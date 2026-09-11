(function (root) {
  const MACD_COLORS = { dif: "#E8A33D", dea: "#6FA8DC" };
  const SIGNAL_COLORS = { long: "#2ECC71", short: "#F0554B" };

  function prepCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(rect.width, 200);
    const h = canvas.clientHeight || parseInt(getComputedStyle(canvas).height) || 60;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function drawLine(ctx, arr, cw, yOf, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    arr.forEach((v, i) => {
      if (v == null) return;
      const x = i * cw + cw / 2;
      if (!started) {
        ctx.moveTo(x, yOf(v));
        started = true;
      } else {
        ctx.lineTo(x, yOf(v));
      }
    });
    ctx.stroke();
  }

  // markers: [{ openTime, direction: 'long'|'short' }, ...] — 과거 신호가 발생한 캔들 표시
  function drawPriceChart(canvas, klines, ha, count, markers) {
    const { ctx, w, h } = prepCanvas(canvas);
    const N = count || 60;
    const data = klines.slice(-N);
    const haData = ha.slice(-N);
    if (data.length < 2) return;
    let min = Infinity,
      max = -Infinity;
    data.forEach((k) => {
      min = Math.min(min, k.low);
      max = Math.max(max, k.high);
    });
    const pad = (max - min) * 0.08 || max * 0.01;
    min -= pad;
    max += pad;
    const cw = w / data.length;
    const yOf = (v) => h - ((v - min) / (max - min)) * h;

    data.forEach((k, i) => {
      const x = i * cw + cw / 2;
      const bullish = haData[i].bullish;
      ctx.strokeStyle = ctx.fillStyle = bullish ? "#2ECC71" : "#F0554B";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yOf(k.high));
      ctx.lineTo(x, yOf(k.low));
      ctx.stroke();
      const bodyTop = yOf(Math.max(k.open, k.close));
      const bodyBot = yOf(Math.min(k.open, k.close));
      const bw = Math.max(cw * 0.6, 1);
      ctx.fillRect(x - bw / 2, bodyTop, bw, Math.max(bodyBot - bodyTop, 1));
    });

    // 과거 LONG/SHORT 신호 마커: LONG은 캔들 아래 초록 삼각형(▲), SHORT는 캔들 위 빨간 삼각형(▼)
    if (markers && markers.length) {
      const byTime = new Map(data.map((k, i) => [k.openTime, i]));
      markers.forEach((m) => {
        const i = byTime.get(m.openTime);
        if (i == null) return;
        const x = i * cw + cw / 2;
        const color = SIGNAL_COLORS[m.direction] || "#8B96A5";
        const size = Math.max(Math.min(cw * 0.5, 7), 3);
        ctx.fillStyle = color;
        ctx.beginPath();
        if (m.direction === "long") {
          const y = yOf(data[i].low) + 4;
          ctx.moveTo(x, y + size);
          ctx.lineTo(x - size, y);
          ctx.lineTo(x + size, y);
        } else {
          const y = yOf(data[i].high) - 4;
          ctx.moveTo(x, y - size);
          ctx.lineTo(x - size, y);
          ctx.lineTo(x + size, y);
        }
        ctx.closePath();
        ctx.fill();
      });
    }
  }

  function drawMacdChart(canvas, macd, count) {
    const { ctx, w, h } = prepCanvas(canvas);
    const N = count || 60;
    const dif = macd.dif.slice(-N);
    const dea = macd.dea.slice(-N);
    const hist = dif.map((v, i) => (v != null && dea[i] != null ? v - dea[i] : null));
    const vals = [...dif, ...dea, ...hist].filter((v) => v != null);
    if (vals.length < 2) return;
    let min = Math.min(...vals),
      max = Math.max(...vals);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.15;
    min -= pad;
    max += pad;
    const cw = w / dif.length;
    const yOf = (v) => h - ((v - min) / (max - min)) * h;
    const zeroY = yOf(0);
    ctx.strokeStyle = "#2B3440";
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(w, zeroY);
    ctx.stroke();

    hist.forEach((v, i) => {
      if (v == null) return;
      const x = i * cw + cw / 2;
      ctx.fillStyle = v >= 0 ? "rgba(46,204,113,0.55)" : "rgba(240,85,75,0.55)";
      const top = Math.min(zeroY, yOf(v));
      const bot = Math.max(zeroY, yOf(v));
      const bw = Math.max(cw * 0.35, 1);
      ctx.fillRect(x - bw / 2, top, bw, Math.max(bot - top, 1));
    });
    drawLine(ctx, dif, cw, yOf, MACD_COLORS.dif);
    drawLine(ctx, dea, cw, yOf, MACD_COLORS.dea);
  }

  function drawRsiChart(canvas, rsi, count) {
    const { ctx, w, h } = prepCanvas(canvas);
    const N = count || 60;
    const data = rsi.slice(-N);
    const min = 0,
      max = 100;
    const cw = w / data.length;
    const yOf = (v) => h - ((v - min) / (max - min)) * h;
    ctx.strokeStyle = "#2B3440";
    ctx.setLineDash([3, 3]);
    [30, 50, 70].forEach((lvl) => {
      ctx.beginPath();
      ctx.moveTo(0, yOf(lvl));
      ctx.lineTo(w, yOf(lvl));
      ctx.stroke();
    });
    ctx.setLineDash([]);
    drawLine(ctx, data, cw, yOf, "#E8A33D");
  }

  root.Charts = { drawPriceChart, drawMacdChart, drawRsiChart, prepCanvas, MACD_COLORS, SIGNAL_COLORS };
})(typeof window !== "undefined" ? window : globalThis);
