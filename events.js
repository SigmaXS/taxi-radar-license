// События: концерты, матчи, выставки — где и когда начнут выходить люди.
// Админ добавляет на /admin/events; водители видят «Сегодня» и «Ближайшие дни» в приложении
// и ставят напоминание перед окончанием. Перенос и отмена сразу видны у всех.
// Если заданы TELEGRAM_BOT_TOKEN и TELEGRAM_GROUP_CHAT_ID — можно сразу опубликовать в Telegram-группе.
const { adminNav } = require('./admin_nav');

/** «2026-10-09T21:30» из формы — это время по Кишинёву; в базу кладём настоящее UTC. */
function chisinauToUtc(local) {
  const guess = new Date(String(local) + ':00Z');
  if (Number.isNaN(guess.getTime())) return null;
  const tz = new Date(guess.toLocaleString('en-US', { timeZone: 'Europe/Chisinau' }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (tz - utc));
}

const fmt = d => new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const local = d => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Chisinau', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(d)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};

module.exports = function setupEvents(app, pool, { member, escapeHtml, geocoder }) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title VARCHAR(120) NOT NULL,
      place VARCHAR(160) NOT NULL,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      starts TIMESTAMPTZ NOT NULL,
      ends TIMESTAMPTZ NOT NULL,
      people INT,
      note VARCHAR(300) NOT NULL DEFAULT '',
      status VARCHAR(12) NOT NULL DEFAULT 'ok',
      posted BOOLEAN NOT NULL DEFAULT false,
      updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(e => console.error('events init error:', e));

  const groupReady = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_GROUP_CHAT_ID);
  async function post(text) {
    if (!groupReady()) return false;
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_GROUP_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    }).catch(() => null);
    return !!(r && r.ok);
  }
  const announce = e => `🎫 ${e.title}\n📍 ${e.place}\n🕒 ${fmt(e.starts)} — окончание ~${fmt(e.ends).slice(-5)}${e.people ? `\n👥 ~${e.people} человек` : ''}${e.note ? `\n${e.note}` : ''}\n\nВ Taxi Radar: «Полезное» → «События» — можно поставить напоминание перед окончанием.`;

  // Приложение: события, которые ещё не закончились (и отменённые — чтобы снять напоминание), на 7 дней вперёд.
  app.post('/api/events/list', member(async (req, res) => {
    const rows = (await pool.query(
      `SELECT * FROM events WHERE status <> 'deleted' AND ends > NOW() - INTERVAL '30 minutes' AND starts < NOW() + INTERVAL '7 days'
       ORDER BY starts`)).rows;
    res.json({
      ok: true,
      events: rows.map(e => ({
        id: e.id, title: e.title, place: e.place, lat: e.lat, lon: e.lon,
        starts: new Date(e.starts).getTime(), ends: new Date(e.ends).getTime(),
        people: e.people, note: e.note, status: e.status, updated: new Date(e.updated).getTime()
      }))
    });
  }));

  app.get('/admin/events', async (req, res) => {
    const rows = (await pool.query(
      `SELECT * FROM events WHERE status <> 'deleted' AND ends > NOW() - INTERVAL '3 days' ORDER BY starts LIMIT 100`)).rows;
    const list = rows.map(e => `<tr style="${e.status === 'cancelled' ? 'opacity:.5' : ''}">
      <td style="white-space:nowrap;">${escapeHtml(fmt(e.starts))}<br>до ~${escapeHtml(fmt(e.ends).slice(-5))}</td>
      <td><b>${escapeHtml(e.title)}</b>${e.status === 'cancelled' ? ' <span style="color:#e53e3e;">ОТМЕНЕНО</span>' : ''}<br>${escapeHtml(e.place)}
        ${e.lat != null ? ` · <a href="https://yandex.ru/maps/?pt=${e.lon},${e.lat}&z=16" target="_blank">карта</a>` : ' · <span style="color:#dd6b20;">точка не найдена</span>'}
        ${e.people ? `<br>👥 ~${e.people}` : ''}${e.note ? `<br><span style="font-size:13px;color:#4a5568;">${escapeHtml(e.note)}</span>` : ''}</td>
      <td style="white-space:nowrap;"><form method="POST" action="/admin/events" style="margin:0;display:grid;gap:4px;">
        <input type="hidden" name="id" value="${e.id}">
        <input type="datetime-local" name="starts" value="${local(e.starts)}"><input type="datetime-local" name="ends" value="${local(e.ends)}">
        <button name="action" value="move" style="border:0;padding:7px;border-radius:6px;background:#3182ce;color:#fff;cursor:pointer;">Перенести</button>
        ${e.status === 'cancelled'
          ? '<button name="action" value="restore" style="border:0;padding:7px;border-radius:6px;background:#38a169;color:#fff;cursor:pointer;">Вернуть</button>'
          : '<button name="action" value="cancel" style="border:0;padding:7px;border-radius:6px;background:#dd6b20;color:#fff;cursor:pointer;">Отменить</button>'}
        <button name="action" value="delete" onclick="return confirm('Удалить событие совсем?')" style="border:0;padding:7px;border-radius:6px;background:#e53e3e;color:#fff;cursor:pointer;">Удалить</button>
      </form></td></tr>`).join('');
    res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>События — Taxi Radar</title>
      <style>body{font-family:sans-serif;background:#f0f2f5;padding:25px;margin:0}.card{background:#fff;border-radius:10px;padding:20px;max-width:1150px;margin:0 auto 20px;box-shadow:0 4px 12px rgba(0,0,0,.06)}
      table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #edf2f7;font-size:14px;text-align:left;vertical-align:top}th{background:#2b6cb0;color:#fff}
      input,textarea{padding:8px;font-size:15px;border:1px solid #cbd5e0;border-radius:6px;box-sizing:border-box}label{display:block;margin-top:10px;font-weight:bold;font-size:14px}</style></head><body>
      ${adminNav('/admin/events')}
      ${req.query.msg ? `<div class="card" style="background:#ebf8ff;">${escapeHtml(req.query.msg)}</div>` : ''}
      <div class="card"><h2>🎫 Добавить событие</h2>
        <p style="font-size:13px;color:#4a5568;">Водители увидят его в «Полезное» → «События» и смогут поставить напоминание за 15 минут до окончания. Время — по Кишинёву.</p>
        <form method="POST" action="/admin/events">
          <label>Название</label><input name="title" maxlength="120" required style="width:100%" placeholder="Концерт на стадионе Зимбру">
          <label>Место (адрес или название)</label><input name="place" maxlength="160" required style="width:100%" placeholder="Стадион Зимбру, ул. Каля Ешилор 1">
          <label>Точка на карте (необязательно — иначе найдём по адресу)</label><input name="point" style="width:260px" placeholder="47.0105, 28.8638">
          <label>Начало и примерное окончание</label><input type="datetime-local" name="starts" required> — <input type="datetime-local" name="ends" required>
          <label>Сколько примерно людей (необязательно)</label><input type="number" name="people" min="1" max="200000" style="width:160px">
          <label>Заметка (откуда лучше забирать, выходы и т. п.)</label><textarea name="note" maxlength="300" rows="2" style="width:100%"></textarea>
          <label style="font-weight:normal;"><input type="checkbox" name="telegram" value="1" ${groupReady() ? 'checked' : 'disabled'}> Опубликовать в Telegram-группе
            ${groupReady() ? '' : '<span style="color:#718096;">(задайте TELEGRAM_BOT_TOKEN и TELEGRAM_GROUP_CHAT_ID в Railway, бот должен быть в группе)</span>'}</label>
          <p><button name="action" value="add" style="border:0;padding:12px 18px;border-radius:8px;background:#2b6cb0;color:#fff;font-weight:bold;cursor:pointer;">Добавить событие</button></p>
        </form></div>
      <div class="card"><h2>Ближайшие события</h2>
        <table><tr><th>Когда</th><th>Что и где</th><th></th></tr>${list || '<tr><td colspan="3">Пока нет</td></tr>'}</table></div>
    </body></html>`);
  });

  app.post('/admin/events', async (req, res) => {
    const b = req.body;
    let msg = '';
    try {
      const id = parseInt(b.id, 10) || 0;
      const ev = id ? (await pool.query('SELECT * FROM events WHERE id = $1', [id])).rows[0] : null;
      if (b.action === 'add') {
        const starts = chisinauToUtc(b.starts), ends = chisinauToUtc(b.ends);
        const title = String(b.title || '').trim().slice(0, 120), place = String(b.place || '').trim().slice(0, 160);
        if (!title || !place || !starts || !ends || ends <= starts) msg = 'Проверьте название, место и время (окончание позже начала)';
        else {
          let lat = null, lon = null;
          const m = String(b.point || '').match(/(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)/);
          if (m) { lat = Number(m[1]); lon = Number(m[2]); if (lat < 40 && lon > 40) [lat, lon] = [lon, lat]; }
          else { const p = await geocoder.findAny(place).catch(() => null); if (p) { lat = p.lat; lon = p.lon; } }
          const people = parseInt(b.people, 10) || null;
          const r = await pool.query(
            `INSERT INTO events (title, place, lat, lon, starts, ends, people, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [title, place, lat, lon, starts, ends, people, String(b.note || '').trim().slice(0, 300)]);
          let posted = false;
          if (b.telegram) posted = await post(announce(r.rows[0]));
          if (posted) await pool.query('UPDATE events SET posted = true WHERE id = $1', [r.rows[0].id]);
          msg = `Событие добавлено${lat == null ? ' — точку на карте найти не удалось, укажите координаты' : ''}${b.telegram ? (posted ? ', опубликовано в Telegram' : ', в Telegram не отправилось') : ''}`;
        }
      } else if (ev && b.action === 'move') {
        const starts = chisinauToUtc(b.starts), ends = chisinauToUtc(b.ends);
        if (!starts || !ends || ends <= starts) msg = 'Проверьте время';
        else {
          await pool.query('UPDATE events SET starts = $2, ends = $3, updated = NOW() WHERE id = $1', [id, starts, ends]);
          if (ev.posted) await post(`🔁 Перенос: ${ev.title}\n🕒 теперь ${fmt(starts)} — ~${fmt(ends).slice(-5)}\n📍 ${ev.place}`);
          msg = 'Время изменено — у водителей напоминание переставится само';
        }
      } else if (ev && (b.action === 'cancel' || b.action === 'restore')) {
        await pool.query('UPDATE events SET status = $2, updated = NOW() WHERE id = $1', [id, b.action === 'cancel' ? 'cancelled' : 'ok']);
        if (ev.posted && b.action === 'cancel') await post(`❌ Отменено: ${ev.title} (${fmt(ev.starts)})`);
        msg = b.action === 'cancel' ? 'Событие отменено — водителям с напоминанием придёт уведомление' : 'Событие возвращено';
      } else if (ev && b.action === 'delete') {
        await pool.query(`UPDATE events SET status = 'deleted', updated = NOW() WHERE id = $1`, [id]);
        msg = 'Удалено';
      }
    } catch (e) {
      console.error('events admin:', e);
      msg = 'Ошибка';
    }
    res.redirect('/admin/events' + (msg ? '?msg=' + encodeURIComponent(msg) : ''));
  });
};

module.exports.chisinauToUtc = chisinauToUtc;
