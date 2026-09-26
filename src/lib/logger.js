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
 *
 * Vertailu tehdään pienaakkosin ja ilman ala- ja väliviivoja, joten
 * `reflection_answers`, `reflectionAnswers` ja `ReflectionAnswers` ovat
 * sama kenttä.
 */
export const SENSITIVE_KEYS = Object.freeze([
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken',
  'password', 'passwordhash', 'salt', 'secret', 'clientsecret',
  'apikey', 'anonkey', 'servicerolekey', 'authorization', 'credentials',
  'email', 'user_id', 'userid',
  'note', 'notes', 'description', 'title', 'name',
  'prompt', 'input', 'text', 'transcript',
  // Suunta ja vapaa sisältö (ERR-15): pohdinnat, vastaukset, nimet ja
  // selitteet. PostgRESTin virheolion `message`, `details` ja `hint`
  // kantavat rivin arvoja ("Key (user_id, name)=(…, Terapia)").
  'reflection', 'reflectionanswers', 'answer', 'answers', 'label',
  'detail', 'details', 'hint', 'message', 'metric', 'unit', 'summary',
  'content', 'body', 'query',
  'energy', 'mood', 'stress', 'sleephours',
  'amount', 'amountminor', 'targetminor', 'currentminor',
  // Sijainti: koordinaatti ei saa päätyä konsoliin (src/platform/geolocation.js).
  'latitude', 'longitude', 'lat', 'lng', 'lon', 'coords', 'coordinates', 'position', 'geolocation'
]);

const SENSITIVE = new Set(SENSITIVE_KEYS);

/** Onko kentän nimi arkaluontoinen? Kirjainkoko ja `_`/`-` eivät ratkaise. */
export function isSensitiveKey(key) {
  const lower = String(key).toLowerCase();
  return SENSITIVE.has(lower) || SENSITIVE.has(lower.replace(/[_-]/g, ''));
}

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
      cleaned[key] = isSensitiveKey(key)
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
 *
 * NATIIVIKUORI EI OLE KEHITYSYMPÄRISTÖ (ERR-16). Capacitorin Android-
 * sovelluksen origin on https://localhost, joten pelkkä isäntänimi
 * päästäisi INFO- ja DEBUG-tapahtumat logcatiin puhelimella. Sama
 * tarkistus kuin src/platform/capabilities.js:n isNativeShell(); lib-
 * kerros ei saa tuoda platform-kerrosta, joten se toistetaan tässä.
 */
export function isDevEnvironment() {
  if (isNativeRuntime()) return false;
  if (typeof globalThis.location === 'undefined') return true; // testit, Node
  const host = String(globalThis.location.hostname || '');
  return host === 'localhost' || host === '127.0.0.1' || host === '';
}

function isNativeRuntime() {
  try {
    const cap = globalThis.Capacitor;
    return Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  } catch {
    // Rikkinäinen silta ei tee ympäristöstä kehitysympäristöä.
    return true;
  }
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
 * Koodin näköinen merkkijono: tunniste, tila, operaatio, virhekoodi.
 *
 * Välilyönti, skandinaavinen kirjain tai välimerkki tarkoittaa lähes aina
 * ihmisen kirjoittamaa tekstiä ("Terapia ryhmä", "Äiti"). Sellainen ei
 * päädy lokiin edes avaimella, jota ei ole listattu arkaluontoiseksi.
 */
const CODE_LIKE = /^[a-z0-9_.:-]{1,60}$/i;

/** Korvausmerkintä vapaalle tekstille, joka ei ole koodi. */
export const FREE_TEXT = '[teksti]';

/** Korvausmerkintä liian pitkälle merkkijonolle. */
export const LONG_TEXT = '[pitkä]';

/** Tapahtuman merkkijonoarvo: koodi säilyy, muu teksti korvataan. */
function eventString(value) {
  if (value === '') return '';
  if (value.length > MAX_EVENT_STRING) return LONG_TEXT;
  return CODE_LIKE.test(value) ? value : FREE_TEXT;
}

/**
 * Rakenteinen diagnostiikkatapahtuma: tunniste + koodit + lukumäärät.
 *
 * TÄMÄ EI OLE SISÄLLÖN LOKI. Sallitaan vain koodin näköiset merkkijonot
 * (koodit, tilat, operaatiotunnisteet), luvut ja totuusarvot. Pitkä
 * merkkijono ja vapaa teksti korvataan, oliot ja taulukot pudotetaan, ja
 * arkaluontoisten avainten (token, koordinaatit, teksti, nimi, pohdinta
 * ...) arvot korvataan aina. Tapahtuman nimi on kiinteä tunniste, ei
 * vapaa teksti.
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
    if (isSensitiveKey(key)) { safe[key] = REDACTED; continue; }
    if (typeof value === 'string') safe[key] = eventString(value);
    else if (typeof value === 'number') safe[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === 'boolean' || value === null) safe[key] = value;
    // oliot, taulukot, funktiot: pudotetaan
  }
  log(level, event, safe);
}

// ---------------------------------------------------------------- virheet

/** Koodin näköinen arvo virheoliosta, tai null. */
function codeOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return typeof value === 'string' && CODE_LIKE.test(value) ? value : null;
}

/** HTTP-tila luvuksi, tai null. */
function statusOf(value) {
  const number = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return Number.isInteger(number) && number >= 0 && number <= 999 ? number : null;
}

/**
 * Virheen diagnostiikka ilman sisältöä: nimi, koodi ja HTTP-tila.
 *
 * VIESTI, `details` JA `hint` JÄÄVÄT POIS. PostgRESTin virheolio kantaa
 * niissä rivin arvoja (uniikkirikkomus: "Key (user_id, name)=(…,
 * Terapia)", tarkistusrikkomus: "Failing row contains (…, pohdinta)"), ja
 * selaimen virheviesti voi sisältää URL:n kyselyineen. Nimi ja koodi
 * kertovat kehittäjälle, MIKÄ epäonnistui, ilman että käyttäjän
 * päiväkirja päätyy konsoliin tai logcatiin.
 *
 * Sisäkkäinen `cause` (AppError, Supabasen kääre) luetaan, jos
 * ulomman virheen kentät puuttuvat.
 *
 * @returns {{errorName: string|null, code: string|number|null, status: number|null}}
 */
export function failureFields(error) {
  if (!error || typeof error !== 'object') {
    return { errorName: error === undefined ? 'undefined' : typeof error, code: null, status: null };
  }
  const cause = error.cause && typeof error.cause === 'object' ? error.cause : null;
  const pick = (key, read) => {
    const own = read(error[key]);
    return own !== null ? own : (cause ? read(cause[key]) : null);
  };
  return {
    errorName: pick('name', codeOf),
    code: pick('code', codeOf),
    status: pick('status', statusOf)
  };
}

/**
 * Kirjaa epäonnistuminen: tapahtuman tunniste + failureFields(error).
 *
 * Korvaa kutsut muotoa `console.warn('…', error)`, jotka tulostivat
 * raa'an virheolion viesteineen ja rivin arvoineen. Oletustaso on WARN,
 * joten tapahtuma näkyy myös tuotannossa — ilman sisältöä.
 *
 * @param {string} event  kiinteä tunniste, esim. 'offline.replay_failed'
 * @param {unknown} error
 * @param {string} [level] LOG_LEVEL; oletus WARN
 */
export function logFailure(event, error, level = LOG_LEVEL.WARN) {
  if (typeof event !== 'string' || !EVENT_NAME.test(event)) return;
  log(level, event, failureFields(error));
}
