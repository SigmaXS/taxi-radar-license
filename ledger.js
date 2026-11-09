// Журнал оплат (/admin/ledger): кто, когда и сколько заплатил, сколько у него осталось и когда ждать следующую оплату.
// Записи появляются сами — когда в админке/Telegram нажали «✓ Пришло» по заявке MIA, — и вручную (форма вверху:
// «такой-то заплатил столько-то»). Вручную можно сразу продлить подписку, чтобы не заходить в «Устройства».
const { adminNav } = require('./admin_nav');

const CUR = () => process.env.CURRENCY || 'L';
const PRODUCTS = { radar: 'Радар', cancel: 'Отмена', both: 'Радар + Отмена', other: 'Другое' };

module.exports = function registerLedger(app, pool, { escapeHtml, extend }) {
  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS pay_ledger (
      id BIGSERIAL PRIMARY KEY,
      device_id VARCHAR(100) NOT NULL,
      amount INT NOT NULL,
      days INT,
      product VARCHAR(10) NOT NULL DEFAULT 'radar',
      method VARCHAR(20) NOT NULL DEFAULT 'MIA',
      note VARCHAR(200),
      claim_id BIGINT UNIQUE,
      paid_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS pay_ledger_device ON pay_ledger (device_id, paid_at);
    -- Оплата частями: сделка = сколько клиент должен всего (999), платежи привязываются к ней (200 + 400 + ...).
    CREATE TABLE IF NOT EXISTS pay_deals (
      id BIGSERIAL PRIMARY KEY,
      device_id VARCHAR(100) NOT NULL,
      product VARCHAR(10) NOT NULL DEFAULT 'radar',
      days INT,
      total INT NOT NULL,
      note VARCHAR(200),
      closed BOOLEAN NOT NULL DEFAULT FALSE,
      created TIMESTAMP NOT NULL DEFAULT NOW()
    );
    ALTER TABLE pay_ledger ADD COLUMN IF NOT EXISTS deal_id BIGINT;
    ALTER TABLE pay_ledger ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'manual';
    CREATE INDEX IF NOT EXISTS pay_ledger_deal ON pay_ledger (deal_id);
  `).then(async () => {
    // Разовая очистка по просьбе владельца: журнал начинается с нуля, всё вносится вручную.
    // Старые заявки MIA больше не переносятся сами; новые подтверждения пишутся отдельным блоком (source = 'auto').
    await pool.query('CREATE TABLE IF NOT EXISTS one_time_jobs (name VARCHAR(100) PRIMARY KEY, done_at TIMESTAMP NOT NULL DEFAULT NOW(), info TEXT)');
    const job = await pool.query("INSERT INTO one_time_jobs (name, info) VALUES ('ledger_reset_2026_11_09', 'журнал оплат очищен') ON CONFLICT (name) DO NOTHING RETURNING name");
    if (job.rows.length) {
      await pool.query('DELETE FROM pay_ledger');
      await pool.query('DELETE FROM pay_deals');
    }
  }).catch(err => console.error('pay_ledger init error:', err));

  /** Запись об оплате по подтверждённой заявке MIA. Повторный вызов с той же заявкой ничего не меняет. */
  async function recordClaim(claim) {
    try {
      await ready;
      await pool.query(
        `INSERT INTO pay_ledger (device_id, amount, days, product, method, note, claim_id, source)
         VALUES ($1, $2, $3, $4, 'MIA', $5, $6, 'auto') ON CONFLICT (claim_id) DO NOTHING`,
        [claim.device_id, claim.price, claim.days, claim.product || 'radar', 'заявка №' + claim.id, claim.id]
      );
    } catch (e) { console.error('pay_ledger record error:', e.message); }
  }

  const tz = { timeZone: 'Europe/Chisinau' };
  const day = d => new Date(d).toLocaleDateString('ru-RU', { ...tz, day: '2-digit', month: '2-digit', year: '2-digit' });
  const dayShort = d => new Date(d).toLocaleDateString('ru-RU', { ...tz, day: '2-digit', month: '2-digit' });
  const daysLeft = d => d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86400e3) : null;
  const money = n => `${Number(n || 0).toLocaleString('ru-RU')} ${CUR()}`;

  function leftCell(until) {
    if (!until) return '<span style="color:#a0aec0">—</span>';
    const n = daysLeft(until);
    if (n <= 0) return `<span style="color:#c53030;font-weight:bold">истекла ${dayShort(until)}</span>`;
    const col = n <= 3 ? '#dd6b20' : '#2f855a';
    return `<span style="color:${col};font-weight:bold">${n} дн.</span> <span style="color:#718096">до ${dayShort(until)}</span>`;
  }

  // Клиент из формы: полный ID, либо кусок ID / ключа / названия телефона / номера из заявки — если подходит ровно один.
  async function findDevice(q) {
    const s = String(q || '').trim();
    if (!s) return { error: 'Укажите клиента (ID или часть ID, телефона, названия)' };
    const like = '%' + s.replace(/[%_\\]/g, m => '\\' + m) + '%';
    const r = await pool.query(
      `SELECT DISTINCT d.device_id FROM devices d
       LEFT JOIN pay_claims c ON c.device_id = d.device_id
       WHERE d.device_id = $1 OR d.device_id ILIKE $2 OR d.key_code ILIKE $2 OR d.device_info ILIKE $2 OR c.phone ILIKE $2
       LIMIT 6`, [s, like]);
    if (r.rows.length === 1) return { id: r.rows[0].device_id };
    const exact = r.rows.find(x => x.device_id === s);
    if (exact) return { id: exact.device_id };
    if (!r.rows.length) return { error: 'Такого устройства нет. Проверьте ID (его видно во вкладке «Устройства»)' };
    return { error: 'Подходит несколько устройств — уточните ID: ' + r.rows.map(x => x.device_id).join(', ') };
  }

  const back = (res, msg) => res.redirect('/admin/ledger' + (msg ? '?msg=' + encodeURIComponent(msg) : ''));

  /**
   * Закрывает сделку, когда заплачено не меньше суммы, и открывает снова, если платёж убрали или сумму подняли.
   * Возвращает { total, paid } или null, если сделки нет.
   */
  async function settleDeal(dealId) {
    if (!dealId) return null;
    const r = await pool.query(
      `SELECT d.total, COALESCE((SELECT SUM(amount) FROM pay_ledger WHERE deal_id = d.id), 0)::int AS paid FROM pay_deals d WHERE d.id = $1`, [dealId]);
    const d = r.rows[0];
    if (!d) return null;
    await pool.query('UPDATE pay_deals SET closed = $1 WHERE id = $2', [d.paid >= d.total, dealId]);
    return { total: d.total, paid: d.paid };
  }

  /**
   * К какой сделке относится платёж. «Полная цена» указана — открываем сделку (или обновляем открытую у этого клиента).
   * Не указана, но у клиента есть незакрытый долг — это очередная часть, кладём в него. Иначе — отдельная оплата.
   */
  async function pickDeal(deviceId, product, days, total, note, noDeal) {
    if (noDeal) return null;
    const open = (await pool.query('SELECT id, total FROM pay_deals WHERE device_id = $1 AND NOT closed ORDER BY id LIMIT 1', [deviceId])).rows[0];
    if (total) {
      if (open) {
        if (open.total !== total) await pool.query('UPDATE pay_deals SET total = $1 WHERE id = $2', [total, open.id]);
        return open.id;
      }
      const r = await pool.query('INSERT INTO pay_deals (device_id, product, days, total, note) VALUES ($1, $2, $3, $4, $5) RETURNING id', [deviceId, product, days, total, note]);
      return Number(r.rows[0].id);
    }
    return open ? Number(open.id) : null;
  }

  app.post('/admin/ledger/add', async (req, res) => {
    try {
      await ready;
      const b = req.body || {};
      const f = await parseForm(b);
      if (f.error) return back(res, f.error);
      let total = null;
      if (b.total !== undefined && b.total !== '') {
        total = parseInt(b.total, 10);
        if (!(total > 0 && total <= 1000000)) return back(res, 'Полная цена — число (или оставьте пустой)');
      }
      const dealId = await pickDeal(f.id, f.product, f.days, total, f.note, b.nodeal === 'on');
      await pool.query(
        'INSERT INTO pay_ledger (device_id, amount, days, product, method, note, paid_at, deal_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [f.id, f.amount, f.days, f.product, f.method, f.note, f.paidAt, dealId]
      );
      const st = await settleDeal(dealId);
      let msg = `✓ Записано: ${money(f.amount)} · ${f.id}`;
      if (st) msg += st.paid >= st.total
        ? ` · долг закрыт (заплатил ${money(st.paid)} из ${money(st.total)})`
        : ` · заплатил ${money(st.paid)} из ${money(st.total)}, осталось ${money(st.total - st.paid)}`;
      // «Продлить подписку»: те же правила, что у кнопки «✓ Пришло». Для «Другое» срок не меняем.
      if (b.extend === 'on' && f.days && f.product !== 'other') {
        const d = await extend({ device_id: f.id, days: f.days, price: f.amount, product: f.product });
        msg += ` · подписка продлена до ${day(d.expires)}`;
      }
      back(res, msg);
    } catch (e) {
      console.error('ledger add error:', e);
      back(res, 'Ошибка сервера: ' + e.message);
    }
  });

  // Долг: поправить полную цену или закрыть (простить остаток).
  app.post('/admin/ledger/deal-total', async (req, res) => {
    const id = parseInt(req.body && req.body.id, 10);
    const total = parseInt(req.body && req.body.total, 10);
    if (!Number.isSafeInteger(id) || !(total > 0 && total <= 1000000)) return back(res, 'Введите сумму числом');
    await pool.query('UPDATE pay_deals SET total = $1 WHERE id = $2', [total, id]);
    const st = await settleDeal(id);
    back(res, st ? `✓ Полная цена ${money(total)}, заплачено ${money(st.paid)}` : 'Долг не найден');
  });
  app.post('/admin/ledger/deal-close', async (req, res) => {
    const id = parseInt(req.body && req.body.id, 10);
    if (Number.isSafeInteger(id)) await pool.query('UPDATE pay_deals SET closed = TRUE WHERE id = $1', [id]).catch(() => null);
    back(res, 'Долг закрыт: остаток списан');
  });

  const INP = 'padding:9px;border:1px solid #cbd5e0;border-radius:8px;font-size:15px;';
  const opt = (val, label, cur) => `<option value="${val}"${String(cur) === String(val) ? ' selected' : ''}>${label}</option>`;

  /**
   * Форма «Записать оплату» (и «Изменить запись»): одна и та же на «Журнале оплат», на «Заявках MIA» и на странице правки.
   * v — значения для правки; без них пустая форма с сегодняшней датой.
   */
  function formHtml(v) {
    const edit = !!v;
    const x = v || {};
    const inp = INP;
    const date = x.paid_at ? new Date(x.paid_at).toLocaleDateString('sv-SE', tz) : new Date().toLocaleDateString('sv-SE', tz);
    return `<div style="background:#fff;border-radius:12px;padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:18px">
      <h3 style="margin-top:0">${edit ? '✎ Изменить запись №' + x.id : '➕ Записать оплату вручную'}</h3>
      <form method="POST" action="/admin/ledger/${edit ? 'edit' : 'add'}" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        ${edit ? `<input type="hidden" name="id" value="${x.id}">` : ''}
        <label style="flex:2;min-width:220px">Клиент (ID, часть ID, телефон)<br><input name="client" required value="${escapeHtml(x.device_id || '')}" style="${inp}width:100%;box-sizing:border-box" placeholder="например a1b2c3 или +373…"></label>
        <label>Сумма, ${escapeHtml(CUR())}<br><input name="amount" type="number" min="1" required value="${x.amount != null ? x.amount : ''}" style="${inp}width:100px"></label>
        <label>Что куплено<br><select name="product" style="${inp}">${opt('radar', 'Радар', x.product)}${opt('cancel', 'Отмена', x.product)}${opt('both', 'Радар + Отмена', x.product)}${opt('other', 'Другое (срок не менять)', x.product)}</select></label>
        ${edit ? '' : `<label title="Если платят частями: сколько он должен всего. Следующие части вносите без этого поля — они сами пойдут в долг.">Полная цена (частями)<br><input name="total" type="number" min="1" style="${inp}width:120px" placeholder="999"></label>`}
        <label>На сколько дней<br><input name="days" type="number" min="1" value="${x.days != null ? x.days : ''}" style="${inp}width:90px" placeholder="30"></label>
        <label>Как оплатил<br><select name="method" style="${inp}">${['MIA', 'Наличные', 'Карта', 'Другое'].map(m => opt(m, m, x.method)).join('')}</select></label>
        <label>Дата<br><input name="date" type="date" value="${date}" style="${inp}"></label>
        <label style="flex:2;min-width:180px">Заметка<br><input name="note" maxlength="200" value="${escapeHtml(x.note || '')}" style="${inp}width:100%;box-sizing:border-box" placeholder="имя, за что, договорились"></label>
        ${edit ? '' : '<label style="display:flex;gap:6px;align-items:center;padding-bottom:10px"><input type="checkbox" name="extend" checked> сразу продлить подписку</label><label style="display:flex;gap:6px;align-items:center;padding-bottom:10px" title="Не относить к долгу клиента"><input type="checkbox" name="nodeal"> отдельная оплата</label>'}
        <button style="background:#38a169;color:#fff;border:none;padding:11px 20px;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer">${edit ? 'Сохранить' : 'Записать'}</button>
        ${edit ? '<a href="/admin/ledger" style="padding:11px 14px">Отмена</a>' : ''}
      </form>
      <div class="small" style="margin-top:6px">${edit
        ? 'Правка меняет только запись в журнале. Срок подписки у клиента не меняется — его правят во вкладке «Устройства».'
        : 'Платят частями? В первый раз впишите «Полную цену» (например 999) и сколько заплатил сейчас (200); дальше вносите только очередную сумму — радар сам посчитает остаток. Оплаты по заявкам MIA (кнопка «✓ Пришло») попадают в журнал сами. Здесь — для тех, кто заплатил наличными, переводом мимо приложения и т. п.'}</div>
    </div>`;
  }

  const pageShell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
    <style>body{font-family:system-ui,sans-serif;margin:25px;background:#f0f2f5;color:#1a202c}.small{font-size:12px;color:#718096}a{color:#2b6cb0}</style></head><body>${adminNav('/admin/ledger')}${body}</body></html>`;

  // Общий разбор полей формы для «добавить» и «изменить».
  async function parseForm(b) {
    const amount = parseInt(b.amount, 10);
    if (!(amount > 0 && amount <= 1000000)) return { error: 'Введите сумму числом' };
    const days = b.days === '' || b.days == null ? null : parseInt(b.days, 10);
    if (days !== null && !(days >= 1 && days <= 3650)) return { error: 'Дни — число от 1 до 3650 (или пусто)' };
    const product = PRODUCTS[b.product] && b.product !== 'other' ? b.product : 'other';
    const method = ['MIA', 'Наличные', 'Карта', 'Другое'].includes(b.method) ? b.method : 'Другое';
    const note = String(b.note || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || null;
    const found = await findDevice(b.client);
    if (found.error) return { error: found.error };
    const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? new Date(b.date + 'T12:00:00+02:00') : new Date();
    return { amount, days, product, method, note, id: found.id, paidAt };
  }

  app.get('/admin/ledger/edit', async (req, res) => {
    await ready;
    const id = parseInt(req.query.id, 10);
    const row = Number.isSafeInteger(id) ? (await pool.query('SELECT * FROM pay_ledger WHERE id = $1', [id])).rows[0] : null;
    if (!row) return back(res, 'Запись не найдена');
    res.send(pageShell('Изменить запись', `<h2>🧾 Журнал оплат</h2>${formHtml(row)}`));
  });

  app.post('/admin/ledger/edit', async (req, res) => {
    try {
      await ready;
      const id = parseInt(req.body && req.body.id, 10);
      if (!Number.isSafeInteger(id)) return back(res, 'Запись не найдена');
      const f = await parseForm(req.body);
      if (f.error) return back(res, f.error);
      const r = await pool.query(
        'UPDATE pay_ledger SET device_id = $1, amount = $2, days = $3, product = $4, method = $5, note = $6, paid_at = $7 WHERE id = $8 RETURNING id, deal_id',
        [f.id, f.amount, f.days, f.product, f.method, f.note, f.paidAt, id]);
      if (r.rows[0] && r.rows[0].deal_id) await settleDeal(r.rows[0].deal_id);
      back(res, r.rows.length ? `✓ Запись №${id} изменена (срок подписки не менялся)` : 'Запись не найдена');
    } catch (e) {
      console.error('ledger edit error:', e);
      back(res, 'Ошибка сервера: ' + e.message);
    }
  });

  // Удаляется только запись в журнале; срок подписки это не меняет (для этого — вкладка «Устройства»).
  app.post('/admin/ledger/delete', async (req, res) => {
    const id = parseInt(req.body && req.body.id, 10);
    if (Number.isSafeInteger(id)) {
      const del = await pool.query('DELETE FROM pay_ledger WHERE id = $1 RETURNING deal_id', [id]).catch(() => null);
      if (del && del.rows[0] && del.rows[0].deal_id) await settleDeal(del.rows[0].deal_id).catch(() => null);
    }
    back(res, 'Запись удалена из журнала (срок подписки не менялся)');
  });

  app.get('/admin/ledger', async (req, res) => {
    try {
      await ready;
      const only = String(req.query.device || '').trim();
      const q = String(req.query.q || '').trim().toLowerCase();
      const [clients, history, totals, deals] = await Promise.all([
        pool.query(`
          SELECT l.device_id, SUM(l.amount)::int AS total, COUNT(*)::int AS n, MAX(l.paid_at) AS last_paid,
                 (SELECT amount FROM pay_ledger x WHERE x.device_id = l.device_id ORDER BY paid_at DESC, id DESC LIMIT 1) AS last_amount,
                 d.expires, d.cancel_expires, d.device_info, d.status,
                 (SELECT phone FROM pay_claims c WHERE c.device_id = l.device_id ORDER BY created DESC LIMIT 1) AS phone
          FROM pay_ledger l LEFT JOIN devices d ON d.device_id = l.device_id
          GROUP BY l.device_id, d.expires, d.cancel_expires, d.device_info, d.status`),
        pool.query(`
          SELECT l.*, d.device_info, (SELECT phone FROM pay_claims c WHERE c.device_id = l.device_id ORDER BY created DESC LIMIT 1) AS phone
          FROM pay_ledger l LEFT JOIN devices d ON d.device_id = l.device_id
          ${only ? 'WHERE l.device_id = $1' : ''} ORDER BY l.paid_at DESC, l.id DESC LIMIT 300`, only ? [only] : []),
        pool.query(`
          SELECT COALESCE(SUM(amount), 0)::int AS all_time,
                 COALESCE(SUM(amount) FILTER (WHERE paid_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Chisinau')), 0)::int AS month,
                 COALESCE(SUM(amount) FILTER (WHERE paid_at >= NOW() - INTERVAL '7 days'), 0)::int AS week,
                 COUNT(*)::int AS n FROM pay_ledger`),
        pool.query(`
          SELECT d.*, COALESCE((SELECT SUM(amount) FROM pay_ledger WHERE deal_id = d.id), 0)::int AS paid,
                 (SELECT device_info FROM devices x WHERE x.device_id = d.device_id) AS device_info,
                 (SELECT phone FROM pay_claims c WHERE c.device_id = d.device_id ORDER BY created DESC LIMIT 1) AS phone
          FROM pay_deals d WHERE NOT d.closed ORDER BY d.created`)
      ]);
      const debtBy = new Map();
      let debtTotal = 0;
      for (const d of deals.rows) { const left = Math.max(0, d.total - d.paid); debtTotal += left; debtBy.set(d.device_id, (debtBy.get(d.device_id) || 0) + left); }

      const until = c => [c.expires, c.cancel_expires].filter(Boolean).map(x => new Date(x).getTime()).sort((a, b) => b - a)[0] || 0;
      let list = clients.rows.map(c => ({ ...c, due: until(c) })).sort((a, b) => a.due - b.due);
      const soon = list.filter(c => c.due && daysLeft(c.due) > 0 && daysLeft(c.due) <= 3).length;
      const expired = list.filter(c => c.due && daysLeft(c.due) <= 0).length;
      if (q) list = list.filter(c => [c.device_id, c.device_info, c.phone].some(v => String(v || '').toLowerCase().includes(q)));
      const t = totals.rows[0];

      const histRows = rows => rows.map(h => `<tr><td>${day(h.paid_at)}</td>
          <td><a href="/admin/ledger?device=${encodeURIComponent(h.device_id)}">${escapeHtml(h.device_id)}</a><br><span class="small">${label(h)}</span></td>
          <td><b>${money(h.amount)}</b></td><td>${PRODUCTS[h.product] || h.product}${h.days ? ' · ' + h.days + ' дн.' : ''}${h.deal_id ? '<br><span class="small">часть долга №' + h.deal_id + '</span>' : ''}</td><td>${escapeHtml(h.method)}</td>
          <td>${escapeHtml(h.note || '')}</td>
          <td style="white-space:nowrap"><a href="/admin/ledger/edit?id=${h.id}" title="Изменить запись" style="text-decoration:none">✎</a> <form style="display:inline" method="POST" action="/admin/ledger/delete" onsubmit="return confirm('Удалить запись из журнала? Срок подписки не изменится.')"><input type="hidden" name="id" value="${h.id}"><button style="background:none;border:none;color:#c53030;cursor:pointer" title="Удалить запись">✕</button></form></td></tr>`).join('');
      const histTable = (rows, empty) => `<div class="wrap"><table><tr><th>Дата</th><th>Клиент</th><th>Сумма</th><th>Что / срок</th><th>Как</th><th>Заметка</th><th style="width:60px"></th></tr>
        ${histRows(rows) || `<tr><td colspan="7" style="padding:18px;color:#718096">${empty}</td></tr>`}</table></div>`;
      const manualRows = history.rows.filter(h => h.source !== 'auto');
      const autoRows = history.rows.filter(h => h.source === 'auto');
      const label = c => `${escapeHtml(c.device_info || '')}${c.phone ? ' · ' + escapeHtml(c.phone) : ''}`;
      const msg = req.query.msg ? `<div style="background:#ebf8ff;border:1px solid #90cdf4;padding:10px 14px;border-radius:8px;margin-bottom:14px">${escapeHtml(String(req.query.msg))}</div>` : '';
      const kpi = (title, val, col) => `<div style="flex:1;min-width:140px;background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
        <div style="color:#718096;font-size:13px">${title}</div><div style="font-size:22px;font-weight:bold;color:${col || '#1a202c'}">${val}</div></div>`;
      const inp = 'padding:9px;border:1px solid #cbd5e0;border-radius:8px;font-size:15px;';

      res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Журнал оплат</title>
        <style>body{font-family:system-ui,sans-serif;margin:25px;background:#f0f2f5;color:#1a202c}h2,h3{margin:18px 0 8px}
        table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden}td,th{padding:9px 10px;border-bottom:1px solid #edf2f7;font-size:14px;text-align:left;vertical-align:top}
        th{background:#2b6cb0;color:#fff}.wrap{overflow-x:auto}a{color:#2b6cb0}.small{font-size:12px;color:#718096}</style></head><body>
        ${adminNav('/admin/ledger')}
        <h2>🧾 Журнал оплат</h2>${msg}
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
          ${kpi('За всё время', money(t.all_time))}${kpi('В этом месяце', money(t.month), '#2f855a')}${kpi('За 7 дней', money(t.week))}
          ${kpi('Платящих клиентов', clients.rows.length)}${kpi('Кончается за 3 дня', soon, soon ? '#dd6b20' : '')}${kpi('Просрочили', expired, expired ? '#c53030' : '')}${kpi('Должны вам', money(debtTotal), debtTotal ? '#c53030' : '')}
        </div>

        ${formHtml()}

        ${deals.rows.length ? `<h3>💳 Долги: оплата частями</h3>
        <div class="wrap"><table><tr><th>Клиент</th><th>За что</th><th>Всего</th><th>Заплатил</th><th>Осталось</th><th>С какого дня</th><th></th></tr>
        ${deals.rows.map(d => `<tr><td><a href="/admin/ledger?device=${encodeURIComponent(d.device_id)}"><b>${escapeHtml(d.device_id)}</b></a><br><span class="small">${label(d)}</span></td>
          <td>${PRODUCTS[d.product] || d.product}${d.days ? ' · ' + d.days + ' дн.' : ''}</td>
          <td>
            <form method="POST" action="/admin/ledger/deal-total" style="display:flex;gap:4px"><input type="hidden" name="id" value="${d.id}"><input name="total" type="number" min="1" value="${d.total}" style="width:80px;padding:5px;border:1px solid #cbd5e0;border-radius:6px"><button title="Изменить полную цену" style="cursor:pointer">✓</button></form></td>
          <td>${money(d.paid)}</td><td><b style="color:#c53030">${money(Math.max(0, d.total - d.paid))}</b></td><td>${day(d.created)}</td>
          <td><form method="POST" action="/admin/ledger/deal-close" onsubmit="return confirm('Закрыть долг? Остаток спишется.')"><input type="hidden" name="id" value="${d.id}"><button style="cursor:pointer">Списать остаток</button></form></td></tr>`).join('')}
        </table></div>` : ''}

        <h3>👥 Клиенты: сколько заплатили и когда ждать оплату</h3>
        <form method="GET" style="margin-bottom:8px"><input name="q" value="${escapeHtml(q)}" placeholder="поиск по ID, телефону, названию" style="${inp}width:280px"> <button style="${inp}cursor:pointer">Найти</button></form>
        <div class="wrap"><table><tr><th>Клиент</th><th>Заплатил всего</th><th>Платежей</th><th>Последняя оплата</th><th>Радар осталось</th><th>Отмена осталось</th><th>Ждём оплату</th><th>Должен</th></tr>
        ${list.map(c => {
          const n = daysLeft(c.due);
          const wait = !c.due ? '—' : n <= 0 ? `<b style="color:#c53030">просрочено ${-n} дн.</b>` : n <= 3 ? `<b style="color:#dd6b20">через ${n} дн. (${dayShort(c.due)})</b>` : `~ ${day(c.due)}`;
          return `<tr><td><a href="/admin/ledger?device=${encodeURIComponent(c.device_id)}"><b>${escapeHtml(c.device_id)}</b></a><br><span class="small">${label(c)}${c.status === 'banned' ? ' · 🚫 бан' : ''}</span></td>
            <td><b>${money(c.total)}</b></td><td>${c.n}</td><td>${day(c.last_paid)}<br><span class="small">${money(c.last_amount)}</span></td>
            <td>${leftCell(c.expires)}</td><td>${leftCell(c.cancel_expires)}</td><td>${wait}</td>
            <td>${debtBy.get(c.device_id) ? `<b style="color:#c53030">${money(debtBy.get(c.device_id))}</b>` : '<span style="color:#a0aec0">—</span>'}</td></tr>`;
        }).join('') || '<tr><td colspan="8" style="padding:18px;color:#718096">Пока нет записей</td></tr>'}
        </table></div>

        <h3>✍️ ${only ? 'Мои записи клиента ' + escapeHtml(only) + ' · <a href="/admin/ledger" style="font-size:14px">показать все</a>' : 'Мои записи (внесены вручную)'}</h3>
        ${histTable(manualRows, 'Пока пусто — вносите оплату формой выше')}

        <h3>🤖 Автоматически: подтверждённые заявки MIA</h3>
        <div class="small" style="margin-bottom:6px">Сюда попадают оплаты, у которых вы нажали «✓ Пришло» в Telegram или в «Заявках MIA». Это отдельный список, ваши записи он не трогает.</div>
        ${histTable(autoRows, 'Пока нет подтверждённых заявок')}
        </body></html>`);
    } catch (e) {
      console.error('ledger page error:', e);
      res.status(500).send('Ошибка: ' + escapeHtml(e.message));
    }
  });

  return { recordClaim, formHtml };
};
