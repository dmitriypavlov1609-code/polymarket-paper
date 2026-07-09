// РИСК-СТОП по спеку: дневной лимит 3%, недельный 8%, общая просадка 15%.
// Ставит/снимает st.halt. paper-enter при активном halt не входит. Запуск: node risk-guard.js
import { readFileSync, writeFileSync } from "node:fs";

const st = JSON.parse(readFileSync("paper-state.json", "utf8"));
const bank = st.startBalance || 300;
const now = Date.now();
const closedPnl = (h) => (st.closed || []).filter(c => new Date(c.exitTs || c.ts || 0).getTime() >= now - h * 3600e3).reduce((a, c) => a + (c.pnl || 0), 0);

const dayPnl = closedPnl(24);
const weekPnl = closedPnl(24 * 7);
st.peakEquity = Math.max(st.peakEquity || st.startBalance, st.equity || st.startBalance);
const drawdown = (st.peakEquity - (st.equity || st.startBalance)) / st.peakEquity;

let halt = null;
// приоритет: просадка (жёстче всего) → неделя → день
if (drawdown >= 0.15) {
  halt = { reason: `просадка ${(drawdown * 100).toFixed(1)}% ≥15% (нужно ручное возобновление)`, until: "2099-01-01T00:00:00Z", manual: true };
} else if (weekPnl <= -bank * 0.08) {
  // до конца недели (воскресенье 23:59 локально по UTC-приближению)
  const d = new Date(now); const daysToSun = (7 - d.getUTCDay()) % 7 || 7; const end = new Date(now + daysToSun * 24 * 3600e3); end.setUTCHours(23, 59, 0, 0);
  halt = { reason: `недельный убыток $${weekPnl.toFixed(2)} ≥8% банка`, until: end.toISOString() };
} else if (dayPnl <= -bank * 0.03) {
  halt = { reason: `дневной убыток $${dayPnl.toFixed(2)} ≥3% банка`, until: new Date(now + 24 * 3600e3).toISOString() };
}

// существующий ручной (просадочный) halt не снимаем автоматически
const prev = st.halt;
if (prev && prev.manual && drawdown >= 0.15) {
  // остаётся
} else if (halt) {
  if (!prev || new Date(prev.until || 0).getTime() < new Date(halt.until).getTime() || halt.manual) {
    if (!prev || prev.reason !== halt.reason) (st.log = st.log || []).push(`⛔ РИСК-СТОП: ${halt.reason} → торговля до ${halt.until.slice(0, 16)}`);
    st.halt = halt;
  }
} else if (prev && !prev.manual && new Date(prev.until || 0).getTime() < now) {
  // время истекло, лимиты в норме — снимаем
  (st.log = st.log || []).push(`✅ Риск-стоп снят — лимиты в норме, торговля возобновлена`);
  st.halt = null;
}

writeFileSync("paper-state.json", JSON.stringify(st, null, 2));
console.log(`risk: день $${dayPnl.toFixed(2)}/-${(bank*0.03).toFixed(0)} | неделя $${weekPnl.toFixed(2)}/-${(bank*0.08).toFixed(0)} | просадка ${(drawdown*100).toFixed(1)}%/15% | ${st.halt ? "⛔ HALT (" + st.halt.reason + ")" : "✅ торговля разрешена"}`);
