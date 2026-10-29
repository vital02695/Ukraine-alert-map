"""Тест логики воркера без OpenAI и без сети: python test_worker.py"""
import json, time
import worker

TYPES = {"uav", "shahed", "kinzhal", "missile", "lancet"}

# --- normalize_events: мусор из ИИ не должен ломать воркер ---
assert worker.normalize_events("не json", TYPES) == []
assert worker.normalize_events({"events": "x"}, TYPES) == []
assert worker.normalize_events({"events": [1, None, {"kind": "threat"}, {"kind": "threat", "target": "  "}]}, TYPES) == []
ev = worker.normalize_events({"events": [
    {"kind": "threat", "type": "kinzhal", "target": "Харків", "origin": "null", "heading_deg": 450},
    {"kind": "threat", "type": "якийсь_новий", "target": "Суми", "origin": "Курськ"},
    {"kind": "alert", "action": "set", "places": ["Харків", "", 5]},
    {"kind": "alert", "action": "перемога"},
]}, TYPES)
assert ev[0] == {"kind": "threat", "type": "kinzhal", "target": "Харків", "origin": None, "heading": 90.0}, ev[0]
assert ev[1]["type"] == "uav" and ev[1]["origin"] == "Курськ", ev[1]
assert ev[2] == {"kind": "alert", "action": "set", "places": ["Харків"]}, ev[2]
assert len(ev) == 3
print("normalize_events OK")

# --- заглушка ИИ: «понимает» несколько фраз и запоминает, что ему передали ---
seen_prompts = []
def fake_llm(system, user):
    seen_prompts.append((system, json.loads(user)))
    t = json.loads(user)["message"].lower()
    if "кинжал" in t:
        return json.dumps({"events": [{"kind": "threat", "type": "kinzhal", "target": "Харків", "origin": None, "heading_deg": None}]})
    if "ще один" in t:
        return json.dumps({"events": [{"kind": "threat", "type": "shahed", "target": "Люботин", "origin": None, "heading_deg": None}]})
    if "тривога" in t:
        return json.dumps({"events": [{"kind": "alert", "action": "set", "places": ["Харків"]}]})
    return json.dumps({"events": []})

class Resp:
    def __init__(self, data, code=200): self.data, self.status_code = data, code
    def json(self): return self.data
    def raise_for_status(self):
        if self.status_code >= 400: raise RuntimeError(self.status_code)

now = int(time.time() * 1000)
MSGS = [
    {"id": "radar_kharkov/1", "channel": "radar_kharkov", "text": "Шахед на Люботин", "ts": now - 9000, "link": "l1"},
    {"id": "radar_kharkov/2", "channel": "radar_kharkov", "text": "кинжал на Харьков", "ts": now - 8000, "link": "l2"},
    {"id": "radar_kharkov/3", "channel": "radar_kharkov", "text": "Ще один", "ts": now - 7000, "link": "l3",
     "replyTo": "radar_kharkov/1", "replyText": "Шахед на Люботин"},
    {"id": "radar_kharkov/4", "channel": "radar_kharkov", "text": "Тривога в Харкові", "ts": now - 6000, "link": "l4"},
    {"id": "radar_kharkov/5", "channel": "radar_kharkov", "text": "новина без загроз", "ts": now - 5000, "link": "l5"},
    {"id": "radar_kharkov/6", "channel": "radar_kharkov", "text": "вже розібрано ШІ", "ts": now - 4000, "link": "l6", "ai": True},
]
posted = []
class FakeHttp:
    def get(self, url, **kw):
        if url.endswith("/api/messages"):
            return Resp({"types": [{"key": k, "label": k} for k in TYPES], "messages": MSGS})
        return Resp({"drones": [{"type": "shahed", "places": ["Люботин"], "text": "Шахед на Люботин"}]})
    def post(self, url, json=None, headers=None, **kw):
        posted.append((url, json, headers)); return Resp({"ok": True})

w = worker.Worker("http://srv/", "SECRET", fake_llm, http=FakeHttp())
n = w.cycle()
assert n == 5, n                                    # 6-е уже с ai=True — пропущено
url, body, headers = posted[0]
assert url == "http://srv/api/ingest" and headers == {"x-token": "SECRET"}
assert [m["id"] for m in body["messages"]] == [f"radar_kharkov/{i}" for i in range(1, 6)]
assert body["messages"][1]["events"][0]["type"] == "kinzhal"
assert body["messages"][3]["events"][0]["kind"] == "alert"
assert body["messages"][4]["events"] == []
# контекст дошёл до ИИ: ответ + активные цели + предыдущие сообщения канала
_, ctx3 = seen_prompts[2]
assert ctx3["reply_to_text"] == "Шахед на Люботин" and ctx3["active_threats"][0]["target"] == "Люботин"
assert len(ctx3["previous_messages_in_channel"]) == 2
assert "kinzhal" in seen_prompts[0][0]              # типы подставлены в системный промпт
# повторный цикл не шлёт то же самое
assert w.cycle() == 0 and len(posted) == 1
print("cycle / context / ingest payload OK")

# --- сбой ИИ: сообщение не теряется, пробуем MAX_ATTEMPTS раз ---
calls = {"n": 0}
def flaky(system, user):
    calls["n"] += 1; raise TimeoutError("openai timeout")
w2 = worker.Worker("http://srv", "S", flaky, http=FakeHttp())
for _ in range(5): w2.cycle()
assert calls["n"] == 5 * worker.MAX_ATTEMPTS, calls["n"]   # 5 сообщений x 3 попытки, дальше пропускаются
print("сбои ИИ не роняют воркер, попыток на сообщение:", worker.MAX_ATTEMPTS)
json.dump(body, open("/tmp/claude-0/-home-claude/8c346246-d55c-5b67-8a97-1b6196cb5698/scratchpad/ingest_payload.json", "w"), ensure_ascii=False)
print("ВСЕ ТЕСТЫ ПРОШЛИ")
