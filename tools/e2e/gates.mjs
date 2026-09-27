// E2E:n porttitila: haaran oma schema.js ("closed"), aallon J portit ("J")
// tai aallon K portit ("K", arjen käyttöjärjestelmä, migraatio 0014).
//
// MIKSI EI TARJOILLA J-EHDOKKAAN schema.js:ÄÄ SELLAISENAAN
//
// J-ehdokkaan schema.js voi olla vanhempi tiedosto (näin oli J v1:ssä):
// siitä puuttuu ajonaikainen skeemakerros (isTableAvailable,
// columnGateOpen, writeRefusal, SCHEMA_REQUIREMENTS, ...), jota tämän
// haaran repositoriot importoivat. Sellaisenaan tarjoiltuna jokainen
// moduuli kaatuisi linkitykseen. EIKÄ valjasta ajeta J-ehdokkaan
// työpuusta: ehdokas voi olla leikattu ennen tämän haaran uusimpia
// korjauksia, ja E2E testaa tämän haaran koodia J:n porteilla.
//
// Siksi: TÄMÄN haaran schema.js, jonka porttiliteraalit (TABLES-lohko ja
// sarakeportit) korvataan aallon J arvoilla. Arvot luetaan J-ehdokkaan
// schema.js:stä (git show, sama jäsennin kuin julkaisutyökaluilla,
// tools/release/state.mjs parseGates) ja niitä verrataan junan omaan
// määrittelyyn (tools/release/waves.mjs). Jos ne eroavat, ajo keskeytyy:
// "J-portit" tarkoittaa aina sitä, mitä J avaa. Jos ref puuttuu (esim.
// kloonista), käytetään junan määrittelyä ja lähde kerrotaan tulosteessa.
//
// Selain saa korvatun tiedoston import mapin kautta (harnessHtml alla;
// ajaja tarjoilee tiedoston): /src/data/schema.js ->
// /src/data/schema.js?e2e-gates=J. Mikään src/-tiedosto ei muutu.
//
// AALTO K: K-ehdokashaaraa ei vielä ole. K-portit johdetaan siksi junan
// määrittelystä (trainMatrix('K') = expectedMatrix('K') + sarakeportit),
// samalla varapolulla kuin J:n portit, kun J:n ref puuttuu, ja lähde
// kerrotaan tulosteessa. Kun K-ehdokas leikataan, sen ref annetaan
// ympäristömuuttujassa E2E_K_GATES_REF: silloin portit luetaan ehdokkaan
// schema.js:stä ja verrataan junan määrittelyyn kuten J:llä.

import { execFileSync } from 'node:child_process';
import { parseGates } from '../release/state.mjs';
import { ALL_GATES, COLUMN_GATES, expectedMatrix, waveIndex } from '../release/waves.mjs';

export const GATE_MODES = Object.freeze(['closed', 'J', 'K', 'L']);
export const DEFAULT_GATES_REF = 'rehearsal/wave-j-v2';
/** K-ehdokkaan ref (ympäristömuuttuja). Oletuksena ei refiä: junan määrittely. */
export const K_GATES_REF_ENV = 'E2E_K_GATES_REF';
/** L-ehdokkaan ref (ympäristömuuttuja). */
export const L_GATES_REF_ENV = 'E2E_L_GATES_REF';
/** Kyselyparametri, jolla selain pyytää korvatun schema.js:n. */
export const GATES_QUERY = 'e2e-gates';

/** Porttitilat, joissa selain saa korvatun schema.js:n (import map). */
const PATCHED_MODES = Object.freeze(['J', 'K', 'L']);

/**
 * Valjassivu porttitilalle. J- ja K-tilassa sivulle lisätään import map,
 * joka ohjaa jokaisen schema.js-importin porttiseen versioon (sama
 * tiedosto, porttiliteraalit korvattu). Import map on sivun ensimmäinen
 * skripti. Muut tilat (closed) saavat sivun sellaisenaan.
 */
export function harnessHtml(template, mode) {
  if (!PATCHED_MODES.includes(mode)) return template;
  const map = JSON.stringify({ imports: { '/src/data/schema.js': `/src/data/schema.js?${GATES_QUERY}=${mode}` } });
  return template.replace('<script type="module"', `<script type="importmap">${map}</script>\n<script type="module"`);
}

/** Junan määrittelemä porttimatriisi aallolle (taulut ja sarakeportit). */
export function trainMatrix(waveId) {
  const columns = {};
  for (const [gate, openFrom] of Object.entries(COLUMN_GATES)) {
    columns[gate] = waveIndex(openFrom) <= waveIndex(waveId);
  }
  return { tables: { ...expectedMatrix(waveId) }, columns };
}

/** Sarakeporttien arvot schema.js:n lähdekoodista. Puuttuva = kiinni (vanha commit). */
export function parseColumnGates(source) {
  const columns = {};
  for (const gate of Object.keys(COLUMN_GATES)) {
    const match = new RegExp(`^export const ${gate} = (true|false);`, 'm').exec(String(source || ''));
    columns[gate] = Boolean(match) && match[1] === 'true';
  }
  return columns;
}

/** Ovatko kaksi matriisia samat? Palauttaa erot sanoina. */
export function matrixDifferences(actual, expected) {
  const out = [];
  for (const gate of ALL_GATES) {
    if (Boolean(actual.tables[gate]) !== Boolean(expected.tables[gate])) out.push(`${gate}: ${actual.tables[gate]} != ${expected.tables[gate]}`);
  }
  for (const gate of Object.keys(COLUMN_GATES)) {
    if (Boolean(actual.columns[gate]) !== Boolean(expected.columns[gate])) out.push(`${gate}: ${actual.columns[gate]} != ${expected.columns[gate]}`);
  }
  return out;
}

/**
 * Korvaa schema.js:n porttiliteraalit. Muu tiedosto (ajonaikainen
 * skeemakerros) pysyy ennallaan. Heittää, jos yksikin portti puuttuu tai
 * jäsennin ei lue tulosta samaksi matriisiksi.
 */
export function patchSchemaGates(source, { tables, columns }) {
  const text = String(source);
  const start = text.indexOf('export const TABLES');
  const end = text.indexOf('export function hasTable', start);
  if (start === -1 || end === -1) throw new Error('schema.js: TABLES-lohkoa ei löytynyt');
  let block = text.slice(start, end);
  for (const gate of ALL_GATES) {
    const pattern = new RegExp(`(\\b${gate}:\\s*)(true|false)\\b`);
    if (!pattern.test(block)) throw new Error(`schema.js: porttia ${gate} ei löytynyt`);
    block = block.replace(pattern, `$1${tables[gate] === true}`);
  }
  let out = text.slice(0, start) + block + text.slice(end);
  for (const gate of Object.keys(COLUMN_GATES)) {
    const pattern = new RegExp(`^export const ${gate} = (true|false);`, 'm');
    if (!pattern.test(out)) throw new Error(`schema.js: sarakeporttia ${gate} ei löytynyt`);
    out = out.replace(pattern, `export const ${gate} = ${columns[gate] === true};`);
  }
  const check = { tables: parseGates(out) || {}, columns: parseColumnGates(out) };
  const differences = matrixDifferences(check, { tables, columns });
  if (differences.length > 0) throw new Error('schema.js: korvaus ei tuottanut pyydettyä matriisia: ' + differences.join('; '));
  return out;
}

function gitShow(ref, file, cwd) {
  return execFileSync('git', ['show', `${ref}:${file}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function gitSha(ref, cwd) {
  return execFileSync('git', ['rev-parse', '--short', ref], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Porttitilan oletusref: J-ehdokas (E2E_GATES_REF tai rehearsal/wave-j-v2)
 * tai K-ehdokas (E2E_K_GATES_REF). K:lla ei ole oletusrefiä: ehdokasta ei
 * vielä ole, joten portit tulevat junan määrittelystä.
 */
export function defaultGatesRef(mode, env = process.env) {
  if (mode === 'K') return env[K_GATES_REF_ENV] || null;
  // Aalto L: ehdokas vain ympäristömuuttujasta; muuten junan määrittely.
  if (mode === 'L') return env[L_GATES_REF_ENV] || null;
  return env.E2E_GATES_REF || DEFAULT_GATES_REF;
}

/**
 * Porttitila ajolle.
 *
 * @param {'closed'|'J'|'K'} mode
 * @param {object} options
 * @param {string} options.cwd  repositorion juuri
 * @param {string} options.schemaSource  työpuun src/data/schema.js
 * @param {string|null} [options.ref]  aallon ehdokkaan ref (ks. defaultGatesRef);
 *   null = ei ehdokasta, portit junan määrittelystä
 * @returns {{ mode: string, source: string|null, provenance: string, matrix: object|null,
 *   fromTrain: boolean }}  fromTrain: portit tulivat junan määrittelystä (ei ehdokkaasta)
 */
export function resolveGateMode(mode, { cwd, schemaSource, ref = defaultGatesRef(mode),
  show = gitShow, sha = gitSha } = {}) {
  if (!GATE_MODES.includes(mode)) throw new Error(`Tuntematon porttitila: ${mode}`);
  if (mode === 'closed') {
    return { mode, source: null, provenance: 'haaran oma src/data/schema.js', matrix: null, fromTrain: false };
  }

  const train = trainMatrix(mode);
  let candidate = null;
  let provenance;
  if (!ref) {
    provenance = `junan määrittely tools/release/waves.mjs (aallon ${mode} ehdokasta ei ole; `
      + `trainMatrix('${mode}'))`;
  } else {
    try {
      const source = show(ref, 'src/data/schema.js', cwd);
      const tables = parseGates(source, { allowMissing: true });
      if (!tables) throw new Error(`${ref}: porttilohkoa ei voitu lukea`);
      candidate = { tables, columns: parseColumnGates(source) };
      provenance = `${ref} (${sha(ref, cwd)}), porttiliteraalit haaran schema.js:ään`;
    } catch (error) {
      if (/porttilohkoa/.test(error.message)) throw error;
      provenance = `junan määrittely tools/release/waves.mjs (ref ${ref} puuttuu)`;
    }
  }
  if (candidate) {
    const differences = matrixDifferences(candidate, train);
    if (differences.length > 0) {
      throw new Error(`${ref} ei vastaa junan aaltoa ${mode}: ${differences.join('; ')}`);
    }
  }
  const matrix = candidate || train;
  return { mode, source: patchSchemaGates(schemaSource, matrix), provenance, matrix, fromTrain: !candidate };
}
