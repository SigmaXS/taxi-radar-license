// Поездки: «Мои поездки» в приложении (с объяснением, почему цена Яндекса отличается
// от расчёта) и страница /admin/trips — точность цены и где расчёт ошибается.
const { adminNav } = require('./admin_nav');

// Разница меньше этой — «цена совпала».
const MATCH_LEI = 5;

/**
 * Почему итоговая цена отличается от нашего расчёта: список причин на двух языках.
 * Только то, что видно по данным поездки — без догадок.
 */
function explain(t) {
  const out = [];
  const add = (ru, ro) => out.push({ ru, ro });
  const est = t.est_price, real = t.real_price;
  if (real == null) {
    add(t.finished ? 'Итоговую цену не удалось прочитать с экрана Яндекса.' : 'Поездка ещё не завершена или радар не увидел её конец.',
      t.finished ? 'Prețul final nu a putut fi citit de pe ecranul Yandex.' : 'Cursa nu s-a încheiat sau radarul nu a văzut sfârșitul.');
    return out;
  }
  const diff = real - est;
  if (Math.abs(diff) <= MATCH_LEI) add(`Цена совпала с расчётом (разница ${diff > 0 ? '+' : ''}${diff} L).`, `Prețul a coincis cu estimarea (diferență ${diff > 0 ? '+' : ''}${diff} L).`);
  if (t.note === 'маршрут менялся') add('Клиент поменял маршрут или добавил заезд — Яндекс пересчитал цену.', 'Clientul a schimbat traseul sau a adăugat o oprire — Yandex a recalculat prețul.');
  if (t.note === 'завершён не у Б') add('Поездку завершили не у точки Б — путь получился другим.', 'Cursa s-a încheiat în alt loc decât B — traseul a fost altul.');
  const planMin = t.nav_min != null ? Number(t.nav_min) : Number(t.est_min);
  if (t.real_min != null && planMin > 0) {
    const extra = Math.round(Number(t.real_min) - planMin);
    if (extra >= 4) add(`Ехали на ${extra} мин дольше прогноза (пробки, светофоры или ожидание) — у Яндекса каждая минута ≈ 1 L.`,
      `Ați mers cu ${extra} min mai mult decât estimarea (trafic, semafoare sau așteptare) — la Yandex fiecare minut ≈ 1 L.`);
    if (extra <= -4) add(`Доехали на ${-extra} мин быстрее прогноза — минут к оплате меньше.`, `Ați ajuns cu ${-extra} min mai repede — mai puține minute de plată.`);
  }
  if (t.nav_price != null && Math.abs(t.nav_price - est) > MATCH_LEI) {
    add(`После «Поехали» навигатор Яндекса проложил другой путь: по нему выходило ${t.nav_price} L, а по карточке ${est} L.`,
      `După «Pornim» navigatorul Yandex a ales alt traseu: ${t.nav_price} L, iar pe ofertă ${est} L.`);
  }
  if (t.real_km != null && Number(t.est_km) > 0) {
    const dk = Number(t.real_km) - Number(t.est_km);
    if (Math.abs(dk) >= 1.5) add(`Проехали ${Number(t.real_km).toFixed(1)} км вместо ${Number(t.est_km).toFixed(1)} км по расчёту.`,
      `Ați parcurs ${Number(t.real_km).toFixed(1)} km în loc de ${Number(t.est_km).toFixed(1)} km.`);
  }
  if (t.stops > 0 && Math.abs(diff) > MATCH_LEI) add(`В заказе ${t.stops} заезд(а) — ожидание на заезде Яндекс берёт отдельно.`, `Comanda are ${t.stops} opriri — așteptarea la oprire se plătește separat.`);
  if (out.length === 0 || (out.length === 1 && Math.abs(diff) > MATCH_LEI && out[0].ru.startsWith('Цена совпала'))) {
    add(diff > 0
      ? `Яндекс взял на ${diff} L больше. Обычно это платное ожидание клиента, изменение надбавки во время поездки или объезд.`
      : `Яндекс взял на ${-diff} L меньше. Обычно это более короткий путь, чем считал радар, или скидка клиенту.`,
    diff > 0
      ? `Yandex a luat cu ${diff} L mai mult. De obicei: așteptare plătită, schimbarea suplimentului sau ocolire.`
      : `Yandex a luat cu ${-diff} L mai puțin. De obicei: traseu mai scurt sau reducere pentru client.`);
  }
  return out;
}

/**
 * «Цена неверная»: где именно расчёт разошёлся с Яндексом и что с этим делать.
 * У поездки три цены: радар по карточке (est), навигатор Яндекса после «Поехали» (nav)
 * и итог Яндекса (real). По тому, между какими из них разрыв, видно виноватое звено.
 */
function diagnose(t) {
  const est = t.est_price, nav = t.nav_price, real = t.real_price;
  const pct = (a, b) => b > 0 ? Math.abs(a - b) / b : 0;
  if (real == null) return { code: 'no_price', title: 'Итог Яндекса не прочитался',
    fix: 'Радар не распознал сумму на экране «Заказ завершён». Нужен скриншот этого экрана от водителя — поправим чтение.' };
  if (t.note === 'маршрут менялся') return { code: 'route_changed', title: 'Клиент менял маршрут',
    fix: 'Расчёт тут ни при чём: Яндекс пересчитал цену после изменения. Ничего делать не нужно.' };
  if (nav == null) return { code: 'no_nav', title: 'Радар не увидел навигатор',
    fix: 'Сравнить можно только итог. Если повторяется — пришлите скриншот экрана после «Поехали».' };
  if (Math.abs(real - nav) <= MATCH_LEI && Math.abs(est - nav) > MATCH_LEI) {
    // Навигатор Яндекса угадал, а карточка — нет: ошибка в нашем расчёте до поездки.
    if (pct(Number(t.est_km), Number(t.nav_km)) > 0.2) return { code: 'address', title: `Адрес найден не там: радар ${Number(t.est_km).toFixed(1)} км, Яндекс ${Number(t.nav_km).toFixed(1)} км`,
      fix: 'Одна из точек (А или Б) стоит не на месте. Поставьте правильную точку адреса ниже — дальше у всех водителей будет верно.' };
    if (pct(Number(t.est_min), Number(t.nav_min)) > 0.25) return { code: 'traffic', title: `Пробки: радар ${Math.round(t.est_min)} мин, Яндекс ${Math.round(t.nav_min)} мин`,
      fix: 'Радар учится на поездках сам. Если этот час на вкладке «по часам» красный — данных пока мало, поправится со временем.' };
    return { code: 'tariff', title: 'Км и минуты совпали, а цена — нет',
      fix: 'Вероятно, надбавка или тариф прочитаны с карточки неверно. Нужен скриншот карточки заказа.' };
  }
  if (Math.abs(real - nav) > MATCH_LEI) {
    if (t.real_min != null && Number(t.real_min) - Number(t.nav_min) >= 4) return { code: 'during_trip', title: `В пути дольше прогноза на ${Math.round(Number(t.real_min) - Number(t.nav_min))} мин`,
      fix: 'Пробки или ожидание уже во время поездки — заранее это не предсказать. Ничего делать не нужно.' };
    return { code: 'during_trip', title: 'Цена изменилась уже в поездке',
      fix: 'Платное ожидание, объезд или смена надбавки по ходу. Расчёт до поездки был верным.' };
  }
  return { code: 'ok', title: 'Расчёт совпал с Яндексом', fix: 'Разница в пределах 5 L — ошибки нет.' };
}

module.exports = function setupTrips(app, pool, { member, escapeHtml }) {
  pool.query(`
    ALTER TABLE trip_reports ADD COLUMN IF NOT EXISTS device_id VARCHAR(100);
    ALTER TABLE trip_reports ADD COLUMN IF NOT EXISTS route_from VARCHAR(120);
    ALTER TABLE trip_reports ADD COLUMN IF NOT EXISTS route_to VARCHAR(120);
    CREATE INDEX IF NOT EXISTS trip_reports_device ON trip_reports (device_id, id DESC);
    ALTER TABLE trip_reports ADD COLUMN IF NOT EXISTS client_id VARCHAR(40);
    CREATE UNIQUE INDEX IF NOT EXISTS trip_reports_client ON trip_reports (device_id, client_id) WHERE client_id IS NOT NULL;
    ALTER TABLE trip_reports ADD COLUMN IF NOT EXISTS disputed TIMESTAMP;
    ALTER TABLE trip_reports ADD COLUMN IF NOT EXISTS dispute_status VARCHAR(20);
    ALTER TABLE trip_reports ADD COLUMN IF NOT EXISTS dispute_reason VARCHAR(40);
    ALTER TABLE trip_reports ADD COLUMN IF NOT EXISTS dispute_comment VARCHAR(300);
    ALTER TABLE trip_reports ADD COLUMN IF NOT EXISTS dispute_done BOOLEAN NOT NULL DEFAULT false;
  `).catch(e => console.error('trips init error:', e));

  // Адреса поездок храним 60 дней — для «Моих поездок» хватает; потом остаются только цифры.
  const forget = () => pool.query(
    `UPDATE trip_reports SET route_from = NULL, route_to = NULL WHERE created < NOW() - INTERVAL '60 days' AND route_from IS NOT NULL`
  ).catch(() => {});
  setTimeout(forget, 60e3).unref(); setInterval(forget, 24 * 3600e3).unref();

  // «Мои поездки»: последние 50 поездок этого телефона с объяснениями.
  app.post('/api/trips/mine', member(async (req, res, deviceId) => {
    const rows = (await pool.query(
      `SELECT id, created, tariff, stops, surge, est_price, est_km, est_min, nav_km, nav_min, nav_price,
              real_price, real_km, real_min, note, finished, route_from, route_to, disputed, client_id,
              dispute_done, dispute_status
       FROM trip_reports WHERE device_id = $1 ORDER BY id DESC LIMIT 50`, [deviceId])).rows;
    res.json({
      ok: true,
      trips: rows.map(t => ({
        id: String(t.id), at: new Date(t.created).getTime(), tariff: t.tariff, surge: t.surge, stops: t.stops,
        from: t.route_from || '', to: t.route_to || '',
        est_price: t.est_price, est_km: Number(t.est_km), est_min: Math.round(Number(t.est_min)),
        nav_price: t.nav_price, real_price: t.real_price,
        real_min: t.real_min == null ? null : Math.round(Number(t.real_min)),
        reasons: explain(t),
        disputed: !!t.disputed,
        // Номер поездки на телефоне — по нему «Мои поездки» склеивают сервер и журнал смены.
        key: t.client_id || '',
        dispute_status: t.disputed ? (t.dispute_status || (t.dispute_done ? 'checked' : 'received')) : ''
      }))
    });
  }));

  // Водитель нажал «Цена неверная» в «Моих поездках».
  app.post('/api/trips/dispute', member(async (req, res, deviceId) => {
    const reason = String(req.body.reason || '').slice(0, 40);
    const comment = String(req.body.comment || '').trim().slice(0, 300);
    const r = await pool.query(
      `UPDATE trip_reports SET disputed = NOW(), dispute_reason = $3, dispute_comment = $4, dispute_done = false, dispute_status = 'received'
       WHERE id = $1 AND device_id = $2`, [parseInt(req.body.id, 10) || 0, deviceId, reason || null, comment || null]);
    const t = (await pool.query('SELECT * FROM trip_reports WHERE id = $1', [parseInt(req.body.id, 10) || 0])).rows[0];
    res.json({ ok: r.rowCount > 0, diagnosis: t ? diagnose(t).title : '' });
  }));

  // Итог разбора — водитель видит его в «Моих поездках». «Нужен скриншот» оставляет обращение открытым.
  const STATUSES = ['fixed_address', 'correct', 'need_info', 'checked'];
  app.post('/admin/trips/dispute', async (req, res) => {
    const status = STATUSES.includes(req.body.status) ? req.body.status : 'checked';
    await pool.query('UPDATE trip_reports SET dispute_status = $2, dispute_done = $3 WHERE id = $1',
      [parseInt(req.body.id, 10) || 0, status, status !== 'need_info']);
    res.redirect('/admin/trips');
  });

  const fmt = d => new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau' });
  const lei = v => v == null ? '—' : `${Math.round(Number(v))} L`;

  app.get('/admin/trips', async (req, res) => {
    try {
      const trips = (await pool.query('SELECT * FROM trip_reports ORDER BY id DESC LIMIT 100')).rows;
      const acc = (await pool.query(
        `SELECT COUNT(*) AS n, AVG(real_price - est_price) AS avg_diff, AVG(ABS(real_price - est_price)) AS avg_abs,
           AVG(ABS(real_price - nav_price)) FILTER (WHERE nav_price IS NOT NULL) AS nav_abs
         FROM trip_reports WHERE real_price IS NOT NULL AND note IS NULL AND created > NOW() - INTERVAL '30 days'`)).rows[0];
      // Где расчёт ошибается: по часам (будни/выходные) и по адресам назначения.
      const byHour = (await pool.query(
        `SELECT EXTRACT(HOUR FROM created AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Chisinau')::int AS h,
                EXTRACT(ISODOW FROM created AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Chisinau') >= 6 AS we,
                COUNT(*) AS n, AVG(real_price - est_price) AS dp,
                AVG(real_min - COALESCE(nav_min, est_min)) FILTER (WHERE real_min IS NOT NULL) AS dm
         FROM trip_reports WHERE real_price IS NOT NULL AND note IS NULL AND created > NOW() - INTERVAL '60 days'
         GROUP BY 1, 2`)).rows;
      const places = (await pool.query(
        `SELECT route_to AS place, COUNT(*) AS n, AVG(real_price - est_price) AS dp, AVG(ABS(real_price - est_price)) AS ap
         FROM trip_reports WHERE real_price IS NOT NULL AND note IS NULL AND route_to IS NOT NULL AND created > NOW() - INTERVAL '60 days'
         GROUP BY route_to HAVING COUNT(*) >= 2 ORDER BY AVG(ABS(real_price - est_price)) DESC LIMIT 15`)).rows;

      const cell = (row) => {
        if (!row) return '<span style="color:#a0aec0;">—</span>';
        const dp = Math.round(Number(row.dp));
        const color = Math.abs(dp) <= 5 ? '#38a169' : Math.abs(dp) <= 12 ? '#dd6b20' : '#e53e3e';
        return `<b style="color:${color}">${dp > 0 ? '+' : ''}${dp} L</b>${row.dm != null ? ` · ${Number(row.dm) > 0 ? '+' : ''}${Math.round(Number(row.dm))} мин` : ''} <span style="color:#718096;font-size:12px;">(${row.n})</span>`;
      };
      const hourRows = Array.from({ length: 24 }, (_, h) => {
        const wd = byHour.find(r => r.h === h && !r.we), we = byHour.find(r => r.h === h && r.we);
        if (!wd && !we) return '';
        return `<tr><td>${h}:00</td><td>${cell(wd)}</td><td>${cell(we)}</td></tr>`;
      }).join('');
      const disputes = (await pool.query(
        'SELECT * FROM trip_reports WHERE disputed IS NOT NULL AND NOT dispute_done ORDER BY disputed DESC LIMIT 50')).rows;
      const REASONS = { amount: 'Яндекс взял другую сумму', route: 'Маршрут был другой', other: 'Другое' };
      const pointForm = (label, q) => !q ? '' : `
        <form method="POST" action="/admin/community/address" style="margin:4px 0;">
          <input type="hidden" name="q" value="${escapeHtml(q)}"><input type="hidden" name="back" value="/admin/trips">
          <b>${label}:</b> ${escapeHtml(q)} <a href="https://yandex.ru/maps/?text=${encodeURIComponent('Кишинёв ' + q)}" target="_blank" style="font-size:12px;">карта</a><br>
          <input type="text" name="point" placeholder="Настоящий адрес или 47.0105, 28.8638" style="width:240px;padding:6px;">
          <button name="action" value="set" style="border:0;padding:6px 10px;border-radius:5px;background:#38a169;color:#fff;cursor:pointer;">Поставить точку</button>
        </form>`;
      const disputeRows = disputes.map(t => {
        const d = diagnose(t);
        return `<tr>
          <td style="white-space:nowrap;">${escapeHtml(fmt(t.disputed))}</td>
          <td>${t.route_from ? `${escapeHtml(t.route_from)} → ${escapeHtml(t.route_to || '')}<br>` : ''}
            радар <b>${lei(t.est_price)}</b> · навигатор <b>${lei(t.nav_price)}</b> · Яндекс <b>${lei(t.real_price)}</b><br>
            <span style="font-size:12px;color:#718096;">${escapeHtml(REASONS[t.dispute_reason] || '')}${t.dispute_comment ? ` — «${escapeHtml(t.dispute_comment)}»` : ''}</span></td>
          <td><b>${escapeHtml(d.title)}</b><br><span style="font-size:13px;">${escapeHtml(d.fix)}</span>
            ${d.code === 'address' ? pointForm('А', t.route_from) + pointForm('Б', t.route_to) : ''}</td>
          <td style="white-space:nowrap;"><form method="POST" action="/admin/trips/dispute" style="margin:0;display:grid;gap:4px;"><input type="hidden" name="id" value="${t.id}">
            ${[['fixed_address', 'Адрес исправлен', '#38a169'], ['correct', 'Расчёт верный', '#3182ce'], ['need_info', 'Нужен скриншот', '#dd6b20'], ['checked', 'Проверено', '#718096']]
              .map(([v, l, c]) => `<button name="status" value="${v}" style="border:0;padding:7px 10px;border-radius:6px;background:${c};color:#fff;cursor:pointer;">${l}</button>`).join('')}
            ${t.dispute_status === 'need_info' ? '<span style="font-size:12px;color:#dd6b20;">ждём скриншот</span>' : ''}</form></td>
        </tr>`;
      }).join('');
      const placeRows = places.map(p => `<tr><td>${escapeHtml(p.place)}</td><td>${p.n}</td><td>${lei(p.ap)}</td><td>${Number(p.dp) > 0 ? '+' : ''}${lei(p.dp)}</td></tr>`).join('');
      const tripRows = trips.map(t => `
        <tr>
          <td style="white-space:nowrap;">${escapeHtml(fmt(t.created))}</td>
          <td>${t.route_from ? `${escapeHtml(t.route_from)} → ${escapeHtml(t.route_to || '')}<br>` : ''}<span style="font-size:12px;color:#718096;">${escapeHtml(t.tariff)}${t.stops ? ` +${t.stops} заезд` : ''}${t.surge ? ` · надбавка +${t.surge}` : ''}</span></td>
          <td>${lei(t.est_price)} · ${Number(t.est_km).toFixed(1)} км · ${Math.round(t.est_min)} мин</td>
          <td>${t.nav_price == null ? '—' : `${lei(t.nav_price)} · ${Math.round(t.nav_min)} мин`}</td>
          <td>${t.real_price == null ? (t.finished ? 'не распознана' : '—') : `<b>${lei(t.real_price)}</b>`}${t.real_min != null ? ` · ${Math.round(t.real_min)} мин` : ''}</td>
          <td style="font-size:13px;">${explain(t).map(r => escapeHtml(r.ru)).join('<br>')}</td>
        </tr>`).join('');

      res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Поездки — Taxi Radar</title>
        <style>body{font-family:sans-serif;background:#f0f2f5;padding:25px;margin:0}.card{background:#fff;border-radius:10px;padding:20px;max-width:1150px;margin:0 auto 20px;box-shadow:0 4px 12px rgba(0,0,0,.06)}
        table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #edf2f7;font-size:14px;text-align:left;vertical-align:top}th{background:#2b6cb0;color:#fff}</style></head><body>
        ${adminNav('/admin/trips')}
        <div class="card"><h2>🎯 Точность цены</h2>
          <p>За 30 дней поездок с ценой от Яндекса: <b>${escapeHtml(acc.n)}</b>. Средняя ошибка расчёта с карточки: <b>${lei(acc.avg_abs)}</b>
          (в среднем Яндекс ${acc.avg_diff != null && acc.avg_diff < 0 ? 'дешевле' : 'дороже'} на ${lei(acc.avg_diff == null ? null : Math.abs(acc.avg_diff))}). После «Поехали» по навигатору: <b>${lei(acc.nav_abs)}</b>.</p></div>
        <div class="card"><h2>⚠️ «Цена неверная» от водителей (${disputes.length})</h2>
          <p style="font-size:13px;color:#4a5568;">Водитель отметил поездку в «Моих поездках». Сервер сам сравнивает три цены — радар по карточке, навигатор Яндекса после «Поехали» и итог —
          и пишет, где разошлось и что делать. Если виноват адрес — поставьте точку прямо здесь.</p>
          <table><tr><th>Когда</th><th>Поездка</th><th>Что не так и что делать</th><th></th></tr>${disputeRows || '<tr><td colspan="4">Спорных поездок нет 👍</td></tr>'}</table></div>
        <div class="card"><h2>🚦 Где расчёт ошибается — по часам</h2>
          <p style="font-size:13px;color:#4a5568;">Средняя разница «Яндекс − наш расчёт» и сколько минут поездка шла дольше прогноза; в скобках — число поездок за 60 дней.
          Зелёный — до 5 L, оранжевый — до 12 L, красный — больше. Красные часы — там пробки, которые радар ещё не выучил.</p>
          <table><tr><th>Час</th><th>Будни</th><th>Выходные</th></tr>${hourRows || '<tr><td colspan="3">Пока мало поездок</td></tr>'}</table></div>
        <div class="card"><h2>📍 Где расчёт ошибается — по адресам Б</h2>
          <p style="font-size:13px;color:#4a5568;">Адреса, куда ехали 2+ раза, с самой большой ошибкой. Часто это неточно найденный адрес — его можно поправить в «Сообществе» → «Свои точки адресов».</p>
          <table><tr><th>Куда</th><th>Поездок</th><th>Средняя ошибка</th><th>Яндекс − расчёт</th></tr>${placeRows || '<tr><td colspan="4">Пока мало поездок с адресами (собираются с 1.17)</td></tr>'}</table></div>
        <div class="card"><h2>🚕 Последние поездки</h2>
          <table><tr><th>Когда</th><th>Маршрут</th><th>Наш расчёт</th><th>Навигатор</th><th>Яндекс в конце</th><th>Почему так</th></tr>${tripRows || '<tr><td colspan="6">Поездок пока нет</td></tr>'}</table></div>
        <script>
          document.querySelectorAll('table').forEach(t => {
            const rows = [...t.querySelectorAll('tr')].filter(r => !r.querySelector('th'));
            if (rows.length <= 3) return;
            const hide = on => rows.slice(2).forEach(r => r.style.display = on ? 'none' : '');
            const b = document.createElement('button');
            b.style.cssText = 'margin-top:8px;border:0;padding:8px 14px;border-radius:6px;background:#2b6cb0;color:#fff;cursor:pointer;font-weight:bold;';
            let folded = true;
            const label = () => b.textContent = folded ? 'Развернуть — ещё ' + (rows.length - 2) : 'Свернуть';
            b.onclick = () => { folded = !folded; hide(folded); label(); };
            hide(true); label(); t.after(b);
          });
        </script></body></html>`);
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка загрузки');
    }
  });
};

module.exports.explain = explain;
module.exports.diagnose = diagnose;
