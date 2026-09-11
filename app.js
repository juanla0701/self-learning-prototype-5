(function (root) {
  const CONFIG = root.CONFIG;
  const State = root.State;
  const UI = root.UI;
  const TFS = ["1m", "5m", "15m"];

  /* ---------------- Fetch + evaluate one symbol (1m/5m/15m 동시 조회) ---------------- */
  async function updateSymbol(symbol) {
    try {
      const klinesByTf = {};
      await Promise.all(
        TFS.map(async (tf) => {
          klinesByTf[tf] = await root.BinanceApi.fetchKlines(symbol, tf, CONFIG.KLINE_LIMIT);
        })
      );
      for (const tf of TFS) {
        if (klinesByTf[tf].length < CONFIG.MACD_SLOW + CONFIG.MACD_SIGNAL) {
          // 유효한 캔들이 부족함 (신규 상장 종목 등) — 잘못된 값을 보여주지 않도록 오류 상태로 표시
          State.errors[symbol] = true;
          UI.renderRow(symbol, State.data[symbol] || null, true);
          return;
        }
      }

      const tfData = {};
      TFS.forEach((tf) => {
        tfData[tf] = root.Signals.computeIndicators(klinesByTf[tf]);
      });

      const prevState = State.data[symbol];
      const result = root.Signals.evaluate(prevState, symbol, tfData);
      State.data[symbol] = result;
      State.errors[symbol] = false; // 이번 갱신은 성공했으므로 오류 플래그 해제

      // "기록" 버튼으로 기록 중인 종목이면, 이번에 새로 받은 가격으로 최고가/최저가(+손익률)를 실시간 갱신한다.
      // LOCK(State.lock)만 되어 있고 기록이 시작되지 않았다면 여기서 아무것도 갱신하지 않는다 (요구사항 2/3).
      if (State.recording && State.recording.symbol === symbol) {
        const next = root.LockRange.update(State.recording, result.price);
        if (next !== State.recording) State.saveRecording(next);
      }

      UI.renderRow(symbol, result, false);
      if (document.getElementById("detailView").classList.contains("open") && document.getElementById("detailSym").textContent === symbol) {
        UI.renderDetail(symbol);
      }

      if (result.isNewSignal && result.leadingDirection) {
        // 신호 기록(SignalLog)은 LOCK IN 여부와 무관하게 항상 남긴다 (데이터 축적 목적).
        root.SignalLog.append(result, result.leadingDirection);
        // 자가학습(패턴 신뢰도) 대기열에 등록 — 감시 중인 모든 종목 대상, Lock-in 기록과는 별개.
        root.PatternLearn.recordPending(result, result.leadingDirection);
        const dirData = result.leadingDirection === "long" ? result.long : result.short;

        // LOCK IN 중이면 잠긴 종목 외의 알림(토스트+브라우저 알림)은 전부 차단한다.
        const locked = State.lock && State.lock.symbol;
        const allowed = !locked || locked === symbol;
        // 학습된 패턴 신뢰도가 낮고(임계값 미만) 샘플이 충분하면 "알림"만 걸러낸다.
        // (신호 자체, 점수, 차트, SignalLog 기록은 전혀 영향받지 않음)
        const passesLearnFilter = root.PatternLearn.shouldAlert(result, result.leadingDirection);
        if (allowed && passesLearnFilter) {
          UI.showToast(symbol, result.leadingDirection, dirData.score);
          fireNotification(symbol, result.leadingDirection, dirData.score, result.price);
        }
      }
    } catch (err) {
      console.error(symbol, err);
      State.errors[symbol] = true;
      UI.renderRow(symbol, null, true);
      if (document.getElementById("detailView").classList.contains("open") && document.getElementById("detailSym").textContent === symbol) {
        UI.renderDetail(symbol);
      }
    }
  }

  // 심볼 목록을 작은 묶음으로 나눠 순차 처리한다 (요청 수/주기는 그대로, 순간 동시 요청 개수만 제한).
  // 50개까지 등록 가능해져도 한 번에 150개 요청이 동시에 나가지 않도록 하기 위함.
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  let isPolling = false; // 이전 폴링 사이클이 아직 진행 중이면 새 사이클을 겹쳐서 시작하지 않는다 (중복 API 요청/중복 감시 방지)
  async function updateAll() {
    if (isPolling) return; // 이미 실행 중 — 겹쳐서 새로 시작하지 않음(요구사항 2/8: 중복 감시 방지)
    isPolling = true;
    try {
      const batches = chunk(State.symbols, CONFIG.SYMBOL_UPDATE_CONCURRENCY);
      for (const batch of batches) {
        await Promise.all(batch.map(updateSymbol));
      }
      root.PatternLearn.evaluatePending(State.data); // 추가 API 호출 없이 이미 받은 가격으로 판정
    } finally {
      isPolling = false;
    }
  }

  let pollTimer = null;
  function restartPolling() {
    if (pollTimer) clearInterval(pollTimer);
    updateAll();
    pollTimer = setInterval(updateAll, CONFIG.POLL_INTERVAL_MS);
  }

  /* ---------------- Notifications ---------------- */
  function fireNotification(symbol, direction, score, price) {
    if (!State.notifyEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
    const label = direction === "long" ? UI.t("watchLong") : UI.t("watchShort");
    const title = `${symbol} \u2014 ${label}`;
    const body = `${UI.t("score")}: ${score} \u00b7 ${UI.t("price")}: ${UI.formatPrice(price)}`;
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body, tag: symbol + "-" + direction }));
    } else {
      new Notification(title, { body });
    }
  }

  // 알림 ON/OFF 실제 토글: 표시 상태와 실제 알림 발송 여부가 항상 일치하도록
  // State.notifyEnabled 하나로만 판단한다 (fireNotification도 이 값을 확인함).
  document.getElementById("notifyBtn").addEventListener("click", async () => {
    if (State.notifyEnabled) {
      // ON -> OFF: 브라우저 권한은 그대로 두고, 우리 쪽 발송 스위치만 끈다.
      State.saveNotify(false);
      UI.renderNotifyBtn();
      return;
    }
    // OFF -> ON
    if (!("Notification" in window)) {
      alert(UI.t("notifyUnsupported"));
      return;
    }
    if (Notification.permission === "granted") {
      State.saveNotify(true);
    } else if (Notification.permission === "denied") {
      alert(UI.t("notifyPermissionDenied"));
      State.saveNotify(false);
    } else {
      const perm = await Notification.requestPermission();
      State.saveNotify(perm === "granted");
    }
    UI.renderNotifyBtn();
  });

  /* ---------------- 백그라운드 감시 (Android 전용) ----------------
     화면이 꺼지거나 앱이 백그라운드로 가도 기존 신호 감시/자가학습이 계속 돌도록
     Foreground Service를 켜고 끈다. 신호 계산/자가학습 로직 자체는 전혀 건드리지 않는다.
     웹(GitHub Pages)에서는 BackgroundMonitor.isSupported()가 false라서 버튼 자체가 숨겨진다. */
  document.getElementById("bgMonitorBtn").addEventListener("click", async () => {
    if (State.bgMonitorEnabled) {
      await root.BackgroundMonitor.stop();
      State.saveBgMonitor(false);
    } else {
      const ok = await root.BackgroundMonitor.start();
      State.saveBgMonitor(ok);
    }
    UI.renderBgMonitorBtn();
  });

  /* ---------------- 자가학습 ON/OFF ----------------
     ON: 새 신호/Lock-in 결과를 학습 데이터에 저장 + 기존 학습 데이터를 신호 신뢰도에 반영.
     OFF: 새 데이터 저장 중단 + 기존 데이터도 신호 판단에 반영 안 함(단, 데이터 자체는 삭제 안 함).
     실제 게이트는 patternLearn.js의 isEnabled() 한 곳에서만 처리하므로, 여기서는 상태만 바꾸고
     화면만 다시 그린다. */
  document.getElementById("learnBtn").addEventListener("click", () => {
    State.saveLearnEnabled(!State.learnEnabled);
    UI.renderLearnPanel();
  });

  document.getElementById("learnResetBtn").addEventListener("click", () => {
    if (confirm(UI.t("resetLearnConfirm"))) {
      root.PatternLearn.reset(); // 자가학습 데이터/통계만 초기화. 거래 기록/Lock-in 기록/설정/종목은 별도 키라 그대로 유지됨.
      UI.renderLearnPanel();
    }
  });

  /* ---------------- Symbol management ---------------- */
  function addSymbol(raw) {
    const sym = raw.trim().toUpperCase();
    if (!sym) return;
    if (State.symbols.includes(sym)) {
      alert(UI.t("already"));
      return;
    }
    if (State.symbols.length >= CONFIG.MAX_SYMBOLS) {
      alert(UI.t("limitReached"));
      return;
    }
    const category = UI.getSelectedCategory(); // 추가 폼에서 선택한 카테고리(코인/주식 선물)
    State.setCategory(sym, category);
    State.saveSymbols([...State.symbols, sym]);
    UI.renderChips();
    UI.maybeShowEmpty();
    updateSymbol(sym);
    // 참고: 이 종목의 과거 자가학습 데이터(있다면)는 종목명 기준으로 그대로 이어서 사용된다 —
    // 감시 목록 추가/삭제와 학습 데이터는 완전히 별개로 관리되기 때문(요구사항 7).
  }

  function removeSymbol(sym) {
    // 감시 목록에서만 제거한다. 이 종목의 자가학습 데이터(PatternLearn)는 절대 건드리지 않는다 —
    // "감시 목록 삭제"와 "학습 데이터 삭제"는 완전히 별개 기능이다(요구사항 7).
    State.saveSymbols(State.symbols.filter((s) => s !== sym));
    delete State.data[sym];
    UI.removeRow(sym);
    UI.renderChips();
    UI.maybeShowEmpty();
  }

  document.getElementById("addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("symbolInput");
    addSymbol(input.value);
    input.value = "";
  });

  document.getElementById("chipList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-sym]");
    if (btn) {
      // 실수로 지우는 것을 막기 위한 확인창 (요구사항 6)
      if (confirm(UI.tp("removeSymbolConfirm", { symbol: btn.dataset.sym }))) removeSymbol(btn.dataset.sym);
    }
  });

  // 메인 화면 종목 카드의 삭제 버튼 (설정 패널을 열지 않고 바로 삭제할 수 있게)
  document.getElementById("list").addEventListener("click", (e) => {
    const btn = e.target.closest("button.row-del[data-sym]");
    if (btn) {
      e.stopPropagation(); // 상세화면이 함께 열리지 않도록
      if (confirm(UI.tp("removeSymbolConfirm", { symbol: btn.dataset.sym }))) removeSymbol(btn.dataset.sym);
    }
  });

  /* ---------------- Language ---------------- */
  document.getElementById("langToggle").addEventListener("click", () => {
    State.saveLang(State.lang === "ko" ? "en" : "ko");
    UI.applyI18n();
  });

  /* ---------------- Detail view: back + timeframe tabs ---------------- */
  document.getElementById("detailBack").addEventListener("click", UI.closeDetail);

  document.querySelectorAll(".tf-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      State.detailTab = btn.dataset.tf;
      UI.renderTfTabs();
      const sym = document.getElementById("detailSym").textContent;
      if (State.data[sym]) UI.renderDetail(sym);
    });
  });

  document.getElementById("settingsBtn").addEventListener("click", () => {
    document.getElementById("settingsPanel").classList.toggle("open");
  });

  /* ---------------- Hamburger menu (☰): 신호 창 / 내 기록 전환 ---------------- */
  document.getElementById("menuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    UI.toggleMenu();
  });
  document.getElementById("menuCoinBtn").addEventListener("click", () => UI.switchView("coin"));
  document.getElementById("menuStockBtn").addEventListener("click", () => UI.switchView("stock"));
  document.getElementById("menuRecordsBtn").addEventListener("click", () => UI.switchView("records"));
  document.addEventListener("click", (e) => {
    const dd = document.getElementById("menuDropdown");
    if (dd.classList.contains("open") && !dd.contains(e.target) && e.target.id !== "menuBtn") {
      UI.toggleMenu(false);
    }
  });

  /* ---------------- LOCK IN / 기록 / UNLOCK ----------------
     LOCK   : 종목을 "잠금"하고 그 순간 가격을 락인 가격으로 저장할 뿐, 추적은 시작하지 않는다.
              (다른 종목 알림 차단은 State.lock만으로 이미 동작 — updateSymbol() 참고)
     기록   : "기록" 버튼을 눌러야 그 순간부터 State.recording으로 최고가/최저가/손익률 추적 시작.
     UNLOCK : 기록 중이었다면 구간을 확정해 State.lockRecords에 저장. State.lock/State.recording을 모두
              초기화해서 다른 종목을 다시 LOCK할 수 있게 한다 (요구사항 8).
     State.lock(잠금)과 State.recording(기록 중)은 서로 다른 상태이며(요구사항 9),
     State.notifyEnabled(알림 ON/OFF)와도 완전히 분리되어 있어 서로 영향을 주지 않는다. */
  function genRecordId() {
    return "rec" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  document.getElementById("lockBtn").addEventListener("click", () => {
    try {
      const symbol = document.getElementById("detailSym").textContent;
      const cur = State.data[symbol];

      if (State.lock && State.lock.symbol === symbol) {
        // UNLOCK: 기록 중이었고, 10초 이상 지속됐을 때만 구간을 확정해서 저장한다 (요구사항 4).
        if (State.recording && State.recording.symbol === symbol) {
          const durationMs = Date.now() - State.recording.lockedAt;
          if (durationMs >= CONFIG.MIN_RECORD_DURATION_MS) {
            const unlockPrice = cur ? cur.price : null;
            const confirmed = root.LockRange.confirm(State.recording, symbol, unlockPrice); // 기존 손익 계산 구조 그대로 재사용
            confirmed.id = genRecordId();
            confirmed.direction = State.recording.direction || "long";
            confirmed.leverage = State.recording.leverage || 1;
            // 레버리지 반영 최종 손익률: LONG = 가격변동% × 레버리지, SHORT = 가격변동% × -1 × 레버리지
            confirmed.finalPnlPercent =
              confirmed.endPnlPercent == null
                ? null
                : confirmed.endPnlPercent * confirmed.leverage * (confirmed.direction === "short" ? -1 : 1);
            State.addLockRecord(confirmed); // signals와 완전히 분리된 저장소(records 전용, 요구사항 5)
            // 자가학습 연결: 기존 거래 기록은 그대로 두고, 자가학습 데이터에도 결과를 복사해서 반영한다.
            // (OFF 상태면 PatternLearn.recordLockResult() 내부에서 아무 것도 하지 않음)
            root.PatternLearn.recordLockResult({
              symbol,
              direction: confirmed.direction,
              conditions: State.recording.conditions,
              pnlPercent: confirmed.finalPnlPercent != null ? confirmed.finalPnlPercent : confirmed.endPnlPercent,
            });
          }
          // 10초 미만이면 아무 것도 저장하지 않고 그냥 폐기 (거래 기록/통계/학습 데이터 전부 미포함)
        }
        State.saveRecording(null);
        State.saveLock(null); // 전체 종목 알림 재개 + 다른 종목을 다시 LOCK할 수 있도록 완전 초기화
      } else {
        // LOCK IN: 현재가가 아직 없으면(데이터 로딩 전) 잠글 수 없다
        if (!cur || !Number.isFinite(cur.price)) {
          alert(UI.t("loadError"));
          return;
        }
        State.saveLock({ symbol, basePrice: cur.price, lockedAt: Date.now() }); // 추적은 아직 시작 안 함
      }
      UI.renderRow(symbol, State.data[symbol], false);
      UI.renderDetail(symbol);
    } catch (err) {
      console.error("lockBtn click failed", err);
    }
  });

  // "기록 시작" 클릭 → 바로 기록을 시작하지 않고 LONG/SHORT + 레버리지 선택 모달을 먼저 연다 (요구사항 3/4).
  let leverageModalSymbol = null;
  document.getElementById("recordStartBtn").addEventListener("click", () => {
    try {
      const symbol = document.getElementById("detailSym").textContent;
      if (!State.lock || State.lock.symbol !== symbol) return; // LOCK 안 된 상태면 무시
      if (State.recording && State.recording.symbol === symbol) return; // 이미 기록 중
      leverageModalSymbol = symbol;
      document.getElementById("leverageModal").classList.add("open");
    } catch (err) {
      console.error("recordStartBtn click failed", err);
    }
  });

  document.querySelectorAll("#leverageModal .lev-dir-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#leverageModal .lev-dir-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  document.getElementById("leverageCancel").addEventListener("click", () => {
    leverageModalSymbol = null;
    document.getElementById("leverageModal").classList.remove("open");
  });

  document.getElementById("leverageConfirm").addEventListener("click", () => {
    try {
      const symbol = leverageModalSymbol;
      document.getElementById("leverageModal").classList.remove("open");
      if (!symbol || !State.lock || State.lock.symbol !== symbol) return; // 그 사이 UNLOCK 등으로 상태가 바뀌었으면 무시
      const cur = State.data[symbol];
      if (!cur || !Number.isFinite(cur.price)) {
        alert(UI.t("loadError"));
        return;
      }
      const direction = document.querySelector("#leverageModal .lev-dir-btn.active").dataset.dir;
      const leverage = parseInt(document.getElementById("leverageSelect").value, 10) || 1;

      const rec = root.LockRange.start(cur.price); // { basePrice, high, low, lockedAt } — lockRange.js 그대로 재사용
      rec.symbol = symbol;
      rec.direction = direction;
      rec.leverage = leverage;
      // 자가학습 연결용: 기록 시작 시점의 지표 조건 스냅샷(선택한 방향 기준)을 함께 저장해둔다.
      // 기존 신호 계산(signals.js)에는 전혀 손대지 않고, 이미 계산되어 있는 조건을 그대로 참조만 한다.
      rec.conditions = (direction === "short" ? cur.short : cur.long).conditions;
      State.saveRecording(rec);
      UI.renderDetail(symbol);
    } catch (err) {
      console.error("leverageConfirm click failed", err);
    }
  });

  /* ---------------- 내 기록: 거래 추가/청산/분석 ---------------- */
  document.getElementById("recordEntryBtn").addEventListener("click", () => {
    UI.openAddTradeModal();
  });
  document.getElementById("addTradeBtn").addEventListener("click", () => {
    UI.openAddTradeModal();
  });
  document.getElementById("addTradeCancel").addEventListener("click", UI.closeAddTradeModal);

  document.querySelectorAll(".dir-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".dir-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  document.getElementById("tradeSymbolSelect").addEventListener("change", (e) => {
    const cur = State.data[e.target.value];
    document.getElementById("tradeEntryPrice").value = cur ? cur.price : "";
  });

  document.getElementById("addTradeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const symbol = document.getElementById("tradeSymbolSelect").value;
    const direction = document.querySelector(".dir-btn.active").dataset.dir;
    const entryPrice = parseFloat(document.getElementById("tradeEntryPrice").value);
    const notional = parseFloat(document.getElementById("tradeNotional").value) || CONFIG.DEFAULT_TRADE_NOTIONAL;
    if (!symbol || !entryPrice) return;
    root.TradeLog.addEntry({ symbol, direction, entryPrice, notional, snapshotResult: State.data[symbol] });
    UI.closeAddTradeModal();
    UI.renderRecordsView();
  });

  document.getElementById("tradeList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "close-trade") UI.openCloseTradeModal(btn.dataset.id);
    if (btn.dataset.action === "analyze-trade") UI.openAnalysisModal(btn.dataset.id);
  });

  // 기록창의 LOCK 기록(records) 삭제 — 신호 데이터(signals)와는 완전히 분리된 저장소이므로
  // 여기서 지워도 SignalLog/State.data에는 아무 영향이 없다 (요구사항 5/7).
  document.getElementById("lockRecordList").addEventListener("click", (e) => {
    const btn = e.target.closest('button[data-action="delete-lock-record"]');
    if (!btn) return;
    if (confirm(UI.t("deleteRecordConfirm"))) {
      State.removeLockRecord(btn.dataset.id);
      UI.renderRecordsView();
    }
  });

  document.getElementById("closeTradeCancel").addEventListener("click", UI.closeCloseTradeModal);
  document.getElementById("closeTradeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = UI.getCloseTradeTargetId();
    const exitPrice = parseFloat(document.getElementById("tradeExitPrice").value);
    if (!id || !exitPrice) return;
    root.TradeLog.closeTrade(id, exitPrice);
    UI.closeCloseTradeModal();
    UI.renderRecordsView();
  });

  document.getElementById("analysisClose").addEventListener("click", UI.closeAnalysisModal);

  /* ---------------- Install prompt (PWA) ---------------- */
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById("installBanner").classList.add("show");
  });
  document.getElementById("installBtn").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    document.getElementById("installBanner").classList.remove("show");
  });
  document.getElementById("installDismiss").addEventListener("click", () => {
    document.getElementById("installBanner").classList.remove("show");
  });

  /* ---------------- Service worker ---------------- */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((err) => console.error("SW register failed", err));
    });
  }

  /* ---------------- MACD legend colors (charts.js를 단일 기준으로 사용) ---------------- */
  function applyLegendColors() {
    const difDot = document.getElementById("legendDifDot");
    const deaDot = document.getElementById("legendDeaDot");
    if (difDot) difDot.style.background = root.Charts.MACD_COLORS.dif;
    if (deaDot) deaDot.style.background = root.Charts.MACD_COLORS.dea;
    const longDot = document.getElementById("legendLongDot");
    const shortDot = document.getElementById("legendShortDot");
    if (longDot) longDot.style.background = root.Charts.SIGNAL_COLORS.long;
    if (shortDot) shortDot.style.background = root.Charts.SIGNAL_COLORS.short;
  }

  /* ---------------- Init ---------------- */
  function init() {
    // 새로고침 후에도 "표시 상태 = 실제 알림 가능 상태"가 어긋나지 않도록 동기화한다.
    // (예: 브라우저 설정에서 알림 권한을 나중에 껐다면, 켜짐으로 남아있던 상태를 자동으로 끈다)
    if (State.notifyEnabled && (!("Notification" in window) || Notification.permission !== "granted")) {
      State.saveNotify(false);
    }
    // 요구사항 9: 감시 목록에서 실재하지 않는 심볼(ANTROPICUSDT 등)을 자동 제거한다.
    // 이 심볼은 코드에 하드코딩된 적이 없고 사용자가 직접 추가해 localStorage에 남아있던 것이므로,
    // 여기서 목록에서만 제거한다. 학습 데이터(PatternLearn)는 별도 저장소이므로 전혀 삭제되지 않는다.
    State.purgeSymbols(CONFIG.PURGE_SYMBOLS);

    UI.applyI18n();
    // 저장된 페이지가 구버전 값('signals')이면 코인 선물 페이지로 넘긴다(마이그레이션).
    UI.switchView(State.view === "stock" || State.view === "records" ? State.view : "coin");
    UI.renderTfTabs();
    applyLegendColors();

    // 백그라운드 감시 버튼: Android 앱(Capacitor)에서만 보이게 하고, 이전에 켜둔 상태였다면
    // 앱을 다시 열었을 때 서비스가 계속 살아있도록(또는 재시작되도록) 맞춰준다.
    const bgSupported = root.BackgroundMonitor.isSupported();
    document.getElementById("bgMonitorRow").style.display = bgSupported ? "" : "none";
    if (bgSupported && State.bgMonitorEnabled) {
      root.BackgroundMonitor.start(); // 이미 실행 중이면 네이티브 쪽에서 별다른 부작용 없이 무시됨
    }
    UI.renderBgMonitorBtn();

    UI.renderLearnPanel(); // 자가학습 ON/OFF 상태 + 통계 표시 초기화

    restartPolling();
    window.addEventListener("resize", () => {
      Object.keys(State.data).forEach((sym) => UI.renderRow(sym, State.data[sym], false));
      if (document.getElementById("detailView").classList.contains("open")) {
        UI.renderDetail(document.getElementById("detailSym").textContent);
      }
    });
  }

  init();
})(typeof window !== "undefined" ? window : globalThis);
