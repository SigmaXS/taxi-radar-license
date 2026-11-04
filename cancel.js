// «Отмена» — отдельный продукт внутри Taxi Radar: свой пробный период,
// свои ключи и своя подписка. Радар и отмена не мешают друг другу.
//
// Таблицы: app_keys.product ('radar' | 'cancel'), devices.cancel_key,
// devices.cancel_expires, devices.cancel_trial_at, devices.cancel_banned.

const guard = require('./guard');
const signing = require('./signing');

const TRIAL_HOURS = 24;

module.exports = function registerCancel(app, pool, { isValidDeviceId, escapeHtml, generateCode, adminNav }) {
  pool.query(`
    ALTER TABLE app_keys ADD COLUMN IF NOT EXISTS product VARCHAR(20) NOT NULL DEFAULT 'radar';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS cancel_key VARCHAR(50);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS cancel_expires TIMESTAMP;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS cancel_trial_at TIMESTAMP;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS cancel_banned BOOLEAN NOT NULL DEFAULT FALSE;
  `).catch(err => console.error('cancel schema error:', err));

  const nowIso = d => (d ? new Date(d).toISOString() : null);

  // Ответ «Отмены» с подписью (см. signing.js): приложение 2.5+ верит active:true только с ней.
  function reply(req, res, deviceId, body) {
    const out = { ...body };
    if (out.active === undefined) out.active = false;
    res.json(signing.signed(req, 'cancel', deviceId, out.active === true, out.expires || '', out));
  }

  async function readStatus(deviceId) {
    const r = await pool.query(
      'SELECT cancel_key, cancel_expires, cancel_trial_at, cancel_banned FROM devices WHERE device_id = $1',
      [deviceId]
    );
    const d = r.rows[0];
    const now = new Date();
    const banned = !!(d && d.cancel_banned);
    const active = !banned && !!(d && d.cancel_expires && new Date(d.cancel_expires) > now);
    return {
      banned,
      active,
      expires: d ? nowIso(d.cancel_expires) : null,
      hours_left: active ? Math.max(0, Math.round((new Date(d.cancel_expires) - now) / 3600000)) : 0,
      trial_available: !(d && d.cancel_trial_at),
      trial_started: !!(d && d.cancel_trial_at)
    };
  }

  // Статус подписки «Отмена» для устройства.
  app.post('/api/cancel/status', guard.limitIp('cstatus', 600, 3600 * 1000), async (req, res) => {
    const deviceId = req.body && req.body.device_id;
    if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, message: 'Нет ID' });
    try {
      reply(req, res, deviceId, { ok: true, ...(await readStatus(deviceId)) });
    } catch (err) {
      console.error('cancel status error:', err);
      res.status(500).json({ ok: false, message: 'Ошибка базы данных' });
    }
  });

  // Пробный день: ровно один раз на устройство, отсчёт с первого включения.
  app.post('/api/cancel/trial', guard.limitIp('ctrial', 60, 3600 * 1000), async (req, res) => {
    const deviceId = req.body && req.body.device_id;
    if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, message: 'Нет ID' });
    try {
      const cur = await readStatus(deviceId);
      if (cur.banned) return reply(req, res, deviceId, { ok: false, active: false, banned: true, message: 'Устройство заблокировано' });
      if (cur.active) return reply(req, res, deviceId, { ok: true, active: true, already: true, expires: cur.expires, hours_left: cur.hours_left });
      if (!cur.trial_available) return reply(req, res, deviceId, { ok: false, active: false, message: 'Пробный день уже использован' });
      if (guard.tooMany('ctrialnew:' + guard.clientIp(req), parseInt(process.env.TRIAL_PER_IP_DAY || '30', 10), 24 * 3600 * 1000)) {
        return reply(req, res, deviceId, { ok: false, active: false, message: 'С этого подключения уже много новых устройств. Напишите нам.' });
      }

      const expires = new Date(Date.now() + TRIAL_HOURS * 3600 * 1000);
      await pool.query(
        `INSERT INTO devices (device_id, cancel_expires, cancel_trial_at, last_seen, status, type)
         VALUES ($1, $2, NOW(), NOW(), 'active', 'Отмена · тест')
         ON CONFLICT (device_id) DO UPDATE
         SET cancel_expires = $2, cancel_trial_at = NOW(), last_seen = NOW()`,
        [deviceId, expires]
      );
      reply(req, res, deviceId, { ok: true, active: true, expires: expires.toISOString(), hours_left: TRIAL_HOURS });
    } catch (err) {
      console.error('cancel trial error:', err);
      res.status(500).json({ ok: false, message: 'Ошибка базы данных' });
    }
  });

  // Активация ключа «Отмена». Ключ удаляется, срок добавляется к текущему.
  app.post('/api/cancel/activate', guard.limitIp('cactivate', 60, 3600 * 1000), async (req, res) => {
    const deviceId = req.body && req.body.device_id;
    const rawKey = req.body && req.body.key;
    if (!isValidDeviceId(deviceId) || typeof rawKey !== 'string' || !rawKey.trim()) {
      return res.status(400).json({ ok: false, message: 'Введите ключ' });
    }
    const key = rawKey.trim().toUpperCase();
    try {
      if ((await readStatus(deviceId)).banned) {
        return reply(req, res, deviceId, { ok: false, active: false, banned: true, message: 'Устройство заблокировано' });
      }
      // Перебор ключей: 10 неверных на устройство и 60 на IP в час.
      if (guard.isBlocked('cbadkey:' + deviceId, 10, 3600 * 1000) || guard.isBlocked('cbadkeyip:' + guard.clientIp(req), 60, 3600 * 1000)) {
        return reply(req, res, deviceId, { ok: false, active: false, message: 'Слишком много неверных ключей. Подождите час.' });
      }
      const del = await pool.query(
        "DELETE FROM app_keys WHERE key_code = $1 AND product = 'cancel' RETURNING *",
        [key]
      );
      if (!del.rows.length) {
        guard.record('cbadkey:' + deviceId, 3600 * 1000);
        guard.record('cbadkeyip:' + guard.clientIp(req), 3600 * 1000);
        return reply(req, res, deviceId, { ok: false, active: false, message: 'Ключ неверный или уже активирован' });
      }
      const k = del.rows[0];
      const hours = Math.round(Number(k.duration_hours) || 0);
      if (!(hours > 0)) return reply(req, res, deviceId, { ok: false, active: false, message: 'У ключа нет срока' });

      const status = await readStatus(deviceId);
      const from = status.active && status.expires ? new Date(status.expires) : new Date();
      const expires = new Date(from.getTime() + hours * 3600 * 1000);

      await pool.query(
        `INSERT INTO devices (device_id, cancel_key, cancel_expires, last_seen, status, type)
         VALUES ($1, $2, $3, NOW(), 'active', $4)
         ON CONFLICT (device_id) DO UPDATE
         SET cancel_key = $2, cancel_expires = $3, last_seen = NOW()`,
        [deviceId, key, expires, k.type || 'Отмена']
      );
      reply(req, res, deviceId, { ok: true, active: true, expires: expires.toISOString(), hours_left: Math.round(hours), type: k.type || '' });
    } catch (err) {
      console.error('cancel activate error:', err);
      res.status(500).json({ ok: false, message: 'Ошибка базы данных' });
    }
  });

  // ---- админка ----

  const back = msg => '/admin/cancel' + (msg ? '?msg=' + encodeURIComponent(msg) : '');
  const dateLabel = () => new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Chisinau', day: '2-digit', month: '2-digit' });
  const btn = (bg, extra = '') => `style="background:${bg};color:#fff;border:none;padding:5px 9px;border-radius:4px;cursor:pointer;font-weight:bold;${extra}"`;
  const fmt = d => (d ? new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

  app.get('/admin/cancel', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const keys = (await pool.query(
        "SELECT * FROM app_keys WHERE product = 'cancel' ORDER BY created DESC NULLS LAST LIMIT 200"
      )).rows;
      const all = (await pool.query(
        `SELECT device_id, device_info, cancel_key, cancel_expires, cancel_trial_at, cancel_banned
         FROM devices WHERE cancel_expires IS NOT NULL OR cancel_trial_at IS NOT NULL OR cancel_banned
         ORDER BY cancel_expires DESC NULLS LAST`
      )).rows;

      const now = new Date();
      const isActive = s => !s.cancel_banned && s.cancel_expires && new Date(s.cancel_expires) > now;
      const activeN = all.filter(isActive).length;
      const bannedN = all.filter(s => s.cancel_banned).length;
      const trialN = all.filter(s => s.cancel_trial_at).length;
      const expiredN = all.length - activeN - bannedN;

      let subs = all;
      if (q) {
        const ql = q.toLowerCase();
        subs = all.filter(s => [s.device_id, s.device_info, s.cancel_key].some(v => String(v || '').toLowerCase().includes(ql)));
      }
      subs = subs.slice(0, 500);

      const freeKeys = keys.map(k => `
        <div style="background:#f7fafc;padding:8px 12px;margin:5px 0;border-radius:6px;display:flex;justify-content:space-between;align-items:center;border:1px solid #e2e8f0;">
          <div><strong style="color:#2b6cb0;">${escapeHtml(k.key_code)}</strong> <span style="font-size:12px;color:#718096;">(${escapeHtml(k.type || '')}, создан ${fmt(k.created)})</span></div>
          <form method="POST" action="/admin/cancel/delete" style="margin:0;">
            <input type="hidden" name="key_code" value="${escapeHtml(k.key_code)}">
            <button ${btn('#e53e3e', 'padding:4px 8px;font-weight:normal;')}>Удалить</button>
          </form>
        </div>`).join('');

      const rows = subs.map(s => {
        const act = isActive(s);
        const status = s.cancel_banned
          ? '<b style="color:#e53e3e;">🚫 В БАНЕ</b>'
          : act ? '<b style="color:#2f855a;">✅ Активна</b>' : '<span style="color:#718096;">⏳ Истекла</span>';
        const left = act ? `<br><span style="font-size:12px;font-weight:bold;color:#b7791f;">осталось ${Math.max(0, Math.floor((new Date(s.cancel_expires) - now) / 86400000))} дн.</span>` : '';
        return `<tr style="${act ? 'background:#fffff0;' : ''}">
          <td style="white-space:nowrap;">${status}</td>
          <td><div style="font-weight:bold;">${escapeHtml(s.cancel_key || '—')}</div><div style="font-size:12px;color:#718096;">${s.cancel_trial_at ? 'тест ' + fmt(s.cancel_trial_at) : ''}</div></td>
          <td><div style="font-weight:600;">${s.device_info ? escapeHtml(s.device_info) : '<span style="color:#a0aec0;">—</span>'}</div>
            <code style="background:#feebc8;color:#c05621;padding:2px 6px;border-radius:4px;font-size:12px;">${escapeHtml(s.device_id)}</code></td>
          <td>${fmt(s.cancel_expires)}${left}</td>
          <td style="white-space:nowrap;">
            <form method="POST" action="/admin/cancel/action" style="display:inline;">
              <input type="hidden" name="device_id" value="${escapeHtml(s.device_id)}">
              <input type="number" name="days" min="1" max="3650" placeholder="дней" style="width:62px;padding:4px;">
              <button name="action" value="add_days" ${btn('#38a169')}>+ Добавить</button>
              <button name="action" value="sub_days" onclick="return confirm('Убрать указанное число дней?')" ${btn('#c05621')}>− Убрать</button>
              ${act ? `<button name="action" value="disable" onclick="return confirm('Отключить подписку «Отмена» у этого устройства?')" ${btn('#718096', 'font-weight:normal;')}>Отключить</button>` : ''}
              ${s.cancel_banned ? `<button name="action" value="unban" ${btn('#38a169')}>Разбанить</button>` : `<button name="action" value="ban" ${btn('#e53e3e', 'font-weight:normal;')}>В БАН</button>`}
              <button name="action" value="unlink" onclick="return confirm('Стереть данные «Отмены» у этого устройства (радар не затрагивается)?')" ${btn('#dd6b20', 'font-weight:normal;')}>Удалить</button>
            </form>
          </td></tr>`;
      }).join('');

      res.send(`<!DOCTYPE html>
      <html lang="ru"><head><meta charset="UTF-8"><title>«Отмена» — ключи и подписки</title>
      <style>
        body { font-family: sans-serif; background: #f0f2f5; padding: 25px; margin: 0; }
        .card { background: #fff; border-radius: 10px; padding: 20px; max-width: 1150px; margin: 0 auto 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 10px; }
        .stat-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; text-align: center; }
        .stat-num { font-size: 24px; font-weight: bold; color: #2b6cb0; margin-top: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th { background: #2b6cb0; color: #fff; padding: 10px; text-align: left; }
        td { padding: 10px; border-bottom: 1px solid #edf2f7; font-size: 14px; }
      </style></head>
      <body>
        ${adminNav('/admin/cancel')}
        <div class="card">
          <h2>🚫 «Отмена» — статистика</h2>
          ${req.query.msg ? `<p style="font-weight:bold;background:#ebf8ff;padding:10px;border-radius:6px;">${escapeHtml(req.query.msg)}</p>` : ''}
          <div class="stats-grid">
            <div class="stat-box"><div>Всего устройств</div><div class="stat-num">${all.length}</div></div>
            <div class="stat-box"><div>✅ Активных</div><div class="stat-num" style="color:#3182ce;">${activeN}</div></div>
            <div class="stat-box"><div>⏳ Истекли</div><div class="stat-num" style="color:#718096;">${expiredN}</div></div>
            <div class="stat-box"><div>🚫 В бане</div><div class="stat-num" style="color:#e53e3e;">${bannedN}</div></div>
            <div class="stat-box"><div>🎁 Взяли тест</div><div class="stat-num">${trialN}</div></div>
          </div>
          <p style="font-size:13px;color:#4a5568;">Ключи «Отмены» не подходят к радару и наоборот. Бан и дни здесь действуют только на «Отмену».</p>
        </div>
        <div class="card">
          <h2>🛠 Создать ключ</h2>
          <form method="POST" action="/admin/cancel/generate" style="display:flex;gap:8px;align-items:center;">
            <input type="number" name="days" min="1" max="3650" placeholder="дней" required style="width:80px;padding:7px;">
            <button style="border:none;padding:8px 14px;border-radius:5px;color:#fff;font-weight:bold;cursor:pointer;background:#38a169;">Создать ключ</button>
          </form>
          <h3 style="margin-top:20px;font-size:16px;">Свободные ключи (${keys.length}):</h3>
          <div style="max-height:200px;overflow-y:auto;">${freeKeys || '<p style="color:#718096;">Нет свободных ключей</p>'}</div>
        </div>
        <div class="card">
          <h2>🔑 Устройства «Отмены»</h2>
          <form method="GET" action="/admin/cancel" style="display:flex;gap:8px;margin:6px 0 4px;">
            <input name="q" value="${escapeHtml(q)}" placeholder="Поиск: ID устройства, ключ или модель телефона" style="flex:1;padding:12px;font-size:16px;border:2px solid #bee3f8;border-radius:8px;">
            <button style="background:#2b6cb0;color:#fff;border:none;padding:12px 18px;border-radius:8px;font-weight:bold;font-size:16px;cursor:pointer;">Найти</button>
            ${q ? '<a href="/admin/cancel" style="align-self:center;">сбросить</a>' : ''}
          </form>
          ${q ? `<p>Найдено: <b>${subs.length}</b> из ${all.length}</p>` : ''}
          <table>
            <thead><tr><th>Статус</th><th>Ключ</th><th>Телефон / ID</th><th>Истекает</th><th>Действие</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5" align="center">Нет устройств</td></tr>'}</tbody>
          </table>
        </div>
      </body></html>`);
    } catch (err) {
      console.error('admin cancel error:', err);
      res.status(500).send('Ошибка загрузки панели');
    }
  });

  app.post('/admin/cancel/generate', async (req, res) => {
    const days = parseInt(req.body && req.body.days, 10);
    if (!(days >= 1 && days <= 3650)) return res.redirect(back('Введите число дней от 1 до 3650'));
    try {
      const code = generateCode('CANC');
      await pool.query(
        "INSERT INTO app_keys (key_code, duration_hours, type, created, product) VALUES ($1, $2, $3, NOW(), 'cancel')",
        [code, days * 24, `Отмена ${days} дн.`]
      );
    } catch (err) {
      console.error('cancel generate error:', err);
    }
    res.redirect('/admin/cancel');
  });

  app.post('/admin/cancel/delete', async (req, res) => {
    const key = String((req.body && req.body.key_code) || '').toUpperCase();
    try {
      await pool.query("DELETE FROM app_keys WHERE key_code = $1 AND product = 'cancel'", [key]);
    } catch (err) {
      console.error('cancel delete error:', err);
    }
    res.redirect('/admin/cancel');
  });

  // Действия над устройством: дни, отключение, бан, сброс. Радарную подписку не трогаем.
  app.post('/admin/cancel/action', async (req, res) => {
    const { device_id, action } = req.body || {};
    try {
      if (action === 'ban') {
        await pool.query('UPDATE devices SET cancel_banned = TRUE WHERE device_id = $1', [device_id]);
      } else if (action === 'unban') {
        await pool.query('UPDATE devices SET cancel_banned = FALSE WHERE device_id = $1', [device_id]);
      } else if (action === 'disable') {
        await pool.query('UPDATE devices SET cancel_expires = NOW() WHERE device_id = $1', [device_id]);
      } else if (action === 'unlink') {
        await pool.query(
          'UPDATE devices SET cancel_key = NULL, cancel_expires = NULL, cancel_trial_at = NULL, cancel_banned = FALSE WHERE device_id = $1',
          [device_id]
        );
      } else if (action === 'add_days' || action === 'sub_days') {
        const days = parseInt(req.body.days, 10);
        if (!(days >= 1 && days <= 3650)) return res.redirect(back('Введите число дней от 1 до 3650'));
        const r = action === 'add_days'
          ? await pool.query(
              `UPDATE devices SET cancel_expires = GREATEST(COALESCE(cancel_expires, NOW()), NOW()) + ($1 || ' days')::INTERVAL
               WHERE device_id = $2 RETURNING cancel_expires`,
              [String(days), device_id])
          : await pool.query(
              `UPDATE devices SET cancel_expires = COALESCE(cancel_expires, NOW()) - ($1 || ' days')::INTERVAL
               WHERE device_id = $2 RETURNING cancel_expires`,
              [String(days), device_id]);
        if (!r.rows.length) return res.redirect(back('Устройство не найдено'));
        return res.redirect(back((action === 'add_days' ? `Добавлено +${days} дн.` : `Убрано −${days} дн.`) + ` (${dateLabel()})`));
      }
    } catch (err) {
      console.error('cancel action error:', err);
    }
    res.redirect('/admin/cancel');
  });
};
