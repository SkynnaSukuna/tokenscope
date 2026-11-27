'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { makeSnapshot } = require('../lib/snapshot');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = ['index.html', 'styles.css', 'app.js', 'description.js', 'review-highlights.js', 'reviews.js', 'api.js'];
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Не удалось прочитать ${path.basename(file)}: ${error.message}`);
    return fallback;
  }
};

function browserCore() {
  const modules = ['billing', 'parser', 'filter'].map((name) => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', name + '.js'), 'utf8');
    return JSON.stringify('./' + name) + ':function(module,exports,require){\n' + source + '\n}';
  });
  return "'use strict';\n// Generated from the same tested modules as the Node API.\nwindow.TokenScopeCore = (() => {\nconst modules={" + modules.join(',\n') + "};\nconst cache={};function require(name){if(cache[name])return cache[name].exports;if(!modules[name])throw new Error('Unknown module '+name);const m={exports:{}};cache[name]=m;modules[name](m,m.exports,require);return m.exports;}\nreturn Object.freeze({...require('./filter'),CATEGORIES:require('./parser').CATEGORIES});\n})();\n";
}

function build({ outDir = path.join(ROOT, 'dist'), cacheDir = path.join(ROOT, 'data') } = {}) {
  const snapshot = makeSnapshot(readJson(path.join(cacheDir, 'cache.json'), {}), readJson(path.join(cacheDir, 'history.json'), {}));
  fs.mkdirSync(outDir, { recursive: true });
  // Явный список: локальные data/, инструменты и служебные файлы в сайт не попадают.
  for (const name of ASSETS) {
    let content = fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');
    if (name === 'index.html') {
      const pattern = /(<script\b[^>]*src=["']\.\/api\.js["'][^>]*><\/script>)/;
      if (!pattern.test(content)) throw new Error('В index.html не найден относительный script ./api.js');
      content = content.replace(pattern, '<script src="./filter-core.js"></script>\n$1');
    }
    fs.writeFileSync(path.join(outDir, name), content);
  }
  fs.writeFileSync(path.join(outDir, 'config.js'), "'use strict';\nwindow.TOKENSCOPE_CONFIG = Object.freeze({mode:'snapshot',snapshotUrl:'./snapshot.json',compressedSnapshotUrl:'./snapshot.json.gz',refreshMinutes:30});\n");
  fs.writeFileSync(path.join(outDir, 'filter-core.js'), browserCore());
  const serialized = JSON.stringify(snapshot);
  fs.writeFileSync(path.join(outDir, 'snapshot.json'), serialized);
  const compressed = zlib.gzipSync(serialized, { level: 9 });
  fs.writeFileSync(path.join(outDir, 'snapshot.json.gz'), compressed);
  console.log(`[pages] Размер каталога для загрузки: ${(compressed.length / 1024 / 1024).toFixed(2)} МБ (gzip)`);
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(outDir, 'LICENSE'));
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
  console.log(`[pages] ${snapshot.offers.length} лотов → ${outDir}`);
  if (!snapshot.offers.length) console.warn('[pages] Снимок пустой. Для загрузки каталога: npm run snapshot');
  if (snapshot.refreshError) console.warn('[pages] ' + snapshot.refreshError);
  return { outDir, count: snapshot.offers.length, updatedAt: snapshot.updatedAt };
}

if (require.main === module) {
  try { build(); } catch (error) { console.error('[pages] ' + error.message); process.exitCode = 1; }
}
module.exports = { build, browserCore };
