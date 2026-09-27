// Lähtömoottori v2: kalenterin tapahtumasta lähtöaika, vaihe ja muistutukset.
//
// PUHDAS MODUULI. Ei kelloa (tämä päivä ja nykyhetki annetaan), ei verkkoa,
// ei satunnaisuutta. Tulokset jäädytetään, eikä syötettä muuteta.
//
// =====================================================================
// TAAKSEPÄIN SAAPUMISESTA, JOKAINEN OSA NÄKYVISSÄ
// =====================================================================
//
//   saapuminen  = alku - etuajassa olo       (tapahtuma > paikka > asetukset)
//   lähtö       = saapuminen - pysäköinti ja kävely - matka
//   valmistautuminen alkaa = lähtö - valmistautuminen
//
// Laskenta itse on travel.js:n departureSchedule (yksi totuus, myös kesä-
// ajan öille). Tämä moduuli valitsee osat ja selittää ne.
//
// Matka, valmistautuminen, pysäköinti ja etuajassa olo EIVÄT ole vapaata
// aikaa: ne ovat suojattua väljyyttä, joka tekee suunnitelmasta toteutuvan.
//
// =====================================================================
// MATKA-AIKAA EI KEKSITÄ
// =====================================================================
//
// Järjestys (selectTravelEstimate):
//   1. tuore liikennetieto
//   2. opittu omista matkoista -- vain jos käyttäjä on hyväksynyt oppimisen
//      paikalle ja matkoja on vähintään kolme; liikennetiedon kanssa
//      käytetään varovaisempaa (suurempaa) lukua
//   3. tapahtumalle itse kirjattu matka-aika
//   4. paikan tavallinen matka-aika (käyttäjän kertoma)
//   5. tuntematon -> lähtöaikaa EI lasketa
//
// =====================================================================
// MUISTUTUKSEN AIKAISTUS EI SIIRRÄ KELLOA
// =====================================================================
//
// settings.reminderOffsetMinutes (käyttäjän hyväksymä myöhästelyn korjaus)
// aikaistaa VAIN muistutuksia. Näytetty lähtöaika pysyy oikeana: jos
// kellonaikaa siirrettäisiin, käyttäjä oppisi siirtämään sitä itse
// takaisin, ja luku lakkaisi tarkoittamasta mitään.

import {
  ESTIMATE_SOURCE, ESTIMATE_SOURCES, DEFAULT_ARRIVAL_BUFFER_MINUTES, MAX_ARRIVAL_BUFFER_MINUTES,
  MAX_PLACE_ARRIVAL_BUFFER_MINUTES, MAX_OVERHEAD_MINUTES, MAX_PREPARATION_MINUTES, MAX_TRAVEL_MINUTES,
  MAX_REMINDER_OFFSET_MINUTES
} from './dailyLife.js';
import {
  departureSchedule, departurePhase, departurePhaseLabel, stabilizeLeave, absoluteMinutes, fromAbsolute,
  minusMinutes, DEFAULT_BUFFERS, TRAVEL_MODES, TRAVEL_MODE, DEPARTURE_PHASE, LEAVE_IN_MINUTES,
  PREPARE_SOON_MINUTES, LEAVE_EARLIER_TOLERANCE_MINUTES, LEAVE_LATER_TOLERANCE_MINUTES
} from './travel.js';
import { normalizeRouteResponse, routeResultMinutes, ROUTING_STATUS } from './routing.js';
import { isIsoDate, isTimeOfDay, toMinutes } from './task.js';

export { DEPARTURE_PHASE };

/** Opittua kestoa ei käytetä ennen tätä määrää matkoja. */
export const MIN_LEARNED_OBSERVATIONS = 3;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Kokonaisluku väliltä [min, max] tai null. Puuttuva ei ole nolla. */
function intIn(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  return n >= min && n <= max ? n : null;
}

const SOURCE_TEXT = Object.freeze({
  [ESTIMATE_SOURCE.PROVIDER]: 'liikennetiedosta',
  [ESTIMATE_SOURCE.USER_SUPPLIED]: 'oma arviosi',
  [ESTIMATE_SOURCE.LEARNED]: 'omista matkoistasi'
});

/** Matka-ajan lähteen nimi käyttäjälle ("oma arviosi"). Tuntemattomalle tyhjä. */
export function estimateSourceText(source) {
  return SOURCE_TEXT[source] || '';
}

// =====================================================================
// MATKA-AJAN VALINTA
// =====================================================================

function estimate(fields) {
  return Object.freeze({
    known: fields.minutes !== null,
    minutes: fields.minutes,
    source: fields.minutes === null ? ESTIMATE_SOURCE.UNKNOWN : fields.source,
    basis: fields.minutes === null ? null : fields.basis,
    explanation: fields.explanation,
    providerMinutes: fields.providerMinutes ?? null,
    learnedMinutes: fields.learnedMinutes ?? null,
    trafficAware: fields.trafficAware === true,
    calculatedAt: fields.calculatedAt ?? null,
    validUntil: fields.validUntil ?? null
  });
}

/**
 * Valitse matka-aika lähtölaskentaan.
 *
 * @param {{providerResult?:object, learned?:{count:number, median:number, p80:number},
 *          event?:{travelMinutes?:number}, place?:{usualTravelMinutes?:number, useLearned?:boolean},
 *          nowMs?:number}} input
 *   providerResult: reittitieto (routing.js ROUTE_RESULT); tarkistetaan uudelleen hetkellä nowMs
 *   learned: commuteLearning.summarizeCommute -yhteenveto
 * @returns {{known:boolean, minutes:number|null, source:string, basis:'provider'|'learned'|'event'|'place'|null,
 *            explanation:string, providerMinutes:number|null, learnedMinutes:number|null,
 *            trafficAware:boolean, calculatedAt:string|null, validUntil:string|null}}
 */
export function selectTravelEstimate(input) {
  const opts = isObject(input) ? input : {};
  const event = isObject(opts.event) ? opts.event : {};
  const place = isObject(opts.place) ? opts.place : {};

  let providerMinutes = null;
  let provider = null;
  let staleNote = '';
  if (opts.providerResult !== undefined && opts.providerResult !== null) {
    const checked = normalizeRouteResponse(opts.providerResult, { nowMs: opts.nowMs });
    if (checked.status === ROUTING_STATUS.OK) {
      providerMinutes = routeResultMinutes(checked);
      provider = checked;
    } else if (checked.status === ROUTING_STATUS.STALE) {
      staleNote = 'Liikennetieto on vanhentunut, joten sitä ei käytetä. ';
    }
  }

  const learned = isObject(opts.learned) ? opts.learned : null;
  const learnedP80 = learned ? intIn(learned.p80, 1, MAX_TRAVEL_MINUTES) : null;
  const learnedMedian = learned ? intIn(learned.median, 1, MAX_TRAVEL_MINUTES) : null;
  const learnedCount = learned && Number.isInteger(learned.count) ? learned.count : 0;
  const learnedUsable = place.useLearned === true && learnedCount >= MIN_LEARNED_OBSERVATIONS
    && learnedP80 !== null && learnedMedian !== null;
  // Viikonpäivään ja lähtöaikaan tarkentunut luku kertoo rajauksensa
  // (commuteLearning.learnedCommuteFor: "maanantaisin klo 7.30–8.00 lähteneet").
  const learnedScope = learned && typeof learned.scopeText === 'string' && learned.scopeText.trim()
    ? `${learned.scopeText.trim().slice(0, 80)}, ` : '';
  const learnedText = learnedUsable
    ? `omien matkojesi perusteella (${learnedScope}${learnedCount} matkaa) tavallisesti ${learnedMedian} min`
      + (learnedP80 > learnedMedian ? `, varman päälle ${learnedP80} min` : '')
    : '';

  const providerFields = provider ? {
    providerMinutes,
    trafficAware: provider.trafficAware,
    calculatedAt: provider.calculatedAt,
    validUntil: provider.validUntil
  } : {};

  if (providerMinutes !== null) {
    const traffic = provider.trafficAware ? ' ruuhka huomioiden' : '';
    if (learnedUsable && learnedP80 > providerMinutes) {
      return estimate({
        ...providerFields,
        minutes: learnedP80,
        source: ESTIMATE_SOURCE.LEARNED,
        basis: 'learned',
        learnedMinutes: learnedP80,
        explanation: `Liikennetiedon mukaan${traffic} ${providerMinutes} min, mutta ${learnedText}. `
          + `Lasketaan varovaisemmin ${learnedP80} min.`
      });
    }
    return estimate({
      ...providerFields,
      minutes: providerMinutes,
      source: ESTIMATE_SOURCE.PROVIDER,
      basis: 'provider',
      learnedMinutes: learnedUsable ? learnedP80 : null,
      explanation: `Arvio ajantasaisesta liikennetiedosta${traffic}: ${providerMinutes} min.`
    });
  }

  if (learnedUsable) {
    return estimate({
      minutes: learnedP80,
      source: ESTIMATE_SOURCE.LEARNED,
      basis: 'learned',
      learnedMinutes: learnedP80,
      explanation: `${staleNote}Matka-aika ${learnedText}.`
    });
  }

  const eventMinutes = intIn(event.travelMinutes, 1, MAX_TRAVEL_MINUTES);
  if (eventMinutes !== null) {
    return estimate({
      minutes: eventMinutes,
      source: ESTIMATE_SOURCE.USER_SUPPLIED,
      basis: 'event',
      explanation: `${staleNote}Tälle tapahtumalle itse kirjaamasi matka-aika: ${eventMinutes} min.`
    });
  }

  const placeMinutes = intIn(place.usualTravelMinutes, 1, MAX_TRAVEL_MINUTES);
  if (placeMinutes !== null) {
    return estimate({
      minutes: placeMinutes,
      source: ESTIMATE_SOURCE.USER_SUPPLIED,
      basis: 'place',
      explanation: `${staleNote}Paikan tavallinen matka-aika, jonka olet itse kertonut: ${placeMinutes} min.`
    });
  }

  return estimate({
    minutes: null,
    explanation: `${staleNote}Matka-aikaa ei tiedetä, joten lähtöaikaa ei lasketa. `
      + 'Kerro paikalle tavallinen matka-aika, niin lähtöaika lasketaan.'
  });
}

// =====================================================================
// UUDELLEENLASKENTA: KERROTAANKO MUUTOKSESTA?
// =====================================================================

/**
 * Kerrotaanko lähtöajan muutoksesta käyttäjälle?
 *
 * Hystereesi on travel.js:n stabilizeLeave (aikaisemmaksi >= 5 min,
 * myöhemmäksi >= 10 min). Muutoksesta kerrotaan VAIN, kun sen aiheutti
 * liikennetieto (`source` tai nextLeave.source on 'provider'): käyttäjän
 * omaa muokkausta ei ilmoiteta hänelle takaisin.
 *
 * @param {{previousLeave:any, nextLeave:any, source?:string,
 *          earlierToleranceMinutes?:number, laterToleranceMinutes?:number}} input
 * @returns {{surface:boolean, changed:boolean, direction:string, deltaMinutes:number|null,
 *            message:string, leave:any}} deltaMinutes = uusi - aiempi (negatiivinen = aikaisemmaksi)
 */
export function recalcDecision(input) {
  const opts = isObject(input) ? input : {};
  const next = opts.nextLeave;
  const source = opts.source !== undefined ? opts.source : (isObject(next) ? next.source : undefined);
  const stable = stabilizeLeave(opts.previousLeave, next, {
    earlierToleranceMinutes: opts.earlierToleranceMinutes ?? LEAVE_EARLIER_TOLERANCE_MINUTES,
    laterToleranceMinutes: opts.laterToleranceMinutes ?? LEAVE_LATER_TOLERANCE_MINUTES
  });

  const moved = stable.changed && (stable.direction === 'earlier' || stable.direction === 'later');
  const surface = moved && source === ESTIMATE_SOURCE.PROVIDER;
  const amount = stable.deltaMinutes === null ? 0 : Math.abs(stable.deltaMinutes);
  let message = '';
  if (surface && stable.direction === 'earlier') {
    message = `Liikenne on hidastunut. Lähtöä kannattaa aikaistaa ${amount} minuuttia.`;
  } else if (surface) {
    message = `Liikenne on sujuvampaa. Voit lähteä ${amount} minuuttia myöhemmin.`;
  }

  return Object.freeze({
    surface,
    changed: stable.changed,
    direction: stable.direction,
    deltaMinutes: stable.deltaMinutes,
    message,
    leave: stable.leave
  });
}

// =====================================================================
// LÄHTÖSUUNNITELMA TAPAHTUMALLE
// =====================================================================

/** Ensimmäinen kelvollinen arvo lähteineen. */
function pick(candidates, fallback) {
  for (const [value, source] of candidates) if (value !== null) return { value, source };
  return fallback;
}

function point(abs) {
  const { date, time } = fromAbsolute(abs);
  return Object.freeze({ date, time, abs });
}

function dayMonth(iso) {
  const [, month, day] = iso.split('-').map(Number);
  return `${day}.${month}.`;
}

function whenText(p, referenceDate) {
  return p.date === referenceDate ? `klo ${p.time}` : `${dayMonth(p.date)} klo ${p.time}`;
}

function titleOf(occurrence, event, place) {
  for (const value of [place && place.name, occurrence && occurrence.locationText, event.locationText]) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  }
  return null;
}

const NO_REMINDERS = Object.freeze({ prepare: null, leaveIn5: null, leaveNow: null });

function notApplicable(reason, extra = {}) {
  return Object.freeze({
    applicable: false,
    known: false,
    phase: null,
    phaseLabel: '',
    eventStart: null,
    arrivalTarget: null,
    leave: null,
    prepareStart: null,
    parts: Object.freeze({ travel: null, overhead: null, early: null, preparation: null }),
    partSources: Object.freeze({ travel: null, overhead: null, early: null, preparation: null }),
    source: ESTIMATE_SOURCE.UNKNOWN,
    mode: null,
    destination: null,
    explanation: reason,
    explanationLines: Object.freeze([reason]),
    travelExplanation: '',
    reminderTimes: NO_REMINDERS,
    reminderOffsetMinutes: 0,
    minutesUntilLeave: null,
    minutesLate: null,
    dstAdjusted: false,
    occurrenceId: null,
    ...extra
  });
}

/**
 * Lähtösuunnitelma kalenterin tapahtuman esiintymälle.
 *
 * @param {object} input
 * @param {object} input.occurrence   EventOccurrence: { id, date, time|null, allDay, locationText, ... }
 *                                    (voi kantaa myös tapahtuman matka-kentät)
 * @param {object} [input.event]      CalendarEvent, jos esiintymä ei kanna matka-kenttiä
 * @param {object} [input.place]      SavedPlace
 * @param {object} [input.settings]   LifeSettings (arrivalBufferMinutes, reminderOffsetMinutes)
 * @param {object} [input.estimate]   selectTravelEstimate-tulos; ilman sitä käytetään
 *                                    tapahtuman ja paikan omia matka-aikoja
 * @param {string} [input.todayIso]   nykyhetken päivä
 * @param {number} [input.nowMinutes] nykyhetki minuutteina keskiyöstä; ilman sitä phase on null
 * @param {number} [input.prepareSoonMinutes]
 */
export function planDeparture(input) {
  const opts = isObject(input) ? input : {};
  const occurrence = isObject(opts.occurrence) ? opts.occurrence : null;
  const event = isObject(opts.event) ? opts.event : {};
  const place = isObject(opts.place) ? opts.place : null;
  const settings = isObject(opts.settings) ? opts.settings : {};
  // Laitteen vyöhyke (ms -> minuutteja UTC:stä itään). Ilman sitä laskenta
  // on puhdasta seinäkelloa; ks. travel.js "KESÄAJAN YÖT".
  const tz = typeof opts.offsetMinutesFn === 'function' ? opts.offsetMinutesFn : null;
  const occurrenceId = occurrence && typeof occurrence.id === 'string' ? occurrence.id : null;

  if (!occurrence || !isIsoDate(occurrence.date)) {
    return notApplicable('Tapahtuman päivää ei tiedetä, joten lähtöaikaa ei lasketa.', { occurrenceId });
  }
  if (occurrence.allDay === true || !isTimeOfDay(occurrence.time)) {
    return notApplicable('Koko päivän tapahtumalle ei lasketa lähtöaikaa.', { occurrenceId });
  }

  // Esiintymän kenttä voittaa tapahtuman kentän (esiintymä on tarkempi).
  const field = key => {
    if (occurrence[key] !== undefined && occurrence[key] !== null) return occurrence[key];
    return event[key];
  };

  const mode = TRAVEL_MODES.includes(field('travelMode')) ? field('travelMode')
    : (place && TRAVEL_MODES.includes(place.travelMode) ? place.travelMode : TRAVEL_MODE.DRIVING);
  const defaults = DEFAULT_BUFFERS[mode];

  const early = pick([
    [intIn(field('arrivalBufferMinutes'), 0, MAX_PLACE_ARRIVAL_BUFFER_MINUTES), 'event'],
    [place ? intIn(place.arrivalBufferMinutes, 0, MAX_PLACE_ARRIVAL_BUFFER_MINUTES) : null, 'place'],
    [intIn(settings.arrivalBufferMinutes, 0, MAX_ARRIVAL_BUFFER_MINUTES), 'settings']
  ], { value: DEFAULT_ARRIVAL_BUFFER_MINUTES, source: 'default' });
  const overhead = pick([
    [intIn(field('overheadMinutes'), 0, MAX_OVERHEAD_MINUTES), 'event'],
    [place ? intIn(place.overheadMinutes, 0, MAX_OVERHEAD_MINUTES) : null, 'place']
  ], { value: defaults.arrival, source: 'default' });
  const preparation = pick([
    [intIn(field('preparationMinutes'), 0, MAX_PREPARATION_MINUTES), 'event'],
    [place ? intIn(place.preparationMinutes, 0, MAX_PREPARATION_MINUTES) : null, 'place']
  ], { value: defaults.preparation, source: 'default' });

  const chosen = isObject(opts.estimate) ? opts.estimate
    : selectTravelEstimate({ event: { travelMinutes: field('travelMinutes') }, place });
  const travel = intIn(chosen.minutes, 1, MAX_TRAVEL_MINUTES);
  const source = travel !== null && ESTIMATE_SOURCES.includes(chosen.source) && chosen.source !== ESTIMATE_SOURCE.UNKNOWN
    ? chosen.source : ESTIMATE_SOURCE.UNKNOWN;
  const known = source !== ESTIMATE_SOURCE.UNKNOWN;
  const travelExplanation = typeof chosen.explanation === 'string' ? chosen.explanation : '';
  const offset = intIn(settings.reminderOffsetMinutes, 0, MAX_REMINDER_OFFSET_MINUTES) ?? 0;

  const startAbs = absoluteMinutes(occurrence.date, toMinutes(occurrence.time));
  const eventStart = point(startAbs);
  const arrivalTarget = point(minusMinutes(startAbs, early.value, tz));
  const date = occurrence.date;

  const lines = [`Alkaa ${whenText(eventStart, date)}.`];
  lines.push(early.value > 0
    ? `Perillä ${whenText(arrivalTarget, date)}, ${early.value} min etuajassa.`
    : `Perillä ${whenText(arrivalTarget, date)}.`);

  const partSources = Object.freeze({
    travel: known ? (chosen.basis ?? null) : null,
    overhead: overhead.source,
    early: early.source,
    preparation: preparation.source
  });
  const base = {
    applicable: true,
    eventStart,
    arrivalTarget,
    mode,
    destination: titleOf(occurrence, event, place),
    travelExplanation,
    reminderOffsetMinutes: offset,
    occurrenceId,
    partSources
  };

  if (!known) {
    lines.push('Matka-aikaa ei tiedetä, joten lähtöaikaa ei lasketa. '
      + 'Kerro paikalle tavallinen matka-aika, niin lähtöaika lasketaan.');
    return Object.freeze({
      ...notApplicable(''),
      ...base,
      phase: DEPARTURE_PHASE.UNKNOWN_TRAVEL,
      phaseLabel: departurePhaseLabel(DEPARTURE_PHASE.UNKNOWN_TRAVEL),
      parts: Object.freeze({ travel: null, overhead: overhead.value, early: early.value, preparation: preparation.value }),
      explanation: lines.join(' '),
      explanationLines: Object.freeze(lines)
    });
  }

  const plan = {
    arrivalDate: date,
    arrivalTime: occurrence.time,
    travelMinutes: travel,
    travelSource: source,
    arrivalBufferMinutes: overhead.value,
    preparationMinutes: preparation.value,
    earlyArrivalMinutes: early.value,
    destination: base.destination
  };
  const schedule = departureSchedule(plan, { todayIso: date, offsetMinutesFn: tz });
  const leave = point(schedule.leave.abs);
  const prepareStart = point(schedule.prepare.abs);
  const dstAdjusted = leave.abs !== startAbs - early.value - overhead.value - travel
    || prepareStart.abs !== leave.abs - preparation.value;

  lines.push(`Lähde ${whenText(leave, date)}: matka ${travel} min (${estimateSourceText(source)})`
    + (overhead.value > 0 ? `, pysäköinti ja kävely ${overhead.value} min.` : '.'));
  if (preparation.value > 0) {
    lines.push(`Aloita valmistautuminen ${whenText(prepareStart, date)} (${preparation.value} min).`);
  }
  if (offset > 0) lines.push(`Muistutukset tulevat ${offset} min tavallista aikaisemmin.`);
  if (dstAdjusted) lines.push('Kello siirtyy yöllä kesäaikaan, ja lähtö on laskettu siirtymä huomioiden.');

  // Muistutukset: aikaistus vain tässä, ei näytettyihin kellonaikoihin.
  // "Lähtö 5 min päästä" jää pois, jos valmistautuminen (1-5 min) alkaa
  // sen jälkeen tai samaan aikaan -- kaksi muistutusta peräkkäin olisi melua.
  const reminder = abs => {
    const { date: d, time } = fromAbsolute(abs);
    return Object.freeze({ date: d, time });
  };
  const withLeaveIn5 = preparation.value === 0 || preparation.value > LEAVE_IN_MINUTES;
  const reminderTimes = Object.freeze({
    prepare: preparation.value > 0 ? reminder(minusMinutes(prepareStart.abs, offset, tz)) : null,
    leaveIn5: withLeaveIn5 ? reminder(minusMinutes(leave.abs, LEAVE_IN_MINUTES + offset, tz)) : null,
    leaveNow: reminder(minusMinutes(leave.abs, offset, tz))
  });

  let phase = null;
  let minutesUntilLeave = null;
  let minutesLate = null;
  if (isIsoDate(opts.todayIso) && typeof opts.nowMinutes === 'number' && Number.isFinite(opts.nowMinutes)) {
    const state = departurePhase(plan, {
      todayIso: opts.todayIso,
      nowMinutes: opts.nowMinutes,
      prepareSoonMinutes: opts.prepareSoonMinutes ?? PREPARE_SOON_MINUTES,
      offsetMinutesFn: tz
    });
    phase = state.phase;
    minutesUntilLeave = state.minutesUntilLeave;
    minutesLate = state.minutesLate;
  }

  return Object.freeze({
    ...base,
    known: true,
    phase,
    phaseLabel: phase ? departurePhaseLabel(phase) : '',
    leave,
    prepareStart,
    parts: Object.freeze({ travel, overhead: overhead.value, early: early.value, preparation: preparation.value }),
    source,
    explanation: lines.join(' '),
    explanationLines: Object.freeze(lines),
    reminderTimes,
    minutesUntilLeave,
    minutesLate,
    dstAdjusted
  });
}
