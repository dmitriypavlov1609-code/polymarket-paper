// БАТАРЕЯ ТЕСТОВ корректности paper-trading. Запуск: node selftest.js
// Тянет ЖИВОЕ состояние из raw GitHub и проверяет целостность, бухгалтерию, позиции, резолвы, черн.
const SRC = "https://raw.githubusercontent.com/dmitriypavlov1609-code/polymarket-paper/main/paper-state.json";
const jget = async (u) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch {} await new Promise(s => setTimeout(s, 800)); } return null; };
let pass = 0, fail = 0, warn = 0;
const ok = (n) => { console.log("  ✅ " + n); pass++; };
const bad = (n, d) => { console.log("  ❌ " + n + (d ? " — " + d : "")); fail++; };
const wrn = (n, d) => { console.log("  ⚠️  " + n + (d ? " — " + d : "")); warn++; };
const near = (a, b, e = 0.02) => Math.abs(a - b) <= e;

(async () => {
  const s = await jget(SRC + "?t=" + Date.now());
  console.log("=== SELF-TEST paper-trading ===\n");

  // 1) целостность
  console.log("[1] Целостность состояния");
  if (!s) { bad("state загружен"); return finish(); }
  ok("state загружен из raw GitHub");
  for (const f of ["startBalance", "cash", "equity", "open", "closed"]) (f in s) ? ok("поле " + f + " есть") : bad("поле " + f + " ОТСУТСТВУЕТ");
  Array.isArray(s.open) ? ok("open — массив (" + s.open.length + ")") : bad("open не массив");
  Array.isArray(s.closed) ? ok("closed — массив (" + s.closed.length + ")") : bad("closed не массив");

  // 2) бухгалтерия
  console.log("\n[2] Бухгалтерия (пересчёт с нуля)");
  const openCost = (s.open || []).reduce((a, p) => a + (p.cost || 0), 0);
  const closedCost = (s.closed || []).reduce((a, c) => a + (c.cost || 0), 0);
  const proceeds = (s.closed || []).reduce((a, c) => a + ((c.exit || 0) * (c.size || 0)), 0);
  const cashCalc = +(s.startBalance - openCost - closedCost + proceeds).toFixed(2);
  near(cashCalc, s.cash, 0.1) ? ok("кэш сходится ($" + s.cash + " ≈ расчёт $" + cashCalc + ")") : bad("кэш НЕ сходится", "хранится $" + s.cash + " ≠ расчёт $" + cashCalc);
  const openVal = (s.open || []).reduce((a, p) => a + (p.value != null ? p.value : p.cost), 0);
  const eqCalc = +(s.cash + openVal).toFixed(2);
  near(eqCalc, s.equity, 0.5) ? ok("эквити сходится ($" + s.equity + ")") : wrn("эквити чуть разошлось", "$" + s.equity + " vs расчёт $" + eqCalc + " (live-марки)");
  (s.cash >= -0.5) ? ok("кэш не отрицательный ($" + s.cash + ")") : bad("кэш отрицательный", "$" + s.cash);
  (openCost <= s.startBalance + 0.5) ? ok("вложено не больше банка ($" + openCost.toFixed(2) + ")") : bad("перевложение", "$" + openCost.toFixed(2));

  // 3) открытые позиции
  console.log("\n[3] Открытые позиции");
  const assets = new Set(), markets = {};
  let structOk = true, costOk = true;
  const mkey = t => (t || "").replace(/\?.*$/, "").trim().toLowerCase();
  for (const p of s.open || []) {
    if (!p.asset || !p.title || !p.side || p.entry == null || !p.size) structOk = false;
    if (!near(p.cost, p.entry * p.size, 0.05)) costOk = false;
    assets.add(p.asset);
    const k = mkey(p.title); (markets[k] = markets[k] || []).push(p.side);
  }
  structOk ? ok("у всех позиций есть asset/title/side/entry/size") : bad("есть позиции с пустыми полями");
  costOk ? ok("cost ≈ entry×size у всех") : bad("cost не сходится с entry×size");
  (assets.size === (s.open || []).length) ? ok("нет дублей по asset") : bad("ДУБЛИ позиций по asset");
  const oppo = Object.entries(markets).filter(([k, sides]) => new Set(sides.map(x => /yes|no/i.test(x) ? x.toLowerCase() : x)).size > 1 && sides.length > 1);
  const selfHedge = Object.values(markets).filter(a => a.length > 1).length;
  selfHedge === 0 ? ok("нет двух позиций на один рынок (само-хедж)") : wrn("несколько позиций на один рынок", selfHedge + " рынков");
  const noTs = (s.open || []).filter(p => !p.ts).length;
  noTs === 0 ? ok("у всех позиций есть дата входа (ts)") : wrn("позиций без даты входа", noTs);

  // 4) закрытые позиции
  console.log("\n[4] Закрытые сделки");
  let pnlOk = true, dateOk = 0;
  for (const c of s.closed || []) {
    if (!near(c.pnl, (c.exit || 0) * (c.size || 0) - (c.cost || 0), 0.02)) pnlOk = false;
    if (c.exitTs) dateOk++;
  }
  pnlOk ? ok("pnl = exit×size − cost у всех закрытых") : bad("pnl не сходится у некоторых закрытых");
  ok("закрытых с датой выхода: " + dateOk + "/" + (s.closed || []).length);
  const fakeZero = (s.closed || []).filter(c => String(c.reason || "").includes("топ вышел") && Math.abs(c.pnl || 0) < 0.05 && Math.abs((c.exit || 0) - (c.entry || 0)) < 0.002).length;
  fakeZero === 0 ? ok("нет фейковых $0 churn-закрытий") : bad("остались фейковые $0 churn", fakeZero + " шт");

  // 5) резолвы — нет ли резолвнутых-но-открытых (главный недавний баг)
  console.log("\n[5] Резолвы (нет ли закрытых рынков среди открытых)");
  let stuckResolved = 0, emptyBook = 0;
  for (const p of s.open || []) {
    let g = await jget("https://gamma-api.polymarket.com/markets?clob_token_ids=" + p.asset);
    let m = Array.isArray(g) ? g[0] : g;
    if (!m || m.closed !== true) { const gc = await jget("https://gamma-api.polymarket.com/markets?clob_token_ids=" + p.asset + "&closed=true"); const mc = Array.isArray(gc) ? gc[0] : gc; if (mc && mc.closed === true) m = mc; }
    if (m && m.closed === true) { stuckResolved++; console.log("     🔴 РЕЗОЛВНУТ но открыт: " + p.title.slice(0, 34)); }
    const b = await jget("https://clob.polymarket.com/book?token_id=" + p.asset);
    const bids = b ? (b.bids || []).map(o => +o.price).filter(x => x > 0) : [];
    if (!bids.length) emptyBook++;
  }
  stuckResolved === 0 ? ok("нет резолвнутых-но-открытых позиций") : bad("ЗАСТРЯВШИЕ резолвы", stuckResolved + " шт — надо закрыть");
  emptyBook === 0 ? ok("у всех открытых живой стакан") : wrn("позиций с пустым стаканом", emptyBook + " (возможен резолв)");

  // 6) черн / кулдаун
  console.log("\n[6] Черн-защита");
  const cdCut = Date.now() - 8 * 3600e3;
  const recentClosedMkt = new Set((s.closed || []).filter(c => new Date(c.exitTs || 0).getTime() > cdCut).map(c => mkey(c.title)));
  const churnBack = (s.open || []).filter(p => recentClosedMkt.has(mkey(p.title))).length;
  churnBack === 0 ? ok("нет перезахода в недавно закрытый рынок (кулдаун держит)") : wrn("перезаход в недавно закрытый рынок", churnBack + " — проверь кулдаун");
  (s.equityCurve || []).length > 0 ? ok("кривая эквити пишется (" + s.equityCurve.length + " точ)") : wrn("кривая эквити пуста");
  (s.topStats || []).length > 0 ? ok("статистика по топам считается (" + s.topStats.length + ")") : wrn("topStats пуста");

  finish();
})();

function finish() {
  console.log("\n=== ИТОГ: " + pass + " ✅  " + warn + " ⚠️  " + fail + " ❌ ===");
  console.log(fail === 0 ? (warn === 0 ? "🟢 ВСЁ КОРРЕКТНО" : "🟡 работает, есть предупреждения") : "🔴 ЕСТЬ ОШИБКИ — чинить");
  process.exit(fail === 0 ? 0 : 1);
}
