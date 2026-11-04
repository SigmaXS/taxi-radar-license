// Ограничения по частоте: перебор ключей, массовые «пробные периоды», подбор пароля админки.
// Счётчики в памяти (при перезапуске обнуляются — для защиты от перебора этого достаточно).
// Лимиты щедрые: за одним IP мобильного оператора сидят сотни водителей.

const hits = new Map();

function count(key, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  hits.set(key, list);
  return list;
}

// true — лимит исчерпан; иначе запоминает попытку.
function tooMany(key, max, windowMs) {
  if (key.endsWith(':unknown')) return false;
  const list = count(key, windowMs);
  if (list.length >= max) return true;
  list.push(Date.now());
  return false;
}

// Только проверка, без записи попытки.
function isBlocked(key, max, windowMs) {
  if (key.endsWith(':unknown')) return false;
  return count(key, windowMs).length >= max;
}

function record(key, windowMs) {
  if (key.endsWith(':unknown')) return;
  count(key, windowMs).push(Date.now());
}

// Внутренние адреса (прокси платформы, локальный запуск) клиента не определяют: для них лимитов по IP нет,
// иначе один счётчик на всех водителей заблокировал бы всех сразу.
const INTERNAL = new RegExp(
  '^(::1$|127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.|f[cd][0-9a-f]{2}:|fe80:|::ffff:(127|10|192\\.168|100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))\\.)', 'i');
function clientIp(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  return !ip || INTERNAL.test(ip) ? 'unknown' : ip;
}

// Middleware для /api: не больше max запросов за окно с одного IP на группу адресов.
function limitIp(name, max, windowMs) {
  return (req, res, next) => {
    if (tooMany(`ip:${name}:${clientIp(req)}`, max, windowMs)) {
      return res.status(429).json({ ok: false, valid: false, force_lock: false, message: 'Слишком много попыток. Подождите немного.' });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) {
    if (!list.length || now - list[list.length - 1] > 24 * 3600 * 1000) hits.delete(k);
  }
}, 10 * 60 * 1000).unref();

module.exports = { tooMany, isBlocked, record, limitIp, clientIp };
