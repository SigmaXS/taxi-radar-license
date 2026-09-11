const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const INITIAL_KEYS = {
  "TEST-10SEC-DEMO": { durationHours: 10 / 3600, type: "Тест 10 секунд" },
  "VIP3-7K92-M8X4": { durationHours: 720, type: "301 дней" },
  "VIP3-3B19-TX85": { durationHours: 720, type: "30 дней" },
  "VIP3-5F71-L2W9": { durationHours: 720, type: "30 дней" },
  "VIP3-8C44-P9K3": { durationHours: 720, type: "30 дней" },
  "VIP3-2V67-Q1Z8": { durationHours: 720, type: "30 дней" },
  "VIP3-9D83-X5H2": { durationHours: 720, type: "30 дней" },
  "VIP3-4N52-J7C6": { durationHours: 720, type: "30 дней" },
  "VIP3-6G18-K4B7": { durationHours: 720, type: "30 дней" },
  "VIP3-1A95-W3D8": { durationHours: 720, type: "30 дней" },
  "VIP3-7M36-S8V2": { durationHours: 720, type: "30 дней" }
};

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
    `);

    // Заполняем дефолтные ключи, если таблица пустая
    const res = await pool.query('SELECT COUNT(*) FROM app_keys');
    if (parseInt(res.rows[0].count) === 0) {
      for (const [k, val] of Object.entries(INITIAL_KEYS)) {
        await pool.query(
          'INSERT INTO app_keys (key_code, duration_hours, type, created) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [k, val.durationHours, val.type, new Date()]
        );
      }
    }
    console.log("Database initialized successfully.");
  } catch (err) {
    console.error("DB init error:", err);
  }
}

initDB();

function generateCode(prefix = "VIP3") {
  const chars = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let r1 = "", r2 = "";
  for (let i = 0; i < 4; i++) r1 += chars[Math.floor(Math.random() * chars.length)];
  for (let i = 0; i < 4; i++) r2 += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${r1}-${r2}`;
}

app.get('/', (req, res) => res.redirect('/admin/view-devices'));

// 1. Запрос триала на 3 дня
app.post('/api/request-trial', async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ valid: false, force_lock: true, message: "Нет ID" });

  try {
    const devQuery = await pool.query('SELECT * FROM devices WHERE device_id = $1', [device_id]);
    if (devQuery.rows.length > 0) {
      const dev = devQuery.rows[0];
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

    const expireDate = new Date(Date.now() + 72 * 3600 * 1000);
    const trialKey = generateCode("TR3D");

    await pool.query(
      'INSERT INTO devices (device_id, key_code, expires, last_seen, status, type) VALUES ($1, $2, $3, $4, $5, $6)',
      [device_id, trialKey, expireDate, new Date(), 'active', 'Пробный (3 дня)']
    );
    await pool.query('INSERT INTO trial_history (device_id) VALUES ($1) ON CONFLICT DO NOTHING', [device_id]);

    return res.json({
      valid: true,
      force_lock: false,
      message: "Активирован бесплатный доступ на 3 дня!",
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
  if (!key || !device_id) {
    return res.status(400).json({ valid: false, force_lock: true, message: "Введите ключ и ID" });
  }

  const cleanKey = key.trim().toUpperCase();

  try {
    const devCheck = await pool.query('SELECT * FROM devices WHERE device_id = $1', [device_id]);
    if (devCheck.rows.length > 0 && devCheck.rows[0].status === 'banned') {
      return res.json({ valid: false, force_lock: true, is_banned: true, message: "Устройство в бане!" });
    }

    const keyQuery = await pool.query('SELECT * FROM app_keys WHERE key_code = $1', [cleanKey]);
    if (keyQuery.rows.length === 0) {
      return res.json({ valid: false, force_lock: true, message: "Неверный ключ или уже активирован" });
    }
    const keyData = keyQuery.rows[0];

    const expireDate = new Date(Date.now() + Math.round(keyData.duration_hours * 3600 * 1000));

    await pool.query(`
      INSERT INTO devices (device_id, key_code, expires, last_seen, status, type)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (device_id) DO UPDATE 
      SET key_code = $2, expires = $3, last_seen = $4, status = $5, type = $6
    `, [device_id, cleanKey, expireDate, new Date(), 'active', keyData.type]);

    await pool.query('DELETE FROM app_keys WHERE key_code = $1', [cleanKey]);

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

// 3. Фоновая проверка
app.post('/api/check-license', async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ valid: false, force_lock: true, message: "Нет ID" });

  try {
    const devQuery = await pool.query('SELECT * FROM devices WHERE device_id = $1', [device_id]);
    if (devQuery.rows.length === 0) {
      return res.json({ valid: false, force_lock: true, message: "Устройство не найдено" });
    }
    const dev = devQuery.rows[0];

    if (dev.status === 'banned') {
      return res.json({ valid: false, force_lock: true, is_banned: true, message: "Устройство заблокировано" });
    }

    const serverNow = new Date();
    const expireDate = new Date(dev.expires);

    if (serverNow > expireDate) {
      return res.json({ valid: false, force_lock: true, is_banned: false, message: "Срок действия подписки истек" });
    }

    await pool.query('UPDATE devices SET last_seen = $1 WHERE device_id = $2', [serverNow, device_id]);

    const diffHours = Math.max(0, Math.round((expireDate - serverNow) / 3600000));
    return res.json({ valid: true, force_lock: false, expires: dev.expires, hours_left: diffHours });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, force_lock: true, message: "Ошибка базы данных" });
  }
});

// Админ-панель
app.get('/admin/view-devices', async (req, res) => {
  try {
    const devicesQuery = await pool.query('SELECT * FROM devices');
    const keysQuery = await pool.query('SELECT * FROM app_keys');
    const trialsQuery = await pool.query('SELECT COUNT(*) FROM trial_history');

    const now = Date.now();
    let totalDevices = 0, onlineDevices = 0, activeSubs = 0, expiredSubs = 0, bannedDevices = 0;

    const devicesList = devicesQuery.rows.map(dev => {
      totalDevices++;
      const isBanned = dev.status === 'banned';
      const isExpired = new Date(dev.expires).getTime() < now;
      const lastSeenDiffMin = Math.round((now - new Date(dev.last_seen).getTime()) / 60000);
      const isOnline = lastSeenDiffMin <= 5 && !isBanned && !isExpired;

      if (isBanned) bannedDevices++;
      else if (isExpired) expiredSubs++;
      else activeSubs++;
      if (isOnline) onlineDevices++;

      const expDate = new Date(dev.expires);
      const formattedDate = expDate.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });

      return `
        <tr>
          <td>${isBanned ? '<span style="color:#e53e3e;font-weight:bold;">● В бане</span>' : (isExpired ? '<span style="color:#718096;">● Истек</span>' : (isOnline ? '<span style="color:#38a169;font-weight:bold;">● Онлайн</span>' : '<span style="color:#a0aec0;">● Оффлайн</span>'))}</td>
          <td style="font-weight:bold;">${dev.key_code}</td>
          <td><code style="background:#feebc8;color:#c05621;padding:3px 6px;border-radius:4px;">${dev.device_id}</code></td>
          <td>${formattedDate}</td>
          <td>
            <form method="POST" action="/admin/action" style="display:inline;">
              <input type="hidden" name="device_id" value="${dev.device_id}">
              <button name="action" value="reset" style="background:#3182ce;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;">+30 дней</button>
              ${isBanned ? '<button name="action" value="unban" style="background:#38a169;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;font-weight:bold;">Разбанить</button>' : '<button name="action" value="ban" style="background:#e53e3e;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;">В БАН</button>'}
              <button name="action" value="unlink" style="background:#dd6b20;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;">Удалить</button>
            </form>
          </td>
        </tr>
      `;
    }).join('');

    const freeKeysList = keysQuery.rows.map(k => `
      <div style="background:#f7fafc; padding:8px 12px; margin:5px 0; border-radius:6px; display:flex; justify-content:space-between; align-items:center; border:1px solid #e2e8f0;">
        <div><strong style="color:#2b6cb0;">${k.key_code}</strong> <span style="font-size:12px; color:#718096;">(${k.type})</span></div>
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
          .card { background: #fff; border-radius: 10px; padding: 20px; max-width: 1000px; margin: 0 auto 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
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
          <div class="stats-grid">
            <div class="stat-box"><div>Всего устройств</div><div class="stat-num">${totalDevices}</div></div>
            <div class="stat-box"><div>⚡ Онлайн сейчас</div><div class="stat-num" style="color:#38a169;">${onlineDevices}</div></div>
            <div class="stat-box"><div>✅ Активных</div><div class="stat-num" style="color:#3182ce;">${activeSubs}</div></div>
            <div class="stat-box"><div>⏳ Истекли</div><div class="stat-num" style="color:#718096;">${expiredSubs}</div></div>
            <div class="stat-box"><div>🚫 В бане</div><div class="stat-num" style="color:#e53e3e;">${bannedDevices}</div></div>
            <div class="stat-box"><div>🎁 Взяли триал</div><div class="stat-num">${trialsQuery.rows[0].count}</div></div>
          </div>
        </div>
        <div class="card">
          <h2>🛠 Создать ключ</h2>
          <div class="btn-group">
            <form method="POST" action="/admin/generate"><button name="type" value="sub_10s" class="gen-btn" style="background:#e53e3e;">⚡ Тест 10 сек</button></form>
            <form method="POST" action="/admin/generate"><button name="type" value="sub_1d" class="gen-btn" style="background:#38a169;">+ 1 день</button></form>
            <form method="POST" action="/admin/generate"><button name="type" value="sub_7d" class="gen-btn" style="background:#38a169;">+ 7 дней</button></form>
            <form method="POST" action="/admin/generate"><button name="type" value="sub_30d" class="gen-btn" style="background:#2f855a;">+ 30 дней</button></form>
          </div>
          <h3 style="margin-top:20px; font-size:16px;">Свободные ключи (${keysQuery.rows.length}):</h3>
          <div style="max-height: 150px; overflow-y: auto;">
            ${freeKeysList || '<p style="color:#718096;">Нет свободных ключей</p>'}
          </div>
        </div>
        <div class="card">
          <h2>🔑 Устройства в базе</h2>
          <table>
            <thead>
              <tr><th>Статус</th><th>Ключ</th><th>ID Устройства</th><th>Истекает</th><th>Действие</th></tr>
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
  let hours = 720, label = "30 дней";
  if (type === 'sub_10s') { hours = 10 / 3600; label = "Тест 10 секунд"; }
  else if (type === 'sub_1d') { hours = 24; label = "1 день"; }
  else if (type === 'sub_7d') { hours = 168; label = "7 дней"; }
  else if (type === 'sub_30d') { hours = 720; label = "30 дней"; }

  const newKey = generateCode(type === 'sub_10s' ? "TEST" : "VIP3");
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

app.post('/admin/action', async (req, res) => {
  const { device_id, action } = req.body;
  try {
    if (action === 'ban') {
      await pool.query("UPDATE devices SET status = 'banned' WHERE device_id = $1", [device_id]);
    } else if (action === 'unban') {
      await pool.query("UPDATE devices SET status = 'active', expires = CASE WHEN expires < NOW() THEN NOW() + INTERVAL '1 day' ELSE expires END WHERE device_id = $1", [device_id]);
    } else if (action === 'unlink') {
      await pool.query("DELETE FROM devices WHERE device_id = $1", [device_id]);
    } else if (action === 'reset') {
      const newExp = new Date(Date.now() + 720 * 3600 * 1000);
      await pool.query("UPDATE devices SET status = 'active', expires = $1 WHERE device_id = $2", [newExp, device_id]);
    }
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin/view-devices');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} with PostgreSQL`));
