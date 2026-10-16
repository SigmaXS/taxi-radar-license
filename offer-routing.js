// Маршрут для карточки заказа (подача и поездка) с живыми пробками — по очереди из нескольких
// сервисов: первый, у кого не кончился бесплатный лимит, считает; кончился или ошибся — следующий.
// Ключи только в Railway: TOMTOM_API_KEY, HERE_API_KEY, MAPBOX_TOKEN, GOOGLE_ROUTES_API_KEY.
// Порядок — ROUTE_PROVIDERS (по умолчанию только tomtom; например «tomtom,here,mapbox,google»). Лимиты бесплатных тарифов
// взяты с запасом и меняются переменными: TOMTOM_DAILY_LIMIT, HERE_MONTHLY_LIMIT, MAPBOX_MONTHLY_LIMIT.
// Адреса, GPS и ответы не сохраняем; в базе только счётчики запросов.

const GOOGLE_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const GOOGLE_FIELDS = 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline';

// ---------- полилинии: всё отдаём в формате Google (precision 5) ----------

function encodePolyline(points) {
  let out = '', pLat = 0, pLon = 0;
  const enc = v => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of points) {
    const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5);
    out += enc(a - pLat) + enc(b - pLon);
    pLat = a; pLon = b;
  }
  return out;
}

// Flexible Polyline (HERE): https://github.com/heremaps/flexible-polyline
const FLEX = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function decodeFlexible(str) {
  let i = 0;
  const uvar = () => {
    let result = 0, shift = 0, v;
    do {
      if (i >= str.length) throw new Error('route_invalid');
      v = FLEX.indexOf(str[i++]);
      if (v < 0) throw new Error('route_invalid');
      result += (v & 0x1f) * 2 ** shift;
      shift += 5;
    } while (v & 0x20);
    return result;
  };
  const svar = () => { const u = uvar(); return u % 2 ? -(u + 1) / 2 : u / 2; };
  if (uvar() !== 1) throw new Error('route_invalid');
  const header = uvar();
  const factor = 10 ** (header & 15), third = (header >> 4) & 7;
  const pts = [];
  let lat = 0, lon = 0;
  while (i < str.length) {
    lat += svar(); lon += svar();
    if (third) svar();
    pts.push([lat / factor, lon / factor]);
  }
  return pts;
}

function leg(meters, seconds, polyline) {
  if (!Number.isFinite(meters) || meters < 0 || !Number.isFinite(seconds) || seconds < 0 ||
      typeof polyline !== 'string' || !polyline) throw new Error('route_invalid');
  return { km: meters / 1000, minutes: seconds / 60, polyline };
}

// ---------- сервисы ----------

function googleSeconds(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?s$/.test(value)) throw new Error('route_invalid');
  return Number(value.slice(0, -1));
}

function parseRoute(json) {
  const r = json.routes?.[0];
  if (!r) throw new Error('route_not_found');
  return leg(r.distanceMeters, googleSeconds(r.duration), r.polyline?.encodedPolyline);
}

class LimitError extends Error { constructor() { super('route_limit'); } }

const PROVIDERS = {
  tomtom: {
    env: 'TOMTOM_API_KEY', period: 'day', limitEnv: 'TOMTOM_DAILY_LIMIT', limit: 2000, coords: true,
    async route(fetch, key, from, to, departure) {
      const url = `https://api.tomtom.com/routing/1/calculateRoute/${from.lat},${from.lon}:${to.lat},${to.lon}/json?` +
        new URLSearchParams({ key, traffic: 'true', travelMode: 'car', routeType: 'fastest', departAt: new Date(departure).toISOString().slice(0, 19) });
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (r.status === 429 || r.status === 403) throw new LimitError();
      if (!r.ok) throw new Error('route_provider_error');
      const j = await r.json();
      const route = j.routes?.[0];
      if (!route) throw new Error('route_not_found');
      const pts = (route.legs || []).flatMap(l => (l.points || []).map(p => [p.latitude, p.longitude]));
      return leg(route.summary?.lengthInMeters, route.summary?.travelTimeInSeconds, pts.length ? encodePolyline(pts) : '');
    }
  },
  here: {
    env: 'HERE_API_KEY', period: 'month', limitEnv: 'HERE_MONTHLY_LIMIT', limit: 25000, coords: true,
    async route(fetch, key, from, to, departure) {
      const url = 'https://router.hereapi.com/v8/routes?' + new URLSearchParams({
        transportMode: 'car', origin: `${from.lat},${from.lon}`, destination: `${to.lat},${to.lon}`,
        return: 'summary,polyline', departureTime: new Date(departure).toISOString().slice(0, 19), apikey: key });
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (r.status === 429 || r.status === 403) throw new LimitError();
      if (!r.ok) throw new Error('route_provider_error');
      const j = await r.json();
      const s = j.routes?.[0]?.sections;
      if (!s || !s.length) throw new Error('route_not_found');
      const pts = s.flatMap(x => decodeFlexible(x.polyline));
      return leg(s.reduce((a, x) => a + (x.summary?.length || 0), 0), s.reduce((a, x) => a + (x.summary?.duration || 0), 0), encodePolyline(pts));
    }
  },
  mapbox: {
    env: 'MAPBOX_TOKEN', period: 'month', limitEnv: 'MAPBOX_MONTHLY_LIMIT', limit: 90000, coords: true,
    async route(fetch, key, from, to, departure) {
      const params = { access_token: key, geometries: 'polyline', overview: 'full' };
      // depart_at — только в будущем; для подачи (сейчас) не передаём: driving-traffic и так берёт текущие пробки.
      if (departure > Date.now() + 60000) params.depart_at = new Date(departure).toISOString().slice(0, 16);
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${from.lon},${from.lat};${to.lon},${to.lat}?` + new URLSearchParams(params);
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (r.status === 429 || r.status === 401 || r.status === 403) throw new LimitError();
      if (!r.ok) throw new Error('route_provider_error');
      const j = await r.json();
      const route = j.routes?.[0];
      if (!route) throw new Error('route_not_found');
      return leg(route.distance, route.duration, route.geometry);
    }
  },
  google: {
    env: 'GOOGLE_ROUTES_API_KEY', period: 'month', limitEnv: 'GOOGLE_MONTHLY_LIMIT', limit: Infinity, coords: false,
    async route(fetch, key, from, to, departure) {
      const point = p => p.lat != null ? { location: { latLng: { latitude: p.lat, longitude: p.lon } } } : { address: p.address };
      const r = await fetch(GOOGLE_ENDPOINT, {
        method: 'POST', signal: AbortSignal.timeout(6000),
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': GOOGLE_FIELDS },
        body: JSON.stringify({ origin: point(from), destination: point(to), departureTime: new Date(departure).toISOString(),
          travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE_OPTIMAL', computeAlternativeRoutes: false, languageCode: 'ro', units: 'METRIC' })
      });
      if (r.status === 429) throw new LimitError();
      if (!r.ok) throw new Error('route_provider_error');
      return parseRoute(await r.json());
    }
  }
};

// ---------- счётчики бесплатных лимитов ----------

function periodKey(period, t) {
  const d = new Date(t);
  return period === 'day' ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 7);
}

module.exports = function registerOfferRouting(app, { member, tooOften, geocoder, pool }, options = {}) {
  const fetchRoute = options.fetch || global.fetch;
  const now = options.now || Date.now;
  const env = options.env || process.env;
  const keyOf = name => String(env[PROVIDERS[name].env] || '').trim();
  const order = () => String(env.ROUTE_PROVIDERS || 'tomtom').split(',').map(s => s.trim().toLowerCase()).filter(n => PROVIDERS[n]);
  const limitOf = name => { const n = parseInt(env[PROVIDERS[name].limitEnv], 10); return Number.isFinite(n) && n >= 0 ? n : PROVIDERS[name].limit; };

  // provider → { key: период, n: запросов }; exhausted — сервис сам сказал «лимит» (до конца периода).
  const usage = {};
  const used = name => { const u = usage[name], k = periodKey(PROVIDERS[name].period, now()); return u && u.key === k ? u : (usage[name] = { key: k, n: 0, exhausted: false }); };
  if (pool) {
    pool.query(`CREATE TABLE IF NOT EXISTS route_usage (provider VARCHAR(20), period VARCHAR(10), n INT NOT NULL DEFAULT 0, PRIMARY KEY (provider, period))`)
      .then(() => pool.query('SELECT provider, period, n FROM route_usage'))
      .then(r => r.rows.forEach(row => { if (PROVIDERS[row.provider]) { const u = used(row.provider); if (u.key === row.period) u.n = Math.max(u.n, row.n); } }))
      .catch(e => console.error('route_usage:', e.message));
  }
  function count(name, n) {
    const u = used(name);
    u.n += n;
    if (pool) pool.query(`INSERT INTO route_usage (provider, period, n) VALUES ($1, $2, $3)
      ON CONFLICT (provider, period) DO UPDATE SET n = route_usage.n + $3`, [name, u.key, n]).catch(() => {});
  }
  const available = name => keyOf(name) && !used(name).exhausted && used(name).n + 2 <= limitOf(name);

  app.post('/api/offer-route', member(async (req, res, deviceId) => {
    res.set?.('Cache-Control', 'no-store');
    const { lat, lon, addresses, boarding_minutes = 0 } = req.body;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180 ||
        !Array.isArray(addresses) || addresses.length !== 2 ||
        addresses.some(a => typeof a !== 'string' || a.trim().length < 5 || a.length > 300) ||
        typeof boarding_minutes !== 'number' || !Number.isFinite(boarding_minutes) || boarding_minutes < 0 || boarding_minutes > 30) {
      return res.status(400).json({ ok: false, code: 'route_invalid_input' });
    }
    const queue = order().filter(available);
    if (!queue.length) return res.status(503).json({ ok: false, code: 'route_not_configured' });
    // Карточка читается раз в секунду — запросы к сервисам ограничиваем.
    if (tooOften(`offer-route:${deviceId}`, 20, 60000)) return res.status(429).json({ ok: false, code: 'route_rate_limit' });

    const withCountry = v => /moldova|молдов/i.test(v) ? v : `${v}, Moldova`;
    const a = addresses[0].trim(), b = addresses[1].trim();
    // Координаты адресов — нашим геокодером (свои точки водителей, Яндекс); Google умеет и по тексту.
    let pa = null, pb = null;
    if (queue.some(n => PROVIDERS[n].coords) && geocoder) {
      const [ra, rb] = await Promise.all([geocoder.lookup(a).catch(() => null), geocoder.lookup(b).catch(() => null)]);
      if (ra?.found && rb?.found) { pa = { lat: ra.lat, lon: ra.lon }; pb = { lat: rb.lat, lon: rb.lon }; }
    }
    const departure = now() + 2000;
    let lastCode = 'route_provider_error';
    for (const name of queue) {
      const p = PROVIDERS[name];
      if (p.coords && !(pa && pb)) { lastCode = 'route_not_found'; continue; }
      const from = { lat, lon };
      const A = p.coords ? pa : { address: withCountry(a) }, B = p.coords ? pb : { address: withCountry(b) };
      try {
        const pickup = await p.route(fetchRoute, keyOf(name), from, A, departure);
        // Пассажир садится после подачи и посадки — поездку считаем с этого времени.
        const trip = await p.route(fetchRoute, keyOf(name), A, B, departure + (pickup.minutes + boarding_minutes) * 60000);
        count(name, 2);
        return res.json({ ok: true, provider: name, calculated_at: now(), pickup, trip });
      } catch (e) {
        count(name, 1);
        if (e instanceof LimitError) { used(name).exhausted = true; console.log(`offer-route: ${name} — лимит, дальше следующий`); }
        else console.log(`offer-route: ${name} — ${e.message}`);
        lastCode = e.message === 'route_not_found' ? 'route_not_found' : 'route_provider_error';
      }
    }
    res.status(502).json({ ok: false, code: lastCode });
  }));

  /** Для админки: сколько запросов израсходовано у каждого сервиса. */
  return () => order().map(name => ({ name, configured: !!keyOf(name), used: used(name).n, limit: limitOf(name), period: PROVIDERS[name].period, exhausted: used(name).exhausted }));
};

module.exports.parseRoute = parseRoute;
module.exports.encodePolyline = encodePolyline;
module.exports.decodeFlexible = decodeFlexible;
