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
  'amount', 'amountminor', 'targetminor', 'currentminor',
  // Sijainti: koordinaatti ei saa päätyä konsoliin (src/platform/geolocation.js).
  'latitude', 'longitude', 'lat', 'lng', 'lon', 'coords', 'coordinates', 'position', 'geolocation'
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

/**
 * Varoitus.
 *
 * Muita tasoja ei viedä erillisinä apureina ennen kuin niille on kutsuja:
 * viemätön rajapinta on lupaus, jota kukaan ei lunasta. Taso annetaan
 * silloin `log()`-funktiolle suoraan.
 */
export const logWarn = (message, context) => log(LOG_LEVEL.WARN, message, context);

// ---------------------------------------------------------------- tapahtumat

const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
/** Pitkä merkkijono on lähes aina käyttäjän sisältöä (litterointi, otsikko). */
const MAX_EVENT_STRING = 60;

/**
 * Rakenteinen diagnostiikkatapahtuma: tunniste + koodit + lukumäärät.
 *
 * TÄMÄ EI OLE SISÄLLÖN LOKI. Sallitaan vain lyhyet merkkijonot (koodit,
 * tilat, operaatiotunnisteet), luvut ja totuusarvot. Pitkä merkkijono
 * korvataan, oliot ja taulukot pudotetaan, ja arkaluontoisten avainten
 * (token, koordinaatit, teksti, litterointi ...) arvot korvataan aina.
 * Tapahtuman nimi on kiinteä tunniste, ei vapaa teksti.
 *
 * Käyttö: puhe, komennot, tilin poisto, sijainti, lähtö ja offline-jono
 * kirjaavat tällä VAIN mitä tapahtui ja miten se päättyi -- ei mitä
 * käyttäjä sanoi tai missä hän oli.
 *
 * @param {string} event esim. 'offline.replay'
 * @param {Record<string, string|number|boolean|null>} [fields]
 * @param {string} [level] LOG_LEVEL; oletus INFO
 */
export function logEvent(event, fields = {}, level = LOG_LEVEL.INFO) {
  if (typeof event !== 'string' || !EVENT_NAME.test(event)) return;

  const safe = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (SENSITIVE.has(key.toLowerCase())) { safe[key] = REDACTED; continue; }
    if (typeof value === 'string') safe[key] = value.length > MAX_EVENT_STRING ? '[pitkä]' : value;
    else if (typeof value === 'number') safe[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === 'boolean' || value === null) safe[key] = value;
    // oliot, taulukot, funktiot: pudotetaan
  }
  log(level, event, safe);
}
