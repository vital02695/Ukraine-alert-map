// Сервер: читает публичные страницы Telegram-каналов (t.me/s/<канал>),
// вытаскивает дроны/ракеты (тип, откуда, куда) и тревоги по областям.
// Отдаёт JSON для карты (public/index.html).

const express = require('express');
const cheerio = require('cheerio');
const path = require('path');
const { REGIONS, CITIES } = require('./cities');
const fs = require('fs');

// ---------- словарь всех населённых пунктов Украины (GeoNames, data/settlements_ua.json) ----------
// Индекс: первые 6 символов названия -> записи. Так находятся и падежные формы (Песочин / Песочині).
const SETTL = new Map();
const SETTL_STOP = new Set(['вони', 'наші', 'нові', 'тому', 'може', 'якщо', 'звідки', 'курсом', 'тепер', 'зараз', 'дрони', 'шахеди', 'ракети']);
const PREPS = /^(на|над|біля|під|у|в|поблизу|із|з|від|до|курсом|по|через)$/;
// приблизительные координаты пунктов без точных (центр громады), data/extra_places.json — необязательный файл
const SETTL_FILES = ['settlements_ua.json', 'extra_places.json'];
for (const file of SETTL_FILES) try {
  for (const [names, lat, lng, pop] of JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf8'))) {
    for (const n of names) {
      const k = n.length >= 6 ? n.slice(0, 6) : n;
      if (!SETTL.has(k)) SETTL.set(k, []);
      SETTL.get(k).push({ n, lat, lng, pop });
    }
  }
} catch (e) { if (file === 'settlements_ua.json') console.error('settlements_ua.json не загружен:', e.message); }

function settlementIn(text) {
  const words = [];
  const re = /[A-Za-zА-Яа-яІіЇїЄєҐґЁё'’ʼ-]+/g;
  let m;
  while ((m = re.exec(text))) words.push({ w: m[0], cap: /^[A-ZА-ЯІЇЄҐЁ]/.test(m[0]) });
  let best = null;
  for (let i = 0; i < words.length; i++) {
    const raw = words[i].w.replace(/[’ʼ`]/g, "'");
    const w = raw.toLowerCase();
    if (w.length < 4 || !/[а-яіїєґё]/.test(w) || SETTL_STOP.has(w)) continue;
    // берём слово, если оно с заглавной (имя собственное) или после предлога
    const prev = i > 0 ? words[i - 1].w.toLowerCase() : '';
    if (!(words[i].cap || PREPS.test(prev))) continue;
    const k = w.length >= 6 ? w.slice(0, 6) : w;
    for (const e of SETTL.get(k) || []) {
      const ok = e.n === w || (w.length >= 6 && e.n.length >= 6 && Math.abs(w.length - e.n.length) <= 3);
      // при одинаковых названиях — приоритет Харьковской области, затем самый крупный пункт
      const score = e.pop + (e.lat > 48.6 && e.lat < 50.5 && e.lng > 34.8 && e.lng < 38.2 ? 1e9 : 0);
      if (ok && (!best || score > best.score)) best = { ...e, score, name: e.n.charAt(0).toUpperCase() + e.n.slice(1) };
    }
  }
  return best;
}

// ---------- настройки ----------
const CHANNELS = (process.env.CHANNELS || 'radar_kharkov,tlknewsua,air_alert_ua,kanalalertmap')
  .split(',').map(s => s.trim()).filter(Boolean);
const POLL_MS = +process.env.POLL_MS || 8000;   // опрос каналов каждые 8 с (лёгкий: 4 страницы)
const TTL_MS = 10 * 60 * 1000;           // дрон "живёт" 10 минут
const ALERT_TTL_MS = TTL_MS;             // тревога гаснет автоматически через 10 минут без нового сообщения
const ALERTS_TOKEN = process.env.ALERTS_IN_UA_TOKEN || ''; // необязательно (alerts.in.ua)
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';       // секрет для Python-парсера (/api/ingest)
const CHANNEL_REGION = { radar_kharkov: 'kharkiv' };       // канал -> область по умолчанию для "відбій"/"тривога" без места

// ---------- регионы / города ----------
const REGION_BY_ID = Object.fromEntries(REGIONS.map(r => [r.id, r]));
const LB = '(?<![а-яіїєґёa-z])';
const CITY_RES = CITIES.map(c => ({ ...c, re: new RegExp(LB + '(?:' + c.r + ')', 'i') }));

function regionsIn(text) {
  const found = [];
  let rest = text;
  for (const r of REGIONS) {
    if (new RegExp(r.re, 'i').test(rest)) {
      found.push(r.id);
      if (!r.city) rest = rest.replace(new RegExp(r.re, 'gi'), ' ');
    }
  }
  return { found, rest };
}

function citiesIn(text) {
  const hits = [];
  for (const c of CITY_RES) {
    const m = c.re.exec(text);
    if (m) hits.push({ c, idx: m.index });
  }
  hits.sort((a, b) => a.idx - b.idx);
  return hits;
}

// ---------- типы дронов ----------
const L = '(?<![а-яіїєґё])', R = '(?![а-яіїєґё])';
const DRONE_TYPES = [
  { key: 'mig31', label: 'МіГ-31К (носій Кинджал)', re: /м[іиi]г[\s-]*31|mig[\s-]*31/i },
  // каждая ракета — отдельный тип со своей иконкой (специфичные раньше общих)
  { key: 'kinzhal', label: 'Кинджал', re: /кинжал|кинджал|кінжал|кінджал|кимжал|kinzhal|kinjal/i },
  { key: 'zircon', label: 'Циркон', re: /циркон|ціркон|zircon|zirkon/i },
  { key: 'oreshnik', label: 'Орешник', re: /орешн|орєшн|oreshnik|oreshnyk/i },
  { key: 'onyx', label: 'Онікс', re: /оникс|онікс|onyx|яхонт/i },
  { key: 'kh22', label: 'Х-22 / Х-32', re: /(?<![а-яіїєґa-z])[хxk]h?[\s-]?(22|32)(?!\d)/i },
  { key: 'ballistic', label: 'Балістика', re: /балістик|баллистик|балистик|іскандер-?м|искандер-?м/i },
  { key: 'geran4', label: 'Герань-4 / 5 (реактивний)', re: /геран[ьіи]?\W{0,2}[45](?!\d)|geran\W{0,2}[45](?!\d)|реактивн|reaktiv/i },
  { key: 'geran3', label: 'Герань-3', re: /геран[ьіи]?\W{0,2}3|geran\W{0,2}3|гербер/i },
  { key: 'bander', label: 'Бандероль', re: /бандер|бендер|бяндер|бляден|бландер|бандеро/i },
  { key: 'shahed', label: 'Шахед / Герань-2', re: /шах[еє]д|shahed|геран|geran|мопед/i },
  { key: 'lancet', label: 'Ланцет', re: /ланцет|lancet/i },
  { key: 'molniya', label: 'Молния (ударний)', re: /молни[яи]|молнія|molniya|ударн/i },
  { key: 'orlan', label: 'Орлан-10', re: /орлан|orlan/i },
  { key: 'recon', label: 'Розвідник (Zala / Supercam)', re: new RegExp('розвід|разведч|разведк|суперкам|supercam|zala|' + L + 'зала\\s?(\\d{3}|бпла|літак)', 'i') },
  { key: 'fpv', label: 'FPV-дрон', re: /fpv|фпв/i },
  { key: 'kab', label: 'КАБ (авіабомба)', re: new RegExp(L + 'каб(и|ів|ах|ом|у)?' + R + '|авіабомб|авиабомб', 'i') },
  { key: 'missile', label: 'Ракета (тип невідомий)', re: /ракет|рокет|paketa|raketa|калібр|калибр|іскандер|искандер|х-?101|х-?59|х-?35|точк[аи]-?у|крилат|крылат/i },
  { key: 'uav', label: 'БПЛА (дрон)', re: new RegExp('бпла|бпл' + R + '|безпілот|беспилот|дрон|' + L + 'uav', 'i') },
];

function detectType(text) {
  for (const t of DRONE_TYPES) if (t.re.test(text)) return t;
  return null;
}

// ---------- геометрия ----------
function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) -
    Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
// Приблизительные точки границы с РФ (с севера на юг, ±15 км) + точки запуска с моря/Крыма.
// Если в сообщении не сказано, откуда летит, цель "вылетает" из ближайшей из них.
const FLIGHT_MS = +process.env.FLIGHT_MS || 60000; // сколько дрон "летит" до цели
const BORDER = [
  [52.12, 33.50], [51.90, 33.75], [51.70, 34.15], [51.50, 34.50], [51.30, 34.95],
  [51.00, 35.30], [50.80, 35.60], [50.60, 35.95], [50.45, 36.20], [50.38, 36.55],
  [50.30, 36.95], [50.20, 37.35], [50.00, 37.85], [49.80, 38.05], [49.60, 38.25],
  [49.40, 38.15], [49.20, 38.20], [49.00, 38.40], [48.85, 39.00], [48.60, 39.55],
  [48.35, 39.80], [48.00, 39.95], [47.70, 39.80], [47.40, 38.85], [47.15, 38.30],
  // море / Крым — для целей на юге
  [46.40, 36.60], [45.70, 34.40], [45.40, 31.00], [45.80, 29.60],
];
const KM = 111.32;
function distKm(aLat, aLng, bLat, bLng) {
  const dy = (aLat - bLat) * KM, dx = (aLng - bLng) * KM * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
}
function nearestBorder(p) {
  let best = BORDER[0], bd = Infinity;
  for (const b of BORDER) { const d = distKm(p.lat, p.lng, b[0], b[1]); if (d < bd) { bd = d; best = b; } }
  return { lat: best[0], lng: best[1], name: 'кордон / точка запуску' };
}
function offsetPoint(lat, lng, brg, km) {
  const r = Math.PI / 180;
  return { lat: lat + (km * Math.cos(brg * r)) / KM, lng: lng + (km * Math.sin(brg * r)) / (KM * Math.cos(lat * r)), name: 'за курсом' };
}
const DIR = { півн: 0, север: 0, схо: 90, вост: 90, півд: 180, юг: 180, зах: 270, запад: 270 };
function dirDeg(stem) {
  stem = stem.toLowerCase();
  for (const k of Object.keys(DIR)) if (stem.startsWith(k)) return DIR[k];
  return null;
}
function compassHeading(text) {
  let m = /(?:^|[\s,.(])(?:з|із|від|от|с)\s+(півн|півд|схо|зах|север|юг|вост|запад)/i.exec(text);
  if (m) { const d = dirDeg(m[1]); if (d !== null) return (d + 180) % 360; } // "з півночі" -> летит на південь
  m = /(?:на|в бік|у бік|в сторону|курсом на)\s+(півн|півд|схід|зах|север|юг|восток|запад)/i.exec(text);
  if (m) { const d = dirDeg(m[1]); if (d !== null) return d; }
  return null;
}

// ---------- разбор сообщений ----------
const SKIP_LINE = /відбій|отбой|збит|знищен|сбит|уничтожен|мінус|минус|без\s+(дрон|бпла|беспилот|безпілот)/i;

function locate(chunk, fallbackRegionIds) {
  const { found, rest } = regionsIn(chunk);
  const hits = citiesIn(rest);
  let pos, target = null, approx = false, places = [];
  // если крупный город не назван — ищем любой населённый пункт из словаря
  if (!hits.length) {
    const st = settlementIn(rest);
    if (st) hits.push({ c: { name: st.name, lat: st.lat, lng: st.lng }, idx: 0 });
  }
  let origin = false;
  if (hits.length) {
    pos = hits[0].c;
    if (hits.length === 1) {
      // "з Воронежа" — точка вылета; по первым 5 буквам названия, т.к. в тексте падежная форма
      const stem = pos.name.slice(0, 5).toLowerCase();
      origin = new RegExp("(?:^|[\\s,.(])(?:з|із|від|от|с)\\s+" + stem, "i").test(chunk);
    }
    if (hits.length > 1) target = hits[hits.length - 1].c;
    places = hits.map(h => h.c.name);
  } else {
    const rid = found.find(x => !REGION_BY_ID[x].city) || found[0] || fallbackRegionIds[0];
    if (!rid) return null;
    const reg = REGION_BY_ID[rid];
    pos = { name: reg.name, lat: reg.lat, lng: reg.lng };
    approx = true;
    places = [reg.name];
  }
  let heading = null;
  if (target) heading = bearing(pos, target);
  else heading = compassHeading(chunk);
  return { pos, target, approx, places, heading, origin };
}

// "ще один / ще одна / ещё один" без названия типа — берём тип последнего дрона в этом месте
const CONT = /(^|[\s,.!])(ще|ещё|еще)(\s+(один|одна|одне|одні|два|три))?(?=[\s,.!(]|$)/i;
function lastDroneAt(placeName, now = Date.now()) {
  let best = null;
  for (const d of drones.values()) {
    if (now - d.ts > TTL_MS) continue;
    const same = placeName && d.places.includes(placeName);
    if (!same) continue;
    if (!best || d.ts > best.ts) best = d;
  }
  return best;
}
function lastDroneInChannel(channel, now = Date.now()) {
  let best = null;
  for (const d of drones.values()) {
    if (d.src !== channel || now - d.ts > TTL_MS) continue;
    if (!best || d.ts > best.ts) best = d;
  }
  return best;
}
// сообщение, на которое ответили (Telegram показывает ссылку на него в блоке reply)
function findReplied(m) {
  if (!m.replyTo) return null;
  for (const d of drones.values()) if (d.id.startsWith(m.replyTo + '#')) return d;
  return null;
}

function parseDrones(m) {
  const text = m.text;
  let msgType = detectType(text);
  if (!msgType) {
    // нет названия типа: "ще один на Харків", ответ на сообщение с шахедом, и т.п.
    const isCont = CONT.test(text);
    const rep = findReplied(m);
    const loc0 = locate(text, []);
    if (!(isCont || (m.replyTo && loc0)) || SKIP_LINE.test(text)) return [];
    // ответ "ще один" без места -> новая цель туда же, куда летел дрон из исходного сообщения
    if (!loc0 && rep) return [{ ...rep, id: `${m.id}#0`, text: text.slice(0, 500), ts: m.ts, src: m.channel, link: m.link }];
    const prev = rep || (m.replyText && detectType(m.replyText) && { type: detectType(m.replyText).key })
      || (loc0 && lastDroneAt(loc0.places[0])) || lastDroneInChannel(m.channel);
    msgType = prev ? DRONE_TYPES.find(t => t.key === prev.type) : null;
  }
  if (!msgType) return [];
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const msgRegions = regionsIn(text).found;
  const multi = lines.length > 1;
  const chunks = multi ? lines : [text];
  let out = [];

  chunks.forEach((chunk, i) => {
    if (SKIP_LINE.test(chunk)) return;
    const type = detectType(chunk) || msgType;
    const loc = locate(chunk, msgRegions);
    if (!loc) return;
    out.push(build(m, type, loc, chunk, i));
  });

  if (multi) {
    const withCity = out.filter(e => !e.approx);
    if (withCity.length) out = withCity;           // шапку-область отбрасываем, если есть города
    if (!out.length && !SKIP_LINE.test(text)) {
      const loc = locate(text, msgRegions);
      if (loc) out.push(build(m, msgType, loc, text, 0));
    }
  }
  return out;
}

function build(m, type, loc, text, i) {
  // dest — куда летит; from — откуда стартует (город из текста / по курсу / ближайшая граница)
  const dest = loc.target || loc.pos;
  let from, fromKind;
  if (loc.target) { from = loc.pos; fromKind = 'text'; }
  else if (loc.origin) { from = loc.pos; fromKind = 'origin'; }
  else if (loc.heading != null) { from = offsetPoint(dest.lat, dest.lng, (loc.heading + 180) % 360, 90); fromKind = 'heading'; }
  else { from = nearestBorder(dest); fromKind = 'border'; }
  let heading = loc.heading;
  if (distKm(from.lat, from.lng, dest.lat, dest.lng) > 3) heading = bearing(from, dest);
  return {
    id: `${m.id}#${i}`,
    type: type.key,
    label: type.label,
    lat: dest.lat, lng: dest.lng,
    fromLat: from.lat, fromLng: from.lng, fromKind,
    toLat: dest.lat, toLng: dest.lng,
    heading: heading == null ? null : Math.round(heading),
    places: loc.places,
    approx: loc.approx,
    text: text.slice(0, 500),
    ts: m.ts,
    src: m.channel,
    link: m.link,
  };
}

// ---------- тревоги ----------
const alertState = new Map(); // regionId -> { since, src }

// Город без области ("тривога в Харкові") -> ближайшая область по координатам
function citiesToRegions(text) {
  const out = new Set();
  for (const c of citiesIn(text)) {
    let best = null, bd = Infinity;
    for (const r of REGIONS) {
      if (r.city) continue;
      const d = (r.lat - c.c.lat) ** 2 + (r.lng - c.c.lng) ** 2;
      if (d < bd) { bd = d; best = r; }
    }
    if (best) out.add(best.id);
  }
  return [...out];
}

function applyAlert(m) {
  const hasKw = /тривог|тревог|відбій|отбой|🔴|🟢/i;
  if (!hasKw.test(m.text)) return;
  const lines = m.text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  let applied = false;
  const apply = (line) => {
    if (!hasKw.test(line)) return false;
    let { found } = regionsIn(line);
    if (!found.length) found = citiesToRegions(line);
    // "Відбій" / "Тривога" без места в региональном канале (радар Харькова) -> его область
    if (!found.length && CHANNEL_REGION[m.channel]) found = [CHANNEL_REGION[m.channel]];
    if (!found.length) return false;
    const clear = /відбій|отбой|🟢/i.test(line);
    for (const id of found) {
      if (clear) alertState.delete(id);
      else alertState.set(id, { since: m.ts, src: m.channel });
    }
    return true;
  };
  for (const line of lines) if (apply(line)) applied = true;
  if (!applied) apply(m.text.replace(/\n+/g, ' '));
}

async function pollAlertsApi() {
  if (!ALERTS_TOKEN) return;
  try {
    const r = await fetch('https://api.alerts.in.ua/v1/alerts/active.json', {
      headers: { Authorization: 'Bearer ' + ALERTS_TOKEN },
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    const fresh = new Map();
    for (const a of j.alerts || []) {
      if (a.location_type && a.location_type !== 'oblast' && a.location_type !== 'city') continue;
      const { found } = regionsIn(a.location_title || a.location_oblast || '');
      for (const id of found) fresh.set(id, { since: Date.parse(a.started_at) || Date.now(), src: 'alerts.in.ua' });
    }
    alertState.clear();
    for (const [k, v] of fresh) alertState.set(k, v);
  } catch (e) { /* оставляем состояние из Telegram */ }
}

// ---------- Telegram ----------
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'uk,ru;q=0.8' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

function parseChannelHtml(html, channel) {
  const $ = cheerio.load(html);
  const msgs = [];
  $('.tgme_widget_message').each((_, el) => {
    const $el = $(el);
    const post = $el.attr('data-post'); // channel/123
    if (!post) return;
    const textEl = $el.find('.tgme_widget_message_text').first();
    if (!textEl.length) return;
    textEl.find('br').replaceWith('\n');
    const text = textEl.text().replace(/ /g, ' ').trim();
    const dt = $el.find('.tgme_widget_message_date time').attr('datetime') || $el.find('time').attr('datetime');
    const ts = dt ? Date.parse(dt) : NaN;
    if (!text || !ts) return;
    // ответ на другое сообщение: ссылка + превью его текста
    let replyTo = null, replyText = '';
    const rep = $el.find('.tgme_widget_message_reply').first();
    if (rep.length) {
      const mm = /t\.me\/([^?#]+)/.exec(rep.attr('href') || '');
      replyTo = mm ? mm[1] : null;
      replyText = rep.find('.js-message_reply_text, .tgme_widget_message_metatext').first().text().replace(/\s+/g, ' ').trim();
    }
    msgs.push({ id: post, channel, text, ts, link: 'https://t.me/' + post, replyTo, replyText });
  });
  return msgs;
}

// ---------- состояние ----------
const drones = new Map();
const seen = new Set();
const status = {};
let lastPoll = 0;
const recentMsgs = [];          // последние сообщения (для Python-парсера)
const llmHandled = new Set();   // сообщения, которые уже разобрал ИИ (правила их не трогают)

function processMessages(all, now = Date.now()) {
  all.sort((a, b) => a.ts - b.ts);
  for (const m of all) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    recentMsgs.push(m);
    if (now - m.ts <= ALERT_TTL_MS) applyAlert(m);
    if (now - m.ts <= TTL_MS && !llmHandled.has(m.id)) for (const d of parseDrones(m)) drones.set(d.id, d);
  }
  while (recentMsgs.length > 400 || (recentMsgs.length && now - recentMsgs[0].ts > 30 * 60 * 1000)) recentMsgs.shift();
  if (seen.size > 20000) seen.clear();
  for (const [id, d] of drones) if (now - d.ts > TTL_MS) drones.delete(id);
  for (const [id, a] of alertState) if (now - a.since > ALERT_TTL_MS) alertState.delete(id);
}

async function poll() {
  const all = [];
  await Promise.all(CHANNELS.map(async ch => {
    try {
      const html = await fetchText(`https://t.me/s/${ch}`);
      const msgs = parseChannelHtml(html, ch);
      status[ch] = { ok: true, at: Date.now(), messages: msgs.length };
      all.push(...msgs);
    } catch (e) {
      status[ch] = { ok: false, at: Date.now(), error: String(e.message || e) };
    }
  }));
  processMessages(all);
  await pollAlertsApi();
  lastPoll = Date.now();
}

// ---------- приём результатов Python-парсера (ИИ) ----------
function resolvePlace(name) {
  if (!name || typeof name !== 'string') return null;
  return locate('на ' + name.trim(), []);
}
function regionIdsFor(names, channel) {
  const out = new Set();
  for (const n of names || []) {
    let f = regionsIn(String(n)).found;
    if (!f.length) f = citiesToRegions(String(n));
    f.forEach(x => out.add(x));
  }
  if (!out.size && CHANNEL_REGION[channel]) out.add(CHANNEL_REGION[channel]);
  return [...out];
}
function ingest(list, now = Date.now()) {
  let threats = 0, alerts = 0;
  for (const it of list || []) {
    if (!it || !it.id || !it.ts) continue;
    llmHandled.add(it.id);
    for (const id of [...drones.keys()]) if (id.startsWith(it.id + '#')) drones.delete(id); // заменяем разбор по правилам
    (it.events || []).forEach((ev, i) => {
      if (ev.kind === 'alert') {
        for (const rid of regionIdsFor(ev.places, it.channel)) {
          if (ev.action === 'clear') alertState.delete(rid); else alertState.set(rid, { since: it.ts, src: 'ai:' + it.channel });
          alerts++;
        }
        return;
      }
      if (ev.kind !== 'threat') return;
      const type = DRONE_TYPES.find(t => t.key === ev.type) || DRONE_TYPES.find(t => t.key === 'uav');
      const tl = resolvePlace(ev.target);
      if (!tl) return;
      const ol = ev.origin ? resolvePlace(ev.origin) : null;
      const loc = ol && !ol.approx
        ? { pos: ol.pos, target: tl.pos, approx: false, places: [ol.places[0], tl.places[0]], heading: null }
        : { pos: tl.pos, target: null, approx: tl.approx, places: tl.places, heading: Number.isFinite(ev.heading) ? ev.heading : null };
      if (now - it.ts <= TTL_MS) drones.set(`${it.id}#ai${i}`, build({ id: it.id, ts: it.ts, channel: it.channel, link: it.link }, type, loc, it.text || '', 'ai' + i));
      threats++;
    });
  }
  return { threats, alerts };
}

function currentDrones(now = Date.now()) {
  const best = new Map();
  for (const d of drones.values()) {
    if (now - d.ts > TTL_MS) continue;
    // один и тот же дрон из разных каналов (в пределах минуты) — один значок; новый дрон в той же точке — отдельный
    const key = [d.type, d.lat.toFixed(2), d.lng.toFixed(2), d.toLat ? d.toLat.toFixed(2) : '', Math.floor(d.ts / 60000)].join('|');
    const prev = best.get(key);
    if (!prev || d.ts > prev.ts) best.set(key, d);
  }
  return [...best.values()].sort((a, b) => b.ts - a.ts);
}

// ---------- HTTP ----------
const GEOJSON_URLS = [
  'https://raw.githubusercontent.com/EugeneBorshch/ukraine_geojson/master/UA_FULL_Ukraine.geojson',
  'https://cdn.jsdelivr.net/gh/EugeneBorshch/ukraine_geojson@master/UA_FULL_Ukraine.geojson',
  'https://raw.githubusercontent.com/wmgeolab/geoBoundaries/main/releaseData/gbOpen/UKR/ADM1/geoBoundaries-UKR-ADM1_simplified.geojson',
];
let geoCache = null;

function createApp() {
  const app = express();
  app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (req, res) => res.send('ok'));

  // Python-парсер: забирает свежие сообщения и присылает результат разбора
  app.get('/api/messages', (req, res) => {
    const since = +req.query.since || 0;
    res.set('Cache-Control', 'no-store');
    res.json({
      now: Date.now(),
      types: DRONE_TYPES.map(t => ({ key: t.key, label: t.label })),
      messages: recentMsgs.filter(m => m.ts > since).map(m => ({ ...m, ai: llmHandled.has(m.id) })),
    });
  });
  app.post('/api/ingest', (req, res) => {
    if (!INGEST_TOKEN) return res.status(503).json({ error: 'INGEST_TOKEN не задан на сервере' });
    if (req.get('x-token') !== INGEST_TOKEN) return res.status(401).json({ error: 'bad token' });
    res.json({ ok: true, ...ingest(req.body && req.body.messages) });
  });

  app.get('/api/meta', (req, res) => {
    res.json({
      ttlMs: TTL_MS,
      regions: REGIONS.map(r => ({ id: r.id, name: r.name, re: r.re, lat: r.lat, lng: r.lng, city: !!r.city })),
      cities: CITIES.map(c => ({ name: c.name, lat: c.lat, lng: c.lng })),
      types: DRONE_TYPES.map(t => ({ key: t.key, label: t.label })),
    });
  });

  app.get('/api/state', (req, res) => {
    const now = Date.now();
    res.set('Cache-Control', 'no-store');
    res.json({
      now,
      lastPoll,
      ttlMs: TTL_MS,
      flightMs: FLIGHT_MS,
      drones: currentDrones(now),
      alerts: [...alertState.entries()].map(([id, a]) => ({ id, since: a.since, src: a.src })),
      sources: status,
    });
  });

  app.get('/api/geojson', async (req, res) => {
    try {
      if (!geoCache) {
        let lastErr;
        for (const u of GEOJSON_URLS) {
          try {
            const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            geoCache = await r.text();
            JSON.parse(geoCache);
            break;
          } catch (e) { lastErr = e; geoCache = null; }
        }
        if (!geoCache) throw lastErr || new Error('no geojson');
      }
      res.set('Cache-Control', 'public, max-age=86400').type('application/json').send(geoCache);
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // Главная страница: ищем index.html в public/ или рядом с server.js
  const fs = require('fs');
  const pageCandidates = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'index.html'),
  ];
  app.get('/', (req, res) => {
    const found = pageCandidates.find(p => fs.existsSync(p));
    if (found) return res.sendFile(found);
    res.status(404).type('text/plain; charset=utf-8').send(
      'index.html не найден. Ожидался в папке public/index.html или рядом с server.js.\n' +
      'Проверьте структуру репозитория на GitHub.\n' +
      'Проверка сервера: /health и /api/state'
    );
  });

  app.use(express.static(path.join(__dirname, 'public')));
  return app;
}

function start() {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log('Server on :' + port + ', channels: ' + CHANNELS.join(', ')));
  const loop = async () => { try { await poll(); } catch (e) { console.error(e); } setTimeout(loop, POLL_MS); };
  loop();
}

if (require.main === module) start();

module.exports = { parseChannelHtml, parseDrones, applyAlert, processMessages, currentDrones, alertState, drones, regionsIn, citiesIn, detectType, ingest, createApp, nearestBorder };
