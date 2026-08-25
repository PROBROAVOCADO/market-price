/* 波波酪梨 · 農漁產品行情  app.js  v1.8.2
 * ─────────────────────────────────────────────────────────
 * 資料來源：農業部農業資料開放平臺「農產品交易行情」與「漁產品交易行情」
 *   https://data.moa.gov.tw/api/v1/AgriProductsTransType/
 *   https://data.moa.gov.tw/Service/OpenData/FromM/AquaticTransData.aspx
 * 不需 API 金鑰，回應標頭帶 access-control-allow-origin: *，前端可直接讀取。
 * 本 App 不經 GAS、不經 Firebase，完全獨立於訂單系統。
 *
 * v1.1.0：可自選作物與市場，選擇記在本機。
 * v1.2.0：視覺改用訂購網站 style.css v8 的設計語彙。
 * v1.4.0：補上 Page/Next 分頁處理（先前只讀第一頁，資料會被安靜截斷）。
 * v1.6.0：色票重整。原本數字的對比只有 3.56:1（全畫面最弱），現為 6.00:1。
 * v1.7.0：加入「隨喜支持」說明與 LINE 好友導流。
 * v1.8.0：加入水果／蔬菜／漁產雙層選單、漁產品行情與啟動更新摘要。
 * v1.8.1：調整部分文字說明。
 * v1.8.2：第二層品項加入名稱／代碼搜尋，選項同步顯示品項代碼。
 * v1.8.2 修正：品項選單合併官方完整代碼表，不再漏掉當日未成交品項。
 */
'use strict';

const VERSION = 'v1.8.2';
const API = 'https://data.moa.gov.tw/api/v1/AgriProductsTransType/';
const FISH_API = 'https://data.moa.gov.tw/Service/OpenData/FromM/AquaticTransData.aspx';
const FETCH_DAYS = 55;          // 日曆天。每週約休一天，55 天約 46 個交易日，撐得住 30 個交易日的檢視
const DEFAULT_MK = 3;           // 換品項時先選交易量前三大；使用者之後可不限數量或直接全選
const CROP_CATALOG = window.PROBRO_CROP_CATALOG || {}; // 官方完整蔬果品名代碼表，由 crop-catalog.js 提供

/* 從 LINE App 的「顯示行動條碼」頁面按「複製連結」，貼到下方引號內。
   空白時支持說明仍可預覽，但「開啟 LINE」按鈕會停用，避免導向錯誤帳號。 */
const LINE_FRIEND_URL = 'https://line.me/ti/p/7OorqI3Zzk';

/* 快取結構版本。只要 寫快取() 存的欄位有增減就必須 +1，
   否則新版程式讀到舊格式，缺少的欄位會是 undefined —— 不會報錯，只會安靜地判斷錯誤。 */
const CACHE_VER = 3;

const CATEGORY = {
  fruit:     { name: '水果', source: 'agri', tc: 'N05' },
  vegetable: { name: '蔬菜', source: 'agri', tc: 'N04' },
  fish:      { name: '漁產', source: 'fish', tc: null }
};
const CROP_DEFAULT = { code: 'G3', name: '酪梨', category: 'fruit' };
// 多市場色盤使用偏深色，讓走勢線在米白底上仍清楚，選取按鈕上的白字也看得見。
// 一般蔬果市場約十多個；若未來超過色盤長度才循環使用。
const SLOT = [
  '#4A6733', '#B5832F', '#2C3722', '#9C4535', '#2F6B73',
  '#6E4F8A', '#406A9C', '#8A5A36', '#7B3F61', '#3F7A5D',
  '#6F642E', '#4E567C', '#9A5E25', '#3A6861', '#7A4C3C',
  '#516B3F', '#5B4773', '#346278', '#8C4F55', '#5B6330'
];

const LS = {
  crop:   'probroMarketCrop',
  mkts:   'probroMarketMkts',
  rows:   'probroMarketRows',
  list:   'probroMarketCropList',
  listAt: 'probroMarketCropListAt'
};
/* 行情站當日下午就會發佈當天資料，發佈時間不固定，所以不用「幾點之後才抓」這種寫死的規則。
   改成：手上還沒有今天的資料就繼續試，已經拿到就放慢。 */
const MIN_GAP = 30 * 60 * 1000;               // 兩次自動抓取的最短間隔
const MAX_AGE = 6 * 60 * 60 * 1000;           // 就算已有今日資料，超過這個時間仍重抓一次
const LIST_TTL = 24 * 60 * 60 * 1000;         // 成交量排序每天更新；完整代碼表不依賴這份快取
const LIST_CACHE_VER = 2;                      // v2 起清單包含當日未成交的完整代碼品項

/* ── 狀態 ──────────────────────────────────────────────── */
const S = {
  crop: { ...CROP_DEFAULT },
  category: CROP_DEFAULT.category,
  pickCategory: CROP_DEFAULT.category,
  markets: [],        // 選定的市場代號，不限數量
  mkName: {},         // 代號 → 名稱
  mkRank: [],         // [{code, name, qty}]，依總交易量遞減
  coverage: null,     // API 這條管線更新到哪一天（含休市列）
  mkDates: {},        // 市場代號 → { 日期: 1 }，用來分辨「休市」與「沒匯入」
  allDates: [],       // feed 裡出現過的所有日期
  rows: [],           // [{d, mc, up, mid, low, avg, qty}]
  fetchedAt: null,
  days: 7,
  focus: null,        // null＝多市場比較；市場代號＝單一市場價格帶
  metric: 'avg',     // 比較模式：avg/mid/up/low/qty ｜ 單市模式：band/qty
  loading: false,
  err: '',
  chart: null,
  cropList: [],       // [{code, name, qty}]
  listLoading: false,
  listErr: '',
  listRequest: 0,
  sheet: null,        // 'crop' ｜ 'support' ｜ 'release' ｜ 'install' ｜ null
  q: '',              // 作物搜尋字串
  open: {},           // 設定頁各摺疊區塊的開合狀態
  armClear: false,    // 清除鈕的兩段式確認
  armTimer: null,
  installPrompt: null
};

/* ── 小工具 ────────────────────────────────────────────── */
const $ = s => document.querySelector(s);
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
const 民國緊密 = d => `${d.getFullYear() - 1911}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;

/** 民國字串 → ISO 日期；格式不符回 null（休市列的 "-" 會在這裡被擋掉） */
function 西元(s) {
  const m = /^(\d{2,3})\.(\d{1,2})\.(\d{1,2})$/.exec(String(s || '').trim());
  return m ? `${(+m[1]) + 1911}-${p2(+m[2])}-${p2(+m[3])}` : null;
}

function 西元緊密(s) {
  const m = /^(\d{2,3})(\d{2})(\d{2})$/.exec(String(s || '').trim());
  return m ? `${(+m[1]) + 1911}-${m[2]}-${m[3]}` : null;
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

const 色 = i => SLOT[((i % SLOT.length) + SLOT.length) % SLOT.length];

async function 取一頁(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error('伺服器回應 ' + res.status);
  const j = await res.json();
  if (!j || !Array.isArray(j.Data)) throw new Error('回傳格式不符預期');
  return { data: j.Data, next: j.Next === true || j.Next === 'true' };
}

/**
 * 公開 API 現在對未登入請求只開放第一頁；資料超過上限時，改把日期範圍
 * 對半切小後分別查詢。這樣仍能完整取得熱門品項的 55 天行情，不碰受限的 Page=2。
 */
async function 取農產區間(start, end, params = '') {
  const url = `${API}?Start_time=${民國(start)}&End_time=${民國(end)}${params}`;
  const r = await 取一頁(url);
  if (!r.next) return r.data;

  const days = Math.round((end.getTime() - start.getTime()) / 864e5);
  if (days <= 0) {
    console.warn('單日農產資料超過公開 API 上限，保留第一頁');
    return r.data;
  }
  const leftEnd = new Date(start.getTime() + Math.floor(days / 2) * 864e5);
  const rightStart = new Date(leftEnd.getTime() + 864e5);
  const left = await 取農產區間(start, leftEnd, params);
  const right = await 取農產區間(rightStart, end, params);
  return left.concat(right);
}

/* ── 行情資料 ──────────────────────────────────────────── */

/**
 * 只用 Start_time / End_time / CropName 三個參數查詢。
 * CropName 是模糊比對（查「酪梨」會一起帶回「酪梨-進口」），所以回來之後
 * 一定要再用 CropCode 精確過濾，否則不同品種或進口品會混在一起。
 * 市場不在查詢端過濾——MarketName 一次只吃一個市場，而且參數之間是 AND，
 * 填越多越容易整組落空。
 */
async function 抓行情(crop) {
  if ((CATEGORY[crop.category] || CATEGORY.fruit).source === 'fish') return 抓漁產行情(crop);
  const end = new Date();
  const start = new Date(end.getTime() - FETCH_DAYS * 864e5);
  const params = `&CropName=${encodeURIComponent(crop.name)}`;
  return 整理(await 取農產區間(start, end, params), crop.code);
}

const FISH_PAGE = 1000;
const FISH_MAX_PAGE = 12;

async function 取漁JSON(params) {
  let out = [];
  for (let page = 0; page < FISH_MAX_PAGE; page++) {
    const url = `${FISH_API}?$top=${FISH_PAGE}&$skip=${page * FISH_PAGE}&${params}`;
    const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error('漁產資料回應 ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('漁產資料格式不符預期');
    out = out.concat(data);
    if (data.length < FISH_PAGE) return out;
  }
  console.warn('漁產資料超過分頁上限，已停止續抓');
  return out;
}

async function 抓漁產行情(crop) {
  const end = new Date();
  const start = new Date(end.getTime() - FETCH_DAYS * 864e5);
  const params = `StartDate=${民國緊密(start)}&EndDate=${民國緊密(end)}`
    + `&TypeNo=${encodeURIComponent(crop.code)}`;
  return 整理漁產(await 取漁JSON(params), crop.code);
}

function 整理漁產(data, code) {
  const map = new Map();
  const name = {}, 市場日 = {}, 全日期 = {};
  let 涵蓋 = null;
  data.forEach(o => {
    if (String(o['品種代碼']) !== String(code)) return;
    const d = 西元緊密(o['交易日期']);
    const rawName = String(o['市場名稱'] || '').trim();
    const mc = rawName.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 10);
    if (!d || !mc) return;
    全日期[d] = 1;
    if (!涵蓋 || d > 涵蓋) 涵蓋 = d;
    (市場日[mc] = 市場日[mc] || {})[d] = 1;
    name[mc] = mc;
    const row = {
      d, mc,
      up: +o['上價'], mid: +o['中價'], low: +o['下價'],
      avg: +o['平均價'], qty: +o['交易量']
    };
    if (!(row.qty > 0) && !(row.avg > 0)) return;
    const key = d + '|' + mc;
    const prev = map.get(key);
    if (!prev || row.qty > prev.qty) map.set(key, row);
  });
  const rows = [...map.values()].sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
  return { rows, name, 涵蓋, 市場日, 全日期: Object.keys(全日期).sort() };
}

/**
 * API 會夾帶兩種不要的列：
 *   1. 同名的其他品種或進口品（CropCode 不同）
 *   2. CropCode "-"、CropName "休市"，價格與交易量全為 0
 * 注意：同一天同一市場可能「休市列」與「交易列」並存（實測 8/16 台中市），
 * 所以不能用「當天有休市列就整天跳過」，只能認 CropCode。
 */
function 整理(data, code) {
  const map = new Map();
  const name = {};
  const 市場日 = {};      // 市場代號 → { 日期: 1 }，含休市列
  const 全日期 = {};      // feed 裡出現過的所有日期
  let 涵蓋 = null;
  data.forEach(o => {
    // 休市列同樣要記。「有休市列」與「連休市列都沒有」是兩件事：
    // 前者是市場當天沒開，後者是這個市場當天的資料根本沒匯入。
    const dd = 西元(o.TransDate);
    if (dd) {
      全日期[dd] = 1;
      if (!涵蓋 || dd > 涵蓋) 涵蓋 = dd;
      const m0 = String(o.MarketCode || '').trim();
      if (m0) (市場日[m0] = 市場日[m0] || {})[dd] = 1;
    }

    if (String(o.CropCode) !== code) return;
    const mc = String(o.MarketCode || '').trim();
    const d = 西元(o.TransDate);
    if (!mc || !d) return;

    const row = {
      d, mc,
      up:  +o.Upper_Price,
      mid: +o.Middle_Price,
      low: +o.Lower_Price,
      avg: +o.Avg_Price,
      qty: +o.Trans_Quantity
    };
    if (!(row.qty > 0) && !(row.avg > 0)) return;

    // 市場名稱只留中英數，不讓 API 的原始字串有機會夾帶標記進 DOM
    const nm = String(o.MarketName || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 10);
    if (nm) name[mc] = nm;

    const key = d + '|' + mc;
    const prev = map.get(key);
    if (!prev || row.qty > prev.qty) map.set(key, row);   // 保險：同鍵取量大者
  });

  const rows = [...map.values()].sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
  return { rows, name, 涵蓋, 市場日, 全日期: Object.keys(全日期).sort() };
}

/** 依總交易量排出這個作物有哪些市場在交易 */
function 算市場排行() {
  const tot = {};
  S.rows.forEach(r => { tot[r.mc] = (tot[r.mc] || 0) + (r.qty > 0 ? r.qty : 0); });
  S.mkRank = Object.keys(tot)
    .map(mc => ({ code: mc, name: S.mkName[mc] || mc, qty: tot[mc] }))
    .sort((a, b) => b.qty - a.qty);
}

/** 沿用使用者選過的市場（若這個作物有交易），否則自動取交易量前三大 */
function 校正市場選擇(重設) {
  const 有 = new Set(S.mkRank.map(m => m.code));
  S.markets = 重設 ? [] : S.markets.filter(mc => 有.has(mc));
  if (!S.markets.length) S.markets = S.mkRank.slice(0, DEFAULT_MK).map(m => m.code);
  if (S.focus && S.markets.indexOf(S.focus) < 0) S.focus = null;   // 焦點市場被移除就回到比較模式
  存選擇();
}

/* ── 作物清單 ──────────────────────────────────────────── */

/**
 * 把最近交易日清單與官方完整代碼表合併：
 *   - 有成交的品項保留交易量排序，放在前面。
 *   - 當日沒成交的品項仍可依名稱或代碼搜尋，放在後面並以 qty=0 標示。
 * API 偶爾出現代碼表尚未收錄的新項目時，也會保留 API 回傳的項目。
 */
function 合併完整作物清單(category, recent = []) {
  const catalog = CROP_CATALOG[category];
  if (!Array.isArray(catalog) || !catalog.length) return recent;

  const active = recent.map(c => ({ ...c, qty: +c.qty || 0 }));
  const seen = new Set(active.map(c => String(c.code)));
  const inactive = [];
  catalog.forEach(entry => {
    if (!Array.isArray(entry) || entry.length < 2) return;
    const code = String(entry[0] || '').trim();
    const name = String(entry[1] || '').trim();
    if (!code || !name || seen.has(code)) return;
    seen.add(code);
    inactive.push({ code, name, qty: 0 });
  });
  return active.concat(inactive);
}

/**
 * 不帶 CropName 查詢會回傳當期全品項，資料量很大，所以一次只查一天。
 * 最近交易日資料只負責排序；可搜尋的品項以官方完整代碼表補齊。
 */
async function 抓作物清單(category) {
  if ((CATEGORY[category] || CATEGORY.fruit).source === 'fish') return 抓漁產清單();
  const tc = (CATEGORY[category] || CATEGORY.fruit).tc;
  for (let back = 0; back < 7; back++) {
    const d = new Date(Date.now() - back * 864e5);
    // 先在伺服器端依大類過濾。這一頁只用來排近期品項；完整性由本機代碼表負責。
    const r = await 取一頁(`${API}?Start_time=${民國(d)}&End_time=${民國(d)}&TcType=${tc}`);
    const data = r.data;
    const tot = {}, name = {};
    data.forEach(o => {
      if (String(o.TcType || '') !== tc) return;
      const code = String(o.CropCode || '').trim();
      const nm = String(o.CropName || '').trim();
      if (!code || code === '-' || !nm || nm === '休市') return;   // 休市列
      name[code] = nm;
      tot[code] = (tot[code] || 0) + (+o.Trans_Quantity || 0);
    });
    const list = Object.keys(tot)
      .map(code => ({ code, name: name[code], qty: tot[code] }))
      .sort((a, b) => b.qty - a.qty);
    if (list.length > 15) return 合併完整作物清單(category, list); // 避開尚未完整發布的半套清單
  }
  const catalogOnly = 合併完整作物清單(category, []);
  if (catalogOnly.length) return catalogOnly;
  throw new Error('最近七天都查不到交易資料，完整品項表也無法載入');
}

async function 抓漁產清單() {
  for (let back = 0; back < 7; back++) {
    const d = new Date(Date.now() - back * 864e5);
    const day = 民國緊密(d);
    const data = await 取漁JSON(`StartDate=${day}&EndDate=${day}`);
    const tot = {}, name = {};
    data.forEach(o => {
      const code = String(o['品種代碼'] || '').trim();
      const nm = String(o['魚貨名稱'] || '').trim();
      if (!code || !nm) return;
      name[code] = nm;
      tot[code] = (tot[code] || 0) + (+o['交易量'] || 0);
    });
    const list = Object.keys(tot)
      .map(code => ({ code, name: name[code], qty: tot[code] }))
      .sort((a, b) => b.qty - a.qty);
    if (list.length > 15) return list;
  }
  throw new Error('最近七天都查不到漁產交易資料');
}

const 清單鍵 = (base, category) => `${base}:v${LIST_CACHE_VER}:${category}`;

async function 確保作物清單(category = S.pickCategory) {
  if (S.cropList.length) return;
  const request = ++S.listRequest;
  const at = +(localStorage.getItem(清單鍵(LS.listAt, category)) || 0);
  if (Date.now() - at < LIST_TTL) {
    try {
      const c = JSON.parse(localStorage.getItem(清單鍵(LS.list, category)) || '[]');
      if (Array.isArray(c) && c.length && request === S.listRequest && category === S.pickCategory) {
        S.cropList = c; 畫面(); return;
      }
    } catch (e) { /* 快取壞了就重抓 */ }
  }
  S.listLoading = true; S.listErr = ''; 畫面();
  try {
    const list = await 抓作物清單(category);
    if (request !== S.listRequest || category !== S.pickCategory) return;
    S.cropList = list;
    try {
      localStorage.setItem(清單鍵(LS.list, category), JSON.stringify(S.cropList));
      localStorage.setItem(清單鍵(LS.listAt, category), String(Date.now()));
    } catch (e) { /* 容量滿，不影響本次 */ }
  } catch (e) {
    if (request !== S.listRequest || category !== S.pickCategory) return;
    // 沒網路時仍讓使用者從隨 App 附帶的完整代碼表選品項；只會缺少近期成交量排序。
    const catalogOnly = 合併完整作物清單(category, []);
    if (catalogOnly.length) {
      S.cropList = catalogOnly;
      S.listErr = '';
    } else {
      S.listErr = String(e.message || e);
    }
  } finally {
    if (request === S.listRequest && category === S.pickCategory) {
      S.listLoading = false; 畫面();
    }
  }
}

/* ── 本機儲存 ──────────────────────────────────────────── */
function 讀選擇() {
  try {
    const c = JSON.parse(localStorage.getItem(LS.crop) || 'null');
    if (c && c.code && c.name) {
      const category = CATEGORY[c.category] ? c.category : 'fruit';
      S.crop = { code: String(c.code), name: String(c.name), category };
      S.category = category;
      S.pickCategory = category;
    }
  } catch (e) { /* 用預設 */ }
  try {
    const m = JSON.parse(localStorage.getItem(LS.mkts) || 'null');
    if (Array.isArray(m)) S.markets = m.map(String);
  } catch (e) { /* 用自動挑選 */ }
}

function 存選擇() {
  try {
    localStorage.setItem(LS.crop, JSON.stringify(S.crop));
    localStorage.setItem(LS.mkts, JSON.stringify(S.markets));
  } catch (e) { /* 略 */ }
}

function 讀快取() {
  try {
    const c = JSON.parse(localStorage.getItem(LS.rows) || 'null');
    // 快取同時綁定「結構版本」與「作物」：
    // 版本不符 → 舊格式缺欄位，寧可重抓；作物不符 → 會顯示上一個作物的價格
    if (!c || c.v !== CACHE_VER) return false;
    if (c.crop !== S.crop.code || c.category !== S.category || !Array.isArray(c.rows) || !c.rows.length) return false;
    S.rows = c.rows;
    S.mkName = c.name || {};
    S.coverage = c.cov || null;
    S.mkDates = c.md || {};
    S.allDates = c.ad || [];
    S.fetchedAt = c.at || null;
    return true;
  } catch (e) { return false; }
}

function 寫快取() {
  try {
    localStorage.setItem(LS.rows, JSON.stringify({
      v: CACHE_VER,
      crop: S.crop.code, category: S.category, rows: S.rows, name: S.mkName, cov: S.coverage,
      md: S.mkDates, ad: S.allDates, at: S.fetchedAt
    }));
  } catch (e) { /* 略 */ }
}

/* ── 更新 ──────────────────────────────────────────────── */

const 今天ISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
const 最新資料日 = () => S.rows.length ? S.rows[S.rows.length - 1].d : null;

/**
 * 把「沒有新資料」拆成四種原因，由嚴重到輕微，先中先停。
 *   缺漏 → feed 有那天，但選定市場全都連休市列都沒有 ＝ 整批未匯入
 *   不同步 → 某些市場明顯落後其他市場（單一市場未匯入時會是這種）
 *   休市 → 有休市列，市場當天沒開市（正常）
 *   落後 → 整條管線還沒發布到今天
 *
 * 註：無法只靠「沒有紀錄」判斷單一市場是否未匯入——市場有開但當天沒成交這個作物，
 * 也是沒有紀錄。所以單一市場改用「與其他市場相比落後多少天」來判斷，避免誤報。
 */
function 資料落差() {
  const 交 = 最新資料日();
  if (!交) return null;
  const all = S.allDates || [];

  // 每個選定市場自己的最新交易日
  const 各 = S.markets.map(mc => {
    const mine = S.rows.filter(r => r.mc === mc);
    return { mc, name: S.mkName[mc] || mc, d: mine.length ? mine[mine.length - 1].d : null };
  });

  // 漁產資料沒有「休市列」，只能忠實呈現各市場實際出現的最新交易日。
  if (S.category === 'fish') {
    const dates = 各.map(x => x.d).filter(Boolean).sort();
    if (dates.length && new Set(dates).size > 1) {
      return { 類: '休市', 文: `各魚市場最新交易：${各.map(x =>
        `${x.name} ${x.d ? 月日(x.d) : '—'}`).join('　')}` };
    }
    if (S.coverage && S.coverage < 今天ISO()) {
      return { 類: '落後', 文: `漁產資料最新只到 ${月日(S.coverage)}，尚未發布之後的交易` };
    }
    return null;
  }

  // ① 缺漏：所有選定市場在那幾天都完全沒紀錄
  const 缺 = all.filter(d => d > 交 && S.markets.length &&
    S.markets.every(mc => !(S.mkDates[mc] || {})[d]));
  if (缺.length) {
    const 列 = 缺.length <= 3 ? 缺.map(月日).join('、') : `${月日(缺[0])} 起共 ${缺.length} 天`;
    return { 類: '缺漏',
      文: `資料源缺少 ${列} 的紀錄——這幾天並非休市，是尚未匯入。行情站官網可能已經查得到。` };
  }

  // ② 不同步：有市場落後其他市場兩天以上
  const 有日 = 各.map(x => x.d).filter(Boolean).sort();
  if (有日.length) {
    const 最新 = 有日[有日.length - 1];
    const 慢 = 各.filter(x => x.d &&
      Math.round((new Date(最新 + 'T00:00:00') - new Date(x.d + 'T00:00:00')) / 864e5) >= 2);
    if (慢.length) {
      return { 類: '不同步',
        文: `${慢.map(x => `${x.name} 停在 ${月日(x.d)}`).join('、')}，`
          + `其他市場已到 ${月日(最新)}。這幾天該市場的資料可能尚未匯入。` };
    }
  }

  // ③ 休市
  const 涵 = S.coverage;
  if (涵 && 涵 > 交) {
    const 全同 = new Set(各.map(x => x.d)).size <= 1;
    return { 類: '休市',
      文: 全同
        ? `資料源已更新至 ${月日(涵)}，選定市場在那之後休市未交易`
        : `各市場最新交易：${各.map(x => `${x.name} ${x.d ? 月日(x.d) : '—'}`).join('　')}` };
  }

  // ④ 整條管線落後
  if (涵 && 涵 < 今天ISO()) {
    return { 類: '落後', 文: `資料源最新只到 ${月日(涵)}，尚未發布之後的資料` };
  }
  return null;
}

/** 自動更新的判斷。手動按重新整理不走這裡，一律直接抓。 */
function 需要更新() {
  if (!S.rows.length) return true;
  const age = Date.now() - new Date(S.fetchedAt || 0).getTime();
  if (age > MAX_AGE) return true;
  if (age < MIN_GAP) return false;
  return 最新資料日() < 今天ISO();     // 還沒拿到今天的，就繼續試
}
async function 更新(手動, 重設市場) {
  if (S.loading) return;
  S.loading = true; S.err = '';
  畫面();
  try {
    const r = await 抓行情(S.crop);
    S.rows = r.rows;
    S.mkName = r.name;
    S.coverage = r.涵蓋 || null;
    S.mkDates = r.市場日 || {};
    S.allDates = r.全日期 || [];
    S.fetchedAt = new Date().toISOString();
    算市場排行();
    校正市場選擇(重設市場);
    寫快取();
    if (手動) toast(S.rows.length ? '已更新' : `這個品項近 ${FETCH_DAYS} 天沒有交易紀錄`, 2400);
  } catch (e) {
    S.err = String(e.message || e);
    if (手動) toast('更新失敗\n' + S.err, 2600);
  } finally {
    S.loading = false;
    畫面();
  }
}

function 換作物(code, name, category = S.pickCategory) {
  S.category = CATEGORY[category] ? category : 'fruit';
  S.pickCategory = S.category;
  S.crop = { code, name, category: S.category };
  S.rows = []; S.mkName = {}; S.mkRank = []; S.markets = [];
  S.fetchedAt = null; S.sheet = null; S.q = '';
  存選擇();
  更新(false, true);
}

/* ── 統計 ──────────────────────────────────────────────── */
const 期間日期 = rows => [...new Set(rows.map(r => r.d))].sort();

function 期間資料() {
  if (!S.rows.length) return [];
  const 選 = new Set(S.markets);
  const 我的 = S.rows.filter(r => 選.has(r.mc));
  const keep = new Set(期間日期(我的).slice(-S.days));
  return 我的.filter(r => keep.has(r.d));
}

/**
 * 交易量加權平均價。
 * 不是「每日均價再取算術平均」——那會讓量很小的日子和量很大的日子等重。
 */
function 加權均價(rows) {
  let s = 0, q = 0;
  rows.forEach(r => { if (r.qty > 0 && r.avg > 0) { s += r.avg * r.qty; q += r.qty; } });
  return q ? s / q : null;
}

/* ── 走勢圖 ────────────────────────────────────────────── */

const METRIC_CMP = [
  { k: 'avg', n: '均價' }, { k: 'mid', n: '中價' },
  { k: 'up',  n: '上價' }, { k: 'low', n: '下價' },
  { k: 'qty', n: '交易量' }
];
const METRIC_ONE = [ { k: 'band', n: '價格帶' }, { k: 'qty', n: '交易量' } ];

const 指標清單 = () => S.focus ? METRIC_ONE : METRIC_CMP;
const 指標名 = k => (指標清單().find(m => m.k === k) || {}).n || '';

/** 切換模式時，把不適用的指標拉回該模式的預設值 */
function 校正指標() {
  const ok = 指標清單().some(m => m.k === S.metric);
  if (!ok) S.metric = S.focus ? 'band' : 'avg';
}

/** 把座標軸切成好讀的刻度：40/50/60，而不是 42.4/47.7/53.1 */
function 好刻度(range, 段數) {
  const raw = range / 段數;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

/* 畫布幾何：PR 要留得下最右邊的日期標籤 */
const GEO = { W: 340, H: 172, PL: 40, PR: 14, PT: 12, PB: 26 };

/** 共用外殼：格線、日期標籤、游標線、感應區 */
function 組圖(dates, series, 額外, opts) {
  const { W, H, PL, PR, PT, PB } = GEO;
  const iw = W - PL - PR, ih = H - PT - PB;

  let lo = Infinity, hi = -Infinity;
  series.forEach(s => s.pts.forEach(v => {
    if (v == null) return;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }));
  if (!isFinite(lo)) return null;

  if (opts.zero) lo = 0;
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
    const lab = opts.zero ? (v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v)) : 錢(v);
    g += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}"
            stroke="#5A4E3A" stroke-opacity="0.15" stroke-width="1" stroke-dasharray="3 3"/>`;
    g += `<text x="${PL - 6}" y="${(y + 3.6).toFixed(1)}" text-anchor="end"
            font-size="10" fill="#6D7760" font-weight="600">${lab}</text>`;
  }

  const 末 = dates.length - 1;
  const labIdx = dates.length <= 4
    ? dates.map((_, i) => i)
    : [0, Math.round(末 / 3), Math.round(末 * 2 / 3), 末];
  [...new Set(labIdx)].forEach(i => {
    const anc = i === 0 ? 'start' : i === 末 ? 'end' : 'middle';
    g += `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="${anc}"
            font-size="10" fill="#6D7760" font-weight="600">${月日(dates[i])}</text>`;
  });

  if (額外) g += 額外(X, Y);      // 價格帶的色塊畫在格線之上、線條之下

  g += `<line id="xh" x1="${X(末).toFixed(1)}" y1="${PT}" x2="${X(末).toFixed(1)}"
          y2="${PT + ih}" stroke="#2C3722" stroke-width="1.5" opacity="0.32"/>`;

  series.forEach(s => {
    if (s.hidden) return;
    const pl = [];
    s.pts.forEach((v, i) => {
      if (v == null) return;      // 該日休市 → 跨過，線接續
      pl.push(`${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
    });
    if (!pl.length) return;
    if (pl.length === 1) {
      const [x, y] = pl[0].split(',');
      g += `<circle cx="${x}" cy="${y}" r="3" fill="${s.color}"/>`;
    } else {
      g += `<polyline points="${pl.join(' ')}" fill="none" stroke="${s.color}"
              stroke-width="${s.w || 2.2}" stroke-linejoin="round" stroke-linecap="round"
              ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} opacity="${s.op || 1}"/>`;
    }
  });

  series.forEach((s, i) => {
    g += `<circle class="xhDot" data-i="${i}" cx="0" cy="0" r="4"
            fill="${s.color}" stroke="#FDFBF7" stroke-width="2" opacity="0"/>`;
  });

  g += `<rect id="scrub" x="${PL}" y="0" width="${iw}" height="${GEO.H}" fill="transparent"/>`;

  S.chart = { dates, series, PL, iw, W, X, Y, 末, unit: opts.unit };

  return `<div class="chartBox">
    <svg id="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.label}">${g}</svg>
    <div class="readout" id="readout"></div>
    <div class="hintLine">按住圖表左右滑動，可查看各日數字</div>
  </div>`;
}

function 走勢圖(rows) {
  const dates = 期間日期(rows);
  if (dates.length < 2) return '<div class="empty">這個期間的資料還不足以畫出走勢</div>';
  const idx = {};
  dates.forEach((d, i) => { idx[d] = i; });

  const 取 = (mc, key) => {
    const pts = new Array(dates.length).fill(null);
    rows.forEach(r => {
      if (r.mc !== mc) return;
      const v = r[key];
      if (v > 0) pts[idx[r.d]] = v;
    });
    return pts;
  };

  let html;
  if (!S.focus) {
    /* 多市場比較：市場很多時把線稍微畫細，減少彼此遮蓋 */
    const crowded = S.markets.length > 6;
    const series = S.markets.map((mc, i) => ({
      name: S.mkName[mc] || mc, color: 色(i), pts: 取(mc, S.metric),
      w: crowded ? 1.45 : 2.2, op: crowded ? 0.9 : 1
    }));
    html = 組圖(dates, series, null, {
      zero: S.metric === 'qty',
      unit: S.metric === 'qty' ? '交易量' : '元/公斤',
      label: `各市場${指標名(S.metric)}走勢`
    });
  } else if (S.metric === 'qty') {
    /* 單一市場的交易量 */
    const i = Math.max(0, S.markets.indexOf(S.focus));
    html = 組圖(dates, [{ name: '交易量', color: 色(i), pts: 取(S.focus, 'qty') }], null, {
      zero: true, unit: '交易量', label: `${S.mkName[S.focus] || ''}交易量走勢`
    });
  } else {
    /* 單一市場價格帶：市場卡上那條橫條，沿時間拉長 */
    const i = Math.max(0, S.markets.indexOf(S.focus));
    const c = 色(i);
    const ups = 取(S.focus, 'up'), lows = 取(S.focus, 'low');
    const series = [
      { name: '上價', color: c, pts: ups,             hidden: true },
      { name: '中價', color: '#2C3722', pts: 取(S.focus, 'mid'), w: 1.6, dash: '4 3', op: .7 },
      { name: '下價', color: c, pts: lows,            hidden: true },
      { name: '均價', color: c, pts: 取(S.focus, 'avg'), w: 2.6 }
    ];
    const 色帶 = (X, Y) => {
      const top = [], bot = [];
      ups.forEach((v, k) => { if (v != null) top.push(`${X(k).toFixed(1)},${Y(v).toFixed(1)}`); });
      for (let k = lows.length - 1; k >= 0; k--) {
        if (lows[k] != null) bot.push(`${X(k).toFixed(1)},${Y(lows[k]).toFixed(1)}`);
      }
      if (top.length < 2 || bot.length < 2) return '';
      return `<polygon points="${top.concat(bot).join(' ')}" fill="${c}" fill-opacity="0.18"/>`
           + `<polyline points="${top.join(' ')}" fill="none" stroke="${c}" stroke-width="1.2"
                stroke-opacity="0.55" stroke-linejoin="round"/>`
           + `<polyline points="${bot.join(' ')}" fill="none" stroke="${c}" stroke-width="1.2"
                stroke-opacity="0.55" stroke-linejoin="round"/>`;
    };
    series.color = c;
    html = 組圖(dates, series, 色帶, {
      zero: false, unit: '元/公斤', label: `${S.mkName[S.focus] || ''}價格帶走勢`
    });
  }

  return html || '<div class="empty">這個期間沒有交易資料</div>';
}

/** 更新圖表下方的讀數列，並把游標移到第 i 天 */
function 更新讀數(i) {
  const c = S.chart;
  if (!c) return;
  i = Math.max(0, Math.min(c.末, i));

  const xh = document.getElementById('xh');
  if (xh) {
    const x = c.X(i).toFixed(1);
    xh.setAttribute('x1', x); xh.setAttribute('x2', x);
  }

  document.querySelectorAll('.xhDot').forEach(el => {
    const s = c.series[+el.dataset.i];
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
    const txt = v == null ? '休市' : (c.unit === '交易量' ? 公斤(v) : 錢(v));
    return `<span class="${v == null ? 'off' : ''}">
      <i style="background:${s.color}"></i>${esc(s.name)} <b class="num">${txt}</b></span>`;
  }).join('');

  box.innerHTML = `<div class="roDate">${月日(d)}（${週(d)}）
      <span class="roUnit">${esc(c.unit)}</span></div>
    <div class="roVals">${vals}</div>`;
}

/** SVG 會隨容器縮放，所以要用 getBoundingClientRect 換算回 viewBox 座標 */
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
    return Math.round((x - c.PL) / c.iw * c.末);
  };
  const 開始 = e => {
    拖曳中 = true;
    if (hit.setPointerCapture) hit.setPointerCapture(e.pointerId);
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
function 市場卡(mc, i, rows) {
  const nm = esc(S.mkName[mc] || mc);
  const c = 色(i);
  const mine = rows.filter(r => r.mc === mc);
  if (!mine.length) {
    return `<div class="mk" style="border-left-color:${c}">
      <div class="mkHead"><div class="mkName">${nm}</div></div>
      <div class="empty" style="padding:18px 0">這個期間沒有交易紀錄</div>
    </div>`;
  }

  const last = mine[mine.length - 1];
  const wavg = 加權均價(mine);
  const totQty = mine.reduce((s, r) => s + (r.qty > 0 ? r.qty : 0), 0);

  const prev = mine.length > 1 ? mine[mine.length - 2] : null;
  let delta = '';
  if (prev && prev.avg > 0 && last.avg > 0) {
    const pct = (last.avg - prev.avg) / prev.avg * 100;
    delta = `<span class="delta ${pct >= 0 ? 'up' : 'down'}">`
          + `${pct >= 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(1)}%</span>`;
  }

  const span = last.up - last.low;
  const pos = v => span > 0 ? Math.max(0, Math.min(100, (v - last.low) / span * 100)) : 50;

  return `<div class="mk" style="border-left-color:${c}">
    <div class="mkHead">
      <div class="mkName">${nm}</div>
      <div class="mkDate">${月日(last.d)}（${週(last.d)}）</div>
    </div>

    <div class="mkAvg">
      <b class="num">${錢(last.avg)}</b><span class="u">元/公斤</span>${delta}
      <span class="qty num">${公斤(last.qty)}</span>
    </div>

    <div class="band">
      <div class="bandWrap">
        <div class="bandBar">
          <div class="bandFill" style="background:${c}"></div>
          <div class="bandMid" style="left:${pos(last.mid).toFixed(1)}%"></div>
        </div>
        <div class="bandAvg" style="left:${pos(last.avg).toFixed(1)}%;color:${c}"></div>
      </div>
      <div class="bandTicks">
        <span>下 ${錢(last.low)}</span>
        <span>中 ${錢(last.mid)}</span>
        <span>上 ${錢(last.up)}</span>
      </div>
    </div>

    <div class="bandKey">
      <span>近 ${S.days} 個交易日均價 <b class="num">${錢(wavg)}</b></span>
      <span>期間總量 <b class="num">${公斤(totQty)}</b></span>
    </div>
  </div>`;
}

/* ── 畫面 ──────────────────────────────────────────────── */
function 畫面() {
  const 過期 = S.fetchedAt && (Date.now() - new Date(S.fetchedAt).getTime() > MAX_AGE);
  const txt = S.loading ? '更新中…' : S.fetchedAt ? '更新於 ' + 時刻(S.fetchedAt) : '尚無資料';
  ['#stamp', '#stamp2'].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.textContent = txt;
    el.classList.toggle('stale', !!過期 && !S.loading);
  });

  const cb = $('#cropBtn');
  if (cb) cb.innerHTML = `${esc((CATEGORY[S.category] || CATEGORY.fruit).name)} · ${esc(S.crop.name)}<span class="caret">▾</span>`;

  行情畫面();
  明細畫面();
  設定畫面();
  作物選單();
}

function 行情畫面() {
  const box = $('#priceBody');
  const rows = 期間資料();
  let h = '';

  if (S.err) {
    h += `<div class="notice">讀不到行情資料：${esc(S.err)}<br>
      ${S.rows.length ? '下面顯示的是上次成功取得的資料。' : '確認網路後再按重新整理。'}</div>`;
  }

  校正指標();

  const 市場鈕 = S.markets.map((mc, i) => {
    const on = S.focus === mc;
    return `<button class="chip ${on ? 'on' : ''}" data-focus="${esc(mc)}"
      ${on ? `style="background:${色(i)};border-color:${色(i)}"` : ''}
      ><i class="dotMk" style="background:${色(i)}"></i>${esc(S.mkName[mc] || mc)}</button>`;
  }).join('');

  h += `<div class="chips">
    <button class="chip ${S.days === 7 ? 'on' : ''}" data-days="7">近 7 個交易日</button>
    <button class="chip ${S.days === 30 ? 'on' : ''}" data-days="30">近 30 個交易日</button>
  </div>
  <div class="chips">
    <button class="chip ${!S.focus ? 'on' : ''}" data-focus="">市場比較（${S.markets.length}）</button>
    ${市場鈕}
  </div>
  <div class="chips">
    ${指標清單().map(m => `<button class="chip ${S.metric === m.k ? 'on' : ''}"
        data-metric="${m.k}">${m.n}</button>`).join('')}
  </div>`;

  if (!S.rows.length) {
    h += S.loading
      ? '<div class="empty">正在取得行情…</div>'
      : `<div class="empty">${esc(S.crop.name)} 近 ${FETCH_DAYS} 天沒有交易紀錄。<br>
           點上方品項名稱換一個，或到「設定」按重新整理。</div>`;
    box.innerHTML = h;
    綁定行情事件(box);
    return;
  }

  const 期 = 期間日期(rows);
  if (期.length) {
    const 跨 = Math.round(
      (new Date(期[期.length - 1] + 'T00:00:00') - new Date(期[0] + 'T00:00:00')) / 864e5) + 1;
    h += `<div class="rangeLine">資料範圍 <b>${月日(期[0])} – ${月日(期[期.length - 1])}</b>`
       + `　${期.length} 個交易日，橫跨 ${跨} 天</div>`;
  }
  const 差 = 資料落差();
  if (差) h += `<div class="gapLine ${差.類 === '休市' ? '' : 'warn'}">${esc(差.文)}</div>`;
  if (!S.focus && S.markets.length > 6) {
    h += `<div class="gapLine">目前同時比較 ${S.markets.length} 個市場，線條較密；可點上方任一市場名稱，單獨查看價格帶。</div>`;
  }

  h += 走勢圖(rows);
  h += '<div class="secTitle">最新一個交易日</div>';
  h += `<div class="bandLegend">
    <div class="blRow"><span class="blBar"></span>橫條＝當日成交區間，左端下價、右端上價</div>
    <div class="blRow"><span class="blSym"><i class="blTri"></i></span>均價（即上方大字）</div>
    <div class="blRow"><span class="blSym"><i class="blLine"></i></span>中價</div>
  </div>`;
  S.markets.forEach((mc, i) => { h += 市場卡(mc, i, rows); });

  box.innerHTML = h;
  綁定走勢圖();
  綁定行情事件(box);
}

function 綁定行情事件(box) {
  box.querySelectorAll('[data-days]').forEach(b =>
    b.addEventListener('click', () => { S.days = +b.dataset.days; 畫面(); }));
  box.querySelectorAll('[data-metric]').forEach(b =>
    b.addEventListener('click', () => { S.metric = b.dataset.metric; 畫面(); }));
  box.querySelectorAll('[data-focus]').forEach(b =>
    b.addEventListener('click', () => {
      S.focus = b.dataset.focus || null;
      校正指標();
      畫面();
    }));
}

function 明細畫面() {
  const box = $('#detailBody');
  const rows = 期間資料();
  if (!rows.length) { box.innerHTML = '<div class="empty">還沒有資料。</div>'; return; }

  const dates = 期間日期(rows).reverse();
  let h = `<div class="notice calm">${esc(S.crop.name)}．近 ${S.days} 個交易日，單位為元/公斤。
    ${S.category === 'fish'
      ? '上／中／下價依漁業署公開資料原值呈現；各魚市場的分級與交易情況可能不同。'
      : '上／中／下價分別是當日最貴 20%、中間 60%、最便宜 20% 交易量的平均。'}</div>`;

  dates.forEach(d => {
    const day = rows.filter(r => r.d === d);
    const tot = day.reduce((s, r) => s + (r.qty > 0 ? r.qty : 0), 0);
    h += `<div class="dayBlock">
      <div class="dayHead">${月日(d)}（${週(d)}）<span class="w num">合計 ${公斤(tot)}</span></div>`;
    S.markets.forEach((mc, i) => {
      const r = day.find(x => x.mc === mc);
      const nm = esc(S.mkName[mc] || mc);
      if (!r) {
        h += `<div class="dRow" style="border-left-color:${色(i)}">
          <div class="dName">${nm}</div>
          <div class="dNums" style="color:#6D7760;opacity:.65">休市或無交易</div></div>`;
        return;
      }
      h += `<div class="dRow" style="border-left-color:${色(i)}">
        <div class="dName">${nm}</div>
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

/** 摺疊區塊。開合狀態記在記憶體，重繪時還原；重開 App 則全部收起。 */
function 摺疊(key, 標題, 內容) {
  return `<details class="acc" data-acc="${key}" ${S.open[key] ? 'open' : ''}>
    <summary class="accHead">${標題}</summary>
    <div class="accBody">${內容}</div>
  </details>`;
}

function 設定畫面() {
  const box = $('#setupBody');
  const 天數 = 期間日期(S.rows).length;
  const isFish = S.category === 'fish';
  const 已安裝 = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  // 用最新一筆真實資料現場驗算，比寫死的例子可信，也不會過期
  let 範例 = '';
  const 樣 = S.rows.length ? S.rows[S.rows.length - 1] : null;
  if (樣) {
    const 算 = 0.2 * 樣.up + 0.6 * 樣.mid + 0.2 * 樣.low;
    範例 = `<br><br>拿 ${月日(樣.d)} ${esc(S.mkName[樣.mc] || 樣.mc)} 實際驗算：<br>`
         + `0.2×${錢(樣.up)} ＋ 0.6×${錢(樣.mid)} ＋ 0.2×${錢(樣.low)} ＝ `
         + `<b>${Math.round(算 * 100) / 100}</b><br>`
         + `行情站給的均價：<b>${錢(樣.avg)}</b>`;
  }

  const 市場鈕 = S.mkRank.length
    ? S.mkRank.map(m => {
        const i = S.markets.indexOf(m.code);
        const on = i >= 0;
        return `<button class="chip ${on ? 'on' : ''}" data-mk="${esc(m.code)}"
          ${on ? `style="background:${色(i)};border-color:${色(i)}"` : ''}
          >${esc(m.name)} <span class="num">${公斤(m.qty)}</span></button>`;
      }).join('')
    : '<div class="empty" style="padding:14px">還沒有資料</div>';
  const 已全選市場 = S.mkRank.length > 0
    && S.markets.length === S.mkRank.length
    && S.mkRank.every(m => S.markets.indexOf(m.code) >= 0);

  const 價格說明 = isFish ? `
    <div class="setRow">
      <h3>漁產的上價、中價、下價</h3>
      <p>畫面直接呈現漁業署「漁產品交易行情」提供的上價、中價、下價與平均價。不同魚市場、魚種與規格的交易組成可能不同，不套用蔬果的 20／60／20 解釋。</p>
    </div>
    <div class="setRow">
      <h3>怎麼看比較實用</h3>
      <p><b>平均價</b>適合快速掌握整體成交水準；<b>中價</b>可觀察中間行情；上價與下價拉得越開，代表當日成交價格分布越寬。<br><br>跨市場比較時，也要留意魚貨規格與交易量不同。</p>
    </div>
    <div class="setRow">
      <h3>近 N 日均價</h3>
      <p>本 App 以各日交易量加權，不讓少量交易日和大量交易日一樣重。這是方便看趨勢的整理值，不取代魚市場原始資料。</p>
    </div>` : `
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
    </div>`;

  const 更新說明 = isFish ? `
    <div class="setRow">
      <h3>漁產行情什麼時候更新</h3>
      <p>漁業署資料每日更新，但各魚市場的交易日與發布時間不一定相同。App 會保留上次成功資料，並在啟動或超過更新間隔後重試；也可以隨時按「重新整理」。</p>
    </div>
    <div class="setRow">
      <h3>各市場日期不同是正常的嗎</h3>
      <p>可能是休市、當天沒有這個魚種，或該市場資料尚未發布。漁產資料沒有另外提供休市列，因此 App 只會列出各市場實際出現的最新交易日，不會把缺少紀錄直接判定成休市或漏資料。</p>
    </div>
    <div class="setRow">
      <h3>近 N 個交易日</h3>
      <p>只計算實際有成交紀錄的日期，休市或沒有該魚種的日子不佔一格，讓走勢圖保有固定數量的資料點。</p>
    </div>` : `
    <div class="setRow">
      <h3>行情站什麼時候發布</h3>
      <p>行情站<b>當日下午</b>就會陸續發佈當天的成交資料，時間不固定，同一天可能補上多次。<br><br>
         這支 App 的作法是：只要手上還沒有今天的資料，每次打開就重試一次（最短間隔 30 分鐘）；
         已經拿到今天的資料就放慢，超過 6 小時才再抓。<br><br>
         想立刻確認最新狀況，按上面的重新整理，一定會即時去抓。<br><br>
         部分市場週一休市，遇國定假日也會停市。</p>
    </div>
    <div class="setRow">
      <h3>這兩個日期為什麼會不一樣</h3>
      <p><b>資料源涵蓋至</b>　API 這條管線更新到哪一天（含休市紀錄）。<br><br>
         <b>選定市場最新交易</b>　你選的市場最近一次實際成交的日子。<br><br>
         兩者不一致時，行情頁上方會標出原因，分成三種：<br><br>
         <b>休市</b>（米色）　那幾天有休市紀錄，市場沒開，屬正常。<br><br>
         <b>缺漏</b>（磚紅）　那幾天連休市紀錄都沒有，代表資料未匯入。市場其實有交易，官網查得到但 API 沒有。<br><br>
         <b>不同步</b>（磚紅）　某個市場落後其他市場兩天以上，通常是那個市場的資料還沒匯入。<br><br>
         <b>落後</b>（磚紅）　整條管線還沒發布到今天。<br><br>
         農業部開放平臺的資料偶爾會比行情站官網慢一到兩天。真的急著要，請直接查
         <b>農產品批發市場交易行情站</b>。</p>
    </div>
    <div class="setRow">
      <h3>「近 N 個交易日」不等於日曆天</h3>
      <p>算的是<b>實際有成交的日子</b>，休市日不佔數。所以近 7 個交易日通常橫跨 8 到 9 個日曆天。<br><br>
         這樣做是為了讓圖上永遠有固定數量的資料點；若改用日曆天，遇到連假那週會只剩四、五個點，胖瘦不一反而看不出趨勢。<br><br>
         實際涵蓋的起訖日期就標在行情頁圖表上方。</p>
    </div>`;

  const 隱私說明 = `
    <div class="setRow">
      <h3>匿名統計</h3>
      <p>本 App 使用 <b>Cloudflare Web Analytics</b> 統計匿名瀏覽數，用來了解有多少人在使用。<br><br>
         <b>不使用 cookie</b>、不做跨站追蹤、不記錄任何可識別個人的資料。<br><br>
         你選的類別、品項與市場只存在這台裝置的瀏覽器裡，不會傳送到任何地方。</p>
    </div>`;

  const 免責說明 = `
    <div class="setRow">
      <h3>資料未經驗證</h3>
      <p>本 App 直接呈現農業部公開資料，未經加工或驗證，可能因資料源延遲、休市或格式變動而不完整。<br><br>
         實際交易請以<b>農產品批發市場交易行情站</b>或<b>漁產品全球資訊網</b>原始資料為準。使用者依本 App 內容所做的任何決策，本 App 不負任何責任。</p>
    </div>
    <div class="setRow">
      <h3>資料來源</h3>
      <p>農業部農業資料開放平臺「農產品交易行情」與漁業署「漁產品交易行情」，依政府資料開放平臺資料使用規範利用。<br><br>
         本 App 為個人工具，與農業部無關。</p>
    </div>`;

  box.innerHTML = `
    <button class="btn wide" id="btnReload" ${S.loading ? 'disabled' : ''}>
      ${S.loading ? '更新中…' : '重新整理'}
    </button>

    <div class="secTitle">目前查詢</div>
    <div class="setRow">
      <h3>${esc(S.crop.name)}</h3>
      <p>${esc((CATEGORY[S.category] || CATEGORY.fruit).name)}品項代號 ${esc(S.crop.code)}．共 <b>${S.rows.length}</b> 筆，涵蓋 <b>${天數}</b> 個交易日。<br>
         資料源涵蓋至：<b>${S.coverage ? 月日(S.coverage) : '—'}</b><br>
         選定市場最新交易：<br>
         ${S.markets.map(mc => {
             const mine = S.rows.filter(r => r.mc === mc);
             const d = mine.length ? mine[mine.length - 1].d : null;
             return `　· ${esc(S.mkName[mc] || mc)}　<b>${d ? 月日(d) : '—'}</b>`;
           }).join('<br>') || '　—'}<br>
         最後抓取：<b>${S.fetchedAt ? 時刻(S.fetchedAt) : '尚未更新'}</b></p>
    </div>
    <button class="btn ghost wide" id="btnPickCrop">換大類或品項</button>

    <div class="secTitle">顯示哪些市場（已選 ${S.markets.length} 個）</div>
    <div class="mkTools">
      <button class="btn ghost wide" id="btnMkAll" ${S.mkRank.length ? '' : 'disabled'}>
        ${已全選市場 ? `取消全選，恢復交易量前 ${DEFAULT_MK} 大` : `全選全部 ${S.mkRank.length} 個市場`}
      </button>
    </div>
    <div class="mkGrid">${市場鈕}</div>
    <div class="setRow">
      <p>只列出這個品項近 ${FETCH_DAYS} 天有交易的市場，依總交易量排序。市場選擇沒有數量上限；換品項時先自動挑交易量前 ${DEFAULT_MK} 大，也可按上方按鈕全選。<br><br>選得越多，行情頁的圖表線條與市場卡也會越多，但不會增加 API 請求次數。</p>
    </div>

    <div class="secTitle">說明</div>
    ${摺疊('price',   '怎麼看這些價格', 價格說明)}
    ${摺疊('update',  '資料何時更新',   更新說明)}
    ${摺疊('privacy', '統計與隱私',     隱私說明)}
    ${摺疊('legal',   '免責與來源',     免責說明)}

    <div class="secTitle">安裝到手機 IOS/Android</div>
    <div class="setRow">
      <h3>${已安裝 ? '已經住進桌面了' : '像 App 一樣從桌面開啟'}</h3>
      <p>${已安裝
        ? '目前正以獨立 App 模式開啟，不會顯示瀏覽器網址列。'
        : 'Android 可把這個 PWA 安裝到主畫面，擁有自己的圖示、獨立視窗與離線快取。'}</p>
      <button class="btn wide" id="btnInstall" ${已安裝 ? 'disabled' : ''}>
        ${已安裝 ? '已安裝完成' : (S.installPrompt ? '安裝到主畫面' : '查看 Android 安裝方法')}
      </button>
    </div>

    <div class="secTitle">支持這個小工具</div>
    <div class="supportCard">
      <div class="supportMark" aria-hidden="true">♡</div>
      <h3>買杯咖啡支持☕</h3>
      <p>如果這個行情工具替你省下一點時間，歡迎請我喝杯咖啡，支持持續維護與更新。</p>
      <button class="btn wide" id="btnSupport">看看支持方式</button>
      <div class="supportNote">完全自願，不影響任何功能。</div>
    </div>

    <div class="secTitle">維護</div>
    <button class="dangerBtn ${S.armClear ? 'armed' : ''}" id="btnClear">
      <span class="dangerIcon">
        <svg viewBox="0 0 24 24"><path d="M4 7h16M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7"/><path d="M6.5 7l.9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10.5 11v5.5M13.5 11v5.5"/></svg>
      </span>
      <span class="dangerText">
        <b>${S.armClear ? '再按一次確認清除' : '清除本機資料與設定'}</b>
        <span>${S.armClear ? '此動作無法復原' : '清掉作物與市場選擇、快取，下次開啟重新載入'}</span>
      </span>
    </button>

    <div class="colophon">
      <p class="colophon-title">PRO-BRO AVOCADO</p>
      <div class="colophon-rule"></div>
      <p class="colophon-line">A field tool for growers, built on a
         family avocado farm in Nantou, Taiwan.</p>
      <p class="colophon-meta">${VERSION} &nbsp;·&nbsp; © ${new Date().getFullYear()}</p>
    </div>
  `;

  box.querySelectorAll('[data-acc]').forEach(d =>
    d.addEventListener('toggle', () => { S.open[d.dataset.acc] = d.open; }));

  $('#btnReload').addEventListener('click', () => 更新(true, false));
  $('#btnPickCrop').addEventListener('click', 開啟作物選單);
  $('#btnMkAll').addEventListener('click', () => {
    S.markets = 已全選市場
      ? S.mkRank.slice(0, DEFAULT_MK).map(m => m.code)
      : S.mkRank.map(m => m.code);
    if (S.focus && S.markets.indexOf(S.focus) < 0) S.focus = null;
    存選擇();
    toast(已全選市場 ? `已恢復交易量前 ${DEFAULT_MK} 大市場` : `已全選 ${S.markets.length} 個市場`);
    畫面();
  });
  $('#btnSupport').addEventListener('click', () => {
    S.sheet = 'support';
    畫面();
  });
  $('#btnInstall').addEventListener('click', async () => {
    if (S.installPrompt) {
      const prompt = S.installPrompt;
      S.installPrompt = null;
      await prompt.prompt();
      const choice = await prompt.userChoice;
      toast(choice.outcome === 'accepted' ? '正在安裝到主畫面' : '這次先不安裝');
      畫面();
      return;
    }
    S.sheet = 'install';
    畫面();
  });

  $('#btnClear').addEventListener('click', () => {
    if (!S.armClear) {                       // 破壞性動作要兩段式，誤觸不會直接清光
      S.armClear = true;
      畫面();
      clearTimeout(S.armTimer);
      S.armTimer = setTimeout(() => { S.armClear = false; 畫面(); }, 5000);
      return;
    }
    clearTimeout(S.armTimer);
    S.armClear = false;
    const bases = Object.values(LS);
    Object.keys(localStorage).forEach(k => {
      if (bases.some(base => k === base || k.startsWith(base + ':'))) localStorage.removeItem(k);
    });
    S.rows = []; S.mkName = {}; S.mkRank = []; S.markets = [];
    S.fetchedAt = null; S.coverage = null; S.cropList = [];
    S.crop = { ...CROP_DEFAULT }; S.category = CROP_DEFAULT.category;
    S.pickCategory = CROP_DEFAULT.category; S.focus = null; S.open = {};
    toast('已清除，重新載入中');
    更新(false, true);
  });

  box.querySelectorAll('[data-mk]').forEach(b =>
    b.addEventListener('click', () => {
      const mc = b.dataset.mk;
      const i = S.markets.indexOf(mc);
      if (i >= 0) {
        if (S.markets.length === 1) { toast('至少要留一個市場'); return; }
        S.markets.splice(i, 1);
        if (S.focus === mc) S.focus = null;
      } else {
        S.markets.push(mc);
      }
      存選擇();
      畫面();
    }));
}

/* ── 作物選單 ──────────────────────────────────────────── */
function 開啟作物選單() {
  S.sheet = 'crop'; S.q = ''; S.pickCategory = S.category;
  S.cropList = []; S.listErr = '';
  畫面();
  確保作物清單(S.pickCategory);
}

function 作物選單() {
  const host = $('#sheetHost');
  if (S.sheet === 'support') { 建立支持選單(host); return; }
  if (S.sheet === 'release') { 建立版本選單(host); return; }
  if (S.sheet === 'install') { 建立安裝選單(host); return; }
  if (S.sheet !== 'crop') { host.innerHTML = ''; return; }
  if (host.querySelector('#sheetBg')) { 填作物清單(); return; }
  建立作物選單(host);
}

function 建立安裝選單(host) {
  host.innerHTML = `<div class="sheet" id="installBg" role="dialog" aria-modal="true"
    aria-labelledby="installTitle">
    <div class="sheetBody">
      <h2 id="installTitle">把行情種在桌面</h2>
      <p>Android 手機用 Chrome 開啟網站後：</p>
      <ol class="supportSteps">
        <li>點右上角「⋮」選單。</li>
        <li>選「安裝應用程式」；若看到的是「加到主畫面」，也可以使用。</li>
        <li>確認安裝，桌面就會多一枚農漁行情圖示。</li>
      </ol>
      <div class="supportCaution">GitHub Pages 必須使用 HTTPS，且 icon-192.png、icon-512.png 與 icon-512-maskable.png 都要一併上傳。</div>
      <button class="btn wide" id="installClose">知道了，返回 App</button>
    </div>
  </div>`;
  $('#installClose').addEventListener('click', () => { S.sheet = null; 畫面(); });
  $('#installBg').addEventListener('click', e => {
    if (e.target.id === 'installBg') { S.sheet = null; 畫面(); }
  });
}

function 建立版本選單(host) {
  if (host.querySelector('#releaseBg')) return;
  host.innerHTML = `<div class="sheet" id="releaseBg" role="dialog" aria-modal="true"
    aria-labelledby="releaseTitle">
    <div class="sheetBody">
      <h2 id="releaseTitle">田邊的新鮮事</h2>
      <p class="releaseHello">風一吹，園裡又冒出幾個新芽<br>這是最近三次耕耘的小小收成🌱</p>
      <div class="releaseList">
        <article class="releaseItem">
          <div class="releaseHead"><span class="releaseVer">v1.8.2</span><span class="releaseSeason">本次收成</span></div>
          <p>第二層品項可用名稱／代碼搜尋，並補齊完整品項；市場選擇也解除上限，可一鍵全選。</p>
        </article>
        <article class="releaseItem">
          <div class="releaseHead"><span class="releaseVer">v1.8.1</span><span class="releaseSeason">上一季</span></div>
          <p>水果、蔬菜、漁產分畦排好，先挑大類再選品項；🐟魚市場行情也一起開張啦！</p>
        </article>
        <article class="releaseItem">
          <div class="releaseHead"><span class="releaseVer">v1.7.0</span><span class="releaseSeason">前一季</span></div>
          <p>新增「支持按鈕」，若小工具幫上忙，歡迎透過 LINE 請小農喝杯咖啡☕</p>
        </article>
      </div>
      <button class="btn wide" id="releaseClose">🚚 好，去逛今天的行情</button>
    </div>
  </div>`;
  $('#releaseClose').addEventListener('click', () => { S.sheet = null; 畫面(); });
}

function 建立支持選單(host) {
  host.innerHTML = `<div class="sheet" id="supportBg" role="dialog" aria-modal="true"
    aria-labelledby="supportTitle">
    <div class="sheetBody">
      <h2 id="supportTitle">買杯咖啡支持☕</h2>
      <p>謝謝你願意支持這個農漁產行情小工具</p>
      <ol class="supportSteps">
        <li>先點下方按鈕，把我加入 LINE 好友。</li>
        <li>到聊天室點「＋」→ 轉帳/小小打氣</li>
        <li>謝謝您的支持☕</li>
      </ol>
      <div class="supportCaution">轉帳完成後無法取消；雙方都必須已開通 LINE Pay Money。請依自己的心意與能力支持</div>
      ${LINE_FRIEND_URL
        ? `<a class="btn wide" id="supportLine" href="${esc(LINE_FRIEND_URL)}"
             target="_blank" rel="noopener noreferrer">開啟 LINE 加好友</a>`
        : '<button class="btn wide" disabled>尚未設定 LINE 連結</button>'}
      <button class="btn ghost wide" id="supportClose">先不用，返回 App</button>
    </div>
  </div>`;

  const 關 = () => { S.sheet = null; 畫面(); };
  $('#supportClose').addEventListener('click', 關);
  $('#supportBg').addEventListener('click', e => { if (e.target.id === 'supportBg') 關(); });
}

function 作物搜尋鍵(value) {
  let key = String(value == null ? '' : value);
  try { key = key.normalize('NFKC'); } catch (e) { /* 舊瀏覽器照原字串搜尋 */ }
  // 名稱中的空格、連字號只是排版差異；「酪梨進口」也要能找到「酪梨-進口」。
  return key.trim().toUpperCase().replace(/[\s\-－—_·・／/]+/g, '');
}

function 符合搜尋的作物() {
  const q = 作物搜尋鍵(S.q);
  if (!q) return S.cropList.slice();
  return S.cropList.filter(c =>
    作物搜尋鍵(c.code).includes(q) || 作物搜尋鍵(c.name).includes(q));
}

function 填作物清單() {
  const cat = $('#categoryPick');
  const search = $('#itemSearch');
  const item = $('#itemPick');
  const help = $('#pickHelp');
  const go = $('#pickGo');
  if (!cat || !search || !item || !help || !go) return;
  cat.value = S.pickCategory;
  if (search.value !== S.q) search.value = S.q;
  if (S.listLoading) {
    item.innerHTML = '<option value="">正在採收清單，請稍候…</option>';
    search.disabled = true; item.disabled = true; go.disabled = true;
    help.textContent = '第一次載入這個大類，可能需要幾秒。';
    return;
  }
  if (S.listErr) {
    item.innerHTML = '<option value="">暫時取不到品項</option>';
    search.disabled = true; item.disabled = true; go.disabled = true;
    help.textContent = S.listErr;
    return;
  }
  search.disabled = !S.cropList.length;

  const previous = item.value;
  const found = 符合搜尋的作物();
  const options = found.map(c =>
    `<option value="${esc(c.code)}" data-name="${esc(c.name)}">${esc(c.code)}｜${esc(c.name)}　${c.qty > 0 ? 公斤(c.qty) : '近期未成交'}</option>`).join('');
  item.innerHTML = `<option value="">${S.q ? '請選擇符合品項' : '請選擇品項'}</option>` + options;

  const q = 作物搜尋鍵(S.q);
  const exact = q && found.find(c =>
    作物搜尋鍵(c.code) === q || 作物搜尋鍵(c.name) === q);
  const only = q && found.length === 1 ? found[0] : null;
  const samePrevious = found.some(c => c.code === previous) ? previous : '';
  const sameCurrent = S.pickCategory === S.category && found.some(c => c.code === S.crop.code)
    ? S.crop.code : '';
  item.value = (exact || only || {}).code || samePrevious || sameCurrent;

  item.disabled = !found.length;
  go.disabled = !item.value;
  if (S.q && found.length) {
    const chosen = found.find(c => c.code === item.value);
    help.textContent = chosen
      ? chosen.qty > 0
        ? `已選取 ${chosen.code}｜${chosen.name}；按 Enter 可直接查看。`
        : `已選取 ${chosen.code}｜${chosen.name}；最近交易日未成交，仍可查看近 ${FETCH_DAYS} 天行情。`
      : `找到 ${found.length} 個品項，請從下拉選單挑一個。`;
  } else if (S.q) {
    help.textContent = `找不到「${S.q}」，請換個名稱、代碼或確認大類。`;
  } else {
    help.textContent = S.cropList.length
      ? `可輸入名稱或代碼搜尋；近期有成交的排前面，完整代碼共 ${S.cropList.length} 個品項。`
      : '這個大類最近沒有交易品項。';
  }
}

function 建立作物選單(host) {
  host.innerHTML = `<div class="sheet" id="sheetBg">
    <div class="sheetBody">
      <h2>選擇行情品項</h2>
      <p>先選大類，再挑今天想看的細項。</p>
      <label class="fieldLabel" for="categoryPick">第一步・大類</label>
      <select class="field pickField" id="categoryPick">
        ${Object.keys(CATEGORY).map(k => `<option value="${k}">${CATEGORY[k].name}</option>`).join('')}
      </select>
      <label class="fieldLabel" for="itemSearch">第二步・搜尋名稱或代碼</label>
      <input class="field itemSearchField" id="itemSearch" type="search"
        placeholder="例如：酪梨、G3" autocomplete="off" autocapitalize="characters"
        spellcheck="false" enterkeyhint="search" aria-describedby="pickHelp">
      <select class="field pickField" id="itemPick" aria-label="符合搜尋的品項"></select>
      <div class="pickHelp" id="pickHelp"></div>
      <button class="btn wide" id="pickGo" disabled>查看這個品項</button>
      <button class="btn ghost wide" id="sheetClose" style="margin-top:12px">關閉</button>
    </div>
  </div>`;

  填作物清單();

  const 關 = () => { S.sheet = null; S.q = ''; S.cropList = []; 畫面(); };
  $('#sheetClose').addEventListener('click', 關);
  $('#sheetBg').addEventListener('click', e => { if (e.target.id === 'sheetBg') 關(); });
  $('#categoryPick').addEventListener('change', e => {
    S.pickCategory = e.target.value;
    S.q = ''; S.cropList = []; S.listErr = '';
    填作物清單();
    確保作物清單(S.pickCategory);
  });
  let composing = false;
  const search = $('#itemSearch');
  const 套用搜尋 = () => { S.q = search.value; 填作物清單(); };
  search.addEventListener('compositionstart', () => { composing = true; });
  search.addEventListener('compositionend', () => { composing = false; 套用搜尋(); });
  search.addEventListener('input', e => { if (!composing && !e.isComposing) 套用搜尋(); });
  search.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if ($('#itemPick').value) $('#pickGo').click();
    else toast('請先輸入正確的名稱或代碼');
  });
  $('#itemPick').addEventListener('change', e => { $('#pickGo').disabled = !e.target.value; });
  $('#pickGo').addEventListener('click', () => {
    const item = $('#itemPick');
    const opt = item.options[item.selectedIndex];
    if (!item.value || !opt) return;
    換作物(item.value, opt.dataset.name || opt.textContent.trim(), S.pickCategory);
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
$('#cropBtn').addEventListener('click', 開啟作物選單);

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  S.installPrompt = e;
  畫面();
});
window.addEventListener('appinstalled', () => {
  S.installPrompt = null;
  toast('已安裝到主畫面');
  畫面();
});

/* ── 啟動 ──────────────────────────────────────────────── */
(function init() {
  讀選擇();
  const 有快取 = 讀快取();
  if (有快取) { 算市場排行(); 校正市場選擇(false); }
  S.sheet = 'release';
  畫面();                     // 先用快取畫出來，不讓使用者盯著空白

  if (需要更新()) 更新(false, false);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (需要更新()) 更新(false, false);
  });
})();
