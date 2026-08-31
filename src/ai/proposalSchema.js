// AI-ehdotuksen skeema ja validointi.
//
// PERIAATE: AI on EHDOTTAVA KERROS. Sen tuotokseen ei luoteta koskaan.
//
// Pipeline:
//   käyttäjän puhe/teksti
//     -> palvelinpuolen /api/parse (API-avain pysyy palvelimella)
//     -> tämä validointi
//     -> normalisoitu ehdotus
//     -> KÄYTTÄJÄN VAHVISTUS
//     -> tehtävädomain
//
// AI ei koskaan kirjoita tietokantaan. Jokainen ehdotus käy käyttäjän
// vahvistuksen kautta, ja tämä moduuli varmistaa, että vahvistettavaksi
// tarjottava ehdotus on rakenteeltaan kelvollinen.
//
// Tuntemattomat kentät hylätään. Sallitut arvot tulevat domainista, joten
// AI ei voi keksiä uutta kategoriaa tai prioriteettia.

import { CATEGORY_KEYS, DEFAULT_CATEGORY, normalizeCategory } from '../domain/categories.js';
import { PRIORITY_KEYS, DEFAULT_PRIORITY, normalizePriority } from '../domain/priority.js';
import { isIsoDate, isTimeOfDay, MAX_TITLE_LENGTH } from '../domain/task.js';

/** Kentät, jotka AI:n vastauksesta luetaan. Kaikki muu hylätään. */
export const PROPOSAL_FIELDS = Object.freeze([
  'title', 'date', 'time', 'endTime', 'durationMinutes', 'category', 'priority', 'note'
]);

/** Sallitut arvot, jotka annetaan myös promptille. */
export const ALLOWED = Object.freeze({
  category: CATEGORY_KEYS,
  priority: PRIORITY_KEYS
});

export const MAX_NOTE_LENGTH = 300;
export const MAX_PROPOSAL_MINUTES = 1440;

/**
 * Poimii JSON-objektin AI:n tekstivastauksesta.
 * Malli saattaa ympäröidä vastauksen koodilohkomerkinnöillä tai selittää
 * sitä, joten pelkkä JSON.parse ei riitä.
 *
 * @returns {object|null} jäsennetty objekti tai null
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;

  const withoutFences = text.replace(/```json/gi, '').replace(/```/g, '').trim();

  const direct = tryParse(withoutFences);
  if (direct) return direct;

  // Ylimmän tason taulukko hylätään eksplisiittisesti. Jos malli palauttaa
  // useita ehdotuksia, ei ole yksiselitteistä kumpi niistä on "se oikea" —
  // arvaamisen sijaan pudotaan varaehdotukseen, jossa käyttäjän oma teksti
  // on otsikkona. Ilman tätä alla oleva aaltosulkeiden poiminta nappaisi
  // vaieten taulukon ensimmäisen alkion.
  if (withoutFences.startsWith('[')) return null;

  // Varasuunnitelma: poimi ensimmäinen aaltosulkeisiin rajattu lohko.
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return tryParse(withoutFences.slice(start, end + 1));
}

function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  return trimmed.slice(0, maxLength);
}

function cleanMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.round(n), MAX_PROPOSAL_MINUTES);
}

/**
 * Validoi ja normalisoi AI:n tuottama ehdotus.
 *
 * Ei koskaan heitä poikkeusta. Palauttaa aina tuloksen, jossa kerrotaan
 * mikä hyväksyttiin ja mikä hylättiin — jälkimmäinen on hyödyllistä
 * diagnostiikassa ja testeissä.
 *
 * @param {unknown} raw       AI:n tuottama objekti
 * @param {object}  context
 * @param {string}  context.today            Oletuspäivä, jos AI ei anna kelvollista
 * @param {string}  [context.fallbackTitle]  Käytetään, jos otsikko puuttuu
 * @returns {{valid:boolean, proposal:object|null, rejected:string[], reason?:string}}
 */
export function validateProposal(raw, context = {}) {
  const today = isIsoDate(context.today) ? context.today : null;
  const rejected = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, proposal: null, rejected: [], reason: 'Vastaus ei ollut objekti' };
  }

  // Tuntemattomat kentät kirjataan ja pudotetaan.
  for (const key of Object.keys(raw)) {
    if (!PROPOSAL_FIELDS.includes(key)) rejected.push(key);
  }

  const title = cleanString(raw.title, MAX_TITLE_LENGTH)
    || cleanString(context.fallbackTitle, MAX_TITLE_LENGTH);
  if (!title) {
    return { valid: false, proposal: null, rejected, reason: 'Otsikko puuttuu' };
  }

  let date = cleanString(raw.date, 10);
  if (!isIsoDate(date)) {
    if (date) rejected.push('date');
    date = today;
  }
  if (!date) {
    return { valid: false, proposal: null, rejected, reason: 'Päivämäärä puuttuu' };
  }

  let time = cleanString(raw.time, 5);
  if (time && !isTimeOfDay(time)) { rejected.push('time'); time = null; }

  let endTime = cleanString(raw.endTime, 5);
  if (endTime && !isTimeOfDay(endTime)) { rejected.push('endTime'); endTime = null; }

  // Loppuaika ilman alkuaikaa on merkityksetön.
  if (endTime && !time) { rejected.push('endTime'); endTime = null; }
  // Nollan mittainen väli on virhe.
  if (endTime && time && endTime === time) { rejected.push('endTime'); endTime = null; }

  const durationMinutes = cleanMinutes(raw.durationMinutes);
  if (raw.durationMinutes != null && durationMinutes === null) rejected.push('durationMinutes');

  if (raw.category != null && !CATEGORY_KEYS.includes(raw.category)) rejected.push('category');
  if (raw.priority != null && !PRIORITY_KEYS.includes(raw.priority)) rejected.push('priority');

  return {
    valid: true,
    rejected,
    proposal: {
      title,
      date,
      time,
      endTime,
      durationMinutes,
      category: normalizeCategory(raw.category) || DEFAULT_CATEGORY,
      priority: normalizePriority(raw.priority) || DEFAULT_PRIORITY,
      note: cleanString(raw.note, MAX_NOTE_LENGTH)
    }
  };
}

/**
 * Varaehdotus, kun AI ei ole käytettävissä tai sen vastaus ei kelpaa.
 * Käyttäjän oma teksti otsikoksi, muut kentät tyhjinä. Näin puheohjaus
 * toimii aina jotenkin, vaikka verkko tai palvelu pettäisi.
 */
export function fallbackProposal(text, today) {
  return {
    title: cleanString(text, MAX_TITLE_LENGTH) || 'Uusi tehtävä',
    date: isIsoDate(today) ? today : null,
    time: null,
    endTime: null,
    durationMinutes: null,
    category: DEFAULT_CATEGORY,
    priority: DEFAULT_PRIORITY,
    note: null
  };
}
