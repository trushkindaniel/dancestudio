// Скачивает шрифты сайта с Google Fonts один раз и кладёт их в public/fonts,
// чтобы браузер посетителя не обращался к серверам Google (152-ФЗ, ч. 5 ст. 18).
// Запуск: node scripts/fetch-fonts.mjs  → public/fonts/*.woff2 и public/css/fonts.css
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'fonts');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const KEEP = new Set(['cyrillic', 'cyrillic-ext', 'latin', 'latin-ext']);

const SOURCES = [
  { url: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500;1,600&display=swap' },
  { url: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap' },
  { url: 'https://fonts.googleapis.com/css2?family=Unbounded:wght@300;500;700&display=swap' },
  // каллиграфия только для надписи «Аренда зала 55»: без подмены шрифта, только нужные буквы
  { url: 'https://fonts.googleapis.com/css2?family=Great+Vibes&display=block&text=' + encodeURIComponent(' 5Аадезлнр'), subset: 'logo' },
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const seen = new Map(); // url файла → имя (variable-шрифты отдают один файл на все начертания)
let css = '/* Шрифты лежат на нашем сервере. Пересобрать: node scripts/fetch-fonts.mjs */\n';
let total = 0;

for (const src of SOURCES) {
  const res = await fetch(src.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${src.url}`);
  const text = await res.text();
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*{([^}]*)}/g;
  let m;
  while ((m = re.exec(text))) {
    const subset = src.subset || m[1] || 'all';
    if (!src.subset && !KEEP.has(subset)) continue;
    const body = m[2];
    const family = /font-family:\s*'([^']+)'/.exec(body)[1];
    const style = /font-style:\s*(\w+)/.exec(body)[1];
    const weight = /font-weight:\s*(\d+)/.exec(body)[1];
    const fileUrl = /url\(([^)]+)\)/.exec(body)[1];
    let name = seen.get(fileUrl);
    if (!name) {
      name = `${family.toLowerCase().replace(/\s+/g, '-')}-${subset}-${style}-${weight}.woff2`;
      const bin = Buffer.from(await (await fetch(fileUrl, { headers: { 'User-Agent': UA } })).arrayBuffer());
      writeFileSync(join(outDir, name), bin);
      total += bin.length;
      seen.set(fileUrl, name);
    }
    css += `/* ${subset} */\n@font-face {${body.replace(/url\([^)]+\)/, `url(/fonts/${name})`)}}\n`;
  }
}
writeFileSync(join(root, 'public', 'css', 'fonts.css'), css);
console.log(`файлов: ${seen.size}, всего ${(total / 1024).toFixed(0)} КБ`);
