const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('../community');
function fixture() {
  const routes = new Map(), queries = [];
  const pool = { query: async (sql, args = []) => {
    queries.push({ sql, args });
    if (sql.startsWith('SELECT status')) return { rows: [{ status: 'active', expires: new Date(Date.now() + 86400000) }] };
    if (sql.startsWith('INSERT INTO road_reports')) return { rows: [{ id: 5 }] };
    if (sql.startsWith('SELECT type, device_id')) return { rows: [{ type: 'danger', device_id: 'author' }] };
    if (sql.startsWith('SELECT COUNT(*) AS n FROM report_votes')) return { rows: [{ n: 1 }] };
    return { rows: [], rowCount: 1 };
  } };
  const interval = global.setInterval;
  global.setInterval = () => ({ unref() {} });
  try { register({ locals: {}, post: (path, handler) => routes.set(path, handler), get() {} }, pool,
    { isValidDeviceId: id => id === 'driver', escapeHtml: s => s }); } finally { global.setInterval = interval; }
  async function call(path, body) {
    let result, status = 200;
    const res = { json: data => { result = data; return res; }, status: value => { status = value; return res; } };
    await routes.get(path)({ body: { device_id: 'driver', ...body } }, res);
    return { result, status };
  }
  return { queries, call };
}
test('police/radar/danger/accident/jam expire in one hour; closure, pothole and address marks have no expiry', async () => {
  for (const type of ['police', 'radar', 'danger', 'accident', 'closure', 'jam', 'pothole', 'addr_noshow', 'addr_hard', 'addr_cancel']) {
    const f = fixture(), start = Date.now();
    const r = await f.call('/api/reports/add', { type, lat: 47.0, lon: 28.8 });
    assert.equal(r.result.ok, true);
    const expires = f.queries.find(q => q.sql.startsWith('INSERT INTO road_reports')).args[4];
    if (['police', 'radar', 'danger', 'accident', 'jam'].includes(type)) assert.ok(expires.getTime() - start >= 3600000 && expires.getTime() - start < 3601000);
    else assert.equal(expires, null);
  }
});
test('one negative vote from another driver does not remove; yes extends a one-hour report', async () => {
  for (const still of [false, true]) {
    const f = fixture();
    assert.equal((await f.call('/api/reports/vote', { id: 5, still })).result.ok, true);
    const update = f.queries.find(q => q.sql.startsWith('UPDATE road_reports SET expires'));
    if (still) assert.ok(update.args[0] instanceof Date); // danger — час
    else assert.equal(update, undefined); // n = 1, не автор — метка остаётся
  }
});
test('history is scoped to requesting device, not supplied author; unlicensed requests fail', async () => {
  const f = fixture();
  await f.call('/api/reports/mine', { author: 'someone-else' });
  const query = f.queries.find(q => q.sql.includes('FROM road_reports WHERE device_id = $1'));
  assert.deepEqual(query.args, ['driver']);
  assert.equal((await f.call('/api/reports/mine', { device_id: 'unknown' })).status, 403);
});
test('invalid report types, malformed confirmations and invalid removal ids are rejected', async () => {
  const f = fixture();
  assert.equal((await f.call('/api/reports/add', { type: 'toString', lat: 47, lon: 28.8 })).result.ok, false);
  assert.equal((await f.call('/api/reports/vote', { id: 5, still: 'false' })).result.ok, false);
  assert.equal((await f.call('/api/places/delete', { id: '5bad' })).result.ok, false);
});
