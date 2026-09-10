// Ilmoituskeskus: mitä sovellus on kertonut ja mitä sille tehtiin.
//
// =====================================================================
// TÄMÄ EI OLE KÄYTTÖJÄRJESTELMÄN ILMOITUS
// =====================================================================
//
// Käyttöjärjestelmän ilmoitus katoaa, kun se pyyhkäistään pois — myös
// silloin kun käyttäjä ei ehtinyt lukea sitä. Puhelin oli taskussa,
// ruutu oli lukossa, ilmoitus tuli kesken kokouksen.
//
// Ilmoituskeskus on sovelluksen oma HISTORIA: se kertoo, mitä
// järjestelmä yritti sanoa ja mitä siitä seurasi. Se on olemassa
// nimenomaan siksi, että käyttöjärjestelmän ilmoitus voi mennä ohi.
//
// =====================================================================
// MERKINTÄ EI OLE TOIMENPIDE
// =====================================================================
//
// Ilmoituskeskus ei tee mitään itse. Se kuvaa TOIMINNOT, joita
// merkinnälle voi tehdä ("kuittaa", "torkuta", "merkitse tehdyksi"), ja
// sovelluskerros toteuttaa ne olemassa olevilla domain-funktioilla.
//
// Ohituspolkua ei ole: "merkitse tehdyksi" kutsuu samaa
// `toggleComplete`-toimintoa kuin tehtävälista. Kaksi tapaa merkitä
// tehtävä tehdyksi tarkoittaisi kaksi paikkaa, joissa sääntö voi
// erota.
//
// =====================================================================
// HISTORIA EI KASVA RAJATTA
// =====================================================================
//
// Vanhat merkinnät karsitaan. Ilmoitushistoria, joka säilyttää kaiken,
// on tietovuoto odottamassa tapahtumaansa — ja se on myös hyödytön:
// kukaan ei selaa kolmen kuukauden takaisia muistutuksia.

import { isIsoDate, MAX_TITLE_LENGTH } from './task.js';

/** Merkinnän laji. */
export const NOTICE_KIND = Object.freeze({
  REMINDER: 'reminder',
  OVERDUE: 'overdue',
  /** Lähtöaika on käsillä. */
  LEAVE_NOW: 'leave_now',
  /** Aikataulussa on ristiriita. */
  CONFLICT: 'conflict',
  /** Tavoite on vaarassa myöhästyä. */
  GOAL_RISK: 'goal_risk',
  /** Tekoälyn ehdotus odottaa tarkistusta. */
  PROPOSAL: 'proposal',
  /** Lasku erääntyy. */
  BILL_DUE: 'bill_due',
  /** Säästötavoite eteni. */
  SAVINGS: 'savings',
  /** Suunnitelmaan ehdotetaan muutosta. */
  REPLAN: 'replan'
});

export const NOTICE_KINDS = Object.freeze(Object.values(NOTICE_KIND));

const KIND_LABELS = Object.freeze({
  reminder: 'Muistutus',
  overdue: 'Myöhässä',
  leave_now: 'Lähtöaika',
  conflict: 'Ristiriita',
  goal_risk: 'Tavoite vaarassa',
  proposal: 'Ehdotus',
  bill_due: 'Lasku erääntyy',
  savings: 'Säästöt',
  replan: 'Muutosehdotus'
});

export function noticeKindLabel(kind) {
  return KIND_LABELS[kind] || 'Ilmoitus';
}

/** Merkinnän tila. */
export const NOTICE_STATUS = Object.freeze({
  /** Näytetty, ei käsitelty. */
  UNREAD: 'unread',
  /** Käyttäjä on nähnyt sen. */
  READ: 'read',
  /** Käyttäjä on tehnyt asialle jotain. */
  ACTED: 'acted',
  /** Käyttäjä sulki sen tekemättä mitään. */
  DISMISSED: 'dismissed'
});

export const NOTICE_STATUSES = Object.freeze(Object.values(NOTICE_STATUS));

/** Vakavuus. Sama asteikko kuin ristiriidoilla. */
export const NOTICE_LEVEL = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  URGENT: 'urgent'
});

export const NOTICE_LEVELS = Object.freeze(Object.values(NOTICE_LEVEL));

/**
 * Mitä merkinnälle voi tehdä.
 *
 * NÄMÄ OVAT NIMIÄ, EIVÄT TOTEUTUKSIA. Sovelluskerros yhdistää nimen
 * olemassa olevaan domain-toimintoon. Ohituspolkua kantaan ei ole.
 */
export const NOTICE_ACTION = Object.freeze({
  OPEN: 'open',
  ACKNOWLEDGE: 'acknowledge',
  SNOOZE: 'snooze',
  COMPLETE: 'complete',
  REVIEW: 'review',
  DISMISS: 'dismiss'
});

export const NOTICE_ACTIONS = Object.freeze(Object.values(NOTICE_ACTION));

/**
 * Mitkä toiminnot kullekin lajille kuuluvat.
 *
 * Nimenomainen kartta. Ilman sitä käyttöliittymä tarjoaisi "torkuta"
 * ristiriidalle ja "merkitse tehdyksi" säästötiedotteelle — toimintoja,
 * joilla ei ole merkitystä eivätkä ne tee mitään.
 */
const ACTIONS_BY_KIND = Object.freeze({
  [NOTICE_KIND.REMINDER]: [NOTICE_ACTION.OPEN, NOTICE_ACTION.ACKNOWLEDGE,
    NOTICE_ACTION.SNOOZE, NOTICE_ACTION.COMPLETE, NOTICE_ACTION.DISMISS],
  [NOTICE_KIND.OVERDUE]: [NOTICE_ACTION.OPEN, NOTICE_ACTION.COMPLETE,
    NOTICE_ACTION.DISMISS],
  [NOTICE_KIND.LEAVE_NOW]: [NOTICE_ACTION.OPEN, NOTICE_ACTION.ACKNOWLEDGE,
    NOTICE_ACTION.DISMISS],
  [NOTICE_KIND.CONFLICT]: [NOTICE_ACTION.OPEN, NOTICE_ACTION.REVIEW,
    NOTICE_ACTION.DISMISS],
  [NOTICE_KIND.GOAL_RISK]: [NOTICE_ACTION.OPEN, NOTICE_ACTION.REVIEW,
    NOTICE_ACTION.DISMISS],
  [NOTICE_KIND.PROPOSAL]: [NOTICE_ACTION.REVIEW, NOTICE_ACTION.DISMISS],
  [NOTICE_KIND.BILL_DUE]: [NOTICE_ACTION.OPEN, NOTICE_ACTION.COMPLETE,
    NOTICE_ACTION.DISMISS],
  [NOTICE_KIND.SAVINGS]: [NOTICE_ACTION.OPEN, NOTICE_ACTION.DISMISS],
  [NOTICE_KIND.REPLAN]: [NOTICE_ACTION.REVIEW, NOTICE_ACTION.DISMISS]
});

/** Toiminnot, jotka tälle merkinnälle ovat mielekkäitä. */
export function actionsFor(notice) {
  if (!notice) return [];
  const actions = ACTIONS_BY_KIND[notice.kind] || [NOTICE_ACTION.DISMISS];

  // Käsitellylle ei tarjota toimintoja uudelleen — paitsi avaamista,
  // joka on aina harmiton.
  if (notice.status === NOTICE_STATUS.ACTED
    || notice.status === NOTICE_STATUS.DISMISSED) {
    return actions.filter(action => action === NOTICE_ACTION.OPEN);
  }

  return actions;
}

/** Montako merkintää säilytetään. */
export const MAX_NOTICES = 100;

/** Kuinka monta päivää merkintöjä säilytetään. */
export const RETENTION_DAYS = 30;

function cleanText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalisoi merkintä.
 *
 * `key` on DETERMINISTINEN AVAIN, joka estää kaksoiskappaleet. Sama
 * hälytys tuottaa saman avaimen riippumatta siitä, montako kertaa
 * taustatarkistus ajetaan. Ks. `src/domain/reminder.js` `occurrenceKey`.
 */
export function normalizeNotice(input = {}) {
  const kind = NOTICE_KINDS.includes(input.kind) ? input.kind : NOTICE_KIND.REMINDER;
  const status = NOTICE_STATUSES.includes(input.status)
    ? input.status : NOTICE_STATUS.UNREAD;
  const level = NOTICE_LEVELS.includes(input.level) ? input.level : NOTICE_LEVEL.INFO;

  return {
    id: input.id != null ? String(input.id) : null,

    /** Kaksoiskappaleiden esto. Sama hälytys = sama avain. */
    key: cleanText(input.key, 200),

    kind,
    level,
    status,

    title: String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),

    /**
     * Miksi tämä ilmestyi.
     *
     * Lasketaan todellisista luvuista muistutus- ja matkamoduuleissa.
     * Ilmoitus ilman perustelua on käsky.
     */
    reason: cleanText(input.reason, 500),

    /**
     * Mihin tämä viittaa. EI VIERASAVAIN: kohde voidaan poistaa, ja
     * merkintä on silti tietue siitä, että asiasta ilmoitettiin.
     */
    targetType: cleanText(input.targetType, 40),
    targetId: input.targetId != null ? String(input.targetId) : null,

    /** Milloin merkintä syntyi. Päivä riittää karsintaan. */
    createdDate: isIsoDate(input.createdDate) ? input.createdDate : null,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateNotice(notice) {
  const errors = {};

  if (!notice) return { valid: false, errors: { notice: 'Merkintää ei ole.' } };
  if (!notice.title) errors.title = 'Merkinnällä pitää olla otsikko.';
  if (!notice.key) errors.key = 'Merkinnältä puuttuu avain.';
  if (!NOTICE_KINDS.includes(notice.kind)) errors.kind = 'Tuntematon laji.';

  // KOHDELAJI JA TUNNISTE KULKEVAT PARINA.
  if (notice.targetType && !notice.targetId) errors.targetId = 'Kohde puuttuu.';
  if (!notice.targetType && notice.targetId) errors.targetType = 'Kohdelaji puuttuu.';

  return { valid: Object.keys(errors).length === 0, errors };
}

// =====================================================================
// LISÄYS JA KAKSOISKAPPALEIDEN ESTO
// =====================================================================

/**
 * Lisää merkintä, jos sitä ei jo ole.
 *
 * =================================================================
 * SAMA AVAIN KAHDESTI ON KERRAN NÄYTETTY.
 * =================================================================
 *
 * Palauttaa uuden listan — ei mutatoi. Jos avain on jo listassa,
 * palauttaa saman listan muuttumattomana: kutsuja voi verrata
 * viitteitä ja tietää, syntyikö uutta.
 */
export function addNotice(notices = [], notice) {
  if (!notice || !notice.key) return notices;
  if (notices.some(existing => existing && existing.key === notice.key)) {
    return notices;
  }
  return [normalizeNotice(notice), ...notices];
}

/** Onko tämä avain jo historiassa? */
export function hasNotice(notices = [], key) {
  return Boolean(key) && notices.some(notice => notice && notice.key === key);
}

/**
 * Karsi vanhat.
 *
 * KAKSI RAJAA: ikä ja määrä. Ikä hoitaa tavallisen käytön; määrä
 * suojaa poikkeukselta, jossa yksi päivä tuottaa satoja merkintöjä.
 *
 * Käsittelemättömät säilyvät pidempään: merkintä, jolle käyttäjä ei
 * ole tehnyt mitään, on juuri se jonka hän saattoi missata.
 */
export function pruneNotices(notices = [], { todayIso, maxAgeDays = RETENTION_DAYS,
  maxCount = MAX_NOTICES } = {}) {
  let kept = notices.filter(Boolean);

  if (isIsoDate(todayIso)) {
    const cutoff = shiftDate(todayIso, -Math.abs(maxAgeDays));
    kept = kept.filter(notice => {
      if (!notice.createdDate) return true;
      // Käsittelemätön säilyy kaksinkertaisen ajan.
      const limit = notice.status === NOTICE_STATUS.UNREAD
        ? shiftDate(todayIso, -Math.abs(maxAgeDays) * 2)
        : cutoff;
      return notice.createdDate >= limit;
    });
  }

  return kept.sort(compareNotices).slice(0, maxCount);
}

function shiftDate(iso, days) {
  const time = Date.parse(iso + 'T00:00:00Z');
  if (!Number.isFinite(time)) return iso;
  return new Date(time + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Järjestys: käsittelemättömät ensin, sitten uusin ensin.
 *
 * Kiireellinen nousee käsittelemättömien sisällä: jos kolme asiaa
 * odottaa, kiireellisin on ylimpänä.
 */
export function compareNotices(a, b) {
  const aOpen = a.status === NOTICE_STATUS.UNREAD ? 0 : 1;
  const bOpen = b.status === NOTICE_STATUS.UNREAD ? 0 : 1;
  if (aOpen !== bOpen) return aOpen - bOpen;

  const levelRank = { urgent: 0, warning: 1, info: 2 };
  const aLevel = levelRank[a.level] ?? 3;
  const bLevel = levelRank[b.level] ?? 3;
  if (aOpen === 0 && aLevel !== bLevel) return aLevel - bLevel;

  const aTime = String(a.createdAt || a.createdDate || '');
  const bTime = String(b.createdAt || b.createdDate || '');
  if (aTime !== bTime) return bTime.localeCompare(aTime);

  return String(a.id || '').localeCompare(String(b.id || ''));
}

// =====================================================================
// TILASIIRTYMÄT
// =====================================================================

const TRANSITIONS = Object.freeze({
  [NOTICE_STATUS.UNREAD]: [NOTICE_STATUS.READ, NOTICE_STATUS.ACTED,
    NOTICE_STATUS.DISMISSED],
  [NOTICE_STATUS.READ]: [NOTICE_STATUS.ACTED, NOTICE_STATUS.DISMISSED],
  // Päätetilat. Käsitelty ei palaa käsittelemättömäksi.
  [NOTICE_STATUS.ACTED]: [],
  [NOTICE_STATUS.DISMISSED]: []
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function markRead(notice) {
  if (!notice || !canTransition(notice.status, NOTICE_STATUS.READ)) return null;
  return normalizeNotice({ ...notice, status: NOTICE_STATUS.READ });
}

/** Käyttäjä teki asialle jotain. */
export function markActed(notice) {
  if (!notice || !canTransition(notice.status, NOTICE_STATUS.ACTED)) return null;
  return normalizeNotice({ ...notice, status: NOTICE_STATUS.ACTED });
}

export function markDismissed(notice) {
  if (!notice || !canTransition(notice.status, NOTICE_STATUS.DISMISSED)) return null;
  return normalizeNotice({ ...notice, status: NOTICE_STATUS.DISMISSED });
}

/** Käsittelemättömät. */
export function unreadNotices(notices = []) {
  return notices
    .filter(notice => notice && notice.status === NOTICE_STATUS.UNREAD)
    .sort(compareNotices);
}

/** Yhteenveto. */
export function summarizeNotices(notices = []) {
  const unread = notices.filter(n => n && n.status === NOTICE_STATUS.UNREAD);

  return {
    total: notices.length,
    unread: unread.length,
    urgent: unread.filter(n => n.level === NOTICE_LEVEL.URGENT).length,
    /** Merkki alapalkkiin. Nolla ei ole merkki. */
    badge: unread.length
  };
}

// =====================================================================
// HÄLYTYKSISTÄ MERKINNÖIKSI
// =====================================================================

/**
 * Muuta muistutuksen hälytys ilmoitusmerkinnäksi.
 *
 * Avain periytyy hälytykseltä, joten kaksoiskappaleiden esto toimii
 * yli koko ketjun: sama hälytys, sama avain, yksi merkintä.
 *
 * Tunniste tulee kutsujalta — domain ei tuota tunnisteita.
 */
export function noticeFromAlert(alert, { id, createdDate, createdAt = null } = {}) {
  if (!alert || !alert.key) return null;

  const level = alert.escalation === 'overdue'
    ? NOTICE_LEVEL.URGENT
    : alert.escalation === 'firm'
      ? NOTICE_LEVEL.WARNING
      : NOTICE_LEVEL.INFO;

  return normalizeNotice({
    id,
    key: alert.key,
    kind: alert.escalation === 'overdue' ? NOTICE_KIND.OVERDUE : NOTICE_KIND.REMINDER,
    level,
    title: alert.title,
    reason: alert.reason,
    targetType: alert.targetType === 'standalone' ? null : alert.targetType,
    targetId: alert.targetType === 'standalone' ? null : alert.targetId,
    createdDate,
    createdAt
  });
}

/**
 * Muuta lähtöhälytys merkinnäksi.
 *
 * Avain sisältää päivän ja suunnitelman tunnisteen: sama lähtö samana
 * päivänä on yksi merkintä, vaikka tarkistus ajettaisiin minuutin
 * välein.
 */
export function noticeFromDeparture(plan, { id, todayIso, reason, late = false } = {}) {
  if (!plan || !plan.id) return null;

  return normalizeNotice({
    id,
    key: `departure|${plan.id}|${todayIso}|${late ? 'late' : 'due'}`,
    kind: NOTICE_KIND.LEAVE_NOW,
    level: late ? NOTICE_LEVEL.URGENT : NOTICE_LEVEL.WARNING,
    title: plan.title || plan.destination || 'Lähtöaika',
    reason,
    targetType: 'travel',
    targetId: plan.id,
    createdDate: todayIso
  });
}

/** Muuta ristiriita merkinnäksi. */
export function noticeFromConflict(conflict, { id, todayIso } = {}) {
  if (!conflict || !conflict.code) return null;

  return normalizeNotice({
    id,
    key: `conflict|${conflict.code}|${todayIso}|${conflict.goalId || conflict.dateIso || ''}`,
    kind: NOTICE_KIND.CONFLICT,
    level: conflict.severity === 'blocking'
      ? NOTICE_LEVEL.URGENT
      : conflict.severity === 'warning' ? NOTICE_LEVEL.WARNING : NOTICE_LEVEL.INFO,
    title: conflictTitle(conflict),
    reason: conflict.message,
    targetType: conflict.goalId ? 'goal' : null,
    targetId: conflict.goalId ?? null,
    createdDate: todayIso
  });
}

function conflictTitle(conflict) {
  return {
    overlap: 'Päällekkäisyys kalenterissa',
    deadline_past: 'Määräpäivä on mennyt',
    insufficient_capacity: 'Aika ei riitä',
    tight_capacity: 'Aikataulu on tiukka',
    milestone_order: 'Välitavoitteiden järjestys',
    milestone_after_goal: 'Välitavoite tavoitteen jälkeen',
    dependency_order: 'Riippuvuus väärin päin',
    portfolio_overcommit: 'Tavoitteet kilpailevat ajasta',
    day_overloaded: 'Päivä on täynnä',
    weak_estimates: 'Kestoarvioita puuttuu'
  }[conflict.code] || 'Ristiriita suunnitelmassa';
}
