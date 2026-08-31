// Elämänalueet eli tehtäväkategoriat.
//
// Yksi lähde koko sovellukselle: lomakkeet, suodattimet, tagit ja AI-jäsennys
// lukevat kaikki tästä. Aiemmin lista oli kahdessa paikassa (index.html ja
// api/parse.js:n prompt), mikä oli hiljainen ajautumisriski.
//
// Avaimet vastaavat konseptidokumentin luvun 21 elämänalueita ja niitä on jo
// tuotantodatassa, joten niitä EI nimetä uudelleen. Uusia voi lisätä listan
// loppuun ilman migraatiota, koska sarake on tekstityyppinen.

export const DEFAULT_CATEGORY = 'muu';

/**
 * @typedef {object} Category
 * @property {string} key    Kannassa säilytettävä arvo
 * @property {string} label  Käyttöliittymän teksti
 * @property {string} tone   Väritoken (ks. src/styles.css)
 */

/** @type {ReadonlyArray<Category>} */
export const CATEGORIES = Object.freeze([
  { key: 'tyo',          label: 'Työ',          tone: 'forest' },
  { key: 'perhe',        label: 'Perhe',        tone: 'gold'   },
  { key: 'hyvinvointi',  label: 'Hyvinvointi',  tone: 'path'   },
  { key: 'harrastus',    label: 'Harrastus',    tone: 'sage'   },
  { key: 'koti',         label: 'Koti',         tone: 'sage'   },
  { key: 'kehitys',      label: 'Kehitys',      tone: 'forest' },
  { key: 'talous',       label: 'Talous',       tone: 'clay'   },
  { key: 'muu',          label: 'Muu',          tone: 'sage'   }
].map(Object.freeze));

const BY_KEY = new Map(CATEGORIES.map(c => [c.key, c]));

/** Kaikki sallitut avaimet. Käytetään AI-vastauksen validointiin. */
export const CATEGORY_KEYS = Object.freeze(CATEGORIES.map(c => c.key));

/** Onko avain tunnettu kategoria. */
export function isCategory(key) {
  return BY_KEY.has(key);
}

/** Kategorian tiedot tai oletuskategoria, jos avainta ei tunneta. */
export function getCategory(key) {
  return BY_KEY.get(key) || BY_KEY.get(DEFAULT_CATEGORY);
}

/** Käyttöliittymän teksti avaimelle. Tuntematon avain -> 'Muu'. */
export function categoryLabel(key) {
  return getCategory(key).label;
}


/**
 * Palauttaa kelvollisen kategoria-avaimen. Tuntematon, tyhjä tai
 * väärän tyyppinen arvo normalisoituu oletukseksi.
 */
export function normalizeCategory(key) {
  return isCategory(key) ? key : DEFAULT_CATEGORY;
}
