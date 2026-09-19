// Lauseen alkureititys: mitä voidaan päättää ILMAN kielimallia.
//
// PUHDAS MODUULI. Kirjoitettu tai puhuttu lause on joko
//
//   HAKU        selvästi haku ("etsi ...", "löydä ...") -> hakupaneeli, ei komentoa
//   MALLI       kaikki muu -> luokittelu palvelimella (create / komento / unknown)
//
// Selvä haku ei kuulu komentoihin (COMMANDS-rekisterissä ei ole hakuintenttiä)
// eikä sitä pidä lähettää mallille: se maksaisi kutsun ja päättyisi
// "tuntematon komento" -virheeseen, vaikka käyttäjä pyysi vain hakua.
//
// KONSERVATIIVINEN: vain "etsi" ja "löydä" -alut. "Hae" jätetään pois
// tarkoituksella -- "hae lapset koulusta klo 15" on tehtävä, ei haku.
// Epäselvä lause menee mallille, joka päättää.

export const ROUTE = Object.freeze({ SEARCH: 'search', MODEL: 'model' });

/** Hakuun kuulumattomat täytesanat, jotka poistetaan hakusanasta. */
const FILLER = new Set([
  'kaikki', 'kaikkia', 'kaikkea', 'minulle', 'minun', 'liittyvät', 'liittyvä', 'liittyviä', 'liittyvät',
  'koskevat', 'koskeva', 'jotka', 'joissa', 'joilla', 'sekä', 'ja', 'tehtävät', 'tehtävä', 'tehtäviä',
  'asiat', 'asia', 'asioita', 'muistutukset', 'muistutus', 'laskut', 'lasku', 'projektit', 'projekti',
  'tavoitteet', 'tavoite', 'että', 'kaikista', 'sovelluksesta'
]);

const SEARCH_PREFIX = /^\s*(?:etsi|löydä)(?![a-zäö])[\s:,-]*/i;

/**
 * @param {string} text
 * @returns {{kind:'search', query:string}|{kind:'model'}}
 */
export function routeUtterance(text) {
  const clean = typeof text === 'string' ? text.normalize('NFC').trim() : '';
  if (!clean) return { kind: ROUTE.MODEL };

  const match = SEARCH_PREFIX.exec(clean);
  if (!match) return { kind: ROUTE.MODEL };

  const rest = clean.slice(match[0].length);
  const words = rest
    .split(/\s+/)
    .map(word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(word => word && !FILLER.has(word.toLocaleLowerCase('fi')));

  // "Etsi" ilman hakusanaa ei ole haku (eikä komento): malli/käyttäjä päättää.
  if (words.length === 0) return { kind: ROUTE.MODEL };

  return { kind: ROUTE.SEARCH, query: words.join(' ').slice(0, 100) };
}
