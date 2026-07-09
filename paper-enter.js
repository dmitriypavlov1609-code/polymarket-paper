// АВТО-ВХОД follow-tops по СПЕКУ (polymarket_agent_prompt.md): дисциплинированный copy-trading.
// Только свежие входы проверенных лидеров, жёсткий риск-менеджмент, сохранение капитала важнее прибыли.
// Запуск: node paper-enter.js  |  node paper-enter.js reset300
import { readFileSync, writeFileSync } from "node:fs";

const jget = async (u) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch {} await new Promise(s => setTimeout(s, 900)); } return null; };

const RESET = process.argv[2] === "reset300";
let st;
if (RESET) {
  st = { startBalance: 300, cash: 300, equity: 300, peakEquity: 300, totalPnl: 0, halt: null, open: [], closed: [], log: ["🔄 РЕСТАРТ банка $300 — дисциплинированный copy-trading по спеку"], tops: [], whales: [], stats: {}, updated: new Date().toISOString() };
} else {
  st = JSON.parse(readFileSync("paper-state.json", "utf8"));
}

// ── РИСК-СТОП: если торговля остановлена (дневной/недельный/просадка) — не входим ──
if (st.halt && st.halt.until && Date.now() < new Date(st.halt.until).getTime()) {
  console.log(`+0 позиций | ⛔ ТОРГОВЛЯ ОСТАНОВЛЕНА (${st.halt.reason}) до ${st.halt.until}`);
  process.exit(0);
}

const BANK = st.equity || st.startBalance;         // текущий банкролл
const MAX_POS = BANK * 0.02;                         // ≤2% банка на позицию
const MAX_EXPOSURE = BANK * 0.25;                    // ≤25% суммарная экспозиция
const MAX_OPEN = 15;
const MAX_CAT = 3;                                   // ≤3 позиции на категорию (коррелир. риск)
const MAX_PER_TOP = 3;
const FRESH_MIN = 20;                                // детект свежих сделок лидера за N минут (~<10-15 мин лаг при cron 6мин)
const LAG_PP = 0.03;                                 // цена сдвинулась ≤3 п.п. от входа лидера
const PRICE_MIN = 0.05, PRICE_MAX = 0.95;            // блэклист крайних цен
const MIN_HOURS = 48;                                // ≥48ч до разрешения (без паники последних часов / лайв-матчей)
const MIN_VOL = 10000;                               // суточный объём рынка ≥ $10k
const MIN_LEADER_USD = 500;                          // лидер вложил заметно

const heldAssets = new Set((st.open || []).map(p => p.asset));
const mkey0 = (t) => (t || "").replace(/\?.*$/, "").trim().toLowerCase();
const heldMarkets = new Set((st.open || []).map(p => mkey0(p.title)));
const COOLDOWN_H = 8;
const cdCut = Date.now() - COOLDOWN_H * 3600e3;
const recentlyClosed = new Set((st.closed || []).filter(c => c.asset && new Date(c.exitTs || 0).getTime() > cdCut).map(c => c.asset));
const recentlyClosedMkt = new Set((st.closed || []).filter(c => new Date(c.exitTs || 0).getTime() > cdCut).map(c => mkey0(c.title)));

function category(title) {
  const t = (title || "").toLowerCase();
  if (/bitcoin|btc|ethereum|eth|solana| sol |xrp|dogecoin|crypto/.test(t)) return "Крипта";
  if (/\bvs\.?\b| vs |spread|half.?time|corners|o\/u| total|to advance|leading at|end in a draw|win on 20\d\d|\bufc\b|\bfifa\b|world cup|\bleague\b|\bnba\b|\bnfl\b|\bnhl\b|wimbledon|\batp\b|\bwta\b|to score|assist|goal/.test(t)) return "Спорт";
  if (/election|president|trump|\bvance\b|congress|senate|governor|primary|democrat|republican|putin|zelensky|mamdani|nyc mayor|nominee/.test(t)) return "Политика";
  if (/\bai\b|openai|xai|gpt|tesla|model|grok|llm|agi/.test(t)) return "Технологии";
  if (/\bwin\b|championship|\btitle\b|\bcup\b/.test(t)) return "Спорт";
  return "Прочее";
}

const lb = await jget("https://polycop.fun/api/leaderboard");
if (!lb || !lb.data) { console.log("нет лидерборда"); process.exit(1); }

// Отбор 5-10 лидеров: стабильные, направленные, положит. ROI, низкий loss_rate
const copyScore = (t) => {
  const cb = t.copy_backtest_pnl || 0, loss = t.copy_loss_rate ?? 99, hedge = t.hedged_pct || 0, roi = t.roi ? t.roi * 100 : 0;
  const wr = (t.win_rate > 1 ? t.win_rate : (t.win_rate || 0) * 100);
  if (cb < 150000 || loss > 13 || hedge > 55 || roi <= 0) return -1;
  return (cb / 1000) * Math.pow(1 - loss / 100, 2) * (1 - hedge / 100) * (0.7 + wr / 200);
};
const tops = lb.data.map(t => ({ ...t, _sc: copyScore(t) })).filter(t => t._sc > 0).sort((a, b) => b._sc - a._sc).slice(0, 10);

// сканируем позиции всех лидеров: строим карту рынок→{asset→Set(лидеров)} для проверки конфликта сторон
const mktAssets = {};   // mkey -> { asset -> Set(topAddr) }
const posByTop = {};
for (const t of tops) {
  const pos = await jget(`https://data-api.polymarket.com/positions?user=${t.address}&sizeThreshold=1000`);
  posByTop[t.address] = Array.isArray(pos) ? pos : [];
  for (const x of posByTop[t.address]) {
    if (!(+x.currentValue >= 1000)) continue;
    const mk = mkey0(x.title);
    (mktAssets[mk] = mktAssets[mk] || {});
    (mktAssets[mk][x.asset] = mktAssets[mk][x.asset] || new Set()).add(t.address);
  }
}
// сколько лидеров стоят на ПРОТИВОПОЛОЖНОЙ стороне рынка (другой asset того же mkey)
const opposedCount = (mk, asset) => {
  const m = mktAssets[mk]; if (!m) return 0;
  const s = new Set();
  for (const [a, tset] of Object.entries(m)) if (a !== asset) for (const tp of tset) s.add(tp);
  return s.size;
};

// собираем СВЕЖИЕ кандидаты (сделка лидера за FRESH_MIN минут)
const sinceTs = Math.floor(Date.now() / 1000) - FRESH_MIN * 60;
const raw = [];
for (const t of tops) {
  const curMap = {};
  for (const x of posByTop[t.address]) curMap[x.asset] = { cur: +x.curPrice, cv: +x.currentValue, avg: +x.avgPrice };
  const act = await jget(`https://data-api.polymarket.com/activity?user=${t.address}&limit=60`);
  const fresh = {};
  for (const e of (Array.isArray(act) ? act : [])) {
    if (e.type !== "TRADE" || e.side !== "BUY" || e.timestamp < sinceTs) continue;
    const f = fresh[e.asset] || (fresh[e.asset] = { usd: 0, price: +e.price, title: e.title, outcome: e.outcome, ts: e.timestamp });
    f.usd += Number(e.usdcSize || 0); f.price = +e.price; f.ts = Math.max(f.ts, e.timestamp);
  }
  for (const [asset, f] of Object.entries(fresh)) {
    const m = curMap[asset];
    if (!m || m.cv < 2000) continue;                                  // лидер ещё держит
    if (heldAssets.has(asset) || heldMarkets.has(mkey0(f.title))) continue;
    if (recentlyClosed.has(asset) || recentlyClosedMkt.has(mkey0(f.title))) continue;
    if (f.usd < MIN_LEADER_USD) continue;
    raw.push({ asset, title: f.title, side: f.outcome, cur: m.cur, avg: f.price, usd: f.usd,
      topAddr: t.address, topPnl: Math.round(t.actual_pnl || 0), topLabel: "top$" + Math.round((t.actual_pnl || 0) / 1000) + "k 🔥", cat: category(f.title) });
  }
}

// дедуп по рынку (один кандидат на рынок, самый свежий крупный)
const byMkt = {};
for (const c of raw) { const k = mkey0(c.title); if (!byMkt[k] || c.usd > byMkt[k].usd) byMkt[k] = c; }
const cands = Object.values(byMkt);

// ── жёсткие фильтры входа (все обязательны) ──
let deployed = (st.open || []).reduce((a, p) => a + p.cost, 0);
const catCount = {}; for (const p of (st.open || [])) catCount[p.cat] = (catCount[p.cat] || 0) + 1;
const topCount = {}; for (const p of (st.open || [])) topCount[p.followAddr] = (topCount[p.followAddr] || 0) + 1;
const added = [], rej = {};
const bump = k => rej[k] = (rej[k] || 0) + 1;

for (const c of cands) {
  if ((st.open || []).length >= MAX_OPEN) break;
  const mk = mkey0(c.title);
  // 1) цена в допустимом диапазоне
  if (!(c.cur >= PRICE_MIN && c.cur <= PRICE_MAX)) { bump("цена вне 5-95¢"); continue; }
  // 2) лаг ≤3 п.п. абсолютных от входа лидера
  if (Math.abs(c.cur - c.avg) > LAG_PP) { bump("лаг >3пп"); continue; }
  // 3) конфликт: ≥2 лидера на встречной стороне → пропуск
  if (opposedCount(mk, c.asset) >= 2) { bump("≥2 лидера против"); continue; }
  // 4) потолки диверсификации
  if ((catCount[c.cat] || 0) >= MAX_CAT) { bump("потолок категории"); continue; }
  if ((topCount[c.topAddr] || 0) >= MAX_PER_TOP) { bump("потолок на топа"); continue; }
  if (heldMarkets.has(mk)) { bump("уже держим рынок"); continue; }
  // 5) рынок: ≥48ч до резолва + объём ≥ $10k (gamma). Читаем и активный, и closed.
  let g = await jget(`https://gamma-api.polymarket.com/markets?clob_token_ids=${c.asset}`);
  let mObj = Array.isArray(g) ? g[0] : g;
  if (!mObj) { bump("нет данных рынка"); continue; }
  const end = mObj.endDate ? new Date(mObj.endDate).getTime() : 0;
  if (!end || (end - Date.now()) < MIN_HOURS * 3600e3) { bump("<48ч до резолва"); continue; }
  const vol = Number(mObj.volume24hr || mObj.volumeClob || mObj.volume || 0);
  if (vol && vol < MIN_VOL) { bump("объём <$10k"); continue; }
  // 6) ликвидность: наш (маленький) ордер не двигает цену >1пп — проверяем глубину asks в пределах 1пп
  const size = Math.max(1, Math.floor(Math.min(MAX_POS, MAX_EXPOSURE - deployed) / c.cur));
  if (size < 1 || deployed + size * c.cur > MAX_EXPOSURE + 0.01) { bump("лимит экспозиции 25%"); continue; }
  const book = await jget(`https://clob.polymarket.com/book?token_id=${c.asset}`);
  const asks = book ? (book.asks || []).map(o => ({ p: +o.price, s: +o.size })).filter(o => o.p <= c.cur + 0.01) : [];
  const depth = asks.reduce((a, o) => a + o.s, 0);
  if (book && depth < size) { bump("мало ликвидности"); continue; }
  // ── ВХОД ──
  const cost = +(size * c.cur).toFixed(2);
  const p = {
    title: c.title, side: c.side, asset: c.asset, entry: +c.cur.toFixed(3), size, cost,
    bid: c.cur, value: cost, pnl: 0, cat: c.cat, followAddr: c.topAddr,
    followLabel: c.topLabel, ts: new Date().toISOString(),
  };
  st.open.push(p);
  heldMarkets.add(mk); deployed += cost;
  catCount[c.cat] = (catCount[c.cat] || 0) + 1; topCount[c.topAddr] = (topCount[c.topAddr] || 0) + 1;
  (st.log = st.log || []).push(`ВХОД: «${c.title.slice(0,40)}» ${c.side} @${c.cur.toFixed(3)} $${size} (лаг ${((c.cur-c.avg)*100).toFixed(1)}пп) за ${c.topLabel}`);
  added.push(p);
}

st.cash = +(st.startBalance - (st.open || []).reduce((a, p) => a + p.cost, 0) - (st.closed || []).reduce((a, c) => a + c.cost, 0) + (st.closed || []).reduce((a, c) => a + (c.exit * c.size), 0)).toFixed(2);
st.equity = +(st.cash + (st.open || []).reduce((a, p) => a + p.value, 0)).toFixed(2);
st.peakEquity = Math.max(st.peakEquity || st.startBalance, st.equity);
st.updated = new Date().toISOString();
writeFileSync("paper-state.json", JSON.stringify(st, null, 2));
const rejStr = Object.entries(rej).map(([k, n]) => k + ":" + n).join(", ");
console.log(`+${added.length} позиций | кандидатов свежих ${cands.length} | открыто ${st.open.length} | экспозиция $${deployed.toFixed(2)}/${MAX_EXPOSURE.toFixed(0)} | кэш $${st.cash}${rejStr ? " | отказы: " + rejStr : ""}`);
for (const p of added) console.log(`  ${p.cat.padEnd(9)} ${p.side} @${p.entry} $${p.size}  ${p.title.slice(0,42)}  ← ${p.followLabel}`);
