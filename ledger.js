// Журнал оплат (/admin/ledger). Одна строка = один клиент и одна подписка:
//   ID клиента · сколько СТОИТ подписка · на сколько дней · сколько ЗАПЛАТИЛ · заметка.
//   Должен = стоит − заплатил. Платят частями — кнопкой «+ доплата» добавляете сумму, остаток пересчитывается.
// Оплаты по заявкам MIA («✓ Пришло») попадают отдельным списком ниже (source = 'auto'): клиент заплатил полностью.
const { adminNav } = require('./admin_nav');

const CUR = () => process.env.CURRENCY || 'L';
const PRODUCTS = { radar: 'Радар', cancel: 'Отмена', both: 'Радар + Отмена' };

module.exports = function registerLedger(app, pool, { escapeHtml, extend }) {
  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS pay_list (
      id BIGSERIAL PRIMARY KEY,
      device_id VARCHAR(100) NOT NULL,
      product VARCHAR(10) NOT NULL DEFAULT 'radar',
      price INT NOT NULL,
      days INT,
      paid INT NOT NULL DEFAULT 0,
      note VARCHAR(200),
      source VARCHAR(10) NOT NULL DEFAULT 'manual',
      claim_id BIGINT UNIQUE,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      updated TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS pay_list_device ON pay_list (device_id);
  `).then(async () => {
    // Разовая очистка по просьбе владельца: прежний журнал (платежи и сделки) был запутанным и удаляется целиком.
    await pool.query('CREATE TABLE IF NOT EXISTS one_time_jobs (name VARCHAR(100) PRIMARY KEY, done_at TIMESTAMP NOT NULL DEFAULT NOW(), info TEXT)');
    const job = await pool.query("INSERT INTO one_time_jobs (name, info) VALUES ('ledger_v2_reset_2026_11_09', 'старый журнал оплат удалён') ON CONFLICT (name) DO NOTHING RETURNING name");
    if (job.rows.length) {
      await pool.query('DROP TABLE IF EXISTS pay_ledger');
      await pool.query('DROP TABLE IF EXISTS pay_deals');
      await pool.query('DELETE FROM pay_list');
    }
  }).catch(err => console.error('pay_list init error:', err));

  /** Оплата по заявке MIA: подписка оплачена полностью. Повтор с той же заявкой ничего не меняет. */
  async function recordClaim(claim) {
    try {
      await ready;
      await pool.query(
        `INSERT INTO pay_list (device_id, product, price, days, paid, note, source, claim_id)
         VALUES ($1, $2, $3, $4, $3, $5, 'auto', $6) ON CONFLICT (claim_id) DO NOTHING`,
        [claim.device_id, claim.product || 'radar', claim.price, claim.days, 'заявка MIA №' + claim.id, claim.id]
      );
    } catch (e) { console.error('pay_list record error:', e.message); }
  }

  const tz = { timeZone: 'Europe/Chisinau' };
  const day = d => new Date(d).toLocaleDateString('ru-RU', { ...tz, day: '2-digit', month: '2-digit', year: '2-digit' });
  const dayShort = d => new Date(d).toLocaleDateString('ru-RU', { ...tz, day: '2-digit', month: '2-digit' });
  const daysLeft = d => d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86400e3) : null;
  const money = n => `${Number(n || 0).toLocaleString('ru-RU')} ${CUR()}`;
  const INP = 'padding:9px;border:1px solid #cbd5e0;border-radius:8px;font-size:15px;';
  const opt = (val, label, cur) => `<option value="${val}"${String(cur) === String(val) ? ' selected' : ''}>${label}</option>`;

  function leftCell(until) {
    if (!until) return '<span style="color:#a0aec0">—</span>';
    const n = daysLeft(until);
    if (n <= 0) return `<span style="color:#c53030;font-weight:bold">истекла ${dayShort(until)}</span>`;
    const col = n <= 3 ? '#dd6b20' : '#2f855a';
    return `<span style="color:${col};font-weight:bold">${n} дн.</span> <span style="color:#718096">до ${dayShort(until)}</span>`;
  }

  /** «Должен» одной строкой: красным долг, зелёным «оплачено», синим переплата. */
  function debtCell(price, paid) {
    const d = price - paid;
    if (d > 0) return `<b style="color:#c53030;font-size:16px">${money(d)}</b>`;
    if (d === 0) return '<b style="color:#2f855a">оплачено ✓</b>';
    return `<b style="color:#2b6cb0">переплата ${money(-d)}</b>`;
  }

  // Клиент из формы: полный ID, либо кусок ID / ключа / названия телефона / номера из заявки — если подходит ровно один.
  // Если устройства с таким ID нет, запись всё равно сохраняется (например, клиент ещё не открывал приложение) — по введённому тексту.
  async function findDevice(q) {
    const s = String(q || '').trim().slice(0, 100);
    if (!s) return { error: 'Укажите клиента (ID, часть ID или телефон)' };
    const like = '%' + s.replace(/[%_\\]/g, m => '\\' + m) + '%';
    const r = await pool.query(
      `SELECT DISTINCT d.device_id FROM devices d
       LEFT JOIN pay_claims c ON c.device_id = d.device_id
       WHERE d.device_id = $1 OR d.device_id ILIKE $2 OR d.key_code ILIKE $2 OR d.device_info ILIKE $2 OR c.phone ILIKE $2
       LIMIT 6`, [s, like]);
    const exact = r.rows.find(x => x.device_id === s);
    if (exact) return { id: exact.device_id, known: true };
    if (r.rows.length === 1) return { id: r.rows[0].device_id, known: true };
    if (!r.rows.length) return { id: s, known: false };
    return { error: 'Подходит несколько устройств — уточните ID: ' + r.rows.map(x => x.device_id).join(', ') };
  }

  const back = (res, msg) => res.redirect('/admin/ledger' + (msg ? '?msg=' + encodeURIComponent(msg) : ''));
  const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
  const intOrNull = v => (v === undefined || v === null || String(v).trim() === '') ? null : parseInt(v, 10);

  /** Общий разбор формы «добавить» и «изменить». */
  async function parseForm(b) {
    const price = intOrNull(b.price);
    if (!(price > 0 && price <= 1000000)) return { error: 'Укажите, сколько стоит подписка (число)' };
    const paid = intOrNull(b.paid) === null ? 0 : intOrNull(b.paid);
    if (!(paid >= 0 && paid <= 1000000)) return { error: '«Заплатил» — число от 0' };
    const days = intOrNull(b.days);
    if (days !== null && !(days >= 1 && days <= 3650)) return { error: 'Дни — число от 1 до 3650 (или пусто)' };
    const product = PRODUCTS[b.product] ? b.product : 'radar';
    const found = await findDevice(b.client);
    if (found.error) return { error: found.error };
    const created = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? new Date(b.date + 'T12:00:00+02:00') : new Date();
    return { id: found.id, known: found.known, price, paid, days, product, note: clean(b.note, 200) || null, created };
  }

  /**
   * Форма «Добавить» (и «Изменить»): одна и та же на «Журнале оплат», на «Заявках MIA» и на странице правки.
   * v — значения строки для правки; без него — пустая форма.
   */
  function formHtml(v) {
    const edit = !!v;
    const x = v || {};
    const inp = INP;
    const date = new Date(x.created || Date.now()).toLocaleDateString('sv-SE', tz);
    return `<div style="background:#fff;border-radius:12px;padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:18px">
      <h3 style="margin-top:0">${edit ? '✎ Изменить запись №' + x.id : '➕ Добавить клиента'}</h3>
      <form method="POST" action="/admin/ledger/${edit ? 'edit' : 'add'}" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        ${edit ? `<input type="hidden" name="id" value="${x.id}">` : ''}
        <label style="flex:2;min-width:200px"><b>ID клиента</b> (или часть ID, телефон)<br><input name="client" required value="${escapeHtml(x.device_id || '')}" style="${inp}width:100%;box-sizing:border-box" placeholder="например 37c3a9962c56a9a3"></label>
        <label><b>Стоит</b>, ${escapeHtml(CUR())}<br><input name="price" type="number" min="1" required value="${x.price != null ? x.price : ''}" style="${inp}width:100px" placeholder="999"></label>
        <label><b>Дней</b><br><input name="days" type="number" min="1" value="${x.days != null ? x.days : ''}" style="${inp}width:80px" placeholder="30"></label>
        <label><b>Заплатил</b>, ${escapeHtml(CUR())}<br><input name="paid" type="number" min="0" value="${x.paid != null ? x.paid : ''}" style="${inp}width:100px" placeholder="0"></label>
        <label>Что<br><select name="product" style="${inp}">${opt('radar', 'Радар', x.product)}${opt('cancel', 'Отмена', x.product)}${opt('both', 'Радар + Отмена', x.product)}</select></label>
        <label>С какого числа<br><input name="date" type="date" value="${date}" style="${inp}"></label>
        <label style="flex:2;min-width:180px"><b>Заметка</b><br><input name="note" maxlength="200" value="${escapeHtml(x.note || '')}" style="${inp}width:100%;box-sizing:border-box" placeholder="кто, за что, до какого числа обещал"></label>
        ${edit ? '' : '<label style="display:flex;gap:6px;align-items:center;padding-bottom:10px" title="Если клиенту ещё не добавлены дни в «Устройствах»"><input type="checkbox" name="extend"> и продлить подписку на эти дни</label>'}
        <button style="background:#38a169;color:#fff;border:none;padding:11px 20px;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer">${edit ? 'Сохранить' : 'Добавить'}</button>
        ${edit ? '<a href="/admin/ledger" style="padding:11px 14px">Отмена</a>' : ''}
      </form>
      <div class="small" style="margin-top:6px">Должен = Стоит − Заплатил. Платит частями — внесите «Заплатил» поменьше, а потом нажмите «+ доплата» в строке клиента.${edit ? ' Правка меняет только запись в журнале, срок подписки не трогает (его правят во вкладке «Устройства»).' : ''}</div>
    </div>`;
  }

  const pageShell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
    <style>body{font-family:system-ui,sans-serif;margin:25px;background:#f0f2f5;color:#1a202c}.small{font-size:12px;color:#718096}a{color:#2b6cb0}</style></head><body>${adminNav('/admin/ledger')}${body}</body></html>`;

  app.post('/admin/ledger/add', async (req, res) => {
    try {
      await ready;
      const b = req.body || {};
      const f = await parseForm(b);
      if (f.error) return back(res, f.error);
      await pool.query(
        'INSERT INTO pay_list (device_id, product, price, days, paid, note, created) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [f.id, f.product, f.price, f.days, f.paid, f.note, f.created]);
      let msg = `✓ Добавлен: ${f.id} · стоит ${money(f.price)}, заплатил ${money(f.paid)}, ` + (f.price - f.paid > 0 ? `должен ${money(f.price - f.paid)}` : 'оплачено');
      if (b.extend === 'on' && f.days && f.known) {
        const d = await extend({ device_id: f.id, days: f.days, price: f.paid || f.price, product: f.product });
        msg += ` · подписка продлена до ${day(d.expires)}`;
      } else if (b.extend === 'on' && !f.known) msg += ' · подписку не продлил: такого устройства нет';
      back(res, msg);
    } catch (e) {
      console.error('ledger add error:', e);
      back(res, 'Ошибка сервера: ' + e.message);
    }
  });

  app.get('/admin/ledger/edit', async (req, res) => {
    await ready;
    const id = parseInt(req.query.id, 10);
    const row = Number.isSafeInteger(id) ? (await pool.query('SELECT * FROM pay_list WHERE id = $1', [id])).rows[0] : null;
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
        'UPDATE pay_list SET device_id = $1, product = $2, price = $3, days = $4, paid = $5, note = $6, created = $7, updated = NOW() WHERE id = $8 RETURNING id',
        [f.id, f.product, f.price, f.days, f.paid, f.note, f.created, id]);
      back(res, r.rows.length ? `✓ Запись №${id} изменена` : 'Запись не найдена');
    } catch (e) {
      console.error('ledger edit error:', e);
      back(res, 'Ошибка сервера: ' + e.message);
    }
  });

  // «+ доплата»: прибавить сумму к «Заплатил». Остаток пересчитывается сам.
  app.post('/admin/ledger/pay', async (req, res) => {
    try {
      await ready;
      const id = parseInt(req.body && req.body.id, 10);
      const amount = parseInt(req.body && req.body.amount, 10);
      if (!Number.isSafeInteger(id) || !(amount > 0 && amount <= 1000000)) return back(res, 'Введите сумму доплаты числом');
      const r = await pool.query('UPDATE pay_list SET paid = paid + $1, updated = NOW() WHERE id = $2 RETURNING device_id, price, paid', [amount, id]);
      const x = r.rows[0];
      back(res, x ? `✓ +${money(amount)} · ${x.device_id}: заплатил ${money(x.paid)} из ${money(x.price)}, ` + (x.price - x.paid > 0 ? `осталось ${money(x.price - x.paid)}` : 'оплачено') : 'Запись не найдена');
    } catch (e) {
      back(res, 'Ошибка сервера: ' + e.message);
    }
  });

  app.post('/admin/ledger/delete', async (req, res) => {
    const id = parseInt(req.body && req.body.id, 10);
    if (Number.isSafeInteger(id)) await pool.query('DELETE FROM pay_list WHERE id = $1', [id]).catch(() => null);
    back(res, 'Запись удалена из журнала (срок подписки не менялся)');
  });

  app.get('/admin/ledger', async (req, res) => {
    try {
      await ready;
      const q = String(req.query.q || '').trim().toLowerCase();
      const onlyDebt = req.query.debt === '1';
      const rows = (await pool.query(`
        SELECT l.*, d.expires, d.cancel_expires, d.device_info, d.status,
               (SELECT phone FROM pay_claims c WHERE c.device_id = l.device_id ORDER BY created DESC LIMIT 1) AS phone
        FROM pay_list l LEFT JOIN devices d ON d.device_id = l.device_id
        ORDER BY l.created DESC, l.id DESC LIMIT 1000`)).rows;

      const mine = rows.filter(r => r.source !== 'auto');
      const auto = rows.filter(r => r.source === 'auto');
      const sum = (list, f) => list.reduce((a, r) => a + f(r), 0);
      const debtTotal = sum(mine, r => Math.max(0, r.price - r.paid));
      const debtors = mine.filter(r => r.price - r.paid > 0).length;
      let shown = mine;
      if (onlyDebt) shown = shown.filter(r => r.price - r.paid > 0);
      if (q) shown = shown.filter(r => [r.device_id, r.device_info, r.phone, r.note].some(v => String(v || '').toLowerCase().includes(q)));

      const label = r => `${escapeHtml(r.device_info || '')}${r.phone ? ' · ' + escapeHtml(r.phone) : ''}`;
      const msg = req.query.msg ? `<div style="background:#ebf8ff;border:1px solid #90cdf4;padding:10px 14px;border-radius:8px;margin-bottom:14px">${escapeHtml(String(req.query.msg))}</div>` : '';
      const kpi = (title, val, col) => `<div style="flex:1;min-width:140px;background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
        <div style="color:#718096;font-size:13px">${title}</div><div style="font-size:22px;font-weight:bold;color:${col || '#1a202c'}">${val}</div></div>`;
      const inp = INP;
      const th = 'text-align:left;padding:9px 10px;background:#2b6cb0;color:#fff;font-size:13px';
      const td = 'padding:9px 10px;border-bottom:1px solid #edf2f7;font-size:14px;vertical-align:top';

      const myRow = r => {
        const left = r.price - r.paid;
        return `<tr${left > 0 ? ' style="background:#fff5f5"' : ''}>
          <td style="${td}">${r.id}<br><span class="small">${day(r.created)}</span></td>
          <td style="${td}"><b>${escapeHtml(r.device_id)}</b><br><span class="small">${label(r)}${r.status === 'banned' ? ' · 🚫 бан' : ''}</span></td>
          <td style="${td}"><b>${money(r.price)}</b><br><span class="small">${PRODUCTS[r.product]}${r.days ? ' · ' + r.days + ' дн.' : ''}</span></td>
          <td style="${td}"><b>${money(r.paid)}</b></td>
          <td style="${td}">${debtCell(r.price, r.paid)}</td>
          <td style="${td}">${escapeHtml(r.note || '')}</td>
          <td style="${td}"><span class="small">радар:</span> ${leftCell(r.expires)}<br><span class="small">отмена:</span> ${leftCell(r.cancel_expires)}</td>
          <td style="${td};white-space:nowrap">
            <form method="POST" action="/admin/ledger/pay" style="display:flex;gap:4px;margin-bottom:6px"><input type="hidden" name="id" value="${r.id}"><input name="amount" type="number" min="1" placeholder="+ сумма" style="width:80px;padding:6px;border:1px solid #cbd5e0;border-radius:6px"><button style="cursor:pointer;background:#38a169;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-weight:bold" title="Прибавить к «Заплатил»">+ доплата</button></form>
            <a href="/admin/ledger/edit?id=${r.id}" style="text-decoration:none">✎ изменить</a>
            <form style="display:inline;margin-left:10px" method="POST" action="/admin/ledger/delete" onsubmit="return confirm('Удалить запись? Срок подписки не изменится.')"><input type="hidden" name="id" value="${r.id}"><button style="background:none;border:none;color:#c53030;cursor:pointer" title="Удалить запись">✕ удалить</button></form>
          </td></tr>`;
      };

      res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Журнал оплат</title>
        <style>body{font-family:system-ui,sans-serif;margin:25px;background:#f0f2f5;color:#1a202c}h2,h3{margin:18px 0 8px}
        table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden}.wrap{overflow-x:auto}a{color:#2b6cb0}.small{font-size:12px;color:#718096}</style></head><body>
        ${adminNav('/admin/ledger')}
        <h2>🧾 Журнал оплат</h2>${msg}
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
          ${kpi('Клиентов записано', mine.length)}${kpi('Стоимость подписок', money(sum(mine, r => r.price)))}
          ${kpi('Заплатили', money(sum(mine, r => r.paid)), '#2f855a')}${kpi('Должны вам', money(debtTotal), debtTotal ? '#c53030' : '')}${kpi('Должников', debtors, debtors ? '#c53030' : '')}
        </div>
        ${formHtml()}

        <h3>✍️ Мои записи</h3>
        <form method="GET" style="margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input name="q" value="${escapeHtml(q)}" placeholder="поиск: ID, телефон, заметка" style="${inp}width:260px">
          <label><input type="checkbox" name="debt" value="1"${onlyDebt ? ' checked' : ''}> только должники</label>
          <button style="${inp}cursor:pointer">Показать</button>
          ${q || onlyDebt ? '<a href="/admin/ledger">сбросить</a>' : ''}
        </form>
        <div class="wrap"><table><tr><th style="${th}">№</th><th style="${th}">Клиент</th><th style="${th}">Стоит</th><th style="${th}">Заплатил</th><th style="${th}">Должен</th><th style="${th}">Заметка</th><th style="${th}">Подписка осталась</th><th style="${th}"></th></tr>
        ${shown.map(myRow).join('') || `<tr><td colspan="8" style="padding:18px;color:#718096">${mine.length ? 'Ничего не найдено' : 'Пока пусто — добавьте клиента формой выше'}</td></tr>`}
        </table></div>

        <h3>🤖 Оплаты MIA: автоматически</h3>
        <div class="small" style="margin-bottom:6px">Сюда попадает оплата, когда вы нажали «✓ Пришло» по заявке. Клиент заплатил полностью. Это отдельный список, ваши записи он не меняет.</div>
        <div class="wrap"><table><tr><th style="${th}">Дата</th><th style="${th}">Клиент</th><th style="${th}">Сумма</th><th style="${th}">Заметка</th><th style="${th}"></th></tr>
        ${auto.map(r => `<tr><td style="${td}">${day(r.created)}</td><td style="${td}"><b>${escapeHtml(r.device_id)}</b><br><span class="small">${label(r)}</span></td>
          <td style="${td}"><b>${money(r.paid)}</b><br><span class="small">${PRODUCTS[r.product]}${r.days ? ' · ' + r.days + ' дн.' : ''}</span></td><td style="${td}">${escapeHtml(r.note || '')}</td>
          <td style="${td}"><form method="POST" action="/admin/ledger/delete" onsubmit="return confirm('Удалить запись из журнала?')"><input type="hidden" name="id" value="${r.id}"><button style="background:none;border:none;color:#c53030;cursor:pointer">✕</button></form></td></tr>`).join('')
          || `<tr><td colspan="5" style="padding:18px;color:#718096">Пока нет подтверждённых заявок</td></tr>`}
        </table></div></body></html>`);
    } catch (e) {
      console.error('ledger page error:', e);
      res.status(500).send('Ошибка: ' + escapeHtml(e.message));
    }
  });

  return { recordClaim, formHtml };
};
