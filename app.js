/* Дашин день — офлайн-версия.
   Данные: Supabase (общие для всех устройств) + копия в localStorage (работает без сети).
   Любое изменение сначала сохраняется на устройстве, кладётся в очередь и отправляется, когда есть сеть. */
"use strict";

const CFG = window.APP_CONFIG || {};
const CALS = {
  study:{name:"Учёба",v:"--c-study"}, work:{name:"Работа",v:"--c-work"}, important:{name:"Важное",v:"--c-important"},
  beauty:{name:"Бьюти",v:"--c-beauty"}, health:{name:"Здоровье",v:"--c-health"}
};
const DEFAULT_HABITS = [
  {id:"h-train", name:"Тренировки", target:3, color:"#34C759", sort:0},
  {id:"h-insta", name:"Посты в Instagram", target:3, color:"#FF3D7F", sort:1},
  {id:"h-sketch", name:"Скетчинг", target:4, color:"#FF7A1A", sort:2},
];
const HABIT_COLORS = ["#34C759","#FF7A1A","#FF3D7F","#0A84FF","#AF52DE","#8FB300"];
const WD = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
const WD_LONG = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
const MONTHS_G = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const LS_DATA = "dd.data.v1", LS_QUEUE = "dd.queue.v1", LS_UI = "dd.ui.v1";

/* ---------- локальное хранилище ---------- */
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const emptyData = () => ({events:[], habits:[], logs:{}, done:{}, outbox:[], meta:{}, syncedAt:null});
let D = load(LS_DATA, emptyData());
let Q = load(LS_QUEUE, []);
const UI = Object.assign({tab:"today", sel:null, off:[], openItem:null, dismissed:null}, load(LS_UI, {}));
let sb = null, session = null, syncing = false, lastError = "";

/* ---------- даты ---------- */
const pad = n => String(n).padStart(2,"0");
const ds = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseD = s => { const [y,m,d] = s.slice(0,10).split("-").map(Number); return new Date(y,m-1,d); };
const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const today = () => ds(new Date());
const monday = d => { const x = new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate()-((x.getDay()+6)%7)); return x; };
const weekDates = (off=0) => { const m = addDays(monday(new Date()), off*7); return [...Array(7)].map((_,i)=>ds(addDays(m,i))); };
const hm = s => (s && s.length > 10) ? s.slice(11,16) : "";
const mins = s => { const t = hm(s); if (!t) return 0; const [h,m] = t.split(":").map(Number); return h*60+m; };
const human = s => { const d = parseD(s); return `${d.getDate()} ${MONTHS_G[d.getMonth()]}`; };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const color = cal => `var(${(CALS[cal]||CALS.work).v})`;
const baseUid = u => String(u).split("_")[0];
const uid8 = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const nowIso = () => new Date().toISOString();

/* ---------- модель ---------- */
function allItems(){
  const map = new Map();
  for (const e of D.events) map.set(e.uid, {uid:e.uid, title:e.title, start:e.start_at, end:e.end_at||e.start_at, allDay:e.all_day, cal:e.cal, location:e.location||""});
  const bases = new Set(D.events.map(e=>baseUid(e.uid)));
  const dels = new Set();
  for (const o of D.outbox){
    if (o.status !== "pending") continue;
    if (o.op === "add"){
      const uid = `app-${o.id}@dasha`; if (bases.has(uid)) continue;
      const p = o.payload;
      map.set(uid, {uid, title:p.title, start:p.start, end:p.end||p.start, allDay:!!p.allDay, cal:p.cal, location:"", pending:true});
    } else dels.add(baseUid(o.payload.uid));
  }
  return [...map.values()].filter(i=>!dels.has(baseUid(i.uid)));
}
function itemsOn(d, items){
  return items.filter(i => {
    if (i.allDay){ const s = i.start.slice(0,10), e = (i.end||i.start).slice(0,10); return d >= s && (d < e || d === s); }
    return i.start.slice(0,10) === d;
  }).sort((a,b) => a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1);
}
const isClass = i => i.cal === "study" && !i.allDay;
const isTask = i => !isClass(i) && i.cal !== "important";
const isDone = i => !!(D.done[i.uid] && D.done[i.uid].done);
const isDeadline = i => /дедлайн|зач[её]т|экзамен|сдать/i.test(i.title);
const habits = () => D.habits.filter(h=>!h.deleted).sort((a,b)=>(a.sort??0)-(b.sort??0));
const habitOn = (hid, d) => !!(D.logs[`${hid}_${d}`] && D.logs[`${hid}_${d}`].done);
const habitWeek = (h, off=0) => weekDates(off).filter(d=>habitOn(h.id,d)).length;

/* ---------- изменения: локально + в очередь ---------- */
function applyLocal(table, row){
  if (table === "habits"){ const i = D.habits.findIndex(h=>h.id===row.id); if (i>=0) D.habits[i] = {...D.habits[i], ...row}; else D.habits.push(row); }
  else if (table === "habit_logs") D.logs[row.id] = row;
  else if (table === "task_done") D.done[row.uid] = row;
  else if (table === "outbox"){ const i = D.outbox.findIndex(o=>o.id===row.id); if (i>=0) D.outbox[i] = row; else D.outbox.push(row); }
}
function write(table, row){
  applyLocal(table, row);
  Q.push({table, row}); save(LS_QUEUE, Q); save(LS_DATA, D);
  render(); sync();
}

/* ---------- синхронизация с Supabase ---------- */
async function flush(){
  while (Q.length){
    const {table, row} = Q[0];
    const {error} = await sb.from(table).upsert(row);
    if (error){
      if (/fetch|network|Failed|Load failed/i.test(error.message||"")) throw error;   // сети нет — попробуем позже
      console.warn("Изменение отклонено", table, error); lastError = error.message;    // данные неверные — выбрасываем
    }
    Q.shift(); save(LS_QUEUE, Q);
  }
}
async function pull(){
  const since = ds(addDays(new Date(), -35)), logsSince = ds(addDays(monday(new Date()), -28));
  const [ev, hb, lg, dn, ob, mt] = await Promise.all([
    sb.from("events").select("*").gte("start_at", since).order("start_at").limit(3000),
    sb.from("habits").select("*"),
    sb.from("habit_logs").select("*").gte("day", logsSince),
    sb.from("task_done").select("*"),
    sb.from("outbox").select("*").eq("status","pending"),
    sb.from("meta").select("*"),
  ]);
  for (const r of [ev,hb,lg,dn,ob,mt]) if (r.error) throw r.error;
  const N = emptyData();
  N.events = ev.data; N.habits = hb.data; N.outbox = ob.data;
  for (const r of lg.data) N.logs[r.id] = r;
  for (const r of dn.data) N.done[r.uid] = r;
  for (const r of mt.data) N.meta[r.key] = r.value;
  N.syncedAt = nowIso();
  D = N;
  for (const {table,row} of Q) applyLocal(table, row);     // неотправленное поверх
  save(LS_DATA, D);
}
async function sync(){
  if (!sb || !session || syncing || !navigator.onLine) { renderNet(); return; }
  syncing = true; renderNet();
  try{
    await flush();
    await pull();
    if (!D.habits.length && !Q.some(q=>q.table==="habits")){
      for (const h of DEFAULT_HABITS) { applyLocal("habits", h); Q.push({table:"habits", row:h}); }
      save(LS_QUEUE, Q); save(LS_DATA, D); await flush();
    }
    lastError = "";
  }catch(e){ console.warn("sync", e); lastError = e.message || String(e); }
  finally{ syncing = false; render(); }
}

/* ---------- отрисовка ---------- */
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>`;
function itemHTML(i){
  const t = i.allDay ? `<div class="t"><b>весь</b>день</div>` : `<div class="t"><b>${hm(i.start)}</b>${hm(i.end)}</div>`;
  const teacher = isClass(i) ? (i.title.match(/([А-ЯЁ][а-яё]+ [А-ЯЁ]\.[А-ЯЁ]\.?)/)||[])[1] : "";
  const title = isClass(i) ? i.title.replace(/\s*\d{2,3}\/\d\s*$/,"").replace(/\s+[А-ЯЁ][а-яё]+ [А-ЯЁ]\.[А-ЯЁ]\.?\s*$/,"") : i.title;
  const right = isTask(i) ? `<button class="check ${isDone(i)?"on":""}" data-done="${esc(i.uid)}" aria-label="${isDone(i)?"Снять отметку":"Отметить выполненным"}">${CHECK}</button>` : `<span></span>`;
  const actions = UI.openItem === i.uid && !isClass(i) ? `<div class="item-actions"><button class="btn danger" data-del="${esc(i.uid)}">Удалить из календаря</button><button class="btn" data-close="1">Отмена</button></div>` : "";
  return `<div class="item ${isTask(i)&&isDone(i)?"done":""}" style="--cc:${color(i.cal)}" data-open="${esc(i.uid)}">
    ${t}<div style="min-width:0"><div class="ttl">${esc(title)}</div><div class="meta"><span class="dot" style="background:${color(i.cal)}"></span><span>${CALS[i.cal]?.name||""}</span>${teacher?`<span>· ${esc(teacher)}</span>`:""}${i.location?`<span>· ${esc(i.location)}</span>`:""}${i.pending?`<span class="chip" style="padding:1px 8px">ждёт iCloud</span>`:""}</div></div>${right}${actions}</div>`;
}
const agenda = (id, list, empty) => { document.getElementById(id).innerHTML = list.length ? list.map(itemHTML).join("") : `<div class="empty">${empty}</div>`; };
function habitHTML(h, full){
  const wk = weekDates(), t = today(), n = habitWeek(h), pct = Math.min(100, Math.round(n/h.target*100));
  return `<div class="habit" style="--hc:${esc(h.color||HABIT_COLORS[0])}">
    <div class="hn"><span>${esc(h.name)}</span>${full?`<button data-edit-habit="${esc(h.id)}" aria-label="Изменить" style="color:var(--muted)">···</button>`:""}</div>
    <div class="hv">${n}<small>/ ${h.target} за неделю</small></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="week-dots">${wk.map((d,k)=>`<button class="wd ${habitOn(h.id,d)?"on":""} ${d===t?"today":""}" data-toggle="${esc(h.id)}|${d}" aria-label="${WD[k]}">${WD[k][0]}</button>`).join("")}</div>
    ${habitOn(h.id,t) ? `<span class="chip lime" style="align-self:flex-start">сегодня ✓</span>` : `<button class="plus" data-toggle="${esc(h.id)}|${t}">Отметить сегодня</button>`}
  </div>`;
}
function renderNet(){
  const el = document.getElementById("net"); if (!el) return;
  el.className = "net"; let txt;
  if (!navigator.onLine){ el.classList.add("off"); txt = Q.length ? `офлайн · ${Q.length} не отправлено` : "офлайн"; }
  else if (!session){ el.classList.add("off"); txt = "войти"; }
  else if (syncing || Q.length){ el.classList.add("wait"); txt = Q.length ? `отправляю ${Q.length}…` : "обновляю…"; }
  else txt = D.meta.synced_at ? `iCloud ${String(D.meta.synced_at).slice(11,16)}` : "готово";
  el.innerHTML = `<i></i>${esc(txt)}`;
  el.title = lastError ? `Ошибка: ${lastError}` : "Нажми, чтобы обновить";
}
function render(){
  const now = new Date(), t = today(), items = allItems();
  document.getElementById("today-str").textContent = `${WD_LONG[now.getDay()]}, ${now.getDate()} ${MONTHS_G[now.getMonth()]}`;
  const h = now.getHours();
  document.getElementById("hello").innerHTML = (h<5?"Доброй ночи":h<12?"Доброе утро":h<18?"Добрый день":"Добрый вечер") + ", <span>Даша</span>";
  renderNet();

  // баннер: изменения в расписании / нет данных / нужен вход
  const b = document.getElementById("banner"), ch = D.meta.schedule_changes;
  if (!D.events.length && !D.syncedAt){ b.hidden = false; b.innerHTML = navigator.onLine ? "Загружаю расписание…" : "Нет данных. Подключись к интернету один раз, чтобы загрузить расписание."; }
  else if (!session && navigator.onLine && sb){ b.hidden = false; b.innerHTML = `Войди, чтобы отметки синхронизировались. <button class="link" id="b-login" style="justify-self:start">Войти</button>`; }
  else if (ch && ch.at !== UI.dismissed && (Date.now() - new Date(ch.at)) < 3*864e5){
    b.hidden = false; b.innerHTML = `<b>Изменения в расписании</b>${(ch.lines||[]).map(l=>`<small>${esc(l)}</small>`).join("")}<button class="link" id="b-dismiss" style="justify-self:start">Понятно</button>`;
  } else b.hidden = true;

  // сводка
  const tItems = itemsOn(t, items), classes = tItems.filter(isClass), tasks = tItems.filter(isTask);
  const wk = weekDates(), wkItems = wk.flatMap(d=>itemsOn(d, items)), wkTasks = wkItems.filter(isTask), wkDone = wkTasks.filter(isDone).length;
  const dls = items.filter(i=>isDeadline(i) && i.start.slice(0,10) >= t).sort((a,b)=>a.start.localeCompare(b.start));
  const dlWeek = dls.filter(i=>i.start.slice(0,10) <= wk[6]).length;
  document.getElementById("stats").innerHTML = [
    [classes.length, classes.length ? `${hm(classes[0].start)}–${hm(classes[classes.length-1].end)}` : "нет пар", "пар сегодня"],
    [tasks.length, `${tasks.filter(isDone).length} готово`, "задач сегодня"],
    [dlWeek, dlWeek ? "на неделе" : "спокойно", "дедлайнов"],
  ].map(([n,c,l],k)=>`<div class="stat"><b>${n}</b><span class="row"><span class="chip ${k===0?"lime":""}">${c}</span></span><span class="sub">${l}</span></div>`).join("");

  const HS = habits(), habT = HS.reduce((s,h)=>s+h.target,0), habN = HS.reduce((s,h)=>s+Math.min(h.target,habitWeek(h)),0);
  const habPct = habT ? Math.round(habN/habT*100) : null, taskPct = wkTasks.length ? Math.round(wkDone/wkTasks.length*100) : null;
  const parts = [habPct, taskPct].filter(x=>x!==null), score = parts.length ? Math.round(parts.reduce((a,b)=>a+b,0)/parts.length) : null;
  document.getElementById("score").textContent = score===null ? "—" : score;
  document.getElementById("score-cap").textContent = score===null ? "пока нет данных" : score>=70 ? "% · идёшь по плану" : score>=40 ? "% · можно подтянуть" : "% · есть куда расти";
  const dl = dls[0];
  if (dl){ const days = Math.round((parseD(dl.start)-parseD(t))/864e5);
    document.getElementById("dl-days").textContent = days;
    document.getElementById("dl-cap").textContent = `${days===0?"сегодня":days%10===1&&days!==11?"день":[2,3,4].includes(days%10)&&![12,13,14].includes(days)?"дня":"дней"} · ${dl.title.replace(/^ДЕДЛАЙН:\s*/i,"")}`;
  } else { document.getElementById("dl-days").textContent = "0"; document.getElementById("dl-cap").textContent = "дедлайнов не видно"; }

  agenda("ag-today", tItems, "На сегодня ничего нет.");
  const tm = addDays(new Date(),1);
  document.getElementById("tmr-title").textContent = `Завтра, ${WD_LONG[tm.getDay()]}`;
  agenda("ag-tmr", itemsOn(ds(tm), items), "Завтра свободно.");
  document.getElementById("habits-mini").innerHTML = HS.length ? HS.map(h=>habitHTML(h,false)).join("") : `<div class="empty">Привычки появятся после первой синхронизации.</div>`;

  renderCal(items); renderTrack(items, habPct, taskPct, wkTasks.length, wkDone);
}
function renderCal(items){
  if (!UI.sel) UI.sel = today();
  const start = monday(new Date()), t = today(), off = new Set(UI.off);
  document.getElementById("strip").innerHTML = [...Array(42)].map((_,k)=>{
    const d = ds(addDays(start,k)), dd = parseD(d), cals = [...new Set(itemsOn(d, items).filter(i=>!off.has(i.cal)).map(i=>i.cal))].slice(0,4);
    return `<button class="day ${d===UI.sel?"sel":""} ${d===t?"today":""}" data-day="${d}"><small>${WD[(dd.getDay()+6)%7]}</small><b>${dd.getDate()}</b><span class="dots">${cals.map(c=>`<i style="background:${color(c)}"></i>`).join("")}</span></button>`;
  }).join("");
  const sd = parseD(UI.sel);
  document.getElementById("month-title").textContent = `${MONTHS[sd.getMonth()]} ${sd.getFullYear()}`;
  const wl = WD_LONG[sd.getDay()];
  document.getElementById("sel-title").textContent = UI.sel===t ? "Сегодня" : `${wl[0].toUpperCase()+wl.slice(1)}, ${human(UI.sel)}`;
  document.getElementById("filters").innerHTML = Object.entries(CALS).map(([k,c])=>`<button class="${off.has(k)?"off":""}" data-filter="${k}"><span class="dot" style="background:var(${c.v})"></span>${c.name}</button>`).join("");
  agenda("ag-sel", itemsOn(UI.sel, items).filter(i=>!off.has(i.cal)), "В этот день ничего нет.");
  const fc = document.getElementById("f-cal");
  if (!fc.options.length) fc.innerHTML = Object.entries(CALS).filter(([k])=>k!=="study").map(([k,c])=>`<option value="${k}">${c.name}</option>`).join("");
}
function renderTrack(items, habPct, taskPct, nTasks, nDone){
  const HS = habits();
  document.getElementById("hab-pct").textContent = habPct===null ? "—" : habPct + "%";
  document.getElementById("task-pct").textContent = taskPct===null ? "—" : taskPct + "%";
  document.getElementById("task-cap").textContent = nTasks ? `${nDone} из ${nTasks} на этой неделе` : "задач на неделе нет";
  document.getElementById("habits-full").innerHTML = HS.length ? HS.map(h=>habitHTML(h,true)).join("") : `<div class="empty">Привычек пока нет. Нажми «+ Привычка».</div>`;

  const wk = weekDates(), order = ["study","work","beauty","health"];
  const data = wk.map(d => { const its = itemsOn(d, items).filter(i=>!i.allDay); const o = {}; for (const c of order) o[c] = its.filter(i=>i.cal===c).reduce((s,i)=>s+Math.max(0,mins(i.end)-mins(i.start))/60,0); return o; });
  const tot = data.map(o=>order.reduce((s,c)=>s+o[c],0)), max = Math.max(4, Math.ceil(Math.max(...tot)/2)*2);
  const X0=28, W=300, H=120, Y0=14, bw=W/7*0.56; let svg = "";
  for (let g=0; g<=max; g+=max/2){ const y = Y0+H-(g/max)*H; svg += `<line x1="${X0}" x2="${X0+W}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${X0-6}" y="${y+4}" text-anchor="end">${g}</text>`; }
  data.forEach((o,k)=>{ let y = Y0+H; const x = X0 + k*(W/7) + (W/7-bw)/2;
    for (const c of order){ const h = o[c]/max*H; if (h>0){ y -= h; svg += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(h-1.5,1)}" rx="5" fill="${color(c)}"/>`; } }
    if (tot[k]>0) svg += `<text x="${x+bw/2}" y="${y-5}" text-anchor="middle" style="fill:var(--fg)">${Math.round(tot[k]*10)/10}</text>`;
    svg += `<text x="${x+bw/2}" y="${Y0+H+18}" text-anchor="middle" ${wk[k]===today()?'style="fill:var(--fg);font-weight:600"':""}>${WD[k]}</text>`; });
  document.getElementById("load-chart").innerHTML = svg;
  document.getElementById("load-legend").innerHTML = order.map(c=>`<span class="chip"><span class="dot" style="background:${color(c)}"></span>${CALS[c].name}</span>`).join("");

  const weeks = [-3,-2,-1,0].map(off=>{ const T = HS.reduce((s,h)=>s+h.target,0), N = HS.reduce((s,h)=>s+Math.min(h.target,habitWeek(h,off)),0); return T ? Math.round(N/T*100) : 0; });
  let s2 = ""; const hX0=28, hW=300, hH=90, hY0=12, hb=hW/4*0.5;
  [0,50,100].forEach(g=>{ const y=hY0+hH-g/100*hH; s2 += `<line x1="${hX0}" x2="${hX0+hW}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${hX0-6}" y="${y+4}" text-anchor="end">${g}</text>`; });
  weeks.forEach((v,k)=>{ const x = hX0 + k*(hW/4) + (hW/4-hb)/2, h = v/100*hH, y = hY0+hH-h, m = addDays(monday(new Date()), (k-3)*7);
    s2 += `<rect x="${x}" y="${y}" width="${hb}" height="${Math.max(h,2)}" rx="8" fill="${k===3?"var(--c-study)":"var(--muted)"}" opacity="${k===3?1:.35}"/><text x="${x+hb/2}" y="${y-6}" text-anchor="middle" style="fill:var(--fg)">${v}%</text><text x="${x+hb/2}" y="${hY0+hH+18}" text-anchor="middle">${k===3?"эта":`${m.getDate()}.${pad(m.getMonth()+1)}`}</text>`; });
  document.getElementById("hist-chart").innerHTML = s2;

  const classH = data.reduce((s,o)=>s+o.study,0);
  let streak = 0; for (let off=-1; off>=-4; off--){ if (HS.length && HS.every(h=>habitWeek(h,off)>=h.target)) streak++; else break; }
  const wkDl = items.filter(i=>isDeadline(i) && wk.includes(i.start.slice(0,10))).length;
  document.getElementById("kv").innerHTML = `<div><b>${Math.round(classH)}</b><span>часов пар на неделе</span></div><div><b>${wkDl}</b><span>дедлайнов на неделе</span></div><div><b>${streak}</b><span>недель подряд план выполнен</span></div>`;
}

/* ---------- действия ---------- */
function setTab(tab){
  UI.tab = tab; save(LS_UI, UI);
  document.querySelectorAll("#tabs button").forEach(x=>x.classList.toggle("on", x.dataset.tab===tab));
  document.querySelectorAll("section.view").forEach(s=>s.classList.toggle("is-active", s.id==="v-"+tab));
  window.scrollTo(0,0);
}
document.addEventListener("click", e => {
  const b = e.target.closest("button, .item"); if (!b) return;
  const d = b.dataset;
  if (b.id === "net"){ if (!session && sb) showGate(); else sync(); return; }
  if (b.id === "b-login"){ showGate(); return; }
  if (b.id === "b-dismiss"){ UI.dismissed = D.meta.schedule_changes?.at; save(LS_UI, UI); render(); return; }
  if (d.tab){ setTab(d.tab); return; }
  if (d.go){ setTab(d.go); return; }
  if (d.day){ UI.sel = d.day; UI.openItem = null; render(); return; }
  if (d.filter){ const s = new Set(UI.off); s.has(d.filter) ? s.delete(d.filter) : s.add(d.filter); UI.off = [...s]; save(LS_UI, UI); render(); return; }
  if (d.done){ e.stopPropagation(); const cur = D.done[d.done]?.done; write("task_done", {uid:d.done, done:!cur, updated_at:nowIso()}); return; }
  if (d.toggle){ const [hid, day] = d.toggle.split("|"); write("habit_logs", {id:`${hid}_${day}`, habit_id:hid, day, done:!habitOn(hid,day), updated_at:nowIso()}); return; }
  if (d.del){ e.stopPropagation(); const it = allItems().find(i=>i.uid===d.del); UI.openItem = null;
    write("outbox", {id:uid8(), op:"delete", payload:{uid:d.del, title:it?.title||""}, status:"pending", created_at:nowIso()}); return; }
  if (d.close){ e.stopPropagation(); UI.openItem = null; render(); return; }
  if (d.editHabit){ openHabitForm(D.habits.find(h=>h.id===d.editHabit)); return; }
  if (d.open && b.classList.contains("item")){ const it = allItems().find(i=>i.uid===d.open); if (it && !isClass(it)){ UI.openItem = UI.openItem===d.open ? null : d.open; render(); } }
});

// добавить задачу
const af = document.getElementById("add-form");
document.getElementById("btn-add").onclick = () => { af.hidden = !af.hidden; document.getElementById("f-date").value = UI.sel || today(); if (!af.hidden) document.getElementById("f-title").focus(); };
document.getElementById("f-cancel").onclick = () => { af.hidden = true; };
af.addEventListener("submit", e => {
  e.preventDefault();
  const title = document.getElementById("f-title").value.trim(), date = document.getElementById("f-date").value, cal = document.getElementById("f-cal").value;
  const st = document.getElementById("f-start").value, en = document.getElementById("f-end").value;
  if (!title || !date) return;
  const allDay = !st; let end = "";
  if (!allDay){ if (en) end = `${date}T${en}`; else { const [h,m] = st.split(":").map(Number); const x = new Date(2000,0,1,h,m+60); end = `${date}T${pad(x.getHours())}:${pad(x.getMinutes())}`; } }
  write("outbox", {id:uid8(), op:"add", status:"pending", created_at:nowIso(),
    payload:{cal, title, start: allDay ? date : `${date}T${st}`, end, allDay, alarms: allDay ? [360,-540] : [15]}});
  af.hidden = true; af.reset(); UI.sel = date; render();
});

// привычки
const hf = document.getElementById("habit-form"); let editHabit = null, delArm = false;
function openHabitForm(h){ editHabit = h || null; hf.hidden = false; document.getElementById("h-name").value = h?.name || ""; document.getElementById("h-target").value = h?.target || 3; document.getElementById("h-del").hidden = !h; document.getElementById("h-name").focus(); }
document.getElementById("btn-habit").onclick = () => openHabitForm(null);
document.getElementById("h-cancel").onclick = () => { hf.hidden = true; };
hf.addEventListener("submit", e => {
  e.preventDefault();
  const name = document.getElementById("h-name").value.trim(), target = Math.max(1, Math.min(7, +document.getElementById("h-target").value || 3));
  if (!name) return;
  if (editHabit) write("habits", {...editHabit, name, target, updated_at:nowIso()});
  else write("habits", {id:"h"+uid8(), name, target, color:HABIT_COLORS[habits().length % HABIT_COLORS.length], sort:habits().length, deleted:false, updated_at:nowIso()});
  hf.hidden = true;
});
document.getElementById("h-del").onclick = ev => {
  if (!delArm){ delArm = true; ev.target.textContent = "Точно удалить?"; setTimeout(()=>{ delArm = false; ev.target.textContent = "Удалить"; }, 3000); return; }
  delArm = false; ev.target.textContent = "Удалить";
  if (editHabit) write("habits", {...editHabit, deleted:true, updated_at:nowIso()});
  hf.hidden = true;
};

/* ---------- вход ---------- */
function showGate(msg){
  document.getElementById("gate").hidden = false; document.getElementById("app").hidden = true; document.getElementById("tabbar").hidden = true;
  if (msg){ document.getElementById("gate-title").textContent = msg.title; document.getElementById("gate-text").textContent = msg.text; document.getElementById("login-form").hidden = !!msg.noForm; }
}
function showApp(){
  document.getElementById("gate").hidden = true; document.getElementById("app").hidden = false; document.getElementById("tabbar").hidden = false;
  setTab(UI.tab || "today"); render();
}
document.getElementById("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("l-btn"), err = document.getElementById("l-err");
  if (!navigator.onLine){ err.textContent = "Для входа нужен интернет."; return; }
  btn.disabled = true; err.textContent = "";
  const {data, error} = await sb.auth.signInWithPassword({email:document.getElementById("l-email").value.trim(), password:document.getElementById("l-pass").value});
  btn.disabled = false;
  if (error){ err.textContent = /Invalid login/i.test(error.message) ? "Неверная почта или пароль." : error.message; return; }
  session = data.session; showApp(); sync();
});
document.getElementById("btn-logout").onclick = async () => {
  if (Q.length && !confirmLogout()) return;
  await sb?.auth.signOut(); session = null; D = emptyData(); Q = []; save(LS_DATA, D); save(LS_QUEUE, Q); showGate();
};
let logoutArm = false;
function confirmLogout(){ if (logoutArm) return true; logoutArm = true; const b = document.getElementById("btn-logout"); b.textContent = `Есть ${Q.length} неотправленных. Нажми ещё раз, чтобы выйти`; setTimeout(()=>{ logoutArm = false; b.textContent = "Выйти из аккаунта"; }, 4000); return false; }

/* ---------- запуск ---------- */
(async function boot(){
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
  const configured = CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase;
  if (!configured){ showGate({title:"Почти готово", text:"Заполни адрес и ключ Supabase в файле config.js — инструкция в README.", noForm:true}); return; }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {auth:{persistSession:true, autoRefreshToken:true, storageKey:"dd.auth"}});
  try { session = (await sb.auth.getSession()).data.session; } catch { session = null; }
  sb.auth.onAuthStateChange((_ev, s) => { session = s; renderNet(); });
  const hasCache = D.events.length || D.habits.length;
  if (session || hasCache) { showApp(); sync(); } else showGate();
})();
window.addEventListener("online", () => { render(); sync(); });
window.addEventListener("offline", render);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible"){ render(); sync(); } });
setInterval(() => { if (document.visibilityState === "visible") sync(); }, 60000);
setInterval(render, 60000);
