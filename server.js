const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DATA_FILE = path.join(__dirname, 'data.json');

// Стартовая база ключей на 30 дней
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
  "VIP3-7M36-S8V2": { durationHours: 720, type: "30 дней" },
  "VIP3-4H29-R6L5": { durationHours: 720, type: "30 дней" },
  "VIP3-8Z14-T9P7": { durationHours: 720, type: "30 дней" },
  "VIP3-3X78-C5Y1": { durationHours: 720, type: "30 дней" },
  "VIP3-9P63-B2N4": { durationHours: 720, type: "30 дней" },
  "VIP3-5L87-V1K9": { durationHours: 720, type: "30 дней" },
  "VIP3-2K41-M7D3": { durationHours: 720, type: "30 дней" },
  "VIP3-6W92-H4F8": { durationHours: 720, type: "30 дней" },
  "VIP3-7E35-G9Q2": { durationHours: 720, type: "30 дней" },
  "VIP3-1T84-X3C6": { durationHours: 720, type: "30 дней" },
  "VIP3-5J69-L8B1": { durationHours: 720, type: "30 дней" }
};

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      keys: { ...INITIAL_KEYS },
      devices: {},
      createdSessionKeys: []
    };
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

app.get('/', (req, res) => {
  res.redirect('/admin/view-devices');
});

// 1. Автоматический пробный период (3 дня = 72 часа)
app.post('/api/request-trial', (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ valid: false, message: "Нет ID устройства" });

  const db = loadData();

  if (db.devices[device_id]) {
    const dev = db.devices[device_id];
    if (dev.status === 'banned') {
      return res.json({ valid: false, message: "Устройство заблокировано (БАН)!" });
    }
    const isExpired = new Date(dev.expires).getTime() < Date.now();
    if (isExpired) {
      return res.json({ valid: false, message: "Пробный период завершен. Введите ключ." });
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

// 2. Активация платного ключа
app.post('/api/activate-device', (req, res) => {
  const { key, device_id } = req.body;
  if (!key || !device_id) {
    return res.status(400).json({ valid: false, message: "Введите ключ и ID устройства" });
  }

  const cleanKey = key.trim().toUpperCase();
  const db = loadData();

  const existingDev = db.devices[device_id];
  if (existingDev && existingDev.status === 'banned') {
    return res.json({ valid: false, message: "Это устройство заблокировано (БАН)!" });
  }

  for (const [dId, dev] of Object.entries(db.devices)) {
    if (dev.key === cleanKey && dId !== device_id && dev.status !== 'banned') {
      return res.json({ valid: false, message: "Этот ключ уже активирован на другом устройстве!" });
    }
  }

  const keyData = db.keys[cleanKey];
  if (!keyData) {
    return res.json({ valid: false, message: "Ключ не найден или уже активирован" });
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

// 3. Фоновая проверка лицензии
app.post('/api/check-license', (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ valid: false, message: "Нет ID" });

  const db = loadData();
  const dev = db.devices[device_id];

  if (!dev) return res.json({ valid: false, message: "Устройство не найдено" });
  if (dev.status === 'banned') return res.json({ valid: false, message: "Устройство заблокировано" });

  const now = new Date();
  const expireDate = new Date(dev.expires);

  if (now > expireDate) {
    return res.json({ valid: false, message: "Срок действия подписки истек" });
  }

  dev.lastSeen = new Date().toISOString();
  saveData(db);

  const diffHours = Math.round((expireDate - now) / 3600000);
  return res.json({ valid: true, expires: dev.expires, hours_left: diffHours });
});

// Веб-админка
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
      hour: '2-digit', minute: '2-digit', second: '2-digit'
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
        <td style="font-weight:bold; letter-spacing:0.5px;">${dev.key}</td>
        <td><code class="dev-id">${deviceId}</code></td>
        <td>${formattedDate}</td>
        <td>
          <form method="POST" action="/admin/action" style="display:inline;">
            <input type="hidden" name="device_id" value="${deviceId}">
            <button name="action" value="reset" class="btn btn-blue">Сбросить</button>
            <button name="action" value="unlink" class="btn btn-orange">Отвязать</button>
            <button name="action" value="ban" class="btn btn-red">В БАН</button>
          </form>
        </td>
      </tr>
    `;
  }).join('');

  const sessionKeysList = (db.createdSessionKeys || []).slice(-8).reverse().map(k => 
    `<li><b style="color:#d69e2e;">${k.key}</b> — (${k.type})</li>`
  ).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <title>Управление лицензиями</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; margin: 0; padding: 30px; }
        .card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); max-width: 1050px; margin: 0 auto 25px auto; }
        h2 { margin-top: 0; font-size: 20px; color: #1a202c; display: flex; align-items: center; gap: 8px; }
        .btn-group { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
        .gen-btn { border: none; padding: 10px 18px; border-radius: 6px; color: #fff; font-weight: bold; cursor: pointer; transition: 0.15s; font-size: 14px; }
        .btn-purple { background: #805ad5; }
        .btn-green { background: #38a169; }
        .gen-btn:hover { opacity: 0.88; transform: translateY(-1px); }
        .badge-count { background: #38a169; color: #fff; font-size: 13px; padding: 2px 10px; border-radius: 12px; font-weight: normal; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th { background: #3182ce; color: #fff; text-align: left; padding: 12px 14px; font-size: 14px; }
        th:first-child { border-top-left-radius: 6px; }
        th:last-child { border-top-right-radius: 6px; }
        td { padding: 12px 14px; border-bottom: 1px solid #edf2f7; font-size: 14px; vertical-align: middle; }
        tr:hover { background: #f7fafc; }
        .dev-id { background: #feebc8; color: #c05621; padding: 3px 8px; border-radius: 4px; font-size: 12px; }
        .btn { border: none; padding: 6px 12px; border-radius: 4px; color: #fff; font-weight: bold; cursor: pointer; font-size: 12px; margin-right: 4px; }
        .btn-blue { background: #3182ce; }
        .btn-orange { background: #dd6b20; }
        .btn-red { background: #e53e3e; }
        .session-keys { font-size: 14px; line-height: 1.8; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🛠 Генератор ключей и Триалов</h2>
        <div class="btn-group">
          <form method="POST" action="/admin/generate"><button name="type" value="trial_1h" class="gen-btn btn-purple">⏱ Триал на 1 час</button></form>
          <form method="POST" action="/admin/generate"><button name="type" value="trial_12h" class="gen-btn btn-purple">⏱ Триал на 12 часов</button></form>
          <form method="POST" action="/admin/generate"><button name="type" value="sub_1d" class="gen-btn btn-green">+ 1 день</button></form>
          <form method="POST" action="/admin/generate"><button name="type" value="sub_7d" class="gen-btn btn-green">+ 7 дней</button></form>
          <form method="POST" action="/admin/generate"><button name="type" value="sub_30d" class="gen-btn btn-green">+ 30 дней</button></form>
        </div>
        <b>Созданные в этой сессии:</b>
        <ul class="session-keys">
          ${sessionKeysList || '<li>Кликните по любой кнопке выше, чтобы создать ключ</li>'}
        </ul>
      </div>

      <div class="card">
        <h2>🔑 Активированные устройства <span class="badge-count">Всего: ${Object.keys(db.devices).length}</span></h2>
        <table>
          <thead>
            <tr>
              <th>Статус</th>
              <th>Ключ</th>
              <th>ID Устройства</th>
              <th>Истекает (Местное)</th>
              <th>Управление</th>
            </tr>
          </thead>
          <tbody>
            ${devicesList || '<tr><td colspan="5" style="text-align:center;color:#a0aec0;padding:25px;">Нет активных устройств</td></tr>'}
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

  if (type === 'trial_1h') { hours = 1; label = "1 час"; }
  else if (type === 'trial_12h') { hours = 12; label = "12 часов"; }
  else if (type === 'sub_1d') { hours = 24; label = "1 день"; }
  else if (type === 'sub_7d') { hours = 168; label = "7 дней"; }
  else if (type === 'sub_30d') { hours = 720; label = "30 дней"; }

  const prefix = type.startsWith('trial') ? 'TR1' : 'VIP3';
  const newKey = generateCode(prefix);
  const db = loadData();

  db.keys[newKey] = { durationHours: hours, type: label, created: new Date().toISOString() };
  if (!db.createdSessionKeys) db.createdSessionKeys = [];
  db.createdSessionKeys.push({ key: newKey, type: label });

  saveData(db);
  res.redirect('/admin/view-devices');
});

app.post('/admin/action', (req, res) => {
  const { device_id, action } = req.body;
  const db = loadData();

  if (db.devices[device_id]) {
    if (action === 'ban') {
      db.devices[device_id].status = 'banned';
    } else if (action === 'unlink') {
      const oldKey = db.devices[device_id].key;
      db.keys[oldKey] = { durationHours: 720, type: "Восстановлен", created: new Date().toISOString() };
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
app.listen(PORT, () => console.log(`License server started on port ${PORT}`));
