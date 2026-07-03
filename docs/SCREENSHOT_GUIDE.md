# Screenshot Guide

Place all images in `docs/screenshots/`. README references these filenames — keep them consistent.

## 1. `hero.gif` (highest priority)
**What**: 15–25 second GIF showing "one full practice loop"
**How**: Record with Kap (macOS) or ScreenToGif (Windows). Recommended: 900×500, ≤ 6 MB.

**Recording script**:
1. Start on empty state, click "匯入 CSV" and load sample
2. Chart appears — hover over price to show OHLC readout
3. Click ↖ tool → draw one trend line + one horizontal line
4. Right sidebar: pick a template from "自訂指標" (BB %B or similar), close modal
5. Click "買進 / Long" — position card appears
6. Step forward 3–5 bars (SL/TP line moves with price)
7. Click × on position card → trade recorded
8. Click "→ 分析頁" at top — new tab opens with dashboard

## 2. `practice.png` (~1600×900)
**What**: The main practice view with visible richness
**Setup**:
- Load sample data, cursor at a period with clear trend
- Have: BB visible, 2-3 MAs, KDJ + MACD + ATR subpanels
- One open Long position with SL/TP lines visible on chart
- 1-2 drawing elements (trend line + horizontal support line)
- Sidebar on "下單" tab, showing position card + margin info

## 3. `block-editor.png` (~1200×800)
**What**: The custom indicator block-mode editor — this is your differentiator
**Setup**:
- Open "自訂指標" tab → "+ 新增自訂"
- Pick template "BB Percent B" from dropdown
- Switch to "🧩 方塊模式" tab (default)
- Screenshot with the block tree visible and the palette on the left side

**Alternative**: Take one screenshot each of text mode and block mode side-by-side (`block-editor.png` and `text-editor.png`) — even more impressive.

## 4. `analytics.png` (~1600×900)
**What**: Analytics dashboard with real trade data
**Setup**:
- Trade at least 15–20 times in practice (or import a trades CSV)
- Click "→ 分析頁"
- Scroll so equity curve + KPI summary + monthly P&L are visible

## 5. `positions.png` (~800×600)
**What**: Sidebar close-up showing multi-position management
**Setup**:
- Open at least 2 Long + 2 Short positions
- Set different SL/TP on each
- Screenshot the right sidebar only (crop tight)
- Should show: margin info bar (with maintenance % coloring), 4 position cards, 全平多單/全平空單 buttons

## Optional but nice

### `settings.png` (~600×400)
Just the settings popover open (⚙ icon top-right), showing theme/candle/language pills.

### `drawing-tools.gif` (10s)
Show drawing a trend line, dragging it to reposition, Ctrl+C then Ctrl+V, delete.

### `custom-indicator-flow.gif` (30s)
Open editor → pick template → switch text/block mode → save → apply to chart.

---

## Tools

**GIF**:
- [Kap](https://getkap.co/) (macOS, free)
- [ScreenToGif](https://www.screentogif.com/) (Windows, free)
- [Peek](https://github.com/phw/peek) (Linux)

**PNG**:
- Built-in OS screenshot tools (`Cmd+Shift+4` on macOS, `Win+Shift+S` on Windows)
- For polished framing: [CleanShot X](https://cleanshot.com/) macOS

**Optimizing**:
- GIFs > 5 MB: run through [ezgif.com/optimize](https://ezgif.com/optimize)
- PNGs: run through [tinypng.com](https://tinypng.com/) (often 60–70% smaller with no visible loss)

---

## After adding images

Once all screenshots are in `docs/screenshots/`, replace the two placeholders in README.md:

1. `YOUR_USERNAME` → your GitHub username (2 occurrences)
2. Verify all image paths resolve
