/* 波波酪梨 · 酪梨行情  app.js  v1.0.3
 * ─────────────────────────────────────────────────────────
 * 資料來源：農業部農業資料開放平臺「農產品交易行情」
 *   https://data.moa.gov.tw/api/v1/AgriProductsTransType/
 * 不需 API 金鑰，回應標頭帶 access-control-allow-origin: *，前端可直接讀取。
 * 因此本 App 不經 GAS、不經 Firebase，完全獨立於訂單系統。
 */
'use strict';

const VERSION   = 'v1.0.3';
const API       = 'https://data.moa.gov.tw/api/v1/AgriProductsTransType/';
const CROP_NAME = '酪梨';   // 查詢用：實測可正常過濾
const CROP_CODE = 'G3';     // 本地過濾用：排除 G39 進口，以及 CropCode 為 "-" 的休市列
const FETCH_DAYS = 40;      // 一次抓 40 天，7 日／30 日兩種檢視都不必重抓

const MARKETS = [
  { code: '109', name: '台北一', cls: 'm109', color: '#6F9A46' },
  { code: '104', name: '台北二', cls: 'm104', color: '#6B563C' },
  { code: '241', name: '三重區', cls: 'm241', color: '#C08A2B' }
];
const MK = {};
MARKETS.forEach(m => { MK[m.code] = m; });

const LS_ROWS = 'probroMarketRows';
const LS_AT   = 'probroMarketAt';
const STALE_MS = 20 * 60 * 60 * 1000;   // 超過 20 小時視為過期（行情一天更新一次）

/* ── 狀態 ──────────────────────────────────────────────── */
const S = {
  rows: [],          // [{d:'2026-08-21', mc:'109', up, mid, low, avg, qty}]
  fetchedAt: null,
  days: 7,           // 7 或 30
  metric: 'avg',     // 'avg' 均價 ｜ 'qty' 交易量
  loading: false,
  err: '',
  chart: null
};

/* ── 小工具 ────────────────────────────────────────────── */
const $  = s => document.querySelector(s);
const p2 = n => ('0' + n).slice(-2);
const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

let toastTimer;
function toast(msg, ms = 1900) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('on', !!msg);
  if (!msg) return;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/** Date → 民國字串，例：2026-08-21 → "115.08.21" */
const 民國 = d => `${d.getFullYear() - 1911}.${p2(d.getMonth() + 1)}.${p2(d.getDate())}`;

/** 民國字串 → ISO 日期，例："115.08.21" → "2026-08-21"；格式不符回 null */
function 西元(s) {
  const m = /^(\d{2,3})\.(\d{1,2})\.(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return `${(+m[1]) + 1911}-${p2(+m[2])}-${p2(+m[3])}`;
}

const 月日 = iso => iso ? iso.slice(5).replace('-', '/') : '';

const 週 = iso => ['日', '一', '二', '三', '四', '五', '六'][new Date(iso + 'T00:00:00').getDay()];

function 時刻(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const 錢 = n => (n == null || !isFinite(n)) ? '—'
  : (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');

function 公斤(n) {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + ' 噸';
  return Math.round(n).toLocaleString('zh-TW') + ' kg';
}

/* ── 取得資料 ──────────────────────────────────────────── */

/**
 * 只用 Start_time / End_time / CropName 三個參數。
 * 市場與品項代號都在本地過濾——API 的 MarketName 一次只吃一個市場，
 * 而且多填參數是 AND 條件，填越多越容易整組落空。
 */
async function 抓資料() {
  const end = new Date();
  const start = new Date(end.getTime() - FETCH_DAYS * 864e5);
  const url = `${API}?Start_time=${民國(start)}&End_time=${民國(end)}`
            + `&CropName=${encodeURIComponent(CROP_NAME)}`;

  const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error('伺服器回應 ' + res.status);

  const j = await res.json();
  if (!j || !Array.isArray(j.Data)) throw new Error('回傳格式不符預期');
  return 整理(j.Data);
}

/**
 * API 會夾帶兩種不要的列：
 *   1. CropCode "G39"／CropName "酪梨-進口"
 *   2. CropCode "-"／CropName "休市"，價格與交易量全為 0
 * 注意：同一天同一市場可能「休市列」與「交易列」並存（實測 8/16 台中市），
 * 所以不能用「當天有休市列就整天跳過」，只能認 CropCode。
 */
function 整理(data) {
  const map = new Map();
  data.forEach(o => {
    if (String(o.CropCode) !== CROP_CODE) return;
    const mc = String(o.MarketCode);
    if (!MK[mc]) return;
    const d = 西元(o.TransDate);
    if (!d) return;

    const row = {
      d, mc,
      up:  +o.Upper_Price,
      mid: +o.Middle_Price,
      low: +o.Lower_Price,
      avg: +o.Avg_Price,
      qty: +o.Trans_Quantity
    };
    if (!(row.qty > 0) && !(row.avg > 0)) return;

    // 保險：同日同市場若出現重複列，保留交易量較大的那筆
    const key = d + '|' + mc;
    const prev = map.get(key);
    if (!prev || row.qty > prev.qty) map.set(key, row);
  });
  return [...map.values()].sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
}

function 讀快取() {
  try {
    const raw = localStorage.getItem(LS_ROWS);
    if (!raw) return false;
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || !rows.length) return false;
    S.rows = rows;
    S.fetchedAt = localStorage.getItem(LS_AT) || null;
    return true;
  } catch (e) { return false; }
}

function 寫快取() {
  try {
    localStorage.setItem(LS_ROWS, JSON.stringify(S.rows));
    localStorage.setItem(LS_AT, S.fetchedAt);
  } catch (e) { /* 容量滿或隱私模式，不影響本次使用 */ }
}

async function 更新(手動) {
  if (S.loading) return;
  S.loading = true; S.err = '';
  畫面();
  try {
    S.rows = await 抓資料();
    S.fetchedAt = new Date().toISOString();
    寫快取();
    if (手動) toast('已更新');
  } catch (e) {
    S.err = String(e.message || e);
    if (手動) toast('更新失敗\n' + S.err, 2600);
  } finally {
    S.loading = false;
    畫面();
  }
}

/* ── 統計 ──────────────────────────────────────────────── */

/** 期間內的日期清單（僅取實際有交易的日子，遞增） */
function 期間日期(rows) {
  return [...new Set(rows.map(r => r.d))].sort();
}

function 期間資料() {
  if (!S.rows.length) return [];
  const all = 期間日期(S.rows);
  const keep = new Set(all.slice(-S.days));
  return S.rows.filter(r => keep.has(r.d));
}

/**
 * 交易量加權平均價。
 * 不是「每日均價再取算術平均」——那會讓量很小的日子和量很大的日子等重，
 * 拿來當成本基準會失真。
 */
function 加權均價(rows) {
  let s = 0, q = 0;
  rows.forEach(r => { if (r.qty > 0 && r.avg > 0) { s += r.avg * r.qty; q += r.qty; } });
  return q ? s / q : null;
}

/* ── 走勢圖 ────────────────────────────────────────────── */

/** 把座標軸切成好讀的刻度：40/50/60，而不是 42.4/47.7/53.1 */
function 好刻度(range, 目標段數) {
  const raw = range / 目標段數;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

function 走勢圖(rows) {
  const dates = 期間日期(rows);
  if (dates.length < 2) return '<div class="empty">這個期間的資料還不足以畫出走勢</div>';

  const idx = {};
  dates.forEach((d, i) => { idx[d] = i; });

  const series = MARKETS.map(m => {
    const pts = new Array(dates.length).fill(null);
    rows.forEach(r => {
      if (r.mc !== m.code) return;
      const v = S.metric === 'avg' ? r.avg : r.qty;
      if (v > 0) pts[idx[r.d]] = v;
    });
    return { m, pts };
  });

  // PR 要留得下最右邊的日期標籤；首尾標籤改成靠邊對齊，就不會溢出畫布
  const W = 340, H = 172, PL = 40, PR = 14, PT = 12, PB = 26;
  const iw = W - PL - PR, ih = H - PT - PB;

  let lo = Infinity, hi = -Infinity;
  series.forEach(s => s.pts.forEach(v => {
    if (v == null) return;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }));
  if (!isFinite(lo)) return '<div class="empty">這個期間沒有交易資料</div>';

  if (S.metric === 'qty') lo = 0;
  if (lo === hi) { lo = lo * 0.9; hi = hi * 1.1 || 1; }

  const step = 好刻度(hi - lo || 1, 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (hi === lo) hi = lo + step;
  if (lo < 0) lo = 0;

  const X = i => PL + (dates.length <= 1 ? iw / 2 : iw * i / (dates.length - 1));
  const Y = v => PT + ih * (1 - (v - lo) / (hi - lo));

  let g = '';

  for (let v = lo; v <= hi + 1e-9; v += step) {
    const y = Y(v);
    const lab = S.metric === 'avg'
      ? 錢(v)
      : (v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v));
    g += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}"
            stroke="#E4DED2" stroke-width="1"/>`;
    g += `<text x="${PL - 6}" y="${(y + 3.6).toFixed(1)}" text-anchor="end"
            font-size="10" fill="#8A7C6C" font-weight="600">${lab}</text>`;
  }

  const 末 = dates.length - 1;
  const labIdx = dates.length <= 4
    ? dates.map((_, i) => i)
    : [0, Math.round(末 / 3), Math.round(末 * 2 / 3), 末];
  [...new Set(labIdx)].forEach(i => {
    const anchor = i === 0 ? 'start' : i === 末 ? 'end' : 'middle';
    g += `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}"
            font-size="10" fill="#8A7C6C" font-weight="600">${月日(dates[i])}</text>`;
  });

  // 讀數游標：先畫，讓折線壓在上面
  g += `<line id="xh" x1="${X(末).toFixed(1)}" y1="${PT}" x2="${X(末).toFixed(1)}"
          y2="${PT + ih}" stroke="#3E3226" stroke-width="1.5" opacity="0.28"/>`;

  series.forEach(s => {
    const pl = [];
    s.pts.forEach((v, i) => {
      if (v == null) return;        // 該市場當天休市 → 跨過，線接續
      pl.push(`${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
    });
    if (!pl.length) return;
    if (pl.length === 1) {
      const [x, y] = pl[0].split(',');
      g += `<circle cx="${x}" cy="${y}" r="3" fill="${s.m.color}"/>`;
    } else {
      g += `<polyline points="${pl.join(' ')}" fill="none" stroke="${s.m.color}"
              stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
  });

  // 游標上的圓點，位置由 更新讀數() 控制
  series.forEach(s => {
    g += `<circle class="xhDot" data-mc="${s.m.code}" cx="0" cy="0" r="4"
            fill="${s.m.color}" stroke="#FFF" stroke-width="1.8" opacity="0"/>`;
  });

  // 透明感應區，蓋在繪圖範圍上收手勢
  g += `<rect id="scrub" x="${PL}" y="0" width="${iw}" height="${H}" fill="transparent"/>`;

  S.chart = { dates, series, PL, iw, W, PT, ih, X, Y, 末 };

  return `<div class="chartBox">
    <svg id="chart" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="${S.metric === 'avg' ? '三市場均價走勢' : '三市場交易量走勢'}">${g}</svg>
    <div class="readout" id="readout"></div>
    <div class="hintLine">按住圖表左右滑動，可查看各日數字</div>
  </div>`;
}

/** 更新圖表下方的讀數列，並把游標移到第 i 天 */
function 更新讀數(i) {
  const c = S.chart;
  if (!c) return;
  i = Math.max(0, Math.min(c.末, i));

  const xh = document.getElementById('xh');
  if (xh) {
    const x = c.X(i).toFixed(1);
    xh.setAttribute('x1', x);
    xh.setAttribute('x2', x);
  }

  document.querySelectorAll('.xhDot').forEach(el => {
    const s = c.series.find(x => x.m.code === el.dataset.mc);
    const v = s ? s.pts[i] : null;
    if (v == null) { el.setAttribute('opacity', '0'); return; }
    el.setAttribute('cx', c.X(i).toFixed(1));
    el.setAttribute('cy', c.Y(v).toFixed(1));
    el.setAttribute('opacity', '1');
  });

  const box = document.getElementById('readout');
  if (!box) return;
  const d = c.dates[i];
  const vals = c.series.map(s => {
    const v = s.pts[i];
    const txt = v == null ? '休市'
      : S.metric === 'avg' ? 錢(v) : 公斤(v);
    return `<span class="${v == null ? 'off' : ''}">
      <i style="background:${s.m.color}"></i>${s.m.name} <b class="num">${txt}</b></span>`;
  }).join('');

  box.innerHTML = `<div class="roDate">${月日(d)}（${週(d)}）
      <span class="roUnit">${S.metric === 'avg' ? '元/公斤' : '交易量'}</span></div>
    <div class="roVals">${vals}</div>`;
}

/** 綁定滑動讀數。SVG 會隨容器縮放，所以要用 getBoundingClientRect 換算回 viewBox 座標 */
function 綁定走勢圖() {
  const svg = document.getElementById('chart');
  const hit = document.getElementById('scrub');
  const c = S.chart;
  if (!svg || !hit || !c) return;

  更新讀數(c.末);          // 預設停在最新一天

  let 拖曳中 = false;

  const 取索引 = e => {
    const r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * c.W;
    const t = (x - c.PL) / c.iw;
    return Math.round(t * c.末);
  };

  const 開始 = e => {
    拖曳中 = true;
    hit.setPointerCapture && hit.setPointerCapture(e.pointerId);
    更新讀數(取索引(e));
  };
  const 移動 = e => { if (拖曳中) { e.preventDefault(); 更新讀數(取索引(e)); } };
  const 結束 = () => { 拖曳中 = false; };

  hit.addEventListener('pointerdown', 開始);
  hit.addEventListener('pointermove', 移動);
  hit.addEventListener('pointerup', 結束);
  hit.addEventListener('pointercancel', 結束);
}

/* ── 市場卡（價格帶） ──────────────────────────────────── */
function 市場卡(m, rows) {
  const mine = rows.filter(r => r.mc === m.code);
  if (!mine.length) {
    return `<div class="mk ${m.cls}">
      <div class="mkHead"><div class="mkName">${m.name}</div></div>
      <div class="empty" style="padding:18px 0">這個期間沒有交易紀錄</div>
    </div>`;
  }

  const last = mine[mine.length - 1];
  const wavg = 加權均價(mine);
  const totQty = mine.reduce((s, r) => s + (r.qty > 0 ? r.qty : 0), 0);

  // 與前一個交易日相比
  const prev = mine.length > 1 ? mine[mine.length - 2] : null;
  let delta = '';
  if (prev && prev.avg > 0 && last.avg > 0) {
    const pct = (last.avg - prev.avg) / prev.avg * 100;
    const cls = pct >= 0 ? 'up' : 'down';
    const sign = pct >= 0 ? '▲' : '▼';
    delta = `<span class="delta ${cls}">${sign}${Math.abs(pct).toFixed(1)}%</span>`;
  }

  // 價格帶：下價 → 上價，標出中價與均價的位置
  const lo = last.low, hi = last.up;
  const span = hi - lo;
  const pos = v => span > 0 ? Math.max(0, Math.min(100, (v - lo) / span * 100)) : 50;

  return `<div class="mk ${m.cls}">
    <div class="mkHead">
      <div class="mkName">${m.name}</div>
      <div class="mkDate">${月日(last.d)}（${週(last.d)}）</div>
    </div>

    <div class="mkAvg">
      <b class="num">${錢(last.avg)}</b><span class="u">元/公斤</span>${delta}
      <span class="qty num">${公斤(last.qty)}</span>
    </div>

    <div class="band">
      <div class="bandWrap">
        <div class="bandBar">
          <div class="bandFill" style="background:${m.color}"></div>
          <div class="bandMid" style="left:${pos(last.mid).toFixed(1)}%"></div>
        </div>
        <div class="bandAvg" style="left:${pos(last.avg).toFixed(1)}%;color:${m.color}"></div>
      </div>
      <div class="bandTicks">
        <span>下 ${錢(last.low)}</span>
        <span>中 ${錢(last.mid)}</span>
        <span>上 ${錢(last.up)}</span>
      </div>
    </div>

    <div class="bandKey">
      <span>近 ${S.days} 日均價 <b class="num">${錢(wavg)}</b></span>
      <span>期間總量 <b class="num">${公斤(totQty)}</b></span>
    </div>
  </div>`;
}

/* ── 畫面 ──────────────────────────────────────────────── */
function 畫面() {
  const 過期 = S.fetchedAt && (Date.now() - new Date(S.fetchedAt).getTime() > STALE_MS);
  const stampTxt = S.loading ? '更新中…'
    : S.fetchedAt ? '更新於 ' + 時刻(S.fetchedAt)
    : '尚無資料';
  ['#stamp', '#stamp2'].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.textContent = stampTxt;
    el.classList.toggle('stale', !!過期 && !S.loading);
  });

  行情畫面();
  明細畫面();
  設定畫面();
}

function 行情畫面() {
  const box = $('#priceBody');
  const rows = 期間資料();

  let h = '';

  if (S.err) {
    h += `<div class="notice">讀不到行情資料：${esc(S.err)}<br>
      ${S.rows.length ? '下面顯示的是上次成功取得的資料。' : '確認網路後再按重新整理。'}</div>`;
  }

  h += `<div class="chips">
    <button class="chip ${S.days === 7 ? 'on' : ''}" data-days="7">近 7 日</button>
    <button class="chip ${S.days === 30 ? 'on' : ''}" data-days="30">近 30 日</button>
  </div>
  <div class="chips">
    <button class="chip ${S.metric === 'avg' ? 'on' : ''}" data-metric="avg">均價</button>
    <button class="chip ${S.metric === 'qty' ? 'on' : ''}" data-metric="qty">交易量</button>
  </div>`;

  if (!S.rows.length) {
    h += S.loading
      ? '<div class="empty">正在取得行情…</div>'
      : '<div class="empty">還沒有資料。<br>到「設定」按重新整理。</div>';
    box.innerHTML = h;
    return;
  }

  h += 走勢圖(rows);
  h += '<div class="secTitle">最新一個交易日</div>';
  h += `<div class="bandLegend">
    <div class="blRow"><span class="blBar"></span>橫條＝當日成交區間，左端下價、右端上價</div>
    <div class="blRow"><span class="blSym"><i class="blTri"></i></span>均價（即上方大字）</div>
    <div class="blRow"><span class="blSym"><i class="blLine"></i></span>中價</div>
  </div>`;
  MARKETS.forEach(m => { h += 市場卡(m, rows); });

  box.innerHTML = h;
  綁定走勢圖();

  box.querySelectorAll('[data-days]').forEach(b =>
    b.addEventListener('click', () => { S.days = +b.dataset.days; 畫面(); }));
  box.querySelectorAll('[data-metric]').forEach(b =>
    b.addEventListener('click', () => { S.metric = b.dataset.metric; 畫面(); }));

}

function 明細畫面() {
  const box = $('#detailBody');
  const rows = 期間資料();
  if (!rows.length) {
    box.innerHTML = '<div class="empty">還沒有資料。</div>';
    return;
  }

  const dates = 期間日期(rows).reverse();   // 新的在上
  let h = `<div class="notice calm">近 ${S.days} 日，單位為元/公斤。上／中／下價分別是當日高、中、低價位區間的平均。</div>`;

  dates.forEach(d => {
    const day = rows.filter(r => r.d === d);
    const tot = day.reduce((s, r) => s + (r.qty > 0 ? r.qty : 0), 0);
    h += `<div class="dayBlock">
      <div class="dayHead">${月日(d)}（${週(d)}）<span class="w num">三市場合計 ${公斤(tot)}</span></div>`;
    MARKETS.forEach(m => {
      const r = day.find(x => x.mc === m.code);
      if (!r) {
        h += `<div class="dRow ${m.cls}">
          <div class="dName">${m.name}</div>
          <div class="dNums" style="color:#B0A695">休市或無交易</div>
        </div>`;
        return;
      }
      h += `<div class="dRow ${m.cls}">
        <div class="dName">${m.name}</div>
        <div class="dNums">
          <span>均<b>${錢(r.avg)}</b></span>
          <span>上 ${錢(r.up)}</span>
          <span>中 ${錢(r.mid)}</span>
          <span>下 ${錢(r.low)}</span>
        </div>
        <div class="dQty">${公斤(r.qty)}</div>
      </div>`;
    });
    h += '</div>';
  });

  box.innerHTML = h;
}

function 設定畫面() {
  const box = $('#setupBody');
  const 天數 = 期間日期(S.rows).length;

  // 用最新一筆真實資料現場驗算，比寫死的例子可信，也不會過期
  let 範例 = '';
  const 樣 = S.rows.filter(r => r.mc === '109').pop() || S.rows[S.rows.length - 1];
  if (樣) {
    const 算 = 0.2 * 樣.up + 0.6 * 樣.mid + 0.2 * 樣.low;
    範例 = `<br><br>拿 ${月日(樣.d)} ${MK[樣.mc].name} 實際驗算：<br>`
         + `0.2×${錢(樣.up)} ＋ 0.6×${錢(樣.mid)} ＋ 0.2×${錢(樣.low)} ＝ `
         + `<b>${(Math.round(算 * 100) / 100)}</b><br>`
         + `行情站給的均價：<b>${錢(樣.avg)}</b>`;
  }

  box.innerHTML = `
    <button class="btn wide" id="btnReload" ${S.loading ? 'disabled' : ''}>
      ${S.loading ? '更新中…' : '重新整理'}
    </button>

    <div class="secTitle">資料狀態</div>
    <div class="setRow">
      <h3>目前快取</h3>
      <p>共 <b>${S.rows.length}</b> 筆，涵蓋 <b>${天數}</b> 個交易日。<br>
         最後更新：<b>${S.fetchedAt ? 時刻(S.fetchedAt) : '尚未更新'}</b></p>
    </div>
    <div class="setRow">
      <h3>資料何時更新</h3>
      <p>行情站每日晚間約八點半更新前一日資料，一天只動一次。白天重複整理不會拿到新東西。</p>
    </div>

    <div class="secTitle">怎麼看這些價格</div>
    <div class="setRow">
      <h3>上價、中價、下價</h3>
      <p>把當天所有成交依價格由高排到低，再依<b>交易量</b>切成三段，每段各自算平均：<br><br>
         <b>上價</b>　最貴的 <b>20%</b> 交易量的平均<br>
         <b>中價</b>　中間的 <b>60%</b> 交易量的平均<br>
         <b>下價</b>　最便宜的 <b>20%</b> 交易量的平均</p>
    </div>
    <div class="setRow">
      <h3>比例固定，跟當天進什麼貨無關</h3>
      <p>永遠是 20／60／20，不會因為今天好貨多就變成別的比例。<br><br>
         所以<b>上價不等於「優級的價格」</b>，而是「當天最貴那兩成的價格，不管它是什麼等級」。分級高的通常拍得高，但那是結果，不是定義。</p>
    </div>
    <div class="setRow">
      <h3>均價＝0.2×上 ＋ 0.6×中 ＋ 0.2×下</h3>
      <p>因為三段的比例固定，均價就是這三個數字按 20／60／20 加權後的結果，也等於當天的總金額 ÷ 總重量。${範例}</p>
    </div>
    <div class="setRow">
      <h3>所以均價不是三者相加除以三</h3>
      <p>中價一個人就佔了六成的權重，上價和下價各只有兩成。<br><br>
         這也是為什麼均價通常會貼著中價跑——均價只是多把頭尾兩成拉進來，被兩端稍微拉扯而已。</p>
    </div>
    <div class="setRow">
      <h3>那該看哪一個</h3>
      <p><b>中價</b>　涵蓋六成的量，最接近「一般貨」的行情，比較穩，適合看趨勢。<br><br>
         <b>均價</b>　含頭尾的完整成交水準，會被異常進貨拉動。<br><br>
         <b>兩者的差距</b>　差得越開，代表當天頭尾兩端越極端。可以當成異常偵測。</p>
    </div>
    <div class="setRow">
      <h3>「近 N 日均價」是另一層加權</h3>
      <p>那是把這幾天的總金額加起來除以總重量，加權的對象是<b>日期</b>，跟上面的 20／60／20 是不同層次的事。<br><br>
         不這樣算的話，只成交 300 公斤的冷門日，會跟成交 2 萬公斤的主力日一樣重要。</p>
    </div>

    <div class="secTitle">收錄範圍</div>
    <div class="setRow">
      <h3>三個市場、只看國產</h3>
      <p>台北一（109）、台北二（104）、三重區（241）。<br>
         品項為國產酪梨（G3），已排除進口酪梨（G39）。</p>
    </div>

    <div class="secTitle">維護</div>
    <button class="btn ghost wide" id="btnClear">清除本機快取</button>
    <div class="setRow" style="margin-top:9px">
      <p>資料來源：農業部農業資料開放平臺「農產品交易行情」。<br>
         本 App 直接讀取公開 API，不經過訂單系統。<br>
         版本 ${VERSION}</p>
    </div>
  `;

  $('#btnReload').addEventListener('click', () => 更新(true));
  $('#btnClear').addEventListener('click', () => {
    localStorage.removeItem(LS_ROWS);
    localStorage.removeItem(LS_AT);
    S.rows = []; S.fetchedAt = null;
    toast('快取已清除');
    畫面();
  });
}

/* ── 分頁切換 ──────────────────────────────────────────── */
document.querySelectorAll('#tabs button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hide'));
    $('#' + b.dataset.go).classList.remove('hide');
    document.querySelectorAll('#tabs button').forEach(x => x.removeAttribute('aria-current'));
    b.setAttribute('aria-current', 'true');
  });
});

/* ── 啟動 ──────────────────────────────────────────────── */
(function init() {
  const 有快取 = 讀快取();
  畫面();                     // 先用快取畫出來，不讓使用者盯著空白
  if (!有快取) {
    更新(false);
  } else {
    const 舊 = Date.now() - new Date(S.fetchedAt || 0).getTime() > STALE_MS;
    if (舊) 更新(false);       // 快取過期才在背景重抓
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // 從背景切回前景時，若快取已過期就順手更新
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!S.fetchedAt) return;
    if (Date.now() - new Date(S.fetchedAt).getTime() > STALE_MS) 更新(false);
  });
})();
