// Общий геокодер для всех водителей: приложение спрашивает адрес у сервера,
// сервер ищет его в своей базе, а если нет — один раз у Яндекс Геокодера
// (ключи YANDEX_GEOCODER_KEY, YANDEX_GEOCODER_KEY_2, _3 ... в Railway).
// Одни и те же адреса в Кишинёве повторяются постоянно, поэтому почти все
// ответы идут из базы и водителю не нужен свой ключ.

// Мягкая привязка к району Кишинёва — как в приложении.
const BBOX = '28.60,46.85~29.10,47.20';
const CENTER = { lat: 47.0105, lon: 28.8638 };
// Бесплатный тариф Яндекса — 1000 запросов в сутки на ключ; оставляем запас.
const DAILY_LIMIT_PER_KEY = Number(process.env.GEOCODER_DAILY_LIMIT || 900);
const FOUND_DAYS = 180;
const NOT_FOUND_HOURS = 24;
// Точки от водителей: адрес → где реально стоял телефон при посадке/высадке.
// Две точки дальше этого друг от друга — кто-то нажал не там; не усредняем.
const LEARN_AGREE_KM = 0.3;
const MAX_FROM_CENTER_KM = 150;

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// YANDEX_GEOCODER_KEY, YANDEX_GEOCODER_KEY_2 ... _9; в любой можно через запятую.
function keysFromEnv() {
  const names = ['YANDEX_GEOCODER_KEY'];
  for (let i = 2; i <= 9; i++) names.push(`YANDEX_GEOCODER_KEY_${i}`);
  const keys = [];
  for (const n of names) {
    for (const k of String(process.env[n] || '').split(',')) {
      const t = k.trim();
      if (t && !keys.includes(t)) keys.push(t);
    }
  }
  return keys;
}

module.exports = function createGeocoder(pool) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS geocode_cache (
      q VARCHAR(300) PRIMARY KEY,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      hits INT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS address_points (
      q VARCHAR(300) PRIMARY KEY,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      n INT NOT NULL DEFAULT 1,
      source VARCHAR(8) NOT NULL,
      updated TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS address_misses (
      q VARCHAR(300) PRIMARY KEY,
      text VARCHAR(300) NOT NULL,
      n INT NOT NULL DEFAULT 1,
      last_seen TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `).catch(err => console.error('Geocode cache init error:', err));

  let day = '';
  // Сколько запросов сегодня ушло по каждому ключу и какие ключи Яндекс отверг.
  let used = new Map();
  let rejected = new Set();
  let lastError = null;
  let cacheHits = 0;
  // Один адрес от нескольких водителей одновременно — один запрос к Яндексу.
  const inFlight = new Map();

  function enabled() {
    return keysFromEnv().length > 0;
  }

  function newDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = new Map();
      rejected = new Set();
    }
  }

  // Ключи, у которых сегодня ещё есть лимит, — самый «свободный» первым.
  function usableKeys() {
    newDay();
    return keysFromEnv()
      .filter(k => !rejected.has(k) && (used.get(k) || 0) < DAILY_LIMIT_PER_KEY)
      .sort((a, b) => (used.get(a) || 0) - (used.get(b) || 0));
  }

  function normalize(q) {
    return String(q || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300);
  }

  // null — Яндекс не нашёл; throw — ключ не подошёл или Яндекс недоступен.
  async function askYandex(q, key) {
    used.set(key, (used.get(key) || 0) + 1);
    const url = 'https://geocode-maps.yandex.ru/1.x/?apikey=' + encodeURIComponent(key) +
      '&geocode=' + encodeURIComponent(q) +
      `&format=json&results=5&lang=ru_RU&bbox=${BBOX}&rspn=0`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) {
      // 403 — ключ заблокирован или кончился лимит: до завтра его не трогаем.
      if (r.status === 403 || r.status === 429) rejected.add(key);
      lastError = `HTTP ${r.status} at ${new Date().toISOString()}`;
      const e = new Error(lastError);
      e.status = r.status;
      throw e;
    }
    const members = (await r.json()).response.GeoObjectCollection.featureMember;
    let best = null;
    for (const m of members) {
      const [lon, lat] = m.GeoObject.Point.pos.split(' ').map(Number);
      const d = haversineKm({ lat, lon }, CENTER);
      if (!best || d < best.d) best = { lat, lon, d };
    }
    return best && { lat: best.lat, lon: best.lon };
  }

  async function askAnyKey(q) {
    for (const key of usableKeys()) {
      try {
        return { point: await askYandex(q, key) };
      } catch (err) {
        console.error('Geocoder:', err.message);
        if (err.status !== 403 && err.status !== 429) return null; // сеть — другой ключ не поможет
      }
    }
    return null;
  }

  /**
   * { found, lat, lon } или null, если сервис сейчас недоступен.
   * Порядок: точка от админа или подтверждённая двумя поездками → база
   * Яндекса → одна точка от водителя (если Яндекс адрес не знает).
   */
  // Известные места, которые Яндекс по тексту карточки не находит
  // («Международный аэропорт Кишинёв, Зона прилёта» и т. п.).
  const BUILTIN = [
    { re: /(аэропорт|aeroport|airport|\brmo\b|кишин[её]в.*прил[её]т|зона прил[её]та|зона выл[её]та)/i,
      not: /(бельц|balti|bălți|одесс|ясс|iasi|бухарест|bucure|киев|kyiv|стамбул)/i,
      lat: 46.9350, lon: 28.9330 },
  ];

  function builtin(q) {
    for (const b of BUILTIN) {
      if (b.re.test(q) && !(b.not && b.not.test(q))) return { found: true, lat: b.lat, lon: b.lon };
    }
    return null;
  }

  async function lookup(rawQuery) {
    const q = normalize(rawQuery);
    if (!q) return { found: false };
    const known = builtin(q);
    if (known) return known;
    const own = (await pool.query('SELECT lat, lon, n, source FROM address_points WHERE q = $1', [q])).rows[0];
    if (own && (own.source === 'admin' || own.n >= 2)) return { found: true, lat: own.lat, lon: own.lon };
    const r = await lookupYandex(rawQuery, q);
    if (own && (!r || !r.found)) return { found: true, lat: own.lat, lon: own.lon };
    return r;
  }

  async function lookupYandex(rawQuery, q) {
    const cached = await pool.query(
      `SELECT lat, lon FROM geocode_cache
       WHERE q = $1 AND (
         (lat IS NOT NULL AND created > NOW() - ($2 || ' days')::INTERVAL) OR
         (lat IS NULL AND created > NOW() - ($3 || ' hours')::INTERVAL))`,
      [q, String(FOUND_DAYS), String(NOT_FOUND_HOURS)]
    );
    if (cached.rows.length > 0) {
      cacheHits++;
      pool.query('UPDATE geocode_cache SET hits = hits + 1 WHERE q = $1', [q]).catch(() => {});
      const row = cached.rows[0];
      return row.lat == null ? { found: false } : { found: true, lat: row.lat, lon: row.lon };
    }
    if (!enabled()) return null;
    if (inFlight.has(q)) return inFlight.get(q);

    const job = (async () => {
      const answer = await askAnyKey(rawQuery);
      if (!answer) return null;
      const p = answer.point;
      await pool.query(
        `INSERT INTO geocode_cache (q, lat, lon, created) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (q) DO UPDATE SET lat = $2, lon = $3, created = NOW()`,
        [q, p ? p.lat : null, p ? p.lon : null]
      );
      return p ? { found: true, lat: p.lat, lon: p.lon } : { found: false };
    })();
    inFlight.set(q, job);
    try {
      return await job;
    } finally {
      inFlight.delete(q);
    }
  }

  // Приложение не смогло найти адрес ни у нас, ни у Яндекса — в список для админа.
  async function miss(rawQuery) {
    const q = normalize(rawQuery);
    if (!q) return;
    await pool.query(
      `INSERT INTO address_misses (q, text) VALUES ($1, $2)
       ON CONFLICT (q) DO UPDATE SET n = address_misses.n + 1, last_seen = NOW()`,
      [q, String(rawQuery).trim().slice(0, 300)]
    );
  }

  // Телефон водителя стоял у этого адреса (посадка или высадка).
  async function learn(rawQuery, lat, lon) {
    const q = normalize(rawQuery);
    if (!q || !Number.isFinite(lat) || !Number.isFinite(lon)) return 'bad';
    if (haversineKm({ lat, lon }, CENTER) > MAX_FROM_CENTER_KM) return 'far';
    const row = (await pool.query('SELECT lat, lon, n, source FROM address_points WHERE q = $1', [q])).rows[0];
    if (!row) {
      await pool.query(
        `INSERT INTO address_points (q, lat, lon, n, source) VALUES ($1, $2, $3, 1, 'gps') ON CONFLICT (q) DO NOTHING`,
        [q, lat, lon]
      );
    } else if (row.source === 'admin') {
      return 'admin';
    } else if (haversineKm({ lat, lon }, row) > LEARN_AGREE_KM) {
      // Подтверждённую точку одна странная поездка не сдвигает; одиночную — заменяет свежей.
      if (row.n >= 2) return 'conflict';
      await pool.query(`UPDATE address_points SET lat = $2, lon = $3, n = 1, updated = NOW() WHERE q = $1`, [q, lat, lon]);
    } else {
      await pool.query(
        `UPDATE address_points SET lat = (lat * n + $2) / (n + 1), lon = (lon * n + $3) / (n + 1),
           n = LEAST(n + 1, 50), updated = NOW() WHERE q = $1`,
        [q, lat, lon]
      );
    }
    await pool.query('DELETE FROM address_misses WHERE q = $1', [q]);
    return 'ok';
  }

  // Админ поставил точку вручную — она главнее всего остального.
  async function setAdminPoint(rawQuery, lat, lon) {
    const q = normalize(rawQuery);
    await pool.query(
      `INSERT INTO address_points (q, lat, lon, n, source) VALUES ($1, $2, $3, 1, 'admin')
       ON CONFLICT (q) DO UPDATE SET lat = $2, lon = $3, n = 1, source = 'admin', updated = NOW()`,
      [q, lat, lon]
    );
    await pool.query('DELETE FROM address_misses WHERE q = $1', [q]);
  }

  async function removePoint(rawQuery) {
    await pool.query('DELETE FROM address_points WHERE q = $1', [normalize(rawQuery)]);
  }

  async function dismissMiss(rawQuery) {
    await pool.query('DELETE FROM address_misses WHERE q = $1', [normalize(rawQuery)]);
  }

  // Для админки.
  async function adminData() {
    const misses = (await pool.query(
      `SELECT q, text, n, last_seen FROM address_misses
       WHERE last_seen > NOW() - INTERVAL '60 days' ORDER BY n DESC, last_seen DESC LIMIT 50`
    )).rows;
    const points = (await pool.query(
      `SELECT q, lat, lon, n, source, updated FROM address_points ORDER BY updated DESC LIMIT 50`
    )).rows;
    const counts = (await pool.query(
      `SELECT source, COUNT(*) AS total, COUNT(*) FILTER (WHERE n >= 2) AS confirmed FROM address_points GROUP BY source`
    )).rows;
    return { misses, points, counts };
  }

  // Для страницы статуса: без самих ключей, только номера и счётчики.
  async function status() {
    newDay();
    const r = await pool.query('SELECT COUNT(*) AS n FROM geocode_cache WHERE lat IS NOT NULL');
    const keys = keysFromEnv();
    return {
      enabled: keys.length > 0,
      keys: keys.map((k, i) => ({
        n: i + 1,
        requests_today: used.get(k) || 0,
        rejected_today: rejected.has(k)
      })),
      daily_limit_per_key: DAILY_LIMIT_PER_KEY,
      cached_addresses: Number(r.rows[0].n),
      cache_hits_since_start: cacheHits,
      last_error: lastError
    };
  }

  return { lookup, status, enabled, miss, learn, setAdminPoint, removePoint, dismissMiss, adminData, normalize };
};
