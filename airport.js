// Табло прилётов аэропорта Кишинёва (RMO).
//
// Сайт аэропорта отдаёт табло зашифрованным и закрыт от скачивания — его не
// взламываем. Вместо этого два бесплатных источника:
//  - Aviationstack (AVIATIONSTACK_KEY) — расписание прилётов на день:
//    севшие, летящие, ещё не вылетевшие. 100 запросов в месяц, поэтому не
//    чаще раза в 7 часов (≈3 в сутки, ≤ 93 в месяц).
//  - AirLabs (AIRLABS_KEY) — самолёты, которые сейчас летят в Кишинёв:
//    по их положению считаем точное время посадки. 1000 в месяц, не чаще
//    раза в 45 минут (≤ 830 в месяц).
// Оба обновляются только когда кто-то открыл «Аэропорт», и не ночью.
// Статус рейса («в пути», «сел», задержка) считаем в момент запроса.

const AV_CACHE_MS = 7 * 60 * 60 * 1000;
const AL_CACHE_MS = 45 * 60 * 1000;
const RMO_LAT = 46.9277, RMO_LON = 28.9313;

function kmBetween(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// Местное время Кишинёва «2026-09-29 14:52».
function chisinauTime(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Chisinau', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function nightInChisinau() {
  const hour = Number(chisinauTime(Date.now()).slice(11, 13));
  return hour >= 1 && hour < 5;
}

// Aviationstack пишет местное время аэропорта, но с пометкой +00:00 —
// берём цифры как есть: «2026-09-29T23:30:00+00:00» → «2026-09-29 23:30».
function avLocal(ts) {
  return typeof ts === 'string' && ts.length >= 16 ? ts.slice(0, 16).replace('T', ' ') : '';
}

// Самолёт в воздухе: посадка ≈ расстояние / скорость + ~8 минут на заход.
function etaFor(f) {
  if (typeof f.lat !== 'number' || typeof f.lng !== 'number') return '';
  const km = kmBetween(f.lat, f.lng, RMO_LAT, RMO_LON);
  const speed = Math.max(Number(f.speed) || 0, 400);
  return chisinauTime(Date.now() + (km / speed) * 3600 * 1000 + 8 * 60 * 1000);
}

module.exports = function airportBoard() {
  const av = { configured: false, updated: null, fetchedAt: 0, count: 0, error: null, flights: [], inFlight: null };
  const al = { configured: false, updated: null, fetchedAt: 0, count: 0, error: null, plan: null, live: new Map(), inFlight: null };

  async function fetchAviationstack(key) {
    // Бесплатный тариф Aviationstack — только http.
    const r = await fetch(`http://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(key)}&arr_iata=RMO&limit=100`);
    const json = await r.json();
    av.updated = new Date().toISOString();
    if (json.error) {
      av.error = String(json.error.message || json.error.code || 'error').slice(0, 200);
      return;
    }
    av.error = null;
    const seen = new Set();
    av.flights = (Array.isArray(json.data) ? json.data : [])
      // Один и тот же самолёт под номерами разных авиакомпаний — оставляем «настоящий».
      .filter(f => f.flight && !f.flight.codeshared && f.flight.iata)
      .map(f => ({
        flight: f.flight.iata,
        from: (f.departure && f.departure.iata) || '',
        sched: avLocal(f.arrival && f.arrival.scheduled),
        est: avLocal(f.arrival && f.arrival.estimated),
        actual: avLocal(f.arrival && f.arrival.actual),
        status: f.flight_status || ''
      }))
      .filter(f => f.sched && !seen.has(f.flight + f.sched) && seen.add(f.flight + f.sched));
    av.count = av.flights.length;
  }

  async function fetchAirLabs(key) {
    const r = await fetch(`https://airlabs.co/api/v9/flights?arr_icao=LUKK&api_key=${encodeURIComponent(key)}`);
    const json = await r.json();
    al.updated = new Date().toISOString();
    const keyInfo = json.request && json.request.key;
    if (keyInfo && typeof keyInfo.type === 'string') al.plan = keyInfo.type;
    if (json.error) {
      al.error = String(json.error.message || json.error.code || 'error').slice(0, 200);
      return;
    }
    al.error = null;
    al.live = new Map();
    for (const f of Array.isArray(json.response) ? json.response : []) {
      const flight = f.flight_iata || f.flight_icao;
      const eta = etaFor(f);
      if (flight && eta) al.live.set(flight, { eta, from: f.dep_iata || '' });
    }
    al.count = al.live.size;
  }

  // Обновить источник, если данные устарели; один запрос на всех водителей.
  async function refresh(src, keyName, cacheMs, fetcher) {
    const key = (process.env[keyName] || '').trim();
    src.configured = Boolean(key);
    if (!key || nightInChisinau() || Date.now() - src.fetchedAt < cacheMs) return;
    if (!src.inFlight) {
      src.inFlight = fetcher(key)
        .catch(err => { src.error = String(err.message).slice(0, 200); })
        .finally(() => { src.fetchedAt = Date.now(); src.inFlight = null; });
    }
    await src.inFlight;
  }

  /** Рейсы сегодняшнего дня (и прошлых 3 часов) по времени: для экрана «Аэропорт». */
  async function flights() {
    await Promise.all([
      refresh(av, 'AVIATIONSTACK_KEY', AV_CACHE_MS, fetchAviationstack),
      refresh(al, 'AIRLABS_KEY', AL_CACHE_MS, fetchAirLabs)
    ]);
    const now = chisinauTime(Date.now());
    const since = chisinauTime(Date.now() - 3 * 3600 * 1000);
    const today = now.slice(0, 10);
    const used = new Set();

    const list = av.flights
      .filter(f => f.sched.slice(0, 10) === today || f.sched >= since)
      .map(f => {
        const live = al.live.get(f.flight);
        const planned = f.est || f.sched;
        let status, time = planned, approx = false;
        if (f.status === 'cancelled') {
          status = 'cancelled';
        } else if (live) {
          used.add(f.flight);
          status = 'en-route';
          time = live.eta;
          approx = true;
        } else if (f.actual) {
          status = 'landed';
          time = f.actual;
        } else if (planned < now) {
          // Время посадки прошло, а в воздухе самолёта нет — скорее всего, сел.
          status = 'landed';
        } else {
          status = f.status === 'active' ? 'en-route' : 'scheduled';
        }
        return { flight: f.flight, from: f.from, time, approx, status, delayed: Boolean(f.est && f.est > f.sched) };
      });

    // Летит в Кишинёв, но в расписании Aviationstack его нет.
    for (const [flight, live] of al.live) {
      if (!used.has(flight) && !list.some(f => f.flight === flight)) {
        list.push({ flight, from: live.from, time: live.eta, approx: true, status: 'en-route', delayed: false });
      }
    }
    return list.sort((a, b) => a.time.localeCompare(b.time));
  }

  // Для проверки: настроены ли ключи и что ответили сервисы (без ключей и рейсов).
  function status() {
    // «configured» — есть ли ключ в Railway прямо сейчас, даже если табло ещё никто не открывал.
    const pick = (s, keyName) => ({ configured: Boolean((process.env[keyName] || '').trim()), updated: s.updated, count: s.count, error: s.error });
    return { aviationstack: pick(av, 'AVIATIONSTACK_KEY'), airlabs: { ...pick(al, 'AIRLABS_KEY'), plan: al.plan } };
  }

  return { flights, status };
};
