// state.js
class OrderStateStore {
  constructor(side) {
    this.side = side; // 'BUY' | 'SELL'
    this.byLevel = new Map(); // priceLevel (string) -> { orderId, qty, price, status, lastUpdated }
  }

  get(level) {
    return this.byLevel.get(level);
  }

  set(level, meta) {
    this.byLevel.set(level, {
      ...meta,
      lastUpdated: Date.now()
    });
  }

  delete(level) {
    this.byLevel.delete(level);
  }

  clear() {
    this.byLevel.clear();
  }

  snapshot() {
    return new Map(this.byLevel);
  }

  values() {
    return Array.from(this.byLevel.values());
  }
}

module.exports = { OrderStateStore };
