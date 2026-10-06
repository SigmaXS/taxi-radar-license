// Цена заказа по тексту снимка карточки Яндекс Про — для iPhone: «Быстрая команда»
// делает снимок, распознаёт текст и отдаёт его действию «Taxi Radar: цена заказа»,
// которое работает в фоне и присылает баннер. Расчёт тот же, что в приложениях
// (RouteFareCalculator.kt / fare_calculator.dart): маршрут OSRM, город/загород
// по полигону зоны, официальные ставки, пробки по поездкам всех водителей.
// Если на снимке номер телефона (экран звонка), — отвечаем отметками о клиенте.

const OSRM = 'https://router.project-osrm.org';

const TARIFFS = {
  'Эконом': { base: 30, city: 3.5, out: 5.3, min: 1.0 },
  'Комфорт': { base: 45, city: 3.5, out: 7.3, min: 1.0 },
  'Комфорт+': { base: 65, city: 3.5, out: 7.3, min: 1.0 }
};
const FREE_KM = 2;
const MAX_UNLABELED_MIN = 40;

// Граница городской тарифной зоны (lon, lat) — как в приложениях.
const CITY_ZONE = [
  [28.83774, 47.08549], [28.80156, 47.07999], [28.76378, 47.07457], [28.76370, 47.05835],
  [28.73516, 47.03933], [28.74046, 47.01677], [28.76997, 46.99111], [28.80372, 46.97135],
  [28.89244, 46.96319], [28.93342, 46.93772], [28.93020, 47.04983], [28.92294, 47.04881],
  [28.84655, 47.06034]
];

function insideCity(lat, lon) {
  let inside = false;
  for (let i = 0, j = CITY_ZONE.length - 1; i < CITY_ZONE.length; j = i++) {
    const [xi, yi] = CITY_ZONE[i], [xj, yj] = CITY_ZONE[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function km(a, b) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function price(tariff, cityKm, outKm, minutes, bonus) {
  const t = TARIFFS[tariff] || TARIFFS['Эконом'];
  const freeCity = Math.min(FREE_KM, cityKm);
  const raw = t.base + t.city * (cityKm - freeCity) + t.out * Math.max(0, outKm - (FREE_KM - freeCity)) + t.min * minutes;
  return Math.round(raw) + bonus;
}

// ---------- разбор текста карточки (как OrderParserService в iPhone-версии) ----------

const PLUS = /\+\s*(\d{1,3})(?:[.,]\d+)?\s*(L|Л|лей|lei|MDL)?(?![\p{L}\d])/giu;
const PAID = /(платн\S*\s+подач|pl[aă]t\S*\s+(?:a\s+)?(?:prelu|deplas)|preluare\s+pl[aă]t|paid\s+pick)/i;
const PICKUP = /^(\d+(?:[.,]\d+)?)\s*(км|м|km|m)\s*[·•]\s*\d+\s*(мин|min)/i;
const CARD_KM = /^(\d+(?:[.,]\d+)?)\s*(км|km)$/i;
const CARD_MIN = /^(?:(\d+)\s*(ч|h)\s*)?(\d+)\s*(мин|min)\.?$/i;
const UNIT = /(\d\s*(км|м|мин|km|m|min|l|lei|лей)(?![\p{L}]))|((?<![\p{L}])(l|lei)\s*\d)/iu;
const STREET = /(^|[\s,.])(str|strada|stradela|bd|bul|bulevardul|șos|şos|sos|soseaua|șoseaua|aleea|piața|piata|calea|ул|улица|пр|просп|проспект|бул|бульвар|шоссе|пер|переулок|село|satul|sat|com)[\s.,]/i;
const ENTRANCE = /^(entrance|подъезд|scara|scară|poarta|ворота|этаж|etaj|кв|ap)(?![\p{L}])/iu;
const MARKER_PREFIX = /^(?:\(?[AАBБ]\)?|Ⓐ|Ⓑ)\s+(?=\S)/;
const MARKER_ONLY = /^(?:\(?[AАBБ]\)?|Ⓐ|Ⓑ)$/;
const TAIL = ['pasager', 'пассажир', 'comentariu', 'комментар', 'acceptă', 'accepta', 'принять'];
const SERVICE_WORDS = ['принять', 'пропустить', 'подача', 'вы находитесь', 'я здесь', 'уточнить', 'приоритет',
  'accept', 'omite', 'preluare', 'accesul la comenzi', 'prioritate', 'are you here', 'pasager', 'пассажир'];
const TARIFF_WORDS = ['эконом', 'комфорт', 'комфорт+', 'econom', 'comfort', 'comfort+', 'confort', 'confort+'];

function isService(t) {
  const l = t.toLowerCase();
  if (UNIT.test(t) || l.includes('·') || l.includes('•') || l.startsWith('+')) return true;
  return SERVICE_WORDS.some(w => l.includes(w)) || TARIFF_WORDS.includes(l);
}

function looksLikeAddress(t) {
  if (t.length < 5 || isService(t) || !/\p{L}/u.test(t)) return false;
  const l = t.toLowerCase();
  if (ENTRANCE.test(l)) return false;
  // Подписи улиц и районов на карте — заглавными («BOTANICA», «str. ISMAIL»).
  const caps = t.replace(/[^\p{L}]/gu, '').replace(/^(str|bd|ул)/i, '');
  if (caps.length >= 4 && caps === caps.toUpperCase() && !/\d/.test(t)) return false;
  return /\d/.test(t) || STREET.test(` ${l} `);
}

function isDelivery(lines) {
  const l = lines.map(s => s.toLowerCase());
  return l.some(s => s === 'доставка' || s === 'livrare') &&
    l.some(s => s.includes('получени') || s.includes('вручени') || s === 'откуда' || s === 'de unde');
}

function parseCard(text) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  const lower = lines.map(s => s.toLowerCase());
  let tariff = 'Эконом';
  if (lower.some(l => /комфорт\+|comfort\+|confort\+/.test(l))) tariff = 'Комфорт+';
  else if (lower.some(l => /комфорт|comfort|confort/.test(l))) tariff = 'Комфорт';

  let paid = 0, surge = 0;
  const used = new Set();
  lines.forEach((line, i) => {
    if (!PAID.test(line)) return;
    used.add(i);
    for (let j = i; j <= Math.min(i + 2, lines.length - 1); j++) {
      const m = [...lines[j].matchAll(PLUS)][0];
      if (!m) continue;
      paid = Math.max(paid, Number(m[1]));
      used.add(j);
      break;
    }
  });
  lines.forEach((line, i) => {
    if (used.has(i)) return;
    for (const m of line.matchAll(PLUS)) {
      const v = Number(m[1]);
      if ((m[2] && v >= 1 && v <= 500) || (!m[2] && v >= 5 && v <= 150)) surge = Math.max(surge, v);
    }
  });

  let start = 0, pickupKm = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PICKUP);
    if (!m) continue;
    const v = Number(m[1].replace(',', '.')) || 0;
    pickupKm = /^(км|km)$/i.test(m[2]) ? v : v / 1000;
    start = i + 1;
    break;
  }
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (TAIL.some(w => lower[i].startsWith(w))) { end = i; break; }
  }

  let cardKm = null, cardMin = null;
  for (const l of lines.slice(0, start === 0 ? lines.length : start - 1)) {
    const k = l.match(CARD_KM);
    if (k && cardKm == null) cardKm = Number(k[1].replace(',', '.'));
    const m = l.match(CARD_MIN);
    if (m && cardMin == null) cardMin = (Number(m[1]) || 0) * 60 + Number(m[3]);
  }
  if (!(cardKm > 0 && cardMin > 0)) { cardKm = null; cardMin = null; }

  const addresses = [];
  for (const l of lines.slice(start, end)) {
    if (MARKER_ONLY.test(l)) continue;
    let c = l.replace(MARKER_PREFIX, '').replace(/[,\s]*\+\d+\s*$/, '').trim().slice(0, 60);
    if (looksLikeAddress(c) && !addresses.includes(c)) addresses.push(c);
  }
  const a = addresses[0] || '', b = addresses.length > 1 ? addresses[addresses.length - 1] : '';
  const al = a.toLowerCase(), bl = b.toLowerCase();
  const stops = addresses.slice(1, -1).filter(s => {
    const l = s.toLowerCase();
    return !(l.includes(al) || al.includes(l) || l.includes(bl) || bl.includes(l));
  });
  return { tariff, bonus: surge + paid, pickupKm, cardKm, cardMin, a, b, stops, delivery: isDelivery(lines) };
}

// ---------- маршрут ----------

async function route(points) {
  const url = `${OSRM}/route/v1/driving/${points.map(p => `${p.lon},${p.lat}`).join(';')}?overview=full&geometries=geojson`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.code !== 'Ok') return null;
  const rt = j.routes[0];
  const coords = rt.geometry.coordinates;
  let city = 0, out = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1], [lon2, lat2] = coords[i];
    const seg = km({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
    insideCity((lat1 + lat2) / 2, (lon1 + lon2) / 2) ? (city += seg) : (out += seg);
  }
  return { city, out, minutes: rt.duration / 60 };
}

// Час и день недели в Кишинёве — сервер живёт в UTC.
function chisinauNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Chisinau', hour: 'numeric', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { hour: Number(parts.hour), weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun' };
}

function fmtKm(v) { return v < 10 ? v.toFixed(1) : String(Math.round(v)); }

// Номера телефонов на снимке (экран звонка): «+373 78 123 456», «078123456».
function findPhones(text) {
  const out = [];
  // Только в пределах строки: соседняя строка «00:12» (время звонка) не должна приклеиться.
  for (const m of String(text).matchAll(/\+?\d[\d \-()]{6,}\d/g)) {
    const hasPlus = m[0].trim().startsWith('+');
    const d = m[0].replace(/\D/g, '');
    let n = null;
    if (hasPlus) n = '+' + d;
    else if (d.startsWith('00')) n = '+' + d.slice(2);
    else if (d.length === 9 && d.startsWith('0')) n = '+373' + d.slice(1);
    else if (d.length === 8 && /^[67]/.test(d)) n = '+373' + d;
    else if (d.startsWith('373') && d.length === 11) n = '+' + d;
    if (n && n.length >= 9 && n.length <= 16 && !out.includes(n)) out.push(n);
  }
  return out;
}

module.exports = function registerOrderPrice(app, { member, geocoder, clientSummary, phoneHash, tooOften, getTraffic }) {
  // Как в Android (RouteFareCalculator.addressKey): подъезд геокодеру только мешает —
  // «…, подъезд 1» он уводил в другое место. Не нашёлся — ещё раз с «Кишинёв, …».
  const ENTRANCE_TAIL = /[,\s]*(entrance|scara|scară|подъезд|подъ\.)\s*\S+/gi;
  async function find(q) {
    const clean = String(q).replace(ENTRANCE_TAIL, '').trim().replace(/,$/, '');
    try {
      const r = await geocoder.lookup(clean);
      if (r && r.found) return r;
      if (/chi[șs]in|кишин/i.test(clean)) return r;
      return await geocoder.lookup('Кишинёв, ' + clean);
    } catch (_) {
      return null;
    }
  }
  app.post('/api/order/price', member(async (req, res, deviceId) => {
    if (tooOften('oprice:' + deviceId, 120, 60 * 60 * 1000)) {
      return res.json({ ok: false, reason: 'often', message: 'Слишком часто — подождите немного' });
    }
    const text = String(req.body.text || '').slice(0, 6000);
    const lang = req.body.lang === 'ro' ? 'ro' : 'ru';
    const t = (ru, ro) => (lang === 'ro' ? ro : ru);
    const card = parseCard(text);

    // Экран звонка: номер есть, адресов нет — карточка клиента.
    const phones = findPhones(text);
    if ((!card.a || !card.b) && phones.length > 0) {
      const phone = phones[0];
      const s = await clientSummary(phoneHash(phone), deviceId);
      return res.json({ ok: true, kind: 'client', phone, tags: s.tags, reviews: s.reviews.length });
    }
    if (card.delivery) return res.json({ ok: false, reason: 'delivery', message: t('Доставку не считаем', 'Livrarea nu se calculează') });
    if (!card.a || !card.b) {
      return res.json({ ok: false, reason: 'no_route', message: t('Не вижу адресов А и Б на снимке', 'Nu văd adresele A și B pe captură') });
    }

    const names = [card.a, ...card.stops, card.b];
    const looked = await Promise.all(names.map(find));
    const pt = r => (r && r.found ? { lat: r.lat, lon: r.lon } : null);
    const A = pt(looked[0]), B = pt(looked[looked.length - 1]);
    if (!A || !B) {
      const missing = !A ? card.a : card.b;
      console.log('order/price: не нашёлся адрес', JSON.stringify(missing));
      return res.json({ ok: false, reason: 'geocode', message: t(`Не нашёлся адрес: ${missing}`, `Adresa nu a fost găsită: ${missing}`) });
    }
    const stops = looked.slice(1, -1).map(pt).filter(s => s && km(s, A) >= 0.3 && km(s, B) >= 0.3);
    const r = await route([A, ...stops, B]).catch(() => null);
    if (!r) return res.json({ ok: false, reason: 'route', message: t('Маршрут не построился', 'Traseul nu s-a construit') });

    // Пробки: таблица по поездкам всех водителей; нет данных — час пик +10 мин.
    const now = chisinauNow();
    const table = getTraffic();
    const factor = table ? (now.weekend ? table.we : table.wd)[now.hour] : null;
    let minutes = r.minutes * (factor || 1);
    if (!factor && !now.weekend && ((now.hour >= 7 && now.hour < 10) || (now.hour >= 13 && now.hour < 19))) {
      minutes += Math.min(10, minutes);
    }
    let cityKm = r.city, outKm = r.out;
    const ourKm = cityKm + outKm;
    let distance = ourKm;
    if (card.cardKm && card.cardMin && ourKm > 0 && card.cardKm >= ourKm * 0.6 && card.cardKm <= ourKm * 1.8) {
      // Яндекс сам подписал маршрут на мини-карте — берём его км и минуты.
      const scale = card.cardKm / ourKm;
      cityKm *= scale; outKm *= scale; distance = card.cardKm; minutes = card.cardMin;
    } else if (minutes > MAX_UNLABELED_MIN) {
      minutes = MAX_UNLABELED_MIN;
    }
    const total = price(card.tariff, cityKm, outKm, minutes, card.bonus);
    const tariffName = lang === 'ro' ? { 'Эконом': 'Econom', 'Комфорт': 'Confort', 'Комфорт+': 'Confort+' }[card.tariff] : card.tariff;
    const line = [
      tariffName,
      `${fmtKm(distance)} ${t('км', 'km')}`,
      `${Math.round(minutes)} ${t('мин', 'min')}`,
      ...(stops.length ? [`${stops.length} ${t('заезд', 'opriri')}`] : []),
      ...(card.bonus > 0 ? [`${t('надбавка', 'adaos')} +${card.bonus}`] : [])
    ].join(' · ');
    res.json({
      ok: true, kind: 'order', price: total, title: `~${total} L`, line,
      tariff: card.tariff, km: Math.round(distance * 10) / 10, min: Math.round(minutes), bonus: card.bonus, stops: stops.length
    });
  }));
};

module.exports.parseCard = parseCard;
module.exports.price = price;
module.exports.insideCity = insideCity;
module.exports.findPhones = findPhones;
