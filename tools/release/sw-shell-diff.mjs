// Palvelutyöntekijän SHELL-listan ero todella ladattaviin moduuleihin.
//
//   node tools/release/sw-shell-diff.mjs          näytä puuttuvat ja ylimääräiset
//   node tools/release/sw-shell-diff.mjs --write  lisää puuttuvat ja poista ylimääräiset
//
// tests/pwa.test.mjs vaatii, että SHELL on täsmälleen src/app/main.js:stä
// tavoitettavien moduulien joukko (+ kiinteät kuoren tiedostot). Tämä työkalu
// laskee saman joukon samalla tavalla (staattiset suhteelliset importit) ja
// korjaa listan, kun uusi moduuli tulee käyttöön. CACHE_VERSIONia EI kosketa:
// se kuuluu aaltocommitille (tools/release/waves.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SW = path.join(ROOT, 'sw.js');

function importsOf(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const m of code.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*['"](\.[^'"]+)['"]/g)) {
    const spec = m[1] || m[2];
    out.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
  }
  return out;
}

export function reachableModules(entry = 'src/app/main.js') {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const next of importsOf(rel)) if (next.startsWith('src/')) stack.push(next);
  }
  return [...seen].sort();
}

export function shellDiff() {
  const sw = fs.readFileSync(SW, 'utf8');
  const listed = [...sw.matchAll(/'\/(src\/[^']+\.js)'/g)].map(m => m[1]);
  const reachable = reachableModules();
  return {
    missing: reachable.filter(m => !listed.includes(m)),
    extra: listed.filter(m => !reachable.includes(m))
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { missing, extra } = shellDiff();
  console.log(`puuttuu: ${missing.length ? missing.join(', ') : '-'}`);
  console.log(`ylimääräinen: ${extra.length ? extra.join(', ') : '-'}`);
  if (process.argv.includes('--write') && (missing.length || extra.length)) {
    let sw = fs.readFileSync(SW, 'utf8');
    const eol = sw.includes('\r\n') ? '\r\n' : '\n';
    for (const m of extra) sw = sw.replace(new RegExp(`\\s*'\\/${m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}',?`), '');
    const anchor = `  '/src/styles.css'`;
    if (missing.length && !sw.includes(anchor)) throw new Error('ankkuria /src/styles.css ei löytynyt sw.js:stä');
    if (missing.length) sw = sw.replace(anchor, missing.map(m => `  '/${m}',`).join(eol) + eol + anchor);
    fs.writeFileSync(SW, sw);
    console.log('sw.js päivitetty');
  }
}
