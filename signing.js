// Подпись ответов о лицензии (ECDSA P-256 / SHA-256).
//
// Приложение принимает «доступ открыт» только с подписью: без неё подставной сервер
// (прокси на телефоне взломщика) мог бы ответить valid:true. Подпись покрывает
// одноразовый nonce из запроса (старый ответ повторить нельзя), ID устройства,
// решение, срок и время сервера. Приватный ключ — только в переменной Railway LICENSE_SIGN_KEY
// (PEM; переводы строк можно писать как \n). Публичная часть вшита в приложение.
const crypto = require('crypto');

let key = null;
let loaded = false;

function privateKey() {
  if (loaded) return key;
  loaded = true;
  const raw = process.env.LICENSE_SIGN_KEY;
  if (!raw) {
    console.error('LICENSE_SIGN_KEY не задан: ответы о лицензии идут без подписи, приложения 2.5+ не пустят никого.');
    return null;
  }
  try {
    let pem = raw.replace(/\\n/g, '\n').trim();
    // Допускаем ключ и без строк BEGIN/END (одним куском или в несколько строк).
    if (!pem.includes('BEGIN')) {
      const body = pem.replace(/\s+/g, '');
      pem = '-----BEGIN PRIVATE KEY-----\n' + (body.match(/.{1,64}/g) || []).join('\n') + '\n-----END PRIVATE KEY-----';
    }
    key = crypto.createPrivateKey(pem);
  } catch (e) {
    console.error('LICENSE_SIGN_KEY не читается:', e.message);
  }
  return key;
}

const NONCE = /^[A-Za-z0-9_-]{8,64}$/;
const cleanNonce = v => (typeof v === 'string' && NONCE.test(v) ? v : '');

function message(kind, nonce, deviceId, valid, expires, ts) {
  return ['v1', kind, nonce, deviceId, valid ? 1 : 0, expires || '', ts].join('|');
}

// Добавляет к ответу ts, nonce и sig. kind: 'radar' | 'cancel'.
// expires — ровно та строка, что уходит в ответе (ISO), иначе пусто.
function signed(req, kind, deviceId, valid, expires, payload) {
  const k = privateKey();
  if (!k) return payload;
  const nonce = cleanNonce(req.body && req.body.nonce);
  const ts = Date.now();
  const sig = crypto.sign('sha256', Buffer.from(message(kind, nonce, deviceId, valid, expires, ts)), k).toString('base64');
  return { ...payload, nonce, ts, sig };
}

module.exports = { signed, message, cleanNonce, isReady: () => !!privateKey() };
