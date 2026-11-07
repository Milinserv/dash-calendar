"""Перенос невыполненных задач на следующий день (запускается в 23:00).

Переносятся события календаря «Работа» за последние 3 дня (включая сегодня; запас, если запуск пропустился), у которых в приложении
не стоит галочка «выполнено». Дедлайны (название начинается с «ДЕДЛАЙН») и повторяющиеся события не переносятся.
Время сохраняется, меняется только дата. Счётчик переносов пишется в таблицу task_carry.
"""
import os, datetime as dt
from zoneinfo import ZoneInfo
import requests, caldav

TZ = ZoneInfo("Europe/Samara")
CARRY_CALS = ["Работа"]
SINCE = dt.date(2026, 11, 8)        # задачи раньше этой даты не трогаем (до запуска функции)
ONLY = os.environ.get("CARRY_ONLY_UID")  # для проверки: переносить только одно событие
SB = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

def sb(method, path, **kw):
    r = requests.request(method, f"{SB}/{path}", headers={**H, **kw.pop("headers", {})}, timeout=60, **kw)
    if r.status_code >= 400: raise RuntimeError(f"Supabase {r.status_code} {r.text[:300]}")
    return r.json() if r.text else None

# «сегодня» считаем с запасом на опоздание запуска после полуночи
base = (dt.datetime.now(TZ) - dt.timedelta(hours=3)).date()
target = base + dt.timedelta(days=1)

done = {r["uid"] for r in sb("GET", "task_done?select=uid&done=eq.true")}
carry = {r["uid"]: r for r in sb("GET", "task_carry?select=*")}

client = caldav.DAVClient("https://caldav.icloud.com/", username=os.environ["APPLE_ID"], password=os.environ["APPLE_PW"])
cals = {c.get_display_name(): c for c in client.principal().calendars()}

moved = 0
for name in CARRY_CALS:
    cal = cals.get(name)
    if not cal: continue
    start = dt.datetime.combine(max(SINCE, base - dt.timedelta(days=3)), dt.time(0), TZ)
    end = dt.datetime.combine(base + dt.timedelta(days=1), dt.time(0), TZ)
    for ev in cal.search(start=start, end=end, event=True, expand=False):
        comp = ev.icalendar_component
        uid, title = str(comp.get("UID")), str(comp.get("SUMMARY", ""))
        if ONLY and uid != ONLY: continue
        if comp.get("RRULE") or uid in done or title.strip().upper().startswith("ДЕДЛАЙН"):
            continue
        s = comp.get("DTSTART").dt
        e = comp.get("DTEND").dt if comp.get("DTEND") else None
        allday = not isinstance(s, dt.datetime)
        day = s if allday else s.astimezone(TZ).date()
        if day > base or day < SINCE: continue
        if allday:
            span = (e - s) if e else dt.timedelta(days=1)
            ns, ne = target, target + span
        else:
            dur = (e - s) if e else dt.timedelta(hours=1)
            ns = dt.datetime.combine(target, s.astimezone(TZ).time(), TZ); ne = ns + dur
        comp.pop("DTSTART"); comp.add("dtstart", ns)
        if "DTEND" in comp: comp.pop("DTEND")
        comp.add("dtend", ne)
        ev.save()
        prev = carry.get(uid) or {}
        sb("POST", "task_carry?on_conflict=uid", headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
           json=[{"uid": uid, "count": int(prev.get("count", 0)) + 1, "first_day": prev.get("first_day") or day.isoformat(),
                  "last_moved": dt.datetime.now(dt.timezone.utc).isoformat()}])
        moved += 1
        print(f"Перенесено: {title} ({day} → {target}), раз: {int(prev.get('count', 0)) + 1}")
print("Перенесено задач:", moved)
