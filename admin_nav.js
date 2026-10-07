// Общая шапка админки: большие кнопки-вкладки вверху каждой страницы,
// чтобы переключаться одним нажатием, а не искать маленькие ссылки.
const TABS = [
  ['/admin/view-devices', '📱 Устройства'],
  ['/admin/trips', '🚕 Поездки'],
  ['/admin/community', '💬 Сообщество'],
  ['/admin/messages', '📣 Сообщения'],
  ['/admin/weekly', '📊 Сводка'],
  ['/admin/crashes', '🐞 Ошибки'],
  ['/admin/apk', '⬆️ Обновление']
];

function adminNav(active) {
  return `<div style="position:sticky;top:0;z-index:10;background:#f0f2f5;padding:10px 0 12px;margin:-25px -25px 18px;">
  <div style="max-width:1150px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;padding:0 12px;">
  ${TABS.map(([href, label]) => `<a href="${href}" style="display:block;text-align:center;padding:14px 10px;border-radius:12px;font-weight:bold;font-size:16px;text-decoration:none;font-family:sans-serif;${href === active
    ? 'background:#2b6cb0;color:#fff;box-shadow:0 4px 10px rgba(43,108,176,.35);'
    : 'background:#fff;color:#2b6cb0;border:2px solid #bee3f8;'}">${label}</a>`).join('')}
  </div></div>`;
}

module.exports = { adminNav };
