// Älykäs aamusuunnittelija: aamurutiini taaksepäin ensimmäisestä menosta.
//
// PUHDAS MODUULI. Ei kelloa, ei DOM:ia, ei verkkoa, ei satunnaisuutta.
// Sama syöte tuottaa aina saman suunnitelman; tulos jäädytetään.
//
// MITEN AAMU LASKETAAN
//
// Kun aamussa on kiinteä meno, aamurutiinin vaiheet ajoitetaan peräkkäin
// päättymään menon valmistautumisen alkuun (tai lähtöön, tai menon
// alkuun, jos lähtöä ei tiedetä). Tarvittava herätys on silloin
// ankkuri - vaiheiden kesto. Arkena herätys on silti profiilin oletus,
// ellei meno vaadi aiempaa (sama sääntö kuin sleepRhythm.js:ssä).
//
// SUOJATTU UNI
//
// wakeTimeLimit on aikaisin herätys, jonka suunnitelma saa käyttää
// kysymättä (esim. myöhään nukkumaan menneelle: vuoteeseen + unitavoite).
// Jos aamu ei mahdu sen jälkeen, suunnitelma EI lyhennä unta eikä pudota
// mitään itse. Se kertoo vajeen ja tarjoaa valinnat:
//   1. jätä pois valinnainen vaihe (OPTIONAL)
//   2. lyhennä tai jätä pois tärkeä mutta joustava vaihe (IMPORTANT_FLEXIBLE)
//   3. herää aiemmin: valinta kertoo, montako minuuttia unta se maksaa.
// Pakollista (MANDATORY) tai suojattua (PROTECTED) vaihetta ei koskaan
// ehdoteta pudotettavaksi.

import { PROTECTION, PROTECTIONS, MAX_MORNING_STEPS, MAX_TRAVEL_MINUTES } from './dailyLife.js';
import { DEFAULT_PROFILE } from './scheduler.js';
import { isIsoDate, isTimeOfDay } from './task.js';
import { sleepScheduleFor } from './sleepRhythm.js';
import {
  ZERO_OFFSET, shiftDateIso, wallClockToEpoch, epochToWallClock, clockText, durationText
} from './wallClock.js';

/** Aamun vaiheen enimmäiskesto (sama kuin LifeSettings.morningRoutine). */
export const MAX_STEP_MINUTES = 240;

/** Lyhennetty vaihe kestää vähintään näin kauan; alle sen se kannattaa jättää pois. */
export const MIN_SHORTENED_STEP_MINUTES = 5;

/** Vaiheen nimen enimmäispituus. */
export const MAX_STEP_NAME_LENGTH = 80;

/** Valinnan laji, kun aamu ei mahdu. */
export const CHOICE_KIND = Object.freeze({
  DROP: 'drop',
  SHORTEN: 'shorten',
  WAKE_EARLIER: 'wake_earlier'
});

/** Mihin aamurutiini päättyy. */
export const ANCHOR_KIND = Object.freeze({
  PREPARE: 'prepare',
  LEAVE: 'leave',
  START: 'start'
});

/** Mistä lähtöaika tuli. */
export const LEAVE_SOURCE = Object.freeze({
  COMMITMENT: 'commitment',
  PROFILE_COMMUTE: 'profile_commute'
});

/** Profiilin aamutoimet yhtenä vaiheena, kun omaa aamurutiinia ei ole. */
export const PROFILE_ROUTINE_STEP_ID = 'profile-routine';

const MS_PER_MINUTE = 60000;

/** Lähtö tai valmistautuminen voi olla edellisenä iltana enintään näin paljon ennen seuraavaa vaihetta. */
const MAX_PREVIOUS_DAY_GAP_MINUTES = 12 * 60;

const ANCHOR_GENITIVE = Object.freeze({
  [ANCHOR_KIND.PREPARE]: 'valmistautumisen',
  [ANCHOR_KIND.LEAVE]: 'lähdön',
  [ANCHOR_KIND.START]: 'menon alun'
});

// ------------------------------------------------------------ apurit

function objectOf(value) {
  return value && typeof value === 'object' ? value : {};
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function minutesBetween(fromMs, toMs) {
  return Math.round((toMs - fromMs) / MS_PER_MINUTE);
}

/** Yksirivinen, siistitty teksti tai null. */
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

/**
 * Aamurutiinin vaiheet siistittyinä: virheelliset ohitetaan, tunnisteen
 * kaksoiskappaleista ensimmäinen voittaa, enintään MAX_MORNING_STEPS.
 * Tuntematon suojaus -> valinnainen (sama kuin protectionLabel).
 * Järjestys on käyttäjän oma, eikä sitä muuteta.
 */
export function morningSteps(input) {
  if (!Array.isArray(input)) return Object.freeze([]);
  const seen = new Set();
  const steps = [];
  for (const raw of input) {
    if (steps.length >= MAX_MORNING_STEPS) break;
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id.trim()
      : (Number.isInteger(raw.id) ? String(raw.id) : '');
    if (!id || seen.has(id)) continue;
    if (typeof raw.minutes !== 'number' || !Number.isFinite(raw.minutes)) continue;
    const minutes = Math.round(raw.minutes);
    if (minutes < 1 || minutes > MAX_STEP_MINUTES) continue;
    seen.add(id);
    steps.push(Object.freeze({
      id,
      name: cleanText(raw.name, MAX_STEP_NAME_LENGTH) || 'Aamun vaihe',
      minutes,
      protection: PROTECTIONS.includes(raw.protection) ? raw.protection : PROTECTION.OPTIONAL
    }));
  }
  return Object.freeze(steps);
}

function routineMinutesOf(profile) {
  const value = objectOf(profile).routineMinutes;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_STEP_MINUTES
    ? value
    : DEFAULT_PROFILE.routineMinutes;
}

function commuteMinutesOf(profile) {
  const value = objectOf(profile).commuteMinutes;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TRAVEL_MINUTES
    ? value
    : null;
}

/**
 * Kellonaika annetulla päivällä, tai edellisenä päivänä jos se olisi
 * viitehetken jälkeen (lähtö 23.50 menoon 00.30). Edellisen päivän tulkinta
 * vain, kun väli on enintään MAX_PREVIOUS_DAY_GAP_MINUTES: muuten aika on
 * ristiriitainen (valmistautuminen 9.00 lähtöön 7.30) ja siis tuntematon.
 */
function epochBefore(dateIso, time, referenceMs, fn) {
  const sameDay = wallClockToEpoch(dateIso, time, fn);
  if (!sameDay) return null;
  if (sameDay.epochMs <= referenceMs) return sameDay.epochMs;
  const previousDate = shiftDateIso(dateIso, -1);
  const previous = previousDate ? wallClockToEpoch(previousDate, time, fn) : null;
  if (!previous || previous.epochMs > referenceMs) return null;
  return referenceMs - previous.epochMs <= MAX_PREVIOUS_DAY_GAP_MINUTES * MS_PER_MINUTE ? previous.epochMs : null;
}

/** Ensimmäinen meno hetkiksi: alku, lähtö (tai tuntematon) ja ankkuri. */
function commitmentTimes(raw, dateIso, profile, fn) {
  if (!raw || typeof raw !== 'object' || !isTimeOfDay(raw.startTime)) return null;
  const start = wallClockToEpoch(dateIso, raw.startTime, fn);
  if (!start) return null;

  let leaveMs = null;
  let leaveSource = null;
  if (isTimeOfDay(raw.leaveTime)) {
    leaveMs = epochBefore(dateIso, raw.leaveTime, start.epochMs, fn);
    if (leaveMs !== null) leaveSource = LEAVE_SOURCE.COMMITMENT;
  }
  const commute = commuteMinutesOf(profile);
  if (leaveMs === null && !isTimeOfDay(raw.leaveTime) && commute !== null) {
    // Menolle ei ole omaa matka-aikaa: käytetään profiilin matka-aikaa,
    // jonka käyttäjä on itse ilmoittanut. Selitys kertoo tästä ääneen.
    leaveMs = start.epochMs - commute * MS_PER_MINUTE;
    leaveSource = LEAVE_SOURCE.PROFILE_COMMUTE;
  }

  let prepareMs = null;
  if (isTimeOfDay(raw.prepareStart)) prepareMs = epochBefore(dateIso, raw.prepareStart, leaveMs ?? start.epochMs, fn);

  const anchorKind = prepareMs !== null ? ANCHOR_KIND.PREPARE : (leaveMs !== null ? ANCHOR_KIND.LEAVE : ANCHOR_KIND.START);
  const anchorMs = prepareMs ?? leaveMs ?? start.epochMs;
  return {
    title: cleanText(raw.title, 200),
    startTime: start.time,
    startMs: start.epochMs,
    leaveMs,
    leaveSource,
    commuteMinutes: leaveSource === LEAVE_SOURCE.PROFILE_COMMUTE ? commute : null,
    anchorMs,
    anchorKind
  };
}

// ------------------------------------------------------------ valinnat

function bySavingThenName(a, b) {
  return b.saving - a.saving
    || a.step.name.localeCompare(b.step.name, 'fi')
    || a.step.id.localeCompare(b.step.id, 'fi');
}

function buildChoices(steps, shortfall, wakeMs, fn) {
  const choices = [];
  const optional = steps.filter(step => step.protection === PROTECTION.OPTIONAL)
    .map(step => ({ step, saving: step.minutes })).sort(bySavingThenName);
  const flexible = steps.filter(step => step.protection === PROTECTION.IMPORTANT_FLEXIBLE);

  for (const { step } of optional) {
    choices.push({
      id: `${CHOICE_KIND.DROP}:${step.id}`,
      kind: CHOICE_KIND.DROP,
      stepId: step.id,
      minutes: step.minutes,
      costsSleepMinutes: 0,
      coversShortfall: step.minutes >= shortfall,
      label: `Jätä pois: ${step.name} (${durationText(step.minutes)})`
    });
  }

  const shortenable = flexible
    .filter(step => step.minutes > MIN_SHORTENED_STEP_MINUTES)
    .map(step => ({ step, saving: Math.min(shortfall, step.minutes - MIN_SHORTENED_STEP_MINUTES) }))
    .sort(bySavingThenName);
  for (const { step, saving } of shortenable) {
    choices.push({
      id: `${CHOICE_KIND.SHORTEN}:${step.id}`,
      kind: CHOICE_KIND.SHORTEN,
      stepId: step.id,
      minutes: saving,
      newMinutes: step.minutes - saving,
      costsSleepMinutes: 0,
      coversShortfall: saving >= shortfall,
      label: `Lyhennä: ${step.name} ${durationText(step.minutes)} → ${durationText(step.minutes - saving)}`
    });
  }

  for (const { step } of flexible.map(step => ({ step, saving: step.minutes })).sort(bySavingThenName)) {
    choices.push({
      id: `${CHOICE_KIND.DROP}:${step.id}`,
      kind: CHOICE_KIND.DROP,
      stepId: step.id,
      minutes: step.minutes,
      costsSleepMinutes: 0,
      coversShortfall: step.minutes >= shortfall,
      label: `Jätä pois: ${step.name} (${durationText(step.minutes)})`
    });
  }

  const earlier = epochToWallClock(wakeMs - shortfall * MS_PER_MINUTE, fn);
  choices.push({
    id: CHOICE_KIND.WAKE_EARLIER,
    kind: CHOICE_KIND.WAKE_EARLIER,
    stepId: null,
    minutes: shortfall,
    costsSleepMinutes: shortfall,
    coversShortfall: true,
    wakeTime: earlier ? earlier.time : null,
    wakeDate: earlier ? earlier.date : null,
    label: `Herää ${durationText(shortfall)} aiemmin (${earlier ? clockText(earlier.time) : '?'}). Uni lyhenee ${durationText(shortfall)}.`
  });
  return choices;
}

// ------------------------------------------------------------ suunnitelma

/**
 * Päivän aamusuunnitelma.
 *
 * @param {object} input
 * @param {string} input.dateIso
 * @param {object|null} input.firstCommitment {title, startTime, leaveTime|null, prepareStart|null}
 * @param {Array} [input.steps] aamurutiini [{id, name, minutes, protection}];
 *        puuttuessa settings.morningRoutine, tyhjänä profiilin aamutoimet
 * @param {object} input.profile {sleepTargetHours, defaultWakeTime, commuteMinutes, routineMinutes}
 * @param {object} input.settings LifeSettings
 * @param {string|null} [input.wakeTimeLimit] aikaisin herätys ilman käyttäjän valintaa ('HH:MM')
 * @param {string|null} [input.usualWakeTime] tavallinen herätys, jos kutsuja tietää sen
 *        (esim. oma herätysaika); muuten sleepScheduleFor
 * @param {Function} [input.offsetMinutesFn] aikavyöhykefunktio, ks. wallClock.js
 * @returns {null | object} null, jos päivä on virheellinen
 */
export function planMorning(input) {
  const {
    dateIso, firstCommitment = null, steps, profile, settings,
    wakeTimeLimit = null, usualWakeTime = null, offsetMinutesFn
  } = objectOf(input);
  if (!isIsoDate(dateIso)) return null;
  const fn = typeof offsetMinutesFn === 'function' ? offsetMinutesFn : ZERO_OFFSET;

  // Vaiheet: annetut, asetusten aamurutiini tai profiilin aamutoimet.
  let routine = morningSteps(Array.isArray(steps) ? steps : objectOf(settings).morningRoutine);
  let fromProfile = false;
  if (routine.length === 0) {
    const minutes = routineMinutesOf(profile);
    routine = minutes > 0
      ? Object.freeze([Object.freeze({ id: PROFILE_ROUTINE_STEP_ID, name: 'Aamutoimet', minutes, protection: PROTECTION.MANDATORY })])
      : Object.freeze([]);
    fromProfile = true;
  }
  const totalMinutes = routine.reduce((sum, step) => sum + step.minutes, 0);

  // Tavallinen herätys ja suojattu raja.
  let usualWake = isTimeOfDay(usualWakeTime) ? usualWakeTime : null;
  if (!usualWake) {
    const schedule = sleepScheduleFor({ dateIso, profile, settings, offsetMinutesFn: fn });
    if (!schedule) return null;
    usualWake = schedule.wakeTime;
  }
  const usual = wallClockToEpoch(dateIso, usualWake, fn);
  if (!usual) return null;
  const limit = isTimeOfDay(wakeTimeLimit) ? wallClockToEpoch(dateIso, wakeTimeLimit, fn) : null;
  const limitMs = limit ? limit.epochMs : null;

  const commitment = commitmentTimes(firstCommitment, dateIso, profile, fn);

  let wakeMs;
  let requiredMs = null;
  let fits = true;
  let shortfallMinutes = 0;
  let slackMinutes = null;
  let stepStartMs;
  if (commitment) {
    requiredMs = commitment.anchorMs - totalMinutes * MS_PER_MINUTE;
    const candidate = Math.min(usual.epochMs, requiredMs);
    wakeMs = limitMs !== null ? Math.max(candidate, limitMs) : candidate;
    fits = requiredMs >= wakeMs;
    shortfallMinutes = fits ? 0 : minutesBetween(requiredMs, wakeMs);
    slackMinutes = fits ? minutesBetween(wakeMs, requiredMs) : 0;
    stepStartMs = requiredMs;
  } else {
    wakeMs = limitMs !== null ? Math.max(usual.epochMs, limitMs) : usual.epochMs;
    stepStartMs = wakeMs;
  }

  const wake = epochToWallClock(wakeMs, fn);
  if (!wake) return null;

  const scheduled = [];
  let cursor = stepStartMs;
  for (const step of routine) {
    const start = epochToWallClock(cursor, fn);
    const end = epochToWallClock(cursor + step.minutes * MS_PER_MINUTE, fn);
    if (!start || !end) return null;
    scheduled.push({
      id: step.id,
      name: step.name,
      minutes: step.minutes,
      protection: step.protection,
      start: start.time,
      startDate: start.date,
      end: end.time,
      endDate: end.date
    });
    cursor += step.minutes * MS_PER_MINUTE;
  }

  const earlierThanUsualMinutes = Math.max(0, minutesBetween(wakeMs, usual.epochMs));
  const leave = commitment && commitment.leaveMs !== null ? epochToWallClock(commitment.leaveMs, fn) : null;
  const anchor = commitment ? epochToWallClock(commitment.anchorMs, fn) : null;
  const required = requiredMs !== null ? epochToWallClock(requiredMs, fn) : null;
  // Epäjohdonmukainen aikavyöhykefunktio: ei arvata.
  if (commitment && (!anchor || !required || (commitment.leaveMs !== null && !leave))) return null;
  const choices = fits ? [] : buildChoices(routine, shortfallMinutes, wakeMs, fn);

  return deepFreeze({
    date: dateIso,
    wakeTime: wake.time,
    wakeDate: wake.date,
    usualWakeTime: usual.time,
    requiredWakeTime: required ? required.time : null,
    requiredWakeDate: required ? required.date : null,
    earlierThanUsualMinutes,
    leaveTime: leave ? leave.time : null,
    leaveDate: leave ? leave.date : null,
    leaveSource: commitment ? commitment.leaveSource : null,
    anchorTime: anchor ? anchor.time : null,
    anchorKind: commitment ? commitment.anchorKind : null,
    commitment: commitment ? { title: commitment.title, startTime: commitment.startTime } : null,
    steps: scheduled,
    stepsFromProfile: fromProfile,
    totalMinutes,
    slackMinutes,
    fits,
    shortfallMinutes,
    choices,
    sleepProtected: true,
    explanation: explain({ commitment, wake, anchor, totalMinutes, earlierThanUsualMinutes, slackMinutes, fits, shortfallMinutes, choices })
  });
}

function explain({ commitment, wake, anchor, totalMinutes, earlierThanUsualMinutes, slackMinutes, fits, shortfallMinutes, choices }) {
  const routineText = totalMinutes > 0 ? `Aamurutiini (${durationText(totalMinutes)})` : 'Aamurutiini';
  if (!commitment) {
    return totalMinutes > 0
      ? `Aamussa ei ole kiinteää menoa. Herätys ${clockText(wake.time)}, ja ${routineText.toLowerCase()} alkaa heti herätyksestä.`
      : `Aamussa ei ole kiinteää menoa. Herätys ${clockText(wake.time)}.`;
  }

  const parts = [];
  if (!fits) {
    const droppable = choices.some(choice => choice.kind !== CHOICE_KIND.WAKE_EARLIER);
    parts.push(`${routineText} ei mahdu herätyksen ${clockText(wake.time)} ja ${ANCHOR_GENITIVE[commitment.anchorKind]}`
      + ` ${clockText(anchor.time)} väliin: aikaa puuttuu ${durationText(shortfallMinutes)}.`);
    parts.push(droppable
      ? 'Unta ei lyhennetä automaattisesti. Valitse, mitä jätät pois tai lyhennät, tai herää aiemmin, jolloin uni lyhenee.'
      : `Kaikki vaiheet ovat pakollisia tai suojattuja. Unta ei lyhennetä automaattisesti: voit herätä ${durationText(shortfallMinutes)} aiemmin, jolloin uni lyhenee saman verran.`);
  } else {
    const anchorPhrase = commitment.anchorKind === ANCHOR_KIND.PREPARE
      ? `valmistautuminen alkaa ${clockText(anchor.time)}`
      : (commitment.anchorKind === ANCHOR_KIND.LEAVE ? `lähtö on ${clockText(anchor.time)}` : `meno alkaa ${clockText(anchor.time)}`);
    parts.push(`Aamun ensimmäisen menon vuoksi ${anchorPhrase}.`);
    parts.push(totalMinutes > 0
      ? `${routineText} on ajoitettu päättymään siihen, herätys ${clockText(wake.time)}.`
      : `Herätys ${clockText(wake.time)}.`);
    if (earlierThanUsualMinutes > 0) parts.push(`Herätys on ${durationText(earlierThanUsualMinutes)} tavallista aiemmin.`);
    if (slackMinutes > 0) parts.push(`Ennen aamurutiinia jää ${durationText(slackMinutes)} väljyyttä.`);
  }
  if (commitment.leaveSource === LEAVE_SOURCE.PROFILE_COMMUTE) {
    parts.push(`Lähtöaika on laskettu profiilisi matka-ajasta (${durationText(commitment.commuteMinutes)}), koska tälle menolle ei ole omaa matka-aikaa.`);
  } else if (commitment.leaveSource === null) {
    parts.push(commitment.anchorKind === ANCHOR_KIND.START
      ? 'Matka-aikaa ei tiedetä, joten aamu on laskettu menon alkuun asti. Lisää matka-aika, niin lähtöaika voidaan laskea.'
      : 'Matka-aikaa ei tiedetä, joten lähtöaikaa ei ole laskettu. Lisää matka-aika, niin lähtöaika voidaan laskea.');
  }
  return parts.join(' ');
}
