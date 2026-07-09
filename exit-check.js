// ВЫХОДЫ follow-tops: по каждой открытой позиции проверяет, держит ли ещё топ наш asset.
// Если топ ИСЧЕЗ из позиции или сократил размер >50% от нашего входного ориентира → закрываем в бумаге.
// Holding-based (не SELL-лента). Запуск: node exit-check.js
import { readFileSync, writeFileSync } from "node:fs";

const jget = async (u) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch {} await new Promise(s => setTimeout(s, 1200)); } return null; };

const GRACE_MIN = 45;   // свежую позицию не трогаем первые 45 мин (защита от черна вход↔выход)
const st = JSON.parse(readFileSync("paper-state.json", "utf8"));
const byTop = {};
const exits = [];
let ok = 0, skippedFresh = 0;

for (const p of st.open || []) {
  if (!p.followAddr) { ok++; continue; }
  // грейс: не выходим из только что открытой позиции
  const ageMin = p.ts ? (Date.now() - new Date(p.ts).getTime()) / 60000 : 999;
  if (ageMin < GRACE_MIN) { skippedFresh++; ok++; continue; }
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

const closedSet = new Set();
for (const { p, reason } of exits) {
  const b = await jget(`https://clob.polymarket.com/book?token_id=${p.asset}`);
  const bids = b ? (b.bids || []).map(o => +o.price).filter(x => x > 0) : [];
  const bid = bids.length ? Math.max(...bids) : null;
  // не можем оценить (пустой/недоступный стакан — часто рынок резолвится) → НЕ закрываем фейково, оставляем на резолв paper-update
  if (bid === null) { console.log(`  ⏸ ${(p.title || "").slice(0, 22)}: топ вышел, но стакан пуст → оставляю на резолв`); ok++; continue; }
  const proceeds = +(bid * p.size).toFixed(2);
  const pnl = +(proceeds - p.cost).toFixed(2);
  (st.closed = st.closed || []).push({ title: p.title, side: p.side, entry: p.entry, exit: +bid.toFixed(3), size: p.size, cost: p.cost, pnl, proceeds, entryTs: p.ts || null, exitTs: new Date().toISOString(), followLabel: p.followLabel || "", followAddr: p.followAddr || "", asset: p.asset, reason });
  (st.log = st.log || []).push(`ВЫХОД вслед за топом (${reason}): «${(p.title || "").slice(0, 36)}» @${bid.toFixed(2)} ${pnl >= 0 ? "+" : ""}$${pnl}`);
  closedSet.add(p);
}
if (closedSet.size) st.open = (st.open || []).filter(p => !closedSet.has(p));

// ── ЧАСТИЧНЫЙ ТЕЙК-ПРОФИТ: 50% позиции, если цена ≥90¢ и до резолва ещё далеко (>48ч) ──
let tp = 0;
for (const p of st.open || []) {
  if (p.tookProfit) continue;
  if ((p.bid || p.entry) < 0.88) continue;                 // дешёвый гейт
  const b = await jget(`https://clob.polymarket.com/book?token_id=${p.asset}`);
  const bids = b ? (b.bids || []).map(o => +o.price).filter(x => x > 0) : [];
  const bid = bids.length ? Math.max(...bids) : null;
  if (bid === null || bid < 0.90) continue;
  const g = await jget(`https://gamma-api.polymarket.com/markets?clob_token_ids=${p.asset}`);
  const m = Array.isArray(g) ? g[0] : g;
  const end = m && m.endDate ? new Date(m.endDate).getTime() : 0;
  if (!end || (end - Date.now()) < 48 * 3600e3) continue;   // близко к резолву — не частично, а по резолву
  const half = Math.floor(p.size / 2);
  if (half < 1) continue;
  const costHalf = +(p.cost * (half / p.size)).toFixed(2);
  const proceeds = +(half * bid).toFixed(2);
  const pnl = +(proceeds - costHalf).toFixed(2);
  (st.closed = st.closed || []).push({ title: p.title, side: p.side, entry: p.entry, exit: +bid.toFixed(3), size: half, cost: costHalf, pnl, proceeds, entryTs: p.ts || null, exitTs: new Date().toISOString(), followLabel: p.followLabel || "", followAddr: p.followAddr || "", asset: p.asset, reason: "тейк-профит 50% @90¢+" });
  (st.log = st.log || []).push(`ТЕЙК-ПРОФИТ 50%: «${(p.title || "").slice(0, 34)}» @${bid.toFixed(2)} +$${pnl}`);
  p.size -= half; p.cost = +(p.cost - costHalf).toFixed(2); p.value = +(p.size * bid).toFixed(2); p.tookProfit = true;
  tp++;
}

// пересчёт кэша/эквити
st.cash = +(st.startBalance - (st.open || []).reduce((a, p) => a + p.cost, 0) - (st.closed || []).reduce((a, c) => a + c.cost, 0) + (st.closed || []).reduce((a, c) => a + (c.exit * c.size), 0)).toFixed(2);
st.equity = +(st.cash + (st.open || []).reduce((a, p) => a + (p.value || p.cost), 0)).toFixed(2);
writeFileSync("paper-state.json", JSON.stringify(st, null, 2));
console.log(`exit-check: держат ${ok} (свежих в грейсе ${skippedFresh}) | закрыто ${closedSet.size}${tp ? " | тейк-профит " + tp : ""}${closedSet.size ? " → " + [...closedSet].map(p => (p.title || "").slice(0, 18)).join(", ") : ""}`);
