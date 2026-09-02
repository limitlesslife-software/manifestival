// Turvallinen lokitus.
//
// PUHDAS MODUULI siinä mielessä, että se ei tunne sovelluslogiikkaa. Se
// koskee konsoliin, koska se on lokin ainoa mielekäs kohde.
//
// ---------------------------------------------------------------------
// PERIAATE: LOKI EI SAA VUOTAA SITÄ, MITÄ SE KIRJAA
// ---------------------------------------------------------------------
// Loki päätyy kehittäjäkonsoliin, ruudunkaappauksiin, tukipyyntöihin ja
// mahdollisesti joskus tiedostoon. Siihen ei kuulu:
//
//   - tokenit ja avaimet
//   - sähköpostiosoitteet
//   - AI:lle annetut raakasyötteet
//   - terveys- ja hyvinvointimerkinnät
//   - talousmuistiinpanot ja summat
//   - tehtävien ja tavoitteiden sisältö
//
// Tämä ei ole varovaisuutta vaan välttämättömyys: käyttäjän oma
// päiväkirja ei saa päätyä konsoliin siksi, että joku halusi debugata
// tallennusta.
//
// ULKOISTA TELEMETRIAA EI OLE. Mikään ei lähde laitteelta.

/** Lokitasot. */
export const LOG_LEVEL = Object.freeze({
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error'
});

/**
 * Kenttien nimet, joiden ARVO korvataan aina.
 *
 * Suodatus tehdään nimen perusteella, jotta uusi arkaluontoinen kenttä
 * putoaa pois ilman että kukaan muistaa lisätä sääntöä.
 */
export const SENSITIVE_KEYS = Object.freeze([
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken',
  'password', 'passwordhash', 'salt', 'secret', 'clientsecret',
  'apikey', 'anonkey', 'servicerolekey', 'authorization', 'credentials',
  'email', 'user_id', 'userid',
  'note', 'notes', 'description', 'title', 'name',
  'prompt', 'input', 'text', 'transcript',
  'energy', 'mood', 'stress', 'sleephours',
  'amount', 'amountminor', 'targetminor', 'currentminor'
]);

const SENSITIVE = new Set(SENSITIVE_KEYS);

/** Korvausmerkintä. Kertoo että kenttä oli olemassa mutta ei sen arvoa. */
export const REDACTED = '[poistettu]';

/**
 * Korvaa arkaluontoiset arvot rekursiivisesti.
 *
 * Kenttä SÄILYY, arvo korvataan: "note: [poistettu]" kertoo että
 * muistiinpano oli olemassa, mikä on usein juuri se mitä debugatessa
 * tarvitaan — ilman että sisältö vuotaa.
 */
export function redactForLog(value, depth = 0) {
  if (depth > 8) return REDACTED;

  if (Array.isArray(value)) {
    // Pitkä lista lyhennetään: sata riviä konsolissa hukuttaa olennaisen.
    const head = value.slice(0, 5).map(item => redactForLog(item, depth + 1));
    return value.length > 5 ? [...head, `…${value.length - 5} muuta`] : head;
  }

  if (value && typeof value === 'object') {
    const cleaned = {};
    for (const [key, item] of Object.entries(value)) {
      cleaned[key] = SENSITIVE.has(key.toLowerCase())
        ? REDACTED
        : redactForLog(item, depth + 1);
    }
    return cleaned;
  }

  return value;
}

/**
 * Onko kehitysympäristö?
 *
 * Tuotannossa vain varoitukset ja virheet kirjataan. Kehityksessä myös
 * debug — mutta samalla suodatuksella, koska kehittäjän kone ei ole sen
 * turvallisempi paikka käyttäjän päiväkirjalle.
 */
export function isDevEnvironment() {
  if (typeof globalThis.location === 'undefined') return true; // testit, Node
  const host = String(globalThis.location.hostname || '');
  return host === 'localhost' || host === '127.0.0.1' || host === '';
}

const LEVEL_ORDER = Object.freeze({
  [LOG_LEVEL.DEBUG]: 10,
  [LOG_LEVEL.INFO]: 20,
  [LOG_LEVEL.WARN]: 30,
  [LOG_LEVEL.ERROR]: 40
});

function minimumLevel() {
  return isDevEnvironment() ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN;
}

/**
 * Kirjaa tapahtuma.
 *
 * @param {string} level   LOG_LEVEL
 * @param {string} message Kiinteä teksti — EI käyttäjän sisältöä
 * @param {object} [context] Rakenteinen konteksti, suodatetaan
 */
export function log(level, message, context = null) {
  const wanted = LEVEL_ORDER[level] ?? LEVEL_ORDER[LOG_LEVEL.INFO];
  if (wanted < LEVEL_ORDER[minimumLevel()]) return;

  const payload = context === null || context === undefined
    ? undefined
    : redactForLog(context);

  const prefix = `Manifestival [${level}]`;
  const target = level === LOG_LEVEL.ERROR
    ? console.error
    : level === LOG_LEVEL.WARN ? console.warn : console.log;

  if (payload === undefined) target(prefix, message);
  else target(prefix, message, payload);
}

export const logDebug = (message, context) => log(LOG_LEVEL.DEBUG, message, context);
export const logInfo = (message, context) => log(LOG_LEVEL.INFO, message, context);
export const logWarn = (message, context) => log(LOG_LEVEL.WARN, message, context);
export const logFailure = (message, context) => log(LOG_LEVEL.ERROR, message, context);
