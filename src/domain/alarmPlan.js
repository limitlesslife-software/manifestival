// Herätyssuunnitelma ja aamun lyhyt katsaus.
//
// PUHDAS MODUULI. Tämä EI aseta yhtään herätystä. Se päättää, mitkä
// herätykset pitäisi olla olemassa (seinäkelloaikoina), ja alusta
// (ManifestivalAlarm-liitännäinen tai verkkoversion rehellinen varavaihtoehto)
// asettaa ne. Domain ei tunne aikavyöhykettä: hetkeksi muunto tehdään
// wallClockToEpoch-funktiolla, jolle kutsuja antaa aikavyöhykefunktion.
//
// PERIAATTEET
//
// - Herätys on käyttäjän oma valinta: settings.alarm.enabled on oletuksena
//   pois, eikä mitään herätystä synny ilman sitä.
// - Oma arki- tai viikonloppuherätysaika (weekdayTime / weekendTime) voittaa
//   rytmin oletuksen. followPlan: aamun meno voi aikaistaa herätystä, mutta
//   ei koskaan yli suojatun unen rajan ilman käyttäjän valintaa.
// - "Kiinteä aika" (followPlan: false) ON herätysaika: aamun meno ei siirrä
//   sitä, ja uni lasketaan siitä. Jos meno vaatisi aiemman herätyksen,
//   siitä kerrotaan varoituksena (fixedAlarmNote). Sääntö on yksi
//   (alarmWakeOf), ja calendarPlan käyttää sitä unelle ja aamulle.
// - Herätys ei soi loputtomiin: enintään MAX_ALARM_RING_MINUTES, torkku
//   enintään MAX_SNOOZE_MINUTES ja MAX_SNOOZES kertaa.
// - Puhe vain, jos käyttäjä on valinnut puheen (puhetila tai speechEnabled).
// - Katsaus ei kerro menojen nimiä, ellei käyttäjä ole ottanut aamun
//   katsausta käyttöön. Muistiinpanoja se ei kerro koskaan.

import {
  ALARM_MODE, ALARM_MODES, ESCALATION_STEP, ESCALATION_STEPS,
  MAX_ALARM_RING_MINUTES, MAX_SNOOZE_MINUTES, MAX_SNOOZES
} from './dailyLife.js';
import { isIsoDate, isTimeOfDay, toMinutes } from './task.js';
import { sleepScheduleFor, sleepTargetMinutes } from './sleepRhythm.js';
import { planMorning } from './morningPlanner.js';
import {
  ZERO_OFFSET, shiftDateIso, wallClockToEpoch, epochToWallClock, clockText, durationText
} from './wallClock.js';

export { wallClockToEpoch, epochToWallClock } from './wallClock.js';

/** Herätyksiä suunnitellaan enintään näin moneksi päiväksi eteenpäin. */
export const MAX_ALARM_DAYS = 3;

/** Voimistuvassa herätyksessä on enintään näin monta vaihetta. */
export const MAX_ESCALATION_STEPS = 4;

/** Herätys soi enintään näin monta sekuntia ilman kuittausta. */
export const MAX_RING_SECONDS = MAX_ALARM_RING_MINUTES * 60;

export const DEFAULT_SNOOZE_MINUTES = 9;

/** Oletus: pehmeä alku, minuutin päästä voimakkaampi. Ei puhetta oletuksena. */
export const DEFAULT_ESCALATION = Object.freeze([
  Object.freeze({ afterSeconds: 0, step: ESCALATION_STEP.SOFT }),
  Object.freeze({ afterSeconds: 60, step: ESCALATION_STEP.LOUD })
]);

/** Mistä herätysaika tuli. */
export const ALARM_SOURCE = Object.freeze({
  RHYTHM: 'rhythm',
  OVERRIDE: 'override',
  PLAN: 'plan'
});

/**
 * Aamun katsaus on lyhyt: enintään näin monta virkettä. Viisi, jotta
 * tervehdys, kellonaika, lähtötavoite, ensimmäinen meno ja aika
 * aamulenkille mahtuvat (paketin §34 esimerkki + menon nimi).
 */
export const BRIEF_MAX_SENTENCES = 5;

/** Lenkistä kerrotaan vasta, kun aikaa on vähintään näin monta minuuttia. */
export const MIN_RUN_MINUTES = 10;

/** Menon nimi katsauksessa enintään näin pitkä. */
export const MAX_BRIEF_TITLE_LENGTH = 60;

const MS_PER_MINUTE = 60000;
const NOON = 12 * 60;
const SPEECH_STEPS = new Set([ESCALATION_STEP.SPEECH, ESCALATION_STEP.REPEAT_SPEECH]);

// ------------------------------------------------------------ apurit

function objectOf(value) {
  return value && typeof value === 'object' ? value : {};
}

function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function offsetFnOf(value) {
  return typeof value === 'function' ? value : ZERO_OFFSET;
}

// ------------------------------------------------------------ voimistuminen

/**
 * Voimistuvan herätyksen vaiheiden tarkistus:
 * enintään MAX_ESCALATION_STEPS vaihetta, tunnetut vaiheet, alkamisajat
 * kokonaisia sekunteja, aidosti kasvavat ja alle MAX_RING_SECONDS.
 * Puuttuva lista on sallittu (oletus käytetään).
 */
export function validateEscalation(steps) {
  const errors = {};
  if (steps !== null && steps !== undefined) {
    if (!Array.isArray(steps)) {
      errors.escalation = 'Voimistuvan herätyksen vaiheet ovat virheelliset.';
    } else if (steps.length > MAX_ESCALATION_STEPS) {
      errors.escalation = `Herätyksessä voi olla enintään ${MAX_ESCALATION_STEPS} vaihetta.`;
    } else {
      let previous = -1;
      for (const step of steps) {
        if (!step || typeof step !== 'object' || !ESCALATION_STEPS.includes(step.step)) {
          errors.escalation = 'Herätyksen vaihe on tuntematon.';
          break;
        }
        if (!Number.isInteger(step.afterSeconds) || step.afterSeconds < 0) {
          errors.escalation = 'Vaiheen alkamisaika on virheellinen.';
          break;
        }
        if (step.afterSeconds <= previous) {
          errors.escalation = 'Vaiheiden pitää alkaa kasvavassa järjestyksessä.';
          break;
        }
        if (step.afterSeconds >= MAX_RING_SECONDS) {
          errors.escalation = `Herätys soi enintään ${MAX_ALARM_RING_MINUTES} minuuttia, joten jokaisen vaiheen pitää alkaa sitä ennen.`;
          break;
        }
        previous = step.afterSeconds;
      }
    }
  }
  return Object.freeze({ valid: Object.keys(errors).length === 0, errors: Object.freeze(errors) });
}

/**
 * Vaiheet käyttökuntoon: virheelliset pois, järjestys alkamisajan mukaan,
 * sama alkamisaika vain kerran, puhevaiheet vain puheen salliessa,
 * enintään MAX_ESCALATION_STEPS. Ei-taulukko -> oletus. Ei koskaan heitä.
 */
export function normalizeEscalation(steps, options) {
  const speechAllowed = objectOf(options).speechAllowed === true;
  if (!Array.isArray(steps)) return DEFAULT_ESCALATION;
  const valid = [];
  steps.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || !ESCALATION_STEPS.includes(raw.step)) return;
    if (!Number.isInteger(raw.afterSeconds) || raw.afterSeconds < 0 || raw.afterSeconds >= MAX_RING_SECONDS) return;
    if (!speechAllowed && SPEECH_STEPS.has(raw.step)) return;
    valid.push({ afterSeconds: raw.afterSeconds, step: raw.step, index });
  });
  valid.sort((a, b) => a.afterSeconds - b.afterSeconds || a.index - b.index);
  const result = [];
  let previous = -1;
  for (const item of valid) {
    if (item.afterSeconds <= previous) continue;
    result.push(Object.freeze({ afterSeconds: item.afterSeconds, step: item.step }));
    previous = item.afterSeconds;
    if (result.length === MAX_ESCALATION_STEPS) break;
  }
  return Object.freeze(result);
}

/** Herätysasetukset LifeSettingsistä rajattuina. Oletus: pois päältä. */
export function alarmSettingsOf(settings) {
  const s = objectOf(settings);
  const alarm = objectOf(s.alarm);
  const mode = ALARM_MODES.includes(alarm.mode) ? alarm.mode : ALARM_MODE.SOUND;
  const speechAllowed = mode === ALARM_MODE.SPEECH || mode === ALARM_MODE.COMBINATION || s.speechEnabled === true;
  return deepFreeze({
    enabled: alarm.enabled === true,
    mode,
    speechAllowed,
    snoozeMinutes: clampInt(alarm.snoozeMinutes, 1, MAX_SNOOZE_MINUTES, DEFAULT_SNOOZE_MINUTES),
    maxSnoozes: clampInt(alarm.maxSnoozes, 0, MAX_SNOOZES, MAX_SNOOZES),
    escalation: normalizeEscalation(alarm.escalation, { speechAllowed }),
    weekdayTime: isTimeOfDay(alarm.weekdayTime) ? alarm.weekdayTime : null,
    weekendTime: isTimeOfDay(alarm.weekendTime) ? alarm.weekendTime : null,
    followPlan: alarm.followPlan !== false
  });
}

// ------------------------------------------------------------ menot

function commitmentsOn(commitmentsByDate, date) {
  let value = null;
  if (commitmentsByDate instanceof Map) value = commitmentsByDate.get(date);
  else if (commitmentsByDate && typeof commitmentsByDate === 'object'
    && Object.prototype.hasOwnProperty.call(commitmentsByDate, date)) value = commitmentsByDate[date];
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? [value] : [];
}

function commuteOf(profile) {
  const value = objectOf(profile).commuteMinutes;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Menon aamua sitova hetki minuutteina: valmistautuminen, lähtö tai alku - matka. */
function anchorMinutes(item, commute) {
  if (isTimeOfDay(item.prepareStart)) return toMinutes(item.prepareStart);
  if (isTimeOfDay(item.leaveTime)) return toMinutes(item.leaveTime);
  return toMinutes(item.startTime) - commute;
}

function textKey(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Ajalliset menot aamua sitovassa järjestyksessä: aikaisin ankkuri, sitten
 * alku, nimi ja tunniste. Tasapelissä syötteen järjestys säilyy.
 */
function commitmentsInOrder(list, profile) {
  if (!Array.isArray(list)) return [];
  const commute = commuteOf(profile);
  const keyed = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || !isTimeOfDay(item.startTime)) continue;
    keyed.push({ item, key: [anchorMinutes(item, commute), toMinutes(item.startTime), textKey(item.title), textKey(item.id)] });
  }
  return keyed.sort((a, b) => compareKeys(a.key, b.key)).map(entry => entry.item);
}

/** Aamua eniten sitova meno: aikaisin ankkuri, sitten alku, nimi ja tunniste. */
export function firstCommitmentOf(list, profile) {
  return commitmentsInOrder(list, profile)[0] || null;
}

function compareKeys(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2], 'fi') || a[3].localeCompare(b[3], 'fi');
}

/**
 * Herätyspäivän aamun sitoumus ja aamusuunnitelma (morningPlanner.planMorning).
 *
 * YKSI VALINTA. Kalenterin unilohkot, Tänään-näkymän aamu, illan ennakko
 * (calendarPlan.morningFor) ja herätys (desiredAlarms) valitsevat aamun
 * menon tällä samalla funktiolla, jotta ne eivät voi olla eri mieltä.
 *
 * KESKIYÖN JÄLKEINEN MENO EI OLE AAMUN MENO. Etäpuhelu klo 00.15 tai joka
 * yö toistuva lääke klo 00.00 on kellonajaltaan päivän aikaisin, mutta sen
 * aamurutiini alkaisi jo EDELLISENÄ iltana: se ei ole tämän yön herätys.
 * Sellainen meno ohitetaan, ja aamun sitoumus on seuraava meno, jonka
 * vaatima herätys osuu herätyspäivälle. Muuten klo 7.30 palaveri jäisi
 * huomiotta, herätys olisi tavallinen ja uni suojattaisiin väärään aikaan
 * (tai herätys soisi edellisenä iltana). Jos yksikään meno ei sovi, aamu on
 * tavallinen (ei sitoumusta).
 *
 * Ratkaisee VAADITTU herätys (requiredWakeDate), ei lopullinen: aikaisin
 * sallittu herätys (wakeTimeLimit) nostaa herätyksen aina herätyspäivälle,
 * eikä menon valinta saa riippua siitä.
 *
 * @param {object} input planMorning-syöte ilman firstCommitmentia, sekä
 * @param {Array}  input.commitments päivän menot {title, startTime, leaveTime|null, prepareStart|null}
 * @returns {{commitment:object|null, plan:object|null}}
 */
export function morningOfDay(input) {
  const {
    dateIso, commitments = null, profile, settings, steps, wakeTimeLimit = null, usualWakeTime = null, offsetMinutesFn
  } = objectOf(input);
  const base = { dateIso, profile, settings, steps, wakeTimeLimit, usualWakeTime, offsetMinutesFn };
  for (const commitment of commitmentsInOrder(commitments, profile)) {
    const plan = planMorning({ ...base, firstCommitment: commitment });
    if (plan && isIsoDate(plan.requiredWakeDate) && plan.requiredWakeDate < dateIso) continue;
    return { commitment, plan };
  }
  return { commitment: null, plan: planMorning({ ...base, firstCommitment: null }) };
}

// ------------------------------------------------------------ herätykset

function latestLogsByDate(sleepLogs, dates) {
  const wanted = new Set(dates);
  const byDate = new Map();
  if (!Array.isArray(sleepLogs)) return byDate;
  for (const log of sleepLogs) {
    if (!log || typeof log !== 'object' || !wanted.has(log.wakeDate)) continue;
    const current = byDate.get(log.wakeDate);
    if (!current || textKey(log.updatedAt) > textKey(current.updatedAt)
      || (textKey(log.updatedAt) === textKey(current.updatedAt) && textKey(log.id).localeCompare(textKey(current.id), 'fi') > 0)) {
      byDate.set(log.wakeDate, log);
    }
  }
  return byDate;
}

/**
 * Suojatun unen raja: jos käyttäjä on kirjannut menneensä vuoteeseen,
 * aikaisin herätys on vuoteeseen + unitavoite (ei kuitenkaan tavallista
 * herätystä myöhempi). Ilman kirjausta rajaa ei ole: aamun meno saa
 * aikaistaa herätystä, ja illan huomautus on jo ehdottanut aiempaa
 * nukkumaanmenoa.
 */
function wakeFloor(log, date, baselineMs, profile, fn) {
  if (!log || !isTimeOfDay(log.actualBedtime)) return null;
  const bedDate = toMinutes(log.actualBedtime) >= NOON ? shiftDateIso(date, -1) : date;
  const bed = bedDate ? wallClockToEpoch(bedDate, log.actualBedtime, fn) : null;
  if (!bed) return null;
  const floorMs = Math.min(bed.epochMs + sleepTargetMinutes(profile) * MS_PER_MINUTE, baselineMs);
  const floor = epochToWallClock(floorMs, fn);
  return floor && floor.date === date ? floor.time : null;
}

/**
 * Yhden päivän herätyssääntö ja tavallinen unirytmi (sisäinen: desiredAlarms
 * ja alarmWakeOf käyttävät tätä samaa). null, jos päivää ei voi laskea.
 */
function wakeRuleOf(date, alarm, profile, settings, log, fn) {
  const usual = sleepScheduleFor({ dateIso: date, profile, settings, offsetMinutesFn: fn });
  if (!usual) return null;
  const override = usual.weekend ? alarm.weekendTime : alarm.weekdayTime;
  const baselineAt = wallClockToEpoch(date, override || usual.wakeTime, fn);
  if (!baselineAt) return null;
  const fixed = alarm.followPlan !== true;
  const rule = deepFreeze({
    date,
    weekend: usual.weekend,
    fixed,
    override: Boolean(override),
    time: baselineAt.time,
    floorTime: fixed ? null : wakeFloor(log, date, baselineAt.epochMs, profile, fn)
  });
  return { rule, usual };
}

/**
 * Herätyksen sääntö yhdelle herätyspäivälle: mitä herätys tekee aamulle.
 *
 * YKSI SÄÄNTÖ. Laitteen herätys (desiredAlarms) ja kaikki, mikä kertoo
 * herätysajan (calendarPlan: Tänään-näkymän aamu, Huominen-kortti,
 * kalenterin unilohkot, ilta- ja nukkumaanmenomuistutukset, illan ennakko),
 * kysyvät sen tältä funktiolta. Muuten "Kiinteä aika" soisi 6.30, mutta uni,
 * iltarutiini ja illan neuvo laskettaisiin menon vaatimasta 6.20:stä.
 *
 * PÄÄTÖS: KIINTEÄ AIKA ON HERÄTYSAIKA. Kiinteä herätys (followPlan: false)
 * soi aina `time`: aamun meno ei siirrä sitä, ja uni lasketaan siitä. Jos
 * meno vaatisi aiemman herätyksen, aamusuunnitelma ei mahdu, ja siitä
 * kerrotaan varoituksena (fixedAlarmNote) sen sijaan, että näkymät olisivat
 * hiljaa eri mieltä. Suunnitelmaa seuraava herätys saa aikaistua menon
 * mukaan, mutta ei kirjatun nukkumaanmenon suojaaman unen ohi (floorTime).
 *
 * @param {object} input
 * @param {string} input.dateIso herätyspäivä
 * @param {object} input.profile
 * @param {object} input.settings LifeSettings
 * @param {Array}  [input.sleepLogs] SleepLog-rivit (kirjattu nukkumaanmeno rajaa)
 * @param {Function} [input.offsetMinutesFn]
 * @returns {null | {date, weekend, fixed, override, time, floorTime}} null, kun
 *   herätys ei ole käytössä: aamusuunnitelman herätys on silloin suositus.
 */
export function alarmWakeOf(input) {
  const { dateIso, profile, settings, sleepLogs = [], offsetMinutesFn } = objectOf(input);
  if (!isIsoDate(dateIso)) return null;
  const alarm = alarmSettingsOf(settings);
  if (!alarm.enabled) return null;
  const log = latestLogsByDate(sleepLogs, [dateIso]).get(dateIso) || null;
  const found = wakeRuleOf(dateIso, alarm, profile, settings, log, offsetFnOf(offsetMinutesFn));
  return found ? found.rule : null;
}

/**
 * Aamusuunnittelijan herätysrajat säännöstä (planMorning / morningOfDay):
 * tavallinen herätys on herätyksen perusaika, ja aikaisin sallittu herätys
 * on kiinteä aika tai suojatun unen raja. Ilman sääntöä ei rajoja.
 */
export function alarmPlanningLimits(wake) {
  if (!wake || typeof wake !== 'object' || !isTimeOfDay(wake.time)) {
    return Object.freeze({ usualWakeTime: null, wakeTimeLimit: null });
  }
  return Object.freeze({
    usualWakeTime: wake.time,
    wakeTimeLimit: wake.fixed === true ? wake.time : (isTimeOfDay(wake.floorTime) ? wake.floorTime : null)
  });
}

/**
 * Kiinteän herätyksen varoitus, kun aamu vaatisi aiemman herätyksen.
 * Sama lause herätyksen perusteluna, Huominen-kortissa, illan ennakossa ja
 * Tänään-näkymän aamussa. null, kun ristiriitaa ei ole.
 *
 * @param {object|null} plan aamusuunnitelma (samoilla herätysrajoilla)
 * @param {object|null} wake alarmWakeOf-tulos
 */
export function fixedAlarmNote(plan, wake) {
  if (!wake || typeof wake !== 'object' || wake.fixed !== true) return null;
  if (!plan || typeof plan !== 'object' || plan.fits !== false) return null;
  if (!isTimeOfDay(plan.wakeTime) || !isTimeOfDay(plan.requiredWakeTime)) return null;
  if (!Number.isInteger(plan.shortfallMinutes) || plan.shortfallMinutes <= 0) return null;
  return `Herätys on kiinteä ${clockText(plan.wakeTime)}, mutta aamu vaatisi herätyksen`
    + ` ${clockText(plan.requiredWakeTime)}: aikaa puuttuu ${durationText(plan.shortfallMinutes)}.`;
}

/**
 * Halutut herätykset päiville fromIso ... fromIso + days - 1 (days ≤ 3).
 *
 * Jokainen herätys on seinäkelloaika {date, time}; hetkeksi sen muuntaa
 * wallClockToEpoch kutsujan aikavyöhykefunktiolla. Tunniste 'wake:<päivä>'
 * on vakaa, joten sama herätys ei synny kahdesti.
 *
 * @param {object} input
 * @param {string} input.fromIso
 * @param {number} [input.days=1]
 * @param {object} input.profile
 * @param {object} input.settings LifeSettings (alarm, morningRoutine, morningBriefEnabled ...)
 * @param {object|Map} [input.commitmentsByDate] { 'YYYY-MM-DD': meno | [menot] }
 *        meno = {title, startTime, leaveTime|null, prepareStart|null, category?}
 * @param {Array} [input.sleepLogs] SleepLog-rivit (vuoteeseenmenon kirjaus rajaa herätystä)
 * @param {Function} [input.offsetMinutesFn]
 */
export function desiredAlarms(input) {
  const { fromIso, days = 1, profile, settings, commitmentsByDate = null, sleepLogs = [], offsetMinutesFn } = objectOf(input);
  if (!isIsoDate(fromIso)) return Object.freeze([]);
  const alarm = alarmSettingsOf(settings);
  if (!alarm.enabled) return Object.freeze([]);
  const fn = offsetFnOf(offsetMinutesFn);
  const count = clampInt(days, 1, MAX_ALARM_DAYS, 1);
  const briefEnabled = objectOf(settings).morningBriefEnabled === true;

  const dates = [];
  for (let index = 0; index < count; index += 1) {
    const date = shiftDateIso(fromIso, index);
    if (date) dates.push(date);
  }
  const logs = latestLogsByDate(sleepLogs, dates);

  const alarms = new Map();
  for (const date of dates) {
    // Sama sääntö kuin calendarPlanissa (alarmWakeOf): herätys ja uni samaa mieltä.
    const found = wakeRuleOf(date, alarm, profile, settings, logs.get(date) || null, fn);
    if (!found) continue;
    const { rule, usual } = found;

    const dayCommitments = commitmentsOn(commitmentsByDate, date);

    // Sama aamun menon valinta ja samat herätysrajat kuin kalenterissa ja
    // Tänään-näkymässä: keskiyön jälkeinen meno ei tee herätystä
    // edelliselle illalle. Kiinteälläkin herätyksellä suunnitelma lasketaan,
    // jotta vaje voidaan kertoa (fixedAlarmNote) ja lähtö katsaukseen.
    const plan = morningOfDay({
      dateIso: date, commitments: dayCommitments, profile, settings,
      ...alarmPlanningLimits(rule), offsetMinutesFn: fn
    }).plan;

    let source = rule.override ? ALARM_SOURCE.OVERRIDE : ALARM_SOURCE.RHYTHM;
    let wakeDate = date;
    let time = rule.time;
    if (plan && !rule.fixed) {
      time = plan.wakeTime;
      wakeDate = plan.wakeDate;
      if (plan.earlierThanUsualMinutes > 0) source = ALARM_SOURCE.PLAN;
    }

    const note = fixedAlarmNote(plan, rule);
    let reason;
    if (source === ALARM_SOURCE.PLAN) reason = plan.explanation;
    else if (source === ALARM_SOURCE.OVERRIDE) {
      reason = `Oma ${usual.weekend ? 'viikonlopun' : 'arkiaamun'} herätysaikasi ${clockText(rule.time)}.`;
      if (note) reason += ` ${note}`;
      else if (plan && !plan.fits) reason += ` ${plan.explanation}`;
    } else if (note) {
      reason = `${usual.reason} ${note}`;
    } else {
      reason = plan && !plan.fits ? `${usual.reason} ${plan.explanation}` : usual.reason;
    }

    const brief = briefEnabled
      ? morningBrief({
        now: { date: wakeDate, time },
        wakeTime: time,
        leaveTime: plan ? plan.leaveTime : null,
        commitments: dayCommitments,
        freeMinutesForRun: runMinutesOf(plan),
        settings
      })
      : null;

    const id = `wake:${date}`;
    alarms.set(id, {
      id,
      forDate: date,
      date: wakeDate,
      time,
      weekend: usual.weekend,
      mode: alarm.mode,
      escalation: alarm.escalation,
      maxRingSeconds: MAX_RING_SECONDS,
      snoozeMinutes: alarm.snoozeMinutes,
      maxSnoozes: alarm.maxSnoozes,
      snoozeCount: 0,
      label: 'Herätys',
      source,
      fits: plan ? plan.fits : true,
      shortfallMinutes: plan ? plan.shortfallMinutes : 0,
      leaveTime: plan ? plan.leaveTime : null,
      reason,
      briefText: brief ? brief.text : null
    });
  }
  return deepFreeze([...alarms.values()].sort((a, b) => a.forDate.localeCompare(b.forDate)));
}

/**
 * Aamun vapaa aika katsauksen lenkkivirkkeelle: aamusuunnitelman väljyys
 * herätyksestä aamurutiinin alkuun (paketin §34 "Sinulla on aikaa 20
 * minuutin aamulenkille"). Vain kun aamussa on meno, johon rutiini on
 * ajoitettu, ja aamu mahtuu: muuten vapaata aikaa ei tiedetä, eikä sitä
 * keksitä. Alle MIN_RUN_MINUTES jättää morningBrief itse sanomatta.
 */
function runMinutesOf(plan) {
  if (!plan || !plan.commitment || plan.fits !== true) return null;
  return Number.isInteger(plan.slackMinutes) && plan.slackMinutes > 0 ? plan.slackMinutes : null;
}

/** Herätyksen hetki kutsujan aikavyöhykkeessä (kesäaikasiirron tiedot mukana). */
export function alarmEpoch(alarm, offsetMinutesFn) {
  if (!alarm || typeof alarm !== 'object') return null;
  return wallClockToEpoch(alarm.date, alarm.time, offsetMinutesFn);
}

// ------------------------------------------------------------ torkku ja kaksoiskappaleet

function snoozeFailure(code, message) {
  return Object.freeze({ ok: false, code, alarm: null, message });
}

/**
 * Torkku: herätys soi uudelleen snoozeMinutes kuluttua hetkestä nowWall
 * ({date, time}). Tunniste pysyy samana, joten uusi versio korvaa vanhan.
 * Torkkuja enintään maxSnoozes. Aikavyöhykefunktion kanssa torkku on
 * todellinen kesto myös kesäajan vaihtuessa.
 */
export function snoozeAlarm(alarm, nowWall, options) {
  if (!alarm || typeof alarm !== 'object' || typeof alarm.id !== 'string' || !alarm.id) {
    return snoozeFailure('invalid_alarm', 'Herätystä ei tunnistettu.');
  }
  const now = objectOf(nowWall);
  if (!isIsoDate(now.date) || !isTimeOfDay(now.time)) {
    return snoozeFailure('invalid_time', 'Kellonaikaa ei tunnistettu.');
  }
  const snoozeMinutes = clampInt(alarm.snoozeMinutes, 1, MAX_SNOOZE_MINUTES, DEFAULT_SNOOZE_MINUTES);
  const maxSnoozes = clampInt(alarm.maxSnoozes, 0, MAX_SNOOZES, MAX_SNOOZES);
  const used = Number.isInteger(alarm.snoozeCount) && alarm.snoozeCount >= 0 ? alarm.snoozeCount : 0;
  if (used >= maxSnoozes) {
    return snoozeFailure('max_snoozes', 'Torkkukerrat on käytetty. Herätys odottaa kuittausta.');
  }
  const { offsetMinutesFn: userFn, nowEpochMs } = objectOf(options);
  const fn = offsetFnOf(userFn);
  // Tarkka nykyhetki (jos alusta antaa sen) ratkaisee syksyn toistuvan
  // tunnin: seinäkelloaika 03.55 voi olla kumpi tahansa esiintymä.
  const exactNow = typeof userFn === 'function' && typeof nowEpochMs === 'number' && Number.isFinite(nowEpochMs)
    ? nowEpochMs
    : null;
  const start = exactNow === null ? wallClockToEpoch(now.date, now.time, fn) : null;
  const startMs = exactNow !== null ? exactNow : (start ? start.epochMs : null);
  const nextMs = startMs !== null ? startMs + snoozeMinutes * MS_PER_MINUTE : null;
  const next = nextMs !== null ? epochToWallClock(nextMs, fn) : null;
  if (!next) return snoozeFailure('invalid_time', 'Kellonaikaa ei tunnistettu.');
  // Kutsujan olioita ei jäädytetä: sisäkkäinen vaihelista kopioidaan.
  const escalation = Array.isArray(alarm.escalation)
    ? Object.freeze(alarm.escalation.map(step => (step && typeof step === 'object' ? Object.freeze({ ...step }) : step)))
    : alarm.escalation;
  const snoozed = Object.freeze({
    ...alarm,
    escalation,
    date: next.date,
    time: next.time,
    // Syksyn toistuvalla tunnilla seinäkelloaika ei yksin kerro, kumpi
    // esiintymä on kyseessä. Aikavyöhykefunktion kanssa hetki kulkee mukana.
    snoozeEpochMs: typeof userFn === 'function' ? nextMs : null,
    snoozeMinutes,
    maxSnoozes,
    snoozeCount: used + 1,
    snoozesLeft: maxSnoozes - used - 1,
    snoozed: true
  });
  return Object.freeze({ ok: true, code: 'snoozed', alarm: snoozed, message: `Herätys soi uudelleen ${clockText(next.time)}.` });
}

function stableText(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function preferAlarm(candidate, current) {
  const a = Number.isInteger(candidate.snoozeCount) ? candidate.snoozeCount : 0;
  const b = Number.isInteger(current.snoozeCount) ? current.snoozeCount : 0;
  if (a !== b) return a > b;
  const whenA = `${candidate.date} ${candidate.time}`;
  const whenB = `${current.date} ${current.time}`;
  if (whenA !== whenB) return whenA > whenB;
  return stableText(candidate) > stableText(current);
}

/**
 * Kaksoiskappaleet pois tunnisteen mukaan: torkutettu (uudempi) versio
 * voittaa, sitten myöhempi hetki. Tulos päivän ja kellonajan mukaan.
 */
export function dedupeAlarms(alarms) {
  if (!Array.isArray(alarms)) return Object.freeze([]);
  const best = new Map();
  for (const alarm of alarms) {
    if (!alarm || typeof alarm !== 'object' || typeof alarm.id !== 'string' || !alarm.id) continue;
    if (!isIsoDate(alarm.date) || !isTimeOfDay(alarm.time)) continue;
    const current = best.get(alarm.id);
    if (!current || preferAlarm(alarm, current)) best.set(alarm.id, alarm);
  }
  return Object.freeze([...best.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id, 'fi')));
}

// ------------------------------------------------------------ aamun katsaus

function briefTitle(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[.!?…]+$/u, '');
  if (!text) return null;
  return text.length > MAX_BRIEF_TITLE_LENGTH ? `${text.slice(0, MAX_BRIEF_TITLE_LENGTH - 1).trimEnd()}…` : text;
}

function greetingFor(minutes) {
  if (minutes < 10 * 60) return 'Hyvää huomenta.';
  if (minutes < 17 * 60) return 'Hyvää päivää.';
  return 'Hyvää iltaa.';
}

/**
 * Aamun lyhyt katsaus, tuotettu paikallisesti (ei tekoälyä, ei verkkoa).
 * Enintään BRIEF_MAX_SENTENCES virkettä, tärkein ensin: tervehdys ja
 * kellonaika, lähtötavoite, ensimmäinen meno (nimi vain, kun katsaus on
 * otettu käyttöön), aika aamulenkille.
 *
 * @returns {null | {lines, text, sentenceCount, titlesIncluded}}
 */
export function morningBrief(input) {
  const { now, wakeTime = null, leaveTime = null, commitments = [], freeMinutesForRun = null, settings } = objectOf(input);
  const current = objectOf(now);
  if (!isIsoDate(current.date) || !isTimeOfDay(current.time)) return null;
  const titlesAllowed = objectOf(settings).morningBriefEnabled === true;
  const nowMinutes = toMinutes(current.time);

  // Päivän ajalliset menot alkamisajan mukaan (päivämäärätön kuuluu tälle päivälle).
  const todays = [];
  for (const item of Array.isArray(commitments) ? commitments : []) {
    if (!item || typeof item !== 'object' || !isTimeOfDay(item.startTime)) continue;
    if (item.date !== undefined && item.date !== null && item.date !== current.date) continue;
    todays.push(item);
  }
  const earlier = (a, b) => a.startTime.localeCompare(b.startTime)
    || textKey(a.title).localeCompare(textKey(b.title), 'fi')
    || textKey(a.id).localeCompare(textKey(b.id), 'fi');
  let first = null;
  for (const item of todays) {
    if (!first || earlier(item, first) < 0) first = item;
  }

  const lines = [`${greetingFor(nowMinutes)} Kello on ${clockText(current.time)}.`];
  let sentences = 2;
  const optional = [];
  const hasLeave = isTimeOfDay(leaveTime);
  // Meno ilman paikkaa ja matkaa alkaa siellä missä olet: sen "lähtö" on
  // sama kuin alku (calendarPlan.commitmentsOn), eikä sitä kutsuta
  // lähtötavoitteeksi. Lähtö, joka ei kuulu millekään annetulle menolle,
  // on edelleen lähtötavoite.
  const leaving = hasLeave ? todays.filter(item => item.leaveTime === leaveTime) : [];
  const startsInPlace = leaving.length > 0 && leaving.every(item => item.leaveTime === item.startTime);
  if (hasLeave && !startsInPlace) {
    const work = first && first.category === 'tyo';
    optional.push(`${work ? 'Työmatkan lähtötavoite' : 'Lähtötavoite'} on ${clockText(leaveTime)}.`);
  }
  const title = titlesAllowed && first ? briefTitle(first.title) : null;
  if (title) {
    optional.push(`Ensimmäinen meno on ${title} kello ${clockText(first.startTime)}.`);
  } else if (startsInPlace) {
    optional.push(`Ensimmäinen meno alkaa kello ${clockText(leaveTime)}.`);
  } else if (todays.length > 0 && !hasLeave) {
    optional.push(todays.length === 1 ? 'Tänään on yksi meno.' : `Tänään on ${todays.length} menoa.`);
  }
  if (typeof freeMinutesForRun === 'number' && Number.isFinite(freeMinutesForRun)
    && Math.floor(freeMinutesForRun) >= MIN_RUN_MINUTES) {
    optional.push(`Sinulla on aikaa ${Math.floor(freeMinutesForRun)} minuutin aamulenkille.`);
  }
  if (todays.length === 0 && !hasLeave) optional.push('Aamussa ei ole kiinteitä menoja.');
  if (isTimeOfDay(wakeTime) && toMinutes(wakeTime) > nowMinutes) {
    optional.push(`Herätys on ${clockText(wakeTime)}.`);
  }
  for (const line of optional) {
    if (sentences >= BRIEF_MAX_SENTENCES) break;
    lines.push(line);
    sentences += 1;
  }

  return deepFreeze({
    lines,
    text: lines.join(' '),
    sentenceCount: sentences,
    titlesIncluded: Boolean(title) && lines.some(line => line.startsWith('Ensimmäinen meno'))
  });
}
