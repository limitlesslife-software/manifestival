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

// SAAPUVAT (aalto L): selvä kirjaus ("muista että ...", "kirjaa ...",
// "saapuviin ...") tallennetaan Saapuviin sellaisenaan, ilman päätöksiä.
export const ROUTE = Object.freeze({ SEARCH: 'search', MODEL: 'model', INBOX: 'inbox' });

/** Hakuun kuulumattomat täytesanat, jotka poistetaan hakusanasta. */
const FILLER = new Set([
  'kaikki', 'kaikkia', 'kaikkea', 'minulle', 'minun', 'liittyvät', 'liittyvä', 'liittyviä', 'liittyvät',
  'koskevat', 'koskeva', 'jotka', 'joissa', 'joilla', 'sekä', 'ja', 'tehtävät', 'tehtävä', 'tehtäviä',
  'asiat', 'asia', 'asioita', 'muistutukset', 'muistutus', 'laskut', 'lasku', 'projektit', 'projekti',
  'tavoitteet', 'tavoite', 'että', 'kaikista', 'sovelluksesta'
]);

const SEARCH_PREFIX = /^\s*(?:etsi|löydä)(?![a-zäö])[\s:,-]*/i;

/**
 * Kirjaus Saapuviin. "muista" ei ole "muistuta" (muistutus on komento), ja
 * "kirjaa aikaa" / "kirjaa 30 min" on ajan kirjaus, ei saapuva asia.
 * Paljas "kirjaa ..." merkitään (`bare`), jotta kutsuja voi antaa selvän
 * menolauseen ("kirjaa parturi huomenna klo 16") kulkea menon luontiin.
 */
const INBOX_PREFIX = /^\s*(muista(?:\s+että)?|kirjaa\s+(?:saapuviin|muistiin|ylös)|saapuviin|kirjaa)(?![a-zäö])[\s:,-]*/;
const NOT_INBOX_AFTER_KIRJAA = /^(?:aika|aikaa|\d)(?![a-zäö])/;

/** Saapuviin kirjaus, tai null. Teksti säilyy käyttäjän kirjoitusasussa. */
function inboxRoute(clean) {
  const lower = clean.toLocaleLowerCase('fi');
  const match = INBOX_PREFIX.exec(lower);
  if (!match || lower.length !== clean.length) return null;
  const rest = clean.slice(match[0].length).trim();
  if (!/[\p{L}\p{N}]/u.test(rest)) return null;
  const bare = match[1] === 'kirjaa';
  if (bare && NOT_INBOX_AFTER_KIRJAA.test(rest.toLocaleLowerCase('fi'))) return null;
  return { kind: ROUTE.INBOX, text: rest.slice(0, 8000), bare };
}

/**
 * @param {string} text
 * @returns {{kind:'search', query:string}|{kind:'model'}}
 */
export function routeUtterance(text) {
  const clean = typeof text === 'string' ? text.normalize('NFC').trim() : '';
  if (!clean) return { kind: ROUTE.MODEL };

  const inbox = inboxRoute(clean);
  if (inbox) return inbox;

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
