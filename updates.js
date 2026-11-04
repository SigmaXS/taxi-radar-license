// Обновление приложения внутри приложения: APK хранится в базе, админ загружает его
// со страницы /admin/apk, приложение скачивает /download/taxiradar.apk и ставит само.
// Пока ни одного APK не загружено — всё как раньше (LATEST_VERSION_* и пост в Telegram).
const crypto = require('crypto');
const express = require('express');
const { adminNav } = require('./admin_nav');

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
  // 2026-10-14: файл 2.2 (код 22) по ошибке загрузили как «2.3 (23)» — у водителей на 2.2 висело бы
  // «есть обновление». Возвращаем записи настоящий номер; заодно чиним испорченный значок в тексте.
  await pool.query(
    `UPDATE app_builds SET version_code = 22, version_name = '2.2',
       notes = regexp_replace(notes, '
[^
]*справлен неверный показ', E'
🛠 Исправлен неверный показ')
     WHERE sha256 = 'fa63b7e40621bb2d732bfd8add2eddcd7b70678c6b673de80db1f1cf8210abbf' AND version_code = 23`);
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
    res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Обновление приложения</title>
<style>body{font-family:sans-serif;background:#f0f2f5;padding:25px;margin:0;color:#1a202c}
.wrap{background:#fff;border-radius:10px;padding:20px;max-width:1150px;margin:0 auto 20px;box-shadow:0 4px 12px rgba(0,0,0,.06)}
input,textarea{width:100%;box-sizing:border-box;margin:6px 0 14px;padding:10px;border-radius:6px;border:1px solid #cbd5e0;font-size:15px}
button{background:#2b6cb0;color:#fff;font-weight:bold;border:0;padding:12px 18px;border-radius:8px;font-size:15px;cursor:pointer}
table{width:100%;border-collapse:collapse}td{padding:8px;border-bottom:1px solid #edf2f7;font-size:14px;vertical-align:top}
a{color:#2b6cb0}.muted{color:#4a5568;font-size:14px}</style></head><body>
${adminNav('/admin/apk')}
<div class="wrap"><h2>Выпустить обновление</h2>
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
</script></div></body></html>`);
  });

  app.post('/admin/apk', express.raw({ type: 'application/octet-stream', limit: '40mb' }), async (req, res) => {
    const code = parseInt(req.query.code, 10);
    const name = String(req.query.name || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 20);
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

  // Файл читаем из базы один раз и раздаём из памяти. Раньше каждый запрос тянул 25 МБ из базы заново
  // (с разворотом в текст ×2): когда водители обновлялись разом, серверу не хватало памяти, он падал
  // и перезапускался — отвечал 502 и на скачивание, и на проверку лицензии.
  let cached = null;   // { sha, name, data }
  let loading = null;  // { sha, promise }
  function apkFile(sha) {
    if (cached && cached.sha === sha) return Promise.resolve(cached);
    if (loading && loading.sha === sha) return loading.promise;
    // Куски по 1 МБ: целиком 25 МБ одним ответом база отдаёт в виде строки ×2 по размеру — серверу не хватало памяти.
    const promise = (async () => {
      const head = await pool.query('SELECT id, version_name, size FROM app_builds WHERE sha256 = $1 ORDER BY id DESC LIMIT 1', [sha]);
      const row = head.rows[0];
      if (!row) return (cached = null);
      const parts = [];
      const CHUNK = 1024 * 1024;
      for (let from = 1; from <= row.size; from += CHUNK) {
        const piece = await pool.query('SELECT substring(data from $2::int for $3::int) AS part FROM app_builds WHERE id = $1', [row.id, from, CHUNK]);
        parts.push(piece.rows[0].part);
      }
      const data = Buffer.concat(parts);
      if (data.length !== row.size) throw new Error('apk size mismatch: ' + data.length + ' vs ' + row.size);
      return (cached = { sha, name: row.version_name, data });
    })().finally(() => { if (loading && loading.sha === sha) loading = null; });
    loading = { sha, promise };
    return promise;
  }

  app.get('/download/taxiradar.apk', async (req, res) => {
    if (!latest) return res.status(404).send('Нет файла');
    try {
      const file = await apkFile(latest.sha256);
      if (!file) return res.status(404).send('Нет файла');
      res.set('Content-Type', 'application/vnd.android.package-archive');
      // В имени версии бывают пробел, перевод строки или кириллица — в заголовок годятся только латиница, цифры, точка и дефис.
      const safe = String(file.name).replace(/[^A-Za-z0-9._-]/g, '') || 'update';
      res.set('Content-Disposition', `attachment; filename="TaxiRadar-${safe}.apk"`);
      res.set('Content-Length', String(file.data.length));
      res.end(file.data);
    } catch (e) {
      console.error('apk download error:', e.message);
      if (!res.headersSent) res.status(500).send('Ошибка сервера, попробуйте ещё раз');
    }
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
