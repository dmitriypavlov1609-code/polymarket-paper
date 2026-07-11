// ОРКЕСТРАТОР 24/7 follow-tops. Один проход = выходы → резолвы/марка → авто-вход → git push.
// Крутится под PM2 на сервере через setInterval. Запуск: node cycle.js  (loop)  |  node cycle.js once
import { execSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";

const ONCE = process.argv[2] === "once";
const INTERVAL_MIN = Number(process.env.CYCLE_MIN || 6);

const run = (cmd) => { try { return execSync(cmd, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], timeout: 180000 }).toString().trim(); } catch (e) { return "ERR:" + (e.stdout ? e.stdout.toString().trim() : e.message).slice(0, 200); } };

async function cycle() {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`\n[${ts}] === CYCLE ===`);
  // подтянуть код-правки из origin (merge; наш state и удалённый код не конфликтуют) — self-heal от гонок пуша
  run("git stash -q; git pull -q --no-rebase origin main; git stash pop -q");
  console.log("1) " + run("node exit-check.js"));
  console.log("2) " + run("node paper-update.js").split("\n").pop());
  console.log("R) " + run("node risk-guard.js"));
  console.log("3) " + run("node paper-enter.js").split("\n")[0]);
  console.log("2b) " + run("node paper-update.js").split("\n").pop());
  console.log("5) " + run("node digest.js"));
  // git push — ТОЛЬКО данные (paper-state.json), НИКОГДА не код (иначе движок затрёт UI-правки на origin)
  // Пуш ПРОРЕЖЕН (throttle): каждый пуш = Vercel-деплой whale-paper-trading, а лимит 100 деплоев/сутки.
  // Коммитим каждый цикл (данные не теряем), но пушим не чаще раза в PUSH_MIN минут. Торговлю это не тормозит.
  const status = run("git status --porcelain -- paper-state.json");
  if (status && !status.startsWith("ERR")) {
    run("git add paper-state.json && git commit -q -m 'paper 24/7 cycle'");
    const PUSH_MIN = Number(process.env.PUSH_MIN || 30);
    let due = true;
    try { due = (Date.now() - statSync(".last-push").mtimeMs) >= PUSH_MIN * 60000; } catch { due = true; }
    if (due) {
      const push = run("git push -q origin main 2>&1");
      if (!push.startsWith("ERR")) { try { writeFileSync(".last-push", ""); } catch {} }
      console.log(`4) pushed (throttle ${PUSH_MIN}м)` + (push.startsWith("ERR") ? " " + push : ""));
    } else {
      console.log(`4) commit локально, push отложен (throttle ${PUSH_MIN}м)`);
    }
  } else {
    console.log("4) без изменений");
  }
}

if (ONCE) {
  await cycle();
} else {
  console.log(`🟢 paper-engine 24/7 запущен, цикл каждые ${INTERVAL_MIN} мин`);
  await cycle();
  setInterval(cycle, INTERVAL_MIN * 60 * 1000);
}
