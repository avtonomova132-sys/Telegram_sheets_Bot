function cmToMm(cm) {
  return Math.round(cm * 10);
}

function kgToG(kg) {
  return Math.round(kg * 1000);
}

// sku/articleId — строки; widthCm/lengthCm/heightCm/weightKg — число или
// null, если измерение не удалось распознать уверенно ни на одном фото.
// "Длинна" с двумя Н — не опечатка, так принимает техподдержка Ozon.
function buildResultText({ sku, articleId, widthCm, lengthCm, heightCm, weightKg }) {
  const dimLine = (value, label) =>
    value === null || value === undefined ? `${label} не удалось прочитать, уточните` : `${label} ${cmToMm(value)}`;

  const weightLine =
    weightKg === null || weightKg === undefined
      ? 'Вес не найден (фото весов не распознано) — впиши вручную, если нужно'
      : `Вес ${kgToG(weightKg)}`;

  return [
    `SKU ${sku}`,
    articleId,
    dimLine(widthCm, 'Ширина'),
    dimLine(lengthCm, 'Длинна'),
    dimLine(heightCm, 'Высота'),
    weightLine,
  ].join('\n');
}

module.exports = { buildResultText };
