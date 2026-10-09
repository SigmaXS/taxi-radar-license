// Недельная сводка админу: по понедельникам в 9:00 (Кишинёв) — в Telegram,
// если в Railway заданы TELEGRAM_BOT_TOKEN и TELEGRAM_ADMIN_CHAT_ID. Ту же сводку
// видно в админке на вкладке «📊 Сводка» в любой момент.
const { adminNav } = require('./admin_nav');

module.exports = function setupWeekly(app, pool, { escapeHtml, latestVersion }) {
  pool.query(`CREATE TABLE IF NOT EXISTS admin_kv (k VARCHAR(40) PRIMARY KEY, v TEXT NOT NULL)`).catch(() => {});

  const one = async (sql, args = []) => (await pool.query(sql, args).catch(() => ({ rows: [{}] }))).rows[0] || {};
  const num = v => v == null ? null : Number(v);

  async function build() {
    const dev = await one(`SELECT
        COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'banned' AND expires > NOW()) AS active,
        COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '7 days') AS week_seen,
        COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '1 day') AS day_seen,
        COUNT(*) FILTER (WHERE expires BETWEEN NOW() AND NOW() + INTERVAL '3 days') AS ending
      FROM devices`);
    const versions = (await pool.query(`SELECT device_info FROM devices WHERE expires > NOW() AND status IS DISTINCT FROM 'banned'`).catch(() => ({ rows: [] }))).rows;
    const latest = latestVersion();
    const lm = String(latest.name).match(/(\d+)\.(\d+)/);
    const latestNum = lm ? Number(lm[1]) * 100 + Number(lm[2]) : 0;
    const outdated = versions.filter(d => { const m = (d.device_info || '').match(/v(\d+)\.(\d+)/); return m && Number(m[1]) * 100 + Number(m[2]) < latestNum; }).length;
    const trips = await one(`SELECT COUNT(*) AS n,
        AVG(ABS(real_price - est_price)) FILTER (WHERE created > NOW() - INTERVAL '7 days') AS err_now,
        AVG(ABS(real_price - est_price)) FILTER (WHERE created <= NOW() - INTERVAL '7 days') AS err_before
      FROM trip_reports WHERE real_price IS NOT NULL AND note IS NULL AND created > NOW() - INTERVAL '14 days'`);
    const weekTrips = await one(`SELECT COUNT(*) AS n FROM trip_reports WHERE created > NOW() - INTERVAL '7 days'`);
    const disputes = await one(`SELECT COUNT(*) AS n FROM trip_reports WHERE disputed IS NOT NULL AND NOT dispute_done`);
    const crashes = await one(`SELECT COUNT(*) FILTER (WHERE first_seen > NOW() - INTERVAL '7 days') AS new, COALESCE(SUM(n), 0) AS total FROM crash_reports WHERE last_seen > NOW() - INTERVAL '7 days'`);
    const misses = await one(`SELECT COUNT(*) AS n FROM address_misses WHERE last_seen > NOW() - INTERVAL '7 days'`);
    const chat = await one(`SELECT COUNT(*) AS n FROM chat_messages WHERE created > NOW() - INTERVAL '7 days'`);

    const lei = v => v == null ? '—' : `${Math.round(v)} L`;
    const errNow = num(trips.err_now), errBefore = num(trips.err_before);
    const trend = errNow != null && errBefore != null ? (errNow < errBefore - 0.5 ? ' (лучше, чем неделю назад 👍)' : errNow > errBefore + 0.5 ? ' (хуже, чем неделю назад)' : ' (как неделю назад)') : '';
    const lines = [
      `📊 Taxi Radar — неделя`,
      ``,
      `👥 Активных подписок: ${num(dev.active) ?? 0}; заходили за неделю: ${num(dev.week_seen) ?? 0}, за сутки: ${num(dev.day_seen) ?? 0}`,
      `⏳ Подписка кончается в ближайшие 3 дня: ${num(dev.ending) ?? 0}`,
      `⚠️ На старой версии (ниже ${latest.name}): ${outdated}`,
      `🚕 Поездок за неделю: ${num(weekTrips.n) ?? 0}; средняя ошибка цены: ${lei(errNow)}${trend}`,
      `🙋 «Цена неверная» ждут разбора: ${num(disputes.n) ?? 0}`,
      `🐞 Ошибки приложения: новых ${num(crashes.new) ?? 0}, падений за неделю ${num(crashes.total) ?? 0}`,
      `📍 Ненайденных адресов за неделю: ${num(misses.n) ?? 0}`,
      `💬 Сообщений в чате: ${num(chat.n) ?? 0}`
    ];
    const todo = [];
    if (num(disputes.n) > 0) todo.push('разобрать «Цена неверная» (вкладка «Поездки»)');
    if (num(crashes.new) > 0) todo.push('посмотреть новые ошибки (вкладка «Ошибки»)');
    if (outdated > 0) todo.push('напомнить старым версиям обновиться (вкладка «Сообщения»)');
    if (num(misses.n) > 0) todo.push('проверить ненайденные адреса («Сообщество»)');
    if (todo.length) lines.push('', 'Что сделать: ' + todo.join('; ') + '.');
    return lines.join('\n');
  }

  const telegramReady = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID);
  async function send(text) {
    if (!telegramReady()) return false;
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    }).catch(() => null);
    return !!(r && r.ok);
  }

  // Каждый час: понедельник, 9-й час по Кишинёву, на этой неделе ещё не отправляли — отправить.
  async function tick() {
    if (!telegramReady()) return;
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Chisinau' }));
    if (now.getDay() !== 1 || now.getHours() !== 9) return;
    const week = now.toISOString().slice(0, 10);
    const last = await one(`SELECT v FROM admin_kv WHERE k = 'weekly_sent'`);
    if (last.v === week) return;
    if (await send(await build())) {
      await pool.query(`INSERT INTO admin_kv (k, v) VALUES ('weekly_sent', $1) ON CONFLICT (k) DO UPDATE SET v = $1`, [week]);
    }
  }
  setInterval(() => tick().catch(e => console.error('weekly:', e.message)), 3600e3).unref();
  setTimeout(() => tick().catch(() => {}), 90e3).unref();

  app.get('/admin/weekly', async (req, res) => {
    const text = await build();
    res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Сводка — Taxi Radar</title>
      <style>body{font-family:sans-serif;background:#f0f2f5;padding:25px;margin:0}.card{background:#fff;border-radius:10px;padding:20px;max-width:1150px;margin:0 auto 20px;box-shadow:0 4px 12px rgba(0,0,0,.06)}
      pre{white-space:pre-wrap;font-size:16px;line-height:1.5;font-family:inherit}button{border:0;padding:12px 18px;border-radius:8px;background:#2b6cb0;color:#fff;font-weight:bold;cursor:pointer;font-size:15px}</style></head><body>
      ${adminNav('/admin/weekly')}
      <div class="card">${req.query.msg ? `<p style="background:#ebf8ff;padding:10px;border-radius:6px;">${escapeHtml(req.query.msg)}</p>` : ''}
        <pre>${escapeHtml(text)}</pre>
        ${telegramReady()
          ? `<form method="POST" action="/admin/weekly"><button>Отправить мне в Telegram сейчас</button></form>
             <p style="font-size:13px;color:#4a5568;">Сама приходит по понедельникам в 9:00.</p>`
          : `<p style="font-size:14px;color:#4a5568;">Чтобы сводка приходила в Telegram по понедельникам в 9:00, добавьте в Railway две переменные:
             <b>TELEGRAM_BOT_TOKEN</b> — токен бота от @BotFather и <b>TELEGRAM_ADMIN_CHAT_ID</b> — ваш chat id (его покажет бот @userinfobot).
             Сначала напишите своему боту любое сообщение, иначе он не сможет вам писать.</p>`}
      </div></body></html>`);
  });

  app.post('/admin/weekly', async (req, res) => {
    const ok = await send(await build());
    res.redirect('/admin/weekly?msg=' + encodeURIComponent(ok ? 'Отправлено в Telegram' : 'Не отправилось — проверьте TELEGRAM_BOT_TOKEN и TELEGRAM_ADMIN_CHAT_ID и что вы написали боту'));
  });
};
