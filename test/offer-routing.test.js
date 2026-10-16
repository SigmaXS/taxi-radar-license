const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('../offer-routing');
const request = { lat: 47.01, lon: 28.86, addresses: ['Zelinski 28/7, Chișinău', 'Bucovinei 5, Chișinău'], boarding_minutes: 2 };
const geocoder = { lookup: async q => q.startsWith('Zelinski') ? { found: true, lat: 46.99, lon: 28.85 } : { found: true, lat: 47.03, lon: 28.80 } };

// Ответы сервисов: подача 1,6 км / 5 мин, поездка 12,2 км / 36 мин.
function reply(url, n) {
  const pickup = n % 2 === 1;
  const m = pickup ? 1600 : 12200, s = pickup ? 300 : 2160;
  if (url.includes('tomtom')) return { routes: [{ summary: { lengthInMeters: m, travelTimeInSeconds: s }, legs: [{ points: [{ latitude: 47, longitude: 28.8 }, { latitude: 47.01, longitude: 28.81 }] }] }] };
  if (url.includes('hereapi')) return { routes: [{ sections: [{ summary: { length: m, duration: s }, polyline: 'BFoz5xJ67i1B1B7PzIhaxL7Y' }] }] };
  if (url.includes('mapbox')) return { routes: [{ distance: m, duration: s, geometry: '_p~iF~ps|U_ulLnnqC' }] };
  return { routes: [{ distanceMeters: m, duration: `${s}s`, polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] };
}

function fixture({ env = {}, status = {}, limited = false } = {}) {
  let handler;
  const calls = [];
  const stats = register({ post: (_, fn) => { handler = fn; } }, {
    member: fn => (req, res) => fn(req, res, 'licensed-test-driver'),
    tooOften: () => limited, geocoder
  }, { env, now: () => 1800000000000,
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
      const name = ['tomtom', 'hereapi', 'mapbox', 'googleapis'].find(x => url.includes(x));
      const code = status[name] || 200;
      return { ok: code === 200, status: code, json: async () => reply(url, calls.filter(c => c.url.includes(name)).length) };
    } });
  return { calls, stats, call: async (body = request) => {
    let code = 200, result;
    const res = { set() {}, status(v) { code = v; return this; }, json(v) { result = v; return this; } };
    await handler({ body }, res);
    return { status: code, result };
  } };
}

test('first configured provider in order answers; legs keep pickup and trip separate', async () => {
  const f = fixture({ env: { TOMTOM_API_KEY: 't', HERE_API_KEY: 'h' } });
  const r = await f.call();
  assert.equal(r.status, 200);
  assert.equal(r.result.provider, 'tomtom');
  assert.equal(r.result.pickup.minutes, 5); assert.equal(r.result.trip.minutes, 36); assert.equal(r.result.trip.km, 12.2);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].url.includes('47.01,28.86:46.99,28.85'));
});

test('provider limit reply moves to the next one and is remembered', async () => {
  const f = fixture({ env: { ROUTE_PROVIDERS: 'tomtom,here', TOMTOM_API_KEY: 't', HERE_API_KEY: 'h' }, status: { tomtom: 429 } });
  assert.equal((await f.call()).result.provider, 'here');
  const before = f.calls.length;
  assert.equal((await f.call()).result.provider, 'here');
  assert.equal(f.calls.slice(before).some(c => c.url.includes('tomtom')), false);
  assert.equal(f.stats().find(s => s.name === 'tomtom').exhausted, true);
});

test('own free limit stops using a provider before it bills', async () => {
  const f = fixture({ env: { ROUTE_PROVIDERS: 'tomtom,mapbox', TOMTOM_API_KEY: 't', TOMTOM_DAILY_LIMIT: '2', MAPBOX_TOKEN: 'm' } });
  assert.equal((await f.call()).result.provider, 'tomtom');
  assert.equal((await f.call()).result.provider, 'mapbox');
});

test('order is configurable; google works by address text', async () => {
  const f = fixture({ env: { ROUTE_PROVIDERS: 'google,tomtom', GOOGLE_ROUTES_API_KEY: 'g', TOMTOM_API_KEY: 't' } });
  const r = await f.call();
  assert.equal(r.result.provider, 'google');
  assert.equal(f.calls[0].body.routingPreference, 'TRAFFIC_AWARE_OPTIMAL');
  assert.equal(f.calls[1].body.destination.address, 'Bucovinei 5, Chișinău, Moldova');
  assert.equal(Date.parse(f.calls[1].body.departureTime) - Date.parse(f.calls[0].body.departureTime), 7 * 60000);
});

test('no keys, all failures and bad input never return made-up times', async () => {
  const none = fixture();
  assert.equal((await none.call()).result.code, 'route_not_configured'); assert.equal(none.calls.length, 0);
  const failed = fixture({ env: { TOMTOM_API_KEY: 't' }, status: { tomtom: 500 } });
  const r = await failed.call();
  assert.equal(r.status, 502); assert.equal(r.result.pickup, undefined);
  for (const patch of [{ lat: 91 }, { lon: NaN }, { addresses: ['one'] }, { boarding_minutes: 31 }]) {
    const f = fixture({ env: { TOMTOM_API_KEY: 't' } });
    assert.equal((await f.call({ ...request, ...patch })).status, 400); assert.equal(f.calls.length, 0);
  }
  const limited = fixture({ env: { TOMTOM_API_KEY: 't' }, limited: true });
  assert.equal((await limited.call()).status, 429); assert.equal(limited.calls.length, 0);
});

test('polylines: HERE flexible decodes, Google encoding matches known sample', () => {
  // Пример из документации HERE: (50.1022829, 8.6982122) … (50.0987800, 8.6875156)
  const pts = register.decodeFlexible('BFoz5xJ67i1B1B7PzIhaxL7Y');
  assert.equal(pts.length, 4);
  assert.ok(Math.abs(pts[0][0] - 50.10228) < 1e-4 && Math.abs(pts[3][1] - 8.68752) < 1e-4);
  // Пример из документации Google: (38.5,-120.2), (40.7,-120.95), (43.252,-126.453)
  assert.equal(register.encodePolyline([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.throws(() => register.parseRoute({ routes: [] }));
});

test('by default only TomTom is used, even if other keys are present', async () => {
  const f = fixture({ env: { HERE_API_KEY: 'h', MAPBOX_TOKEN: 'm' } });
  assert.equal((await f.call()).result.code, 'route_not_configured');
  assert.equal(f.calls.length, 0);
});
