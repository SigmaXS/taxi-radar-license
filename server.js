const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Список активных ключей (сюда можно дописывать свои ключи)
const LICENSE_DATABASE = {
  "RADAR-7788-VIP1": { status: "active", expires: "2099-12-31" },
  "RADAR-2026-CHISINAU": { status: "active", expires: "2099-12-31" },
  "RADAR-TRIAL-01": { status: "active", expires: "2026-10-01" },
  "RADAR-PRO-9988": { status: "active", expires: "2026-12-31" }
};

// Главная страница (проверка, что сервер жив)
app.get('/', (req, res) => {
  res.send('Taxi Radar License Server is running.');
});

// Проверка ключа
app.post('/api/check-license', (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.status(400).json({ valid: false, message: "Введите ключ" });
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
  const expireDate = new Date(license.expires);

  if (now > expireDate) {
    return res.json({
      valid: false,
      message: "Срок действия ключа истек"
    });
  }

  return res.json({
    valid: true,
    message: "Лицензия подтверждена",
    expires: license.expires
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});