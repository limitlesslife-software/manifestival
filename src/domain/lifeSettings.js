// Arjen asetukset: uni, herätys, aamurutiini, ateriarytmi, ohjaustyyli
// ja muistutusten toimitustapa. YKSI rivi käyttäjää kohti.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa.
//
// PUUTTUVA RIVI = OLETUKSET. Uusi käyttäjä ei tallenna mitään ennen kuin
// muuttaa jotain; `effectiveLifeSettings([])` antaa silti täyden,
// kelvollisen olion. Unen tavoite ja arkiherätys EIVÄT ole täällä: ne
// pysyvät profiilissa (profile.sleepTargetHours, profile.defaultWakeTime).
//
// JSONB-RAKENTEET TARKISTETAAN KENTITTÄIN. Kanta rajaa vain tyypin ja
// koon (migraatio 0014); sisältö voi tulla vanhemmasta sovellusversiosta,
// toiselta laitteelta tai käsin muokattuna. Siksi normalisointi:
//
//   - pudottaa tuntemattomat avaimet ja kelvottomat alkiot,
//   - kiristää luvut sallitulle alueelle,
//   - palauttaa oletuksen, kun rakenne on roskaa,
//   - ei koskaan heitä.
//
// PUHE ON AINA KÄYTTÄJÄN OMA VALINTA: yksikään oletus ei puhu, eikä
// herätyksen oletusvoimistus sisällä puhetta.

import {
  PROTECTION, PROTECTIONS, GUIDANCE_STYLE, GUIDANCE_STYLES, DELIVERIES, REMINDER_TOPICS,
  DEFAULT_DELIVERY, ALARM_MODE, ALARM_MODES, ESCALATION_STEP, ESCALATION_STEPS,
  MAX_ALARM_RING_MINUTES, MAX_SNOOZE_MINUTES, MAX_SNOOZES,
  DEFAULT_ARRIVAL_BUFFER_MINUTES, MAX_ARRIVAL_BUFFER_MINUTES,
  DEFAULT_WIND_DOWN_MINUTES, MAX_WIND_DOWN_MINUTES,
  DEFAULT_WEEKEND_SHIFT_MINUTES, MAX_WEEKEND_SHIFT_MINUTES, MAX_REMINDER_OFFSET_MINUTES,
  MAX_MORNING_STEPS, MAX_MEALS
} from './dailyLife.js';
import {
  idOrNull, textOrNull, intOrNull, clampInt, boolOr, oneOf, timeOrNull, minutesOfTime
} from './entityFields.js';

// ------------------------------------------------------------ rajat

/** Oma tuntiarvo sentteinä (kanta: life_settings_hourly_value_check). */
export const MAX_HOURLY_VALUE_MINOR = 1000000000;
export const DEFAULT_CURRENCY = 'EUR';
export const DEFAULT_DIGEST_TIME = '18:00';

/** jsonb-sarakkeiden kokoraja (kanta: pg_column_size). JSON-teksti on likiarvo. */
export const MAX_ALARM_JSON_BYTES = 8192;
export const MAX_MORNING_ROUTINE_JSON_BYTES = 8192;
export const MAX_MEAL_RHYTHM_JSON_BYTES = 8192;
export const MAX_DELIVERY_JSON_BYTES = 4096;

export const MAX_STEP_NAME_LENGTH = 60;
export const MAX_STEP_MINUTES = 240;
export const MAX_ITEM_ID_LENGTH = 40;
export const MAX_MEAL_PREP_MINUTES = 240;
export const MAX_SUPPLEMENTS = 10;
export const MIN_WATER_INTERVAL_MINUTES = 15;
export const MAX_WATER_INTERVAL_MINUTES = 480;
export const MAX_ESCALATION_STEPS = 6;
export const DEFAULT_SNOOZE_MINUTES = 9;

/**
 * Herätyksen oletusvoimistus: pehmeä ääni, minuutin päästä kovempi.
 * Ei puhetta (käyttäjän valinta) eikä loputonta hälytystä
 * (MAX_ALARM_RING_MINUTES rajaa koko soiton).
 */
export const DEFAULT_ESCALATION = Object.freeze([
  Object.freeze({ afterSeconds: 0, step: ESCALATION_STEP.SOFT }),
  Object.freeze({ afterSeconds: 60, step: ESCALATION_STEP.LOUD })
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Oletukset. Jäädytetty syvältä: kukaan ei voi muuttaa toisen oletusta. */
export const DEFAULT_LIFE_SETTINGS = deepFreeze({
  id: null,
  weekendWakeShiftMaxMinutes: DEFAULT_WEEKEND_SHIFT_MINUTES,
  weekendBedShiftMaxMinutes: DEFAULT_WEEKEND_SHIFT_MINUTES,
  windDownMinutes: DEFAULT_WIND_DOWN_MINUTES,
  bedtimeTarget: null,
  arrivalBufferMinutes: DEFAULT_ARRIVAL_BUFFER_MINUTES,
  guidanceStyle: GUIDANCE_STYLE.CALM,
  speechEnabled: false,
  morningBriefEnabled: false,
  reminderOffsetMinutes: 0,
  digestEnabled: false,
  digestTime: DEFAULT_DIGEST_TIME,
  sleepAffectsCapacity: false,
  hourlyValueMinor: null,
  currency: DEFAULT_CURRENCY,
  alarm: {
    enabled: false,
    mode: ALARM_MODE.SOUND,
    snoozeMinutes: DEFAULT_SNOOZE_MINUTES,
    maxSnoozes: MAX_SNOOZES,
    escalation: DEFAULT_ESCALATION.map(step => ({ ...step })),
    weekdayTime: null,
    weekendTime: null,
    followPlan: true
  },
  morningRoutine: [],
  mealRhythm: {
    meals: [],
    waterEveryMinutes: null,
    waterFrom: null,
    waterTo: null,
    supplements: [],
    lateEatingCutoff: null
  },
  delivery: {},
  createdAt: null,
  updatedAt: null
});

// ------------------------------------------------------------ apurit

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Alkion tunniste: annettu (rajattu) tai johdettu järjestyksestä. Toistuva
 * tunniste saa johdetun, jotta kaksi alkiota ei koskaan jaa tunnistetta.
 */
function itemIds(items, prefix) {
  const used = new Set();
  return items.map((item, index) => {
    let id = idOrNull(item.id, MAX_ITEM_ID_LENGTH);
    if (!id || used.has(id)) {
      let n = index + 1;
      id = `${prefix}-${n}`;
      while (used.has(id)) { n += 1; id = `${prefix}-${n}`; }
    }
    used.add(id);
    return id;
  });
}

function currencyOf(value) {
  if (typeof value !== 'string') return DEFAULT_CURRENCY;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : DEFAULT_CURRENCY;
}

// ------------------------------------------------------------ herätys

/**
 * Voimistuksen vaiheet: tunnettu toiminto, 0 … MAX_ALARM_RING_MINUTES
 * sekuntia soiton alusta, nousevasti, yksi vaihe per hetki. Roska tai tyhjä
 * lista -> oletusvoimistus (herätys ilman ääntä ei herättäisi).
 */
function normalizeEscalation(value) {
  if (!Array.isArray(value)) return DEFAULT_ESCALATION.map(step => ({ ...step }));
  const byTime = new Map();
  for (const raw of value) {
    if (!isPlainObject(raw) || !ESCALATION_STEPS.includes(raw.step)) continue;
    const after = intOrNull(raw.afterSeconds, 0, MAX_ALARM_RING_MINUTES * 60);
    if (after === null || byTime.has(after)) continue;
    byTime.set(after, { afterSeconds: after, step: raw.step });
  }
  const steps = [...byTime.values()].sort((a, b) => a.afterSeconds - b.afterSeconds)
    .slice(0, MAX_ESCALATION_STEPS);
  return steps.length ? steps : DEFAULT_ESCALATION.map(step => ({ ...step }));
}

export function normalizeAlarm(value) {
  const source = isPlainObject(value) ? value : {};
  const base = DEFAULT_LIFE_SETTINGS.alarm;
  return {
    enabled: boolOr(source.enabled, base.enabled),
    mode: oneOf(source.mode, ALARM_MODES, base.mode),
    snoozeMinutes: clampInt(source.snoozeMinutes, 1, MAX_SNOOZE_MINUTES, base.snoozeMinutes),
    maxSnoozes: clampInt(source.maxSnoozes, 0, MAX_SNOOZES, base.maxSnoozes),
    escalation: normalizeEscalation(source.escalation),
    weekdayTime: timeOrNull(source.weekdayTime),
    weekendTime: timeOrNull(source.weekendTime),
    // Herätys seuraa päivän suunnitelmaa (aikainen meno aikaistaa), ellei
    // käyttäjä kiinnitä kellonaikaa.
    followPlan: boolOr(source.followPlan, base.followPlan)
  };
}

// ------------------------------------------------------------ aamurutiini

/**
 * Aamurutiinin vaiheet: nimi ja kesto pakollisia (vaihe ilman niitä ei
 * mahdu suunnitelmaan), suojausluokka tuntematon -> tärkeä mutta joustava.
 * Pakollinen tai suojattu vaihe EI koskaan tipu automaattisesti; tämä vain
 * siivoaa rakenteen.
 */
export function normalizeMorningRoutine(value) {
  if (!Array.isArray(value)) return [];
  const steps = [];
  for (const raw of value) {
    if (!isPlainObject(raw)) continue;
    const name = textOrNull(raw.name, MAX_STEP_NAME_LENGTH);
    const minutes = intOrNull(raw.minutes, 1, MAX_STEP_MINUTES);
    if (!name || minutes === null) continue;
    steps.push({ id: raw.id, name, minutes, protection: oneOf(raw.protection, PROTECTIONS, PROTECTION.IMPORTANT_FLEXIBLE) });
    if (steps.length === MAX_MORNING_STEPS) break;
  }
  const ids = itemIds(steps, 'aamu');
  return steps.map((step, index) => ({ ...step, id: ids[index] }));
}

// ------------------------------------------------------------ ateriat

function byTimeThenName(a, b) {
  if (a.time !== b.time) {
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    return minutesOfTime(a.time) - minutesOfTime(b.time);
  }
  return a.name.localeCompare(b.name, 'fi');
}

export function normalizeMealRhythm(value) {
  const source = isPlainObject(value) ? value : {};
  const meals = [];
  for (const raw of Array.isArray(source.meals) ? source.meals : []) {
    if (!isPlainObject(raw)) continue;
    const name = textOrNull(raw.name, MAX_STEP_NAME_LENGTH);
    const time = timeOrNull(raw.time);
    // Ateria ilman kellonaikaa ei ole rytmiä: siitä ei voi muistuttaa.
    if (!name || !time) continue;
    meals.push({ id: raw.id, name, time, prepMinutes: intOrNull(raw.prepMinutes, 0, MAX_MEAL_PREP_MINUTES) });
    if (meals.length === MAX_MEALS) break;
  }
  meals.sort(byTimeThenName);
  const mealIds = itemIds(meals, 'ateria');

  const supplements = [];
  for (const raw of Array.isArray(source.supplements) ? source.supplements : []) {
    if (!isPlainObject(raw)) continue;
    const name = textOrNull(raw.name, MAX_STEP_NAME_LENGTH);
    if (!name) continue;
    // Kellonaika saa puuttua ("aamupalan kanssa").
    supplements.push({ id: raw.id, name, time: timeOrNull(raw.time) });
    if (supplements.length === MAX_SUPPLEMENTS) break;
  }
  supplements.sort(byTimeThenName);
  const supplementIds = itemIds(supplements, 'lisa');

  const waterEveryMinutes = intOrNull(source.waterEveryMinutes, MIN_WATER_INTERVAL_MINUTES, MAX_WATER_INTERVAL_MINUTES);
  return {
    meals: meals.map((meal, index) => ({ ...meal, id: mealIds[index] })),
    waterEveryMinutes,
    // Juomamuistutuksen ikkuna merkitsee vain, kun muistutus on päällä.
    waterFrom: waterEveryMinutes === null ? null : timeOrNull(source.waterFrom),
    waterTo: waterEveryMinutes === null ? null : timeOrNull(source.waterTo),
    supplements: supplements.map((item, index) => ({ ...item, id: supplementIds[index] })),
    lateEatingCutoff: timeOrNull(source.lateEatingCutoff)
  };
}

// ------------------------------------------------------------ toimitustapa

/**
 * Toimitustavan ohitukset aiheittain: vain tunnetut aiheet ja tunnetut
 * tavat. Oletus (DEFAULT_DELIVERY) ei tallennu tänne: tyhjä olio = kaikki
 * oletuksella.
 */
export function normalizeDelivery(value) {
  const source = isPlainObject(value) ? value : {};
  const out = {};
  for (const topic of REMINDER_TOPICS) {
    if (DELIVERIES.includes(source[topic])) out[topic] = source[topic];
  }
  return out;
}

/** Aiheen voimassa oleva toimitustapa: käyttäjän valinta tai oletus. */
export function deliveryFor(settings, topic) {
  const chosen = settings && isPlainObject(settings.delivery) ? settings.delivery[topic] : undefined;
  if (DELIVERIES.includes(chosen)) return chosen;
  return DEFAULT_DELIVERY[topic] ?? null;
}

// ------------------------------------------------------------ koko rivi

/**
 * Normalisoi asetusrivi. Ei heitä: mikä tahansa syöte tuottaa täyden,
 * kelvollisen olion. Puuttuva kenttä -> oletus.
 */
export function normalizeLifeSettings(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const base = DEFAULT_LIFE_SETTINGS;
  return {
    id: idOrNull(source.id),
    weekendWakeShiftMaxMinutes: clampInt(source.weekendWakeShiftMaxMinutes, 0, MAX_WEEKEND_SHIFT_MINUTES,
      base.weekendWakeShiftMaxMinutes),
    weekendBedShiftMaxMinutes: clampInt(source.weekendBedShiftMaxMinutes, 0, MAX_WEEKEND_SHIFT_MINUTES,
      base.weekendBedShiftMaxMinutes),
    windDownMinutes: clampInt(source.windDownMinutes, 0, MAX_WIND_DOWN_MINUTES, base.windDownMinutes),
    bedtimeTarget: timeOrNull(source.bedtimeTarget),
    arrivalBufferMinutes: clampInt(source.arrivalBufferMinutes, 0, MAX_ARRIVAL_BUFFER_MINUTES,
      base.arrivalBufferMinutes),
    guidanceStyle: oneOf(source.guidanceStyle, GUIDANCE_STYLES, base.guidanceStyle),
    speechEnabled: boolOr(source.speechEnabled, base.speechEnabled),
    morningBriefEnabled: boolOr(source.morningBriefEnabled, base.morningBriefEnabled),
    // Käyttäjän hyväksymä aikaistus. Sovellus voi EHDOTTAA, ei asettaa.
    reminderOffsetMinutes: clampInt(source.reminderOffsetMinutes, 0, MAX_REMINDER_OFFSET_MINUTES,
      base.reminderOffsetMinutes),
    digestEnabled: boolOr(source.digestEnabled, base.digestEnabled),
    digestTime: timeOrNull(source.digestTime) ?? base.digestTime,
    sleepAffectsCapacity: boolOr(source.sleepAffectsCapacity, base.sleepAffectsCapacity),
    hourlyValueMinor: intOrNull(source.hourlyValueMinor, 1, MAX_HOURLY_VALUE_MINOR),
    currency: currencyOf(source.currency),
    alarm: normalizeAlarm(source.alarm),
    morningRoutine: normalizeMorningRoutine(source.morningRoutine),
    mealRhythm: normalizeMealRhythm(source.mealRhythm),
    delivery: normalizeDelivery(source.delivery),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

/**
 * Yhdistä muutokset voimassa oleviin asetuksiin. Sisäkkäiset oliot
 * (herätys, ateriarytmi, toimitustapa) yhdistetään kentittäin, jotta
 * "herätys päälle" ei nollaa herätyksen kellonaikoja. Listat (aamurutiini,
 * ateriat) korvataan kokonaan: osittainen lista olisi arvaus.
 */
export function mergeLifeSettings(current, changes) {
  const base = normalizeLifeSettings(current);
  const patch = isPlainObject(changes) ? changes : {};
  const merged = { ...base, ...patch };
  for (const key of ['alarm', 'mealRhythm', 'delivery']) {
    if (isPlainObject(patch[key])) merged[key] = { ...base[key], ...patch[key] };
    else if (key in patch) merged[key] = base[key];
  }
  merged.id = base.id ?? idOrNull(patch.id);
  merged.createdAt = base.createdAt;
  merged.updatedAt = base.updatedAt;
  return normalizeLifeSettings(merged);
}

const jsonLength = value => {
  try { return JSON.stringify(value).length; } catch { return Infinity; }
};

/**
 * Tarkista asetukset. Normalisointi on jo kiristänyt luvut, joten tämä
 * kertoo lähinnä ristiriidoista, jotka käyttäjän on ratkaistava itse.
 */
export function validateLifeSettings(settings) {
  const errors = {};
  if (!isPlainObject(settings)) return { valid: false, errors: { settings: 'Asetuksia ei ole.' } };
  const alarm = isPlainObject(settings.alarm) ? settings.alarm : {};
  if (alarm.enabled === true && alarm.followPlan === false && !alarm.weekdayTime && !alarm.weekendTime) {
    errors.alarm = 'Valitse herätysaika tai anna päivän suunnitelman määrätä se.';
  }
  const water = isPlainObject(settings.mealRhythm) ? settings.mealRhythm : {};
  if (water.waterEveryMinutes != null && water.waterFrom && water.waterTo && water.waterFrom === water.waterTo) {
    errors.mealRhythm = 'Juomamuistutuksen alku ja loppu eivät voi olla sama kellonaika.';
  }
  if (settings.currency !== undefined && !/^[A-Z]{3}$/.test(String(settings.currency))) {
    errors.currency = 'Valuutta on kolmikirjaiminen tunnus, esim. EUR.';
  }
  if (jsonLength(settings.alarm) > MAX_ALARM_JSON_BYTES) errors.alarm = 'Herätyksen asetukset ovat liian suuret.';
  if (jsonLength(settings.morningRoutine) > MAX_MORNING_ROUTINE_JSON_BYTES) {
    errors.morningRoutine = 'Aamurutiini on liian pitkä.';
  }
  if (jsonLength(settings.mealRhythm) > MAX_MEAL_RHYTHM_JSON_BYTES) errors.mealRhythm = 'Ateriarytmi on liian pitkä.';
  if (jsonLength(settings.delivery) > MAX_DELIVERY_JSON_BYTES) errors.delivery = 'Toimitustapoja on liikaa.';
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Voimassa olevat asetukset tilan listasta (0 tai 1 riviä). Tyhjä,
 * puuttuva tai roskainen lista -> oletukset. Jos rivejä on virheen takia
 * useampi (kanta estää sen), uusin päivitetty voittaa ja tasatilanteessa
 * tunniste ratkaisee — tulos on sama joka kerta.
 */
export function effectiveLifeSettings(list) {
  const rows = (Array.isArray(list) ? list : []).filter(isPlainObject);
  if (rows.length === 0) return normalizeLifeSettings({});
  const sorted = [...rows].sort((a, b) => {
    const au = typeof a.updatedAt === 'string' ? a.updatedAt : '';
    const bu = typeof b.updatedAt === 'string' ? b.updatedAt : '';
    if (au !== bu) return au < bu ? 1 : -1;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''), 'fi');
  });
  return normalizeLifeSettings(sorted[0]);
}
