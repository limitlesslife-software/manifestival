// Arjen käyttöjärjestelmän entiteettien yhteiset kenttänormalisoijat.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa. Jokainen funktio
// palauttaa kelvollisen arvon tai nullin — yksikään ei heitä, vaikka
// syöte olisi mitä tahansa (tyhjä, väärän tyyppinen, kannasta, lomak-
// keelta tai tekoälyn ehdotuksesta).
//
// TUNTEMATON EI OLE NOLLA. `Number(null)`, `Number('')` ja
// `Number(false)` ovat kaikki 0. Ilman näitä tarkistuksia vastaamatta
// jättäminen muuttuisi vastaukseksi: tuntematon matka-aika nollaksi
// (= "ollaan jo perillä") tai tyhjä motivaatio asteikon pohjaksi.
// Siksi puuttuva arvo tarkistetaan AINA ennen muunnosta.
//
// Rajat (MAX_*) tulevat kutsujalta, joka tuo ne src/domain/dailyLife.js:
// stä tai omasta moduulistaan. Ne vastaavat migraation 0014 CHECK-
// rajoitteita (tests/daily-life-migration.test.mjs vertaa).

import { isIsoDate } from './task.js';

/** Tyhjä syöte: null, undefined tai tyhjä merkkijono. */
function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/**
 * Luku tai null. Vain luku tai numeerinen merkkijono kelpaa: totuusarvo,
 * olio ja taulukko ovat roskaa eivätkä nolla tai yksi.
 */
function numberOf(value) {
  if (isBlank(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Tunniste tai null. Olio tai taulukko ei ole tunniste. */
export function idOrNull(value, maxLength = 100) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text === '' ? null : text.slice(0, maxLength);
}

/** Vapaa teksti: trimmattu ja rajattu, tyhjä -> null. */
export function textOrNull(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim().slice(0, maxLength).trim();
  return text === '' ? null : text;
}

/** Pakollinen teksti: trimmattu ja rajattu, puuttuva -> '' (validointi kertoo). */
export function requiredText(value, maxLength) {
  return textOrNull(value, maxLength) ?? '';
}

/**
 * Kokonaisluku väliltä [min, max] tai null.
 *
 * Yläraja KIRISTETÄÄN: 2000 minuutin matka on arvo, vain liian suuri.
 * Alarajan alittava luku on ROSKAA ja muuttuu tuntemattomaksi: nollan
 * minuutin matka tai negatiivinen valmistautuminen ei ole mikään arvo,
 * ja sen kiristäminen rajalle keksisi luvun, jota kukaan ei antanut.
 */
export function intOrNull(value, min, max) {
  const n = numberOf(value);
  if (n === null) return null;
  const rounded = Math.round(n);
  if (rounded < min) return null;
  return Math.min(rounded, max);
}

/**
 * Asteikon arvo (esim. 1–5) tai null. Sama sääntö kuin
 * src/domain/wellbeing.js: annettu luku kiristetään asteikolle molemmista
 * päistä (se on arvo), puuttuva pysyy puuttuvana.
 */
export function scaleOrNull(value, min, max) {
  const n = numberOf(value);
  if (n === null) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Asetuksen kokonaisluku: aina arvo. Roska -> oletus, alueen ulkopuolinen
 * kiristetään alueelle (asetuksella ei ole "tuntematonta").
 */
export function clampInt(value, min, max, fallback) {
  const n = numberOf(value);
  if (n === null) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Totuusarvo; kaikki muu kuin true/false -> oletus. Merkkijono 'false' ei ole tosi. */
export function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** Sallittu arvo tai oletus. */
export function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** ISO-päivä ('YYYY-MM-DD', kalenterissa olemassa) tai null. */
export function dateOrNull(value) {
  return isIsoDate(value) ? value : null;
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,6})?)?$/;

/**
 * Kellonaika 'HH:MM' tai null.
 *
 * Kanta palauttaa `time`-sarakkeen muodossa 'HH:MM:SS'. Ilman tätä
 * muunnosta jokainen kannasta ladattu aika muuttuisi nulliksi, ja
 * tallennettu meno näyttäisi koko päivän menolta.
 */
export function timeOrNull(value) {
  if (typeof value !== 'string') return null;
  const match = TIME_OF_DAY.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

/** Aikaleima kanoniseen ISO-muotoon (UTC) tai null. */
export function timestampOrNull(value) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** 'HH:MM' -> minuutteja keskiyöstä. Kutsuja takaa muodon (timeOrNull). */
export function minutesOfTime(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
