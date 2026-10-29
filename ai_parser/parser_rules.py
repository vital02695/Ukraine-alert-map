#!/usr/bin/env python3
"""
Разбор сообщений БЕЗ ИИ и БЕЗ ключей. Совместим с worker.py (режим --rules).

Понимает:
  - тип цели с опечатками и падежами: "кинжал", "кинджал", "рокета", "бляденроль", "герань 2/1", "реактивний", "МиГ-31К"...
  - "на X" / "над X" / "біля X" — цель;  "з X" / "із X" / "від X" — точка вылета (если цели нет — цель = X)
  - "ще один / ще одна на X" и ответ на сообщение — тип берётся из исходной цели
  - тревога / отбой: "тривога в Харкові", "відбій у Харкові", общий "відбій" для регионального канала
  - сбитые/уничтоженные цели и новости без угрозы пропускаются

Словарь населённых пунктов берётся из ../data/settlements_ua.json (тот же, что на сервере).

Запуск отдельно (тест):  python parser_rules.py "кинжал на Харьков"
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")

# ---------- типы (ключи совпадают с DRONE_TYPES на сервере; порядок важен — специфичные раньше общих) ----------
TYPE_RULES = [
    ("mig31", r"м[іиi]г[\s-]*31|mig[\s-]*31"),
    ("kinzhal", r"кинжал|кинджал|кінжал|кінджал|kinzhal|kinjal"),
    ("zircon", r"циркон|ціркон|zircon|zirkon"),
    ("oreshnik", r"орешн|орєшн|oreshnik"),
    ("onyx", r"оникс|онікс|onyx|яхонт"),
    ("kh22", r"(?<![а-яіїєґa-z])[хxk]h?[\s-]?(22|32)(?!\d)"),
    ("ballistic", r"балістик|баллистик|балистик|іскандер-?м|искандер-?м"),
    ("geran4", r"геран[ьіи]?\W{0,2}[45](?!\d)|geran\W{0,2}[45](?!\d)|реактивн|reaktiv"),
    ("geran3", r"геран[ьіи]?\W{0,2}3|geran\W{0,2}3|гербер"),
    ("bander", r"бандер|бендер|бяндер|бляден|бландер|бандеро"),
    ("shahed", r"шах[еє]д|shahed|геран|geran|мопед"),
    ("lancet", r"ланцет|lancet"),
    ("molniya", r"молни[яи]|молнія|molniya|ударн"),
    ("orlan", r"орлан|orlan"),
    ("recon", r"розвід|разведч|разведк|суперкам|supercam|zala"),
    ("fpv", r"fpv|фпв"),
    ("kab", r"(?<![а-яіїєґ])каб(и|ів|ах|ом|у)?(?![а-яіїєґ])|авіабомб|авиабомб"),
    ("missile", r"ракет|рокет|paketa|raketa|калібр|калибр|іскандер|искандер|х-?101|х-?59|х-?35|точк[аи]-?у|крилат|крылат"),
    ("uav", r"бпла|бпл(?![а-яіїєґ])|безпілот|беспилот|дрон|uav"),
]
TYPE_RE = [(k, re.compile(p, re.I)) for k, p in TYPE_RULES]
TYPE_LABEL = {k: k for k, _ in TYPE_RULES}

SKIP_RE = re.compile(r"відбій|отбой|збит|знищен|сбит|уничтожен|мінус|минус|без\s+(дрон|бпла|беспилот|безпілот)", re.I)
ALERT_RE = re.compile(r"тривог|тревог", re.I)
CLEAR_RE = re.compile(r"відбій|отбой|🟢", re.I)
CONT_RE = re.compile(r"(^|[\s,.!])(ще|ещё|еще)(\s+(один|одна|одне|одні|два|три))?(?=[\s,.!(]|$)", re.I)
PREP_TARGET = {"на", "над", "біля", "поблизу", "у", "в", "до", "курсом", "по", "через"}
PREP_ORIGIN = {"з", "із", "від", "с", "от"}
CAP_RE = re.compile(r"^[A-ZА-ЯІЇЄҐЁ]")
WORD_RE = re.compile(r"[A-Za-zА-Яа-яІіЇїЄєҐґЁё'’ʼ-]+")
STOP = {"вони", "наші", "нові", "тому", "може", "якщо", "звідки", "курсом", "тепер", "зараз", "дрони", "шахеди", "ракети", "один", "одна"}

# регион по умолчанию для регионального канала (как CHANNEL_REGION на сервере)
CHANNEL_PLACE = {"radar_kharkov": "Харків"}


def _norm(s):
    return s.lower().replace("’", "'").replace("ʼ", "'").replace("`", "'")


# ---------- словарь населённых пунктов ----------
# Приоритетные названия (ключевые города и города РФ, откуда летят): проверяются раньше словаря.
# (стем в нижнем регистре, название для карты, lat, lng)
MANUAL = [
    ("харк", "Харків", 49.9935, 36.2304), ("харьк", "Харків", 49.9935, 36.2304),
    ("київ", "Київ", 50.4501, 30.5234), ("киев", "Київ", 50.4501, 30.5234),
    ("одес", "Одеса", 46.4825, 30.7233), ("дніпр", "Дніпро", 48.4647, 35.0462), ("днепр", "Дніпро", 48.4647, 35.0462),
    ("львів", "Львів", 49.8397, 24.0297), ("львов", "Львів", 49.8397, 24.0297),
    ("запоріж", "Запоріжжя", 47.8388, 35.1396), ("запорож", "Запоріжжя", 47.8388, 35.1396),
    ("суми", "Суми", 50.9077, 34.7981), ("сумах", "Суми", 50.9077, 34.7981), ("сумы", "Суми", 50.9077, 34.7981),
    ("полтав", "Полтава", 49.5883, 34.5514), ("чернігів", "Чернігів", 51.4982, 31.2893),
    ("миколаї", "Миколаїв", 46.975, 31.9946), ("николаев", "Миколаїв", 46.975, 31.9946),
    ("курськ", "Курськ", 51.7304, 36.1926), ("курск", "Курськ", 51.7304, 36.1926),
    ("бєлгород", "Бєлгород", 50.5997, 36.5983), ("белгород", "Бєлгород", 50.5997, 36.5983),
    ("воронеж", "Воронеж", 51.6605, 39.2003), ("брянськ", "Брянськ", 53.2434, 34.364), ("брянск", "Брянськ", 53.2434, 34.364),
]

_INDEX = None


def _load_index():
    global _INDEX
    if _INDEX is not None:
        return _INDEX
    _INDEX = {}
    for fname in ("settlements_ua.json", "extra_places.json"):
        path = os.path.join(DATA, fname)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            for names, lat, lng, pop in json.load(f):
                for n in names:
                    n = _norm(n)
                    _INDEX.setdefault(n[:6] if len(n) >= 6 else n, []).append((n, lat, lng, pop))
    return _INDEX


def _lookup(word):
    """Ищет населённый пункт по слову (с падежами). Возвращает (название, lat, lng, pop) или None."""
    w = _norm(word)
    if len(w) < 4 or STOP.__contains__(w):
        return None
    for stem, name, lat, lng in MANUAL:
        if w.startswith(stem):
            return name, lat, lng, 10**7
    idx = _load_index()
    best = None
    for n, lat, lng, pop in idx.get(w[:6] if len(w) >= 6 else w, []):
        ok = n == w or (len(w) >= 6 and len(n) >= 6 and abs(len(w) - len(n)) <= 3)
        if not ok:
            continue
        score = pop + (1e9 if 48.6 < lat < 50.5 and 34.8 < lng < 38.2 else 0)  # приоритет Харьковщине
        if best is None or score > best[0]:
            best = (score, n, lat, lng, pop)
    if not best:
        return None
    return best[1][:1].upper() + best[1][1:], best[2], best[3], best[4]


def find_places(text):
    """[(роль 'target'|'origin', название)] по порядку в тексте."""
    out = []
    words = [(m.group(0), m.start()) for m in WORD_RE.finditer(text)]
    for i, (w, _) in enumerate(words):
        prev = _norm(words[i - 1][0]) if i else ""
        if not (CAP_RE.match(w) or prev in PREP_TARGET or prev in PREP_ORIGIN):
            continue
        hit = _lookup(w)
        if not hit:
            continue
        role = "origin" if prev in PREP_ORIGIN else "target"
        out.append((role, hit[0]))
    return out


def detect_type(text):
    for key, rx in TYPE_RE:
        if rx.search(text):
            return key
    return None


def _alert_places(text, channel):
    """Места тревоги: названия городов из текста + регион канала по умолчанию."""
    places = [name for _, name in find_places(text)]
    if not places:
        t = _norm(text)
        if "харк" in t or "харьк" in t:
            places = ["Харків"]
    if not places and channel in CHANNEL_PLACE:
        places = [CHANNEL_PLACE[channel]]
    return places


def parse_message(ctx):
    """ctx — то же, что worker.py шлёт ИИ. Возвращает {"events": [...]}."""
    text = ctx.get("message", "") or ""
    channel = ctx.get("channel", "")
    events = []

    # тревога / отбой
    if ALERT_RE.search(text) or (CLEAR_RE.search(text) and channel in CHANNEL_PLACE):
        action = "clear" if CLEAR_RE.search(text) else "set"
        for line in [l for l in text.split("\n") if l.strip()] or [text]:
            places = _alert_places(line, channel)
            if places or action == "clear":
                events.append({"kind": "alert", "action": action, "places": places})
        if events:
            return {"events": events}

    if SKIP_RE.search(text):
        return {"events": []}

    lines = [l.strip() for l in text.split("\n") if l.strip()] or [text]
    # тип: из текста, из ответа, из предыдущих событий на этом месте
    reply_type = None
    if ctx.get("reply_to_text"):
        reply_type = detect_type(ctx["reply_to_text"])
    if not reply_type and ctx.get("reply_to_events"):
        for ev in ctx["reply_to_events"]:
            if ev.get("kind") == "threat":
                reply_type = ev.get("type")
                break

    cont = bool(CONT_RE.search(text))
    reply_places = find_places(ctx.get("reply_to_text") or "")
    if not reply_places and ctx.get("reply_to_events"):
        reply_places = [("target", ev["target"]) for ev in ctx["reply_to_events"] if ev.get("kind") == "threat" and ev.get("target")][:1]
    for line in lines:
        ltype = detect_type(line)
        places = find_places(line)
        if not ltype:
            # "ще один ..." или ответ без названия типа — тип берём у исходной цели
            if not (cont or ctx.get("reply_to_text") or ctx.get("reply_to_events")):
                continue
            ltype = reply_type or _prev_type(ctx, places)
        if not ltype:
            continue
        if not places:
            places = reply_places          # место не названо — берём из сообщения, на которое ответили
        if not places:
            continue
        targets = [n for r, n in places if r == "target"]
        origins = [n for r, n in places if r == "origin"]
        target = targets[-1] if targets else (origins[0] if origins else None)
        origin = origins[0] if (origins and targets) else None
        if not target:
            continue
        events.append({"kind": "threat", "type": ltype, "target": target, "origin": origin, "heading": None})
    return {"events": events}


def _prev_type(ctx, places):
    """Тип последней цели в том же месте: из активных целей или из предыдущих сообщений канала."""
    names = {n for _, n in places}
    for a in reversed(ctx.get("active_threats") or []):
        if not names or a.get("target") in names:
            return a.get("type")
    for h in reversed(ctx.get("previous_messages_in_channel") or []):
        for ev in reversed(h.get("events") or []):
            if ev.get("kind") == "threat" and (not names or ev.get("target") in names):
                return ev.get("type")
    return None


def rules_llm(system, user):
    """Совместимо с worker.py: та же сигнатура, что у ИИ. Возвращает JSON-строку."""
    try:
        ctx = json.loads(user)
    except ValueError:
        return json.dumps({"events": []})
    return json.dumps(parse_message(ctx), ensure_ascii=False)


if __name__ == "__main__":
    text = " ".join(sys.argv[1:]) or "кинжал на Харьков"
    print(json.dumps(parse_message({"channel": "radar_kharkov", "message": text}), ensure_ascii=False, indent=2))
