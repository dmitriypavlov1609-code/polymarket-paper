// Общий скрипт для всех страниц дашборда. Каждый рендер работает только если его контейнер есть на странице.
const SRC="https://raw.githubusercontent.com/dmitriypavlov1609-code/polymarket-paper/main/paper-state.json";
const DATA="https://data-api.polymarket.com", CLOB="https://clob.polymarket.com";
const TRACKED=[
  ["0x72a0d79b4325638bc2bcfc9a2b8a380c2d81c059","BTC-NO","$332K · WR77%"],
  ["0x06dc51826bc524d9a83770e7de9dd7e005b04524","ETH-whale","$762K · WR73%"],
  ["0xcc500cbcc8b7cf5bd21975ebbea34f21b5644c82","floor-whale","copyPnL $514K · 0% hedge"],
];
const $=id=>document.getElementById(id);
const money=n=>(n>=0?"$":"-$")+Math.abs(n).toFixed(2);
const cls=n=>n>0?"grn":n<0?"red":"";
// дата по московскому времени (UTC+3): "07.07 14:23"
const msk=iso=>{if(!iso)return"—";try{return new Date(iso).toLocaleString("ru-RU",{timeZone:"Europe/Moscow",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).replace(", "," ");}catch{return"—";}};
const jget=async u=>{try{return await(await fetch(u)).json()}catch{return null}};
const isC=t=>/bitcoin|btc|ethereum| eth |solana| sol |xrp/i.test(" "+(t||"")+" ");
function cat(t){t=(t||"").toLowerCase();
  if(/bitcoin|btc|ethereum|eth|solana|xrp|crypto|\$[0-9]{2},/.test(t))return"Крипта";
  if(/\bvs\.?\b| vs |spread|half.?time|corners|o\/u| total|to advance|leading at|end in a draw|win on 20\d\d|\bufc\b|\bfifa\b|world cup|\bleague\b|\bnba\b|\bnfl\b|\bnhl\b|wimbledon|\batp\b|\bwta\b|to score|assist|goal/.test(t))return"Спорт";
  if(/election|president|trump|\bvance\b|senate|democrat|republican|putin|governor|primary|nominee|mamdani/.test(t))return"Политика";
  if(/\bai\b|openai|xai|gpt|tesla|grok|model/.test(t))return"Технологии";
  if(/\bwin\b|championship|\btitle\b|\bcup\b/.test(t))return"Спорт";return"Прочее";}
let STATE=null,FILTER="Все",OPENLIVE=[];
// фильтр по времени входа ставки + сортировка
let TIMEF="Всё время",SORTDIR="new";
const TIMEWIN={"Всё время":Infinity,"24ч":24,"3 дня":72,"7 дней":168};

async function bidOf(asset){const b=await jget(CLOB+"/book?token_id="+asset);return b?Math.max(0,...(b.bids||[]).map(o=>+o.price)):0;}

function renderOpen(){
  if(!$("open"))return;
  const winH=TIMEWIN[TIMEF]||Infinity, now=Date.now();
  let list=OPENLIVE.filter(p=>FILTER==="Все"||p.cat===FILTER)
    .filter(p=>winH===Infinity||(p.ts&&(now-new Date(p.ts).getTime())<=winH*3600e3));
  list.sort((a,b)=>{const ta=new Date(a.ts||0).getTime(),tb=new Date(b.ts||0).getTime();return SORTDIR==="new"?tb-ta:ta-tb;});
  if(!list.length){$("open").innerHTML='<div class="empty">Нет ставок'+(FILTER!=="Все"?" в «"+FILTER+"»":"")+(TIMEF!=="Всё время"?" за "+TIMEF:"")+'</div>';return;}
  let h='';
  for(const p of list){
    h+='<div class="card" style="margin-bottom:10px">';
    h+='<div style="display:flex;justify-content:space-between;align-items:baseline"><div><b>'+p.title+'</b> <span class="badge">'+p.cat+'</span></div><div class="'+cls(p.pnl)+'" style="font-weight:700">'+money(p.pnl)+'</div></div>';
    h+='<div style="font-size:13px;color:var(--dim);margin:4px 0 3px">Мы: <span class="side-'+(/yes/i.test(p.side)?"yes":"no")+'">'+p.side+'</span> ×'+p.size+' · вход $'+p.entry.toFixed(3)+' → тек. $'+p.bid.toFixed(3)+'</div>';
    h+='<div style="font-size:12px;color:var(--dim);margin-bottom:6px">🗓 вход (МСК): <b>'+msk(p.ts)+'</b> · выход: <span style="color:var(--dim)">открыта</span></div>';
    const f=p.follow;
    if(f){
      h+='<div style="font-size:12px;border-top:1px solid var(--line);padding-top:6px">🐋 <b>'+f.label+'</b> <span style="color:var(--dim)">'+f.addr+'</span>';
      h+=' · капитал <b>$'+(f.book>=1000?(f.book/1000).toFixed(0)+'k':f.book)+'</b>';
      if(f.wr!=null) h+=' · WR <b>'+f.wr+'%</b>';
      if(f.entry!=null) h+=' · его вход <b>$'+f.entry.toFixed(3)+'</b>';
      if(f.posPnl!=null) h+=' · на позиции <b class="'+cls(f.posPnl)+'">'+(f.posPnl>=0?"+":"")+'$'+Math.abs(f.posPnl).toLocaleString()+'</b>';
      if(f.overallPnl!=null) h+=' · всего <b class="'+cls(f.overallPnl)+'">'+(f.overallPnl>=0?"+":"")+'$'+(Math.abs(f.overallPnl)/1000).toFixed(0)+'k</b>';
      h+='</div>';
    } else h+='<div style="font-size:12px;color:var(--dim);border-top:1px solid var(--line);padding-top:6px">🐋 кит не привязан</div>';
    h+='</div>';
  }
  $("open").innerHTML=h;
}

async function loadLive(){
  if(!STATE)return;const s=STATE;
  // позиции live + метрики (карточки есть на всех страницах)
  OPENLIVE=[];let openVal=0;
  for(const p of (s.open||[])){
    const bid=await bidOf(p.asset)||p.entry;
    const value=+(bid*p.size).toFixed(2), pnl=+(value-p.cost).toFixed(2);
    OPENLIVE.push({...p,bid,value,pnl,cat:cat(p.title)});openVal+=value;
  }
  const closedProceeds=(s.closed||[]).reduce((a,c)=>a+(c.exit*c.size),0);
  const spent=(s.open||[]).reduce((a,p)=>a+p.cost,0)+(s.closed||[]).reduce((a,c)=>a+c.cost,0);
  const cash=+(s.startBalance-spent+closedProceeds).toFixed(2);
  const equity=+(cash+openVal).toFixed(2), eqPnl=+(equity-s.startBalance).toFixed(2);
  if($("equity"))$("equity").innerHTML='<span class="'+cls(eqPnl)+'">'+money(equity)+'</span>';
  if($("cash"))$("cash").textContent=money(cash);
  if($("pnl"))$("pnl").innerHTML='<span class="'+cls(eqPnl)+'">'+money(eqPnl)+' ('+(eqPnl>=0?"+":"")+(eqPnl/s.startBalance*100).toFixed(1)+'%)</span>';
  if($("opencnt"))$("opencnt").textContent=OPENLIVE.length;
  if($("tabs")){const cats=["Все",...new Set(OPENLIVE.map(p=>p.cat))];
    $("tabs").innerHTML=cats.map(c=>'<span class="tab'+(c===FILTER?' on':'')+'" onclick="setFilter(\''+c+'\')">'+c+'</span>').join('');}
  buildTimeChips();
  renderOpen();
  if($("updated"))$("updated").textContent=new Date().toLocaleTimeString("ru-RU");

  renderMyWhales();
}

// НАШИ КИТЫ = все, за кем мы реально следим (из наших позиций). Сколько заработали, на каких ставках, когда.
function renderMyWhales(){
  if(!$("whales")||!STATE)return;const s=STATE;
  const g={};
  const add=(addr,label,bet)=>{const k=addr||label||"?";const w=(g[k]=g[k]||{addr:addr||"",label:label||"top",bets:[],realized:0,unreal:0,wins:0,losses:0,open:0,closed:0});w.bets.push(bet);if((!w.addr||w.addr==="")&&addr)w.addr=addr;if((!w.label||w.label==="top")&&label)w.label=label;};
  for(const p of s.open||[]){const live=(OPENLIVE||[]).find(x=>x.asset===p.asset);const pnl=live?live.pnl:(p.pnl||0);
    add(p.followAddr,p.followLabel,{title:p.title,side:p.side,pnl,entryTs:p.ts,exitTs:null,status:"open"});}
  for(const c of s.closed||[])add(c.followAddr,c.followLabel,{title:c.title,side:c.side,pnl:c.pnl||0,entryTs:c.entryTs,exitTs:c.exitTs,status:"closed"});
  for(const w of Object.values(g)){for(const b of w.bets){if(b.status==="open"){w.unreal+=b.pnl;w.open++;}else{w.realized+=b.pnl;w.closed++;b.pnl>0?w.wins++:(b.pnl<0&&w.losses++);}}w.total=+(w.realized+w.unreal).toFixed(2);w.bets.sort((a,b)=>new Date(b.entryTs||0)-new Date(a.entryTs||0));}
  const list=Object.values(g).sort((a,b)=>b.total-a.total);
  if(!list.length){$("whales").innerHTML='<div class="empty">Пока нет ставок за китами</div>';return;}
  let h="";
  for(const w of list){
    const wr=w.closed?Math.round(w.wins/w.closed*100):null;
    h+='<div class="card" style="border-left:3px solid '+(w.total>=0?"var(--grn)":"var(--red)")+';margin-bottom:12px">';
    h+='<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px"><div><b style="font-size:15px">'+w.label+'</b> <span class="acc" style="font-size:12px">'+(w.addr?w.addr.slice(0,6)+"…"+w.addr.slice(-4):"")+'</span></div><div class="'+cls(w.total)+'" style="font-size:21px;font-weight:700">'+money(w.total)+'</div></div>';
    h+='<div style="color:var(--dim);font-size:12px;margin:3px 0 8px">заработано с этим китом · '+w.bets.length+' ставок · W'+w.wins+'/L'+w.losses+(wr!=null?" · WR "+wr+"%":"")+' · реализ '+money(w.realized)+' · открыто '+money(w.unreal)+'</div>';
    for(const b of w.bets){
      h+='<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:6px 0;border-top:1px solid var(--line)">';
      h+='<div><span class="side-'+(/yes/i.test(b.side)?"yes":"no")+'">'+b.side+'</span> '+(b.title||"").slice(0,42)+'<div style="color:var(--dim);margin-top:2px">🗓 '+msk(b.entryTs)+' → '+(b.status==="open"?'<span class="grn">открыта</span>':msk(b.exitTs))+'</div></div>';
      h+='<div class="'+cls(b.pnl)+'" style="font-weight:700;white-space:nowrap">'+money(b.pnl)+'</div></div>';
    }
    h+='</div>';
  }
  $("whales").innerHTML=h;
}

// ── сортировка таблиц ──
const SORT={topstats:{k:"total",dir:-1},tops:{k:"copyPnl",dir:-1}};
function sortArr(arr,k,dir){return [...arr].sort((a,b)=>{let x=a[k],y=b[k];if(typeof x==="string"&&typeof y==="string")return dir*x.localeCompare(y);return dir*((+x||0)-(+y||0));});}
function hdr(table,k,label){const st=SORT[table],act=st.k===k;return '<th class="sortable'+(act?" act":"")+'" onclick="sortBy(\''+table+'\',\''+k+'\')">'+label+' <span class="ar">'+(act?(st.dir<0?"▼":"▲"):"↕")+'</span></th>';}
function sortBy(table,k){const st=SORT[table];if(st.k===k)st.dir*=-1;else{st.k=k;st.dir=-1;}table==="topstats"?renderTopStats():renderTops();}
function renderTopStats(){
  if(!$("topstats"))return;const s=STATE;let arr=(s.topStats||[]).map(t=>({...t,count:t.open+t.closed}));
  if(!arr.length){$("topstats").innerHTML='<div class="empty">Появится после первых сделок</div>';return;}
  arr=sortArr(arr,SORT.topstats.k,SORT.topstats.dir);
  let h='<table><tr><th>Топ (за кем идём)</th>'+hdr("topstats","total","Наш итог")+hdr("topstats","realized","Реализ.")+hdr("topstats","unreal","Открыто")+hdr("topstats","count","Позиций")+hdr("topstats","wins","W")+hdr("topstats","losses","L")+'</tr>';
  for(const t of arr)h+='<tr><td>'+(t.label||"top")+' <span class="acc" style="font-size:11px">'+(t.addr||"")+'</span></td>'
    +'<td class="'+cls(t.total)+'"><b>'+money(t.total)+'</b></td><td class="'+cls(t.realized)+'">'+money(t.realized)+'</td>'
    +'<td class="'+cls(t.unreal)+'">'+money(t.unreal)+' ('+t.open+')</td><td>'+t.count+'</td><td class="grn">'+t.wins+'</td><td class="red">'+t.losses+'</td></tr>';
  $("topstats").innerHTML=h+'</table>';
}
function renderTops(){
  if(!$("tops"))return;const s=STATE;let arr=(s.tops||[]);
  if(!arr.length){$("tops").innerHTML='<div class="empty">—</div>';return;}
  arr=sortArr(arr,SORT.tops.k,SORT.tops.dir);
  let h='<table><tr><th>Трейдер</th>'+hdr("tops","copyPnl","Copy PnL")+hdr("tops","realPnl","Real PnL")+hdr("tops","loss","Loss%")+hdr("tops","roi","ROI")+hdr("tops","hedged","Hedge%")+'</tr>';
  for(const t of arr)h+='<tr><td>'+t.addr+'</td><td class="grn">$'+t.copyPnl+'k</td><td>$'+t.realPnl+'k</td><td>'+t.loss+'%</td><td class="acc">'+(t.roi!=null?t.roi+"%":"—")+'</td><td>'+t.hedged+'%</td></tr>';
  $("tops").innerHTML=h+'</table>';
}
function renderStatic(){
  const s=STATE;const st=s.stats||{};
  if($("s_day")){
    $("s_day").innerHTML='<span class="'+cls(st.day)+'">'+money(st.day||0)+'</span>';
    $("s_week").innerHTML='<span class="'+cls(st.week)+'">'+money(st.week||0)+'</span>';
    $("s_month").innerHTML='<span class="'+cls(st.month)+'">'+money(st.month||0)+'</span>';
    $("s_trades").textContent=st.trades||0;$("s_wr").textContent=(st.winrate||0)+"%";
  }
  renderTopStats(); renderTops();
  if($("closed")){
    if((s.closed||[]).length){let h='<table><tr><th>Рынок</th><th>Сторона</th><th>Цена вх→вых</th><th>Дата входа (МСК)</th><th>Дата выхода (МСК)</th><th>PnL</th></tr>';
      for(const p of [...s.closed].reverse())h+='<tr><td>'+p.title+'</td><td class="side-'+(/yes/i.test(p.side)?"yes":"no")+'">'+p.side+'</td><td>$'+p.entry.toFixed(3)+'→$'+p.exit.toFixed(3)+'</td><td>'+msk(p.entryTs)+'</td><td>'+msk(p.exitTs||p.ts)+'</td><td class="'+cls(p.pnl)+'">'+money(p.pnl)+'</td></tr>';
      $("closed").innerHTML=h+'</table>';}else $("closed").innerHTML='<div class="empty">Пока нет закрытых сделок</div>';
  }
  if($("digest")){
    if((s.digest||[]).length){$("digest").innerHTML=[...s.digest].reverse().slice(0,12).map(d=>{
      const t=new Date(d.ts),hh=String(t.getHours()).padStart(2,"0")+":"+String(t.getMinutes()).padStart(2,"0"),dd=t.getDate()+"."+(t.getMonth()+1);
      return '<div style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="acc">'+dd+' '+hh+'</span> — '+d.line+'</div>';}).join("");}
    else $("digest").innerHTML='<div class="empty">Первая сводка появится в течение часа</div>';
  }
  if($("log"))$("log").innerHTML=(s.log||[]).slice(-14).reverse().map(l=>"• "+l).join("<br>");
  renderAnalytics();
}
const CHARTS={};
function mkChart(id,cfg){if(CHARTS[id])CHARTS[id].destroy();const el=document.getElementById(id);if(!el||!window.Chart)return;Chart.defaults.color="#8b98a9";Chart.defaults.font.size=11;CHARTS[id]=new Chart(el,cfg);}
function renderAnalytics(){
  if(!STATE||!$("chEquity"))return;const s=STATE;
  const ec=s.equityCurve||[];
  const labels=ec.map(p=>{const t=new Date(p.t);return String(t.getHours()).padStart(2,"0")+":"+String(t.getMinutes()).padStart(2,"0");});
  mkChart("chEquity",{type:"line",data:{labels,datasets:[{data:ec.map(p=>p.eq),borderColor:"#2f6bff",backgroundColor:"rgba(47,107,255,.08)",fill:true,tension:.3,pointRadius:0,borderWidth:2}]},
    options:{plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{maxTicksLimit:8}},y:{grid:{color:"#f0f0f0"},ticks:{callback:v=>"$"+v}}}}});
  const ts=(s.topStats||[]).filter(t=>t.open+t.closed>0).slice(0,10);
  mkChart("chWhales",{type:"bar",data:{labels:ts.map(t=>(t.label||"top").replace(/ 🔥.*/,"").slice(0,16)),datasets:[{data:ts.map(t=>t.total),backgroundColor:ts.map(t=>t.total>=0?"#15a34a":"#e5484d"),borderRadius:4}]},
    options:{indexAxis:"y",plugins:{legend:{display:false}},scales:{x:{grid:{color:"#f0f0f0"},ticks:{callback:v=>"$"+v}},y:{grid:{display:false}}}}});
  const byCat={};for(const p of (s.open||[]))byCat[p.cat||"Прочее"]=(byCat[p.cat||"Прочее"]||0)+(p.cost||0);
  const ck=Object.keys(byCat);
  mkChart("chCat",{type:"doughnut",data:{labels:ck,datasets:[{data:ck.map(k=>+byCat[k].toFixed(2)),backgroundColor:["#2f6bff","#15a34a","#f0883e","#a371f7","#e5484d","#b0b6c0"],borderColor:"#ffffff",borderWidth:2}]},
    options:{plugins:{legend:{position:"right",labels:{boxWidth:10,padding:8}}}}});
  const wa=(s.topStats||[]).filter(t=>t.open+t.closed>0);
  if($("whaleAnalytics")){
    if(wa.length)$("whaleAnalytics").innerHTML=wa.map(t=>{
      const c=t.total>=0?"grn":"red";const wr=t.closed?Math.round(t.wins/t.closed*100):null;
      return '<div class="whalestat '+(t.total>=0?"pos":"neg")+'"><div><div class="wl">'+(t.label||"top")+' <span class="acc" style="font-size:11px">'+(t.addr||"")+'</span></div>'+
        '<div class="wm">позиций '+(t.open+t.closed)+' · открыто '+t.open+' · закрыто '+t.closed+(wr!=null?' · WR '+wr+'%':'')+' · реализ '+money(t.realized)+' · откр '+money(t.unreal)+'</div></div>'+
        '<div><div class="wp '+c+'">'+money(t.total)+'</div><div class="wpm">помог заработать</div></div></div>';
    }).join("");else $("whaleAnalytics").innerHTML='<div class="empty">Аналитика появится после первых сделок</div>';
  }
}
function setFilter(c){FILTER=c;if($("tabs"))$("tabs").querySelectorAll(".tab").forEach(t=>t.classList.toggle("on",t.textContent===c));renderOpen();}
function buildTimeChips(){
  if(!$("timefilter"))return;
  const periods=Object.keys(TIMEWIN);
  let th=periods.map(t=>'<span class="tab'+(t===TIMEF?" on":"")+'" onclick="setTimeFilter(\''+t+'\')">'+(t==="Всё время"?"🕐 "+t:t)+'</span>').join("");
  th+='<span class="tab" onclick="toggleSort()" title="порядок по времени входа">'+(SORTDIR==="new"?"↓ новые сверху":"↑ старые сверху")+'</span>';
  $("timefilter").innerHTML=th;
}
function setTimeFilter(t){TIMEF=t;buildTimeChips();renderOpen();}
function toggleSort(){SORTDIR=SORTDIR==="new"?"old":"new";buildTimeChips();renderOpen();}
async function loadState(){STATE=await jget(SRC+"?t="+Date.now());if(STATE){renderStatic();loadLive();}}
loadState(); setInterval(loadLive,20000); setInterval(loadState,120000);
