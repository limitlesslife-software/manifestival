// Syotteen validointi /api/capture-paatepisteelle.
//
// Erillinen moduuli, jotta validointi voidaan testata ilman verkkokutsuja
// (tests/api-capture-validation.test.cjs). Alaviiva tiedostonimen alussa
// kertoo Vercelille, etta tama EI ole oma reitti vaan apumoduuli.
//
// ---------------------------------------------------------------
// KAYTTAJAN TEKSTI MENEE PROMPTIIN, KONTEKSTI ON LIPPUJA
// ---------------------------------------------------------------
//
// `text` on kayttajan omaa vapaata tekstia. Sita ei voi rajoittaa
// sallittuihin arvoihin -- se ON syote -- mutta sen PITUUS rajoitetaan
// ja se lahetetaan JSON-koodattuna, jolloin se ei voi katkaista
// promptin rakennetta.
//
// Kaikki muu konteksti on BOOLEANEJA ja yksi paivamaara. Boolean ei voi
// sisaltaa ohjetta eika siita voi lukea mita kayttaja tekee.
//
// Harkittiin ja hylattiin: kayttajan olemassa olevien tehtavien
// otsikoiden lahettaminen "paremman tulkinnan" vuoksi. Se olisi vienyt
// koko tehtavalistan ulos jokaisella kirjauksella ilman etta tulkinta
// sita tarvitsee.

/** Vapaan kirjaustekstin enimmaispituus. */
const MAX_TEXT_LENGTH = 1000;

/** Koko JSON-rungon enimmaiskoko tavuina. */
const MAX_BODY_BYTES = 8 * 1024;

/** Sallitut lahteet. */
const SOURCES = Object.freeze(['text', 'voice']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Sallitut viikonpaivat. Estaa mielivaltaisen tekstin ujuttamisen promptiin. */
const WEEKDAYS = Object.freeze([
  'sunnuntai', 'maanantai', 'tiistai', 'keskiviikko',
  'torstai', 'perjantai', 'lauantai'
]);

/** Kontekstin sallitut liput. Nimenomainen lista, ei poislukulista. */
const CONTEXT_FLAGS = Object.freeze([
  'financeEnabled', 'goalsEnabled', 'travelEnabled'
]);

/**
 * Validoi ja normalisoi /api/capture -pyynnon runko.
 *
 * Palauttaa joko { ok: true, value } tai { ok: false, status, error }.
 */
function validateCaptureRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Virheellinen pyyntö' };
  }

  let approxBytes;
  try {
    approxBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return { ok: false, status: 400, error: 'Virheellinen pyyntö' };
  }
  if (approxBytes > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'Pyyntö on liian suuri' };
  }

  const { text, today, weekday, source, context } = body;

  if (typeof text !== 'string') {
    return { ok: false, status: 400, error: 'Teksti puuttuu' };
  }
  const cleanText = text.trim();
  if (cleanText.length === 0) {
    return { ok: false, status: 400, error: 'Teksti puuttuu' };
  }
  if (cleanText.length > MAX_TEXT_LENGTH) {
    return { ok: false, status: 413, error: 'Teksti on liian pitkä' };
  }

  if (typeof today !== 'string' || !ISO_DATE.test(today)) {
    return { ok: false, status: 400, error: 'Virheellinen päivämäärä' };
  }
  if (Number.isNaN(Date.parse(today))) {
    return { ok: false, status: 400, error: 'Virheellinen päivämäärä' };
  }

  // Viikonpaiva menee promptiin, joten se validoidaan sallittuja arvoja
  // vastaan. Tuntematon arvo pudotetaan -- se ei ole virhe, koska
  // paivamaarasta voi paatella viikonpaivan ilmankin.
  const cleanWeekday = typeof weekday === 'string' && WEEKDAYS.includes(weekday)
    ? weekday : null;

  const cleanSource = SOURCES.includes(source) ? source : 'text';

  return {
    ok: true,
    value: {
      text: cleanText,
      today,
      weekday: cleanWeekday,
      source: cleanSource,
      context: cleanCaptureContext(context)
    }
  };
}

/**
 * Siisti konteksti.
 *
 * VAIN BOOLEANEJA. Tuntematon kentta pudotetaan hiljaa.
 *
 * Puuttuva lippu on `true` niille ominaisuuksille, jotka ovat aina
 * olemassa (talous, tavoitteet), ja `false` sille joka vaatii
 * erillisen palveluntarjoajan (matka). Oletus on siis
 * KONSERVATIIVINEN siella missa se koskee ulkoista riippuvuutta:
 * matkaehdotusta ei tehda, ellei matka-arvio ole kaytettavissa.
 */
function cleanCaptureContext(context) {
  const defaults = {
    financeEnabled: true,
    goalsEnabled: true,
    travelEnabled: false
  };

  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return defaults;
  }

  const out = { ...defaults };
  for (const flag of CONTEXT_FLAGS) {
    if (typeof context[flag] === 'boolean') out[flag] = context[flag];
  }
  return out;
}

module.exports = {
  validateCaptureRequest,
  cleanCaptureContext,
  MAX_TEXT_LENGTH,
  MAX_BODY_BYTES,
  SOURCES,
  WEEKDAYS,
  CONTEXT_FLAGS
};
