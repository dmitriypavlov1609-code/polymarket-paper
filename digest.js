// ЧАСОВАЯ СВОДКА: раз в ~час добавляет краткий итог в st.digest (показывается на дашборде).
// Вызывается каждым циклом; пишет только если с прошлой сводки прошло ≥55 мин. Запуск: node digest.js
import { readFileSync, writeFileSync } from "node:fs";

const st = JSON.parse(readFileSync("paper-state.json", "utf8"));
st.digest = st.digest || [];
const now = Date.now();
const last = st.digest.length ? new Date(st.digest[st.digest.length - 1].ts).getTime() : 0;
if (now - last < 55 * 60 * 1000) { console.log("digest: рано (<55мин)"); process.exit(0); }

const pnl = +((st.equity || 0) - (st.startBalance || 0)).toFixed(2);
const ts = new Date(now);
// лидеры/аутсайдеры по топам
const tstats = (st.topStats || []).filter(t => Math.abs(t.total) >= 0.01);
const best = tstats.slice(0, 2).map(t => `${t.label} ${t.total >= 0 ? "+" : ""}$${t.total}`);
const worst = tstats.slice(-2).reverse().filter(t => t.total < 0).map(t => `${t.label} $${t.total}`);
// что закрылось за последний час
const hAgo = now - 60 * 60 * 1000;
const recentClosed = (st.closed || []).filter(c => new Date(c.exitTs || c.ts).getTime() >= hAgo);
const wins = recentClosed.filter(c => (c.pnl || 0) > 0).length, losses = recentClosed.filter(c => (c.pnl || 0) < 0).length;

const line = `эквити $${(st.equity || 0).toFixed(2)} (PnL ${pnl >= 0 ? "+" : ""}$${pnl}) · открыто ${(st.open || []).length} · кэш $${(st.cash || 0).toFixed(2)}`
  + ` · за час закрыто ${recentClosed.length} (W${wins}/L${losses})`
  + (best.length ? ` · лидеры: ${best.join(", ")}` : "")
  + (worst.length ? ` · минус: ${worst.join(", ")}` : "");

st.digest.push({ ts: ts.toISOString(), equity: st.equity, pnl, open: (st.open || []).length, cash: st.cash, line });
if (st.digest.length > 48) st.digest = st.digest.slice(-48);
writeFileSync("paper-state.json", JSON.stringify(st, null, 2));
console.log("digest+ " + line);
