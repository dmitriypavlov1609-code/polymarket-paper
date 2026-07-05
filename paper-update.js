// Генератор данных для дашборда: марки позиций + наши киты + топы лидерборда + категории + тайм-статистика.
// Запуск: node paper-update.js   (сохраняет открытые/закрытые сделки и кэш из текущего state)
import { readFileSync, writeFileSync } from "node:fs";

const F = readFileSync("paper-state.json", "utf8");
const st = JSON.parse(F);

const jget = async (u) => { try { return await (await fetch(u)).json(); } catch { return null; } };
const bidOf = async (asset) => {
  const b = await jget(`https://clob.polymarket.com/book?token_id=${asset}`);
  return b ? Math.max(0, ...(b.bids || []).map(o => +o.price)) : 0;
};

function category(title) {
  const t = (title || "").toLowerCase();
  if (/bitcoin|btc|ethereum|eth|solana| sol |xrp|dogecoin|crypto|\$1,|\$2,|\$5[0-9],|\$6[0-9],|\$7[0-9],/.test(t)) return "Крипта";
  if (/election|president|trump|vance|congress|senate|governor|primary|democrat|republican|putin|zelensky/.test(t)) return "Политика";
  if (/\bai\b|openai|xai|gpt|tesla|model|grok|llm|agi/.test(t)) return "Технологии";
  if (/win|cup|league|match|vs\.|corners|goal|assist|fifa|nba|nfl/.test(t)) return "Спорт";
  return "Прочее";
}

// 1) марки открытых позиций
for (const p of st.open || []) {
  const bid = await bidOf(p.asset);
  p.bid = bid || p.bid || p.entry;
  p.value = +(p.bid * p.size).toFixed(2);
  p.pnl = +(p.value - p.cost).toFixed(2);
  p.cat = category(p.title);
}
st.equity = +((st.cash || 0) + (st.open || []).reduce((a, x) => a + x.value, 0)).toFixed(2);
st.totalPnl = +(st.equity - st.startBalance).toFixed(2);

// 2) тайм-статистика по закрытым (по exitTs)
const nowMs = Date.now();
const since = (h) => nowMs - h * 3600e3;
const clg = (from) => (st.closed || []).filter(c => new Date(c.exitTs || c.ts).getTime() >= from).reduce((a, c) => a + (c.pnl || 0), 0);
st.stats = {
  day: +clg(since(24)).toFixed(2),
  week: +clg(since(24 * 7)).toFixed(2),
  month: +clg(since(24 * 30)).toFixed(2),
  trades: (st.closed || []).length,
  winrate: (st.closed || []).length ? Math.round((st.closed.filter(c => c.pnl > 0).length / st.closed.length) * 100) : 0,
};

// 3) наши киты (нетто крипто-книга + топ)
const TRACKED = [
  ["0x72a0d79b4325638bc2bcfc9a2b8a380c2d81c059", "BTC-NO", "$332K · WR77%"],
  ["0x06dc51826bc524d9a83770e7de9dd7e005b04524", "ETH-whale", "$762K · WR73%"],
  ["0xcc500cbcc8b7cf5bd21975ebbea34f21b5644c82", "floor-whale", "copyPnL $514K · 0% hedge"],
];
const whales = [];
for (const [a, label, stat] of TRACKED) {
  const p = await jget(`https://data-api.polymarket.com/positions?user=${a}&sizeThreshold=50`);
  const mkt = {}; let tot = 0;
  for (const x of (Array.isArray(p) ? p : [])) {
    tot += Number(x.currentValue || 0);
    const k = (x.title || "").replace(/\?.*/, "");
    mkt[k] = (mkt[k] || 0) + (/yes/i.test(x.outcome) ? 1 : -1) * Number(x.currentValue || 0);
  }
  const top = Object.entries(mkt).filter(([k, v]) => Math.abs(v) > 2000).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 3)
    .map(([k, v]) => ({ m: k.replace(/Will (the price of )?/i, "").slice(0, 40), side: v > 0 ? "YES" : "NO", usd: Math.round(Math.abs(v)), cat: category(k) }));
  whales.push({ label, addr: a.slice(0, 6) + "…" + a.slice(-4), stat, book: Math.round(tot), top });
}
st.whales = whales;

// 4) НОВЫЕ ТОПЫ с polycop.fun лидерборда
const lb = await jget("https://polycop.fun/api/leaderboard");
const tops = [];
if (lb && lb.data) {
  const ranked = lb.data.filter(t => (t.copy_backtest_pnl || 0) > 100000).sort((a, b) => (b.copy_backtest_pnl || 0) - (a.copy_backtest_pnl || 0)).slice(0, 8);
  for (const t of ranked) {
    tops.push({
      addr: t.address.slice(0, 6) + "…" + t.address.slice(-4),
      copyPnl: Math.round((t.copy_backtest_pnl || 0) / 1000),
      realPnl: Math.round((t.actual_pnl || 0) / 1000),
      loss: Math.round(t.copy_loss_rate || 0),
      roi: t.roi ? Math.round(t.roi * 100) : null,
      hedged: Math.round(t.hedged_pct || 0),
    });
  }
}
st.tops = tops;

st.updated = new Date().toISOString();
writeFileSync("paper-state.json", JSON.stringify(st, null, 2));
console.log(`updated: equity $${st.equity} | open ${st.open.length} | whales ${whales.length} | tops ${tops.length} | day $${st.stats.day}`);
