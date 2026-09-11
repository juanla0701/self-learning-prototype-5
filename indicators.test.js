// 실행: node indicators.test.js
// 브라우저 없이도 지표 계산과 점수제 신호 판단 로직을 검증하는 테스트.
const assert = require("assert");
const path = require("path");

// signalLog.js가 사용하는 localStorage를 노드 환경에 흉내낸다.
global.localStorage = (function () {
  let store = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();

require(path.join(__dirname, "./config.js"));
require(path.join(__dirname, "./i18n.js"));
require(path.join(__dirname, "./heikinAshi.js"));
require(path.join(__dirname, "./macd.js"));
require(path.join(__dirname, "./rsi.js"));
require(path.join(__dirname, "./signals.js"));
require(path.join(__dirname, "./signalLog.js"));
require(path.join(__dirname, "./tradeLog.js"));
require(path.join(__dirname, "./lossAnalysis.js"));
require(path.join(__dirname, "./lockRange.js"));
require(path.join(__dirname, "./binanceApi.js"));
require(path.join(__dirname, "./state.js"));
require(path.join(__dirname, "./patternLearn.js"));
require(path.join(__dirname, "./backgroundMonitor.js"));

const { HeikinAshi, MACD, RSI, Signals, SignalLog, TradeLog, LossAnalysis, LockRange, BinanceApi, State, PatternLearn, BackgroundMonitor, CONFIG } = global;

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("  \u2713", name);
    passed++;
  } catch (e) {
    console.log("  \u2717", name, "-", e.message);
    failed++;
  }
}

console.log("\n[Heikin Ashi]");
test("HA close = average of OHLC", () => {
  const k = [{ open: 10, high: 12, low: 9, close: 11 }];
  const ha = HeikinAshi.compute(k);
  assert.strictEqual(ha[0].close, (10 + 12 + 9 + 11) / 4);
});
test("HA open of candle 2 = avg(prev HA open, prev HA close)", () => {
  const k = [
    { open: 10, high: 12, low: 9, close: 11 },
    { open: 11, high: 13, low: 10, close: 12 },
  ];
  const ha = HeikinAshi.compute(k);
  const expectedOpen2 = (ha[0].open + ha[0].close) / 2;
  assert.strictEqual(ha[1].open, expectedOpen2);
});
test("bullish flag matches HA close > HA open", () => {
  const k = [{ open: 10, high: 15, low: 9, close: 14 }];
  const ha = HeikinAshi.compute(k);
  assert.strictEqual(ha[0].bullish, ha[0].close > ha[0].open);
});

console.log("\n[MACD]");
test("EMA seeds with SMA then recurses", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const ema = MACD.computeEMA(values, 3);
  const sma3 = (1 + 2 + 3) / 3;
  assert.strictEqual(ema[2], sma3);
  const k = 2 / 4;
  const expectedNext = values[3] * k + sma3 * (1 - k);
  assert.ok(Math.abs(ema[3] - expectedNext) < 1e-9);
});
test("DIF = EMAfast - EMAslow once both exist", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const { dif } = MACD.compute(closes, 12, 26, 9);
  const emaFast = MACD.computeEMA(closes, 12);
  const emaSlow = MACD.computeEMA(closes, 26);
  const idx = 30;
  assert.ok(Math.abs(dif[idx] - (emaFast[idx] - emaSlow[idx])) < 1e-9);
});
test("golden cross detected when DIF crosses above DEA", () => {
  const macd = { dif: [-1, -0.5, 0.2], dea: [0, 0, 0] };
  const cross = Signals.detectCross(macd, 2);
  assert.strictEqual(cross.golden, true);
  assert.strictEqual(cross.dead, false);
});
test("dead cross detected when DIF crosses below DEA", () => {
  const macd = { dif: [1, 0.5, -0.2], dea: [0, 0, 0] };
  const cross = Signals.detectCross(macd, 2);
  assert.strictEqual(cross.dead, true);
  assert.strictEqual(cross.golden, false);
});

console.log("\n[RSI]");
test("RSI = 100 when there are no losses in the period", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const rsi = RSI.compute(closes, 14);
  assert.strictEqual(rsi[14], 100);
});
test("RSI = 0 when there are no gains in the period", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
  const rsi = RSI.compute(closes, 14);
  assert.strictEqual(rsi[14], 0);
});
test("RSI stays within [0,100]", () => {
  const closes = [10, 12, 9, 15, 8, 20, 5, 25, 3, 30, 1, 32, 2, 35, 4, 40];
  const rsi = RSI.compute(closes, 14);
  rsi.forEach((v) => { if (v != null) assert.ok(v >= 0 && v <= 100); });
});

console.log("\n[Signals — multi-timeframe scoring]");

// scoreDirection이 필요로 하는 최소 필드만 채운 가짜 tf 데이터를 만드는 헬퍼
function fakeTf({ ha15, ha5, ha1, ha1Prev, macdCross }) {
  const mkHa = (bullish) => ({ bullish });
  // 1m의 HA 배열과 MACD 배열은 같은 캔들 인덱스를 가리켜야 하므로 길이를 맞춘다.
  const dif = macdCross === "golden" ? [-0.5, 0.3] : macdCross === "dead" ? [0.5, -0.3] : [0.1, 0.1];
  const dea = [0, 0];
  return {
    "15m": { ha: [mkHa(ha15)] },
    "5m": { ha: [mkHa(ha5)] },
    "1m": { ha: [mkHa(ha1Prev), mkHa(ha1)], macd: { dif, dea } },
  };
}

test("all 4 conditions matching LONG => score 100, band strong", () => {
  const tf = fakeTf({ ha15: true, ha5: true, ha1: true, ha1Prev: false, macdCross: "golden" });
  const r = Signals.scoreDirection("long", tf);
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.band, "strong");
  assert.deepStrictEqual(r.conditions, { trend15: true, trend5: true, ha1Flip: true, macdCross: true });
});

test("only 15m+5m trend match (no flip/cross) => score 55, band neutral", () => {
  const tf = fakeTf({ ha15: true, ha5: true, ha1: true, ha1Prev: true, macdCross: null });
  const r = Signals.scoreDirection("long", tf);
  assert.strictEqual(r.score, CONFIG.SCORE_WEIGHTS.trend15 + CONFIG.SCORE_WEIGHTS.trend5); // 55
  assert.strictEqual(r.band, "neutral");
});

test("only ha1Flip + macdCross (trend disagrees) => score 45, band none", () => {
  const tf = fakeTf({ ha15: false, ha5: false, ha1: true, ha1Prev: false, macdCross: "golden" });
  const r = Signals.scoreDirection("long", tf);
  assert.strictEqual(r.score, CONFIG.SCORE_WEIGHTS.ha1Flip + CONFIG.SCORE_WEIGHTS.macdCross); // 45
  assert.strictEqual(r.band, "none");
});

test("LONG and SHORT use the identical scoring structure (symmetric)", () => {
  const tfLong = fakeTf({ ha15: true, ha5: true, ha1: true, ha1Prev: false, macdCross: "golden" });
  const tfShort = fakeTf({ ha15: false, ha5: false, ha1: false, ha1Prev: true, macdCross: "dead" });
  const rLong = Signals.scoreDirection("long", tfLong);
  const rShort = Signals.scoreDirection("short", tfShort);
  assert.strictEqual(rLong.score, rShort.score);
  assert.strictEqual(rLong.band, rShort.band);
});

test("1m/5m/15m don't have to ALL agree for a signal (not strict AND)", () => {
  // 15m/5m는 방향과 일치하지만 1m 조건은 하나도 안 맞는 경우에도 점수(55)가 남아야 한다
  // (엄격한 AND 방식이었다면 여기서 신호가 완전히 0이 되어야 함)
  const tf = fakeTf({ ha15: true, ha5: true, ha1: false, ha1Prev: false, macdCross: null });
  const r = Signals.scoreDirection("long", tf);
  assert.ok(r.score > 0, "score should not collapse to 0 when only some timeframes agree");
});

function buildKline(open, high, low, close, openTime) {
  return { open, high, low, close, openTime, closeTime: openTime + 1 };
}
function buildTrendingKlines(startPrice, step, n, startTime, tfMs) {
  const arr = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    price += step;
    const open = price - step / 2, close = price, high = Math.max(open, close) + 0.2, low = Math.min(open, close) - 0.2;
    arr.push(buildKline(open, high, low, close, startTime + i * tfMs));
  }
  return arr;
}

test("evaluate(): strong uptrend across 1m/5m/15m yields a LONG signal with high score", () => {
  const k15 = buildTrendingKlines(100, 0.5, 40, 0, 15 * 60000);
  const k5 = buildTrendingKlines(100, 0.5, 40, 0, 5 * 60000);
  const k1 = buildTrendingKlines(100, 0.5, 40, 0, 60000);
  const tf = {
    "15m": Signals.computeIndicators(k15),
    "5m": Signals.computeIndicators(k5),
    "1m": Signals.computeIndicators(k1),
  };
  const result = Signals.evaluate(null, "TESTUSDT", tf);
  assert.ok(result.long.score >= result.short.score);
  assert.ok(["strong", "watch", "neutral"].includes(result.status));
});

test("duplicate signal is not re-logged for the same 1m entry candle", () => {
  const k15 = buildTrendingKlines(100, 0.5, 40, 0, 15 * 60000);
  const k5 = buildTrendingKlines(100, 0.5, 40, 0, 5 * 60000);
  const k1 = buildTrendingKlines(100, 0.5, 40, 0, 60000);
  const tf = {
    "15m": Signals.computeIndicators(k15),
    "5m": Signals.computeIndicators(k5),
    "1m": Signals.computeIndicators(k1),
  };
  const first = Signals.evaluate(null, "TESTUSDT", tf);
  const second = Signals.evaluate(first, "TESTUSDT", tf); // 동일 1m 캔들, 상태 변화 없음
  if (first.isNewSignal) {
    assert.strictEqual(second.isNewSignal, false);
  } else {
    assert.ok(true); // 애초에 관심 등급 미만이면 비교 대상 아님
  }
});

console.log("\n[SignalLog — recording structure for future AI use]");
test("append() stores a structured record with symbol/direction/score/conditions/timeframes", () => {
  SignalLog.clear();
  const k15 = buildTrendingKlines(100, 0.5, 40, 0, 15 * 60000);
  const k5 = buildTrendingKlines(100, 0.5, 40, 0, 5 * 60000);
  const k1 = buildTrendingKlines(100, 0.5, 40, 0, 60000);
  const tf = {
    "15m": Signals.computeIndicators(k15),
    "5m": Signals.computeIndicators(k5),
    "1m": Signals.computeIndicators(k1),
  };
  const result = Signals.evaluate(null, "TESTUSDT", tf);
  const rec = SignalLog.append(result, "long");
  assert.strictEqual(rec.symbol, "TESTUSDT");
  assert.strictEqual(rec.direction, "long");
  assert.ok(typeof rec.score === "number");
  assert.ok(rec.conditions && typeof rec.conditions.trend15 === "boolean");
  assert.ok(rec.timeframes["1m"] && rec.timeframes["5m"] && rec.timeframes["15m"]);
  assert.ok(rec.entryTimes["1m"] != null);
  assert.strictEqual(SignalLog.getAll().length, 1);
});

test("SIGNAL_LOG_MAX caps the stored history", () => {
  SignalLog.clear();
  const k15 = buildTrendingKlines(100, 0.5, 40, 0, 15 * 60000);
  const k5 = buildTrendingKlines(100, 0.5, 40, 0, 5 * 60000);
  const tf1mBase = buildTrendingKlines(100, 0.5, 40, 0, 60000);
  for (let i = 0; i < CONFIG.SIGNAL_LOG_MAX + 10; i++) {
    const k1 = tf1mBase.map((k) => ({ ...k, openTime: k.openTime + i * 100000000 }));
    const tf = {
      "15m": Signals.computeIndicators(k15),
      "5m": Signals.computeIndicators(k5),
      "1m": Signals.computeIndicators(k1),
    };
    const result = Signals.evaluate(null, "TESTUSDT", tf);
    SignalLog.append(result, "long");
  }
  assert.strictEqual(SignalLog.getAll().length, CONFIG.SIGNAL_LOG_MAX);
});

test("getMarkersForSymbolTf() returns openTime+direction pairs for chart markers", () => {
  SignalLog.clear();
  const k15 = buildTrendingKlines(100, 0.5, 40, 0, 15 * 60000);
  const k5 = buildTrendingKlines(100, 0.5, 40, 0, 5 * 60000);
  const k1 = buildTrendingKlines(100, 0.5, 40, 0, 60000);
  const tf = {
    "15m": Signals.computeIndicators(k15),
    "5m": Signals.computeIndicators(k5),
    "1m": Signals.computeIndicators(k1),
  };
  const result = Signals.evaluate(null, "TESTUSDT", tf);
  SignalLog.append(result, "long");
  const markers = SignalLog.getMarkersForSymbolTf("TESTUSDT", "1m");
  assert.strictEqual(markers.length, 1);
  assert.strictEqual(markers[0].direction, "long");
  assert.strictEqual(markers[0].openTime, result.entryTimes["1m"]);
});

console.log("\n[TradeLog — user-recorded trades]");

function clearTrades() {
  localStorage.setItem(CONFIG.STORAGE_KEYS.TRADES, "[]");
}

function fakeResult(overrides) {
  const base = {
    symbol: "TESTUSDT",
    updatedAt: Date.now(),
    price: 100,
    tf: {
      "1m": { klines: [{ openTime: 0 }], ha: [{ bullish: true }], macd: { dif: [0.5], dea: [0.1] }, rsi: [60] },
      "5m": { klines: [{ openTime: 0 }], ha: [{ bullish: true }], macd: { dif: [0.5], dea: [0.1] }, rsi: [58] },
      "15m": { klines: [{ openTime: 0 }], ha: [{ bullish: true }], macd: { dif: [0.5], dea: [0.1] }, rsi: [55] },
    },
    long: { direction: "long", score: 80, band: "strong", conditions: { trend15: true, trend5: true, ha1Flip: true, macdCross: true } },
    short: { direction: "short", score: 20, band: "none", conditions: { trend15: false, trend5: false, ha1Flip: false, macdCross: false } },
    leadingDirection: "long",
    status: "strong",
  };
  return Object.assign(base, overrides);
}

test("addEntry() creates an open trade with a snapshot and default notional", () => {
  clearTrades();
  const t1 = TradeLog.addEntry({ symbol: "TESTUSDT", direction: "long", entryPrice: 100, snapshotResult: fakeResult() });
  assert.strictEqual(t1.status, "open");
  assert.strictEqual(t1.symbol, "TESTUSDT");
  assert.strictEqual(t1.notional, CONFIG.DEFAULT_TRADE_NOTIONAL);
  assert.ok(t1.entrySnapshot);
  assert.strictEqual(t1.entrySnapshot.long.score, 80);
});

test("closeTrade() computes pnlPercent/pnlAmount correctly for LONG", () => {
  clearTrades();
  const t1 = TradeLog.addEntry({ symbol: "TESTUSDT", direction: "long", entryPrice: 100, notional: 100, snapshotResult: fakeResult() });
  const closed = TradeLog.closeTrade(t1.id, 110); // +10%
  assert.ok(Math.abs(closed.pnlPercent - 10) < 1e-9);
  assert.ok(Math.abs(closed.pnlAmount - 10) < 1e-9);
  assert.strictEqual(closed.win, true);
  assert.strictEqual(closed.status, "closed");
});

test("closeTrade() computes pnlPercent correctly for SHORT (inverse direction)", () => {
  clearTrades();
  const t1 = TradeLog.addEntry({ symbol: "TESTUSDT", direction: "short", entryPrice: 100, notional: 100, snapshotResult: fakeResult() });
  const closed = TradeLog.closeTrade(t1.id, 90); // price down 10% => short profits +10%
  assert.ok(Math.abs(closed.pnlPercent - 10) < 1e-9);
  assert.strictEqual(closed.win, true);
});

test("getStats() aggregates win rate and total P/L across closed trades only", () => {
  clearTrades();
  const a = TradeLog.addEntry({ symbol: "AAAUSDT", direction: "long", entryPrice: 100, notional: 100 });
  TradeLog.closeTrade(a.id, 110); // win +10
  const b = TradeLog.addEntry({ symbol: "BBBUSDT", direction: "long", entryPrice: 100, notional: 100 });
  TradeLog.closeTrade(b.id, 95); // loss -5
  TradeLog.addEntry({ symbol: "CCCUSDT", direction: "long", entryPrice: 100, notional: 100 }); // still open
  const stats = TradeLog.getStats();
  assert.strictEqual(stats.total, 2); // open trade excluded
  assert.strictEqual(stats.wins, 1);
  assert.ok(Math.abs(stats.winRate - 50) < 1e-9);
  assert.ok(Math.abs(stats.totalPnlAmount - 5) < 1e-9); // +10 - 5
});

test("TRADE_LOG_MAX caps stored trade history", () => {
  clearTrades();
  for (let i = 0; i < CONFIG.TRADE_LOG_MAX + 5; i++) {
    TradeLog.addEntry({ symbol: "TESTUSDT", direction: "long", entryPrice: 100 });
  }
  assert.strictEqual(TradeLog.getAll().length, CONFIG.TRADE_LOG_MAX);
});

console.log("\n[LossAnalysis — hedged, rule-based probable-cause text]");

test("analyze() returns not-applicable for winning or open trades", () => {
  clearTrades();
  const t1 = TradeLog.addEntry({ symbol: "TESTUSDT", direction: "long", entryPrice: 100, snapshotResult: fakeResult() });
  const stillOpen = LossAnalysis.analyze(t1);
  assert.strictEqual(stillOpen.applicable, false);

  const closedWin = TradeLog.closeTrade(t1.id, 110);
  const winResult = LossAnalysis.analyze(closedWin);
  assert.strictEqual(winResult.applicable, false);
});

test("analyze() flags a low entry score as a probable cause", () => {
  clearTrades();
  const weakSnapshot = fakeResult({
    long: { score: 45, band: "none", conditions: { trend15: false, trend5: false, ha1Flip: true, macdCross: true } },
  });
  const t1 = TradeLog.addEntry({ symbol: "TESTUSDT", direction: "long", entryPrice: 100, snapshotResult: weakSnapshot });
  const closed = TradeLog.closeTrade(t1.id, 90); // loss
  const analysis = LossAnalysis.analyze(closed);
  assert.strictEqual(analysis.applicable, true);
  const keys = analysis.reasons.map((r) => r.key);
  assert.ok(keys.includes("lowEntryScore"));
  assert.ok(keys.includes("against15mTrend"));
});

test("analyze() every reason string renders through tp()-style interpolation without leftover braces", () => {
  clearTrades();
  const weakSnapshot = fakeResult({
    long: { score: 45, band: "none", conditions: { trend15: false, trend5: false, ha1Flip: true, macdCross: true } },
  });
  const t1 = TradeLog.addEntry({ symbol: "TESTUSDT", direction: "long", entryPrice: 100, snapshotResult: weakSnapshot });
  const closed = TradeLog.closeTrade(t1.id, 90);
  const analysis = LossAnalysis.analyze(closed);
  const I18N = global.I18N.ko;
  analysis.reasons.forEach((r) => {
    let s = I18N[r.key];
    Object.keys(r.params).forEach((k) => { s = s.replace(new RegExp("\\{" + k + "\\}", "g"), r.params[k]); });
    assert.ok(!/\{[a-zA-Z]+\}/.test(s), `leftover placeholder in ${r.key}: ${s}`);
  });
});

test("analyze() handles a trade with no snapshot gracefully", () => {
  clearTrades();
  const t1 = TradeLog.addEntry({ symbol: "TESTUSDT", direction: "long", entryPrice: 100 }); // no snapshotResult
  const closed = TradeLog.closeTrade(t1.id, 90);
  const analysis = LossAnalysis.analyze(closed);
  assert.strictEqual(analysis.applicable, true);
  assert.strictEqual(analysis.reasons[0].key, "noSnapshotData");
});

console.log("\n[LockRange — LOCK ~ UNLOCK 구간 최고가/최저가]");

test("start() initializes high/low/basePrice all to the lock-in price", () => {
  const lock = LockRange.start(100, 1000);
  assert.strictEqual(lock.basePrice, 100);
  assert.strictEqual(lock.high, 100);
  assert.strictEqual(lock.low, 100);
  assert.strictEqual(lock.lockedAt, 1000);
});

test("update() raises the high on a new higher price (LOCK → price up → high 갱신)", () => {
  let lock = LockRange.start(100);
  lock = LockRange.update(lock, 105);
  assert.strictEqual(lock.high, 105);
  assert.strictEqual(lock.low, 100); // 최저가는 그대로
});

test("update() lowers the low on a new lower price (LOCK → price down → low 갱신)", () => {
  let lock = LockRange.start(100);
  lock = LockRange.update(lock, 95);
  assert.strictEqual(lock.low, 95);
  assert.strictEqual(lock.high, 100); // 최고가는 그대로
});

test("update() tracks both directions across a sequence of ticks", () => {
  let lock = LockRange.start(100);
  [103, 98, 107, 101, 94, 102].forEach((p) => { lock = LockRange.update(lock, p); });
  assert.strictEqual(lock.high, 107);
  assert.strictEqual(lock.low, 94);
  assert.strictEqual(lock.basePrice, 100); // 기준가는 변하지 않는다
});

test("update() ignores non-finite prices (data error) without corrupting the range", () => {
  let lock = LockRange.start(100);
  lock = LockRange.update(lock, NaN);
  lock = LockRange.update(lock, undefined);
  lock = LockRange.update(lock, -1 / 0);
  assert.strictEqual(lock.high, 100);
  assert.strictEqual(lock.low, 100);
});

test("update() returns the same reference when nothing changed (avoids needless writes)", () => {
  let lock = LockRange.start(100);
  lock = LockRange.update(lock, 105);
  const before = lock;
  const after = LockRange.update(lock, 102); // 최고/최저 갱신 없음
  assert.strictEqual(after, before);
});

test("LOCK → price moves both ways → UNLOCK confirms the final high/low/unlockPrice", () => {
  let lock = LockRange.start(100, 1000);
  [103, 98, 107, 94].forEach((p) => { lock = LockRange.update(lock, p); });
  const confirmed = LockRange.confirm(lock, "BTCUSDT", 99, 2000);
  assert.strictEqual(confirmed.symbol, "BTCUSDT");
  assert.strictEqual(confirmed.basePrice, 100);
  assert.strictEqual(confirmed.high, 107);
  assert.strictEqual(confirmed.low, 94);
  assert.strictEqual(confirmed.unlockPrice, 99);
  assert.strictEqual(confirmed.lockedAt, 1000);
  assert.strictEqual(confirmed.unlockedAt, 2000);
});

test("re-LOCK starts a brand new range, independent of the previous confirmed range", () => {
  let lockA = LockRange.start(100);
  lockA = LockRange.update(lockA, 120);
  const confirmedA = LockRange.confirm(lockA, "BTCUSDT", 110);
  assert.strictEqual(confirmedA.high, 120);

  // 다시 LOCK: 완전히 새로운 구간으로 시작해야 하고 이전 구간(confirmedA)의 값에 영향받지 않아야 한다
  let lockB = LockRange.start(200);
  assert.strictEqual(lockB.high, 200);
  assert.strictEqual(lockB.low, 200);
  lockB = LockRange.update(lockB, 190);
  assert.strictEqual(lockB.low, 190);
  assert.strictEqual(lockB.high, 200);
  // 이전 구간 데이터가 새 구간에 섞여 들어가지 않았는지 확인
  assert.notStrictEqual(lockB.high, confirmedA.high);
});

test("pctChange() computes signed percentage vs base, and returns null for invalid input", () => {
  assert.ok(Math.abs(LockRange.pctChange(100, 110) - 10) < 1e-9);
  assert.ok(Math.abs(LockRange.pctChange(100, 90) - -10) < 1e-9);
  assert.strictEqual(LockRange.pctChange(0, 100), null);
  assert.strictEqual(LockRange.pctChange(100, NaN), null);
  assert.strictEqual(LockRange.pctChange(null, 100), null);
});

console.log("\n[LockRange — P/L% tracking anchored to the record-start price]");

test("worked example from the spec: 100 → 105 → 110 → 95 → 103", () => {
  // 📋 기록 시작가: $100
  let lock = LockRange.start(100, 1000);

  // 현재가 $105 → 현재 손익률 +5.00%
  lock = LockRange.update(lock, 105);
  assert.ok(Math.abs(LockRange.pctChange(lock.basePrice, 105) - 5) < 1e-9);

  // $110까지 상승 → 최고가 110 / 최고 손익률 +10.00%
  lock = LockRange.update(lock, 110);
  assert.strictEqual(lock.high, 110);
  assert.ok(Math.abs(LockRange.pctChange(lock.basePrice, lock.high) - 10) < 1e-9);

  // $95까지 하락 → 최저가 95 / 최저 손익률 -5.00%
  lock = LockRange.update(lock, 95);
  assert.strictEqual(lock.low, 95);
  assert.ok(Math.abs(LockRange.pctChange(lock.basePrice, lock.low) - -5) < 1e-9);

  // 이후 $103 → 현재 손익률 +3.00%, 최고/최저는 그대로 유지
  lock = LockRange.update(lock, 103);
  assert.strictEqual(lock.high, 110); // 최고가 유지
  assert.strictEqual(lock.low, 95);   // 최저가 유지
  assert.ok(Math.abs(LockRange.pctChange(lock.basePrice, 103) - 3) < 1e-9);

  // UNLOCK ($103에서) → 확정 기록에 모든 필드가 정확히 저장되는지 확인
  const confirmed = LockRange.confirm(lock, "BTCUSDT", 103, 2000);
  assert.strictEqual(confirmed.startPrice, 100);
  assert.strictEqual(confirmed.basePrice, 100); // 락인 가격 = 기록 시작가
  assert.strictEqual(confirmed.endPrice, 103);
  assert.strictEqual(confirmed.high, 110);
  assert.strictEqual(confirmed.low, 95);
  assert.ok(Math.abs(confirmed.maxPnlPercent - 10) < 1e-9);
  assert.ok(Math.abs(confirmed.minPnlPercent - -5) < 1e-9);
  assert.ok(Math.abs(confirmed.endPnlPercent - 3) < 1e-9);
  assert.strictEqual(confirmed.recordStartAt, 1000);
  assert.strictEqual(confirmed.recordEndAt, 2000);
  assert.strictEqual(confirmed.lockedAt, 1000);
  assert.strictEqual(confirmed.unlockedAt, 2000);
});

test("P/L% tracking is always anchored to the record-start price, not any intermediate price", () => {
  let lock = LockRange.start(200);
  lock = LockRange.update(lock, 220); // +10% at the time, but base must stay 200
  lock = LockRange.update(lock, 180); // -10% at the time
  const confirmed = LockRange.confirm(lock, "ETHUSDT", 210);
  assert.strictEqual(confirmed.basePrice, 200);
  assert.ok(Math.abs(confirmed.maxPnlPercent - 10) < 1e-9); // vs 200, not vs any other price
  assert.ok(Math.abs(confirmed.minPnlPercent - -10) < 1e-9);
  assert.ok(Math.abs(confirmed.endPnlPercent - 5) < 1e-9); // (210-200)/200*100
});

test("re-LOCK resets P/L tracking to a fresh base, independent of the previous confirmed record", () => {
  let lockA = LockRange.start(100);
  lockA = LockRange.update(lockA, 150); // +50%
  const confirmedA = LockRange.confirm(lockA, "BTCUSDT", 140);
  assert.ok(Math.abs(confirmedA.maxPnlPercent - 50) < 1e-9);

  // 다시 LOCK: 새 기준가로 손익률 계산이 완전히 새로 시작되어야 한다
  let lockB = LockRange.start(500);
  lockB = LockRange.update(lockB, 510); // +2%, 이전 구간의 50%와 무관해야 함
  const confirmedB = LockRange.confirm(lockB, "BTCUSDT", 505);
  assert.ok(Math.abs(confirmedB.maxPnlPercent - 2) < 1e-9);
  assert.notStrictEqual(confirmedB.basePrice, confirmedA.basePrice);
});

console.log("\n[BinanceApi — malformed price data is rejected, not displayed]");

test("isValidCandle() accepts a normal candle", () => {
  assert.strictEqual(BinanceApi.isValidCandle({ open: 100, high: 101, low: 99, close: 100.5 }), true);
});
test("isValidCandle() rejects NaN fields", () => {
  assert.strictEqual(BinanceApi.isValidCandle({ open: NaN, high: 101, low: 99, close: 100.5 }), false);
});
test("isValidCandle() rejects zero/negative prices", () => {
  assert.strictEqual(BinanceApi.isValidCandle({ open: 0, high: 101, low: 99, close: 100.5 }), false);
  assert.strictEqual(BinanceApi.isValidCandle({ open: 100, high: 101, low: -5, close: 100.5 }), false);
});

console.log("\n[State — LOCK과 기록(recording)의 분리 (요구사항 2/9)]");

test("LOCK만으로는 State.recording이 생기지 않는다 (기록은 별도 버튼으로만 시작)", () => {
  State.saveLock(null);
  State.saveRecording(null);
  State.saveLock({ symbol: "BTCUSDT", basePrice: 100, lockedAt: 1000 });
  assert.strictEqual(State.lock.symbol, "BTCUSDT");
  assert.strictEqual(State.recording, null); // LOCK만 했을 뿐 기록은 시작 안 됨
});

test("State.lock과 State.recording은 서로 독립적으로 갱신된다", () => {
  State.saveLock({ symbol: "BTCUSDT", basePrice: 100, lockedAt: 1000 });
  const rec = LockRange.start(100, 2000);
  rec.symbol = "BTCUSDT";
  rec.direction = "long";
  State.saveRecording(rec);
  assert.strictEqual(State.lock.basePrice, 100);
  assert.strictEqual(State.recording.symbol, "BTCUSDT");
  // 기록 중 가격 갱신이 LOCK 상태(State.lock)에는 영향을 주지 않는다
  const updated = LockRange.update(State.recording, 110);
  State.saveRecording(updated);
  assert.strictEqual(State.recording.high, 110);
  assert.strictEqual(State.lock.basePrice, 100); // 그대로
});

test("알림 ON/OFF(State.notifyEnabled)는 LOCK/기록 상태 변경에 영향받지 않는다 (요구사항 9)", () => {
  State.saveNotify(true);
  State.saveLock({ symbol: "ETHUSDT", basePrice: 2000, lockedAt: 1000 });
  State.saveRecording(Object.assign(LockRange.start(2000), { symbol: "ETHUSDT", direction: "long" }));
  assert.strictEqual(State.notifyEnabled, true);
  State.saveLock(null);
  State.saveRecording(null);
  assert.strictEqual(State.notifyEnabled, true); // 여전히 ON 유지
});

console.log("\n[State — LOCK 기록(records) CRUD, signals와 분리 (요구사항 4/5/7)]");

test("addLockRecord()로 저장한 기록은 localStorage에도 즉시 반영된다", () => {
  localStorage.setItem(CONFIG.STORAGE_KEYS.LOCK_RECORDS, "[]");
  State.lockRecords = [];
  const record = { id: "rec1", symbol: "BTCUSDT", direction: "long", basePrice: 100, high: 110, low: 95, endPnlPercent: 3 };
  State.addLockRecord(record);
  assert.strictEqual(State.lockRecords.length, 1);
  const persisted = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.LOCK_RECORDS));
  assert.strictEqual(persisted.length, 1);
  assert.strictEqual(persisted[0].id, "rec1");
});

test("removeLockRecord()는 해당 기록만 지우고 나머지는 유지한다 (개별 삭제)", () => {
  localStorage.setItem(CONFIG.STORAGE_KEYS.LOCK_RECORDS, "[]");
  State.lockRecords = [];
  State.addLockRecord({ id: "a", symbol: "BTCUSDT" });
  State.addLockRecord({ id: "b", symbol: "ETHUSDT" });
  State.addLockRecord({ id: "c", symbol: "SOLUSDT" });
  State.removeLockRecord("b");
  assert.strictEqual(State.lockRecords.length, 2);
  assert.ok(State.lockRecords.find((r) => r.id === "a"));
  assert.ok(!State.lockRecords.find((r) => r.id === "b"));
  assert.ok(State.lockRecords.find((r) => r.id === "c"));
  const persisted = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.LOCK_RECORDS));
  assert.strictEqual(persisted.length, 2);
});

test("LOCK 기록은 SignalLog(신호 데이터)와 완전히 분리된 저장소를 쓴다", () => {
  SignalLog.clear();
  localStorage.setItem(CONFIG.STORAGE_KEYS.LOCK_RECORDS, "[]");
  State.lockRecords = [];
  State.addLockRecord({ id: "x", symbol: "BTCUSDT", direction: "long" });
  assert.strictEqual(SignalLog.getAll().length, 0); // signals 쪽엔 아무 영향 없음
  assert.strictEqual(State.lockRecords.length, 1);
});

console.log("\n[State — UNLOCK 후 다른 종목 재LOCK (요구사항 8)]");

test("UNLOCK(둘 다 null로 초기화)하면 곧바로 다른 종목을 LOCK할 수 있다", () => {
  // 종목 A: LOCK -> 기록 -> UNLOCK
  State.saveLock({ symbol: "AAAUSDT", basePrice: 10, lockedAt: 1 });
  State.saveRecording(Object.assign(LockRange.start(10), { symbol: "AAAUSDT", direction: "long" }));
  State.saveLock(null);
  State.saveRecording(null);
  assert.strictEqual(State.lock, null);
  assert.strictEqual(State.recording, null);

  // 종목 B: 곧바로 LOCK 가능해야 함
  State.saveLock({ symbol: "BBBUSDT", basePrice: 20, lockedAt: 2 });
  assert.strictEqual(State.lock.symbol, "BBBUSDT");
  assert.strictEqual(State.recording, null); // 기록은 아직 시작 안 됨(요구사항 2 유지)

  // 종목 B UNLOCK -> 종목 C도 문제없이 LOCK
  State.saveLock(null);
  State.saveLock({ symbol: "CCCUSDT", basePrice: 30, lockedAt: 3 });
  assert.strictEqual(State.lock.symbol, "CCCUSDT");
});

console.log("\n[레버리지 반영 최종 손익률 (요구사항 5) — app.js와 동일한 계산식]");

// app.js와 동일한 공식: LONG = endPnlPercent × leverage, SHORT = endPnlPercent × -1 × leverage
function finalPnl(direction, leverage, endPnlPercent) {
  return endPnlPercent * leverage * (direction === "short" ? -1 : 1);
}

test("LONG 10x: +2% 가격 상승 → +20%", () => {
  assert.ok(Math.abs(finalPnl("long", 10, 2) - 20) < 1e-9);
});
test("LONG 10x: -2% 가격 하락 → -20%", () => {
  assert.ok(Math.abs(finalPnl("long", 10, -2) - -20) < 1e-9);
});
test("SHORT 10x: -2% 가격 하락 → +20%", () => {
  assert.ok(Math.abs(finalPnl("short", 10, -2) - 20) < 1e-9);
});
test("SHORT 10x: +2% 가격 상승 → -20%", () => {
  assert.ok(Math.abs(finalPnl("short", 10, 2) - -20) < 1e-9);
});
test("레버리지 1x는 원래 가격 변동률과 동일하다 (기존 손익 계산 구조 보존)", () => {
  assert.ok(Math.abs(finalPnl("long", 1, 3) - 3) < 1e-9);
  assert.ok(Math.abs(finalPnl("short", 1, 3) - -3) < 1e-9);
});
test("maxPnlPercent/minPnlPercent(구간 최고·최저 손익률)는 레버리지 미적용 그대로 유지되어야 한다", () => {
  // LockRange.confirm()이 반환하는 max/minPnlPercent 자체는 이번 수정으로 손대지 않았음을 재확인
  let lock = LockRange.start(100);
  lock = LockRange.update(lock, 110);
  lock = LockRange.update(lock, 95);
  const confirmed = LockRange.confirm(lock, "BTCUSDT", 103);
  assert.ok(Math.abs(confirmed.maxPnlPercent - 10) < 1e-9); // 레버리지 미적용 원본
  assert.ok(Math.abs(confirmed.minPnlPercent - -5) < 1e-9);
});

console.log("\n[PatternLearn — 경량 자가학습 신호 필터 (요구사항 1)]");

function clearPatternLearn() {
  localStorage.setItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN, JSON.stringify({ pending: [], stats: {} }));
}
function fakeSignalResult(direction, conditions, price, updatedAt) {
  const dir = { score: 80, band: "strong", conditions };
  const other = { score: 20, band: "none", conditions: { trend15: false, trend5: false, ha1Flip: false, macdCross: false } };
  return {
    symbol: "TESTUSDT",
    price,
    updatedAt: updatedAt || Date.now(),
    long: direction === "long" ? dir : other,
    short: direction === "short" ? dir : other,
  };
}
const COND = { trend15: true, trend5: true, ha1Flip: true, macdCross: true };

test("샘플이 부족하면(LEARN_MIN_SAMPLES 미만) 항상 통과시킨다 (소수 실패로 차단 금지)", () => {
  clearPatternLearn();
  const r = fakeSignalResult("long", COND, 100);
  assert.strictEqual(PatternLearn.getConfidence(PatternLearn.buildPatternKey("coin", "TESTUSDT", "long", COND)), null);
  assert.strictEqual(PatternLearn.shouldAlert(r, "long"), true);
});

test("recordPending() → evaluatePending()으로 승/패가 패턴별로 누적된다 (추가 API 호출 없이 기존 가격 재사용)", () => {
  clearPatternLearn();
  const entryTime = Date.now() - CONFIG.LEARN_HORIZON_MS - 1000; // 판정 시점 지남
  const r = fakeSignalResult("long", COND, 100, entryTime);
  PatternLearn.recordPending(r, "long");
  // 이후 가격이 올랐다 = LONG 성공
  PatternLearn.evaluatePending({ TESTUSDT: { price: 110 } });
  const key = PatternLearn.buildPatternKey("coin", "TESTUSDT", "long", COND);
  // 샘플 1개뿐이라 아직 MIN_SAMPLES 미만 → 여전히 null(필터링 안 함)이어야 정상
  assert.strictEqual(PatternLearn.getConfidence(key), null);
});

test("충분한 샘플이 쌓이면 신뢰도가 계산되고, 낮은 신뢰도는 알림만 차단한다(신호 자체는 유지)", () => {
  clearPatternLearn();
  const key = PatternLearn.buildPatternKey("coin", "TESTUSDT", "long", COND);
  const N = CONFIG.LEARN_MIN_SAMPLES;
  // 대부분 실패하는 패턴을 인위적으로 재현 (승 1, 패 N-1)
  for (let i = 0; i < N; i++) {
    const entryTime = Date.now() - CONFIG.LEARN_HORIZON_MS - 1000;
    const r = fakeSignalResult("long", COND, 100, entryTime);
    PatternLearn.recordPending(r, "long");
    const finalPrice = i === 0 ? 110 : 90; // 첫 건만 성공(상승), 나머지는 실패(하락)
    PatternLearn.evaluatePending({ TESTUSDT: { price: finalPrice } });
  }
  const confidence = PatternLearn.getConfidence(key);
  assert.ok(confidence != null);
  assert.ok(confidence < CONFIG.LEARN_CONFIDENCE_THRESHOLD);

  const r = fakeSignalResult("long", COND, 100);
  assert.strictEqual(PatternLearn.shouldAlert(r, "long"), false); // 알림만 차단
});

test("판정 시간이 아직 안 지난 대기 항목은 건드리지 않는다", () => {
  clearPatternLearn();
  const r = fakeSignalResult("long", COND, 100, Date.now()); // 방금 발생 — 아직 판정 시점 아님
  PatternLearn.recordPending(r, "long");
  PatternLearn.evaluatePending({ TESTUSDT: { price: 999 } }); // 가격이 어떻든 아직 판정 안 됨
  assert.strictEqual(PatternLearn.getConfidence(PatternLearn.buildPatternKey("coin", "TESTUSDT", "long", COND)), null);
});

console.log("\n[10초 미만 기록 폐기 (요구사항 4) — app.js와 동일한 판정식]");

test("9.9초 경과 → 저장 안 함 / 10초 이상 → 정상 저장 (경계값 그대로)", () => {
  // app.js: durationMs >= CONFIG.MIN_RECORD_DURATION_MS 일 때만 저장
  assert.strictEqual(9900 >= CONFIG.MIN_RECORD_DURATION_MS, false);
  assert.strictEqual(10000 >= CONFIG.MIN_RECORD_DURATION_MS, true);
  assert.strictEqual(CONFIG.MIN_RECORD_DURATION_MS, 10000);
});

console.log("\n[PatternLearn — ON/OFF 토글 (요구사항 1)]");

function setLearnEnabled(v) {
  State.saveLearnEnabled(v);
}
function clearLearn() {
  localStorage.setItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN, JSON.stringify({ pending: [], stats: {}, entries: [] }));
}

test("기본값은 ON이다 (기존 앱 동작 유지)", () => {
  // localStorage를 건드리지 않은 새 State라면 true여야 하지만, 이 테스트 파일에선 이미
  // 이전 테스트들이 State를 공유하므로, 여기서는 저장된 값이 실제로 반영되는지만 확인한다.
  setLearnEnabled(true);
  assert.strictEqual(State.learnEnabled, true);
  assert.strictEqual(PatternLearn.isEnabled(), true);
});

test("OFF로 바꾸면 isEnabled()가 즉시 false를 반환한다", () => {
  setLearnEnabled(false);
  assert.strictEqual(PatternLearn.isEnabled(), false);
  setLearnEnabled(true); // 다른 테스트에 영향 없도록 복구
});

test("OFF 상태에서는 recordPending()이 아무 것도 저장하지 않는다", () => {
  clearLearn();
  setLearnEnabled(false);
  const r = fakeSignalResult("long", COND, 100);
  PatternLearn.recordPending(r, "long");
  const raw = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN));
  assert.strictEqual(raw.pending.length, 0);
  setLearnEnabled(true);
});

test("OFF 상태에서는 evaluatePending()이 대기 항목을 그대로 둔다(삭제도 판정도 안 함)", () => {
  clearLearn();
  setLearnEnabled(true);
  const entryTime = Date.now() - CONFIG.LEARN_HORIZON_MS - 1000;
  const r = fakeSignalResult("long", COND, 100, entryTime);
  PatternLearn.recordPending(r, "long"); // ON 상태에서 정상 등록
  setLearnEnabled(false);
  PatternLearn.evaluatePending({ TESTUSDT: { price: 110 } }); // OFF이므로 무시되어야 함
  const raw = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN));
  assert.strictEqual(raw.pending.length, 1); // 그대로 남아있어야 함 (삭제되지 않음)
  setLearnEnabled(true);
  PatternLearn.evaluatePending({ TESTUSDT: { price: 110 } }); // 다시 ON하면 이어서 판정됨
  const raw2 = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN));
  assert.strictEqual(raw2.pending.length, 0);
});

test("OFF 상태에서는 getConfidence()/shouldAlert()가 기존 데이터를 무시한다(항상 통과)", () => {
  clearLearn();
  setLearnEnabled(true);
  const key = PatternLearn.buildPatternKey("coin", "TESTUSDT", "long", COND);
  // 신뢰도가 낮은 패턴을 미리 만들어둔다 (표본 충분, 낮은 승률)
  for (let i = 0; i < CONFIG.LEARN_MIN_SAMPLES; i++) {
    const entryTime = Date.now() - CONFIG.LEARN_HORIZON_MS - 1000;
    const r = fakeSignalResult("long", COND, 100, entryTime);
    PatternLearn.recordPending(r, "long");
    PatternLearn.evaluatePending({ TESTUSDT: { price: i === 0 ? 110 : 90 } });
  }
  setLearnEnabled(false);
  assert.strictEqual(PatternLearn.getConfidence(key), null); // OFF면 데이터가 있어도 null
  const r = fakeSignalResult("long", COND, 100);
  assert.strictEqual(PatternLearn.shouldAlert(r, "long"), true); // OFF면 항상 통과
  setLearnEnabled(true);
  assert.notStrictEqual(PatternLearn.getConfidence(key), null); // 다시 ON하면 기존 데이터 그대로 사용됨
});

console.log("\n[PatternLearn — 저장 데이터 상세화 + 하위호환 (요구사항 2, 6)]");

test("evaluatePending()이 승/패 확정 시 상세 entries도 함께 기록한다(종목/방향/조건/손익률 포함)", () => {
  clearLearn();
  const entryTime = Date.now() - CONFIG.LEARN_HORIZON_MS - 1000;
  const r = fakeSignalResult("long", COND, 100, entryTime);
  PatternLearn.recordPending(r, "long");
  PatternLearn.evaluatePending({ TESTUSDT: { price: 110 } });
  const raw = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN));
  assert.strictEqual(raw.entries.length, 1);
  const e = raw.entries[0];
  assert.strictEqual(e.source, "signal");
  assert.strictEqual(e.symbol, "TESTUSDT");
  assert.strictEqual(e.direction, "long");
  assert.deepStrictEqual(e.conditions, COND);
  assert.strictEqual(e.result, "WIN");
  assert.ok(Math.abs(e.pnlPercent - 10) < 1e-9);
});

test("category 불명 legacy 데이터는 코인/주식으로 추측하지 않고 legacy 영역에 보존된다(요구사항 10)", () => {
  // 이전 버전이 기록하던 형태 재현: stats는 구버전 전역 카운터, entries에는 category 필드가 없음.
  const legacy = {
    pending: [],
    stats: { "long:1111": { wins: 3, losses: 1 } }, // 구버전 전역 통계 — 절대 삭제되면 안 됨
    entries: [
      { source: "signal", symbol: "BTCUSDT", direction: "long", conditions: COND, result: "WIN", pnlPercent: 4 },
      { source: "signal", symbol: "BTCUSDT", direction: "long", conditions: COND, result: "LOSS", pnlPercent: -2 },
      { source: "lockin", symbol: "ETHUSDT", direction: "short", conditions: COND, result: "WIN", pnlPercent: 3 },
    ],
  };
  localStorage.setItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN, JSON.stringify(legacy));

  // load()가 호출되는 순간 자동 마이그레이션. category가 없으므로 새 학습 공간엔 들어가지 않아야 한다.
  const coinTotals = PatternLearn.getTotals("coin");
  const stockTotals = PatternLearn.getTotals("stock");
  assert.strictEqual(coinTotals.total, 0); // 코인으로 추측해서 넣지 않음
  assert.strictEqual(stockTotals.total, 0); // 주식으로도 넣지 않음

  // 원본과 legacy 보존 확인
  const raw = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN));
  assert.deepStrictEqual(raw.stats["long:1111"], { wins: 3, losses: 1 }); // 구버전 stats 그대로
  assert.strictEqual(raw.entries.length, 3); // entries 원본 그대로 (삭제 금지)
  assert.strictEqual(raw.schemaVersion, 2);
  const legacyStats = PatternLearn.getLegacyStats();
  const legacyTotal = Object.values(legacyStats).reduce((n, v) => n + v.wins + v.losses, 0);
  assert.strictEqual(legacyTotal, 3); // 3건이 legacy 영역에 안전하게 보존됨

  // 마이그레이션 이후 새로 기록하면 정확한 category로 독립 저장된다.
  State.setCategory("BTCUSDT", "coin");
  PatternLearn.recordLockResult({ symbol: "BTCUSDT", direction: "long", conditions: COND, pnlPercent: 5 });
  assert.strictEqual(PatternLearn.getStatsFor("coin", "BTCUSDT").total, 1); // legacy와 섞이지 않고 1건만
  assert.strictEqual(PatternLearn.getStatsFor("stock", "BTCUSDT").total, 0);
});

console.log("\n[PatternLearn — Lock-in 결과 연결 (요구사항 3)]");

test("recordLockResult()는 손익률 부호로 WIN/LOSS를 판정하고 stats/entries에 반영한다", () => {
  clearLearn();
  const key = PatternLearn.buildPatternKey("coin", "ETHUSDT", "short", COND);
  PatternLearn.recordLockResult({ symbol: "ETHUSDT", direction: "short", conditions: COND, pnlPercent: 12.5 });
  const info = PatternLearn.getPatternInfo(key);
  assert.strictEqual(info.wins, 1);
  assert.strictEqual(info.losses, 0);
  const raw = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN));
  assert.strictEqual(raw.entries[0].source, "lockin");
  assert.strictEqual(raw.entries[0].symbol, "ETHUSDT");
});

test("recordLockResult()는 자가학습 OFF면 아무 것도 저장하지 않는다", () => {
  clearLearn();
  setLearnEnabled(false);
  PatternLearn.recordLockResult({ symbol: "BTCUSDT", direction: "long", conditions: COND, pnlPercent: 5 });
  const raw = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN));
  assert.strictEqual(raw.entries.length, 0);
  setLearnEnabled(true);
});

test("recordLockResult()는 조건 스냅샷이 없으면 무시한다(예전 방식 호환)", () => {
  clearLearn();
  PatternLearn.recordLockResult({ symbol: "BTCUSDT", direction: "long", conditions: null, pnlPercent: 5 });
  const raw = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN));
  assert.strictEqual(raw.entries.length, 0);
});

console.log("\n[PatternLearn — 종목별/카테고리별 독립 학습 (요구사항 4)]");

test("BTCUSDT의 학습 결과가 ETHUSDT 판단에 섞이지 않는다", () => {
  clearLearn();
  const btcKey = PatternLearn.buildPatternKey("coin", "BTCUSDT", "long", COND);
  const ethKey = PatternLearn.buildPatternKey("coin", "ETHUSDT", "long", COND);
  for (let i = 0; i < CONFIG.LEARN_MIN_SAMPLES; i++) {
    PatternLearn.recordLockResult({ symbol: "BTCUSDT", direction: "long", conditions: COND, pnlPercent: 5 }); // BTC는 전부 승
  }
  assert.strictEqual(PatternLearn.getPatternInfo(ethKey).total, 0); // ETH는 전혀 영향 없음
  assert.strictEqual(PatternLearn.getPatternInfo(btcKey).total, CONFIG.LEARN_MIN_SAMPLES);
  const btcConf = PatternLearn.getConfidence(btcKey);
  const ethConf = PatternLearn.getConfidence(ethKey);
  assert.ok(btcConf != null);
  assert.strictEqual(ethConf, null); // 데이터가 없으므로 학습 부족 → 필터링 없이 통과
});

test("같은 조건이어도 종목이 다르면 완전히 다른 패턴키를 생성한다(섞임 없음)", () => {
  const k1 = PatternLearn.buildPatternKey("coin", "BTCUSDT", "long", COND);
  const k2 = PatternLearn.buildPatternKey("coin", "ETHUSDT", "long", COND);
  assert.notStrictEqual(k1, k2);
});

test("카테고리가 다르면(코인 vs 주식) 같은 심볼 문자열이어도 키가 분리된다", () => {
  const k1 = PatternLearn.buildPatternKey("coin", "AAPL", "long", COND);
  const k2 = PatternLearn.buildPatternKey("stock", "AAPL", "long", COND);
  assert.notStrictEqual(k1, k2);
});

test("신규 종목(학습 데이터 0개)은 기존 신호가 그대로 통과한다(과도한 차단 금지, 요구사항 5)", () => {
  clearLearn();
  const r = fakeSignalResult("long", COND, 100);
  r.symbol = "BRANDNEWUSDT";
  assert.strictEqual(PatternLearn.shouldAlert(r, "long"), true);
});

console.log("\n[PatternLearn — 학습 데이터가 쌓일수록 영향력이 점진적으로 증가 (요구사항 5)]");

test("표본이 최소 기준을 갓 넘겼을 때는 신뢰도가 중립(0.5)에 가깝게 스무딩된다", () => {
  clearLearn();
  // 표본 LEARN_MIN_SAMPLES개, 전부 패배 → 원본 승률은 0%지만, 스무딩 때문에 0보다는 확실히 높게 나와야 한다
  for (let i = 0; i < CONFIG.LEARN_MIN_SAMPLES; i++) {
    PatternLearn.recordLockResult({ symbol: "SMOOTHUSDT", direction: "long", conditions: COND, pnlPercent: -1 });
  }
  const key = PatternLearn.buildPatternKey("coin", "SMOOTHUSDT", "long", COND);
  const conf = PatternLearn.getConfidence(key);
  assert.ok(conf > 0); // 원본 승률(0%)보다 확실히 위로 당겨져 있어야 함(중립 쪽으로 스무딩)
  assert.ok(conf < 0.5); // 그래도 실제로 전부 졌으니 0.5보다는 낮아야 함
});

test("표본이 훨씬 많이 쌓이면 신뢰도가 실제 승률에 근접하게 수렴한다", () => {
  clearLearn();
  const symbol = "CONVERGEUSDT";
  const N = CONFIG.LEARN_MIN_SAMPLES * 8; // 표본을 충분히 많이 쌓는다
  for (let i = 0; i < N; i++) {
    PatternLearn.recordLockResult({ symbol, direction: "long", conditions: COND, pnlPercent: -1 }); // 전부 패배 → 실제 승률 0%
  }
  const key = PatternLearn.buildPatternKey("coin", symbol, "long", COND);
  const conf = PatternLearn.getConfidence(key);
  // 공식: (wins + PRIOR*0.5) / (total + PRIOR) = (0 + 10*0.5) / (80 + 10) ≈ 0.056
  const expected = (0 + CONFIG.LEARN_PRIOR_WEIGHT * 0.5) / (N + CONFIG.LEARN_PRIOR_WEIGHT);
  assert.ok(Math.abs(conf - expected) < 1e-9);
  assert.ok(conf < 0.1); // 표본이 적을 때(0.5 근처)보다 실제 승률(0%)에 훨씬 가까워짐
});

console.log("\n[설정 — 최대 종목 수 확대 (요구사항 2)]");

test("MAX_SYMBOLS가 50으로 확대되었다", () => {
  assert.strictEqual(CONFIG.MAX_SYMBOLS, 50);
});
test("SYMBOL_UPDATE_CONCURRENCY가 설정되어 있다(50개를 한 번에 몰아서 요청하지 않기 위함)", () => {
  assert.ok(CONFIG.SYMBOL_UPDATE_CONCURRENCY > 0 && CONFIG.SYMBOL_UPDATE_CONCURRENCY < CONFIG.MAX_SYMBOLS);
});

console.log("\n[State — 종목 카테고리 분리 (요구사항 3, 7)]");

test("카테고리 지정이 없는 기존 종목은 기본 카테고리(coin)로 자동 처리된다(마이그레이션)", () => {
  assert.strictEqual(State.getCategory("NEVERSETUSDT"), "coin");
});
test("setCategory()로 지정한 카테고리가 유지된다", () => {
  State.setCategory("AAPLSTOCK", "stock");
  assert.strictEqual(State.getCategory("AAPLSTOCK"), "stock");
});
test("종목을 감시 목록에서 제거해도(State.symbols) 카테고리/학습 데이터는 별개로 남아있다(요구사항 7)", () => {
  State.setCategory("KEEPLEARNUSDT", "coin");
  PatternLearn.recordLockResult({ symbol: "KEEPLEARNUSDT", direction: "long", conditions: COND, pnlPercent: 5 });
  // 감시 목록에서 제거하는 것을 흉내(State.symbols 자체를 바꿔도 카테고리/학습 데이터는 무관)
  State.saveSymbols(State.symbols.filter((s) => s !== "KEEPLEARNUSDT"));
  assert.strictEqual(State.getCategory("KEEPLEARNUSDT"), "coin"); // 카테고리 정보 유지
  assert.ok(PatternLearn.getSymbolStats("KEEPLEARNUSDT").total >= 1); // 학습 데이터도 유지
});

console.log("\n[PatternLearn — 요약 통계 및 초기화 (요구사항 5, 7)]");

test("getTotals(category)는 해당 시장의 패턴만 합산한다", () => {
  clearLearn();
  State.setCategory("A", "coin");
  State.setCategory("B", "stock");
  PatternLearn.recordLockResult({ symbol: "A", direction: "long", conditions: COND, pnlPercent: 5 });   // coin 1승
  PatternLearn.recordLockResult({ symbol: "B", direction: "short", conditions: COND, pnlPercent: -3 }); // stock 1패
  // 카테고리를 명시하면 그 시장만 집계되어야 한다(섞이면 실패)
  const coin = PatternLearn.getTotals("coin");
  assert.strictEqual(coin.wins, 1);
  assert.strictEqual(coin.losses, 0); // 주식의 1패가 섞이면 안 됨
  const stock = PatternLearn.getTotals("stock");
  assert.strictEqual(stock.wins, 0);  // 코인의 1승이 섞이면 안 됨
  assert.strictEqual(stock.losses, 1);
  // 카테고리를 생략하면 전 시장 합계(전체 현황 확인용)
  const all = PatternLearn.getTotals();
  assert.strictEqual(all.wins, 1);
  assert.strictEqual(all.losses, 1);
});

test("reset()은 학습 데이터만 지우고, 다른 localStorage 키(거래기록/LOCK기록/설정)는 건드리지 않는다", () => {
  clearLearn();
  PatternLearn.recordLockResult({ symbol: "A", direction: "long", conditions: COND, pnlPercent: 5 });
  localStorage.setItem(CONFIG.STORAGE_KEYS.TRADES, JSON.stringify([{ id: "keep-me" }]));
  localStorage.setItem(CONFIG.STORAGE_KEYS.LOCK_RECORDS, JSON.stringify([{ id: "keep-me-too" }]));
  PatternLearn.reset();
  const totals = PatternLearn.getTotals();
  assert.strictEqual(totals.entries, 0);
  assert.strictEqual(totals.wins, 0);
  // 다른 키들은 그대로 있어야 한다
  assert.strictEqual(JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.TRADES))[0].id, "keep-me");
  assert.strictEqual(JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.LOCK_RECORDS))[0].id, "keep-me-too");
});

console.log("\n[독립성 테스트 — 요구사항 13 (TEST 1~7)]");

// 이 블록은 요구사항 13의 TEST 1~7을 순서대로, 하나의 깨끗한 상태에서 누적 진행한다.
function freshLearn() {
  localStorage.setItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN,
    JSON.stringify({ pending: [], stats: {}, entries: [], statsBySymbol: {}, legacyStats: {}, schemaVersion: 2 }));
}
function learnN(category, symbol, n, pnl) {
  State.setCategory(symbol, category);
  for (let i = 0; i < n; i++) {
    PatternLearn.recordLockResult({ symbol, direction: "long", conditions: COND, pnlPercent: pnl });
  }
}

freshLearn();
State.saveLearnEnabled(true);

test("TEST 1: 코인 BTCUSDT 10개 생성 → coin/BTCUSDT=10, stock 전체=0", () => {
  learnN("coin", "BTCUSDT", 10, 5);
  assert.strictEqual(PatternLearn.getStatsFor("coin", "BTCUSDT").total, 10);
  assert.strictEqual(PatternLearn.getTotals("stock").total, 0);
  assert.strictEqual(PatternLearn.getTotals("coin").total, 10);
});

test("TEST 2: 주식 A 5개 생성 → coin/BTCUSDT=10 유지, stock/A=5 (합쳐지면 실패)", () => {
  learnN("stock", "STOCKA", 5, 5);
  assert.strictEqual(PatternLearn.getStatsFor("coin", "BTCUSDT").total, 10); // 그대로
  assert.strictEqual(PatternLearn.getStatsFor("stock", "STOCKA").total, 5);
  assert.strictEqual(PatternLearn.getTotals("coin").total, 10);  // 코인 시장에 주식 5건이 섞이지 않음
  assert.strictEqual(PatternLearn.getTotals("stock").total, 5);  // 주식 시장에 코인 10건이 섞이지 않음
});

test("TEST 3: ETHUSDT 3개 생성 → BTCUSDT=10 그대로, ETHUSDT=3 (BTC가 13이면 실패)", () => {
  learnN("coin", "ETHUSDT", 3, 5);
  assert.strictEqual(PatternLearn.getStatsFor("coin", "BTCUSDT").total, 10); // 13이 되면 실패
  assert.strictEqual(PatternLearn.getStatsFor("coin", "ETHUSDT").total, 3);
  assert.strictEqual(PatternLearn.getTotals("coin").total, 13); // 시장 합계는 10+3
});

test("TEST 4: 주식 B 2개 생성 → 주식A=5, 주식B=2 (합쳐지면 실패)", () => {
  learnN("stock", "STOCKB", 2, 5);
  assert.strictEqual(PatternLearn.getStatsFor("stock", "STOCKA").total, 5); // 7이 되면 실패
  assert.strictEqual(PatternLearn.getStatsFor("stock", "STOCKB").total, 2);
  assert.strictEqual(PatternLearn.getTotals("stock").total, 7);
});

test("TEST 5: BTCUSDT의 높은 승률이 ETHUSDT/주식 confidence에 영향을 주지 않는다", () => {
  freshLearn();
  learnN("coin", "BTCUSDT", CONFIG.LEARN_MIN_SAMPLES * 2, 5); // BTC: 전부 승 (높은 승률, 표본 충분)
  const btcKey = PatternLearn.buildPatternKey("coin", "BTCUSDT", "long", COND);
  const ethKey = PatternLearn.buildPatternKey("coin", "ETHUSDT", "long", COND);
  const stockKey = PatternLearn.buildPatternKey("stock", "STOCKA", "long", COND);
  assert.ok(PatternLearn.getConfidence(btcKey) > 0.7);          // BTC는 높은 신뢰도(스무딩 적용값)
  assert.strictEqual(PatternLearn.getConfidence(ethKey), null);  // ETH는 데이터 없음 → null(필터 미적용)
  assert.strictEqual(PatternLearn.getConfidence(stockKey), null);// 주식도 데이터 없음 → null

  // shouldAlert까지 분리 확인: 데이터 없는 종목은 기존 전략 그대로 통과해야 한다(요구사항 7)
  State.setCategory("ETHUSDT", "coin");
  State.setCategory("STOCKA", "stock");
  const mkResult = (sym) => ({ symbol: sym, long: { conditions: COND }, short: { conditions: COND } });
  assert.strictEqual(PatternLearn.shouldAlert(mkResult("ETHUSDT"), "long"), true);
  assert.strictEqual(PatternLearn.shouldAlert(mkResult("STOCKA"), "long"), true);
});

test("TEST 5b: 같은 심볼명이 코인/주식 양쪽에 있어도 학습 공간이 완전히 분리된다", () => {
  freshLearn();
  // 동일 심볼 문자열 "XYZ"를 코인/주식 양쪽에서 학습시킨다 (카테고리만 다름)
  const coinKey = PatternLearn.buildPatternKey("coin", "XYZ", "long", COND);
  const stockKey = PatternLearn.buildPatternKey("stock", "XYZ", "long", COND);
  State.setCategory("XYZ", "coin");
  for (let i = 0; i < CONFIG.LEARN_MIN_SAMPLES; i++) {
    PatternLearn.recordLockResult({ symbol: "XYZ", direction: "long", conditions: COND, pnlPercent: 5 }); // coin: 전부 승
  }
  State.setCategory("XYZ", "stock");
  for (let i = 0; i < CONFIG.LEARN_MIN_SAMPLES; i++) {
    PatternLearn.recordLockResult({ symbol: "XYZ", direction: "long", conditions: COND, pnlPercent: -5 }); // stock: 전부 패
  }
  assert.strictEqual(PatternLearn.getStatsFor("coin", "XYZ").wins, CONFIG.LEARN_MIN_SAMPLES);
  assert.strictEqual(PatternLearn.getStatsFor("coin", "XYZ").losses, 0);
  assert.strictEqual(PatternLearn.getStatsFor("stock", "XYZ").wins, 0);
  assert.strictEqual(PatternLearn.getStatsFor("stock", "XYZ").losses, CONFIG.LEARN_MIN_SAMPLES);
  // confidence도 정반대로 나와야 한다(섞였다면 둘 다 0.5가 됨).
  // 스무딩 공식 (wins + PRIOR*0.5)/(total + PRIOR) 기준, 표본 10·PRIOR 10이면
  // 전승=0.75 / 전패=0.25가 이론값이다.
  const expectHigh = (CONFIG.LEARN_MIN_SAMPLES + CONFIG.LEARN_PRIOR_WEIGHT * 0.5) / (CONFIG.LEARN_MIN_SAMPLES + CONFIG.LEARN_PRIOR_WEIGHT);
  const expectLow = (0 + CONFIG.LEARN_PRIOR_WEIGHT * 0.5) / (CONFIG.LEARN_MIN_SAMPLES + CONFIG.LEARN_PRIOR_WEIGHT);
  assert.ok(Math.abs(PatternLearn.getConfidence(coinKey) - expectHigh) < 1e-9);
  assert.ok(Math.abs(PatternLearn.getConfidence(stockKey) - expectLow) < 1e-9);
  assert.ok(PatternLearn.getConfidence(coinKey) > PatternLearn.getConfidence(stockKey)); // 섞이지 않았음을 명확히 확인
});

test("TEST 7: 저장된 데이터를 다시 읽어도(재실행 시뮬레이션) category+symbol별 값이 그대로 유지된다", () => {
  freshLearn();
  learnN("coin", "BTCUSDT", 10, 5);
  learnN("coin", "ETHUSDT", 3, 5);
  learnN("stock", "STOCKA", 5, 5);
  // localStorage 내용을 그대로 두고 다시 조회하면(=앱 재실행 후 첫 조회) 동일해야 한다
  const raw = localStorage.getItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN);
  localStorage.setItem(CONFIG.STORAGE_KEYS.PATTERN_LEARN, raw); // 디스크 왕복
  assert.strictEqual(PatternLearn.getStatsFor("coin", "BTCUSDT").total, 10);
  assert.strictEqual(PatternLearn.getStatsFor("coin", "ETHUSDT").total, 3);
  assert.strictEqual(PatternLearn.getStatsFor("stock", "STOCKA").total, 5);
  assert.strictEqual(PatternLearn.getTotals("coin").total, 13);
  assert.strictEqual(PatternLearn.getTotals("stock").total, 5);
});

test("자가학습 OFF면 카테고리 무관하게 저장/반영이 멈추고, 데이터는 삭제되지 않는다(요구사항 9)", () => {
  freshLearn();
  learnN("coin", "BTCUSDT", CONFIG.LEARN_MIN_SAMPLES, 5);
  const beforeTotal = PatternLearn.getStatsFor("coin", "BTCUSDT").total;
  State.saveLearnEnabled(false);
  learnN("coin", "BTCUSDT", 5, 5); // OFF 상태에서 추가 시도
  assert.strictEqual(PatternLearn.getStatsFor("coin", "BTCUSDT").total, beforeTotal); // 늘지 않음
  const key = PatternLearn.buildPatternKey("coin", "BTCUSDT", "long", COND);
  assert.strictEqual(PatternLearn.getConfidence(key), null); // OFF면 기존 데이터도 미반영
  State.saveLearnEnabled(true);
  assert.strictEqual(PatternLearn.getStatsFor("coin", "BTCUSDT").total, beforeTotal); // 데이터는 보존됨
  assert.ok(PatternLearn.getConfidence(key) != null); // 다시 ON하면 그대로 사용
});

console.log("\n[BackgroundMonitor — 웹 환경(Capacitor 없음)에서는 안전하게 아무 동작 안 함]");

test("window.Capacitor가 없으면 isSupported()는 false", () => {
  assert.strictEqual(BackgroundMonitor.isSupported(), false);
});

// start()/stop()은 async 함수라 항상 Promise를 반환하므로, 위의 동기 test() 헬퍼 대신
// 여기서 직접 await로 확인한다 (하네스 자체는 건드리지 않음, 최소 추가).
(async () => {
  try {
    const s1 = await BackgroundMonitor.start();
    const s2 = await BackgroundMonitor.stop();
    assert.strictEqual(s1, false);
    assert.strictEqual(s2, false);
    console.log("  \u2713 Capacitor가 없을 때 start()/stop()은 에러 없이 false를 반환한다 (웹 버전 무영향)");
    passed++;
  } catch (e) {
    console.log("  \u2717 start()/stop() 웹 폴백 -", e.message);
    failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
