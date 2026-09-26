// Porttitilan apuvälineet testeille.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Portit avataan tuotantoon viidessä aallossa, ja jokainen aalto on oma
// committinsa. Testi, joka olettaa portin olevan kiinni, kaatuisi siinä
// aallossa jossa se avataan — eikä se olisi vika koodissa vaan
// testissä.
//
// Toisaalta oletusta ei saa vain poistaa. "Portti kiinni tarkoittaa
// muistivarastoa" on oikea ja tärkeä väite, ja se on todistettava
// jokaisesta portista joka on kiinni.
//
// Ratkaisu: testit kysyvät porttitilan täältä ja väittävät kummastakin
// puolesta erikseen. Sama testi syvenee itsestään, kun portti kääntyy.

import { TABLES } from '../../src/data/schema.js';
import { ALL_REPOSITORIES } from '../../src/data/collectionsRepo.js';
import { ALL_GATES } from '../../tools/release/waves.mjs';

export { ALL_GATES };

/** Portit, jotka ovat auki juuri nyt. */
export const OPEN_GATES = Object.freeze(ALL_GATES.filter(g => TABLES[g] === true));

/** Portit, jotka ovat yhä kiinni. */
export const CLOSED_GATES = Object.freeze(ALL_GATES.filter(g => TABLES[g] !== true));

/** Onko portti auki? */
export function isGateOpen(gate) {
  return TABLES[gate] === true;
}

/** Repositorio porttiavaimella, tai null jos portti on oma moduulinsa. */
export function repoForGate(gate) {
  return ALL_REPOSITORIES.find(repo => repo.schemaKey === gate) || null;
}

/** Repositoriot, joiden portti on kiinni. */
export function closedRepositories() {
  return ALL_REPOSITORIES.filter(repo => !repo.isPersistent());
}

/** Repositoriot, joiden portti on auki. */
export function openRepositories() {
  return ALL_REPOSITORIES.filter(repo => repo.isPersistent());
}

/**
 * Supabase-asiakkaan korvike, joka kirjaa jokaisen kutsun.
 *
 * Ketju on sama kuin oikealla asiakkaalla:
 *   from(t).select('*').eq(...)          -> { data, error }
 *   from(t).insert(row)                  -> { data, error }
 *   from(t).update(row).eq(...).eq(...)  -> { data, error }
 *   from(t).update(row).eq(...).select('id') -> { data: [rivi], error }
 *   from(t).delete().eq(...).eq(...)     -> { data, error }
 *   from(t).select('*').eq(...).maybeSingle()
 *   from(t).upsert(row)
 *
 * PÄIVITYS PALAUTTAA LÄHETETYN RIVIN. Repositoriot ketjuttavat
 * päivitykseen `.select('id')` ja pitävät nollaa riviä "kohdetta ei
 * enää ole" -virheenä. Oletusvastaus (`data: []`) tarkoittaa hauille
 * tyhjää listaa, ei "päivitys ei osunut", joten päivitys vastaa
 * lähetetyllä rivillä. Nollan rivin päivitys: `{ updateData: [] }`.
 *
 * YKSI RIVI (`maybeSingle`) ON RIVI TAI null, EI LISTA. Oletusvastauksen
 * tyhjä lista olisi "rivi löytyi": muistutusasetusten tallennus torjui
 * silloin muutoksen (palvelimella on jo rivi), kun portti oli auki.
 *
 * @param {object} response { data, error, updateData? } tai { throws: Error }
 */
export function fakeClient(response = { data: [], error: null }) {
  const calls = [];

  const dataFor = entry => {
    if (entry.operation === 'update' && !response.error) {
      if (response.updateData !== undefined) return response.updateData;
      return [{ ...(entry.payload || {}) }];
    }
    const data = response.data === undefined ? [] : response.data;
    if (entry.maybeSingle && Array.isArray(data)) return data[0] ?? null;
    return data;
  };

  const chain = (entry) => {
    const query = {
      eq(column, value) {
        entry.filters.push([column, value]);
        return query;
      },
      select(columns) {
        entry.returning = columns === undefined ? '*' : columns;
        return query;
      },
      maybeSingle() {
        entry.maybeSingle = true;
        return query;
      },
      then(resolve, reject) {
        if (response.throws) {
          return Promise.reject(response.throws).then(resolve, reject);
        }
        return Promise.resolve({
          data: dataFor(entry),
          error: response.error || null
        }).then(resolve, reject);
      }
    };
    return query;
  };

  return {
    calls,
    from(table) {
      const record = (operation) => (payload) => {
        const entry = { table, operation, payload, filters: [], maybeSingle: false };
        calls.push(entry);
        return chain(entry);
      };
      return {
        select: record('select'),
        insert: record('insert'),
        update: record('update'),
        upsert: record('upsert'),
        delete: record('delete')
      };
    }
  };
}
