// Допуск по весу единицы: накладная vs карточка/семья (3 %).
const WEIGHT_TOL = 0.03;

function weightOk(lineG, famG) {
  if (!lineG || !famG) return true; // неизвестный вес не отсекает, решает модель/Елена
  return Math.abs(lineG - famG) / famG <= WEIGHT_TOL;
}

module.exports = { weightOk, WEIGHT_TOL };
