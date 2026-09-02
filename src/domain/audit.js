// AI-toimintojen kirjausketju.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa — aikaleima annetaan
// parametrina, kuten muissakin domain-moduuleissa.
//
// MITÄ TÄMÄ ON
// Kirjaus siitä, mitä AI ehdotti, mitä käyttäjä vahvisti ja mitä oikeasti
// tapahtui. Sen tehtävä on vastata kysymykseen "miksi tämä muuttui?" silloin
// kun käyttäjä ei muista tehneensä muutosta.
//
// MITÄ TÄMÄ EI OLE
// Tämä ei ole analytiikkaa. Se ei mittaa käyttöä, ei seuraa käyttäytymistä
// eikä lähde mihinkään. Se on käyttäjän oma loki hänen omista toimistaan.
//
// ARKALUONTOISUUS
// Raakaa syötettä EI tallenneta sellaisenaan. "Soita Matille numeroon
// 040 1234567 ja kerro koeteloksesta" on kirjaus, jota käyttäjä ei odota
// säilyvän. Tallennetaan LYHENNETTY tiivistelmä, jonka pituus on rajattu ja
// joka riittää tunnistamaan komennon jälkikäteen.

import { isIsoDate } from './task.js';

/** Mitä komennolle lopulta tapahtui. */
export const AUDIT_RESULT = Object.freeze({
  /** Ehdotus tehtiin, käyttäjä ei ole vielä vastannut. */
  PROPOSED: 'proposed',
  /** Käyttäjä perui. */
  CANCELLED: 'cancelled',
  /** Suoritettiin onnistuneesti. */
  EXECUTED: 'executed',
  /** Suoritus epäonnistui. */
  FAILED: 'failed',
  /** Kohde oli epäselvä, joten mitään ei tehty. */
  AMBIGUOUS: 'ambiguous',
  /** Komentoa ei tunnistettu tai se hylättiin. */
  REJECTED: 'rejected'
});

export const AUDIT_RESULTS = Object.freeze(Object.values(AUDIT_RESULT));

/**
 * Kuinka pitkä pätkä käyttäjän syötteestä säilytetään.
 *
 * Riittää tunnistamaan komennon ("Muistuta huomenna klo 14 soittamaan…")
 * mutta katkaisee pitkät kirjaukset ennen kuin niistä tulee päiväkirja.
 */
export const MAX_INPUT_SUMMARY = 120;

/** Kuinka monta kirjausta säilytetään. Loki ei saa kasvaa rajatta. */
export const MAX_AUDIT_ENTRIES = 200;

/**
 * Tiivistä käyttäjän syöte kirjausta varten.
 *
 * Katkaisu tehdään sanan rajalta, jottei viimeinen sana jää puolikkaaksi —
 * puolikas sana näyttää virheeltä eikä lyhennykseltä.
 */
export function summarizeInput(input) {
  if (input === null || input === undefined) return '';
  const text = String(input).replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_INPUT_SUMMARY) return text;

  const cut = text.slice(0, MAX_INPUT_SUMMARY);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > MAX_INPUT_SUMMARY * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
}

/**
 * Normalisoi kirjaus.
 *
 * Kaikki kentät ovat vapaaehtoisia paitsi `intent` ja `timestamp`: kirjaus
 * ilman niitä ei kerro mitään.
 */
export function normalizeAuditEntry(input = {}) {
  const result = AUDIT_RESULTS.includes(input.result)
    ? input.result
    : AUDIT_RESULT.PROPOSED;

  return {
    id: input.id != null ? String(input.id) : null,
    /** ISO-aikaleima. Annetaan kutsujalta — domain ei lue kelloa. */
    timestamp: input.timestamp != null ? String(input.timestamp) : null,
    /** Lyhennetty tiivistelmä, ei raaka syöte. */
    inputSummary: summarizeInput(input.inputSummary ?? input.input),
    intent: input.intent != null ? String(input.intent) : null,
    risk: input.risk != null ? String(input.risk) : null,
    targetType: input.targetType != null ? String(input.targetType) : null,
    targetId: input.targetId != null ? String(input.targetId) : null,
    /** Ihmisluettava kuvaus siitä, mitä ehdotettiin. */
    proposal: input.proposal != null ? String(input.proposal).slice(0, 300) : null,
    confirmed: input.confirmed === true,
    executed: input.executed === true,
    result,
    errorCode: input.errorCode != null ? String(input.errorCode).slice(0, 60) : null
  };
}

export function validateAuditEntry(entry) {
  const errors = {};
  if (!entry.intent) errors.intent = 'Komento puuttuu.';
  if (!entry.timestamp) errors.timestamp = 'Aikaleima puuttuu.';
  if (!AUDIT_RESULTS.includes(entry.result)) errors.result = 'Tuntematon lopputulos.';

  // Suoritettu ilman vahvistusta olisi merkki turvamallin rikkoutumisesta.
  // Kirjaus ei saa väittää sellaista, joten se hylätään jo täällä.
  if (entry.executed && !entry.confirmed) {
    errors.confirmed = 'Suoritettu komento ilman vahvistusta.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Lisää kirjaus listaan ja pidä lista rajallisena.
 *
 * Uusin ensin: käyttäjä etsii lähes aina viimeisintä muutosta.
 * Palauttaa UUDEN listan — ei muuta annettua.
 */
export function appendAuditEntry(entries, entry) {
  const normalized = normalizeAuditEntry(entry);
  return [normalized, ...(entries || [])].slice(0, MAX_AUDIT_ENTRIES);
}

/**
 * Päivitä olemassa olevan kirjauksen lopputulos.
 *
 * Ehdotus kirjataan ennen käyttäjän vastausta, joten sama kirjaus
 * täydentyy myöhemmin. Uutta riviä ei luoda: se näyttäisi kahdelta eri
 * toiminnolta.
 */
export function completeAuditEntry(entries, id, changes = {}) {
  return (entries || []).map(entry => {
    if (String(entry.id) !== String(id)) return entry;
    return normalizeAuditEntry({ ...entry, ...changes });
  });
}

/** Kirjaukset yhdelle päivälle. */
export function entriesForDate(entries, dateIso) {
  if (!isIsoDate(dateIso)) return [];
  return (entries || []).filter(entry =>
    typeof entry.timestamp === 'string' && entry.timestamp.slice(0, 10) === dateIso);
}

/**
 * Yhteenveto kirjauksista.
 * Käyttöliittymä näyttää tämän asetuksissa: "AI on tehnyt 12 muutosta."
 */
export function summarizeAudit(entries = []) {
  const byResult = {};
  for (const value of AUDIT_RESULTS) byResult[value] = 0;

  let confirmed = 0;
  let executed = 0;
  for (const entry of entries) {
    byResult[entry.result] = (byResult[entry.result] || 0) + 1;
    if (entry.confirmed) confirmed++;
    if (entry.executed) executed++;
  }

  return {
    total: entries.length,
    byResult,
    confirmed,
    executed,
    latest: entries[0] || null
  };
}

/** Ihmisluettava kuvaus yhdestä kirjauksesta. */
export function describeAuditEntry(entry) {
  if (!entry) return '';
  const what = entry.proposal || entry.intent || 'Tuntematon komento';

  switch (entry.result) {
    case AUDIT_RESULT.EXECUTED: return `${what} — tehty`;
    case AUDIT_RESULT.CANCELLED: return `${what} — peruttu`;
    case AUDIT_RESULT.FAILED: return `${what} — epäonnistui`;
    case AUDIT_RESULT.AMBIGUOUS: return `${what} — kohde oli epäselvä`;
    case AUDIT_RESULT.REJECTED: return `${what} — hylättiin`;
    default: return `${what} — odottaa vahvistusta`;
  }
}
