"""Парсер расписания УдГУ МКПО: 2 смена ДИЗ, РЕК, ТУР — группа 54.02.01-41, подгруппа 2."""
import os, re, sys, json, datetime as dt, hashlib, urllib.request, urllib.parse, html
import xlrd

PAGE = "https://f-mkpo.udsu.ru/class_times"
LINK_TEXT = "2 смена ДИЗ"
GROUP = "54.02.01-41"
SUBGROUP = 2          # второй столбец группы
HOLIDAYS = {dt.date(2026,11,4), dt.date(2026,12,31), dt.date(2027,1,1)}
DAYS = ["ПОНЕДЕЛЬНИК","ВТОРНИК","СРЕДА","ЧЕТВЕРГ","ПЯТНИЦА","СУББОТА"]

def find_xls_url():
    h = urllib.request.urlopen(PAGE, timeout=60).read().decode("utf-8", "replace")
    for href, text in re.findall(r'href="([^"]+)"[^>]*>([^<]*)', h):
        if LINK_TEXT.lower() in html.unescape(text).lower():
            return urllib.parse.quote(urllib.parse.urljoin(PAGE, html.unescape(href)), safe=":/%?=&")
    raise SystemExit("Ссылка на файл расписания не найдена")

def load(path):
    b = xlrd.open_workbook(path, formatting_info=True)
    s = b.sheet_by_index(0)
    # найти столбцы группы
    grow = next(r for r in range(15) if any(GROUP in str(v) for v in s.row_values(r)))
    gcols = [c for c in range(s.ncols) if GROUP in str(s.cell_value(grow, c))]
    col0 = gcols[0]; target = col0 + SUBGROUP - 1
    covered = {}
    for r0, r1, c0, c1 in s.merged_cells:
        for r in range(r0, r1):
            for c in range(c0, c1):
                covered[(r, c)] = (r0, c0, r1, c1)
    lessons = []; day = None; slot = None; slot_row = None
    for r in range(grow + 1, s.nrows):
        d = str(s.cell_value(r, 0)).strip().upper()
        if d in DAYS: day = DAYS.index(d)
        t = str(s.cell_value(r, 1)).strip()
        if re.match(r"\d{1,2}\.\d{2}-\d{1,2}\.\d{2}", t): slot = t; slot_row = r
        if day is None or slot is None: continue
        for c in range(s.ncols):
            v = str(s.cell_value(r, c)).strip()
            if not v: continue
            r0, c0, r1, c1 = covered.get((r, c), (r, c, r + 1, c + 1))
            if not (c0 <= target < c1): continue
            half = "both" if (r1 - r0) >= 2 else ("top" if r == slot_row else "bottom")
            lessons.append(dict(day=day, slot=slot, text=" ".join(v.split()), half=half))
    return lessons

def date_rules(text, year):
    """'26.10 не будет X' -> exclude; '8.10,15.10 X' -> only."""
    m = re.match(r"^\s*((?:\d{1,2}[.,]\d{1,2}[.,]?\s*,?\s*)+)(.*)$", text)
    if not m: return None, None, text
    dates = set()
    for dd, mm in re.findall(r"(\d{1,2})[.,](\d{1,2})", m.group(1)):
        mo = int(mm); y = year if mo >= 8 else year + 1
        try: dates.add(dt.date(y, mo, int(dd)))
        except ValueError: pass
    rest = m.group(2).strip()
    if rest.lower().startswith("не будет"):
        return None, dates, rest[8:].strip()
    return dates, None, rest

def expand(lessons, start, days=35):
    year = start.year if start.month >= 8 else start.year - 1
    ev = []
    for i in range(days):
        d = start + dt.timedelta(days=i)
        if d.weekday() > 5 or d in HOLIDAYS: continue
        for L in lessons:
            if L["day"] != d.weekday(): continue
            only, excl, title = date_rules(L["text"], year)
            if only is not None and d not in only: continue
            if excl and d in excl: continue
            a, b = L["slot"].split("-")
            st = dt.datetime.combine(d, dt.time(*map(int, a.split("."))))
            en = dt.datetime.combine(d, dt.time(*map(int, b.split("."))))
            room = re.search(r"(\d{2,3}/\d|\d корп[^ ]*.*)$", title)
            ev.append(dict(start=st.isoformat(), end=en.isoformat(), title=title,
                           location=room.group(1) if room else "", note="" if L["half"]=="both" else "только половина пары по таблице — уточни неделю",
                           uid="udsu-" + hashlib.md5(f"{st.isoformat()}|{title}".encode()).hexdigest() + "@dasha"))
    return ev

def load_overrides():
    """Исключения из расписания, которые хранятся в базе (meta.schedule_overrides):
    {"skip_weekdays":[0], "skip_from":"2026-11-09", "skip_until":"", "skip_dates":["2026-11-20"], "skip_titles":["Физическая культура"]}
    weekday: 0 — понедельник … 5 — суббота."""
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key: return {}
    req = urllib.request.Request(url.rstrip("/") + "/rest/v1/meta?key=eq.schedule_overrides&select=value",
                                 headers={"apikey": key, "Authorization": f"Bearer {key}"})
    rows = json.loads(urllib.request.urlopen(req, timeout=60).read() or b"[]")
    return (rows[0]["value"] or {}) if rows else {}

def apply_overrides(ev, o):
    if not o: return ev
    wd, frm, until = set(o.get("skip_weekdays") or []), o.get("skip_from") or "0000", o.get("skip_until") or "9999"
    dates, titles = set(o.get("skip_dates") or []), [t.lower() for t in (o.get("skip_titles") or [])]
    out = []
    for e in ev:
        d = e["start"][:10]
        if d in dates: continue
        if frm <= d <= until and dt.date.fromisoformat(d).weekday() in wd: continue
        if any(t in e["title"].lower() for t in titles): continue
        out.append(e)
    return out

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "events.json"
    url = find_xls_url()
    urllib.request.urlretrieve(url, "schedule.xls")
    L = load("schedule.xls")
    ev = expand(L, dt.date.today(), 35)
    ov = load_overrides()
    if ov: print("Исключения:", ov)
    ev = apply_overrides(ev, ov)
    json.dump(dict(source=url, events=ev), open(out, "w"), ensure_ascii=False, indent=1)
    for e in ev: print(e["start"][:16].replace("T"," "), e["end"][11:16], "|", e["title"], e["note"])
