"""Синхронизация events.json -> календарь iCloud «Учёба». Использование: APPLE_ID=... APPLE_PW=... python3 sync.py events.json"""
import os, sys, json, datetime as dt
from zoneinfo import ZoneInfo
import caldav
from icalendar import Calendar, Event

TZ = ZoneInfo("Europe/Samara")   # Ижевск, UTC+4
CAL_NAME = "Учёба"
data = json.load(open(sys.argv[1]))
want = {e["uid"]: e for e in data["events"]}

client = caldav.DAVClient("https://caldav.icloud.com/", username=os.environ["APPLE_ID"], password=os.environ["APPLE_PW"])
principal = client.principal()
cal = next((c for c in principal.calendars() if c.get_display_name() == CAL_NAME), None)
if cal is None:
    cal = principal.make_calendar(name=CAL_NAME)
    print("Создан календарь", CAL_NAME)

now = dt.datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
have = {}
for obj in cal.search(start=now, end=now + dt.timedelta(days=40), event=True, expand=False):
    ics = Calendar.from_ical(obj.data)
    for comp in ics.walk("VEVENT"):
        uid = str(comp.get("UID"))
        if uid.startswith("udsu-"):
            have[uid] = (obj, str(comp.get("SUMMARY")), comp.get("DTSTART").dt)

removed = [(have[u][2], have[u][1]) for u in have if u not in want]
for u in have:
    if u not in want: have[u][0].delete()

added = []
for u, e in want.items():
    if u in have: continue
    c = Calendar(); c.add("prodid", "-//udsu-sync//dasha//"); c.add("version", "2.0")
    ev = Event()
    ev.add("uid", u); ev.add("summary", e["title"])
    ev.add("dtstart", dt.datetime.fromisoformat(e["start"]).replace(tzinfo=TZ))
    ev.add("dtend", dt.datetime.fromisoformat(e["end"]).replace(tzinfo=TZ))
    ev.add("dtstamp", dt.datetime.now(dt.timezone.utc))
    if e["location"]: ev.add("location", e["location"])
    ev.add("description", ((e["note"] + "\n") if e["note"] else "") + "Источник: " + data["source"])
    c.add_component(ev)
    cal.save_event(c.to_ical().decode())
    if e["start"][:10] < (now + dt.timedelta(days=28)).date().isoformat():
        added.append((e["start"], e["title"]))   # новые даты в конце окна — не изменение

print(f"Итог: в календаре {len(want)} пар на ближайшие 5 недель; добавлено {len(want)-len([u for u in want if u in have])}, удалено {len(removed)}")
first_run = not have
if not first_run:
    for s, t in sorted(added): print("  + НОВОЕ:", s[:16].replace("T", " "), t)
    for s, t in sorted(removed, key=lambda x: str(x[0])): print("  − УБРАНО:", str(s)[:16], t)
    print("ИЗМЕНЕНИЯ ЕСТЬ" if (added or removed) else "Изменений нет")
