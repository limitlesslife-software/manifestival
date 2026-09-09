// Kuitin ja laskun luenta: ehdotuksesta hyväksyttyyn kirjaukseen.
//
// ---------------------------------------------------------------
// HYVÄKSYNTÄ ON DOMAIN-SÄÄNTÖ, EI KÄYTTÖLIITTYMÄN TAPA
// ---------------------------------------------------------------
//
// AI:n lukema kuitti EI OLE talouskirjaus. Se on ehdotus, ja
// ehdotuksen ja kirjauksen välissä on ihminen.
//
// Jos hyväksyntä olisi vain käyttöliittymän sovittu tapa — "kutsu
// tallennusta vasta kun käyttäjä on painanut nappia" — se pettäisi
// ensimmäisessä uudelleenlatauksessa, uusintayrityksessä tai
// näkymän ohittavassa kutsussa. Väärin luettu summa päätyisi
// budjettiin ilman että kukaan sanoi kyllä.
//
// Siksi tila on mallissa:
//
//   EXTRACTED  AI on lukenut. EI ole kirjaus. Ei näy budjetissa.
//   REVIEWED   ihminen on katsonut ja korjannut. Ei vielä kirjaus.
//   APPROVED   ihminen on hyväksynyt. Vasta tästä syntyy tapahtuma.
//   REJECTED   ihminen hylkäsi. Ei synny mitään.
//
// `toTransaction` palauttaa `null` kaikille muille tiloille kuin
// APPROVED. Se ei ole tarkistus jonka voi ohittaa — se on ainoa tie.
//
// ---------------------------------------------------------------
// KUVA EI JÄÄ MIHINKÄÄN
// ---------------------------------------------------------------
//
// Kuitin kuva on henkilökohtaisin tieto koko sovelluksessa: se
// kertoo missä olit, milloin ja mitä ostit. Sitä ei talleteta.
//
// Kuva elää vain luennan ajan muistissa, eikä tämä moduuli ota sitä
// vastaan lainkaan — se käsittelee vain luennan TULOSTA. Kuvan
// elinkaari on `src/app/receiptCapture.js`:n vastuulla, ja siellä se
// vapautetaan heti kun luenta on valmis tai peruttu.
//
// Mitään kuvakenttää ei ole tässä mallissa. Kenttä jota ei ole, ei
// voi vahingossa täyttyä.

import { isIsoDate } from './task.js';
import { normalizeMinor, normalizeCurrency } from './money.js';
import { normalizeExpenseCategory } from './financeCategories.js';
import {
  TRANSACTION_KIND, TRANSACTION_ORIGIN, SOURCE_KIND, normalizeTransaction
} from './transactions.js';

/** Luennan tila. Vain APPROVED voi muuttua kirjaukseksi. */
export const EXTRACTION_STATUS = Object.freeze({
  EXTRACTED: 'extracted',
  REVIEWED: 'reviewed',
  APPROVED: 'approved',
  REJECTED: 'rejected'
});

export const EXTRACTION_STATUSES = Object.freeze(Object.values(EXTRACTION_STATUS));

/** Mitä luettiin. */
export const EXTRACTION_SUBJECT = Object.freeze({
  RECEIPT: 'receipt',
  BILL: 'bill'
});

/**
 * Luottamustaso kenttäkohtaisesti.
 *
 * `LOW` tarkoittaa: näytä tämä käyttäjälle korostettuna. Epävarmuutta
 * ei piiloteta — piilotettu epävarmuus näyttää varmuudelta.
 */
export const CONFIDENCE = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
});

const CONFIDENCES = Object.freeze(Object.values(CONFIDENCE));

const MAX_MERCHANT = 120;
const MAX_DESCRIPTION = 200;
const MAX_LINE_ITEMS = 50;
const MAX_REFERENCE = 40;
const MAX_IBAN = 42;

function cleanText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

function normalizeConfidence(value) {
  return CONFIDENCES.includes(value) ? value : CONFIDENCE.LOW;
}

/**
 * Normalisoi yksi rivi kuitilta.
 *
 * Rivit ovat vapaaehtoisia: moni kuitti ei erittele mitään, ja
 * riviluenta on kaikkein epävarminta. Rivi jolla ei ole kuvausta ei
 * kerro mitään, joten se hylätään.
 */
export function normalizeLineItem(input = {}) {
  const description = cleanText(input.description, MAX_DESCRIPTION);
  if (!description) return null;

  const quantity = Number(input.quantity);

  return {
    description,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
    unitPriceMinor: normalizeMinor(input.unitPriceMinor),
    totalMinor: normalizeMinor(input.totalMinor),
    category: input.category ? normalizeExpenseCategory(input.category) : null
  };
}

/**
 * Normalisoi luennan tulos.
 *
 * KAIKKI KENTÄT OVAT EPÄLUOTETTAVIA. Tämä on AI:n tuottamaa tekstiä,
 * ja se normalisoidaan yhtä tiukasti kuin mikä tahansa ulkoinen
 * syöte. Kelvoton arvo muuttuu nulliksi eikä arvaukseksi.
 */
export function normalizeExtraction(input = {}) {
  const subject = input.subject === EXTRACTION_SUBJECT.BILL
    ? EXTRACTION_SUBJECT.BILL
    : EXTRACTION_SUBJECT.RECEIPT;

  const status = EXTRACTION_STATUSES.includes(input.status)
    ? input.status
    : EXTRACTION_STATUS.EXTRACTED;

  const rawItems = Array.isArray(input.lineItems) ? input.lineItems : [];
  const lineItems = rawItems
    .slice(0, MAX_LINE_ITEMS)
    .map(normalizeLineItem)
    .filter(Boolean);

  return {
    id: input.id != null ? String(input.id) : null,
    subject,
    status,

    /** Kauppa tai laskuttaja. */
    merchant: cleanText(input.merchant, MAX_MERCHANT),
    /** Ostopäivä tai laskun eräpäivä. */
    date: isIsoDate(input.date) ? input.date : null,
    totalMinor: normalizeMinor(input.totalMinor),
    currency: normalizeCurrency(input.currency),
    category: input.category ? normalizeExpenseCategory(input.category) : null,
    description: cleanText(input.description, MAX_DESCRIPTION),

    /** Vain laskuille. Maksutiedot EIVÄT käynnistä maksua. */
    iban: cleanText(input.iban, MAX_IBAN),
    reference: cleanText(input.reference, MAX_REFERENCE),

    lineItems,

    /** Yleinen luottamus ja kenttäkohtaiset. */
    confidence: normalizeConfidence(input.confidence),
    fieldConfidence: normalizeFieldConfidence(input.fieldConfidence),

    createdAt: input.createdAt ?? null
  };
}

function normalizeFieldConfidence(input) {
  const result = {};
  if (!input || typeof input !== 'object') return result;
  for (const field of ['merchant', 'date', 'totalMinor', 'currency',
                       'category', 'iban', 'reference']) {
    if (input[field] != null) result[field] = normalizeConfidence(input[field]);
  }
  return result;
}

/**
 * Kentät, jotka käyttäjän on syytä tarkistaa.
 *
 * Puuttuva kenttä on aina tarkistettava, samoin matalan luottamuksen
 * kenttä. Molemmat merkitään näkyvästi -- käyttäjä ei voi korjata
 * sitä mitä hän ei tiedä olevan epävarmaa.
 */
export function fieldsNeedingReview(extraction) {
  if (!extraction) return [];
  const needed = [];

  const required = extraction.subject === EXTRACTION_SUBJECT.BILL
    ? ['merchant', 'date', 'totalMinor']
    : ['merchant', 'date', 'totalMinor'];

  for (const field of required) {
    if (extraction[field] === null || extraction[field] === undefined) {
      needed.push(field);
      continue;
    }
    if (extraction.fieldConfidence[field] === CONFIDENCE.LOW) needed.push(field);
  }

  return needed;
}

/** Onko luennassa tarpeeksi tietoa, jotta sen voi hyväksyä? */
export function validateExtraction(extraction) {
  const errors = {};

  if (!extraction) return { valid: false, errors: { extraction: 'Luentaa ei ole.' } };
  if (!extraction.merchant) {
    errors.merchant = extraction.subject === EXTRACTION_SUBJECT.BILL
      ? 'Anna laskuttaja.' : 'Anna kaupan nimi.';
  }
  if (!extraction.date) errors.date = 'Anna päivämäärä.';
  if (extraction.totalMinor === null) errors.totalMinor = 'Anna summa.';
  else if (extraction.totalMinor <= 0) errors.totalMinor = 'Summan pitää olla suurempi kuin nolla.';

  return { valid: Object.keys(errors).length === 0, errors };
}

// =====================================================================
// TILASIIRTYMÄT
// =====================================================================

/** Merkitse katsotuksi. Ei vielä kirjaus. */
export function markReviewed(extraction) {
  if (!extraction) return null;
  return normalizeExtraction({ ...extraction, status: EXTRACTION_STATUS.REVIEWED });
}

/**
 * Hyväksy luenta.
 *
 * Hyväksyntä EDELLYTTÄÄ kelvollista sisältöä. Puutteellista luentaa ei
 * voi hyväksyä -- muuten hyväksyntä ei tarkoittaisi mitään.
 */
export function approveExtraction(extraction) {
  const { valid } = validateExtraction(extraction);
  if (!valid) return null;
  return normalizeExtraction({ ...extraction, status: EXTRACTION_STATUS.APPROVED });
}

/** Hylkää luenta. Mitään ei synny. */
export function rejectExtraction(extraction) {
  if (!extraction) return null;
  return normalizeExtraction({ ...extraction, status: EXTRACTION_STATUS.REJECTED });
}

/** Käyttäjän korjaus. Korjaus palauttaa tilan katsotuksi, ei hyväksytyksi. */
export function applyCorrection(extraction, changes = {}) {
  if (!extraction) return null;
  return normalizeExtraction({
    ...extraction,
    ...changes,
    // Korjattu luenta on katsottu, ei hyväksytty. Hyväksyntä on aina
    // erillinen, tietoinen teko.
    status: EXTRACTION_STATUS.REVIEWED
  });
}

// =====================================================================
// KIRJAUKSEKSI
// =====================================================================

/**
 * Muuta hyväksytty kuittiluenta tapahtumaksi.
 *
 * PALAUTTAA NULL, JOS LUENTAA EI OLE HYVÄKSYTTY. Tämä on se portti,
 * jonka läpi AI:n tuottama tieto pääsee talouskirjaukseksi — eikä
 * mitään muuta tietä ole.
 */
export function toTransaction(extraction, id) {
  if (!extraction) return null;
  if (extraction.status !== EXTRACTION_STATUS.APPROVED) return null;
  if (extraction.subject !== EXTRACTION_SUBJECT.RECEIPT) return null;

  return normalizeTransaction({
    id,
    kind: TRANSACTION_KIND.EXPENSE,
    origin: TRANSACTION_ORIGIN.RECEIPT,
    amountMinor: extraction.totalMinor,
    currency: extraction.currency,
    date: extraction.date,
    category: extraction.category || 'muu',
    description: extraction.merchant,
    note: extraction.description,
    sourceKind: SOURCE_KIND.RECEIPT,
    sourceId: extraction.id
  });
}

/**
 * Muuta hyväksytty laskuluenta AVOIMEKSI laskuksi.
 *
 * SKANNATTU LASKU EI OLE MAKSETTU. Se on avoin lasku, jonka käyttäjä
 * maksaa itse omassa pankissaan. Manifestivalilla ei ole valtuutta
 * siirtää rahaa eikä käyttöliittymä saa antaa ymmärtää muuta.
 *
 * IBAN ja viitenumero kulkevat mukana, jotta käyttäjä voi kopioida ne
 * pankkiin — ne ovat tietoa, eivät toimintaa.
 */
export function toBill(extraction, id) {
  if (!extraction) return null;
  if (extraction.status !== EXTRACTION_STATUS.APPROVED) return null;
  if (extraction.subject !== EXTRACTION_SUBJECT.BILL) return null;

  return {
    id,
    name: extraction.merchant,
    amountMinor: extraction.totalMinor,
    currency: extraction.currency,
    dueDate: extraction.date,
    /** AVOIN. Skannaus ei maksa laskua. */
    status: 'open',
    paidDate: null,
    payee: extraction.merchant,
    iban: extraction.iban,
    reference: extraction.reference,
    note: extraction.description
  };
}

// =====================================================================
// AI-VASTAUKSEN VALIDOINTI
// =====================================================================

/**
 * Jäsennä AI:n vastaus luennaksi.
 *
 * FAIL CLOSED. Kelvoton vastaus palauttaa `null`, ei puolittaista
 * luentaa. Puolittainen olisi pahempi: käyttäjä näkisi lomakkeen
 * osittain täytettynä eikä tietäisi mikä on luettua ja mikä
 * arvattua.
 *
 * @returns {{ ok: boolean, extraction?: object, reason?: string }}
 */
export function parseExtractionResponse(raw, { subject, id } = {}) {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'Vastausta ei tullut.' };
  }

  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'Vastaus ei ollut kelvollista JSONia.' };
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'Vastaus ei ollut olio.' };
  }

  const extraction = normalizeExtraction({ ...data, subject, id });

  // Täysin tyhjä luenta ei ole luenta. Jos yksikään tunnistetieto ei
  // tullut läpi, on rehellisempää sanoa ettei lukeminen onnistunut
  // kuin näyttää tyhjä lomake luentana.
  const gotSomething = extraction.merchant !== null
    || extraction.totalMinor !== null
    || extraction.date !== null;

  if (!gotSomething) {
    return { ok: false, reason: 'Kuvasta ei saatu luettua mitään.' };
  }

  return { ok: true, extraction };
}
