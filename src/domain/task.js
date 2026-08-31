// Tehtävän domain-malli: normalisointi, validointi ja järjestys.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei globaalia tilaa. Kaikki funktiot
// ovat testattavissa suoraan.
//
// HUOM skeemasta: osa kentistä (description, durationMinutes, priority,
// schedulingState) elää tällä hetkellä VAIN domainissa ja käyttöliittymässä.
// Ne eivät vielä tallennu tietokantaan, koska se vaatisi migraation 0002:n
// ajamisen tuotantoon. Ks. src/data/schema.js ja docs/SCHEMA.md.
// Domain on kirjoitettu valmiiksi oikein, jotta migraation jälkeen ei tarvita
// uutta refaktorointia.

import { normalizeCategory } from './categories.js';
import { normalizePriority, priorityWeight } from './priority.js';

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;

/** Aikataulutuksen tila. Erottaa käyttäjän päätöksen automaatin ehdotuksesta. */
export const SCHEDULING = Object.freeze({
  /** Käyttäjä on itse asettanut ajan. Automaatti ei saa siirtää tätä. */
  MANUAL: 'manual',
  /** Käyttäjä on hyväksynyt automaatin ehdottaman ajan. Automaatti saa siirtää. */
  AUTO: 'auto',
  /** Ei aikaa. Odottaa sijoittamista. */
  UNSCHEDULED: 'unscheduled'
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

export function isTimeOfDay(value) {
  return typeof value === 'string' && HHMM.test(value);
}

/** 'HH:MM' -> minuutteja keskiyöstä. */
export function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Minuutteja keskiyöstä -> 'HH:MM'. Kiertää vuorokauden yli. */
export function fromMinutes(total) {
  const wrapped = ((Math.round(total) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/**
 * Tehtävän kesto minuutteina.
 * Ensisijaisesti alku- ja loppuajasta, muuten erillisestä kestokentästä.
 * Keskiyön yli menevä väli lasketaan oikein (esim. 22:00–06:00 = 480).
 */
export function durationOf(task) {
  if (task.time && task.endTime) {
    const start = toMinutes(task.time);
    const end = toMinutes(task.endTime);
    const span = end > start ? end - start : (1440 - start) + end;
    return span === 0 ? null : span;
  }
  if (Number.isFinite(task.durationMinutes) && task.durationMinutes > 0) {
    return task.durationMinutes;
  }
  return null;
}

/**
 * Tehtävän tosiasiallinen loppuaika.
 * Jos loppuaikaa ei ole mutta kesto tiedetään, se lasketaan.
 */
export function effectiveEndTime(task) {
  if (task.endTime) return task.endTime;
  if (task.time && Number.isFinite(task.durationMinutes) && task.durationMinutes > 0) {
    return fromMinutes(toMinutes(task.time) + task.durationMinutes);
  }
  return null;
}


/** Aikataulutuksen tila johdettuna. Ei koskaan luota pelkkään tallennettuun arvoon. */
export function schedulingStateOf(task) {
  if (!task.time) return SCHEDULING.UNSCHEDULED;
  return task.schedulingState === SCHEDULING.AUTO ? SCHEDULING.AUTO : SCHEDULING.MANUAL;
}

/**
 * Saako automaattinen aikataulutus siirtää tätä tehtävää?
 *
 * EI, jos käyttäjä on itse asettanut ajan. Tämä on tuotteen keskeinen lupaus:
 * järjestelmä ei saa tuhota käyttäjän omaa päätöstä (konseptidokumentti,
 * luku 7: "Joustavuus ilman hallinnan menetystä").
 */
export function isMovableByScheduler(task) {
  if (task.completed) return false;
  if (task.isWake) return false;
  return schedulingStateOf(task) !== SCHEDULING.MANUAL;
}

/**
 * Normalisoi mielivaltaisen olion tehtäväksi.
 * Tuntemattomat kentät pudotetaan, virheelliset arvot korvataan oletuksilla.
 * Ei koskaan heitä poikkeusta — validointiin käytä validateTask().
 */
export function normalizeTask(input = {}) {
  const time = isTimeOfDay(input.time) ? input.time : null;
  const endTime = isTimeOfDay(input.endTime) ? input.endTime : null;

  const rawDuration = Number(input.durationMinutes);
  const durationMinutes = Number.isFinite(rawDuration) && rawDuration > 0
    ? Math.round(rawDuration)
    : null;

  return {
    id: input.id != null ? String(input.id) : null,
    title: String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),
    description: input.description
      ? String(input.description).trim().slice(0, MAX_DESCRIPTION_LENGTH)
      : null,
    date: isIsoDate(input.date) ? input.date : null,
    time,
    endTime,
    durationMinutes,
    category: normalizeCategory(input.category),
    priority: normalizePriority(input.priority),
    completed: Boolean(input.completed),
    isWake: Boolean(input.isWake),
    note: input.note ? String(input.note) : null,
    schedulingState: time
      ? (input.schedulingState === SCHEDULING.AUTO ? SCHEDULING.AUTO : SCHEDULING.MANUAL)
      : SCHEDULING.UNSCHEDULED,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

/**
 * Validoi tehtävän. Palauttaa { valid, errors } jossa errors on
 * kenttä -> suomenkielinen viesti.
 */
export function validateTask(task) {
  const errors = {};

  const title = String(task.title ?? '').trim();
  if (!title) errors.title = 'Anna tehtävälle nimi.';
  else if (title.length > MAX_TITLE_LENGTH) errors.title = `Nimi on liian pitkä (enintään ${MAX_TITLE_LENGTH} merkkiä).`;

  if (!isIsoDate(task.date)) errors.date = 'Valitse päivämäärä.';

  if (task.time != null && !isTimeOfDay(task.time)) errors.time = 'Kellonaika ei kelpaa.';
  if (task.endTime != null && !isTimeOfDay(task.endTime)) errors.endTime = 'Loppuaika ei kelpaa.';

  if (task.endTime && !task.time) errors.endTime = 'Anna ensin alkuaika.';
  if (task.time && task.endTime && task.time === task.endTime) {
    errors.endTime = 'Loppuajan pitää poiketa alkuajasta.';
  }

  if (task.description && String(task.description).length > MAX_DESCRIPTION_LENGTH) {
    errors.description = 'Kuvaus on liian pitkä.';
  }

  if (task.durationMinutes != null) {
    const d = Number(task.durationMinutes);
    if (!Number.isFinite(d) || d <= 0) errors.durationMinutes = 'Keston pitää olla positiivinen.';
    else if (d > 1440) errors.durationMinutes = 'Kesto ei voi ylittää vuorokautta.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Järjestys päivän sisällä.
 *
 * 1. Aikataulutetut ennen aikatauluttamattomia
 * 2. Aikataulutetut kellonajan mukaan
 * 3. Aikatauluttamattomat prioriteetin mukaan
 * 4. Tasatilanteessa nimen mukaan — takaa determinismin
 */
export function compareForDay(a, b) {
  const aTimed = Boolean(a.time);
  const bTimed = Boolean(b.time);
  if (aTimed !== bTimed) return aTimed ? -1 : 1;

  if (aTimed && bTimed && a.time !== b.time) return a.time < b.time ? -1 : 1;

  const byPriority = priorityWeight(a.priority) - priorityWeight(b.priority);
  if (byPriority !== 0) return byPriority;

  return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'fi');
}

/** Järjestys useamman päivän listassa: päivä ensin, sitten päivän sisäinen järjestys. */
export function compareByDateThenDay(a, b) {
  if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
  return compareForDay(a, b);
}

/** Menevätkö kahden tehtävän aikavälit päällekkäin? Ajattomat eivät koskaan. */
export function overlaps(a, b) {
  if (!a.time || !b.time) return false;
  const aStart = toMinutes(a.time);
  const bStart = toMinutes(b.time);
  const aEnd = aStart + (durationOf(a) ?? 0);
  const bEnd = bStart + (durationOf(b) ?? 0);
  if (aEnd === aStart || bEnd === bStart) return aStart === bStart;
  return aStart < bEnd && bStart < aEnd;
}

/** Päivän tehtävät jaoteltuna näkymää varten. */
export function partitionDay(tasks) {
  const scheduled = [];
  const unscheduled = [];
  const completed = [];
  for (const task of tasks) {
    if (task.completed) completed.push(task);
    else if (task.time) scheduled.push(task);
    else unscheduled.push(task);
  }
  return {
    scheduled: scheduled.sort(compareForDay),
    unscheduled: unscheduled.sort(compareForDay),
    completed: completed.sort(compareForDay)
  };
}
