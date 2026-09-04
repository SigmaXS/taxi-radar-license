const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DATA_FILE = path.join(__dirname, 'data.json');

const INITIAL_KEYS = {
  "VIP3-7K92-M8X4": { durationHours: 720, type: "30 дней" },
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

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { keys: { ...INITIAL_KEYS }, devices: {}, createdSessionKeys: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed.keys) parsed.keys = { ...INITIAL_KEYS };
    if (!parsed.devices) parsed.devices = {};
    if (!parsed.createdSessionKeys) parsed.createdSessionKeys = [];
    return parsed;
  } catch (e) {
    return { keys: { ...INITIAL_KEYS }, devices: {}, createdSessionKeys: [] };
  }
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Save error:", e);
  }
}

function generateCode(prefix = "VIP3") {
  const chars = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let r1 = "", r2 = "";
  for (let i = 0; i < 4; i++) r1 += chars[Math.floor(Math.random() * chars.length)];
  for (let i = 0; i < 4; i++) r2 += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${r1}-${r2}`;
}

app.get('/', (req, res) => res.redirect('/admin/view-devices'));

// 1. Запрос триала на 3 дня
app.post('/api/request-trial', (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ valid: false, message: "Нет ID" });

  const db = loadData();
  if (db.devices[device_id]) {
    const dev = db.devices[device_id];
    if (dev.status === 'banned') {
      return res.json({ valid: false, is_banned: true, message: "Устройство заблокировано (БАН)!" });
    }
    const isExpired = new Date(dev.expires).getTime() < Date.now();
    if (isExpired) {
      return res.json({ valid: false, is_banned: false, message: "Пробный период завершен. Введите ключ." });
    }
    return res.json({ valid: true, expires: dev.expires, message: "Пробный период активен" });
  }

  const expireDate = new Date(Date.now() + 72 * 3600 * 1000);
  const trialKey = generateCode("TR3D");

  db.devices[device_id] = {
    key: trialKey,
    expires: expireDate.toISOString(),
    lastSeen: new Date().toISOString(),
    status: 'active',
    type: "Пробный (3 дня)"
  };

  saveData(db);
  return res.json({
    valid: true,
    message: "Активирован бесплатный доступ на 3 дня!",
    expires: expireDate.toISOString()
  });
});

// 2. Активация ключа
app.post('/api/activate-device', (req, res) => {
  const { key, device_id } = req.body;
  if (!key || !device_id) {
    return res.status(400).json({ valid: false, message: "Введите ключ и ID" });
  }

  const cleanKey = key.trim().toUpperCase();
  const db = loadData();

  const existingDev = db.devices[device_id];
  if (existingDev && existingDev.status === 'banned') {
    return res.json({ valid: false, is_banned: true, message: "Устройство в бане! Обратитесь к администратору." });
  }

  for (const [dId, dev] of Object.entries(db.devices)) {
    if (dev.key === cleanKey && dId !== device_id && dev.status !== 'banned') {
      return res.json({ valid: false, message: "Этот ключ уже занят другим телефоном!" });
    }
  }

  const keyData = db.keys[cleanKey];
  if (!keyData) {
    return res.json({ valid: false, message: "Неверный ключ или уже активирован" });
  }

  const expireDate = new Date(Date.now() + keyData.durationHours * 3600 * 1000);

  db.devices[device_id] = {
    key: cleanKey,
    expires: expireDate.toISOString(),
    lastSeen: new Date().toISOString(),
    status: 'active',
    type: keyData.type
  };

  delete db.keys[cleanKey];
  saveData(db);

  return res.json({
    valid: true,
    message: `Успешно! Доступ открыт (${keyData.type})`,
    expires: expireDate.toISOString()
  });
});

// 3. Фоновая проверка
app.post('/api/check-license', (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ valid: false, message: "Нет ID" });

  const db = loadData();
  const dev = db.devices[device_id];

  if (!dev) return res.json({ valid: false, message: "Устройство не найдено" });
  
  if (dev.status === 'banned') {
    return res.json({ valid: false, is_banned: true, message: "Устройство заблокировано администратором (БАН)" });
  }

  const serverNow = new Date();
  const expireDate = new Date(dev.expires);

  if (serverNow > expireDate) {
    return res.json({ valid: false, is_banned: false, message: "Срок действия подписки истек" });
  }

  dev.lastSeen = serverNow.toISOString();
  saveData(db);

  const diffHours = Math.max(0, Math.round((expireDate - serverNow) / 3600000));
  return res.json({ valid: true, expires: dev.expires, hours_left: diffHours });
});

// Админ-панель
app.get('/admin/view-devices', (req, res) => {
  const db = loadData();
  const now = Date.now();

  const devicesList = Object.entries(db.devices).map(([deviceId, dev]) => {
    const isBanned = dev.status === 'banned';
    const isExpired = new Date(dev.expires).getTime() < now;
    const lastSeenDiffMin = Math.round((now - new Date(dev.lastSeen).getTime()) / 60000);
    const isOnline = lastSeenDiffMin <= 5 && !isBanned && !isExpired;

    const expDate = new Date(dev.expires);
    const formattedDate = expDate.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    return `
      <tr>
        <td>
          ${isBanned 
            ? '<span style="color:#e53e3e;font-weight:bold;">● В бане</span>'
            : (isExpired 
                ? '<span style="color:#718096;">● Истек</span>' 
                : (isOnline 
                    ? '<span style="color:#38a169;font-weight:bold;">● Онлайн</span>' 
                    : '<span style="color:#a0aec0;">● Оффлайн</span>'))}
        </td>
        <td style="font-weight:bold;">${dev.key}</td>
        <td><code style="background:#feebc8;color:#c05621;padding:3px 6px;border-radius:4px;">${deviceId}</code></td>
        <td>${formattedDate}</td>
        <td>
          <form method="POST" action="/admin/action" style="display:inline;">
            <input type="hidden" name="device_id" value="${deviceId}">
            <button name="action" value="reset" style="background:#3182ce;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;">+30 дней</button>
            ${isBanned 
              ? '<button name="action" value="unban" style="background:#38a169;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;font-weight:bold;">Разбанить</button>'
              : '<button name="action" value="ban" style="background:#e53e3e;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;">В БАН</button>'}
            <button name="action" value="unlink" style="background:#dd6b20;color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;">Удалить</button>
          </form>
        </td>
      </tr>
    `;
  }).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <title>Управление лицензиями</title>
      <style>
        body { font-family: sans-serif; background: #f0f2f5; padding: 25px; margin: 0; }
        .card { background: #fff; border-radius: 10px; padding: 20px; max-width: 1000px; margin: 0 auto 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
        .btn-group { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 15px; }
        .gen-btn { border: none; padding: 8px 14px; border-radius: 5px; color: #fff; font-weight: bold; cursor: pointer; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th { background: #2b6cb0; color: #fff; padding: 10px; text-align: left; }
        td { padding: 10px; border-bottom: 1px solid #edf2f7; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🛠 Создать ключ</h2>
        <div class="btn-group">
          <form method="POST" action="/admin/generate"><button name="type" value="sub_1d" class="gen-btn" style="background:#38a169;">+ 1 день</button></form>
          <form method="POST" action="/admin/generate"><button name="type" value="sub_7d" class="gen-btn" style="background:#38a169;">+ 7 дней</button></form>
          <form method="POST" action="/admin/generate"><button name="type" value="sub_30d" class="gen-btn" style="background:#2f855a;">+ 30 дней</button></form>
        </div>
      </div>
      <div class="card">
        <h2>🔑 Устройства (Всего: ${Object.keys(db.devices).length})</h2>
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
});

app.post('/admin/generate', (req, res) => {
  const { type } = req.body;
  let hours = 720, label = "30 дней";
  if (type === 'sub_1d') { hours = 24; label = "1 день"; }
  else if (type === 'sub_7d') { hours = 168; label = "7 дней"; }

  const newKey = generateCode("VIP3");
  const db = loadData();
  db.keys[newKey] = { durationHours: hours, type: label, created: new Date().toISOString() };
  saveData(db);
  res.redirect('/admin/view-devices');
});

app.post('/admin/action', (req, res) => {
  const { device_id, action } = req.body;
  const db = loadData();

  if (db.devices[device_id]) {
    if (action === 'ban') {
      db.devices[device_id].status = 'banned';
    } else if (action === 'unban') {
      db.devices[device_id].status = 'active';
      if (new Date(db.devices[device_id].expires).getTime() < Date.now()) {
        db.devices[device_id].expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      }
    } else if (action === 'unlink') {
      delete db.devices[device_id];
    } else if (action === 'reset') {
      db.devices[device_id].expires = new Date(Date.now() + 720 * 3600 * 1000).toISOString();
      db.devices[device_id].status = 'active';
    }
    saveData(db);
  }
  res.redirect('/admin/view-devices');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
