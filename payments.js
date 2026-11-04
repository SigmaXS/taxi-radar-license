// Оплата подписки переводом MIA: водитель переводит деньги на номер продавца и жмёт
// «Я оплатил» — сюда приходит заявка, админу в Telegram уходит сообщение с номером
// водителя и кнопками «✓ Пришло» / «✗ Не пришло». «Пришло» продлевает подписку этому
// телефону сразу — ключ не нужен.
// Переменные Railway: MIA_PHONE (номер для перевода, по умолчанию CONTACT_PHONE), MIA_NAME
// (имя получателя — водитель сверит его в банке), TELEGRAM_BOT_TOKEN и TELEGRAM_PAY_CHAT_ID
// (канал или чат для заявок; по умолчанию TELEGRAM_ADMIN_CHAT_ID).
// Ссылки кнопок подписаны (HMAC от ADMIN_PASSWORD) — открываются без входа в админку.
const crypto = require('crypto');
const { adminNav } = require('./admin_nav');

module.exports = function registerPayments(app, pool, { isValidDeviceId, escapeHtml, parseTariffs, rewardReferrer }) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS pay_claims (
      id BIGSERIAL PRIMARY KEY,
      device_id VARCHAR(100) NOT NULL,
      days INT NOT NULL,
      price INT NOT NULL,
      phone VARCHAR(20) NOT NULL,
      promo VARCHAR(30),
      device_info VARCHAR(150),
      product VARCHAR(20) NOT NULL DEFAULT 'radar',
      status VARCHAR(12) NOT NULL DEFAULT 'new',
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      decided TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS pay_claims_device ON pay_claims (device_id, created);
  `).catch(err => console.error('pay_claims init error:', err));

  const miaPhone = () => process.env.MIA_PHONE || process.env.CONTACT_PHONE || '+37378293919';
  const chatId = () => process.env.TELEGRAM_PAY_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID;
  const secret = () => process.env.PAY_SECRET || process.env.ADMIN_PASSWORD || '';
  const sign = (id, action) => crypto.createHmac('sha256', secret()).update(`pay:${id}:${action}`).digest('hex').slice(0, 32);
  const validSig = (id, action, sig) => {
    if (!secret() || typeof sig !== 'string' || sig.length !== 32) return false;
    return crypto.timingSafeEqual(Buffer.from(sign(id, action)), Buffer.from(sig));
  };
  const fmt = d => new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  async function telegram(method, body) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !chatId()) return null;
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId(), ...body })
      });
      return r.ok ? r.json() : null;
    } catch (e) {
      console.error('Telegram pay error:', e.message);
      return null;
    }
  }

  // Номер и сумма для перевода — в /api/app-config.
  function configFields() {
    return { mia_phone: miaPhone(), mia_name: process.env.MIA_NAME || '' };
  }

  // «Я оплатил». Подписка не нужна: оплачивают как раз те, у кого она кончилась.
  const recent = new Map();
  app.post('/api/pay/claim', async (req, res) => {
    const b = req.body || {};
    if (!isValidDeviceId(b.device_id)) return res.status(400).json({ ok: false, message: 'Нет ID' });
    const phone = String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 16);
    if (phone.replace(/\D/g, '').length < 8) return res.json({ ok: false, message: 'Укажите свой номер телефона' });
    const product = ['cancel', 'both'].includes(b.product) ? b.product : 'radar';
    const tariff = product !== 'radar'
      ? { days: 30, price: Number(process.env.CANCEL_PRICE || 999) }
      : parseTariffs().find(t => t.days === parseInt(b.days, 10));
    if (!tariff) return res.json({ ok: false, message: 'Тариф не найден, обновите экран' });
    // Не чаще раза в 2 минуты с одного телефона (двойное нажатие, повторы).
    const last = recent.get(b.device_id) || 0;
    if (Date.now() - last < 2 * 60 * 1000) return res.json({ ok: true, repeated: true });
    recent.set(b.device_id, Date.now());
    try {
      const today = await pool.query(`SELECT COUNT(*) AS n FROM pay_claims WHERE device_id = $1 AND created > NOW() - INTERVAL '1 day'`, [b.device_id]);
      if (Number(today.rows[0].n) >= 5) return res.json({ ok: false, message: 'Слишком много заявок за сутки — напишите нам в Telegram' });
      const promo = String(b.promo || '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 30) || null;
      const info = typeof b.device_info === 'string' ? b.device_info.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 150) : null;
      const r = await pool.query(
        'INSERT INTO pay_claims (device_id, days, price, phone, promo, device_info, product) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created',
        [b.device_id, tariff.days, tariff.price, phone, promo, info, product]
      );
      const id = Number(r.rows[0].id);
      const dev = (await pool.query('SELECT expires, status FROM devices WHERE device_id = $1', [b.device_id])).rows[0];
      const base = 'https://' + req.get('host');
      const text = [
        `💰 Оплата подписки №${id}`,
        `${tariff.price} ${process.env.CURRENCY || 'лей'} · ${tariff.days} дн. — проверьте перевод MIA`,
        `📞 ${phone}`,
        promo ? `Промокод: ${promo}` : null,
        info ? `📱 ${info}` : null,
        `ID: ${b.device_id}`,
        dev ? `Сейчас: ${new Date(dev.expires) > new Date() ? 'активна до ' + fmt(dev.expires) : 'истекла'}` : 'Сейчас: новое устройство'
      ].filter(Boolean).join('\n');
      const sent = await telegram('sendMessage', {
        text,
        reply_markup: { inline_keyboard: [[
          { text: '✓ Пришло — продлить', url: `${base}/pay/ok/${id}/${sign(id, 'ok')}` },
          { text: '✗ Не пришло', url: `${base}/pay/no/${id}/${sign(id, 'no')}` }
        ]] }
      });
      res.json({ ok: true, id, notified: !!sent });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, message: 'Ошибка сервера' });
    }
  });

  // Статус последней заявки — экран «Подписка» показывает «ждём подтверждения».
  app.post('/api/pay/status', async (req, res) => {
    if (!isValidDeviceId(req.body && req.body.device_id)) return res.status(400).json({ ok: false });
    const r = await pool.query(
      `SELECT id, status, created FROM pay_claims WHERE device_id = $1 AND created > NOW() - INTERVAL '2 days' ORDER BY created DESC LIMIT 1`,
      [req.body.device_id]
    ).catch(() => null);
    const c = r && r.rows[0];
    res.json({ ok: true, claim: c ? { id: Number(c.id), status: c.status, created: new Date(c.created).toISOString() } : null });
  });

  async function extend(claim) {
    if (claim.product === 'both') {
      const r = await pool.query(
        `INSERT INTO devices (device_id, expires, cancel_expires, last_seen, status, type)
         VALUES ($1, NOW() + ($2 || ' days')::INTERVAL, NOW() + ($2 || ' days')::INTERVAL, NOW(), 'active', $3)
         ON CONFLICT (device_id) DO UPDATE SET
           expires = CASE WHEN devices.status <> 'disabled' AND devices.expires > NOW() THEN devices.expires ELSE NOW() END + ($2 || ' days')::INTERVAL,
           cancel_expires = CASE WHEN devices.cancel_expires > NOW() THEN devices.cancel_expires ELSE NOW() END + ($2 || ' days')::INTERVAL,
           status = CASE WHEN devices.status = 'banned' THEN devices.status ELSE 'active' END,
           last_seen = NOW()
         RETURNING expires, status`,
        [claim.device_id, String(claim.days), `MIA ${claim.price} L, Радар + Отмена ${claim.days} дн.`]
      );
      try { await rewardReferrer(claim.device_id); } catch (e) { console.error('Referral reward error:', e); }
      return r.rows[0];
    }
    if (claim.product === 'cancel') {
      const r = await pool.query(
        `INSERT INTO devices (device_id, cancel_expires, last_seen, status, type)
         VALUES ($1, NOW() + ($2 || ' days')::INTERVAL, NOW(), 'active', $3)
         ON CONFLICT (device_id) DO UPDATE SET
           cancel_expires = CASE WHEN devices.cancel_expires > NOW() THEN devices.cancel_expires ELSE NOW() END + ($2 || ' days')::INTERVAL,
           last_seen = NOW()
         RETURNING cancel_expires AS expires, status`,
        [claim.device_id, String(claim.days), `MIA ${claim.price} L, Отмена ${claim.days} дн.`]
      );
      return r.rows[0];
    }
    const r = await pool.query(
      `INSERT INTO devices (device_id, key_code, expires, last_seen, status, type)
       VALUES ($1, NULL, NOW() + ($2 || ' days')::INTERVAL, NOW(), 'active', $3)
       ON CONFLICT (device_id) DO UPDATE SET
         expires = CASE WHEN devices.status <> 'disabled' AND devices.expires > NOW() THEN devices.expires ELSE NOW() END + ($2 || ' days')::INTERVAL,
         status = CASE WHEN devices.status = 'banned' THEN devices.status ELSE 'active' END,
         type = $3
       RETURNING expires, status`,
      [claim.device_id, String(claim.days), `MIA ${claim.price} L, ${claim.days} дн. (${fmt(new Date()).slice(0, 5)})`]
    );
    try { await rewardReferrer(claim.device_id); } catch (e) { console.error('Referral reward error:', e); }
    return r.rows[0];
  }

  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:480px;margin:24px auto;padding:0 16px;color:#1a202c}
    .card{border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:12px 0;line-height:1.6}
    button{width:100%;padding:16px;font-size:18px;border:none;border-radius:10px;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;

  // Кнопка из Telegram открывает страницу с заявкой; подтверждение — отдельной кнопкой (POST),
  // чтобы случайное открытие ссылки ничего не меняло.
  async function show(req, res) {
    const { id, sig, action } = req.params;
    const num = parseInt(id, 10);
    if (!['ok', 'no'].includes(action) || !Number.isSafeInteger(num) || !validSig(num, action, sig)) return res.status(403).send('Ссылка недействительна');
    const c = (await pool.query('SELECT * FROM pay_claims WHERE id = $1', [num])).rows[0];
    if (!c) return res.status(404).send('Заявка не найдена');
    const info = `<div class="card"><b>Заявка №${num}</b><br>${c.price} лей · ${c.days} дн.<br>📞 <a href="tel:${escapeHtml(c.phone)}">${escapeHtml(c.phone)}</a><br>
      ${c.promo ? 'Промокод: ' + escapeHtml(c.promo) + '<br>' : ''}${c.device_info ? escapeHtml(c.device_info) + '<br>' : ''}ID: ${escapeHtml(c.device_id)}<br>${fmt(c.created)}</div>`;
    if (c.status !== 'new') {
      return res.send(page('Оплата', `${info}<p>Уже решено: <b>${c.status === 'ok' ? '✓ подписка продлена' : '✗ отклонено'}</b> (${fmt(c.decided)}).</p>`));
    }
    if (req.method === 'GET') {
      const btn = action === 'ok'
        ? `<button style="background:#38a169">✓ Деньги пришли — продлить на ${c.days} дн.</button>`
        : '<button style="background:#e53e3e">✗ Деньги не пришли — отклонить</button>';
      return res.send(page('Оплата', `${info}<form method="POST">${btn}</form>`));
    }
    // Решение принимается один раз, даже если нажали дважды.
    const upd = await pool.query(`UPDATE pay_claims SET status = $1, decided = NOW() WHERE id = $2 AND status = 'new' RETURNING *`, [action, num]);
    if (!upd.rows.length) return res.redirect(req.originalUrl);
    let result;
    if (action === 'ok') {
      const d = await extend(upd.rows[0]);
      result = d.status === 'banned' ? '⚠️ Отмечено как оплачено, но устройство в бане — срок продлён, бан не снят.' : `✓ Подписка продлена до ${fmt(d.expires)}`;
    } else result = '✗ Заявка отклонена. Водитель увидит «оплата не найдена».';
    telegram('sendMessage', { text: `Заявка №${num}: ${result}` });
    res.send(page('Оплата', `${info}<p><b>${escapeHtml(result)}</b></p>`));
  }
  app.get('/pay/:action/:id/:sig', show);
  app.post('/pay/:action/:id/:sig', show);

  // Список заявок в админке — если Telegram не настроен или сообщение потерялось.
  app.get('/admin/payments', async (req, res) => {
    const rows = (await pool.query('SELECT * FROM pay_claims ORDER BY created DESC LIMIT 100')).rows;
    const st = s => s === 'ok' ? '✓ продлено' : s === 'no' ? '✗ отклонено' : '⏳ ждёт';
    res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Оплаты</title>
      <style>body{font-family:system-ui,sans-serif;margin:25px}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #edf2f7;font-size:14px;text-align:left;vertical-align:top}th{background:#2b6cb0;color:#fff}</style></head><body>${adminNav('/admin/payments')}
      <h2>Оплаты MIA</h2>
      <p style="color:#4a5568;font-size:14px;">Номер для перевода: <b>${escapeHtml(miaPhone())}</b>${process.env.MIA_NAME ? ' · ' + escapeHtml(process.env.MIA_NAME) : ''}.
      ${process.env.TELEGRAM_BOT_TOKEN && chatId() ? 'Заявки приходят в Telegram.' : 'Чтобы заявки приходили в Telegram, задайте TELEGRAM_BOT_TOKEN и TELEGRAM_PAY_CHAT_ID (или TELEGRAM_ADMIN_CHAT_ID).'}</p>
      <table><tr><th>№</th><th>Когда</th><th>Сумма</th><th>Телефон</th><th>ID</th><th>Статус</th></tr>
      ${rows.map(c => `<tr><td>${c.id}</td><td>${fmt(c.created)}</td><td>${c.price} L · ${c.days} дн.${c.promo ? '<br>промо ' + escapeHtml(c.promo) : ''}</td>
        <td><a href="tel:${escapeHtml(c.phone)}">${escapeHtml(c.phone)}</a></td><td style="font-size:12px">${escapeHtml(c.device_id)}<br>${escapeHtml(c.device_info || '')}</td>
        <td>${st(c.status)}${c.status === 'new' ? `<br><a href="/pay/ok/${c.id}/${sign(Number(c.id), 'ok')}">✓ пришло</a> · <a href="/pay/no/${c.id}/${sign(Number(c.id), 'no')}">✗ нет</a>` : ''}</td></tr>`).join('')}
      </table></body></html>`);
  });

  return { configFields };
};
