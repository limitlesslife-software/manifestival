// Kapasiteetti: paljonko aikaa oikeasti on.
//
// =====================================================================
// VUOROKAUDESSA EI OLE 24 SUUNNITELTAVAA TUNTIA
// =====================================================================
//
// Tämä on koko moduulin perustelu. Suunnittelija, joka pitää
// vuorokautta 1440 minuutin säiliönä, tuottaa suunnitelmia jotka ovat
// aritmeettisesti mahdollisia ja inhimillisesti mahdottomia — ja
// mahdoton suunnitelma näyttää täsmälleen yhtä valmiilta kuin
// mahdollinen.
//
// Päivä kuluu neljään osaan:
//
//   UNI             ei suunniteltavissa, tulee profiilista
//   KIINTEÄ          käyttäjän itse ajastama työ, ei siirrettävissä
//   JOUSTAVA         suunniteltu mutta siirrettävissä
//   VAPAA            se mitä jää — ja siitäkään ei käytetä kaikkea
//
// =====================================================================
// PUSKURI EI OLE HUKKAA
// =====================================================================
//
// `bufferRatio` jättää osan vapaasta ajasta suunnittelematta. Se ei ole
// varovaisuutta vaan realismia: päivät venyvät, asiat kestävät
// arvioitua pidempään ja jokin tulee aina väliin. Täyteen ahdettu
// kalenteri epäonnistuu ensimmäisestä yllätyksestä, ja epäonnistunut
// suunnitelma opettaa käyttäjän olemaan luottamatta suunnitelmiin.
//
// =====================================================================
// TÄMÄ MODUULI EI SIJOITA MITÄÄN
// =====================================================================
//
// Se laskee KUINKA PALJON. Mihin kohtaan päivää mikin menee on
// `planScheduler.js`:n asia, ja se nojaa olemassa olevaan
// `scheduler.js`:n vapaiden välien laskentaan.

import { fmtISO, parseISO, addDays } from '../lib/datetime.js';
import { isIsoDate, durationOf } from './task.js';
import {
  DEFAULT_PROFILE, DEFAULT_TASK_MINUTES, awakeWindow,
  eventsOnDate, eventItemsOnDate, blocksOnDate, protectSleepRange, unionMinutesWithin,
  indexEventOccurrences, indexCalendarBlocks
} from './scheduler.js';
import { expandRoutines } from './routine.js';
import { DEFAULT_ROUTINE_MINUTES } from './routine.js';

/**
 * Osuus vapaasta ajasta, joka jätetään suunnittelematta.
 *
 * 0,25 tarkoittaa: neljästä vapaasta tunnista suunnitellaan kolme.
 *
 * Luku on maltillinen tarkoituksella. Sen tehtävä ei ole tehdä
 * suunnitelmasta väljää vaan estää sitä olemasta mahdoton.
 */
export const DEFAULT_BUFFER_RATIO = 0.25;

/** Lyhin väli, jota kannattaa laskea käytettäväksi. */
export const MIN_USABLE_MINUTES = 15;

/** Kuinka pitkälle eteenpäin kapasiteettia lasketaan oletuksena. */
export const DEFAULT_HORIZON_DAYS = 28;

/** Pisin sallittu horisontti. Yli vuoden ennuste on arvaus. */
export const MAX_HORIZON_DAYS = 365;

function clampRatio(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  // Puskuri ei voi olla koko päivä: silloin mitään ei voisi suunnitella
  // eikä suunnittelija kertoisi miksi.
  return Math.max(0, Math.min(0.9, n));
}

/** Käyttäjän puskuri (profile.planning_buffer_ratio, 0–0,9) tai oletus. */
export function normalizeBufferRatio(value) {
  return clampRatio(value, DEFAULT_BUFFER_RATIO);
}

/**
 * Unen vaje keventää päivää (life_settings.sleep_affects_capacity).
 *
 * 10 % jokaista vajaata tuntia kohti, enintään 30 %. Vaje on minuutteja
 * tavoitteesta; nolla tai tuntematon ei muuta mitään.
 */
export const SLEEP_ADJUST_PER_HOUR = 0.1;
export const SLEEP_ADJUST_MAX = 0.3;

export function sleepAdjustRatio(shortfallMinutes) {
  const n = Number(shortfallMinutes);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(SLEEP_ADJUST_MAX, Math.round((n / 60) * SLEEP_ADJUST_PER_HOUR * 100) / 100);
}

/**
 * Kapasiteettijarrun jälkimmäinen puoli: puskurin jälkeen vähennetään unen
 * vaje ja viikon vähimmäisvapaa-ajan päiväosuus. Palauttaa erittelyn.
 */
function applyBrake(rawFreeMinutes, ratio, { sleepShortfallMinutes = 0, reservedMinutes = 0 } = {}) {
  const bufferMinutes = Math.round(rawFreeMinutes * ratio);
  const afterBuffer = Math.max(0, rawFreeMinutes - bufferMinutes);
  const sleepAdjustMinutes = Math.round(afterBuffer * sleepAdjustRatio(sleepShortfallMinutes));
  const afterSleep = Math.max(0, afterBuffer - sleepAdjustMinutes);
  const reserved = Math.max(0, Math.min(afterSleep, Math.round(Number(reservedMinutes) || 0)));
  const usable = Math.max(0, afterSleep - reserved);
  return {
    bufferMinutes,
    sleepAdjustMinutes,
    reservedFreeMinutes: reserved,
    usableMinutes: usable >= MIN_USABLE_MINUTES ? usable : 0
  };
}

function protectedBlockMinutes(dayBlocks, range, kind) {
  return unionMinutesWithin(dayBlocks.filter(block => (block.blockKind ?? block.kind) === kind), range);
}

/**
 * Yhden päivän kapasiteetti.
 *
 * KAIKKI LUVUT OVAT MINUUTTEJA.
 *
 * @param {object} input
 * @param {Array}  input.tasks       kaikki tehtävät (suodatetaan päivälle)
 * @param {object} input.profile     herätys- ja nukkumaanmenoajan lähde
 * @param {string} input.dateIso
 * @param {Array}  [input.routines]
 * @param {Array}  [input.exceptions]
 * @param {number} [input.bufferRatio]
 * @param {Array}  [input.events]  tapahtumaesiintymät (calendar.js)
 * @param {Array}  [input.blocks]  suojatut lohkot (calendarBlocks.js)
 *
 * KALENTERITIETOINEN LASKENTA ON VALINNAINEN. Kun `events` tai `blocks`
 * annetaan (tyhjäkin taulukko), sitoutunut aika lasketaan varattujen
 * välien UNIONINA valveillaoloikkunan sisällä: matka, joka osuu
 * kiinteän tapaamisen päälle, ei vähennä samaa aikaa kahdesti, eikä
 * nukkumaanmenon jälkeinen merkintä syö valveillaoloaikaa. Ilman niitä
 * tulos on täsmälleen sama kuin ennen, jotta vanhat kutsujat ja niiden
 * luvut eivät muutu huomaamatta.
 */
export function dayCapacity({
  tasks = [],
  profile = DEFAULT_PROFILE,
  dateIso,
  routines = [],
  exceptions = [],
  bufferRatio = DEFAULT_BUFFER_RATIO,
  events = null,
  blocks = null,
  sleepShortfallMinutes = 0,
  reservedMinutes = 0
} = {}) {
  const brake = { sleepShortfallMinutes, reservedMinutes };
  if (Array.isArray(events) || Array.isArray(blocks)) {
    return calendarDayCapacity({
      tasks, profile, dateIso, routines, exceptions, bufferRatio,
      events: Array.isArray(events) ? events : [],
      blocks: Array.isArray(blocks) ? blocks : [],
      brake
    });
  }

  const ratio = clampRatio(bufferRatio, DEFAULT_BUFFER_RATIO);

  const dayTasks = tasks.filter(task => task && task.date === dateIso && !task.completed);

  // Valveillaoloaika luetaan olemassa olevasta aikataulumoottorista.
  // Herätys- ja nukkumaanmenoaika johdetaan profiilista ja päivän
  // ensimmäisestä kiinteästä sitoumuksesta — sitä logiikkaa ei toisteta.
  const valve = awakeWindow({ tasks: dayTasks, profile, dateIso });
  const awakeMinutes = Math.max(0, valve.end - valve.start);

  // KIINTEÄ: käyttäjän itse ajastama. Ei siirrettävissä.
  const fixed = dayTasks.filter(task => task.time && task.schedulingState !== 'auto');
  const fixedMinutes = sumMinutes(fixed);

  // JOUSTAVA: automaatin sijoittama, siirrettävissä.
  const flexible = dayTasks.filter(task => task.time && task.schedulingState === 'auto');
  const flexibleMinutes = sumMinutes(flexible);

  // RUTIINIT: toistuvat sitoumukset. Nekin varaavat aikaa, vaikka niitä
  // ei ole kirjattu tehtäviksi.
  const occurrences = expandRoutines({
    routines, from: dateIso, to: dateIso, exceptions
  });
  const routineMinutes = occurrences
    .reduce((total, o) => total + (o.durationMinutes || DEFAULT_ROUTINE_MINUTES), 0);

  const committedMinutes = fixedMinutes + flexibleMinutes + routineMinutes;
  const rawFreeMinutes = Math.max(0, awakeMinutes - committedMinutes);

  // Puskuri lasketaan VAPAASTA ajasta, ei valveillaoloajasta. Muuten
  // täysi päivä kuluttaisi puskurin kahdesti: kerran sitoumuksina ja
  // kerran puskurina.
  const applied = applyBrake(rawFreeMinutes, ratio, brake);

  return {
    dateIso,
    awakeMinutes,
    fixedMinutes,
    flexibleMinutes,
    routineMinutes,
    committedMinutes,
    /** Vapaa aika ennen puskuria. */
    rawFreeMinutes,
    bufferMinutes: applied.bufferMinutes,
    /** Unen vajeen kevennys (vain kun asetus on päällä ja vaje tiedossa). */
    sleepAdjustMinutes: applied.sleepAdjustMinutes,
    /** Viikon vähimmäisvapaa-ajan päiväosuus (protectedTime.weeklyFreeTimeReserve). */
    reservedFreeMinutes: applied.reservedFreeMinutes,
    /** SE LUKU, JOTA SUUNNITTELIJA SAA KÄYTTÄÄ. */
    usableMinutes: applied.usableMinutes,
    protectedTimeMinutes: 0,
    vacation: false,
    /** Tapahtumia ja lohkoja ei annettu: niiden minuutteja ei laskettu (ei nolla). */
    calendarAware: false,
    eventMinutes: null,
    blockMinutes: null,
    counts: {
      fixed: fixed.length,
      flexible: flexible.length,
      routines: occurrences.length,
      events: 0,
      blocks: 0
    }
  };
}

/**
 * Kalenteritietoinen päiväkapasiteetti (ks. dayCapacity).
 *
 * VARATTU = ajallisten merkintöjen (kiinteät ja automaattiset tehtävät,
 * kiinteät rutiinit, tapahtumat ja lohkot) UNIONI valveillaoloikkunan
 * sisällä + ajattomien rutiinien minuutit (ne vievät aikaa jossain
 * kohtaa päivää, mutta niillä ei ole väliä, jonka voisi yhdistää).
 *
 * Valveillaoloikkuna luetaan KAIKISTA tehtävistä kuten päivänäkymässä
 * (huomisen työ määrää tämän illan nukkumaanmenon), ja suojattu uni
 * kaventaa sitä samalla tavalla kuin buildDayPlan.
 */
function calendarDayCapacity({ tasks, profile, dateIso, routines, exceptions, bufferRatio, events, blocks, brake = {} }) {
  const ratio = clampRatio(bufferRatio, DEFAULT_BUFFER_RATIO);
  const all = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const dayTasks = all.filter(task => task.date === dateIso && !task.completed);

  const dayBlocks = blocksOnDate(blocks, dateIso);
  const dayEvents = eventsOnDate(events, dateIso);
  const eventItems = eventItemsOnDate(events, dateIso);

  const range = protectSleepRange(awakeWindow({ tasks: all, profile, dateIso }), dayBlocks);
  const awakeMinutes = Math.max(0, range.end - range.start);

  const fixed = dayTasks.filter(task => task.time && task.schedulingState !== 'auto');
  const flexible = dayTasks.filter(task => task.time && task.schedulingState === 'auto');

  const occurrences = expandRoutines({ routines, from: dateIso, to: dateIso, exceptions });
  const timedRoutines = occurrences.filter(o => o.time);
  const untimedRoutineMinutes = occurrences
    .filter(o => !o.time)
    .reduce((total, o) => total + (o.durationMinutes || DEFAULT_ROUTINE_MINUTES), 0);

  const timedCommitted = unionMinutesWithin(
    [...fixed, ...flexible, ...timedRoutines, ...eventItems, ...dayBlocks], range);
  const committedMinutes = timedCommitted + untimedRoutineMinutes;
  const rawFreeMinutes = Math.max(0, awakeMinutes - committedMinutes);

  const applied = applyBrake(rawFreeMinutes, ratio, brake);
  const ownTimeMinutes = protectedBlockMinutes(dayBlocks, range, 'own_time');
  const freeTimeMinutes = protectedBlockMinutes(dayBlocks, range, 'free_time');
  const vacation = dayBlocks.some(block => (block.blockKind ?? block.kind) === 'vacation');

  return {
    dateIso,
    awakeMinutes,
    // Erittely näytettäväksi: summat kuten ennen. Päällekkäisyys on
    // poistettu vain `committedMinutes`-luvusta, johon suunnittelu nojaa.
    fixedMinutes: sumMinutes(fixed),
    flexibleMinutes: sumMinutes(flexible),
    routineMinutes: occurrences
      .reduce((total, o) => total + (o.durationMinutes || DEFAULT_ROUTINE_MINUTES), 0),
    committedMinutes,
    rawFreeMinutes,
    bufferMinutes: applied.bufferMinutes,
    sleepAdjustMinutes: applied.sleepAdjustMinutes,
    reservedFreeMinutes: applied.reservedFreeMinutes,
    usableMinutes: applied.usableMinutes,
    /** Suojattu oma aika ja vapaa-aika valveillaoloikkunassa (lohkojen unioni, sisältyy blockMinutes-lukuun). */
    ownTimeMinutes,
    freeTimeMinutes,
    protectedTimeMinutes: unionMinutesWithin(dayBlocks.filter(block =>
      ['own_time', 'free_time', 'vacation'].includes(block.blockKind ?? block.kind)), range),
    /** Loma: joustavalle työlle ei ole aikaa. Kiinteät menot on laskettu yllä. */
    vacation,
    calendarAware: true,
    /** Tapahtumien varaama aika valveillaoloikkunassa (unioni). */
    eventMinutes: unionMinutesWithin(eventItems, range),
    /** Suojattujen lohkojen aika valveillaoloikkunassa (unioni). Uni on jo ikkunan ulkopuolella. */
    blockMinutes: unionMinutesWithin(dayBlocks, range),
    counts: {
      fixed: fixed.length,
      flexible: flexible.length,
      routines: occurrences.length,
      events: dayEvents.length,
      blocks: dayBlocks.length
    }
  };
}

function sumMinutes(tasks) {
  return tasks.reduce((total, task) => total + (durationOf(task) ?? DEFAULT_TASK_MINUTES), 0);
}

/**
 * Kalenterisyötteen jäädytys kerran koko horisontille: päiväindeksi
 * rakennetaan silloin vain kerran, ja jokainen päivähaku on O(1).
 * null säilyy nullina, jotta vanha laskenta pysyy vanhana.
 */
function calendarInputOnce(items, indexer) {
  if (!Array.isArray(items)) return null;
  const frozen = Object.isFrozen(items) ? items : Object.freeze([...items]);
  indexer(frozen);
  return frozen;
}

/**
 * Kapasiteetti aikavälillä.
 *
 * Palauttaa päiväkohtaiset luvut JA summan. Päiväkohtaiset ovat se,
 * jonka varassa sijoitus tehdään; summa on se, jonka varassa
 * ennuste tehdään.
 *
 * @returns {{days: Array, totalUsableMinutes: number, dayCount: number}}
 */
export function horizonCapacity({
  tasks = [],
  profile = DEFAULT_PROFILE,
  fromIso,
  toIso,
  routines = [],
  exceptions = [],
  bufferRatio = DEFAULT_BUFFER_RATIO,
  events = null,
  blocks = null,
  // Kapasiteettijarru (src/app/capacityBrake.js): päivä -> minuutit.
  reserves = null,
  sleepShortfalls = null
} = {}) {
  const days = [];

  if (!isIsoDate(fromIso) || !isIsoDate(toIso) || toIso < fromIso) {
    return { days, totalUsableMinutes: 0, dayCount: 0 };
  }

  // Päiväindeksit rakennetaan kerran koko horisontille, ei joka päivälle.
  const eventList = calendarInputOnce(events, indexEventOccurrences);
  const blockList = calendarInputOnce(blocks, indexCalendarBlocks);
  const perDay = (map, dateIso) => (map instanceof Map && Number.isFinite(map.get(dateIso)) ? map.get(dateIso) : 0);

  let cursor = parseISO(fromIso);
  const end = parseISO(toIso);
  let guard = 0;

  while (cursor <= end && guard < MAX_HORIZON_DAYS) {
    const dateIso = fmtISO(cursor);
    days.push(dayCapacity({
      tasks, profile, dateIso, routines, exceptions, bufferRatio,
      events: eventList, blocks: blockList,
      reservedMinutes: perDay(reserves, dateIso),
      sleepShortfallMinutes: perDay(sleepShortfalls, dateIso)
    }));
    cursor = addDays(cursor, 1);
    guard += 1;
  }

  return {
    days,
    totalUsableMinutes: days.reduce((total, day) => total + day.usableMinutes, 0),
    dayCount: days.length
  };
}

/**
 * Horisontin loppupäivä.
 *
 * Rajataan `MAX_HORIZON_DAYS`:iin, koska pidemmälle laskettu kapasiteetti
 * ei ole tietoa vaan arvaus — profiili, rutiinit ja elämä muuttuvat.
 */
export function horizonEnd(fromIso, days = DEFAULT_HORIZON_DAYS) {
  if (!isIsoDate(fromIso)) return null;
  const n = Math.max(1, Math.min(MAX_HORIZON_DAYS, Math.trunc(Number(days) || 0)));
  return fmtISO(addDays(parseISO(fromIso), n - 1));
}

/**
 * Kapasiteetti määräpäivään mennessä.
 *
 * Tämä on ennusteen ja mahdottomuustarkistuksen perusluku: paljonko
 * suunniteltavaa aikaa on jäljellä ennen kuin määräpäivä tulee.
 *
 * Palauttaa `null` kun määräpäivä on menneisyydessä — kysymys ei ole
 * enää voimassa, eikä nolla kertoisi sitä.
 */
export function capacityUntil({
  tasks = [],
  profile = DEFAULT_PROFILE,
  todayIso,
  deadlineIso,
  routines = [],
  exceptions = [],
  bufferRatio = DEFAULT_BUFFER_RATIO,
  events = null,
  blocks = null,
  reserves = null,
  sleepShortfalls = null
} = {}) {
  if (!isIsoDate(todayIso) || !isIsoDate(deadlineIso)) return null;
  if (deadlineIso < todayIso) return null;

  return horizonCapacity({
    tasks, profile, fromIso: todayIso, toIso: deadlineIso,
    routines, exceptions, bufferRatio, events, blocks, reserves, sleepShortfalls
  });
}

/**
 * Paljonko työtä on jäljellä?
 *
 * Vain KESKENERÄINEN työ lasketaan. Valmis tehtävä ei vaadi aikaa,
 * eikä sitä pidä laskea jäljellä olevaksi kuormaksi.
 *
 * Tehtävä ilman kestoarviota saa oletuksen. Se on arvaus, ja
 * `estimated`-luku kertoo montako sellaista mukana on — jotta
 * käyttöliittymä voi sanoa, kuinka luotettava kokonaisluku on.
 */
export function remainingWork(tasks = []) {
  let minutes = 0;
  let counted = 0;
  let estimated = 0;

  for (const task of tasks) {
    if (!task || task.completed) continue;
    counted += 1;

    const duration = durationOf(task);
    if (duration === null) {
      estimated += 1;
      minutes += DEFAULT_TASK_MINUTES;
    } else {
      minutes += duration;
    }
  }

  return {
    minutes,
    taskCount: counted,
    /** Montako tehtävää käytti oletuskestoa oikean arvion sijaan. */
    estimatedCount: estimated,
    /** Kuinka suuri osa luvusta on arvattu. */
    estimateRatio: counted === 0 ? 0 : Math.round((estimated / counted) * 100) / 100
  };
}

/**
 * Riittääkö aika?
 *
 * Vertaa jäljellä olevaa työtä jäljellä olevaan kapasiteettiin.
 *
 * `feasible: null` tarkoittaa ettei kysymykseen voi vastata — ei sitä,
 * että vastaus olisi kielteinen. Määräpäivätön tavoite ei ole mahdoton;
 * se on määräpäivätön.
 */
export function feasibility({ remaining, capacity }) {
  if (!remaining || !capacity) {
    return { feasible: null, requiredMinutes: null, availableMinutes: null, ratio: null };
  }

  const required = remaining.minutes;
  const available = capacity.totalUsableMinutes;

  return {
    feasible: required <= available,
    requiredMinutes: required,
    availableMinutes: available,
    /**
     * Kuinka täyteen kapasiteetti menisi. Yli 1 tarkoittaa mahdotonta.
     * Nolla kapasiteettia ja nolla työtä on mahdollista, ei mahdotonta.
     */
    ratio: available === 0
      ? (required === 0 ? 0 : Infinity)
      : Math.round((required / available) * 100) / 100
  };
}

/**
 * Montako minuuttia päivässä keskimäärin tarvittaisiin?
 *
 * Käytetään perusteluissa: "tähän tarvittaisiin noin 45 min päivässä".
 * Se on ymmärrettävämpi kuin "18 tuntia jäljellä".
 */
export function dailyRequirement(remainingMinutes, dayCount) {
  const days = Math.trunc(Number(dayCount) || 0);
  if (days <= 0) return null;
  return Math.ceil(Number(remainingMinutes || 0) / days);
}
