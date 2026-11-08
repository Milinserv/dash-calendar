"""Синхронизация приложения «Дашин день» с iCloud через Supabase.

1) Берёт из таблицы outbox задачи со статусом pending и записывает их в календари iCloud.
2) Читает календари iCloud и обновляет таблицу events (пары — на 40 дней вперёд, задачи — на 120, «Важное» — на год).

Переменные окружения: APPLE_ID, APPLE_PW (пароль для приложений), SUPABASE_URL, SUPABASE_SERVICE_KEY.
"""
import os, datetime as dt
from zoneinfo import ZoneInfo
import requests, caldav
from icalendar import Calendar, Event, Alarm

TZ = ZoneInfo("Europe/Samara")
NAMES = {"study": "Учёба", "work": "Работа", "important": "Важное", "beauty": "Бьюти", "health": "Здоровье", "personal": "Личное"}
CODES = {v: k for k, v in NAMES.items()}

SB = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

def sb(method, path, **kw):
    r = requests.request(method, f"{SB}/{path}", headers={**H, **kw.pop("headers", {})}, timeout=60, **kw)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase {method} {path}: {r.status_code} {r.text[:300]}")
    return r.json() if r.text else None

client = caldav.DAVClient("https://caldav.icloud.com/", username=os.environ["APPLE_ID"], password=os.environ["APPLE_PW"])
cals = {c.get_display_name(): c for c in client.principal().calendars()}

# ---------- 1. outbox -> iCloud ----------
def add_event(o):
    cal = cals[NAMES[o["cal"]]]
    ic = Calendar(); ic.add("prodid", "-//dasha-app//"); ic.add("version", "2.0")
    e = Event(); e.add("uid", f"app-{o['id']}@dasha"); e.add("summary", o["title"])
    if o.get("allDay"):
        d = dt.date.fromisoformat(o["start"][:10]); e.add("dtstart", d)
        e.add("dtend", dt.date.fromisoformat(o["end"][:10]) if o.get("end") else d + dt.timedelta(1))
        e.add("transp", "TRANSPARENT")
    else:
        s = dt.datetime.fromisoformat(o["start"]).replace(tzinfo=TZ)
        en = dt.datetime.fromisoformat(o["end"]).replace(tzinfo=TZ) if o.get("end") else s + dt.timedelta(hours=1)
        e.add("dtstart", s); e.add("dtend", en)
    if o.get("yearly"): e.add("rrule", {"freq": "yearly"})
    if o.get("notes"): e.add("description", o["notes"])
    if o.get("url"): e.add("url", o["url"])
    e.add("dtstamp", dt.datetime.now(dt.timezone.utc))
    for m in o.get("alarms") or []:
        a = Alarm(); a.add("action", "DISPLAY"); a.add("description", o["title"])
        a.add("trigger", dt.timedelta(minutes=-int(m))); e.add_component(a)
    ic.add_component(e); cal.save_event(ic.to_ical().decode())

def delete_event(uid):
    uid = uid.split("_")[0]
    for name in NAMES.values():
        for ev in cals[name].events():
            if str(ev.icalendar_component.get("UID")) == uid:
                ev.delete(); return
    raise RuntimeError("событие не найдено")

pending = sb("GET", "outbox?status=eq.pending&order=created_at.asc")
for row in pending:
    try:
        p = dict(row["payload"], id=row["id"])
        add_event(p) if row["op"] == "add" else delete_event(p["uid"])
        sb("PATCH", f"outbox?id=eq.{row['id']}", json={"status": "done", "error": None})
        print("OK", row["op"], p.get("title") or p.get("uid"))
    except Exception as ex:
        sb("PATCH", f"outbox?id=eq.{row['id']}", json={"status": "error", "error": str(ex)[:300]})
        print("ERROR", row["id"], ex)

# ---------- 2. iCloud -> events ----------
now = dt.datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
start = now - dt.timedelta(days=7)
items = {}
for name, cal in cals.items():
    if name not in CODES: continue
    e2 = now + dt.timedelta(days={"Важное": 370, "Учёба": 40}.get(name, 120))
    for obj in cal.search(start=start, end=e2, event=True, expand=True):
        for comp in obj.icalendar_instance.walk("VEVENT"):
            s = comp.get("DTSTART").dt; e = comp.get("DTEND").dt if comp.get("DTEND") else s
            allday = not isinstance(s, dt.datetime)
            S, E = (s.isoformat(), e.isoformat()) if allday else (s.astimezone(TZ).strftime("%Y-%m-%dT%H:%M"), e.astimezone(TZ).strftime("%Y-%m-%dT%H:%M"))
            uid = str(comp.get("UID"))
            if comp.get("RECURRENCE-ID") or comp.get("RRULE") or (allday and name == "Важное"):
                uid = f"{uid}_{S[:10]}"
            items[uid] = dict(uid=uid, title=str(comp.get("SUMMARY", "")), start_at=S, end_at=E, all_day=allday,
                              cal=CODES[name], location=str(comp.get("LOCATION", "") or ""),
                              updated_at=dt.datetime.now(dt.timezone.utc).isoformat())

rows = list(items.values())
for i in range(0, len(rows), 200):
    sb("POST", "events?on_conflict=uid", json=rows[i:i+200], headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
# убрать из окна то, чего больше нет в iCloud
have = sb("GET", f"events?select=uid,start_at&start_at=gte.{start.date().isoformat()}")
gone = [r["uid"] for r in have if r["uid"] not in items]
for i in range(0, len(gone), 100):
    chunk = ",".join('"' + u.replace('"', '') + '"' for u in gone[i:i+100])
    sb("DELETE", f"events?uid=in.({chunk})")
old = (now - dt.timedelta(days=60)).date().isoformat()
sb("DELETE", f"events?start_at=lt.{old}")
sb("POST", "meta?on_conflict=key", json=[{"key": "synced_at", "value": dt.datetime.now(TZ).isoformat(timespec="minutes"),
    "updated_at": dt.datetime.now(dt.timezone.utc).isoformat()}], headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
print(f"events: {len(rows)} в окне, удалено {len(gone)}, outbox: {len(pending)}")
