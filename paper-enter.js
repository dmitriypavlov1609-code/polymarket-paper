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

// направленные результативные топы (не ММ)
const tops = lb.data
  .filter(t => (t.copy_backtest_pnl || 0) > 150000 && (t.copy_loss_rate ?? 99) < 18 && (t.hedged_pct || 0) < 60)
  .sort((a, b) => (b.copy_backtest_pnl || 0) - (a.copy_backtest_pnl || 0))
  .slice(0, 14);

// собираем кандидатов по всем топам
const cands = [];
const seenMarket = new Set();
for (const t of tops) {
  const pos = await jget(`https://data-api.polymarket.com/positions?user=${t.address}&sizeThreshold=4000`);
  for (const x of (Array.isArray(pos) ? pos : [])) {
    const cv = +x.currentValue, cur = +x.curPrice, avg = +x.avgPrice;
    if (!(cv >= 5000)) continue;
    if (!(cur >= 0.25 && cur <= 0.9)) continue;        // не крайности, но фаворитов пускаем
    const isSingle = !multiDay(x.title);
    if (isSingle && cv < 30000) continue;              // одиночный матч — только с ОГРОМНОЙ конвикцией топа
    const lag = avg > 0 ? (cur - avg) / avg : 1;
    if (Math.abs(lag) > 0.2) continue;                 // не гнаться за убежавшей ценой
    const yield_ = (1 / cur - 1) * 100;
    if (yield_ < 8) continue;                           // минимальный апсайд
    if (heldAssets.has(x.asset)) continue;
    const mkey = (x.title || "").replace(/\?.*/, "").slice(0, 40);
    cands.push({
      asset: x.asset, title: x.title, side: x.outcome, cur, avg,
      cv, yield_, lag, mkey, isSingle,
      topAddr: t.address, topPnl: Math.round(t.actual_pnl || 0),
      topLabel: "top$" + Math.round((t.actual_pnl || 0) / 1000) + "k",
      cat: category(x.title),
      conv: cv,
    });
  }
}
// приоритет: консенсус по рынку (несколько топов) → большая конвикция → больший yield
const byMarket = {};
for (const c of cands) { (byMarket[c.mkey] = byMarket[c.mkey] || []).push(c); }
const ranked = [];
for (const [mk, arr] of Object.entries(byMarket)) {
  arr.sort((a, b) => b.conv - a.conv);
  const best = arr[0];
  best.consensus = arr.length;
  best.conv = arr.reduce((s, c) => s + c.conv, 0);   // суммарная конвикция по рынку
  ranked.push(best);
}
ranked.sort((a, b) => (b.consensus - a.consensus) || (b.conv - a.conv) || (b.yield_ - a.yield_));

// диверсификация: не более 3 позиций на категорию
let deployed = (st.open || []).reduce((a, p) => a + p.cost, 0);
const catCount = {}; for (const p of (st.open || [])) catCount[p.cat] = (catCount[p.cat] || 0) + 1;
const added = [];
for (const c of ranked) {
  if ((st.open || []).length >= MAX_OPEN) break;
  if ((catCount[c.cat] || 0) >= 4) continue;
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
