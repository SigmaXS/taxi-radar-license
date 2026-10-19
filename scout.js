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
const LEASE_MS = 60e3;         // выданную разведчику точку минуту не отдаём другому
const RECHECK_MS = 60e3;       // точку водителя — не чаще раза в минуту
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

/** Надбавка в точке одна на все тарифы: берём значение большинства известных тарифов (при равенстве — большее). */
function single(values) {
  const known = Object.values(values).filter(v => Number.isInteger(v));
  if (!known.length) return null;
  const count = new Map();
  known.forEach(v => count.set(v, (count.get(v) || 0) + 1));
  return [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

module.exports = function registerScout(app, { member }, options = {}) {
  const now = options.now || Date.now;
  const env = options.env || process.env;
  const radiusKm = () => { const n = parseFloat(env.SCOUT_RADIUS_KM); return Number.isFinite(n) && n > 0 ? n : 20; };
  const scouts = () => String(env.SCOUT_DEVICE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

  const wanted = new Map();   // cell → { at: последний раз водитель тут, lease: до когда выдана разведчику }
  const results = new Map();  // cell → { at, value, values, lat, lon }

  function prune() {
    const t = now();
    for (const [k, w] of wanted) if (t - w.at > WANT_MS) wanted.delete(k);
    for (const [k, r] of results) if (t - r.at > FRESH_MS * 3) results.delete(k);
  }

  function nearest(p) {
    const t = now();
    let best = null;
    for (const r of results.values()) {
      if (t - r.at > FRESH_MS || r.value === null) continue;
      const d = km(p, r);
      if (d <= NEAR_KM && (!best || d < best.d)) best = { d, r };
    }
    return best?.r || null;
  }

  function want(lat, lon, b) {
    const key = cellOf(lat, lon);
    const w = wanted.get(key) || { at: 0, lease: 0, b: true };
    w.at = now(); w.b = w.b && b; // точка, где стоит хоть один водитель, важнее точки Б
    wanted.set(key, w);
  }

  // Радар водителя, раз в минуту: «я здесь» (и куда везу — b_lat/b_lon) → надбавка разведчика рядом.
  app.post('/api/scout/near', member(async (req, res) => {
    const { lat, lon, b_lat, b_lon } = req.body;
    if (!okCoord(lat, lon)) return res.status(400).json({ ok: false, code: 'bad_point' });
    prune();
    const out = { ok: true };
    if (km(CENTER, { lat, lon }) > radiusKm()) { out.surge = 0; out.far = true; }
    else {
      want(lat, lon, false);
      const r = nearest({ lat, lon });
      if (r) Object.assign(out, { surge: r.value, values: r.values, age_s: Math.round((now() - r.at) / 1000) });
      else Object.assign(out, { surge: null, scouting: scouts().length > 0 });
    }
    if (okCoord(b_lat, b_lon)) {
      if (km(CENTER, { lat: b_lat, lon: b_lon }) > radiusKm()) out.surge_b = 0;
      else { want(b_lat, b_lon, true); const rb = nearest({ lat: b_lat, lon: b_lon }); out.surge_b = rb ? rb.value : null; }
    }
    res.json(out);
  }));

  // Разведчик: дай точки для проверки — где водители, сначала давно не проверенные.
  app.post('/api/scout/tasks', member(async (req, res, deviceId) => {
    if (!scouts().includes(deviceId)) return res.status(403).json({ ok: false, code: 'not_scout' });
    prune();
    const t = now();
    const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 8, 1), 20);
    const list = [...wanted.entries()]
      .filter(([, w]) => w.lease < t)
      .map(([k, w]) => ({ k, w, checked: results.get(k)?.at || 0 }))
      // Точки водителей — раз в минуту; точки Б — раз в 2,5 мин и в конце очереди.
      .filter(x => t - x.checked > (x.w.b ? RECHECK_B_MS : RECHECK_MS))
      .sort((a, b) => (a.w.b - b.w.b) || (a.checked - b.checked))
      .slice(0, limit);
    list.forEach(x => { x.w.lease = t + LEASE_MS; });
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
    results.set(key, { at: now(), value, values, lat, lon });
    const w = wanted.get(key); if (w) w.lease = 0;
    const spread = Object.values(values).filter(Number.isInteger);
    if (spread.length > 1 && Math.max(...spread) !== Math.min(...spread)) {
      console.log(`scout: разные надбавки по тарифам в ${lat.toFixed(4)},${lon.toFixed(4)}: ${JSON.stringify(values)} — проверьте скидки аккаунта разведчика`);
    }
    res.json({ ok: true, value });
  }));

  /** Для админки и проверки: сколько точек ждут и сколько свежих результатов. */
  return () => {
    prune();
    const t = now();
    const fresh = [...results.values()].filter(r => t - r.at <= FRESH_MS);
    const last = Math.max(0, ...[...results.values()].map(r => r.at));
    return { scouts: scouts().length, wanted: wanted.size, fresh: fresh.length,
      hot: fresh.filter(r => r.value > 0).length, lastAgeSec: last ? Math.round((t - last) / 1000) : null };
  };
};

module.exports.single = single;
module.exports.km = km;
