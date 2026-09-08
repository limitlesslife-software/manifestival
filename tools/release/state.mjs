// Julkaisujunan tilan lukeminen repositoriosta.
//
// Kolme riippumatonta lähdettä, jotka jokainen kelvollinen aaltocommit
// muuttaa yhdessä. Ks. `waves.mjs`, kohta "KOLME RIIPPUMATONTA LÄHDETTÄ".
//
// Tämä moduuli lukee kaikki kolme ja kertoo, ovatko ne keskenään
// yhtäpitäviä ja mitä aaltoa ne vastaavat. Se ei muuta mitään eikä ota
// yhteyttä verkkoon.

import fs from 'node:fs';
import path from 'node:path';

import {
  ALL_GATES, cacheVersionOf, describeMatrix, expectedMatrix, resolveWave
} from './waves.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');

const NEWLINE = String.fromCharCode(10);

/** Tiedoston sisältö repon juuresta, tai tyhjä jos sitä ei ole. */
export function readRepoFile(relativePath) {
  const full = path.join(ROOT, relativePath);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

/**
 * Porttien arvot `src/data/schema.js`:n lähdekoodista.
 *
 * MIKSI JÄSENNETÄÄN EIKÄ IMPORTOIDA
 *
 * Sama jäsennin lukee myös TOISEN COMMITIN schema.js:n (`git show`),
 * jota ei voi importoida. Julkaisumanifestin todentaminen nojaa juuri
 * siihen: jokaisen aaltocommitin porttimatriisi luetaan siitä
 * commitista, ei työpuusta.
 *
 * Testit tarkistavat lisäksi, että tämä jäsennin antaa työpuulle saman
 * tuloksen kuin moduulin oikea import. Jäsennin, joka erkanee
 * tulkinnasta, olisi pahempi kuin ei jäsennintä lainkaan.
 *
 * @param {string} source schema.js:n sisältö
 * @returns {object|null} portti -> boolean, tai null jos lohkoa ei löydy
 */
export function parseGates(source) {
  if (!source) return null;

  const start = source.indexOf('export const TABLES');
  if (start === -1) return null;
  const end = source.indexOf('export function hasTable', start);
  const block = source.slice(start, end === -1 ? undefined : end);

  const gates = {};
  for (const gate of ALL_GATES) {
    const match = new RegExp(`\\b${gate}:\\s*(true|false)\\b`).exec(block);
    if (!match) return null;
    gates[gate] = match[1] === 'true';
  }

  // Ylimääräinen portti on virhe: se olisi taulu, jota tämä juna ei
  // tunne, ja se avautuisi ilman aaltoa ja ilman hyväksyntää.
  const declared = [...block.matchAll(/^\s{2}(\w+):\s*(?:true|false)/gm)].map(m => m[1]);
  if (declared.length !== ALL_GATES.length) return null;

  return gates;
}

/** Onko TASK_EXTENDED_FIELDS yhä aktivoitu? */
export function parseTaskExtendedFields(source) {
  return /export const TASK_EXTENDED_FIELDS = true/.test(source || '');
}

/** Välimuistiversio `sw.js`:stä, tai null. */
export function parseCacheVersion(source) {
  const match = /const CACHE_VERSION = '(v\d+)'/.exec(source || '');
  return match ? match[1] : null;
}

/**
 * Porttitaulukko `docs/PRODUCTION-STATUS.md`:stä.
 *
 * Rivi on muotoa `| \`routines\` | 0003 | kiinni |`. Portin katsotaan
 * olevan auki, jos rivillä lukee AKTIVOITU.
 *
 * @returns {object|null} portti -> boolean, tai null jos rivi puuttuu
 */
export function parseStatusDoc(source) {
  if (!source) return null;
  const rows = source.split(NEWLINE);
  const gates = {};
  for (const gate of ALL_GATES) {
    const row = rows.find(r => r.includes('|') && r.includes('`' + gate + '`'));
    if (!row) return null;
    gates[gate] = /AKTIVOITU/.test(row);
  }
  return gates;
}

/**
 * Repositorion nykyinen julkaisutila.
 *
 * @returns {{
 *   wave: string|null, gates: object|null, cacheVersion: string|null,
 *   statusGates: object|null, taskExtendedFields: boolean,
 *   problems: string[]
 * }}
 */
export function currentState() {
  const schemaSource = readRepoFile('src/data/schema.js');
  const swSource = readRepoFile('sw.js');
  const statusSource = readRepoFile('docs/PRODUCTION-STATUS.md');

  const gates = parseGates(schemaSource);
  const cacheVersion = parseCacheVersion(swSource);
  const statusGates = parseStatusDoc(statusSource);
  const taskExtendedFields = parseTaskExtendedFields(schemaSource);

  const problems = [];
  if (!gates) problems.push('src/data/schema.js: porttilohkoa ei voitu lukea');
  if (!cacheVersion) problems.push('sw.js: CACHE_VERSION-vakiota ei löytynyt');
  if (!statusGates) problems.push('docs/PRODUCTION-STATUS.md: porttitaulukkoa ei voitu lukea');
  if (!taskExtendedFields) {
    problems.push('src/data/schema.js: TASK_EXTENDED_FIELDS ei ole enää true');
  }

  const wave = gates ? resolveWave(gates) : null;
  if (gates && wave === null) {
    problems.push(
      'porttimatriisi ei vastaa yhtäkään sallittua aaltoa: ' + describeMatrix(gates));
  }

  if (wave && cacheVersion && cacheVersion !== cacheVersionOf(wave)) {
    problems.push(
      `sw.js CACHE_VERSION on ${cacheVersion}, aalto ${wave} edellyttää `
      + cacheVersionOf(wave));
  }

  if (gates && statusGates) {
    for (const gate of ALL_GATES) {
      if (gates[gate] !== statusGates[gate]) {
        problems.push(
          `${gate}: schema.js sanoo ${gates[gate] ? 'auki' : 'kiinni'}, `
          + `PRODUCTION-STATUS.md sanoo ${statusGates[gate] ? 'auki' : 'kiinni'}`);
      }
    }
  }

  return { wave, gates, cacheVersion, statusGates, taskExtendedFields, problems };
}

/**
 * Vastaako annettu porttimatriisi täsmälleen tätä aaltoa?
 *
 * @returns {string[]} poikkeamat; tyhjä lista tarkoittaa täsmäystä
 */
export function matrixDifferences(gates, waveId) {
  const expected = expectedMatrix(waveId);
  const differences = [];
  for (const gate of ALL_GATES) {
    if (gates[gate] !== expected[gate]) {
      differences.push(
        `${gate}: on ${gates[gate] ? 'auki' : 'kiinni'}, `
        + `aallossa ${waveId} pitäisi olla ${expected[gate] ? 'auki' : 'kiinni'}`);
    }
  }
  return differences;
}
