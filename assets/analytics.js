"use strict";

// ============================================================
// Analytics page
// ============================================================
const LS_KEY = "practice_trading_trades_session";
const COLORS = { pos:"#22c55e", neg:"#ef4444", neu:"#60a5fa", warn:"#fbbf24", muted:"#8da0c0" };
const STATE = { trades: [], charts: {} };

function $(id) { return document.getElementById(id); }
function fmt(n, d=2) { return n.toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d}); }
function pct(x) { return (x*100).toFixed(2) + "%"; }

function parseTimeLabel(label) {
  if (!label) return null;
  const s = String(label).trim();
  // Format A: "YYYYMMDD HH:MM:SS"
  let m = s.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
  }
  // Format B: ISO string
  const d = new Date(s);
  if (!isNaN(d)) return d;
  return null;
}

function processTrades(rawTrades) {
  return rawTrades.map((t, i) => {
    const entryT = parseTimeLabel(t.entryTime || t.EntryTime);
    const exitT  = parseTimeLabel(t.exitTime  || t.ExitTime);
    const pnl = +(t.pnl ?? t.PnL ?? 0);
    return {
      i: i+1,
      side: String(t.side || t.Side || "").toLowerCase(),
      entryT, exitT,
      entryPrice: +(t.entryPrice ?? t.EntryPrice ?? 0),
      exitPrice:  +(t.exitPrice  ?? t.ExitPrice  ?? 0),
      size: +(t.size ?? t.Size ?? 1),
      spread: +(t.spread ?? t.Spread ?? 0),
      reason: String(t.reason || t.Reason || "manual"),
      pnl,
      holdMin: (entryT && exitT) ? (exitT - entryT)/60000 : null
    };
  }).filter(t => t.side === "long" || t.side === "short");
}

// ============================================================
// Loaders
// ============================================================
function loadFromSession() {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) { alert("localStorage 中沒有交易紀錄。請先在練習頁進行至少一筆交易。"); return; }
  try {
    const obj = JSON.parse(raw);
    STATE.trades = processTrades(obj.trades || []);
    $("anaSrc").textContent = `Session: ${obj.trades.length} 筆 · 載入時間 ${new Date(obj.savedAt).toLocaleString()}`;
    render();
  } catch(e) {
    alert("資料解析錯誤: " + e.message);
  }
}

function loadFromCsv(file) {
  Papa.parse(file, {
    header: true, dynamicTyping: true, skipEmptyLines: true,
    complete: (results) => {
      STATE.trades = processTrades(results.data);
      if (!STATE.trades.length) { alert("CSV 無有效交易紀錄"); return; }
      $("anaSrc").textContent = `${file.name} · ${STATE.trades.length} 筆`;
      render();
    }
  });
}

$("loadFromSession").onclick = loadFromSession;
$("anaTradesFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) loadFromCsv(f);
  e.target.value = "";
});

// Auto-load from URL hash on first visit
if (location.hash === "#fromSession") {
  setTimeout(loadFromSession, 50);
}

// ============================================================
// Computations
// ============================================================
function computeKPI() {
  const t = STATE.trades;
  const total = t.length;
  const wins = t.filter(x => x.pnl > 0);
  const losses = t.filter(x => x.pnl <= 0);
  const winRate = total ? wins.length/total : 0;
  const grossWin = wins.reduce((s,x)=>s+x.pnl,0);
  const grossLoss = losses.reduce((s,x)=>s+Math.abs(x.pnl),0);
  const pf = grossLoss>0 ? grossWin/grossLoss : (grossWin>0 ? Infinity : 0);
  const total_pnl = grossWin - grossLoss;
  const avgWin = wins.length ? grossWin/wins.length : 0;
  const avgLoss = losses.length ? grossLoss/losses.length : 0;
  const rr = avgLoss>0 ? avgWin/avgLoss : 0;
  const exp = total ? total_pnl/total : 0;
  // Equity curve + maxDD
  let equity = 0, peak = 0, maxDD = 0;
  t.forEach(x => {
    equity += x.pnl;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) : 0;
    if (dd > maxDD) maxDD = dd;
  });
  // Sharpe (trade-level scaled)
  let sharpe = 0;
  if (total > 1) {
    const mean = total_pnl/total;
    const v = t.reduce((s,x)=>s+(x.pnl-mean)**2,0)/(total-1);
    const sd = Math.sqrt(v);
    sharpe = sd > 0 ? (mean/sd) * Math.sqrt(total) : 0;
  }
  // Streaks
  let maxWinStreak=0, maxLossStreak=0, curW=0, curL=0;
  t.forEach(x => {
    if (x.pnl > 0) { curW++; curL=0; if (curW>maxWinStreak) maxWinStreak=curW; }
    else { curL++; curW=0; if (curL>maxLossStreak) maxLossStreak=curL; }
  });
  return { total, winRate, total_pnl, pf, avgWin, avgLoss, rr, exp, maxDD, sharpe, maxWinStreak, maxLossStreak };
}

function renderKPIs() {
  const k = computeKPI();
  const ddPct = k.maxDD > 0 && k.total_pnl !== 0 ? (k.maxDD / Math.max(k.total_pnl+k.maxDD, k.maxDD)) : 0;
  const kpis = [
    { label: "總交易數", value: k.total, sub: `連勝 ${k.maxWinStreak} / 連敗 ${k.maxLossStreak}` },
    { label: "勝率", value: pct(k.winRate), cls: k.winRate>=0.5?"pos":"neg" },
    { label: "總損益", value: fmt(k.total_pnl), cls: k.total_pnl>=0?"pos":"neg" },
    { label: "獲利因子", value: isFinite(k.pf)?k.pf.toFixed(2):"∞", cls: k.pf>=1?"pos":"neg" },
    { label: "盈虧比 RR", value: k.rr.toFixed(2), cls: k.rr>=1?"pos":"neg" },
    { label: "夏普比率", value: k.sharpe.toFixed(2), cls: k.sharpe>=1?"pos":"neg" },
    { label: "平均盈", value: fmt(k.avgWin), cls: "pos" },
    { label: "平均虧", value: fmt(k.avgLoss), cls: "neg" },
    { label: "期望值/筆", value: fmt(k.exp), cls: k.exp>=0?"pos":"neg" },
    { label: "最大回撤", value: fmt(k.maxDD), cls: "neg" },
  ];
  const html = kpis.map(x =>
    `<div class="kpi ${x.cls||''}">
      <div class="kpi-label">${x.label}</div>
      <div class="kpi-value">${x.value}</div>
      ${x.sub ? `<div class="kpi-sub">${x.sub}</div>` : ""}
    </div>`
  ).join("");
  $("kpiGrid").innerHTML = html;
}

// ============================================================
// Chart helpers
// ============================================================
const CHART_BASE_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { color:"#8da0c0", font: { size: 10 } } } },
  scales: {
    x: { ticks: { color:"#8da0c0", font:{size:10} }, grid:{ color:"#1a1f2c" } },
    y: { ticks: { color:"#8da0c0", font:{size:10} }, grid:{ color:"#1a1f2c" } }
  }
};

function destroyChart(name) {
  if (STATE.charts[name]) { STATE.charts[name].destroy(); STATE.charts[name] = null; }
}

function renderEquity() {
  destroyChart("equity");
  const labels = []; const data = [];
  let eq = 0;
  STATE.trades.forEach(t => {
    eq += t.pnl;
    labels.push(t.exitT ? t.exitT.toISOString().slice(0,16).replace("T"," ") : `#${t.i}`);
    data.push(eq);
  });
  STATE.charts.equity = new Chart($("chartEquity"), {
    type: "line",
    data: { labels, datasets: [{
      label: "累積 P&L", data, borderColor: COLORS.neu, backgroundColor: "rgba(96,165,250,0.15)",
      fill: true, pointRadius: 0, tension: 0.15, borderWidth: 1.5
    }]},
    options: { ...CHART_BASE_OPTS, scales: { ...CHART_BASE_OPTS.scales, x: { ...CHART_BASE_OPTS.scales.x, ticks: { color:"#8da0c0", maxTicksLimit: 8 } } } }
  });
}

function renderDD() {
  destroyChart("dd");
  const labels = []; const data = [];
  let eq = 0, peak = 0;
  STATE.trades.forEach(t => {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    labels.push(`#${t.i}`);
    data.push(-(peak - eq));
  });
  STATE.charts.dd = new Chart($("chartDD"), {
    type: "line",
    data: { labels, datasets: [{
      label: "Drawdown", data, borderColor: COLORS.neg, backgroundColor: "rgba(239,68,68,0.25)",
      fill: true, pointRadius: 0, tension: 0.15, borderWidth: 1.2
    }]},
    options: { ...CHART_BASE_OPTS, scales: { ...CHART_BASE_OPTS.scales, x: { ticks: { display: false }, grid:{ color:"#1a1f2c" } } } }
  });
}

function renderMonthly() {
  destroyChart("monthly");
  const byMonth = new Map();
  STATE.trades.forEach(t => {
    if (!t.exitT) return;
    const key = `${t.exitT.getUTCFullYear()}-${String(t.exitT.getUTCMonth()+1).padStart(2,"0")}`;
    byMonth.set(key, (byMonth.get(key)||0) + t.pnl);
  });
  const labels = Array.from(byMonth.keys()).sort();
  const data = labels.map(k => byMonth.get(k));
  STATE.charts.monthly = new Chart($("chartMonthly"), {
    type: "bar",
    data: { labels, datasets: [{
      label: "Monthly P&L", data,
      backgroundColor: data.map(v => v>=0 ? COLORS.pos : COLORS.neg),
      borderWidth: 0
    }]},
    options: { ...CHART_BASE_OPTS }
  });
}

function renderHourWR() {
  destroyChart("hourWR");
  const buckets = Array.from({length:24}, () => ({ n:0, w:0, pnl:0 }));
  STATE.trades.forEach(t => {
    if (!t.entryT) return;
    const h = t.entryT.getUTCHours();
    buckets[h].n++;
    if (t.pnl > 0) buckets[h].w++;
    buckets[h].pnl += t.pnl;
  });
  const labels = buckets.map((_,i) => String(i).padStart(2,"0"));
  const wr = buckets.map(b => b.n ? (b.w/b.n)*100 : null);
  const colors = buckets.map(b => b.pnl >= 0 ? COLORS.pos : COLORS.neg);
  STATE.charts.hourWR = new Chart($("chartHourWR"), {
    type: "bar",
    data: { labels, datasets: [{
      label: "勝率 (%)", data: wr, backgroundColor: colors, borderWidth: 0
    }]},
    options: {
      ...CHART_BASE_OPTS,
      scales: {
        ...CHART_BASE_OPTS.scales,
        y: { ...CHART_BASE_OPTS.scales.y, min: 0, max: 100 }
      },
      plugins: {
        ...CHART_BASE_OPTS.plugins,
        tooltip: { callbacks: { afterLabel: (ctx) => {
          const b = buckets[ctx.dataIndex];
          return `筆數 ${b.n} | 總P&L ${b.pnl.toFixed(0)}`;
        } } }
      }
    }
  });
}

function renderDowWR() {
  destroyChart("dowWR");
  const days = ["週日","週一","週二","週三","週四","週五","週六"];
  const buckets = Array.from({length:7}, () => ({ n:0, w:0, pnl:0 }));
  STATE.trades.forEach(t => {
    if (!t.entryT) return;
    const d = t.entryT.getUTCDay();
    buckets[d].n++;
    if (t.pnl > 0) buckets[d].w++;
    buckets[d].pnl += t.pnl;
  });
  const wr = buckets.map(b => b.n ? (b.w/b.n)*100 : null);
  const colors = buckets.map(b => b.pnl >= 0 ? COLORS.pos : COLORS.neg);
  STATE.charts.dowWR = new Chart($("chartDowWR"), {
    type: "bar",
    data: { labels: days, datasets: [{ label:"勝率(%)", data: wr, backgroundColor: colors, borderWidth: 0 }]},
    options: { ...CHART_BASE_OPTS, scales: { ...CHART_BASE_OPTS.scales, y: { ...CHART_BASE_OPTS.scales.y, min: 0, max: 100 } } }
  });
}

function renderPnLDist() {
  destroyChart("pnlDist");
  const pnls = STATE.trades.map(t => t.pnl);
  if (!pnls.length) return;
  const min = Math.min(...pnls), max = Math.max(...pnls);
  const nBins = 30;
  const w = (max - min) / nBins || 1;
  const bins = Array.from({length:nBins}, () => 0);
  pnls.forEach(p => {
    const idx = Math.min(nBins-1, Math.floor((p - min) / w));
    bins[idx]++;
  });
  const labels = bins.map((_,i) => (min + (i+0.5)*w).toFixed(0));
  const colors = bins.map((_,i) => (min + (i+0.5)*w) >= 0 ? COLORS.pos : COLORS.neg);
  STATE.charts.pnlDist = new Chart($("chartPnLDist"), {
    type: "bar",
    data: { labels, datasets: [{ label:"次數", data: bins, backgroundColor: colors, borderWidth: 0 }]},
    options: { ...CHART_BASE_OPTS, scales: { ...CHART_BASE_OPTS.scales, x: { ...CHART_BASE_OPTS.scales.x, ticks:{ color:"#8da0c0", maxTicksLimit: 10 } } } }
  });
}

// Convert minutes to a compact, human-readable string for chart labels & tooltips
function fmtHold(minutes) {
  if (!isFinite(minutes)) return "—";
  if (minutes < 60) return `${minutes.toFixed(0)}分`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes - h * 60);
    return m ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(minutes / 1440);
  const h = Math.round((minutes - d * 1440) / 60);
  return h ? `${d}d${h}h` : `${d}d`;
}

function renderHold() {
  destroyChart("hold");
  const holds = STATE.trades.map(t => t.holdMin).filter(h => h != null && isFinite(h));
  if (!holds.length) return;
  const min = Math.min(...holds), max = Math.max(...holds);
  const nBins = 20;
  const w = (max - min) / nBins || 1;
  const bins = Array.from({length:nBins}, () => ({n:0, pnl:0}));
  STATE.trades.forEach(t => {
    if (t.holdMin == null) return;
    const idx = Math.min(nBins-1, Math.floor((t.holdMin - min) / w));
    bins[idx].n++; bins[idx].pnl += t.pnl;
  });
  // Bin centers in minutes — show in compact units
  const centersMin = bins.map((_, i) => min + (i + 0.5) * w);
  const labels = centersMin.map(fmtHold);
  const colors = bins.map(b => b.pnl >= 0 ? COLORS.pos : COLORS.neg);
  STATE.charts.hold = new Chart($("chartHold"), {
    type: "bar",
    data: { labels, datasets: [{ label:"筆數", data: bins.map(b=>b.n), backgroundColor: colors, borderWidth: 0 }]},
    options: { ...CHART_BASE_OPTS,
      scales: {
        ...CHART_BASE_OPTS.scales,
        x: {
          ...CHART_BASE_OPTS.scales.x,
          title: { display: true, text: "持倉時間（每根 K 棒區間中位數）", color: "#8da0c0", font: { size: 10 } }
        },
        y: {
          ...CHART_BASE_OPTS.scales.y,
          title: { display: true, text: "筆數", color: "#8da0c0", font: { size: 10 } }
        }
      },
      plugins: {
        ...CHART_BASE_OPTS.plugins,
        tooltip: {
          callbacks: {
            title: ctx => `持倉約 ${fmtHold(centersMin[ctx[0].dataIndex])}（${centersMin[ctx[0].dataIndex].toFixed(0)} 分鐘）`,
            afterLabel: ctx => `總 P&L ${bins[ctx.dataIndex].pnl.toFixed(0)}`
          }
        }
      }
    }
  });
}

function renderRollWR() {
  destroyChart("rollWR");
  const W = 20;
  const t = STATE.trades;
  const wr = [], labels = [];
  for (let i = 0; i < t.length; i++) {
    const start = Math.max(0, i - W + 1);
    const slice = t.slice(start, i+1);
    const w = slice.filter(x => x.pnl > 0).length;
    wr.push((w / slice.length) * 100);
    labels.push(`#${i+1}`);
  }
  STATE.charts.rollWR = new Chart($("chartRollWR"), {
    type: "line",
    data: { labels, datasets: [{
      label: "滾動勝率 (Last 20)", data: wr,
      borderColor: COLORS.warn, backgroundColor: "rgba(251,191,36,0.15)",
      fill: false, pointRadius: 0, borderWidth: 1.5, tension: 0.15
    }]},
    options: { ...CHART_BASE_OPTS,
      scales: { ...CHART_BASE_OPTS.scales,
        y: { ...CHART_BASE_OPTS.scales.y, min: 0, max: 100 },
        x: { ticks:{ display:false }, grid:{ color:"#1a1f2c" } }
      }
    }
  });
}

function renderLongShort() {
  const longs = STATE.trades.filter(t => t.side === "long");
  const shorts = STATE.trades.filter(t => t.side === "short");
  function stats(arr) {
    const n = arr.length;
    const w = arr.filter(t => t.pnl > 0).length;
    const wr = n ? w/n : 0;
    const pnl = arr.reduce((s,t)=>s+t.pnl, 0);
    const avg = n ? pnl/n : 0;
    const gw = arr.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
    const gl = Math.abs(arr.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
    const pf = gl>0 ? gw/gl : (gw>0?Infinity:0);
    return { n, wr, pnl, avg, pf };
  }
  const L = stats(longs), S = stats(shorts);
  $("longShortTable").innerHTML = `
  <table class="compare-table">
    <thead><tr><th>方向</th><th>筆數</th><th>勝率</th><th>總P&L</th><th>均/筆</th><th>PF</th></tr></thead>
    <tbody>
      <tr><td>Long</td><td>${L.n}</td><td class="${L.wr>=0.5?'pos':'neg'}">${pct(L.wr)}</td><td class="${L.pnl>=0?'pos':'neg'}">${fmt(L.pnl)}</td><td class="${L.avg>=0?'pos':'neg'}">${fmt(L.avg)}</td><td class="${L.pf>=1?'pos':'neg'}">${isFinite(L.pf)?L.pf.toFixed(2):"∞"}</td></tr>
      <tr><td>Short</td><td>${S.n}</td><td class="${S.wr>=0.5?'pos':'neg'}">${pct(S.wr)}</td><td class="${S.pnl>=0?'pos':'neg'}">${fmt(S.pnl)}</td><td class="${S.avg>=0?'pos':'neg'}">${fmt(S.avg)}</td><td class="${S.pf>=1?'pos':'neg'}">${isFinite(S.pf)?S.pf.toFixed(2):"∞"}</td></tr>
    </tbody>
  </table>`;
}

function renderReason() {
  const byReason = new Map();
  STATE.trades.forEach(t => {
    const r = t.reason;
    if (!byReason.has(r)) byReason.set(r, { n:0, w:0, pnl:0 });
    const b = byReason.get(r);
    b.n++; if (t.pnl > 0) b.w++; b.pnl += t.pnl;
  });
  const rows = Array.from(byReason.entries()).map(([reason, b]) => `
    <tr>
      <td>${reason}</td>
      <td>${b.n}</td>
      <td class="${b.w/b.n>=0.5?'pos':'neg'}">${pct(b.w/b.n)}</td>
      <td class="${b.pnl>=0?'pos':'neg'}">${fmt(b.pnl)}</td>
      <td class="${b.pnl>=0?'pos':'neg'}">${fmt(b.pnl/b.n)}</td>
    </tr>`).join("");
  $("reasonTable").innerHTML = `
    <table class="reason-table">
      <thead><tr><th>原因</th><th>筆數</th><th>勝率</th><th>總P&L</th><th>均/筆</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}


function renderTradeList() {
  const tbody = document.querySelector("#anaTradeTable tbody");
  tbody.innerHTML = STATE.trades.slice().reverse().map(t => `
    <tr>
      <td>${t.i}</td>
      <td class="${t.side==='long'?'pos':'neg'}">${t.side==='long'?'L':'S'}</td>
      <td>${t.entryT?t.entryT.toISOString().slice(0,16).replace('T',' '):'—'}</td>
      <td>${t.entryPrice.toFixed(3)}</td>
      <td>${t.exitT?t.exitT.toISOString().slice(0,16).replace('T',' '):'—'}</td>
      <td>${t.exitPrice.toFixed(3)}</td>
      <td>${t.size}</td>
      <td title="${t.holdMin!=null?t.holdMin.toFixed(0)+' 分鐘':''}">${t.holdMin!=null?fmtHold(t.holdMin):'—'}</td>
      <td>${t.reason}</td>
      <td class="${t.pnl>=0?'pos':'neg'}">${fmt(t.pnl)}</td>
    </tr>`).join("");
  $("tradeCount").textContent = `(共 ${STATE.trades.length} 筆)`;
}

// ============================================================
// Master render
// ============================================================
function render() {
  if (!STATE.trades.length) return;
  $("anaEmpty").style.display = "none";
  $("anaMain").style.display = "grid";
  renderKPIs();
  renderEquity();
  renderDD();
  renderMonthly();
  renderHourWR();
  renderDowWR();
  renderPnLDist();
  renderHold();
  renderRollWR();
  renderLongShort();
  renderReason();
  renderTradeList();
}

// ============================================================
// i18n — read lang from practice page's localStorage (sync)
// ============================================================
const V2_LS_KEY = "practice_trading_v2_ui";

function getLang() {
  try {
    const s = JSON.parse(localStorage.getItem(V2_LS_KEY) || "{}");
    return s.lang || "zh-TW";
  } catch(e) { return "zh-TW"; }
}

const ANA_I18N = {
  "zh-TW": {
    "ana.title": "績效分析",
    "ana.importCsv": "匯入交易紀錄",
    "ana.loadFromSession": "從練習頁載入",
    "ana.back": "← 返回練習頁",
    "ana.empty.title": "請載入交易紀錄",
    "ana.empty.intro": "三種方式：",
    "ana.empty.way1": "從練習頁右上「→ 分析頁」開啟（自動帶入當前 session）",
    "ana.empty.way2": "本頁點「從練習頁載入」（讀 localStorage）",
    "ana.empty.way3": "本頁點「匯入交易紀錄」上傳之前匯出的 trades CSV",
    "ana.card.summary": "總覽 Summary",
    "ana.card.equity": "權益曲線 Equity Curve",
    "ana.card.dd": "回撤 Drawdown",
    "ana.card.monthly": "月度損益 Monthly P&L",
    "ana.card.hourWR": "進場時段勝率 (UTC Hour)",
    "ana.card.dowWR": "星期幾勝率 Day-of-Week",
    "ana.card.pnlDist": "P&L 分佈 Distribution",
    "ana.card.hold": "持倉時間分佈 Holding Time",
    "ana.card.rollWR": "滾動勝率 (Last 20)",
    "ana.card.longShort": "Long vs Short 對比",
    "ana.card.reason": "出場原因分析 (SL / TP / Manual)",
    "ana.card.tradeList": "交易明細 Trade List",
    "ana.tbl.entryTime": "進場時間",
    "ana.tbl.entryPrice": "進場價",
    "ana.tbl.exitTime": "出場時間",
    "ana.tbl.exitPrice": "出場價",
    "ana.tbl.size": "口數",
    "ana.tbl.hold": "持倉(分)",
    "log.idx": "#",
    "log.side": "方向",
    "log.reason": "原因",
    "log.pnl": "P&L"
  },
  "en-US": {
    "ana.title": "Performance Analysis",
    "ana.importCsv": "Import Trades",
    "ana.loadFromSession": "Load from Practice",
    "ana.back": "← Back to Practice",
    "ana.empty.title": "No trades loaded",
    "ana.empty.intro": "Three ways:",
    "ana.empty.way1": "Open via '→ Analytics' from Practice page (auto-load current session)",
    "ana.empty.way2": "Click 'Load from Practice' here (reads localStorage)",
    "ana.empty.way3": "Click 'Import Trades' to upload a previously exported trades CSV",
    "ana.card.summary": "Summary",
    "ana.card.equity": "Equity Curve",
    "ana.card.dd": "Drawdown",
    "ana.card.monthly": "Monthly P&L",
    "ana.card.hourWR": "Hour-of-Day Win Rate (UTC)",
    "ana.card.dowWR": "Day-of-Week Win Rate",
    "ana.card.pnlDist": "P&L Distribution",
    "ana.card.hold": "Holding Time Distribution",
    "ana.card.rollWR": "Rolling Win Rate (Last 20)",
    "ana.card.longShort": "Long vs Short",
    "ana.card.reason": "Exit Reason Breakdown (SL / TP / Manual)",
    "ana.card.tradeList": "Trade List",
    "ana.tbl.entryTime": "Entry time",
    "ana.tbl.entryPrice": "Entry",
    "ana.tbl.exitTime": "Exit time",
    "ana.tbl.exitPrice": "Exit",
    "ana.tbl.size": "Size",
    "ana.tbl.hold": "Hold (min)",
    "log.idx": "#",
    "log.side": "Side",
    "log.reason": "Reason",
    "log.pnl": "P&L"
  }
};

let ANA_LANG = getLang();

function applyAnaI18n() {
  const dict = ANA_I18N[ANA_LANG] || ANA_I18N["zh-TW"];
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const k = el.dataset.i18n;
    if (dict[k] !== undefined) el.textContent = dict[k];
  });
  document.documentElement.lang = ANA_LANG === "en-US" ? "en" : "zh-TW";
}
applyAnaI18n();

// Listen for storage changes — if user switches lang on practice page,
// analytics page picks it up on next focus or storage event
window.addEventListener("storage", (e) => {
  if (e.key === V2_LS_KEY) {
    ANA_LANG = getLang();
    applyAnaI18n();
  }
});
// Also re-apply on focus (covers same-window navigation cases)
window.addEventListener("focus", () => {
  const newLang = getLang();
  if (newLang !== ANA_LANG) {
    ANA_LANG = newLang;
    applyAnaI18n();
  }
});
