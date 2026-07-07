// АВТО-ВХОД follow-tops: сканирует лидерборд polycop, находит крупные МНОГОДНЕВНЫЕ
// направленные позиции топов, заходит близко к их цене, размер ∝ конвикции.
// Запуск: node paper-enter.js            (обычный цикл — доливает до целевого числа позиций)
//         node paper-enter.js reset300   (сброс банка на $300 и свежий набор)
import { readFileSync, writeFileSync } from "node:fs";

const jget = async (u) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch {} await new Promise(s => setTimeout(s, 1000)); } return null; };

const RESET = process.argv[2] === "reset300";
let st;
if (RESET) {
  st = { startBalance: 300, cash: 300, equity: 300, totalPnl: 0, open: [], closed: [], log: ["🔄 РЕСТАРТ банка $300 — follow-tops, упор на многодневные рынки"], tops: [], whales: [], stats: {}, updated: new Date().toISOString() };
} else {
  st = JSON.parse(readFileSync("paper-state.json", "utf8"));
}

const MAX_OPEN = 12;
const MAX_DEPLOY = st.startBalance * 0.70;   // держим ~30% кэша сухим порохом
const heldAssets = new Set((st.open || []).map(p => p.asset));
// рынок-ключ = нормализованный заголовок без хвоста вопроса (чтобы не влезать во ВСТРЕЧНУЮ сторону того же рынка)
const mkey0 = (t) => (t || "").replace(/\?.*$/, "").trim().toLowerCase();
const heldMarkets = new Set((st.open || []).map(p => mkey0(p.title)));

function category(title) {
  const t = (title || "").toLowerCase();
  if (/bitcoin|btc|ethereum|eth|solana| sol |xrp|dogecoin|crypto/.test(t)) return "Крипта";
  if (/election|president|trump|vance|congress|senate|governor|primary|democrat|republican|putin|zelensky|mamdani|nyc mayor/.test(t)) return "Политика";
  if (/\bai\b|openai|xai|gpt|tesla|model|grok|llm|agi/.test(t)) return "Технологии";
  if (/win|cup|league|match|vs\.|corners|goal|assist|fifa|nba|nfl|nhl/.test(t)) return "Спорт";
  return "Прочее";
}
// многодневный низкодисперсный? (крипто-диапазоны, политика, макро с горизонтом) — НЕ спорт-матч-одиночка
function multiDay(title) {
  const t = (title || "").toLowerCase();
  if (/vs\.| vs |corners|assist|to score|wimbledon|match|game \d/.test(t)) return false; // одиночный матч
  return true;
}

// конвикция топа → размер бумаги. single-event = ЛОТЕРЕЙНЫЙ потолок (диверсифицируем как кит)
function sizeFor(convUsd, topPnl, isSingle) {
  let base = convUsd >= 200000 ? 30 : convUsd >= 80000 ? 24 : convUsd >= 30000 ? 20 : convUsd >= 10000 ? 16 : 12;
  if (topPnl >= 1000000) base *= 1.1;
  if (isSingle) base = Math.min(base, 14);   // одиночный матч — только мелко
  return Math.round(base);
}

const lb = await jget("https://polycop.fun/api/leaderboard");
if (!lb || !lb.data) { console.log("нет лидерборда"); process.exit(1); }

// СКОР копируемости (из анализа): copyPnL × консистентность² × направленность × знак ROI.
// Ловим тех, за кем копир РЕАЛЬНО зарабатывает стабильно, а не просто с большим PnL.
const copyScore = (t) => {
  const cb = t.copy_backtest_pnl || 0, loss = t.copy_loss_rate ?? 99, hedge = t.hedged_pct || 0, roi = t.roi ? t.roi * 100 : 0;
  if (cb < 120000 || loss > 20 || hedge > 60) return -1;
  return (cb / 1000) * Math.pow(1 - loss / 100, 2) * (1 - hedge / 100) * (roi > 0 ? 1 : 0.4);
};
const tops = lb.data
  .map(t => ({ ...t, _sc: copyScore(t) }))
  .filter(t => t._sc > 0)
  .sort((a, b) => b._sc - a._sc)
  .slice(0, 20);

// собираем кандидатов по всем топам
const cands = [];
const FRESH_HOURS = 20;                 // «свежий вход» — сделка топа за последние N часов
const sinceTs = Math.floor(Date.now() / 1000) - FRESH_HOURS * 3600;
for (const t of tops) {
  const pos = await jget(`https://data-api.polymarket.com/positions?user=${t.address}&sizeThreshold=2000`);
  // карта asset → текущая цена/конвикция из книги топа
  const curMap = {};
  for (const x of (Array.isArray(pos) ? pos : [])) curMap[x.asset] = { cur: +x.curPrice, cv: +x.currentValue, title: x.title, side: x.outcome, avg: +x.avgPrice };

  // (A) СВЕЖИЕ ВХОДЫ — главный эдж: топ ТОЛЬКО купил, цена ещё у его цены входа
  const act = await jget(`https://data-api.polymarket.com/activity?user=${t.address}&limit=120`);
  const freshByAsset = {};
  for (const e of (Array.isArray(act) ? act : [])) {
    if (e.type !== "TRADE" || e.side !== "BUY" || e.timestamp < sinceTs) continue;
    const f = freshByAsset[e.asset] || (freshByAsset[e.asset] = { usd: 0, price: +e.price, title: e.title, outcome: e.outcome });
    f.usd += Number(e.usdcSize || 0); f.price = +e.price;
  }
  for (const [asset, f] of Object.entries(freshByAsset)) {
    const m = curMap[asset]; const cur = m ? m.cur : f.price;
    if (heldAssets.has(asset) || heldMarkets.has(mkey0(f.title))) continue;
    if (!(cur >= 0.12 && cur <= 0.96)) continue;
    const lag = f.price > 0 ? (cur - f.price) / f.price : 1;
    if (lag > 0.08) continue;                            // свежий, но цена уже ушла вверх >8% → эдж съеден
    if (f.usd < 800) continue;                            // топ вложил заметно
    const yield_ = (1 / cur - 1) * 100;
    const isSingle = !multiDay(f.title);
    if (isSingle && f.usd < 15000) continue;             // одиночные матчи — только очень крупный свежий вход
    cands.push({
      asset, title: f.title, side: f.outcome, cur, avg: f.price,
      cv: (m ? m.cv : f.usd), yield_, lag, mkey: (f.title || "").replace(/\?.*/, "").slice(0, 40), isSingle,
      topAddr: t.address, topPnl: Math.round(t.actual_pnl || 0),
      topLabel: "top$" + Math.round((t.actual_pnl || 0) / 1000) + "k 🔥свежий",
      cat: category(f.title), conv: (m ? m.cv : f.usd), fresh: true,
    });
  }

  // (B) СОСТАРИВШИЕСЯ КНИГИ — вторичный сигнал (для консенсуса), строгий lag/yield
  for (const x of (Array.isArray(pos) ? pos : [])) {
    const cv = +x.currentValue, cur = +x.curPrice, avg = +x.avgPrice;
    if (!(cv >= 2500)) continue;
    if (!(cur >= 0.25 && cur <= 0.9)) continue;
    const isSingle = !multiDay(x.title);
    if (isSingle && cv < 30000) continue;
    const lag = avg > 0 ? (cur - avg) / avg : 1;
    if (Math.abs(lag) > 0.2) continue;
    const yield_ = (1 / cur - 1) * 100;
    if (yield_ < 8) continue;
    if (heldAssets.has(x.asset)) continue;
    if (heldMarkets.has(mkey0(x.title))) continue;
    cands.push({
      asset: x.asset, title: x.title, side: x.outcome, cur, avg,
      cv, yield_, lag, mkey: (x.title || "").replace(/\?.*/, "").slice(0, 40), isSingle,
      topAddr: t.address, topPnl: Math.round(t.actual_pnl || 0),
      topLabel: "top$" + Math.round((t.actual_pnl || 0) / 1000) + "k",
      cat: category(x.title), conv: cv, fresh: false,
    });
  }
}
// приоритет: консенсус по рынку (несколько топов) → большая конвикция → больший yield
const byMarket = {};
for (const c of cands) { (byMarket[c.mkey] = byMarket[c.mkey] || []).push(c); }
const ranked = [];
for (const [mk, arr] of Object.entries(byMarket)) {
  arr.sort((a, b) => (b.fresh - a.fresh) || (b.conv - a.conv));   // свежий вход — представитель рынка
  const best = arr[0];
  best.consensus = new Set(arr.map(c => c.topAddr)).size;         // консенсус = число РАЗНЫХ топов
  best.fresh = arr.some(c => c.fresh);
  best.conv = arr.reduce((s, c) => s + c.conv, 0);
  ranked.push(best);
}
// приоритет: СВЕЖИЙ вход топа → консенсус разных топов → конвикция → апсайд
ranked.sort((a, b) => (b.fresh - a.fresh) || (b.consensus - a.consensus) || (b.conv - a.conv) || (b.yield_ - a.yield_));

// диверсификация: не более 3 позиций на категорию
let deployed = (st.open || []).reduce((a, p) => a + p.cost, 0);
const catCount = {}; for (const p of (st.open || [])) catCount[p.cat] = (catCount[p.cat] || 0) + 1;
const added = [];
for (const c of ranked) {
  if ((st.open || []).length >= MAX_OPEN) break;
  if ((catCount[c.cat] || 0) >= 4) continue;
  if (heldMarkets.has(mkey0(c.title))) continue;   // страховка от встречной стороны в этом же проходе
  const size = sizeFor(c.conv, c.topPnl, c.isSingle);
  const cost = +(size * c.cur).toFixed(2);
  if (deployed + cost > MAX_DEPLOY) continue;
  const p = {
    title: c.title, side: c.side, asset: c.asset,
    entry: +c.cur.toFixed(3), size, cost,
    bid: c.cur, value: cost, pnl: 0, cat: c.cat,
    followAddr: c.topAddr,
    followLabel: c.topLabel + (c.consensus > 1 ? ` ×${c.consensus}` : ""),
    ts: new Date().toISOString(),
  };
  st.open.push(p);
  heldMarkets.add(mkey0(c.title));
  deployed += cost;
  catCount[c.cat] = (catCount[c.cat] || 0) + 1;
  (st.log = st.log || []).push(`ВХОД: «${c.title.slice(0,40)}» ${c.side} @${c.cur.toFixed(2)} $${size} за ${c.topLabel}${c.consensus>1?` (консенсус ×${c.consensus})`:""} yield ${c.yield_.toFixed(0)}%`);
  added.push(p);
}

st.cash = +(st.startBalance - (st.open || []).reduce((a, p) => a + p.cost, 0) - (st.closed || []).reduce((a, c) => a + c.cost, 0) + (st.closed || []).reduce((a, c) => a + (c.exit * c.size), 0)).toFixed(2);
st.equity = +(st.cash + (st.open || []).reduce((a, p) => a + p.value, 0)).toFixed(2);
st.updated = new Date().toISOString();
writeFileSync("paper-state.json", JSON.stringify(st, null, 2));
console.log(`+${added.length} позиций | открыто ${st.open.length} | вложено $${deployed.toFixed(2)} | кэш $${st.cash} | эквити $${st.equity}`);
for (const p of added) console.log(`  ${p.cat.padEnd(9)} ${p.side} @${p.entry} $${p.size}  ${p.title.slice(0,42)}  ← ${p.followLabel}`);
