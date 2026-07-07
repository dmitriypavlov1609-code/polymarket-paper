// ВЫХОДЫ follow-tops: по каждой открытой позиции проверяет, держит ли ещё топ наш asset.
// Если топ ИСЧЕЗ из позиции или сократил размер >50% от нашего входного ориентира → закрываем в бумаге.
// Holding-based (не SELL-лента). Запуск: node exit-check.js
import { readFileSync, writeFileSync } from "node:fs";

const jget = async (u) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch {} await new Promise(s => setTimeout(s, 1200)); } return null; };

const st = JSON.parse(readFileSync("paper-state.json", "utf8"));
const byTop = {};
const exits = [];
let ok = 0;

for (const p of st.open || []) {
  if (!p.followAddr) { ok++; continue; }
  if (!(p.followAddr in byTop)) byTop[p.followAddr] = await jget(`https://data-api.polymarket.com/positions?user=${p.followAddr}&sizeThreshold=1`);
  const pos = byTop[p.followAddr];
  if (pos === null) { console.log(`  ⚠ нет данных по топу: ${(p.title || "").slice(0, 24)} — оставляю`); ok++; continue; }
  const held = (Array.isArray(pos) ? pos : []).find(x => x.asset === p.asset);
  if (!held) { exits.push({ p, reason: "топ вышел" }); continue; }
  // сокращение >50%: запоминаем пиковую конвикцию топа в позиции, если упала вдвое — это частичный выход
  const cv = Number(held.currentValue || 0);
  p.topPeak = Math.max(p.topPeak || 0, cv);
  if (p.topPeak > 3000 && cv < p.topPeak * 0.5) { exits.push({ p, reason: `топ сократил >50% ($${Math.round(p.topPeak)}→$${Math.round(cv)})` }); continue; }
  ok++;
}

for (const { p, reason } of exits) {
  const b = await jget(`https://clob.polymarket.com/book?token_id=${p.asset}`);
  const bid = b ? Math.max(0, ...(b.bids || []).map(o => +o.price)) : p.entry;
  const proceeds = +(bid * p.size).toFixed(2);
  const pnl = +(proceeds - p.cost).toFixed(2);
  (st.closed = st.closed || []).push({ title: p.title, side: p.side, entry: p.entry, exit: +bid.toFixed(3), size: p.size, cost: p.cost, pnl, proceeds, exitTs: new Date().toISOString(), followLabel: p.followLabel || "", followAddr: p.followAddr || "", reason });
  (st.log = st.log || []).push(`ВЫХОД вслед за топом (${reason}): «${(p.title || "").slice(0, 36)}» @${bid.toFixed(2)} ${pnl >= 0 ? "+" : ""}$${pnl}`);
}
if (exits.length) {
  const set = new Set(exits.map(e => e.p));
  st.open = (st.open || []).filter(p => !set.has(p));
}
// пересчёт кэша/эквити
st.cash = +(st.startBalance - (st.open || []).reduce((a, p) => a + p.cost, 0) - (st.closed || []).reduce((a, c) => a + c.cost, 0) + (st.closed || []).reduce((a, c) => a + (c.exit * c.size), 0)).toFixed(2);
st.equity = +(st.cash + (st.open || []).reduce((a, p) => a + (p.value || p.cost), 0)).toFixed(2);
writeFileSync("paper-state.json", JSON.stringify(st, null, 2));
console.log(`exit-check: держат ${ok} | вышли ${exits.length}${exits.length ? " → " + exits.map(e => (e.p.title || "").slice(0, 18)).join(", ") : ""}`);
