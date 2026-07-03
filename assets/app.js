"use strict";

// ============================================================
// STATE
// ============================================================
const STATE = {
  bars: [],
  cursor: 0,
  position: null,
  trades: [],
  locked: false,
  startEquity: 100000,
  equity: 100000,
  peakEquity: 100000,
  maxDD: 0,
  equityCurve: [],
  playing: false,
  playInterval: null,
  // MA list on main pane
  maList: [
    { id: 1, type: "EMA", period: 20, color: "#fbbf24", enabled: true },
    { id: 2, type: "EMA", period: 50, color: "#60a5fa", enabled: true },
    { id: 3, type: "SMA", period: 200, color: "#a78bfa", enabled: true }
  ],
  maNextId: 4,
  maSeries: {},
  // Dynamic indicator subplot panes
  panes: [],     // [{ id, type, height, params, dom, chart, series }]
  mainPane: null,
  paneNextId: 100
};

// ============================================================
// INDICATOR MATH
// ============================================================
function calcSMA(arr, period) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function calcStd(arr, period) {
  const out = new Array(arr.length).fill(null);
  for (let i = period - 1; i < arr.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += arr[j];
    const mean = s / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (arr[j] - mean) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}
function calcEMA(arr, period) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    prev = prev === null ? arr[i] : arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function calcBB(closes, period, stdMult) {
  const mid = calcSMA(closes, period);
  const std = calcStd(closes, period);
  const up = mid.map((m, i) => m == null ? null : m + stdMult * std[i]);
  const lo = mid.map((m, i) => m == null ? null : m - stdMult * std[i]);
  return { mid, up, lo };
}
function calcKDJ(highs, lows, closes, n, m1, m2) {
  const len = closes.length;
  const rsv = new Array(len).fill(null);
  for (let i = n - 1; i < len; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    rsv[i] = hi === lo ? 50 : (closes[i] - lo) / (hi - lo) * 100;
  }
  const K = new Array(len).fill(null);
  const D = new Array(len).fill(null);
  const J = new Array(len).fill(null);
  let pk = 50, pd = 50;
  for (let i = 0; i < len; i++) {
    if (rsv[i] == null) continue;
    const k = ((m1 - 1) / m1) * pk + (1 / m1) * rsv[i];
    const d = ((m2 - 1) / m2) * pd + (1 / m2) * k;
    K[i] = k; D[i] = d; J[i] = 3 * k - 2 * d;
    pk = k; pd = d;
  }
  return { K, D, J };
}
function calcMACD(closes, fast, slow, sig) {
  const eFast = calcEMA(closes, fast);
  const eSlow = calcEMA(closes, slow);
  const dif = eFast.map((v, i) => v == null || eSlow[i] == null ? null : v - eSlow[i]);
  const dea = calcEMA(dif.map(v => v == null ? 0 : v), sig);
  for (let i = 0; i < dif.length; i++) if (dif[i] == null) dea[i] = null;
  const hist = dif.map((v, i) => v == null || dea[i] == null ? null : (v - dea[i]) * 2);
  return { dif, dea, hist };
}
function calcATR(highs, lows, closes, period) {
  const len = closes.length;
  const tr = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    if (i === 0) tr[i] = highs[i] - lows[i];
    else {
      tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    }
  }
  const atr = new Array(len).fill(null);
  let prev = null;
  for (let i = 0; i < len; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      let s = 0;
      for (let j = 0; j <= i; j++) s += tr[j];
      prev = s / period;
    } else {
      prev = (prev * (period - 1) + tr[i]) / period;
    }
    atr[i] = prev;
  }
  return atr;
}
function calcRSI(closes, period) {
  const len = closes.length;
  const out = new Array(len).fill(null);
  if (len < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < len; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}
function calcStoch(highs, lows, closes, kPeriod, dPeriod) {
  const len = closes.length;
  const k = new Array(len).fill(null);
  for (let i = kPeriod - 1; i < len; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    k[i] = hi === lo ? 50 : (closes[i] - lo) / (hi - lo) * 100;
  }
  const d = calcSMA(k.map(v => v == null ? 0 : v), dPeriod);
  for (let i = 0; i < len; i++) if (k[i] == null) d[i] = null;
  return { k, d };
}

// ============================================================
// PANE DEFINITIONS
// ============================================================
const PANE_DEFS = {
  kdj: {
    name: "KDJ", defaultHeight: 130,
    params: [
      { key: "n", label: "N", def: 9 },
      { key: "m1", label: "M1", def: 3 },
      { key: "m2", label: "M2", def: 3 }
    ],
    initSeries(chart) {
      return {
        K: chart.addLineSeries({ color: "#fbbf24", lineWidth: 1, priceLineVisible: false }),
        D: chart.addLineSeries({ color: "#60a5fa", lineWidth: 1, priceLineVisible: false }),
        J: chart.addLineSeries({ color: "#a78bfa", lineWidth: 1, priceLineVisible: false })
      };
    },
    render(pane, bars, times) {
      const r = calcKDJ(bars.map(b=>b.high), bars.map(b=>b.low), bars.map(b=>b.close),
        pane.params.n, pane.params.m1, pane.params.m2);
      pane.series.K.setData(r.K.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      pane.series.D.setData(r.D.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      pane.series.J.setData(r.J.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    }
  },
  macd: {
    name: "MACD", defaultHeight: 130,
    params: [
      { key: "fast", label: "快線", def: 12 },
      { key: "slow", label: "慢線", def: 26 },
      { key: "sig", label: "訊號", def: 9 }
    ],
    initSeries(chart) {
      return {
        hist: chart.addHistogramSeries({ color: "#475569", priceLineVisible: false }),
        dif:  chart.addLineSeries({ color: "#fbbf24", lineWidth: 1, priceLineVisible: false }),
        dea:  chart.addLineSeries({ color: "#60a5fa", lineWidth: 1, priceLineVisible: false })
      };
    },
    render(pane, bars, times) {
      const r = calcMACD(bars.map(b=>b.close), pane.params.fast, pane.params.slow, pane.params.sig);
      pane.series.hist.setData(r.hist.map((v,i)=>v==null?null:{
        time:times[i], value:v, color: v >= 0 ? "#22c55e" : "#ef4444"
      }).filter(Boolean));
      pane.series.dif.setData(r.dif.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      pane.series.dea.setData(r.dea.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    }
  },
  atr: {
    name: "ATR", defaultHeight: 110,
    params: [{ key: "period", label: "週期", def: 14 }],
    initSeries(chart) {
      return { atr: chart.addLineSeries({ color: "#a78bfa", lineWidth: 1, priceLineVisible: false }) };
    },
    render(pane, bars, times) {
      const v = calcATR(bars.map(b=>b.high), bars.map(b=>b.low), bars.map(b=>b.close), pane.params.period);
      pane.series.atr.setData(v.map((x,i)=>x==null?null:{time:times[i],value:x}).filter(Boolean));
    }
  },
  rsi: {
    name: "RSI", defaultHeight: 110,
    params: [{ key: "period", label: "週期", def: 14 }],
    initSeries(chart) {
      return { rsi: chart.addLineSeries({ color: "#22d3ee", lineWidth: 1, priceLineVisible: false }) };
    },
    render(pane, bars, times) {
      const v = calcRSI(bars.map(b=>b.close), pane.params.period);
      pane.series.rsi.setData(v.map((x,i)=>x==null?null:{time:times[i],value:x}).filter(Boolean));
    }
  },
  stoch: {
    name: "Stoch", defaultHeight: 120,
    params: [
      { key: "k", label: "K", def: 14 },
      { key: "d", label: "D", def: 3 }
    ],
    initSeries(chart) {
      return {
        K: chart.addLineSeries({ color: "#fbbf24", lineWidth: 1, priceLineVisible: false }),
        D: chart.addLineSeries({ color: "#60a5fa", lineWidth: 1, priceLineVisible: false })
      };
    },
    render(pane, bars, times) {
      const r = calcStoch(bars.map(b=>b.high), bars.map(b=>b.low), bars.map(b=>b.close), pane.params.k, pane.params.d);
      pane.series.K.setData(r.k.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      pane.series.D.setData(r.d.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    }
  },
  volume: {
    name: "Volume", defaultHeight: 100,
    params: [],
    initSeries(chart) {
      return { vol: chart.addHistogramSeries({ color: "#475569", priceLineVisible: false }) };
    },
    render(pane, bars, times) {
      pane.series.vol.setData(bars.map((b,i)=>({
        time:times[i], value:b.volume||0,
        color: b.close >= b.open ? "#22c55e80" : "#ef444480"
      })));
    }
  }
};

// ============================================================
// HELPERS
// ============================================================
function getSpread() { return +document.getElementById("spread").value || 0; }
function getMult() { return +document.getElementById("contractMult").value || 100; }
function $(id) { return document.getElementById(id); }

function fmtDateForInput(unixSec) {
  const d = new Date(unixSec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function findBarIdxAtDate(dateStr) {
  // dateStr "YYYY-MM-DD" → find first bar with that or later date (UTC)
  if (!dateStr) return -1;
  const [y, m, d] = dateStr.split("-").map(Number);
  const targetSec = Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000);
  for (let i = 0; i < STATE.bars.length; i++) {
    if (STATE.bars[i].time >= targetSec) return i;
  }
  return STATE.bars.length - 1;
}

// ============================================================
// CSV PARSING
// ============================================================
function parseDateTime(d, t) {
  const ds = String(d);
  const y = +ds.substring(0, 4);
  const m = +ds.substring(4, 6) - 1;
  const day = +ds.substring(6, 8);
  const [hh, mm, ss] = String(t).split(":").map(Number);
  return Math.floor(Date.UTC(y, m, day, hh || 0, mm || 0, ss || 0) / 1000);
}

function parseBars(rows) {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]).map(k => k.toLowerCase());
  let bars = [];
  if (keys.includes("date") && keys.includes("time")) {
    bars = rows.filter(r => r.Date && r.Time).map(r => ({
      time: parseDateTime(r.Date, r.Time),
      open: +r.Open, high: +r.High, low: +r.Low, close: +r.Close,
      volume: +r.Volume || 0,
      label: `${r.Date} ${r.Time}`
    }));
  } else if (keys.includes("datetime") || keys.includes("timestamp")) {
    const tk = keys.includes("datetime") ? "datetime" : "timestamp";
    bars = rows.map(r => {
      const realKey = Object.keys(r).find(k => k.toLowerCase() === tk);
      const tval = r[realKey];
      const t = isNaN(tval) ? Math.floor(new Date(tval).getTime() / 1000) : +tval;
      return {
        time: t, open: +r.Open || +r.open, high: +r.High || +r.high,
        low: +r.Low || +r.low, close: +r.Close || +r.close,
        volume: +r.Volume || +r.volume || 0,
        label: new Date(t * 1000).toISOString()
      };
    });
  } else {
    throw new Error("無法辨識 CSV 欄位（需 Date,Time,Open,High,Low,Close）");
  }
  bars = bars.filter(b => isFinite(b.time) && isFinite(b.close));
  bars.sort((a, b) => a.time - b.time);
  const seen = new Set();
  return bars.filter(b => { if (seen.has(b.time)) return false; seen.add(b.time); return true; });
}

function loadBarsCsv(file) {
  Papa.parse(file, {
    header: true, dynamicTyping: true, skipEmptyLines: true,
    complete: (results) => {
      try {
        const bars = parseBars(results.data);
        if (!bars.length) { alert("CSV 無有效資料"); return; }
        STATE.bars = bars;
        STATE.cursor = Math.min(200, bars.length - 1);
        $("dsInfo").textContent =
          `${file.name} · ${bars.length} 根 K | ${bars[0].label} → ${bars[bars.length-1].label}`;
        $("emptyState").style.display = "none";
        $("sidebar").style.display = "block";
        $("replayControls").style.display = "flex";
        $("dateJumpWrap").style.display = "inline-flex";
        // Set date picker range
        const dEl = $("jumpDate");
        dEl.min = fmtDateForInput(bars[0].time);
        dEl.max = fmtDateForInput(bars[bars.length - 1].time);
        dEl.value = fmtDateForInput(bars[STATE.cursor].time);
        initCharts();
        refresh();
      } catch (e) {
        alert("CSV 解析錯誤: " + e.message);
      }
    }
  });
}

function loadTradesCsv(file) {
  if (!STATE.bars.length) { alert("請先匯入 K 線 CSV"); return; }
  Papa.parse(file, {
    header: true, dynamicTyping: true, skipEmptyLines: true,
    complete: (results) => {
      const rows = results.data;
      if (!rows.length) { alert("交易紀錄為空"); return; }
      // Build a map: bar label → idx (we used "YYYYMMDD HH:MM:SS" or ISO as label)
      const labelToIdx = new Map();
      STATE.bars.forEach((b, i) => labelToIdx.set(String(b.label).trim(), i));
      const importedTrades = [];
      let skipped = 0;
      for (const r of rows) {
        const entryTime = String(r.EntryTime || r.entryTime || "").trim();
        const exitTime  = String(r.ExitTime  || r.exitTime  || "").trim();
        const side = String(r.Side || r.side || "").toLowerCase();
        if (!entryTime || !exitTime || !["long","short"].includes(side)) { skipped++; continue; }
        const entryIdx = labelToIdx.get(entryTime);
        const exitIdx  = labelToIdx.get(exitTime);
        if (entryIdx == null || exitIdx == null) { skipped++; continue; }
        const entryPrice = +r.EntryPrice || +r.entryPrice;
        const exitPrice  = +r.ExitPrice  || +r.exitPrice;
        const size = +r.Size || +r.size || 1;
        const spread = +r.Spread || +r.spread || 0;
        const pnl = +r.PnL || +r.pnl || 0;
        const reason = String(r.Reason || r.reason || "manual");
        // Reconstruct entryBid/entryAsk
        const entryBid = side === "long" ? entryPrice - spread : entryPrice;
        const entryAsk = side === "long" ? entryPrice : entryPrice + spread;
        importedTrades.push({
          side, entryIdx, exitIdx, entryPrice, exitPrice, size,
          entryBid, entryAsk, spread, leverage: 20, sl: null, tp: null,
          pnl, reason, entryTime, exitTime
        });
      }
      if (!importedTrades.length) {
        alert(`匯入失敗：${skipped} 筆紀錄都無法對應到目前資料的時間戳`);
        return;
      }
      importedTrades.sort((a, b) => a.exitIdx - b.exitIdx);
      // Use current input as starting balance and lock it
      applyInitialBalance();
      lockBalance();
      STATE.trades = importedTrades;
      STATE.position = null;
      recalcEquity();
      // Jump cursor to one bar after the last exit
      const lastExit = importedTrades[importedTrades.length - 1].exitIdx;
      STATE.cursor = Math.min(lastExit, STATE.bars.length - 1);
      $("jumpDate").value = fmtDateForInput(STATE.bars[STATE.cursor].time);
      refresh();
      alert(`已匯入 ${importedTrades.length} 筆交易（略過 ${skipped} 筆無法對應的）。已跳到最後一筆交易結束的位置。`);
    }
  });
}

// ============================================================
// MOVING AVERAGES (on main pane)
// ============================================================
function rebuildMaSeries() {
  Object.values(STATE.maSeries).forEach(s => {
    try { STATE.mainPane.chart.removeSeries(s); } catch(e) {}
  });
  STATE.maSeries = {};
  STATE.maList.forEach(ma => {
    STATE.maSeries[ma.id] = STATE.mainPane.chart.addLineSeries({
      color: ma.color, lineWidth: 2, priceLineVisible: false,
      title: `${ma.type}${ma.period}`
    });
  });
}
function renderMaList() {
  const list = $("maList");
  list.innerHTML = "";
  STATE.maList.forEach(ma => {
    const row = document.createElement("div");
    row.className = "ma-row";
    row.innerHTML = `
      <input type="checkbox" data-id="${ma.id}" data-key="enabled" ${ma.enabled?"checked":""}>
      <select data-id="${ma.id}" data-key="type">
        <option value="SMA" ${ma.type==="SMA"?"selected":""}>SMA</option>
        <option value="EMA" ${ma.type==="EMA"?"selected":""}>EMA</option>
      </select>
      <input type="number" data-id="${ma.id}" data-key="period" value="${ma.period}" min="1" max="500">
      <input type="color" data-id="${ma.id}" data-key="color" value="${ma.color}">
      <button class="del-btn" data-id="${ma.id}">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll("input,select").forEach(el => {
    el.onchange = (e) => {
      const id = +e.target.dataset.id;
      const key = e.target.dataset.key;
      const ma = STATE.maList.find(m => m.id === id);
      if (!ma) return;
      if (key === "enabled") ma.enabled = e.target.checked;
      else if (key === "period") ma.period = +e.target.value;
      else if (key === "type") ma.type = e.target.value;
      else if (key === "color") { ma.color = e.target.value; rebuildMaSeries(); }
      refresh();
    };
  });
  list.querySelectorAll(".del-btn").forEach(btn => {
    btn.onclick = () => {
      const id = +btn.dataset.id;
      STATE.maList = STATE.maList.filter(m => m.id !== id);
      rebuildMaSeries(); renderMaList(); refresh();
    };
  });
}
function addMa() {
  const palette = ["#fbbf24","#60a5fa","#a78bfa","#22c55e","#ef4444","#f472b6","#06b6d4","#fb923c"];
  const used = STATE.maList.map(m => m.color);
  const color = palette.find(c => !used.includes(c)) || palette[STATE.maList.length % palette.length];
  STATE.maList.push({ id: STATE.maNextId++, type: "EMA", period: 10, color, enabled: true });
  rebuildMaSeries(); renderMaList(); refresh();
}

// ============================================================
// CHART / PANE MANAGEMENT
// ============================================================
function commonChartOpts(extra = {}) {
  return {
    layout: { background: { color: "#0f1115" }, textColor: "#8da0c0", fontSize: 11 },
    grid: { vertLines: { color: "#1a1f2c" }, horzLines: { color: "#1a1f2c" } },
    rightPriceScale: { borderColor: "#2a3140" },
    timeScale: { borderColor: "#2a3140", timeVisible: true, secondsVisible: false },
    crosshair: { mode: 1 },
    ...extra
  };
}

function createPaneDom(pane, isMain = false) {
  const div = document.createElement("div");
  div.className = "chart-pane" + (isMain ? " main-pane" : "");
  div.dataset.paneId = pane.id;
  if (!isMain) div.style.height = pane.height + "px";

  const label = document.createElement("div");
  label.className = "pane-label";
  label.textContent = isMain ? "Price + BB + MA" : PANE_DEFS[pane.type].name;
  div.appendChild(label);

  const values = document.createElement("div");
  values.className = "pane-values";
  values.id = `vals_${pane.id}`;
  div.appendChild(values);

  if (!isMain) {
    const closeBtn = document.createElement("button");
    closeBtn.className = "pane-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "刪除此面板";
    closeBtn.onclick = () => removePane(pane.id);
    div.appendChild(closeBtn);
  }
  return div;
}

function buildPaneChart(pane, isMain = false) {
  const isLast = pane === STATE.panes[STATE.panes.length - 1];
  const opts = commonChartOpts(
    isLast ? {} : { timeScale: { visible: false, borderColor: "#2a3140" } }
  );
  pane.chart = LightweightCharts.createChart(pane.dom, opts);

  if (isMain) {
    pane.series = {
      candle: pane.chart.addCandlestickSeries({
        upColor: "#22c55e", downColor: "#ef4444", borderUpColor: "#22c55e",
        borderDownColor: "#ef4444", wickUpColor: "#22c55e", wickDownColor: "#ef4444"
      }),
      bbMid: pane.chart.addLineSeries({ color: "#fbbf24", lineWidth: 1, lineStyle: 2, priceLineVisible: false }),
      bbUp:  pane.chart.addLineSeries({ color: "#60a5fa", lineWidth: 1, lineStyle: 2, priceLineVisible: false }),
      bbLo:  pane.chart.addLineSeries({ color: "#60a5fa", lineWidth: 1, lineStyle: 2, priceLineVisible: false })
    };
  } else {
    pane.series = PANE_DEFS[pane.type].initSeries(pane.chart);
  }
}

function createDivider(idxAbove) {
  const d = document.createElement("div");
  d.className = "pane-divider";
  d.dataset.idxAbove = idxAbove;
  d.addEventListener("mousedown", (e) => startResize(e, idxAbove));
  return d;
}

function startResize(e, idxAbove) {
  e.preventDefault();
  const container = $("chartsContainer");
  const above = STATE.panes[idxAbove];
  const below = STATE.panes[idxAbove + 1];
  if (!above || !below) return;
  // We resize subpanes only (heights are fixed px). Main pane (idx 0) auto-fills.
  // Rule: drag transfers height between adjacent panes that have explicit heights.
  // If one of them is the main pane, only the subpane resizes.
  const isAboveMain = above === STATE.mainPane;
  const isBelowMain = below === STATE.mainPane;
  const startY = e.clientY;
  const aboveStart = above.dom.offsetHeight;
  const belowStart = below.dom.offsetHeight;
  const divider = e.target;
  divider.classList.add("dragging");
  document.body.style.cursor = "ns-resize";

  const onMove = (ev) => {
    const dy = ev.clientY - startY;
    if (isAboveMain) {
      // Resize below only; main is flex:1 and will absorb
      const newBelow = Math.max(60, belowStart - dy);
      below.height = newBelow;
      below.dom.style.height = newBelow + "px";
    } else if (isBelowMain) {
      const newAbove = Math.max(60, aboveStart + dy);
      above.height = newAbove;
      above.dom.style.height = newAbove + "px";
    } else {
      const newAbove = Math.max(60, aboveStart + dy);
      const newBelow = Math.max(60, belowStart - dy);
      // Maintain total
      if (newAbove + newBelow !== aboveStart + belowStart) return;
      above.height = newAbove; below.height = newBelow;
      above.dom.style.height = newAbove + "px";
      below.dom.style.height = newBelow + "px";
    }
    // Resize charts
    above.chart.applyOptions({ width: above.dom.clientWidth, height: above.dom.clientHeight });
    below.chart.applyOptions({ width: below.dom.clientWidth, height: below.dom.clientHeight });
  };
  const onUp = () => {
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function rebuildLayout() {
  const container = $("chartsContainer");
  container.innerHTML = "";
  STATE.panes.forEach((pane, i) => {
    container.appendChild(pane.dom);
    if (i < STATE.panes.length - 1) {
      container.appendChild(createDivider(i));
    }
  });
  // After DOM is laid out, ensure all charts get correct size
  requestAnimationFrame(() => {
    STATE.panes.forEach(p => {
      if (p.chart) p.chart.applyOptions({ width: p.dom.clientWidth, height: p.dom.clientHeight });
    });
  });
}

function addPane(type) {
  if (!STATE.bars.length) return;
  const def = PANE_DEFS[type];
  if (!def) return;
  const params = {};
  def.params.forEach(p => { params[p.key] = p.def; });
  const pane = {
    id: STATE.paneNextId++,
    type, params,
    height: def.defaultHeight,
    dom: null, chart: null, series: {}
  };
  pane.dom = createPaneDom(pane, false);
  STATE.panes.push(pane);
  rebuildLayout();
  buildPaneChart(pane, false);
  refreshTimeScaleVisibility();
  syncTimeScales();
  subscribeCrosshair(pane);
  renderPaneList();
  refresh();
}

function removePane(id) {
  const idx = STATE.panes.findIndex(p => p.id === id);
  if (idx < 0) return;
  const pane = STATE.panes[idx];
  if (pane === STATE.mainPane) return;
  try { pane.chart.remove(); } catch(e) {}
  STATE.panes.splice(idx, 1);
  rebuildLayout();
  refreshTimeScaleVisibility();
  syncTimeScales();
  renderPaneList();
  refresh();
}

function renderPaneList() {
  const list = $("paneList");
  list.innerHTML = "";
  STATE.panes.filter(p => p !== STATE.mainPane).forEach(pane => {
    const def = PANE_DEFS[pane.type];
    const item = document.createElement("div");
    item.className = "pane-item";
    let paramHtml = "";
    def.params.forEach(p => {
      paramHtml += `<div><label>${p.label}</label><input type="number" data-pid="${pane.id}" data-pkey="${p.key}" value="${pane.params[p.key]}"></div>`;
    });
    item.innerHTML = `
      <div class="pane-item-header">
        <span class="pane-item-name">${def.name}</span>
        <button class="del-pane-btn" data-pid="${pane.id}">✕</button>
      </div>
      <div class="pane-params">${paramHtml || '<span class="hint-small">無參數</span>'}</div>`;
    list.appendChild(item);
  });
  list.querySelectorAll(".del-pane-btn").forEach(b => {
    b.onclick = () => removePane(+b.dataset.pid);
  });
  list.querySelectorAll(".pane-params input").forEach(inp => {
    inp.onchange = (e) => {
      const pid = +e.target.dataset.pid;
      const pkey = e.target.dataset.pkey;
      const pane = STATE.panes.find(p => p.id === pid);
      if (!pane) return;
      pane.params[pkey] = +e.target.value;
      refresh();
    };
  });
}

function syncTimeScales() {
  // Cross-pane time-scale + cursor sync, idempotent
  let syncing = false;
  STATE.panes.forEach(src => {
    src.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncing || !range) return;
      syncing = true;
      STATE.panes.forEach(dst => {
        if (dst !== src) dst.chart.timeScale().setVisibleLogicalRange(range);
      });
      syncing = false;
    });
  });
}
function subscribeCrosshair(pane) {
  pane.chart.subscribeCrosshairMove((param) => {
    if (!param.time) return;
    updateValuesAt(param.time);
  });
}

function refreshTimeScaleVisibility() {
  // Ensure exactly one pane (the last one) shows the time axis.
  if (!STATE.panes.length) return;
  const last = STATE.panes.length - 1;
  STATE.panes.forEach((pane, i) => {
    if (!pane.chart) return;
    pane.chart.applyOptions({
      timeScale: {
        visible: i === last,
        borderColor: "#2a3140",
        timeVisible: true,
        secondsVisible: false
      }
    });
  });
}

function initCharts() {
  // Reset
  STATE.panes.forEach(p => { try { p.chart.remove(); } catch(e) {} });
  STATE.panes = [];
  STATE.maSeries = {};

  // Main price pane
  const main = { id: 0, type: "price", height: 0, params: {}, dom: null, chart: null, series: {} };
  main.dom = createPaneDom(main, true);
  STATE.panes.push(main);
  STATE.mainPane = main;

  // Default subpanes
  ["kdj", "macd", "atr"].forEach(t => {
    const def = PANE_DEFS[t];
    const params = {};
    def.params.forEach(p => { params[p.key] = p.def; });
    const pane = { id: STATE.paneNextId++, type: t, params, height: def.defaultHeight,
                   dom: null, chart: null, series: {} };
    pane.dom = createPaneDom(pane, false);
    STATE.panes.push(pane);
  });

  rebuildLayout();
  STATE.panes.forEach((p, i) => buildPaneChart(p, i === 0));
  refreshTimeScaleVisibility();
  rebuildMaSeries();
  renderMaList();
  renderPaneList();
  syncTimeScales();
  STATE.panes.forEach(subscribeCrosshair);

  // Window resize observer
  new ResizeObserver(() => {
    STATE.panes.forEach(p => {
      if (p.chart) p.chart.applyOptions({ width: p.dom.clientWidth, height: p.dom.clientHeight });
    });
  }).observe($("chartsContainer"));
}

// ============================================================
// REFRESH / RENDER
// ============================================================
// Bound the size of every per-refresh computation. Without this, advancing
// cursor to bar 100,000 would force indicators + setData() over 100K points
// every step, which can take >1s. 5000 is plenty for visual context and gives
// every indicator more than enough warm-up data.
const RENDER_WINDOW = 5000;

function getVisibleBars() {
  if (!STATE.bars.length) return [];
  const end = STATE.cursor + 1;
  const start = Math.max(0, end - RENDER_WINDOW);
  return STATE.bars.slice(start, end);
}

function refresh() {
  if (!STATE.bars.length || !STATE.mainPane) return;
  const bars = getVisibleBars();
  const times = bars.map(b => b.time);
  const closes = bars.map(b => b.close);

  // Main: candles
  STATE.mainPane.series.candle.setData(
    bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }))
  );

  // MAs
  const showMA = $("showMA").checked;
  STATE.maList.forEach(ma => {
    const s = STATE.maSeries[ma.id];
    if (!s) return;
    if (!showMA || !ma.enabled) { s.setData([]); return; }
    const vals = ma.type === "EMA" ? calcEMA(closes, ma.period) : calcSMA(closes, ma.period);
    s.setData(vals.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
  });

  // BB
  if ($("showBB").checked) {
    const period = +$("bbPeriod").value;
    const stdM = +$("bbStd").value;
    const bb = calcBB(closes, period, stdM);
    STATE.mainPane.series.bbMid.setData(bb.mid.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    STATE.mainPane.series.bbUp.setData(bb.up.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    STATE.mainPane.series.bbLo.setData(bb.lo.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
  } else {
    STATE.mainPane.series.bbMid.setData([]);
    STATE.mainPane.series.bbUp.setData([]);
    STATE.mainPane.series.bbLo.setData([]);
  }

  // Subpanes
  STATE.panes.filter(p => p !== STATE.mainPane).forEach(pane => {
    PANE_DEFS[pane.type].render(pane, bars, times);
  });

  // Position markers + bottom widgets
  drawPositionMarkers();
  updateValuesAt(times[times.length - 1]);
  updateStats();
  updatePositionCard();

  // Update date input
  if (STATE.cursor >= 0 && STATE.cursor < STATE.bars.length) {
    $("jumpDate").value = fmtDateForInput(STATE.bars[STATE.cursor].time);
  }
}

function updateValuesAt(time) {
  if (!time) return;
  const idx = STATE.bars.findIndex(b => b.time === time);
  if (idx < 0) return;
  const b = STATE.bars[idx];
  const spread = getSpread();
  const valsEl = document.querySelector(".main-pane .pane-values");
  if (valsEl) {
    valsEl.innerHTML =
      `<span style="color:#8da0c0">O</span> ${b.open.toFixed(3)} ` +
      `<span style="color:#8da0c0">H</span> ${b.high.toFixed(3)} ` +
      `<span style="color:#8da0c0">L</span> ${b.low.toFixed(3)} ` +
      `<span style="color:#8da0c0">C</span> ${b.close.toFixed(3)}`;
  }
  const cur = STATE.bars[STATE.cursor];
  if (cur) {
    const bid = cur.close;
    const ask = bid + spread;
    $("dispBid").textContent = bid.toFixed(3);
    $("dispAsk").textContent = ask.toFixed(3);
    $("dispSpread").textContent = spread.toFixed(2);
  }
}

function drawPositionMarkers() {
  if (!STATE.mainPane) return;
  const markers = [];
  STATE.trades.forEach((t, i) => {
    markers.push({
      time: STATE.bars[t.entryIdx].time,
      position: t.side === "long" ? "belowBar" : "aboveBar",
      color: t.side === "long" ? "#22c55e" : "#ef4444",
      shape: t.side === "long" ? "arrowUp" : "arrowDown",
      text: `${t.side === "long" ? "L" : "S"}#${i+1}`
    });
    if (t.exitIdx != null) {
      markers.push({
        time: STATE.bars[t.exitIdx].time,
        position: "inBar",
        color: t.pnl >= 0 ? "#22c55e" : "#ef4444",
        shape: "circle",
        text: t.pnl.toFixed(0)
      });
    }
  });
  if (STATE.position) {
    const p = STATE.position;
    markers.push({
      time: STATE.bars[p.entryIdx].time,
      position: p.side === "long" ? "belowBar" : "aboveBar",
      color: p.side === "long" ? "#22c55e" : "#ef4444",
      shape: p.side === "long" ? "arrowUp" : "arrowDown",
      text: `${p.side === "long" ? "L" : "S"} OPEN`
    });
  }
  markers.sort((a, b) => a.time - b.time);
  STATE.mainPane.series.candle.setMarkers(markers);
}

// ============================================================
// BALANCE LOCK
// ============================================================
function applyInitialBalance() {
  if (STATE.locked) return false;
  const v = +$("initBalance").value;
  if (!isFinite(v) || v <= 0) return false;
  STATE.startEquity = v;
  STATE.equity = v;
  STATE.peakEquity = v;
  STATE.maxDD = 0;
  return true;
}
function lockBalance() {
  STATE.locked = true;
  const input = $("initBalance");
  input.disabled = true;
  input.style.opacity = "0.55";
  input.style.cursor = "not-allowed";
  $("lockIcon").innerHTML = "🔒 已鎖";
  $("lockIcon").style.color = "#fbbf24";
  $("balanceHint").textContent = "模擬已開始，餘額由交易結果決定（重置帳戶可解鎖）";
}
function unlockBalance() {
  STATE.locked = false;
  const input = $("initBalance");
  input.disabled = false;
  input.style.opacity = "1";
  input.style.cursor = "auto";
  $("lockIcon").innerHTML = "🔓 可改";
  $("lockIcon").style.color = "#8da0c0";
  $("balanceHint").textContent = "模擬開始（首筆交易）後將鎖定";
}

// ============================================================
// TRADING
// ============================================================
function recordTrade(p, exitIdx, exitPrice, pnl, reason, bar) {
  STATE.equity += pnl;
  STATE.peakEquity = Math.max(STATE.peakEquity, STATE.equity);
  STATE.maxDD = Math.max(STATE.maxDD, (STATE.peakEquity - STATE.equity) / STATE.peakEquity);
  STATE.equityCurve.push({ time: bar.time, equity: STATE.equity });
  STATE.trades.push({
    side: p.side, entryIdx: p.entryIdx, exitIdx,
    entryPrice: p.entryPrice, exitPrice, size: p.size,
    entryBid: p.entryBid, entryAsk: p.entryAsk, spread: p.spread,
    leverage: p.leverage, sl: p.sl, tp: p.tp,
    pnl, reason, entryTime: p.entryTime, exitTime: bar.label
  });
  STATE.position = null;
}
function recalcEquity() {
  STATE.equity = STATE.startEquity;
  STATE.peakEquity = STATE.startEquity;
  STATE.maxDD = 0;
  STATE.equityCurve = [];
  STATE.trades.forEach(t => {
    STATE.equity += t.pnl;
    if (STATE.equity > STATE.peakEquity) STATE.peakEquity = STATE.equity;
    const dd = STATE.peakEquity > 0 ? (STATE.peakEquity - STATE.equity) / STATE.peakEquity : 0;
    if (dd > STATE.maxDD) STATE.maxDD = dd;
    STATE.equityCurve.push({ time: STATE.bars[t.exitIdx].time, equity: STATE.equity });
  });
}
function reopenTradeAsPosition(t) {
  STATE.position = {
    side: t.side, entryPrice: t.entryPrice,
    entryBid: t.entryBid, entryAsk: t.entryAsk, spread: t.spread,
    entryIdx: t.entryIdx, size: t.size, leverage: t.leverage,
    sl: t.sl, tp: t.tp, entryTime: t.entryTime
  };
}

function placeOrder(side) {
  const type = $("orderType").value;

  // Validate trigger price for non-market
  if (type !== "market") {
    const trig = +$("triggerPrice").value;
    if (!isFinite(trig) || trig <= 0) { alert("請輸入有效的觸發價"); return; }
    if (type === "oco") {
      const trig2 = +$("triggerPrice2").value;
      if (!isFinite(trig2) || trig2 <= 0) { alert("OCO 需要兩個觸發價"); return; }
    }
  }

  const cfg = readSLTPConfig();

  // MARKET ENTRY
  if (type === "market") {
    if (STATE.position) { alert("已有持倉，請先平倉"); return; }
    if (STATE.cursor >= STATE.bars.length - 1) { alert("已到資料尾端，無法下單"); return; }
    if (!STATE.locked) {
      if (!applyInitialBalance()) { alert("初始餘額無效"); return; }
      lockBalance();
    }
    const entryBarIdx = STATE.cursor + 1;
    const entryBar = STATE.bars[entryBarIdx];
    const size = +$("orderSize").value;
    const lev = +$("orderLev").value;
    const spread = getSpread();
    const entryBid = entryBar.open;
    const entryAsk = entryBid + spread;
    const entryPrice = side === "long" ? entryAsk : entryBid;

    const slRes = resolveSL(cfg, side, entryAsk, entryBid, spread);
    if (slRes.invalid) return;
    const tp = resolveTP(cfg, side, entryAsk, entryBid, spread);

    STATE.position = {
      side, entryPrice, entryBid, entryAsk, spread,
      entryIdx: entryBarIdx, size, leverage: lev,
      sl: slRes.sl, tp, trail: slRes.trail,
      entryTime: entryBar.label
    };
    STATE.cursor++;
    refresh();
    return;
  }

  // PENDING (limit/stop) — store config, resolve at trigger
  const trig = +$("triggerPrice").value;
  if (type === "limit" || type === "stop") {
    const curBid = STATE.bars[STATE.cursor].close;
    if (type === "limit") {
      if (side === "long" && trig >= curBid) {
        if (!confirm(`Buy Limit 應低於現價 ${curBid.toFixed(3)}，確定？`)) return;
      }
      if (side === "short" && trig <= curBid) {
        if (!confirm(`Sell Limit 應高於現價 ${curBid.toFixed(3)}，確定？`)) return;
      }
    } else {
      if (side === "long" && trig <= curBid) {
        if (!confirm(`Buy Stop 應高於現價 ${curBid.toFixed(3)}，確定？`)) return;
      }
      if (side === "short" && trig >= curBid) {
        if (!confirm(`Sell Stop 應低於現價 ${curBid.toFixed(3)}，確定？`)) return;
      }
    }
    placePendingOrder(side, type, trig, null, cfg);
    renderPendingOrders();
    return;
  }

  // OCO — two same-side pending orders
  if (type === "oco") {
    const trig2 = +$("triggerPrice2").value;
    const groupId = STATE.ocoNextGroupId++;
    const [hi, lo] = trig > trig2 ? [trig, trig2] : [trig2, trig];
    if (side === "long") {
      placePendingOrder("long", "stop",  hi, groupId, cfg);
      placePendingOrder("long", "limit", lo, groupId, cfg);
    } else {
      placePendingOrder("short", "stop",  lo, groupId, cfg);
      placePendingOrder("short", "limit", hi, groupId, cfg);
    }
    renderPendingOrders();
    return;
  }
}

function closePosition(reason = "manual") {
  if (!STATE.position) return;
  let exitIdx, exitBidRaw;
  if (STATE.cursor >= STATE.bars.length - 1) {
    exitIdx = STATE.cursor;
    exitBidRaw = STATE.bars[exitIdx].close;
  } else {
    exitIdx = STATE.cursor + 1;
    exitBidRaw = STATE.bars[exitIdx].open;
  }
  const p = STATE.position;
  const mult = getMult();
  const exitAskRaw = exitBidRaw + p.spread;
  const exitPrice = p.side === "long" ? exitBidRaw : exitAskRaw;
  const pnl = p.side === "long"
    ? (exitPrice - p.entryPrice) * p.size * mult
    : (p.entryPrice - exitPrice) * p.size * mult;
  recordTrade(p, exitIdx, exitPrice, pnl, reason, STATE.bars[exitIdx]);
  refresh();
}

function checkSLTP() {
  if (!STATE.position) return false;
  const bar = STATE.bars[STATE.cursor];
  const p = STATE.position;
  if (p.entryIdx > STATE.cursor) return false;
  const mult = getMult();
  if (p.side === "long") {
    if (p.sl != null && bar.low <= p.sl) {
      const ep = p.sl;
      const pnl = (ep - p.entryPrice) * p.size * mult;
      recordTrade(p, STATE.cursor, ep, pnl, "SL", bar);
      return true;
    }
    if (p.tp != null && bar.high >= p.tp) {
      const ep = p.tp;
      const pnl = (ep - p.entryPrice) * p.size * mult;
      recordTrade(p, STATE.cursor, ep, pnl, "TP", bar);
      return true;
    }
  } else {
    const askHigh = bar.high + p.spread;
    const askLow = bar.low + p.spread;
    if (p.sl != null && askHigh >= p.sl) {
      const ep = p.sl;
      const pnl = (p.entryPrice - ep) * p.size * mult;
      recordTrade(p, STATE.cursor, ep, pnl, "SL", bar);
      return true;
    }
    if (p.tp != null && askLow <= p.tp) {
      const ep = p.tp;
      const pnl = (p.entryPrice - ep) * p.size * mult;
      recordTrade(p, STATE.cursor, ep, pnl, "TP", bar);
      return true;
    }
  }
  return false;
}

function updatePositionCard() {
  const el = $("positionCard");
  if (!STATE.position) { el.innerHTML = ""; return; }
  const p = STATE.position;
  const mult = getMult();
  const curBid = STATE.bars[STATE.cursor].close;
  const curAsk = curBid + p.spread;
  const upnl = p.side === "long"
    ? (curBid - p.entryPrice) * p.size * mult
    : (p.entryPrice - curAsk) * p.size * mult;
  const entryLabel = p.side === "long"
    ? `${p.entryPrice.toFixed(3)} <span style="color:#8da0c0">(Ask)</span>`
    : `${p.entryPrice.toFixed(3)} <span style="color:#8da0c0">(Bid)</span>`;
  el.innerHTML = `<div class="position-card ${p.side}">
    <div style="display:flex;justify-content:space-between"><b>${p.side.toUpperCase()}</b><span>${p.size} 口 · ${p.leverage}x · 點差 ${p.spread.toFixed(2)}</span></div>
    <div class="stat"><span class="k">進場價</span><span class="v">${entryLabel}</span></div>
    <div class="stat"><span class="k">現價 Bid / Ask</span><span class="v">${curBid.toFixed(3)} / ${curAsk.toFixed(3)}</span></div>
    <div class="stat"><span class="k">SL / TP</span><span class="v">${p.sl!=null?p.sl.toFixed(3):"—"} / ${p.tp!=null?p.tp.toFixed(3):"—"}</span></div>
    <div class="stat"><span class="k">浮動 P&L</span><span class="v ${upnl>=0?'pos':'neg'}">${upnl.toFixed(2)}</span></div>
  </div>`;
}

// ============================================================
// STATS
// ============================================================
function updateStats() {
  const t = STATE.trades;
  const total = t.length;
  const wins = t.filter(x => x.pnl > 0);
  const losses = t.filter(x => x.pnl <= 0);
  const winRate = total ? wins.length / total : 0;
  const grossWin = wins.reduce((s, x) => s + x.pnl, 0);
  const grossLoss = losses.reduce((s, x) => s + Math.abs(x.pnl), 0);
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const totalPnL = grossWin - grossLoss;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const rr = avgLoss > 0 ? avgWin / avgLoss : 0;
  const ret = (STATE.equity - STATE.startEquity) / STATE.startEquity;
  let sharpe = 0;
  if (total > 1) {
    const rets = t.map(x => x.pnl / STATE.startEquity);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    const sd = Math.sqrt(v);
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(total) : 0;
  }
  const exp = total ? totalPnL / total : 0;
  const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const setV = (id, v, cls = "") => {
    const el = $(id); el.textContent = v; el.className = "v " + cls;
  };
  setV("sTotal", total);
  setV("sWin", (winRate * 100).toFixed(2) + "%", winRate >= 0.5 ? "pos" : "neg");
  setV("sPnL", fmt(totalPnL), totalPnL >= 0 ? "pos" : "neg");
  setV("sEquity", fmt(STATE.equity));
  setV("sRet", (ret * 100).toFixed(2) + "%", ret >= 0 ? "pos" : "neg");
  setV("sPF", isFinite(pf) ? pf.toFixed(2) : "∞", pf >= 1 ? "pos" : "neg");
  setV("sAvg", fmt(avgWin) + " / " + fmt(avgLoss));
  setV("sRR", rr.toFixed(2));
  setV("sSharpe", sharpe.toFixed(2), sharpe >= 1 ? "pos" : "neg");
  setV("sDD", (STATE.maxDD * 100).toFixed(2) + "%", "neg");
  setV("sExp", fmt(exp), exp >= 0 ? "pos" : "neg");

  const tbody = document.querySelector("#tradeTable tbody");
  tbody.innerHTML = "";
  t.slice().reverse().forEach((x, j) => {
    const idx = t.length - j;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${idx}</td>
      <td class="${x.side==='long'?'pos':'neg'}">${x.side==='long'?'L':'S'}</td>
      <td>${x.entryPrice.toFixed(3)}</td>
      <td>${x.exitPrice.toFixed(3)}</td>
      <td>${x.reason}</td>
      <td class="${x.pnl>=0?'pos':'neg'}">${x.pnl.toFixed(2)}</td>`;
    tbody.appendChild(tr);
  });
}

// ============================================================
// REPLAY CONTROLS
// ============================================================
function stepForward() {
  if (STATE.cursor >= STATE.bars.length - 1) { stopPlay(); return; }
  STATE.cursor++;
  // === Conservative trail order (Option C) ===
  // 1) checkSLTP first — uses the SL value carried over from the previous bar.
  //    This prevents the "same-bar high then low" trap where trail ratchets SL
  //    up based on this bar's high, then the same bar's low immediately stops out.
  // 2) checkPendingOrders may open a new position from limit/stop triggers.
  // 3) updateTrailingSL last — updates bestPrice + SL for the NEXT bar's check.
  checkSLTP();
  checkPendingOrders();
  updateTrailingSL();
  refresh();
}
function stepBack() {
  if (STATE.cursor <= 1) return;
  STATE.cursor--;
  let changed = false;
  while (STATE.trades.length > 0 &&
         STATE.trades[STATE.trades.length - 1].exitIdx > STATE.cursor) {
    if (STATE.position) break;
    const last = STATE.trades.pop();
    reopenTradeAsPosition(last);
    changed = true;
  }
  if (STATE.position && STATE.position.entryIdx > STATE.cursor) {
    STATE.position = null;
    changed = true;
  }
  if (changed) {
    recalcEquity();
    if (STATE.trades.length === 0 && !STATE.position && STATE.locked) {
      unlockBalance();
    }
  }
  refresh();
}
function startPlay() {
  if (STATE.playing) return;
  STATE.playing = true;
  $("play").textContent = "⏸ 暫停";
  STATE.playInterval = setInterval(stepForward, +$("speed").value);
}
function stopPlay() {
  STATE.playing = false;
  $("play").textContent = "▶ 播放";
  if (STATE.playInterval) clearInterval(STATE.playInterval);
  STATE.playInterval = null;
}

// ============================================================
// EVENT BINDINGS
// ============================================================
$("csvFile").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (f) loadBarsCsv(f);
  e.target.value = "";
});
$("tradesFile").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (f) loadTradesCsv(f);
  e.target.value = "";
});
// Use arrow wrappers so later overrides (pending orders, trailing SL) are picked up.
// Direct assignment captures the function reference at this line, losing all later overrides.
$("nextBar").onclick = () => stepForward();
$("prevBar").onclick = () => stepBack();
$("play").onclick = () => { STATE.playing ? stopPlay() : startPlay(); };
$("speed").onchange = () => { if (STATE.playing) { stopPlay(); startPlay(); } };
$("jumpStart").onclick = () => { STATE.cursor = Math.min(200, STATE.bars.length - 1); refresh(); };
$("jumpEnd").onclick = () => { STATE.cursor = STATE.bars.length - 1; refresh(); };
$("btnJumpDate").onclick = () => {
  const idx = findBarIdxAtDate($("jumpDate").value);
  if (idx < 0) return;
  STATE.cursor = idx;
  // Step-back logic should also kick in for safety
  let changed = false;
  while (STATE.trades.length > 0 &&
         STATE.trades[STATE.trades.length - 1].exitIdx > STATE.cursor) {
    if (STATE.position) break;
    const last = STATE.trades.pop();
    reopenTradeAsPosition(last);
    changed = true;
  }
  if (STATE.position && STATE.position.entryIdx > STATE.cursor) {
    STATE.position = null; changed = true;
  }
  if (changed) {
    recalcEquity();
    if (STATE.trades.length === 0 && !STATE.position && STATE.locked) unlockBalance();
  }
  refresh();
};
$("btnLong").onclick = () => placeOrder("long");
$("btnShort").onclick = () => placeOrder("short");
$("btnFlat").onclick = () => closePosition("manual");
$("applyParams").onclick = refresh;
["showMA","showBB"].forEach(id => $(id).onchange = refresh);
$("addMa").onclick = addMa;
$("addPane").onclick = () => addPane($("newPaneType").value);
$("spread").onchange = () => {
  $("dispSpread").textContent = getSpread().toFixed(2);
  refresh();
};
$("btnReset").onclick = () => {
  if (!confirm("確定重置？所有交易記錄將清空，初始餘額將解鎖")) return;
  STATE.trades = []; STATE.position = null; STATE.equityCurve = [];
  unlockBalance();
  applyInitialBalance();
  refresh();
};
$("initBalance").addEventListener("input", () => {
  if (STATE.locked) return;
  if (applyInitialBalance()) refresh();
});
$("btnExport").onclick = () => {
  if (!STATE.trades.length) { alert("尚無交易"); return; }
  const headers = ["#","Side","EntryTime","EntryPrice","ExitTime","ExitPrice","Size","Spread","Reason","PnL"];
  const lines = [headers.join(",")];
  STATE.trades.forEach((t, i) => {
    lines.push([i+1, t.side, t.entryTime, t.entryPrice, t.exitTime, t.exitPrice, t.size, (t.spread||0).toFixed(2), t.reason, t.pnl.toFixed(2)].join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "trades_" + Date.now() + ".csv";
  a.click();
};

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "ArrowRight" || e.code === "Space") { e.preventDefault(); stepForward(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); stepBack(); }
  else if (e.key === "b" || e.key === "B") placeOrder("long");
  else if (e.key === "s" || e.key === "S") placeOrder("short");
  else if (e.key === "f" || e.key === "F") closePosition("manual");
  else if (e.key === "p" || e.key === "P") { STATE.playing ? stopPlay() : startPlay(); }
});

// ============================================================
// ADDITIONAL INDICATOR MATH (subplot)
// ============================================================
function calcMomentum(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) out[i] = closes[i] - closes[i-period];
  return out;
}
function calcROC(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i-period] !== 0 ? (closes[i]/closes[i-period] - 1) * 100 : null;
  }
  return out;
}
function calcCCI(highs, lows, closes, period) {
  const tp = closes.map((c,i) => (highs[i]+lows[i]+c)/3);
  const sma = calcSMA(tp, period);
  const out = new Array(tp.length).fill(null);
  for (let i = period-1; i < tp.length; i++) {
    let md = 0;
    for (let j = i-period+1; j <= i; j++) md += Math.abs(tp[j] - sma[i]);
    md /= period;
    out[i] = md === 0 ? 0 : (tp[i] - sma[i]) / (0.015 * md);
  }
  return out;
}
function calcWilliamsR(highs, lows, closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period-1; i < closes.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i-period+1; j <= i; j++) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    out[i] = hi === lo ? -50 : ((hi - closes[i]) / (hi - lo)) * -100;
  }
  return out;
}
function calcADX(highs, lows, closes, period) {
  const len = closes.length;
  const tr = new Array(len).fill(0);
  const pDM = new Array(len).fill(0);
  const mDM = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    tr[i] = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    const up = highs[i] - highs[i-1];
    const dn = lows[i-1] - lows[i];
    pDM[i] = (up > dn && up > 0) ? up : 0;
    mDM[i] = (dn > up && dn > 0) ? dn : 0;
  }
  // Wilder smoothing
  function wilder(arr) {
    const out = new Array(arr.length).fill(null);
    let s = 0;
    for (let i = 1; i <= period; i++) s += arr[i];
    out[period] = s;
    for (let i = period+1; i < arr.length; i++) {
      out[i] = out[i-1] - (out[i-1]/period) + arr[i];
    }
    return out;
  }
  const trN = wilder(tr);
  const pDMN = wilder(pDM);
  const mDMN = wilder(mDM);
  const pDI = new Array(len).fill(null);
  const mDI = new Array(len).fill(null);
  const dx = new Array(len).fill(null);
  for (let i = period; i < len; i++) {
    if (trN[i] && trN[i] !== 0) {
      pDI[i] = 100 * pDMN[i] / trN[i];
      mDI[i] = 100 * mDMN[i] / trN[i];
      const sum = pDI[i] + mDI[i];
      dx[i] = sum === 0 ? 0 : 100 * Math.abs(pDI[i] - mDI[i]) / sum;
    }
  }
  // ADX = Wilder smoothing of DX
  const adx = new Array(len).fill(null);
  let firstAdx = null;
  for (let i = period*2; i < len; i++) {
    if (firstAdx === null) {
      let s = 0;
      for (let j = period; j <= i; j++) s += dx[j];
      firstAdx = s / (i - period + 1);
      adx[i] = firstAdx;
    } else {
      adx[i] = (adx[i-1] * (period-1) + dx[i]) / period;
    }
  }
  return { adx, pDI, mDI };
}

// Register additional subplot indicators
PANE_DEFS.adx = {
  name: "ADX", defaultHeight: 130,
  params: [{ key: "period", label: "週期", def: 14 }],
  initSeries(c) {
    return {
      adx: c.addLineSeries({ color: "#fbbf24", lineWidth: 1.5, priceLineVisible: false, title: "ADX" }),
      p:   c.addLineSeries({ color: "#22c55e", lineWidth: 1, priceLineVisible: false, title: "+DI" }),
      m:   c.addLineSeries({ color: "#ef4444", lineWidth: 1, priceLineVisible: false, title: "-DI" })
    };
  },
  render(pane, bars, times) {
    const r = calcADX(bars.map(b=>b.high), bars.map(b=>b.low), bars.map(b=>b.close), pane.params.period);
    pane.series.adx.setData(r.adx.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    pane.series.p.setData(r.pDI.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    pane.series.m.setData(r.mDI.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
  }
};
PANE_DEFS.momentum = {
  name: "Momentum", defaultHeight: 110,
  params: [{ key: "period", label: "週期", def: 10 }],
  initSeries(c) { return { v: c.addLineSeries({ color: "#a78bfa", lineWidth: 1, priceLineVisible: false }) }; },
  render(pane, bars, times) {
    const v = calcMomentum(bars.map(b=>b.close), pane.params.period);
    pane.series.v.setData(v.map((x,i)=>x==null?null:{time:times[i],value:x}).filter(Boolean));
  }
};
PANE_DEFS.roc = {
  name: "ROC", defaultHeight: 110,
  params: [{ key: "period", label: "週期", def: 10 }],
  initSeries(c) { return { v: c.addLineSeries({ color: "#22d3ee", lineWidth: 1, priceLineVisible: false }) }; },
  render(pane, bars, times) {
    const v = calcROC(bars.map(b=>b.close), pane.params.period);
    pane.series.v.setData(v.map((x,i)=>x==null?null:{time:times[i],value:x}).filter(Boolean));
  }
};
PANE_DEFS.cci = {
  name: "CCI", defaultHeight: 120,
  params: [{ key: "period", label: "週期", def: 20 }],
  initSeries(c) { return { v: c.addLineSeries({ color: "#f472b6", lineWidth: 1, priceLineVisible: false }) }; },
  render(pane, bars, times) {
    const v = calcCCI(bars.map(b=>b.high), bars.map(b=>b.low), bars.map(b=>b.close), pane.params.period);
    pane.series.v.setData(v.map((x,i)=>x==null?null:{time:times[i],value:x}).filter(Boolean));
  }
};
PANE_DEFS.williams = {
  name: "Williams %R", defaultHeight: 110,
  params: [{ key: "period", label: "週期", def: 14 }],
  initSeries(c) { return { v: c.addLineSeries({ color: "#fbbf24", lineWidth: 1, priceLineVisible: false }) }; },
  render(pane, bars, times) {
    const v = calcWilliamsR(bars.map(b=>b.high), bars.map(b=>b.low), bars.map(b=>b.close), pane.params.period);
    pane.series.v.setData(v.map((x,i)=>x==null?null:{time:times[i],value:x}).filter(Boolean));
  }
};

// ============================================================
// OVERLAY INDICATORS (on main pane)
// ============================================================
const OVERLAY_DEFS = {
  donchian: {
    name: "Donchian Channel",
    params: [{ key: "period", label: "週期", def: 20 }],
    init(chart) {
      return {
        up:  chart.addLineSeries({ color: "#22d3ee", lineWidth: 1, priceLineVisible: false }),
        lo:  chart.addLineSeries({ color: "#f472b6", lineWidth: 1, priceLineVisible: false }),
        mid: chart.addLineSeries({ color: "#a78bfa", lineWidth: 1, lineStyle: 2, priceLineVisible: false })
      };
    },
    render(o, bars, times) {
      const n = o.params.period;
      const highs = bars.map(b=>b.high), lows = bars.map(b=>b.low);
      const up = new Array(highs.length).fill(null);
      const lo = new Array(highs.length).fill(null);
      const mid = new Array(highs.length).fill(null);
      for (let i = n-1; i < highs.length; i++) {
        let h = -Infinity, l = Infinity;
        for (let j = i-n+1; j <= i; j++) {
          if (highs[j] > h) h = highs[j];
          if (lows[j] < l) l = lows[j];
        }
        up[i] = h; lo[i] = l; mid[i] = (h+l)/2;
      }
      o.series.up.setData(up.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      o.series.lo.setData(lo.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      o.series.mid.setData(mid.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    }
  },
  keltner: {
    name: "Keltner Channel",
    params: [
      { key: "period", label: "EMA週期", def: 20 },
      { key: "atrPeriod", label: "ATR週期", def: 10 },
      { key: "mult", label: "倍數", def: 2 }
    ],
    init(chart) {
      return {
        up:  chart.addLineSeries({ color: "#22d3ee", lineWidth: 1, priceLineVisible: false }),
        lo:  chart.addLineSeries({ color: "#f472b6", lineWidth: 1, priceLineVisible: false }),
        mid: chart.addLineSeries({ color: "#fbbf24", lineWidth: 1, lineStyle: 2, priceLineVisible: false })
      };
    },
    render(o, bars, times) {
      const closes = bars.map(b=>b.close);
      const highs = bars.map(b=>b.high);
      const lows = bars.map(b=>b.low);
      const mid = calcEMA(closes, o.params.period);
      const atr = calcATR(highs, lows, closes, o.params.atrPeriod);
      const up = mid.map((m,i) => m==null||atr[i]==null ? null : m + o.params.mult*atr[i]);
      const lo = mid.map((m,i) => m==null||atr[i]==null ? null : m - o.params.mult*atr[i]);
      o.series.up.setData(up.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      o.series.lo.setData(lo.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      o.series.mid.setData(mid.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    }
  },
  vwap: {
    name: "VWAP (daily)",
    params: [],
    init(chart) { return { v: chart.addLineSeries({ color: "#22c55e", lineWidth: 1.5, priceLineVisible: false }) }; },
    render(o, bars, times) {
      const out = new Array(bars.length).fill(null);
      let day = -1, pv = 0, vol = 0;
      for (let i = 0; i < bars.length; i++) {
        const d = Math.floor(bars[i].time / 86400);
        if (d !== day) { day = d; pv = 0; vol = 0; }
        const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
        const v = bars[i].volume || 1;
        pv += tp * v; vol += v;
        out[i] = vol > 0 ? pv/vol : null;
      }
      o.series.v.setData(out.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    }
  },
  sar: {
    name: "Parabolic SAR",
    params: [
      { key: "step", label: "步進", def: 0.02 },
      { key: "max", label: "上限", def: 0.2 }
    ],
    init(chart) {
      return { v: chart.addLineSeries({ color: "#fbbf24", lineWidth: 0, lineStyle: 0, pointMarkersVisible: true, lastValueVisible: false, priceLineVisible: false }) };
    },
    render(o, bars, times) {
      const len = bars.length;
      if (len < 2) return;
      const out = new Array(len).fill(null);
      let isUp = bars[1].close >= bars[0].close;
      let sar = isUp ? bars[0].low : bars[0].high;
      let ep = isUp ? bars[0].high : bars[0].low;
      let af = o.params.step;
      out[0] = sar;
      for (let i = 1; i < len; i++) {
        sar = sar + af * (ep - sar);
        if (isUp) {
          if (bars[i].low < sar) {
            isUp = false; sar = ep; ep = bars[i].low; af = o.params.step;
          } else {
            if (bars[i].high > ep) { ep = bars[i].high; af = Math.min(o.params.max, af + o.params.step); }
            sar = Math.min(sar, bars[i-1].low, bars[Math.max(0,i-2)].low);
          }
        } else {
          if (bars[i].high > sar) {
            isUp = true; sar = ep; ep = bars[i].high; af = o.params.step;
          } else {
            if (bars[i].low < ep) { ep = bars[i].low; af = Math.min(o.params.max, af + o.params.step); }
            sar = Math.max(sar, bars[i-1].high, bars[Math.max(0,i-2)].high);
          }
        }
        out[i] = sar;
      }
      o.series.v.setData(out.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    }
  },
  supertrend: {
    name: "SuperTrend",
    params: [
      { key: "period", label: "ATR週期", def: 10 },
      { key: "mult", label: "倍數", def: 3 }
    ],
    init(chart) {
      return {
        up: chart.addLineSeries({ color: "#22c55e", lineWidth: 1.5, priceLineVisible: false }),
        dn: chart.addLineSeries({ color: "#ef4444", lineWidth: 1.5, priceLineVisible: false })
      };
    },
    render(o, bars, times) {
      const closes = bars.map(b=>b.close);
      const atr = calcATR(bars.map(b=>b.high), bars.map(b=>b.low), closes, o.params.period);
      const mid = bars.map(b => (b.high + b.low) / 2);
      const upBand = mid.map((m,i)=> atr[i]==null ? null : m + o.params.mult*atr[i]);
      const dnBand = mid.map((m,i)=> atr[i]==null ? null : m - o.params.mult*atr[i]);
      const upArr = new Array(bars.length).fill(null);
      const dnArr = new Array(bars.length).fill(null);
      let trend = 1;
      for (let i = 0; i < bars.length; i++) {
        if (upBand[i] == null) continue;
        if (i > 0 && closes[i-1] > (trend===1 ? dnArr[i-1]||dnBand[i-1] : upArr[i-1]||upBand[i])) trend = 1;
        if (closes[i] < dnBand[i]) trend = -1;
        else if (closes[i] > upBand[i]) trend = 1;
        if (trend === 1) dnArr[i] = dnBand[i]; else upArr[i] = upBand[i];
      }
      o.series.up.setData(upArr.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      o.series.dn.setData(dnArr.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    }
  },
  ichimoku: {
    name: "Ichimoku",
    params: [
      { key: "tenkan", label: "Tenkan", def: 9 },
      { key: "kijun", label: "Kijun", def: 26 },
      { key: "senkou", label: "Senkou", def: 52 }
    ],
    init(chart) {
      return {
        tenkan: chart.addLineSeries({ color: "#ef4444", lineWidth: 1, priceLineVisible: false }),
        kijun:  chart.addLineSeries({ color: "#60a5fa", lineWidth: 1, priceLineVisible: false }),
        a:      chart.addLineSeries({ color: "#22c55e", lineWidth: 1, priceLineVisible: false }),
        b:      chart.addLineSeries({ color: "#fbbf24", lineWidth: 1, priceLineVisible: false })
      };
    },
    render(o, bars, times) {
      const highs = bars.map(b=>b.high), lows = bars.map(b=>b.low);
      function hhll(period) {
        const out = new Array(highs.length).fill(null);
        for (let i = period-1; i < highs.length; i++) {
          let h = -Infinity, l = Infinity;
          for (let j = i-period+1; j <= i; j++) {
            if (highs[j] > h) h = highs[j];
            if (lows[j] < l) l = lows[j];
          }
          out[i] = (h+l)/2;
        }
        return out;
      }
      const tenkan = hhll(o.params.tenkan);
      const kijun  = hhll(o.params.kijun);
      const senkouA = tenkan.map((t,i)=> t==null||kijun[i]==null?null:(t+kijun[i])/2);
      const senkouB = hhll(o.params.senkou);
      o.series.tenkan.setData(tenkan.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      o.series.kijun.setData(kijun.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      o.series.a.setData(senkouA.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
      o.series.b.setData(senkouB.map((v,i)=>v==null?null:{time:times[i],value:v}).filter(Boolean));
    }
  }
};

// ============================================================
// OVERLAY MANAGEMENT
// ============================================================
STATE.overlays = [];
STATE.overlayNextId = 200;

function addOverlay(type) {
  if (!STATE.mainPane) return;
  const def = OVERLAY_DEFS[type];
  if (!def) return;
  const params = {};
  def.params.forEach(p => { params[p.key] = p.def; });
  const o = { id: STATE.overlayNextId++, type, params, series: def.init(STATE.mainPane.chart) };
  STATE.overlays.push(o);
  renderOverlayList();
  refresh();
}

function removeOverlay(id) {
  const idx = STATE.overlays.findIndex(o => o.id === id);
  if (idx < 0) return;
  const o = STATE.overlays[idx];
  Object.values(o.series).forEach(s => {
    try { STATE.mainPane.chart.removeSeries(s); } catch(e) {}
  });
  STATE.overlays.splice(idx, 1);
  renderOverlayList();
  refresh();
}

function renderOverlayList() {
  const list = $("overlayList");
  list.innerHTML = "";
  STATE.overlays.forEach(o => {
    const def = OVERLAY_DEFS[o.type];
    let paramHtml = "";
    def.params.forEach(p => {
      paramHtml += `<div><label>${p.label}</label><input type="number" data-oid="${o.id}" data-okey="${p.key}" value="${o.params[p.key]}" step="0.01"></div>`;
    });
    const item = document.createElement("div");
    item.className = "pane-item";
    item.innerHTML = `
      <div class="pane-item-header">
        <span class="pane-item-name">${def.name}</span>
        <button class="del-pane-btn" data-oid="${o.id}">✕</button>
      </div>
      <div class="pane-params">${paramHtml || '<span class="hint-small">無參數</span>'}</div>`;
    list.appendChild(item);
  });
  list.querySelectorAll(".del-pane-btn").forEach(b => {
    b.onclick = () => removeOverlay(+b.dataset.oid);
  });
  list.querySelectorAll(".pane-params input").forEach(inp => {
    inp.onchange = (e) => {
      const oid = +e.target.dataset.oid;
      const okey = e.target.dataset.okey;
      const o = STATE.overlays.find(x => x.id === oid);
      if (!o) return;
      o.params[okey] = +e.target.value;
      refresh();
    };
  });
}

// ============================================================
// FORMULA COMPILER (custom indicators, Route A)
// ============================================================
// Tiny recursive-descent parser that supports:
//   numbers, identifiers, function calls, + - * / parentheses, unary minus
// Compiles to JS source that calls vectorized helpers.

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[\d.]/.test(c)) {
      let j = i;
      while (j < src.length && /[\d.]/.test(src[j])) j++;
      tokens.push({ type: "NUM", value: src.slice(i, j) });
      i = j; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ type: "ID", value: src.slice(i, j) });
      i = j; continue;
    }
    if ("+-*/(),".includes(c)) { tokens.push({ type: c }); i++; continue; }
    throw new Error("非預期字符: " + c);
  }
  return tokens;
}

function parseFormula(src) {
  const tokens = tokenize(src);
  let p = 0;
  function peek() { return tokens[p]; }
  function consume(t) {
    const tk = tokens[p++];
    if (t && (!tk || tk.type !== t)) throw new Error(`預期 ${t}，得到 ${tk ? tk.type : "EOF"}`);
    return tk;
  }
  // expr = term (('+'|'-') term)*
  function parseExpr() {
    let left = parseTerm();
    while (peek() && (peek().type === "+" || peek().type === "-")) {
      const op = consume().type;
      const right = parseTerm();
      left = { kind: "bin", op, left, right };
    }
    return left;
  }
  function parseTerm() {
    let left = parseUnary();
    while (peek() && (peek().type === "*" || peek().type === "/")) {
      const op = consume().type;
      const right = parseUnary();
      left = { kind: "bin", op, left, right };
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().type === "-") { consume(); return { kind: "neg", arg: parseUnary() }; }
    if (peek() && peek().type === "+") { consume(); return parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new Error("非預期結尾");
    if (tk.type === "NUM") { consume(); return { kind: "num", value: parseFloat(tk.value) }; }
    if (tk.type === "(") { consume(); const e = parseExpr(); consume(")"); return e; }
    if (tk.type === "ID") {
      consume();
      if (peek() && peek().type === "(") {
        consume();
        const args = [];
        if (peek() && peek().type !== ")") {
          args.push(parseExpr());
          while (peek() && peek().type === ",") { consume(); args.push(parseExpr()); }
        }
        consume(")");
        return { kind: "call", name: tk.value, args };
      }
      return { kind: "var", name: tk.value };
    }
    throw new Error("非預期 token: " + tk.type);
  }
  const ast = parseExpr();
  if (p < tokens.length) throw new Error("未消化的 token: " + tokens[p].type);
  return ast;
}

// Compile AST to JS source (calls element-wise helpers _add etc.)
function compileAst(node) {
  switch (node.kind) {
    case "num":  return String(node.value);
    case "var":  return node.name;
    case "neg":  return "_neg(" + compileAst(node.arg) + ")";
    case "call": return node.name + "(" + node.args.map(compileAst).join(",") + ")";
    case "bin": {
      const fn = { "+":"_add", "-":"_sub", "*":"_mul", "/":"_div" }[node.op];
      return fn + "(" + compileAst(node.left) + "," + compileAst(node.right) + ")";
    }
  }
  throw new Error("未知 AST: " + node.kind);
}

const FORMULA_HELPERS = {
  _isArr: Array.isArray,
  _at(x, i) { return Array.isArray(x) ? x[i] : x; },
  _vecOp(a, b, f) {
    const isA = Array.isArray(a), isB = Array.isArray(b);
    if (!isA && !isB) return f(a, b);
    const n = isA ? a.length : b.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const av = isA ? a[i] : a;
      const bv = isB ? b[i] : b;
      out[i] = (av == null || bv == null) ? null : f(av, bv);
    }
    return out;
  },
  _add(a,b) { return FORMULA_HELPERS._vecOp(a,b,(x,y)=>x+y); },
  _sub(a,b) { return FORMULA_HELPERS._vecOp(a,b,(x,y)=>x-y); },
  _mul(a,b) { return FORMULA_HELPERS._vecOp(a,b,(x,y)=>x*y); },
  _div(a,b) { return FORMULA_HELPERS._vecOp(a,b,(x,y)=>y===0?null:x/y); },
  _neg(a) { return Array.isArray(a) ? a.map(x => x==null?null:-x) : -a; },
  sma: calcSMA, ema: calcEMA, std: calcStd,
  rsi: calcRSI,
  abs(a) { return Array.isArray(a) ? a.map(x => x==null?null:Math.abs(x)) : Math.abs(a); },
  log(a) { return Array.isArray(a) ? a.map(x => x==null?null:Math.log(x)) : Math.log(a); },
  sqrt(a) { return Array.isArray(a) ? a.map(x => x==null||x<0?null:Math.sqrt(x)) : Math.sqrt(a); },
  max(a,b) { return FORMULA_HELPERS._vecOp(a,b,(x,y)=>Math.max(x,y)); },
  min(a,b) { return FORMULA_HELPERS._vecOp(a,b,(x,y)=>Math.min(x,y)); },
  shift(arr, n) {
    if (!Array.isArray(arr)) return arr;
    const out = new Array(arr.length).fill(null);
    for (let i = n; i < arr.length; i++) out[i] = arr[i-n];
    return out;
  },
  hh(arr, period) {
    const out = new Array(arr.length).fill(null);
    for (let i = period-1; i < arr.length; i++) {
      let v = -Infinity;
      for (let j = i-period+1; j <= i; j++) if (arr[j] > v) v = arr[j];
      out[i] = v;
    }
    return out;
  },
  ll(arr, period) {
    const out = new Array(arr.length).fill(null);
    for (let i = period-1; i < arr.length; i++) {
      let v = Infinity;
      for (let j = i-period+1; j <= i; j++) if (arr[j] < v) v = arr[j];
      out[i] = v;
    }
    return out;
  }
};

function compileFormula(formula, paramKeys) {
  const ast = parseFormula(formula);
  const body = compileAst(ast);
  const helperNames = Object.keys(FORMULA_HELPERS);
  const paramDestr = paramKeys.length ? `const {${paramKeys.join(",")}} = __p;` : "";
  const helperDestr = `const {${helperNames.join(",")}} = __h;`;
  const code = `${paramDestr}${helperDestr}return ${body};`;
  return new Function("close","open","high","low","volume","__p","__h", code);
}

function evalCustomIndicator(def, bars) {
  const closes = bars.map(b=>b.close);
  const opens = bars.map(b=>b.open);
  const highs = bars.map(b=>b.high);
  const lows = bars.map(b=>b.low);
  const vols = bars.map(b=>b.volume||0);
  const paramKeys = def.params.map(p => p.key);
  const p = {};
  def.params.forEach(x => { p[x.key] = x.value !== undefined ? x.value : x.def; });
  return def.lines.map(line => {
    try {
      if (!line._compiled) line._compiled = compileFormula(line.formula, paramKeys);
      return line._compiled(closes, opens, highs, lows, vols, p, FORMULA_HELPERS);
    } catch(e) {
      console.error("公式錯誤:", line.formula, e);
      return new Array(bars.length).fill(null);
    }
  });
}

// ============================================================
// CUSTOM INDICATOR STORAGE & PANE_DEFS REGISTRATION
// ============================================================
const CUSTOM_LS_KEY = "practice_trading_custom_indicators";

function loadCustomIndicators() {
  try {
    const raw = localStorage.getItem(CUSTOM_LS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch(e) { return []; }
}
function saveCustomIndicators() {
  localStorage.setItem(CUSTOM_LS_KEY, JSON.stringify(STATE.customIndicators));
}

STATE.customIndicators = loadCustomIndicators();

function registerCustomPaneDef(def) {
  // type key like "custom_<id>"
  PANE_DEFS["custom_" + def.id] = {
    name: def.name,
    defaultHeight: 130,
    params: def.params.map(p => ({ key: p.key, label: p.label, def: p.def })),
    initSeries(chart) {
      const series = {};
      def.lines.forEach((line, i) => {
        series["L" + i] = chart.addLineSeries({
          color: line.color || "#fbbf24", lineWidth: 1, priceLineVisible: false, title: line.name
        });
      });
      return series;
    },
    render(pane, bars, times) {
      // Build runtime def with current pane.params overriding defaults
      const runtimeDef = {
        ...def,
        params: def.params.map(p => ({ ...p, value: pane.params[p.key] }))
      };
      const results = evalCustomIndicator(runtimeDef, bars);
      results.forEach((arr, i) => {
        const s = pane.series["L" + i];
        if (!s || !Array.isArray(arr)) return;
        s.setData(arr.map((v,i)=> v==null||!isFinite(v)?null:{time:times[i],value:v}).filter(Boolean));
      });
    }
  };
}

function registerAllCustoms() {
  STATE.customIndicators.forEach(registerCustomPaneDef);
  // Repopulate select dropdown
  const sel = $("newPaneType");
  // Remove old custom optgroup if any
  const oldGroup = sel.querySelector("optgroup[label='自訂']");
  if (oldGroup) oldGroup.remove();
  if (STATE.customIndicators.length) {
    const group = document.createElement("optgroup");
    group.label = "自訂";
    STATE.customIndicators.forEach(c => {
      const opt = document.createElement("option");
      opt.value = "custom_" + c.id;
      opt.textContent = c.name;
      group.appendChild(opt);
    });
    sel.appendChild(group);
  }
}

function renderCustomList() {
  const list = $("customList");
  list.innerHTML = "";
  if (!STATE.customIndicators.length) {
    list.innerHTML = '<div class="hint-small">尚無自訂指標。點下方「+ 新增自訂」開始。</div>';
    return;
  }
  STATE.customIndicators.forEach(c => {
    const item = document.createElement("div");
    item.className = "pane-item";
    item.innerHTML = `
      <div class="pane-item-header">
        <span class="pane-item-name">${c.name}</span>
        <span>
          <button class="del-pane-btn" data-action="edit" data-cid="${c.id}" style="background:#2563eb;margin-right:4px">編</button>
          <button class="del-pane-btn" data-action="del" data-cid="${c.id}">✕</button>
        </span>
      </div>
      <div class="hint-small">${c.lines.length} 條線 · 參數: ${c.params.map(p=>p.key).join(", ") || "無"}</div>`;
    list.appendChild(item);
  });
  list.querySelectorAll("button[data-action='del']").forEach(b => {
    b.onclick = () => {
      const cid = +b.dataset.cid;
      if (!confirm("刪除這個自訂指標？")) return;
      STATE.customIndicators = STATE.customIndicators.filter(c => c.id !== cid);
      delete PANE_DEFS["custom_" + cid];
      // Remove from active panes
      STATE.panes.filter(p => p.type === "custom_" + cid).forEach(p => removePane(p.id));
      saveCustomIndicators();
      registerAllCustoms();
      renderCustomList();
    };
  });
  list.querySelectorAll("button[data-action='edit']").forEach(b => {
    b.onclick = () => openCustomEditor(+b.dataset.cid);
  });
}

// ============================================================
// CUSTOM INDICATOR EDITOR (modal)
// ============================================================
function openCustomEditor(editId = null) {
  const existing = editId != null ? STATE.customIndicators.find(c => c.id === editId) : null;
  // Build modal
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;display:flex;align-items:center;justify-content:center;";
  overlay.innerHTML = `
    <div style="background:#161a22;border:1px solid #2a3140;border-radius:6px;padding:18px;min-width:540px;max-width:680px;max-height:90vh;overflow-y:auto;color:#d8dde6;">
      <h2 style="font-size:14px;margin-bottom:10px;color:#fff;">${existing ? "編輯" : "新增"}自訂指標</h2>
      <div style="margin-bottom:8px">
        <label style="font-size:11px;color:#8da0c0">名稱</label>
        <input type="text" id="ciName" value="${existing?existing.name:""}" placeholder="例如 BB%B">
      </div>
      <h3 style="font-size:11px;color:#8da0c0;margin:12px 0 4px;text-transform:uppercase;letter-spacing:0.6px">參數</h3>
      <div id="ciParams"></div>
      <button class="add-btn" id="ciAddParam">+ 新增參數</button>
      <h3 style="font-size:11px;color:#8da0c0;margin:12px 0 4px;text-transform:uppercase;letter-spacing:0.6px">線條與公式</h3>
      <div id="ciLines"></div>
      <button class="add-btn" id="ciAddLine">+ 新增線</button>
      <h3 style="font-size:11px;color:#8da0c0;margin:12px 0 4px;text-transform:uppercase;letter-spacing:0.6px">可用變數與函數</h3>
      <div style="font-size:11px;color:#8da0c0;background:#0f1115;padding:8px;border-radius:4px;line-height:1.6">
        <b>變數</b>：close, open, high, low, volume（皆為陣列）+ 自定的參數名<br>
        <b>運算</b>：+ - * / ( )（自動 element-wise）<br>
        <b>函數</b>：sma(arr,n), ema(arr,n), std(arr,n), rsi(arr,n), abs(x), log(x), sqrt(x), max(a,b), min(a,b), shift(arr,n), hh(arr,n), ll(arr,n)<br>
        <b>例</b>：<code>(close - sma(close, period)) / (2 * sd * std(close, period))</code> &mdash; 這是 BB %B
      </div>
      <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-flat" id="ciCancel">取消</button>
        <button class="btn btn-step" id="ciSave">${existing ? "儲存" : "建立"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Initialize state for the editor
  let params = existing ? existing.params.map(p => ({...p})) : [
    { key: "period", label: "週期", def: 20 }
  ];
  let lines = existing ? existing.lines.map(l => ({ name: l.name, color: l.color, formula: l.formula })) : [
    { name: "Line 1", color: "#fbbf24", formula: "sma(close, period)" }
  ];

  function renderParams() {
    const c = document.getElementById("ciParams");
    c.innerHTML = "";
    params.forEach((p, idx) => {
      const row = document.createElement("div");
      row.className = "ma-row";
      row.style.gridTemplateColumns = "1fr 1fr 60px 24px";
      row.innerHTML = `
        <input type="text" value="${p.key}" placeholder="key" data-idx="${idx}" data-k="key">
        <input type="text" value="${p.label}" placeholder="label" data-idx="${idx}" data-k="label">
        <input type="number" value="${p.def}" step="any" data-idx="${idx}" data-k="def">
        <button class="del-btn" data-idx="${idx}">✕</button>`;
      c.appendChild(row);
    });
    c.querySelectorAll("input").forEach(inp => {
      inp.oninput = (e) => {
        const i = +e.target.dataset.idx, k = e.target.dataset.k;
        params[i][k] = k === "def" ? +e.target.value : e.target.value;
      };
    });
    c.querySelectorAll(".del-btn").forEach(b => {
      b.onclick = () => { params.splice(+b.dataset.idx, 1); renderParams(); };
    });
  }
  function renderLines() {
    const c = document.getElementById("ciLines");
    c.innerHTML = "";
    lines.forEach((l, idx) => {
      const row = document.createElement("div");
      row.style.cssText = "background:#1f2535;padding:8px;border-radius:4px;margin-bottom:6px;";
      row.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 32px 24px;gap:6px;margin-bottom:4px">
          <input type="text" value="${l.name}" placeholder="line name" data-idx="${idx}" data-k="name">
          <input type="color" value="${l.color}" data-idx="${idx}" data-k="color">
          <button class="del-btn" data-idx="${idx}">✕</button>
        </div>
        <input type="text" value="${l.formula.replace(/"/g,'&quot;')}" placeholder="公式 (e.g. sma(close, period))" data-idx="${idx}" data-k="formula" style="width:100%">
        <div class="hint-small" id="ciValid_${idx}"></div>`;
      c.appendChild(row);
    });
    c.querySelectorAll("input").forEach(inp => {
      inp.oninput = (e) => {
        const i = +e.target.dataset.idx, k = e.target.dataset.k;
        lines[i][k] = e.target.value;
        if (k === "formula") {
          try { parseFormula(e.target.value); document.getElementById("ciValid_"+i).textContent = "✓ 語法正確"; document.getElementById("ciValid_"+i).style.color = "#22c55e"; }
          catch(err) { document.getElementById("ciValid_"+i).textContent = "✗ " + err.message; document.getElementById("ciValid_"+i).style.color = "#ef4444"; }
        }
      };
    });
    c.querySelectorAll(".del-btn").forEach(b => {
      b.onclick = () => { lines.splice(+b.dataset.idx, 1); renderLines(); };
    });
  }
  renderParams(); renderLines();
  document.getElementById("ciAddParam").onclick = () => { params.push({ key: "p"+(params.length+1), label: "Param", def: 14 }); renderParams(); };
  document.getElementById("ciAddLine").onclick = () => { lines.push({ name: "Line " + (lines.length+1), color: "#60a5fa", formula: "close" }); renderLines(); };
  document.getElementById("ciCancel").onclick = () => document.body.removeChild(overlay);
  document.getElementById("ciSave").onclick = () => {
    const name = document.getElementById("ciName").value.trim();
    if (!name) { alert("請輸入名稱"); return; }
    if (!lines.length) { alert("至少需要一條線"); return; }
    // Validate formulas
    for (let i = 0; i < lines.length; i++) {
      try { parseFormula(lines[i].formula); }
      catch(err) { alert(`第 ${i+1} 條線公式錯誤: ${err.message}`); return; }
    }
    if (existing) {
      existing.name = name;
      existing.params = params;
      existing.lines = lines.map(l => ({ name: l.name, color: l.color, formula: l.formula }));
      // Need to re-register PANE_DEF with fresh compiled flag
      delete PANE_DEFS["custom_" + existing.id];
    } else {
      const id = Date.now();
      STATE.customIndicators.push({
        id, name,
        params,
        lines: lines.map(l => ({ name: l.name, color: l.color, formula: l.formula }))
      });
    }
    saveCustomIndicators();
    registerAllCustoms();
    renderCustomList();
    document.body.removeChild(overlay);
  };
}

// ============================================================
// REFRESH HOOK FOR OVERLAYS (extend existing refresh)
// ============================================================
const _origRefresh = refresh;
let _lastSavedTradesLen = -1;
refresh = function() {
  _origRefresh();
  // Overlay rendering — only compute if any overlay exists
  if (STATE.overlays.length && STATE.bars.length && STATE.mainPane) {
    const bars = getVisibleBars();
    const times = bars.map(b => b.time);
    for (let i = 0; i < STATE.overlays.length; i++) {
      const o = STATE.overlays[i];
      OVERLAY_DEFS[o.type].render(o, bars, times);
    }
  }
  // localStorage save — only when trade count changed (analytics page only reads completed trades)
  if (STATE.trades.length !== _lastSavedTradesLen) {
    _lastSavedTradesLen = STATE.trades.length;
    try {
      localStorage.setItem("practice_trading_trades_session", JSON.stringify({
        trades: STATE.trades, savedAt: Date.now()
      }));
    } catch(e) {}
  }
};

// ============================================================
// EVENT BINDINGS for new sections
// ============================================================
$("addOverlay").onclick = () => addOverlay($("newOverlayType").value);
$("openCustomEditor").onclick = () => openCustomEditor();
$("exportCustom").onclick = () => {
  if (!STATE.customIndicators.length) { alert("尚無自訂指標可匯出"); return; }
  const blob = new Blob([JSON.stringify(STATE.customIndicators, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "custom_indicators_" + Date.now() + ".json";
  a.click();
};
$("importCustomFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const arr = JSON.parse(fr.result);
      if (!Array.isArray(arr)) throw new Error("格式不正確");
      let added = 0;
      arr.forEach(c => {
        if (c.name && c.params && c.lines) {
          c.id = Date.now() + Math.floor(Math.random()*1000);
          STATE.customIndicators.push(c);
          added++;
        }
      });
      saveCustomIndicators();
      registerAllCustoms();
      renderCustomList();
      alert(`匯入 ${added} 個自訂指標`);
    } catch(err) {
      alert("匯入失敗: " + err.message);
    }
  };
  fr.readAsText(f);
  e.target.value = "";
});

// Initialize custom indicators on startup
registerAllCustoms();
renderCustomList();

// ============================================================
// Late-binding re-fixes for event handlers that captured the
// original refresh before it was overridden above.
// ============================================================
$("applyParams").onclick = () => refresh();
["showMA","showBB"].forEach(id => $(id).onchange = () => refresh());

// Patch: when editing an existing custom indicator, remove any
// active panes using it so the new lines/series take effect cleanly.
// Wraps openCustomEditor's save flow: the registerAllCustoms() call
// after save re-registers PANE_DEFS but doesn't touch existing pane
// series — so we proactively close stale panes upon registration.
(function patchRegister() {
  const orig = registerAllCustoms;
  registerAllCustoms = function() {
    // Find panes whose type is a custom_<id> that no longer exists
    const validKeys = new Set(STATE.customIndicators.map(c => "custom_" + c.id));
    const stale = STATE.panes.filter(p => p.type && p.type.startsWith("custom_") && !validKeys.has(p.type));
    stale.forEach(p => removePane(p.id));
    orig();
  };
})();

// ============================================================
// CUSTOM INDICATOR EDITOR UX — TEMPLATES + IMPROVED LAYOUT
// ============================================================
const CI_TEMPLATES = {
  bb_pctb: {
    name: "BB %B (布林通道位置)",
    params: [
      { key: "period", label: "週期 Period", def: 20 },
      { key: "sd", label: "標準差倍數 StdDev", def: 2 }
    ],
    lines: [
      { name: "%B", color: "#fbbf24",
        formula: "(close - sma(close, period)) / (2 * sd * std(close, period))" }
    ]
  },
  ema_dist: {
    name: "EMA 距離 (Price - EMA)",
    params: [{ key: "period", label: "EMA 週期", def: 50 }],
    lines: [
      { name: "Distance", color: "#60a5fa", formula: "close - ema(close, period)" }
    ]
  },
  ema_dist_pct: {
    name: "EMA 距離率 (%)",
    params: [{ key: "period", label: "EMA 週期", def: 50 }],
    lines: [
      { name: "Dist %", color: "#a78bfa",
        formula: "(close - ema(close, period)) / ema(close, period) * 100" }
    ]
  },
  ma_cross: {
    name: "雙均線差 (Fast - Slow)",
    params: [
      { key: "fast", label: "快線", def: 12 },
      { key: "slow", label: "慢線", def: 26 }
    ],
    lines: [
      { name: "Spread", color: "#22c55e", formula: "ema(close, fast) - ema(close, slow)" }
    ]
  },
  smooth_roc: {
    name: "平滑 ROC",
    params: [
      { key: "n", label: "回看根數", def: 10 },
      { key: "smooth", label: "平滑週期", def: 5 }
    ],
    lines: [
      { name: "Smooth ROC", color: "#f472b6",
        formula: "ema((close - shift(close, n)) / shift(close, n) * 100, smooth)" }
    ]
  },
  stoch_rsi: {
    name: "Stochastic RSI",
    params: [
      { key: "rsiN", label: "RSI 週期", def: 14 },
      { key: "stN", label: "Stoch 週期", def: 14 }
    ],
    lines: [
      { name: "StochRSI", color: "#22d3ee",
        formula: "(rsi(close, rsiN) - ll(rsi(close, rsiN), stN)) / (hh(rsi(close, rsiN), stN) - ll(rsi(close, rsiN), stN)) * 100" }
    ]
  },
  range_pct: {
    name: "K 棒振幅 (%)",
    params: [],
    lines: [
      { name: "Range%", color: "#fbbf24", formula: "(high - low) / close * 100" }
    ]
  }
};

const CI_PARAM_PRESETS = [
  { key: "period", label: "週期 Period", def: 20 },
  { key: "fast",   label: "快線 Fast",   def: 12 },
  { key: "slow",   label: "慢線 Slow",   def: 26 },
  { key: "n",      label: "回看根數",     def: 14 },
  { key: "mult",   label: "倍數",         def: 2 },
  { key: "sd",     label: "標準差倍數",   def: 2 },
  { key: "offset", label: "偏移",         def: 0 }
];

const CI_FUNCTION_REF = [
  { name: "sma(arr, n)",        desc: "簡單移動平均：取最近 n 根的平均",   insert: "sma(close, period)" },
  { name: "ema(arr, n)",        desc: "指數移動平均（重視最近資料）",        insert: "ema(close, period)" },
  { name: "std(arr, n)",        desc: "標準差（衡量波動）",                   insert: "std(close, period)" },
  { name: "rsi(arr, n)",        desc: "相對強弱指標 RSI（0~100）",            insert: "rsi(close, 14)" },
  { name: "abs(x)",             desc: "絕對值",                                insert: "abs(close - open)" },
  { name: "log(x)",             desc: "自然對數",                              insert: "log(close)" },
  { name: "sqrt(x)",            desc: "平方根",                                insert: "sqrt(close)" },
  { name: "max(a, b)",          desc: "逐根取較大值",                          insert: "max(close, open)" },
  { name: "min(a, b)",          desc: "逐根取較小值",                          insert: "min(close, open)" },
  { name: "shift(arr, n)",      desc: "把陣列往後位移 n 根（取 n 期前的值）",   insert: "shift(close, 1)" },
  { name: "hh(arr, n)",         desc: "n 期內最高值（highest high）",          insert: "hh(high, period)" },
  { name: "ll(arr, n)",         desc: "n 期內最低值（lowest low）",            insert: "ll(low, period)" }
];

// Override openCustomEditor with the improved version
openCustomEditor = function(editId = null) {
  const existing = editId != null ? STATE.customIndicators.find(c => c.id === editId) : null;

  let templateOptions = '<option value="">— 從零開始 —</option>';
  Object.entries(CI_TEMPLATES).forEach(([k, t]) => {
    templateOptions += `<option value="${k}">${t.name}</option>`;
  });
  let presetButtons = CI_PARAM_PRESETS.map(p =>
    `<button class="add-btn ci-preset" data-pk="${p.key}" data-pl="${p.label}" data-pd="${p.def}" style="width:auto;padding:3px 8px;display:inline-block;margin:2px;">${p.label.split(" ")[0]}</button>`
  ).join("");
  let fnRefHtml = CI_FUNCTION_REF.map(f =>
    `<div class="ci-fn" data-insert="${f.insert.replace(/"/g,'&quot;')}" style="display:flex;justify-content:space-between;padding:4px 6px;cursor:pointer;border-radius:3px;font-size:11px;">
       <code style="color:#fbbf24;">${f.name}</code>
       <span style="color:#8da0c0;font-size:10px;">${f.desc}</span>
     </div>`
  ).join("");

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;";
  overlay.innerHTML = `
    <div style="background:#161a22;border:1px solid #2a3140;border-radius:6px;padding:18px;width:760px;max-width:100%;max-height:90vh;overflow-y:auto;color:#d8dde6;">
      <h2 style="font-size:14px;margin-bottom:12px;color:#fff;">${existing ? "編輯" : "新增"}自訂指標</h2>

      ${existing ? "" : `
      <div style="background:#1f2535;padding:10px;border-radius:4px;margin-bottom:14px;">
        <label style="font-size:11px;color:#8da0c0;display:block;margin-bottom:4px">📋 從範本快速建立（可選）</label>
        <select id="ciTemplate" style="width:100%">${templateOptions}</select>
      </div>`}

      <div style="margin-bottom:10px">
        <label style="font-size:11px;color:#8da0c0">指標名稱（會出現在面板標題與下拉選單中）</label>
        <input type="text" id="ciName" value="${existing?existing.name:""}" placeholder="例如：BB %B、雙均線差">
      </div>

      <h3 style="font-size:11px;color:#8da0c0;margin:14px 0 4px;text-transform:uppercase;letter-spacing:0.6px">參數定義</h3>
      <div style="font-size:10px;color:#5a6580;margin-bottom:6px">
        每個參數有三欄：<b style="color:#fbbf24">變數名</b>（公式裡引用）→ <b style="color:#fbbf24">顯示標籤</b>（你之後調整時看到的中文）→ <b style="color:#fbbf24">預設值</b>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 60px 24px;gap:4px;margin-bottom:4px;font-size:10px;color:#8da0c0;text-transform:uppercase;letter-spacing:0.4px">
        <div>變數名 (key)</div>
        <div>顯示標籤 (label)</div>
        <div style="text-align:center">預設值</div>
        <div></div>
      </div>
      <div id="ciParams"></div>
      <div style="margin-top:4px;font-size:10px;color:#8da0c0;">⚡ 快速加入常用參數：${presetButtons}</div>

      <h3 style="font-size:11px;color:#8da0c0;margin:14px 0 4px;text-transform:uppercase;letter-spacing:0.6px">線條與公式</h3>
      <div id="ciLines"></div>
      <button class="add-btn" id="ciAddLine">+ 新增線</button>

      <h3 style="font-size:11px;color:#8da0c0;margin:14px 0 4px;text-transform:uppercase;letter-spacing:0.6px">可用函數（點擊插入到公式）</h3>
      <div style="background:#0f1115;padding:8px;border-radius:4px;max-height:200px;overflow-y:auto;" id="ciFnRef">
        ${fnRefHtml}
      </div>
      <div style="font-size:10px;color:#5a6580;margin-top:6px;line-height:1.5">
        <b>變數</b>：close, open, high, low, volume（陣列）+ 你定義的參數名<br>
        <b>運算</b>：+ − × ÷ ( ) — 自動逐根計算
      </div>

      <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-flat" id="ciCancel">取消</button>
        <button class="btn btn-step" id="ciSave">${existing ? "儲存" : "建立"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let params = existing ? existing.params.map(p => ({...p})) : [];
  let lines = existing ? existing.lines.map(l => ({ name: l.name, color: l.color, formula: l.formula })) : [
    { name: "Line 1", color: "#fbbf24", formula: "sma(close, period)" }
  ];
  let activeFormulaTarget = null;

  function renderParams() {
    const c = document.getElementById("ciParams");
    c.innerHTML = "";
    params.forEach((p, idx) => {
      const row = document.createElement("div");
      row.style.cssText = "display:grid;grid-template-columns:1fr 1fr 60px 24px;gap:4px;margin-bottom:4px;";
      row.innerHTML = `
        <input type="text" value="${p.key}" placeholder="period" data-idx="${idx}" data-k="key" title="公式裡引用的變數名">
        <input type="text" value="${p.label}" placeholder="週期" data-idx="${idx}" data-k="label" title="顯示給使用者看的中文標籤">
        <input type="number" value="${p.def}" step="any" data-idx="${idx}" data-k="def" title="預設值">
        <button class="del-btn" data-idx="${idx}" title="移除此參數">✕</button>`;
      c.appendChild(row);
    });
    c.querySelectorAll("input").forEach(inp => {
      inp.oninput = (e) => {
        const i = +e.target.dataset.idx, k = e.target.dataset.k;
        params[i][k] = k === "def" ? +e.target.value : e.target.value;
      };
    });
    c.querySelectorAll(".del-btn").forEach(b => {
      b.onclick = () => { params.splice(+b.dataset.idx, 1); renderParams(); };
    });
  }
  function renderLines() {
    const c = document.getElementById("ciLines");
    c.innerHTML = "";
    lines.forEach((l, idx) => {
      const row = document.createElement("div");
      row.style.cssText = "background:#1f2535;padding:8px;border-radius:4px;margin-bottom:6px;";
      row.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 32px 24px;gap:6px;margin-bottom:4px">
          <input type="text" value="${l.name}" placeholder="線名稱" data-idx="${idx}" data-k="name">
          <input type="color" value="${l.color}" data-idx="${idx}" data-k="color">
          <button class="del-btn" data-idx="${idx}" title="移除此線">✕</button>
        </div>
        <input type="text" value="${l.formula.replace(/"/g,'&quot;')}" placeholder="公式 (e.g. sma(close, period))" data-idx="${idx}" data-k="formula" class="ci-formula" style="width:100%;font-family:Consolas,monospace">
        <div class="hint-small" id="ciValid_${idx}">點上方「可用函數」可一鍵插入</div>`;
      c.appendChild(row);
    });
    c.querySelectorAll("input").forEach(inp => {
      inp.onfocus = (e) => { if (e.target.classList.contains("ci-formula")) activeFormulaTarget = e.target; };
      inp.oninput = (e) => {
        const i = +e.target.dataset.idx, k = e.target.dataset.k;
        lines[i][k] = e.target.value;
        if (k === "formula") {
          try { parseFormula(e.target.value);
                document.getElementById("ciValid_"+i).textContent = "✓ 語法正確";
                document.getElementById("ciValid_"+i).style.color = "#22c55e";
          } catch(err) {
                document.getElementById("ciValid_"+i).textContent = "✗ " + err.message;
                document.getElementById("ciValid_"+i).style.color = "#ef4444";
          }
        }
      };
    });
    c.querySelectorAll(".del-btn").forEach(b => {
      b.onclick = () => { lines.splice(+b.dataset.idx, 1); renderLines(); };
    });
    // Set last formula as default insertion target
    const lastF = c.querySelector(".ci-formula:last-of-type");
    if (lastF) activeFormulaTarget = lastF;
  }

  // Template picker
  if (!existing) {
    document.getElementById("ciTemplate").onchange = (e) => {
      const k = e.target.value;
      if (!k) return;
      const t = CI_TEMPLATES[k];
      document.getElementById("ciName").value = t.name;
      params = t.params.map(p => ({...p}));
      lines = t.lines.map(l => ({...l}));
      renderParams(); renderLines();
    };
  }

  // Preset param chips
  overlay.querySelectorAll(".ci-preset").forEach(b => {
    b.onclick = () => {
      if (params.find(p => p.key === b.dataset.pk)) { alert(`已有參數 ${b.dataset.pk}`); return; }
      params.push({ key: b.dataset.pk, label: b.dataset.pl, def: +b.dataset.pd });
      renderParams();
    };
  });

  // Function reference click-to-insert
  overlay.querySelectorAll(".ci-fn").forEach(el => {
    el.onmouseenter = () => { el.style.background = "#1f2535"; };
    el.onmouseleave = () => { el.style.background = ""; };
    el.onclick = () => {
      const text = el.dataset.insert;
      if (!activeFormulaTarget) {
        const last = overlay.querySelector(".ci-formula:last-of-type");
        if (last) activeFormulaTarget = last;
      }
      if (activeFormulaTarget) {
        const cur = activeFormulaTarget.value;
        const cursorPos = activeFormulaTarget.selectionStart ?? cur.length;
        activeFormulaTarget.value = cur.slice(0, cursorPos) + text + cur.slice(cursorPos);
        activeFormulaTarget.focus();
        activeFormulaTarget.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };
  });

  // Empty-state defaults (if not from template, start with sensible defaults)
  if (!existing && !params.length) {
    params.push({ key: "period", label: "週期 Period", def: 20 });
  }
  renderParams();
  renderLines();

  document.getElementById("ciAddLine").onclick = () => {
    lines.push({ name: "Line " + (lines.length+1), color: "#60a5fa", formula: "close" });
    renderLines();
  };
  document.getElementById("ciCancel").onclick = () => document.body.removeChild(overlay);
  document.getElementById("ciSave").onclick = () => {
    const name = document.getElementById("ciName").value.trim();
    if (!name) { alert("請輸入名稱"); return; }
    if (!lines.length) { alert("至少需要一條線"); return; }
    for (let i = 0; i < lines.length; i++) {
      try { parseFormula(lines[i].formula); }
      catch(err) { alert(`第 ${i+1} 條線公式錯誤: ${err.message}`); return; }
    }
    if (existing) {
      STATE.panes.filter(p => p.type === "custom_" + existing.id).forEach(p => removePane(p.id));
      existing.name = name;
      existing.params = params;
      existing.lines = lines.map(l => ({ name: l.name, color: l.color, formula: l.formula }));
      delete PANE_DEFS["custom_" + existing.id];
    } else {
      STATE.customIndicators.push({
        id: Date.now(), name, params,
        lines: lines.map(l => ({ name: l.name, color: l.color, formula: l.formula }))
      });
    }
    saveCustomIndicators();
    registerAllCustoms();
    renderCustomList();
    document.body.removeChild(overlay);
  };
};

// ============================================================
// BLOCK MODE — visual block-based custom indicator editor
// ============================================================
const BLOCK_FN_ARITY = {
  sma: 2, ema: 2, std: 2, rsi: 2,
  abs: 1, log: 1, sqrt: 1,
  max: 2, min: 2,
  shift: 2, hh: 2, ll: 2
};
const BLOCK_VARS = ["close","open","high","low","volume"];
const BLOCK_OPS = ["+", "-", "*", "/"];
const BLOCK_OP_LABELS = { "+": "＋", "-": "−", "*": "×", "/": "÷" };

function newBlock(kind, opts = {}) {
  switch (kind) {
    case "var":   return { kind: "var", name: opts.name };
    case "param": return { kind: "param", name: opts.name };
    case "num":   return { kind: "num", value: opts.value !== undefined ? opts.value : 0 };
    case "op":    return { kind: "op", op: opts.op, args: [null, null] };
    case "fn":    return { kind: "fn", name: opts.name, args: new Array(BLOCK_FN_ARITY[opts.name] || 1).fill(null) };
  }
}

// AST → Block tree
function astToBlock(ast) {
  if (!ast) return null;
  switch (ast.kind) {
    case "num": return { kind: "num", value: ast.value };
    case "var":
      if (BLOCK_VARS.includes(ast.name)) return { kind: "var", name: ast.name };
      return { kind: "param", name: ast.name };
    case "neg":
      return { kind: "op", op: "-", args: [{ kind: "num", value: 0 }, astToBlock(ast.arg)] };
    case "bin":
      return { kind: "op", op: ast.op, args: [astToBlock(ast.left), astToBlock(ast.right)] };
    case "call":
      return { kind: "fn", name: ast.name, args: ast.args.map(astToBlock) };
  }
  return null;
}

function formulaToBlock(formula) {
  try { return astToBlock(parseFormula(formula)); }
  catch(e) { return null; }
}

function blockToFormula(b) {
  if (!b) return "0";
  switch (b.kind) {
    case "num": return String(b.value);
    case "var":
    case "param": return b.name;
    case "op": return "(" + blockToFormula(b.args[0]) + b.op + blockToFormula(b.args[1]) + ")";
    case "fn": return b.name + "(" + b.args.map(blockToFormula).join(",") + ")";
  }
  return "0";
}

function blockComplete(b) {
  if (!b) return false;
  if (b.args) return b.args.every(blockComplete);
  return true;
}

// ============================================================
// Drag-and-drop state for block palette
// ============================================================
let DRAG_MAKE = null;  // function that creates a new block

function makePaletteItem(label, makeFn, styleClass) {
  const btn = document.createElement("button");
  btn.className = "ci-palette-item " + (styleClass || "");
  btn.textContent = label;
  btn.draggable = true;
  btn.onmousedown = () => { DRAG_MAKE = makeFn; };
  btn.ondragstart = (e) => {
    DRAG_MAKE = makeFn;
    e.dataTransfer.setData("text/plain", "block");
    e.dataTransfer.effectAllowed = "copy";
  };
  btn.ondragend = () => { /* keep DRAG_MAKE in case onclick fires next */ };
  btn.onclick = () => {
    if (window._ciActiveSlotPick) {
      window._ciActiveSlotPick(makeFn());
      window._ciActiveSlotPick = null;
      document.querySelectorAll(".ci-palette").forEach(p => p.remove());
    }
  };
  return btn;
}

function makeSlot(onPick, currentParams) {
  const slot = document.createElement("span");
  slot.className = "ci-slot";
  slot.textContent = "＋ 點此或拖入方塊";
  slot.title = "點擊選擇方塊，或從調色盤拖入";
  slot.onclick = (e) => {
    e.stopPropagation();
    window._ciActiveSlotPick = onPick;
    showBlockPalette(slot, onPick, currentParams);
  };
  slot.ondragover = (e) => { e.preventDefault(); slot.classList.add("drag-over"); };
  slot.ondragleave = () => { slot.classList.remove("drag-over"); };
  slot.ondrop = (e) => {
    e.preventDefault();
    slot.classList.remove("drag-over");
    if (DRAG_MAKE) {
      onPick(DRAG_MAKE());
      DRAG_MAKE = null;
    }
  };
  return slot;
}

function showBlockPalette(anchor, onPick, currentParams) {
  document.querySelectorAll(".ci-palette").forEach(p => p.remove());
  const pal = document.createElement("div");
  pal.className = "ci-palette";
  const r = anchor.getBoundingClientRect();
  pal.style.left = Math.min(window.innerWidth - 420, r.left) + "px";
  pal.style.top = (r.bottom + 4) + "px";

  function addCat(title, items) {
    const cat = document.createElement("div");
    cat.className = "ci-palette-cat";
    const h = document.createElement("h4");
    h.textContent = title;
    cat.appendChild(h);
    const itemsDiv = document.createElement("div");
    itemsDiv.className = "ci-palette-items";
    items.forEach(it => itemsDiv.appendChild(makePaletteItem(it.label, it.make, it.style)));
    cat.appendChild(itemsDiv);
    pal.appendChild(cat);
  }

  addCat("變數 Variables", BLOCK_VARS.map(v => ({
    label: v, make: () => newBlock("var", {name:v}), style: "var-style"
  })));
  if (currentParams && currentParams.length) {
    addCat("參數 Parameters", currentParams.map(p => ({
      label: p.key, make: () => newBlock("param", {name:p.key}), style: "param-style"
    })));
  }
  addCat("數字 Number", [
    { label: "數字 (可編輯)", make: () => newBlock("num", {value:0}), style: "num-style" }
  ]);
  addCat("運算子 Operators", BLOCK_OPS.map(op => ({
    label: BLOCK_OP_LABELS[op], make: () => newBlock("op", {op}), style: "op-style"
  })));
  addCat("函數 - 1 個輸入", ["abs","log","sqrt"].map(f => ({
    label: f + "(◯)", make: () => newBlock("fn", {name:f}), style: "fn-style"
  })));
  addCat("函數 - 2 個輸入", ["sma","ema","std","rsi","max","min","shift","hh","ll"].map(f => ({
    label: f + "(◯,◯)", make: () => newBlock("fn", {name:f}), style: "fn-style"
  })));

  document.body.appendChild(pal);
  setTimeout(() => {
    const close = (e) => {
      if (!pal.contains(e.target) && e.target !== anchor) {
        pal.remove();
        document.removeEventListener("click", close);
        window._ciActiveSlotPick = null;
      }
    };
    document.addEventListener("click", close);
  }, 0);
}

// ============================================================
// Render a block tree element
// ============================================================
function renderBlockEl(block, onReplace, rerender, currentParams) {
  const el = document.createElement("span");
  el.className = "ci-block ci-block-" + block.kind;
  el.draggable = true;
  el.ondragstart = (e) => {
    e.stopPropagation();
    DRAG_MAKE = () => JSON.parse(JSON.stringify(block));
    e.dataTransfer.setData("text/plain", "block");
    e.dataTransfer.effectAllowed = "copy";
  };

  switch (block.kind) {
    case "var":
    case "param":
      el.appendChild(document.createTextNode(block.name));
      break;
    case "num": {
      const input = document.createElement("input");
      input.type = "number";
      input.value = block.value;
      input.step = "any";
      input.oninput = (e) => { block.value = +e.target.value; };
      input.onclick = (e) => e.stopPropagation();
      el.appendChild(input);
      break;
    }
    case "op": {
      block.args.forEach((arg, i) => {
        if (i > 0) {
          const op = document.createElement("span");
          op.className = "ci-block-op-label";
          op.textContent = " " + BLOCK_OP_LABELS[block.op] + " ";
          op.style.cssText = "font-weight:600;color:#86efac;padding:0 4px";
          el.appendChild(op);
        }
        el.appendChild(makeChildSlot(block, i, rerender, currentParams));
      });
      break;
    }
    case "fn": {
      const name = document.createElement("span");
      name.className = "ci-block-fn-name";
      name.textContent = block.name;
      el.appendChild(name);
      const lp = document.createElement("span");
      lp.className = "ci-block-paren"; lp.textContent = "(";
      el.appendChild(lp);
      block.args.forEach((arg, i) => {
        if (i > 0) {
          const c = document.createElement("span");
          c.className = "ci-block-comma"; c.textContent = ", ";
          el.appendChild(c);
        }
        el.appendChild(makeChildSlot(block, i, rerender, currentParams));
      });
      const rp = document.createElement("span");
      rp.className = "ci-block-paren"; rp.textContent = ")";
      el.appendChild(rp);
      break;
    }
  }

  const del = document.createElement("button");
  del.className = "ci-block-del";
  del.textContent = "×";
  del.title = "移除";
  del.onclick = (e) => { e.stopPropagation(); onReplace(null); };
  el.appendChild(del);
  return el;
}

function makeChildSlot(parentBlock, argIdx, rerender, currentParams) {
  const child = parentBlock.args[argIdx];
  if (!child) {
    return makeSlot((b) => {
      parentBlock.args[argIdx] = b;
      rerender();
    }, currentParams);
  }
  return renderBlockEl(child, (newB) => {
    parentBlock.args[argIdx] = newB;
    rerender();
  }, rerender, currentParams);
}

// ============================================================
// Override openCustomEditor to add mode tabs + block UI
// ============================================================
openCustomEditor = function(editId = null) {
  const existing = editId != null ? STATE.customIndicators.find(c => c.id === editId) : null;

  // State
  let params = existing ? existing.params.map(p => ({...p})) : [{ key: "period", label: "週期 Period", def: 20 }];
  let lines = existing
    ? existing.lines.map(l => ({ name: l.name, color: l.color, formula: l.formula, block: formulaToBlock(l.formula) }))
    : [{ name: "Line 1", color: "#fbbf24", formula: "sma(close, period)", block: { kind: "fn", name: "sma", args: [{ kind: "var", name: "close" }, { kind: "param", name: "period" }] } }];
  let mode = "block";
  let activeFormulaTarget = null;

  // Templates
  let templateOptions = '<option value="">— 從零開始 —</option>';
  Object.entries(CI_TEMPLATES).forEach(([k, t]) => templateOptions += `<option value="${k}">${t.name}</option>`);
  let presetButtons = CI_PARAM_PRESETS.map(p =>
    `<button class="add-btn ci-preset" data-pk="${p.key}" data-pl="${p.label}" data-pd="${p.def}" style="width:auto;padding:3px 8px;display:inline-block;margin:2px;">${p.label.split(" ")[0]}</button>`
  ).join("");
  let fnRefHtml = CI_FUNCTION_REF.map(f =>
    `<div class="ci-fn" data-insert="${f.insert.replace(/"/g,'&quot;')}" style="display:flex;justify-content:space-between;padding:4px 6px;cursor:pointer;border-radius:3px;font-size:11px;">
       <code style="color:#fbbf24;">${f.name}</code>
       <span style="color:#8da0c0;font-size:10px;">${f.desc}</span>
     </div>`
  ).join("");

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;";
  overlay.innerHTML = `
    <div style="background:#161a22;border:1px solid #2a3140;border-radius:6px;padding:18px;width:820px;max-width:100%;max-height:92vh;overflow-y:auto;color:#d8dde6;">
      <h2 style="font-size:14px;margin-bottom:12px;color:#fff;">${existing ? "編輯" : "新增"}自訂指標</h2>

      ${existing ? "" : `
      <div style="background:#1f2535;padding:10px;border-radius:4px;margin-bottom:14px;">
        <label style="font-size:11px;color:#8da0c0;display:block;margin-bottom:4px">📋 從範本快速建立（可選）</label>
        <select id="ciTemplate" style="width:100%">${templateOptions}</select>
      </div>`}

      <div style="margin-bottom:10px">
        <label style="font-size:11px;color:#8da0c0">指標名稱</label>
        <input type="text" id="ciName" value="${existing?existing.name:""}" placeholder="例如：BB %B、雙均線差">
      </div>

      <h3 style="font-size:11px;color:#8da0c0;margin:14px 0 4px;text-transform:uppercase;letter-spacing:0.6px">參數定義</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr 60px 24px;gap:4px;margin-bottom:4px;font-size:10px;color:#8da0c0;text-transform:uppercase;letter-spacing:0.4px">
        <div>變數名 (key)</div><div>顯示標籤 (label)</div><div style="text-align:center">預設值</div><div></div>
      </div>
      <div id="ciParams"></div>
      <div style="margin-top:4px;font-size:10px;color:#8da0c0;">⚡ 快速加入：${presetButtons}</div>

      <h3 style="font-size:11px;color:#8da0c0;margin:14px 0 4px;text-transform:uppercase;letter-spacing:0.6px">公式設計</h3>
      <div class="ci-mode-tabs">
        <button class="ci-mode-tab" data-mode="block">🧩 方塊模式 (推薦)</button>
        <button class="ci-mode-tab" data-mode="text">📝 文字模式</button>
      </div>
      <div id="ciBody"></div>

      <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-flat" id="ciCancel">取消</button>
        <button class="btn btn-step" id="ciSave">${existing ? "儲存" : "建立"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // ===== Params section =====
  function renderParams() {
    const c = document.getElementById("ciParams");
    c.innerHTML = "";
    params.forEach((p, idx) => {
      const row = document.createElement("div");
      row.style.cssText = "display:grid;grid-template-columns:1fr 1fr 60px 24px;gap:4px;margin-bottom:4px;";
      row.innerHTML = `
        <input type="text" value="${p.key}" placeholder="period" data-idx="${idx}" data-k="key">
        <input type="text" value="${p.label}" placeholder="週期" data-idx="${idx}" data-k="label">
        <input type="number" value="${p.def}" step="any" data-idx="${idx}" data-k="def">
        <button class="del-btn" data-idx="${idx}">✕</button>`;
      c.appendChild(row);
    });
    c.querySelectorAll("input").forEach(inp => {
      inp.oninput = (e) => {
        const i = +e.target.dataset.idx, k = e.target.dataset.k;
        params[i][k] = k === "def" ? +e.target.value : e.target.value;
        if (mode === "block") renderBody();  // refresh palette since params changed
      };
    });
    c.querySelectorAll(".del-btn").forEach(b => {
      b.onclick = () => { params.splice(+b.dataset.idx, 1); renderParams(); if (mode==="block") renderBody(); };
    });
  }
  overlay.querySelectorAll(".ci-preset").forEach(b => {
    b.onclick = () => {
      if (params.find(p => p.key === b.dataset.pk)) { alert(`已有參數 ${b.dataset.pk}`); return; }
      params.push({ key: b.dataset.pk, label: b.dataset.pl, def: +b.dataset.pd });
      renderParams();
      if (mode === "block") renderBody();
    };
  });

  // ===== Mode tabs =====
  function setActiveTab() {
    overlay.querySelectorAll(".ci-mode-tab").forEach(t => {
      t.classList.toggle("active", t.dataset.mode === mode);
    });
  }
  overlay.querySelectorAll(".ci-mode-tab").forEach(t => {
    t.onclick = () => {
      const newMode = t.dataset.mode;
      if (newMode === mode) return;
      // Convert
      if (mode === "block" && newMode === "text") {
        lines.forEach(l => { if (l.block) l.formula = blockToFormula(l.block); });
      } else if (mode === "text" && newMode === "block") {
        let failed = 0;
        lines.forEach(l => {
          const b = formulaToBlock(l.formula);
          if (b) l.block = b; else failed++;
        });
        if (failed) alert(`${failed} 條線的公式無法轉換為方塊（語法錯誤），方塊區會顯示空白`);
      }
      mode = newMode;
      setActiveTab();
      renderBody();
    };
  });

  // ===== Body renderer (switches between text and block mode) =====
  function renderBody() {
    const body = document.getElementById("ciBody");
    body.innerHTML = "";
    if (mode === "text") renderTextBody(body);
    else renderBlockBody(body);
  }

  function renderTextBody(body) {
    const linesDiv = document.createElement("div"); linesDiv.id = "ciLines";
    body.appendChild(linesDiv);
    const addBtn = document.createElement("button");
    addBtn.className = "add-btn"; addBtn.textContent = "+ 新增線";
    addBtn.onclick = () => {
      lines.push({ name: "Line " + (lines.length+1), color: "#60a5fa", formula: "close", block: { kind: "var", name: "close" } });
      renderTextLines();
    };
    body.appendChild(addBtn);
    const h = document.createElement("h3");
    h.style.cssText = "font-size:11px;color:#8da0c0;margin:14px 0 4px;text-transform:uppercase;letter-spacing:0.6px";
    h.textContent = "可用函數（點擊插入到公式）";
    body.appendChild(h);
    const fnRef = document.createElement("div");
    fnRef.style.cssText = "background:#0f1115;padding:8px;border-radius:4px;max-height:180px;overflow-y:auto;";
    fnRef.innerHTML = fnRefHtml;
    body.appendChild(fnRef);
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:10px;color:#5a6580;margin-top:6px;line-height:1.5";
    hint.innerHTML = "<b>變數</b>：close, open, high, low, volume + 參數名<br><b>運算</b>：+ − × ÷ ( ) 自動逐根計算";
    body.appendChild(hint);
    renderTextLines();
    fnRef.querySelectorAll(".ci-fn").forEach(el => {
      el.onmouseenter = () => { el.style.background = "#1f2535"; };
      el.onmouseleave = () => { el.style.background = ""; };
      el.onclick = () => {
        const text = el.dataset.insert;
        if (!activeFormulaTarget) {
          const last = overlay.querySelector(".ci-formula:last-of-type");
          if (last) activeFormulaTarget = last;
        }
        if (activeFormulaTarget) {
          const cur = activeFormulaTarget.value;
          const cp = activeFormulaTarget.selectionStart ?? cur.length;
          activeFormulaTarget.value = cur.slice(0, cp) + text + cur.slice(cp);
          activeFormulaTarget.focus();
          activeFormulaTarget.dispatchEvent(new Event("input", { bubbles: true }));
        }
      };
    });
  }

  function renderTextLines() {
    const c = document.getElementById("ciLines");
    c.innerHTML = "";
    lines.forEach((l, idx) => {
      const row = document.createElement("div");
      row.style.cssText = "background:#1f2535;padding:8px;border-radius:4px;margin-bottom:6px;";
      row.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 32px 24px;gap:6px;margin-bottom:4px">
          <input type="text" value="${l.name}" placeholder="線名稱" data-idx="${idx}" data-k="name">
          <input type="color" value="${l.color}" data-idx="${idx}" data-k="color">
          <button class="del-btn" data-idx="${idx}">✕</button>
        </div>
        <input type="text" value="${l.formula.replace(/"/g,'&quot;')}" placeholder="公式" data-idx="${idx}" data-k="formula" class="ci-formula" style="width:100%;font-family:Consolas,monospace">
        <div class="hint-small" id="ciValid_${idx}">點上方函數一鍵插入</div>`;
      c.appendChild(row);
    });
    c.querySelectorAll("input").forEach(inp => {
      inp.onfocus = (e) => { if (e.target.classList.contains("ci-formula")) activeFormulaTarget = e.target; };
      inp.oninput = (e) => {
        const i = +e.target.dataset.idx, k = e.target.dataset.k;
        lines[i][k] = e.target.value;
        if (k === "formula") {
          try {
            parseFormula(e.target.value);
            document.getElementById("ciValid_"+i).textContent = "✓ 語法正確";
            document.getElementById("ciValid_"+i).style.color = "#22c55e";
          } catch(err) {
            document.getElementById("ciValid_"+i).textContent = "✗ " + err.message;
            document.getElementById("ciValid_"+i).style.color = "#ef4444";
          }
        }
      };
    });
    c.querySelectorAll(".del-btn").forEach(b => {
      b.onclick = () => { lines.splice(+b.dataset.idx, 1); renderTextLines(); };
    });
  }

  function renderBlockBody(body) {
    // Sidebar palette + each line's canvas
    const sidebarWrap = document.createElement("div");
    sidebarWrap.className = "ci-palette-sidebar";
    sidebarWrap.innerHTML = "<h4>方塊調色盤（拖入空位 / 或先點空位再點此）</h4>";
    const sb = document.createElement("div");
    function makeCat(title, items) {
      const cat = document.createElement("div");
      cat.className = "ci-palette-cat";
      const h = document.createElement("h4");
      h.textContent = title;
      cat.appendChild(h);
      const idiv = document.createElement("div");
      idiv.className = "ci-palette-items";
      items.forEach(it => idiv.appendChild(makePaletteItem(it.label, it.make, it.style)));
      cat.appendChild(idiv);
      sb.appendChild(cat);
    }
    makeCat("變數", BLOCK_VARS.map(v => ({ label: v, make: () => newBlock("var",{name:v}), style:"var-style" })));
    if (params.length) {
      makeCat("參數", params.map(p => ({ label: p.key, make: () => newBlock("param",{name:p.key}), style:"param-style" })));
    }
    makeCat("數字", [{ label: "數字", make: () => newBlock("num",{value:0}), style:"num-style" }]);
    makeCat("運算子", BLOCK_OPS.map(op => ({ label: BLOCK_OP_LABELS[op], make: () => newBlock("op",{op}), style:"op-style" })));
    makeCat("函數 (1)", ["abs","log","sqrt"].map(f => ({ label: f+"(◯)", make: () => newBlock("fn",{name:f}), style:"fn-style" })));
    makeCat("函數 (2)", ["sma","ema","std","rsi","max","min","shift","hh","ll"].map(f => ({ label: f+"(◯,◯)", make: () => newBlock("fn",{name:f}), style:"fn-style" })));
    sidebarWrap.appendChild(sb);
    body.appendChild(sidebarWrap);

    // Lines
    const linesDiv = document.createElement("div");
    body.appendChild(linesDiv);
    function renderBlockLines() {
      linesDiv.innerHTML = "";
      lines.forEach((line, idx) => {
        const wrap = document.createElement("div");
        wrap.className = "ci-block-line-wrap";
        const head = document.createElement("div");
        head.className = "ci-block-line-head";
        head.innerHTML = `
          <input type="text" value="${line.name}" placeholder="線名稱" data-idx="${idx}" data-k="name">
          <input type="color" value="${line.color}" data-idx="${idx}" data-k="color">
          <button class="del-btn" data-idx="${idx}">✕</button>`;
        head.querySelectorAll("input").forEach(inp => {
          inp.oninput = (e) => {
            const i = +e.target.dataset.idx, k = e.target.dataset.k;
            lines[i][k] = e.target.value;
          };
        });
        head.querySelector(".del-btn").onclick = () => {
          lines.splice(idx, 1);
          renderBlockLines();
        };
        wrap.appendChild(head);
        const canvas = document.createElement("div");
        canvas.className = "ci-block-canvas";
        canvas.id = `ciBlockCanvas_${idx}`;
        wrap.appendChild(canvas);
        const preview = document.createElement("div");
        preview.style.cssText = "font-family:Consolas,monospace;font-size:10px;color:#5a6580;margin-top:6px;";
        preview.id = `ciBlockPreview_${idx}`;
        wrap.appendChild(preview);
        linesDiv.appendChild(wrap);

        function renderThisLine() {
          canvas.innerHTML = "";
          const rerender = () => renderThisLine();
          if (!line.block) {
            canvas.appendChild(makeSlot((b) => { line.block = b; rerender(); }, params));
          } else {
            canvas.appendChild(renderBlockEl(
              line.block,
              (newB) => { line.block = newB; rerender(); },
              rerender,
              params
            ));
          }
          // Preview formula
          const eq = blockComplete(line.block) ? blockToFormula(line.block) : "（尚有空位未填）";
          preview.innerHTML = `等價公式：<span style="color:${blockComplete(line.block)?'#22c55e':'#fbbf24'}">${eq}</span>`;
        }
        renderThisLine();
      });
      // Add line button
      const addBtn = document.createElement("button");
      addBtn.className = "add-btn"; addBtn.textContent = "+ 新增線";
      addBtn.onclick = () => {
        lines.push({ name: "Line " + (lines.length+1), color: "#60a5fa", formula: "0", block: null });
        renderBlockLines();
      };
      linesDiv.appendChild(addBtn);
    }
    renderBlockLines();
  }

  // ===== Template picker =====
  if (!existing) {
    document.getElementById("ciTemplate").onchange = (e) => {
      const k = e.target.value;
      if (!k) return;
      const t = CI_TEMPLATES[k];
      document.getElementById("ciName").value = t.name;
      params = t.params.map(p => ({...p}));
      lines = t.lines.map(l => ({ name: l.name, color: l.color, formula: l.formula, block: formulaToBlock(l.formula) }));
      renderParams();
      renderBody();
    };
  }

  // ===== Initial render =====
  renderParams();
  setActiveTab();
  renderBody();

  // ===== Cancel / Save =====
  document.getElementById("ciCancel").onclick = () => document.body.removeChild(overlay);
  document.getElementById("ciSave").onclick = () => {
    const name = document.getElementById("ciName").value.trim();
    if (!name) { alert("請輸入名稱"); return; }
    if (!lines.length) { alert("至少需要一條線"); return; }

    // Convert blocks → formulas if in block mode
    if (mode === "block") {
      for (let i = 0; i < lines.length; i++) {
        if (!blockComplete(lines[i].block)) {
          alert(`第 ${i+1} 條線「${lines[i].name}」的方塊樹有空位未填`);
          return;
        }
        lines[i].formula = blockToFormula(lines[i].block);
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        try { parseFormula(lines[i].formula); }
        catch(err) { alert(`第 ${i+1} 條線公式錯誤: ${err.message}`); return; }
      }
    }

    if (existing) {
      STATE.panes.filter(p => p.type === "custom_" + existing.id).forEach(p => removePane(p.id));
      existing.name = name;
      existing.params = params;
      existing.lines = lines.map(l => ({ name: l.name, color: l.color, formula: l.formula }));
      delete PANE_DEFS["custom_" + existing.id];
    } else {
      STATE.customIndicators.push({
        id: Date.now(), name, params,
        lines: lines.map(l => ({ name: l.name, color: l.color, formula: l.formula }))
      });
    }
    saveCustomIndicators();
    registerAllCustoms();
    renderCustomList();
    document.body.removeChild(overlay);
  };
};

// ============================================================
// PANNABLE BLOCK CANVAS — global event delegation
// Works on every .ci-block-canvas regardless of when it's created.
// ============================================================
(function setupBlockCanvasPan() {
  // Mouse-drag-to-pan: middle-click anywhere, OR left-click on canvas background
  document.addEventListener("mousedown", (e) => {
    const canvas = e.target.closest && e.target.closest(".ci-block-canvas");
    if (!canvas) return;
    const isMiddleBtn = e.button === 1;
    const onBackground = (e.target === canvas);
    if (!isMiddleBtn && !onBackground) return;
    e.preventDefault();
    canvas.classList.add("panning");
    const startX = e.clientX, startY = e.clientY;
    const startSL = canvas.scrollLeft, startST = canvas.scrollTop;
    const onMove = (ev) => {
      canvas.scrollLeft = startSL - (ev.clientX - startX);
      canvas.scrollTop  = startST - (ev.clientY - startY);
    };
    const onUp = () => {
      canvas.classList.remove("panning");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Shift + wheel → horizontal scroll on block canvas only.
  // We early-exit BEFORE doing DOM walks if there's no editor open.
  document.addEventListener("wheel", (e) => {
    if (!e.shiftKey) return;                  // most wheel events skipped at once
    const canvas = e.target.closest && e.target.closest(".ci-block-canvas");
    if (!canvas) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      canvas.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  // (Auto-scroll-into-view feature removed — its body-wide MutationObserver
  //  fired on every DOM change in the whole app and was the main cause of
  //  refresh slowdown. The block canvas is pannable & resizable anyway.)
})();

// ============================================================
// BLOCK SWAP — drag a block onto another to exchange positions
// ============================================================

// Wrap renderBlockEl so every rendered block carries its context:
//   el._block       — the block object it represents
//   el._onReplace   — function(newBlock) that replaces this block at its position
//                     (also triggers a rerender)
//   el._rerender    — function to rerender the line
(function patchRenderBlockEl() {
  const orig = renderBlockEl;
  renderBlockEl = function(block, onReplace, rerender, currentParams) {
    const el = orig(block, onReplace, rerender, currentParams);
    el._block = block;
    el._onReplace = onReplace;
    el._rerender = rerender;
    return el;
  };
})();

// Helper: is `target` reachable from `node` (i.e., descendant or equal)?
function isDescendantBlock(node, target) {
  if (!node) return false;
  if (node === target) return true;
  if (!node.args) return false;
  return node.args.some(c => c && isDescendantBlock(c, target));
}

// Global drag state for block-to-block swap
let DRAG_SWAP_SOURCE = null;  // a DOM element (the .ci-block being dragged)

document.addEventListener("dragstart", (e) => {
  const blockEl = e.target.closest && e.target.closest(".ci-block");
  if (blockEl && blockEl.closest(".ci-block-canvas")) {
    DRAG_SWAP_SOURCE = blockEl;
  } else {
    DRAG_SWAP_SOURCE = null;
  }
}, true);

document.addEventListener("dragover", (e) => {
  if (!DRAG_SWAP_SOURCE) return;
  // Slot has its own dragover (for picking) — let it handle.
  if (e.target.closest && e.target.closest(".ci-slot")) return;
  const targetEl = e.target.closest && e.target.closest(".ci-block");
  if (!targetEl || targetEl === DRAG_SWAP_SOURCE) return;
  // Only within the same canvas
  if (targetEl.closest(".ci-block-canvas") !== DRAG_SWAP_SOURCE.closest(".ci-block-canvas")) return;
  e.preventDefault();   // mark target as a valid drop target
  // Highlight (only one at a time)
  document.querySelectorAll(".drag-swap-target").forEach(el => {
    if (el !== targetEl) el.classList.remove("drag-swap-target");
  });
  targetEl.classList.add("drag-swap-target");
}, true);

document.addEventListener("dragleave", (e) => {
  const t = e.target.closest && e.target.closest(".ci-block");
  if (!t) return;
  // Only clear if pointer truly left the block
  // (dragleave fires when moving onto a child — check relatedTarget)
  if (e.relatedTarget && t.contains(e.relatedTarget)) return;
  t.classList.remove("drag-swap-target");
}, true);

document.addEventListener("drop", (e) => {
  // Clear all highlights regardless of outcome
  document.querySelectorAll(".drag-swap-target").forEach(el => el.classList.remove("drag-swap-target"));
  if (!DRAG_SWAP_SOURCE) return;

  // If user dropped on a SLOT, let the slot's own ondrop handle (copy semantics)
  if (e.target.closest && e.target.closest(".ci-slot")) {
    DRAG_SWAP_SOURCE = null;
    return;
  }
  const targetEl = e.target.closest && e.target.closest(".ci-block");
  if (!targetEl || targetEl === DRAG_SWAP_SOURCE) { DRAG_SWAP_SOURCE = null; return; }
  if (targetEl.closest(".ci-block-canvas") !== DRAG_SWAP_SOURCE.closest(".ci-block-canvas")) {
    DRAG_SWAP_SOURCE = null;
    return;
  }

  // Have a valid swap target
  e.preventDefault();
  e.stopPropagation();

  const srcBlock = DRAG_SWAP_SOURCE._block;
  const tgtBlock = targetEl._block;
  const srcReplace = DRAG_SWAP_SOURCE._onReplace;
  const tgtReplace = targetEl._onReplace;

  if (!srcBlock || !tgtBlock || !srcReplace || !tgtReplace) {
    DRAG_SWAP_SOURCE = null; return;
  }

  // Cannot swap blocks where one is an ancestor of the other
  if (isDescendantBlock(srcBlock, tgtBlock) || isDescendantBlock(tgtBlock, srcBlock)) {
    alert("無法與祖先或子孫方塊交換位置");
    DRAG_SWAP_SOURCE = null;
    return;
  }

  // Perform swap. Each onReplace mutates + rerenders; second rerender wins.
  // (Both onReplace closures still hold valid parent references — they mutate
  //  the parent objects directly which remain in the tree.)
  srcReplace(tgtBlock);
  tgtReplace(srcBlock);

  DRAG_SWAP_SOURCE = null;
}, true);

document.addEventListener("dragend", () => {
  document.querySelectorAll(".drag-swap-target").forEach(el => el.classList.remove("drag-swap-target"));
  DRAG_SWAP_SOURCE = null;
}, true);

// ============================================================
// DRAWING TOOLS — SVG overlay on main pane
// ============================================================
const DRAW_LS_KEY = "practice_trading_drawings";

STATE.drawings = (() => {
  try { return JSON.parse(localStorage.getItem(DRAW_LS_KEY)) || []; }
  catch(e) { return []; }
})();
STATE.drawingTool = "cursor";
STATE.drawingColor = "#fbbf24";
STATE.drawingTemp = null;     // in-progress shape during creation
STATE.drawingNextId = (STATE.drawings.reduce((m, d) => Math.max(m, d.id || 0), 0) || 0) + 1;
STATE.drawingLayer = null;    // DOM container
STATE.drawingSvg = null;      // SVG element

function saveDrawings() {
  try { localStorage.setItem(DRAW_LS_KEY, JSON.stringify(STATE.drawings)); } catch(e) {}
}

// Convert a {time, price} world point to SVG coordinates relative to main pane
function worldToScreen(time, price) {
  if (!STATE.mainPane || !STATE.mainPane.chart) return null;
  const ts = STATE.mainPane.chart.timeScale();
  const x = ts.timeToCoordinate(time);
  const y = STATE.mainPane.series.candle.priceToCoordinate(price);
  if (x === null || y === null) return null;
  return { x, y };
}

function screenToWorld(clientX, clientY) {
  if (!STATE.mainPane || !STATE.mainPane.chart) return null;
  const rect = STATE.mainPane.dom.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const ts = STATE.mainPane.chart.timeScale();
  const time = ts.coordinateToTime(x);
  const price = STATE.mainPane.series.candle.coordinateToPrice(y);
  if (time === null || price === null) return null;
  return { time, price };
}

function createDrawingToolbar() {
  if (!STATE.mainPane) return;
  // Remove existing
  const oldBar = STATE.mainPane.dom.querySelector(".draw-toolbar");
  if (oldBar) oldBar.remove();
  const oldLayer = STATE.mainPane.dom.querySelector(".drawing-layer");
  if (oldLayer) oldLayer.remove();

  // Toolbar
  const bar = document.createElement("div");
  bar.className = "draw-toolbar";
  const tools = [
    { tool: "cursor",   icon: "↖", tip: "選取（平移圖表）" },
    { tool: "trendline", icon: "╱", tip: "趨勢線（兩點）" },
    { tool: "hline",    icon: "─", tip: "水平線（一點）" },
    { tool: "rectangle", icon: "▭", tip: "矩形（兩點）" },
    { tool: "text",     icon: "T", tip: "文字標籤" },
  ];
  tools.forEach(t => {
    const btn = document.createElement("button");
    btn.className = "draw-tool-btn" + (STATE.drawingTool === t.tool ? " active" : "");
    btn.dataset.tool = t.tool;
    btn.innerHTML = `<span style="font-size:14px;font-weight:600;">${t.icon}</span><span class="tool-tip">${t.tip}</span>`;
    btn.onclick = () => setDrawingTool(t.tool);
    bar.appendChild(btn);
  });
  // Color
  const colorBtn = document.createElement("button");
  colorBtn.className = "draw-tool-btn";
  colorBtn.innerHTML = `<input type="color" value="${STATE.drawingColor}"><span class="tool-tip">畫筆顏色</span>`;
  const colorInput = colorBtn.querySelector("input");
  colorInput.oninput = (e) => { STATE.drawingColor = e.target.value; };
  bar.appendChild(colorBtn);

  // Divider
  const div = document.createElement("div");
  div.className = "draw-toolbar-divider";
  bar.appendChild(div);

  // Eraser
  const eraser = document.createElement("button");
  eraser.className = "draw-tool-btn" + (STATE.drawingTool === "eraser" ? " active" : "");
  eraser.dataset.tool = "eraser";
  eraser.innerHTML = `<span style="font-size:14px;">⌫</span><span class="tool-tip">橡皮擦（點圖形刪除）</span>`;
  eraser.onclick = () => setDrawingTool("eraser");
  bar.appendChild(eraser);

  // Clear all
  const clearBtn = document.createElement("button");
  clearBtn.className = "draw-tool-btn";
  clearBtn.innerHTML = `<span style="font-size:14px;">🗑</span><span class="tool-tip">清除全部</span>`;
  clearBtn.onclick = () => {
    if (!STATE.drawings.length) return;
    if (!confirm("清除所有繪圖？")) return;
    STATE.drawings = [];
    saveDrawings();
    renderDrawings();
  };
  bar.appendChild(clearBtn);

  STATE.mainPane.dom.appendChild(bar);

  // SVG overlay
  const layer = document.createElement("div");
  layer.className = "drawing-layer";
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("xmlns", svgNS);
  layer.appendChild(svg);
  STATE.mainPane.dom.appendChild(layer);
  STATE.drawingLayer = layer;
  STATE.drawingSvg = svg;

  // Wire mouse events
  layer.addEventListener("mousedown", onDrawMouseDown);
  layer.addEventListener("mousemove", onDrawMouseMove);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      STATE.drawingTemp = null;
      renderDrawings();
    }
  });

  // Listen to chart time scale changes → reposition shapes
  STATE.mainPane.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    renderDrawings();
  });
}

function setDrawingTool(tool) {
  STATE.drawingTool = tool;
  STATE.drawingTemp = null;
  // Update toolbar visual state
  STATE.mainPane.dom.querySelectorAll(".draw-toolbar .draw-tool-btn").forEach(b => {
    if (b.dataset.tool) b.classList.toggle("active", b.dataset.tool === tool);
  });
  // Update layer pointer-events
  if (tool === "cursor") {
    STATE.drawingLayer.classList.remove("active", "eraser-mode");
  } else if (tool === "eraser") {
    STATE.drawingLayer.classList.add("active", "eraser-mode");
  } else {
    STATE.drawingLayer.classList.add("active");
    STATE.drawingLayer.classList.remove("eraser-mode");
  }
  renderDrawings();
}

function onDrawMouseDown(e) {
  if (STATE.drawingTool === "cursor") return;
  if (e.button !== 0) return;  // left click only
  e.stopPropagation();

  if (STATE.drawingTool === "eraser") return;  // eraser handled by shape click

  const world = screenToWorld(e.clientX, e.clientY);
  if (!world) return;

  switch (STATE.drawingTool) {
    case "hline":
      STATE.drawings.push({
        id: STATE.drawingNextId++, type: "hline",
        pts: [{ time: world.time, price: world.price }],
        color: STATE.drawingColor
      });
      saveDrawings(); renderDrawings();
      break;

    case "trendline":
    case "rectangle":
      if (!STATE.drawingTemp) {
        STATE.drawingTemp = {
          type: STATE.drawingTool,
          pts: [{ time: world.time, price: world.price }],
          color: STATE.drawingColor
        };
      } else {
        STATE.drawingTemp.pts.push({ time: world.time, price: world.price });
        STATE.drawingTemp.id = STATE.drawingNextId++;
        STATE.drawings.push(STATE.drawingTemp);
        STATE.drawingTemp = null;
        saveDrawings();
        renderDrawings();
      }
      break;

    case "text": {
      const t = prompt("輸入文字標註：");
      if (t) {
        STATE.drawings.push({
          id: STATE.drawingNextId++, type: "text",
          pts: [{ time: world.time, price: world.price }],
          color: STATE.drawingColor, text: t
        });
        saveDrawings(); renderDrawings();
      }
      break;
    }
  }
}

function onDrawMouseMove(e) {
  if (!STATE.drawingTemp) return;
  const world = screenToWorld(e.clientX, e.clientY);
  if (!world) return;
  STATE.drawingTemp._previewEnd = { time: world.time, price: world.price };
  renderDrawings();
}

function renderDrawings() {
  if (!STATE.drawingSvg || !STATE.mainPane) return;
  const svg = STATE.drawingSvg;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const w = STATE.mainPane.dom.clientWidth;
  const h = STATE.mainPane.dom.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);

  const svgNS = "http://www.w3.org/2000/svg";

  // Render persisted drawings
  const list = STATE.drawings.slice();
  if (STATE.drawingTemp && STATE.drawingTemp._previewEnd) {
    list.push({
      ...STATE.drawingTemp,
      id: -1,
      pts: [STATE.drawingTemp.pts[0], STATE.drawingTemp._previewEnd],
      _preview: true
    });
  }

  list.forEach(d => {
    const isPreview = d._preview;
    const opacity = isPreview ? 0.6 : 1;
    switch (d.type) {
      case "hline": {
        const p0 = worldToScreen(d.pts[0].time, d.pts[0].price);
        if (!p0) {
          // Try to use price only — span full width
          const y = STATE.mainPane.series.candle.priceToCoordinate(d.pts[0].price);
          if (y === null) return;
          drawLine(svg, 0, y, w, y, d.color, 1.5, d.id, opacity);
          drawLabel(svg, w - 50, y, d.pts[0].price.toFixed(2), d.color);
        } else {
          drawLine(svg, 0, p0.y, w, p0.y, d.color, 1.5, d.id, opacity);
          drawLabel(svg, w - 50, p0.y, d.pts[0].price.toFixed(2), d.color);
        }
        break;
      }
      case "trendline": {
        if (d.pts.length < 2) return;
        const p0 = worldToScreen(d.pts[0].time, d.pts[0].price);
        const p1 = worldToScreen(d.pts[1].time, d.pts[1].price);
        if (!p0 || !p1) return;
        drawLine(svg, p0.x, p0.y, p1.x, p1.y, d.color, 1.5, d.id, opacity);
        break;
      }
      case "rectangle": {
        if (d.pts.length < 2) return;
        const p0 = worldToScreen(d.pts[0].time, d.pts[0].price);
        const p1 = worldToScreen(d.pts[1].time, d.pts[1].price);
        if (!p0 || !p1) return;
        const x = Math.min(p0.x, p1.x), y = Math.min(p0.y, p1.y);
        const rw = Math.abs(p1.x - p0.x), rh = Math.abs(p1.y - p0.y);
        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", x);
        rect.setAttribute("y", y);
        rect.setAttribute("width", rw);
        rect.setAttribute("height", rh);
        rect.setAttribute("fill", d.color);
        rect.setAttribute("fill-opacity", isPreview ? 0.1 : 0.15);
        rect.setAttribute("stroke", d.color);
        rect.setAttribute("stroke-width", 1.5);
        rect.setAttribute("opacity", opacity);
        rect.classList.add("drawing-shape");
        rect.dataset.id = d.id;
        rect.onclick = () => onShapeClick(d.id);
        svg.appendChild(rect);
        break;
      }
      case "text": {
        const p0 = worldToScreen(d.pts[0].time, d.pts[0].price);
        if (!p0) return;
        const txt = document.createElementNS(svgNS, "text");
        txt.setAttribute("x", p0.x);
        txt.setAttribute("y", p0.y);
        txt.setAttribute("fill", d.color);
        txt.setAttribute("font-size", 12);
        txt.setAttribute("font-family", "Consolas, monospace");
        txt.setAttribute("opacity", opacity);
        txt.textContent = d.text;
        txt.classList.add("drawing-shape");
        txt.dataset.id = d.id;
        txt.onclick = () => onShapeClick(d.id);
        svg.appendChild(txt);
        break;
      }
    }
  });
}

function drawLine(svg, x1, y1, x2, y2, color, width, id, opacity) {
  const svgNS = "http://www.w3.org/2000/svg";
  // Wider invisible line for easier click target
  const hit = document.createElementNS(svgNS, "line");
  hit.setAttribute("x1", x1); hit.setAttribute("y1", y1);
  hit.setAttribute("x2", x2); hit.setAttribute("y2", y2);
  hit.setAttribute("stroke", "transparent");
  hit.setAttribute("stroke-width", 8);
  hit.classList.add("drawing-shape");
  if (id !== undefined && id >= 0) {
    hit.dataset.id = id;
    hit.onclick = () => onShapeClick(id);
  }
  svg.appendChild(hit);
  const line = document.createElementNS(svgNS, "line");
  line.setAttribute("x1", x1); line.setAttribute("y1", y1);
  line.setAttribute("x2", x2); line.setAttribute("y2", y2);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", width);
  line.setAttribute("opacity", opacity);
  svg.appendChild(line);
}

function drawLabel(svg, x, y, text, color) {
  const svgNS = "http://www.w3.org/2000/svg";
  const bg = document.createElementNS(svgNS, "rect");
  bg.setAttribute("x", x); bg.setAttribute("y", y - 8);
  bg.setAttribute("width", 46); bg.setAttribute("height", 16);
  bg.classList.add("drawing-label-bg");
  svg.appendChild(bg);
  const t = document.createElementNS(svgNS, "text");
  t.setAttribute("x", x + 4); t.setAttribute("y", y + 4);
  t.setAttribute("fill", color);
  t.setAttribute("font-size", 11);
  t.setAttribute("font-family", "Consolas, monospace");
  t.textContent = text;
  svg.appendChild(t);
}

function onShapeClick(id) {
  if (STATE.drawingTool === "eraser") {
    STATE.drawings = STATE.drawings.filter(d => d.id !== id);
    saveDrawings();
    renderDrawings();
  }
}

// ============================================================
// PENDING ORDERS — Limit / Stop / OCO
// ============================================================
STATE.pendingOrders = [];      // [{ id, side, type, triggerPrice, sl, tp, size, lev, spread, ocoGroupId? }]
STATE.pendingNextId = 1;
STATE.ocoNextGroupId = 1;

function placePendingOrder(side, type, triggerPrice, ocoGroupId = null) {
  const size = +$("orderSize").value;
  const lev = +$("orderLev").value;
  const slDist = +$("orderSL").value || 0;
  const tpDist = +$("orderTP").value || 0;
  const spread = getSpread();
  STATE.pendingOrders.push({
    id: STATE.pendingNextId++,
    side, type,                 // type: "limit" | "stop"
    triggerPrice, slDist, tpDist,
    size, lev, spread,
    ocoGroupId,
    placedAt: STATE.cursor      // bar index
  });
}

// Check pending orders against the current bar. Called after stepForward / checkSLTP.
function checkPendingOrders() {
  if (!STATE.pendingOrders.length) return;
  const bar = STATE.bars[STATE.cursor];
  if (!bar) return;

  const triggered = [];
  for (const o of STATE.pendingOrders) {
    if (o.placedAt > STATE.cursor) continue;
    let hit = false;
    if (o.type === "limit" && o.side === "long")  hit = bar.low  <= o.triggerPrice;
    if (o.type === "limit" && o.side === "short") hit = bar.high >= o.triggerPrice;
    if (o.type === "stop"  && o.side === "long")  hit = bar.high >= o.triggerPrice;
    if (o.type === "stop"  && o.side === "short") hit = bar.low  <= o.triggerPrice;
    if (hit) triggered.push(o);
  }
  if (!triggered.length) return;

  for (const o of triggered) {
    if (STATE.position) break;
    if (!STATE.locked) {
      if (!applyInitialBalance()) continue;
      lockBalance();
    }
    const entryBid = o.side === "long" ? o.triggerPrice - o.spread : o.triggerPrice;
    const entryAsk = o.side === "long" ? o.triggerPrice : o.triggerPrice + o.spread;
    const entryPrice = o.side === "long" ? entryAsk : entryBid;

    // Apply sltpCfg if present; otherwise no SL/TP
    let slRes = { sl: null, trail: null };
    let tp = null;
    if (o.sltpCfg) {
      slRes = resolveSL(o.sltpCfg, o.side, entryAsk, entryBid, o.spread);
      tp = resolveTP(o.sltpCfg, o.side, entryAsk, entryBid, o.spread);
    }

    STATE.position = {
      side: o.side, entryPrice, entryBid, entryAsk, spread: o.spread,
      entryIdx: STATE.cursor, size: o.size, leverage: o.lev,
      sl: slRes.sl, tp, trail: slRes.trail,
      entryTime: bar.label
    };
    // Cancel order + OCO siblings
    STATE.pendingOrders = STATE.pendingOrders.filter(po =>
      po !== o && (po.ocoGroupId == null || po.ocoGroupId !== o.ocoGroupId)
    );
    break;
  }
  renderPendingOrders();
}

function cancelPendingOrder(id) {
  const o = STATE.pendingOrders.find(p => p.id === id);
  if (!o) return;
  // If OCO, cancel its siblings too
  STATE.pendingOrders = STATE.pendingOrders.filter(po =>
    po.id !== id && (o.ocoGroupId == null || po.ocoGroupId !== o.ocoGroupId)
  );
  renderPendingOrders();
}

function renderPendingOrders() {
  const list = $("pendingOrdersList");
  if (!list) return;
  if (!STATE.pendingOrders.length) {
    list.innerHTML = "";
    renderPendingOrderLines();  // ← bug fix: also clear chart price lines
    return;
  }
  list.innerHTML = "<h2 style='font-size:11px;color:#8da0c0;letter-spacing:0.6px;margin:6px 0;text-transform:uppercase'>待掛單 Pending</h2>";
  STATE.pendingOrders.forEach(o => {
    const card = document.createElement("div");
    card.className = "pending-order-card " + (o.side === "long" ? "buy" : "sell") + (o.ocoGroupId ? " oco" : "");
    const typeLabel = ({ limit: "Limit", stop: "Stop" })[o.type];
    const ocoTag = o.ocoGroupId ? " · OCO" : "";
    card.innerHTML = `
      <div class="po-info">
        <span class="po-tag">${o.side === "long" ? "BUY" : "SELL"} ${typeLabel}${ocoTag}</span>
        <span class="po-price">@ ${o.triggerPrice.toFixed(3)}</span>
        <span class="po-tag">${o.size} 口 · SL ${o.slDist || "—"} · TP ${o.tpDist || "—"}</span>
      </div>
      <button class="po-cancel" title="取消">✕</button>`;
    card.querySelector(".po-cancel").onclick = () => cancelPendingOrder(o.id);
    list.appendChild(card);
  });
  // Also render hlines on main pane (visual marker)
  renderPendingOrderLines();
}

// Show pending orders as price lines on main chart
let _pendingLines = [];
function renderPendingOrderLines() {
  if (!STATE.mainPane) return;
  // Remove old price lines
  _pendingLines.forEach(pl => { try { STATE.mainPane.series.candle.removePriceLine(pl); } catch(e) {} });
  _pendingLines = [];
  STATE.pendingOrders.forEach(o => {
    const pl = STATE.mainPane.series.candle.createPriceLine({
      price: o.triggerPrice,
      color: o.side === "long" ? "#16a34a" : "#dc2626",
      lineWidth: 1,
      lineStyle: 2,  // dashed
      axisLabelVisible: true,
      title: `${o.side === "long" ? "BUY" : "SELL"} ${o.type.toUpperCase()}${o.ocoGroupId ? " OCO" : ""}`
    });
    _pendingLines.push(pl);
  });
}



// On stepBack: cancel pending orders whose placement is now in the future
const _origStepBack = stepBack;
stepBack = function() {
  _origStepBack();
  // Drop pendings placed at or after current cursor (defensive)
  const before = STATE.pendingOrders.length;
  STATE.pendingOrders = STATE.pendingOrders.filter(o => o.placedAt <= STATE.cursor);
  if (STATE.pendingOrders.length !== before) renderPendingOrders();
};

// Trigger price input visibility on order type change
$("orderType").addEventListener("change", () => {
  const t = $("orderType").value;
  $("triggerPriceWrap").style.display = t === "market" ? "none" : "block";
  $("ocoExtraWrap").style.display = t === "oco" ? "block" : "none";
  // Update label
  const label = $("triggerPriceLabel");
  if (label) {
    label.textContent = t === "oco" ? "OCO 第一觸發價" : "觸發價";
  }
});

// Override refresh to also keep pending order lines fresh
const _origRefreshOrders = refresh;
refresh = function() {
  _origRefreshOrders();
  renderDrawings();
  if (STATE.mainPane && _pendingLines.length === 0 && STATE.pendingOrders.length > 0) {
    renderPendingOrderLines();
  }
};

// Initialize drawing toolbar after charts are built — hook into initCharts
const _origInitCharts = initCharts;
initCharts = function() {
  _origInitCharts();
  createDrawingToolbar();
  setTimeout(renderDrawings, 50);
  if (STATE.pendingOrders && STATE.pendingOrders.length) renderPendingOrders();
};

// Reset behavior should also clear pending orders
const _origBtnReset = $("btnReset").onclick;
$("btnReset").onclick = function() {
  if (!confirm("確定重置？所有交易記錄將清空，初始餘額將解鎖")) return;
  STATE.trades = []; STATE.position = null; STATE.equityCurve = [];
  STATE.pendingOrders = [];
  unlockBalance();
  applyInitialBalance();
  renderPendingOrders();
  refresh();
};

// ============================================================
// NEW SL/TP MODES (distance / absolute / trailing) + trail floor
// ============================================================
function readSLTPConfig() {
  return {
    slMode: $("slMode").value,
    slValue: +$("slValue").value || 0,
    floorEnable: $("slFloorEnable").checked,
    floorMode: $("slFloorMode").value,
    floorValue: +$("slFloorValue").value || 0,
    tpMode: $("tpMode").value,
    tpValue: +$("tpValue").value || 0
  };
}

// Convention:
//   For LONG  positions, p.sl / p.tp are stored in chart (Bid) scale; check bar.low/high directly.
//   For SHORT positions, p.sl / p.tp are stored in Ask scale (= chart + spread); check (bar.high+spread)/(bar.low+spread).
// User input of "absolute price" is always on the chart price they see (Bid). We add spread internally for shorts.

function resolveSL(cfg, side, entryAsk, entryBid, spread) {
  if (cfg.slMode === "none" || !cfg.slValue) return { sl: null, trail: null };

  if (cfg.slMode === "dist") {
    const sl = side === "long" ? entryAsk - cfg.slValue : entryBid + cfg.slValue;
    return { sl, trail: null };
  }

  if (cfg.slMode === "abs") {
    if (side === "long") {
      if (cfg.slValue >= entryBid) {
        if (!confirm(`Long SL 絕對價 ${cfg.slValue} >= 進場 Bid ${entryBid.toFixed(3)}，會立即觸發。確定？`))
          return { sl: null, trail: null, invalid: true };
      }
      return { sl: cfg.slValue, trail: null };
    } else {
      if (cfg.slValue <= entryBid) {
        if (!confirm(`Short SL 絕對價 ${cfg.slValue} <= 進場 Bid ${entryBid.toFixed(3)}，會立即觸發。確定？`))
          return { sl: null, trail: null, invalid: true };
      }
      return { sl: cfg.slValue + spread, trail: null };  // convert chart price → Ask scale
    }
  }

  if (cfg.slMode === "trail") {
    const distance = cfg.slValue;
    let floor = null;
    if (cfg.floorEnable && cfg.floorValue > 0) {
      if (cfg.floorMode === "dist") {
        floor = side === "long" ? entryAsk - cfg.floorValue : entryBid + cfg.floorValue;
      } else {
        floor = side === "long" ? cfg.floorValue : cfg.floorValue + spread;
      }
    }
    let sl;
    if (side === "long") {
      sl = entryAsk - distance;
      if (floor != null) sl = Math.max(sl, floor);
    } else {
      sl = entryBid + distance;
      if (floor != null) sl = Math.min(sl, floor);
    }
    return {
      sl,
      trail: {
        distance, floor,
        bestPrice: side === "long" ? entryAsk : entryBid
      }
    };
  }
  return { sl: null, trail: null };
}

function resolveTP(cfg, side, entryAsk, entryBid, spread) {
  if (cfg.tpMode === "none" || !cfg.tpValue) return null;

  if (cfg.tpMode === "dist") {
    return side === "long" ? entryAsk + cfg.tpValue : entryBid - cfg.tpValue;
  }
  if (cfg.tpMode === "abs") {
    if (side === "long") {
      if (cfg.tpValue <= entryBid) {
        if (!confirm(`Long TP 絕對價 ${cfg.tpValue} <= 進場 Bid ${entryBid.toFixed(3)}，會立即觸發。確定？`)) return null;
      }
      return cfg.tpValue;
    } else {
      if (cfg.tpValue >= entryBid) {
        if (!confirm(`Short TP 絕對價 ${cfg.tpValue} >= 進場 Bid ${entryBid.toFixed(3)}，會立即觸發。確定？`)) return null;
      }
      return cfg.tpValue + spread;
    }
  }
  return null;
}

// Update trailing SL each bar
function updateTrailingSL() {
  const p = STATE.position;
  if (!p || !p.trail) return;
  const bar = STATE.bars[STATE.cursor];
  if (!bar) return;
  if (p.side === "long") {
    if (bar.high > p.trail.bestPrice) p.trail.bestPrice = bar.high;
    let cand = p.trail.bestPrice - p.trail.distance;
    if (p.trail.floor != null) cand = Math.max(cand, p.trail.floor);
    if (cand > p.sl) p.sl = cand;   // ratchet — never move SL backward
  } else {
    if (bar.low < p.trail.bestPrice) p.trail.bestPrice = bar.low;
    let cand = p.trail.bestPrice + p.trail.distance;
    if (p.trail.floor != null) cand = Math.min(cand, p.trail.floor);
    if (cand < p.sl) p.sl = cand;
  }
}


// Update placePendingOrder signature to carry sltp config
placePendingOrder = function(side, type, triggerPrice, ocoGroupId = null, sltpCfg = null) {
  STATE.pendingOrders.push({
    id: STATE.pendingNextId++,
    side, type, triggerPrice,
    size: +$("orderSize").value,
    lev: +$("orderLev").value,
    spread: getSpread(),
    sltpCfg,
    ocoGroupId,
    placedAt: STATE.cursor
  });
};



// recordTrade carries trail info
const _origRecordTrade = recordTrade;
recordTrade = function(p, exitIdx, exitPrice, pnl, reason, bar) {
  _origRecordTrade(p, exitIdx, exitPrice, pnl, reason, bar);
  // last pushed trade gets trail snapshot for reference
  const t = STATE.trades[STATE.trades.length - 1];
  if (t && p.trail) {
    t.trailDistance = p.trail.distance;
    t.trailFloor = p.trail.floor;
  }
};

// reopenTradeAsPosition restores trail if present
const _origReopen = reopenTradeAsPosition;
reopenTradeAsPosition = function(t) {
  _origReopen(t);
  if (t.trailDistance != null) {
    STATE.position.trail = {
      distance: t.trailDistance,
      floor: t.trailFloor,
      bestPrice: t.side === "long" ? t.entryAsk : t.entryBid
    };
  }
};

// Update position card to show user-facing SL/TP (in chart Bid scale)
updatePositionCard = function() {
  const el = $("positionCard");
  if (!STATE.position) { el.innerHTML = ""; return; }
  const p = STATE.position;
  const mult = getMult();
  const curBid = STATE.bars[STATE.cursor].close;
  const curAsk = curBid + p.spread;
  const upnl = p.side === "long"
    ? (curBid - p.entryPrice) * p.size * mult
    : (p.entryPrice - curAsk) * p.size * mult;
  const entryLabel = p.side === "long"
    ? `${p.entryPrice.toFixed(3)} <span style="color:#8da0c0">(Ask)</span>`
    : `${p.entryPrice.toFixed(3)} <span style="color:#8da0c0">(Bid)</span>`;
  // Convert stored SL/TP to chart price for display
  const slDisplay = p.sl != null ? (p.side === "long" ? p.sl : p.sl - p.spread) : null;
  const tpDisplay = p.tp != null ? (p.side === "long" ? p.tp : p.tp - p.spread) : null;
  const trailTag = p.trail
    ? ` <span style="color:#fbbf24">📈 trail ${p.trail.distance}${p.trail.floor!=null?` (floor ${(p.side==="long"?p.trail.floor:p.trail.floor-p.spread).toFixed(2)})`:""}</span>`
    : "";
  el.innerHTML = `<div class="position-card ${p.side}">
    <div style="display:flex;justify-content:space-between"><b>${p.side.toUpperCase()}</b><span>${p.size} 口 · ${p.leverage}x · 點差 ${p.spread.toFixed(2)}</span></div>
    <div class="stat"><span class="k">進場價</span><span class="v">${entryLabel}</span></div>
    <div class="stat"><span class="k">現價 Bid / Ask</span><span class="v">${curBid.toFixed(3)} / ${curAsk.toFixed(3)}</span></div>
    <div class="stat"><span class="k">SL / TP</span><span class="v">${slDisplay!=null?slDisplay.toFixed(3):"—"} / ${tpDisplay!=null?tpDisplay.toFixed(3):"—"}${trailTag}</span></div>
    <div class="stat"><span class="k">浮動 P&L</span><span class="v ${upnl>=0?'pos':'neg'}">${upnl.toFixed(2)}</span></div>
  </div>`;
};

// UI: show/hide trail floor wrap based on slMode + slFloorEnable
$("slMode").addEventListener("change", () => {
  $("slFloorWrap").style.display = $("slMode").value === "trail" ? "block" : "none";
  if ($("slMode").value !== "trail") {
    $("slFloorEnable").checked = false;
    $("slFloorInputs").style.display = "none";
  }
});
$("slFloorEnable").addEventListener("change", () => {
  $("slFloorInputs").style.display = $("slFloorEnable").checked ? "block" : "none";
});

// ============================================================
// DRAWING: drag (move) + select + copy/paste
// ============================================================
STATE.selectedDrawingId = null;
STATE.drawingClipboard = null;
STATE._dragInfo = null;

// Helper: get pixel delta in time/price for a given world delta
function pixelDeltaToWorld(dx, dy, refPoint) {
  // refPoint is a {time, price} from the drawing; we convert refPoint to pixels,
  // then add dx/dy to get a new pixel position, then convert back to world.
  if (!STATE.mainPane) return null;
  const p = worldToScreen(refPoint.time, refPoint.price);
  if (!p) return null;
  const newScreenX = p.x + dx, newScreenY = p.y + dy;
  const ts = STATE.mainPane.chart.timeScale();
  const newTime = ts.coordinateToTime(newScreenX);
  const newPrice = STATE.mainPane.series.candle.coordinateToPrice(newScreenY);
  if (newTime === null || newPrice === null) return null;
  return {
    timeDelta: newTime - refPoint.time,
    priceDelta: newPrice - refPoint.price
  };
}

// Override onShapeClick to handle select (in cursor mode) AND eraser
function onShapeClick(id) {
  if (STATE.drawingTool === "eraser") {
    STATE.drawings = STATE.drawings.filter(d => d.id !== id);
    saveDrawings();
    renderDrawings();
    return;
  }
  if (STATE.drawingTool === "cursor") {
    // Toggle select
    STATE.selectedDrawingId = (STATE.selectedDrawingId === id) ? null : id;
    renderDrawings();
  }
}

// Start drag on a shape (cursor mode only). Returns true if drag was initiated.
function startShapeDrag(e, drawing) {
  if (STATE.drawingTool !== "cursor") return false;
  e.preventDefault();
  e.stopPropagation();
  STATE.selectedDrawingId = drawing.id;
  // Snapshot original points so we can undo on cancel
  const origPts = drawing.pts.map(p => ({ time: p.time, price: p.price }));
  STATE._dragInfo = {
    drawingId: drawing.id,
    startClientX: e.clientX,
    startClientY: e.clientY,
    origPts,
    moved: false
  };
  const onMove = (ev) => {
    if (!STATE._dragInfo) return;
    const dx = ev.clientX - STATE._dragInfo.startClientX;
    const dy = ev.clientY - STATE._dragInfo.startClientY;
    if (Math.abs(dx) + Math.abs(dy) < 2) return;  // ignore tiny drift
    STATE._dragInfo.moved = true;
    // Compute world deltas from first point
    const ref = STATE._dragInfo.origPts[0];
    const delta = pixelDeltaToWorld(dx, dy, ref);
    if (!delta) return;
    // For horizontal lines: only Y movement (price), keep time
    const isHLine = drawing.type === "hline";
    drawing.pts.forEach((p, i) => {
      const origP = STATE._dragInfo.origPts[i];
      p.price = origP.price + delta.priceDelta;
      if (!isHLine) p.time = origP.time + delta.timeDelta;
    });
    renderDrawings();
  };
  const onUp = () => {
    if (STATE._dragInfo && STATE._dragInfo.moved) {
      saveDrawings();
    }
    STATE._dragInfo = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  return true;
}

// Patch renderDrawings to wire drag handlers and selected style
const _origRenderDrawings = renderDrawings;
renderDrawings = function() {
  _origRenderDrawings();
  if (!STATE.drawingSvg) return;
  STATE.drawingSvg.querySelectorAll(".drawing-shape").forEach(el => {
    const id = +el.dataset.id;
    if (!id || id < 0) return;
    const drawing = STATE.drawings.find(d => d.id === id);
    if (!drawing) return;
    // type class for cursor hint
    el.classList.add("shape-" + drawing.type);
    if (id === STATE.selectedDrawingId) el.classList.add("shape-selected");
    // Override onclick so it does NOT fire after a drag
    el.onclick = (ev) => {
      // If drag moved, suppress click
      if (STATE._dragInfo && STATE._dragInfo.moved) return;
      onShapeClick(id);
    };
    // mousedown initiates drag (cursor mode)
    el.addEventListener("mousedown", (ev) => {
      if (STATE.drawingTool !== "cursor") return;
      if (ev.button !== 0) return;
      startShapeDrag(ev, drawing);
    });
  });
};

// Override setDrawingTool to default-show shapes interactive in cursor mode
const _origSetDrawingTool = setDrawingTool;
setDrawingTool = function(tool) {
  // Clear selection when switching tools (except staying in cursor)
  if (tool !== "cursor") STATE.selectedDrawingId = null;
  _origSetDrawingTool(tool);
};

// In cursor mode the layer should allow events on shapes only.
// Currently the layer toggles "active" — we want shapes to be interactable even when layer is inactive.
// Achieve via CSS: shapes always have pointer-events: all; layer is none unless drawing tool active.
(function() {
  const style = document.createElement("style");
  style.textContent = `
    .drawing-layer { pointer-events: none; }
    .drawing-layer.active { pointer-events: all; }
    .drawing-layer .drawing-shape { pointer-events: all; }
    .drawing-layer.active .drawing-shape { pointer-events: none; }
    .drawing-layer.eraser-mode .drawing-shape { pointer-events: all; cursor: pointer !important; }
  `;
  document.head.appendChild(style);
})();

// Copy / paste shortcuts
document.addEventListener("keydown", (e) => {
  // Only handle when not focused on an input/select
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  // Copy
  if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
    if (STATE.selectedDrawingId == null) return;
    const d = STATE.drawings.find(x => x.id === STATE.selectedDrawingId);
    if (d) {
      STATE.drawingClipboard = JSON.parse(JSON.stringify(d));
      delete STATE.drawingClipboard.id;
      // brief flash to confirm
      flashSelected();
    }
  }
  // Paste
  if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) {
    if (!STATE.drawingClipboard) return;
    e.preventDefault();
    const copy = JSON.parse(JSON.stringify(STATE.drawingClipboard));
    copy.id = STATE.drawingNextId++;
    // Offset slightly (about 5 bars in time, small in price)
    if (STATE.mainPane && STATE.bars.length) {
      const visibleBars = getVisibleBars();
      const timeStep = visibleBars.length > 1
        ? (visibleBars[visibleBars.length-1].time - visibleBars[0].time) / Math.max(1, visibleBars.length - 1)
        : 60;
      const offsetTime = timeStep * 5;
      const offsetPrice = STATE.mainPane.series.candle ? 0 : 0;
      copy.pts.forEach(p => {
        p.time += offsetTime;
        // small price offset proportional to distance between points
        if (copy.pts.length >= 2) {
          // skip price offset for simplicity (user can drag after)
        }
      });
    }
    STATE.drawings.push(copy);
    STATE.selectedDrawingId = copy.id;
    saveDrawings();
    renderDrawings();
  }
  // Delete selected
  if ((e.key === "Delete" || e.key === "Backspace") && STATE.selectedDrawingId != null) {
    const id = STATE.selectedDrawingId;
    STATE.drawings = STATE.drawings.filter(d => d.id !== id);
    STATE.selectedDrawingId = null;
    saveDrawings();
    renderDrawings();
  }
});

function flashSelected() {
  const el = STATE.drawingSvg.querySelector(".shape-selected");
  if (!el) return;
  const orig = el.style.filter;
  el.style.filter = "drop-shadow(0 0 12px #22c55e)";
  setTimeout(() => { el.style.filter = orig; }, 250);
}

// ============================================================
// PREFERENCES — trade notes + behavior alerts (with toggles)
// ============================================================
const PREFS_LS_KEY = "practice_trading_prefs";

STATE.prefs = (() => {
  const defaults = {
    noteOnEntry: false, noteOnExit: false,
    alertNoSL: false,
    alertOvertrading: false, overtradingPerHour: 10,
    alertLossStreak: false, lossStreakN: 3,
    alertRisk: false, riskPct: 5,
    alertLeverage: false, leverageMult: 10
  };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_LS_KEY) || "{}");
    return Object.assign({}, defaults, saved);
  } catch(e) { return defaults; }
})();
STATE._tempEntryNote = null;
STATE._tempExitNote = null;
STATE._pendingTriggerNote = null;

function savePrefs() {
  try { localStorage.setItem(PREFS_LS_KEY, JSON.stringify(STATE.prefs)); } catch(e) {}
}

const PREF_FIELD_MAP = {
  prefNoteEntry: "noteOnEntry",
  prefNoteExit: "noteOnExit",
  prefAlertNoSL: "alertNoSL",
  prefAlertOvertrading: "alertOvertrading",
  prefOvertradingN: "overtradingPerHour",
  prefAlertLossStreak: "alertLossStreak",
  prefLossStreakN: "lossStreakN",
  prefAlertRisk: "alertRisk",
  prefRiskPct: "riskPct",
  prefAlertLeverage: "alertLeverage",
  prefLeverageMult: "leverageMult"
};

function applyPrefsToUI() {
  for (const [id, key] of Object.entries(PREF_FIELD_MAP)) {
    const el = $(id);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!STATE.prefs[key];
    else el.value = STATE.prefs[key];
  }
}
function bindPrefsHandlers() {
  for (const [id, key] of Object.entries(PREF_FIELD_MAP)) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener("change", () => {
      STATE.prefs[key] = el.type === "checkbox" ? el.checked : +el.value;
      savePrefs();
    });
    if (el.type !== "checkbox") {
      el.addEventListener("input", () => {
        STATE.prefs[key] = +el.value;
        savePrefs();
      });
    }
  }
}
applyPrefsToUI();
bindPrefsHandlers();

// ============================================================
// Note modal — multi-line input with Ctrl+Enter to save, Esc to skip
// ============================================================
function openNoteModal(title, placeholder, defaultText, onResult) {
  const overlay = document.createElement("div");
  overlay.className = "note-modal-overlay";
  overlay.innerHTML = `
    <div class="note-modal-box">
      <h2>${title}</h2>
      <textarea style="height:120px" placeholder="${placeholder.replace(/"/g,'&quot;')}">${(defaultText || "").replace(/</g,"&lt;")}</textarea>
      <div class="note-modal-help">Ctrl+Enter 儲存 · Esc 略過</div>
      <div class="note-modal-actions">
        <button class="btn btn-flat" data-act="skip">略過</button>
        <button class="btn btn-step" data-act="save">儲存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = overlay.querySelector("textarea");
  setTimeout(() => ta.focus(), 0);
  const close = (result) => {
    document.body.removeChild(overlay);
    onResult(result);
  };
  overlay.querySelector("[data-act=skip]").onclick = () => close(null);
  overlay.querySelector("[data-act=save]").onclick = () => close(ta.value.trim() || null);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); close(ta.value.trim() || null); }
    else if (e.key === "Escape") { close(null); }
  });
}

// ============================================================
// Behavior alerts — returns array of warning strings (empty = clean)
// ============================================================
function checkBehaviorAlerts() {
  const warnings = [];
  if (!STATE.bars[STATE.cursor]) return warnings;
  const cfg = readSLTPConfig();
  const size = +$("orderSize").value;
  const mult = getMult();
  const curBar = STATE.bars[STATE.cursor];
  const curPrice = curBar.close;

  // 1. No SL
  if (STATE.prefs.alertNoSL && (cfg.slMode === "none" || !cfg.slValue)) {
    warnings.push(`沒有設停損 — 沒有出口計畫的交易容易爆倉`);
  }

  // 2. Overtrading
  if (STATE.prefs.alertOvertrading && STATE.trades.length > 0) {
    const hourAgo = curBar.time - 3600;  // unix seconds
    const recent = STATE.trades.filter(t => {
      const eb = STATE.bars[t.exitIdx];
      return eb && eb.time >= hourAgo;
    });
    if (recent.length >= STATE.prefs.overtradingPerHour) {
      warnings.push(`過度交易 — 過去 1 小時已成 ${recent.length} 筆（門檻 ${STATE.prefs.overtradingPerHour}），可能在追盤`);
    }
  }

  // 3. Loss streak
  if (STATE.prefs.alertLossStreak && STATE.trades.length > 0) {
    let streak = 0;
    for (let i = STATE.trades.length - 1; i >= 0; i--) {
      if (STATE.trades[i].pnl <= 0) streak++;
      else break;
    }
    if (streak >= STATE.prefs.lossStreakN) {
      warnings.push(`連敗冷靜 — 剛經歷 ${streak} 筆連續虧損（門檻 ${STATE.prefs.lossStreakN}），建議檢視訊號是否仍有效，避免報復性交易`);
    }
  }

  // 4. Single-trade risk too high
  if (STATE.prefs.alertRisk) {
    let estRisk = 0;
    if (cfg.slMode === "dist" && cfg.slValue > 0) {
      estRisk = cfg.slValue * size * mult;
    } else if (cfg.slMode === "trail" && cfg.slValue > 0) {
      estRisk = cfg.slValue * size * mult;
    } else if (cfg.slMode === "abs" && cfg.slValue > 0) {
      estRisk = Math.abs(curPrice - cfg.slValue) * size * mult;
    }
    if (estRisk > 0) {
      const pct = estRisk / STATE.equity * 100;
      if (pct > STATE.prefs.riskPct) {
        warnings.push(`單筆風險過大 — 可能損失 $${estRisk.toFixed(0)}，是帳戶的 ${pct.toFixed(1)}%（門檻 ${STATE.prefs.riskPct}%）`);
      }
    }
  }

  // 5. High notional leverage
  if (STATE.prefs.alertLeverage) {
    const notional = curPrice * size * mult;
    const ratio = notional / STATE.equity;
    if (ratio > STATE.prefs.leverageMult) {
      warnings.push(`名目槓桿過高 — 倉位名目 $${notional.toFixed(0)} 是帳戶權益的 ${ratio.toFixed(1)}×（門檻 ${STATE.prefs.leverageMult}×）`);
    }
  }

  return warnings;
}

function showBehaviorAlertModal(warnings, onConfirm) {
  const overlay = document.createElement("div");
  overlay.className = "note-modal-overlay";
  overlay.innerHTML = `
    <div class="alert-modal-box">
      <h2>⚠️ 行為警示 Behavior Alert</h2>
      <ul class="alert-modal-list">${warnings.map(w => `<li>${w}</li>`).join("")}</ul>
      <div class="hint-small" style="color:#8da0c0">這些不是禁止訊號 — 是提醒您是否確實有計畫。如果是策略允許的情境，按「仍要送出」即可。</div>
      <div class="note-modal-actions">
        <button class="btn btn-flat" data-act="cancel">取消下單</button>
        <button class="btn btn-step" data-act="proceed">仍要送出</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("[data-act=cancel]").onclick = () => { document.body.removeChild(overlay); onConfirm(false); };
  overlay.querySelector("[data-act=proceed]").onclick = () => { document.body.removeChild(overlay); onConfirm(true); };
}

// ============================================================
// Hook placeOrder — alert first, then optional entry note, then go
// ============================================================
const _placeOrderBeforeNotes = placeOrder;
placeOrder = function(side) {
  const warnings = checkBehaviorAlerts();
  const proceedWithEntry = () => {
    if (STATE.prefs.noteOnEntry) {
      openNoteModal(
        "為什麼下這單？",
        "例如：突破 BB 上軌、RSI 從超賣反彈、KDJ 黃金交叉、跌到關鍵支撐...",
        "",
        (note) => {
          STATE._tempEntryNote = note;
          executeOrder();
        }
      );
    } else {
      executeOrder();
    }
  };
  const executeOrder = () => {
    const beforePending = STATE.pendingOrders.length;
    _placeOrderBeforeNotes(side);
    const note = STATE._tempEntryNote;
    STATE._tempEntryNote = null;
    if (note) {
      if (STATE.position && !STATE.position.entryNote) {
        STATE.position.entryNote = note;
      }
      for (let i = beforePending; i < STATE.pendingOrders.length; i++) {
        STATE.pendingOrders[i].entryNote = note;
      }
      refresh();
    }
  };
  if (warnings.length) {
    showBehaviorAlertModal(warnings, (ok) => { if (ok) proceedWithEntry(); });
  } else {
    proceedWithEntry();
  }
};

// ============================================================
// Hook closePosition — optional exit note (manual close only)
// ============================================================
const _closePositionBeforeNotes = closePosition;
closePosition = function(reason = "manual") {
  if (!STATE.position) return;
  if (STATE.prefs.noteOnExit && reason === "manual") {
    openNoteModal(
      "這筆交易學到什麼？",
      "例如：執行紀律好、太早平倉、跟到趨勢、追高被洗、SL 太緊...",
      "",
      (note) => {
        STATE._tempExitNote = note;
        _closePositionBeforeNotes(reason);
      }
    );
  } else {
    _closePositionBeforeNotes(reason);
  }
};

// ============================================================
// Hook recordTrade — carry entryNote from position, capture exitNote
// ============================================================
const _recordTradeBeforeNotes = recordTrade;
recordTrade = function(p, exitIdx, exitPrice, pnl, reason, bar) {
  _recordTradeBeforeNotes(p, exitIdx, exitPrice, pnl, reason, bar);
  const t = STATE.trades[STATE.trades.length - 1];
  if (!t) return;
  if (p.entryNote) t.entryNote = p.entryNote;
  if (STATE._tempExitNote) {
    t.exitNote = STATE._tempExitNote;
    STATE._tempExitNote = null;
  }
};

// ============================================================
// Hook checkPendingOrders — copy entryNote from triggered order to position
// ============================================================
const _checkPendingBeforeNotes = checkPendingOrders;
checkPendingOrders = function() {
  // Before running: find which (if any) order would trigger and remember its note
  let triggeredNote = null;
  const bar = STATE.bars[STATE.cursor];
  if (bar) {
    for (const o of STATE.pendingOrders) {
      if (o.placedAt > STATE.cursor) continue;
      let hit = false;
      if (o.type === "limit" && o.side === "long")  hit = bar.low  <= o.triggerPrice;
      if (o.type === "limit" && o.side === "short") hit = bar.high >= o.triggerPrice;
      if (o.type === "stop"  && o.side === "long")  hit = bar.high >= o.triggerPrice;
      if (o.type === "stop"  && o.side === "short") hit = bar.low  <= o.triggerPrice;
      if (hit) {
        if (o.entryNote) triggeredNote = o.entryNote;
        break;  // first hit wins (matches original logic)
      }
    }
  }
  const hadPosition = !!STATE.position;
  _checkPendingBeforeNotes();
  if (!hadPosition && STATE.position && triggeredNote && !STATE.position.entryNote) {
    STATE.position.entryNote = triggeredNote;
  }
};

// ============================================================
// Trade list — show 📝 indicator and make rows clickable to edit notes
// ============================================================
const _updateStatsBeforeNotes = updateStats;
updateStats = function() {
  _updateStatsBeforeNotes();
  const tbody = document.querySelector("#tradeTable tbody");
  if (!tbody) return;
  const rows = tbody.querySelectorAll("tr");
  // Rows are in reverse order (latest first)
  rows.forEach((tr, j) => {
    const idx = STATE.trades.length - 1 - j;
    const trade = STATE.trades[idx];
    if (!trade) return;
    tr.style.cursor = "pointer";
    // Avoid attaching multiple listeners — clone-and-replace is overkill; just reassign
    tr.onclick = (ev) => {
      ev.stopPropagation();
      openTradeNotesEditor(idx);
    };
    // Add 📝 to reason column if any note exists
    if ((trade.entryNote || trade.exitNote) && tr.cells[4] && !tr.cells[4].querySelector(".note-icon")) {
      const span = document.createElement("span");
      span.className = "note-icon";
      span.textContent = " 📝";
      span.title = "有筆記 — 點此列檢視";
      tr.cells[4].appendChild(span);
    }
  });
};

function openTradeNotesEditor(tradeIdx) {
  const trade = STATE.trades[tradeIdx];
  if (!trade) return;
  const overlay = document.createElement("div");
  overlay.className = "note-modal-overlay";
  const sign = trade.pnl >= 0 ? "+" : "";
  overlay.innerHTML = `
    <div class="note-modal-box" style="min-width:500px">
      <h2>交易 #${tradeIdx + 1} 筆記</h2>
      <div class="hint-small" style="margin-bottom:8px;color:#8da0c0">
        ${trade.side.toUpperCase()} · 進 ${trade.entryPrice.toFixed(3)} → 出 ${trade.exitPrice.toFixed(3)} · ${trade.reason}
        · P&L <span style="color:${trade.pnl>=0?'#22c55e':'#ef4444'}">${sign}${trade.pnl.toFixed(2)}</span>
      </div>
      <label class="hint-small" style="display:block;margin-top:6px;color:#8da0c0">開倉理由 / 進場時的想法</label>
      <textarea id="editEntryNote" style="height:80px;margin-bottom:8px">${(trade.entryNote || "").replace(/</g,"&lt;")}</textarea>
      <label class="hint-small" style="display:block;margin-top:4px;color:#8da0c0">平倉檢討 / 學到的東西</label>
      <textarea id="editExitNote" style="height:80px">${(trade.exitNote || "").replace(/</g,"&lt;")}</textarea>
      <div class="note-modal-actions">
        <button class="btn btn-flat" data-act="cancel">關閉</button>
        <button class="btn btn-step" data-act="save">儲存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("[data-act=cancel]").onclick = () => document.body.removeChild(overlay);
  overlay.querySelector("[data-act=save]").onclick = () => {
    const e = overlay.querySelector("#editEntryNote").value.trim();
    const x = overlay.querySelector("#editExitNote").value.trim();
    trade.entryNote = e || undefined;
    trade.exitNote = x || undefined;
    document.body.removeChild(overlay);
    updateStats();
  };
}

// ============================================================
// v2 UI — pill toggles, tab bar, settings popover, themes, i18n
// ============================================================
const V2_LS_KEY = "practice_trading_v2_ui";

STATE.v2 = (() => {
  const defaults = { theme: "ocean", candle: "green-up", lang: "zh-TW" };
  try {
    const saved = JSON.parse(localStorage.getItem(V2_LS_KEY) || "{}");
    return Object.assign({}, defaults, saved);
  } catch(e) { return defaults; }
})();
function saveV2Settings() {
  try { localStorage.setItem(V2_LS_KEY, JSON.stringify(STATE.v2)); } catch(e) {}
}

// ---------- i18n ----------
const I18N = {
  "zh-TW": {
    "header.analytics": "→ 分析頁",
    "tabs.trade": "下單",
    "tabs.indicators": "指標",
    "tabs.prefs": "偏好",
    "tabs.stats": "績效",
    "settings.theme": "主題色",
    "settings.theme.ocean": "海藍",
    "settings.theme.emerald": "青綠",
    "settings.theme.violet": "紫羅蘭",
    "settings.candle": "K 線漲跌色",
    "settings.candle.green": "漲綠跌紅",
    "settings.candle.red": "漲紅跌綠",
    "settings.lang": "語言 Language",
    "settings.done": "完成"
  },
  "en-US": {
    "header.analytics": "→ Analytics",
    "tabs.trade": "Trade",
    "tabs.indicators": "Indicators",
    "tabs.prefs": "Prefs",
    "tabs.stats": "Stats",
    "settings.theme": "Accent color",
    "settings.theme.ocean": "Ocean",
    "settings.theme.emerald": "Emerald",
    "settings.theme.violet": "Violet",
    "settings.candle": "Candle colors",
    "settings.candle.green": "Green up / Red down",
    "settings.candle.red": "Red up / Green down",
    "settings.lang": "Language 語言",
    "settings.done": "Done"
  }
};
function t(key) {
  return (I18N[STATE.v2.lang] && I18N[STATE.v2.lang][key]) || I18N["zh-TW"][key] || key;
}
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.dataset.i18n;
    if (I18N[STATE.v2.lang] && I18N[STATE.v2.lang][key] !== undefined) {
      el.textContent = I18N[STATE.v2.lang][key];
    }
  });
  document.documentElement.lang = STATE.v2.lang === "en-US" ? "en" : "zh-TW";
}

// ---------- Theme application ----------
function applyTheme() {
  document.body.dataset.theme = STATE.v2.theme;
  document.body.dataset.candle = STATE.v2.candle;
  applyCandleColors();
}
function applyCandleColors() {
  // Update candle series with new colors so chart matches setting
  if (!STATE.mainPane || !STATE.mainPane.series.candle) return;
  const up = STATE.v2.candle === "green-up" ? "#22c55e" : "#ef4444";
  const dn = STATE.v2.candle === "green-up" ? "#ef4444" : "#22c55e";
  STATE.mainPane.series.candle.applyOptions({
    upColor: up, downColor: dn,
    borderUpColor: up, borderDownColor: dn,
    wickUpColor: up, wickDownColor: dn
  });
}

// Apply on load
applyTheme();
applyI18n();

// ---------- Settings popover ----------
const settingsBtn = $("settingsBtn");
const settingsPopover = $("settingsPopover");
let settingsOpen = false;
function toggleSettings(show) {
  settingsOpen = show !== undefined ? show : !settingsOpen;
  settingsPopover.style.display = settingsOpen ? "block" : "none";
  if (settingsOpen) {
    // Sync UI to current values
    syncPillGroup("settingsTheme", STATE.v2.theme);
    syncPillGroup("settingsCandle", STATE.v2.candle);
    syncPillGroup("settingsLang", STATE.v2.lang);
  }
}
function syncPillGroup(groupId, value) {
  const g = $(groupId);
  if (!g) return;
  g.querySelectorAll(".pill").forEach(p => {
    p.classList.toggle("active", p.dataset.value === value);
  });
}
if (settingsBtn) settingsBtn.onclick = (e) => { e.stopPropagation(); toggleSettings(); };
document.addEventListener("click", (e) => {
  if (!settingsOpen) return;
  if (settingsPopover.contains(e.target) || e.target === settingsBtn) return;
  toggleSettings(false);
});
$("settingsDone").onclick = () => toggleSettings(false);

// Bind theme pills
$("settingsTheme").querySelectorAll(".pill").forEach(p => {
  p.onclick = () => {
    STATE.v2.theme = p.dataset.value;
    saveV2Settings();
    applyTheme();
    syncPillGroup("settingsTheme", STATE.v2.theme);
  };
});
$("settingsCandle").querySelectorAll(".pill").forEach(p => {
  p.onclick = () => {
    STATE.v2.candle = p.dataset.value;
    saveV2Settings();
    applyTheme();
    syncPillGroup("settingsCandle", STATE.v2.candle);
  };
});
$("settingsLang").querySelectorAll(".pill").forEach(p => {
  p.onclick = () => {
    STATE.v2.lang = p.dataset.value;
    saveV2Settings();
    applyI18n();
    syncPillGroup("settingsLang", STATE.v2.lang);
  };
});

// ---------- Pill groups that sync a hidden <select> (e.g. slMode/tpMode) ----------
document.querySelectorAll(".pill-group[data-syncs-select]").forEach(group => {
  const selectId = group.dataset.syncsSelect;
  const select = document.getElementById(selectId);
  if (!select) return;
  // Initial sync: pill active state → select value
  const initialActive = group.querySelector(".pill.active");
  if (initialActive) {
    select.value = initialActive.dataset.value;
    select.dispatchEvent(new Event("change"));
  }
  group.querySelectorAll(".pill").forEach(pill => {
    pill.onclick = (e) => {
      e.preventDefault();
      group.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      select.value = pill.dataset.value;
      select.dispatchEvent(new Event("change"));
    };
  });
});

// ---------- Tab bar: scroll sidebar to corresponding panel ----------
const TAB_TARGETS = {
  // Map tab name → which panel index in the sidebar scroll container to scroll to
  trade: 1,       // 帳戶 (0) + 下單 (1) — scroll to top
  indicators: 2,  // 主圖指標 panel
  prefs: 4,       // 練習偏好
  stats: 5        // 績效指標
};
function activateTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
  const scroll = $("sidebarScroll");
  if (!scroll) return;
  const panels = scroll.querySelectorAll(".panel");
  let targetIdx;
  if (tabName === "trade") targetIdx = 0;
  else if (tabName === "indicators") targetIdx = 2;
  else if (tabName === "prefs") {
    // find prefs panel by its h2 content
    targetIdx = Array.from(panels).findIndex(p => p.querySelector("h2") && /練習偏好|Preferences/.test(p.querySelector("h2").textContent));
    if (targetIdx < 0) targetIdx = 4;
  } else if (tabName === "stats") {
    targetIdx = Array.from(panels).findIndex(p => p.querySelector("h2") && /績效|Performance/.test(p.querySelector("h2").textContent));
    if (targetIdx < 0) targetIdx = 5;
  }
  const target = panels[targetIdx];
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
}
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.onclick = () => activateTab(btn.dataset.tab);
});

// ---------- Indicator count badge ----------
function updateIndicatorBadge() {
  const badge = $("indicatorCountBadge");
  if (!badge) return;
  // Count = 1 (main pane price) + subpane panes + overlays + visible MAs
  const subpanes = STATE.panes ? Math.max(0, STATE.panes.length - 1) : 0;
  const overlays = STATE.overlays ? STATE.overlays.length : 0;
  const mas = STATE.maList ? STATE.maList.filter(m => m.enabled).length : 0;
  const total = 1 + subpanes + overlays + mas;
  badge.textContent = total;
}
// Update badge whenever refresh runs (lightweight; refresh already throttled)
const _origRefreshBadge = refresh;
refresh = function() {
  _origRefreshBadge();
  updateIndicatorBadge();
};

// After charts initialize, apply candle colors
const _origInitChartsV2 = initCharts;
initCharts = function() {
  _origInitChartsV2();
  applyCandleColors();
};

// ============================================================
// v2 — Top pill tabs: show/hide tab content instead of scroll
// ============================================================
(function setupMainTabPills() {
  const pills = document.querySelectorAll(".tab-pills .pill[data-main-tab]");
  if (!pills.length) return;
  function activate(name) {
    pills.forEach(p => p.classList.toggle("active", p.dataset.mainTab === name));
    document.querySelectorAll(".tab-content[data-main-tab]").forEach(c => {
      c.classList.toggle("active", c.dataset.mainTab === name);
    });
    // Scroll inside container back to top when switching
    const cnt = document.querySelector(".tab-content-container");
    if (cnt) cnt.scrollTop = 0;
  }
  pills.forEach(p => p.onclick = () => activate(p.dataset.mainTab));
})();

// ============================================================
// v2 — Indicator badge fix + SL/TP hide on "none" + i18n expansion
// ============================================================

// (1) Indicator count badge — count only subpanes + overlays (not main + MAs)
// MAs are managed inside the indicator panel so listing them again on the tab
// pill is double-counting. Reset to a more meaningful number.
(function fixIndicatorBadge() {
  // Re-implement updateIndicatorBadge via a global ref
  window._updateIndicatorBadgeReal = function() {
    const badge = $("indicatorCountBadge");
    if (!badge) return;
    const subpanes = STATE.panes ? Math.max(0, STATE.panes.length - 1) : 0;
    const overlays = STATE.overlays ? STATE.overlays.length : 0;
    const total = subpanes + overlays;
    badge.textContent = total;
    badge.style.display = total > 0 ? "" : "none";
  };
  // Replace the previously bound updateIndicatorBadge function
  if (typeof updateIndicatorBadge !== "undefined") {
    updateIndicatorBadge = window._updateIndicatorBadgeReal;
  }
})();

// (2) Hide SL/TP value input when mode = "none" — makes selection obvious
function updateSLTPValueVisibility() {
  const slMode = $("slMode").value;
  const tpMode = $("tpMode").value;
  // SL: hide the grid wrapper of slValue when mode is none
  const slInput = $("slValue");
  if (slInput) {
    const wrapper = slInput.parentElement;  // the grid-template wrapper
    if (wrapper) wrapper.style.display = slMode === "none" ? "none" : "";
  }
  // TP: same
  const tpInput = $("tpValue");
  if (tpInput) {
    const wrapper = tpInput.parentElement;
    if (wrapper) wrapper.style.display = tpMode === "none" ? "none" : "";
  }
}
$("slMode").addEventListener("change", updateSLTPValueVisibility);
$("tpMode").addEventListener("change", updateSLTPValueVisibility);
// Initial state
updateSLTPValueVisibility();

// (3) Extended applyI18n — support data-i18n-ph (placeholder), data-i18n-title (title)
// We also append a much larger dictionary covering sidebar labels + buttons.
const I18N_EXT = {
  "zh-TW": {
    // Header
    "header.title": "練習交易終端", "header.csv": "匯入 CSV", "header.tradesCsv": "匯入交易紀錄",
    "header.analytics": "→ 分析頁", "header.dsInfo": "尚未載入資料",
    "ctrl.prev": "上一根 (←)", "ctrl.next": "下一根 ▶", "ctrl.play": "▶ 播放", "ctrl.pause": "⏸ 暫停",
    "ctrl.jumpStart": "跳到資料開頭", "ctrl.jumpEnd": "跳到資料結尾", "ctrl.jumpTo": "跳到",
    "speed.slow": "慢 (0.8s)", "speed.med": "中 (0.4s)", "speed.fast": "快 (0.15s)", "speed.veryFast": "極快",
    // Tabs
    "tabs.trade": "下單", "tabs.indicators": "指標", "tabs.prefs": "偏好", "tabs.stats": "績效",
    // Account
    "panel.account": "帳戶設定", "label.initBalance": "初始餘額 ($)",
    "lock.unlocked": "🔓 可改", "lock.locked": "🔒 已鎖",
    "hint.lockBeforeTrade": "模擬開始（首筆交易）後將鎖定",
    "hint.lockAfterTrade": "模擬已開始，餘額由交易結果決定（重置帳戶可解鎖）",
    // Trade panel
    "panel.trade": "下單模擬",
    "label.askPrice": "買價 Ask", "label.bidPrice": "賣價 Bid", "label.spreadShort": "點差",
    "label.size": "口數", "label.leverage": "槓桿",
    "label.spread": "點差 ($)", "label.contractMult": "合約乘數",
    "label.sl": "停損 (SL)", "label.tp": "停利 (TP)",
    "label.orderType": "進場類型", "label.triggerPrice": "觸發價",
    "label.ocoSecond": "OCO 第二觸發價 (對向)",
    "hint.oco": "OCO 會同時掛兩張對向單，任一觸發後另一張自動取消",
    "pill.none": "不設", "pill.dist": "距離", "pill.abs": "絕對價", "pill.trail": "移動",
    "ph.priceOrDist": "價格或距離", "ph.price": "價格", "ph.floor": "底線", "ph.triggerPrice2": "另一邊的觸發價",
    "order.market": "市價 Market", "order.limit": "限價 Limit",
    "order.stop": "停損觸發 Stop", "order.oco": "OCO 對沖",
    "btn.long": "買進 / Long", "btn.short": "放空 / Short", "btn.flat": "平倉",
    "label.slFloorEnable": "設止損底線（移動止損的最後保險）",
    "panel.pending": "待掛單 Pending",
    // Indicators tab
    "panel.mainIndicators": "主圖指標 (Price + BB + MA)",
    "indicators.ma": "均線", "indicators.bb": "布林",
    "indicators.maList": "均線 Moving Averages", "indicators.add": "+ 新增均線",
    "indicators.bb_full": "布林通道 (BB)", "indicators.period": "週期", "indicators.stddev": "標準差",
    "indicators.overlays": "主圖疊加指標",
    "hint.overlays": "疊加在 K 線上的指標（Donchian / Keltner / VWAP / SAR / Ichimoku 等）",
    "indicators.addOverlay": "+ 新增疊加",
    "indicators.subpanes": "副圖指標面板",
    "hint.subpanes": "下方主圖以外的指標面板可新增/刪除，並用面板之間的橫桿拖曳調整高度。",
    "indicators.addPane": "+ 新增指標面板",
    "btn.applyParams": "套用參數",
    "panel.custom": "自訂指標 Custom Indicators",
    "hint.custom": "用公式定義你自己的指標，存在瀏覽器，可匯出 JSON 備份或分享。",
    "custom.add": "+ 新增自訂", "custom.export": "匯出 JSON", "custom.import": "匯入 JSON",
    // Preferences
    "panel.prefs": "練習偏好 Preferences",
    "prefs.notes": "📝 交易筆記",
    "prefs.notesEntry": "開倉前提示「為什麼？」",
    "prefs.notesExit": "手動平倉時提示「學到什麼？」",
    "hint.notes": "交易紀錄中有筆記的列會顯示 📝，點任一列可編輯",
    "prefs.alerts": "⚠️ 行為警示",
    "prefs.alertNoSL": "未設停損就下單",
    "prefs.alertOvertrading": "過度交易（過去 1 小時已成",
    "prefs.alertOvertradingSuf": "筆以上）",
    "prefs.alertLossStreak": "連敗冷靜（連續",
    "prefs.alertLossStreakSuf": "筆虧損後）",
    "prefs.alertRiskPre": "單筆風險 >",
    "prefs.alertRiskSuf": "% 帳戶",
    "prefs.alertLeveragePre": "名目槓桿 >",
    "prefs.alertLeverageSuf": "×",
    "hint.alerts": "觸發時會彈出警示視窗，使用者需確認才送單",
    // Stats
    "panel.stats": "績效指標",
    "stats.totalTrades": "總交易數", "stats.winRate": "勝率",
    "stats.totalPnL": "總損益", "stats.equity": "當前權益", "stats.return": "總報酬率",
    "stats.pf": "獲利因子", "stats.avgWinLoss": "平均盈/虧", "stats.rr": "盈虧比 RR",
    "stats.sharpe": "夏普比率", "stats.maxDD": "最大回撤", "stats.exp": "期望值/筆",
    "btn.reset": "重置帳戶", "btn.export": "匯出 CSV",
    "panel.tradeLog": "交易紀錄",
    "log.idx": "#", "log.side": "方向", "log.entry": "進場",
    "log.exit": "出場", "log.reason": "原因", "log.pnl": "P&L",
    // Empty
    "empty.title": "請匯入 CSV 開始練習",
    "empty.format": "支援格式：",
    "empty.hint": "提示：可同時匯入過去匯出的交易紀錄 CSV，接續上次練習進度",
    // Settings (kept)
    "settings.theme": "主題色", "settings.theme.ocean": "海藍",
    "settings.theme.emerald": "青綠", "settings.theme.violet": "紫羅蘭",
    "settings.candle": "K 線漲跌色", "settings.candle.green": "漲綠跌紅",
    "settings.candle.red": "漲紅跌綠", "settings.lang": "語言 Language",
    "settings.done": "完成"
  },
  "en-US": {
    "header.title": "Practice Terminal", "header.csv": "Import CSV", "header.tradesCsv": "Import Trades",
    "header.analytics": "→ Analytics", "header.dsInfo": "No data loaded",
    "ctrl.prev": "Previous (←)", "ctrl.next": "Next ▶", "ctrl.play": "▶ Play", "ctrl.pause": "⏸ Pause",
    "ctrl.jumpStart": "Jump to start", "ctrl.jumpEnd": "Jump to end", "ctrl.jumpTo": "Jump",
    "speed.slow": "Slow (0.8s)", "speed.med": "Med (0.4s)", "speed.fast": "Fast (0.15s)", "speed.veryFast": "Ultra",
    "tabs.trade": "Trade", "tabs.indicators": "Indicators", "tabs.prefs": "Prefs", "tabs.stats": "Stats",
    "panel.account": "Account", "label.initBalance": "Initial balance ($)",
    "lock.unlocked": "🔓 Editable", "lock.locked": "🔒 Locked",
    "hint.lockBeforeTrade": "Locks when first trade is placed",
    "hint.lockAfterTrade": "Simulation started; balance changes only via P&L (reset to unlock)",
    "panel.trade": "Order Entry",
    "label.askPrice": "Ask", "label.bidPrice": "Bid", "label.spreadShort": "Spread",
    "label.size": "Size", "label.leverage": "Leverage",
    "label.spread": "Spread ($)", "label.contractMult": "Multiplier",
    "label.sl": "Stop Loss (SL)", "label.tp": "Take Profit (TP)",
    "label.orderType": "Order type", "label.triggerPrice": "Trigger price",
    "label.ocoSecond": "OCO 2nd trigger (opposite)",
    "hint.oco": "OCO places two opposing orders; first to fill cancels the other",
    "pill.none": "None", "pill.dist": "Distance", "pill.abs": "Absolute", "pill.trail": "Trailing",
    "ph.priceOrDist": "Price or distance", "ph.price": "Price",
    "ph.floor": "Floor", "ph.triggerPrice2": "Other side trigger",
    "order.market": "Market", "order.limit": "Limit", "order.stop": "Stop", "order.oco": "OCO",
    "btn.long": "Buy / Long", "btn.short": "Sell / Short", "btn.flat": "Close",
    "label.slFloorEnable": "Set SL floor (last-resort safety net)",
    "panel.pending": "Pending Orders",
    "panel.mainIndicators": "Main Chart (Price + BB + MA)",
    "indicators.ma": "MA", "indicators.bb": "BB",
    "indicators.maList": "Moving Averages", "indicators.add": "+ Add MA",
    "indicators.bb_full": "Bollinger Bands (BB)", "indicators.period": "Period", "indicators.stddev": "Std Dev",
    "indicators.overlays": "Main Chart Overlays",
    "hint.overlays": "Indicators drawn on K-line (Donchian / Keltner / VWAP / SAR / Ichimoku etc.)",
    "indicators.addOverlay": "+ Add Overlay",
    "indicators.subpanes": "Subpane Indicators",
    "hint.subpanes": "Indicator panels below the main chart. Add/remove and drag the bar to resize.",
    "indicators.addPane": "+ Add Pane",
    "btn.applyParams": "Apply",
    "panel.custom": "Custom Indicators",
    "hint.custom": "Define your own with formulas. Saved in browser; export/import JSON.",
    "custom.add": "+ New", "custom.export": "Export JSON", "custom.import": "Import JSON",
    "panel.prefs": "Practice Preferences",
    "prefs.notes": "📝 Trade Notes",
    "prefs.notesEntry": "Prompt 'Why this trade?' before entry",
    "prefs.notesExit": "Prompt 'What did I learn?' on manual exit",
    "hint.notes": "Trades with notes show 📝; click a row to edit",
    "prefs.alerts": "⚠️ Behavior Alerts",
    "prefs.alertNoSL": "Order without Stop Loss",
    "prefs.alertOvertrading": "Overtrading (more than",
    "prefs.alertOvertradingSuf": "trades in last hour)",
    "prefs.alertLossStreak": "Losing streak (after",
    "prefs.alertLossStreakSuf": "losses)",
    "prefs.alertRiskPre": "Single-trade risk >",
    "prefs.alertRiskSuf": "% of equity",
    "prefs.alertLeveragePre": "Notional leverage >",
    "prefs.alertLeverageSuf": "×",
    "hint.alerts": "Triggered alerts show a confirmation modal before submission",
    "panel.stats": "Performance",
    "stats.totalTrades": "Total trades", "stats.winRate": "Win rate",
    "stats.totalPnL": "Total P&L", "stats.equity": "Current equity", "stats.return": "Total return",
    "stats.pf": "Profit factor", "stats.avgWinLoss": "Avg win/loss", "stats.rr": "RR ratio",
    "stats.sharpe": "Sharpe ratio", "stats.maxDD": "Max drawdown", "stats.exp": "Expectancy",
    "btn.reset": "Reset account", "btn.export": "Export CSV",
    "panel.tradeLog": "Trade Log",
    "log.idx": "#", "log.side": "Side", "log.entry": "Entry",
    "log.exit": "Exit", "log.reason": "Reason", "log.pnl": "P&L",
    "empty.title": "Import a CSV to start practicing",
    "empty.format": "Format:",
    "empty.hint": "Tip: You can also import previously exported trades CSV to resume",
    "settings.theme": "Accent color", "settings.theme.ocean": "Ocean",
    "settings.theme.emerald": "Emerald", "settings.theme.violet": "Violet",
    "settings.candle": "Candle colors", "settings.candle.green": "Green up / Red down",
    "settings.candle.red": "Red up / Green down", "settings.lang": "Language 語言",
    "settings.done": "Done"
  }
};

// Merge into existing I18N
Object.keys(I18N_EXT).forEach(lang => {
  I18N[lang] = Object.assign({}, I18N[lang] || {}, I18N_EXT[lang]);
});

// Extended applyI18n: also handle placeholder and title
applyI18n = function() {
  const dict = I18N[STATE.v2.lang] || I18N["zh-TW"];
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.dataset.i18n;
    if (dict[key] !== undefined) el.textContent = dict[key];
  });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => {
    const key = el.dataset.i18nPh;
    if (dict[key] !== undefined) el.placeholder = dict[key];
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    const key = el.dataset.i18nTitle;
    if (dict[key] !== undefined) el.title = dict[key];
  });
  document.documentElement.lang = STATE.v2.lang === "en-US" ? "en" : "zh-TW";
};
applyI18n();

// ============================================================
// SL / TP / Trail bestPrice — live price lines on main chart
// ============================================================
let _slLineRef = null;
let _tpLineRef = null;
let _trailBestLineRef = null;

function removeSLTPLines() {
  const series = STATE.mainPane && STATE.mainPane.series && STATE.mainPane.series.candle;
  if (!series) return;
  [_slLineRef, _tpLineRef, _trailBestLineRef].forEach(ref => {
    if (ref) { try { series.removePriceLine(ref); } catch(e) {} }
  });
  _slLineRef = _tpLineRef = _trailBestLineRef = null;
}

function updateSLTPLines() {
  removeSLTPLines();
  const p = STATE.position;
  if (!p) return;
  const series = STATE.mainPane && STATE.mainPane.series && STATE.mainPane.series.candle;
  if (!series) return;

  // SL: stored in Bid scale for long, Ask scale for short — display in chart (Bid) scale
  if (p.sl != null) {
    const dispSL = p.side === "long" ? p.sl : (p.sl - p.spread);
    _slLineRef = series.createPriceLine({
      price: dispSL,
      color: "#ef4444",
      lineWidth: 1,
      lineStyle: 2,     // dashed
      axisLabelVisible: true,
      title: p.trail ? "↺ SL" : "SL"
    });
  }
  // TP: same scale convention
  if (p.tp != null) {
    const dispTP = p.side === "long" ? p.tp : (p.tp - p.spread);
    _tpLineRef = series.createPriceLine({
      price: dispTP,
      color: "#22c55e",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "TP"
    });
  }
  // Trail bestPrice (subtle line showing how high/low trail has tracked)
  if (p.trail) {
    const dispBest = p.side === "long" ? p.trail.bestPrice : p.trail.bestPrice;
    _trailBestLineRef = series.createPriceLine({
      price: dispBest,
      color: "#fbbf24",
      lineWidth: 1,
      lineStyle: 1,     // dotted
      axisLabelVisible: false,
      title: "▲ best"
    });
  }
}


// Inject into refresh chain (last layer)
const _origRefreshSLTPLines = refresh;
refresh = function() {
  _origRefreshSLTPLines();
  updateSLTPLines();
};

// ============================================================
// MULTI-POSITION REFACTOR — STATE.positions array + margin
// ============================================================
// This is a self-contained late-binding refactor that overrides all
// position-related entry points. STATE.position (singular) is kept as a
// dynamic alias to positions[0] for any code path we may have missed,
// but the canonical source of truth is STATE.positions (array).
// ============================================================

STATE.positions = STATE.positions || [];
STATE.positionNextId = STATE.positionNextId || 1;

// ─── Settings helpers ───────────────────────────────────────
function getMarginPct() {
  const v = +$("marginPct").value;
  return (isFinite(v) && v > 0) ? v : 5;
}
function getUnitsPerLot() {
  // Prefer the new "unitsPerLot" input; fall back to contractMult for any
  // legacy code path that still reads it.
  const u = +$("unitsPerLot").value;
  if (isFinite(u) && u > 0) return u;
  const c = +$("contractMult").value;
  return (isFinite(c) && c > 0) ? c : 100;
}
// Override existing getMult() (used by PnL math) to read unitsPerLot too
getMult = function() { return getUnitsPerLot(); };

// Sync contractMult ↔ unitsPerLot so any place reading either gets the same value
(function syncUnitsContract() {
  const a = $("unitsPerLot"), b = $("contractMult");
  if (!a || !b) return;
  const sync = (from, to) => { to.value = from.value; };
  a.addEventListener("input", () => sync(a, b));
  b.addEventListener("input", () => sync(b, a));
  sync(a, b);  // initial sync from new input to legacy
})();

// ─── Margin math (per position) ──────────────────────────────
function positionNotional(p, currentPrice) {
  // Long: bid scale (chart) — use entryAsk-ish for stability; we use stored entryPrice
  const px = currentPrice != null ? currentPrice : p.entryPrice;
  return px * p.size * (p.unitsPerLot || getUnitsPerLot());
}
function positionMarginUsed(p) {
  // Margin locked = notional at entry × marginPct (frozen at order time)
  return p.entryPrice * p.size * (p.unitsPerLot || getUnitsPerLot()) * (p.marginPct || getMarginPct()) / 100;
}
function positionFloatingPnL(p) {
  const bar = STATE.bars[STATE.cursor];
  if (!bar) return 0;
  const mult = p.unitsPerLot || getUnitsPerLot();
  if (p.side === "long") {
    const curBid = bar.close;
    return (curBid - p.entryPrice) * p.size * mult;
  } else {
    const curAsk = bar.close + p.spread;
    return (p.entryPrice - curAsk) * p.size * mult;
  }
}

function totalMarginUsed()    { return STATE.positions.reduce((s, p) => s + positionMarginUsed(p), 0); }
function totalFloatingPnL()   { return STATE.positions.reduce((s, p) => s + positionFloatingPnL(p), 0); }
function currentEquity()      { return STATE.equity + totalFloatingPnL(); }   // STATE.equity = realized only
function currentFreeMargin()  { return currentEquity() - totalMarginUsed(); }
function currentMarginLevel() {
  const used = totalMarginUsed();
  return used > 0 ? (currentEquity() / used) * 100 : Infinity;
}

// ─── Position CRUD helpers ──────────────────────────────────
function addPosition(p) {
  p.id = STATE.positionNextId++;
  p.marginPct = p.marginPct || getMarginPct();
  p.unitsPerLot = p.unitsPerLot || getUnitsPerLot();
  STATE.positions.push(p);
  return p;
}
function removePositionById(id) {
  const idx = STATE.positions.findIndex(p => p.id === id);
  if (idx >= 0) STATE.positions.splice(idx, 1);
}
function getPositionById(id) {
  return STATE.positions.find(p => p.id === id);
}

// Margin check before opening
function canAffordNewPosition(side, entryAsk, entryBid, size) {
  const price = side === "long" ? entryAsk : entryBid;
  const required = price * size * getUnitsPerLot() * getMarginPct() / 100;
  return { ok: required <= currentFreeMargin(), required, free: currentFreeMargin() };
}

// ─── Override placeOrder (market path) — push to positions ───
const _placeOrderSingleMulti = placeOrder;
placeOrder = function(side) {
  const type = $("orderType").value;
  if (type !== "market") {
    // Pending orders: keep going through existing path (which will
    // push to STATE.positions on fill via the refactored checkPendingOrders)
    return _placeOrderSingleMulti(side);
  }
  // MARKET path — fully reimplemented for multi-position
  if (STATE.cursor >= STATE.bars.length - 1) { alert("已到資料尾端，無法下單"); return; }
  if (!STATE.locked) {
    if (!applyInitialBalance()) { alert("初始餘額無效"); return; }
    lockBalance();
  }
  const entryBarIdx = STATE.cursor + 1;
  const entryBar = STATE.bars[entryBarIdx];
  const size = +$("orderSize").value;
  const lev = +$("orderLev").value;
  const spread = getSpread();
  const entryBid = entryBar.open;
  const entryAsk = entryBid + spread;
  // Margin check
  const aff = canAffordNewPosition(side, entryAsk, entryBid, size);
  if (!aff.ok) {
    alert(`保證金不足：此單需要 $${aff.required.toFixed(2)}，目前可用 $${aff.free.toFixed(2)}`);
    return;
  }
  const cfg = readSLTPConfig();
  const entryPrice = side === "long" ? entryAsk : entryBid;
  const slRes = resolveSL(cfg, side, entryAsk, entryBid, spread);
  if (slRes.invalid) return;
  const tp = resolveTP(cfg, side, entryAsk, entryBid, spread);
  // Behavior alerts: reuse the original system (warning before opening)
  const warnings = checkBehaviorAlerts();
  const doOpen = () => {
    addPosition({
      side, entryPrice, entryBid, entryAsk, spread,
      entryIdx: entryBarIdx, size, leverage: lev,
      sl: slRes.sl, tp, trail: slRes.trail,
      entryTime: entryBar.label,
      entryNote: STATE._tempEntryNote || null
    });
    STATE._tempEntryNote = null;
    STATE.cursor++;
    refresh();
  };
  const withNote = () => {
    if (STATE.prefs.noteOnEntry) {
      openNoteModal("為什麼下這單？", "例如：突破前高、RSI 反彈、KDJ 黃金交叉...", "", (note) => {
        STATE._tempEntryNote = note;
        doOpen();
      });
    } else { doOpen(); }
  };
  if (warnings.length) {
    showBehaviorAlertModal(warnings, (ok) => { if (ok) withNote(); });
  } else {
    withNote();
  }
};

// ─── Close all / close by id ────────────────────────────────
function closePositionById(id, reason = "manual") {
  const p = getPositionById(id);
  if (!p) return;
  let exitIdx, exitBidRaw;
  if (STATE.cursor >= STATE.bars.length - 1) {
    exitIdx = STATE.cursor;
    exitBidRaw = STATE.bars[exitIdx].close;
  } else {
    exitIdx = STATE.cursor + 1;
    exitBidRaw = STATE.bars[exitIdx].open;
  }
  const mult = p.unitsPerLot || getUnitsPerLot();
  const exitAskRaw = exitBidRaw + p.spread;
  const exitPrice = p.side === "long" ? exitBidRaw : exitAskRaw;
  const pnl = p.side === "long"
    ? (exitPrice - p.entryPrice) * p.size * mult
    : (p.entryPrice - exitPrice) * p.size * mult;
  const bar = STATE.bars[exitIdx];
  STATE.equity += pnl;
  STATE.peakEquity = Math.max(STATE.peakEquity, STATE.equity);
  STATE.maxDD = Math.max(STATE.maxDD, (STATE.peakEquity - STATE.equity) / STATE.peakEquity);
  STATE.equityCurve.push({ time: bar.time, equity: STATE.equity });
  STATE.trades.push({
    side: p.side, entryIdx: p.entryIdx, exitIdx,
    entryPrice: p.entryPrice, exitPrice, size: p.size,
    entryBid: p.entryBid, entryAsk: p.entryAsk, spread: p.spread,
    leverage: p.leverage, sl: p.sl, tp: p.tp,
    pnl, reason, entryTime: p.entryTime, exitTime: bar.label,
    entryNote: p.entryNote,
    trailDistance: p.trail ? p.trail.distance : null,
    trailFloor: p.trail ? p.trail.floor : null,
    unitsPerLot: p.unitsPerLot, marginPct: p.marginPct
  });
  removePositionById(id);
  refresh();
}
function closeAllPositions(reason = "manual") {
  // Optional exit note prompt (only when reason === "manual")
  if (STATE.prefs.noteOnExit && reason === "manual" && STATE.positions.length > 0) {
    openNoteModal("這筆交易學到什麼？", "例如：紀律好、太早平倉、跟到趨勢...", "", (note) => {
      // Apply to LAST closed trades (one note for the batch)
      const ids = STATE.positions.map(p => p.id);
      ids.forEach(id => closePositionById(id, reason));
      if (note) {
        // Attach note to the last N trades just recorded
        for (let i = 1; i <= ids.length; i++) {
          const t = STATE.trades[STATE.trades.length - i];
          if (t) t.exitNote = note;
        }
        refresh();
      }
    });
  } else {
    const ids = STATE.positions.map(p => p.id);
    ids.forEach(id => closePositionById(id, reason));
  }
}

// Override existing closePosition to mean "close all"
closePosition = function(reason = "manual") { closeAllPositions(reason); };

// ─── Iterate-version of checkSLTP across all positions ──────
checkSLTP = function() {
  if (!STATE.positions.length) return false;
  const bar = STATE.bars[STATE.cursor];
  if (!bar) return false;
  // Iterate in reverse so splices don't mess up the loop
  for (let i = STATE.positions.length - 1; i >= 0; i--) {
    const p = STATE.positions[i];
    if (p.entryIdx > STATE.cursor) continue;
    const mult = p.unitsPerLot || getUnitsPerLot();
    if (p.side === "long") {
      if (p.sl != null && bar.low <= p.sl) {
        const ep = p.sl;
        const pnl = (ep - p.entryPrice) * p.size * mult;
        _multiRecordTrade(p, STATE.cursor, ep, pnl, "SL", bar);
        STATE.positions.splice(i, 1);
        continue;
      }
      if (p.tp != null && bar.high >= p.tp) {
        const ep = p.tp;
        const pnl = (ep - p.entryPrice) * p.size * mult;
        _multiRecordTrade(p, STATE.cursor, ep, pnl, "TP", bar);
        STATE.positions.splice(i, 1);
        continue;
      }
    } else {
      const askHigh = bar.high + p.spread;
      const askLow = bar.low + p.spread;
      if (p.sl != null && askHigh >= p.sl) {
        const ep = p.sl;
        const pnl = (p.entryPrice - ep) * p.size * mult;
        _multiRecordTrade(p, STATE.cursor, ep, pnl, "SL", bar);
        STATE.positions.splice(i, 1);
        continue;
      }
      if (p.tp != null && askLow <= p.tp) {
        const ep = p.tp;
        const pnl = (p.entryPrice - ep) * p.size * mult;
        _multiRecordTrade(p, STATE.cursor, ep, pnl, "TP", bar);
        STATE.positions.splice(i, 1);
        continue;
      }
    }
  }
  return false;
};

// Helper to record a closed trade without removing position (we splice externally)
function _multiRecordTrade(p, exitIdx, exitPrice, pnl, reason, bar) {
  STATE.equity += pnl;
  STATE.peakEquity = Math.max(STATE.peakEquity, STATE.equity);
  STATE.maxDD = Math.max(STATE.maxDD, (STATE.peakEquity - STATE.equity) / STATE.peakEquity);
  STATE.equityCurve.push({ time: bar.time, equity: STATE.equity });
  STATE.trades.push({
    side: p.side, entryIdx: p.entryIdx, exitIdx,
    entryPrice: p.entryPrice, exitPrice, size: p.size,
    entryBid: p.entryBid, entryAsk: p.entryAsk, spread: p.spread,
    leverage: p.leverage, sl: p.sl, tp: p.tp,
    pnl, reason, entryTime: p.entryTime, exitTime: bar.label,
    entryNote: p.entryNote,
    trailDistance: p.trail ? p.trail.distance : null,
    trailFloor: p.trail ? p.trail.floor : null,
    unitsPerLot: p.unitsPerLot, marginPct: p.marginPct
  });
}

// ─── Trail update per position ──────────────────────────────
updateTrailingSL = function() {
  if (!STATE.positions.length) return;
  const bar = STATE.bars[STATE.cursor];
  if (!bar) return;
  STATE.positions.forEach(p => {
    if (!p.trail) return;
    if (p.side === "long") {
      if (bar.high > p.trail.bestPrice) p.trail.bestPrice = bar.high;
      let cand = p.trail.bestPrice - p.trail.distance;
      if (p.trail.floor != null) cand = Math.max(cand, p.trail.floor);
      if (cand > p.sl) p.sl = cand;
    } else {
      if (bar.low < p.trail.bestPrice) p.trail.bestPrice = bar.low;
      let cand = p.trail.bestPrice + p.trail.distance;
      if (p.trail.floor != null) cand = Math.min(cand, p.trail.floor);
      if (cand < p.sl) p.sl = cand;
    }
  });
};

// ─── Pending orders: no single-position constraint + margin check ──
checkPendingOrders = function() {
  if (!STATE.pendingOrders.length) return;
  const bar = STATE.bars[STATE.cursor];
  if (!bar) return;
  // Find all triggered
  const triggered = [];
  for (const o of STATE.pendingOrders) {
    if (o.placedAt > STATE.cursor) continue;
    let hit = false;
    if (o.type === "limit" && o.side === "long")  hit = bar.low  <= o.triggerPrice;
    if (o.type === "limit" && o.side === "short") hit = bar.high >= o.triggerPrice;
    if (o.type === "stop"  && o.side === "long")  hit = bar.high >= o.triggerPrice;
    if (o.type === "stop"  && o.side === "short") hit = bar.low  <= o.triggerPrice;
    if (hit) triggered.push(o);
  }
  for (const o of triggered) {
    if (!STATE.locked) {
      if (!applyInitialBalance()) continue;
      lockBalance();
    }
    const entryBid = o.side === "long" ? o.triggerPrice - o.spread : o.triggerPrice;
    const entryAsk = o.side === "long" ? o.triggerPrice : o.triggerPrice + o.spread;
    // Margin check
    const aff = canAffordNewPosition(o.side, entryAsk, entryBid, o.size);
    if (!aff.ok) {
      // Cancel this order silently (or could alert) — reject due to margin
      STATE.pendingOrders = STATE.pendingOrders.filter(po => po !== o);
      continue;
    }
    const entryPrice = o.side === "long" ? entryAsk : entryBid;
    let slRes = { sl: null, trail: null };
    let tp = null;
    if (o.sltpCfg) {
      slRes = resolveSL(o.sltpCfg, o.side, entryAsk, entryBid, o.spread);
      tp = resolveTP(o.sltpCfg, o.side, entryAsk, entryBid, o.spread);
    }
    addPosition({
      side: o.side, entryPrice, entryBid, entryAsk, spread: o.spread,
      entryIdx: STATE.cursor, size: o.size, leverage: o.lev,
      sl: slRes.sl, tp, trail: slRes.trail,
      entryTime: bar.label,
      entryNote: o.entryNote || null
    });
    // Cancel this order + OCO siblings
    STATE.pendingOrders = STATE.pendingOrders.filter(po =>
      po !== o && (po.ocoGroupId == null || po.ocoGroupId !== o.ocoGroupId)
    );
  }
  renderPendingOrders();
};

// ─── Margin call / liquidation ──────────────────────────────
function checkMarginCall() {
  if (!$("marginCallEnable").checked) return;
  if (STATE.positions.length === 0) return;

  const levelEnabled = $("marginLevelEnable").checked;
  const eq = currentEquity();
  const used = totalMarginUsed();

  if (levelEnabled) {
    const threshold = +$("marginLevelPct").value;
    let level = used > 0 ? (eq / used) * 100 : Infinity;
    // While below threshold, force-close the position with the largest UNREALIZED LOSS
    // (most negative floating PnL) — keeps winners, kills losers.
    let safety = 100;
    while (level < threshold && STATE.positions.length > 0 && safety-- > 0) {
      let worstIdx = -1, worstPnL = Infinity;
      STATE.positions.forEach((p, i) => {
        const f = positionFloatingPnL(p);
        if (f < worstPnL) { worstPnL = f; worstIdx = i; }
      });
      if (worstIdx < 0) break;
      const victimId = STATE.positions[worstIdx].id;
      closePositionById(victimId, "強平");
      // Recompute
      const newEq = currentEquity();
      const newUsed = totalMarginUsed();
      level = newUsed > 0 ? (newEq / newUsed) * 100 : Infinity;
    }
  } else {
    // No level — close all when total floating loss ≥ used margin
    const floating = totalFloatingPnL();
    if (floating <= -used) {
      [...STATE.positions].forEach(p => closePositionById(p.id, "強平"));
    }
  }
}

// ─── Refresh override — render multi-position UI + check margin call ──
const _origRefreshMulti = refresh;
refresh = function() {
  _origRefreshMulti();
  renderPositionCards();
  renderMarginInfo();
  checkMarginCall();
};

function fmt(n, d=2) { return n.toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d}); }

function renderPositionCards() {
  const list = $("positionsList");
  if (!list) return;
  if (!STATE.positions.length) { list.innerHTML = ""; return; }
  list.innerHTML = "";
  STATE.positions.forEach(p => {
    const f = positionFloatingPnL(p);
    const slDisp = p.sl != null ? (p.side === "long" ? p.sl : p.sl - p.spread) : null;
    const tpDisp = p.tp != null ? (p.side === "long" ? p.tp : p.tp - p.spread) : null;
    const trailTag = p.trail ? `<span class="trail-tag">↺${p.trail.distance}</span>` : "";
    const card = document.createElement("div");
    card.className = "pos-card " + p.side;
    card.innerHTML = `
      <div class="pos-head">
        <span><span class="pos-side">${p.side.toUpperCase()}</span><span class="pos-id">#${p.id}</span>${trailTag}</span>
        <button class="pos-close-btn" data-id="${p.id}" title="平掉這倉">✕</button>
      </div>
      <div class="pos-row"><span class="lbl">進場</span><span class="val">${p.entryPrice.toFixed(3)} · ${p.size} 口</span></div>
      <div class="pos-row"><span class="lbl">SL / TP</span><span class="val">${slDisp!=null?slDisp.toFixed(2):'—'} / ${tpDisp!=null?tpDisp.toFixed(2):'—'}</span></div>
      <div class="pos-row pos-pnl-row"><span class="lbl">浮動 P&L</span><span class="val ${f>=0?'pos':'neg'}">${f>=0?'+':''}${fmt(f)}</span></div>`;
    card.querySelector(".pos-close-btn").onclick = () => closePositionById(p.id, "manual");
    list.appendChild(card);
  });
}

function renderMarginInfo() {
  const el = $("marginInfo");
  if (!el) return;
  if (!STATE.positions.length) { el.style.display = "none"; return; }
  el.style.display = "grid";
  const eq = currentEquity();
  const used = totalMarginUsed();
  const free = eq - used;
  const level = used > 0 ? (eq / used) * 100 : Infinity;
  const floating = totalFloatingPnL();
  let cls = "";
  const levelThreshold = +$("marginLevelPct").value;
  if (isFinite(level) && level < levelThreshold * 1.5) cls = "warn";
  if (isFinite(level) && level < levelThreshold) cls = "danger";
  el.className = "margin-info " + cls;
  el.innerHTML = `
    <div class="mi-row"><span class="mi-label">持倉</span><span class="mi-value">${STATE.positions.length} 筆</span></div>
    <div class="mi-row"><span class="mi-label">浮動</span><span class="mi-value ${floating>=0?'pos':'neg'}">${floating>=0?'+':''}${fmt(floating)}</span></div>
    <div class="mi-row"><span class="mi-label">權益</span><span class="mi-value">${fmt(eq)}</span></div>
    <div class="mi-row"><span class="mi-label">已用</span><span class="mi-value">${fmt(used)}</span></div>
    <div class="mi-row"><span class="mi-label">可用</span><span class="mi-value ${free>=0?'pos':'neg'}">${fmt(free)}</span></div>
    <div class="mi-row"><span class="mi-label">維持率</span><span class="mi-value ${cls}">${isFinite(level) ? level.toFixed(0)+'%' : '∞'}</span></div>`;
}

// ─── Multi-position chart markers + SL/TP lines ─────────────
drawPositionMarkers = function() {
  if (!STATE.mainPane) return;
  const markers = [];
  STATE.trades.forEach((t, i) => {
    markers.push({
      time: STATE.bars[t.entryIdx].time,
      position: t.side === "long" ? "belowBar" : "aboveBar",
      color: t.side === "long" ? "#22c55e" : "#ef4444",
      shape: t.side === "long" ? "arrowUp" : "arrowDown",
      text: `${t.side === "long" ? "L" : "S"}#${i+1}`
    });
    if (t.exitIdx != null) {
      markers.push({
        time: STATE.bars[t.exitIdx].time,
        position: "inBar",
        color: t.pnl >= 0 ? "#22c55e" : "#ef4444",
        shape: "circle",
        text: t.pnl.toFixed(0)
      });
    }
  });
  STATE.positions.forEach(p => {
    markers.push({
      time: STATE.bars[p.entryIdx].time,
      position: p.side === "long" ? "belowBar" : "aboveBar",
      color: p.side === "long" ? "#22c55e" : "#ef4444",
      shape: p.side === "long" ? "arrowUp" : "arrowDown",
      text: `${p.side === "long" ? "L" : "S"}#${p.id}`
    });
  });
  markers.sort((a, b) => a.time - b.time);
  STATE.mainPane.series.candle.setMarkers(markers);
};

// Override SL/TP lines to draw per-position lines
updateSLTPLines = function() {
  removeSLTPLines();
  if (!STATE.positions.length) return;
  const series = STATE.mainPane && STATE.mainPane.series && STATE.mainPane.series.candle;
  if (!series) return;
  STATE.positions.forEach(p => {
    if (p.sl != null) {
      const dispSL = p.side === "long" ? p.sl : (p.sl - p.spread);
      const ref = series.createPriceLine({
        price: dispSL, color: "#ef4444", lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: `${p.trail ? "↺SL" : "SL"} #${p.id}`
      });
      _slPriceLines.push(ref);
    }
    if (p.tp != null) {
      const dispTP = p.side === "long" ? p.tp : (p.tp - p.spread);
      const ref = series.createPriceLine({
        price: dispTP, color: "#22c55e", lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: `TP #${p.id}`
      });
      _slPriceLines.push(ref);
    }
  });
};
let _slPriceLines = [];
function removeSLTPLines() {
  const series = STATE.mainPane && STATE.mainPane.series && STATE.mainPane.series.candle;
  if (!series) return;
  _slPriceLines.forEach(ref => { try { series.removePriceLine(ref); } catch(e) {} });
  _slPriceLines = [];
  // Also clear legacy single-position refs from earlier code
  [_slLineRef, _tpLineRef, _trailBestLineRef].forEach(ref => {
    if (ref) { try { series.removePriceLine(ref); } catch(e) {} }
  });
  _slLineRef = _tpLineRef = _trailBestLineRef = null;
}

// ─── Step-back: revert/delete multi-positions ───────────────
stepBack = function() {
  if (STATE.cursor <= 1) return;
  STATE.cursor--;
  let changed = false;
  // Revert closed trades whose exitIdx > cursor
  while (STATE.trades.length > 0 &&
         STATE.trades[STATE.trades.length - 1].exitIdx > STATE.cursor) {
    const last = STATE.trades.pop();
    // Reopen as position
    addPosition({
      side: last.side, entryPrice: last.entryPrice,
      entryBid: last.entryBid, entryAsk: last.entryAsk, spread: last.spread,
      entryIdx: last.entryIdx, size: last.size, leverage: last.leverage,
      sl: last.sl, tp: last.tp,
      trail: last.trailDistance != null ? {
        distance: last.trailDistance, floor: last.trailFloor,
        bestPrice: last.side === "long" ? last.entryAsk : last.entryBid
      } : null,
      entryTime: last.entryTime, entryNote: last.entryNote,
      unitsPerLot: last.unitsPerLot, marginPct: last.marginPct
    });
    changed = true;
  }
  // Delete positions whose entry is now in the future
  const before = STATE.positions.length;
  STATE.positions = STATE.positions.filter(p => p.entryIdx <= STATE.cursor);
  if (STATE.positions.length !== before) changed = true;
  // Drop pending orders placed in the future
  const beforeP = STATE.pendingOrders.length;
  STATE.pendingOrders = STATE.pendingOrders.filter(o => o.placedAt <= STATE.cursor);
  if (STATE.pendingOrders.length !== beforeP) renderPendingOrders();
  if (changed) {
    recalcEquity();
    if (STATE.trades.length === 0 && STATE.positions.length === 0 && STATE.locked) {
      unlockBalance();
    }
  }
  refresh();
};

// ─── Reset includes positions array ─────────────────────────
const _origResetClick = $("btnReset").onclick;
$("btnReset").onclick = function() {
  if (!confirm("確定重置？所有交易記錄將清空，初始餘額將解鎖")) return;
  STATE.trades = []; STATE.positions = [];
  STATE.equityCurve = [];
  STATE.pendingOrders = [];
  unlockBalance();
  applyInitialBalance();
  renderPendingOrders();
  refresh();
};

// ─── Apply i18n for new labels ──────────────────────────────
Object.assign(I18N["zh-TW"], {
  "label.marginPct": "保證金率 (%)",
  "label.unitsPerLot": "一倉單位",
  "hint.marginUnits": "名目 = 進場價 × 口數 × 一倉單位；佔用保證金 = 名目 × 保證金率%",
  "panel.marginCall": "強平設定",
  "prefs.marginCallEnable": "啟用自動強平",
  "prefs.marginLevelEnable": "使用保證金維持率（<",
  "prefs.marginLevelSuf": "% 時開始強平虧損最大倉位）",
  "hint.marginCall": "關閉維持率 → 總虧損 = 已用保證金時直接平倉全部",
  "btn.flatAll": "平倉全部"
});
Object.assign(I18N["en-US"], {
  "label.marginPct": "Margin (%)",
  "label.unitsPerLot": "Units / Lot",
  "hint.marginUnits": "Notional = Entry × Lots × Units/Lot;  Margin used = Notional × Margin%",
  "panel.marginCall": "Margin Call",
  "prefs.marginCallEnable": "Enable auto-liquidation",
  "prefs.marginLevelEnable": "Use maintenance level (when level <",
  "prefs.marginLevelSuf": "% close worst losers until restored)",
  "hint.marginCall": "Without maintenance level → close all when total loss ≥ margin used",
  "btn.flatAll": "Close All"
});
applyI18n();

// Initial UI render
renderPositionCards();
renderMarginInfo();

// ============================================================
// Close-position UX — long/short batch + multi-select
// ============================================================
STATE.selectedPositionIds = new Set();

function closeAllBySide(side, reason = "manual") {
  const ids = STATE.positions.filter(p => p.side === side).map(p => p.id);
  if (!ids.length) return;
  // Skip exit-note modal for batch closes (would be one-per, too noisy)
  ids.forEach(id => closePositionById(id, reason));
}
function closeSelectedPositions(reason = "manual") {
  const ids = Array.from(STATE.selectedPositionIds);
  if (!ids.length) return;
  ids.forEach(id => closePositionById(id, reason));
  STATE.selectedPositionIds.clear();
  refresh();
}

function updateFlatButtonsState() {
  const longCount  = STATE.positions.filter(p => p.side === "long").length;
  const shortCount = STATE.positions.filter(p => p.side === "short").length;
  const btnL = $("btnFlatLongs");
  const btnS = $("btnFlatShorts");
  if (btnL) btnL.disabled = longCount === 0;
  if (btnS) btnS.disabled = shortCount === 0;
  // Selected button
  const sel = $("btnFlatSelected");
  const cnt = $("flatSelectedCount");
  const validSelected = Array.from(STATE.selectedPositionIds).filter(id =>
    STATE.positions.some(p => p.id === id));
  // Prune stale selections
  STATE.selectedPositionIds = new Set(validSelected);
  if (sel) {
    if (validSelected.length > 0) {
      sel.style.display = "";
      if (cnt) cnt.textContent = `(${validSelected.length})`;
    } else {
      sel.style.display = "none";
    }
  }
}

// Override renderPositionCards to include checkbox + selection state
const _origRenderPositionCardsMulti = renderPositionCards;
renderPositionCards = function() {
  _origRenderPositionCardsMulti();
  const list = $("positionsList");
  if (!list) return;
  // Add checkboxes into each card head (before the side text)
  list.querySelectorAll(".pos-card").forEach((card, idx) => {
    const closeBtn = card.querySelector(".pos-close-btn");
    if (!closeBtn) return;
    const id = +closeBtn.dataset.id;
    // Mark selection state
    if (STATE.selectedPositionIds.has(id)) card.classList.add("selected");
    // Inject checkbox into head (only once)
    const head = card.querySelector(".pos-head");
    if (head && !head.querySelector(".pos-check")) {
      const sideSpan = head.querySelector(".pos-side");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "pos-check";
      cb.dataset.id = id;
      cb.checked = STATE.selectedPositionIds.has(id);
      cb.onclick = (e) => {
        e.stopPropagation();
        if (cb.checked) STATE.selectedPositionIds.add(id);
        else STATE.selectedPositionIds.delete(id);
        card.classList.toggle("selected", cb.checked);
        updateFlatButtonsState();
      };
      // Insert checkbox right before the side span
      if (sideSpan && sideSpan.parentElement) {
        sideSpan.parentElement.insertBefore(cb, sideSpan);
      }
    }
  });
  updateFlatButtonsState();
};

// Wire up the new buttons
const btnL = $("btnFlatLongs");
const btnS = $("btnFlatShorts");
const btnSel = $("btnFlatSelected");
if (btnL) btnL.onclick = () => closeAllBySide("long", "manual");
if (btnS) btnS.onclick = () => closeAllBySide("short", "manual");
if (btnSel) btnSel.onclick = () => closeSelectedPositions("manual");

// Add new i18n keys
Object.assign(I18N["zh-TW"], {
  "btn.flatLongs": "全平多單",
  "btn.flatShorts": "全平空單",
  "btn.flatSelected": "平倉選中"
});
Object.assign(I18N["en-US"], {
  "btn.flatLongs": "Close all Longs",
  "btn.flatShorts": "Close all Shorts",
  "btn.flatSelected": "Close selected"
});
applyI18n();
updateFlatButtonsState();

// ============================================================
// FIX: obsolete single-position UI functions still in refresh chain
// ============================================================
// updatePositionCard was called by the pre-multi refresh path but references
// $("positionCard") (removed) and STATE.position (undefined) → crash breaks
// the entire refresh chain, causing renderPositionCards + renderMarginInfo +
// close-button wiring to silently fail.
//
// Neutralize both position-card entry points now that renderPositionCards
// is the source of truth for the multi-position UI.
updatePositionCard = function() { /* replaced by renderPositionCards */ };
// Also guard the pre-multi drawPositionMarkers reference to STATE.position if
// any residual override still holds it (multi already overrides but be safe).
if (!window._multiMarkersInstalled) window._multiMarkersInstalled = true;

// One more defensive step: STATE.position (singular) is a legacy alias.
// A few residual reads (e.g. behavior alerts, notes wrappers) may still touch
// it. Make it dynamically reflect positions[0] via a getter so old reads work.
try {
  Object.defineProperty(STATE, "position", {
    configurable: true,
    get() { return STATE.positions.length ? STATE.positions[0] : null; },
    set(_) { /* ignore — writes go through addPosition/removePositionById */ }
  });
} catch(e) { /* if property already exists non-configurable, skip */ }

// Force a refresh now so buttons and cards wire up correctly on this load.
if (STATE.mainPane) refresh();

// ============================================================
// FIX: exit note + CSV export with notes
// ============================================================

// Helper: close one/many positions with optional exit-note prompt
function closePositionsWithNote(ids, reason = "manual", batchLabel = "") {
  if (!ids || !ids.length) return;
  const promptForNote = STATE.prefs.noteOnExit && reason === "manual";
  const doClose = (note) => {
    STATE._tempExitNote = note;
    ids.forEach(id => closePositionById(id, reason));
    STATE._tempExitNote = null;
  };
  if (promptForNote) {
    const title = ids.length === 1
      ? "這筆交易學到什麼？"
      : `一次平掉 ${ids.length} 筆${batchLabel}，本輪學到什麼？`;
    openNoteModal(title, "例如：紀律好、太早平倉、跟到趨勢、追高被洗...", "", (note) => doClose(note));
  } else {
    doClose(null);
  }
}

// Patch closePositionById to pick up exitNote from STATE._tempExitNote
const _closePositionByIdCore = closePositionById;
closePositionById = function(id, reason = "manual") {
  const p = getPositionById(id);
  if (!p) return;
  // Reuse the core logic but attach exitNote after push
  const tradesLenBefore = STATE.trades.length;
  _closePositionByIdCore(id, reason);
  const t = STATE.trades[tradesLenBefore];  // the trade just pushed
  if (t && STATE._tempExitNote) {
    t.exitNote = STATE._tempExitNote;
  }
};

// Rewire × on each position card via renderPositionCards override
const _renderCardsWithNote = renderPositionCards;
renderPositionCards = function() {
  _renderCardsWithNote();
  const list = $("positionsList");
  if (!list) return;
  list.querySelectorAll(".pos-close-btn").forEach(btn => {
    const id = +btn.dataset.id;
    btn.onclick = (e) => {
      e.stopPropagation();
      closePositionsWithNote([id], "manual");
    };
  });
};

// Rewire batch buttons
const _btnFlatLongs = $("btnFlatLongs");
const _btnFlatShorts = $("btnFlatShorts");
const _btnFlatSelected = $("btnFlatSelected");
if (_btnFlatLongs) _btnFlatLongs.onclick = () => {
  const ids = STATE.positions.filter(p => p.side === "long").map(p => p.id);
  closePositionsWithNote(ids, "manual", "多單");
};
if (_btnFlatShorts) _btnFlatShorts.onclick = () => {
  const ids = STATE.positions.filter(p => p.side === "short").map(p => p.id);
  closePositionsWithNote(ids, "manual", "空單");
};
if (_btnFlatSelected) _btnFlatSelected.onclick = () => {
  const ids = Array.from(STATE.selectedPositionIds).filter(id =>
    STATE.positions.some(p => p.id === id));
  closePositionsWithNote(ids, "manual", "選中");
  STATE.selectedPositionIds.clear();
};

// ─── CSV export: append EntryNote + ExitNote ─────────────────
function csvEscape(s) {
  if (s == null) return "";
  const str = String(s);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}
$("btnExport").onclick = () => {
  if (!STATE.trades.length) { alert("尚無交易"); return; }
  const headers = ["#","Side","EntryTime","EntryPrice","ExitTime","ExitPrice","Size","Spread","Reason","PnL","EntryNote","ExitNote"];
  const lines = [headers.join(",")];
  STATE.trades.forEach((t, i) => {
    lines.push([
      i+1,
      t.side,
      csvEscape(t.entryTime),
      t.entryPrice,
      csvEscape(t.exitTime),
      t.exitPrice,
      t.size,
      (t.spread||0).toFixed(2),
      t.reason,
      t.pnl.toFixed(2),
      csvEscape(t.entryNote),
      csvEscape(t.exitNote)
    ].join(","));
  });
  // BOM for Excel/Chinese compatibility
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "trades_" + Date.now() + ".csv";
  a.click();
};
