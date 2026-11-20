(() => {
  "use strict";

  const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
  const $ = id => document.getElementById(id);

  let ws = null;
  let reconnectTimer = null;
  let symbols = [];
  let candles = [];
  let selectedSymbol = "";
  let selectedName = "";
  let chart = null;
  let candleSeries = null;
  let tickSubId = null;
  let lastSignalKey = "";
  let reconnectDelay = 1500;
  let tickCount = 0;

  // Historical data is loaded in two 1,000-candle pages.
  let historyPageReqId = 100;
  let historyPagesLoaded = 0;
  let historyOldestEpoch = null;
  let historyGeneration = 0;
  const historyRequests = new Map();
  const HISTORY_PAGE_SIZE = 1000;
  const HISTORY_TARGET = 2000;
  const HISTORY_MAX_PAGES = 2;

  const logItems = [];

  function setConnection(state, label) {
    const dot = $("connDot");
    const text = $("connText");
    if (dot) dot.className = "dot " + (state === "ok" ? "ok" : state === "bad" ? "bad" : "");
    if (text) text.textContent = label;
  }

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function connect() {
    clearTimeout(reconnectTimer);
    setConnection("", "Connecting to Deriv…");

    try {
      ws = new WebSocket(WS_URL);
    } catch (error) {
      console.error("WebSocket connection error:", error);
      setConnection("bad", "Connection failed");
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectDelay = 1500;
      setConnection("ok", "Connected");
      send({ active_symbols: "brief" });
    };

    ws.onmessage = event => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (error) {
        console.warn("Could not parse Deriv response:", error);
        return;
      }

      if (msg.error) {
        console.warn("Deriv API:", msg.error.message);
        if (msg.req_id && historyRequests.has(msg.req_id)) {
          historyRequests.delete(msg.req_id);
          $("btStatus").textContent = "Historical data request failed: " + msg.error.message;
          updateHistoryStatus("History request failed. Try Refresh data.");
        }
        return;
      }

      if (msg.msg_type === "active_symbols" && Array.isArray(msg.active_symbols)) {
        symbols = msg.active_symbols.map(s => ({
          ...s,
          symbol: s.underlying_symbol || s.symbol,
          display_name: s.underlying_symbol_name || s.display_name || s.symbol,
          symbol_type: s.underlying_symbol_type || s.symbol_type,
          pip: s.pip_size,
          market_display_name: s.market,
          submarket_display_name: s.submarket,
          subgroup_display_name: s.subgroup
        })).filter(s => s.symbol && isSynthetic(s));

        renderMarkets();

        // Restore the selected market after a reconnect; otherwise choose the first market.
        if (selectedSymbol && symbols.some(s => s.symbol === selectedSymbol)) {
          selectMarket(selectedSymbol);
        } else if (!selectedSymbol && symbols.length) {
          selectMarket(symbols[0].symbol);
        }
      }

      if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
        handleHistoricalCandles(msg);
      }

      if (msg.msg_type === "tick" && msg.tick) {
        tickCount++;
        const quote = Number(msg.tick.quote);
        const epoch = Number(msg.tick.epoch);

        $("lastPrice").textContent = quote.toLocaleString(undefined, {
          maximumFractionDigits: 8
        });
        $("lastUpdate").textContent =
          "Updated " + new Date(epoch * 1000).toLocaleTimeString();

        updateLiveCandle(epoch, quote);
        if (msg.subscription && msg.subscription.id) {
          tickSubId = msg.subscription.id;
        }
      }
    };

    ws.onerror = () => setConnection("bad", "Connection issue");
    ws.onclose = () => {
      tickSubId = null;
      setConnection("bad", "Disconnected — reconnecting");
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.7, 15000);
      connect();
    }, reconnectDelay);
  }

  function isSynthetic(s) {
    const text = `${s.symbol || ""} ${s.display_name || ""} ${s.market || ""} ${s.submarket || ""}`.toLowerCase();
    return /synthetic|derived|volatility|boom|crash|step|range break|jump|drift|dex|hybrid|bear|bull/.test(text);
  }

  function validCandle(c) {
    return [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
      c.high >= c.low && c.high >= Math.max(c.open, c.close) &&
      c.low <= Math.min(c.open, c.close);
  }

  function normalizeCandles(raw) {
    return raw.map(c => ({
      time: Number(c.epoch),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    })).filter(validCandle);
  }

  function mergeCandles(existing, incoming) {
    const byTime = new Map(incoming.map(c => [c.time, c]));
    // Combine a historical candle with any live ticks received while history loaded.
    existing.forEach(c => {
      const historical = byTime.get(c.time);
      if (historical) {
        byTime.set(c.time, {
          time: c.time,
          open: historical.open,
          high: Math.max(historical.high, c.high),
          low: Math.min(historical.low, c.low),
          close: c.close
        });
      } else {
        byTime.set(c.time, c);
      }
    });
    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  }

  function requestHistoryPage(page, end) {
    if (!selectedSymbol || !ws || ws.readyState !== WebSocket.OPEN) return;

    const reqId = historyPageReqId++;
    historyRequests.set(reqId, {
      generation: historyGeneration,
      page,
      symbol: selectedSymbol
    });

    const request = {
      ticks_history: selectedSymbol,
      count: HISTORY_PAGE_SIZE,
      end,
      style: "candles",
      granularity: Number($("timeframe").value),
      req_id: reqId
    };

    if (!send(request)) {
      historyRequests.delete(reqId);
      updateHistoryStatus("Unable to request history. Check connection.");
    }
  }

  function handleHistoricalCandles(msg) {
    const reqId = Number(msg.req_id);
    const request = historyRequests.get(reqId);
    if (!request) return;

    historyRequests.delete(reqId);
    if (request.generation !== historyGeneration || request.symbol !== selectedSymbol) return;

    const pageCandles = normalizeCandles(msg.candles);
    if (!pageCandles.length) {
      updateHistoryStatus(candles.length
        ? `Loaded ${candles.length} candles. No older candles were returned.`
        : "No historical candles returned for this market and timeframe.");
      return;
    }

    candles = mergeCandles(candles, pageCandles);
    historyPagesLoaded++;
    historyOldestEpoch = candles.length ? candles[0].time : null;

    candleSeries.setData(candles);
    updateAnalysis();

    if (
      request.page + 1 < HISTORY_MAX_PAGES &&
      candles.length < HISTORY_TARGET &&
      pageCandles.length >= HISTORY_PAGE_SIZE &&
      historyOldestEpoch !== null
    ) {
      updateHistoryStatus(`Loaded ${candles.length} candles. Loading older history…`);
      requestHistoryPage(request.page + 1, String(historyOldestEpoch - 1));
    } else {
      updateHistoryStatus(`History ready: ${candles.length} candles loaded.`);
    }
  }

  function updateHistoryStatus(message) {
    if ($("chartCaption")) {
      const timeframeLabel = $("timeframe").selectedOptions[0]?.textContent || "";
      $("chartCaption").textContent = `${message} · ${timeframeLabel}`;
    }
  }

  function renderMarkets() {
    const query = $("marketSearch").value.toLowerCase();
    const list = symbols.filter(s =>
      `${s.display_name || ""} ${s.symbol || ""}`.toLowerCase().includes(query)
    );

    $("marketList").innerHTML = list.length
      ? ""
      : '<div class="empty">No matching markets found.</div>';

    list.forEach(s => {
      const button = document.createElement("button");
      button.className = "market-item" + (s.symbol === selectedSymbol ? " active" : "");
      const left = document.createElement("div");
      const name = document.createElement("b");
      const sub = document.createElement("small");
      const tag = document.createElement("span");

      name.textContent = s.display_name || s.symbol;
      sub.textContent = s.symbol;
      tag.textContent = "OPEN";
      left.append(name, sub);
      button.append(left, tag);
      button.onclick = () => selectMarket(s.symbol);
      $("marketList").append(button);
    });

    const select = $("marketSelect");
    const old = select.value;
    select.innerHTML = "";
    symbols.forEach(s => {
      const option = document.createElement("option");
      option.value = s.symbol;
      option.textContent = s.display_name || s.symbol;
      select.append(option);
    });
    if (symbols.some(s => s.symbol === old)) select.value = old;
    else if (selectedSymbol) select.value = selectedSymbol;
  }

  function forgetSubscriptions() {
    if (tickSubId) send({ forget: tickSubId });
    tickSubId = null;
  }

  function selectMarket(symbol) {
    if (!symbol || !ws || ws.readyState !== WebSocket.OPEN) return;

    historyGeneration++;
    historyRequests.clear();
    historyPagesLoaded = 0;
    historyOldestEpoch = null;

    forgetSubscriptions();
    selectedSymbol = symbol;
    const market = symbols.find(s => s.symbol === symbol);
    selectedName = market?.display_name || symbol;

    $("marketName").textContent = selectedName;
    $("symbolCode").textContent = symbol;
    $("marketSelect").value = symbol;
    renderMarkets();

    candles = [];
    tickCount = 0;
    lastSignalKey = "";
    candleSeries.setData([]);
    $("lastPrice").textContent = "—";
    $("lastUpdate").textContent = "Waiting for tick";
    $("signalState").textContent = "WAIT";
    $("signalReason").textContent = "Loading history";
    $("signalBig").textContent = "WAIT";
    $("signalBig").className = "signal-big neutral";
    $("signalSummary").textContent = "Waiting for historical market data.";
    resetBacktestDisplay();

    updateHistoryStatus("Loading historical candles…");
    requestHistoryPage(0, "latest");
    send({ ticks: symbol, subscribe: 1 });
  }

  function updateLiveCandle(epoch, price) {
    if (!Number.isFinite(epoch) || !Number.isFinite(price)) return;

    const interval = Number($("timeframe").value);
    const time = Math.floor(epoch / interval) * interval;
    let last = candles[candles.length - 1];

    if (!last || time > last.time) {
      last = { time, open: price, high: price, low: price, close: price };
      candles.push(last);
    } else if (time === last.time) {
      last = {
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price
      };
      candles[candles.length - 1] = last;
    } else {
      return;
    }

    candleSeries.update(last);
    updateAnalysis();
  }

  function ema(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
    for (let i = period; i < values.length; i++) {
      value = values[i] * k + value * (1 - k);
    }
    return value;
  }

  function emaSeries(values, period) {
    const output = Array(values.length).fill(null);
    if (values.length < period) return output;

    const k = 2 / (period + 1);
    let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
    output[period - 1] = value;

    for (let i = period; i < values.length; i++) {
      value = values[i] * k + value * (1 - k);
      output[i] = value;
    }
    return output;
  }

  function rsi(values, period = 14) {
    if (values.length <= period) return null;
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const change = values[i] - values[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }

    let averageGain = gains / period;
    let averageLoss = losses / period;

    for (let i = period + 1; i < values.length; i++) {
      const change = values[i] - values[i - 1];
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);
      averageGain = ((averageGain * (period - 1)) + gain) / period;
      averageLoss = ((averageLoss * (period - 1)) + loss) / period;
    }

    if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
    const relativeStrength = averageGain / averageLoss;
    return 100 - (100 / (1 + relativeStrength));
  }

  function rsiSeries(values, period = 14) {
    const output = Array(values.length).fill(null);
    if (values.length <= period) return output;

    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const change = values[i] - values[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }

    let averageGain = gains / period;
    let averageLoss = losses / period;
    output[period] = averageLoss === 0
      ? (averageGain === 0 ? 50 : 100)
      : 100 - (100 / (1 + averageGain / averageLoss));

    for (let i = period + 1; i < values.length; i++) {
      const change = values[i] - values[i - 1];
      averageGain = ((averageGain * (period - 1)) + Math.max(change, 0)) / period;
      averageLoss = ((averageLoss * (period - 1)) + Math.max(-change, 0)) / period;
      output[i] = averageLoss === 0
        ? (averageGain === 0 ? 50 : 100)
        : 100 - (100 / (1 + averageGain / averageLoss));
    }
    return output;
  }

  function atrSeries(data, period = 14) {
    const output = Array(data.length).fill(null);
    if (data.length < period) return output;

    const trueRanges = data.map((candle, index) => {
      const previousClose = index > 0 ? data[index - 1].close : candle.open;
      return Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose)
      );
    });

    let value = trueRanges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
    output[period - 1] = value;
    for (let i = period; i < data.length; i++) {
      value = ((value * (period - 1)) + trueRanges[i]) / period;
      output[i] = value;
    }
    return output;
  }

  function updateAnalysis() {
    if (candles.length < 35) return;

    const closes = candles.map(c => c.close);
    const fast = ema(closes, 9);
    const slow = ema(closes, 21);
    const rv = rsi(closes, 14);
    if (!Number.isFinite(fast) || !Number.isFinite(slow) || !Number.isFinite(rv)) return;

    const recent = candles.slice(-14);
    const ranges = recent.map(c => c.high - c.low);
    const averageRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const price = closes[closes.length - 1];
    const trend = fast > slow ? "Bullish" : fast < slow ? "Bearish" : "Flat";

    $("emaMetric").textContent = trend;
    $("rsiMetric").textContent = rv.toFixed(1);
    $("volMetric").textContent = averageRange.toPrecision(5);
    $("chartCaption").textContent =
      `${candles.length} candles · ${$("timeframe").selectedOptions[0].textContent}`;

    let score = 0;
    if (fast > slow) score++;
    else if (fast < slow) score--;

    if (rv > 52 && rv < 72) score++;
    else if (rv < 48 && rv > 28) score--;

    const momentum = closes[closes.length - 1] - closes[closes.length - 4];
    if (momentum > 0) score++;
    else if (momentum < 0) score--;

    let state = "WAIT";
    let cls = "neutral";
    let reason = "Indicators do not agree";
    if (score >= 2) {
      state = "BUY BIAS";
      cls = "bull";
      reason = "Uptrend and momentum checks align";
    } else if (score <= -2) {
      state = "SELL BIAS";
      cls = "bear";
      reason = "Downtrend and momentum checks align";
    }

    $("signalState").textContent = state;
    $("signalState").className = cls;
    $("signalBig").textContent = state;
    $("signalBig").className = "signal-big " + cls;
    $("signalReason").textContent = reason;
    $("signalSummary").textContent =
      reason + ". Research bias only; wait for independent confirmation.";
    $("scoreMetric").textContent = `${Math.abs(score)}/3 agreement`;

    const key = `${selectedSymbol}:${$("timeframe").value}:${candles[candles.length - 1].time}:${state}`;
    if (state !== "WAIT" && key !== lastSignalKey) {
      lastSignalKey = key;
      addLog(state, price, reason);
      maybeNotify(state, price);
    }
  }

  function addLog(state, price, reason) {
    const item = {
      state,
      price,
      time: new Date().toLocaleTimeString(),
      market: selectedName,
      reason
    };
    logItems.unshift(item);
    if (logItems.length > 30) logItems.pop();
    renderLog();
  }

  function renderLog() {
    $("signalLog").innerHTML = logItems.length
      ? ""
      : '<div class="empty">No signals recorded yet.</div>';

    logItems.forEach(item => {
      const row = document.createElement("div");
      row.className = "logrow";
      const left = document.createElement("div");
      const right = document.createElement("div");
      const strong = document.createElement("b");
      const small = document.createElement("small");

      strong.textContent = item.state + " · " + item.market;
      small.textContent = item.time + " · " + item.reason;
      left.append(strong, document.createElement("br"), small);
      right.textContent = Number(item.price).toPrecision(7);
      row.append(left, right);
      $("signalLog").append(row);
    });
  }

  function maybeNotify(state, price) {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Deriv Intelligence AI", {
        body: `${state} research bias: ${selectedName} · ${price}`
      });
    }
  }

  function initChart() {
    const element = $("chart");
    chart = LightweightCharts.createChart(element, {
      layout: {
        background: { color: "#0d1929" },
        textColor: "#a8b8ce"
      },
      grid: {
        vertLines: { color: "#17283d" },
        horzLines: { color: "#17283d" }
      },
      rightPriceScale: { borderColor: "#263951" },
      timeScale: {
        borderColor: "#263951",
        timeVisible: true,
        secondsVisible: false
      },
      crosshair: { mode: 1 }
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: "#31d69a",
      downColor: "#ff6f7d",
      borderUpColor: "#31d69a",
      borderDownColor: "#ff6f7d",
      wickUpColor: "#31d69a",
      wickDownColor: "#ff6f7d"
    });

    new ResizeObserver(() => {
      chart.applyOptions({ width: element.clientWidth });
    }).observe(element);
  }

  function resetBacktestDisplay() {
    ["btTrades", "btWinRate", "btNet", "btDrawdown", "btProfitFactor", "btAverage",
      "btBuyNet", "btBuyPF", "btSellNet", "btSellPF"].forEach(id => {
      if ($(id)) $(id).textContent = "—";
    });
    $("btStatus").textContent = "Run a backtest after historical candles load.";
    $("btDetails").textContent = "";
    if ($("oosStatus")) $("oosStatus").textContent = "Run the backtest to evaluate the final 30% of the historical sample separately.";
    if ($("oosResults")) $("oosResults").querySelectorAll("strong").forEach(node => node.textContent = "—");
  }

  function directionStats(trades) {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = losses.reduce((sum, t) => sum + Math.abs(t.pnl), 0);
    return {
      count: trades.length,
      net: grossProfit - grossLoss,
      winRate: trades.length ? wins.length / trades.length * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0
    };
  }

  function simulateStrategy(data, firstSignalIndex = 35) {
    const closes = data.map(c => c.close);
    const fast = emaSeries(closes, 9);
    const slow = emaSeries(closes, 21);
    const rsiValues = rsiSeries(closes, 14);
    const atrValues = atrSeries(data, 14);
    const trades = [];
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;

    for (let i = Math.max(35, firstSignalIndex); i < data.length - 1;) {
      const momentum = closes[i] - closes[i - 3];
      const atr = atrValues[i];
      if (!Number.isFinite(fast[i]) || !Number.isFinite(slow[i]) ||
          !Number.isFinite(rsiValues[i]) || !Number.isFinite(atr) || atr <= 0) {
        i++;
        continue;
      }

      let direction = null;
      if (fast[i] > slow[i] && rsiValues[i] > 50 && rsiValues[i] < 70 && momentum > 0) {
        direction = "BUY";
      } else if (fast[i] < slow[i] && rsiValues[i] < 50 && rsiValues[i] > 30 && momentum < 0) {
        direction = "SELL";
      }
      if (!direction) {
        i++;
        continue;
      }

      // Signal uses candle i close; simulated entry is the next candle open.
      const entryIndex = i + 1;
      const entry = data[entryIndex].open;
      const stopDistance = atr * 1.5;
      const targetDistance = atr * 2;
      const stop = direction === "BUY" ? entry - stopDistance : entry + stopDistance;
      const target = direction === "BUY" ? entry + targetDistance : entry - targetDistance;
      let exit = null;
      let exitReason = "";
      let exitIndex = entryIndex;
      const lastIndex = Math.min(entryIndex + 9, data.length - 1);

      for (let j = entryIndex; j <= lastIndex; j++) {
        const candle = data[j];
        // Conservative intrabar assumption: stop is counted first if both levels are touched.
        if (direction === "BUY") {
          if (candle.low <= stop) { exit = stop; exitReason = "STOP LOSS"; }
          else if (candle.high >= target) { exit = target; exitReason = "TAKE PROFIT"; }
        } else {
          if (candle.high >= stop) { exit = stop; exitReason = "STOP LOSS"; }
          else if (candle.low <= target) { exit = target; exitReason = "TAKE PROFIT"; }
        }
        if (exit !== null) { exitIndex = j; break; }
        if (j === lastIndex) { exit = candle.close; exitReason = "TIME EXIT"; exitIndex = j; }
      }

      if (exit === null) break;
      const pnl = direction === "BUY" ? exit - entry : entry - exit;
      trades.push({ direction, entryTime: data[entryIndex].time, exitTime: data[exitIndex].time,
        entry, exit, pnl, reason: exitReason });
      equity += pnl;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
      i = exitIndex + 1; // one simulated position at a time
    }

    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl < 0).length;
    const grossProfit = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0);
    return {
      trades, wins, losses, equity, maxDrawdown, grossProfit, grossLoss,
      winRate: trades.length ? wins / trades.length * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0
    };
  }

  function runStrategyBacktest() {
    const granularity = Number($("timeframe").value);
    const now = Math.floor(Date.now() / 1000);
    // Keep only fully closed candles; the current live candle is not eligible.
    const data = candles.filter(c => c.time + granularity <= now);
    if (data.length < 100) {
      $("btStatus").textContent = `Need at least 100 closed candles. Currently available: ${data.length}.`;
      return;
    }

    const full = simulateStrategy(data, 35);
    const splitIndex = Math.floor(data.length * 0.70);
    const outOfSample = simulateStrategy(data, splitIndex);
    const buyStats = directionStats(full.trades.filter(t => t.direction === "BUY"));
    const sellStats = directionStats(full.trades.filter(t => t.direction === "SELL"));
    const fmt = value => Number(value).toFixed(3);
    const pf = value => value === Infinity ? "∞" : value.toFixed(2);

    $("btTrades").textContent = String(full.trades.length);
    $("btWinRate").textContent = full.trades.length ? full.winRate.toFixed(1) + "%" : "—";
    $("btNet").textContent = fmt(full.equity);
    $("btDrawdown").textContent = fmt(full.maxDrawdown);
    $("btProfitFactor").textContent = pf(full.profitFactor);
    $("btAverage").textContent = full.trades.length ? fmt(full.equity / full.trades.length) : "—";
    $("btBuyNet").textContent = fmt(buyStats.net);
    $("btBuyPF").textContent = pf(buyStats.profitFactor);
    $("btSellNet").textContent = fmt(sellStats.net);
    $("btSellPF").textContent = pf(sellStats.profitFactor);

    $("btStatus").textContent =
      `${full.wins} wins · ${full.losses} losses · ${full.trades.length} trades · ` +
      `${data.length} closed candles · ${selectedName} · ${$("timeframe").selectedOptions[0].textContent}`;

    $("btDetails").innerHTML = `
      <p><strong>BUY:</strong> ${buyStats.count} trades · ${buyStats.winRate.toFixed(1)}% wins · Net ${fmt(buyStats.net)} · PF ${pf(buyStats.profitFactor)}</p>
      <p><strong>SELL:</strong> ${sellStats.count} trades · ${sellStats.winRate.toFixed(1)}% wins · Net ${fmt(sellStats.net)} · PF ${pf(sellStats.profitFactor)}</p>
      <p><strong>Gross profit:</strong> ${fmt(full.grossProfit)} price units</p>
      <p><strong>Gross loss:</strong> ${fmt(full.grossLoss)} price units</p>
      <p><strong>Recent trades:</strong></p>
      ${full.trades.slice(-10).reverse().map(t => `
        <div class="backtest-result"><strong>${t.direction}</strong>
          <span>${new Date(t.entryTime * 1000).toLocaleString()}</span>
          <span>${t.reason}</span><span>${fmt(t.pnl)}</span>
        </div>`).join("") || "No qualifying trades found."}
      <p class="hint">Price movement units only—not Deriv contract payouts or account-currency profit. Fees, payout rules, stake sizing and execution slippage are not modeled.</p>
    `;

    const oos = $("oosResults");
    if (oos) {
      oos.innerHTML = `
        <div><span>Test-period candles</span><strong>${data.length - splitIndex}</strong></div>
        <div><span>Out-of-sample trades</span><strong>${outOfSample.trades.length}</strong></div>
        <div><span>Win rate</span><strong>${outOfSample.trades.length ? outOfSample.winRate.toFixed(1) + "%" : "—"}</strong></div>
        <div><span>Net price units</span><strong>${fmt(outOfSample.equity)}</strong></div>
        <div><span>Profit factor</span><strong>${pf(outOfSample.profitFactor)}</strong></div>
        <div><span>Max drawdown</span><strong>${fmt(outOfSample.maxDrawdown)}</strong></div>
      `;
    }
    const oosStatus = $("oosStatus");
    if (oosStatus) oosStatus.textContent =
      `Chronological split: first 70% used as indicator history/training period; final 30% used for evaluation. No strategy parameters were tuned on the test segment.`;
  }

  function connectBacktestButton() {
    const button = $("runBacktest");
    if (!button) return;

    button.addEventListener("click", () => {
      $("btStatus").textContent = "Running backtest…";
      try {
        runStrategyBacktest();
      } catch (error) {
        console.error("Backtest error:", error);
        $("btStatus").textContent = "Backtest error: " + error.message;
      }
    });
  }

  $("marketSelect").addEventListener("change", event => selectMarket(event.target.value));
  $("timeframe").addEventListener("change", () => selectMarket(selectedSymbol));
  $("refreshBtn").addEventListener("click", () => selectMarket(selectedSymbol));
  $("marketSearch").addEventListener("input", renderMarkets);
  $("clearLog").addEventListener("click", () => {
    logItems.length = 0;
    renderLog();
  });

  $("notifyBtn").addEventListener("click", async () => {
    if (!("Notification" in window)) {
      $("alertStatus").textContent = "Notifications are not supported in this browser.";
      return;
    }
    const permission = await Notification.requestPermission();
    $("alertStatus").textContent = permission === "granted"
      ? "Browser notifications enabled."
      : "Notification permission not granted.";
  });

  $("testAlertBtn").addEventListener("click", () => {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Deriv Intelligence AI", {
        body: "Browser alert test successful."
      });
    } else {
      $("alertStatus").textContent = "Enable browser alerts first.";
    }
  });

  initChart();
  connect();
  connectBacktestButton();
})();
