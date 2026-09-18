// Tilin elinkaari: yksi totuudenlähde sille, mitä käyttäjän tiliin
// kuuluu, ja kuinka poisto vaikuttaisi siihen.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa, ei tietokantaa.
//
// -----------------------------------------------------------------------
// EI OMAA LISTAA — YKSI LÄHDE VIENNIN KANSSA
// -----------------------------------------------------------------------
// `EXPORTED_COLLECTIONS` (src/domain/dataExport.js) ON JO se käyttäjän
// omistamien tietotyyppien nimenomainen luettelo. Erillinen "poisto-
// inventaario" ajautuisi siitä eroon ensimmäisellä unohtuneella
// päivityksellä — juuri sitä riskiä Phase N pyytää pienentämään.
// Tämä moduuli lukee saman listan eikä koskaan omaa kopiotaan siitä.
//
// -----------------------------------------------------------------------
// KUIVA-AJO EI KOSKAAN POISTA MITÄÄN
// -----------------------------------------------------------------------
// `dryRunDeletion()` on puhdas laskenta: se ottaa vastaan käyttäjän
// jo ladatun oman datan (samassa muodossa kuin buildUserDataExport())
// ja kertoo mitä poisto TEKISI — rivimäärät, tallennustiedostojen
// kategoriat (ei ole yhtään, ks. alla) ja onko auth-tili ylipäätään
// poistettavissa nykyisellä backendillä. Se ei koske tietokantaan,
// tiedostojärjestelmään eikä Supabaseen millään tavalla.

import { EXPORTED_COLLECTIONS } from './dataExport.js';

export { EXPORTED_COLLECTIONS as ACCOUNT_OWNED_COLLECTIONS };

/**
 * Tallennustiedostojen kategoriat, joita tilin poisto koskisi.
 *
 * TYHJÄ LISTA ON TOTUUS, EI PUUTE. Kuitin ja laskun kuvaa ei tallenneta
 * minnekään (ks. docs/SECURITY.md "Kuitin kuva" ja
 * src/domain/receipts.js, jossa ei ole kuvakenttää). Profiilikuvaa tai
 * muuta tiedostotallennusta ei ole toteutettu. Jos sellainen joskus
 * lisätään, se on lisättävä TÄHÄN LISTAAN ensin — muuten poisto jättäisi
 * tiedoston orvoksi.
 */
export const STORED_FILE_CATEGORIES = Object.freeze([]);

/**
 * Onko auth-käyttäjän poisto (auth.users-rivi) mahdollista nykyisellä
 * backendillä?
 *
 * EI, PYSYVÄSTI KUNNES PÄÄTETÄÄN TOISIN. `auth.users`-rivin poisto vaatii
 * Supabasen korotetun palvelinoikeuden (ks. docs/SECURITY.md,
 * "Salaisuudet"-taulukon viimeinen rivi), jota tämä repo tarkoituksella
 * ei sisällä missään — ei selaimessa, ei `api/`-hakemistossa. Tämä ei
 * ole unohdus vaan tietoinen rajaus (lukittu testillä
 * tests/security-invariants.test.mjs), jonka poistaminen vaatii
 * erillisen infrastruktuuripäätöksen: esim. Supabase Edge Function,
 * jossa korotettu oikeus elää Supabasen puolella eikä Vercelin
 * ympäristömuuttujissa. Ks. docs/ACCOUNT-DELETION.md.
 */
export function authAccountDeletable() {
  return false;
}

/** Ihmisluettava syy, jos auth-tiliä ei voi poistaa. */
export function authAccountBlockedReason() {
  return 'Tilin auth-rivin poisto vaatii palvelinpuolen korotettua oikeutta, '
    + 'jota tässä sovelluksessa ei ole toteutettu (ks. docs/ACCOUNT-DELETION.md).';
}

/**
 * Kuiva-ajo: mitä tilin poisto vaikuttaisi, ilman että mitään poistetaan.
 *
 * @param {object} data Kokoelmat nimillä (sama muoto kuin buildUserDataExport():lle)
 * @returns {{
 *   collections: Array<{name:string, count:number}>,
 *   totalRows: number,
 *   storedFileCategories: string[],
 *   authDeletable: boolean,
 *   blockers: string[]
 * }}
 */
export function dryRunDeletion(data = {}) {
  const collections = EXPORTED_COLLECTIONS.map(name => {
    const value = data[name];
    const count = Array.isArray(value) ? value.length : (value && typeof value === 'object' ? 1 : 0);
    return { name, count };
  });

  const totalRows = collections.reduce((sum, entry) => sum + entry.count, 0);
  const authDeletable = authAccountDeletable();
  const blockers = authDeletable ? [] : [authAccountBlockedReason()];

  return {
    collections,
    totalRows,
    storedFileCategories: [...STORED_FILE_CATEGORIES],
    authDeletable,
    blockers
  };
}

/**
 * Testi, jonka pitäisi kaatua, jos joku käyttäjän omistama tietotyyppi
 * lisätään vientiin/tilaan mutta unohdetaan täältä.
 *
 * TÄMÄ MODUULI EI VOI KAATUA ITSESTÄÄN, KOSKA SE LUKEE SAMAN LISTAN —
 * mutta tests/account-lifecycle.test.mjs todistaa erikseen, että
 * EXPORTED_COLLECTIONS itse kattaa src/app/state.js:n kokoelmakentät.
 */
export function collectionCount() {
  return EXPORTED_COLLECTIONS.length;
}
