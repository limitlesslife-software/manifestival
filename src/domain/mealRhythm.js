// Ateriarytmi: päivän ateria-, vesi- ja lisäravinnemuistutukset.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa. Päivä annetaan
// parametrina.
//
// MITÄ TÄMÄ ON JA MITÄ EI
//
// Tämä muuttaa käyttäjän OMAN ateriarytmin (life_settings.meal_rhythm)
// päivän muistutuskohteiksi. Se ei ehdota ruokavaliota, määriä eikä
// ravintoaineita, eikä se arvioi syömistä. "Ruokailun iltaraja" on
// käyttäjän itse asettama kellonaika, ei sääntö.
//
// SEINÄKELLO, EI KESTO
//
// Muistutukset ovat seinäkellon aikoja ("lounas 11.30"). Kesäajan
// vaihtopäivänä kellonajat pysyvät samoina; hetkeksi muuntaminen kuuluu
// ilmoituskerrokselle. Vesimuistutukset ovat päiväsaikaan (alku ennen
// loppua), joten ne eivät ylitä keskiyötä.
//
// RAJAT
//
// Vesimuistutusten väli on vähintään MEAL_RULES.WATER_MIN_INTERVAL_MINUTES
// ja niitä on enintään MEAL_RULES.WATER_MAX_REMINDERS_PER_DAY päivässä:
// tiheämpi muistuttaminen olisi häiriö, ei tuki. Validointi hylkää
// rajojen ulkopuoliset arvot; jos sellainen on silti tallessa, kohteiden
// muodostus pitää rajat (väli pidennetään, määrä katkaistaan).

import { MAX_MEALS, REMINDER_TOPIC } from './dailyLife.js';
import { isIsoDate } from './task.js';
import { MEAL_RULES } from './dailyLifeSignalsPolicy.js';

export const MEAL_ITEM_KIND = Object.freeze({
  MEAL_PREP: 'meal_prep',
  MEAL: 'meal',
  WATER: 'water',
  SUPPLEMENT: 'supplement',
  LATE_CUTOFF: 'late_cutoff'
});

export const MEAL_ITEM_KINDS = Object.freeze(Object.values(MEAL_ITEM_KIND));

/** Saman kellonajan kohteiden järjestys: valmistelu ennen ateriaa. */
const KIND_ORDER = Object.freeze({
  meal_prep: 0, meal: 1, supplement: 2, water: 3, late_cutoff: 4
});

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_ID_LENGTH = 100;
const collator = new Intl.Collator('fi');

/** Hajotettava olio: null, luku tai merkkijono ei kaada funktiota. */
const argsOf = value => (value !== null && typeof value === 'object' ? value : {});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function minutesOf(time) {
  if (typeof time !== 'string') return null;
  const match = HHMM.exec(time.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function clockOf(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ').slice(0, MEAL_RULES.MAX_NAME_LENGTH);
  return name === '' ? null : name;
}

function cleanKey(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const key = value.trim().slice(0, MAX_ID_LENGTH);
  return key === '' ? null : key;
}

function intIn(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= min && rounded <= max ? rounded : null;
}

/**
 * Vesimuistutusten kellonajat: alusta loppuun (loppu mukaan lukien) välin
 * välein. Tyhjä lista, jos jokin kolmesta puuttuu tai alku ei ole ennen
 * loppua — tuntemattomasta ei keksitä muistutuksia.
 *
 * @returns {ReadonlyArray<string>} 'HH:MM'-ajat, enintään WATER_MAX_REMINDERS_PER_DAY
 */
export function waterReminderTimes(input) {
  const { waterEveryMinutes, waterFrom, waterTo } = argsOf(input);
  const every = intIn(waterEveryMinutes, 1, 1440);
  const from = minutesOf(waterFrom);
  const to = minutesOf(waterTo);
  if (every === null || from === null || to === null || from >= to) return Object.freeze([]);
  const step = Math.max(every, MEAL_RULES.WATER_MIN_INTERVAL_MINUTES);
  const times = [];
  for (let t = from; t <= to && times.length < MEAL_RULES.WATER_MAX_REMINDERS_PER_DAY; t += step) {
    times.push(clockOf(t));
  }
  return Object.freeze(times);
}

function compareItems(a, b) {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;
  return collator.compare(a.id, b.id) || collator.compare(a.title, b.title);
}

/**
 * Päivän muistutuskohteet ateriarytmistä.
 *
 * Kohteen tunniste on deterministinen (`meal:<päivä>:<laji>:<avain>`), jotta
 * ilmoituskerros voi tunnistaa jo ajastetun ja kuitatun kohteen eikä toista
 * sitä. Sama tunniste kahdesti (syötevirhe) tuottaa yhden kohteen.
 *
 * @param {{mealRhythm: object, dateIso: string}} input
 * @returns {ReadonlyArray<{id:string, date:string, time:string, kind:string,
 *   title:string, topic:string, sourceId:string|null}>}
 */
export function dailyMealItems(input) {
  const { mealRhythm, dateIso } = argsOf(input);
  if (!isObject(mealRhythm) || !isIsoDate(dateIso)) return Object.freeze([]);
  const items = [];
  const push = (kind, key, minutes, title, sourceId) => {
    items.push({
      id: `meal:${dateIso}:${kind}:${key}`,
      date: dateIso,
      time: clockOf(minutes),
      kind,
      title,
      topic: REMINDER_TOPIC.MEAL,
      sourceId
    });
  };

  const meals = Array.isArray(mealRhythm.meals) ? mealRhythm.meals : [];
  for (const meal of meals.slice(0, MAX_MEALS * 4)) {
    if (!isObject(meal)) continue;
    const minutes = minutesOf(meal.time);
    if (minutes === null) continue;
    const name = cleanName(meal.name) || 'Ateria';
    const sourceId = cleanKey(meal.id);
    const key = sourceId || `${clockOf(minutes)}-${name.toLocaleLowerCase('fi')}`;
    push(MEAL_ITEM_KIND.MEAL, key, minutes, name, sourceId);
    const prep = intIn(meal.prepMinutes, 0, MEAL_RULES.MAX_PREP_MINUTES);
    // Valmistelu, joka alkaisi edellisenä päivänä, jätetään pois: se
    // kuuluisi toisen päivän listaan, ja validointi kertoo siitä.
    if (prep !== null && prep > 0 && minutes - prep >= 0) {
      push(MEAL_ITEM_KIND.MEAL_PREP, key, minutes - prep, `Valmistelu: ${name}`, sourceId);
    }
  }

  const supplements = Array.isArray(mealRhythm.supplements) ? mealRhythm.supplements : [];
  for (const supplement of supplements.slice(0, MEAL_RULES.MAX_SUPPLEMENTS * 4)) {
    if (!isObject(supplement)) continue;
    const minutes = minutesOf(supplement.time);
    if (minutes === null) continue;
    const name = cleanName(supplement.name) || 'Lisäravinne';
    const sourceId = cleanKey(supplement.id);
    push(MEAL_ITEM_KIND.SUPPLEMENT, sourceId || `${clockOf(minutes)}-${name.toLocaleLowerCase('fi')}`,
      minutes, name, sourceId);
  }

  for (const time of waterReminderTimes(mealRhythm)) {
    push(MEAL_ITEM_KIND.WATER, time, minutesOf(time), 'Vesitauko', null);
  }

  const cutoff = minutesOf(mealRhythm.lateEatingCutoff);
  if (cutoff !== null) push(MEAL_ITEM_KIND.LATE_CUTOFF, 'cutoff', cutoff, 'Ruokailun iltaraja', null);

  items.sort(compareItems);
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(Object.freeze(item));
  }
  return Object.freeze(unique);
}

function result(errors) {
  return Object.freeze({ valid: Object.keys(errors).length === 0, errors: Object.freeze(errors) });
}

/**
 * Tarkista ateriarytmi ennen tallennusta.
 *
 * @returns {{valid:boolean, errors:Object<string,string>}}
 */
export function validateMealRhythm(mealRhythm) {
  const errors = {};
  if (mealRhythm === null || mealRhythm === undefined) return result(errors);
  if (!isObject(mealRhythm)) {
    return result({ mealRhythm: 'Ateriarytmi ei ole kelvollinen.' });
  }

  const meals = mealRhythm.meals ?? [];
  if (!Array.isArray(meals)) {
    errors.meals = 'Ateriat eivät ole kelvollinen lista.';
  } else {
    if (meals.length > MAX_MEALS) errors.meals = `Aterioita voi olla enintään ${MAX_MEALS}.`;
    meals.forEach((meal, index) => {
      if (!isObject(meal)) {
        errors[`meals.${index}`] = 'Ateria ei ole kelvollinen.';
        return;
      }
      if (!cleanName(meal.name)) errors[`meals.${index}.name`] = 'Anna aterialle nimi.';
      const minutes = minutesOf(meal.time);
      if (minutes === null) errors[`meals.${index}.time`] = 'Anna aika muodossa HH:MM.';
      if (meal.prepMinutes !== null && meal.prepMinutes !== undefined && meal.prepMinutes !== '') {
        const prep = intIn(meal.prepMinutes, 0, MEAL_RULES.MAX_PREP_MINUTES);
        if (prep === null) {
          errors[`meals.${index}.prepMinutes`] = `Valmistelun kesto on 0–${MEAL_RULES.MAX_PREP_MINUTES} minuuttia.`;
        } else if (minutes !== null && minutes - prep < 0) {
          errors[`meals.${index}.prepMinutes`] = 'Valmistelu alkaisi edellisenä päivänä. Lyhennä valmistelua tai siirrä ateriaa.';
        }
      }
    });
  }

  const supplements = mealRhythm.supplements ?? [];
  if (!Array.isArray(supplements)) {
    errors.supplements = 'Lisäravinteet eivät ole kelvollinen lista.';
  } else {
    if (supplements.length > MEAL_RULES.MAX_SUPPLEMENTS) {
      errors.supplements = `Lisäravinnemuistutuksia voi olla enintään ${MEAL_RULES.MAX_SUPPLEMENTS}.`;
    }
    supplements.forEach((supplement, index) => {
      if (!isObject(supplement)) {
        errors[`supplements.${index}`] = 'Muistutus ei ole kelvollinen.';
        return;
      }
      if (!cleanName(supplement.name)) errors[`supplements.${index}.name`] = 'Anna nimi.';
      if (minutesOf(supplement.time) === null) errors[`supplements.${index}.time`] = 'Anna aika muodossa HH:MM.';
    });
  }

  const hasWater = [mealRhythm.waterEveryMinutes, mealRhythm.waterFrom, mealRhythm.waterTo]
    .some(value => value !== null && value !== undefined && value !== '');
  if (hasWater) {
    const every = intIn(mealRhythm.waterEveryMinutes, 1, 1440);
    const from = minutesOf(mealRhythm.waterFrom);
    const to = minutesOf(mealRhythm.waterTo);
    if (every === null || every < MEAL_RULES.WATER_MIN_INTERVAL_MINUTES) {
      errors.waterEveryMinutes = `Vesimuistutusten väli on vähintään ${MEAL_RULES.WATER_MIN_INTERVAL_MINUTES} minuuttia.`;
    }
    if (from === null) errors.waterFrom = 'Anna alkamisaika muodossa HH:MM.';
    if (to === null) errors.waterTo = 'Anna päättymisaika muodossa HH:MM.';
    if (from !== null && to !== null && from >= to) {
      errors.waterTo = 'Päättymisajan pitää olla alkamisajan jälkeen samana päivänä.';
    }
    if (every !== null && every >= MEAL_RULES.WATER_MIN_INTERVAL_MINUTES && from !== null && to !== null && from < to
      && Math.floor((to - from) / every) + 1 > MEAL_RULES.WATER_MAX_REMINDERS_PER_DAY) {
      errors.waterEveryMinutes = `Vesimuistutuksia tulisi yli ${MEAL_RULES.WATER_MAX_REMINDERS_PER_DAY} päivässä. Pidennä väliä tai lyhennä aikaa.`;
    }
  }

  const cutoff = mealRhythm.lateEatingCutoff;
  if (cutoff !== null && cutoff !== undefined && cutoff !== '' && minutesOf(cutoff) === null) {
    errors.lateEatingCutoff = 'Anna iltaraja muodossa HH:MM.';
  }

  return result(errors);
}
