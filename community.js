// Всё «общее» для водителей Taxi Radar: чат, отметки о клиентах, метки на
// дороге (как в Waze) и очередь в аэропорту. Только для устройств с
// активной подпиской. Всё хранится в той же базе PostgreSQL.
const crypto = require('crypto');

// Метки о клиентах. Жалобы показываем, только когда их поставили минимум
// двое разных водителей: одна злая отметка ничего не решает.
const CLIENT_TAGS = {
  slow: { label: 'долго выходит', negative: true },
  noshow: { label: 'не вышел', negative: true },
  rude: { label: 'неадекватный', negative: true },
  unpaid: { label: 'не заплатил', negative: true },
  ok: { label: 'всё ок', negative: false },
  card: { label: 'оплата картой', negative: false },
  plus: { label: 'есть Яндекс Плюс', negative: false }
};
const CLIENT_TAG_DAYS = 180;
const NEGATIVE_MIN_DRIVERS = 2;

// Метки на карте и сколько минут они живут.
const REPORT_TYPES = {
  police: 60,
  accident: 120,
  closure: 12 * 60,
  jam: 60,
  pothole: 7 * 24 * 60,
  addr_noshow: 90 * 24 * 60,
  addr_hard: 90 * 24 * 60,
  addr_cancel: 90 * 24 * 60
};

// Стоянка такси у аэропорта Кишинёва: «в очереди», если телефон пинговал недавно.
const AIRPORT_QUEUE_MINUTES = 5;

module.exports = function registerCommunity(app, pool, { isValidDeviceId, escapeHtml }) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS chat_users (
      device_id VARCHAR(100) PRIMARY KEY,
      nickname VARCHAR(24) NOT NULL,
      muted BOOLEAN NOT NULL DEFAULT false,
      created TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      device_id VARCHAR(100) NOT NULL,
      nickname VARCHAR(24) NOT NULL,
      text VARCHAR(500) NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      deleted BOOLEAN NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS chat_messages_created ON chat_messages (created);
    CREATE TABLE IF NOT EXISTS client_tags (
      phone_hash CHAR(64) NOT NULL,
      device_id VARCHAR(100) NOT NULL,
      tag VARCHAR(20) NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (phone_hash, device_id, tag)
    );
    CREATE TABLE IF NOT EXISTS road_reports (
      id BIGSERIAL PRIMARY KEY,
      device_id VARCHAR(100) NOT NULL,
      type VARCHAR(20) NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      expires TIMESTAMP NOT NULL,
      votes_no INT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS road_reports_expires ON road_reports (expires);
    CREATE TABLE IF NOT EXISTS report_votes (
      report_id BIGINT NOT NULL,
      device_id VARCHAR(100) NOT NULL,
      still BOOLEAN NOT NULL,
      PRIMARY KEY (report_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS airport_presence (
      device_id VARCHAR(100) PRIMARY KEY,
      last_seen TIMESTAMP NOT NULL
    );
  `).catch(err => console.error('Community tables init error:', err));

  // ---------- общее ----------

  async function isLicensed(deviceId) {
    if (!isValidDeviceId(deviceId)) return false;
    const r = await pool.query('SELECT status, expires FROM devices WHERE device_id = $1', [deviceId]);
    if (r.rows.length === 0) return false;
    const d = r.rows[0];
    return d.status !== 'banned' && d.status !== 'disabled' && new Date(d.expires) > new Date();
  }

  // Обёртка для всех API сообщества: только подписчики, ошибки — в лог, не наружу.
  function member(handler) {
    return async (req, res) => {
      try {
        const deviceId = req.body && req.body.device_id;
        if (!(await isLicensed(deviceId))) {
          return res.status(403).json({ ok: false, message: 'Нужна активная подписка' });
        }
        await handler(req, res, deviceId);
      } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, message: 'Ошибка сервера' });
      }
    };
  }

  // Простое ограничение частоты в памяти: «не больше N за окно».
  const hits = new Map();
  function tooOften(key, max, windowMs) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) {
      hits.set(key, list);
      return true;
    }
    list.push(now);
    hits.set(key, list);
    return false;
  }

  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
  }

  // ---------- чат ----------

  app.post('/api/chat/profile', member(async (req, res, deviceId) => {
    const nickname = cleanText(req.body.nickname, 20).replace(/\s+/g, ' ');
    if (!/^[\p{L}\p{N} ._-]{2,20}$/u.test(nickname)) {
      return res.json({ ok: false, message: 'Ник: 2–20 букв или цифр' });
    }
    await pool.query(
      `INSERT INTO chat_users (device_id, nickname) VALUES ($1, $2)
       ON CONFLICT (device_id) DO UPDATE SET nickname = $2`,
      [deviceId, nickname]
    );
    res.json({ ok: true, nickname });
  }));

  // after — id последнего сообщения, что уже есть у приложения; без него — последние 50.
  app.post('/api/chat/list', member(async (req, res, deviceId) => {
    const after = parseInt(req.body.after, 10);
    const rows = Number.isFinite(after) && after > 0
      ? (await pool.query(
        `SELECT id, device_id, nickname, text, created FROM chat_messages
         WHERE id > $1 AND NOT deleted ORDER BY id LIMIT 100`, [after])).rows
      : (await pool.query(
        `SELECT * FROM (SELECT id, device_id, nickname, text, created FROM chat_messages
         WHERE NOT deleted ORDER BY id DESC LIMIT 50) t ORDER BY id`)).rows;
    const me = (await pool.query('SELECT nickname, muted FROM chat_users WHERE device_id = $1', [deviceId])).rows[0];
    res.json({
      ok: true,
      me: me ? { nickname: me.nickname, muted: me.muted } : null,
      messages: rows.map(m => ({
        id: Number(m.id),
        nickname: m.nickname,
        text: m.text,
        ts: new Date(m.created).toISOString(),
        mine: m.device_id === deviceId
      }))
    });
  }));

  app.post('/api/chat/send', member(async (req, res, deviceId) => {
    const text = cleanText(req.body.text, 500);
    if (!text) return res.json({ ok: false, message: 'Пустое сообщение' });
    const me = (await pool.query('SELECT nickname, muted FROM chat_users WHERE device_id = $1', [deviceId])).rows[0];
    if (!me) return res.json({ ok: false, message: 'Сначала выберите ник' });
    if (me.muted) return res.json({ ok: false, message: 'Вам запрещено писать в чат' });
    if (tooOften('chat3s:' + deviceId, 1, 3000) || tooOften('chat10m:' + deviceId, 30, 10 * 60 * 1000)) {
      return res.json({ ok: false, message: 'Слишком часто — подождите немного' });
    }
    const r = await pool.query(
      'INSERT INTO chat_messages (device_id, nickname, text) VALUES ($1, $2, $3) RETURNING id, created',
      [deviceId, me.nickname, text]
    );
    res.json({ ok: true, id: Number(r.rows[0].id) });
  }));

  // ---------- клиенты ----------

  // Номер хранится только как HMAC-отпечаток с секретом сервера: по базе
  // без секрета номера не восстановить. Секрет — PHONE_PEPPER в Railway;
  // если не задан, берём производный от DATABASE_URL (он постоянный).
  const pepper = process.env.PHONE_PEPPER ||
    crypto.createHash('sha256').update('taxi-radar|' + (process.env.DATABASE_URL || '')).digest('hex');

  function phoneHash(phone) {
    return crypto.createHmac('sha256', pepper).update(phone).digest('hex');
  }

  // Приложение присылает номер уже в международном виде: +37378123456.
  function cleanPhone(value) {
    if (typeof value !== 'string') return null;
    const p = value.replace(/[^\d+]/g, '');
    return /^\+\d{8,15}$/.test(p) ? p : null;
  }

  async function clientSummary(hash, deviceId) {
    const rows = (await pool.query(
      `SELECT tag, COUNT(DISTINCT device_id) AS drivers,
              BOOL_OR(device_id = $2) AS mine
       FROM client_tags
       WHERE phone_hash = $1 AND created > NOW() - ($3 || ' days')::INTERVAL
       GROUP BY tag`,
      [hash, deviceId, String(CLIENT_TAG_DAYS)]
    )).rows;
    const tags = {};
    const mine = [];
    for (const r of rows) {
      const def = CLIENT_TAGS[r.tag];
      if (!def) continue;
      const drivers = Number(r.drivers);
      if (!def.negative || drivers >= NEGATIVE_MIN_DRIVERS) tags[r.tag] = drivers;
      if (r.mine) mine.push(r.tag);
    }
    return { tags, mine };
  }

  app.post('/api/clients/check', member(async (req, res, deviceId) => {
    const phone = cleanPhone(req.body.phone);
    if (!phone) return res.json({ ok: false, message: 'Неверный номер' });
    if (tooOften('check:' + deviceId, 120, 60 * 60 * 1000)) {
      return res.json({ ok: false, message: 'Слишком много проверок' });
    }
    res.json({ ok: true, ...(await clientSummary(phoneHash(phone), deviceId)) });
  }));

  // on=false снимает свою отметку (ошиблись кнопкой).
  app.post('/api/clients/tag', member(async (req, res, deviceId) => {
    const phone = cleanPhone(req.body.phone);
    const tag = req.body.tag;
    if (!phone || !CLIENT_TAGS[tag]) return res.json({ ok: false, message: 'Неверные данные' });
    const hash = phoneHash(phone);
    if (req.body.on === false) {
      await pool.query('DELETE FROM client_tags WHERE phone_hash = $1 AND device_id = $2 AND tag = $3', [hash, deviceId, tag]);
    } else {
      const today = await pool.query(
        "SELECT COUNT(*) AS n FROM client_tags WHERE device_id = $1 AND created > NOW() - INTERVAL '1 day'",
        [deviceId]
      );
      if (Number(today.rows[0].n) >= 30) return res.json({ ok: false, message: 'Не больше 30 отметок в сутки' });
      await pool.query(
        `INSERT INTO client_tags (phone_hash, device_id, tag) VALUES ($1, $2, $3)
         ON CONFLICT (phone_hash, device_id, tag) DO UPDATE SET created = NOW()`,
        [hash, deviceId, tag]
      );
    }
    res.json({ ok: true, ...(await clientSummary(hash, deviceId)) });
  }));

  // ---------- метки на дороге ----------

  function validPoint(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && lat > 45.3 && lat < 48.7 && lon > 26.5 && lon < 30.3;
  }

  app.post('/api/reports/list', member(async (req, res, deviceId) => {
    const lat = Number(req.body.lat), lon = Number(req.body.lon);
    if (!validPoint(lat, lon)) return res.json({ ok: true, reports: [] });
    // ~30 км вокруг водителя.
    const rows = (await pool.query(
      `SELECT r.id, r.type, r.lat, r.lon, r.created, r.expires, r.device_id,
              v.still AS my_vote
       FROM road_reports r
       LEFT JOIN report_votes v ON v.report_id = r.id AND v.device_id = $5
       WHERE r.expires > NOW() AND r.lat BETWEEN $1 AND $2 AND r.lon BETWEEN $3 AND $4
       ORDER BY r.created DESC LIMIT 300`,
      [lat - 0.27, lat + 0.27, lon - 0.4, lon + 0.4, deviceId]
    )).rows;
    res.json({
      ok: true,
      reports: rows.map(r => ({
        id: Number(r.id),
        type: r.type,
        lat: r.lat,
        lon: r.lon,
        created: new Date(r.created).toISOString(),
        mine: r.device_id === deviceId,
        voted: r.my_vote !== null
      }))
    });
  }));

  app.post('/api/reports/add', member(async (req, res, deviceId) => {
    const type = req.body.type;
    const lat = Number(req.body.lat), lon = Number(req.body.lon);
    const ttl = REPORT_TYPES[type];
    if (!ttl || !validPoint(lat, lon)) return res.json({ ok: false, message: 'Неверная метка' });
    if (tooOften('report:' + deviceId, 10, 60 * 60 * 1000)) {
      return res.json({ ok: false, message: 'Не больше 10 меток в час' });
    }
    // Такая же метка рядом (~150 м) уже есть — продлеваем её, а не плодим копии.
    const near = await pool.query(
      `SELECT id FROM road_reports WHERE type = $1 AND expires > NOW()
       AND ABS(lat - $2) < 0.00135 AND ABS(lon - $3) < 0.002 LIMIT 1`,
      [type, lat, lon]
    );
    const expires = new Date(Date.now() + ttl * 60 * 1000);
    if (near.rows.length) {
      await pool.query('UPDATE road_reports SET expires = GREATEST(expires, $1), votes_no = 0 WHERE id = $2', [expires, near.rows[0].id]);
      return res.json({ ok: true, id: Number(near.rows[0].id), extended: true });
    }
    const r = await pool.query(
      'INSERT INTO road_reports (device_id, type, lat, lon, expires) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [deviceId, type, lat, lon, expires]
    );
    res.json({ ok: true, id: Number(r.rows[0].id) });
  }));

  // «Ещё здесь?» — да продлевает метку, два «нет» от разных водителей убирают её.
  app.post('/api/reports/vote', member(async (req, res, deviceId) => {
    const id = parseInt(req.body.id, 10);
    const still = req.body.still === true;
    const rep = (await pool.query('SELECT type, device_id FROM road_reports WHERE id = $1', [id])).rows[0];
    if (!rep) return res.json({ ok: false, message: 'Метка уже исчезла' });
    await pool.query(
      `INSERT INTO report_votes (report_id, device_id, still) VALUES ($1, $2, $3)
       ON CONFLICT (report_id, device_id) DO UPDATE SET still = $3`,
      [id, deviceId, still]
    );
    if (still) {
      const expires = new Date(Date.now() + REPORT_TYPES[rep.type] * 60 * 1000);
      await pool.query('UPDATE road_reports SET expires = GREATEST(expires, $1) WHERE id = $2', [expires, id]);
    } else {
      const no = await pool.query('SELECT COUNT(*) AS n FROM report_votes WHERE report_id = $1 AND NOT still', [id]);
      const n = Number(no.rows[0].n);
      // Автор сам сказал «нет» — убираем сразу.
      if (n >= 2 || rep.device_id === deviceId) {
        await pool.query('UPDATE road_reports SET expires = NOW(), votes_no = $1 WHERE id = $2', [n, id]);
      } else {
        await pool.query('UPDATE road_reports SET votes_no = $1 WHERE id = $2', [n, id]);
      }
    }
    res.json({ ok: true });
  }));

  // ---------- аэропорт ----------

  // Приложение пингует, только пока телефон на стоянке такси у аэропорта.
  app.post('/api/airport/ping', member(async (req, res, deviceId) => {
    await pool.query(
      `INSERT INTO airport_presence (device_id, last_seen) VALUES ($1, NOW())
       ON CONFLICT (device_id) DO UPDATE SET last_seen = NOW()`,
      [deviceId]
    );
    res.json({ ok: true });
  }));

  app.post('/api/airport/status', member(async (req, res) => {
    const q = await pool.query(
      `SELECT COUNT(*) AS n FROM airport_presence WHERE last_seen > NOW() - ($1 || ' minutes')::INTERVAL`,
      [String(AIRPORT_QUEUE_MINUTES)]
    );
    res.json({ ok: true, queue: Number(q.rows[0].n), flights: app.locals.airportFlights || [] });
  }));

  // ---------- табло прилётов ----------

  // Сайт аэропорта отдаёт табло зашифрованным и закрыт от скачивания — не
  // взламываем. Берём прилёты в Кишинёв (RMO) у AirLabs: бесплатный ключ,
  // 1000 запросов в месяц. Раз в 45 минут ≈ 960 в месяц — укладываемся.
  // На бесплатном тарифе расписания Кишинёва нет — берём самолёты в воздухе.
  // Ключ — переменная AIRLABS_KEY в Railway; без неё табло просто пустое.
  // Новый код RMO у AirLabs может быть ещё не заведён — пробуем варианты
  // и запоминаем тот, что вернул рейсы.
  const AIRPORT_QUERIES = [
    'schedules?arr_icao=LUKK', 'schedules?arr_iata=KIV', 'schedules?arr_iata=RMO',
    // Запасной вариант: самолёты, которые сейчас летят в Кишинёв.
    'flights?arr_icao=LUKK', 'flights?arr_iata=RMO', 'flights?arr_iata=KIV'
  ];
  let airportQuery = null;
  const FLIGHTS_EVERY_MS = 45 * 60 * 1000;
  const RMO_LAT = 46.9277, RMO_LON = 28.9313;

  function kmBetween(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }

  // Местное время Кишинёва «2026-09-29 14:52».
  function chisinauTime(ms) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Chisinau', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  // Самолёт в воздухе: время посадки ≈ расстояние / скорость + ~8 минут на заход.
  function etaFor(f) {
    if (typeof f.lat !== 'number' || typeof f.lng !== 'number') return '';
    const km = kmBetween(f.lat, f.lng, RMO_LAT, RMO_LON);
    const speed = Math.max(Number(f.speed) || 0, 400);
    return chisinauTime(Date.now() + (km / speed) * 3600 * 1000 + 8 * 60 * 1000);
  }
  app.locals.airportFlights = [];

  // Для диагностики: настроен ли ключ, когда обновлялись, что ответил AirLabs.
  const board = { configured: false, updated: null, count: 0, error: null, query: null, attempts: [], plan: null };

  async function refreshFlights() {
    const key = (process.env.AIRLABS_KEY || '').trim();
    board.configured = Boolean(key);
    if (!key) return;
    try {
      let list = [];
      board.attempts = [];
      for (const q of airportQuery ? [airportQuery] : AIRPORT_QUERIES) {
        const r = await fetch(`https://airlabs.co/api/v9/${q}&api_key=${encodeURIComponent(key)}`);
        const json = await r.json();
        board.updated = new Date().toISOString();
        const keyInfo = json.request && json.request.key;
        if (keyInfo && typeof keyInfo.type === 'string') board.plan = keyInfo.type;
        board.attempts.push({ q, n: Array.isArray(json.response) ? json.response.length : null });
        if (json.error) {
          board.error = String(json.error.message || json.error.code || 'error').slice(0, 200);
          console.error('Airport flights API error:', board.error);
          return;
        }
        board.error = null;
        list = Array.isArray(json.response) ? json.response : [];
        if (list.length) {
          airportQuery = q;
          board.query = q;
          break;
        }
      }
      app.locals.airportFlights = list
        .map(f => ({
          flight: f.flight_iata || f.flight_icao || '',
          from: f.dep_iata || '',
          // Время местное, «2026-09-29 14:30».
          // /flights отдаёт не расписание, а самолёты в воздухе — время считаем сами.
          time: f.arr_time || f.arr_estimated || etaFor(f),
          estimated: f.arr_time ? (f.arr_estimated || f.arr_actual || '') : '',
          approx: !f.arr_time && !f.arr_estimated,
          status: f.status || ''
        }))
        .filter(f => f.time)
        .sort((a, b) => a.time.localeCompare(b.time));
      board.count = app.locals.airportFlights.length;
      console.log(`Airport flights refreshed: ${board.count}`);
    } catch (err) {
      board.error = String(err.message).slice(0, 200);
      console.error('Airport flights error:', err.message);
    }
  }

  // Открыто: только состояние, без ключа и без самих рейсов.
  app.get('/api/airport/board-status', (req, res) => res.json(board));
  refreshFlights();
  setInterval(refreshFlights, FLIGHTS_EVERY_MS);

  // ---------- админка ----------

  app.get('/admin/community', async (req, res) => {
    try {
      const messages = (await pool.query(
        `SELECT m.id, m.device_id, m.nickname, m.text, m.created, m.deleted, u.muted
         FROM chat_messages m LEFT JOIN chat_users u ON u.device_id = m.device_id
         ORDER BY m.id DESC LIMIT 100`
      )).rows;
      const reports = (await pool.query(
        'SELECT id, device_id, type, lat, lon, created, expires, votes_no FROM road_reports WHERE expires > NOW() ORDER BY created DESC LIMIT 200'
      )).rows;
      const tagStats = (await pool.query(
        'SELECT tag, COUNT(*) AS n, COUNT(DISTINCT phone_hash) AS phones FROM client_tags GROUP BY tag ORDER BY n DESC'
      )).rows;
      const queue = (await pool.query(
        `SELECT COUNT(*) AS n FROM airport_presence WHERE last_seen > NOW() - ($1 || ' minutes')::INTERVAL`,
        [String(AIRPORT_QUEUE_MINUTES)]
      )).rows[0].n;
      const fmt = d => new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau' });
      const btn = 'border:none;padding:4px 8px;border-radius:4px;color:#fff;cursor:pointer;';

      const chatRows = messages.map(m => `
        <tr style="${m.deleted ? 'opacity:.4' : ''}">
          <td style="white-space:nowrap;">${escapeHtml(fmt(m.created))}</td>
          <td><b>${escapeHtml(m.nickname)}</b>${m.muted ? ' <span style="color:#e53e3e;">(заглушён)</span>' : ''}<br><code style="font-size:11px;">${escapeHtml(m.device_id)}</code></td>
          <td>${escapeHtml(m.text)}</td>
          <td style="white-space:nowrap;">
            <form method="POST" action="/admin/community/chat" style="display:inline;">
              <input type="hidden" name="id" value="${escapeHtml(m.id)}">
              <input type="hidden" name="device_id" value="${escapeHtml(m.device_id)}">
              ${m.deleted ? '' : `<button name="action" value="delete" style="${btn}background:#718096;">Удалить</button>`}
              ${m.muted
                ? `<button name="action" value="unmute" style="${btn}background:#38a169;">Разрешить писать</button>`
                : `<button name="action" value="mute" style="${btn}background:#e53e3e;" onclick="return confirm('Запретить этому водителю писать в чат?')">Заглушить</button>`}
            </form>
          </td>
        </tr>`).join('');

      const reportRows = reports.map(r => `
        <tr>
          <td>${escapeHtml(r.type)}</td>
          <td><a href="https://yandex.ru/maps/?pt=${r.lon},${r.lat}&z=16" target="_blank">${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</a></td>
          <td>${escapeHtml(fmt(r.created))}</td>
          <td>${escapeHtml(fmt(r.expires))}</td>
          <td><code style="font-size:11px;">${escapeHtml(r.device_id)}</code></td>
          <td>
            <form method="POST" action="/admin/community/report" style="display:inline;">
              <input type="hidden" name="id" value="${escapeHtml(r.id)}">
              <button style="${btn}background:#e53e3e;">Убрать</button>
            </form>
          </td>
        </tr>`).join('');

      const tagRows = tagStats.map(t => `<li>${escapeHtml((CLIENT_TAGS[t.tag] || {}).label || t.tag)}: ${t.n} отметок, ${t.phones} номеров</li>`).join('');
      const notice = req.query.msg ? `<p style="background:#ebf8ff;padding:10px;border-radius:6px;">${escapeHtml(req.query.msg)}</p>` : '';

      res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Сообщество — Taxi Radar</title>
        <style>
          body { font-family: sans-serif; background: #f0f2f5; padding: 25px; margin: 0; }
          .card { background: #fff; border-radius: 10px; padding: 20px; max-width: 1150px; margin: 0 auto 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
          table { width: 100%; border-collapse: collapse; } td, th { padding: 8px; border-bottom: 1px solid #edf2f7; font-size: 14px; text-align: left; vertical-align: top; }
          th { background: #2b6cb0; color: #fff; } input[type=text] { padding: 6px; width: 260px; }
        </style></head><body>
        <div class="card"><a href="/admin/view-devices">← Устройства и ключи</a>${notice}</div>
        <div class="card"><h2>✈️ Аэропорт</h2><p>Сейчас в очереди водителей радара: <b>${escapeHtml(queue)}</b></p></div>
        <div class="card"><h2>👤 Клиенты</h2>
          <p>Номера в базе не хранятся — только зашифрованные отпечатки. Проверить или очистить номер можно, только введя его.</p>
          <ul>${tagRows || '<li>Отметок пока нет</li>'}</ul>
          <form method="POST" action="/admin/community/client" style="margin-top:10px;">
            <input type="text" name="phone" placeholder="+37378123456">
            <button name="action" value="check" style="${btn}background:#3182ce;">Проверить</button>
            <button name="action" value="clear" style="${btn}background:#e53e3e;" onclick="return confirm('Удалить все отметки этого номера?')">Очистить номер</button>
          </form>
          <form method="POST" action="/admin/community/client" style="margin-top:10px;">
            <input type="text" name="device_id" placeholder="ID устройства водителя">
            <button name="action" value="clear_device" style="${btn}background:#e53e3e;" onclick="return confirm('Удалить все отметки, которые поставил этот водитель?')">Удалить все его отметки</button>
          </form>
        </div>
        <div class="card"><h2>🗺 Метки на дороге (активные: ${reports.length})</h2>
          <table><tr><th>Тип</th><th>Где</th><th>Поставлена</th><th>До</th><th>Кто</th><th></th></tr>${reportRows || '<tr><td colspan="6">Нет активных меток</td></tr>'}</table>
        </div>
        <div class="card"><h2>💬 Чат (последние 100)</h2>
          <table><tr><th>Время</th><th>Кто</th><th>Сообщение</th><th></th></tr>${chatRows || '<tr><td colspan="4">Сообщений пока нет</td></tr>'}</table>
        </div>
      </body></html>`);
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка загрузки');
    }
  });

  app.post('/admin/community/chat', async (req, res) => {
    const { id, device_id, action } = req.body;
    try {
      if (action === 'delete') await pool.query('UPDATE chat_messages SET deleted = true WHERE id = $1', [parseInt(id, 10)]);
      if (action === 'mute') await pool.query('UPDATE chat_users SET muted = true WHERE device_id = $1', [device_id]);
      if (action === 'unmute') await pool.query('UPDATE chat_users SET muted = false WHERE device_id = $1', [device_id]);
    } catch (err) {
      console.error(err);
    }
    res.redirect('/admin/community');
  });

  app.post('/admin/community/report', async (req, res) => {
    try {
      await pool.query('UPDATE road_reports SET expires = NOW() WHERE id = $1', [parseInt(req.body.id, 10)]);
    } catch (err) {
      console.error(err);
    }
    res.redirect('/admin/community');
  });

  app.post('/admin/community/client', async (req, res) => {
    const { action } = req.body;
    let msg = '';
    try {
      if (action === 'clear_device') {
        const r = await pool.query('DELETE FROM client_tags WHERE device_id = $1', [req.body.device_id]);
        msg = `Удалено отметок: ${r.rowCount}`;
      } else {
        const local = String(req.body.phone || '').replace(/[^\d+]/g, '');
        // Как в приложении: местный номер 0XXXXXXXX — молдавский.
        const phone = cleanPhone(/^0\d{8}$/.test(local) ? '+373' + local.slice(1) : local);
        if (!phone) {
          msg = 'Неверный номер';
        } else if (action === 'clear') {
          const r = await pool.query('DELETE FROM client_tags WHERE phone_hash = $1', [phoneHash(phone)]);
          msg = `Удалено отметок: ${r.rowCount}`;
        } else {
          const rows = (await pool.query(
            'SELECT tag, COUNT(DISTINCT device_id) AS n FROM client_tags WHERE phone_hash = $1 GROUP BY tag',
            [phoneHash(phone)]
          )).rows;
          msg = rows.length
            ? rows.map(r => `${(CLIENT_TAGS[r.tag] || {}).label || r.tag}: ${r.n}`).join(', ')
            : 'Отметок нет';
        }
      }
    } catch (err) {
      console.error(err);
      msg = 'Ошибка';
    }
    res.redirect('/admin/community?msg=' + encodeURIComponent(msg));
  });
};
