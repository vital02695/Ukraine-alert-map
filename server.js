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
try {
  for (const [names, lat, lng, pop] of JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'settlements_ua.json'), 'utf8'))) {
    for (const n of names) {
      const k = n.length >= 6 ? n.slice(0, 6) : n;
      if (!SETTL.has(k)) SETTL.set(k, []);
      SETTL.get(k).push({ n, lat, lng, pop });
    }
  }
} catch (e) { console.error('settlements_ua.json не загружен:', e.message); }

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
      if (ok && (!best || e.pop > best.pop)) best = { ...e, name: e.n.charAt(0).toUpperCase() + e.n.slice(1) };
    }
  }
  return best;
}

// ---------- настройки ----------
const CHANNELS = (process.env.CHANNELS || 'radar_kharkov,tlknewsua,air_alert_ua,kanalalertmap')
  .split(',').map(s => s.trim()).filter(Boolean);
const POLL_MS = +process.env.POLL_MS || 15000;
const TTL_MS = 10 * 60 * 1000;           // дрон "живёт" 10 минут
const ALERT_TTL_MS = 12 * 3600 * 1000;   // тревога без отбоя гаснет через 12 ч
const ALERTS_TOKEN = process.env.ALERTS_IN_UA_TOKEN || ''; // необязательно (alerts.in.ua)

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
  { key: 'geran4', label: 'Герань-4', re: /геран[ьіи]?\W{0,2}4|geran\W{0,2}4/i },
  { key: 'geran3', label: 'Герань-3 (реактивний)', re: /геран[ьіи]?\W{0,2}3|geran\W{0,2}3|гербер/i },
  { key: 'shahed', label: 'Шахед / Герань-2', re: /шах[еє]д|shahed|геран|geran|мопед/i },
  { key: 'lancet', label: 'Ланцет', re: /ланцет|lancet/i },
  { key: 'molniya', label: 'Молния', re: /молни[яи]|молнія|molniya/i },
  { key: 'orlan', label: 'Орлан-10', re: /орлан|orlan/i },
  { key: 'recon', label: 'Розвідувальний БПЛА (Zala / Supercam)', re: new RegExp('суперкам|supercam|zala|' + L + 'зала\\s?(\\d{3}|бпла|літак)', 'i') },
  { key: 'fpv', label: 'FPV-дрон', re: /fpv|фпв/i },
  { key: 'kab', label: 'КАБ (авіабомба)', re: new RegExp(L + 'каб(и|ів|ах|ом|у)?' + R + '|авіабомб|авиабомб', 'i') },
  { key: 'missile', label: 'Ракета', re: /ракет|калібр|калибр|кинджал|кінжал|іскандер|искандер|х-?101|х-?59|х-?22|х-?35|циркон|точк[аи]-?у|балістик|баллистик|крилат|крылат/i },
  { key: 'uav', label: 'БПЛА', re: new RegExp('бпла|бпл' + R + '|безпілот|беспилот|дрон|' + L + 'uav', 'i') },
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
  if (hits.length) {
    pos = hits[0].c;
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
  return { pos, target, approx, places, heading };
}

function parseDrones(m) {
  const text = m.text;
  const msgType = detectType(text);
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
  return {
    id: `${m.id}#${i}`,
    type: type.key,
    label: type.label,
    lat: loc.pos.lat, lng: loc.pos.lng,
    toLat: loc.target ? loc.target.lat : null,
    toLng: loc.target ? loc.target.lng : null,
    heading: loc.heading === null ? null : Math.round(loc.heading),
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
    msgs.push({ id: post, channel, text, ts, link: 'https://t.me/' + post });
  });
  return msgs;
}

// ---------- состояние ----------
const drones = new Map();
const seen = new Set();
const status = {};
let lastPoll = 0;

function processMessages(all, now = Date.now()) {
  all.sort((a, b) => a.ts - b.ts);
  for (const m of all) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (now - m.ts <= ALERT_TTL_MS) applyAlert(m);
    if (now - m.ts <= TTL_MS) for (const d of parseDrones(m)) drones.set(d.id, d);
  }
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

function currentDrones(now = Date.now()) {
  const best = new Map();
  for (const d of drones.values()) {
    if (now - d.ts > TTL_MS) continue;
    const key = [d.type, d.lat.toFixed(2), d.lng.toFixed(2), d.toLat ? d.toLat.toFixed(2) : ''].join('|');
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
  app.get('/health', (req, res) => res.send('ok'));

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

module.exports = { parseChannelHtml, parseDrones, applyAlert, processMessages, currentDrones, alertState, drones, regionsIn, citiesIn, detectType };
