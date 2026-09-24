// Kirjaustulkinnan validointi.
//
// =====================================================================
// MALLI EHDOTTAA KOHTEEN, SOVELLUS PÄÄTTÄÄ
// =====================================================================
//
// Tämä on se raja, jonka yli mallin sana ei kanna. Malli saa sanoa
// "tämä on lasku"; sovellus tarkistaa, onko lasku mahdollinen tästä
// syötteestä, ja hylkää tulkinnan jos ei ole.
//
// Tuntematon kohde EI ole virhe vaan EPÄVARMUUS. Se menee saapuviin
// muistiinpanona, ei domainiin arvauksena. Väärään moduuliin luotu rivi
// näyttää oikealta ja löytyy väärästä paikasta — se on pahempi kuin
// kirjaamaton rivi.
//
// FAIL CLOSED. Kelvoton vastaus muuttuu muistiinpanoksi, ei
// puolittaiseksi tehtäväksi.

import {
  CAPTURE_KIND, CAPTURE_KINDS, normalizeInterpretation, needsReview,
  isForbidden
} from '../domain/capture.js';

/** Vastauksen enimmäiskoko merkkeinä. Suojaa jäsennystä ja muistia. */
export const MAX_RESPONSE_LENGTH = 20000;

/**
 * Kentät, jotka luetaan mallin vastauksesta.
 *
 * NIMENOMAINEN LISTA, EI POISLUKULISTA. Tuntematon kenttä pudotetaan
 * hiljaa; poislukulista päästäisi läpi jokaisen kentän, jota kukaan ei
 * osannut kieltää etukäteen.
 */
export const ALLOWED_FIELDS = Object.freeze([
  'kind', 'confidence', 'title',
  'date', 'time', 'endTime', 'durationMinutes',
  'category', 'priority', 'reminderLeadMinutes',
  'amountMinor', 'transactionKind', 'financeCategory',
  'metric', 'unit', 'baselineValue', 'targetValue',
  'recurrenceType', 'weekdays',
  'destination', 'arrivalTime', 'arrivalDate',
  'assumptions', 'question'
]);

/**
 * Kentät, joiden esiintyminen on ITSESSÄÄN merkki siitä, että malli
 * yritti tehdä päätöksen joka ei kuulu sille.
 *
 * Näitä ei vain pudoteta vaan ne KIRJATAAN, jotta kehotteen ajautuminen
 * huomataan ennen kuin se ehtii tuottaa vahinkoa.
 */
export const REJECTED_FIELDS = Object.freeze([
  'id', 'userId', 'user_id', 'completed', 'status', 'schedulingState',
  'createdAt', 'updatedAt', 'sql', 'query', 'html', 'script'
]);

/**
 * Poimi JSON mallin vastauksesta.
 *
 * Malli voi ympäröidä vastauksen tekstillä tai koodilohkolla, vaikka
 * kehote kieltää sen. Poiminta on sallivampi kuin kehote — jäsennys ei
 * ole.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_RESPONSE_LENGTH) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validoi ja normalisoi tulkinta.
 *
 * PALAUTTAA AINA TULKINNAN. Kelvoton vastaus ei ole virhe vaan
 * muistiinpano: käyttäjä kirjoitti jotain, ja se säilyy vaikka
 * järjestelmä ei ymmärtänyt sitä.
 *
 * @param {string|object} raw
 * @returns {{
 *   ok: boolean, interpretation: object, needsReview: boolean,
 *   reason: string|null, rejectedFields: Array
 * }}
 */
export function validateCaptureResponse(raw) {
  const fallback = normalizeInterpretation({
    kind: CAPTURE_KIND.NOTE, confidence: 'low'
  });

  if (raw === null || raw === undefined) {
    return {
      ok: false,
      interpretation: fallback,
      needsReview: true,
      reason: 'Vastausta ei tullut.',
      rejectedFields: []
    };
  }

  const data = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      interpretation: fallback,
      needsReview: true,
      reason: 'Vastaus ei ollut kelvollista JSONia.',
      rejectedFields: []
    };
  }

  const rejected = [];
  const shaped = {};

  for (const key of Object.keys(data)) {
    if (ALLOWED_FIELDS.includes(key)) shaped[key] = data[key];
    else if (REJECTED_FIELDS.includes(key)) rejected.push(key);
  }

  // KIELLETTY KOMENTO EI OLE TULKINTA.
  //
  // Kirjaus ei koskaan poista eikä muuta mitään, joten kiellettyä
  // komentoa ei pitäisi voida edes ilmaista. Tarkistus on silti tässä:
  // malli voi palauttaa mitä tahansa.
  for (const value of Object.values(shaped)) {
    if (isForbidden(value)) {
      return {
        ok: false,
        interpretation: fallback,
        needsReview: true,
        reason: 'Vastaus sisälsi kielletyn toimenpiteen.',
        rejectedFields: rejected
      };
    }
  }

  // TUNTEMATON KOHDE PUTOAA MUISTIINPANOKSI, EI LÄHIMPÄÄN.
  //
  // Lähin arvaus näyttäisi täsmälleen yhtä varmalta kuin oikea
  // tulkinta.
  if (shaped.kind !== undefined && !CAPTURE_KINDS.includes(shaped.kind)) {
    return {
      ok: true,
      interpretation: normalizeInterpretation({
        ...shaped, kind: CAPTURE_KIND.NOTE, confidence: 'low'
      }),
      needsReview: true,
      reason: `Tuntematon kohde: ${String(shaped.kind).slice(0, 40)}`,
      rejectedFields: rejected
    };
  }

  const interpretation = normalizeInterpretation(shaped);

  return {
    ok: true,
    interpretation,
    needsReview: needsReview(interpretation),
    reason: null,
    rejectedFields: rejected
  };
}

/**
 * Kirjauksen konteksti mallille.
 *
 * VAIN SE, MITÄ TULKINTAAN TARVITAAN. Käyttäjän tehtävälista,
 * muistiinpanot, hyvinvointimerkinnät ja taloustiedot EIVÄT lähde ulos:
 * kohteen päättelyyn riittää tieto siitä, mikä päivä tänään on ja mitkä
 * ominaisuudet ovat käytössä.
 *
 * Ominaisuuslippu on tarpeen, jottei malli ehdota kohdetta, jota tässä
 * asennuksessa ei ole — se olisi ehdotus, jota ei voi hyväksyä.
 */
export function buildCaptureContext({ todayIso, weekday, features = {} } = {}) {
  return {
    today: todayIso ?? null,
    weekday: weekday ?? null,
    /** Onko talousominaisuudet käytössä tässä asennuksessa? */
    financeEnabled: features.finance !== false,
    /** Onko tavoitesuunnittelu käytössä? */
    goalsEnabled: features.goals !== false,
    /** Onko matka-arvio käytettävissä? */
    travelEnabled: features.travel === true
  };
}
