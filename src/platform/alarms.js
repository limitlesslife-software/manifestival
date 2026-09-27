// Herätykset, puhutut muistutukset, puhe ja reitin avaus: alustasovitin.
//
// =====================================================================
// MITÄ TÄMÄ TEKEE JA MITÄ EI
// =====================================================================
//
// Android-sovelluksessa tämä puhuu omalle ManifestivalAlarm-liitännäiselle
// (android/app/src/main/java/fi/limitlesslife/manifestival/AlarmPlugin.java):
//   - herätys soi myös sovelluksen ollessa kiinni ja näyttö lukittuna
//   - puhuttu muistutus (esim. "lähde nyt") luetaan ääneen taustalla
//   - kuittaus, torkku ja "Lähdin" kirjataan laitteelle, ja sovellus lukee
//     ne consumeEvents()-kutsulla, kun se seuraavan kerran avataan
//
// Selaimessa ja PWA:ssa herätystä EI ole, eikä sitä teeskennellä: ajastin
// avoimessa välilehdessä lupaisi herätyksen, joka jää soimatta, kun
// välilehti suljetaan tai puhelin nukahtaa. Vastaus on rehellinen
// "toimii vain Android-sovelluksessa" (ALARMS_WEB_REASON).
//
// Puhe (speak) toimii selaimessa speechSynthesisillä, mutta VAIN kun sivu on
// auki; tulos kertoo sen (foregroundOnly: true).
//
// =====================================================================
// SOPIMUS LIITÄNNÄISEN KANSSA
// =====================================================================
//
// scheduleAlarms(entries) KORVAA laitteen koko herätysjoukon (sovitus, ei
// lisäys): mitä listassa ei ole, perutaan. Sama tunniste = yksi herätys.
// Merkintä: {id, kind:'wake'|'spoken'|'critical', date:'YYYY-MM-DD',
// time:'HH:MM', title, body, speech|null, mode, escalation:[{afterSeconds,
// step}], snoozeMinutes, maxSnoozes, routeDestination|null, routeMode|null,
// brief|null, briefOnDismiss}. Herätyksen briefOnDismiss: laite lukee
// aamukatsauksen KERRAN Sammuta-painalluksen jälkeen tavasta riippumatta
// (tervehdys ja kellonaika puhehetkellä + brief, jos luettavissa).
// Aika annetaan SEINÄKELLOAIKANA; laite laskee hetken omassa
// aikavyöhykkeessään ja laskee sen uudelleen, kun vyöhyke tai kello vaihtuu.
//
// Reitin kohde on aina pelkkää tekstiä. Linkin kokoaa liitännäinen (tai
// selaimessa navigationUrl tästä moduulista) -- linkkiä ei koskaan oteta
// vastaan kutsujalta.
//
// EI HEITÄ. Jokainen funktio palauttaa tuloksen ({ok:false, code, reason}),
// myös kun liitännäinen heittää tai ei vastaa (aikaraja).
//
// Arvolistat (tavat, vaiheet, rajat) ovat liitännäisen rajapinnan
// sopimus. Niiden vastineet domainissa (src/domain/dailyLife.js,
// alarmPlan.js) ovat samat; tests/platform-alarms.test.mjs pitää ne
// samoina. Alustakerros ei saa tuoda domainia (arkkitehtuurisääntö).

import {
  isNativeShell, nativeAlarmPlugin, setAlarmAccessState, PERMISSION,
  NATIVE_ALARM_PLUGIN, ALARMS_WEB_REASON
} from './capabilities.js';

export { NATIVE_ALARM_PLUGIN, ALARMS_WEB_REASON };

export const ALARM_KIND = Object.freeze({
  /** Herätys: setAlarmClock, lukitusnäkymä, Sammuta/Torku. */
  WAKE: 'wake',
  /** Puhuttu muistutus: luetaan kerran, ilmoituksessa Kuittaa/Lähdin, Torku 5 min, Avaa reitti. */
  SPOKEN: 'spoken',
  /** Kriittinen muistutus: soi kuten herätys (esim. viimeinen lähtöhetki). */
  CRITICAL: 'critical'
});

export const ALARM_KINDS = Object.freeze(Object.values(ALARM_KIND));

/** Liitännäisen hyväksymät herätystavat (= dailyLife.js ALARM_MODES). */
export const NATIVE_ALARM_MODES = Object.freeze(['alarm_sound', 'music', 'speech', 'combination']);

/** Liitännäisen hyväksymät voimistumisen vaiheet (= dailyLife.js ESCALATION_STEPS). */
export const NATIVE_ESCALATION_STEPS = Object.freeze(['soft', 'speech', 'loud', 'repeat_speech']);

/** Reitin kulkutavat (= travel.js TRAVEL_MODES). */
export const NATIVE_TRAVEL_MODES = Object.freeze(['driving', 'transit', 'walking', 'cycling', 'other']);

/** Rajat. Samat kuin AlarmMath.java:ssa ja domainissa. */
export const ALARM_LIMITS = Object.freeze({
  maxAlarms: 50,
  maxIdLength: 120,
  maxTitleLength: 200,
  maxBodyLength: 500,
  maxSpeechLength: 500,
  maxDestinationLength: 200,
  maxEscalationSteps: 4,
  maxRingSeconds: 600,
  maxSnoozeMinutes: 30,
  maxSnoozes: 3,
  defaultSnoozeMinutes: 9
});

/** Laitteen kirjaamat tapahtumat (AlarmStore.java EVENT_*). */
export const ALARM_EVENT = Object.freeze({
  DELIVERED: 'delivered',
  ACKNOWLEDGED: 'acknowledged',
  SNOOZED: 'snoozed',
  DISMISSED: 'dismissed',
  /** Käyttäjä painoi "Lähdin" lähtömuistutuksessa. */
  DEPARTED: 'departed',
  /** Herätys ei soinut (puhelin pois päältä, yli puoli tuntia myöhässä) tai jäi kuittaamatta. */
  MISSED: 'missed',
  /** Suomenkielistä puhetta ei ollut: soitettiin ääni ja näytettiin teksti. */
  SPEECH_FALLBACK: 'speech_fallback',
  /** Valittu herätysääni ei soinut: oletusääni. */
  SOUND_FALLBACK: 'sound_fallback'
});

export const ALARM_EVENTS = Object.freeze(Object.values(ALARM_EVENT));

/** Liitännäisen elävän tapahtuman nimi (AlarmPlugin.EVENT). */
export const NATIVE_ALARM_EVENT = 'alarmEvent';

/** Tavallisen liitännäiskutsun yläraja. */
export const CALL_TIMEOUT_MS = 8000;
/** Puheen yläraja (liitännäinen katkaisee itse minuutissa). */
export const SPEAK_TIMEOUT_MS = 70000;
/** Äänivalitsin odottaa käyttäjää; silti ei ikuisesti. */
export const PICK_TIMEOUT_MS = 10 * 60 * 1000;

export const SPEECH_FOREGROUND_NOTE = 'Puhe kuuluu vain, kun sovellus on auki.';

const NOT_IN_THIS_VERSION = 'Herätys ei ole käytettävissä tässä Android-sovelluksen versiossa.';

const ID_PATTERN = /^[A-Za-z0-9_:.|@#-]+$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const LANG_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$/;

// Näkymättömät ja ohjausmerkit pois, rivinvaihdot välilyönneiksi.
const LINE_BREAKS = /[\t\n\v\f\r\u{85}\u{2028}\u{2029}]/gu;
const INVISIBLE = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{AD}\u{61C}\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{206F}\u{FEFF}\u{FFF9}-\u{FFFB}]/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Kohteessa ei saa olla linkkiä tai skeemaa (sama sääntö kuin AlarmMath.sanitizeDestination).
const URL_LIKE = /([a-z][a-z0-9+.-]*:\/\/|\bwww\.)/i;
const SCHEME_LIKE = /\b(?:javascript|vbscript|data|file|blob|about|intent|content|chrome|android-app|market|google\.navigation|geo|mailto|tel|sms|ftp|wss?|https?)\s*:/i;
const MARKUP = /[<>"`\\{}|^]/;

// Osoite kootaan osista: tietoturvatesti (security-csp) etsii lähdekoodista
// absoluuttisia osoitteita, joihin sovellus ITSE ottaa yhteyttä. Tähän ei
// oteta yhteyttä; linkki annetaan käyttöjärjestelmälle avattavaksi.
const MAPS_PREFIX = `${'https:'}//${'www.google.com'}/maps/dir/?api=1&destination=`;
const WEB_TRAVEL_MODE = Object.freeze({
  driving: 'driving', transit: 'transit', walking: 'walking', cycling: 'bicycling', other: 'driving'
});

// ------------------------------------------------------------ apurit

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codePointLength(text) {
  return Array.from(text).length;
}

/** Näyttöteksti siistiksi; null, jos mitään ei jää. Ei katkaise: pituus tarkistetaan erikseen. */
function cleanText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(LONE_SURROGATE, '').normalize('NFC')
    .replace(LINE_BREAKS, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Kalenteripäivä muodossa YYYY-MM-DD; 30.2. tai 2027-02-29 eivät kelpaa (ei vieritystä). */
export function isAlarmDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

/** Kellonaika HH:MM, 00:00–23:59. */
export function isAlarmTime(value) {
  if (typeof value !== 'string') return false;
  const match = TIME_PATTERN.exec(value);
  return Boolean(match) && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

/** Tunniste: ASCII ilman välilyöntejä, 1–120 merkkiä. */
export function isAlarmId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= ALARM_LIMITS.maxIdLength
    && ID_PATTERN.test(value);
}

/**
 * Reitin kohde pelkäksi tekstiksi tai null. Linkki, skeema ("geo:",
 * "intent:") tai merkintäkielen merkit -> null (hylätään, ei arvata).
 */
export function cleanDestination(value) {
  const text = cleanText(value);
  if (!text || codePointLength(text) > ALARM_LIMITS.maxDestinationLength) return null;
  if (URL_LIKE.test(text) || SCHEME_LIKE.test(text) || MARKUP.test(text)) return null;
  return text;
}

/**
 * Selaimen varavaihtoehto: reittiohjeen https-linkki Google Mapsiin, koottu
 * tässä kiinteästä alusta ja koodatusta tekstistä. Sama muoto kuin
 * src/domain/navigationLink.js googleMapsUrl (testi vertaa). null, jos
 * kohde ei kelpaa.
 */
export function navigationUrl(destination, mode = 'driving') {
  const text = cleanDestination(destination);
  if (!text) return null;
  // Vain omat avaimet: "constructor" tai "__proto__" ei saa päätyä linkkiin.
  const travel = NATIVE_TRAVEL_MODES.includes(mode) ? WEB_TRAVEL_MODE[mode] : WEB_TRAVEL_MODE.driving;
  return `${MAPS_PREFIX}${encodeURIComponent(text)}&travelmode=${travel}`;
}

// ------------------------------------------------------------ tarkistus

/**
 * Yksi herätysmerkintä liitännäisen sopimusta vasten.
 *
 * Tiukka: väärä muoto on ohjelmointivirhe, ja se hylätään selvällä syyllä
 * eikä korjata hiljaa. Puuttuvat valinnaiset kentät saavat oletuksen
 * (tapa alarm_sound, torkku 9 min, 3 torkkua, oletusvoimistuminen).
 *
 * @returns {{valid:boolean, errors:Object<string,string>, entry:object|null}}
 */
export function validateAlarmEntry(input) {
  try {
    return validateEntryUnsafe(input);
  } catch {
    // Esim. heittävä getter: hylätään, ei kaadeta kutsujaa.
    return Object.freeze({
      valid: false, errors: Object.freeze({ entry: 'Herätyksen tiedot ovat virheelliset.' }), entry: null
    });
  }
}

function validateEntryUnsafe(input) {
  const errors = {};
  const source = isObject(input) ? input : {};
  if (!isObject(input)) errors.entry = 'Herätyksen tiedot puuttuvat.';

  if (!isAlarmId(source.id)) errors.id = 'Herätyksen tunniste puuttuu tai on virheellinen.';
  if (!ALARM_KINDS.includes(source.kind)) errors.kind = 'Herätyksen laji on tuntematon.';
  if (!isAlarmDate(source.date)) errors.date = 'Päivämäärä on virheellinen.';
  if (!isAlarmTime(source.time)) errors.time = 'Kellonaika on virheellinen.';

  const title = cleanText(source.title);
  if (!title) errors.title = 'Herätykselle tarvitaan nimi.';
  else if (codePointLength(title) > ALARM_LIMITS.maxTitleLength) {
    errors.title = `Nimi voi olla enintään ${ALARM_LIMITS.maxTitleLength} merkkiä.`;
  }

  const body = source.body === undefined || source.body === null ? null : cleanText(source.body);
  if (source.body !== undefined && source.body !== null && typeof source.body !== 'string') {
    errors.body = 'Lisäteksti on virheellinen.';
  } else if (body && codePointLength(body) > ALARM_LIMITS.maxBodyLength) {
    errors.body = `Lisäteksti voi olla enintään ${ALARM_LIMITS.maxBodyLength} merkkiä.`;
  }

  const speech = source.speech === undefined || source.speech === null ? null : cleanText(source.speech);
  if (source.speech !== undefined && source.speech !== null && typeof source.speech !== 'string') {
    errors.speech = 'Puhuttava teksti on virheellinen.';
  } else if (speech && codePointLength(speech) > ALARM_LIMITS.maxSpeechLength) {
    errors.speech = `Puhuttava teksti voi olla enintään ${ALARM_LIMITS.maxSpeechLength} merkkiä.`;
  }

  // Aamukatsaus sammutuksen jälkeen: loppuosan teksti ja lippu (vain herätykselle).
  const brief = source.brief === undefined || source.brief === null ? null : cleanText(source.brief);
  if (source.brief !== undefined && source.brief !== null && typeof source.brief !== 'string') {
    errors.brief = 'Aamukatsauksen teksti on virheellinen.';
  } else if (brief && codePointLength(brief) > ALARM_LIMITS.maxSpeechLength) {
    errors.brief = `Aamukatsaus voi olla enintään ${ALARM_LIMITS.maxSpeechLength} merkkiä.`;
  }
  const briefOnDismiss = source.briefOnDismiss === undefined || source.briefOnDismiss === null
    ? false : source.briefOnDismiss;
  if (typeof briefOnDismiss !== 'boolean') errors.briefOnDismiss = 'Aamukatsauksen valinta on virheellinen.';
  else if (briefOnDismiss && source.kind !== ALARM_KIND.WAKE) errors.briefOnDismiss = 'Aamukatsaus kuuluu vain herätykseen.';

  const mode = source.mode === undefined || source.mode === null ? 'alarm_sound' : source.mode;
  if (!NATIVE_ALARM_MODES.includes(mode)) errors.mode = 'Herätyksen tapa on tuntematon.';

  const escalation = [];
  if (source.escalation !== undefined && source.escalation !== null) {
    if (!Array.isArray(source.escalation)) {
      errors.escalation = 'Voimistuvan herätyksen vaiheet ovat virheelliset.';
    } else if (source.escalation.length > ALARM_LIMITS.maxEscalationSteps) {
      errors.escalation = `Herätyksessä voi olla enintään ${ALARM_LIMITS.maxEscalationSteps} vaihetta.`;
    } else {
      let previous = -1;
      for (const step of source.escalation) {
        if (!isObject(step) || !NATIVE_ESCALATION_STEPS.includes(step.step)) {
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
        if (step.afterSeconds >= ALARM_LIMITS.maxRingSeconds) {
          errors.escalation = 'Herätys soi enintään 10 minuuttia, joten jokaisen vaiheen pitää alkaa sitä ennen.';
          break;
        }
        previous = step.afterSeconds;
        escalation.push(Object.freeze({ afterSeconds: step.afterSeconds, step: step.step }));
      }
    }
  }

  const snoozeMinutes = source.snoozeMinutes === undefined || source.snoozeMinutes === null
    ? ALARM_LIMITS.defaultSnoozeMinutes : source.snoozeMinutes;
  if (!Number.isInteger(snoozeMinutes) || snoozeMinutes < 1 || snoozeMinutes > ALARM_LIMITS.maxSnoozeMinutes) {
    errors.snoozeMinutes = `Torkun pituus on 1–${ALARM_LIMITS.maxSnoozeMinutes} minuuttia.`;
  }
  const maxSnoozes = source.maxSnoozes === undefined || source.maxSnoozes === null
    ? ALARM_LIMITS.maxSnoozes : source.maxSnoozes;
  if (!Number.isInteger(maxSnoozes) || maxSnoozes < 0 || maxSnoozes > ALARM_LIMITS.maxSnoozes) {
    errors.maxSnoozes = `Torkkuja voi olla 0–${ALARM_LIMITS.maxSnoozes}.`;
  }

  let routeDestination = null;
  if (source.routeDestination !== undefined && source.routeDestination !== null) {
    routeDestination = cleanDestination(source.routeDestination);
    if (!routeDestination) errors.routeDestination = 'Reitin kohde on paikan nimi tai osoite, ei linkki.';
  }
  const routeMode = source.routeMode === undefined || source.routeMode === null ? null : source.routeMode;
  if (routeMode !== null && !NATIVE_TRAVEL_MODES.includes(routeMode)) errors.routeMode = 'Kulkutapa on tuntematon.';

  const valid = Object.keys(errors).length === 0;
  const entry = valid
    ? Object.freeze({
      id: source.id,
      kind: source.kind,
      date: source.date,
      time: source.time,
      title,
      body: body || null,
      speech: speech || null,
      mode,
      escalation: Object.freeze(escalation),
      snoozeMinutes,
      maxSnoozes,
      routeDestination,
      routeMode,
      brief: brief || null,
      briefOnDismiss: briefOnDismiss === true
    })
    : null;
  return Object.freeze({ valid, errors: Object.freeze(errors), entry });
}

function safeId(input) {
  try {
    return isObject(input) && typeof input.id === 'string' ? input.id : null;
  } catch {
    return null;
  }
}

/**
 * Koko joukko liitännäiselle: kelvolliset (ensimmäinen samalla
 * tunnisteella voittaa, enintään maxAlarms) ja hylätyt syineen.
 * Deterministinen, ei muuta syötettä.
 */
export function prepareAlarms(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const input of list) {
    const result = validateAlarmEntry(input);
    const id = result.valid ? result.entry.id : safeId(input);
    if (!result.valid) {
      rejected.push(Object.freeze({ id, errors: result.errors }));
      continue;
    }
    if (seen.has(result.entry.id)) {
      rejected.push(Object.freeze({ id, errors: Object.freeze({ id: 'Sama tunniste on jo mukana.' }) }));
      continue;
    }
    if (accepted.length >= ALARM_LIMITS.maxAlarms) {
      rejected.push(Object.freeze({ id, errors: Object.freeze({ entry: 'Liian monta herätystä kerralla.' }) }));
      continue;
    }
    seen.add(result.entry.id);
    accepted.push(result.entry);
  }
  return Object.freeze({ accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) });
}

// ------------------------------------------------------------ liitännäiskutsu

const TIMEOUT = Symbol('timeout');

/**
 * Kutsu liitännäisen metodia rajatusti. Ei heitä: {ok:true, value} tai
 * {ok:false, code: unavailable | timeout | failed}.
 */
async function callPlugin(plugin, method, args, timeoutMs = CALL_TIMEOUT_MS) {
  if (!plugin || typeof plugin[method] !== 'function') return { ok: false, code: 'unavailable' };
  let timer = null;
  try {
    const call = Promise.resolve().then(() => (args === undefined ? plugin[method]() : plugin[method](args)));
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });
    const value = await Promise.race([call, timeout]);
    if (value === TIMEOUT) return { ok: false, code: 'timeout' };
    return { ok: true, value: isObject(value) ? value : {} };
  } catch {
    return { ok: false, code: 'failed' };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function unsupported(extra = {}) {
  return Object.freeze({
    ok: false,
    supported: false,
    reason: isNativeShell() ? NOT_IN_THIS_VERSION : ALARMS_WEB_REASON,
    ...extra
  });
}

function stringList(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function reasonList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map(item => Object.freeze({
      id: typeof item.id === 'string' ? item.id : null,
      code: typeof item.code === 'string' ? item.code : 'unknown'
    }));
}

// ------------------------------------------------------------ tila

/** Onko herätys, joka soi sovelluksen ollessa kiinni, mahdollinen tällä alustalla. */
export function supportsBackgroundAlarms() {
  return nativeAlarmPlugin() !== null;
}

/**
 * Laitteen tila: tarkat herätykset, koko näytön ilmoitus, ilmoitukset,
 * suomenkielinen puhe. EI pyydä lupia. Päivittää kyvykkyysrekisterin.
 */
export async function alarmStatus() {
  const plugin = nativeAlarmPlugin();
  if (!plugin) {
    return Object.freeze({
      supported: false, implemented: false, reason: isNativeShell() ? NOT_IN_THIS_VERSION : ALARMS_WEB_REASON,
      exact: false, fullScreen: false, notifications: false, tts: 'unknown', soundPicked: false,
      musicPicked: false, musicName: null, musicLost: false, scheduled: 0, ringing: false, batteryOptimized: null
    });
  }
  const result = await callPlugin(plugin, 'status');
  if (!result.ok) {
    return Object.freeze({
      supported: true, implemented: true, reason: 'Herätyksen tilaa ei saatu luettua.', code: result.code,
      exact: false, fullScreen: false, notifications: false, tts: 'unknown', soundPicked: false,
      musicPicked: false, musicName: null, musicLost: false, scheduled: 0, ringing: false, batteryOptimized: null
    });
  }
  const value = result.value;
  const exact = value.exact === true;
  const notifications = value.notifications === true;
  setAlarmAccessState(exact && notifications ? PERMISSION.GRANTED : PERMISSION.DENIED);
  return Object.freeze({
    supported: true,
    implemented: true,
    reason: '',
    exact,
    exactSettingsAvailable: value.exactSettingsAvailable === true,
    fullScreen: value.fullScreen === true,
    fullScreenSettingsAvailable: value.fullScreenSettingsAvailable === true,
    notifications,
    tts: ['available', 'missing'].includes(value.tts) ? value.tts : 'unknown',
    soundPicked: value.soundPicked === true,
    // Oma herätysmusiikki (pickAlarmMusic): valittu ja tiedoston nimi (vain näyttöteksti).
    // Laite kertoo valituksi vain, jos pysyvä lukuoikeus on yhä voimassa;
    // musicLost = valittu musiikki ei ole enää käytettävissä (soi herätysääni).
    musicPicked: value.musicPicked === true,
    musicName: value.musicPicked === true ? displayName(value.musicName) : null,
    musicLost: value.musicPicked !== true && value.musicLost === true,
    scheduled: Number.isInteger(value.scheduled) && value.scheduled >= 0 ? value.scheduled : 0,
    ringing: value.ringing === true,
    batteryOptimized: typeof value.batteryOptimized === 'boolean' ? value.batteryOptimized : null,
    sdk: Number.isInteger(value.sdk) ? value.sdk : null
  });
}

// ------------------------------------------------------------ ajastus

/**
 * Korvaa laitteen herätysjoukko näillä. Virheelliset merkinnät hylätään
 * yksitellen (rejected), muut ajastetaan. Selaimessa ei ajasteta mitään.
 *
 * @returns {Promise<{ok, supported, scheduled, requested, exact, inexact, dropped, rejected, reason?, code?}>}
 */
export async function scheduleAlarms(entries, options) {
  const timeoutMs = isObject(options) && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : CALL_TIMEOUT_MS;
  const list = Array.isArray(entries) ? entries : [];
  let prepared;
  try {
    prepared = prepareAlarms(list);
  } catch {
    // Rikkinäinen taulukko (heittävä indeksi tms.): ei kosketa laitteen herätyksiin.
    return Object.freeze({
      ok: false, supported: supportsBackgroundAlarms(), requested: 0, scheduled: 0, exact: false,
      inexact: Object.freeze([]), dropped: Object.freeze([]), rejected: Object.freeze([]), code: 'invalid',
      reason: 'Herätysten tiedot ovat virheelliset.'
    });
  }
  const { accepted, rejected } = prepared;
  const base = { requested: list.length, scheduled: 0, exact: false, inexact: Object.freeze([]), dropped: Object.freeze([]), rejected };
  const plugin = nativeAlarmPlugin();
  if (!plugin) return unsupported(base);

  const result = await callPlugin(plugin, 'schedule', { alarms: accepted }, timeoutMs);
  if (!result.ok) {
    return Object.freeze({ ...base, ok: false, supported: true, code: result.code, reason: 'Herätyksiä ei saatu ajastettua.' });
  }
  const value = result.value;
  const inexact = Object.freeze(stringList(value.inexact));
  return Object.freeze({
    ok: value.ok !== false,
    supported: true,
    requested: list.length,
    scheduled: Number.isInteger(value.scheduled) && value.scheduled >= 0 ? value.scheduled : 0,
    exact: value.exact === true && inexact.length === 0,
    inexact,
    dropped: Object.freeze(reasonList(value.dropped)),
    rejected: Object.freeze([...rejected, ...reasonList(value.rejected).map(item => Object.freeze({
      id: item.id, errors: Object.freeze({ entry: `Laite hylkäsi herätyksen (${item.code}).` })
    }))])
  });
}

/** Peru annetut herätykset (ja pysäytä, jos jokin soi). */
export async function cancelAlarms(ids) {
  const list = stringList(ids).filter(isAlarmId);
  const plugin = nativeAlarmPlugin();
  if (!plugin) return unsupported({ removed: 0 });
  const result = await callPlugin(plugin, 'cancel', { ids: list });
  if (!result.ok) return Object.freeze({ ok: false, supported: true, removed: 0, code: result.code });
  return Object.freeze({
    ok: true, supported: true,
    removed: Number.isInteger(result.value.removed) ? result.value.removed : 0
  });
}

/**
 * Peru kaikki: ajastukset, laitteen tapahtumajono ja muistutusilmoitukset.
 * Uloskirjautuminen ja tilin poisto. Selaimessa ei ole mitään peruttavaa.
 */
export async function cancelAllAlarms() {
  seenSeq.clear();
  seenOrder.length = 0;
  const plugin = nativeAlarmPlugin();
  if (!plugin) return Object.freeze({ ok: true, supported: false, removed: 0 });
  const result = await callPlugin(plugin, 'cancelAll');
  if (!result.ok) return Object.freeze({ ok: false, supported: true, removed: 0, code: result.code });
  return Object.freeze({
    ok: true, supported: true,
    removed: Number.isInteger(result.value.removed) ? result.value.removed : 0
  });
}

/** Laitteella ajastettuna olevat herätykset. */
export async function listAlarms() {
  const plugin = nativeAlarmPlugin();
  if (!plugin) return unsupported({ alarms: Object.freeze([]) });
  const result = await callPlugin(plugin, 'list');
  if (!result.ok) return Object.freeze({ ok: false, supported: true, alarms: Object.freeze([]), code: result.code });
  const alarms = (Array.isArray(result.value.alarms) ? result.value.alarms : [])
    .filter(item => isObject(item) && isAlarmId(item.id))
    .map(item => Object.freeze({
      id: item.id,
      kind: ALARM_KINDS.includes(item.kind) ? item.kind : null,
      date: isAlarmDate(item.date) ? item.date : null,
      time: isAlarmTime(item.time) ? item.time : null,
      title: typeof item.title === 'string' ? item.title : '',
      atMs: Number.isFinite(item.atMs) ? item.atMs : null,
      exact: item.exact === true,
      snoozeCount: Number.isInteger(item.snoozeCount) ? item.snoozeCount : 0,
      snoozedUntilMs: Number.isFinite(item.snoozedUntilMs) ? item.snoozedUntilMs : null
    }));
  return Object.freeze({ ok: true, supported: true, alarms: Object.freeze(alarms) });
}

// ------------------------------------------------------------ asetukset (vain napautuksesta)

/** Avaa "Herätykset ja muistutukset" -asetus. VAIN käyttäjän napautuksesta. */
export async function openExactAlarmSettings() {
  const plugin = nativeAlarmPlugin();
  if (!plugin) return unsupported();
  const result = await callPlugin(plugin, 'openExactAlarmSettings');
  return Object.freeze({
    ok: result.ok && result.value.ok !== false, supported: true,
    notNeeded: result.ok && result.value.notNeeded === true
  });
}

/** Avaa koko näytön ilmoitusten asetus (Android 14+). VAIN käyttäjän napautuksesta. */
export async function openFullScreenSettings() {
  const plugin = nativeAlarmPlugin();
  if (!plugin) return unsupported();
  const result = await callPlugin(plugin, 'openFullScreenSettings');
  return Object.freeze({
    ok: result.ok && result.value.ok !== false, supported: true,
    notNeeded: result.ok && result.value.notNeeded === true
  });
}

/** Laitteen antama nimi näyttötekstiksi (rajattu), tai null. */
function displayName(value) {
  const text = cleanText(value);
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length <= ALARM_LIMITS.maxTitleLength ? text : chars.slice(0, ALARM_LIMITS.maxTitleLength).join('');
}

/**
 * Oma herätysmusiikki järjestelmän tiedostovalitsimella (Android:
 * ACTION_OPEN_DOCUMENT audio/*, pysyvä lukuoikeus vain valittuun
 * tiedostoon, EI tallennustilan lupaa). Soi tavoilla "Oma musiikki" ja
 * "Ääni ja puhe"; jos tiedosto ei ole luettavissa (poistettu, puhelin
 * käynnistetty eikä vielä avattu), soi herätysääni. VAIN käyttäjän napautuksesta.
 *
 * @returns {Promise<{ok, supported, picked, title, code}>} code: cancelled |
 *   not-persistable | unsupported | unavailable | timeout | failed
 */
export async function pickAlarmMusic() {
  const plugin = nativeAlarmPlugin();
  if (!plugin) return unsupported({ picked: false, title: null, code: 'unsupported' });
  const result = await callPlugin(plugin, 'pickAlarmMusic', undefined, PICK_TIMEOUT_MS);
  if (!result.ok) return Object.freeze({ ok: false, supported: true, picked: false, title: null, code: result.code });
  const value = result.value;
  const ok = value.ok === true;
  return Object.freeze({
    ok,
    supported: true,
    picked: ok && value.picked === true,
    title: ok ? displayName(value.title) : null,
    code: ok ? null : (typeof value.code === 'string' ? value.code : 'unknown')
  });
}

/** Järjestelmän herätysäänivalitsin. VAIN käyttäjän napautuksesta. */
export async function pickAlarmSound() {
  const plugin = nativeAlarmPlugin();
  if (!plugin) return unsupported();
  const result = await callPlugin(plugin, 'pickAlarmSound', undefined, PICK_TIMEOUT_MS);
  if (!result.ok) return Object.freeze({ ok: false, supported: true, code: result.code });
  const value = result.value;
  return Object.freeze({
    ok: value.ok === true,
    supported: true,
    picked: value.picked === true,
    title: typeof value.title === 'string' ? value.title : null,
    code: typeof value.code === 'string' ? value.code : null
  });
}

// ------------------------------------------------------------ puhe

/** Selaimen käynnissä olevan puheen lopetusfunktio (finish), tai null. */
let webUtterance = null;

/**
 * Puhu teksti nyt. Android-sovelluksessa laitteen puhe (TextToSpeech);
 * selaimessa speechSynthesis VAIN sivun ollessa auki (foregroundOnly).
 *
 * @returns {Promise<{ok:boolean, backend:'native'|'web'|'none', foregroundOnly:boolean, code?:string, note?:string}>}
 */
export async function speak(text, options) {
  const lang = isObject(options) ? options.lang : undefined;
  const clean = cleanText(text);
  const language = typeof lang === 'string' && LANG_PATTERN.test(lang) ? lang : 'fi-FI';
  if (!clean || codePointLength(clean) > ALARM_LIMITS.maxSpeechLength) {
    return Object.freeze({ ok: false, backend: 'none', foregroundOnly: true, code: 'invalid' });
  }
  const plugin = nativeAlarmPlugin();
  if (plugin) {
    const result = await callPlugin(plugin, 'speak', { text: clean, lang: language }, SPEAK_TIMEOUT_MS);
    if (!result.ok) return Object.freeze({ ok: false, backend: 'native', foregroundOnly: false, code: result.code });
    return Object.freeze({
      ok: result.value.ok === true,
      backend: 'native',
      foregroundOnly: false,
      code: result.value.ok === true ? null : (typeof result.value.code === 'string' ? result.value.code : 'unknown')
    });
  }
  return speakWeb(clean, language);
}

function webSpeech() {
  const synth = globalThis.speechSynthesis;
  const Utterance = globalThis.SpeechSynthesisUtterance;
  if (isNativeShell() || !synth || typeof synth.speak !== 'function' || typeof Utterance !== 'function') return null;
  return { synth, Utterance };
}

function speakWeb(text, lang) {
  const api = webSpeech();
  if (!api) {
    return Promise.resolve(Object.freeze({
      ok: false, backend: 'none', foregroundOnly: true, code: 'unsupported',
      note: 'Puhe ei ole käytettävissä tällä laitteella.'
    }));
  }
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = (ok, code) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (webUtterance === finish) webUtterance = null;
      resolve(Object.freeze({
        ok, backend: 'web', foregroundOnly: true, code: ok ? null : code, note: SPEECH_FOREGROUND_NOTE
      }));
    };
    try {
      // Edellinen puhe katkeaa: sen lupaus ratkeaa koodilla "stopped".
      if (typeof webUtterance === 'function') webUtterance(false, 'stopped');
      const utterance = new api.Utterance(text);
      utterance.lang = lang;
      utterance.onend = () => finish(true, null);
      utterance.onerror = () => finish(false, 'failed');
      webUtterance = finish;
      timer = setTimeout(() => finish(false, 'timeout'), SPEAK_TIMEOUT_MS);
      api.synth.cancel();
      api.synth.speak(utterance);
    } catch {
      finish(false, 'failed');
    }
  });
}

/** Lopeta puhe. */
export async function stopSpeaking() {
  const plugin = nativeAlarmPlugin();
  if (plugin) {
    const result = await callPlugin(plugin, 'stopSpeaking');
    return Object.freeze({ ok: result.ok });
  }
  const api = webSpeech();
  if (!api) return Object.freeze({ ok: false });
  try {
    // Ensin oma lopetus: selaimen cancel voi laukaista onend-tapahtuman,
    // jolloin keskeytetty puhe näyttäisi onnistuneelta.
    if (typeof webUtterance === 'function') webUtterance(false, 'stopped');
    api.synth.cancel();
    return Object.freeze({ ok: true });
  } catch {
    return Object.freeze({ ok: false });
  }
}

// ------------------------------------------------------------ reitti

/**
 * Avaa reitti. Android: liitännäinen avaa Google Mapsin navigoinnin (tai
 * https-reittiohjeen). Selain: palauttaa sallitun https-linkin, jonka
 * kutsuja avaa (esim. <a target="_blank" rel="noopener">) -- tämä moduuli
 * ei avaa ikkunoita.
 *
 * @returns {Promise<{ok, backend:'native'|'web', opened:boolean, url:string|null, target?:string, code?:string}>}
 */
export async function openNavigation(target) {
  const destination = isObject(target) ? target.destination : undefined;
  const mode = isObject(target) ? target.mode : undefined;
  const text = cleanDestination(destination);
  const travel = NATIVE_TRAVEL_MODES.includes(mode) ? mode : 'driving';
  const plugin = nativeAlarmPlugin();
  if (!text) {
    return Object.freeze({ ok: false, backend: plugin ? 'native' : 'web', opened: false, url: null, code: 'invalid' });
  }
  if (plugin) {
    const result = await callPlugin(plugin, 'openNavigation', { destination: text, mode: travel });
    if (!result.ok) return Object.freeze({ ok: false, backend: 'native', opened: false, url: null, code: result.code });
    const ok = result.value.ok === true;
    return Object.freeze({
      ok,
      backend: 'native',
      opened: ok,
      url: null,
      target: typeof result.value.target === 'string' ? result.value.target : null,
      code: ok ? null : (typeof result.value.code === 'string' ? result.value.code : 'unknown')
    });
  }
  const url = navigationUrl(text, travel);
  return Object.freeze({ ok: Boolean(url), backend: 'web', opened: false, url, code: url ? null : 'invalid' });
}

// ------------------------------------------------------------ tapahtumat

/** Jo nähdyt tapahtumat (seq): sama tapahtuma voi tulla suoraan ja jonosta. Rajattu. */
const seenSeq = new Set();
const seenOrder = [];
const MAX_SEEN = 500;

function remember(seq) {
  if (seenSeq.has(seq)) return false;
  seenSeq.add(seq);
  seenOrder.push(seq);
  while (seenOrder.length > MAX_SEEN) seenSeq.delete(seenOrder.shift());
  return true;
}

/**
 * Laitteen tapahtuma käyttökelpoiseksi tai null. Tuntematon laji,
 * virheellinen tunniste tai aikaleima -> null. Ei otsikoita: vain tunniste.
 */
export function normalizeAlarmEvent(raw) {
  if (!isObject(raw)) return null;
  if (!ALARM_EVENTS.includes(raw.type) || !isAlarmId(raw.id)) return null;
  if (!Number.isFinite(raw.atMs) || raw.atMs < 0) return null;
  if (!Number.isInteger(raw.seq) || raw.seq < 1) return null;
  const untilMs = Number.isFinite(raw.untilMs) && raw.untilMs > raw.atMs ? raw.untilMs : null;
  if (raw.type === ALARM_EVENT.SNOOZED && untilMs === null) return null;
  return Object.freeze({
    seq: raw.seq,
    type: raw.type,
    id: raw.id,
    kind: ALARM_KINDS.includes(raw.kind) ? raw.kind : null,
    atMs: raw.atMs,
    untilMs,
    auto: raw.auto === true,
    fallback: typeof raw.fallback === 'string' ? raw.fallback : null,
    code: typeof raw.code === 'string' ? raw.code : null
  });
}

/**
 * Lue ja tyhjennä laitteen tapahtumajono (kirjattu, kun sovellus oli
 * kiinni). Jo nähdyt (onEvent) suodatetaan. Järjestys: seq.
 */
export async function consumeEvents() {
  const plugin = nativeAlarmPlugin();
  if (!plugin) return unsupported({ events: Object.freeze([]) });
  const result = await callPlugin(plugin, 'consumeEvents');
  if (!result.ok) return Object.freeze({ ok: false, supported: true, events: Object.freeze([]), code: result.code });
  const events = (Array.isArray(result.value.events) ? result.value.events : [])
    .map(normalizeAlarmEvent)
    .filter(Boolean)
    .sort((a, b) => a.seq - b.seq)
    .filter(event => remember(event.seq));
  return Object.freeze({ ok: true, supported: true, events: Object.freeze(events) });
}

/**
 * Kuuntele tapahtumia sovelluksen ollessa auki. Palauttaa lopetusfunktion.
 * Selaimessa ei tapahtumia (lopetus ei tee mitään).
 *
 * Käsitelty tapahtuma kuitataan laitteelle (ackEvents): laite pitää jokaisen
 * tapahtuman jonossa, eikä muistissa oleva seenSeq säily sovelluksen
 * uudelleenkäynnistyksen yli. Ilman kuittausta consumeEvents antaisi saman
 * kuittauksen tai "Lähdin"-tapahtuman seuraavassa istunnossa toiseen kertaan.
 */
export function onEvent(callback) {
  const plugin = nativeAlarmPlugin();
  if (!plugin || typeof callback !== 'function' || typeof plugin.addListener !== 'function') return () => {};
  let handle = null;
  let removed = false;
  const listener = raw => {
    const event = normalizeAlarmEvent(raw);
    if (!event) return;
    if (remember(event.seq)) {
      try {
        callback(event);
      } catch {
        // Kuuntelijan virhe ei saa katkaista muita tapahtumia. Ei kuittausta:
        // laitteen jono antaa tapahtuman seuraavassa käynnistyksessä.
        return;
      }
    }
    // Käsitelty (tai jo nähty): pois laitteen jonosta. Ei odoteta, ei heitä.
    callPlugin(plugin, 'ackEvents', { seqs: [event.seq] });
  };
  try {
    const registration = plugin.addListener(NATIVE_ALARM_EVENT, listener);
    Promise.resolve(registration).then(value => {
      handle = value;
      if (removed && handle && typeof handle.remove === 'function') handle.remove();
    }).catch(() => {});
  } catch {
    return () => {};
  }
  return () => {
    removed = true;
    try {
      if (handle && typeof handle.remove === 'function') handle.remove();
    } catch {
      // jo poistettu
    }
  };
}

/** Testit: nollaa muistissa oleva tila. */
export function resetAlarmsForTests() {
  seenSeq.clear();
  seenOrder.length = 0;
  webUtterance = null;
}
