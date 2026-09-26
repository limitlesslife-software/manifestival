// Virheiden esittäminen niin, että käyttäjälle näytettävä viesti ja
// diagnostinen tieto pysyvät erillään.
//
// Auditoinnissa todettiin, että jokainen epäonnistunut kantakutsu päätyi vain
// console.error-lokiin: käyttöliittymä näytti onnistumista, vaikka tallennus
// epäonnistui. Tämä moduuli tekee erottelusta pakollisen.
//
// PERIAATE: käyttäjä ei koskaan näe Supabasen sisäistä viestiä, pinojälkeä
// eikä palvelimen konfiguraatiota. Kehittäjä näkee ne konsolissa -- ilman
// käyttäjän arvoja (redactDbDetail, redactQuotedValues).

import { LOG_LEVEL, logFailure as logFailureFields } from './logger.js';

/**
 * Sovellusvirhe, jolla on erikseen käyttäjäviesti ja diagnostiikka.
 */
export class AppError extends Error {
  /**
   * @param {string} userMessage  Suomenkielinen, ymmärrettävä viesti käyttäjälle.
   * @param {object} [options]
   * @param {unknown} [options.cause]  Alkuperäinen virhe (vain diagnostiikkaan).
   * @param {string}  [options.code]   Lyhyt tunniste lokitusta varten.
   * @param {string}  [options.op]     Operaatio lokitusta varten (esim. 'tasks.insert').
   *   Tyypitetyssä virheessä (failWith) koodi on ERROR_CODE-arvo, joten
   *   operaatio kulkee erikseen.
   * @param {string}  [options.errorClass] Syyn luokka, jolla viesti valittiin
   *   (src/data/repoErrors.js failFromCause). Kooste ja näkymän ohje lukevat
   *   sen eivätkä luokittele syytä uudelleen: heitetty poikkeus ilman koodia
   *   näytti muuten verkkovirheeltä.
   */
  constructor(userMessage, options = {}) {
    super(userMessage);
    this.name = 'AppError';
    this.userMessage = userMessage;
    this.code = options.code || 'unknown';
    this.op = options.op || null;
    this.cause = options.cause;
    this.errorClass = options.errorClass || null;
  }

  /** Kehittäjälle tarkoitettu esitys. Ei näytetä käyttäjälle. */
  toDiagnostic() {
    const head = this.op ? `[${this.code} ${this.op}]` : `[${this.code}]`;
    const parts = [`${head} ${this.userMessage}`];
    if (this.cause) {
      const c = redactedCause(this.cause);
      if (typeof c === 'string') parts.push(c);
      else {
        if (c.code) parts.push(String(c.code));
        if (c.message) parts.push(c.message);
        if (c.details) parts.push(c.details);
        if (c.hint) parts.push(c.hint);
      }
    }
    return parts.filter(Boolean).join(' | ');
  }
}

/** Korvaava merkintä, kun rakennetta ei tunnisteta: arvoa ei tulosteta. */
const REDACTED_DETAIL = '[poistettu]';

/**
 * PostgreSQL:n `Key (sarakkeet)=(arvot) <loppu>` -muodot. Loppu on
 * kiinteä teksti, joten arvot ovat AINA avaimen ja lopun välissä --
 * sulkeiden tasapainoon ei luoteta (nimi "Terapia (oma" tai rivinvaihto
 * pohdinnassa rikkoi aiemman sulkulaskennan).
 */
const KEY_TAILS = [
  /( already exists\.?\s*)$/,
  /( is not present in table "[^"\n]*"\.?\s*)$/,
  /( is still referenced from table "[^"\n]*"\.?\s*)$/
];

/**
 * Poista käyttäjän arvot PostgreSQL:n virhetiedoista ennen lokitusta.
 *
 * PostgRESTin `details` sisältää rivin arvot: uniikkirikkomus
 * "Key (user_id, name)=(<uuid>, <elämänalueen nimi>) already exists",
 * tarkistusrikkomus "Failing row contains (… muistiinpano, pohdinta …)".
 * Rakenne (sarakkeiden nimet, rajoite) säilyy diagnostiikkaa varten,
 * arvot korvataan. Löydös yön Suunta-tietoturvakatselmoinnissa:
 * console.error tulosti ne tuotannossakin.
 *
 * RAKENTEELLINEN, EI SULKULASKENTAA. Arvo voi sisältää rivinvaihtoja
 * (pohdinta, kuvaus), sisäkkäisiä tai parittomia sulkeita ja jopa
 * tekstin "already exists". Siksi tunnistetaan vain kiinteät osat
 * (alku "Key (…)=" tai "Failing row contains", loppu merkkijonon
 * lopussa) ja KAIKKI niiden välissä korvataan. Tuntematon muoto
 * korvataan kokonaan: mieluummin vähemmän diagnostiikkaa kuin vuoto.
 *
 * @param {unknown} detail
 * @returns {string} '' kun tietoa ei ole
 */
export function redactDbDetail(detail) {
  if (detail === null || detail === undefined || detail === '') return '';
  const text = String(detail);

  const failing = /^([\s\S]*?)Failing row contains[\s\S]*?(\.?)\s*$/.exec(text);
  if (failing) return `${redactQuotedValues(failing[1])}Failing row contains (…)${failing[2]}`;

  // Sarakeosa päättyy ensimmäiseen ")=": sarakkeiden nimissä sitä ei ole,
  // ja arvot tulevat vasta sen jälkeen.
  const key = /^([\s\S]*?Key \()([\s\S]*?)\)=[\s\S]*$/.exec(text);
  if (key) {
    const columns = /^[a-z0-9_ ,.():"]*$/i.test(key[2]) ? key[2] : '…';
    for (const tail of KEY_TAILS) {
      const end = tail.exec(text);
      if (end) return `${redactQuotedValues(key[1])}${columns})=(…)${end[1]}`;
    }
    // "conflicts with existing key (…)=(…)" ja muut: toinenkin avain
    // sisältää arvoja, joten loppu jätetään kokonaan pois.
    return `${redactQuotedValues(key[1])}${columns})=(…)`;
  }
  return REDACTED_DETAIL;
}

/**
 * Lainausmerkeissä olevat ARVOT pois virheviestistä ja vihjeestä.
 *
 * PostgreSQL toistaa syötteen viestissä: 22P02 'invalid input syntax for
 * type integer: "Salainen arvo"', 22007 'invalid input value for enum
 * …: "…"'. Kaksoispisteen jälkeinen lainaus on aina arvo; rajoitteen ja
 * taulun nimet (`constraint "x"`, `relation "y"`) säilyvät, koska ne
 * ovat skeemaa eivätkä käyttäjän tietoa. Arvo voi itse sisältää
 * lainausmerkkejä, joten KAIKKI ensimmäisen `: "` jälkeen korvataan.
 */
export function redactQuotedValues(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/:\s*"[\s\S]*$/, ': "…"');
}

/** Syyolio lokitukseen ilman käyttäjän arvoja. Ei koskaan palauta raakaa oliota. */
function redactedCause(cause) {
  if (cause === null || cause === undefined) return '';
  if (typeof cause !== 'object') {
    // Merkkijonosyy voi olla mitä tahansa (myös käyttäjän tekstiä):
    // tulostetaan vain tyyppi ja pituus.
    return typeof cause === 'string' ? `[teksti ${cause.length} merkkiä]` : String(cause);
  }
  const out = {};
  for (const key of ['code', 'status', 'name']) {
    const value = cause[key];
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  if (cause.message !== undefined && cause.message !== null) out.message = redactQuotedValues(cause.message);
  if (cause.hint !== undefined && cause.hint !== null) out.hint = redactQuotedValues(cause.hint);
  if (cause.details !== undefined && cause.details !== null) out.details = redactDbDetail(cause.details);
  return out;
}

/** Onnistunut tulos. */
export function ok(value) {
  return { ok: true, value };
}

/** Epäonnistunut tulos. */
export function fail(userMessage, options = {}) {
  return { ok: false, error: new AppError(userMessage, options) };
}


/**
 * Kirjaa virheen konsoliin diagnostisessa muodossa.
 * Erotettu omaksi funktiokseen, jotta lokitus voidaan myöhemmin ohjata muualle.
 *
 * JOKAINEN SYÖTE SUODATETAAN. Aiemmin muu kuin AppError tulostettiin
 * sellaisenaan: PostgREST-muotoinen olio vei `details`-kentän arvot ja
 * 22P02-viesti syötteen konsoliin. Nyt Error ja tavallinen olio kulkevat
 * saman suodatuksen läpi kuin AppErrorin syy.
 */
export function logError(error) {
  if (error instanceof AppError) {
    console.error('Manifestival:', error.toDiagnostic(), redactedCause(error.cause));
    return;
  }
  console.error('Manifestival:', redactedCause(error));
}

/**
 * Kirjaa epäonnistuminen tapahtumana: vain nimi, koodi ja HTTP-tila.
 *
 * Sovelluskoodin console.warn/error(…, error) tulosti koko virheolion
 * (viesti voi sisältää käyttäjän tekstiä). Tämä kirjaa vain tunnisteet.
 * Yksi toteutus: kirjaus tehdään src/lib/logger.js:n logFailure-apurilla
 * (failureFields: nimi, koodi ja tila myös syyoliosta). Tämä säilyttää
 * vain oletustason ERROR tämän moduulin kutsujille.
 *
 * @param {string} event esim. 'auth.signout_failed'
 * @param {unknown} error
 * @param {string} [level] LOG_LEVEL; oletus ERROR
 */
export function logFailure(event, error, level = LOG_LEVEL.ERROR) {
  logFailureFields(event, error, level);
}

/**
 * Sovelluksen virhekoodit.
 *
 * Tyypitetty koodi on eri asia kuin käyttäjäviesti. Viesti voi muuttua
 * kielen tai sävyn mukaan; koodi on sopimus, jota testit ja kutsuva koodi
 * voivat tarkistaa. Ilman koodia jokainen virheen käsittely päätyisi
 * vertaamaan suomenkielistä merkkijonoa — ja hajoaisi ensimmäisestä
 * sanamuodon korjauksesta.
 */
export const ERROR_CODE = Object.freeze({
  /** Syöte ei kelpaa. Käyttäjä voi korjata sen. */
  VALIDATION_ERROR: 'validation_error',
  /** Kohdetta ei ole olemassa. */
  NOT_FOUND: 'not_found',
  /** Kohteita on useita eikä oikeaa voi valita puolesta. */
  AMBIGUOUS_TARGET: 'ambiguous_target',
  /** Käyttäjällä ei ole oikeutta tähän. */
  PERMISSION_DENIED: 'permission_denied',
  /** Toimintoa ei ole toteutettu tällä alustalla. */
  UNSUPPORTED: 'unsupported',
  /** Tieto on muuttunut samanaikaisesti muualla. */
  CONFLICT: 'conflict',
  /** Kirjautuminen puuttuu tai on vanhentunut. */
  AUTH_REQUIRED: 'auth_required',
  /** Tallennus ei ole käytettävissä — esim. migraatio ajamatta. */
  PERSISTENCE_UNAVAILABLE: 'persistence_unavailable',
  /** Verkkoyhteys puuttuu tai katkesi. */
  NETWORK_ERROR: 'network_error',
  /**
   * Palvelin vastasi, mutta on tilapäisesti poissa käytöstä (503,
   * aikakatkaisu, kanta ei vastaa). Eri asia kuin verkko: laitteen
   * yhteys on kunnossa, eikä "tarkista yhteys" auttaisi.
   */
  SERVICE_UNAVAILABLE: 'service_unavailable',
  /** Tuntematon. Käytetään vain kun mikään muu ei sovi. */
  UNKNOWN: 'unknown'
});

export const ERROR_CODES = Object.freeze(Object.values(ERROR_CODE));

/** Onko koodi tunnettu? Tuntematon koodi on itsessään vika. */
export function isKnownErrorCode(code) {
  return ERROR_CODES.includes(code);
}

/**
 * Epäonnistunut tulos tyypitetyllä koodilla.
 *
 * Erillinen `fail`-funktiosta, jotta vanhat kutsupaikat toimivat
 * ennallaan ja uudet saavat tyypityksen.
 */
export function failWith(code, userMessage, options = {}) {
  return {
    ok: false,
    error: new AppError(userMessage, {
      ...options,
      code: isKnownErrorCode(code) ? code : ERROR_CODE.UNKNOWN
    })
  };
}
