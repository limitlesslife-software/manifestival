// Syotteen validointi /api/extract-paatepisteelle.
//
// Erillinen moduuli, jotta validointi voidaan testata ilman verkkokutsuja
// (tests/api-extract-validation.test.cjs). Alaviiva tiedostonimen alussa
// kertoo Vercelille, etta tama EI ole oma reitti vaan apumoduuli.
//
// ---------------------------------------------------------------
// KUVA KULKEE LAPI, EI TALTEEN
// ---------------------------------------------------------------
//
// Tama validoi kuvan, joka lahetetaan Anthropicille luettavaksi. Kuvaa
// EI kirjoiteta levylle, EI lokiteta eika EI palauteta vastauksessa.
// Se elaa pyynnon keston ajan ja katoaa.
//
// Erityisesti: virheviestit eivat koskaan sisalla kuvadataa eivatka sen
// osaa. Base64-pattka lokissa olisi juuri se kuitti, jota ei ollut
// tarkoitus sailyttaa.

/**
 * Kuvan enimmaiskoko base64-merkkeina.
 *
 * 5 MB base64 vastaa noin 3,7 MB:n kuvaa. Puhelimen kamera tuottaa
 * enemman, joten SELAIN PIENENTAA KUVAN ennen lahetysta
 * (src/app/receiptCapture.js). Raja on siksi tarkistus eika tavoite:
 * jos se ylittyy, pienennys on pettanyt.
 */
const MAX_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024;

/** Koko JSON-rungon enimmaiskoko tavuina. */
const MAX_BODY_BYTES = 7 * 1024 * 1024;

/** Sallitut kuvatyypit. Anthropicin Vision tukee naita. */
const MEDIA_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

/** Mita kuvassa vaitetaan olevan. Ohjaa promptia, joten tiukka lista. */
const SUBJECTS = Object.freeze(['receipt', 'bill']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Base64 ilman data-URI-etuliitetta. Selain riisuu etuliitteen. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validoi ja normalisoi /api/extract -pyynnon rungon.
 *
 * Palauttaa joko { ok: true, value } tai { ok: false, status, error }.
 * Virheviesti on aina turvallinen naytettavaksi clientille eika sisalla
 * kuvadataa.
 */
function validateExtractRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Virheellinen pyyntö' };
  }

  const { image, mediaType, subject, today } = body;

  // KOKORAJA ENSIN, ja kuvasta erikseen — ei JSON.stringifyta koko
  // rungosta. Suuren kuvan serialisointi virheen selvittamiseksi olisi
  // itsessaan se muistipiikki, jota raja yrittaa estaa.
  if (typeof image !== 'string') {
    return { ok: false, status: 400, error: 'Kuva puuttuu' };
  }
  if (image.length === 0) {
    return { ok: false, status: 400, error: 'Kuva puuttuu' };
  }
  if (image.length > MAX_IMAGE_BASE64_LENGTH) {
    return { ok: false, status: 413, error: 'Kuva on liian suuri' };
  }

  // Data-URI-etuliite ei kelpaa: Anthropic odottaa pelkkaa base64:aa,
  // ja etuliitteen hiljainen poisto tekisi rajatarkistuksesta
  // epatarkan.
  if (!BASE64.test(image)) {
    return { ok: false, status: 400, error: 'Kuvan muoto ei kelpaa' };
  }

  if (typeof mediaType !== 'string' || !MEDIA_TYPES.includes(mediaType)) {
    return { ok: false, status: 400, error: 'Kuvan tyyppi ei kelpaa' };
  }

  if (typeof subject !== 'string' || !SUBJECTS.includes(subject)) {
    return { ok: false, status: 400, error: 'Virheellinen kohde' };
  }

  // today menee promptiin, joten se validoidaan tiukasti.
  if (typeof today !== 'string' || !ISO_DATE.test(today)) {
    return { ok: false, status: 400, error: 'Virheellinen päivämäärä' };
  }
  if (Number.isNaN(Date.parse(today))) {
    return { ok: false, status: 400, error: 'Virheellinen päivämäärä' };
  }

  // Kokonaisrunko: kuva on jo rajattu, joten tama on halpa.
  const muutBytes = Buffer.byteLength(
    JSON.stringify({ mediaType, subject, today }), 'utf8');
  if (image.length + muutBytes > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'Pyyntö on liian suuri' };
  }

  return { ok: true, value: { image, mediaType, subject, today } };
}

module.exports = {
  validateExtractRequest,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_BODY_BYTES,
  MEDIA_TYPES,
  SUBJECTS
};
