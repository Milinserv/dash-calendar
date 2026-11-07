"""Если проверка пар нашла изменения — кладёт их в таблицу meta, приложение покажет баннер."""
import os, sys, json, datetime as dt, requests
text = open(sys.argv[1], encoding="utf-8").read()
if "ИЗМЕНЕНИЯ ЕСТЬ" not in text:
    sys.exit(0)
lines = [l.strip() for l in text.splitlines() if l.strip().startswith(("+ НОВОЕ", "− УБРАНО"))]
url = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/meta?on_conflict=key"
key = os.environ["SUPABASE_SERVICE_KEY"]
r = requests.post(url, timeout=60, headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                  "Prefer": "resolution=merge-duplicates,return=minimal"},
                  json=[{"key": "schedule_changes", "value": {"at": dt.datetime.now().isoformat(timespec="minutes"), "lines": lines[:20]},
                         "updated_at": dt.datetime.now(dt.timezone.utc).isoformat()}])
r.raise_for_status()
print("Изменения записаны:", len(lines))
