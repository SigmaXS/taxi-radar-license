const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('../scout');

function fixture(env = { SCOUT_DEVICE_IDS: 'scout-1' }) {
  const routes = {};
  let t = 1800000000000;
  const stats = register({ post: (path, fn) => { routes[path] = fn; } }, {
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
