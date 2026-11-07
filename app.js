/* Дашин день — офлайн-версия, v2.
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
const MONTHS_S = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const CARRY_CALS = ["work"];          // какие задачи переносятся в 23:00 (как в sync/carry.py)
const STALE_AFTER = 3;                // с какого переноса подсвечивать
const LS_DATA = "dd.data.v2", LS_QUEUE = "dd.queue.v1", LS_UI = "dd.ui.v2";

/* ---------- локальное хранилище ---------- */
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const emptyData = () => ({events:[], habits:[], logs:{}, done:{}, outbox:[], meta:{}, entries:{}, carry:{}, someday:{}, syncedAt:null});
let D = Object.assign(emptyData(), load(LS_DATA, {}));
let Q = load(LS_QUEUE, []);
const UI = Object.assign({tab:"today", sel:null, off:[], openItem:null, dismissed:null, calMode:"week", month:null, sheet:null, laterOpen:null}, load(LS_UI, {}));
UI.sheet = null; UI.laterOpen = null;
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
const short = s => { const d = parseD(s); return `${d.getDate()} ${MONTHS_S[d.getMonth()]}`; };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const color = cal => `var(${(CALS[cal]||CALS.work).v})`;
const baseUid = u => String(u).split("_")[0];
const uid8 = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const nowIso = () => new Date().toISOString();
const times = n => n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "раза" : "раз";

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
const carryCount = i => (D.carry[i.uid] && D.carry[i.uid].count) || 0;
const habits = () => D.habits.filter(h=>!h.deleted).sort((a,b)=>(a.sort??0)-(b.sort??0));
const habitOn = (hid, d) => !!(D.logs[`${hid}_${d}`] && D.logs[`${hid}_${d}`].done);
const habitWeek = (h, off=0) => weekDates(off).filter(d=>habitOn(h.id,d)).length;
const entriesOf = hid => Object.values(D.entries).filter(e=>e.habit_id===hid && !e.deleted);
const laterItems = () => Object.values(D.someday).filter(s=>!s.deleted);

/* ---------- изменения: локально + в очередь ---------- */
function applyLocal(table, row){
  if (table === "habits"){ const i = D.habits.findIndex(h=>h.id===row.id); if (i>=0) D.habits[i] = {...D.habits[i], ...row}; else D.habits.push(row); }
  else if (table === "habit_logs") D.logs[row.id] = row;
  else if (table === "task_done") D.done[row.uid] = row;
  else if (table === "habit_entries") D.entries[row.id] = {...(D.entries[row.id]||{}), ...row};
  else if (table === "someday") D.someday[row.id] = {...(D.someday[row.id]||{}), ...row};
  else if (table === "outbox"){ const i = D.outbox.findIndex(o=>o.id===row.id); if (i>=0) D.outbox[i] = row; else D.outbox.push(row); }
}
function write(table, row, opts={}){
  applyLocal(table, row);
  Q.push({table, row}); save(LS_QUEUE, Q); save(LS_DATA, D);
  if (!opts.quiet){ render(); sync(); }
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
  const since = ds(addDays(monday(new Date()), -35)), logsSince = ds(addDays(monday(new Date()), -28));
  const res = await Promise.all([
    sb.from("events").select("*").gte("start_at", since).order("start_at").limit(4000),
    sb.from("habits").select("*"),
    sb.from("habit_logs").select("*").gte("day", logsSince),
    sb.from("task_done").select("*"),
    sb.from("outbox").select("*").eq("status","pending"),
    sb.from("meta").select("*"),
    sb.from("habit_entries").select("*").eq("deleted", false),
    sb.from("task_carry").select("*"),
    sb.from("someday").select("*").eq("deleted", false),
  ]);
  for (const r of res) if (r.error) throw r.error;
  const [ev,hb,lg,dn,ob,mt,en,cr,sd] = res.map(r=>r.data);
  const N = emptyData();
  N.events = ev; N.habits = hb; N.outbox = ob;
  for (const r of lg) N.logs[r.id] = r;
  for (const r of dn) N.done[r.uid] = r;
  for (const r of mt) N.meta[r.key] = r.value;
  for (const r of en) N.entries[r.id] = r;
  for (const r of cr) N.carry[r.uid] = r;
  for (const r of sd) N.someday[r.id] = r;
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

/* ---------- отрисовка: общие куски ---------- */
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>`;
const XICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
function itemHTML(i){
  const t = i.allDay ? `<div class="t"><b>весь</b>день</div>` : `<div class="t"><b>${hm(i.start)}</b>${hm(i.end)}</div>`;
  const teacher = isClass(i) ? (i.title.match(/([А-ЯЁ][а-яё]+ [А-ЯЁ]\.[А-ЯЁ]\.?)/)||[])[1] : "";
  const title = isClass(i) ? i.title.replace(/\s*\d{2,3}\/\d\s*$/,"").replace(/\s+[А-ЯЁ][а-яё]+ [А-ЯЁ]\.[А-ЯЁ]\.?\s*$/,"") : i.title;
  const cc = carryCount(i), stale = cc >= STALE_AFTER && !isDone(i);
  const right = isTask(i) ? `<button class="check ${isDone(i)?"on":""}" data-done="${esc(i.uid)}" aria-label="${isDone(i)?"Снять отметку":"Отметить выполненным"}">${CHECK}</button>` : `<span></span>`;
  const actions = UI.openItem === i.uid && !isClass(i) ? `<div class="item-actions"><button class="btn danger" data-del="${esc(i.uid)}">Удалить из календаря</button><button class="btn" data-close="1">Отмена</button></div>` : "";
  return `<div class="item ${isTask(i)&&isDone(i)?"done":""} ${stale?"stale":""}" style="--cc:${color(i.cal)}" data-open="${esc(i.uid)}">
    ${t}<div style="min-width:0"><div class="ttl">${esc(title)}</div><div class="meta"><span class="dot" style="background:${color(i.cal)}"></span><span>${CALS[i.cal]?.name||""}</span>${teacher?`<span>· ${esc(teacher)}</span>`:""}${i.location?`<span>· ${esc(i.location)}</span>`:""}${cc?`<span class="chip carry">перенос ×${cc}</span>`:""}${i.pending?`<span class="chip" style="padding:1px 8px">ждёт iCloud</span>`:""}</div></div>${right}
    ${stale?`<div class="stale-note">Переносится уже ${cc} ${times(cc)}. Может, разбить её на шаги поменьше или удалить?</div>`:""}${actions}</div>`;
}
const agenda = (id, list, empty) => { document.getElementById(id).innerHTML = list.length ? list.map(itemHTML).join("") : `<div class="empty">${empty}</div>`; };
function habitHTML(h){
  const wk = weekDates(), t = today(), n = habitWeek(h), pct = Math.min(100, Math.round(n/h.target*100));
  const next = entriesOf(h.id).filter(e=>e.status==="planned").sort((a,b)=>(a.day||"9999").localeCompare(b.day||"9999"))[0];
  return `<div class="habit" style="--hc:${esc(h.color||HABIT_COLORS[0])}">
    <button class="open" data-sheet="${esc(h.id)}" aria-label="Открыть: ${esc(h.name)}">
      <span class="hn"><span>${esc(h.name)}</span><span aria-hidden="true">›</span></span>
      <span class="hv">${n}<small>/ ${h.target} за неделю</small></span>
      <span class="bar"><i style="width:${pct}%"></i></span>
      ${next ? `<span class="next">План: ${next.day?short(next.day)+" · ":""}${esc(next.title)}</span>` : ""}
    </button>
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

/* ---------- отрисовка: экраны ---------- */
function render(){
  const now = new Date(), t = today(), items = allItems();
  document.getElementById("today-str").textContent = `${WD_LONG[now.getDay()]}, ${now.getDate()} ${MONTHS_G[now.getMonth()]}`;
  const h = now.getHours();
  document.getElementById("hello").innerHTML = (h<5?"Доброй ночи":h<12?"Доброе утро":h<18?"Добрый день":"Добрый вечер") + ", <span>Даша</span>";
  renderNet();

  const b = document.getElementById("banner"), ch = D.meta.schedule_changes;
  if (!D.events.length && !D.syncedAt){ b.hidden = false; b.innerHTML = navigator.onLine ? "Загружаю расписание…" : "Нет данных. Подключись к интернету один раз, чтобы загрузить расписание."; }
  else if (!session && navigator.onLine && sb){ b.hidden = false; b.innerHTML = `Войди, чтобы отметки синхронизировались. <button class="link" id="b-login" style="justify-self:start">Войти</button>`; }
  else if (ch && ch.at !== UI.dismissed && (Date.now() - new Date(ch.at)) < 3*864e5){
    b.hidden = false; b.innerHTML = `<b>Изменения в расписании</b>${(ch.lines||[]).map(l=>`<small>${esc(l)}</small>`).join("")}<button class="link" id="b-dismiss" style="justify-self:start">Понятно</button>`;
  } else b.hidden = true;

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

  const undone = tItems.filter(i=>CARRY_CALS.includes(i.cal) && !isDone(i) && !/^ДЕДЛАЙН/i.test(i.title)).length;
  document.getElementById("carry-hint").textContent = undone ? `не отмечено до 23:00 → на завтра` : "";
  agenda("ag-today", tItems, "На сегодня ничего нет.");
  const tm = addDays(new Date(),1);
  document.getElementById("tmr-title").textContent = `Завтра, ${WD_LONG[tm.getDay()]}`;
  agenda("ag-tmr", itemsOn(ds(tm), items), "Завтра свободно.");
  document.getElementById("habits-mini").innerHTML = HS.length ? HS.map(habitHTML).join("") : `<div class="empty">Привычки появятся после первой синхронизации.</div>`;

  renderCal(items); renderTrack(items, habPct, taskPct, wkTasks.length, wkDone); renderLater(); renderSheet();
}

function renderCal(items){
  if (!UI.sel) UI.sel = today();
  const t = today(), off = new Set(UI.off), sd = parseD(UI.sel);
  const dotsFor = d => [...new Set(itemsOn(d, items).filter(i=>!off.has(i.cal)).map(i=>i.cal))].slice(0,4).map(c=>`<i style="background:${color(c)}"></i>`).join("");
  document.getElementById("cm-week").classList.toggle("on", UI.calMode==="week");
  document.getElementById("cm-month").classList.toggle("on", UI.calMode==="month");
  document.getElementById("strip").hidden = UI.calMode !== "week";
  document.getElementById("month").hidden = UI.calMode !== "month";

  if (UI.calMode === "week"){
    const start = addDays(monday(new Date()), -7);
    document.getElementById("strip").innerHTML = [...Array(56)].map((_,k)=>{
      const d = ds(addDays(start,k)), dd = parseD(d);
      return `<button class="day ${d===UI.sel?"sel":""} ${d===t?"today":""}" data-day="${d}"><small>${WD[(dd.getDay()+6)%7]}</small><b>${dd.getDate()}</b><span class="dots">${dotsFor(d)}</span></button>`;
    }).join("");
    document.getElementById("month-title").textContent = `${MONTHS[sd.getMonth()]} ${sd.getFullYear()}`;
  } else {
    if (!UI.month) UI.month = UI.sel.slice(0,7);
    const [y,m] = UI.month.split("-").map(Number), first = new Date(y, m-1, 1), gridStart = monday(first);
    document.getElementById("month-name").textContent = `${MONTHS[m-1]} ${y}`;
    document.getElementById("month-title").textContent = "Календарь";
    let html = WD.map(w=>`<div class="wdh">${w}</div>`).join("");
    for (let k=0; k<42; k++){
      const dd = addDays(gridStart,k), d = ds(dd);
      if (k>=35 && dd.getMonth() !== m-1) break;
      html += `<button class="mday ${dd.getMonth()!==m-1?"out":""} ${d===t?"today":""} ${d===UI.sel?"sel":""}" data-day="${d}"><b>${dd.getDate()}</b><span class="dots">${dotsFor(d)}</span></button>`;
    }
    document.getElementById("mgrid").innerHTML = html;
  }
  const wl = WD_LONG[sd.getDay()];
  document.getElementById("sel-title").textContent = UI.sel===t ? "Сегодня" : `${wl[0].toUpperCase()+wl.slice(1)}, ${human(UI.sel)}`;
  document.getElementById("filters").innerHTML = Object.entries(CALS).map(([k,c])=>`<button class="${off.has(k)?"off":""}" data-filter="${k}"><span class="dot" style="background:var(${c.v})"></span>${c.name}</button>`).join("");
  agenda("ag-sel", itemsOn(UI.sel, items).filter(i=>!off.has(i.cal)), "В этот день ничего нет.");
  const fc = document.getElementById("f-cal");
  if (!fc.options.length) fc.innerHTML = Object.entries(CALS).filter(([k])=>k!=="study").map(([k,c])=>`<option value="${k}">${c.name}</option>`).join("");
}

const LOAD_WEEKS_BACK = 4, LOAD_WEEKS_FWD = 5;
let loadScrolled = false;
function renderLoad(items){
  const order = ["study","work","beauty","health"], weeks = LOAD_WEEKS_BACK + 1 + LOAD_WEEKS_FWD;
  const start = addDays(monday(new Date()), -7*LOAD_WEEKS_BACK), days = [...Array(weeks*7)].map((_,k)=>ds(addDays(start,k)));
  const data = days.map(d => { const its = itemsOn(d, items).filter(i=>!i.allDay); const o = {}; for (const c of order) o[c] = its.filter(i=>i.cal===c).reduce((s,i)=>s+Math.max(0,mins(i.end)-mins(i.start))/60,0); return o; });
  const tot = data.map(o=>order.reduce((s,c)=>s+o[c],0)), max = Math.max(4, Math.ceil(Math.max(...tot)/2)*2);
  const scroller = document.getElementById("load-scroll"), WW = Math.max(300, scroller.clientWidth || 320);   // ширина одной недели = ширина блока
  const H = 120, Y0 = 26, colW = WW/7, bw = colW*0.56, t = today();
  let svg = "";
  for (let w=0; w<weeks; w++){
    const x0 = w*WW, m = parseD(days[w*7]), e = parseD(days[w*7+6]);
    svg += `<rect class="snap" x="${x0}" y="0" width="${WW}" height="1" fill="transparent"/>`;
    svg += `<text x="${x0+6}" y="12" style="fill:var(${w===LOAD_WEEKS_BACK?"--fg":"--muted"});font-weight:${w===LOAD_WEEKS_BACK?600:400}">${w===LOAD_WEEKS_BACK?"Эта неделя · ":""}${m.getDate()} ${MONTHS_S[m.getMonth()]} – ${e.getDate()} ${MONTHS_S[e.getMonth()]}</text>`;
    for (const g of [0, max/2, max]){ const y = Y0+H-(g/max)*H; svg += `<line x1="${x0+4}" x2="${x0+WW-4}" y1="${y}" y2="${y}" stroke="var(--line)"/>`; }
  }
  data.forEach((o,k)=>{
    const x = k*colW + (colW-bw)/2, d = days[k]; let y = Y0+H;
    svg += `<g class="bar-hit" data-chartday="${d}"><rect x="${k*colW}" y="${Y0}" width="${colW}" height="${H+24}" fill="transparent"/>`;
    for (const c of order){ const h = o[c]/max*H; if (h>0){ y -= h; svg += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(h-1.5,1)}" rx="5" fill="${color(c)}"/>`; } }
    if (tot[k]>0) svg += `<text x="${x+bw/2}" y="${y-5}" text-anchor="middle" style="fill:var(--fg)">${Math.round(tot[k]*10)/10}</text>`;
    const dd = parseD(d);
    svg += `<text x="${x+bw/2}" y="${Y0+H+16}" text-anchor="middle" ${d===t?'style="fill:var(--c-important);font-weight:600"':""}>${WD[k%7]} ${dd.getDate()}</text></g>`;
  });
  const el = document.getElementById("load-chart");
  el.setAttribute("viewBox", `0 0 ${WW*weeks} ${Y0+H+24}`); el.style.width = `${WW*weeks}px`;
  el.innerHTML = svg;
  if (!loadScrolled && scroller.clientWidth){ scroller.scrollLeft = WW*LOAD_WEEKS_BACK; loadScrolled = true; }
  document.getElementById("load-legend").innerHTML = order.map(c=>`<span class="chip"><span class="dot" style="background:${color(c)}"></span>${CALS[c].name}</span>`).join("");
  return data.slice(LOAD_WEEKS_BACK*7, LOAD_WEEKS_BACK*7+7);
}
function renderTrack(items, habPct, taskPct, nTasks, nDone){
  const HS = habits();
  document.getElementById("hab-pct").textContent = habPct===null ? "—" : habPct + "%";
  document.getElementById("task-pct").textContent = taskPct===null ? "—" : taskPct + "%";
  document.getElementById("task-cap").textContent = nTasks ? `${nDone} из ${nTasks} на этой неделе` : "задач на неделе нет";
  document.getElementById("habits-full").innerHTML = HS.length ? HS.map(habitHTML).join("") : `<div class="empty">Привычек пока нет. Нажми «+ Привычка».</div>`;
  const thisWeek = renderLoad(items);

  const weeks = [-3,-2,-1,0].map(off=>{ const T = HS.reduce((s,h)=>s+h.target,0), N = HS.reduce((s,h)=>s+Math.min(h.target,habitWeek(h,off)),0); return T ? Math.round(N/T*100) : 0; });
  let s2 = ""; const hX0=28, hW=300, hH=90, hY0=12, hb=hW/4*0.5;
  [0,50,100].forEach(g=>{ const y=hY0+hH-g/100*hH; s2 += `<line x1="${hX0}" x2="${hX0+hW}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${hX0-6}" y="${y+4}" text-anchor="end">${g}</text>`; });
  weeks.forEach((v,k)=>{ const x = hX0 + k*(hW/4) + (hW/4-hb)/2, h = v/100*hH, y = hY0+hH-h, m = addDays(monday(new Date()), (k-3)*7);
    s2 += `<rect x="${x}" y="${y}" width="${hb}" height="${Math.max(h,2)}" rx="8" fill="${k===3?"var(--c-study)":"var(--muted)"}" opacity="${k===3?1:.35}"/><text x="${x+hb/2}" y="${y-6}" text-anchor="middle" style="fill:var(--fg)">${v}%</text><text x="${x+hb/2}" y="${hY0+hH+18}" text-anchor="middle">${k===3?"эта":`${m.getDate()}.${pad(m.getMonth()+1)}`}</text>`; });
  document.getElementById("hist-chart").innerHTML = s2;

  const classH = thisWeek.reduce((s,o)=>s+o.study,0);
  let streak = 0; for (let off=-1; off>=-4; off--){ if (HS.length && HS.every(h=>habitWeek(h,off)>=h.target)) streak++; else break; }
  const stale = items.filter(i=>carryCount(i)>=STALE_AFTER && !isDone(i)).length;
  document.getElementById("kv").innerHTML = `<div><b>${Math.round(classH)}</b><span>часов пар на неделе</span></div><div><b>${stale}</b><span>задач переносятся 3+ раза</span></div><div><b>${streak}</b><span>недель подряд план выполнен</span></div>`;
}

/* ---------- карточка привычки ---------- */
function renderSheet(){
  const sh = document.getElementById("sheet"), back = document.getElementById("sheet-back");
  const h = UI.sheet && D.habits.find(x=>x.id===UI.sheet && !x.deleted);
  if (!h){ sh.hidden = true; back.hidden = true; return; }
  const keepFocus = document.activeElement && sh.contains(document.activeElement) ? document.activeElement.id : null;
  const draft = {t: document.getElementById("e-title")?.value || "", d: document.getElementById("e-day")?.value || ""};
  const t = today(), all = entriesOf(h.id);
  const planned = all.filter(e=>e.status==="planned").sort((a,b)=>(a.day||"9999").localeCompare(b.day||"9999"));
  const done = all.filter(e=>e.status==="done").sort((a,b)=>(b.day||"").localeCompare(a.day||"")).slice(0,30);
  const n = habitWeek(h);
  const entryHTML = e => `<div class="entry ${e.status==="planned"&&e.day&&e.day<t?"overdue":""}">
      <button class="check ${e.status==="done"?"on":""}" data-entry-done="${esc(e.id)}" aria-label="${e.status==="done"?"Вернуть в план":"Отметить сделанным"}">${CHECK}</button>
      <div style="min-width:0"><div class="ttl">${esc(e.title)}</div><div class="meta">${e.day?(e.status==="done"?"сделано ":"на ")+human(e.day):"без даты"}${e.status==="planned"&&e.day&&e.day<t?" · просрочено":""}${e.note?` · ${esc(e.note)}`:""}</div></div>
      <button class="x" data-entry-del="${esc(e.id)}" aria-label="Удалить запись">${XICON}</button></div>`;
  document.getElementById("sheet-body").innerHTML = `
    <div class="row between"><div><h2 id="sh-title">${esc(h.name)}</h2><div class="sub">${n} из ${h.target} на этой неделе</div></div><button class="x" data-sheet-close="1" aria-label="Закрыть">${XICON}</button></div>
    <div class="habit" style="--hc:${esc(h.color)};padding:12px"><div class="week-dots">${weekDates().map((d,k)=>`<button class="wd ${habitOn(h.id,d)?"on":""} ${d===t?"today":""}" data-toggle="${esc(h.id)}|${d}" aria-label="${WD[k]}">${WD[k][0]}</button>`).join("")}</div></div>
    <form class="card white form" id="entry-form">
      <h3>Запланировать</h3>
      <div class="field"><label for="e-title">Что</label><input id="e-title" placeholder="${/инст|пост/i.test(h.name)?"Например, рилс про упаковку диффузора":"Например, бег 5 км"}" required value="${esc(draft.t)}"></div>
      <div class="two"><div class="field"><label for="e-day">День (необязательно)</label><input id="e-day" type="date" value="${esc(draft.d)}"></div><div class="field" style="align-self:end"><button class="btn ink big" type="submit">Добавить</button></div></div>
    </form>
    <div><h3 style="margin-bottom:8px">В планах · ${planned.length}</h3><div class="agenda">${planned.length?planned.map(entryHTML).join(""):`<div class="empty">Пока пусто. Запланируй, что сделать, — отметка «сделано» сама поставит галочку привычки.</div>`}</div></div>
    <div><h3 style="margin-bottom:8px">Сделано</h3><div class="agenda">${done.length?done.map(entryHTML).join(""):`<div class="empty">Здесь появится история: что именно ты сделала и когда.</div>`}</div></div>
    <form class="card form" id="habit-form">
      <h3>Настройки привычки</h3>
      <div class="two"><div class="field"><label for="h-name">Название</label><input id="h-name" required value="${esc(h.name)}"></div><div class="field"><label for="h-target">Раз в неделю</label><input id="h-target" type="number" min="1" max="7" value="${h.target}"></div></div>
      <div class="row between"><button class="btn danger" type="button" id="h-del">Удалить привычку</button><button class="btn ink" type="submit">Сохранить</button></div>
    </form>`;
  sh.hidden = false; back.hidden = false;
  if (keepFocus) document.getElementById(keepFocus)?.focus();
}
function openSheet(id){ UI.sheet = id; renderSheet(); document.getElementById("sheet").scrollTop = 0; }
function closeSheet(){ UI.sheet = null; renderSheet(); }

/* ---------- «Потом» ---------- */
const URL_RE = /https?:\/\/[^\s]+/i;
function renderLater(){
  const all = laterItems(), t = today();
  const open = all.filter(s=>s.status==="open").sort((a,b)=>(b.created_at||"").localeCompare(a.created_at||""));
  const sched = all.filter(s=>s.status==="scheduled").sort((a,b)=>(a.scheduled_to||"").localeCompare(b.scheduled_to||""));
  const done = all.filter(s=>s.status==="done").sort((a,b)=>(b.updated_at||"").localeCompare(a.updated_at||"")).slice(0,30);
  const link = s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url.replace(/^https?:\/\/(www\.)?/,"").slice(0,48))}${s.url.length>60?"…":""}</a>` : "";
  const calOpts = Object.entries(CALS).filter(([k])=>k!=="study").map(([k,c])=>`<option value="${k}" ${k==="work"?"selected":""}>${c.name}</option>`).join("");
  document.getElementById("later-list").innerHTML = open.length ? open.map(s=>`<div class="later">
      <div style="min-width:0"><div class="ttl">${esc(s.title)}</div>${link(s)}</div>
      <button class="x" data-later-del="${esc(s.id)}" aria-label="Удалить">${XICON}</button>
      ${UI.laterOpen===s.id ? `<form class="form" data-later-form="${esc(s.id)}">
          <div class="two"><div class="field"><label for="ls-day">День</label><input id="ls-day" type="date" required value="${t}"></div><div class="field"><label for="ls-cal">Календарь</label><select id="ls-cal">${calOpts}</select></div></div>
          <div class="two"><div class="field"><label for="ls-start">Время (пусто — весь день)</label><input id="ls-start" type="time"></div><div class="field" style="align-self:end"><button class="btn ink big" type="submit">В календарь</button></div></div>
        </form>` : `<div class="acts"><button class="btn ink" data-later-plan="${esc(s.id)}">Поставить в день</button><button class="btn" data-later-done="${esc(s.id)}">Сделано</button></div>`}
    </div>`).join("") : `<div class="empty">Список пуст. Сюда удобно кидать видео, статьи и идеи «когда-нибудь».</div>`;
  document.getElementById("later-sched-wrap").hidden = !sched.length;
  document.getElementById("later-sched").innerHTML = sched.map(s=>`<div class="later"><div style="min-width:0"><div class="ttl">${esc(s.title)}</div><div class="sub">на ${s.scheduled_to?human(s.scheduled_to):"—"}</div>${link(s)}</div><button class="x" data-later-reopen="${esc(s.id)}" aria-label="Вернуть в список" title="Вернуть в «Потом»">↺</button></div>`).join("");
  document.getElementById("later-done-wrap").hidden = !done.length;
  document.getElementById("later-done").innerHTML = done.map(s=>`<div class="later"><div style="min-width:0"><div class="ttl" style="text-decoration:line-through;color:var(--muted)">${esc(s.title)}</div>${link(s)}</div><button class="x" data-later-reopen="${esc(s.id)}" aria-label="Вернуть в список" title="Вернуть в «Потом»">↺</button></div>`).join("");
}

/* ---------- действия ---------- */
function setTab(tab){
  UI.tab = tab; save(LS_UI, UI);
  document.querySelectorAll("#tabs button").forEach(x=>x.classList.toggle("on", x.dataset.tab===tab));
  document.querySelectorAll("section.view").forEach(s=>s.classList.toggle("is-active", s.id==="v-"+tab));
  window.scrollTo(0,0);
  if (tab === "track"){ loadScrolled = false; render(); }
}
const saveUI = () => save(LS_UI, {...UI, sheet:null, laterOpen:null});
document.addEventListener("click", e => {
  const chart = e.target.closest("[data-chartday]");
  if (chart){ UI.sel = chart.dataset.chartday; UI.month = UI.sel.slice(0,7); setTab("cal"); render(); return; }
  if (e.target.id === "sheet-back"){ closeSheet(); return; }
  const b = e.target.closest("button, .item"); if (!b) return;
  const d = b.dataset;
  if (b.id === "net"){ if (!session && sb) showGate(); else sync(); return; }
  if (b.id === "b-login"){ showGate(); return; }
  if (b.id === "b-dismiss"){ UI.dismissed = D.meta.schedule_changes?.at; saveUI(); render(); return; }
  if (d.tab){ setTab(d.tab); return; }
  if (d.go){ setTab(d.go); return; }
  if (d.calmode){ UI.calMode = d.calmode; UI.month = (UI.sel||today()).slice(0,7); saveUI(); render(); return; }
  if (d.month){ const [y,m] = UI.month.split("-").map(Number), x = new Date(y, m-1+Number(d.month), 1); UI.month = `${x.getFullYear()}-${pad(x.getMonth()+1)}`; render(); return; }
  if (d.day){ UI.sel = d.day; UI.openItem = null; render(); return; }
  if (d.filter){ const s = new Set(UI.off); s.has(d.filter) ? s.delete(d.filter) : s.add(d.filter); UI.off = [...s]; saveUI(); render(); return; }
  if (d.sheet){ openSheet(d.sheet); return; }
  if (d.sheetClose){ closeSheet(); return; }
  if (d.done){ e.stopPropagation(); const cur = D.done[d.done]?.done; write("task_done", {uid:d.done, done:!cur, updated_at:nowIso()}); return; }
  if (d.toggle){ const [hid, day] = d.toggle.split("|"); write("habit_logs", {id:`${hid}_${day}`, habit_id:hid, day, done:!habitOn(hid,day), updated_at:nowIso()}); return; }
  if (d.entryDone){
    const en = D.entries[d.entryDone]; if (!en) return;
    if (en.status === "planned"){
      const day = en.day && en.day <= today() ? en.day : today();
      write("habit_entries", {...en, status:"done", day, updated_at:nowIso()}, {quiet:true});
      write("habit_logs", {id:`${en.habit_id}_${day}`, habit_id:en.habit_id, day, done:true, updated_at:nowIso()});
    } else write("habit_entries", {...en, status:"planned", updated_at:nowIso()});
    return;
  }
  if (d.entryDel){ const en = D.entries[d.entryDel]; if (en) write("habit_entries", {...en, deleted:true, updated_at:nowIso()}); return; }
  if (d.del){ e.stopPropagation(); const it = allItems().find(i=>i.uid===d.del); UI.openItem = null;
    write("outbox", {id:uid8(), op:"delete", payload:{uid:d.del, title:it?.title||""}, status:"pending", created_at:nowIso()}); return; }
  if (d.close){ e.stopPropagation(); UI.openItem = null; render(); return; }
  if (d.laterPlan){ UI.laterOpen = d.laterPlan; render(); document.getElementById("ls-day")?.focus(); return; }
  if (d.laterDone){ const s = D.someday[d.laterDone]; write("someday", {...s, status:"done", updated_at:nowIso()}); return; }
  if (d.laterDel){ const s = D.someday[d.laterDel]; write("someday", {...s, deleted:true, updated_at:nowIso()}); return; }
  if (d.laterReopen){ const s = D.someday[d.laterReopen]; write("someday", {...s, status:"open", scheduled_to:null, updated_at:nowIso()}); return; }
  if (d.open && b.classList.contains("item")){ const it = allItems().find(i=>i.uid===d.open); if (it && !isClass(it)){ UI.openItem = UI.openItem===d.open ? null : d.open; render(); } }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && UI.sheet) closeSheet(); });

document.addEventListener("submit", e => {
  const f = e.target;
  if (f.id === "entry-form"){
    e.preventDefault();
    const title = document.getElementById("e-title").value.trim(), day = document.getElementById("e-day").value || null;
    if (!title) return;
    document.getElementById("e-title").value = ""; document.getElementById("e-day").value = "";
    write("habit_entries", {id:"e"+uid8(), habit_id:UI.sheet, day, title, note:"", status:"planned", deleted:false, updated_at:nowIso()});
    return;
  }
  if (f.id === "habit-form"){
    e.preventDefault();
    const h = D.habits.find(x=>x.id===UI.sheet); if (!h) return;
    const name = document.getElementById("h-name").value.trim(), target = Math.max(1, Math.min(7, +document.getElementById("h-target").value || 3));
    if (name) write("habits", {...h, name, target, updated_at:nowIso()});
    return;
  }
  if (f.dataset.laterForm){
    e.preventDefault();
    const s = D.someday[f.dataset.laterForm]; if (!s) return;
    const day = document.getElementById("ls-day").value, cal = document.getElementById("ls-cal").value, st = document.getElementById("ls-start").value;
    if (!day) return;
    let end = ""; if (st){ const [h,m] = st.split(":").map(Number); const x = new Date(2000,0,1,h,m+60); end = `${day}T${pad(x.getHours())}:${pad(x.getMinutes())}`; }
    write("outbox", {id:uid8(), op:"add", status:"pending", created_at:nowIso(),
      payload:{cal, title:s.title, start: st ? `${day}T${st}` : day, end, allDay:!st, alarms: st ? [15] : [-540], url:s.url||"", notes:s.note||""}}, {quiet:true});
    UI.laterOpen = null;
    write("someday", {...s, status:"scheduled", scheduled_to:day, updated_at:nowIso()});
    return;
  }
});

// «Потом»: добавить
document.getElementById("later-form").addEventListener("submit", e => {
  e.preventDefault();
  const inp = document.getElementById("lt-title"), raw = inp.value.trim(); if (!raw) return;
  const url = (raw.match(URL_RE)||[""])[0], title = raw.replace(URL_RE, "").replace(/\s{2,}/g," ").trim() || url;
  inp.value = "";
  write("someday", {id:"s"+uid8(), title, url, note:"", status:"open", deleted:false, created_at:nowIso(), updated_at:nowIso()});
});

// добавить задачу в календарь
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

// новая привычка
document.getElementById("btn-habit").onclick = () => {
  const id = "h"+uid8();
  write("habits", {id, name:"Новая привычка", target:3, color:HABIT_COLORS[habits().length % HABIT_COLORS.length], sort:habits().length, deleted:false, updated_at:nowIso()});
  openSheet(id); setTimeout(()=>{ const n = document.getElementById("h-name"); if (n){ n.focus(); n.select(); } }, 50);
};
let delArm = false;
document.addEventListener("click", ev => {
  if (ev.target.id !== "h-del") return;
  if (!delArm){ delArm = true; ev.target.textContent = "Точно удалить?"; setTimeout(()=>{ delArm = false; const b = document.getElementById("h-del"); if (b) b.textContent = "Удалить привычку"; }, 3000); return; }
  delArm = false;
  const h = D.habits.find(x=>x.id===UI.sheet); if (h){ UI.sheet = null; write("habits", {...h, deleted:true, updated_at:nowIso()}); }
});

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
let logoutArm = false;
document.getElementById("btn-logout").onclick = async () => {
  const b = document.getElementById("btn-logout");
  if (Q.length && !logoutArm){ logoutArm = true; b.textContent = `Есть ${Q.length} неотправленных. Нажми ещё раз, чтобы выйти`; setTimeout(()=>{ logoutArm = false; b.textContent = "Выйти из аккаунта"; }, 4000); return; }
  await sb?.auth.signOut(); session = null; D = emptyData(); Q = []; save(LS_DATA, D); save(LS_QUEUE, Q); showGate();
};

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
window.addEventListener("resize", () => { if (UI.tab === "track"){ loadScrolled = false; render(); } });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible"){ render(); sync(); } });
setInterval(() => { if (document.visibilityState === "visible" && !UI.sheet && !UI.laterOpen) sync(); }, 60000);
setInterval(() => { if (!UI.sheet && !UI.laterOpen) render(); }, 60000);
