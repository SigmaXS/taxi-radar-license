// Автоимпорт событий: концерты, фестивали, шоу, стендап и спорт на крупных площадках
// Кишинёва (где потом выходит много людей). Два источника:
//  • iticket.md — разделы concert / festival / standup;
//  • afisha.md — разделы «Кишинёв Арена», «Концерты», «Шоу», «Спорт» (там много того, чего нет в iticket).
// Раз в 6 часов; новые — в таблицу events с пометкой source. Одно и то же событие на двух
// сайтах не дублируем (та же площадка, начало в пределах 1,5 часа). Если админ перенёс или
// отменил событие — импорт его больше не трогает (admin_edited).
const DEFAULT_HOURS = 2.5;
const HORIZON_DAYS = 14;

// Крупные площадки: как узнать по названию и где стоит (координаты — для «На карте»).
const VENUES = [
  { re: /арена|arena chi/i, key: 'arena', lat: 47.07278, lon: 28.86283 },
  { re: /дворец республики|palatul republicii/i, key: 'republicii', lat: 47.02449, lon: 28.82465 },
  { re: /national.*sulac|sulac|национальный дворец|palatul na[țt]ional/i, key: 'sulac', lat: 47.02261, lon: 28.83125 },
  { re: /опер[ыа] и балета|opera și balet|opera si balet|teatrul na[țt]ional de oper/i, key: 'opera', lat: 47.02783, lon: 28.83025 },
  { re: /стадион|stadion/i, key: 'stadion', lat: null, lon: null },
  { re: /moldexpo|молдэкспо/i, key: 'moldexpo', lat: null, lon: null },
  { re: /пвнс|marii adun|великого национального собрания/i, key: 'pman', lat: 47.02420, lon: 28.83400 },
  { re: /зел[её]ный театр|teatrul verde/i, key: 'verde', lat: null, lon: null },
];
// Оперу, балет, спектакли и детское не берём.
const SKIP_TITLE = /опер[аы]\b|opera\b|балет|balet|ballet|copii|детск|спектакл|spectacol|flautul|zurli|forum|форум|networking|нетворкинг|training|тренинг/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = { 'User-Agent': 'TaxiRadar-server/1.0 (+events for taxi drivers)' };

async function get(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

function ldItems(html) {
  const out = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      for (const x of (Array.isArray(j) ? j : (j['@graph'] || [j]))) if (x && typeof x === 'object') out.push(x);
    } catch (e) { /* битый блок — пропускаем */ }
  }
  return out;
}

/** «2026-10-16T20:00:00» без пояса — время по Кишинёву → настоящая дата. */
function chisinauLocal(s) {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return new Date(s);
  return require('./events').chisinauToUtc(String(s).slice(0, 16));
}

/** Со страницы события (JSON-LD Event): подходит ли и что записать. null — не подходит. */
function parseEvent(html, url, category = '') {
  const ev = ldItems(html).find(x => String(x['@type']).includes('Event'));
  if (!ev || !ev.startDate) return null;
  const title = String(ev.name || '').trim().slice(0, 120);
  const loc = ev.location || {};
  const venue = String(loc.name || '').trim();
  const addr = loc.address || {};
  const city = String(addr.addressLocality || '');
  // afisha.md не пишет город — крупные площадки и так кишинёвские.
  if (city && !/кишин|chi[șs]in/i.test(city + ' ' + venue)) return null;
  const big = VENUES.find(v => v.re.test(venue));
  if (!big || SKIP_TITLE.test(title)) return null;
  // В Оперном театре — только стендап: остальное там опера, балет и спектакли.
  if (big.key === 'opera' && category !== 'standup') return null;
  // Время 00:00 на сайте — значит, не указано: ставим 19:00 и предупреждаем в заметке.
  const noTime = /T00:00(:00)?$/.test(String(ev.startDate)) || /^\d{4}-\d\d-\d\d$/.test(String(ev.startDate));
  const starts = noTime ? chisinauLocal(String(ev.startDate).slice(0, 10) + 'T19:00') : chisinauLocal(ev.startDate);
  if (!starts || Number.isNaN(starts.getTime())) return null;
  let ends = ev.endDate ? chisinauLocal(ev.endDate) : null;
  if (!ends || !(ends > starts) || ends - starts > 12 * 3600e3) ends = new Date(starts.getTime() + DEFAULT_HOURS * 3600e3);
  const geo = loc.geo || {};
  const lat = Number(geo.latitude), lon = Number(geo.longitude);
  return {
    title, url, starts, ends, venueKey: big.key, noTime,
    place: (venue + (addr.streetAddress ? ', ' + addr.streetAddress : '')).slice(0, 160),
    lat: Number.isFinite(lat) && lat > 45 ? lat : big.lat, lon: Number.isFinite(lon) && lon > 26 ? lon : big.lon
  };
}

// ---------- списки событий на сайтах ----------

async function iticketUrls() {
  const urls = new Map();
  for (const cat of ['concert', 'festival', 'standup']) {
    const html = await get(`https://iticket.md/ru/events/${cat}`).catch(() => '');
    for (const x of ldItems(html)) if (x['@type'] === 'ItemList') for (const i of x.itemListElement || []) if (i.url && !urls.has(i.url)) urls.set(i.url, cat);
    await sleep(1000);
  }
  return urls;
}

/** afisha.md отдаёт список в «RSC»-данных страницы: id, название и адрес каждого события. */
async function afishaUrls() {
  const urls = new Map();
  for (const [cat, as] of [['chisinau-arena', 'concert'], ['concerte', 'concert'], ['performance', 'show'], ['sport-events', 'concert']]) {
    const txt = await get(`https://afisha.md/ru/events/${cat}`, { RSC: '1' }).catch(() => '');
    for (const m of txt.matchAll(/"id":"(\d{4,7})","title":"(?:[^"\\]|\\.)*","url":"([a-z0-9-]+)","type":"EVENT"/g)) {
      const url = `https://afisha.md/ru/events/${cat}/${m[1]}/${m[2]}`;
      if (![...urls.keys()].some(u => u.includes(`/${m[1]}/`))) urls.set(url, as);
    }
    await sleep(1000);
  }
  return urls;
}

module.exports = function setupEventsImport(pool, geocoder) {
  // Колонки добавляем перед каждым импортом: таблицу events создаёт events.js, и при старте
  // сервера она может появиться позже, чем этот модуль.
  const ensure = () => pool.query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS source VARCHAR(20);
    ALTER TABLE events ADD COLUMN IF NOT EXISTS source_url VARCHAR(300);
    ALTER TABLE events ADD COLUMN IF NOT EXISTS admin_edited BOOLEAN NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX IF NOT EXISTS events_source_url ON events (source_url) WHERE source_url IS NOT NULL;
  `);
  setTimeout(() => ensure().catch(() => {}), 20e3).unref();

  let running = false;
  async function run() {
    if (running) return null;
    running = true;
    let added = 0, updated = 0, seen = 0, dup = 0;
    try {
      await ensure();
      // Сколько людей придёт, сайты не пишут; вместимость зала вводила в заблуждение — не показываем.
      await pool.query(`UPDATE events SET people = NULL WHERE source IS NOT NULL AND people IS NOT NULL`);
      const sources = [['iticket', await iticketUrls()], ['afisha', await afishaUrls()]];
      const horizon = Date.now() + HORIZON_DAYS * 86400e3;
      for (const [source, urls] of sources) {
        const site = source === 'iticket' ? 'iticket.md' : 'afisha.md';
        for (const [url, cat] of urls) {
          const html = await get(url).catch(() => null);
          await sleep(1000); // бережно к сайту: не чаще раза в секунду
          if (!html) continue;
          const e = parseEvent(html, url, cat);
          if (!e || e.ends < new Date() || e.starts > horizon) continue;
          seen++;
          const old = (await pool.query('SELECT id, starts, admin_edited FROM events WHERE source_url = $1', [url])).rows[0];
          if (old) {
            if (!old.admin_edited && new Date(old.starts).getTime() !== e.starts.getTime()) {
              // Перенесли на сайте — переносим и у нас (напоминания водителей переставятся сами).
              await pool.query('UPDATE events SET starts = $2, ends = $3, updated = NOW() WHERE id = $1', [old.id, e.starts, e.ends]);
              updated++;
            }
            continue;
          }
          // То же событие уже есть (с другого сайта или добавлено вручную): та же площадка, начало ±1,5 ч.
          const twin = (await pool.query(
            `SELECT id FROM events WHERE status <> 'deleted' AND ABS(EXTRACT(EPOCH FROM starts - $1::timestamptz)) < 5400
             AND (place ILIKE $2 OR (lat IS NOT NULL AND $3::float8 IS NOT NULL AND ABS(lat - $3) < 0.003 AND ABS(lon - $4) < 0.004))`,
            [e.starts, '%' + e.place.split(',')[0].slice(0, 20) + '%', e.lat, e.lon])).rows[0];
          if (twin) { dup++; continue; }
          if (e.lat == null && geocoder) {
            const p = await geocoder.findAny(e.place).catch(() => null);
            if (p) { e.lat = p.lat; e.lon = p.lon; }
          }
          await pool.query(
            `INSERT INTO events (title, place, lat, lon, starts, ends, people, note, source, source_url)
             VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9) ON CONFLICT DO NOTHING`,
            [e.title, e.place, e.lat, e.lon, e.starts, e.ends, e.noTime ? `По данным ${site}; время начала не указано — уточняйте` : `По данным ${site}; окончание примерное`, source, url]);
          added++;
        }
      }
      console.log(`События: подходящих ${seen}, новых ${added}, повторов ${dup}, перенесено ${updated}`);
    } catch (err) {
      console.error('events import:', err.message);
    } finally {
      running = false;
    }
    return { seen, added, updated, dup };
  }

  setTimeout(() => run(), 3 * 60e3).unref();
  setInterval(() => run(), 6 * 3600e3).unref();
  return { run };
};

module.exports.parseEvent = parseEvent;

module.exports.afishaUrls = afishaUrls;
module.exports.iticketUrls = iticketUrls;
