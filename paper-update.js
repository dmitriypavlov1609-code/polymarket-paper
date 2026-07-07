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
  if (/\bvs\.?\b| vs |spread|half.?time|corners|o\/u| total|to advance|leading at|end in a draw|win on 20\d\d|\bufc\b|\bfifa\b|world cup|\bleague\b|\bnba\b|\bnfl\b|\bnhl\b|wimbledon|\batp\b|\bwta\b|to score|assist|goal/.test(t)) return "Спорт";
  if (/election|president|trump|\bvance\b|congress|senate|governor|primary|democrat|republican|putin|zelensky|mamdani|nyc mayor|nominee/.test(t)) return "Политика";
  if (/\bai\b|openai|xai|gpt|tesla|model|grok|llm|agi/.test(t)) return "Технологии";
  if (/\bwin\b|championship|\btitle\b|\bcup\b/.test(t)) return "Спорт";
  return "Прочее";
}

// 1) марки открытых позиций + АВТО-ЗАКРЫТИЕ резолвнувшихся (bid≈0 проигрыш / ≈1 выигрыш)
const nowIso = new Date().toISOString();
const stillOpen = [];
st.closed = st.closed || [];
for (const p of st.open || []) {
  const bk = await jget(`https://clob.polymarket.com/book?token_id=${p.asset}`);
  const bids = bk ? (bk.bids || []).map(o => +o.price).filter(x => x > 0) : [];
  const bid = bids.length ? Math.max(...bids) : null;
  // РЕЗОЛВ по авторитетному gamma-флагу closed. ВАЖНО: gamma по умолчанию отдаёт ТОЛЬКО активные рынки —
  // резолвнувшиеся возвращают []! Поэтому если активный запрос пуст/не закрыт, дозапрашиваем closed=true.
  let g = await jget(`https://gamma-api.polymarket.com/markets?clob_token_ids=${p.asset}`);
  let m = Array.isArray(g) ? g[0] : g;
  if (!m || m.closed !== true) {
    const gc = await jget(`https://gamma-api.polymarket.com/markets?clob_token_ids=${p.asset}&closed=true`);
    const mc = Array.isArray(gc) ? gc[0] : gc;
    if (mc && mc.closed === true) m = mc;
  }
  if (m && m.closed === true) {
    let exit = 0;
    try {
      const outs = JSON.parse(m.outcomes || "[]"), pr = JSON.parse(m.outcomePrices || "[]");
      const i = outs.findIndex(o => (o || "").toLowerCase() === (p.side || "").toLowerCase());
      exit = (i >= 0 && +pr[i] >= 0.5) ? 1 : (i >= 0 ? 0 : (bid != null && bid >= 0.5 ? 1 : 0));
    } catch { exit = (bid != null && bid >= 0.5) ? 1 : 0; }
    const pnl = +((exit * p.size) - p.cost).toFixed(2);
    // ЧЕСТНОЕ время резолва рынка из gamma (closedTime/endDate), а не момент, когда мы заметили
    let resolveTs = nowIso;
    try { const ct = m.closedTime || m.endDate; if (ct) { const str = String(ct).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"); const d = new Date(str); if (!isNaN(d)) resolveTs = d.toISOString(); } } catch {}
    st.closed.push({ title: p.title, side: p.side, entry: p.entry, exit, size: p.size, cost: p.cost, pnl, entryTs: p.ts || null, exitTs: resolveTs, followLabel: p.followLabel || "", followAddr: p.followAddr || "", asset: p.asset });
    (st.log = st.log || []).push("РЕЗОЛВ: «" + p.title + "» " + (exit ? "🟢ВЫИГРЫШ" : "🔴ПРОИГРЫШ") + " " + (pnl >= 0 ? "+" : "") + "$" + pnl);
    continue;
  }
  // не резолвнут — марка (глюк bid=null → держим прошлую цену, не обнуляем)
  p.bid = bid != null ? bid : (p.bid || p.entry);
  p.value = +(p.bid * p.size).toFixed(2);
  p.pnl = +(p.value - p.cost).toFixed(2);
  p.cat = category(p.title);
  stillOpen.push(p);
}
st.open = stillOpen;
// кэш считаем от сделок (единый источник истины, как в браузере)
const spent = (st.open || []).reduce((a, p) => a + p.cost, 0) + (st.closed || []).reduce((a, c) => a + c.cost, 0);
const proceeds = (st.closed || []).reduce((a, c) => a + (c.exit * c.size), 0);
st.cash = +(st.startBalance - spent + proceeds).toFixed(2);
st.equity = +(st.cash + (st.open || []).reduce((a, x) => a + x.value, 0)).toFixed(2);
st.totalPnl = +(st.equity - st.startBalance).toFixed(2);

// обогащение: за каким КИТОМ идём (его вход, капитал, WR, общий PnL, его +/- на позиции)
const lb0 = await jget("https://polycop.fun/api/leaderboard");
const lbMap = {}; if (lb0 && lb0.data) for (const t of lb0.data) lbMap[t.address.toLowerCase()] = t;
const WR_FB = {
  "0x06dc51826bc524d9a83770e7de9dd7e005b04524": { wr: 73, label: "ETH-whale" },
  "0x72a0d79b4325638bc2bcfc9a2b8a380c2d81c059": { wr: 77, label: "BTC-NO" },
  "0xcc500cbcc8b7cf5bd21975ebbea34f21b5644c82": { wr: null, label: "floor-whale" },
};
for (const p of st.open || []) {
  if (!p.followAddr) { p.follow = null; continue; }
  const wp = await jget(`https://data-api.polymarket.com/positions?user=${p.followAddr}&sizeThreshold=1`);
  let book = 0, entry = null, posPnl = null;
  for (const x of (Array.isArray(wp) ? wp : [])) {
    book += Number(x.currentValue || 0);
    if (x.asset === p.asset) { entry = Number(x.avgPrice || 0); posPnl = Number(x.currentValue || 0) - Number(x.initialValue || 0); }
  }
  const lbt = lbMap[p.followAddr.toLowerCase()];
  const wr = lbt ? Math.round(lbt.win_rate > 1 ? lbt.win_rate : lbt.win_rate * 100) : (WR_FB[p.followAddr.toLowerCase()] ? WR_FB[p.followAddr.toLowerCase()].wr : null);
  p.follow = {
    label: p.followLabel || (WR_FB[p.followAddr.toLowerCase()] && WR_FB[p.followAddr.toLowerCase()].label) || "top",
    addr: p.followAddr.slice(0, 6) + "…" + p.followAddr.slice(-4),
    entry: entry != null ? +entry.toFixed(3) : null,
    book: Math.round(book),
    wr,
    overallPnl: lbt ? Math.round(lbt.actual_pnl || 0) : null,
    posPnl: posPnl != null ? Math.round(posPnl) : null,
  };
}

// 1b) СТАТИСТИКА ПО ТОПАМ: сколько заработали/проиграли следуя за каждым (реализ + открытое)
const tstat = {};
const tkey = (addr, label) => (addr || label || "?");
for (const p of (st.open || [])) {
  const k = tkey(p.followAddr, p.followLabel); if (!k || k === "?") continue;
  const s = tstat[k] || (tstat[k] = { addr: p.followAddr || "", label: p.followLabel || "top", realized: 0, unreal: 0, open: 0, wins: 0, losses: 0 });
  s.unreal += (p.pnl || 0); s.open += 1; if (!s.label && p.followLabel) s.label = p.followLabel;
}
for (const c of (st.closed || [])) {
  const k = tkey(c.followAddr, c.followLabel); if (!k || k === "?") continue;
  const s = tstat[k] || (tstat[k] = { addr: c.followAddr || "", label: c.followLabel || "top", realized: 0, unreal: 0, open: 0, wins: 0, losses: 0 });
  s.realized += (c.pnl || 0); if ((c.pnl || 0) > 0) s.wins += 1; else if ((c.pnl || 0) < 0) s.losses += 1;
  if (!s.addr && c.followAddr) s.addr = c.followAddr;
}
st.topStats = Object.values(tstat).map(s => ({
  label: s.label, addr: s.addr ? s.addr.slice(0, 6) + "…" + s.addr.slice(-4) : "",
  total: +(s.realized + s.unreal).toFixed(2), realized: +s.realized.toFixed(2), unreal: +s.unreal.toFixed(2),
  open: s.open, closed: s.wins + s.losses, wins: s.wins, losses: s.losses,
})).sort((a, b) => b.total - a.total);

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
const lb = lb0 || await jget("https://polycop.fun/api/leaderboard");
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

// кривая эквити для графика (снимок не чаще, чем раз в ~5 мин; храним ~400 точек ≈ пара суток)
st.equityCurve = st.equityCurve || [];
const lastPt = st.equityCurve[st.equityCurve.length - 1];
if (!lastPt || Date.now() - new Date(lastPt.t).getTime() > 5 * 60 * 1000) {
  st.equityCurve.push({ t: new Date().toISOString(), eq: st.equity, pnl: +(st.equity - st.startBalance).toFixed(2), open: (st.open || []).length });
  if (st.equityCurve.length > 400) st.equityCurve = st.equityCurve.slice(-400);
}

st.updated = new Date().toISOString();
writeFileSync("paper-state.json", JSON.stringify(st, null, 2));
console.log(`updated: equity $${st.equity} | open ${st.open.length} | whales ${whales.length} | tops ${tops.length} | day $${st.stats.day}`);
