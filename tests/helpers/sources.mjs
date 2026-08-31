// Apuvälineet lähdekoodia tarkasteleville testeille.

import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Kaikki .js-tiedostot hakemistopuussa, polut repon juuresta. */
export function jsFilesIn(relativeDir) {
  const absolute = path.join(ROOT, relativeDir);
  if (!fs.existsSync(absolute)) return [];

  const results = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) results.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  };
  walk(absolute);
  return results.sort();
}

/** Kaikki selaimeen ladattavat moduulit. */
export function browserModules() {
  return jsFilesIn('src');
}

/** Kaikki palvelinpuolen moduulit. */
export function serverModules() {
  return jsFilesIn('api');
}

/** Kaikki lähdetiedostot, joissa salaisuuksia ei saa esiintyä. */
export function allSourceFiles() {
  return [...browserModules(), ...serverModules(), 'index.html', 'src/styles.css'];
}

/** Tiedoston sisältö. */
export function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

export function readIndexHtml() {
  return read('index.html');
}

/**
 * Tiedoston sisältö ilman kommentteja.
 *
 * Tarpeen, koska koodissa selitetään usein juuri sitä mitä on POISTETTU
 * ("aiemmin tämä kutsui renderAll()"). Ilman tätä invarianttitestit
 * kaatuisivat hyödyllisiin kommentteihin eivätkä todelliseen koodiin.
 *
 * Poistaa /* * / -lohkot ja kokonaan kommentoidut rivit. Rivin lopun
 * kommentteja ei poisteta, jottei merkkijonojen sisältöä (esim. URL:t)
 * rikota vahingossa.
 */
export function readCode(relativePath) {
  return read(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
}

/**
 * Moduulin suorat riippuvuudet repon juuresta lasketuin poluin.
 * Vain suhteelliset importit — CDN-riippuvuuksia ei ole.
 */
export function importsOf(relativePath) {
  const source = read(relativePath);
  const dir = path.dirname(relativePath);
  const specifiers = [
    ...source.matchAll(/(?:^|\n)\s*import\s[^'"]*['"](\.[^'"]+)['"]/g),
    ...source.matchAll(/(?:^|\n)\s*export\s+\*\s+from\s+['"](\.[^'"]+)['"]/g),
    ...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)
  ].map(match => match[1]);

  return specifiers.map(spec =>
    path.normalize(path.join(dir, spec)).split(path.sep).join('/'));
}

/** Koko importgraafi: tiedosto -> sen riippuvuudet. */
export function importGraph(files) {
  const graph = new Map();
  for (const file of files) graph.set(file, importsOf(file));
  return graph;
}

/**
 * Etsi ensimmäinen sykli graafista.
 * @returns {string[]|null} syklin polku tai null
 */
export function findCycle(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const stack = [];

  for (const node of graph.keys()) color.set(node, WHITE);

  const visit = node => {
    color.set(node, GRAY);
    stack.push(node);

    for (const next of graph.get(node) || []) {
      if (!graph.has(next)) continue; // repon ulkopuolinen
      const state = color.get(next);
      if (state === GRAY) return [...stack.slice(stack.indexOf(next)), next];
      if (state === WHITE) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

/** Mihin kerrokseen tiedosto kuuluu. */
export function layerOf(relativePath) {
  const match = /^src\/([^/]+)\//.exec(relativePath);
  if (!match) return relativePath === 'src/styles.css' ? 'styles' : 'root';
  return match[1];
}
