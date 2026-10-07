// Обновление приложения внутри приложения: APK хранится в базе, админ загружает его
// со страницы /admin/apk, приложение скачивает /download/taxiradar.apk и ставит само.
// Пока ни одного APK не загружено — всё как раньше (LATEST_VERSION_* и пост в Telegram).
const crypto = require('crypto');
const express = require('express');

let latest = null; // { version_code, version_name, notes, sha256, size, created } — без самого файла

async function init(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_builds (
      id SERIAL PRIMARY KEY,
      version_code INT NOT NULL,
      version_name VARCHAR(20) NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      sha256 CHAR(64) NOT NULL,
      size INT NOT NULL,
      data BYTEA NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await refresh(pool);
}

async function refresh(pool) {
  const r = await pool.query(
    'SELECT version_code, version_name, notes, sha256, size, created FROM app_builds ORDER BY version_code DESC, id DESC LIMIT 1');
  latest = r.rows[0] || null;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setup(app, pool) {
  init(pool).catch(e => console.error('app_builds init error:', e));

  // Страница загрузки (вход в /admin уже проверен requireAdmin).
  app.get('/admin/apk', async (req, res) => {
    const list = await pool.query('SELECT id, version_code, version_name, size, created, notes FROM app_builds ORDER BY id DESC LIMIT 10');
    res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Обновление приложения</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;background:#090F1C;color:#E8EEF5}
input,textarea,button{width:100%;box-sizing:border-box;margin:6px 0 14px;padding:12px;border-radius:12px;border:1px solid #2A3E57;background:#121F32;color:#E8EEF5;font-size:16px}
button{background:#FFCC00;color:#141414;font-weight:700;border:0}td{padding:6px 8px;border-bottom:1px solid #2A3E57;vertical-align:top}
a{color:#FFCC00}.muted{color:#98A8BA;font-size:14px}</style></head><body>
<p><a href="/admin/view-devices">← Устройства</a></p>
<h2>Выпустить обновление</h2>
<p class="muted">После загрузки у всех водителей с более старой версией появится жёлтая плашка «Обновить» — файл скачается и установится прямо из приложения. Подпись APK приложение проверяет само: чужой файл не установится.</p>
<form id="f">
<label>APK-файл</label><input type="file" id="file" accept=".apk" required>
<label>Номер сборки (versionCode)</label><input id="code" type="number" min="1" required>
<label>Версия (versionName)</label><input id="name" placeholder="1.17" required>
<label>Что нового (покажется водителям после обновления; каждый пункт с новой строки)</label><textarea id="notes" rows="8"></textarea>
<button>Загрузить и разослать</button><div id="st" class="muted"></div></form>
<h3>Загруженные</h3><table>${list.rows.map(b => `<tr><td>${esc(b.version_name)} (${b.version_code})</td><td>${(b.size / 1048576).toFixed(1)} МБ</td><td>${new Date(b.created).toLocaleString('ru-RU')}</td></tr>`).join('') || '<tr><td class="muted">пока нет</td></tr>'}</table>
<script>
document.getElementById('f').onsubmit = async e => {
  e.preventDefault();
  const st = document.getElementById('st'); st.textContent = 'Загружаю…';
  const q = new URLSearchParams({ code: document.getElementById('code').value, name: document.getElementById('name').value, notes: document.getElementById('notes').value });
  const r = await fetch('/admin/apk?' + q, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: document.getElementById('file').files[0] });
  st.textContent = await r.text(); if (r.ok) setTimeout(() => location.reload(), 1500);
};
</script></body></html>`);
  });

  app.post('/admin/apk', express.raw({ type: 'application/octet-stream', limit: '40mb' }), async (req, res) => {
    const code = parseInt(req.query.code, 10);
    const name = String(req.query.name || '').trim().slice(0, 20);
    const notes = String(req.query.notes || '').trim().slice(0, 3000);
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length < 100000) return res.status(400).send('Нет файла');
    // APK — это zip: начинается с «PK».
    if (data[0] !== 0x50 || data[1] !== 0x4b) return res.status(400).send('Это не APK');
    if (!code || !name) return res.status(400).send('Укажите номер сборки и версию');
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    await pool.query('INSERT INTO app_builds (version_code, version_name, notes, sha256, size, data) VALUES ($1, $2, $3, $4, $5, $6)',
      [code, name, notes, sha256, data.length, data]);
    // Старые сборки не храним — база не пухнет: оставляем две последние.
    await pool.query('DELETE FROM app_builds WHERE id NOT IN (SELECT id FROM app_builds ORDER BY id DESC LIMIT 2)');
    await refresh(pool);
    res.send(`Готово: ${name} (${code}) загружена, водители увидят обновление.`);
  });

  app.get('/download/taxiradar.apk', async (req, res) => {
    if (!latest) return res.status(404).send('Нет файла');
    const r = await pool.query('SELECT data, version_name FROM app_builds WHERE sha256 = $1 ORDER BY id DESC LIMIT 1', [latest.sha256]);
    if (!r.rows[0]) return res.status(404).send('Нет файла');
    res.set('Content-Type', 'application/vnd.android.package-archive');
    res.set('Content-Disposition', `attachment; filename="TaxiRadar-${r.rows[0].version_name}.apk"`);
    res.set('Content-Length', String(r.rows[0].data.length));
    res.end(r.rows[0].data);
  });
}

/** Поля для /api/app-config: загруженный APK важнее переменных Railway. */
function configFields(base) {
  if (!latest) return {};
  return {
    latest_version_code: latest.version_code,
    latest_version_name: latest.version_name,
    update_notes: latest.notes,
    apk_url: `${base}/download/taxiradar.apk`,
    apk_sha256: latest.sha256,
    apk_size: latest.size
  };
}

/** Последняя версия: загруженный APK или переменные Railway. */
function latestVersion() {
  if (latest) return { code: latest.version_code, name: latest.version_name };
  return { code: parseInt(process.env.LATEST_VERSION_CODE || '18', 10), name: process.env.LATEST_VERSION_NAME || '1.16' };
}

module.exports = { setup, configFields, latestVersion };
