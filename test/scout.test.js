const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('../scout');

function fixture(env = { SCOUT_DEVICE_IDS: 'scout-1' }) {
  const routes = {};
  let t = 1800000000000;
  const stats = register({ post: (path, fn) => { routes[path] = fn; }, get: (path, fn) => { routes['GET ' + path] = fn; } }, {
    member: fn => (req, res) => fn(req, res, req.device)
  }, { env, now: () => t });
  const call = async (path, body, device = 'driver-1') => {
    let status = 200, result;
    const res = { status(v) { status = v; return this; }, json(v) { result = v; return this; } };
    await routes[path]({ body, device }, res);
    return { status, ...result };
  };
  return { call, stats, tick: ms => { t += ms; } };
}

test('driver point is queued, scout checks it, driver gets the surge', async () => {
  const f = fixture();
  const first = await f.call('/api/scout/near', { lat: 46.9939, lon: 28.8505 });
  assert.equal(first.surge, null);
  const tasks = await f.call('/api/scout/tasks', {}, 'scout-1');
  assert.equal(tasks.points.length, 1);
  assert.ok(Math.abs(tasks.points[0].lat - 46.994) < 1e-9);
  await f.call('/api/scout/result', { ...tasks.points[0], values: { econom: null, comfort: 55, comfortplus: 55 } }, 'scout-1');
  f.tick(30e3);
  const again = await f.call('/api/scout/near', { lat: 46.9941, lon: 28.8507 });
  assert.equal(again.surge, 55); // нет машин Эконома — берём Комфорт: надбавка одна на все тарифы
});

test('far from Chisinau: 0 at once, no scouting', async () => {
  const f = fixture();
  const r = await f.call('/api/scout/near', { lat: 47.30, lon: 28.60 });
  assert.equal(r.surge, 0); assert.equal(r.far, true);
  assert.equal((await f.call('/api/scout/tasks', {}, 'scout-1')).points.length, 0);
});

test('only listed scouts get tasks or post results', async () => {
  const f = fixture();
  assert.equal((await f.call('/api/scout/tasks', {}, 'driver-1')).status, 403);
  assert.equal((await f.call('/api/scout/result', { lat: 47, lon: 28.8, values: {} }, 'driver-1')).status, 403);
});

test('no cars on any tariff is no data, not zero; old results expire', async () => {
  const f = fixture();
  await f.call('/api/scout/near', { lat: 47.0, lon: 28.85 });
  await f.call('/api/scout/result', { lat: 47.0, lon: 28.85, values: { econom: null, comfort: null, comfortplus: null } }, 'scout-1');
  assert.equal((await f.call('/api/scout/near', { lat: 47.0, lon: 28.85 })).surge, null);
  await f.call('/api/scout/result', { lat: 47.0, lon: 28.85, values: { econom: 15, comfort: 15, comfortplus: 15 } }, 'scout-1');
  assert.equal((await f.call('/api/scout/near', { lat: 47.0, lon: 28.85 })).surge, 15);
  f.tick(6 * 60e3);
  assert.equal((await f.call('/api/scout/near', { lat: 47.0, lon: 28.85 })).surge, null);
});

test('a point handed to the scout is not handed out again for a minute', async () => {
  const f = fixture();
  await f.call('/api/scout/near', { lat: 47.0, lon: 28.85 });
  assert.equal((await f.call('/api/scout/tasks', {}, 'scout-1')).points.length, 1);
  assert.equal((await f.call('/api/scout/tasks', {}, 'scout-1')).points.length, 0);
});

test('majority value across tariffs; ties take the larger', () => {
  assert.equal(register.single({ econom: 15, comfort: 15, comfortplus: 35 }), 15);
  assert.equal(register.single({ econom: 15, comfort: 35, comfortplus: null }), 35);
  assert.equal(register.single({ econom: null, comfort: null, comfortplus: null }), null);
});

test('point B is checked after driver points and at most every 2.5 minutes', async () => {
  const f = fixture();
  await f.call('/api/scout/near', { lat: 47.0, lon: 28.85, b_lat: 47.05, b_lon: 28.80 });
  const t1 = await f.call('/api/scout/tasks', {}, 'scout-1');
  assert.equal(t1.points.length, 2);
  assert.ok(Math.abs(t1.points[0].lat - 47.0) < 1e-9, 'driver point first');
  await f.call('/api/scout/result', { lat: 47.05, lon: 28.80, values: { econom: 35, comfort: 35, comfortplus: 35 } }, 'scout-1');
  await f.call('/api/scout/result', { lat: 47.0, lon: 28.85, values: { econom: 15, comfort: 15, comfortplus: 15 } }, 'scout-1');
  const r = await f.call('/api/scout/near', { lat: 47.0, lon: 28.85, b_lat: 47.05, b_lon: 28.80 });
  assert.equal(r.surge, 15); assert.equal(r.surge_b, 35);
  f.tick(90e3);
  const t2 = await f.call('/api/scout/tasks', {}, 'scout-1');
  assert.equal(t2.points.length, 1, 'after 90 s only the driver point is due');
});

test('few driver points are rechecked every 20 s, many every minute', async () => {
  const f = fixture();
  await f.call('/api/scout/near', { lat: 47.0, lon: 28.85 });
  await f.call('/api/scout/tasks', {}, 'scout-1');
  await f.call('/api/scout/result', { lat: 47.0, lon: 28.85, values: { econom: 15, comfort: 15, comfortplus: 15 } }, 'scout-1');
  f.tick(25e3);
  assert.equal((await f.call('/api/scout/tasks', {}, 'scout-1')).points.length, 1, 'one driver: due again after 20 s');
  for (let i = 0; i < 6; i++) await f.call('/api/scout/near', { lat: 47.01 + i * 0.01, lon: 28.85 }, 'driver-' + (i + 2));
  await f.call('/api/scout/near', { lat: 47.0, lon: 28.85 });
  await f.call('/api/scout/result', { lat: 47.0, lon: 28.85, values: { econom: 15, comfort: 15, comfortplus: 15 } }, 'scout-1');
  f.tick(25e3);
  const t = await f.call('/api/scout/tasks', {}, 'scout-1');
  assert.ok(!t.points.some(p => Math.abs(p.lat - 47.0) < 1e-9), 'seven drivers: not due after 25 s');
});

test('a driver who moved: the old point leaves the queue at once', async () => {
  const f = fixture();
  await f.call('/api/scout/near', { lat: 47.0, lon: 28.85 }, 'driver-1');
  await f.call('/api/scout/near', { lat: 47.0, lon: 28.85 }, 'driver-2');
  await f.call('/api/scout/near', { lat: 47.02, lon: 28.85 }, 'driver-1'); // уехал
  let t = await f.call('/api/scout/tasks', {}, 'scout-1');
  assert.equal(t.points.length, 2, 'driver-2 still stands at the old point');
  f.tick(30e3);
  await f.call('/api/scout/near', { lat: 47.04, lon: 28.85 }, 'driver-2'); // и этот уехал
  await f.call('/api/scout/near', { lat: 47.02, lon: 28.85 }, 'driver-1');
  f.tick(30e3);
  t = await f.call('/api/scout/tasks', {}, 'scout-1');
  assert.ok(!t.points.some(p => Math.abs(p.lat - 47.0) < 1e-9), 'nobody at the old point any more');
});

test('driver on the move: a fresh check within 1.2 km is used until the new point is checked', async () => {
  const f = fixture();
  await f.call('/api/scout/near', { lat: 47.0, lon: 28.85 });
  await f.call('/api/scout/result', { lat: 47.0, lon: 28.85, values: { econom: 15, comfort: 15, comfortplus: 15 } }, 'scout-1');
  const moved = await f.call('/api/scout/near', { lat: 47.008, lon: 28.85 }); // ~0.9 км
  assert.equal(moved.surge, 15);
  const far = await f.call('/api/scout/near', { lat: 47.03, lon: 28.85 }, 'driver-9'); // ~3.3 км
  assert.equal(far.surge, null);
  f.tick(4 * 60e3);
  assert.equal((await f.call('/api/scout/near', { lat: 47.008, lon: 28.85 }, 'driver-8')).surge, null, 'too old for the fallback');
});
