/* =========================================================================
   Binance Futures market data (public endpoint only — no API key, no order
   permission, read-only kline data).
   ========================================================================= */
(function (root) {
  const CONFIG = root.CONFIG;

  function isValidCandle(k) {
    return (
      Number.isFinite(k.open) &&
      Number.isFinite(k.high) &&
      Number.isFinite(k.low) &&
      Number.isFinite(k.close) &&
      k.open > 0 &&
      k.high > 0 &&
      k.low > 0 &&
      k.close > 0
    );
  }

  async function fetchKlines(symbol, interval, limit) {
    const url = `${CONFIG.BINANCE_FAPI_KLINES}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error("Unexpected response shape");
    const klines = raw.map((r) => ({
      openTime: r[0],
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5]),
      closeTime: r[6],
    }));
    // 값이 깨진(NaN, 0 이하) 캔들은 걸러낸다 — 화면에 잘못된 가격이 표시되는 것을 막기 위함.
    // (신호 계산에 필요한 최소 캔들 수 체크는 app.js에서 필터링 이후 길이로 판단한다)
    return klines.filter(isValidCandle);
  }

  root.BinanceApi = { fetchKlines, isValidCandle };
})(typeof window !== "undefined" ? window : globalThis);
