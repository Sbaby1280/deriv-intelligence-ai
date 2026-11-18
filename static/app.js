(() => {
"use strict";
const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const $ = id => document.getElementById(id);
let ws, reconnectTimer, symbols = [], candles = [], selectedSymbol = "", selectedName = "";
window.getMarketCandles = () => candles;
let chart, candleSeries, tickSubId = null, historySubId = null, lastSignalKey = "";
let reconnectDelay = 1500, tickCount = 0;
const logItems = [];

function setConnection(state, label) {
  $("connDot").className = "dot " + (state === "ok" ? "ok" : state === "bad" ? "bad" : "");
  $("connText").textContent = label;
}
function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function connect() {
  clearTimeout(reconnectTimer);
  setConnection("", "Connecting to Deriv…");
  try { ws = new WebSocket(WS_URL); } catch (e) { setConnection("bad", "Connection failed"); scheduleReconnect(); return; }
  ws.onopen = () => {
    reconnectDelay = 1500; setConnection("ok", "Connected");
    send({active_symbols:"brief"});
  };
  ws.onmessage = event => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }

  if (msg.error) {
    console.warn("Deriv API:", msg.error.message);
    return;
  }

  if (msg.msg_type === "active_symbols" && Array.isArray(msg.active_symbols)) {
    symbols = msg.active_symbols.map(s => ({
      ...s,
      symbol: s.underlying_symbol,
      display_name: s.underlying_symbol_name,
      symbol_type: s.underlying_symbol_type,
      pip: s.pip_size,
      market_display_name: s.market,
      submarket_display_name: s.submarket,
      subgroup_display_name: s.subgroup
    })).filter(isSynthetic);

    renderMarkets();

    if (!selectedSymbol && symbols.length) {
      selectMarket(symbols[0].symbol);
    }
  }

if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {    candles = msg.candles.map(c => ({
      time: Number(c.epoch),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    })).filter(validCandle);

    candles.sort((a, b) => a.time - b.time);
    candleSeries.setData(candles);
    updateAnalysis();

    if (msg.subscription?.id) historySubId = msg.subscription.id;
  }

  if (msg.msg_type === "tick" && msg.tick) {
    tickCount++;

    $("lastPrice").textContent = Number(msg.tick.quote).toLocaleString(undefined, {
      maximumFractionDigits: 8
    });

    $("lastUpdate").textContent =
      "Updated " + new Date(msg.tick.epoch * 1000).toLocaleTimeString();

    updateLiveCandle(Number(msg.tick.epoch), Number(msg.tick.quote));

    if (msg.subscription?.id) tickSubId = msg.subscription.id;
  }
};
  ws.onerror = () => setConnection("bad", "Connection issue");
  ws.onclose = () => { setConnection("bad", "Disconnected — reconnecting"); scheduleReconnect(); };
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { reconnectDelay = Math.min(reconnectDelay*1.7,15000); connect(); }, reconnectDelay);
}
function isSynthetic(s) {
  const text = `${s.symbol||""} ${s.display_name||""} ${s.market||""} ${s.submarket||""}`.toLowerCase();
  return /synthetic|derived|volatility|boom|crash|step|range break|jump|drift|dex|hybrid|bear|bull/.test(text);
}
function validCandle(c){return [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite)}
function renderMarkets() {
  const query = $("marketSearch").value.toLowerCase();
  const list = symbols.filter(s => `${s.display_name} ${s.symbol}`.toLowerCase().includes(query));
  $("marketList").innerHTML = list.length ? "" : '<div class="empty">No matching markets found.</div>';
  list.forEach(s => {
    const b = document.createElement("button"); b.className = "market-item" + (s.symbol===selectedSymbol?" active":"");
    const left = document.createElement("div"), name=document.createElement("b"), sub=document.createElement("small"), tag=document.createElement("span");
    name.textContent=s.display_name||s.symbol; sub.textContent=s.symbol; tag.textContent="OPEN";
    left.append(name,sub); b.append(left,tag); b.onclick=()=>selectMarket(s.symbol); $("marketList").append(b);
  });
  const select=$("marketSelect"); const old=select.value;
  select.innerHTML="";
  symbols.forEach(s=>{const o=document.createElement("option");o.value=s.symbol;o.textContent=s.display_name||s.symbol;select.append(o)});
  if (symbols.some(s=>s.symbol===old)) select.value=old; else if(selectedSymbol) select.value=selectedSymbol;
}
function forgetSubscriptions() {
  if (tickSubId) send({forget:tickSubId});
  if (historySubId) send({forget:historySubId});
  tickSubId=null; historySubId=null;
}
function selectMarket(symbol) {
  if (!symbol || !ws || ws.readyState!==WebSocket.OPEN) return;
   window.getMarketCandles = () => candles;
  forgetSubscriptions(); selectedSymbol=symbol;
  const s=symbols.find(x=>x.symbol===symbol); selectedName=s?.display_name||symbol;
  $("marketName").textContent=selectedName; $("symbolCode").textContent=symbol;
  $("marketSelect").value=symbol; renderMarkets(); candles=[]; tickCount=0; lastSignalKey="";
  candleSeries.setData([]);
  const granularity=Number($("timeframe").value);
  send({ticks_history:symbol,count:2000,end:"latest",style:"candles",granularity,subscribe:1});
  send({ticks:symbol,subscribe:1});
  $("signalState").textContent="WAIT"; $("signalReason").textContent="Loading history";
}
function updateLiveCandle(epoch, price) {
  const interval=Number($("timeframe").value), time=Math.floor(epoch/interval)*interval;
  let last=candles[candles.length-1];
  if (!last || time>last.time) {
    last={time,open:price,high:price,low:price,close:price}; candles.push(last);
    if(candles.length>500)candles.shift();
  } else if(time===last.time) {
    last={...last,high:Math.max(last.high,price),low:Math.min(last.low,price),close:price}; candles[candles.length-1]=last;
  } else return;
  candleSeries.update(last); updateAnalysis();
}
function ema(values, period) {window.runEMA = ema;
  if(values.length<period)return null;
  const k=2/(period+1); let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++)v=values[i]*k+v*(1-k);
  return v;
}
function rsi(values, period=14) {window.runRSI = rsi;
  if(values.length<=period)return null;
  let gains=0,losses=0;
  for(let i=values.length-period;i<values.length;i++){const d=values[i]-values[i-1];if(d>0)gains+=d;else losses-=d;}
  if(losses===0)return 100;
  return 100-(100/(1+gains/losses));
}
function updateAnalysis() {
  if(candles.length<35)return;
  const closes=candles.map(c=>c.close), fast=ema(closes,9), slow=ema(closes,21), rv=rsi(closes);
  const recent=candles.slice(-14), ranges=recent.map(c=>c.high-c.low);
  const avgRange=ranges.reduce((a,b)=>a+b,0)/ranges.length;
  const price=closes[closes.length-1], trend=fast>slow?"Bullish":fast<slow?"Bearish":"Flat";
  const rsiText=rv===null?"—":rv.toFixed(1);
  $("emaMetric").textContent=trend; $("rsiMetric").textContent=rsiText;
  $("volMetric").textContent=avgRange.toPrecision(5); $("chartCaption").textContent=`${candles.length} candles · ${$("timeframe").selectedOptions[0].textContent}`;
  let score=0; if(fast>slow)score+=1; else if(fast<slow)score-=1;
  if(rv>52 && rv<72)score+=1; else if(rv<48 && rv>28)score-=1;
  const momentum=closes.at(-1)-closes.at(-4); if(momentum>0)score+=1; else if(momentum<0)score-=1;
  let state="WAIT", cls="neutral", reason="Indicators do not agree";
  if(score>=2){state="BUY BIAS";cls="bull";reason="Uptrend and momentum checks align";}
  else if(score<=-2){state="SELL BIAS";cls="bear";reason="Downtrend and momentum checks align";}
  $("signalState").textContent=state; $("signalState").className=cls;
  $("signalBig").textContent=state; $("signalBig").className="signal-big "+cls;
  $("signalReason").textContent=reason; $("signalSummary").textContent=reason+". Research bias only; wait for independent confirmation.";
  $("scoreMetric").textContent=`${Math.abs(score)}/3 agreement`;
  const key=`${selectedSymbol}:${$("timeframe").value}:${candles.at(-1).time}:${state}`;
  if(state!=="WAIT" && key!==lastSignalKey){lastSignalKey=key;addLog(state,price,reason);maybeNotify(state,price);}
}
function addLog(state,price,reason) {
  const item={state,price,time:new Date().toLocaleTimeString(),market:selectedName,reason};logItems.unshift(item);
  if(logItems.length>30)logItems.pop(); renderLog();
}
function renderLog(){
  $("signalLog").innerHTML=logItems.length?"":'<div class="empty">No signals recorded yet.</div>';
  logItems.forEach(x=>{const row=document.createElement("div");row.className="logrow";const a=document.createElement("div"),b=document.createElement("div"),strong=document.createElement("b"),small=document.createElement("small");
    strong.textContent=x.state+" · "+x.market;small.textContent=x.time+" · "+x.reason;a.append(strong,document.createElement("br"),small);b.textContent=x.price.toPrecision(7);row.append(a,b);$("signalLog").append(row);});
}
function maybeNotify(state,price){if(Notification.permission==="granted")new Notification("Deriv Intelligence AI",{body:`${state} research bias: ${selectedName} · ${price}`});}
function initChart(){
  const el=$("chart");chart=LightweightCharts.createChart(el,{layout:{background:{color:"#0d1929"},textColor:"#a8b8ce"},grid:{vertLines:{color:"#17283d"},horzLines:{color:"#17283d"}},rightPriceScale:{borderColor:"#263951"},timeScale:{borderColor:"#263951",timeVisible:true,secondsVisible:false},crosshair:{mode:1}});
  candleSeries=chart.addCandlestickSeries({upColor:"#31d69a",downColor:"#ff6f7d",borderUpColor:"#31d69a",borderDownColor:"#ff6f7d",wickUpColor:"#31d69a",wickDownColor:"#ff6f7d"});
  new ResizeObserver(()=>chart.applyOptions({width:el.clientWidth})).observe(el);
}
$("marketSelect").addEventListener("change",e=>selectMarket(e.target.value));
$("timeframe").addEventListener("change",()=>selectMarket(selectedSymbol));
$("refreshBtn").addEventListener("click",()=>selectMarket(selectedSymbol));
$("marketSearch").addEventListener("input",renderMarkets);
$("clearLog").addEventListener("click",()=>{logItems.length=0;renderLog()});
$("notifyBtn").addEventListener("click",async()=>{if(!("Notification"in window)){$("alertStatus").textContent="Notifications are not supported in this browser.";return;}const p=await Notification.requestPermission();$("alertStatus").textContent=p==="granted"?"Browser notifications enabled.":"Notification permission not granted.";});
$("testAlertBtn").addEventListener("click",()=>{if("Notification"in window&&Notification.permission==="granted")new Notification("Deriv Intelligence AI",{body:"Browser alert test successful."});else $("alertStatus").textContent="Enable browser alerts first."});
initChart(); connect();
})();
function runStrategyBacktest() {
  const data = window.getMarketCandles
    ? window.getMarketCandles()
    : [];

  const status = document.getElementById("btStatus");
  const getEMA = window.runEMA;
  const getRSI = window.runRSI;

  if (data.length < 50) {
    status.textContent = "Load at least 50 candles first.";
    return;
  }

  if (typeof getEMA !== "function" || typeof getRSI !== "function") {
    status.textContent = "EMA or RSI calculation is unavailable.";
    return;
  }

  const closes = data.map(c => c.close);
  const trades = [];

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let i = 35;

  while (i < data.length - 1) {
    const history = closes.slice(0, i + 1);

    const fast = getEMA(history, 9);
    const slow = getEMA(history, 21);
    const rv = getRSI(history);

    if (!Number.isFinite(fast) ||
        !Number.isFinite(slow) ||
        !Number.isFinite(rv)) {
      i++;
      continue;
    }

    const momentum = closes[i] - closes[i - 3];

    let direction = null;

    if (fast > slow && rv > 50 && rv < 70 && momentum > 0) {
      direction = "BUY";
    } else if (fast < slow && rv < 50 && rv > 30 && momentum < 0) {
      direction = "SELL";
    }

    if (!direction) {
      i++;
      continue;
    }

    // Enter at the next candle's open.
    const entryIndex = i + 1;
    const entry = data[entryIndex].open;

    // Simple average candle range as an ATR approximation.
    const window = data.slice(i - 13, i + 1);
    const atr = window.reduce(
      (sum, c) => sum + c.high - c.low, 0
    ) / window.length;

    if (!Number.isFinite(atr) || atr <= 0) {
      i++;
      continue;
    }

    const stopDistance = atr * 1.5;
    const targetDistance = atr * 2;
    const stop = direction === "BUY"
      ? entry - stopDistance
      : entry + stopDistance;
    const target = direction === "BUY"
      ? entry + targetDistance
      : entry - targetDistance;

    let exit = null;
    let exitReason = "";
    let exitIndex = entryIndex;

    // Maximum holding period: 10 candles.
    const lastIndex = Math.min(entryIndex + 9, data.length - 1);

    for (let j = entryIndex; j <= lastIndex; j++) {
      const c = data[j];

      // If both levels are touched, assume the stop was hit first.
      if (direction === "BUY") {
        if (c.low <= stop) {
          exit = stop;
          exitReason = "STOP LOSS";
        } else if (c.high >= target) {
          exit = target;
          exitReason = "TAKE PROFIT";
        }
      } else {
        if (c.high >= stop) {
          exit = stop;
          exitReason = "STOP LOSS";
        } else if (c.low <= target) {
          exit = target;
          exitReason = "TAKE PROFIT";
        }
      }

      if (exit !== null) {
        exitIndex = j;
        break;
      }

      if (j === lastIndex) {
        exit = c.close;
        exitReason = "TIME EXIT";
        exitIndex = j;
      }
    }

    if (exit === null) break;

    const pnl = direction === "BUY"
      ? exit - entry
      : entry - exit;

    trades.push({
      direction,
      entry,
      exit,
      pnl,
      reason: exitReason
    });

    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);

    if (pnl > 0) grossProfit += pnl;
    if (pnl < 0) grossLoss += Math.abs(pnl);

    // Do not open another trade while this one is active.
    i = exitIndex;
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl < 0).length;
  const winRate = trades.length ? wins / trades.length * 100 : 0;

  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0 ? Infinity : 0;

  const buyTrades = trades.filter(t => t.direction === "BUY");
  const sellTrades = trades.filter(t => t.direction === "SELL");

  const buyWins = buyTrades.filter(t => t.pnl > 0).length;
  const sellWins = sellTrades.filter(t => t.pnl > 0).length;

  const fmt = n => Number(n).toFixed(3);

  document.getElementById("btTrades").textContent = trades.length;
  document.getElementById("btWinRate").textContent =
    trades.length ? winRate.toFixed(1) + "%" : "—";
  document.getElementById("btNet").textContent = fmt(equity);
  document.getElementById("btDrawdown").textContent = fmt(maxDrawdown);
  document.getElementById("btProfitFactor").textContent =
    profitFactor === Infinity ? "∞" : profitFactor.toFixed(2);
  document.getElementById("btAverage").textContent =
    trades.length ? fmt(equity / trades.length) : "—";

  status.textContent =
    `${wins} wins · ${losses} losses · ${trades.length} trades · ${data.length} candles`;

  document.getElementById("btDetails").innerHTML = `
    <p><strong>BUY:</strong> ${buyTrades.length} trades,
    ${buyTrades.length ? (buyWins / buyTrades.length * 100).toFixed(1) : 0}% wins</p>
    <p><strong>SELL:</strong> ${sellTrades.length} trades,
    ${sellTrades.length ? (sellWins / sellTrades.length * 100).toFixed(1) : 0}% wins</p>
    <p><strong>Gross profit:</strong> ${fmt(grossProfit)}</p>
    <p><strong>Gross loss:</strong> ${fmt(grossLoss)}</p>
    <p><strong>Recent trades:</strong></p>
    ${trades.slice(-10).reverse().map(t => `
      <div class="backtest-result">
        <strong>${t.direction}</strong>
        <span>${t.reason}</span>
        <span>${fmt(t.pnl)}</span>
      </div>
    `).join("") || "No qualifying trades found."}
  `;
}
function connectBacktestButton() {
  const btn = document.getElementById("runBacktest");

  if (!btn) {
    console.error("Backtest button not found.");
    return;
  }

  btn.addEventListener("click", () => {
    const status = document.getElementById("btStatus");
    status.textContent = "Running backtest...";

    try {
      runStrategyBacktest();
    } catch (error) {
      console.error("Backtest error:", error);
      status.textContent = "Backtest error: " + error.message;
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", connectBacktestButton);
} else {
  connectBacktestButton();
}
