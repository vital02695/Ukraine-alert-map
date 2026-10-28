// Сборка словаря населённых пунктов из GeoNames UA.txt
// Использование: node build_settlements.js путь/к/UA.txt
const fs = require('fs');
const src = process.argv[2];
const out = __dirname + '/data/settlements_ua.json';
const CYR = /[а-яіїєґё]/i;
const clean = s => s.normalize('NFC').replace(/́/g, '').replace(/[’ʼ`]/g, "'").trim().toLowerCase();
const rows = [];
let seen = 0;
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  if (!line) continue;
  const c = line.split('\t');
  if (c[6] !== 'P') continue; // только населённые пункты
  const lat = +c[4], lng = +c[5], pop = +c[14] || 0;
  const names = new Set();
  const add = n => {
    n = clean(n).replace(/^(станция|станція|станц\.?)\s+/, '');
    if (n.length >= 3 && CYR.test(n)) names.add(n);
  };
  add(c[1]);
  c[3].split(',').forEach(add);
  if (!names.size) continue;
  seen++;
  rows.push([[...names].slice(0, 8), +lat.toFixed(4), +lng.toFixed(4), pop]);
}
fs.writeFileSync(out, JSON.stringify(rows));
console.log('Населённых пунктов с кириллицей:', rows.length, '(из P-строк:', seen + ')');
console.log('Размер:', (fs.statSync(out).size / 1024 / 1024).toFixed(2), 'МБ');
