// stateDiffer.js
function diff(targetLevels, store, qtyChangeTolerance = 0.25) {
  const toPlace = [];
  const toModify = [];
  const toCancel = [];
  const targetKeys = new Set();

  for (const target of targetLevels) {
    const { level, qty, rawPrice } = target;
    targetKeys.add(level);
    
    const existing = store.get(level);
    if (!existing) {
      toPlace.push({ level, qty, rawPrice });
    } else {
      const existingQty = parseFloat(existing.qty);
      const targetQty = parseFloat(qty);
      const qtyDiffPct = Math.abs(existingQty - targetQty) / existingQty;
      
      if (qtyDiffPct > qtyChangeTolerance) {
        toModify.push({ level, qty, rawPrice, orderId: existing.orderId });
      }
    }
  }

  for (const [level, existing] of store.snapshot()) {
    if (!targetKeys.has(level)) {
      toCancel.push({ level, orderId: existing.orderId });
    }
  }

  return { toPlace, toModify, toCancel };
}

module.exports = { diff };
