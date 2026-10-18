const test = require('node:test');
const assert = require('node:assert/strict');
const createGeocoder = require('../geocoder');

function member(city, lat, lon, kind = 'house', precision = 'exact') {
  return {GeoObject: {Point: {pos: `${lon} ${lat}`}, metaDataProperty: {GeocoderMetaData: {
    kind, precision, Address: {Components: [{kind: 'locality', name: city}]}
  }}}};
}

test('route lookup uses only fresh verified Yandex results, shares concurrent work, and bypasses mixed cache', async () => {
  process.env.YANDEX_GEOCODER_KEY = 'test-key';
  const originalFetch = global.fetch;
  const calls = [], sql = [];
  global.fetch = async url => {
    calls.push(new URL(url).hostname);
    assert.equal(new URL(url).hostname, 'geocode-maps.yandex.ru');
    return {ok: true, json: async () => ({response: {GeoObjectCollection: {featureMember: [
      member('Stauceni', 47.12, 28.86),
      member('Chișinău', 47.02, 28.83, 'locality'),
      member('Кишинёв', 47.055, 28.865)
    ]}}})};
  };
  try {
    const geocoder = createGeocoder({query: async q => {sql.push(q); return {rows: [{lat: 47.12, lon: 28.86, v: 2}]};}});
    const address = 'Strada Bucovinei 5, Chișinău, Moldova';
    const [a, b] = await Promise.all([geocoder.lookupRoute(address), geocoder.lookupRoute(address)]);
    assert.deepEqual(a, {found: true, lat: 47.055, lon: 28.865, approx: false, source: 'yandex'});
    assert.deepEqual(b, a);
    assert.deepEqual(await geocoder.lookupRoute(address), a);
    assert.equal(calls.length, 1);
    assert.equal(sql.some(q => /^SELECT/i.test(q.trim())), false);
  } finally { global.fetch = originalFetch; }
});

test('missing Yandex address never falls back to OSM, a driver point or a city centroid', async () => {
  process.env.YANDEX_GEOCODER_KEY = 'test-key';
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async url => {
    calls.push(new URL(url).hostname);
    return {ok: true, json: async () => ({response: {GeoObjectCollection: {featureMember: [member('Chișinău', 47.02, 28.83, 'locality')]}}})};
  };
  try {
    const geocoder = createGeocoder({query: async () => ({rows: []})});
    assert.deepEqual(await geocoder.lookupRoute('Strada Bucovinei 5, Chișinău'), {found: false});
    assert.deepEqual(calls, ['geocode-maps.yandex.ru']);
  } finally { global.fetch = originalFetch; }
});
