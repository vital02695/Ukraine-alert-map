// Приблизительные координаты для населённых пунктов без координат.
// Берём центр их громады (или района) по названию из data/settlements_ua.json.
// Использование: node build_extra.js путь/к/ua-name-places.csv
const fs = require('fs');
const csv = process.argv[2];
const lines = fs.readFileSync(csv, 'utf8').split('\n').filter(Boolean);
const head = lines[0].split(',');
const rows = lines.slice(1).map(l => { const c = l.split(','); const o = {}; head.forEach((h, i) => o[h] = c[i] || ''); return o; });
const norm = s => (s || '').toLowerCase().replace(/[’ʼ`]/g, "'").trim();
const dict = JSON.parse(fs.readFileSync(__dirname + '/data/settlements_ua.json', 'utf8'));
const have = new Map();                     // имя -> лучший центр (по населению)
const byPrefix = new Map();                 // первые 6 символов -> записи
for (const [names, lat, lng, pop] of dict) for (const n0 of names) {
  const n = norm(n0);
  if (!have.has(n) || have.get(n).pop < pop) have.set(n, { lat, lng, pop });
  const k = n.slice(0, 6);
  if (!byPrefix.has(k)) byPrefix.set(k, []);
  byPrefix.get(k).push({ n, lat, lng, pop });
}
const centerOf = title => {                 // "Люботинська міська громада" -> центр Люботина
  const word = norm(title).replace(/\s+(міська|селищна|сільська|районна|громада|район).*$/, '').split(/\s+/)[0];
  if (!word || word.length < 4) return null;
  const k = word.slice(0, 6);
  let best = null;
  for (const e of byPrefix.get(k) || []) {
    if (e.n.slice(0, 6) === k && (!best || e.pop > best.pop)) best = e;
  }
  return best ? { lat: best.lat, lng: best.lng } : null;
};
const found = [], extra = new Map();
let fromHromada = 0, fromRayon = 0, none = 0;
for (const r of rows) {
  const name = norm(r['name:uk'] || r.name);
  if (!name || have.has(name)) { found.push(1); continue; }
  const c = centerOf(r.hromada) || (fromRayon++, centerOf(r.rayon));
  if (!c) { none++; continue; }
  if (r.hromada && centerOf(r.hromada)) fromHromada++;
  const key = name + '|' + c.lat + '|' + c.lng;
  if (!extra.has(key)) extra.set(key, { name, lat: c.lat, lng: c.lng, region: r.region });
}
const out = [...extra.values()].map(e => [[e.name], +e.lat.toFixed(4), +e.lng.toFixed(4), 0]);
fs.writeFileSync(__dirname + '/data/extra_places.json', JSON.stringify(out));
console.log({ всего: rows.length, уже_есть: found.length, добавлено: out.length, по_громаде: fromHromada, по_району: fromRayon, не_найдено: none });
