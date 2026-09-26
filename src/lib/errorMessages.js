// Virheen syy -> käyttäjälle näytettävä suomenkielinen viesti.
//
// YKSI PAIKKA KAIKELLE VIRHETEKSTILLE, JOKA RIIPPUU SYYSTÄ.
//
// Aiemmin jokainen repositorio palautti yhden kiinteän viestin
// operaatiota kohti. Verkkokatko, vanhentunut istunto, ajamaton migraatio,
// kahden laitteen uniikkikilpa ja palvelimen hylkäys näyttivät kaikki
// saman "Tallennus ei onnistunut." -- käyttäjä ei voinut tietää, auttaako
// uusi yritys, pitääkö kirjautua uudelleen vai onko tieto jo tallessa.
//
// LUOKITTELU EI OLE TÄSSÄ. Syy luokitellaan src/domain/offlineQueue.js:n
// classifyError-funktiolla -- samoilla luokilla, joilla offline-jono ja
// aikakirjausten lähtökori päättävät uudelleenyrityksestä. Erillistä
// luokittelua ei saa syntyä: silloin viesti ja toisto erkanisivat. lib-kerros
// ei saa importoida domainia (tests/architecture.test.mjs), joten kutsuja
// antaa luokan (`errorClass`); repositorioille sen tekee src/data/repoErrors.js.
//
// PERIAATE: viesti ei koskaan sisällä koodia, taulun tai rajoitteen nimeä,
// palvelimen tekstiä eikä käyttäjän arvoja. Rajoitteen NIMI luetaan
// syyn viestistä vain avaimeksi kiinteään viestitaulukkoon.

import { ERROR_CODE } from './result.js';

/**
 * classifyError-luokkien arvot (src/domain/offlineQueue.js ERROR_CLASS).
 * Kopio vain siksi, ettei lib importoi domainia; testi pitää ne samoina.
 */
export const DESCRIBED_CLASSES = Object.freeze([
  'network', 'auth', 'duplicate', 'schema', 'unavailable', 'rejected', 'unknown'
]);

/** Operaatiot, joiden mukaan sanamuoto valitaan. */
export const ERROR_OP = Object.freeze({ LOAD: 'load', SAVE: 'save', DELETE: 'delete' });

const DEFAULT_FALLBACK = Object.freeze({
  load: 'Tietojen lataus ei onnistunut.',
  save: 'Tallennus ei onnistunut.',
  delete: 'Poisto ei onnistunut.'
});

const NETWORK = Object.freeze({
  load: 'Ei yhteyttä palvelimeen. Näet viimeksi ladatut tiedot.',
  save: 'Ei yhteyttä palvelimeen. Muutosta ei tallennettu – yritä uudelleen, kun yhteys toimii.',
  delete: 'Ei yhteyttä palvelimeen. Mitään ei poistettu – yritä uudelleen, kun yhteys toimii.'
});

const AUTH = Object.freeze({
  load: 'Kirjautumisesi on vanhentunut. Kirjaudu uudelleen sisään, niin tiedot latautuvat.',
  save: 'Kirjautumisesi on vanhentunut. Kirjaudu uudelleen sisään – muutosta ei tallennettu.',
  delete: 'Kirjautumisesi on vanhentunut. Kirjaudu uudelleen sisään – mitään ei poistettu.'
});

const SCHEMA = Object.freeze({
  load: 'Tätä tietoa ei voi vielä ladata palvelimelta (päivitys kesken). Mitään ei kadonnut.',
  save: 'Tätä tietoa ei voi vielä tallentaa palvelimelle (päivitys kesken). Mitään ei tallennettu.',
  delete: 'Tätä tietoa ei voi vielä muuttaa palvelimella (päivitys kesken). Mitään ei poistettu.'
});

const UNAVAILABLE = Object.freeze({
  load: 'Palvelu ei vastannut juuri nyt. Näet viimeksi ladatut tiedot – yritä hetken päästä uudelleen.',
  save: 'Palvelu ei vastannut juuri nyt. Muutosta ei tallennettu – yritä hetken päästä uudelleen.',
  delete: 'Palvelu ei vastannut juuri nyt. Mitään ei poistettu – yritä hetken päästä uudelleen.'
});

const REJECTED = Object.freeze({
  save: 'Palvelin ei hyväksynyt tietoja. Tarkista kentät ja yritä uudelleen.',
  delete: 'Palvelin ei hyväksynyt poistoa. Päivitä näkymä ja yritä uudelleen.'
});

/** Käyttöoikeus puuttuu (42501, 403): RLS hylkäsi, istunto ei vastaa riviä. */
const PERMISSION = 'Sinulla ei ole oikeutta tähän tietoon. Kirjaudu uudelleen sisään.';

/** Kohde puuttuu: poistettu toisella laitteella tai RLS suodatti sen pois. */
export const NOT_FOUND_MESSAGE = 'Kohdetta ei enää ole – se on ehkä poistettu toisella laitteella. Päivitä näkymä.';

/** Vierasavain (23503): liitetty kohde on poistunut, tai poistettavaan viitataan. */
const MISSING_REFERENCE = Object.freeze({
  save: 'Liitettyä kohdetta ei enää ole – se on ehkä poistettu toisella laitteella. Päivitä näkymä.',
  delete: 'Kohdetta ei voi poistaa, koska muut tiedot viittaavat siihen. Päivitä näkymä.'
});

/** Uniikkirikkomus, jonka rajoitetta ei tunneta. */
const DUPLICATE_DEFAULT = 'Sama tieto on jo tallennettu, ehkä toisella laitteella. Päivitä näkymä.';

/**
 * Kahden laitteen kilpailu: uniikkirajoitteen nimi -> viesti.
 * Nimet ovat supabase/migrations/-tiedostoista. Viesti kertoo, mikä on jo
 * olemassa ja mitä tehdä -- ei rajoitteen nimeä.
 */
export const CONFLICT_MESSAGES = Object.freeze({
  life_areas_name_unique: 'Sinulla on jo tämänniminen elämänalue. Päivitä näkymä, jos et näe sitä.',
  life_areas_category_unique: 'Kategoria on jo kytketty toiseen alueeseen. Päivitä näkymä.',
  weekly_capacities_week_unique:
    'Tämän viikon kapasiteetti on jo tallennettu toisella laitteella. Päivitä näkymä ja yritä uudelleen.',
  alignment_reviews_week_unique:
    'Tämän viikon katsaus on jo tallennettu toisella laitteella. Pohdintasi on yhä kentässä – päivitä näkymä ja tallenna uudelleen.',
  running_timers_one_per_user: 'Ajastin on jo käynnissä toisella laitteella. Pysäytä se ensin.',
  alignment_item_settings_item_unique:
    'Tämän kohteen Suunta-asetukset on jo tallennettu toisella laitteella. Päivitä näkymä.',
  time_entries_operation_unique: 'Tämä aika on jo kirjattu, ehkä toisella laitteella. Päivitä näkymä.',
  wellbeing_entries_unique_day: 'Tälle päivälle on jo hyvinvointimerkintä. Päivitä näkymä ja muokkaa sitä.',
  routine_exceptions_unique_day: 'Rutiinilla on jo poikkeus tälle päivälle. Päivitä näkymä.',
  notices_key_unique: 'Sama ilmoitus on jo tallennettu. Päivitä näkymä.'
});

/** Rajoitteen nimi PostgreSQL:n viestistä, tai null. Nimi on skeemaa, ei käyttäjän tietoa. */
export function constraintNameOf(cause) {
  const source = (cause && cause.cause) || cause || {};
  const match = /(?:unique|exclusion) constraint "([a-z0-9_]+)"/.exec(String(source.message || ''));
  return match ? match[1] : null;
}

function opOf(op) {
  return op === ERROR_OP.LOAD || op === ERROR_OP.DELETE ? op : ERROR_OP.SAVE;
}

function classOf(errorClass, offline) {
  const kind = DESCRIBED_CLASSES.includes(errorClass) ? errorClass : 'unknown';
  // Laite tietää olevansa offline: tuntematon tai "palvelin ei vastaa"
  // on silloin verkko (sama sääntö kuin classifyError 5xx:lle offline).
  if (offline && (kind === 'unknown' || kind === 'unavailable')) return 'network';
  return kind;
}

/**
 * Kuvaa epäonnistuminen käyttäjälle.
 *
 * @param {unknown} cause AppError (`.cause`) tai suora Supabase-virhe
 * @param {object} [context]
 * @param {'load'|'save'|'delete'} [context.op]
 * @param {string} [context.table] vain lokitukseen/avaimeksi, ei koskaan viestiin
 * @param {boolean} [context.offline]
 * @param {string} [context.errorClass] classifyError(cause, {offline}) -tulos
 * @param {string} [context.fallback] kiinteä operaatiokohtainen teksti tuntemattomalle syylle
 * @returns {{code: string, userMessage: string, errorClass: string}}
 */
export function describeError(cause, {
  op = ERROR_OP.SAVE, offline = false, errorClass = 'unknown', fallback = null
} = {}) {
  const operation = opOf(op);
  const kind = classOf(errorClass, offline);
  const source = (cause && cause.cause) || cause || {};
  const code = String(source.code ?? '');
  const status = Number(source.status ?? 0);
  const described = (errorCode, userMessage) => ({ code: errorCode, userMessage, errorClass: kind });

  switch (kind) {
    case 'network':
      return described(ERROR_CODE.NETWORK_ERROR, NETWORK[operation]);
    case 'auth':
      return described(ERROR_CODE.AUTH_REQUIRED, AUTH[operation]);
    case 'schema':
      return described(ERROR_CODE.PERSISTENCE_UNAVAILABLE, SCHEMA[operation]);
    case 'unavailable':
      return described(ERROR_CODE.SERVICE_UNAVAILABLE, UNAVAILABLE[operation]);
    case 'duplicate': {
      const name = constraintNameOf(cause);
      return described(ERROR_CODE.CONFLICT, (name && CONFLICT_MESSAGES[name]) || DUPLICATE_DEFAULT);
    }
    case 'rejected':
      if (code === '42501' || status === 403) return described(ERROR_CODE.PERMISSION_DENIED, PERMISSION);
      if (code === 'PGRST116' || status === 404) return described(ERROR_CODE.NOT_FOUND, NOT_FOUND_MESSAGE);
      if (code === '23503' && operation !== ERROR_OP.LOAD) {
        return described(ERROR_CODE.CONFLICT, MISSING_REFERENCE[operation]);
      }
      if (operation !== ERROR_OP.LOAD) return described(ERROR_CODE.VALIDATION_ERROR, REJECTED[operation]);
      break;
    default:
      break;
  }
  const text = typeof fallback === 'string' && fallback ? fallback : DEFAULT_FALLBACK[operation];
  return described(ERROR_CODE.UNKNOWN, text);
}

// ------------------------------------------------------ latauksen kooste

/** Tasapelissä järjestys: verkko ensin (yleisin ja päivitys auttaa), sitten istunto. */
const CLASS_PRIORITY = Object.freeze(['network', 'auth', 'unavailable', 'schema', 'rejected', 'duplicate', 'unknown']);

/**
 * Yleisin luokka. Yksi kooste yhdestä syystä: kaksi tusinaa epäonnistunutta
 * kokoelmaa samasta verkkokatkosta on yksi viesti, ei kaksi tusinaa.
 *
 * @param {string[]} classes classifyError-tulokset
 * @returns {string|null}
 */
export function dominantClass(classes = []) {
  const counts = new Map();
  for (const kind of classes) {
    const key = DESCRIBED_CLASSES.includes(kind) ? kind : 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  for (const kind of CLASS_PRIORITY) {
    const count = counts.get(kind) || 0;
    if (count > 0 && (best === null || count > counts.get(best))) best = kind;
  }
  return best;
}

const LOAD_SUMMARY = Object.freeze({
  network: 'Osa tiedoista ei latautunut. Mitään ei kadonnut — päivitä, kun yhteys toimii.',
  auth: 'Kirjautumisesi on vanhentunut, joten tietoja ei saatu ladattua. Kirjaudu uudelleen sisään — mitään ei kadonnut.',
  schema: 'Osa tiedoista ei ole vielä käytettävissä, koska palvelua päivitetään. Mitään ei kadonnut.',
  unavailable: 'Palvelu ei vastannut juuri nyt, joten osa tiedoista ei latautunut. Mitään ei kadonnut — yritä hetken päästä uudelleen.',
  other: 'Osa tiedoista ei latautunut. Mitään ei kadonnut — yritä hetken päästä uudelleen.'
});

/**
 * Latauksen kooste yleisimmän syyn mukaan. SKEEMA- TAI ISTUNTOVIRHE EI
 * OLE YHTEYSVIRHE: "päivitä, kun yhteys toimii" johtaisi harhaan, kun
 * päivitys ei auttaisi.
 *
 * @param {string[]} classes
 */
export function loadSummaryMessage(classes = []) {
  const kind = dominantClass(classes);
  return LOAD_SUMMARY[kind] || LOAD_SUMMARY.other;
}

const LOAD_ADVICE = Object.freeze({
  network: 'Päivitä, kun yhteys toimii.',
  auth: 'Kirjaudu uudelleen sisään, niin ne latautuvat.',
  schema: 'Palvelua päivitetään; ne tulevat näkyviin, kun päivitys on valmis.',
  other: 'Yritä hetken päästä uudelleen.'
});

/**
 * Näkymän tyhjän tilan korvaava ohje (lataus epäonnistui): mitä tehdä,
 * valittuna yleisimmän syyn mukaan.
 *
 * @param {string[]} classes
 */
export function loadAdvice(classes = []) {
  const kind = dominantClass(classes);
  return LOAD_ADVICE[kind] || LOAD_ADVICE.other;
}

// ------------------------------------------------------ AI-päätepisteet

const AI_MESSAGES = Object.freeze({
  capture: Object.freeze({
    auth: 'Kirjautumisesi on vanhentunut. Kirjaudu uudelleen sisään.',
    tooLarge: 'Teksti on liian pitkä.',
    rateLimited: 'Liian monta pyyntöä. Odota hetki.',
    unavailable: 'Palvelu ei juuri nyt vastaa. Rivi on tallessa saapuvissa.',
    rejected: 'Palvelu ei hyväksynyt pyyntöä. Rivi on tallessa saapuvissa.'
  }),
  image: Object.freeze({
    auth: 'Kirjautumisesi on vanhentunut. Kirjaudu uudelleen sisään.',
    tooLarge: 'Kuva on liian suuri.',
    rateLimited: 'Liian monta pyyntöä. Odota hetki.',
    unavailable: 'Kuvan lukeminen ei juuri nyt onnistu. Yritä hetken päästä uudelleen.',
    rejected: 'Kuvaa ei voitu lukea. Kokeile toista kuvaa.'
  })
});

/**
 * AI-päätepisteen HTTP-tila -> kiinteä viesti. Palvelimen `body.error`
 * -tekstiin EI luoteta: se voi muuttua, olla englanniksi tai (välityspalvelimen
 * virhesivulla) mitä tahansa. Sama malli kuin src/ai/commandClient.js.
 *
 * @param {number} status
 * @param {{subject?: 'capture'|'image'}} [options]
 */
export function aiEndpointMessage(status, { subject = 'capture' } = {}) {
  const copy = AI_MESSAGES[subject] || AI_MESSAGES.capture;
  const code = Number(status) || 0;
  if (code === 401 || code === 403) return copy.auth;
  if (code === 413) return copy.tooLarge;
  if (code === 429) return copy.rateLimited;
  if (code === 0 || code === 408 || code >= 500) return copy.unavailable;
  return copy.rejected;
}

// ------------------------------------------------------ yleiset

/** Odottamaton virhe (käsittelemätön lupaus tai poikkeus): yksi kiinteä viesti. */
export const UNEXPECTED_ERROR_MESSAGE = 'Toiminto ei onnistunut. Yritä uudelleen – jos vika toistuu, avaa sovellus uudelleen.';

/**
 * Käynnistyksen epäonnistumisen teksti.
 *
 * Natiivikuoressa ei ole "sivua" päivitettäväksi, ja ilman verkkoa
 * uudelleenlataus ei auta ennen kuin yhteys on palannut.
 *
 * @param {{offline?: boolean, native?: boolean}} context
 */
export function startupFailureMessage({ offline = false, native = false } = {}) {
  if (offline) {
    return native
      ? 'Sovellus ei käynnistynyt, koska verkkoyhteyttä ei ole. Tarkista yhteys ja avaa sovellus uudelleen.'
      : 'Sovellus ei käynnistynyt, koska verkkoyhteyttä ei ole. Tarkista yhteys ja lataa sivu uudelleen.';
  }
  return native
    ? 'Sovellus ei käynnistynyt. Sulje sovellus ja avaa se uudelleen.'
    : 'Sovellus ei käynnistynyt. Lataa sivu uudelleen.';
}
