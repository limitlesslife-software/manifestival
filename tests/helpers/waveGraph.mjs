// TESTIKÄYTTÖÖN: koko src/-moduulipuu minkä tahansa aallon porteilla.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Portit ovat käännösaikaisia vakioita (src/data/schema.js), ja tuotehaaralla
// ne ovat kiinni. Ajonaikainen skeematarkistus on kuitenkin olemassa juuri
// niitä tilanteita varten, joissa portti on AUKI ja kanta on jäljessä
// (aallon J käännös, kanta aallossa C). Ne on pakko ajaa oikealla koodilla.
//
// Ratkaisu: Noden moduulikoukut (module.registerHooks). Tuonti
// `src/...?wave=J` saa OMAN moduuli-ilmentymänsä, ja sen kaikki
// src/-riippuvuudet perivät saman kyselyn. Kun ladattava tiedosto on
// schema.js, sen porttiliteraalit kirjoitetaan aallon arvoiksi
// (tools/release/waves.mjs: expectedMatrix + COLUMN_GATES) -- täsmälleen
// kuten julkaisujunan aaltocommit tekisi. Mitään tiedostoa ei kirjoiteta
// levylle, ja eri aaltojen tila (asiakas, istunto, ajonaikainen tila) on
// erillinen, koska moduulit ovat eri ilmentymiä.

import nodeModule from 'node:module';
import { expectedMatrix, COLUMN_GATES, waveIndex, ALL_GATES } from '../../tools/release/waves.mjs';

const SRC = new URL('../../src/', import.meta.url).href;
const WAVE_QUERY = /[?&]wave=([A-Z]+)$/;

/** Ovatko koukut käytettävissä tässä Node-versiossa? */
export const WAVE_GRAPH_SUPPORTED = typeof nodeModule.registerHooks === 'function';

/** Aallon porttiarvot: taulut ja sarakeportit. */
export function waveGates(wave) {
  const tables = expectedMatrix(wave);
  const columns = { TASK_EXTENDED_FIELDS: true };
  for (const [gate, openFrom] of Object.entries(COLUMN_GATES)) {
    columns[gate] = waveIndex(wave) >= waveIndex(openFrom);
  }
  return { tables, columns };
}

/** schema.js:n lähde aallon porteilla. Kaatuu, jos yksikin literaali puuttuu. */
export function rewriteSchemaSource(source, wave) {
  const { tables, columns } = waveGates(wave);
  let out = source;
  const start = out.indexOf('export const TABLES');
  const end = out.indexOf('export function hasTable', start);
  let block = out.slice(start, end);
  for (const gate of ALL_GATES) {
    const pattern = new RegExp(`(\\b${gate}:\\s*)(true|false)\\b`);
    if (!pattern.test(block)) throw new Error('portti puuttuu schema.js:stä: ' + gate);
    block = block.replace(pattern, `$1${tables[gate] ? 'true' : 'false'}`);
  }
  out = out.slice(0, start) + block + out.slice(end);
  for (const [gate, open] of Object.entries(columns)) {
    const pattern = new RegExp(`(export const ${gate} = )(true|false);`);
    if (!pattern.test(out)) throw new Error('sarakeportti puuttuu schema.js:stä: ' + gate);
    out = out.replace(pattern, `$1${open ? 'true' : 'false'};`);
  }
  return out;
}

let registered = false;

function register() {
  if (registered || !WAVE_GRAPH_SUPPORTED) return;
  registered = true;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      const parent = WAVE_QUERY.exec(context.parentURL || '');
      if (parent && result.url.startsWith(SRC) && !WAVE_QUERY.test(result.url)) {
        return { ...result, url: result.url + '?wave=' + parent[1] };
      }
      return result;
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const match = WAVE_QUERY.exec(url);
      if (!match || !url.startsWith(SRC + 'data/schema.js?')) return result;
      const source = typeof result.source === 'string'
        ? result.source : Buffer.from(result.source).toString('utf8');
      return { ...result, format: 'module', source: rewriteSchemaSource(source, match[1]) };
    }
  });
}

/**
 * Tuo src/-moduuli annetun aallon porteilla.
 * @param {string} wave 'C'..'J'
 * @param {string} rel esim. 'data/tasksRepo.js'
 */
export function importAtWave(wave, rel) {
  register();
  return import(SRC + rel + '?wave=' + wave);
}
