// Syotteen validointi /api/parse-paatepisteelle.
//
// Erillinen moduuli, jotta validointi voidaan testata ilman verkkokutsuja
// (tests/api-validation.test.cjs). Alaviiva tiedostonimen alussa kertoo
// Vercelille, etta tama EI ole oma reitti vaan apumoduuli.
//
// Tiedostonimet ilman alaviivaa hakemistossa api/ muuttuvat julkisiksi
// HTTP-paatepisteiksi — sita ei haluta tassa.

/** Puhekomennon enimmaispituus. Pidempi ei ole realistinen ja kuluttaisi turhaan tokeneita. */
const MAX_TRANSCRIPT_LENGTH = 1000;

/** Koko JSON-runkon enimmaiskoko tavuina. Suojaa suurilta payloadeilta. */
const MAX_BODY_BYTES = 8 * 1024;

/** Sallitut viikonpaivat. Estaa mielivaltaisen tekstin ujuttamisen promptiin. */
const WEEKDAYS = Object.freeze([
  'sunnuntai', 'maanantai', 'tiistai', 'keskiviikko',
  'torstai', 'perjantai', 'lauantai'
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validoi ja normalisoi /api/parse -pyynnon rungon.
 *
 * Palauttaa joko { ok: true, value } tai { ok: false, status, error }.
 * Virheviesti on aina turvallinen naytettavaksi clientille — se ei
 * paljasta palvelimen sisaista tilaa.
 */
function validateParseRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Virheellinen pyyntö' };
  }

  // Kokoraja ennen muuta kasittelya.
  let approxBytes;
  try {
    approxBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return { ok: false, status: 400, error: 'Virheellinen pyyntö' };
  }
  if (approxBytes > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'Pyyntö on liian suuri' };
  }

  const { transcript, today, weekday } = body;

  if (typeof transcript !== 'string') {
    return { ok: false, status: 400, error: 'Puhekomento puuttuu' };
  }
  const cleanTranscript = transcript.trim();
  if (cleanTranscript.length === 0) {
    return { ok: false, status: 400, error: 'Puhekomento puuttuu' };
  }
  if (cleanTranscript.length > MAX_TRANSCRIPT_LENGTH) {
    return { ok: false, status: 413, error: 'Puhekomento on liian pitkä' };
  }

  // today ja weekday menevat suoraan promptiin, joten ne validoidaan tiukasti.
  if (typeof today !== 'string' || !ISO_DATE.test(today)) {
    return { ok: false, status: 400, error: 'Virheellinen päivämäärä' };
  }
  if (Number.isNaN(Date.parse(today))) {
    return { ok: false, status: 400, error: 'Virheellinen päivämäärä' };
  }
  if (typeof weekday !== 'string' || !WEEKDAYS.includes(weekday)) {
    return { ok: false, status: 400, error: 'Virheellinen viikonpäivä' };
  }

  return { ok: true, value: { transcript: cleanTranscript, today, weekday } };
}

module.exports = {
  validateParseRequest,
  MAX_TRANSCRIPT_LENGTH,
  MAX_BODY_BYTES,
  WEEKDAYS
};
