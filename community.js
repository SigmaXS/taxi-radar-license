// Всё «общее» для водителей Taxi Radar: чат, отметки о клиентах, метки на
// дороге (как в Waze) и очередь в аэропорту. Только для устройств с
// активной подпиской. Всё хранится в той же базе PostgreSQL.
const crypto = require('crypto');

// Метки о клиентах. Жалобы показываем, только когда их поставили минимум
// двое разных водителей: одна злая отметка ничего не решает.
const CLIENT_TAGS = {
  slow: { label: 'долго выходит', negative: true },
  noshow: { label: 'не вышел', negative: true },
  rude: { label: 'неадекватный', negative: true },
  unpaid: { label: 'не заплатил', negative: true },
  ok: { label: 'всё ок', negative: false },
  card: { label: 'оплата картой', negative: false },
  plus: { label: 'есть Яндекс Плюс', negative: false }
};
const CLIENT_TAG_DAYS = 180;
const NEGATIVE_MIN_DRIVERS = 2;

// Метки на карте и сколько минут они живут.
const REPORT_TYPES = {
  police: 60,
  radar: 60,
  danger: 60,
  accident: 120,
  closure: 12 * 60,
  jam: 60,
  pothole: 7 * 24 * 60,
  addr_noshow: 90 * 24 * 60,
  addr_hard: 90 * 24 * 60,
  addr_cancel: 90 * 24 * 60
};

// Места водителей: где поесть, помыть машину, заправиться и т. д. Живут, пока
// их не удалят; три «не советую» больше, чем «советую», — место скрывается.
const PLACE_TYPES = ['food', 'wash', 'fuel', 'coffee', 'wc', 'tire', 'parking'];

// Стоянка такси у аэропорта Кишинёва: «в очереди», если телефон пинговал недавно.
const AIRPORT_QUEUE_MINUTES = 5;

module.exports = function registerCommunity(app, pool, { isValidDeviceId, escapeHtml }) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS chat_users (
      device_id VARCHAR(100) PRIMARY KEY,
      nickname VARCHAR(24) NOT NULL,
      muted BOOLEAN NOT NULL DEFAULT false,
      created TIMESTAMP NOT NULL DEFAULT NOW()
    );
    ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      device_id VARCHAR(100) NOT NULL,
      nickname VARCHAR(24) NOT NULL,
      text VARCHAR(500) NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      deleted BOOLEAN NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS chat_messages_created ON chat_messages (created);
    CREATE TABLE IF NOT EXISTS client_tags (
      phone_hash CHAR(64) NOT NULL,
      device_id VARCHAR(100) NOT NULL,
      tag VARCHAR(20) NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (phone_hash, device_id, tag)
    );
    CREATE TABLE IF NOT EXISTS traffic_samples (
      id BIGSERIAL PRIMARY KEY,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      hour INT NOT NULL,
      weekend BOOLEAN NOT NULL,
      osrm_min REAL NOT NULL,
      yandex_min REAL NOT NULL,
      km REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS traffic_samples_created ON traffic_samples (created);
    CREATE TABLE IF NOT EXISTS places (
      id BIGSERIAL PRIMARY KEY,
      device_id VARCHAR(100) NOT NULL,
      type VARCHAR(20) NOT NULL,
      name VARCHAR(60) NOT NULL,
      note VARCHAR(200) NOT NULL DEFAULT '',
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      hidden BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS place_votes (
      place_id BIGINT NOT NULL,
      device_id VARCHAR(100) NOT NULL,
      good BOOLEAN NOT NULL,
      PRIMARY KEY (place_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS client_reviews (
      phone_hash CHAR(64) NOT NULL,
      device_id VARCHAR(100) NOT NULL,
      text VARCHAR(200) NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (phone_hash, device_id)
    );
    CREATE TABLE IF NOT EXISTS road_reports (
      id BIGSERIAL PRIMARY KEY,
      device_id VARCHAR(100) NOT NULL,
      type VARCHAR(20) NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      expires TIMESTAMP NOT NULL,
      votes_no INT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS road_reports_expires ON road_reports (expires);
    CREATE TABLE IF NOT EXISTS report_votes (
      report_id BIGINT NOT NULL,
      device_id VARCHAR(100) NOT NULL,
      still BOOLEAN NOT NULL,
      PRIMARY KEY (report_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS airport_presence (
      device_id VARCHAR(100) PRIMARY KEY,
      last_seen TIMESTAMP NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trip_reports (
      id BIGSERIAL PRIMARY KEY,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      tariff VARCHAR(20) NOT NULL,
      stops INT NOT NULL DEFAULT 0,
      surge INT NOT NULL DEFAULT 0,
      est_price INT NOT NULL,
      est_km REAL NOT NULL,
      est_min REAL NOT NULL,
      nav_km REAL,
      nav_min REAL,
      nav_price INT,
      real_price INT,
      real_km REAL,
      real_min REAL,
      finished TIMESTAMP
    );
    ALTER TABLE trip_reports ADD COLUMN IF NOT EXISTS note VARCHAR(40);
  `).catch(err => console.error('Community tables init error:', err));

  // ---------- общее ----------

  async function isLicensed(deviceId) {
    if (!isValidDeviceId(deviceId)) return false;
    const r = await pool.query('SELECT status, expires FROM devices WHERE device_id = $1', [deviceId]);
    if (r.rows.length === 0) return false;
    const d = r.rows[0];
    return d.status !== 'banned' && d.status !== 'disabled' && new Date(d.expires) > new Date();
  }

  // Обёртка для всех API сообщества: только подписчики, ошибки — в лог, не наружу.
  function member(handler) {
    return async (req, res) => {
      try {
        const deviceId = req.body && req.body.device_id;
        if (!(await isLicensed(deviceId))) {
          return res.status(403).json({ ok: false, message: 'Нужна активная подписка' });
        }
        await handler(req, res, deviceId);
      } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, message: 'Ошибка сервера' });
      }
    };
  }

  // Простое ограничение частоты в памяти: «не больше N за окно».
  const hits = new Map();
  function tooOften(key, max, windowMs) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) {
      hits.set(key, list);
      return true;
    }
    list.push(now);
    hits.set(key, list);
    return false;
  }

  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
  }

  // ---------- чат ----------

  app.post('/api/chat/profile', member(async (req, res, deviceId) => {
    const nickname = cleanText(req.body.nickname, 20).replace(/\s+/g, ' ');
    if (!/^[\p{L}\p{N} ._-]{2,20}$/u.test(nickname)) {
      return res.json({ ok: false, message: 'Ник: 2–20 букв или цифр' });
    }
    await pool.query(
      `INSERT INTO chat_users (device_id, nickname) VALUES ($1, $2)
       ON CONFLICT (device_id) DO UPDATE SET nickname = $2`,
      [deviceId, nickname]
    );
    res.json({ ok: true, nickname });
  }));

  // after — id последнего сообщения, что уже есть у приложения; без него — последние 50.
  app.post('/api/chat/list', member(async (req, res, deviceId) => {
    const after = parseInt(req.body.after, 10);
    const rows = Number.isFinite(after) && after > 0
      ? (await pool.query(
        `SELECT m.id, m.device_id, m.nickname, m.text, m.created, COALESCE(u.is_admin, false) AS admin
         FROM chat_messages m LEFT JOIN chat_users u ON u.device_id = m.device_id
         WHERE m.id > $1 AND NOT m.deleted ORDER BY m.id LIMIT 100`, [after])).rows
      : (await pool.query(
        `SELECT * FROM (SELECT m.id, m.device_id, m.nickname, m.text, m.created, COALESCE(u.is_admin, false) AS admin
         FROM chat_messages m LEFT JOIN chat_users u ON u.device_id = m.device_id
         WHERE NOT m.deleted ORDER BY m.id DESC LIMIT 50) t ORDER BY id`)).rows;
    const me = (await pool.query('SELECT nickname, muted, is_admin FROM chat_users WHERE device_id = $1', [deviceId])).rows[0];
    // Удалённые админом сообщения приложение должно убрать у себя.
    const deleted = Number.isFinite(after) && after > 0
      ? (await pool.query(
        `SELECT id FROM chat_messages WHERE deleted AND id > $1 - 200`, [after])).rows.map(r => Number(r.id))
      : [];
    res.json({
      ok: true,
      me: me ? { nickname: me.nickname, muted: me.muted, admin: me.is_admin } : null,
      deleted,
      messages: rows.map(m => ({
        id: Number(m.id),
        nickname: m.nickname,
        text: m.text,
        ts: new Date(m.created).toISOString(),
        mine: m.device_id === deviceId,
        admin: m.admin === true
      }))
    });
  }));

  // Сколько новых сообщений после after (не своих) — для красного кружка на главном.
  // after = 0 (чат ещё не открывали) — считаем сообщения за последние сутки.
  app.post('/api/chat/unread', member(async (req, res, deviceId) => {
    const after = parseInt(req.body.after, 10) || 0;
    const r = (await pool.query(
      after > 0
        ? `SELECT COUNT(*) FILTER (WHERE device_id <> $2) AS n, MAX(id) AS last FROM chat_messages WHERE id > $1 AND NOT deleted`
        : `SELECT COUNT(*) FILTER (WHERE device_id <> $2) AS n, MAX(id) AS last FROM chat_messages
           WHERE created > NOW() - INTERVAL '1 day' AND NOT deleted AND $1 = 0`,
      [after, deviceId]
    )).rows[0];
    res.json({ ok: true, count: Math.min(Number(r.n) || 0, 999), last_id: Number(r.last) || after });
  }));

  // Админ чата прямо из приложения: удалить сообщение или заглушить автора.
  app.post('/api/chat/moderate', member(async (req, res, deviceId) => {
    const me = (await pool.query('SELECT is_admin FROM chat_users WHERE device_id = $1', [deviceId])).rows[0];
    if (!me || !me.is_admin) return res.json({ ok: false, message: 'Только для админа' });
    const id = parseInt(req.body.id, 10);
    const msg = (await pool.query('SELECT device_id FROM chat_messages WHERE id = $1', [id])).rows[0];
    if (!msg) return res.json({ ok: false, message: 'Сообщение не найдено' });
    if (req.body.action === 'delete') {
      await pool.query('UPDATE chat_messages SET deleted = true WHERE id = $1', [id]);
    } else if (req.body.action === 'mute') {
      if (msg.device_id === deviceId) return res.json({ ok: false, message: 'Себя заглушить нельзя' });
      await pool.query('UPDATE chat_users SET muted = true WHERE device_id = $1', [msg.device_id]);
      await pool.query('UPDATE chat_messages SET deleted = true WHERE device_id = $1', [msg.device_id]);
    } else {
      return res.json({ ok: false, message: 'Неизвестное действие' });
    }
    res.json({ ok: true });
  }));

  app.post('/api/chat/send', member(async (req, res, deviceId) => {
    const text = cleanText(req.body.text, 500);
    if (!text) return res.json({ ok: false, message: 'Пустое сообщение' });
    const me = (await pool.query('SELECT nickname, muted FROM chat_users WHERE device_id = $1', [deviceId])).rows[0];
    if (!me) return res.json({ ok: false, message: 'Сначала выберите ник' });
    if (me.muted) return res.json({ ok: false, message: 'Вам запрещено писать в чат' });
    if (tooOften('chat3s:' + deviceId, 1, 3000) || tooOften('chat10m:' + deviceId, 30, 10 * 60 * 1000)) {
      return res.json({ ok: false, message: 'Слишком часто — подождите немного' });
    }
    const r = await pool.query(
      'INSERT INTO chat_messages (device_id, nickname, text) VALUES ($1, $2, $3) RETURNING id, created',
      [deviceId, me.nickname, text]
    );
    res.json({ ok: true, id: Number(r.rows[0].id) });
  }));

  // ---------- клиенты ----------

  // Номер хранится только как HMAC-отпечаток с секретом сервера: по базе
  // без секрета номера не восстановить. Секрет — PHONE_PEPPER в Railway;
  // если не задан, берём производный от DATABASE_URL (он постоянный).
  const pepper = process.env.PHONE_PEPPER ||
    crypto.createHash('sha256').update('taxi-radar|' + (process.env.DATABASE_URL || '')).digest('hex');

  function phoneHash(phone) {
    return crypto.createHmac('sha256', pepper).update(phone).digest('hex');
  }

  // Приложение присылает номер уже в международном виде: +37378123456.
  function cleanPhone(value) {
    if (typeof value !== 'string') return null;
    const p = value.replace(/[^\d+]/g, '');
    return /^\+\d{8,15}$/.test(p) ? p : null;
  }

  async function clientSummary(hash, deviceId) {
    const rows = (await pool.query(
      `SELECT tag, COUNT(DISTINCT device_id) AS drivers,
              BOOL_OR(device_id = $2) AS mine,
              BOOL_OR(device_id = 'admin') AS by_admin
       FROM client_tags
       WHERE phone_hash = $1 AND created > NOW() - ($3 || ' days')::INTERVAL
       GROUP BY tag`,
      [hash, deviceId, String(CLIENT_TAG_DAYS)]
    )).rows;
    const tags = {};
    const mine = [];
    for (const r of rows) {
      const def = CLIENT_TAGS[r.tag];
      if (!def) continue;
      const drivers = Number(r.drivers);
      // Отметку админа показываем сразу — он проверил клиента сам.
      if (!def.negative || drivers >= NEGATIVE_MIN_DRIVERS || r.by_admin) tags[r.tag] = drivers;
      if (r.mine) mine.push(r.tag);
    }
    // Отзывы своими словами: по одному от водителя, свежие сверху.
    const reviews = (await pool.query(
      `SELECT text, created, device_id = $2 AS mine, device_id = 'admin' AS admin
       FROM client_reviews
       WHERE phone_hash = $1 AND created > NOW() - ($3 || ' days')::INTERVAL
       ORDER BY created DESC LIMIT 10`,
      [hash, deviceId, String(CLIENT_TAG_DAYS)]
    )).rows.map(r => ({ text: r.text, ts: r.created, mine: r.mine, admin: r.admin }));
    return { tags, mine, reviews };
  }

  // В отзыве не должно быть чужих номеров и ссылок — только слова о поездке.
  function cleanReview(value) {
    return cleanText(value, 200)
      .replace(/https?:\/\/\S+|www\.\S+|t\.me\/\S+/gi, '…')
      .replace(/\+?\d[\d\s()-]{6,}\d/g, '…')
      .replace(/\s+/g, ' ')
      .trim();
  }

  app.post('/api/clients/check', member(async (req, res, deviceId) => {
    const phone = cleanPhone(req.body.phone);
    if (!phone) return res.json({ ok: false, message: 'Неверный номер' });
    if (tooOften('check:' + deviceId, 120, 60 * 60 * 1000)) {
      return res.json({ ok: false, message: 'Слишком много проверок' });
    }
    res.json({ ok: true, ...(await clientSummary(phoneHash(phone), deviceId)) });
  }));

  // on=false снимает свою отметку (ошиблись кнопкой).
  app.post('/api/clients/tag', member(async (req, res, deviceId) => {
    const phone = cleanPhone(req.body.phone);
    const tag = req.body.tag;
    if (!phone || !CLIENT_TAGS[tag]) return res.json({ ok: false, message: 'Неверные данные' });
    const hash = phoneHash(phone);
    if (req.body.on === false) {
      await pool.query('DELETE FROM client_tags WHERE phone_hash = $1 AND device_id = $2 AND tag = $3', [hash, deviceId, tag]);
    } else {
      const today = await pool.query(
        "SELECT COUNT(*) AS n FROM client_tags WHERE device_id = $1 AND created > NOW() - INTERVAL '1 day'",
        [deviceId]
      );
      if (Number(today.rows[0].n) >= 30) return res.json({ ok: false, message: 'Не больше 30 отметок в сутки' });
      await pool.query(
        `INSERT INTO client_tags (phone_hash, device_id, tag) VALUES ($1, $2, $3)
         ON CONFLICT (phone_hash, device_id, tag) DO UPDATE SET created = NOW()`,
        [hash, deviceId, tag]
      );
    }
    res.json({ ok: true, ...(await clientSummary(hash, deviceId)) });
  }));

  // Свой отзыв о клиенте; пустой текст — удалить свой отзыв.
  app.post('/api/clients/review', member(async (req, res, deviceId) => {
    const phone = cleanPhone(req.body.phone);
    if (!phone) return res.json({ ok: false, message: 'Неверный номер' });
    const hash = phoneHash(phone);
    const text = cleanReview(req.body.text);
    if (!text) {
      await pool.query('DELETE FROM client_reviews WHERE phone_hash = $1 AND device_id = $2', [hash, deviceId]);
    } else {
      if (tooOften('review:' + deviceId, 20, 24 * 3600 * 1000)) {
        return res.json({ ok: false, message: 'Не больше 20 отзывов в сутки' });
      }
      await pool.query(
        `INSERT INTO client_reviews (phone_hash, device_id, text) VALUES ($1, $2, $3)
         ON CONFLICT (phone_hash, device_id) DO UPDATE SET text = $3, created = NOW()`,
        [hash, deviceId, text]
      );
    }
    res.json({ ok: true, ...(await clientSummary(hash, deviceId)) });
  }));

  // ---------- метки на дороге ----------

  function validPoint(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && lat > 45.3 && lat < 48.7 && lon > 26.5 && lon < 30.3;
  }

  app.post('/api/reports/list', member(async (req, res, deviceId) => {
    const lat = Number(req.body.lat), lon = Number(req.body.lon);
    if (!validPoint(lat, lon)) return res.json({ ok: true, reports: [] });
    // ~30 км вокруг водителя.
    const rows = (await pool.query(
      `SELECT r.id, r.type, r.lat, r.lon, r.created, r.expires, r.device_id,
              v.still AS my_vote
       FROM road_reports r
       LEFT JOIN report_votes v ON v.report_id = r.id AND v.device_id = $5
       WHERE r.expires > NOW() AND r.lat BETWEEN $1 AND $2 AND r.lon BETWEEN $3 AND $4
       ORDER BY r.created DESC LIMIT 300`,
      [lat - 0.27, lat + 0.27, lon - 0.4, lon + 0.4, deviceId]
    )).rows;
    res.json({
      ok: true,
      reports: rows.map(r => ({
        id: Number(r.id),
        type: r.type,
        lat: r.lat,
        lon: r.lon,
        created: new Date(r.created).toISOString(),
        mine: r.device_id === deviceId,
        voted: r.my_vote !== null
      }))
    });
  }));

  app.post('/api/reports/add', member(async (req, res, deviceId) => {
    const type = req.body.type;
    const lat = Number(req.body.lat), lon = Number(req.body.lon);
    const ttl = REPORT_TYPES[type];
    if (!ttl || !validPoint(lat, lon)) return res.json({ ok: false, message: 'Неверная метка' });
    if (tooOften('report:' + deviceId, 10, 60 * 60 * 1000)) {
      return res.json({ ok: false, message: 'Не больше 10 меток в час' });
    }
    // Такая же метка рядом (~150 м) уже есть — продлеваем её, а не плодим копии.
    const near = await pool.query(
      `SELECT id FROM road_reports WHERE type = $1 AND expires > NOW()
       AND ABS(lat - $2) < 0.00135 AND ABS(lon - $3) < 0.002 LIMIT 1`,
      [type, lat, lon]
    );
    const expires = new Date(Date.now() + ttl * 60 * 1000);
    if (near.rows.length) {
      await pool.query('UPDATE road_reports SET expires = GREATEST(expires, $1), votes_no = 0 WHERE id = $2', [expires, near.rows[0].id]);
      return res.json({ ok: true, id: Number(near.rows[0].id), extended: true });
    }
    const r = await pool.query(
      'INSERT INTO road_reports (device_id, type, lat, lon, expires) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [deviceId, type, lat, lon, expires]
    );
    res.json({ ok: true, id: Number(r.rows[0].id) });
  }));

  // «Ещё здесь?» — да продлевает метку, два «нет» от разных водителей убирают её.
  app.post('/api/reports/vote', member(async (req, res, deviceId) => {
    const id = parseInt(req.body.id, 10);
    const still = req.body.still === true;
    const rep = (await pool.query('SELECT type, device_id FROM road_reports WHERE id = $1', [id])).rows[0];
    if (!rep) return res.json({ ok: false, message: 'Метка уже исчезла' });
    await pool.query(
      `INSERT INTO report_votes (report_id, device_id, still) VALUES ($1, $2, $3)
       ON CONFLICT (report_id, device_id) DO UPDATE SET still = $3`,
      [id, deviceId, still]
    );
    if (still) {
      const expires = new Date(Date.now() + REPORT_TYPES[rep.type] * 60 * 1000);
      await pool.query('UPDATE road_reports SET expires = GREATEST(expires, $1) WHERE id = $2', [expires, id]);
    } else {
      const no = await pool.query('SELECT COUNT(*) AS n FROM report_votes WHERE report_id = $1 AND NOT still', [id]);
      const n = Number(no.rows[0].n);
      // Автор сам сказал «нет» — убираем сразу.
      if (n >= 2 || rep.device_id === deviceId) {
        await pool.query('UPDATE road_reports SET expires = NOW(), votes_no = $1 WHERE id = $2', [n, id]);
      } else {
        await pool.query('UPDATE road_reports SET votes_no = $1 WHERE id = $2', [n, id]);
      }
    }
    res.json({ ok: true });
  }));

  // ---------- общие пробки: обучение на поездках всех водителей ----------

  // Пример: сколько ехать по OSRM (пустые дороги) и сколько по Яндексу в этот час.
  app.post('/api/traffic/sample', member(async (req, res, deviceId) => {
    const hour = parseInt(req.body.hour, 10);
    const osrm = Number(req.body.osrm_min), yandex = Number(req.body.yandex_min), km = Number(req.body.km);
    const ratio = yandex / osrm;
    if (!(hour >= 0 && hour <= 23) || !(osrm >= 3 && osrm <= 300) || !(km > 0 && km < 500) || !(ratio >= 0.5 && ratio <= 3)) {
      return res.json({ ok: false });
    }
    if (tooOften('traffic:' + deviceId, 80, 24 * 3600 * 1000)) return res.json({ ok: false });
    await pool.query(
      'INSERT INTO traffic_samples (hour, weekend, osrm_min, yandex_min, km) VALUES ($1, $2, $3, $4, $5)',
      [hour, req.body.weekend === true, osrm, yandex, km]
    );
    res.json({ ok: true });
  }));

  // Поправка на каждый час (будни / выходные): медиана «Яндекс / OSRM» за 60 дней
  // по этому часу ±1, если примеров хотя бы 3. Пересчитываем раз в 10 минут.
  const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  async function rebuildTraffic() {
    try {
      const rows = (await pool.query(
        `SELECT hour, weekend, yandex_min / osrm_min AS r FROM traffic_samples WHERE created > NOW() - INTERVAL '60 days'`
      )).rows;
      const table = { wd: [], we: [], n_wd: [], n_we: [], total: rows.length };
      for (const weekend of [false, true]) {
        for (let h = 0; h < 24; h++) {
          const near = rows.filter(x => x.weekend === weekend && Math.min(Math.abs(x.hour - h), 24 - Math.abs(x.hour - h)) <= 1).map(x => Number(x.r));
          const v = near.length >= 3 ? Math.min(2.2, Math.max(0.8, median(near))) : null;
          table[weekend ? 'we' : 'wd'].push(v == null ? null : Math.round(v * 100) / 100);
          table[weekend ? 'n_we' : 'n_wd'].push(near.length);
        }
      }
      app.locals.trafficTable = table;
    } catch (err) {
      console.error('Traffic table:', err.message);
    }
  }
  setTimeout(rebuildTraffic, 5000);
  setInterval(rebuildTraffic, 10 * 60 * 1000);

  // ---------- места водителей ----------

  app.post('/api/places/list', member(async (req, res, deviceId) => {
    const lat = Number(req.body.lat), lon = Number(req.body.lon);
    if (!validPoint(lat, lon)) return res.json({ ok: true, places: [] });
    const rows = (await pool.query(
      `SELECT p.id, p.type, p.name, p.note, p.lat, p.lon, p.device_id,
              COUNT(v.*) FILTER (WHERE v.good) AS up,
              COUNT(v.*) FILTER (WHERE NOT v.good) AS down,
              BOOL_OR(v.device_id = $5 AND v.good) AS my_up,
              BOOL_OR(v.device_id = $5 AND NOT v.good) AS my_down
       FROM places p LEFT JOIN place_votes v ON v.place_id = p.id
       WHERE NOT p.hidden AND p.lat BETWEEN $1 AND $2 AND p.lon BETWEEN $3 AND $4
       GROUP BY p.id ORDER BY p.created DESC LIMIT 500`,
      [lat - 0.27, lat + 0.27, lon - 0.4, lon + 0.4, deviceId]
    )).rows;
    res.json({
      ok: true,
      places: rows
        .filter(r => !(Number(r.down) >= 3 && Number(r.down) > Number(r.up)))
        .map(r => ({
          id: Number(r.id), type: r.type, name: r.name, note: r.note, lat: r.lat, lon: r.lon,
          up: Number(r.up), down: Number(r.down), mine: r.device_id === deviceId,
          vote: r.my_up ? 1 : r.my_down ? -1 : 0
        }))
    });
  }));

  app.post('/api/places/add', member(async (req, res, deviceId) => {
    const type = req.body.type;
    const lat = Number(req.body.lat), lon = Number(req.body.lon);
    const name = cleanText(req.body.name, 60);
    const note = cleanText(req.body.note, 200).replace(/https?:\/\/\S+|www\.\S+/gi, '…');
    if (!PLACE_TYPES.includes(type) || !validPoint(lat, lon) || !name) {
      return res.json({ ok: false, message: 'Укажите тип и название' });
    }
    if (tooOften('place:' + deviceId, 10, 24 * 3600 * 1000)) {
      return res.json({ ok: false, message: 'Не больше 10 мест в сутки' });
    }
    const r = await pool.query(
      'INSERT INTO places (device_id, type, name, note, lat, lon) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [deviceId, type, name, note, lat, lon]
    );
    // Автор — сразу «советую».
    await pool.query('INSERT INTO place_votes (place_id, device_id, good) VALUES ($1, $2, true)', [r.rows[0].id, deviceId]);
    res.json({ ok: true, id: Number(r.rows[0].id) });
  }));

  // vote: 1 — советую, -1 — не советую, 0 — убрать свой голос.
  app.post('/api/places/vote', member(async (req, res, deviceId) => {
    const id = parseInt(req.body.id, 10);
    const vote = Number(req.body.vote);
    if (!(await pool.query('SELECT 1 FROM places WHERE id = $1 AND NOT hidden', [id])).rows.length) {
      return res.json({ ok: false, message: 'Места уже нет' });
    }
    if (vote === 0) {
      await pool.query('DELETE FROM place_votes WHERE place_id = $1 AND device_id = $2', [id, deviceId]);
    } else {
      await pool.query(
        `INSERT INTO place_votes (place_id, device_id, good) VALUES ($1, $2, $3)
         ON CONFLICT (place_id, device_id) DO UPDATE SET good = $3`,
        [id, deviceId, vote > 0]
      );
    }
    res.json({ ok: true });
  }));

  // Удалить может только автор (и админ — в админке).
  app.post('/api/places/delete', member(async (req, res, deviceId) => {
    const r = await pool.query('UPDATE places SET hidden = true WHERE id = $1 AND device_id = $2', [parseInt(req.body.id, 10), deviceId]);
    res.json({ ok: r.rowCount > 0 });
  }));

  // ---------- аэропорт ----------

  // Приложение пингует, только пока телефон на стоянке такси у аэропорта.
  app.post('/api/airport/ping', member(async (req, res, deviceId) => {
    await pool.query(
      `INSERT INTO airport_presence (device_id, last_seen) VALUES ($1, NOW())
       ON CONFLICT (device_id) DO UPDATE SET last_seen = NOW()`,
      [deviceId]
    );
    res.json({ ok: true });
  }));

  app.post('/api/airport/status', member(async (req, res) => {
    const q = await pool.query(
      `SELECT COUNT(*) AS n FROM airport_presence WHERE last_seen > NOW() - ($1 || ' minutes')::INTERVAL`,
      [String(AIRPORT_QUEUE_MINUTES)]
    );
    res.json({ ok: true, queue: Number(q.rows[0].n), flights: await airportBoard.flights() });
  }));

  // ---------- табло прилётов (см. airport.js) ----------

  const airportBoard = require('./airport')();
  // Открыто: только состояние источников, без ключей и без самих рейсов.
  app.get('/api/airport/board-status', (req, res) => res.json(airportBoard.status()));

  // ---------- общий геокодер (см. geocoder.js) ----------

  const geocoder = require('./geocoder')(pool);

  app.post('/api/geocode', member(async (req, res, deviceId) => {
    // Одна карточка — 2–5 адресов; 200 за 10 минут хватит с запасом.
    if (tooOften('geo:' + deviceId, 200, 10 * 60 * 1000)) {
      return res.json({ ok: false, message: 'Слишком часто' });
    }
    const q = cleanText(req.body.q, 300);
    const r = await geocoder.lookup(q);
    if (!r) return res.json({ ok: false, message: 'Геокодер недоступен' });
    res.json({ ok: true, ...r });
  }));

  app.post('/api/geocode/miss', member(async (req, res, deviceId) => {
    if (tooOften('miss:' + deviceId, 60, 10 * 60 * 1000)) return res.json({ ok: false });
    await geocoder.miss(cleanText(req.body.q, 300));
    res.json({ ok: true });
  }));

  // Точка, где водитель забрал или высадил пассажира. Кто прислал — не храним.
  app.post('/api/geocode/learn', member(async (req, res, deviceId) => {
    if (tooOften('learn:' + deviceId, 30, 60 * 60 * 1000)) return res.json({ ok: false });
    const r = await geocoder.learn(cleanText(req.body.q, 300), Number(req.body.lat), Number(req.body.lon));
    res.json({ ok: r === 'ok', result: r });
  }));

  // ---------- точность цен: наш расчёт против Яндекса ----------

  const num = (v, min, max) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= min && x <= max ? x : null;
  };

  // Поездка началась: наш расчёт с карточки и что показал навигатор Яндекса.
  app.post('/api/trips/start', member(async (req, res, deviceId) => {
    if (tooOften('trip:' + deviceId, 20, 60 * 60 * 1000)) return res.json({ ok: false });
    const b = req.body;
    const estPrice = num(b.est_price, 1, 20000);
    if (estPrice == null) return res.json({ ok: false });
    const r = await pool.query(
      `INSERT INTO trip_reports (tariff, stops, surge, est_price, est_km, est_min, nav_km, nav_min, nav_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [cleanText(b.tariff, 20) || '?', num(b.stops, 0, 10) || 0, num(b.surge, 0, 5000) || 0, estPrice,
        num(b.est_km, 0, 1000) || 0, num(b.est_min, 0, 1000) || 0,
        num(b.nav_km, 0, 1000), num(b.nav_min, 0, 1000), num(b.nav_price, 1, 20000)]
    );
    res.json({ ok: true, id: String(r.rows[0].id) });
  }));

  // Поездка закончилась: цена, км и минуты, которые показал Яндекс Про.
  app.post('/api/trips/finish', member(async (req, res) => {
    const b = req.body;
    await pool.query(
      `UPDATE trip_reports SET real_price = $2, real_km = $3, real_min = $4, note = $5, finished = NOW()
       WHERE id = $1 AND finished IS NULL AND created > NOW() - INTERVAL '6 hours'`,
      // note — «маршрут менялся», «завершён не у Б»: такие поездки в среднюю ошибку не идут.
      [parseInt(b.id, 10) || 0, num(b.real_price, 1, 20000), num(b.real_km, 0, 1000), num(b.real_min, 0, 1000),
        cleanText(b.note, 40) || null]
    );
    res.json({ ok: true });
  }));

  // Открыто: счётчики без ключей и без адресов.
  app.get('/api/geocode-status', async (req, res) => {
    try {
      res.json(await geocoder.status());
    } catch (err) {
      res.status(500).json({ error: 'status failed' });
    }
  });

  // ---------- админка ----------

  app.get('/admin/community', async (req, res) => {
    try {
      const messages = (await pool.query(
        `SELECT m.id, m.device_id, m.nickname, m.text, m.created, m.deleted, u.muted, u.is_admin
         FROM chat_messages m LEFT JOIN chat_users u ON u.device_id = m.device_id
         ORDER BY m.id DESC LIMIT 100`
      )).rows;
      const reports = (await pool.query(
        'SELECT id, device_id, type, lat, lon, created, expires, votes_no FROM road_reports WHERE expires > NOW() ORDER BY created DESC LIMIT 200'
      )).rows;
      const tagStats = (await pool.query(
        'SELECT tag, COUNT(*) AS n, COUNT(DISTINCT phone_hash) AS phones FROM client_tags GROUP BY tag ORDER BY n DESC'
      )).rows;
      const queue = (await pool.query(
        `SELECT COUNT(*) AS n FROM airport_presence WHERE last_seen > NOW() - ($1 || ' minutes')::INTERVAL`,
        [String(AIRPORT_QUEUE_MINUTES)]
      )).rows[0].n;
      const fmt = d => new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau' });
      const btn = 'border:none;padding:4px 8px;border-radius:4px;color:#fff;cursor:pointer;';
      const addr = await geocoder.adminData();
      const trips = (await pool.query('SELECT * FROM trip_reports ORDER BY id DESC LIMIT 50')).rows;
      const acc = (await pool.query(
        `SELECT COUNT(*) AS n,
           AVG(real_price - est_price) AS avg_diff, AVG(ABS(real_price - est_price)) AS avg_abs,
           AVG(ABS(real_price - nav_price)) FILTER (WHERE nav_price IS NOT NULL) AS nav_abs
         FROM trip_reports WHERE real_price IS NOT NULL AND note IS NULL AND created > NOW() - INTERVAL '30 days'`
      )).rows[0];
      const lei = v => v == null ? '—' : `${Math.round(Number(v))} L`;

      const missRows = addr.misses.map(m => `
        <tr>
          <td>${escapeHtml(m.text)}<br><a href="https://yandex.ru/maps/?text=${encodeURIComponent('Кишинёв ' + m.text)}" target="_blank" style="font-size:12px;">искать на карте</a></td>
          <td>${escapeHtml(m.n)}</td>
          <td style="white-space:nowrap;">${escapeHtml(fmt(m.last_seen))}</td>
          <td style="white-space:nowrap;">
            <form method="POST" action="/admin/community/address" style="display:inline;">
              <input type="hidden" name="q" value="${escapeHtml(m.text)}">
              <input type="text" name="point" placeholder="47.0105, 28.8638" style="width:150px;">
              <button name="action" value="set" style="${btn}background:#38a169;">Сохранить точку</button>
              <button name="action" value="dismiss" style="${btn}background:#718096;">Скрыть</button>
            </form>
          </td>
        </tr>`).join('');
      const pointRows = addr.points.map(p => `
        <tr>
          <td>${escapeHtml(p.q)}</td>
          <td><a href="https://yandex.ru/maps/?pt=${p.lon},${p.lat}&z=17" target="_blank">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</a></td>
          <td>${p.source === 'admin' ? 'админ' : `поездки: ${escapeHtml(p.n)}`}</td>
          <td>
            <form method="POST" action="/admin/community/address" style="display:inline;">
              <input type="hidden" name="q" value="${escapeHtml(p.q)}">
              <button name="action" value="remove" style="${btn}background:#e53e3e;">Удалить</button>
            </form>
          </td>
        </tr>`).join('');
      const countLine = addr.counts.map(c => `${c.source === 'admin' ? 'от админа' : 'с поездок'}: ${c.total}` +
        (c.source === 'gps' ? ` (подтверждено 2+ поездками: ${c.confirmed})` : '')).join(' · ');
      const tripRows = trips.map(t => `
        <tr>
          <td style="white-space:nowrap;">${escapeHtml(fmt(t.created))}</td>
          <td>${escapeHtml(t.tariff)}${t.stops ? ` +${escapeHtml(t.stops)} заезд` : ''}${t.surge ? ` +${escapeHtml(t.surge)}` : ''}</td>
          <td>${lei(t.est_price)} · ${Number(t.est_km).toFixed(1)} км · ${Math.round(t.est_min)} мин</td>
          <td>${t.nav_price == null ? '—' : `${lei(t.nav_price)} · ${Number(t.nav_km).toFixed(1)} км · ${Math.round(t.nav_min)} мин`}</td>
          <td>${t.real_price == null ? (t.finished ? 'цена не распознана' : '—') : `<b>${lei(t.real_price)}</b>`}${t.real_km != null ? ` · ${Number(t.real_km).toFixed(1)} км` : ''}${t.real_min != null ? ` · ${Math.round(t.real_min)} мин` : ''}</td>
          <td>${t.real_price == null ? '' : `${t.real_price - t.est_price > 0 ? '+' : ''}${t.real_price - t.est_price} L`}${t.note ? `<br><span style="font-size:12px;color:#dd6b20;">${escapeHtml(t.note)} — не в среднем</span>` : ''}</td>
        </tr>`).join('');

      const chatRows = messages.map(m => `
        <tr style="${m.deleted ? 'opacity:.4' : ''}">
          <td style="white-space:nowrap;">${escapeHtml(fmt(m.created))}</td>
          <td><b>${escapeHtml(m.nickname)}</b>${m.is_admin ? ' <span style="color:#d69e2e;">★ админ</span>' : ''}${m.muted ? ' <span style="color:#e53e3e;">(заглушён)</span>' : ''}<br><code style="font-size:11px;">${escapeHtml(m.device_id)}</code></td>
          <td>${escapeHtml(m.text)}</td>
          <td style="white-space:nowrap;">
            <form method="POST" action="/admin/community/chat" style="display:inline;">
              <input type="hidden" name="id" value="${escapeHtml(m.id)}">
              <input type="hidden" name="device_id" value="${escapeHtml(m.device_id)}">
              ${m.deleted ? '' : `<button name="action" value="delete" style="${btn}background:#718096;">Удалить</button>`}
              ${m.is_admin
                ? `<button name="action" value="unadmin" style="${btn}background:#718096;">Снять админа</button>`
                : `<button name="action" value="admin" style="${btn}background:#d69e2e;" onclick="return confirm('Сделать этого водителя админом чата?')">Сделать админом</button>`}
              ${m.muted
                ? `<button name="action" value="unmute" style="${btn}background:#38a169;">Разрешить писать</button>`
                : `<button name="action" value="mute" style="${btn}background:#e53e3e;" onclick="return confirm('Запретить этому водителю писать в чат?')">Заглушить</button>`}
            </form>
          </td>
        </tr>`).join('');

      const reportRows = reports.map(r => `
        <tr>
          <td>${escapeHtml(r.type)}</td>
          <td><a href="https://yandex.ru/maps/?pt=${r.lon},${r.lat}&z=16" target="_blank">${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</a></td>
          <td>${escapeHtml(fmt(r.created))}</td>
          <td>${escapeHtml(fmt(r.expires))}</td>
          <td><code style="font-size:11px;">${escapeHtml(r.device_id)}</code></td>
          <td>
            <form method="POST" action="/admin/community/report" style="display:inline;">
              <input type="hidden" name="id" value="${escapeHtml(r.id)}">
              <button style="${btn}background:#e53e3e;">Убрать</button>
            </form>
          </td>
        </tr>`).join('');

      const reviews = (await pool.query(
        `SELECT phone_hash, device_id, text, created FROM client_reviews ORDER BY created DESC LIMIT 30`
      )).rows;
      const reviewRows = reviews.map(r => `
        <tr>
          <td style="white-space:nowrap;">${escapeHtml(fmt(r.created))}</td>
          <td>${escapeHtml(r.text)}</td>
          <td><code style="font-size:11px;">${escapeHtml(r.device_id)}</code></td>
          <td>
            <form method="POST" action="/admin/community/review" style="display:inline;">
              <input type="hidden" name="phone_hash" value="${escapeHtml(r.phone_hash)}">
              <input type="hidden" name="device_id" value="${escapeHtml(r.device_id)}">
              <button style="${btn}background:#e53e3e;">Удалить</button>
            </form>
          </td>
        </tr>`).join('');
      const placesList = (await pool.query(
        `SELECT p.id, p.type, p.name, p.note, p.lat, p.lon, p.hidden,
                COUNT(v.*) FILTER (WHERE v.good) AS up, COUNT(v.*) FILTER (WHERE NOT v.good) AS down
         FROM places p LEFT JOIN place_votes v ON v.place_id = p.id
         GROUP BY p.id ORDER BY p.created DESC LIMIT 50`
      )).rows;
      const placeRows = placesList.map(p => `
        <tr style="${p.hidden ? 'opacity:.4' : ''}">
          <td>${escapeHtml(p.type)}</td>
          <td><b>${escapeHtml(p.name)}</b><br>${escapeHtml(p.note)}</td>
          <td><a href="https://yandex.ru/maps/?pt=${p.lon},${p.lat}&z=17" target="_blank">карта</a></td>
          <td>${escapeHtml(p.up)} / ${escapeHtml(p.down)}</td>
          <td>${p.hidden ? 'удалено' : `<form method="POST" action="/admin/community/place" style="display:inline;">
            <input type="hidden" name="id" value="${escapeHtml(p.id)}">
            <button style="${btn}background:#e53e3e;">Удалить</button></form>`}</td>
        </tr>`).join('');
      const tagRows = tagStats.map(t => `<li>${escapeHtml((CLIENT_TAGS[t.tag] || {}).label || t.tag)}: ${t.n} отметок, ${t.phones} номеров</li>`).join('');
      const notice = req.query.msg ? `<p style="background:#ebf8ff;padding:10px;border-radius:6px;">${escapeHtml(req.query.msg)}</p>` : '';

      res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Сообщество — Taxi Radar</title>
        <style>
          body { font-family: sans-serif; background: #f0f2f5; padding: 25px; margin: 0; }
          .card { background: #fff; border-radius: 10px; padding: 20px; max-width: 1150px; margin: 0 auto 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
          table { width: 100%; border-collapse: collapse; } td, th { padding: 8px; border-bottom: 1px solid #edf2f7; font-size: 14px; text-align: left; vertical-align: top; }
          th { background: #2b6cb0; color: #fff; } input[type=text] { padding: 6px; width: 260px; }
        </style></head><body>
        <div class="card"><a href="/admin/view-devices">← Устройства и ключи</a>${notice}</div>
        <div class="card"><h2>📍 Адреса, которые не нашлись (${addr.misses.length})</h2>
          <p style="font-size:13px;color:#4a5568;">Яндекс не нашёл эти адреса — цена по ним не показывалась. Найдите место на карте, скопируйте координаты («47.0105, 28.8638») и сохраните — дальше адрес будет находиться у всех. Точки с поездок водителей добавляются сами.</p>
          <table><tr><th>Адрес с карточки</th><th>Раз</th><th>Последний</th><th></th></tr>${missRows || '<tr><td colspan="4">Все адреса находятся 👍</td></tr>'}</table>
          <h3 style="margin-top:20px;">Свои точки адресов ${countLine ? `<span style="font-weight:normal;font-size:13px;">— ${escapeHtml(countLine)}</span>` : ''}</h3>
          <form method="POST" action="/admin/community/address" style="margin-bottom:10px;">
            <input type="text" name="q" placeholder="Адрес, как на карточке заказа">
            <input type="text" name="point" placeholder="47.0105, 28.8638" style="width:150px;">
            <button name="action" value="set" style="${btn}background:#38a169;">Добавить точку</button>
          </form>
          <table><tr><th>Адрес</th><th>Точка</th><th>Откуда</th><th></th></tr>${pointRows || '<tr><td colspan="4">Пока нет</td></tr>'}</table>
        </div>
        <div class="card"><h2>🎯 Точность цены</h2>
          <p>За 30 дней поездок с ценой от Яндекса: <b>${escapeHtml(acc.n)}</b>. Средняя ошибка расчёта с карточки: <b>${lei(acc.avg_abs)}</b> (в среднем Яндекс ${acc.avg_diff != null && acc.avg_diff < 0 ? 'дешевле' : 'дороже'} на ${lei(acc.avg_diff == null ? null : Math.abs(acc.avg_diff))}). После «Поехали» по навигатору: <b>${lei(acc.nav_abs)}</b>.</p>
          <table><tr><th>Когда</th><th>Тариф</th><th>Наш расчёт</th><th>По навигатору</th><th>Яндекс в конце</th><th>Разница</th></tr>${tripRows || '<tr><td colspan="6">Поездок пока нет</td></tr>'}</table>
        </div>
        <div class="card"><h2>✈️ Аэропорт</h2><p>Сейчас в очереди водителей радара: <b>${escapeHtml(queue)}</b></p></div>
        <div class="card"><h2>👤 Клиенты</h2>
          <p>Номера в базе не хранятся — только зашифрованные отпечатки. Проверить или очистить номер можно, только введя его.</p>
          <ul>${tagRows || '<li>Отметок пока нет</li>'}</ul>
          <form method="POST" action="/admin/community/client" style="margin-top:10px;">
            <input type="text" name="phone" placeholder="+37378123456">
            <button name="action" value="check" style="${btn}background:#3182ce;">Проверить</button>
            <button name="action" value="clear" style="${btn}background:#e53e3e;" onclick="return confirm('Удалить все отметки этого номера?')">Очистить номер</button>
          </form>
          <form method="POST" action="/admin/community/client" style="margin-top:10px;">
            <input type="text" name="phone" placeholder="+37378123456 или 078123456">
            <select name="tag" style="padding:6px;">
              ${Object.entries(CLIENT_TAGS).map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`).join('')}
            </select>
            <button name="action" value="tag" style="${btn}background:#d69e2e;">Добавить метку от админа</button>
            <div style="font-size:12px;color:#718096;margin-top:4px;">Метка от админа видна водителям сразу, без правила «минимум 2 водителя». Удобно проверить на своём номере.</div>
          </form>
          <form method="POST" action="/admin/community/client" style="margin-top:10px;">
            <input type="text" name="device_id" placeholder="ID устройства водителя">
            <button name="action" value="clear_device" style="${btn}background:#e53e3e;" onclick="return confirm('Удалить все отметки, которые поставил этот водитель?')">Удалить все его отметки</button>
          </form>
        </div>
        <div class="card"><h2>✍ Отзывы о клиентах (последние 30)</h2>
          <p style="font-size:13px;color:#4a5568;">Водители видят отзыв сразу. Удаляйте оскорбления, личные данные и всё, что не о поездке.</p>
          <table><tr><th>Когда</th><th>Отзыв</th><th>Кто</th><th></th></tr>${reviewRows || '<tr><td colspan="4">Отзывов пока нет</td></tr>'}</table>
        </div>
        <div class="card"><h2>🚦 Общие пробки (по поездкам всех водителей)</h2>
          ${(() => {
            const t = req.app.locals.trafficTable;
            if (!t || !t.total) return '<p>Примеров пока нет — их присылают версии 1.16 и новее.</p>';
            const cell = (v, n) => v == null ? `<span style="color:#a0aec0;">— (${n})</span>` : `<b>×${v.toFixed(2)}</b> <span style="color:#718096;font-size:12px;">(${n})</span>`;
            const rows = Array.from({ length: 24 }, (_, h) => `<tr><td>${h}:00</td><td>${cell(t.wd[h], t.n_wd[h])}</td><td>${cell(t.we[h], t.n_we[h])}</td></tr>`).join('');
            return `<p style="font-size:13px;color:#4a5568;">Во сколько раз поездка дольше, чем по пустым дорогам. В скобках — сколько поездок (этот час ±1, за 60 дней). Нужно минимум 3. Всего примеров: <b>${t.total}</b>.</p>
              <table><tr><th>Час</th><th>Будни</th><th>Выходные</th></tr>${rows}</table>`;
          })()}
        </div>
        <div class="card"><h2>📍 Места водителей (последние 50)</h2>
          <table><tr><th>Тип</th><th>Название и заметка</th><th>Где</th><th>👍/👎</th><th></th></tr>${placeRows || '<tr><td colspan="5">Мест пока нет</td></tr>'}</table>
        </div>
        <div class="card"><h2>🗺 Метки на дороге (активные: ${reports.length})</h2>
          <table><tr><th>Тип</th><th>Где</th><th>Поставлена</th><th>До</th><th>Кто</th><th></th></tr>${reportRows || '<tr><td colspan="6">Нет активных меток</td></tr>'}</table>
        </div>
        <div class="card"><h2>💬 Чат (последние 100)</h2>
          <table><tr><th>Время</th><th>Кто</th><th>Сообщение</th><th></th></tr>${chatRows || '<tr><td colspan="4">Сообщений пока нет</td></tr>'}</table>
        </div>
      </body></html>`);
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка загрузки');
    }
  });

  app.post('/admin/community/chat', async (req, res) => {
    const { id, device_id, action } = req.body;
    try {
      if (action === 'delete') await pool.query('UPDATE chat_messages SET deleted = true WHERE id = $1', [parseInt(id, 10)]);
      if (action === 'mute') await pool.query('UPDATE chat_users SET muted = true WHERE device_id = $1', [device_id]);
      if (action === 'unmute') await pool.query('UPDATE chat_users SET muted = false WHERE device_id = $1', [device_id]);
      if (action === 'admin') await pool.query('UPDATE chat_users SET is_admin = true, muted = false WHERE device_id = $1', [device_id]);
      if (action === 'unadmin') await pool.query('UPDATE chat_users SET is_admin = false WHERE device_id = $1', [device_id]);
    } catch (err) {
      console.error(err);
    }
    res.redirect('/admin/community');
  });

  app.post('/admin/community/address', async (req, res) => {
    const { action } = req.body;
    const q = cleanText(req.body.q, 300);
    let msg = '';
    try {
      if (!q) {
        msg = 'Нужен адрес';
      } else if (action === 'set') {
        const m = String(req.body.point || '').match(/(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)/);
        let lat = m ? Number(m[1]) : NaN, lon = m ? Number(m[2]) : NaN;
        // Скопировали «долгота, широта» (как в ссылках Яндекса) — переставим.
        if (lat < 40 && lon > 40) [lat, lon] = [lon, lat];
        if (!(lat > 45 && lat < 49 && lon > 26 && lon < 31)) {
          msg = 'Координаты не похожи на Молдову. Пример: 47.0105, 28.8638';
        } else {
          await geocoder.setAdminPoint(q, lat, lon);
          msg = 'Точка сохранена: ' + q;
        }
      } else if (action === 'remove') {
        await geocoder.removePoint(q);
        msg = 'Точка удалена';
      } else if (action === 'dismiss') {
        await geocoder.dismissMiss(q);
      }
    } catch (err) {
      console.error(err);
      msg = 'Ошибка';
    }
    res.redirect('/admin/community' + (msg ? '?msg=' + encodeURIComponent(msg) : ''));
  });

  app.post('/admin/community/review', async (req, res) => {
    try {
      await pool.query('DELETE FROM client_reviews WHERE phone_hash = $1 AND device_id = $2', [req.body.phone_hash, req.body.device_id]);
    } catch (err) {
      console.error(err);
    }
    res.redirect('/admin/community?msg=' + encodeURIComponent('Отзыв удалён'));
  });

  app.post('/admin/community/place', async (req, res) => {
    try {
      await pool.query('UPDATE places SET hidden = true WHERE id = $1', [parseInt(req.body.id, 10)]);
    } catch (err) {
      console.error(err);
    }
    res.redirect('/admin/community?msg=' + encodeURIComponent('Место удалено'));
  });

  app.post('/admin/community/report', async (req, res) => {
    try {
      await pool.query('UPDATE road_reports SET expires = NOW() WHERE id = $1', [parseInt(req.body.id, 10)]);
    } catch (err) {
      console.error(err);
    }
    res.redirect('/admin/community');
  });

  app.post('/admin/community/client', async (req, res) => {
    const { action } = req.body;
    let msg = '';
    try {
      if (action === 'clear_device') {
        const r = await pool.query('DELETE FROM client_tags WHERE device_id = $1', [req.body.device_id]);
        const rv = await pool.query('DELETE FROM client_reviews WHERE device_id = $1', [req.body.device_id]);
        msg = `Удалено отметок: ${r.rowCount}, отзывов: ${rv.rowCount}`;
      } else {
        const local = String(req.body.phone || '').replace(/[^\d+]/g, '');
        // Как в приложении: местный номер 0XXXXXXXX — молдавский.
        const phone = cleanPhone(/^0\d{8}$/.test(local) ? '+373' + local.slice(1) : local);
        if (!phone) {
          msg = 'Неверный номер';
        } else if (action === 'tag') {
          if (!CLIENT_TAGS[req.body.tag]) {
            msg = 'Неизвестная метка';
          } else {
            await pool.query(
              `INSERT INTO client_tags (phone_hash, device_id, tag) VALUES ($1, 'admin', $2)
               ON CONFLICT (phone_hash, device_id, tag) DO UPDATE SET created = NOW()`,
              [phoneHash(phone), req.body.tag]
            );
            msg = `Добавлено: ${CLIENT_TAGS[req.body.tag].label}`;
          }
        } else if (action === 'clear') {
          const r = await pool.query('DELETE FROM client_tags WHERE phone_hash = $1', [phoneHash(phone)]);
          const rv = await pool.query('DELETE FROM client_reviews WHERE phone_hash = $1', [phoneHash(phone)]);
          msg = `Удалено отметок: ${r.rowCount}, отзывов: ${rv.rowCount}`;
        } else {
          const rows = (await pool.query(
            'SELECT tag, COUNT(DISTINCT device_id) AS n FROM client_tags WHERE phone_hash = $1 GROUP BY tag',
            [phoneHash(phone)]
          )).rows;
          msg = rows.length
            ? rows.map(r => `${(CLIENT_TAGS[r.tag] || {}).label || r.tag}: ${r.n}`).join(', ')
            : 'Отметок нет';
          const rv = (await pool.query('SELECT text FROM client_reviews WHERE phone_hash = $1 ORDER BY created DESC', [phoneHash(phone)])).rows;
          if (rv.length) msg += ' · Отзывы: ' + rv.map(r => `«${r.text}»`).join(' ');
        }
      }
    } catch (err) {
      console.error(err);
      msg = 'Ошибка';
    }
    res.redirect('/admin/community?msg=' + encodeURIComponent(msg));
  });
};
