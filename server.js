const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// База лицензий: ровно 20 ключей со сроком действия на 1 месяц (до 2026-10-04)
const LICENSE_DATABASE = {
  "RADAR-7K92-M8X4": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-3B19-TX85": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-5F71-L2W9": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-8C44-P9K3": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-2V67-Q1Z8": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-9D83-X5H2": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-4N52-J7C6": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-6G18-K4B7": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-1A95-W3D8": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-7M36-S8V2": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-4H29-R6L5": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-8Z14-T9P7": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-3X78-C5Y1": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-9P63-B2N4": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-5L87-V1K9": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-2K41-M7D3": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-6W92-H4F8": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-7E35-G9Q2": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-1T84-X3C6": { status: "active", expires: "2026-10-04", note: "1 Month" },
  "RADAR-5J69-L8B1": { status: "active", expires: "2026-10-04", note: "1 Month" }
};

// Проверка работы сервера
app.get('/', (req, res) => {
  res.send('Taxi Radar License Server is running.');
});

// Проверка лицензионного ключа
app.post('/api/check-license', (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.status(400).json({ valid: false, message: "Введите лицензионный ключ" });
  }

  const cleanKey = key.trim().toUpperCase();
  const license = LICENSE_DATABASE[cleanKey];

  if (!license || license.status !== 'active') {
    return res.json({
      valid: false,
      message: "Ключ не найден или заблокирован"
    });
  }

  const now = new Date();
  const expireDate = new Date(license.expires + "T23:59:59");

  if (now > expireDate) {
    return res.json({
      valid: false,
      message: "Срок действия ключа (1 месяц) истек"
    });
  }

  // Расчет оставшихся дней подписки
  const diffTime = Math.abs(expireDate - now);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return res.json({
    valid: true,
    message: `Лицензия активна! Осталось дней: ${diffDays}`,
    expires: license.expires,
    days_left: diffDays
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
