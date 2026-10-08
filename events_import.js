// Автоимпорт событий с iticket.md: концерты, фестивали, стендап на крупных площадках
// Кишинёва (где потом выходит много людей). Раз в 6 часов; новые — в таблицу events
// с пометкой source='iticket'. Админ может перенести/отменить их как обычные — такие
// правки импорт больше не трогает (admin_edited).
const SITE = 'https://iticket.md/ru';
const CATEGORIES = ['concert', 'festival', 'standup'];
// Крупные площадки и примерная вместимость (для подписи «~N человек»).
const VENUES = [
  [/арена|arena chi/i, 10000],
  [/дворец республики|palatul republicii/i, 2800],
  [/national.*sulac|sulac|национальный дворец/i, 1300],
  [/опер[ыа] и балета|opera și balet|opera si balet/i, 1100],
  [/стадион|stadion/i, 10000],
  [/moldexpo|молдэкспо/i, 3000],
  [/пвнс|marii adun|великого национального собрания/i, 20000],
  [/зел[её]ный театр|teatrul verde/i, 5000],
];
// Оперу, балет, детские спектакли не берём.
const SKIP_TITLE = /опер[аы]\b|opera\b|балет|balet|ballet|copii|детск|спектакл|spectacol|flautul|zurli/i;
const DEFAULT_HOURS = 2.5;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'TaxiRadar-server/1.0 (+events for taxi drivers)' }, signal: AbortSignal.timeout(15000) });
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

/** Из страницы события: название, площадка, координаты, начало и конец. null — не подходит. */
function parseEvent(html, url, category = '') {
  const ev = ldItems(html).find(x => String(x['@type']).includes('Event'));
  if (!ev || !ev.startDate) return null;
  const title = String(ev.name || '').trim().slice(0, 120);
  const loc = ev.location || {};
  const venue = String(loc.name || '').trim();
  const city = String((loc.address || {}).addressLocality || '');
  if (!/кишин|chi[șs]in/i.test(city + ' ' + venue)) return null;
  const big = VENUES.find(([re]) => re.test(venue));
  if (!big || SKIP_TITLE.test(title)) return null;
  // В Оперном театре — только стендап: остальное там опера, балет и спектакли.
  if (/опер[ыа] и балета|opera/i.test(venue) && category !== 'standup') return null;
  const starts = new Date(ev.startDate);
  let ends = ev.endDate ? new Date(ev.endDate) : null;
  if (!ends || !(ends > starts) || ends - starts > 12 * 3600e3) ends = new Date(starts.getTime() + DEFAULT_HOURS * 3600e3);
  const geo = loc.geo || {};
  const lat = Number(geo.latitude), lon = Number(geo.longitude);
  return {
    title, url, starts, ends,
    place: (venue + ((loc.address || {}).streetAddress ? ', ' + loc.address.streetAddress : '')).slice(0, 160),
    lat: Number.isFinite(lat) && lat > 45 ? lat : null, lon: Number.isFinite(lon) && lon > 26 ? lon : null,
    people: big[1]
  };
}

module.exports = function setupEventsImport(pool) {
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
    if (running) return;
    running = true;
    let added = 0, updated = 0, seen = 0;
    try {
      await ensure();
      const urls = new Map(); // адрес -> раздел (concert/festival/standup)
      for (const cat of CATEGORIES) {
        const html = await get(`${SITE}/events/${cat}`).catch(() => '');
        for (const x of ldItems(html)) if (x['@type'] === 'ItemList') for (const i of x.itemListElement || []) if (i.url && !urls.has(i.url)) urls.set(i.url, cat);
        await sleep(1000);
      }
      const horizon = Date.now() + 14 * 86400e3;
      for (const [url, cat] of urls) {
        const html = await get(url).catch(() => null);
        await sleep(1000); // бережно к сайту: не чаще раза в секунду
        if (!html) continue;
        const e = parseEvent(html, url, cat);
        if (!e || e.ends < new Date() || e.starts > horizon) continue;
        seen++;
        const old = (await pool.query('SELECT id, starts, ends, admin_edited FROM events WHERE source_url = $1', [url])).rows[0];
        if (!old) {
          await pool.query(
            `INSERT INTO events (title, place, lat, lon, starts, ends, people, note, source, source_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'iticket', $9) ON CONFLICT DO NOTHING`,
            [e.title, e.place, e.lat, e.lon, e.starts, e.ends, e.people, 'По данным iticket.md; окончание примерное', url]);
          added++;
        } else if (!old.admin_edited && (new Date(old.starts).getTime() !== e.starts.getTime())) {
          // Перенесли на сайте — переносим и у нас (напоминания водителей переставятся сами).
          await pool.query('UPDATE events SET starts = $2, ends = $3, updated = NOW() WHERE id = $1', [old.id, e.starts, e.ends]);
          updated++;
        }
      }
      console.log(`iticket: подходящих ${seen}, новых ${added}, перенесено ${updated}`);
    } catch (err) {
      console.error('iticket import:', err.message);
    } finally {
      running = false;
    }
    return { seen, added, updated };
  }

  setTimeout(() => run(), 3 * 60e3).unref();
  setInterval(() => run(), 6 * 3600e3).unref();
  return { run };
};

module.exports.parseEvent = parseEvent;
