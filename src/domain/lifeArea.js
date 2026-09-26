// Elämänalueet: käyttäjän oma määritelmä siitä, mikä elämässä on tärkeää.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// =====================================================================
// KÄYTTÄJÄ PÄÄTTÄÄ, SOVELLUS EI
// =====================================================================
//
// Sovellus ei luo oletusalueita eikä päätä niiden tärkeyttä. Ehdotukset
// (SUGGESTED_AREAS) ovat vain aloitusapu, joista käyttäjä valitsee.
//
// =====================================================================
// TÄRKEYS JA AIKATAVOITE OVAT ERI ASIOITA
// =====================================================================
//
//   importance              "Kuinka tärkeä tämä on elämässä jota haluan?"
//                           1–5, strateginen, ei tämän päivän kiire
//   targetMinutesPerWeek    "Paljonko aikaa haluan antaa tälle viikossa?"
//                           minuutteja; null = ei asetettu, 0 = ei nyt
//
// Kumpaakaan ei johdeta toisesta. Perhe voi olla erittäin tärkeä, vaikka
// viikkoon mahtuu vähän tunteja; se jännite näytetään käyttäjälle, sitä
// ei ratkaista kirjoittamalla toista arvoa toisen päälle.
//
// MIKSI MINUUTIT EIKÄ PROSENTTIOSUUS: minuutit verrataan suoraan
// viikkokapasiteettiin ja toteumaan, eikä prosenttien summaa tarvitse
// pitää sadassa. Osuus lasketaan minuuteista näytettäessä (desiredShares).

import { isCategory } from './categories.js';

export const MAX_AREA_NAME_LENGTH = 60;
export const MAX_AREA_DESCRIPTION_LENGTH = 500;
export const MINUTES_PER_WEEK = 10080;
export const MAX_SORT_ORDER = 999;
export const DEFAULT_IMPORTANCE = 3;

/** Tärkeysasteikko. Nimet kertovat merkityksen; luku on vain järjestys. */
export const IMPORTANCE_LEVELS = Object.freeze([
  Object.freeze({ value: 1, label: 'Vähän tärkeä' }),
  Object.freeze({ value: 2, label: 'Jonkin verran tärkeä' }),
  Object.freeze({ value: 3, label: 'Tärkeä' }),
  Object.freeze({ value: 4, label: 'Hyvin tärkeä' }),
  Object.freeze({ value: 5, label: 'Erittäin tärkeä' })
]);

/** Aloitusehdotukset. EI oletuksia: mitään ei luoda ilman käyttäjän valintaa. */
export const SUGGESTED_AREAS = Object.freeze([
  Object.freeze({ name: 'Työ', categoryKey: 'tyo' }),
  Object.freeze({ name: 'Perhe', categoryKey: 'perhe' }),
  Object.freeze({ name: 'Terveys', categoryKey: 'hyvinvointi' }),
  Object.freeze({ name: 'Talous', categoryKey: 'talous' }),
  Object.freeze({ name: 'Parisuhde', categoryKey: null }),
  Object.freeze({ name: 'Ystävät', categoryKey: null }),
  Object.freeze({ name: 'Oma aika', categoryKey: null }),
  Object.freeze({ name: 'Oppiminen', categoryKey: 'kehitys' }),
  Object.freeze({ name: 'Harrastukset', categoryKey: 'harrastus' })
]);

export function importanceLabel(value) {
  const level = IMPORTANCE_LEVELS.find(entry => entry.value === value);
  return level ? level.label : '';
}

export function isImportance(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

export const IMPORTANCE_REQUIRED_MESSAGE = 'Valitse kuinka tärkeä alue on.';

/**
 * Käyttäjän LUOMAN alueen tärkeys on valittava itse. Puuttuva arvo ei saa
 * hiljaa oletusta 3: se sulkisi alueen huomiotta jäämisen havainnon
 * ulkopuolelle (NEGLECT vaatii tärkeyden 4–5), eikä käyttäjä olisi
 * päättänyt sitä. Kannasta luettu rivi saa yhä normalisoinnin oletuksen.
 *
 * @returns {string|null} virheilmoitus tai null
 */
export function importanceChoiceError(input) {
  const value = input ? input.importance : undefined;
  if (value === null || value === undefined || value === '') return IMPORTANCE_REQUIRED_MESSAGE;
  return null;
}

function wholeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function normalizeText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

/** Vertailuavain nimelle: kirjainkoko ja reunavälit eivät tee nimestä eri nimeä. */
export function areaNameKey(name) {
  return String(name ?? '').normalize('NFC').trim().toLocaleLowerCase('fi');
}

export function normalizeLifeArea(input = {}) {
  const importance = wholeNumber(input.importance);
  const target = wholeNumber(input.targetMinutesPerWeek);
  const sortOrder = wholeNumber(input.sortOrder);
  return {
    id: input.id != null ? String(input.id) : null,
    name: String(input.name ?? '').normalize('NFC').trim().slice(0, MAX_AREA_NAME_LENGTH),
    description: normalizeText(input.description, MAX_AREA_DESCRIPTION_LENGTH),
    // Kelvoton tärkeys EI muutu oletukseksi hiljaa: validointi hylkää sen.
    // Puuttuva tärkeys saa oletuksen vain kannasta luetulle riville; uuden
    // alueen luonti vaatii valinnan (importanceChoiceError).
    importance: importance === null ? DEFAULT_IMPORTANCE : importance,
    targetMinutesPerWeek: target,
    categoryKey: isCategory(input.categoryKey) ? input.categoryKey : null,
    active: input.active === undefined ? true : Boolean(input.active),
    sortOrder: sortOrder === null ? 0 : Math.min(Math.max(sortOrder, 0), MAX_SORT_ORDER),
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

/**
 * @param {object} area normalisoitu alue
 * @param {Array} [others] käyttäjän muut alueet (yksikäsitteisyys)
 * @returns {{valid: boolean, errors: Object<string,string>}}
 */
export function validateLifeArea(area, others = []) {
  const errors = {};
  if (!area || !area.name) {
    errors.name = 'Anna alueelle nimi.';
  } else if (area.name.length > MAX_AREA_NAME_LENGTH) {
    errors.name = `Nimi voi olla enintään ${MAX_AREA_NAME_LENGTH} merkkiä.`;
  }

  if (!isImportance(area?.importance)) {
    errors.importance = 'Valitse tärkeys asteikolta 1–5.';
  }

  const target = area?.targetMinutesPerWeek;
  if (target !== null && target !== undefined
      && (!Number.isInteger(target) || target < 0 || target > MINUTES_PER_WEEK)) {
    errors.targetMinutesPerWeek = 'Viikon aikatavoite on 0–168 tuntia.';
  }

  const rest = (others || []).filter(other => other && other.id !== area?.id);
  if (area?.name && rest.some(other => areaNameKey(other.name) === areaNameKey(area.name))) {
    errors.name = 'Sinulla on jo tämänniminen alue.';
  }
  if (area?.categoryKey && rest.some(other => other.categoryKey === area.categoryKey)) {
    errors.categoryKey = 'Kategoria on jo kytketty toiseen alueeseen.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export function compareLifeAreas(a, b) {
  if (a.active !== b.active) return a.active ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name, 'fi');
}

export function activeLifeAreas(areas = []) {
  return areas.filter(area => area && area.active);
}

/**
 * Käyttäjän toivoma ajan jakauma: kunkin aktiivisen alueen osuus kaikista
 * asetetuista viikkotavoitteista.
 *
 * Vain alueet, joilla on tavoite > 0, saavat osuuden. Alue ilman
 * tavoitetta ei ole "0 %": sille ei ole toivottu mitään osuutta.
 *
 * @returns {{totalMinutes: number, shares: Map<string, number>}}
 */
export function desiredShares(areas = []) {
  const withTarget = activeLifeAreas(areas).filter(area => area.targetMinutesPerWeek > 0);
  const totalMinutes = withTarget.reduce((sum, area) => sum + area.targetMinutesPerWeek, 0);
  const shares = new Map();
  if (totalMinutes > 0) {
    for (const area of withTarget) shares.set(area.id, area.targetMinutesPerWeek / totalMinutes);
  }
  return { totalMinutes, shares };
}

/**
 * Lukumäärä oikeassa sijamuodossa: "1 asia", "2 asiaa". Suomen partitiivi
 * ei ole yksikössä sama kuin monikossa, eikä "1 asiaa" ole suomea.
 */
export function countOf(count, singular, partitive) {
  return `${count} ${count === 1 ? singular : partitive}`;
}

/** "3 h 30 min" / "45 min" / "0 min". Näyttöä varten, ei laskentaan. */
export function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return '–';
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
