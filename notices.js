// Ошибки приложения и сообщения водителям.
//  • /api/crash — приложение упало: при следующем запуске присылает, где и на каком телефоне.
//    Одинаковые падения склеиваются (по месту в коде), в /admin/crashes видно, сколько раз.
//  • /admin/messages — сообщение всем водителям: баннер на главной приложения (с 1.17).
//    Можно показать только тем, у кого версия старее — «обновитесь».
const crypto = require('crypto');

module.exports = function setupNotices(app, pool, { isValidDeviceId, escapeHtml }) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS crash_reports (
      sig CHAR(40) PRIMARY KEY,
      version VARCHAR(20) NOT NULL DEFAULT '',
      model VARCHAR(80) NOT NULL DEFAULT '',
      android VARCHAR(10) NOT NULL DEFAULT '',
      title VARCHAR(300) NOT NULL DEFAULT '',
      stack TEXT NOT NULL DEFAULT '',
      n INT NOT NULL DEFAULT 1,
      devices INT NOT NULL DEFAULT 1,
      last_device VARCHAR(100),
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      text VARCHAR(600) NOT NULL,
      below_version INT,
      until TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT true,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).then(refresh).catch(e => console.error('notices init error:', e));

  let current = null; // действующее сообщение — в app-config без запроса к базе
  async function refresh() {
    const r = await pool.query(
      'SELECT id, text, below_version FROM announcements WHERE active AND (until IS NULL OR until > NOW()) ORDER BY id DESC LIMIT 1');
    current = r.rows[0] || null;
  }
  setInterval(() => refresh().catch(() => {}), 10 * 60 * 1000);

  // Не больше 20 отчётов в час с одного адреса — падение в цикле не завалит базу.
  const hits = new Map();
  function tooMany(ip) {
    const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
    list.push(now); hits.set(ip, list);
    if (hits.size > 5000) hits.clear();
    return list.length > 20;
  }

  app.post('/api/crash', async (req, res) => {
    try {
      if (tooMany(req.ip)) return res.json({ ok: false });
      const b = req.body || {};
      const deviceId = String(b.device_id || '');
      const stack = String(b.stack || '').slice(0, 6000);
      if (!stack || (deviceId && !isValidDeviceId(deviceId))) return res.json({ ok: false });
      // Место падения — первые строки стека без номеров строк и текста ошибки: одна ошибка = одна строка.
      const where = stack.split('\n').filter(l => l.trim().startsWith('at ')).slice(0, 4).join('\n').replace(/:\d+\)/g, ')');
      const title = stack.split('\n')[0].slice(0, 300);
      const sig = crypto.createHash('sha1').update(title.split(':')[0] + '\n' + where).digest('hex');
      await pool.query(
        `INSERT INTO crash_reports (sig, version, model, android, title, stack, last_device) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (sig) DO UPDATE SET n = crash_reports.n + 1, last_seen = NOW(), version = $2, model = $3, android = $4,
           title = $5, stack = $6,
           devices = crash_reports.devices + (CASE WHEN crash_reports.last_device IS DISTINCT FROM $7 THEN 1 ELSE 0 END),
           last_device = $7`,
        [sig, String(b.version || '').slice(0, 20), String(b.model || '').slice(0, 80), String(b.android || '').slice(0, 10),
          title, stack, deviceId || null]);
      res.json({ ok: true });
    } catch (e) {
      console.error('crash report:', e);
      res.json({ ok: false });
    }
  });

  const page = (title, body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{font-family:sans-serif;background:#f0f2f5;padding:20px;margin:0}.card{background:#fff;border-radius:10px;padding:18px;max-width:1150px;margin:0 auto 18px;box-shadow:0 4px 12px rgba(0,0,0,.06)}
table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #edf2f7;font-size:14px;text-align:left;vertical-align:top}th{background:#2b6cb0;color:#fff}
pre{white-space:pre-wrap;font-size:12px;background:#f7fafc;padding:8px;border-radius:6px;max-height:300px;overflow:auto}
textarea,input,select{padding:8px;font-size:15px;border:1px solid #cbd5e0;border-radius:6px}button{border:0;padding:8px 14px;border-radius:6px;color:#fff;cursor:pointer;font-weight:bold}
</style></head><body><div class="card"><a href="/admin/view-devices">← Устройства</a> · <a href="/admin/community">Сообщество</a></div>${body}</body></html>`;
  const fmt = d => new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau' });

  app.get('/admin/crashes', async (req, res) => {
    const rows = (await pool.query('SELECT * FROM crash_reports ORDER BY last_seen DESC LIMIT 100')).rows;
    const list = rows.map(c => `<tr>
      <td style="white-space:nowrap">${escapeHtml(fmt(c.last_seen))}</td>
      <td><b>${c.n}</b> раз${c.devices > 1 ? ` · ${c.devices} тел.` : ''}</td>
      <td>v${escapeHtml(c.version)} · ${escapeHtml(c.model)} · Android ${escapeHtml(c.android)}</td>
      <td><details><summary>${escapeHtml(c.title)}</summary><pre>${escapeHtml(c.stack)}</pre></details></td>
      <td><form method="POST" action="/admin/crashes" style="margin:0"><input type="hidden" name="sig" value="${escapeHtml(c.sig)}">
        <button style="background:#38a169">Исправлено</button></form></td></tr>`).join('');
    res.send(page('Ошибки приложения', `<div class="card"><h2>🐞 Ошибки приложения (${rows.length})</h2>
      <p style="font-size:13px;color:#4a5568">Приложение упало — при следующем запуске оно присылает, где именно (с 1.17). Одинаковые ошибки склеены.
      Нажмите на текст ошибки, чтобы увидеть подробности; «Исправлено» — убрать из списка (если повторится, появится снова).</p>
      <table><tr><th>Последний раз</th><th>Сколько</th><th>Версия и телефон</th><th>Ошибка</th><th></th></tr>${list || '<tr><td colspan="5">Ошибок нет 👍</td></tr>'}</table></div>`));
  });

  app.post('/admin/crashes', async (req, res) => {
    await pool.query('DELETE FROM crash_reports WHERE sig = $1', [String(req.body.sig || '')]);
    res.redirect('/admin/crashes');
  });

  app.get('/admin/messages', async (req, res) => {
    const rows = (await pool.query('SELECT * FROM announcements ORDER BY id DESC LIMIT 20')).rows;
    const latest = req.app.locals.latestVersion ? req.app.locals.latestVersion() : null;
    const list = rows.map(a => {
      const live = a.active && (!a.until || new Date(a.until) > new Date());
      return `<tr style="${live ? '' : 'opacity:.45'}"><td style="white-space:nowrap">${escapeHtml(fmt(a.created))}</td>
        <td>${escapeHtml(a.text)}</td><td>${a.below_version ? `версии ниже ${a.below_version}` : 'всем'}</td>
        <td>${a.until ? escapeHtml(fmt(a.until)) : 'пока не снимете'}</td>
        <td>${live ? `<form method="POST" action="/admin/messages" style="margin:0"><input type="hidden" name="off" value="${a.id}"><button style="background:#e53e3e">Снять</button></form>` : 'снято'}</td></tr>`;
    }).join('');
    res.send(page('Сообщение водителям', `<div class="card"><h2>📣 Сообщение водителям</h2>
      <p style="font-size:13px;color:#4a5568">Покажется баннером на главной экране приложения (версии 1.17 и новее), водитель может его закрыть.
      Одновременно действует одно — новое заменяет старое.</p>
      <form method="POST" action="/admin/messages">
        <textarea name="text" rows="4" maxlength="600" style="width:100%;box-sizing:border-box" placeholder="Например: Сегодня в аэропорту много рейсов с 18:00" required></textarea>
        <p>Кому: <select name="below"><option value="">всем водителям</option>
          ${latest ? `<option value="${latest.code}">только у кого версия старее ${escapeHtml(latest.name)}</option>` : ''}</select>
        &nbsp; Показывать: <select name="days"><option value="1">1 день</option><option value="3">3 дня</option><option value="7" selected>7 дней</option><option value="">пока не сниму</option></select></p>
        <button style="background:#2b6cb0">Отправить водителям</button></form></div>
      <div class="card"><h3>Отправленные</h3><table><tr><th>Когда</th><th>Текст</th><th>Кому</th><th>До</th><th></th></tr>${list || '<tr><td colspan="5">Пока нет</td></tr>'}</table></div>`));
  });

  app.post('/admin/messages', async (req, res) => {
    if (req.body.off) {
      await pool.query('UPDATE announcements SET active = false WHERE id = $1', [parseInt(req.body.off, 10) || 0]);
    } else {
      const text = String(req.body.text || '').trim().slice(0, 600);
      const below = parseInt(req.body.below, 10) || null;
      const days = parseInt(req.body.days, 10) || null;
      if (text) {
        await pool.query('UPDATE announcements SET active = false WHERE active');
        await pool.query(`INSERT INTO announcements (text, below_version, until) VALUES ($1, $2, ${days ? `NOW() + ($3 || ' days')::INTERVAL` : '$3::timestamptz'})`,
          [text, below, days ? String(days) : null]);
      }
    }
    await refresh();
    res.redirect('/admin/messages');
  });

  /** Для /api/app-config. */
  return {
    configFields: () => current ? { announcement: { id: current.id, text: current.text, below_version: current.below_version || 0 } } : {}
  };
};
