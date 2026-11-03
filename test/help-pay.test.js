const test = require('node:test');
const assert = require('node:assert/strict');

function routes() {
  const map = new Map();
  const app = { locals: {}, post: (p, h) => map.set('POST ' + p, h), get: (p, h) => map.set('GET ' + p, h) };
  async function call(key, req) {
    let result, status = 200, sent;
    const res = { json: d => { result = d; return res; }, status: v => { status = v; return res; }, send: v => { sent = v; return res; }, redirect() {} };
    await map.get(key)(req, res);
    return { result, status, sent };
  }
  return { app, call };
}

test('help: phone and point stay hidden until the driver taps "help"; danger shows them to everyone', async () => {
  const created = new Date().toISOString();
  const row = (kind, mine) => ({ id: 7, kind, price: 100, note: '', phone: '+37378000000', lat: 47.01, lon: 28.85, created, helpers: 0, mine_help: mine, device_id: 'other' });
  for (const [kind, mine, visible] of [['jump', false, false], ['jump', true, true], ['danger', false, true]]) {
    const { app, call } = routes();
    const pool = { query: async sql => {
      if (sql.startsWith('SELECT status')) return { rows: [{ status: 'active', expires: new Date(Date.now() + 86400000) }] };
      if (sql.includes('FROM help_requests h')) return { rows: [row(kind, mine)] };
      return { rows: [] };
    } };
    const interval = global.setInterval;
    global.setInterval = () => ({ unref() {} });
    try { require('../community')(app, pool, { isValidDeviceId: id => id === 'driver', escapeHtml: s => s }); } finally { global.setInterval = interval; }
    const r = await call('POST /api/help/nearby', { body: { device_id: 'driver', lat: 47.0, lon: 28.85 } });
    assert.equal(r.result.requests.length, 1);
    assert.equal('phone' in r.result.requests[0], visible, `${kind} mine=${mine}`);
  }
});

test('pay: confirm link needs a valid signature, then extends the device once', async () => {
  process.env.ADMIN_PASSWORD = 'secret';
  const { app, call } = routes();
  const queries = [];
  let status = 'new';
  const claim = () => ({ id: 3, device_id: 'driver', days: 30, price: 99, phone: '+37378000000', status, created: new Date(), decided: new Date() });
  const pool = { query: async (sql, args) => {
    queries.push(sql);
    if (sql.startsWith('SELECT * FROM pay_claims')) return { rows: [claim()] };
    if (sql.startsWith('UPDATE pay_claims')) { if (status !== 'new') return { rows: [] }; status = args[0]; return { rows: [claim()] }; }
    if (sql.includes('INSERT INTO devices')) return { rows: [{ expires: new Date(), status: 'active' }] };
    return { rows: [] };
  } };
  let rewarded = 0;
  require('../payments')(app, pool, { isValidDeviceId: () => true, escapeHtml: s => String(s), parseTariffs: () => [{ days: 30, price: 99 }], rewardReferrer: async () => { rewarded++; } });
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', 'secret').update('pay:3:ok').digest('hex').slice(0, 32);
  assert.equal((await call('POST /pay/:action/:id/:sig', { method: 'POST', params: { action: 'ok', id: '3', sig: 'x'.repeat(32) } })).status, 403);
  // Открыть ссылку — ещё ничего не меняет.
  await call('GET /pay/:action/:id/:sig', { method: 'GET', params: { action: 'ok', id: '3', sig } });
  assert.equal(queries.filter(q => q.includes('INSERT INTO devices')).length, 0);
  await call('POST /pay/:action/:id/:sig', { method: 'POST', params: { action: 'ok', id: '3', sig }, originalUrl: '/pay/ok/3/' + sig });
  await call('POST /pay/:action/:id/:sig', { method: 'POST', params: { action: 'ok', id: '3', sig }, originalUrl: '/pay/ok/3/' + sig });
  assert.equal(queries.filter(q => q.includes('INSERT INTO devices')).length, 1);
  assert.equal(rewarded, 1);
});
