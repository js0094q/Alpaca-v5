export function seedOpeningRange(runtime, date, { low = 100, high = 101 } = {}) {
  const open = Date.parse(`${date}T13:30:00Z`);
  const status = runtime.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: open - 1_000 });
  const observations = [
    runtime.onTrade({ timestamp: open + 1_000, price: low, tradeId: `or-low-${date}` }),
    runtime.onTrade({ timestamp: open + 14 * 60_000, price: high, tradeId: `or-high-${date}` }),
  ];
  return { status, observations };
}

export function triggerBreakout(runtime, date, price = 102, tradeId = `breakout-${date}`) {
  return runtime.onTrade({ timestamp: Date.parse(`${date}T13:45:00Z`), price, tradeId });
}
