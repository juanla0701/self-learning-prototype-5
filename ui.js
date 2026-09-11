(function (root) {
  const CONFIG = root.CONFIG;
  const State = root.State;

  function t(key) {
    return (root.I18N[State.lang] && root.I18N[State.lang][key]) || key;
  }
  // {placeholder} 치환이 필요한 문구용 (손실 분석 문구 등)
  function tp(key, params) {
    let s = t(key);
    Object.keys(params || {}).forEach((k) => {
      s = s.replace(new RegExp("\\{" + k + "\\}", "g"), params[k]);
    });
    return s;
  }

  function formatPrice(p) {
    if (p == null || !Number.isFinite(p) || p <= 0) return "-";
    if (p >= 100) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    return p.toFixed(6);
  }
  function formatNum(n) {
    return n == null ? "-" : n.toFixed(2);
  }

  // status('strong'|'watch'|'neutral'|'none') + direction('long'|'short'|null) -> 배지 텍스트/클래스
  function badgeInfo(status, direction) {
    if (status === "strong") return { text: direction === "long" ? t("strongLong") : t("strongShort"), cls: "strong-" + direction };
    if (status === "watch") return { text: direction === "long" ? t("watchLong") : t("watchShort"), cls: "watch-" + direction };
    if (status === "neutral") return { text: t("neutralSignal"), cls: "neutral" };
    return { text: t("noSignal"), cls: "none" };
  }

  /* ---------------- Dashboard list ---------------- */
  // 현재 열려 있는 카테고리 페이지에 이 종목이 속하는지 (속하지 않으면 목록에 표시하지 않는다)
  function isInCurrentCategoryPage(symbol) {
    if (State.view !== "coin" && State.view !== "stock") return false;
    return State.getCategory(symbol) === State.view;
  }

  function ensureRow(symbol) {
    let row = document.getElementById("row-" + symbol);
    if (row) return row;
    if (!isInCurrentCategoryPage(symbol)) return null; // 다른 시장 종목은 이 페이지에 만들지 않음
    const list = document.getElementById("list");
    const empty = list.querySelector(".empty");
    if (empty) empty.remove();
    // row 자체를 button으로 두면 안에 삭제 button을 넣을 수 없으므로(중첩 불가),
    // div 래퍼 안에 "상세보기 영역(button)"과 "삭제 버튼"을 나란히 둔다.
    row = document.createElement("div");
    row.className = "row";
    row.id = "row-" + symbol;
    row.innerHTML = `
      <button type="button" class="row-open" data-open="${symbol}">
        <div class="row-main">
          <div class="row-top">
            <span class="row-sym">${symbol}</span>
            <span class="row-badge none" id="badge-${symbol}">${t("noSignal")}</span>
          </div>
          <div class="row-bottom">
            <span class="row-price" id="price-${symbol}">-</span>
            <span class="row-score" id="score-${symbol}">-</span>
          </div>
        </div>
        <span class="row-chevron">\u203A</span>
      </button>
      <button type="button" class="row-del" data-sym="${symbol}">${t("delete")}</button>
    `;
    row.querySelector(`button[data-open="${symbol}"]`).addEventListener("click", () => openDetail(symbol));
    list.appendChild(row);
    return row;
  }

  function renderRow(symbol, result, isError) {
    const row = ensureRow(symbol);
    if (!row) return; // 현재 카테고리 페이지에 속하지 않는 종목 — 이 페이지에는 표시하지 않음
    if (isError || !result) {
      // 가격/신호 데이터가 없거나 오류가 났을 때는 잘못된 값을 남기지 않고 "-"로 표시한다.
      row.querySelector(`#price-${symbol}`).textContent = "-";
      row.querySelector(`#score-${symbol}`).textContent = "-";
      const badge = row.querySelector(`#badge-${symbol}`);
      badge.className = "row-badge error";
      badge.textContent = t("loadError");
      return;
    }
    const info = badgeInfo(result.status, result.leadingDirection);
    const badge = row.querySelector(`#badge-${symbol}`);
    badge.className = "row-badge " + info.cls;
    badge.textContent = info.text;
    row.classList.remove("strong-long", "strong-short", "watch-long", "watch-short", "locked-symbol");
    if (info.cls.startsWith("strong-") || info.cls.startsWith("watch-")) row.classList.add(info.cls);
    if (State.lock && State.lock.symbol === symbol) row.classList.add("locked-symbol");

    const symEl = row.querySelector(`.row-sym`);
    symEl.textContent = (State.lock && State.lock.symbol === symbol ? "\uD83D\uDD12 " : "") + symbol;

    // 가격 데이터가 비정상(NaN/0 이하 등)이면 formatPrice()가 "-"를 반환한다 —
    // 신호 계산에 쓰인 것과 동일한 result.price를 그대로 표시하므로 값이 서로 어긋나지 않는다.
    row.querySelector(`#price-${symbol}`).textContent = formatPrice(result.price);
    const leadScore = result.leadingDirection === "short" ? result.short.score : result.long.score;
    row.querySelector(`#score-${symbol}`).textContent = t("score") + " " + leadScore;
  }

  function removeRow(symbol) {
    const row = document.getElementById("row-" + symbol);
    if (row) row.remove();
  }

  function maybeShowEmpty() {
    const list = document.getElementById("list");
    const cat = State.view === "stock" ? "stock" : "coin";
    // 전체 종목이 아니라 "현재 카테고리 페이지"의 종목 수로 판단한다
    if (State.symbolsInCategory(cat).length === 0 && !list.querySelector(".empty")) {
      list.innerHTML = `<div class="empty">${t("empty")}</div>`;
    }
  }

  /* ---------------- Detail view ---------------- */
  let detailSymbol = null;

  function openDetail(symbol) {
    detailSymbol = symbol;
    document.getElementById("detailSym").textContent = symbol;
    document.getElementById("detailView").classList.add("open");
    renderDetail(symbol);
  }
  function closeDetail() {
    detailSymbol = null;
    document.getElementById("detailView").classList.remove("open");
  }

  function conditionRow(label, met, points) {
    return `<div class="cond-item ${met ? "met" : ""}">
      <span class="cond-mark">${met ? "\u2713" : "\u2014"}</span>
      <span class="cond-label">${label}</span>
      <span class="cond-pts">${met ? "+" + points : "0"}</span>
    </div>`;
  }

  function renderScorePanel(result) {
    const dir = result.leadingDirection;
    const dirData = dir === "short" ? result.short : result.long;
    const info = badgeInfo(result.status, dir);

    const badge = document.getElementById("detailBadge");
    badge.className = "badge-lg " + info.cls;
    badge.textContent = info.text + (dir ? " \u00b7 " + t("score") + " " + dirData.score : "");

    const W = CONFIG.SCORE_WEIGHTS;
    const c = dirData.conditions;
    document.getElementById("detailConditions").innerHTML = [
      conditionRow(t("cond_trend15"), c.trend15, W.trend15),
      conditionRow(t("cond_trend5"), c.trend5, W.trend5),
      conditionRow(t("cond_ha1Flip"), c.ha1Flip, W.ha1Flip),
      conditionRow(t("cond_macdCross"), c.macdCross, W.macdCross),
    ].join("");

    // 참고용: 반대 방향 점수도 작게 표시 (LONG/SHORT 동일 구조로 계산되었음을 보여줌)
    document.getElementById("detailBothScores").textContent =
      `${t("longScore")} ${result.long.score} \u00b7 ${t("shortScore")} ${result.short.score}`;

    // 자가학습 신뢰도 — 기존 신호(LONG/SHORT·점수·배지)는 전혀 바꾸지 않고, 추가 정보로만 표시한다.
    const learnEl = document.getElementById("detailLearnInfo");
    if (learnEl && dir) {
      if (!root.PatternLearn.isEnabled()) {
        learnEl.textContent = t("learnOffNotice");
      } else {
        const category = State.getCategory(result.symbol);
        const key = root.PatternLearn.buildPatternKey(category, result.symbol, dir, dirData.conditions);
        const info = root.PatternLearn.getPatternInfo(key);
        if (info.total === 0) {
          learnEl.textContent = t("learnNoData");
        } else if (info.confidence == null) {
          learnEl.textContent = tp("learnInsufficient", { total: info.total });
        } else {
          const label = info.confidence >= CONFIG.LEARN_CONFIDENCE_THRESHOLD ? t("learnHigh") : t("learnLow");
          learnEl.textContent = tp("learnConfidenceText", {
            label,
            pct: (info.confidence * 100).toFixed(0),
            total: info.total,
          });
        }
      }
    }
  }

  function renderChartsForTab(symbol, result, tf) {
    const d = result.tf[tf];
    const markers = root.SignalLog.getMarkersForSymbolTf(symbol, tf);
    root.Charts.drawPriceChart(document.getElementById("detailChartPrice"), d.klines, d.ha, 80, markers);
    root.Charts.drawMacdChart(document.getElementById("detailChartMacd"), d.macd, 80);
    root.Charts.drawRsiChart(document.getElementById("detailChartRsi"), d.rsi, 80);

    const last = d.ha.length - 1;
    document.getElementById("tfTrend").textContent = d.ha[last].bullish ? t("bullish") : t("bearish");
    document.getElementById("tfTrend").className = "v " + (d.ha[last].bullish ? "bull" : "bear");
    document.getElementById("tfDif").textContent = formatNum(d.macd.dif[last]);
    document.getElementById("tfDea").textContent = formatNum(d.macd.dea[last]);
    document.getElementById("tfRsi").textContent = formatNum(d.rsi[last]);
  }

  function renderTfTabs() {
    document.querySelectorAll(".tf-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tf === State.detailTab);
    });
  }

  function pctChange(base, val) {
    return root.LockRange.pctChange(base, val);
  }
  function pctText(base, val) {
    const p = pctChange(base, val);
    if (p == null) return "-";
    return (p >= 0 ? "+" : "") + p.toFixed(2) + "%";
  }
  function pctCls(base, val) {
    const p = pctChange(base, val);
    if (p == null) return "";
    return p >= 0 ? "up" : "down";
  }
  // 이미 계산된 퍼센트 값(예: LockRange.confirm()이 저장해둔 maxPnlPercent)을 표시용으로 포맷
  function pctFromValue(p) {
    if (p == null || !Number.isFinite(p)) return "-";
    return (p >= 0 ? "+" : "") + p.toFixed(2) + "%";
  }
  function pctClsFromValue(p) {
    if (p == null || !Number.isFinite(p)) return "";
    return p >= 0 ? "up" : "down";
  }

  function renderLockPanel(symbol, result) {
    const btn = document.getElementById("lockBtn");
    const recordBtn = document.getElementById("recordStartBtn");
    const display = document.getElementById("lockDisplay");
    const isLocked = State.lock && State.lock.symbol === symbol;
    const isRecording = State.recording && State.recording.symbol === symbol;

    btn.classList.toggle("on", isLocked);
    btn.classList.toggle("off", !isLocked);
    btn.textContent = isLocked ? t("unlock") : t("lockIn");

    // "기록" 버튼: LOCK된 상태에서만 활성화되고, 이미 기록 중이면 다시 누를 수 없다 (요구사항 2).
    recordBtn.style.display = isLocked ? "" : "none";
    recordBtn.disabled = !isLocked || isRecording;
    recordBtn.textContent = isRecording ? t("recording") : t("startRecording");
    recordBtn.classList.toggle("active", isRecording);

    if (isRecording) {
      // 기록 시작 ~ 현재까지: 가격과 손익률을 함께 실시간으로 갱신한다.
      // 손익률은 항상 기록 시작가(recording.basePrice) 기준으로 계산한다.
      const rec = State.recording;
      const curPrice = result ? result.price : null;
      // 요구사항 3: "LONG ×10 | +15.2%" 형식. 레버리지는 여기서만 적용(중복 적용 방지) —
      // 구간 최고/최저 손익률(아래 두 줄)은 기존 그대로 레버리지 미적용 원본 값이다.
      const rawPct = root.LockRange.pctChange(rec.basePrice, curPrice);
      const levPct = rawPct == null ? null : rawPct * (rec.leverage || 1) * (rec.direction === "short" ? -1 : 1);
      const dirLabel = rec.direction === "short" ? t("short") : t("long");
      const levText = `${dirLabel} \u00d7${rec.leverage || 1} | ${pctFromValue(levPct)}`;
      display.innerHTML = `
        <div class="lock-live">
          <div class="lock-row"><span>\uD83D\uDCCB ${t("recordStartPrice")}</span><b>${formatPrice(rec.basePrice)}</b></div>
          <div class="lock-row"><span>${t("currentPrice")}</span><b>${formatPrice(curPrice)}</b></div>
          <div class="lock-row"><span>${t("currentPnl")}</span><b class="pct ${pctClsFromValue(levPct)}">${levText}</b></div>
          <div class="lock-row"><span>\uD83D\uDCC8 ${t("rangeHigh")}</span><b>${formatPrice(rec.high)}</b></div>
          <div class="lock-row"><span>${t("rangeHighPnl")}</span><b class="pct ${pctCls(rec.basePrice, rec.high)}">${pctText(rec.basePrice, rec.high)}</b></div>
          <div class="lock-row"><span>\uD83D\uDCC9 ${t("rangeLow")}</span><b>${formatPrice(rec.low)}</b></div>
          <div class="lock-row"><span>${t("rangeLowPnl")}</span><b class="pct ${pctCls(rec.basePrice, rec.low)}">${pctText(rec.basePrice, rec.low)}</b></div>
        </div>
        <div class="lock-notice">${t("lockNotice")}</div>
      `;
    } else if (isLocked) {
      // LOCK만 된 상태 (기록 전) — 락인 가격만 보여주고 최고/최저/손익률은 아직 추적하지 않는다.
      display.innerHTML = `
        <div class="lock-live">
          <div class="lock-row"><span>\uD83D\uDD12 ${t("lockPriceLabel")}</span><b>${formatPrice(State.lock.basePrice)}</b></div>
        </div>
        <div class="lock-notice">${t("waitingToRecord")}</div>
      `;
    } else {
      display.innerHTML = "";
    }
  }

  function renderDetail(symbol) {
    if (detailSymbol !== symbol) return;
    const result = State.data[symbol];
    const hasError = !!State.errors[symbol];

    if (!result || hasError) {
      // 가격/신호 데이터가 없거나 오류 상태면 잘못된(오래된) 값 대신 전부 "-"로 표시한다.
      document.getElementById("detailPrice").textContent = "-";
      document.getElementById("detailUpdated").textContent = hasError ? t("loadError") : "-";
      const badge = document.getElementById("detailBadge");
      badge.className = "badge-lg error";
      badge.textContent = t("loadError");
      document.getElementById("detailBothScores").textContent = "-";
      document.getElementById("detailConditions").innerHTML = "";
      ["tfTrend", "tfDif", "tfDea", "tfRsi"].forEach((id) => {
        const el = document.getElementById(id);
        el.textContent = "-";
        el.className = "v";
      });
      renderLockPanel(symbol, result || null);
      return;
    }

    document.getElementById("detailPrice").textContent = formatPrice(result.price);
    document.getElementById("detailUpdated").textContent = t("updated") + ": " + new Date(result.updatedAt).toLocaleTimeString();

    renderScorePanel(result);
    renderLockPanel(symbol, result);
    renderTfTabs();
    renderChartsForTab(symbol, result, State.detailTab);
  }

  /* ---------------- Toast (즉시 화면 알림) ---------------- */
  function showToast(symbol, direction, score) {
    const box = document.getElementById("toastBox");
    const el = document.createElement("div");
    el.className = "toast " + direction;
    const label = direction === "long" ? t("watchLong") : t("watchShort");
    el.innerHTML = `<strong>${symbol}</strong> ${label}<br><span>${t("score")}: ${score}</span>`;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, 5000);
  }

  /* ---------------- Menu (☰) / view switch ---------------- */
  function toggleMenu(forceOpen) {
    const dd = document.getElementById("menuDropdown");
    if (typeof forceOpen === "boolean") dd.classList.toggle("open", forceOpen);
    else dd.classList.toggle("open");
  }

  function switchView(view) {
    State.view = view;
    const isCategoryPage = view === "coin" || view === "stock";
    document.getElementById("list").style.display = isCategoryPage ? "" : "none";
    document.getElementById("recordsView").classList.toggle("open", view === "records");
    document.getElementById("menuCoinBtn").classList.toggle("active", view === "coin");
    document.getElementById("menuStockBtn").classList.toggle("active", view === "stock");
    document.getElementById("menuRecordsBtn").classList.toggle("active", view === "records");
    // 상단 브랜드 제목을 현재 페이지 이름으로 바꿔서 지금 어느 시장을 보고 있는지 명확히 한다.
    const brandTitle = document.querySelector(".brand h1");
    if (brandTitle) {
      brandTitle.textContent = view === "stock" ? t("stockFutures") : view === "records" ? t("menuRecords") : t("coinFutures");
    }
    const pageLabel = document.getElementById("currentPageLabel");
    if (pageLabel) pageLabel.textContent = view === "stock" ? t("stockFutures") : t("coinFutures");
    if (isCategoryPage) renderCategoryList(); // 이 카테고리의 종목만 다시 그린다(목록 섞임 방지)
    if (view === "records") renderRecordsView();
    renderChips();
    renderLearnPanel(); // 학습 통계도 현재 시장 기준으로 다시 계산(페이지 전환 시 이전 시장 숫자가 남지 않도록)
    toggleMenu(false);
  }

  // 현재 카테고리 페이지에 속한 종목만 신호 목록에 표시한다 (다른 카테고리 행은 DOM에서 제거).
  function renderCategoryList() {
    const cat = State.view === "stock" ? "stock" : "coin";
    const list = document.getElementById("list");
    // 이 카테고리에 속하지 않은 기존 행을 제거
    State.symbols.forEach((sym) => {
      if (State.getCategory(sym) !== cat) removeRow(sym);
    });
    const syms = State.symbolsInCategory(cat);
    if (syms.length === 0) {
      list.innerHTML = `<div class="empty">${t("empty")}</div>`;
      return;
    }
    const emptyEl = list.querySelector(".empty");
    if (emptyEl) emptyEl.remove();
    syms.forEach((sym) => {
      if (State.data[sym]) renderRow(sym, State.data[sym], !!State.errors[sym]);
      else ensureRow(sym);
    });
  }

  /* ---------------- Records view ("내 기록") ---------------- */
  function fmtTime(ts) {
    return ts ? new Date(ts).toLocaleString() : "-";
  }

  function tradeCard(trade) {
    const dirCls = trade.direction;
    const dirLabel = trade.direction === "long" ? t("long") : t("short");
    const isOpen = trade.status === "open";
    const pnlCls = trade.win === true ? "up" : trade.win === false ? "down" : "";
    const pnlText = isOpen ? "-" : (trade.pnlPercent >= 0 ? "+" : "") + trade.pnlPercent.toFixed(2) + "%";
    const amtText = isOpen ? "-" : (trade.pnlAmount >= 0 ? "+" : "") + trade.pnlAmount.toFixed(2) + " USDT";

    return `
      <div class="trade-card" data-id="${trade.id}">
        <div class="trade-top">
          <div><span class="trade-sym">${trade.symbol}</span> <span class="trade-dir ${dirCls}">${dirLabel}</span></div>
          ${isOpen ? `<span class="trade-status-open">${t("open")}</span>` : `<span class="trade-pnl ${pnlCls}">${pnlText}</span>`}
        </div>
        <div class="trade-grid">
          <div>${t("entryPrice")}: <b>${formatPrice(trade.entryPrice)}</b></div>
          <div>${t("exitPrice")}: <b>${isOpen ? "-" : formatPrice(trade.exitPrice)}</b></div>
          <div>${t("entryTime")}: <b>${fmtTime(trade.entryTime)}</b></div>
          <div>${t("exitTime")}: <b>${isOpen ? "-" : fmtTime(trade.exitTime)}</b></div>
          ${!isOpen ? `<div>${t("pnlAmount")}: <b class="${pnlCls}">${amtText}</b></div>` : ""}
        </div>
        <div class="trade-actions">
          ${isOpen ? `<button class="ghost-btn" data-action="close-trade" data-id="${trade.id}">${t("recordExit")}</button>` : ""}
          ${!isOpen && trade.win === false ? `<button class="ghost-btn" data-action="analyze-trade" data-id="${trade.id}">${t("analyze")}</button>` : ""}
        </div>
      </div>`;
  }

  function lockRecordCard(r) {
    const dirLabel = r.direction === "short" ? t("short") : t("long");
    // finalPnlPercent(레버리지 반영)가 없는 예전 기록은 endPnlPercent(비레버리지)로 대체 표시
    const finalPnl = r.finalPnlPercent != null ? r.finalPnlPercent : r.endPnlPercent;
    const leverage = r.leverage || 1;
    return `
      <div class="trade-card" data-id="${r.id}">
        <div class="trade-top">
          <div><span class="trade-sym">${r.symbol}</span> <span class="trade-dir ${r.direction}">${dirLabel}</span> <span class="trade-dir lev">${leverage}x</span></div>
          <span class="trade-pnl ${pctClsFromValue(finalPnl)}">${pctFromValue(finalPnl)}</span>
        </div>
        <div class="trade-grid">
          <div>${t("recordStartTime")}: <b>${fmtTime(r.recordStartAt || r.lockedAt)}</b></div>
          <div>${t("recordEndTime")}: <b>${fmtTime(r.recordEndAt || r.unlockedAt)}</b></div>
          <div>${t("lockPriceLabel")}: <b>${formatPrice(r.basePrice)}</b></div>
          <div>${t("recordStartPrice")}: <b>${formatPrice(r.startPrice)}</b></div>
          <div>${t("recordEndPrice")}: <b>${formatPrice(r.endPrice)}</b></div>
          <div>${t("rangeHighLabel")}: <b>${formatPrice(r.high)}</b></div>
          <div>${t("rangeLowLabel")}: <b>${formatPrice(r.low)}</b></div>
          <div>${t("maxPnlLabel")}: <b class="${pctClsFromValue(r.maxPnlPercent)}">${pctFromValue(r.maxPnlPercent)}</b></div>
          <div>${t("minPnlLabel")}: <b class="${pctClsFromValue(r.minPnlPercent)}">${pctFromValue(r.minPnlPercent)}</b></div>
          <div>${t("leverageLabel")}: <b>${leverage}x</b></div>
          <div>${t("finalPnlLabel")}: <b class="${pctClsFromValue(finalPnl)}">${pctFromValue(finalPnl)}</b></div>
        </div>
        <div class="trade-actions">
          <button class="ghost-btn" data-action="delete-lock-record" data-id="${r.id}">${t("delete")}</button>
        </div>
      </div>`;
  }

  function renderRecordsView() {
    // 요구사항 2: 상단 통계는 정상 동작하는 LOCK 기록(State.lockRecords) 기준으로 계산한다.
    const lockRecords = State.lockRecords;
    const finalPnlOf = (r) => (r.finalPnlPercent != null ? r.finalPnlPercent : r.endPnlPercent);
    const total = lockRecords.length;
    const wins = lockRecords.filter((r) => finalPnlOf(r) > 0).length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    const totalPnl = lockRecords.reduce((sum, r) => sum + (finalPnlOf(r) || 0), 0);

    document.getElementById("statTotal").textContent = total;
    document.getElementById("statWinRate").textContent = total > 0 ? winRate.toFixed(1) + "%" : "-";
    const pnlEl = document.getElementById("statPnl");
    pnlEl.textContent = total > 0 ? (totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(2) + "%" : "-";
    pnlEl.className = "stat-v " + (totalPnl > 0 ? "up" : totalPnl < 0 ? "down" : "");

    // LOCK 기록(records) — 신호 데이터(signals)와 분리된 별도 목록. 여기서만 표시된다 (요구사항 5).
    const lockListEl = document.getElementById("lockRecordList");
    lockListEl.innerHTML = lockRecords.length
      ? lockRecords.map(lockRecordCard).join("")
      : `<div class="empty">${t("noLockRecords")}</div>`;
  }

  /* ---------------- Trade modals ---------------- */
  function openAddTradeModal() {
    const sel = document.getElementById("tradeSymbolSelect");
    sel.innerHTML = State.symbols.map((s) => `<option value="${s}">${s}</option>`).join("");
    const defaultSym = (detailSymbol && State.symbols.includes(detailSymbol)) ? detailSymbol : State.symbols[0];
    if (defaultSym) sel.value = defaultSym;
    const priceEl = document.getElementById("tradeEntryPrice");
    const cur = State.data[sel.value];
    priceEl.value = cur ? cur.price : "";
    document.getElementById("addTradeModal").classList.add("open");
  }
  function closeAddTradeModal() {
    document.getElementById("addTradeModal").classList.remove("open");
  }

  let closeTradeTargetId = null;
  function openCloseTradeModal(tradeId) {
    closeTradeTargetId = tradeId;
    const trade = root.TradeLog.getAll().find((t2) => t2.id === tradeId);
    const cur = trade ? State.data[trade.symbol] : null;
    document.getElementById("tradeExitPrice").value = cur ? cur.price : "";
    document.getElementById("closeTradeModal").classList.add("open");
  }
  function closeCloseTradeModal() {
    closeTradeTargetId = null;
    document.getElementById("closeTradeModal").classList.remove("open");
  }
  function getCloseTradeTargetId() {
    return closeTradeTargetId;
  }

  function openAnalysisModal(tradeId) {
    const trade = root.TradeLog.getAll().find((t2) => t2.id === tradeId);
    const body = document.getElementById("analysisBody");
    if (!trade) {
      body.innerHTML = "";
      document.getElementById("analysisModal").classList.add("open");
      return;
    }
    const result = root.LossAnalysis.analyze(trade);
    if (!result.reasons.length) {
      body.innerHTML = `<div class="analysis-reason"><span>${t("noSnapshotData")}</span></div>`;
    } else {
      body.innerHTML = result.reasons
        .map((r) => `<div class="analysis-reason"><span class="bullet">\u2022</span><span>${tp(r.key, r.params)}</span></div>`)
        .join("");
    }
    document.getElementById("analysisModal").classList.add("open");
  }
  function closeAnalysisModal() {
    document.getElementById("analysisModal").classList.remove("open");
  }

  /* ---------------- 종목 추가 대상 카테고리 ----------------
     별도 선택 버튼 없이 "현재 열려 있는 카테고리 페이지"가 곧 추가 대상이다.
     (기록 페이지에서 추가하는 경우는 코인으로 취급) */
  function getSelectedCategory() {
    return State.view === "stock" ? "stock" : "coin";
  }

  function tierLabel(tier) {
    if (tier === "sufficient") return t("tierSufficient");
    if (tier === "learning") return t("tierLearning");
    return t("tierInsufficient");
  }

  /* ---------------- Symbol chips (settings panel) — 카테고리별 그룹 + 종목별 학습 상태 ---------------- */
  function renderChips() {
    const box = document.getElementById("chipList");
    const cat = State.view === "stock" ? "stock" : "coin"; // 기록 페이지에서는 코인 목록을 기본 표시
    const syms = State.symbolsInCategory(cat);
    box.innerHTML = "";
    if (syms.length === 0) {
      const none = document.createElement("div");
      none.className = "chip-none";
      none.textContent = t("noSymbolsInCategory");
      box.appendChild(none);
    }
    syms.forEach((sym) => {
      const learn = root.PatternLearn.getStatsFor(cat, sym); // 현재 페이지 카테고리만 집계(타 시장 데이터 미포함)
      const chip = document.createElement("div");
      chip.className = "chip";
      const winRateText = learn.winRate == null ? "-" : learn.winRate.toFixed(1) + "%";
      chip.innerHTML = `
        <div class="chip-main">
          <span class="chip-sym">${sym}</span>
          <span class="chip-learn">${t("totalEntries")} ${learn.total} \u00b7 ${t("winRate")} ${winRateText} \u00b7 ${tierLabel(learn.tier)}</span>
        </div>
        <button class="chip-del" data-sym="${sym}">${t("delete")}</button>`;
      box.appendChild(chip);
    });
    // 현재 카테고리 종목 수와 전체 기준 상한을 함께 보여준다 (상한 MAX_SYMBOLS는 전체 공통)
    document.getElementById("symbolCount").textContent = `${syms.length} (${t("allCategories")} ${State.symbols.length} / ${CONFIG.MAX_SYMBOLS})`;
  }

  /* ---------------- Notify button (실제 ON/OFF 토글) ---------------- */
  function renderNotifyBtn() {
    const btn = document.getElementById("notifyBtn");
    btn.textContent = State.notifyEnabled ? t("notifyOn") : t("notifyOff");
    btn.classList.toggle("on", State.notifyEnabled);
    btn.classList.toggle("off", !State.notifyEnabled);
    btn.setAttribute("aria-pressed", String(State.notifyEnabled));
  }

  /* ---------------- 백그라운드 감시 버튼 (Android 전용, 알림 토글과 동일 패턴) ---------------- */
  function renderBgMonitorBtn() {
    const btn = document.getElementById("bgMonitorBtn");
    btn.textContent = State.bgMonitorEnabled ? t("bgMonitorOn") : t("bgMonitorOff");
    btn.classList.toggle("on", State.bgMonitorEnabled);
    btn.classList.toggle("off", !State.bgMonitorEnabled);
    btn.setAttribute("aria-pressed", String(State.bgMonitorEnabled));
  }

  /* ---------------- 자가학습 상태 패널 (요구사항 5) ---------------- */
  function renderLearnPanel() {
    const btn = document.getElementById("learnBtn");
    btn.textContent = State.learnEnabled ? t("learnOn") : t("learnOff");
    btn.classList.toggle("on", State.learnEnabled);
    btn.classList.toggle("off", !State.learnEnabled);
    btn.setAttribute("aria-pressed", String(State.learnEnabled));

    // 요구사항 8: 현재 열려 있는 시장(코인/주식)의 학습 통계만 표시한다.
    const learnCat = State.view === "stock" ? "stock" : "coin";
    const totals = root.PatternLearn.getTotals(learnCat);
    const marketName = t(learnCat === "stock" ? "stockFutures" : "coinFutures");
    // 학습 데이터 수는 실제로 WIN/LOSS 판정이 끝난 건수(total)를 보여준다.
    document.getElementById("learnEntries").textContent = totals.total;
    document.getElementById("learnWins").textContent = totals.wins;
    document.getElementById("learnLosses").textContent = totals.losses;
    document.getElementById("learnWinRate").textContent = totals.winRate == null ? "-" : totals.winRate.toFixed(1) + "%";
    document.getElementById("learnAppliedNotice").textContent =
      `[${marketName}] ` + (State.learnEnabled ? t("learnAppliedYes") : t("learnAppliedNo"));
  }

  /* ---------------- i18n apply ---------------- */
  function applyI18n() {
    document.documentElement.lang = State.lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.getElementById("symbolInput").placeholder = t("addPlaceholder");
    renderNotifyBtn();
    renderBgMonitorBtn();
    renderLearnPanel();
    renderChips();
    maybeShowEmpty();
    Object.keys(State.data).forEach((sym) => renderRow(sym, State.data[sym], false));
    if (detailSymbol) renderDetail(detailSymbol);
    if (State.view === "records") renderRecordsView();
  }

  root.UI = {
    t,
    tp,
    formatPrice,
    formatNum,
    badgeInfo,
    renderRow,
    removeRow,
    maybeShowEmpty,
    openDetail,
    closeDetail,
    renderDetail,
    renderTfTabs,
    renderLockPanel,
    showToast,
    renderChips,
    getSelectedCategory,
    renderCategoryList,
    renderNotifyBtn,
    renderBgMonitorBtn,
    renderLearnPanel,
    applyI18n,
    toggleMenu,
    switchView,
    renderRecordsView,
    openAddTradeModal,
    closeAddTradeModal,
    openCloseTradeModal,
    closeCloseTradeModal,
    getCloseTradeTargetId,
    openAnalysisModal,
    closeAnalysisModal,
  };
})(typeof window !== "undefined" ? window : globalThis);
