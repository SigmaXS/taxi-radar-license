// «Отмена» — отдельный продукт внутри Taxi Radar: свой пробный период,
// свои ключи и своя подписка. Радар и отмена не мешают друг другу.
//
// Таблицы: app_keys.product ('radar' | 'cancel'), devices.cancel_key,
// devices.cancel_expires, devices.cancel_trial_at.

const TRIAL_HOURS = 24;

module.exports = function registerCancel(app, pool, { isValidDeviceId, escapeHtml, generateCode, adminNav }) {
  pool.query(`
    ALTER TABLE app_keys ADD COLUMN IF NOT EXISTS product VARCHAR(20) NOT NULL DEFAULT 'radar';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS cancel_key VARCHAR(50);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS cancel_expires TIMESTAMP;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS cancel_trial_at TIMESTAMP;
  `).catch(err => console.error('cancel schema error:', err));

  const nowIso = d => (d ? new Date(d).toISOString() : null);

  async function readStatus(deviceId) {
    const r = await pool.query(
      'SELECT cancel_key, cancel_expires, cancel_trial_at FROM devices WHERE device_id = $1',
      [deviceId]
    );
    const d = r.rows[0];
    const now = new Date();
    const active = !!(d && d.cancel_expires && new Date(d.cancel_expires) > now);
    return {
      active,
      expires: d ? nowIso(d.cancel_expires) : null,
      hours_left: active ? Math.max(0, Math.round((new Date(d.cancel_expires) - now) / 3600000)) : 0,
      trial_available: !(d && d.cancel_trial_at),
      trial_started: !!(d && d.cancel_trial_at)
    };
  }

  // Статус подписки «Отмена» для устройства.
  app.post('/api/cancel/status', async (req, res) => {
    const deviceId = req.body && req.body.device_id;
    if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, message: 'Нет ID' });
    try {
      res.json({ ok: true, ...(await readStatus(deviceId)) });
    } catch (err) {
      console.error('cancel status error:', err);
      res.status(500).json({ ok: false, message: 'Ошибка базы данных' });
    }
  });

  // Пробный день: ровно один раз на устройство, отсчёт с первого включения.
  app.post('/api/cancel/trial', async (req, res) => {
    const deviceId = req.body && req.body.device_id;
    if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, message: 'Нет ID' });
    try {
      const cur = await readStatus(deviceId);
      if (cur.active) return res.json({ ok: true, already: true, expires: cur.expires, hours_left: cur.hours_left });
      if (!cur.trial_available) return res.json({ ok: false, message: 'Пробный день уже использован' });

      const expires = new Date(Date.now() + TRIAL_HOURS * 3600 * 1000);
      await pool.query(
        `INSERT INTO devices (device_id, cancel_expires, cancel_trial_at, last_seen, status, type)
         VALUES ($1, $2, NOW(), NOW(), 'active', 'Отмена · тест')
         ON CONFLICT (device_id) DO UPDATE
         SET cancel_expires = $2, cancel_trial_at = NOW(), last_seen = NOW()`,
        [deviceId, expires]
      );
      res.json({ ok: true, expires: expires.toISOString(), hours_left: TRIAL_HOURS });
    } catch (err) {
      console.error('cancel trial error:', err);
      res.status(500).json({ ok: false, message: 'Ошибка базы данных' });
    }
  });

  // Активация ключа «Отмена». Ключ удаляется, срок добавляется к текущему.
  app.post('/api/cancel/activate', async (req, res) => {
    const deviceId = req.body && req.body.device_id;
    const rawKey = req.body && req.body.key;
    if (!isValidDeviceId(deviceId) || typeof rawKey !== 'string' || !rawKey.trim()) {
      return res.status(400).json({ ok: false, message: 'Введите ключ' });
    }
    const key = rawKey.trim().toUpperCase();
    try {
      const del = await pool.query(
        "DELETE FROM app_keys WHERE key_code = $1 AND product = 'cancel' RETURNING *",
        [key]
      );
      if (!del.rows.length) {
        return res.json({ ok: false, message: 'Ключ неверный или уже активирован' });
      }
      const k = del.rows[0];
      const hours = Math.round(Number(k.duration_hours) || 0);
      if (!(hours > 0)) return res.json({ ok: false, message: 'У ключа нет срока' });

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
      res.json({ ok: true, expires: expires.toISOString(), hours_left: Math.round(hours), type: k.type || '' });
    } catch (err) {
      console.error('cancel activate error:', err);
      res.status(500).json({ ok: false, message: 'Ошибка базы данных' });
    }
  });

  // ---- админка ----

  app.get('/admin/cancel', async (req, res) => {
    try {
      const keys = (await pool.query(
        "SELECT * FROM app_keys WHERE product = 'cancel' ORDER BY created DESC NULLS LAST LIMIT 200"
      )).rows;
      const subs = (await pool.query(
        `SELECT device_id, device_info, cancel_key, cancel_expires, cancel_trial_at
         FROM devices WHERE cancel_expires IS NOT NULL OR cancel_trial_at IS NOT NULL
         ORDER BY cancel_expires DESC NULLS LAST LIMIT 200`
      )).rows;

      const fmt = d => (d ? new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
      const active = d => (d && new Date(d) > new Date());

      res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Отмена</title>
      <style>body{font-family:system-ui,sans-serif;margin:25px;background:#f7fafc}table{width:100%;border-collapse:collapse;background:#fff}
      td,th{padding:8px;border-bottom:1px solid #edf2f7;font-size:14px;text-align:left;vertical-align:top}th{background:#2b6cb0;color:#fff}
      .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:14px 0}
      input,button{font-size:15px;padding:10px;border-radius:8px;border:1px solid #cbd5e0}button{background:#2b6cb0;color:#fff;border:none;cursor:pointer}</style></head>
      <body>${adminNav('/admin/cancel')}
      <h2>«Отмена» — ключи и подписки</h2>
      <div class="card">
        <form method="POST" action="/admin/cancel/generate">
          <b>Новый ключ</b><br>
          <input name="days" type="number" min="1" max="3650" value="30" style="width:90px"> дней
          <button type="submit">Создать ключ</button>
        </form>
        <div style="color:#4a5568;font-size:13px;margin-top:8px">Ключи «Отмены» не подходят к радару и наоборот.</div>
      </div>
      <h3>Свободные ключи (${keys.length})</h3>
      <table><tr><th>Ключ</th><th>Срок</th><th>Тип</th><th>Создан</th><th></th></tr>
      ${keys.map(k => `<tr><td><b>${escapeHtml(k.key_code)}</b></td><td>${(Number(k.duration_hours) / 24).toFixed(0)} дн.</td>
        <td>${escapeHtml(k.type || '')}</td><td>${fmt(k.created)}</td>
        <td><form method="POST" action="/admin/cancel/delete"><input type="hidden" name="key_code" value="${escapeHtml(k.key_code)}"><button style="background:#e53e3e;padding:6px 10px">Удалить</button></form></td></tr>`).join('')}
      </table>
      <h3>Подписки «Отмена» (${subs.length})</h3>
      <table><tr><th>Устройство</th><th>Ключ</th><th>Действует до</th><th>Тест</th></tr>
      ${subs.map(s => `<tr><td style="font-size:12px">${escapeHtml(s.device_id)}<br>${escapeHtml(s.device_info || '')}</td>
        <td>${escapeHtml(s.cancel_key || '—')}</td>
        <td style="color:${active(s.cancel_expires) ? '#2f855a' : '#c53030'}">${fmt(s.cancel_expires)}</td>
        <td>${s.cancel_trial_at ? fmt(s.cancel_trial_at) : '—'}</td></tr>`).join('')}
      </table></body></html>`);
    } catch (err) {
      console.error('admin cancel error:', err);
      res.status(500).send('Ошибка загрузки панели');
    }
  });

  app.post('/admin/cancel/generate', async (req, res) => {
    const days = parseInt(req.body && req.body.days, 10);
    if (!(days >= 1 && days <= 3650)) {
      return res.redirect('/admin/cancel?msg=' + encodeURIComponent('Введите число дней от 1 до 3650'));
    }
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
};
