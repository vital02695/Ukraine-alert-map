#!/usr/bin/env python3
"""
ИИ-парсер сообщений Telegram для карты загроз.

Что делает:
  1. Каждые несколько секунд забирает свежие сообщения у основного сервера (GET /api/messages).
  2. Отправляет каждое сообщение в ChatGPT (библиотека openai) вместе с контекстом:
     последние сообщения канала, текст сообщения, на которое ответили, активные цели на карте.
     ИИ понимает опечатки ("кинжал на Харьков"), "ще один на Харків", ответы, тревогу/відбій.
  3. Присылает результат на сервер (POST /api/ingest) — карта показывает то, что понял ИИ.
     Правила на сервере остаются запасным вариантом: если этот воркер выключен, всё работает как раньше.

Переменные окружения:
  SERVER_URL      адрес основного сервера, например https://my-map.onrender.com   (обязательно)
  INGEST_TOKEN    тот же секрет, что и на сервере                                  (обязательно)
  OPENAI_API_KEY  ключ OpenAI                                                       (обязательно)
  OPENAI_MODEL    модель, по умолчанию gpt-4o-mini (дёшево и достаточно)
  POLL_SECONDS    как часто спрашивать сервер, по умолчанию 5
  PORT            если задан — поднимается /health (нужно для Render Web Service)

Быстрая проверка без сервера (нужен только OPENAI_API_KEY):
  python worker.py --test "кинжал на Харьков"
"""
import argparse
import collections
import json
import re
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests

sys_path_fix = os.path.dirname(os.path.abspath(__file__))
if sys_path_fix not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path_fix)

log = logging.getLogger("ai-parser")

MAX_AGE_MS = 15 * 60 * 1000      # сообщения старше 15 минут не разбираем
MAX_ATTEMPTS = 3                 # сколько раз пробовать сообщение при сбоях ИИ

SYSTEM_PROMPT = """Ты разбираешь сообщения из украинских Telegram-каналов о воздушной обстановке (радар Харькова и др.) для карты.
Сообщения короткие, на украинском или русском, с опечатками и сленгом. Верни ТОЛЬКО JSON вида:
{"events": [ ... ]}

Событие угрозы:
  {"kind":"threat","type":"<ключ типа>","target":"<куда летит>","origin":"<откуда или null>","heading_deg":<число 0-360 или null>}
Событие тревоги:
  {"kind":"alert","action":"set"|"clear","places":["<город или область>", ...]}

Ключи типов (используй только их):
{TYPES}

Правила:
- Названия мест пиши по-украински в именительном падеже: "на Песочин"/"над Песочином" -> "Песочин", "в Харькове" -> "Харків", "Харьков" -> "Харків".
  Если названа только область — пиши её полностью ("Харківська область").
- target — куда летит. origin — только если явно сказано откуда ("з Курська", "из Белгорода"), иначе null.
  heading_deg — только если указан компасный курс ("з півночі" значит летит на юг = 180; "курсом на захід" = 270), иначе null.
- Исправляй опечатки и варианты написания: "кинжал/кинджал/кінжал" = kinzhal, "рокета/ракета" без названия = missile,
  "бляденроль/бандероль" = bander, "шахед/шахеди/герань 2/мопед" = shahed, "герань 3" = geran3, "герань 4/5" или "реактивний" = geran4,
  "фпв" = fpv, "каб" = kab, "бпла/дрон" без уточнения = uav, "ударний"/"молния" = molniya, "розвідник/разведчик" = recon.
- "ще один/ещё один/ще одна/ще два на <место>" — ещё одна цель ТОГО ЖЕ типа, что и предыдущая в этом месте/канале/в сообщении,
  на которое ответили (поле reply_to_text / reply_to_events) или среди active_threats. Создай threat с тем же type.
- Если сообщение — ответ (reply_to_*), тип и место бери из исходного сообщения, когда в ответе их нет.
- Одно сообщение может содержать несколько целей (несколько строк/мест) — верни несколько событий.
- "тривога в <городе/области>" -> alert set; "відбій"/"отбой" -> alert clear. Город считай тревогой для своей области — просто пиши название города в places.
  Если место не названо, а канал региональный — places: [] (сервер подставит область канала).
- НЕ создавай события для: сбитых/уничтоженных целей ("збито", "знищено"), новостей о последствиях, обсуждений, рекламы, сообщений без угрозы.
  В таком случае верни {"events": []}.
- Если тип неясен, но это явно летящая цель — type "uav" (дрон) или "missile" (ракета).
- Ничего не придумывай: если места нет и взять его неоткуда — не создавай threat.
"""


# ---------- работа с ИИ ----------
def make_openai_llm(api_key, model):
    """Возвращает функцию llm(system, user) -> str (JSON). Импорт библиотеки ленивый, чтобы тесты шли без неё."""
    from openai import OpenAI  # pip install openai

    client = OpenAI(api_key=api_key)

    def call(system, user):
        resp = client.chat.completions.create(
            model=model,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            timeout=30,
        )
        return resp.choices[0].message.content

    return call


def normalize_events(raw, valid_types):
    """Проверяет ответ ИИ и приводит к безопасному виду. Мусор отбрасывается."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return []
    events = raw.get("events") if isinstance(raw, dict) else None
    if not isinstance(events, list):
        return []
    out = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        kind = ev.get("kind")
        if kind == "threat":
            target = ev.get("target")
            if not isinstance(target, str) or not target.strip():
                continue
            t = ev.get("type")
            if t not in valid_types:
                t = "uav"
            origin = ev.get("origin")
            origin = origin.strip() if isinstance(origin, str) and origin.strip().lower() not in ("", "null", "none") else None
            h = ev.get("heading_deg")
            h = float(h) % 360 if isinstance(h, (int, float)) and not isinstance(h, bool) else None
            out.append({"kind": "threat", "type": t, "target": target.strip(), "origin": origin, "heading": h})
        elif kind == "alert":
            action = ev.get("action")
            if action not in ("set", "clear"):
                continue
            places = ev.get("places")
            places = [p.strip() for p in places if isinstance(p, str) and p.strip()] if isinstance(places, list) else []
            out.append({"kind": "alert", "action": action, "places": places})
    return out



# ---------- Google Gemini (бесплатный ключ из Google AI Studio) ----------
def make_gemini_llm(api_key, model="gemini-2.5-flash"):
    """Запросы к Gemini по HTTP (без отдельной библиотеки). Ключ передаётся в заголовке, не в адресе.
    При ошибке сети/ключа/ответа — используем правила (parser_rules), чтобы карта не останавливалась."""
    from parser_rules import rules_llm
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    def call(system, user):
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
        }
        try:
            r = requests.post(url, json=body, headers={"x-goog-api-key": api_key}, timeout=30)
            if r.status_code != 200:
                raise RuntimeError(f"Gemini HTTP {r.status_code}: {r.text[:200]}")
            text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
            json.loads(text)                      # проверяем, что это JSON
            return text
        except Exception as e:
            log.warning("Gemini не ответил (%s), используем правила", e)
            return rules_llm(system, user)

    return call


# ---------- локальная бесплатная модель (без ключа и без интернета после скачивания) ----------
def make_local_llm(model_id="Qwen/Qwen2.5-1.5B-Instruct"):
    """Qwen2.5 через transformers. Нужно ~3-4 ГБ RAM; на бесплатном Render не запустится.
    Если модель не загрузилась или ответила не JSON — используем правила (parser_rules)."""
    from transformers import AutoTokenizer, AutoModelForCausalLM  # pip install transformers torch
    from parser_rules import rules_llm

    tok = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype="auto")

    def call(system, user):
        msgs = [{"role": "system", "content": system},
                {"role": "user", "content": user + "\n\nОтветь только JSON."}]
        text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        ids = tok(text, return_tensors="pt")
        out = model.generate(**ids, max_new_tokens=300, do_sample=False)
        reply = tok.decode(out[0][ids.input_ids.shape[1]:], skip_special_tokens=True)
        m = re.search(r"\{.*\}", reply, re.S)
        if m:
            try:
                json.loads(m.group(0))
                return m.group(0)
            except ValueError:
                pass
        log.warning("локальная модель вернула не JSON, используем правила")
        return rules_llm(system, user)

    return call

# ---------- воркер ----------
class Worker:
    def __init__(self, server_url, token, llm, http=requests, dry_run=False):
        self.server = server_url.rstrip("/")
        self.token = token
        self.llm = llm
        self.http = http
        self.dry_run = dry_run
        self.valid_types = {"uav"}
        self.type_labels = {}
        self.done = set()                                   # id уже разобранных сообщений
        self.attempts = collections.Counter()
        self.events_by_id = collections.OrderedDict()       # id -> события (для ответов)
        self.history = collections.defaultdict(lambda: collections.deque(maxlen=8))  # канал -> последние сообщения

    # --- общение с сервером ---
    def fetch_messages(self):
        since = int(time.time() * 1000) - MAX_AGE_MS
        r = self.http.get(f"{self.server}/api/messages", params={"since": since}, timeout=15)
        r.raise_for_status()
        j = r.json()
        for t in j.get("types", []):
            self.valid_types.add(t["key"])
            self.type_labels[t["key"]] = t["label"]
        return j.get("messages", [])

    def fetch_active(self):
        try:
            r = self.http.get(f"{self.server}/api/state", timeout=15)
            r.raise_for_status()
            drones = r.json().get("drones", [])
        except Exception:  # контекст необязателен
            return []
        return [{"type": d["type"], "target": (d.get("places") or [""])[-1], "text": d.get("text", "")[:120]} for d in drones[:12]]

    def send(self, batch):
        if not batch:
            return
        if self.dry_run:
            print(json.dumps(batch, ensure_ascii=False, indent=2))
            return
        r = self.http.post(f"{self.server}/api/ingest", json={"messages": batch}, headers={"x-token": self.token}, timeout=15)
        if r.status_code == 401:
            raise RuntimeError("Сервер отклонил токен: проверьте INGEST_TOKEN")
        if r.status_code == 503:
            raise RuntimeError("На сервере не задан INGEST_TOKEN")
        r.raise_for_status()

    # --- разбор одного сообщения ---
    def build_prompt(self, msg, active):
        types = "\n".join(f"- {k}: {self.type_labels.get(k, k)}" for k in sorted(self.valid_types))
        system = SYSTEM_PROMPT.replace("{TYPES}", types)
        ctx = {
            "channel": msg.get("channel"),
            "message": msg.get("text", ""),
            "reply_to_text": msg.get("replyText") or None,
            "reply_to_events": self.events_by_id.get(msg.get("replyTo")) if msg.get("replyTo") else None,
            "previous_messages_in_channel": [
                {"text": h["text"], "events": h["events"]} for h in list(self.history[msg.get("channel")])[-6:]
            ],
            "active_threats": active,
        }
        return system, json.dumps(ctx, ensure_ascii=False)

    def analyze(self, msg, active=None):
        system, user = self.build_prompt(msg, active or [])
        events = normalize_events(self.llm(system, user), self.valid_types)
        self.events_by_id[msg["id"]] = events
        while len(self.events_by_id) > 500:
            self.events_by_id.popitem(last=False)
        self.history[msg.get("channel")].append({"text": msg.get("text", "")[:300], "events": events})
        return events

    # --- один цикл ---
    def cycle(self):
        msgs = [m for m in self.fetch_messages() if m["id"] not in self.done and not m.get("ai")]
        msgs.sort(key=lambda m: m["ts"])
        if not msgs:
            return 0
        active = self.fetch_active()
        batch = []
        for m in msgs:
            if self.attempts[m["id"]] >= MAX_ATTEMPTS:
                self.done.add(m["id"])
                continue
            try:
                events = self.analyze(m, active)
            except Exception as e:  # сбой ИИ/сети — попробуем в следующем цикле
                self.attempts[m["id"]] += 1
                log.warning("не удалось разобрать %s: %s", m["id"], e)
                continue
            self.done.add(m["id"])
            batch.append({"id": m["id"], "channel": m.get("channel"), "ts": m["ts"], "link": m.get("link"),
                          "text": m.get("text", ""), "events": events})
            log.info("%s: %s -> %s", m["id"], m.get("text", "")[:60].replace("\n", " "), json.dumps(events, ensure_ascii=False))
        self.send(batch)
        if len(self.done) > 5000:
            self.done = set(list(self.done)[-2000:])
        return len(batch)

    def run(self, poll_seconds=5):
        log.info("ИИ-парсер запущен, сервер: %s", self.server)
        while True:
            try:
                self.cycle()
            except Exception as e:
                log.error("цикл не удался: %s", e)
            time.sleep(poll_seconds)


# ---------- health (для Render Web Service) ----------
def start_health_server(port):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *a):
            pass

    threading.Thread(target=HTTPServer(("0.0.0.0", port), H).serve_forever, daemon=True).start()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--test", metavar="ТЕКСТ", help="разобрать одно сообщение и вывести результат (без сервера)")
    ap.add_argument("--dry-run", action="store_true", help="не отправлять на сервер, только печатать")
    ap.add_argument("--gemini", action="store_true", help="Google Gemini по бесплатному ключу (GEMINI_API_KEY), при сбое — правила")
    ap.add_argument("--local", action="store_true", help="локальная бесплатная модель Qwen (нужно ~4 ГБ RAM), при сбое — правила")
    ap.add_argument("--rules", action="store_true", help="разбирать правилами (parser_rules.py), без ИИ и без ключа")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.gemini:
        gkey = os.environ.get("GEMINI_API_KEY")
        if not gkey:
            raise SystemExit("Задайте GEMINI_API_KEY")
        llm = make_gemini_llm(gkey, os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"))
    elif args.local:
        llm = make_local_llm(os.environ.get("LOCAL_MODEL", "Qwen/Qwen2.5-1.5B-Instruct"))
    elif args.rules:
        from parser_rules import rules_llm
        llm = rules_llm
    else:
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            raise SystemExit("Задайте OPENAI_API_KEY (или запускайте с --rules)")
        llm = make_openai_llm(key, os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))

    if args.test:
        w = Worker("http://unused", "", llm)
        w.valid_types = {"uav", "shahed", "geran3", "geran4", "lancet", "molniya", "orlan", "recon", "fpv", "kab", "bander",
                         "missile", "ballistic", "kinzhal", "zircon", "oreshnik", "onyx", "kh22", "mig31"}
        msg = {"id": "test/1", "channel": "radar_kharkov", "text": args.test, "ts": int(time.time() * 1000)}
        print(json.dumps(w.analyze(msg), ensure_ascii=False, indent=2))
        return

    server, token = os.environ.get("SERVER_URL"), os.environ.get("INGEST_TOKEN")
    if not server or not token:
        raise SystemExit("Задайте SERVER_URL и INGEST_TOKEN")
    if os.environ.get("PORT"):
        start_health_server(int(os.environ["PORT"]))
    Worker(server, token, llm, dry_run=args.dry_run).run(float(os.environ.get("POLL_SECONDS", "5")))


if __name__ == "__main__":
    main()
