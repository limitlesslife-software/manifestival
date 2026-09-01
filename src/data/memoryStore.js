// Muistinvarainen kokoelmavarasto.
//
// KAKSI KÄYTTÖTARKOITUSTA
//
// 1. TESTIT. Koko uusi domain — rutiinit, tavoitteet, projektit, hyvinvointi —
//    voidaan testata ilman verkkoa ja ilman Supabasea. Testit ovat nopeita ja
//    toistettavia eivätkä koskaan kirjoita tuotantoon.
//
// 2. VÄLIAIKAINEN SIJAINTI ennen migraatioita. Tauluja `routines`, `goals`,
//    `projects` ja `wellbeing` ei ole vielä olemassa, koska migraatioita
//    0003–0006 ei ole ajettu. Siihen asti nämä elävät istunnon muistissa.
//
// ⚠️ TÄMÄ EI OLE TUOTANNON DATAKERROS.
//
// Muistivarasto katoaa sivun latauksessa. Se on tietoinen, dokumentoitu ja
// käyttöliittymässä NÄKYVÄ rajoitus — ei piilotettu puute. Vaihtoehto olisi
// ollut teeskennellä tallennusta, mikä olisi pahempaa: käyttäjä luulisi
// tietojensa säilyvän.
//
// Kun migraatiot on ajettu, `src/data/schema.js` ohjaa kutsut Supabaseen
// eikä tätä enää käytetä tuotantopolussa.

import { ok, fail } from '../lib/result.js';

/**
 * Luo uusi eristetty kokoelma.
 *
 * Jokainen kutsu palauttaa oman varastonsa — testit eivät voi vuotaa
 * toisiinsa eikä globaalia tilaa synny.
 *
 * @param {object} [options]
 * @param {Function} [options.normalize] Normalisointifunktio riveille
 * @param {string}   [options.name]      Nimi virheviesteihin
 */
export function createCollection({ normalize = value => value, name = 'kokoelma' } = {}) {
  /** @type {Map<string, object>} */
  const items = new Map();

  function assertId(entity) {
    if (!entity || entity.id == null || entity.id === '') {
      throw new Error(name + ': tunniste puuttuu');
    }
    return String(entity.id);
  }

  return {
    name,

    /** Kaikki rivit lisäysjärjestyksessä. Palautus on kopio. */
    async list() {
      return ok([...items.values()].map(item => ({ ...item })));
    },

    /** Yksi rivi tunnisteella. */
    async get(id) {
      const item = items.get(String(id));
      return item ? ok({ ...item }) : fail(name + ': riviä ei löydy.', { code: 'memory.missing' });
    },

    /** Lisää rivi. Olemassa oleva tunniste on virhe — se paljastaa bugin. */
    async insert(entity) {
      const normalized = normalize(entity);
      const id = assertId(normalized);
      if (items.has(id)) {
        return fail(name + ': tunniste on jo käytössä.', { code: 'memory.duplicate' });
      }
      items.set(id, { ...normalized });
      return ok({ ...normalized });
    },

    /** Korvaa rivi kokonaan. */
    async update(entity) {
      const normalized = normalize(entity);
      const id = assertId(normalized);
      if (!items.has(id)) {
        return fail(name + ': riviä ei löydy.', { code: 'memory.missing' });
      }
      items.set(id, { ...normalized });
      return ok({ ...normalized });
    },

    /** Yhdistä muutokset olemassa olevaan riviin. */
    async patch(id, changes) {
      const key = String(id);
      const current = items.get(key);
      if (!current) return fail(name + ': riviä ei löydy.', { code: 'memory.missing' });

      const merged = normalize({ ...current, ...changes, id: key });
      items.set(key, { ...merged });
      return ok({ ...merged });
    },

    /** Poista rivi. Olemattoman poisto ei ole virhe — lopputulos on sama. */
    async remove(id) {
      items.delete(String(id));
      return ok({ id: String(id) });
    },

    /** Korvaa koko sisältö. Käytetään latauksessa ja testien alustuksessa. */
    async replaceAll(entities = []) {
      items.clear();
      for (const entity of entities) {
        const normalized = normalize(entity);
        if (normalized && normalized.id != null) items.set(String(normalized.id), { ...normalized });
      }
      return ok([...items.values()].map(item => ({ ...item })));
    },

    /** Tyhjennä. Kutsutaan uloskirjautumisessa. */
    clear() {
      items.clear();
    },

    /** Rivien määrä. Vain diagnostiikkaan ja testeihin. */
    size() {
      return items.size;
    }
  };
}

/**
 * Kokoelma, joka toimii repositorion rajapinnalla.
 *
 * Sama muoto kuin Supabase-repositorioilla: `{ ok, value }` tai
 * `{ ok, error }`. Näin sovelluskerros ei tiedä kumpaa se käyttää, ja
 * migraation jälkeinen vaihto ei vaadi muutoksia kutsupaikkoihin.
 */
export function createMemoryRepository(options) {
  return createCollection(options);
}
