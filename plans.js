// Тарифы «Отмены»: дни:цена через запятую в CANCEL_TARIFFS (Railway), по умолчанию 3:250,7:450,30:999.
// Чем длиннее срок, тем дешевле день (83 → 64 → 33 лея), поэтому выгоднее всего месяц.
// Пакет «Радар + Отмена» — 30 дней, цена в BUNDLE_PRICE (по умолчанию 999).

function cancelTariffs() {
  const raw = process.env.CANCEL_TARIFFS || '3:250,7:450,30:999';
  const list = raw.split(',').map(p => {
    const [d, pr] = p.split(':').map(x => parseInt(String(x).trim(), 10));
    return { days: d, price: pr };
  }).filter(t => t.days >= 1 && t.days <= 365 && t.price > 0);
  return list.length ? list.sort((a, b) => a.days - b.days) : [{ days: 30, price: 999 }];
}

function bundlePrice() {
  return Number(process.env.BUNDLE_PRICE || process.env.CANCEL_PRICE || 999);
}

module.exports = { cancelTariffs, bundlePrice };
