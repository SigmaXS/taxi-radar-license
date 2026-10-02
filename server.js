const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
// API вызывает Android-приложение, а не браузер, — CORS нужен только ему.
app.use('/api', cors());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const TRIAL_HOURS = 168; // 7 дней

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_keys (
        key_code VARCHAR(50) PRIMARY KEY,
        duration_hours REAL,
        type VARCHAR(50),
        created TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS devices (
        device_id VARCHAR(100) PRIMARY KEY,
        key_code VARCHAR(50),
        expires TIMESTAMP,
        last_seen TIMESTAMP,
        status VARCHAR(20),
        type VARCHAR(50)
      );
      CREATE TABLE IF NOT EXISTS trial_history (
        device_id VARCHAR(100) PRIMARY KEY
      );
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_info VARCHAR(150);
      CREATE TABLE IF NOT EXISTS referrals (
        device_id VARCHAR(100) PRIMARY KEY,
        code VARCHAR(12) UNIQUE NOT NULL,
        referred_by VARCHAR(12),
        rewarded BOOLEAN NOT NULL DEFAULT false,
        created TIMESTAMP
      );
    `);
    console.log("Database initialized successfully.");
  } catch (err) {
    console.error("DB init error:", err);
  }
}

initDB();

function generateCode(prefix = "VIP3") {
  const chars = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let r1 = "", r2 = "";
  for (let i = 0; i < 4; i++) r1 += chars[crypto.randomInt(chars.length)];
  for (let i = 0; i < 4; i++) r2 += chars[crypto.randomInt(chars.length)];
  return `${prefix}-${r1}-${r2}`;
}

// ANDROID_ID — 16 hex-символов; допускаем чуть шире, но без спецсимволов,
// чтобы ID нельзя было использовать для внедрения HTML в админку.
function isValidDeviceId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
}

// Модель телефона от приложения («Xiaomi M2007J3SG · Android 12 · v1.2»).
// Старые версии приложения её не присылают — тогда null и прежнее значение не трогаем.
function cleanDeviceInfo(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 150);
  return cleaned || null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Вход в админку — логин/пароль из переменных Railway (ADMIN_USER, ADMIN_PASSWORD).
// Без ADMIN_PASSWORD админка закрыта полностью, а не открыта для всех.
function requireAdmin(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return res.status(503).send('Админка отключена: задайте переменную ADMIN_PASSWORD в Railway.');
  }
  const user = process.env.ADMIN_USER || 'admin';

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep !== -1 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), password)) {
      // Браузер сам подставляет сохранённый пароль и в запросы с чужих сайтов —
      // поэтому действия (POST) принимаем только со страниц самой админки.
      if (req.method !== 'GET') {
        const origin = req.headers.origin || req.headers.referer;
        if (origin) {
          let originHost = null;
          try { originHost = new URL(origin).host; } catch (e) { /* некорректный заголовок */ }
          if (originHost !== req.headers.host) return res.status(403).send('Запрещено');
        }
      }
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Taxi Radar admin", charset="UTF-8"');
  return res.status(401).send('Требуется вход');
}

app.use('/admin', requireAdmin);

app.get('/', (req, res) => res.send('Taxi Radar License Server is running.'));

function referralBonusDays() {
  const days = parseInt(process.env.REFERRAL_BONUS_DAYS || '3', 10);
  return Number.isFinite(days) && days > 0 ? days : 3;
}

// Контакты, ссылка на группу и ключ карты для приложения. Меняются переменными
// в Railway без выпуска новой версии; пустое значение прячет кнопку в приложении.
function parseTariffs() {
  try {
    const t = JSON.parse(process.env.TARIFFS || '');
    if (Array.isArray(t) && t.length) return t.filter(x => x && x.days > 0 && x.price >= 0);
  } catch (e) { /* по умолчанию ниже */ }
  return [{ days: 30, price: 99 }];
}

app.get('/api/app-config', (req, res) => {
  const phone = process.env.CONTACT_PHONE ?? '+37378293919';
  res.json({
    telegram: process.env.CONTACT_TELEGRAM ?? 'sigmalxl',
    whatsapp: process.env.CONTACT_WHATSAPP ?? phone,
    viber: process.env.CONTACT_VIBER ?? phone,
    phone,
    group_url: process.env.GROUP_URL ?? 'https://t.me/taxi_radar_chisinau',
    // Ключ Яндекс Tiles API для карты спроса (бесплатный, общий на всех).
    tiles_api_key: process.env.TILES_API_KEY || '',
    // Адреса ищет сервер (geocoder.js) — водителю не нужен свой ключ Яндекса.
    shared_geocoder: Object.keys(process.env).some(k => /^YANDEX_GEOCODER_KEY(_\d)?$/.test(k) && process.env[k].trim()),
    referral_bonus_days: referralBonusDays(),
    // Колокольчик «новая версия» в приложении: при выпуске новой версии поменяйте
    // LATEST_VERSION_CODE / LATEST_VERSION_NAME и UPDATE_URL (пост с APK в Telegram).
    latest_version_code: parseInt(process.env.LATEST_VERSION_CODE || '16', 10),
    latest_version_name: process.env.LATEST_VERSION_NAME || '1.15',
    update_url: process.env.UPDATE_URL || process.env.GROUP_URL || 'https://t.me/taxi_radar_chisinau',
    update_notes: process.env.UPDATE_NOTES ||
      'Новое: тёмная карта и места водителей (где поесть, мойка, заправка); метка «Радар»; цена заказа без точки Б после «Поехали»; кнопка «Подписка» в профиле.',
    // Тарифы на экране «Подписка»: JSON вида [{"days":30,"price":99}]
    tariffs: parseTariffs(),
    currency: process.env.CURRENCY || 'лей',
    surge_base: surgeBase()
  });
});

// Старт тарифа без надбавки: Эконом, Комфорт, Комфорт+, Доставка. Цена «от …» у Яндекса
// = старт + надбавка (+15 / +35 / +55), надбавка в виджете = цена − старт.
// Если Яндекс поменяет тарифы — SURGE_BASE в Railway, например «30,45,65,25»,
// без нового приложения.
function surgeBase() {
  const [econom, comfort, comfortplus, express] = String(process.env.SURGE_BASE || '30,45,65,25')
    .split(',').map(v => parseInt(v, 10));
  const ok = v => Number.isFinite(v) && v > 0;
  return {
    econom: ok(econom) ? econom : 30,
    comfort: ok(comfort) ? comfort : 45,
    comfortplus: ok(comfortplus) ? comfortplus : 65,
    // «Доставка» у Яндекса — класс «express».
    express: ok(express) ? express : 25
  };
}

async function ensureReferralCode(deviceId) {
  const existing = await pool.query('SELECT * FROM referrals WHERE device_id = $1', [deviceId]);
  if (existing.rows.length > 0) return existing.rows[0];
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode("R").slice(2).replace('-', '').slice(0, 6);
    const inserted = await pool.query(
      'INSERT INTO referrals (device_id, code, created) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING *',
      [deviceId, code, new Date()]
    );
    if (inserted.rows.length > 0) return inserted.rows[0];
    const again = await pool.query('SELECT * FROM referrals WHERE device_id = $1', [deviceId]);
    if (again.rows.length > 0) return again.rows[0];
  }
  throw new Error('Не удалось создать реферальный код');
}

async function deviceExists(deviceId) {
  const r = await pool.query('SELECT 1 FROM devices WHERE device_id = $1', [deviceId]);
  return r.rows.length > 0;
}

// Бонус пригласившему — только когда приглашённый купил ключ (не триал),
// иначе рефералку можно накрутить фейковыми устройствами. Один раз на друга.
async function rewardReferrer(deviceId) {
  const claimed = await pool.query(
    'UPDATE referrals SET rewarded = true WHERE device_id = $1 AND referred_by IS NOT NULL AND rewarded = false RETURNING referred_by',
    [deviceId]
  );
  if (claimed.rows.length === 0) return;
  const referrer = await pool.query(
    'SELECT d.device_id, d.expires, d.status FROM referrals r JOIN devices d ON d.device_id = r.device_id WHERE r.code = $1',
    [claimed.rows[0].referred_by]
  );
  if (referrer.rows.length === 0 || referrer.rows[0].status === 'banned') return;
  const base = Math.max(new Date(referrer.rows[0].expires).getTime(), Date.now());
  const newExp = new Date(base + referralBonusDays() * 24 * 3600 * 1000);
  await pool.query('UPDATE devices SET expires = $1 WHERE device_id = $2', [newExp, referrer.rows[0].device_id]);
}

app.post('/api/referral/me', async (req, res) => {
  const { device_id } = req.body;
  if (!isValidDeviceId(device_id)) return res.status(400).json({ ok: false, message: "Нет ID" });
  try {
    if (!(await deviceExists(device_id))) return res.json({ ok: false, message: "Сначала активируйте доступ" });
    const ref = await ensureReferralCode(device_id);
    const stats = await pool.query(
      'SELECT COUNT(*) AS invited, COUNT(*) FILTER (WHERE rewarded) AS rewarded FROM referrals WHERE referred_by = $1',
      [ref.code]
    );
    return res.json({
      ok: true,
      code: ref.code,
      referred_by: ref.referred_by,
      invited: parseInt(stats.rows[0].invited, 10),
      rewarded: parseInt(stats.rows[0].rewarded, 10),
      bonus_days: referralBonusDays()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Ошибка базы данных" });
  }
});

app.post('/api/referral/apply', async (req, res) => {
  const { device_id, code } = req.body;
  if (!isValidDeviceId(device_id) || typeof code !== 'string') {
    return res.status(400).json({ ok: false, message: "Введите код" });
  }
  const cleanCode = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(cleanCode)) return res.json({ ok: false, message: "Код не найден" });

  try {
    if (!(await deviceExists(device_id))) return res.json({ ok: false, message: "Сначала активируйте доступ" });
    const own = await ensureReferralCode(device_id);
    if (own.referred_by) return res.json({ ok: false, message: "Код друга уже введён" });
    if (own.code === cleanCode) return res.json({ ok: false, message: "Нельзя ввести свой собственный код" });

    const referrer = await pool.query('SELECT 1 FROM referrals WHERE code = $1', [cleanCode]);
    if (referrer.rows.length === 0) return res.json({ ok: false, message: "Код не найден" });

    const updated = await pool.query(
      'UPDATE referrals SET referred_by = $1 WHERE device_id = $2 AND referred_by IS NULL RETURNING 1',
      [cleanCode, device_id]
    );
    if (updated.rows.length === 0) return res.json({ ok: false, message: "Код друга уже введён" });
    return res.json({ ok: true, message: `Код принят! Когда купите ключ, другу начислится +${referralBonusDays()} дн.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Ошибка базы данных" });
  }
});

// 1. Запрос триала на 7 дней — один раз на устройство, по времени сервера
app.post('/api/request-trial', async (req, res) => {
  const { device_id } = req.body;
  if (!isValidDeviceId(device_id)) return res.status(400).json({ valid: false, force_lock: true, message: "Нет ID" });
  const deviceInfo = cleanDeviceInfo(req.body.device_info);

  try {
    const devQuery = await pool.query('SELECT * FROM devices WHERE device_id = $1', [device_id]);
    if (devQuery.rows.length > 0) {
      const dev = devQuery.rows[0];
      await pool.query('UPDATE devices SET device_info = COALESCE($1, device_info) WHERE device_id = $2', [deviceInfo, device_id]);
      if (dev.status === 'banned') {
        return res.json({ valid: false, force_lock: true, is_banned: true, message: "Устройство заблокировано (БАН)!" });
      }
      const isExpired = new Date(dev.expires).getTime() < Date.now();
      if (isExpired) {
        return res.json({ valid: false, force_lock: true, is_banned: false, message: "Пробный период завершен. Введите ключ." });
      }
      return res.json({ valid: true, force_lock: false, expires: dev.expires, message: "Пробный период активен" });
    }

    const trialCheck = await pool.query('SELECT * FROM trial_history WHERE device_id = $1', [device_id]);
    if (trialCheck.rows.length > 0) {
      return res.json({ valid: false, force_lock: true, message: "Пробный период на этом устройстве уже был использован. Введите ключ." });
    }

    const expireDate = new Date(Date.now() + TRIAL_HOURS * 3600 * 1000);
    const trialKey = generateCode("TR7D");

    await pool.query(
      'INSERT INTO devices (device_id, key_code, expires, last_seen, status, type, device_info) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [device_id, trialKey, expireDate, new Date(), 'active', 'Пробный (7 дней)', deviceInfo]
    );
    await pool.query('INSERT INTO trial_history (device_id) VALUES ($1) ON CONFLICT DO NOTHING', [device_id]);

    return res.json({
      valid: true,
      force_lock: false,
      message: "Активирован бесплатный доступ на 7 дней!",
      expires: expireDate.toISOString()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, force_lock: true, message: "Ошибка сервера БД" });
  }
});

// 2. Активация ключа
app.post('/api/activate-device', async (req, res) => {
  const { key, device_id } = req.body;
  if (typeof key !== 'string' || !key.trim() || !isValidDeviceId(device_id)) {
    return res.status(400).json({ valid: false, force_lock: true, message: "Введите ключ и ID" });
  }

  const cleanKey = key.trim().toUpperCase();
  const deviceInfo = cleanDeviceInfo(req.body.device_info);

  try {
    const devCheck = await pool.query('SELECT * FROM devices WHERE device_id = $1', [device_id]);
    if (devCheck.rows.length > 0 && devCheck.rows[0].status === 'banned') {
      return res.json({ valid: false, force_lock: true, is_banned: true, message: "Устройство в бане!" });
    }

    // Удаляем ключ в том же запросе, что и читаем: два устройства не смогут
    // активировать один ключ одновременно.
    const keyQuery = await pool.query('DELETE FROM app_keys WHERE key_code = $1 RETURNING *', [cleanKey]);
    if (keyQuery.rows.length === 0) {
      return res.json({ valid: false, force_lock: true, message: "Неверный ключ или уже активирован" });
    }
    const keyData = keyQuery.rows[0];

    const expireDate = new Date(Date.now() + Math.round(keyData.duration_hours * 3600 * 1000));

    await pool.query(`
      INSERT INTO devices (device_id, key_code, expires, last_seen, status, type, device_info)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (device_id) DO UPDATE
      SET key_code = $2, expires = $3, last_seen = $4, status = $5, type = $6,
          device_info = COALESCE($7, devices.device_info)
    `, [device_id, cleanKey, expireDate, new Date(), 'active', keyData.type, deviceInfo]);

    // Тестовые ключи на секунды/часы бонус пригласившему не дают.
    if (keyData.duration_hours >= 24) {
      try {
        await rewardReferrer(device_id);
      } catch (err) {
        console.error('Referral reward error:', err);
      }
    }

    return res.json({
      valid: true,
      force_lock: false,
      message: `Успешно! Доступ открыт (${keyData.type})`,
      expires: expireDate.toISOString()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, force_lock: true, message: "Ошибка базы данных" });
  }
});

// 3. Проверка при входе в приложение и фоновая — по времени сервера
app.post('/api/check-license', async (req, res) => {
  const { device_id } = req.body;
  if (!isValidDeviceId(device_id)) return res.status(400).json({ valid: false, force_lock: true, message: "Нет ID" });

  try {
    const devQuery = await pool.query('SELECT * FROM devices WHERE device_id = $1', [device_id]);
    if (devQuery.rows.length === 0) {
      return res.json({ valid: false, force_lock: true, message: "Устройство не найдено" });
    }
    const dev = devQuery.rows[0];

    const serverNow = new Date();
    await pool.query(
      'UPDATE devices SET last_seen = $1, device_info = COALESCE($2, device_info) WHERE device_id = $3',
      [serverNow, cleanDeviceInfo(req.body.device_info), device_id]
    );

    if (dev.status === 'banned') {
      return res.json({ valid: false, force_lock: true, is_banned: true, message: "Устройство заблокировано" });
    }
    if (dev.status === 'disabled') {
      return res.json({ valid: false, force_lock: true, is_banned: false, message: "Подписка отключена. Введите ключ." });
    }

    const expireDate = new Date(dev.expires);

    if (serverNow > expireDate) {
      return res.json({ valid: false, force_lock: true, is_banned: false, message: "Срок действия подписки истек" });
    }

    const diffHours = Math.max(0, Math.round((expireDate - serverNow) / 3600000));
    return res.json({ valid: true, force_lock: false, expires: dev.expires, hours_left: diffHours });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, force_lock: true, message: "Ошибка базы данных" });
  }
});

// Админ-панель (закрыта паролем — см. requireAdmin)
app.get('/admin/view-devices', async (req, res) => {
  try {
    const devicesQuery = await pool.query('SELECT * FROM devices ORDER BY last_seen DESC NULLS LAST');
    const keysQuery = await pool.query('SELECT * FROM app_keys');
    const trialsQuery = await pool.query('SELECT COUNT(*) FROM trial_history');
    const referralsQuery = await pool.query('SELECT device_id, code, referred_by, rewarded FROM referrals');

    const refByDevice = new Map(referralsQuery.rows.map(r => [r.device_id, r]));
    const invitedByCode = new Map();
    let referredDevices = 0;
    for (const r of referralsQuery.rows) {
      if (!r.referred_by) continue;
      referredDevices++;
      const s = invitedByCode.get(r.referred_by) || { invited: 0, paid: 0 };
      s.invited++;
      if (r.rewarded) s.paid++;
      invitedByCode.set(r.referred_by, s);
    }

    const now = Date.now();

    // С версии 1.9 приложение подписано новым ключом, и Android выдаёт ему
    // другой ANDROID_ID — тот же телефон приходит как новое устройство.
    // Подсказываем пары: новая версия и старая с той же моделью и Android,
    // у старой подписка длиннее.
    const phoneOf = info => (info || '').replace(/\s*·\s*v[\d.]+\s*$/, '').trim();
    const versionOf = info => {
      const m = (info || '').match(/v(\d+)\.(\d+)/);
      return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
    };
    const signed = d => versionOf(d.device_info) >= 109;
    const transferPairs = [];
    for (const nd of devicesQuery.rows.filter(signed)) {
      for (const od of devicesQuery.rows) {
        if (od.device_id === nd.device_id || signed(od) || od.status === 'banned') continue;
        const samePhone = od.device_info && phoneOf(od.device_info) === phoneOf(nd.device_info);
        if (samePhone && new Date(od.expires) > new Date(nd.expires)) transferPairs.push({ from: od, to: nd });
      }
    }
    const shortDate = d => new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Chisinau' });
    const pairRows = transferPairs.map(p => `
      <tr>
        <td>${escapeHtml(phoneOf(p.to.device_info))}</td>
        <td><code>${escapeHtml(p.from.device_id)}</code><br><span style="font-size:12px;color:#718096;">${escapeHtml(p.from.device_info || '')} · до ${escapeHtml(shortDate(p.from.expires))} · ${escapeHtml(p.from.type || '')}</span></td>
        <td><code>${escapeHtml(p.to.device_id)}</code><br><span style="font-size:12px;color:#718096;">${escapeHtml(p.to.device_info || '')} · до ${escapeHtml(shortDate(p.to.expires))}</span></td>
        <td>
          <form method="POST" action="/admin/transfer" style="margin:0;">
            <input type="hidden" name="from" value="${escapeHtml(p.from.device_id)}">
            <input type="hidden" name="to" value="${escapeHtml(p.to.device_id)}">
            <button onclick="return confirm('Перенести подписку, ник в чате и приглашения на новый ID? Старая строка удалится.')" style="background:#38a169;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;font-weight:bold;">Перенести</button>
          </form>
        </td>
      </tr>`).join('');

    let totalDevices = 0, onlineDevices = 0, activeSubs = 0, expiredSubs = 0, bannedDevices = 0;

    const devicesList = devicesQuery.rows.map(dev => {
      totalDevices++;
      const isBanned = dev.status === 'banned';
      const isDisabled = dev.status === 'disabled';
      const isExpired = new Date(dev.expires).getTime() < now;
      const lastSeenDiffMin = Math.round((now - new Date(dev.last_seen).getTime()) / 60000);
      const isOnline = lastSeenDiffMin <= 5 && !isBanned && !isDisabled && !isExpired;

      if (isBanned) bannedDevices++;
      else if (isDisabled || isExpired) expiredSubs++;
      else activeSubs++;
      if (isOnline) onlineDevices++;

      let statusHtml;
      if (isBanned) statusHtml = '<span style="color:#e53e3e;font-weight:bold;">● В бане</span>';
      else if (isDisabled) statusHtml = '<span style="color:#dd6b20;font-weight:bold;">● Отключён</span>';
      else if (isExpired) statusHtml = '<span style="color:#718096;">● Истек</span>';
      else if (isOnline) statusHtml = '<span style="color:#38a169;font-weight:bold;">● Онлайн</span>';
      else statusHtml = '<span style="color:#a0aec0;">● Оффлайн</span>';

      // «Отключить» — только у тех, у кого подписка сейчас работает.
      const canDisable = !isBanned && !isDisabled && !isExpired;

      const ref = refByDevice.get(dev.device_id);
      const refParts = [];
      if (ref) {
        const s = invitedByCode.get(ref.code) || { invited: 0, paid: 0 };
        refParts.push(`реф. код <b>${escapeHtml(ref.code)}</b> · пригласил ${s.invited} (купили ${s.paid})`);
        if (ref.referred_by) refParts.push(`пришёл по коду ${escapeHtml(ref.referred_by)}`);
      }
      const refHtml = refParts.length
        ? `<div style="font-size:12px;color:#4a5568;margin-top:3px;">${refParts.join(' · ')}</div>`
        : '';

      const expDate = new Date(dev.expires);
      const formattedDate = expDate.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });

      return `
        <tr>
          <td style="white-space:nowrap;">${statusHtml}</td>
          <td><div style="font-weight:bold;">${escapeHtml(dev.key_code)}</div><div style="font-size:12px;color:#718096;">${escapeHtml(dev.type || '')}</div></td>
          <td>
            <div style="font-weight:600;">${dev.device_info ? escapeHtml(dev.device_info) : '<span style="color:#a0aec0;">— старая версия приложения</span>'}</div>
            <code style="background:#feebc8;color:#c05621;padding:2px 6px;border-radius:4px;font-size:12px;">${escapeHtml(dev.device_id)}</code>
            ${refHtml}
          </td>
          <td>${escapeHtml(formattedDate)}</td>
          <td style="white-space:nowrap;">
            <form method="POST" action="/admin/action" style="display:inline;">
              <input type="hidden" name="device_id" value="${escapeHtml(dev.device_id)}">
              <input type="number" name="days" min="1" max="3650" placeholder="дней" style="width:62px;padding:4px;">
              <button name="action" value="add_days" style="background:#38a169;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;font-weight:bold;">+ Добавить</button>
              ${canDisable ? '<button name="action" value="disable" onclick="return confirm(\'Отключить подписку у этого устройства?\')" style="background:#718096;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;">Отключить</button>' : ''}
              ${isBanned ? '<button name="action" value="unban" style="background:#38a169;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;font-weight:bold;">Разбанить</button>' : '<button name="action" value="ban" style="background:#e53e3e;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;">В БАН</button>'}
              <button name="action" value="unlink" style="background:#dd6b20;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;">Удалить</button>
            </form>
          </td>
        </tr>
      `;
    }).join('');

    const freeKeysList = keysQuery.rows.map(k => `
      <div style="background:#f7fafc; padding:8px 12px; margin:5px 0; border-radius:6px; display:flex; justify-content:space-between; align-items:center; border:1px solid #e2e8f0;">
        <div><strong style="color:#2b6cb0;">${escapeHtml(k.key_code)}</strong> <span style="font-size:12px; color:#718096;">(${escapeHtml(k.type)})</span></div>
        <form method="POST" action="/admin/delete-key" style="margin:0;">
          <input type="hidden" name="key_code" value="${escapeHtml(k.key_code)}">
          <button style="background:#e53e3e;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;">Удалить</button>
        </form>
      </div>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="ru">
      <head>
        <meta charset="UTF-8">
        <title>Аналитика и управление лицензиями</title>
        <style>
          body { font-family: sans-serif; background: #f0f2f5; padding: 25px; margin: 0; }
          .card { background: #fff; border-radius: 10px; padding: 20px; max-width: 1150px; margin: 0 auto 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
          .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 10px; }
          .stat-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; text-align: center; }
          .stat-num { font-size: 24px; font-weight: bold; color: #2b6cb0; margin-top: 5px; }
          .btn-group { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 15px; }
          .gen-btn { border: none; padding: 8px 14px; border-radius: 5px; color: #fff; font-weight: bold; cursor: pointer; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          th { background: #2b6cb0; color: #fff; padding: 10px; text-align: left; }
          td { padding: 10px; border-bottom: 1px solid #edf2f7; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>📊 Аналитика и Статистика (PostgreSQL)</h2>
          ${req.query.msg ? `<p style="font-weight:bold;background:#ebf8ff;padding:10px;border-radius:6px;">${escapeHtml(req.query.msg)}</p>` : ''}
          <p><a href="/admin/community">💬 Чат, клиенты, метки на карте, аэропорт →</a></p>
          <div class="stats-grid">
            <div class="stat-box"><div>Всего устройств</div><div class="stat-num">${totalDevices}</div></div>
            <div class="stat-box"><div>⚡ Онлайн сейчас</div><div class="stat-num" style="color:#38a169;">${onlineDevices}</div></div>
            <div class="stat-box"><div>✅ Активных</div><div class="stat-num" style="color:#3182ce;">${activeSubs}</div></div>
            <div class="stat-box"><div>⏳ Истекли</div><div class="stat-num" style="color:#718096;">${expiredSubs}</div></div>
            <div class="stat-box"><div>🚫 В бане</div><div class="stat-num" style="color:#e53e3e;">${bannedDevices}</div></div>
            <div class="stat-box"><div>🎁 Взяли триал</div><div class="stat-num">${escapeHtml(trialsQuery.rows[0].count)}</div></div>
            <div class="stat-box"><div>🤝 По рефералке</div><div class="stat-num">${referredDevices}</div></div>
          </div>
        </div>
        <div class="card">
          <h2>🛠 Создать ключ</h2>
          <div class="btn-group">
            <form method="POST" action="/admin/generate" style="display:flex;gap:8px;align-items:center;">
              <input type="number" name="days" min="1" max="3650" placeholder="дней" required style="width:80px;padding:7px;">
              <button name="type" value="days" class="gen-btn" style="background:#38a169;">Создать ключ</button>
            </form>
            <form method="POST" action="/admin/generate"><button name="type" value="sub_1m" class="gen-btn" style="background:#e53e3e;">⚡ Тест 1 минута</button></form>
          </div>
          <h3 style="margin-top:20px; font-size:16px;">Свободные ключи (${keysQuery.rows.length}):</h3>
          <div style="max-height: 150px; overflow-y: auto;">
            ${freeKeysList || '<p style="color:#718096;">Нет свободных ключей</p>'}
          </div>
        </div>
        <div class="card">
          <h2>🔁 Перенос подписки на новую версию</h2>
          <p style="font-size:13px;color:#4a5568;">С версии 1.9 тот же телефон приходит с новым ID. Перенос отдаёт новому ID срок и тариф старого (если он длиннее), ник и админку в чате, приглашения и отметки; старая строка удаляется.</p>
          ${pairRows ? `<h3 style="font-size:15px;">Похоже на один и тот же телефон:</h3>
          <table><thead><tr><th>Телефон</th><th>Старый ID (до 1.9)</th><th>Новый ID</th><th></th></tr></thead><tbody>${pairRows}</tbody></table>` : '<p style="color:#718096;">Подсказок нет: пар «старая версия → новая» с той же моделью не найдено.</p>'}
          <form method="POST" action="/admin/transfer" style="margin-top:12px;">
            <input type="text" name="from" placeholder="Старый ID" style="padding:6px;width:220px;">
            →
            <input type="text" name="to" placeholder="Новый ID" style="padding:6px;width:220px;">
            <button onclick="return confirm('Перенести подписку со старого ID на новый? Старая строка удалится.')" style="background:#3182ce;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;">Перенести вручную</button>
          </form>
        </div>
        <div class="card">
          <h2>🔑 Устройства в базе</h2>
          <table>
            <thead>
              <tr><th>Статус</th><th>Ключ</th><th>Телефон / ID</th><th>Истекает</th><th>Действие</th></tr>
            </thead>
            <tbody>
              ${devicesList || '<tr><td colspan="5" align="center">Нет устройств</td></tr>'}
            </tbody>
          </table>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Ошибка загрузки панели из базы данных");
  }
});

app.post('/admin/generate', async (req, res) => {
  const { type } = req.body;
  let hours, label;
  if (type === 'sub_1m') {
    hours = 1 / 60;
    label = "Тест 1 минута";
  } else {
    const days = parseInt(req.body.days, 10);
    if (!(days >= 1 && days <= 3650)) {
      return res.redirect('/admin/view-devices?msg=' + encodeURIComponent('Введите число дней от 1 до 3650'));
    }
    hours = days * 24;
    label = `${days} дн.`;
  }

  const newKey = generateCode(type === 'sub_1m' ? "TEST" : "VIP3");
  try {
    await pool.query(
      'INSERT INTO app_keys (key_code, duration_hours, type, created) VALUES ($1, $2, $3, $4)',
      [newKey, hours, label, new Date()]
    );
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin/view-devices');
});

app.post('/admin/delete-key', async (req, res) => {
  const { key_code } = req.body;
  try {
    await pool.query('DELETE FROM app_keys WHERE key_code = $1', [key_code]);
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin/view-devices');
});

app.post('/admin/action', async (req, res) => {
  const { device_id, action } = req.body;
  try {
    if (action === 'ban') {
      await pool.query("UPDATE devices SET status = 'banned' WHERE device_id = $1", [device_id]);
    } else if (action === 'unban') {
      await pool.query("UPDATE devices SET status = 'active', expires = CASE WHEN expires < NOW() THEN NOW() + INTERVAL '1 day' ELSE expires END WHERE device_id = $1", [device_id]);
    } else if (action === 'disable') {
      // Снимаем подписку, но не баним: новым ключом устройство может вернуться.
      await pool.query("UPDATE devices SET status = 'disabled', expires = $1 WHERE device_id = $2", [new Date(), device_id]);
    } else if (action === 'unlink') {
      await pool.query("DELETE FROM devices WHERE device_id = $1", [device_id]);
    } else if (action === 'add_days') {
      // +N дней к текущему сроку; если подписка уже кончилась — от сегодня. Бан не снимаем.
      const days = parseInt(req.body.days, 10);
      if (!(days >= 1 && days <= 3650)) {
        return res.redirect('/admin/view-devices?msg=' + encodeURIComponent('Введите число дней от 1 до 3650'));
      }
      const r = await pool.query(
        `UPDATE devices SET expires = GREATEST(expires, NOW()) + ($1 || ' days')::INTERVAL,
           status = CASE WHEN status = 'banned' THEN status ELSE 'active' END,
           type = $3
         WHERE device_id = $2 RETURNING expires`,
        // В колонке «Тип» видно, что дни добавлены вручную, сколько и когда.
        [String(days), device_id, `Продлено +${days} дн. (${new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Chisinau', day: '2-digit', month: '2-digit' })})`]
      );
      if (!r.rows.length) return res.redirect('/admin/view-devices?msg=' + encodeURIComponent('Устройство не найдено'));
    }
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin/view-devices');
});

// Перенос подписки со старого ID телефона на новый (см. «Перенос» в админке).
// Всё в одной транзакции: либо переехало целиком, либо ничего.
app.post('/admin/transfer', async (req, res) => {
  const from = String(req.body.from || '').trim();
  const to = String(req.body.to || '').trim();
  let msg;
  if (!isValidDeviceId(from) || !isValidDeviceId(to) || from === to) {
    return res.redirect('/admin/view-devices?msg=' + encodeURIComponent('Нужны два разных ID'));
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = (await client.query('SELECT * FROM devices WHERE device_id = $1 FOR UPDATE', [from])).rows[0];
    const cur = (await client.query('SELECT * FROM devices WHERE device_id = $1 FOR UPDATE', [to])).rows[0];
    if (!old || !cur) {
      msg = 'Не найден ' + (!old ? 'старый' : 'новый') + ' ID';
      await client.query('ROLLBACK');
    } else if (old.status === 'banned') {
      msg = 'Старый ID в бане — не переносим';
      await client.query('ROLLBACK');
    } else {
      // Срок и тариф — лучший из двух; модель телефона — от новой версии.
      if (new Date(old.expires) > new Date(cur.expires)) {
        await client.query(
          `UPDATE devices SET key_code = $2, expires = $3, type = $4,
             status = CASE WHEN status = 'banned' THEN status ELSE 'active' END
           WHERE device_id = $1`,
          [to, old.key_code, old.expires, old.type]
        );
      }
      await client.query('DELETE FROM devices WHERE device_id = $1', [from]);
      await client.query('INSERT INTO trial_history (device_id) VALUES ($1) ON CONFLICT DO NOTHING', [to]);

      // Приглашения: старый код водитель уже раздал — оставляем его. Новый
      // (создаётся при первом запуске) убираем, если по нему никто не пришёл.
      const oldRef = (await client.query('SELECT * FROM referrals WHERE device_id = $1', [from])).rows[0];
      if (oldRef) {
        const newRef = (await client.query('SELECT * FROM referrals WHERE device_id = $1', [to])).rows[0];
        const newUsed = newRef && (await client.query('SELECT 1 FROM referrals WHERE referred_by = $1 LIMIT 1', [newRef.code])).rows.length > 0;
        if (!newRef || !newUsed) {
          await client.query('DELETE FROM referrals WHERE device_id = $1', [to]);
          await client.query(
            'UPDATE referrals SET device_id = $2, referred_by = COALESCE(referred_by, $3) WHERE device_id = $1',
            [from, to, newRef ? newRef.referred_by : null]
          );
        }
      }

      // Чат: ник, админка, заглушка и сообщения.
      const oldChat = (await client.query('SELECT * FROM chat_users WHERE device_id = $1', [from])).rows[0];
      if (oldChat) {
        await client.query('DELETE FROM chat_users WHERE device_id = $1', [to]);
        await client.query('UPDATE chat_users SET device_id = $2 WHERE device_id = $1', [from, to]);
      }
      await client.query('UPDATE chat_messages SET device_id = $2 WHERE device_id = $1', [from, to]);
      // Отметки о клиентах: одинаковые у старого и нового не дублируем.
      await client.query(
        `DELETE FROM client_tags o USING client_tags n
         WHERE o.device_id = $1 AND n.device_id = $2 AND n.phone_hash = o.phone_hash AND n.tag = o.tag`,
        [from, to]
      );
      await client.query('UPDATE client_tags SET device_id = $2 WHERE device_id = $1', [from, to]);
      await client.query(
        `DELETE FROM client_reviews o USING client_reviews n
         WHERE o.device_id = $1 AND n.device_id = $2 AND n.phone_hash = o.phone_hash`,
        [from, to]
      );
      await client.query('UPDATE client_reviews SET device_id = $2 WHERE device_id = $1', [from, to]);
      await client.query('UPDATE road_reports SET device_id = $2 WHERE device_id = $1', [from, to]);
      await client.query('COMMIT');
      const exp = new Date(Math.max(new Date(old.expires), new Date(cur.expires)));
      msg = `Перенесено на ${to}: подписка до ${exp.toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau' })}`;
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    msg = 'Ошибка переноса — ничего не изменено';
  } finally {
    client.release();
  }
  res.redirect('/admin/view-devices?msg=' + encodeURIComponent(msg));
});

// Чат, отметки о клиентах, метки на дороге, аэропорт — см. community.js.
require('./community')(app, pool, { isValidDeviceId, escapeHtml });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} with PostgreSQL`));
