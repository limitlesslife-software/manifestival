// Syotteen validointi /api/command-paatepisteelle.
//
// Erillinen moduuli, jotta validointi voidaan testata ilman verkkokutsuja
// (tests/api-command-validation.test.mjs). Alaviiva tiedostonimen alussa
// kertoo Vercelille, etta tama EI ole oma reitti vaan apumoduuli.
//
// ---------------------------------------------------------------
// TAMA PAATEPISTE LUOKITTELEE, EI SUORITA
// ---------------------------------------------------------------
//
// Vastaus on RAAKA EHDOTUS. Ainoa paikka, jossa se muuttuu
// suoritettavaksi komennoksi, on src/ai/intentSchema.js:n
// resolveCommand() -- tiukka allowlist, kentta kerrallaan validointi,
// ei olioita eika prototyyppeja. Tama paatepiste ei tunne edes sita
// listaa: se vain valittaa kayttajan lauseen mallille ja palauttaa
// mallin tekstin sellaisenaan takaisin selaimelle.
//
// ---------------------------------------------------------------
// KAYTTAJAN TEKSTI MENEE PROMPTIIN, KONTEKSTI ON MINIMAALINEN
// ---------------------------------------------------------------
//
// Kohteen tunnistus (mika tehtava, mika rutiini) tehdaan KOKONAAN
// selaimessa jo ladattua tilaa vasten (src/ai/entityResolver.js).
// Malli ei koskaan nae kayttajan tehtavalistaa, tavoitteita, laskuja
// eika sijaintia -- se tarvitsee vain lauseen ja paivamaaran
// paatelläkseen "targetName"-kentan, jonka avulla selain hakee
// oikean rivin OMASTA datastaan.

/** Vapaan komentotekstin enimmaispituus. Komennot ovat lyhyita lauseita. */
const MAX_TEXT_LENGTH = 300;

/** Koko JSON-rungon enimmaiskoko tavuina. */
const MAX_BODY_BYTES = 4 * 1024;

/** Sallitut lahteet: kirjoitettu tai puhuttu komento. */
const SOURCES = Object.freeze(['text', 'voice']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Sallitut viikonpaivat. Estaa mielivaltaisen tekstin ujuttamisen promptiin. */
const WEEKDAYS = Object.freeze([
  'sunnuntai', 'maanantai', 'tiistai', 'keskiviikko',
  'torstai', 'perjantai', 'lauantai'
]);

/**
 * Validoi ja normalisoi /api/command -pyynnon runko.
 *
 * Palauttaa joko { ok: true, value } tai { ok: false, status, error }.
 */
function validateCommandRequest(body) {
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

  const { text, today, weekday, source } = body;

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

  const cleanWeekday = typeof weekday === 'string' && WEEKDAYS.includes(weekday)
    ? weekday : null;

  const cleanSource = SOURCES.includes(source) ? source : 'text';

  return {
    ok: true,
    value: {
      text: cleanText,
      today,
      weekday: cleanWeekday,
      source: cleanSource
    }
  };
}

module.exports = {
  validateCommandRequest,
  MAX_TEXT_LENGTH,
  MAX_BODY_BYTES,
  SOURCES,
  WEEKDAYS
};
