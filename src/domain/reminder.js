// Muistutusmoottori.
//
// =====================================================================
// MUISTUTUS EI OLE AIKALEIMA
// =====================================================================
//
// Olemassa oleva `src/domain/notification.js` vastaa kysymykseen
// "mitä ilmoituksia tästä päivästä syntyy". Se on suunnittelija: se
// laskee aikomukset päivän suunnitelmasta ja unohtaa ne.
//
// Muistutus on eri asia. Sillä on ELINKAARI:
//
//   ajastettu -> erääntynyt -> toimitettu -> kuitattu
//                     |             |
//                     |             +-> torkutettu -> takaisin ajastetuksi
//                     +-> vanhentunut
//
// Se muistaa, kuitattiinko se, ja se osaa palata. Ilman elinkaarta
// "muistuta uudelleen jos en ole tehnyt" olisi mahdoton toteuttaa.
//
// =====================================================================
// TORKKU EI SIIRRÄ MÄÄRÄPÄIVÄÄ
// =====================================================================
//
// Tämä on koko moduulin tärkein sääntö. Torkku siirtää MUISTUTUSTA, ei
// tehtävää. Jos torkku siirtäisi määräpäivän, käyttäjä voisi torkuttaa
// laskun eräpäivän ohi kolmella painalluksella eikä mikään kertoisi
// sitä.
//
// Muistutus viittaa kohteeseen. Se ei omista sitä.
//
// =====================================================================
// TOISTETTU ARVIOINTI EI SAA TUOTTAA KAKSOISKAPPALEITA
// =====================================================================
//
// Taustatarkistus ajetaan monta kertaa päivässä ja sovelluksen
// jokaisella avauksella. Jos arviointi loisi uuden hälytyksen joka
// kerta, käyttäjä saisi saman muistutuksen kymmenen kertaa.
//
// Siksi jokaisella hälytyksellä on DETERMINISTINEN AVAIN
// (`occurrenceKey`): sama muistutus, sama porras, sama minuutti ->
// sama avain. Kahdesti luotu on kerran näytetty.

import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes, MAX_TITLE_LENGTH }
  from './task.js';
import { fmtISO, parseISO, addDays } from '../lib/datetime.js';

/** Muistutuksen elinkaaren tila. */
export const REMINDER_STATUS = Object.freeze({
  /** Odottaa hetkeään. */
  SCHEDULED: 'scheduled',
  /** Hetki on tullut, ei vielä toimitettu. */
  DUE: 'due',
  /** Näytetty käyttäjälle. */
  DELIVERED: 'delivered',
  /** Käyttäjä kuittasi nähneensä. EI sama kuin tehty. */
  ACKNOWLEDGED: 'acknowledged',
  /** Siirretty myöhemmäksi. Palaa ajastetuksi. */
  SNOOZED: 'snoozed',
  /** Kohde on tehty. Päätetila. */
  COMPLETED: 'completed',
  /** Aika meni ohi eikä mitään tapahtunut. Päätetila. */
  EXPIRED: 'expired',
  /** Peruttu. Päätetila. */
  CANCELLED: 'cancelled'
});

export const REMINDER_STATUSES = Object.freeze(Object.values(REMINDER_STATUS));

/** Tilat, joissa muistutus voi vielä hälyttää. */
export const LIVE_STATUSES = Object.freeze([
  REMINDER_STATUS.SCHEDULED, REMINDER_STATUS.DUE,
  REMINDER_STATUS.DELIVERED, REMINDER_STATUS.SNOOZED
]);

const STATUS_LABELS = Object.freeze({
  [REMINDER_STATUS.SCHEDULED]: 'Ajastettu',
  [REMINDER_STATUS.DUE]: 'Erääntynyt',
  [REMINDER_STATUS.DELIVERED]: 'Näytetty',
  [REMINDER_STATUS.ACKNOWLEDGED]: 'Kuitattu',
  [REMINDER_STATUS.SNOOZED]: 'Torkutettu',
  [REMINDER_STATUS.COMPLETED]: 'Tehty',
  [REMINDER_STATUS.EXPIRED]: 'Vanhentunut',
  [REMINDER_STATUS.CANCELLED]: 'Peruttu'
});

export function reminderStatusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS[REMINDER_STATUS.SCHEDULED];
}

/** Mihin muistutus viittaa. EI vierasavain — ks. tiedoston alku. */
export const REMINDER_TARGET = Object.freeze({
  TASK: 'task',
  ROUTINE: 'routine',
  BILL: 'bill',
  MILESTONE: 'milestone',
  GOAL: 'goal',
  /** Matkalle lähtö. Ks. src/domain/travel.js. */
  TRAVEL: 'travel',
  /** Vapaa muistutus ilman kohdetta. */
  STANDALONE: 'standalone'
});

export const REMINDER_TARGETS = Object.freeze(Object.values(REMINDER_TARGET));

/** Mikä laukaisee muistutuksen. */
export const TRIGGER = Object.freeze({
  /** Kiinteä kellonaika. */
  AT_TIME: 'at_time',
  /** Tietty aika ennen kohteen alkua tai eräpäivää. */
  BEFORE_TARGET: 'before_target',
  /** Kun kohde muuttuu myöhässä olevaksi. */
  WHEN_OVERDUE: 'when_overdue',
  /** Kun on aika lähteä. Ks. src/domain/travel.js. */
  LEAVE_BY: 'leave_by'
});

export const TRIGGERS = Object.freeze(Object.values(TRIGGER));

/**
 * Porrastus.
 *
 * Kolme porrasta, ei enempää. Neljäs porras ei lisää tietoa vaan
 * ärsytystä, ja ärsyttävä muistutus opettaa käyttäjän ohittamaan
 * kaikki muistutukset.
 */
export const ESCALATION = Object.freeze({
  /** Ensimmäinen, hienovarainen. */
  GENTLE: 'gentle',
  /** Toinen, painokkaampi. */
  FIRM: 'firm',
  /** Aika meni ohi. */
  OVERDUE: 'overdue'
});

export const ESCALATIONS = Object.freeze(Object.values(ESCALATION));

/** Portaiden oletusetuajat minuutteina. */
export const DEFAULT_ESCALATION_LEAD = Object.freeze({
  [ESCALATION.GENTLE]: 60,
  [ESCALATION.FIRM]: 15,
  [ESCALATION.OVERDUE]: 0
});

/**
 * Montako hälytystä yksi muistutus saa tuottaa.
 *
 * RAJA ON OLEMASSA JOTTA SITÄ EI TARVITSE MIETTIÄ. Loputon toisto on
 * helppo kirjoittaa vahingossa: yksi ehto väärin päin ja käyttäjän
 * puhelin soi minuutin välein.
 */
export const MAX_ALERTS_PER_REMINDER = 5;

/** Torkkuvaihtoehdot minuutteina. */
export const SNOOZE_OPTIONS = Object.freeze([5, 15, 30, 60]);

/** Pisin sallittu torkku. Vuorokausi. */
export const MAX_SNOOZE_MINUTES = 1440;

/** Montako kertaa saman muistutuksen saa torkuttaa. */
export const MAX_SNOOZE_COUNT = 10;

function cleanText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

/**
 * Kokonaisluku tai null.
 *
 * PUUTTUVA ARVO TARKISTETAAN ENNEN MUUNNOSTA. `Number(null)` on nolla,
 * ja nollan etuaika tarkoittaisi "muistuta täsmälleen silloin kun asia
 * alkaa" — eri asia kuin "etuaikaa ei ole asetettu".
 */
function positiveInt(value, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return null;
  return max ? Math.min(n, max) : n;
}

/**
 * Normalisoi muistutus.
 *
 * `targetId` EI OLE VIERASAVAIN. Kohde voidaan poistaa, ja muistutus
 * on silti tietue siitä, että muistuttaminen oli tarkoitus. Sama
 * perustelu kuin `transactions.source_id` (migraatio 0009) ja
 * `ai_action_audit.target_id` (migraatio 0008).
 *
 * Poistettu kohde tekee muistutuksesta orvon; `isOrphaned` tunnistaa
 * sen ja sovellus peruu sen — hiljaisen katoamisen sijaan.
 */
export function normalizeReminder(input = {}) {
  const status = REMINDER_STATUSES.includes(input.status)
    ? input.status : REMINDER_STATUS.SCHEDULED;

  const targetType = REMINDER_TARGETS.includes(input.targetType)
    ? input.targetType : REMINDER_TARGET.STANDALONE;

  const trigger = TRIGGERS.includes(input.trigger)
    ? input.trigger : TRIGGER.AT_TIME;

  return {
    id: input.id != null ? String(input.id) : null,

    title: String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),

    targetType,
    targetId: input.targetId != null ? String(input.targetId) : null,

    trigger,

    /** Milloin muistutus laukeaa. Päivä + kellonaika. */
    dueDate: isIsoDate(input.dueDate) ? input.dueDate : null,
    dueTime: isTimeOfDay(input.dueTime) ? input.dueTime : null,

    /** Etuaika minuutteina, kun laukaisin on BEFORE_TARGET. */
    leadMinutes: positiveInt(input.leadMinutes, 10080),

    status,

    /** Porrastus päällä? Yksittäinen muistutus ei tarvitse sitä. */
    escalate: input.escalate === true,

    /** Montako hälytystä on jo tuotettu. Raja on MAX_ALERTS_PER_REMINDER. */
    alertCount: positiveInt(input.alertCount, MAX_ALERTS_PER_REMINDER) ?? 0,

    /** Montako kertaa torkutettu. */
    snoozeCount: positiveInt(input.snoozeCount, MAX_SNOOZE_COUNT) ?? 0,

    /**
     * Mihin asti muistutetaan.
     *
     * "Muistuta kunnes klo 17" on tämä. Ilman rajaa muistutus jäisi
     * elämään loputtomasti.
     */
    untilTime: isTimeOfDay(input.untilTime) ? input.untilTime : null,

    note: cleanText(input.note, 500),

    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateReminder(reminder) {
  const errors = {};

  if (!reminder) return { valid: false, errors: { reminder: 'Muistutusta ei ole.' } };

  if (!reminder.title) errors.title = 'Anna muistutukselle nimi.';

  if (!REMINDER_STATUSES.includes(reminder.status)) errors.status = 'Tuntematon tila.';
  if (!TRIGGERS.includes(reminder.trigger)) errors.trigger = 'Tuntematon laukaisin.';

  // KOHDELAJI JA TUNNISTE KULKEVAT PARINA.
  //
  // Laji ilman tunnistetta ei osoita mihinkään, ja tunniste ilman lajia
  // ei kerro mihin se osoittaa. Sama sääntö kuin tapahtuman lähteellä.
  if (reminder.targetType !== REMINDER_TARGET.STANDALONE && !reminder.targetId) {
    errors.targetId = 'Kohde puuttuu.';
  }
  if (reminder.targetType === REMINDER_TARGET.STANDALONE && reminder.targetId) {
    errors.targetId = 'Vapaalla muistutuksella ei ole kohdetta.';
  }

  if (reminder.trigger === TRIGGER.AT_TIME) {
    if (!reminder.dueDate) errors.dueDate = 'Milloin muistutan?';
    if (!reminder.dueTime) errors.dueTime = 'Mihin aikaan?';
  }

  if (reminder.trigger === TRIGGER.BEFORE_TARGET && reminder.leadMinutes === null) {
    errors.leadMinutes = 'Kuinka paljon ennen?';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// =====================================================================
// AIKALASKENTA
// =====================================================================

/**
 * Muistutuksen hetki minuutteina päivän alusta.
 *
 * Palauttaa `null`, kun hetkeä ei voi laskea. `null` on rehellinen:
 * nolla tarkoittaisi keskiyötä.
 */
export function dueMinutes(reminder) {
  if (!reminder || !reminder.dueTime) return null;
  return toMinutes(reminder.dueTime);
}

/**
 * Laske muistutuksen hetki kohteesta.
 *
 * BEFORE_TARGET: kohteen alku miinus etuaika.
 *
 * YLI KESKIYÖN MENEVÄ ETUAIKA SIIRTÄÄ PÄIVÄÄ. Kokous klo 08:00 ja
 * 12 tunnin etuaika tarkoittaa edellisen päivän klo 20:00 — ei saman
 * päivän klo 20:00, joka olisi kokouksen jälkeen.
 *
 * @returns {{dateIso: string, time: string}|null}
 */
export function resolveTriggerTime(reminder, target) {
  if (!reminder) return null;

  if (reminder.trigger === TRIGGER.AT_TIME) {
    if (!reminder.dueDate || !reminder.dueTime) return null;
    return { dateIso: reminder.dueDate, time: reminder.dueTime };
  }

  if (reminder.trigger === TRIGGER.BEFORE_TARGET) {
    if (!target || !target.date || !target.time) return null;
    if (reminder.leadMinutes === null) return null;

    const targetMinutes = toMinutes(target.time);
    let minutes = targetMinutes - reminder.leadMinutes;
    let dateIso = target.date;

    // Keskiyön yli: siirry taaksepäin päivä kerrallaan.
    let guard = 0;
    while (minutes < 0 && guard < 14) {
      minutes += 1440;
      dateIso = fmtISO(addDays(parseISO(dateIso), -1));
      guard += 1;
    }

    return { dateIso, time: fromMinutes(minutes) };
  }

  if (reminder.trigger === TRIGGER.WHEN_OVERDUE) {
    if (!target || !target.date) return null;
    // Myöhässä olevasta muistutetaan seuraavan päivän aamuna: samana
    // päivänä se ei ole vielä myöhässä.
    return {
      dateIso: fmtISO(addDays(parseISO(target.date), 1)),
      time: '09:00'
    };
  }

  // LEAVE_BY lasketaan matkamoduulissa, koska se tarvitsee matka-arvion.
  return null;
}

/**
 * Onko muistutus erääntynyt annettuna hetkenä?
 *
 * VERTAILU ON PÄIVÄ + MINUUTIT, EI AIKALEIMA. Aikaleima veisi
 * paikallisen päivän UTC:hen ja siirtäisi suomalaisen aamun edelliselle
 * päivälle. Sama päätös kuin `transactions.date` -sarakkeessa.
 */
export function isDue(reminder, { todayIso, nowMinutes }) {
  if (!reminder || !isIsoDate(todayIso)) return false;
  if (!LIVE_STATUSES.includes(reminder.status)) return false;
  if (!reminder.dueDate || !reminder.dueTime) return false;

  if (reminder.dueDate < todayIso) return true;
  if (reminder.dueDate > todayIso) return false;

  return toMinutes(reminder.dueTime) <= Number(nowMinutes ?? 0);
}

/**
 * Onko muistutuksen aika mennyt ohi lopullisesti?
 *
 * `untilTime` on se raja, jonka jälkeen muistuttaminen lakkaa.
 * Ilman rajaa muistutus vanhenee vasta seuraavana päivänä.
 */
export function isExpired(reminder, { todayIso, nowMinutes }) {
  if (!reminder || !isIsoDate(todayIso)) return false;
  if (!LIVE_STATUSES.includes(reminder.status)) return false;
  if (!reminder.dueDate) return false;

  if (reminder.dueDate < todayIso) return true;
  if (reminder.dueDate > todayIso) return false;

  if (!reminder.untilTime) return false;
  return toMinutes(reminder.untilTime) < Number(nowMinutes ?? 0);
}

/**
 * Onko muistutuksen kohde poistettu?
 *
 * Orpo muistutus on tietue asiasta, jota ei enää ole. Sitä ei
 * hävitetä hiljaa, vaan sovellus peruu sen näkyvästi.
 *
 * `lookup` on kohdelaji -> kokoelma. Kokoelma saa olla taulukko tai
 * VALMIS TUNNISTEJOUKKO (`Set`): jälkimmäinen tekee hausta vakioaikaisen,
 * ja `evaluateReminders` rakentaa sen kerran kierrosta kohti.
 *
 * PUUTTUVA KOKOELMA EI TEE ORVOKSI. Kokoelmaa ei ole ladattu on eri
 * asia kuin että kohde on poistettu, ja väärä orpous peruisi
 * muistutuksen turhaan.
 */
export function isOrphaned(reminder, lookup = {}) {
  if (!reminder || reminder.targetType === REMINDER_TARGET.STANDALONE) return false;

  // Luetaan KERRAN. Alla oleva haku kulkee koko kokoelman läpi, ja
  // kentän lukeminen silmukan sisällä tekisi siitä n kertaa kalliimman
  // kuin se on — mikä näkyy 30 sekunnin välein ajettavassa
  // hälytyskierroksessa. Ks. tests/assistant-performance.test.mjs.
  const targetId = reminder.targetId;
  if (!targetId) return false;

  const collection = lookup[reminder.targetType];

  if (collection instanceof Set) return !collection.has(targetId);
  if (!Array.isArray(collection)) return false;

  return !collection.some(row => row && String(row.id) === targetId);
}

/**
 * Kohdekokoelmista tunnistejoukot.
 *
 * Rakennetaan KERRAN kierrosta kohti. Ilman tätä jokainen muistutus
 * kävisi kohdekokoelman läpi erikseen, ja hälytyskierros olisi
 * tehtävien ja muistutusten tulo — ei summa.
 */
function idLookup(lookup = {}) {
  const out = {};
  for (const [kind, collection] of Object.entries(lookup)) {
    if (collection instanceof Set) { out[kind] = collection; continue; }
    if (!Array.isArray(collection)) continue;
    out[kind] = new Set(
      collection.filter(Boolean).map(row => String(row.id)));
  }
  return out;
}

// =====================================================================
// TILASIIRTYMÄT
// =====================================================================

const TRANSITIONS = Object.freeze({
  [REMINDER_STATUS.SCHEDULED]: [
    REMINDER_STATUS.DUE, REMINDER_STATUS.COMPLETED,
    REMINDER_STATUS.CANCELLED, REMINDER_STATUS.EXPIRED
  ],
  [REMINDER_STATUS.DUE]: [
    REMINDER_STATUS.DELIVERED, REMINDER_STATUS.ACKNOWLEDGED,
    REMINDER_STATUS.SNOOZED, REMINDER_STATUS.COMPLETED,
    REMINDER_STATUS.CANCELLED, REMINDER_STATUS.EXPIRED
  ],
  [REMINDER_STATUS.DELIVERED]: [
    REMINDER_STATUS.ACKNOWLEDGED, REMINDER_STATUS.SNOOZED,
    REMINDER_STATUS.COMPLETED, REMINDER_STATUS.CANCELLED,
    REMINDER_STATUS.EXPIRED, REMINDER_STATUS.DUE
  ],
  [REMINDER_STATUS.SNOOZED]: [
    REMINDER_STATUS.SCHEDULED, REMINDER_STATUS.DUE,
    REMINDER_STATUS.COMPLETED, REMINDER_STATUS.CANCELLED,
    REMINDER_STATUS.EXPIRED
  ],
  [REMINDER_STATUS.ACKNOWLEDGED]: [
    REMINDER_STATUS.COMPLETED, REMINDER_STATUS.CANCELLED
  ],
  // Päätetilat.
  [REMINDER_STATUS.COMPLETED]: [],
  [REMINDER_STATUS.EXPIRED]: [],
  [REMINDER_STATUS.CANCELLED]: []
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function transition(reminder, to, extra = {}) {
  if (!reminder || !canTransition(reminder.status, to)) return null;
  return normalizeReminder({ ...reminder, ...extra, status: to });
}

/** Merkitse toimitetuksi. Kasvattaa hälytyslaskuria. */
export function markDelivered(reminder) {
  if (!reminder) return null;
  if (!canTransition(reminder.status, REMINDER_STATUS.DELIVERED)) return null;

  return normalizeReminder({
    ...reminder,
    status: REMINDER_STATUS.DELIVERED,
    alertCount: Math.min(reminder.alertCount + 1, MAX_ALERTS_PER_REMINDER)
  });
}

/** Käyttäjä kuittasi nähneensä. EI sama kuin tehty. */
export function acknowledge(reminder) {
  return transition(reminder, REMINDER_STATUS.ACKNOWLEDGED);
}

/**
 * Torkuta.
 *
 * ============================================================
 * TORKKU SIIRTÄÄ MUISTUTUSTA, EI MÄÄRÄPÄIVÄÄ.
 * ============================================================
 *
 * Palautettu muistutus kantaa uuden ajan. Kohde ei muutu — tämä
 * funktio ei edes näe sitä. Se on rakenteellinen tae eikä
 * muistisääntö: kohteen siirtämiseen ei ole täällä pääsyä.
 *
 * @param {object} reminder
 * @param {number} minutes
 * @param {{todayIso: string, nowMinutes: number}} now
 */
export function snooze(reminder, minutes, { todayIso, nowMinutes } = {}) {
  if (!reminder) return null;
  if (!canTransition(reminder.status, REMINDER_STATUS.SNOOZED)) return null;

  const delay = Math.trunc(Number(minutes));
  if (!Number.isFinite(delay) || delay <= 0) return null;
  if (delay > MAX_SNOOZE_MINUTES) return null;

  // TORKKUJEN MÄÄRÄ ON RAJATTU. Ilman rajaa muistutus voisi elää
  // ikuisesti viiden minuutin pätkissä, eikä mikään kertoisi että
  // asia on jäänyt tekemättä.
  if (reminder.snoozeCount >= MAX_SNOOZE_COUNT) return null;

  const base = Number.isFinite(Number(nowMinutes))
    ? Number(nowMinutes)
    : dueMinutes(reminder) ?? 0;

  let target = base + delay;
  let dateIso = isIsoDate(todayIso) ? todayIso : reminder.dueDate;

  // Yli keskiyön: siirry eteenpäin päivä kerrallaan.
  let guard = 0;
  while (target >= 1440 && guard < 2) {
    target -= 1440;
    dateIso = dateIso ? fmtISO(addDays(parseISO(dateIso), 1)) : null;
    guard += 1;
  }

  return normalizeReminder({
    ...reminder,
    status: REMINDER_STATUS.SNOOZED,
    dueDate: dateIso,
    dueTime: fromMinutes(target),
    snoozeCount: reminder.snoozeCount + 1,
    // TORKUTETTU MUISTUTUS ODOTTAA UUTTA VUOROAAN.
    //
    // `untilTime` säilyy: torkku ei saa ohittaa käyttäjän asettamaa
    // takarajaa. Jos torkku menee rajan yli, muistutus vanhenee.
    untilTime: reminder.untilTime
  });
}

/** Kohde on tehty. Päätetila. */
export function markCompleted(reminder) {
  return transition(reminder, REMINDER_STATUS.COMPLETED);
}

/** Peruta. Päätetila. */
export function cancel(reminder) {
  return transition(reminder, REMINDER_STATUS.CANCELLED);
}

/** Vanhentui. Päätetila. */
export function expire(reminder) {
  return transition(reminder, REMINDER_STATUS.EXPIRED);
}

// =====================================================================
// HÄLYTYKSET
// =====================================================================

/**
 * Hälytyksen deterministinen avain.
 *
 * =================================================================
 * TÄMÄ ON KAKSOISKAPPALEIDEN ESTO.
 * =================================================================
 *
 * Sama muistutus, sama porras, sama minuutti tuottaa saman avaimen.
 * Taustatarkistus voidaan ajaa niin usein kuin halutaan: toistuvasti
 * laskettu hälytys on sama hälytys.
 *
 * Minuutti on mukana, koska torkutettu muistutus on aidosti eri
 * hälytys — se on eri hetki ja käyttäjä odottaa sitä.
 */
export function occurrenceKey(reminder, escalation, { dateIso, minutes }) {
  if (!reminder || !reminder.id) return null;
  return [
    reminder.id,
    escalation || ESCALATION.GENTLE,
    dateIso || reminder.dueDate || '',
    String(minutes ?? '')
  ].join('|');
}

/**
 * Mikä porras tälle hetkelle kuuluu?
 *
 * Palauttaa `null`, jos hälytystä ei kuulu tuottaa.
 */
export function escalationFor(reminder, { todayIso, nowMinutes }) {
  if (!reminder || !reminder.escalate) {
    return isDue(reminder, { todayIso, nowMinutes }) ? ESCALATION.GENTLE : null;
  }

  if (!reminder.dueDate || !reminder.dueTime) return null;
  if (!LIVE_STATUSES.includes(reminder.status)) return null;

  const now = Number(nowMinutes ?? 0);
  const due = toMinutes(reminder.dueTime);

  // Mennyt päivä: myöhässä.
  if (reminder.dueDate < todayIso) return ESCALATION.OVERDUE;
  if (reminder.dueDate > todayIso) return null;

  const remaining = due - now;

  if (remaining <= 0) return ESCALATION.OVERDUE;
  if (remaining <= DEFAULT_ESCALATION_LEAD[ESCALATION.FIRM]) return ESCALATION.FIRM;
  if (remaining <= DEFAULT_ESCALATION_LEAD[ESCALATION.GENTLE]) return ESCALATION.GENTLE;

  return null;
}

/**
 * Arvioi muistutukset ja tuota hälytykset.
 *
 * =================================================================
 * TÄMÄ ON PUHDAS FUNKTIO. Se ei lue kelloa eikä kirjoita mitään.
 * =================================================================
 *
 * Sama syöte tuottaa saman tuloksen, mikä tekee siitä testattavan
 * ilman ajastimia — ja ilman laitetta.
 *
 * `deliveredKeys` on joukko jo näytettyjä avaimia. Se on kutsujan
 * vastuulla, koska vain kutsuja tietää mitä on oikeasti näytetty.
 *
 * @returns {{alerts: Array, expired: Array, orphaned: Array}}
 */
export function evaluateReminders({
  reminders = [],
  todayIso,
  nowMinutes = 0,
  deliveredKeys = new Set(),
  lookup = {}
} = {}) {
  const alerts = [];
  const expired = [];
  const orphaned = [];

  // TUNNISTEJOUKOT RAKENNETAAN KERRAN. Ks. `idLookup`.
  const ids = idLookup(lookup);

  for (const reminder of reminders) {
    if (!reminder) continue;

    if (isOrphaned(reminder, ids)) {
      orphaned.push(reminder);
      continue;
    }

    if (isExpired(reminder, { todayIso, nowMinutes })) {
      expired.push(reminder);
      continue;
    }

    if (reminder.alertCount >= MAX_ALERTS_PER_REMINDER) continue;

    const escalation = escalationFor(reminder, { todayIso, nowMinutes });
    if (!escalation) continue;

    const key = occurrenceKey(reminder, escalation, {
      dateIso: todayIso, minutes: reminder.dueTime
    });

    // KAKSOISKAPPALEIDEN ESTO. Sama avain kahdesti on kerran näytetty.
    if (!key || deliveredKeys.has(key)) continue;

    alerts.push({
      key,
      reminderId: reminder.id,
      title: reminder.title,
      escalation,
      targetType: reminder.targetType,
      targetId: reminder.targetId,
      dueDate: reminder.dueDate,
      dueTime: reminder.dueTime,
      reason: explainAlert(reminder, escalation, { todayIso, nowMinutes })
    });
  }

  return { alerts, expired, orphaned };
}

/**
 * Miksi tämä hälytys ilmestyi?
 *
 * =================================================================
 * PERUSTELU LASKETAAN TODELLISISTA LUVUISTA.
 * =================================================================
 *
 * Hälytys ilman perustelua on käsky. Käyttäjän pitää nähdä MIKSI,
 * jotta hän voi säätää muistutusta tai olla eri mieltä.
 */
export function explainAlert(reminder, escalation, { todayIso, nowMinutes }) {
  if (!reminder) return '';

  const nimi = reminder.title || 'Asia';

  if (escalation === ESCALATION.OVERDUE) {
    if (reminder.dueDate && reminder.dueDate < todayIso) {
      return `"${nimi}" oli määrä hoitaa ${reminder.dueDate}.`;
    }
    return `"${nimi}" oli määrä hoitaa klo ${reminder.dueTime}.`;
  }

  if (!reminder.dueTime) return `Muistutan asiasta "${nimi}".`;

  const remaining = toMinutes(reminder.dueTime) - Number(nowMinutes ?? 0);

  if (remaining <= 0) return `"${nimi}" on nyt.`;

  const kesto = remaining >= 60
    ? `${Math.floor(remaining / 60)} h ${remaining % 60} min`
    : `${remaining} min`;

  return `Muistutan tästä nyt, koska "${nimi}" alkaa ${kesto} kuluttua.`;
}

/**
 * Muistutus tehtävälle.
 *
 * Apufunktio, jotta kutsupaikkojen ei tarvitse tietää laukaisimien
 * yksityiskohtia. Tunniste tulee kutsujalta — domain ei tuota
 * tunnisteita.
 */
export function reminderForTask(task, { id, leadMinutes = 30, escalate = false } = {}) {
  if (!task || !task.id) return null;

  const resolved = resolveTriggerTime(
    normalizeReminder({ trigger: TRIGGER.BEFORE_TARGET, leadMinutes }),
    task
  );

  return normalizeReminder({
    id,
    title: task.title,
    targetType: REMINDER_TARGET.TASK,
    targetId: task.id,
    trigger: TRIGGER.BEFORE_TARGET,
    leadMinutes,
    dueDate: resolved ? resolved.dateIso : task.date,
    dueTime: resolved ? resolved.time : null,
    escalate,
    status: REMINDER_STATUS.SCHEDULED
  });
}

/** Muistutukset kohteelle. */
export function remindersForTarget(reminders = [], targetType, targetId) {
  if (!targetType || targetId == null) return [];
  const id = String(targetId);
  return reminders.filter(r =>
    r && r.targetType === targetType && r.targetId === id);
}

/** Elävät muistutukset järjestyksessä. */
export function liveReminders(reminders = []) {
  return reminders
    .filter(r => r && LIVE_STATUSES.includes(r.status))
    .sort(compareReminders);
}

/** Järjestys: aikaisin ensin, päivätön viimeisenä. */
export function compareReminders(a, b) {
  const aDate = a.dueDate || '9999-12-31';
  const bDate = b.dueDate || '9999-12-31';
  if (aDate !== bDate) return aDate.localeCompare(bDate);

  const aTime = a.dueTime || '23:59';
  const bTime = b.dueTime || '23:59';
  if (aTime !== bTime) return aTime.localeCompare(bTime);

  return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'fi');
}

/** Yhteenveto. */
export function summarizeReminders(reminders = []) {
  return {
    total: reminders.length,
    live: reminders.filter(r => LIVE_STATUSES.includes(r.status)).length,
    snoozed: reminders.filter(r => r.status === REMINDER_STATUS.SNOOZED).length,
    acknowledged: reminders.filter(r => r.status === REMINDER_STATUS.ACKNOWLEDGED).length,
    expired: reminders.filter(r => r.status === REMINDER_STATUS.EXPIRED).length
  };
}
