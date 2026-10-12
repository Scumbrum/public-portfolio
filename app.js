const GOAL = 10000;
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
// yahoo-finance2 is published on jsDelivr, but it cannot run in the browser:
// Yahoo's chart API does not send CORS headers. proxy.cors.dev only adds those headers.
const CORS_PROXY = 'https://proxy.cors.dev/?';

const canvas = document.getElementById('chart');
const tooltip = document.getElementById('tooltip');
const ctx = canvas.getContext('2d');

const VIOLET = '#c4b5fd';
const AXIS = '#a89bc4';
const GRID = 'rgba(196, 181, 253, 0.12)';

let snapshot = null;
let period = '1y';
let series = [];
let hoverIndex = null;
let layout = null;

const money = (value) => {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const signedMoney = (value) => `${value > 0 ? '+' : ''}${money(value)}`;

const pct = (value) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

const fmtDate = (iso) => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function historyStart() {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);
  return start;
}

function periodStart(id) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (id === '7d') start.setDate(start.getDate() - 7);
  else if (id === '1m') start.setMonth(start.getMonth() - 1);
  else if (id === '1y') start.setFullYear(start.getFullYear() - 1);
  else start.setMonth(0, 1);
  return start.toISOString().slice(0, 10);
}

async function fetchChart(ticker) {
  const period1 = Math.floor(historyStart().getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const yahooUrl =
    `${YAHOO_CHART}${encodeURIComponent(ticker)}` +
    `?interval=1d&period1=${period1}&period2=${period2}`;

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(CORS_PROXY + encodeURIComponent(yahooUrl));
    if (response.status === 429) {
      lastError = new Error(`Yahoo rate limit for ${ticker}`);
      await new Promise((resolve) => setTimeout(resolve, 700 * 2 ** attempt));
      continue;
    }
    if (!response.ok) throw new Error(`Yahoo chart HTTP ${response.status} for ${ticker}`);
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    if (!result?.timestamp?.length) {
      throw new Error(payload?.chart?.error?.description || `No chart data for ${ticker}`);
    }
    const quote = result.indicators?.quote?.[0] ?? {};
    const history = result.timestamp
      .map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        close: quote.close?.[i] ?? null,
      }))
      .filter((row) => row.close != null && row.close > 0);
    const currentPrice = result.meta?.regularMarketPrice ?? history.at(-1)?.close ?? null;
    const name = result.meta?.shortName || result.meta?.longName || ticker;
    return { history, currentPrice, name };
  }
  throw lastError ?? new Error(`Failed to load ${ticker}`);
}

function holdingsFromActions(actions) {
  const grouped = new Map();
  for (const action of actions) {
    const ticker = String(action.asset ?? action.ticker ?? '').trim().toUpperCase();
    const amount = Number(action.amount);
    const price = Number(action.price);
    if (!ticker || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price)) continue;

    const held = grouped.get(ticker) ?? { ticker, amount: 0, price: 0 };
    if (String(action.side).toUpperCase() === 'SELL') {
      held.amount = Math.max(0, round(held.amount - amount, 4));
      if (held.amount === 0) held.price = 0;
    } else {
      const nextAmount = held.amount + amount;
      held.price = (held.amount * held.price + amount * price) / nextAmount;
      held.amount = round(nextAmount, 4);
    }
    grouped.set(ticker, held);
  }
  return [...grouped.values()].filter((holding) => holding.amount > 0);
}

function buildHistory(assets, charts) {
  const maps = {};
  const dates = new Set();
  for (const asset of assets) {
    const ticker = String(asset.ticker).toUpperCase();
    const rows = charts[ticker]?.history ?? [];
    maps[ticker] = new Map(rows.map((row) => [row.date, row.close]));
    for (const row of rows) dates.add(row.date);
  }

  const last = {};
  const points = [];
  for (const date of [...dates].sort()) {
    let value = 0;
    let complete = true;
    for (const asset of assets) {
      const ticker = String(asset.ticker).toUpperCase();
      const close = maps[ticker].get(date);
      if (close != null) last[ticker] = close;
      if (last[ticker] == null) {
        complete = false;
        break;
      }
      value += asset.amount * last[ticker];
    }
    if (complete) points.push({ date, value: round(value, 2) });
  }
  return points;
}

function buildSnapshot(actions, charts, errors) {
  const assets = holdingsFromActions(actions);
  const positions = assets.map((asset) => {
    const ticker = asset.ticker;
    const currentPrice = charts[ticker]?.currentPrice ?? null;
    const cost = asset.amount * asset.price;
    const value = currentPrice == null ? null : asset.amount * currentPrice;
    const returnAbs = value == null ? null : value - cost;
    const returnPct = value == null || cost === 0 ? null : (returnAbs / cost) * 100;
    return {
      name: charts[ticker]?.name || ticker,
      ticker,
      amount: asset.amount,
      price: round(asset.price, 4),
      currentPrice: currentPrice == null ? null : round(currentPrice, 2),
      cost: round(cost, 2),
      value: value == null ? null : round(value, 2),
      returnAbs: returnAbs == null ? null : round(returnAbs, 2),
      returnPct: returnPct == null ? null : round(returnPct, 2),
    };
  });

  const priced = positions.filter((position) => position.value != null);
  const value = priced.reduce((sum, position) => sum + position.value, 0);
  const cost = priced.reduce((sum, position) => sum + position.cost, 0);
  const returnAbs = value - cost;

  return {
    goal: GOAL,
    errors,
    positions,
    totals: {
      value: round(value, 2),
      cost: round(cost, 2),
      returnAbs: round(returnAbs, 2),
      returnPct: cost === 0 ? null : round((returnAbs / cost) * 100, 2),
    },
    history: buildHistory(assets, charts),
    actions,
  };
}

function sliceHistory() {
  const start = periodStart(period);
  const rows = (snapshot?.history ?? []).filter((row) => row.date >= start);
  return rows.length ? rows : (snapshot?.history ?? []).slice(-2);
}

function renderStats() {
  const totals = snapshot?.totals;
  const amount = document.getElementById('total-amount');
  const ret = document.getElementById('total-return');
  if (!totals || totals.value == null) {
    amount.textContent = '—';
    ret.textContent = '—';
    ret.className = '';
    return;
  }
  amount.textContent = money(totals.value);
  if (totals.returnPct == null) {
    ret.textContent = '—';
    ret.className = '';
    return;
  }
  ret.textContent = `${signedMoney(totals.returnAbs)} (${pct(totals.returnPct)})`;
  ret.className = totals.returnAbs >= 0 ? 'up' : 'down';
}

function renderWindow() {
  const label = document.getElementById('window-return');
  if (series.length < 2) {
    label.textContent = series.length ? 'Not enough history in this window' : 'No history yet';
    label.className = 'muted';
    return;
  }
  const first = series[0].value;
  const last = series[series.length - 1].value;
  const change = last - first;
  const changePct = first === 0 ? null : (change / first) * 100;
  label.textContent = changePct == null
    ? signedMoney(change)
    : `${signedMoney(change)} (${pct(changePct)})`;
  label.className = change >= 0 ? 'up' : 'down';
}

function renderPositions() {
  const body = document.getElementById('positions');
  const positions = snapshot?.positions ?? [];
  if (!positions.length) {
    body.innerHTML = '<tr><td class="empty" colspan="6">Add an action in data.js.</td></tr>';
    return;
  }
  body.innerHTML = positions.map((position) => `
    <tr>
      <td>${escapeHtml(position.name)}</td>
      <td>${escapeHtml(position.ticker)}</td>
      <td>${position.amount}</td>
      <td>${money(position.price)}</td>
      <td>${position.currentPrice == null ? '—' : money(position.currentPrice)}</td>
      <td>${position.value == null ? '—' : money(position.value)}</td>
    </tr>
  `).join('');
}

function assetLabel(action) {
  const raw = String(action.asset ?? action.ticker ?? '').trim();
  const position = (snapshot?.positions ?? []).find((item) => item.ticker === raw.toUpperCase());
  return position ? `${position.name} (${position.ticker})` : raw;
}

function renderActions() {
  const list = document.getElementById('action-list');
  const actions = snapshot?.actions ?? [];
  if (!actions.length) {
    list.innerHTML = '<li class="empty">No actions in data.js.</li>';
    return;
  }
  list.innerHTML = actions.map((action) => {
    const side = String(action.side ?? '').toUpperCase();
    const when = action.date || action.at;
    return `
      <li>
        <span class="${side === 'BUY' ? 'side-buy' : 'side-sell'}">${escapeHtml(side)}</span>
        <span>${escapeHtml(assetLabel(action))}</span>
        <span>${action.amount} @ ${money(Number(action.price))}</span>
        ${when ? `<span class="muted">${fmtDate(String(when).slice(0, 10))}</span>` : ''}
      </li>
    `;
  }).join('');
}

function renderProgress() {
  const value = snapshot?.totals?.value ?? 0;
  const ratio = Math.max(0, Math.min(1, value / GOAL));
  document.getElementById('progress-fill').style.width = `${ratio * 100}%`;
  document.getElementById('progress-label').textContent = `${money(value)} of ${money(GOAL)}`;
  const bar = document.querySelector('.bar');
  bar.setAttribute('aria-valuenow', String(Math.round(value)));
  bar.setAttribute('aria-valuetext', `${money(value)} of ${money(GOAL)}`);
}

function renderBanner() {
  const banner = document.getElementById('banner');
  const errors = snapshot?.errors ?? [];
  banner.hidden = errors.length === 0;
  banner.textContent = errors.map((error) => `${error.ticker}: ${error.message}`).join(' · ');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function applySnapshot(next) {
  snapshot = next;
  series = sliceHistory();
  renderStats();
  renderWindow();
  renderPositions();
  renderActions();
  renderProgress();
  renderBanner();
  draw();
}

function buildLayout(cssW, cssH) {
  const pad = { top: 24, right: 24, bottom: 36, left: 72 };
  const w = cssW - pad.left - pad.right;
  const h = cssH - pad.top - pad.bottom;
  const values = series.map((row) => row.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(Math.abs(max) * 0.08, 1);
  const minVal = min - span * 0.12;
  const maxVal = max + span * 0.12;
  const xAt = (i) => pad.left + (w / Math.max(series.length - 1, 1)) * i;
  const yAt = (value) => pad.top + h - ((value - minVal) / (maxVal - minVal)) * h;
  return { pad, w, h, minVal, maxVal, xAt, yAt, cssW, cssH };
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 960;
  const cssH = Math.round(cssW * (420 / 960));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (series.length < 2) {
    layout = null;
    ctx.fillStyle = AXIS;
    ctx.font = '14px Segoe UI, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('History will appear after Yahoo Finance returns prices.', cssW / 2, cssH / 2);
    return;
  }

  layout = buildLayout(cssW, cssH);
  const { pad, w, h, minVal, maxVal, xAt, yAt } = layout;

  ctx.font = '12px Segoe UI, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const value = minVal + ((maxVal - minVal) / 4) * i;
    const y = yAt(value);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + w, y);
    ctx.stroke();
    ctx.fillStyle = AXIS;
    ctx.fillText(money(value), pad.left - 10, y);
  }

  ctx.textBaseline = 'top';
  const ticks = Math.min(cssW < 520 ? 2 : cssW < 760 ? 3 : 5, series.length);
  for (let i = 0; i < ticks; i++) {
    const index = Math.round((i / (ticks - 1 || 1)) * (series.length - 1));
    const label = fmtDate(series[index].date);
    const x = xAt(index);
    const labelWidth = ctx.measureText(label).width;
    let align = 'center';
    let drawX = x;
    if (x - labelWidth / 2 < pad.left) {
      align = 'left';
      drawX = Math.max(x, 4);
    } else if (x + labelWidth / 2 > cssW - 8) {
      align = 'right';
      drawX = Math.min(x, cssW - 8);
    }
    ctx.textAlign = align;
    ctx.fillStyle = AXIS;
    ctx.fillText(label, drawX, pad.top + h + 12);
  }

  const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + h);
  gradient.addColorStop(0, 'rgba(167, 139, 250, 0.45)');
  gradient.addColorStop(1, 'rgba(167, 139, 250, 0)');
  ctx.beginPath();
  series.forEach((row, i) => {
    const x = xAt(i);
    const y = yAt(row.value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(xAt(series.length - 1), pad.top + h);
  ctx.lineTo(xAt(0), pad.top + h);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  series.forEach((row, i) => {
    const x = xAt(i);
    const y = yAt(row.value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = VIOLET;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.stroke();

  if (hoverIndex != null && series[hoverIndex]) {
    const x = xAt(hoverIndex);
    const y = yAt(series[hoverIndex].value);
    ctx.strokeStyle = 'rgba(245, 243, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + h);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#f5f3ff';
    ctx.fill();
  }
}

function moveTooltip(event) {
  if (!layout || series.length < 2) {
    tooltip.hidden = true;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  let nearest = 0;
  let best = Infinity;
  series.forEach((_, i) => {
    const distance = Math.abs(layout.xAt(i) - x);
    if (distance < best) {
      best = distance;
      nearest = i;
    }
  });
  if (nearest === hoverIndex && !tooltip.hidden) {
    placeTooltip(event, nearest);
    return;
  }
  hoverIndex = nearest;
  draw();
  const row = series[nearest];
  tooltip.hidden = false;
  tooltip.innerHTML = `<strong>${fmtDate(row.date)}</strong><br>${money(row.value)}`;
  placeTooltip(event, nearest);
}

function placeTooltip(event, index) {
  const rect = canvas.getBoundingClientRect();
  const wrap = canvas.parentElement.getBoundingClientRect();
  const pointX = layout.xAt(index);
  const left = Math.min(Math.max(pointX + 12, 8), wrap.width - tooltip.offsetWidth - 8);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(event.clientY - rect.top - 56, 8)}px`;
}

canvas.addEventListener('mousemove', moveTooltip);
canvas.addEventListener('mouseleave', () => {
  hoverIndex = null;
  tooltip.hidden = true;
  draw();
});
window.addEventListener('resize', draw);

document.querySelectorAll('.periods button').forEach((button) => {
  button.addEventListener('click', () => {
    period = button.dataset.period;
    document.querySelectorAll('.periods button').forEach((item) => {
      item.classList.toggle('active', item === button);
    });
    series = sliceHistory();
    hoverIndex = null;
    tooltip.hidden = true;
    renderWindow();
    draw();
  });
});

async function load() {
  try {
    const actions = ACTIONS;
    const tickers = holdingsFromActions(actions).map((holding) => holding.ticker);
    const charts = {};
    const errors = [];
    for (const ticker of tickers) {
      try {
        charts[ticker] = await fetchChart(ticker);
      } catch (err) {
        errors.push({ ticker, message: err.message });
      }
    }
    applySnapshot(buildSnapshot(actions, charts, errors));
  } catch (err) {
    document.getElementById('window-return').textContent = err.message || 'Could not load portfolio';
  }
}

load();
