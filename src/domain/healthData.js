// Terveysmittausten laajennuskohta (sopimus, ei toteutusta).
//
// PUHDAS MODUULI: ei verkkoa, ei kelloa, ei alustaa.
//
// =====================================================================
// MITÄ TÄMÄ ON
// =====================================================================
//
// Manifestival ei ole terveyssovellus eikä mittaa mitään. Tämä moduuli
// kuvaa, MILLAISENA terveystieto voisi myöhemmin tulla sovellukseen:
//
//   - mittauslajit (paino, kehonkoostumus, leposyke, verenpaine,
//     laboratorioarvot, mitattu uni, aktiivisuus, kuntotestit)
//   - käsin syötetyn mittauksen normalisointi ja tarkistus
//   - lähteiden rajapinta (Health Connect, Apple Health, puettavat
//     laitteet), joista YKSIKÄÄN EI OLE TOTEUTETTU
//
// Tallennusta ei ole (ei taulua, ei migraatiota), eikä mikään kutsu tätä
// vielä. Kun lähde joskus kytketään, sen on palautettava täsmälleen
// `normalizeHealthMeasurement`-funktion muoto.
//
// =====================================================================
// MITATTU VAI MAHDOLLISUUS
// =====================================================================
//
// Sovellus tietää unesta vain vuoteessa olon ajan: MAHDOLLISUUDEN nukkua
// (dailyLife.SLEEP_KIND.OPPORTUNITY). Mitattu uni vaatii laitteen. Sama
// ero pätee kaikkeen: HEALTH_DATA_BASIS.MEASURED on laitteen, vaa'an tai
// laboratorion lukema; OPPORTUNITY on sovelluksen oma päättely. Niitä ei
// koskaan esitetä samana asiana.
//
// =====================================================================
// EI TULKINTAA
// =====================================================================
//
// Alueet (esim. leposyke 20–250) ovat SYÖTTÖVIRHEEN VARTIJOITA, eivät
// viitearvoja: ne hylkäävät kirjoitusvirheen (800 kg), eivät arvioi
// terveyttä. Moduuli ei luokittele arvoja eikä anna neuvoja. Rajojen
// ulkopuolista arvoa ei kiristetä rajalle — se olisi keksitty mittaus —
// vaan se on tuntematon (null).
//
// Terveystieto on arkaluonteista: ei lokiin, ei tekoälyn kontekstiin.

import { SLEEP_KIND } from './dailyLife.js';
import { isCalendarDate, clockMinutes } from './zonedClock.js';

export const HEALTH_METRIC_KIND = Object.freeze({
  WEIGHT: 'weight',
  BODY_COMPOSITION: 'body_composition',
  RESTING_HEART_RATE: 'resting_heart_rate',
  BLOOD_PRESSURE: 'blood_pressure',
  LAB_RESULT: 'lab_result',
  MEASURED_SLEEP: 'measured_sleep',
  ACTIVITY: 'activity',
  FITNESS_TEST: 'fitness_test'
});

export const HEALTH_METRIC_KINDS = Object.freeze(Object.values(HEALTH_METRIC_KIND));

const KIND_LABELS = Object.freeze({
  weight: 'Paino',
  body_composition: 'Kehonkoostumus',
  resting_heart_rate: 'Leposyke',
  blood_pressure: 'Verenpaine',
  lab_result: 'Laboratorioarvo',
  measured_sleep: 'Mitattu uni',
  activity: 'Aktiivisuus',
  fitness_test: 'Kuntotesti'
});

export function healthMetricLabel(kind) {
  return KIND_LABELS[kind] || 'Mittaus';
}

/** Tiedon perusta. Samat arvot kuin dailyLife.SLEEP_KIND, jotta käsite on yksi. */
export const HEALTH_DATA_BASIS = Object.freeze({
  MEASURED: SLEEP_KIND.MEASURED,
  OPPORTUNITY: SLEEP_KIND.OPPORTUNITY
});

const BASIS_LABELS = Object.freeze({
  [HEALTH_DATA_BASIS.MEASURED]: 'Mitattu',
  [HEALTH_DATA_BASIS.OPPORTUNITY]: 'Aikaa unelle (ei mittaus)'
});

export function healthBasisLabel(basis) {
  return BASIS_LABELS[basis] || BASIS_LABELS[HEALTH_DATA_BASIS.OPPORTUNITY];
}

/** Unikirjauksen perusta: vain laitteen mittaama uni on mitattua. */
export function sleepBasisOf(sleepLog) {
  return sleepLog && sleepLog.kind === SLEEP_KIND.MEASURED
    ? HEALTH_DATA_BASIS.MEASURED
    : HEALTH_DATA_BASIS.OPPORTUNITY;
}

/** Mistä mittaus tuli. */
export const HEALTH_SOURCE = Object.freeze({
  MANUAL: 'manual',
  HEALTH_CONNECT: 'health_connect',
  APPLE_HEALTH: 'apple_health',
  WEARABLE: 'wearable'
});

export const HEALTH_SOURCES = Object.freeze(Object.values(HEALTH_SOURCE));

export const PROVIDER_STATUS = Object.freeze({
  NOT_IMPLEMENTED: 'not_implemented'
});

/** Lähteet. YKSIKÄÄN EI OLE TOTEUTETTU. */
export const HEALTH_PROVIDERS = Object.freeze({
  [HEALTH_SOURCE.HEALTH_CONNECT]: Object.freeze({
    label: 'Health Connect', platform: 'android', status: PROVIDER_STATUS.NOT_IMPLEMENTED
  }),
  [HEALTH_SOURCE.APPLE_HEALTH]: Object.freeze({
    label: 'Apple Health', platform: 'ios', status: PROVIDER_STATUS.NOT_IMPLEMENTED
  }),
  [HEALTH_SOURCE.WEARABLE]: Object.freeze({
    label: 'Puettava laite', platform: 'any', status: PROVIDER_STATUS.NOT_IMPLEMENTED
  })
});

/**
 * Lähteen rajapinta, jonka tuleva toteutus täyttää (alustakerroksessa,
 * ei täällä). Kaikki menetelmät ovat asynkronisia ja käyttäjän
 * käynnistämiä.
 */
export const HEALTH_PROVIDER_CONTRACT = Object.freeze({
  methods: Object.freeze([
    'isAvailable(): Promise<boolean>',
    'requestPermissions(kinds: string[]): Promise<{ granted: string[] }>',
    'readMeasurements({ kinds, fromIso, toIso }): Promise<HealthMeasurement[]>'
  ]),
  rules: Object.freeze([
    'vain lukeminen: sovellus ei kirjoita terveyslähteeseen',
    'vain käyttäjän käynnistämänä: ei taustasynkronointia',
    'vain pyydetyt lajit ja aikaväli',
    'jokainen mittaus kulkee normalizeHealthMeasurement-funktion läpi',
    'tuntematon arvo jätetään pois, ei palauteta nollana',
    'ei sijaintia, ei raakavirtoja, ei laitteen tunnisteita',
    'ei lokiin eikä tekoälyn kontekstiin'
  ])
});

/** Onko jokin terveyslähde käytettävissä? Aina epätosi. */
export function hasHealthProvider() {
  return false;
}

export function healthProviderStatus(source) {
  const provider = HEALTH_PROVIDERS[source];
  if (!provider) return null;
  return Object.freeze({
    source,
    label: provider.label,
    status: provider.status,
    available: false,
    text: `${provider.label}: ei vielä käytössä. Mittauksen voi kirjata käsin.`
  });
}

// ------------------------------------------------------------ käsin syötetty mittaus

/**
 * Kenttäkohtaiset syöttövirheen rajat [min, max, tarkkuus]. EIVÄT viitearvoja.
 * `required`: kentät, joista vähintään yksi (any) tai kaikki (all) tarvitaan.
 */
const METRIC_FIELDS = Object.freeze({
  weight: Object.freeze({ numbers: { weightKg: [20, 400, 0.1] }, required: ['all', 'weightKg'] }),
  body_composition: Object.freeze({
    numbers: { bodyFatPercent: [2, 75, 0.1], muscleMassKg: [5, 200, 0.1], waterPercent: [20, 80, 0.1] },
    required: ['any', 'bodyFatPercent', 'muscleMassKg', 'waterPercent']
  }),
  resting_heart_rate: Object.freeze({ numbers: { bpm: [20, 250, 1] }, required: ['all', 'bpm'] }),
  blood_pressure: Object.freeze({
    numbers: { systolic: [50, 300, 1], diastolic: [20, 200, 1], pulse: [20, 250, 1] },
    required: ['all', 'systolic', 'diastolic']
  }),
  lab_result: Object.freeze({
    numbers: { value: [-1e6, 1e6, 0.001] }, texts: { name: 80, unit: 20, referenceText: 80 },
    required: ['all', 'name', 'value']
  }),
  measured_sleep: Object.freeze({ numbers: { minutes: [1, 1440, 1] }, required: ['all', 'minutes'] }),
  activity: Object.freeze({
    numbers: { steps: [0, 200000, 1], activeMinutes: [0, 1440, 1], distanceKm: [0, 500, 0.01] },
    required: ['any', 'steps', 'activeMinutes', 'distanceKm']
  }),
  fitness_test: Object.freeze({
    numbers: { value: [-1e6, 1e6, 0.001] }, texts: { name: 80, unit: 20 },
    required: ['all', 'name', 'value']
  })
});

const MAX_NOTE_LENGTH = 500;
const MAX_ID_LENGTH = 200;

function numberIn(value, [min, max, step]) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim().replace(',', '.')) : NaN;
  if (!Number.isFinite(n)) return null;
  // Tarkkuuteen pyöristys ENNEN rajatarkistusta, jotta tallennettu arvo ja
  // tarkistettu arvo ovat sama luku.
  const rounded = Math.round(n / step) * step;
  const clean = Number(rounded.toFixed(3));
  return clean >= min && clean <= max ? clean : null;
}

function text(value, max) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s+/g, ' ').slice(0, max);
  return cleaned === '' ? null : cleaned;
}

/**
 * Normalisoi mittaus. Ei koskaan heitä.
 *
 * @returns {Readonly<{id:string|null, kind:string|null, date:string|null, time:string|null,
 *   source:string, basis:string, values:Readonly<object>, note:string|null,
 *   createdAt:any, updatedAt:any}>}
 */
export function normalizeHealthMeasurement(input) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const kind = HEALTH_METRIC_KINDS.includes(source.kind) ? source.kind : null;
  const spec = kind ? METRIC_FIELDS[kind] : null;
  const raw = source.values !== null && typeof source.values === 'object' ? source.values : {};
  const values = {};
  if (spec) {
    for (const [field, range] of Object.entries(spec.numbers || {})) values[field] = numberIn(raw[field], range);
    for (const [field, max] of Object.entries(spec.texts || {})) values[field] = text(raw[field], max);
  }
  // Aika vain merkkijonona 'HH:MM': pelkkä luku voisi olla mitä tahansa.
  const minutes = typeof source.time === 'string' ? clockMinutes(source.time) : null;
  const id = source.id != null ? String(source.id).trim().slice(0, MAX_ID_LENGTH) : '';
  return Object.freeze({
    id: id === '' ? null : id,
    kind,
    date: isCalendarDate(source.date) ? source.date : null,
    time: minutes === null ? null : source.time.trim(),
    source: HEALTH_SOURCES.includes(source.source) ? source.source : HEALTH_SOURCE.MANUAL,
    // Käsin syötetty mittaus on käyttäjän kertoma LUKEMA (vaaka, mittari,
    // laboratorio): mitattu, ei sovelluksen päättelemä.
    basis: HEALTH_DATA_BASIS.MEASURED,
    values: Object.freeze(values),
    note: text(source.note, MAX_NOTE_LENGTH),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  });
}

/**
 * Tarkista normalisoitu (tai raaka) mittaus ennen tallennusta.
 *
 * @returns {{valid:boolean, errors:Object<string,string>}}
 */
export function validateHealthMeasurement(input) {
  const m = normalizeHealthMeasurement(input);
  const errors = {};
  if (!m.kind) errors.kind = 'Valitse mittauksen laji.';
  if (!m.date) errors.date = 'Anna päivämäärä.';
  const raw = input && typeof input === 'object' && input.time != null && input.time !== '';
  if (raw && m.time === null) errors.time = 'Anna aika muodossa HH:MM.';
  if (m.kind) {
    const spec = METRIC_FIELDS[m.kind];
    const [mode, ...fields] = spec.required;
    const present = fields.filter(field => m.values[field] !== null);
    if (mode === 'all') {
      for (const field of fields) {
        if (m.values[field] === null) errors[`values.${field}`] = 'Arvo puuttuu tai on mahdoton. Tarkista luku.';
      }
    } else if (present.length === 0) {
      errors.values = 'Anna vähintään yksi arvo.';
    }
    if (m.kind === HEALTH_METRIC_KIND.BLOOD_PRESSURE && m.values.systolic !== null && m.values.diastolic !== null
      && m.values.systolic <= m.values.diastolic) {
      errors['values.diastolic'] = 'Alapaineen pitää olla pienempi kuin yläpaineen. Tarkista järjestys.';
    }
  }
  return Object.freeze({ valid: Object.keys(errors).length === 0, errors: Object.freeze(errors) });
}
