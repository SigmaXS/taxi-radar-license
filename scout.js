// Разведчик надбавки: сайт Яндекса сейчас отдаёт только старт 30/45/65, а приложение Яндекс Go — настоящую
// цену «от N». Телефон-разведчик (Taxi Radar в режиме «Разведчик» + Яндекс Go) по очереди открывает Go в точках,
// где сейчас стоят водители, читает цены и присылает надбавку сюда; радары водителей раз в минуту её забирают.
// Разведчики — устройства из SCOUT_DEVICE_IDS (Railway, через запятую). Всё в памяти: данным важна свежесть.

// Центр Кишинёва; дальше SCOUT_RADIUS_KM надбавки не бывает — водителю сразу 0, разведчика не гоняем.
const CENTER = { lat: 47.0245, lon: 28.8353 };
const CELL = 0.001;            // ~110 × 75 м: точки водителей ближе — одна проверка
const WANT_MS = 3 * 60e3;      // точка в очереди, пока водитель в ней был последние 3 мин
const FRESH_MS = 5 * 60e3;     // результат годен 5 мин
const NEAR_KM = 0.3;           // результат соседней клетки годится, если ближе 300 м
// Новое место водителя ещё не проверено (едет) — до проверки отдаём ближайшую свежую проверку поблизости, а не «?»:
// надбавка меняется зонами в несколько кварталов.
const FALLBACK_KM = 1.2, FALLBACK_MS = 3 * 60e3;
const LEASE_MS = 60e3;         // выданную разведчику точку минуту не отдаём другому
const RECHECK_MS = 60e3;       // точку водителя — не чаще раза в минуту…
const RECHECK_FEW_MS = 20e3;   // …а пока точек водителей мало (до FEW) — раз в 20 с: разведчик всё равно свободен
const FEW = 5;
const RECHECK_B_MS = 150e3;    // точку Б (куда везёт) — раз в 2,5 мин и только после точек водителей

function km(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const cellOf = (lat, lon) => `${Math.round(lat / CELL)}:${Math.round(lon / CELL)}`;
const centerOf = key => { const [a, b] = key.split(':').map(Number); return { lat: a * CELL, lon: b * CELL }; };
const okCoord = (lat, lon) => typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) &&
  lat > 45 && lat < 49 && lon > 26 && lon < 31;
const okSurge = v => v === null || (Number.isInteger(v) && v >= 0 && v <= 500);

/** Надбавка в точке одна на все тарифы. Главный — Эконом: его старт (30) надёжен, и водители сверяют именно его.
 *  Комфорт/Комфорт+ в Go могут считаться иначе (другой старт, скидка аккаунта) и раньше перевешивали Эконом
 *  большинством (Эконом +15, а водителям уходило +6). Без Эконома — значение большинства остальных (при равенстве — большее). */
function single(values) {
  if (Number.isInteger(values.econom)) return values.econom;
  const known = Object.values(values).filter(v => Number.isInteger(v));
  if (!known.length) return null;
  const count = new Map();
  known.forEach(v => count.set(v, (count.get(v) || 0) + 1));
  return [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

module.exports = function registerScout(app, { member, escapeHtml = s => String(s), pool }, options = {}) {
  const now = options.now || Date.now;
  const env = options.env || process.env;
  const radiusKm = () => { const n = parseFloat(env.SCOUT_RADIUS_KM); return Number.isFinite(n) && n > 0 ? n : 20; };
  const scouts = () => String(env.SCOUT_DEVICE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

  const wanted = new Map();   // cell → { at: последний раз водитель тут, lease: до когда выдана разведчику }
  const results = new Map();  // cell → { at, value, values, lat, lon }
  // Проверки — и в базе: перезапуск сервера (каждая заливка) не должен обнулять надбавку у всех водителей.
  if (pool) {
    pool.query(`CREATE TABLE IF NOT EXISTS scout_results (cell VARCHAR(30) PRIMARY KEY, at BIGINT NOT NULL, value INT, vals TEXT, lat DOUBLE PRECISION, lon DOUBLE PRECISION)`)
      .then(() => pool.query('SELECT * FROM scout_results WHERE at > $1', [now() - FRESH_MS]))
      .then(r => r.rows.forEach(x => { if (!results.has(x.cell)) results.set(x.cell, { at: Number(x.at), value: x.value, values: JSON.parse(x.vals || '{}'), lat: x.lat, lon: x.lon }); }))
      .catch(e => console.error('scout_results:', e.message));
  }
  function store(key, r) {
    results.set(key, r);
    if (pool) pool.query(`INSERT INTO scout_results (cell, at, value, vals, lat, lon) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (cell) DO UPDATE SET at = $2, value = $3, vals = $4, lat = $5, lon = $6`,
      [key, r.at, r.value, JSON.stringify(r.values), r.lat, r.lon]).catch(() => {});
  }

  function prune() {
    const t = now();
    // Радар замолчал (выключен, нет связи) — через 3 минуты его точки уходят из очереди.
    for (const [dev, d] of byDevice) if (t - d.at > WANT_MS) { forget(dev, false); forget(dev, true); byDevice.delete(dev); }
    for (const [k, w] of wanted) if (t - w.at > WANT_MS) wanted.delete(k);
    for (const [k, r] of results) if (t - r.at > FRESH_MS * 3) results.delete(k);
  }

  function nearest(p, radius = NEAR_KM, maxAge = FRESH_MS) {
    const t = now();
    let best = null;
    for (const r of results.values()) {
      if (t - r.at > maxAge || r.value === null) continue;
      const d = km(p, r);
      if (d <= radius && (!best || d < best.d)) best = { d, r };
    }
    return best?.r || null;
  }
  const nearestOrAround = p => nearest(p) || nearest(p, FALLBACK_KM, FALLBACK_MS);

  // Чья точка: водитель уехал — его старая клетка сразу уходит из очереди (если там больше никого),
  // а не висит ещё 3 минуты. Так же с точкой Б: новая заменяет старую, нет Б — заказ кончился.
  const byDevice = new Map(); // device → { here: клетка, b: клетка Б, at }
  function release(key, dev, isB) {
    const w = key && wanted.get(key);
    if (!w) return;
    (isB ? w.bs : w.here).delete(dev);
    if (!w.here.size && !w.bs.size) wanted.delete(key); else w.b = w.here.size === 0;
  }
  function want(lat, lon, isB, dev) {
    const key = cellOf(lat, lon);
    const d = byDevice.get(dev) || {};
    const prev = isB ? d.b : d.here;
    if (prev && prev !== key) release(prev, dev, isB);
    const w = wanted.get(key) || { at: 0, lease: 0, here: new Set(), bs: new Set(), b: true };
    (isB ? w.bs : w.here).add(dev);
    w.at = now(); w.b = w.here.size === 0; // точка, где стоит хоть один водитель, важнее точки Б
    wanted.set(key, w);
    if (isB) d.b = key; else d.here = key;
    d.at = now(); byDevice.set(dev, d);
  }
  function forget(dev, isB) {
    const d = byDevice.get(dev);
    if (!d) return;
    if (isB) { release(d.b, dev, true); d.b = null; } else { release(d.here, dev, false); d.here = null; }
  }

  // Радар водителя, раз в минуту: «я здесь» (и куда везу — b_lat/b_lon) → надбавка разведчика рядом.
  app.post('/api/scout/near', member(async (req, res, deviceId) => {
    const { lat, lon, b_lat, b_lon } = req.body;
    if (!okCoord(lat, lon)) return res.status(400).json({ ok: false, code: 'bad_point' });
    prune();
    const out = { ok: true };
    if (km(CENTER, { lat, lon }) > radiusKm()) { out.surge = 0; out.far = true; forget(deviceId, false); }
    else {
      // Разведчик за работой лежит дома с Яндекс Go — его место проверять незачем. Телефон из списка,
      // который сейчас не разведывает (водитель взял его в машину), — обычный водитель.
      if (!scouting(deviceId)) want(lat, lon, false, deviceId);
      const r = nearestOrAround({ lat, lon });
      if (r) Object.assign(out, { surge: r.value, values: r.values, age_s: Math.round((now() - r.at) / 1000) });
      else Object.assign(out, { surge: null, scouting: scouts().length > 0 });
    }
    if (okCoord(b_lat, b_lon)) {
      if (km(CENTER, { lat: b_lat, lon: b_lon }) > radiusKm()) out.surge_b = 0;
      else { if (!scouting(deviceId)) want(b_lat, b_lon, true, deviceId); const rb = nearestOrAround({ lat: b_lat, lon: b_lon }); out.surge_b = rb ? rb.value : null; }
    } else forget(deviceId, true);
    res.json(out);
  }));

  // ---------- сторож: разведчик замолчал или завис — сообщение владельцу в Telegram ----------
  const health = new Map(); // scout → { task: последний запрос точек, result: последняя проверка, a11y, state }
  const startedAt = now();
  const scouting = id => scouts().includes(id) && now() - hp(id).task < 2 * 60e3;
  const hp = id => health.get(id) || (health.set(id, { task: 0, result: 0, a11y: true, state: 'ok' }), health.get(id));
  async function telegram(text) {
    const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_ADMIN_CHAT_ID;
    if (options.telegram) return options.telegram(text);
    if (!token || !chat) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(10000) }).catch(() => null);
  }
  function watch() {
    const t = now();
    if (t - startedAt < 5 * 60e3) return; // после перезапуска сервера — дать разведчикам выйти на связь
    const waiting = [...wanted.values()].some(w => !w.b);
    for (const id of scouts()) {
      const h = hp(id);
      const state = t - h.task > 5 * 60e3 ? 'silent'
        : !h.a11y ? 'a11y'
        : waiting && t - Math.max(h.result, startedAt) > 5 * 60e3 ? 'stuck' : 'ok';
      if (state === h.state) continue;
      const name = `разведчик …${id.slice(-4)}`;
      const text = {
        silent: `🛰 ${name} не на связи 5 мин: радар выключен, нет интернета или телефон сел. Проверьте телефон.`,
        a11y: `🛰 ${name}: спец. возможность Taxi Radar включена, но не работает. Выключите и включите её снова или перезагрузите телефон.`,
        stuck: `🛰 ${name} 5 мин не прислал ни одной проверки, хотя водители ждут: Яндекс Go завис или экран заблокирован. Перезагрузите телефон.`,
        ok: `✅ ${name} снова работает.`
      }[state];
      h.state = state;
      console.log('scout:', text);
      telegram(text);
    }
  }
  if (!options.now) setInterval(watch, 60e3).unref();

  // Разведчик сообщает о себе (спец. возможность работает?) — раз в круг.
  app.post('/api/scout/status', member(async (req, res, deviceId) => {
    if (!scouts().includes(deviceId)) return res.status(403).json({ ok: false, code: 'not_scout' });
    const h = hp(deviceId); h.task = now(); h.a11y = req.body.a11y !== false;
    res.json({ ok: true });
  }));

  // Разведчик: дай точки для проверки — где водители, сначала давно не проверенные.
  app.post('/api/scout/tasks', member(async (req, res, deviceId) => {
    if (!scouts().includes(deviceId)) return res.status(403).json({ ok: false, code: 'not_scout' });
    hp(deviceId).task = now();
    prune();
    const t = now();
    const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 8, 1), 20);
    const drivers = [...wanted.values()].filter(w => !w.b).length;
    const recheck = drivers <= FEW ? RECHECK_FEW_MS : RECHECK_MS;
    const list = [...wanted.entries()]
      .filter(([, w]) => w.lease < t)
      .map(([k, w]) => ({ k, w, checked: results.get(k)?.at || 0 }))
      // Точки водителей — раз в минуту; точки Б — раз в 2,5 мин и в конце очереди.
      .filter(x => t - x.checked > (x.w.b ? RECHECK_B_MS : recheck))
      .sort((a, b) => (a.w.b - b.w.b) || (a.checked - b.checked))
      .slice(0, limit);
    list.forEach(x => { x.w.lease = t + Math.min(LEASE_MS, recheck); });
    res.json({ ok: true, points: list.map(x => ({ ...centerOf(x.k) })) });
  }));

  // Разведчик: результат по точке. values — надбавка по тарифам (null — «нет свободных машин» / не прочитано).
  app.post('/api/scout/result', member(async (req, res, deviceId) => {
    if (!scouts().includes(deviceId)) return res.status(403).json({ ok: false, code: 'not_scout' });
    const { lat, lon } = req.body;
    const v = req.body.values || {};
    const values = { econom: v.econom ?? null, comfort: v.comfort ?? null, comfortplus: v.comfortplus ?? null };
    if (!okCoord(lat, lon) || !Object.values(values).every(okSurge)) return res.status(400).json({ ok: false, code: 'bad_result' });
    const value = single(values);
    const key = cellOf(lat, lon);
    // Ни по одному тарифу нет машин — «нет данных», а не 0; клетка снова встанет в очередь через минуту.
    store(key, { at: now(), value, values, lat, lon });
    hp(deviceId).result = now();
    const w = wanted.get(key); if (w) w.lease = 0;
    const spread = Object.values(values).filter(Number.isInteger);
    if (spread.length > 1 && Math.max(...spread) !== Math.min(...spread)) {
      console.log(`scout: разные надбавки по тарифам в ${lat.toFixed(4)},${lon.toFixed(4)}: ${JSON.stringify(values)} — проверьте скидки аккаунта разведчика`);
    }
    res.json({ ok: true, value });
  }));

  // Разведчик (и проверка с его ID): очередь как есть — ничего не выдаёт и не бронирует.
  app.post('/api/scout/queue', member(async (req, res, deviceId) => {
    if (!scouts().includes(deviceId)) return res.status(403).json({ ok: false, code: 'not_scout' });
    prune();
    const t = now();
    const drivers = [...wanted.values()].filter(w => !w.b).length;
    res.json({ ok: true, recheck_s: (drivers <= FEW ? RECHECK_FEW_MS : RECHECK_MS) / 1000, points: [...wanted.entries()].map(([k, w]) => {
      const p = centerOf(k), r = results.get(k);
      return { lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4), b: w.b, drivers: w.here.size, seen_s: Math.round((t - w.at) / 1000),
        leased: w.lease > t, checked_s: r ? Math.round((t - r.at) / 1000) : null, value: r ? r.value : undefined, values: r ? r.values : undefined };
    }) });
  }));

  // Админка: очередь разведчика — какие точки, когда водитель там был и когда проверено (страница обновляется сама).
  app.get('/admin/scout', (req, res) => {
    prune();
    const t = now();
    const age = ms => ms == null ? '—' : ms < 120e3 ? `${Math.round(ms / 1000)} с` : `${Math.round(ms / 60e3)} мин`;
    const rows = [...wanted.entries()].map(([k, w]) => ({ k, w, p: centerOf(k), r: results.get(k) }))
      .sort((a, b) => (a.w.b - b.w.b) || (b.w.at - a.w.at))
      .map(({ w, p, r }) => `<tr><td>${w.b ? 'Б (куда везут)' : 'водитель'}</td>
        <td><a href="https://yandex.md/maps/?pt=${p.lon},${p.lat}&z=16" target="_blank">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</a></td>
        <td>${age(t - w.at)} назад</td><td>${r ? age(t - r.at) + ' назад' : 'ещё нет'}</td>
        <td><b>${r ? (r.value == null ? 'нет машин' : '+' + r.value) : ''}</b></td>
        <td style="font-size:12px;color:#4a5568;">${r ? escapeHtml(JSON.stringify(r.values)) : ''}</td></tr>`).join('');
    const nav = (() => { try { return require('./admin_nav').adminNav('/admin/scout'); } catch { return ''; } })();
    res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>Разведчик — Taxi Radar</title>
      <style>body{font-family:sans-serif;background:#f0f2f5;padding:25px;margin:0}.card{background:#fff;border-radius:10px;padding:20px;max-width:1150px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,.06)}
      table{width:100%;border-collapse:collapse;font-size:15px}td,th{padding:9px;border-bottom:1px solid #e2e8f0;text-align:left}th{background:#ebf4ff}</style></head><body>${nav}
      <div class="card"><h2>🛰 Разведчик надбавки</h2>
      <p>Телефонов-разведчиков: <b>${scouts().length}</b> · точек в очереди: <b>${wanted.size}</b> ·
      точку водителя проверяем раз в <b>${[...wanted.values()].filter(w => !w.b).length <= FEW ? '20 с' : 'минуту'}</b>, точку Б — раз в 2,5 мин.
      Точка пропадает, если радар водителя молчит 3 минуты. Страница обновляется каждые 10 с.</p>
      <table><tr><th>Чья</th><th>Где</th><th>Водитель был</th><th>Проверено</th><th>Надбавка</th><th>По тарифам</th></tr>${rows || '<tr><td colspan="6">Очередь пустая — ни у кого из водителей с 2.3 радар сейчас не запущен.</td></tr>'}</table></div></body></html>`);
  });

  /** Для админки и проверки: сколько точек ждут и сколько свежих результатов. */
  return Object.assign(() => {
    prune();
    const t = now();
    const fresh = [...results.values()].filter(r => t - r.at <= FRESH_MS);
    const last = Math.max(0, ...[...results.values()].map(r => r.at));
    return { scouts: scouts().length, wanted: wanted.size, fresh: fresh.length,
      hot: fresh.filter(r => r.value > 0).length, lastAgeSec: last ? Math.round((t - last) / 1000) : null };
  }, { watch });
};

module.exports.single = single;
module.exports.km = km;
