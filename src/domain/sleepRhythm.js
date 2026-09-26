// Unirytmi: herätys, nukkumaanmeno, iltarutiini ja viikonlopun väljyys.
//
// PUHDAS MODUULI. Ei kelloa (päivä ja tarvittaessa aikavyöhykefunktio
// annetaan), ei DOM:ia, ei verkkoa, ei satunnaisuutta. Tulokset jäädytetään.
//
// PERIAATE: UNI ON SUOJATTU
//
// Uni ei ole "se mikä jää yli". Nukkumaanmeno lasketaan taaksepäin
// seuraavasta herätyksestä: herätys - unitavoite. Arkiaamun herätys on
// profiilin oletus, ellei kiinteä meno vaadi aiempaa. Viikonloppuna herätys
// saa siirtyä enintään käyttäjän itse asettaman väljyyden verran.
//
// MITÄ TÄMÄ EI TEE
//
// Sovellus ei mittaa unta. Se tietää vain, milloin käyttäjä kertoo menneensä
// vuoteeseen ja nousseensa (mahdollisuus nukkua, SLEEP_KIND.OPPORTUNITY).
// Siksi mikään teksti ei väitä "nukuit 6 tuntia", eikä mikään ehdotus ole
// terveysneuvo: kaikki on ehdotuksia, jotka käyttäjä voi ohittaa.
//
// Vertailukohta on aina käyttäjän oma luku (unitavoite, herätysaika,
// viikonlopun väljyys), ei väestön keskiarvo. Tuntematon on null, ei nolla.

import {
  PROTECTION, SLEEP_KIND,
  DEFAULT_WIND_DOWN_MINUTES, MAX_WIND_DOWN_MINUTES,
  DEFAULT_WEEKEND_SHIFT_MINUTES, MAX_WEEKEND_SHIFT_MINUTES
} from './dailyLife.js';
import { DEFAULT_PROFILE } from './scheduler.js';
import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes } from './task.js';
import {
  MINUTES_PER_DAY, ZERO_OFFSET, dayNumberOf, shiftDateIso, isoWeekday,
  wallClockToEpoch, epochToWallClock, elapsedMinutes, clockText, durationText
} from './wallClock.js';

/** Paluu arkirytmiin etenee enintään näin monta minuuttia yössä. */
export const MAX_RETURN_STEP_MINUTES = 30;

/** Rytmin seuranta katsoo näin monta päivää taaksepäin (4 viikkoa). */
export const DRIFT_WINDOW_DAYS = 28;

/** Siirtymästä kerrotaan vasta, kun väljyys ylittyy näin monena viikonloppuna. */
export const DRIFT_MIN_WEEKENDS = 2;

/** Arjen vertailukohta lasketaan kirjauksista vasta näin monesta arkiaamusta. */
export const DRIFT_MIN_REFERENCE_DAYS = 3;

/** Illan huomautus vasta, kun huominen alkaa vähintään näin paljon aiemmin. */
export const EVENING_NOTICE_MIN_MINUTES = 5;

/** Unitavoitteen rajat tunteina (samat kuin profiilin lomakkeessa). */
export const MIN_SLEEP_TARGET_HOURS = 1;
export const MAX_SLEEP_TARGET_HOURS = 14;

/** Pidempi vuoteessaolo on todennäköisemmin kirjausvirhe kuin yö: tuntematon. */
export const MAX_TIME_IN_BED_MINUTES = 18 * 60;

/** Mistä herätysaika tuli. */
export const WAKE_SOURCE = Object.freeze({
  DEFAULT: 'default',
  WEEKEND: 'weekend',
  COMMITMENT: 'commitment'
});

/** Mistä nukkumaanmenoaika tuli. */
export const BEDTIME_SOURCE = Object.freeze({
  SLEEP_TARGET: 'sleep_target',
  BEDTIME_TARGET: 'bedtime_target'
});

/** Mihin rytmin vertailukohta perustuu. */
export const REFERENCE_BASIS = Object.freeze({
  OBSERVED: 'observed',
  DECLARED: 'declared'
});

const NOON = 12 * 60;
const LAST_MINUTE = MINUTES_PER_DAY - 1;
const MS_PER_MINUTE = 60000;

// ------------------------------------------------------------ apurit

function objectOf(value) {
  return value && typeof value === 'object' ? value : {};
}

function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function offsetFnOf(value) {
  return typeof value === 'function' ? value : ZERO_OFFSET;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** Kellonaika suhteessa herätyspäivän keskiyöhön: iltapäivä ja ilta ovat edellistä päivää. */
function relativeToWakeDay(time) {
  const minutes = toMinutes(time);
  return minutes >= NOON ? minutes - MINUTES_PER_DAY : minutes;
}

function mean(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return Math.round(sum / values.length);
}

// ------------------------------------------------------------ profiili ja asetukset

/** Unitavoite minuutteina. Puuttuva tai järjetön arvo -> profiilin oletus (8 h), kuten muualla sovelluksessa. */
export function sleepTargetMinutes(profile) {
  const hours = objectOf(profile).sleepTargetHours;
  const valid = typeof hours === 'number' && Number.isFinite(hours)
    && hours >= MIN_SLEEP_TARGET_HOURS && hours <= MAX_SLEEP_TARGET_HOURS;
  return Math.round((valid ? hours : DEFAULT_PROFILE.sleepTargetHours) * 60);
}

/** Arkiaamun herätys profiilista ('HH:MM'). */
export function defaultWakeOf(profile) {
  const value = objectOf(profile).defaultWakeTime;
  return isTimeOfDay(value) ? value : DEFAULT_PROFILE.defaultWakeTime;
}

/** Unirytmin asetukset LifeSettingsistä rajattuina; puuttuva -> oletus. */
export function rhythmSettingsOf(settings) {
  const s = objectOf(settings);
  return Object.freeze({
    weekendWakeShiftMaxMinutes: clampInt(s.weekendWakeShiftMaxMinutes, 0, MAX_WEEKEND_SHIFT_MINUTES, DEFAULT_WEEKEND_SHIFT_MINUTES),
    weekendBedShiftMaxMinutes: clampInt(s.weekendBedShiftMaxMinutes, 0, MAX_WEEKEND_SHIFT_MINUTES, DEFAULT_WEEKEND_SHIFT_MINUTES),
    windDownMinutes: clampInt(s.windDownMinutes, 0, MAX_WIND_DOWN_MINUTES, DEFAULT_WIND_DOWN_MINUTES),
    bedtimeTarget: isTimeOfDay(s.bedtimeTarget) ? s.bedtimeTarget : null
  });
}

// ------------------------------------------------------------ päivän unirytmi

function wakeSentence(source, wakeTime, rhythm, earlierMinutes) {
  if (source === WAKE_SOURCE.COMMITMENT) {
    return `Aamun meno vaatii herätyksen ${clockText(wakeTime)}, ${durationText(earlierMinutes)} tavallista aiemmin.`;
  }
  if (source === WAKE_SOURCE.WEEKEND) {
    return rhythm.weekendWakeShiftMaxMinutes > 0
      ? `Viikonloppuna herätys saa siirtyä enintään ${durationText(rhythm.weekendWakeShiftMaxMinutes)} myöhemmäksi: herätys ${clockText(wakeTime)}.`
      : `Viikonloppunakin herätys on ${clockText(wakeTime)}, kuten arkena.`;
  }
  return `Arkiaamun herätys on ${clockText(wakeTime)}, kuten olet profiilissa asettanut.`;
}

/**
 * Yhden herätyspäivän unirytmi.
 *
 * - Arkena herätys = profiilin oletus, ellei requiredWake ole aiempi.
 * - Viikonloppuna herätys saa siirtyä enintään weekendWakeShiftMaxMinutes
 *   myöhemmäksi; kiinteä meno voi silti vaatia aiemman.
 * - Nukkumaanmeno = herätys - unitavoite (edellisenä iltana). Jos oma
 *   nukkumaanmenotavoite on aiempi, se pysyy (viikonloppuöinä siihen saa
 *   lisätä viikonlopun väljyyden).
 * - Iltarutiini alkaa nukkumaanmeno - windDownMinutes.
 *
 * offsetMinutesFn (valinnainen, ks. wallClock.js): kesäajan vaihtoyönä
 * unitavoite lasketaan todellisena kestona, ei seinäkellon erotuksena.
 *
 * @returns {null | object} null, jos päivä on virheellinen
 */
export function sleepScheduleFor(input) {
  const { dateIso, profile, settings, requiredWake = null, offsetMinutesFn } = objectOf(input);
  if (!isIsoDate(dateIso)) return null;
  const fn = offsetFnOf(offsetMinutesFn);
  const rhythm = rhythmSettingsOf(settings);
  const sleepMinutes = sleepTargetMinutes(profile);
  const weekday = isoWeekday(dateIso);
  const weekend = weekday === 6 || weekday === 7;

  let usualWakeMinutes = toMinutes(defaultWakeOf(profile));
  if (weekend) usualWakeMinutes = Math.min(usualWakeMinutes + rhythm.weekendWakeShiftMaxMinutes, LAST_MINUTE);
  const usualWakeTime = fromMinutes(usualWakeMinutes);

  let wakeTime = usualWakeTime;
  let source = weekend ? WAKE_SOURCE.WEEKEND : WAKE_SOURCE.DEFAULT;
  if (isTimeOfDay(requiredWake) && toMinutes(requiredWake) < usualWakeMinutes) {
    wakeTime = requiredWake;
    source = WAKE_SOURCE.COMMITMENT;
  }

  const wake = wallClockToEpoch(dateIso, wakeTime, fn);
  if (!wake) return null;

  let bedMs = wake.epochMs - sleepMinutes * MS_PER_MINUTE;
  let bedtimeSource = BEDTIME_SOURCE.SLEEP_TARGET;
  if (rhythm.bedtimeTarget) {
    const targetDate = toMinutes(rhythm.bedtimeTarget) >= NOON ? shiftDateIso(dateIso, -1) : dateIso;
    const target = targetDate ? wallClockToEpoch(targetDate, rhythm.bedtimeTarget, fn) : null;
    if (target) {
      const allowance = weekend ? rhythm.weekendBedShiftMaxMinutes : 0;
      const targetMs = target.epochMs + allowance * MS_PER_MINUTE;
      if (targetMs < bedMs) {
        bedMs = targetMs;
        bedtimeSource = BEDTIME_SOURCE.BEDTIME_TARGET;
      }
    }
  }
  const windDownMs = bedMs - rhythm.windDownMinutes * MS_PER_MINUTE;
  const bed = epochToWallClock(bedMs, fn);
  const windDown = epochToWallClock(windDownMs, fn);
  if (!bed || !windDown) return null;

  const earlierThanUsualMinutes = source === WAKE_SOURCE.COMMITMENT
    ? usualWakeMinutes - toMinutes(wakeTime)
    : 0;
  const timeInBedMinutes = Math.round((wake.epochMs - bedMs) / MS_PER_MINUTE);

  const bedPart = bedtimeSource === BEDTIME_SOURCE.BEDTIME_TARGET
    ? `Nukkumaan ${clockText(bed.time)} oman nukkumaanmenotavoitteesi mukaan`
    : `${durationText(sleepMinutes)} unitavoitteella nukkumaan ${clockText(bed.time)}`;
  const windPart = rhythm.windDownMinutes > 0 ? `, iltarutiini alkaa ${clockText(windDown.time)}.` : '.';

  return Object.freeze({
    date: dateIso,
    weekday,
    weekend,
    wakeTime: wake.time,
    wakeAdjusted: wake.adjusted,
    usualWakeTime,
    earlierThanUsualMinutes,
    bedtime: bed.time,
    bedtimeDate: bed.date,
    windDownStart: windDown.time,
    windDownDate: windDown.date,
    windDownMinutes: rhythm.windDownMinutes,
    sleepMinutes,
    timeInBedMinutes,
    source,
    bedtimeSource,
    protected: true,
    protection: PROTECTION.PROTECTED,
    reason: `${wakeSentence(source, wake.time, rhythm, earlierThanUsualMinutes)} ${bedPart}${windPart}`
  });
}

// ------------------------------------------------------------ vuoteessaolo

/**
 * Mahdollisuus nukkua (vuoteessaoloaika) minuutteina kirjauksesta:
 * actualBedtime -> actualWake. EI mitattua unta. Puuttuva tai
 * epäuskottava kirjaus -> null, ei nolla.
 *
 * Toinen parametri { offsetMinutesFn } tekee kesäajan vaihtoyöstä
 * todellisen pituisen (kevät 7 h, syksy 9 h seinäkellon 8 tunnista).
 */
export function sleepOpportunity(log, options) {
  if (!log || typeof log !== 'object') return null;
  const { wakeDate, actualBedtime, actualWake } = log;
  if (!isIsoDate(wakeDate) || !isTimeOfDay(actualBedtime) || !isTimeOfDay(actualWake)) return null;
  const bed = toMinutes(actualBedtime);
  const wake = toMinutes(actualWake);
  if (bed === wake) return null;
  const bedDate = bed > wake ? shiftDateIso(wakeDate, -1) : wakeDate;
  if (!bedDate) return null;
  const minutes = elapsedMinutes(
    { date: bedDate, time: actualBedtime },
    { date: wakeDate, time: actualWake },
    offsetFnOf(objectOf(options).offsetMinutesFn)
  );
  if (minutes === null || minutes <= 0 || minutes > MAX_TIME_IN_BED_MINUTES) return null;
  return minutes;
}

// ------------------------------------------------------------ rytmin siirtymä

function chooseLog(current, candidate) {
  if (!current) return candidate;
  const a = typeof current.updatedAt === 'string' ? current.updatedAt : '';
  const b = typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '';
  if (a !== b) return b > a ? candidate : current;
  const idA = typeof current.id === 'string' ? current.id : '';
  const idB = typeof candidate.id === 'string' ? candidate.id : '';
  return idB.localeCompare(idA, 'fi') > 0 ? candidate : current;
}

function groupSummary(entries, fn) {
  const wakes = [];
  const beds = [];
  const opportunities = [];
  for (const entry of entries) {
    if (entry.wake !== null) wakes.push(entry.wake);
    if (entry.bed !== null) beds.push(entry.bed);
    const opportunity = sleepOpportunity(entry.log, { offsetMinutesFn: fn });
    if (opportunity !== null) opportunities.push(opportunity);
  }
  const meanWake = mean(wakes);
  const meanBed = mean(beds);
  return {
    count: entries.length,
    wakeCount: wakes.length,
    bedtimeCount: beds.length,
    meanWakeMinutes: meanWake,
    meanWake: meanWake === null ? null : fromMinutes(meanWake),
    meanBedtimeMinutes: meanBed,
    meanBedtime: meanBed === null ? null : fromMinutes(meanBed),
    meanTimeInBedMinutes: mean(opportunities)
  };
}

/**
 * Arjen ja viikonlopun rytmin ero kirjatuista ajoista (vuoteeseen meno ja
 * nousu). Kertoo siirtymästä vasta, kun viikonlopun väljyys on ylittynyt
 * vähintään DRIFT_MIN_WEEKENDS viikonloppuna viimeisen DRIFT_WINDOW_DAYS
 * päivän aikana. Kyse on mahdollisuudesta nukkua, ei mitatusta unesta.
 *
 * Vertailukohta: arkiaamujen kirjausten keskiarvo, kun niitä on vähintään
 * DRIFT_MIN_REFERENCE_DAYS; muuten käyttäjän oma profiilin herätysaika ja
 * siitä laskettu nukkumaanmeno.
 */
export function driftReport(input) {
  const { logs, profile, settings, todayIso, offsetMinutesFn } = objectOf(input);
  const todayNumber = dayNumberOf(todayIso);
  if (todayNumber === null) return null;
  const fn = offsetFnOf(offsetMinutesFn);
  const rhythm = rhythmSettingsOf(settings);
  const windowStart = shiftDateIso(todayIso, -(DRIFT_WINDOW_DAYS - 1));
  const startNumber = todayNumber - (DRIFT_WINDOW_DAYS - 1);

  // Yksi kirjaus päivää kohden (tietokannassa uniikki; tässä deterministinen valinta).
  const byDate = new Map();
  for (const log of Array.isArray(logs) ? logs : []) {
    if (!log || typeof log !== 'object') continue;
    const number = dayNumberOf(log.wakeDate);
    if (number === null || number < startNumber || number > todayNumber) continue;
    byDate.set(log.wakeDate, chooseLog(byDate.get(log.wakeDate), log));
  }

  const weekdayEntries = [];
  const weekendEntries = [];
  const dates = [...byDate.keys()].sort();
  for (const date of dates) {
    const log = byDate.get(date);
    const wake = isTimeOfDay(log.actualWake) ? toMinutes(log.actualWake) : null;
    let bed = isTimeOfDay(log.actualBedtime) ? relativeToWakeDay(log.actualBedtime) : null;
    if (bed !== null && wake !== null && bed >= wake) bed = null; // ristiriitainen kirjaus: ei arvata
    if (wake === null && bed === null) continue;
    const weekday = isoWeekday(date);
    const entry = { date, weekday, wake, bed, log };
    if (weekday === 6 || weekday === 7) weekendEntries.push(entry);
    else weekdayEntries.push(entry);
  }

  const weekday = groupSummary(weekdayEntries, fn);
  const weekend = groupSummary(weekendEntries, fn);

  // Vertailukohta: havaittu arki tai käyttäjän oma ilmoitus.
  const declared = sleepScheduleFor({ dateIso: todayIso, profile, settings: { ...objectOf(settings), weekendWakeShiftMaxMinutes: 0, weekendBedShiftMaxMinutes: 0 } });
  const declaredWake = toMinutes(defaultWakeOf(profile));
  const declaredBed = (dayNumberOf(declared.bedtimeDate) - todayNumber) * MINUTES_PER_DAY + toMinutes(declared.bedtime);
  const wakeBasis = weekday.wakeCount >= DRIFT_MIN_REFERENCE_DAYS ? REFERENCE_BASIS.OBSERVED : REFERENCE_BASIS.DECLARED;
  const bedBasis = weekday.bedtimeCount >= DRIFT_MIN_REFERENCE_DAYS ? REFERENCE_BASIS.OBSERVED : REFERENCE_BASIS.DECLARED;
  const referenceWake = wakeBasis === REFERENCE_BASIS.OBSERVED ? weekday.meanWakeMinutes : declaredWake;
  const referenceBed = bedBasis === REFERENCE_BASIS.OBSERVED ? weekday.meanBedtimeMinutes : declaredBed;

  // Viikonloput lauantain mukaan: lauantai- ja sunnuntaiaamu.
  const weekendMap = new Map();
  for (const entry of weekendEntries) {
    const saturday = entry.weekday === 6 ? entry.date : shiftDateIso(entry.date, -1);
    const current = weekendMap.get(saturday) || { saturday, wakeShift: null, bedShift: null };
    if (entry.wake !== null) {
      const shift = entry.wake - referenceWake;
      current.wakeShift = current.wakeShift === null ? shift : Math.max(current.wakeShift, shift);
    }
    if (entry.bed !== null) {
      const shift = entry.bed - referenceBed;
      current.bedShift = current.bedShift === null ? shift : Math.max(current.bedShift, shift);
    }
    weekendMap.set(saturday, current);
  }
  const weekends = [...weekendMap.values()]
    .sort((a, b) => a.saturday.localeCompare(b.saturday))
    .map(item => ({
      saturday: item.saturday,
      wakeShiftMinutes: item.wakeShift,
      bedShiftMinutes: item.bedShift,
      beyond: (item.wakeShift !== null && item.wakeShift > rhythm.weekendWakeShiftMaxMinutes)
        || (item.bedShift !== null && item.bedShift > rhythm.weekendBedShiftMaxMinutes)
    }));
  const beyondCount = weekends.filter(item => item.beyond).length;
  const drifting = beyondCount >= DRIFT_MIN_WEEKENDS;

  const wakeShiftMinutes = weekend.meanWakeMinutes === null ? null : weekend.meanWakeMinutes - referenceWake;
  const bedShiftMinutes = weekend.meanBedtimeMinutes === null ? null : weekend.meanBedtimeMinutes - referenceBed;

  let message = null;
  if (drifting) {
    const weeks = Math.round(DRIFT_WINDOW_DAYS / 7);
    const parts = [`Viikonlopun rytmi on siirtynyt asettamaasi väljyyttä enemmän ${beyondCount} viikonloppuna viimeisen ${weeks} viikon aikana.`];
    if (wakeShiftMinutes !== null && wakeShiftMinutes > 0) {
      parts.push(`Viikonloppuisin nouset keskimäärin ${durationText(wakeShiftMinutes)} arkea myöhemmin.`);
    }
    if (bedShiftMinutes !== null && bedShiftMinutes > 0) {
      parts.push(`Nukkumaan menet keskimäärin ${durationText(bedShiftMinutes)} arkea myöhemmin.`);
    }
    parts.push('Tämä perustuu kirjaamiisi kellonaikoihin, ei unen mittaukseen.');
    message = parts.join(' ');
  }

  return deepFreeze({
    kind: SLEEP_KIND.OPPORTUNITY,
    windowStart,
    windowEnd: todayIso,
    weekday,
    weekend,
    reference: {
      wake: fromMinutes(referenceWake),
      wakeMinutes: referenceWake,
      bedtime: fromMinutes(referenceBed),
      bedtimeMinutes: referenceBed,
      wakeBasis,
      bedtimeBasis: bedBasis
    },
    wakeShiftMinutes,
    bedShiftMinutes,
    wakeAllowanceMinutes: rhythm.weekendWakeShiftMaxMinutes,
    bedAllowanceMinutes: rhythm.weekendBedShiftMaxMinutes,
    weekends,
    beyondCount,
    drifting,
    message
  });
}

// ------------------------------------------------------------ paluu arkeen

/**
 * Viikonlopun jälkeinen paluu arkirytmiin: EHDOTUS, ei muutos.
 *
 * todayIso on lauantai tai sunnuntai. Jos viikonlopun herätys
 * (recentWeekendWake) on maanantain herätystä (mondayWake) myöhempänä
 * enemmän kuin käyttäjän oma väljyys, ehdotetaan porrasta: jokainen
 * ehdotettu aamu enintään MAX_RETURN_STEP_MINUTES aiemmin kuin edellinen.
 * Maanantain herätys on kiinteä; jos porras ei riitä, jäljelle jäävä
 * hyppy kerrotaan rehellisesti (mondayJumpMinutes).
 *
 * @returns {null | object} null, kun ehdotukselle ei ole tarvetta
 */
export function mondayReadiness(input) {
  const { todayIso, mondayWake, recentWeekendWake, settings, profile, offsetMinutesFn } = objectOf(input);
  const weekday = isoWeekday(todayIso);
  if (weekday !== 6 && weekday !== 7) return null;
  if (!isTimeOfDay(mondayWake) || !isTimeOfDay(recentWeekendWake)) return null;
  const fn = offsetFnOf(offsetMinutesFn);
  const rhythm = rhythmSettingsOf(settings);
  const monday = toMinutes(mondayWake);
  const recent = toMinutes(recentWeekendWake);
  const shiftMinutes = recent - monday;
  if (shiftMinutes <= 0 || shiftMinutes <= rhythm.weekendWakeShiftMaxMinutes) return null;

  const sleepMinutes = sleepTargetMinutes(profile);
  const mondayDate = shiftDateIso(todayIso, 8 - weekday);
  if (!mondayDate) return null;

  const steps = [];
  let previous = recent;
  for (let offset = 1; offset <= 8 - weekday; offset += 1) {
    const date = shiftDateIso(todayIso, offset);
    if (!date) return null;
    const isMonday = date === mondayDate;
    const wakeMinutes = isMonday ? monday : Math.max(monday, previous - MAX_RETURN_STEP_MINUTES);
    const wakeTime = fromMinutes(wakeMinutes);
    const wake = wallClockToEpoch(date, wakeTime, fn);
    const bed = wake ? epochToWallClock(wake.epochMs - sleepMinutes * MS_PER_MINUTE, fn) : null;
    if (!wake || !bed) return null;
    steps.push({
      date,
      wakeTime: wake.time,
      bedtime: bed.time,
      bedtimeDate: bed.date,
      earlierByMinutes: previous - wakeMinutes,
      suggestion: !isMonday,
      fixed: isMonday
    });
    previous = wakeMinutes;
  }

  const mondayStep = steps[steps.length - 1];
  const mondayJumpMinutes = mondayStep.earlierByMinutes;
  const opening = `Viikonlopun rytmi on siirtymässä ${durationText(shiftMinutes)} myöhemmäksi.`;
  let message;
  let detail;
  if (weekday === 6) {
    const sunday = steps[0];
    message = `${opening} Haluatko pitää sunnuntain herätyksen lähempänä arkirytmiä?`;
    detail = `Ehdotus: sunnuntaina herätys ${clockText(sunday.wakeTime)} ja maanantaina ${clockText(mondayStep.wakeTime)}.`
      + ` Rytmi palaa enintään ${MAX_RETURN_STEP_MINUTES} min yössä.`;
    if (mondayJumpMinutes > MAX_RETURN_STEP_MINUTES) {
      detail += ` Maanantaiaamu on silti ${durationText(mondayJumpMinutes)} sunnuntaita aiemmin.`;
    }
  } else {
    message = `${opening} Haluatko aloittaa iltarutiinin tänään hieman aiemmin?`;
    detail = `Maanantain herätys on ${clockText(mondayStep.wakeTime)}. ${durationText(sleepMinutes)} unitavoitteella`
      + ` nukkumaan ${clockText(mondayStep.bedtime)}.`;
  }

  return deepFreeze({
    todayIso,
    mondayDate,
    shiftMinutes,
    allowanceMinutes: rhythm.weekendWakeShiftMaxMinutes,
    maxStepMinutes: MAX_RETURN_STEP_MINUTES,
    steps,
    mondayJumpMinutes,
    suggestion: true,
    message,
    detail
  });
}

// ------------------------------------------------------------ edellinen ilta

function scheduleOffsets(schedule) {
  if (!schedule || typeof schedule !== 'object') return null;
  if (!isTimeOfDay(schedule.wakeTime) || !isTimeOfDay(schedule.bedtime)) return null;
  const base = dayNumberOf(schedule.date);
  const relative = (time, date) => {
    const number = dayNumberOf(date);
    if (base !== null && number !== null) return (number - base) * MINUTES_PER_DAY + toMinutes(time);
    return relativeToWakeDay(time);
  };
  const wake = toMinutes(schedule.wakeTime);
  const bed = relative(schedule.bedtime, schedule.bedtimeDate);
  const windDown = isTimeOfDay(schedule.windDownStart) ? relative(schedule.windDownStart, schedule.windDownDate) : bed;
  if (!(bed < wake) || windDown > bed) return null;
  return { wake, bed, windDown };
}

/**
 * Illan huomautus, kun huominen alkaa tavallista aiemmin.
 *
 * tomorrowSchedule ja usualSchedule ovat sleepScheduleFor-tuloksia
 * (huominen menon kanssa ja ilman). cause: 'commute' (työmatka) tai
 * 'commitment'/puuttuva (yleinen meno). Palauttaa null, jos huominen ei ala
 * vähintään EVENING_NOTICE_MIN_MINUTES aiemmin. Vain ehdotus.
 */
export function eveningBefore(input) {
  const { tomorrowSchedule, usualSchedule, cause = null } = objectOf(input);
  const tomorrow = scheduleOffsets(tomorrowSchedule);
  const usual = scheduleOffsets(usualSchedule);
  if (!tomorrow || !usual) return null;
  const deltaMinutes = usual.windDown - tomorrow.windDown;
  if (deltaMinutes < EVENING_NOTICE_MIN_MINUTES) return null;

  const declaredSleep = tomorrowSchedule.sleepMinutes;
  const sleepMinutes = typeof declaredSleep === 'number' && Number.isFinite(declaredSleep) && declaredSleep > 0
    ? Math.round(declaredSleep)
    : tomorrow.wake - tomorrow.bed;

  const causeText = cause === 'commute'
    ? 'Huomisen työmatka vaatii aikaisemman lähdön.'
    : 'Huominen aamu alkaa tavallista aiemmin.';
  const hasWindDown = tomorrow.windDown < tomorrow.bed;
  const action = hasWindDown
    ? `iltarutiini kannattaa aloittaa ${durationText(deltaMinutes)} aiemmin`
    : `nukkumaan kannattaa mennä ${durationText(deltaMinutes)} aiemmin`;
  const windDownStart = isTimeOfDay(tomorrowSchedule.windDownStart) ? tomorrowSchedule.windDownStart : tomorrowSchedule.bedtime;

  return Object.freeze({
    message: `${causeText} Jos haluat säilyttää ${durationText(sleepMinutes)} unen, ${action}.`,
    detail: (hasWindDown ? `Iltarutiini ${clockText(windDownStart)}, nukkumaan` : 'Nukkumaan')
      + ` ${clockText(tomorrowSchedule.bedtime)}, herätys ${clockText(tomorrowSchedule.wakeTime)}.`,
    windDownStart,
    bedtime: tomorrowSchedule.bedtime,
    wakeTime: tomorrowSchedule.wakeTime,
    deltaMinutes,
    sleepMinutes,
    suggestion: true
  });
}
