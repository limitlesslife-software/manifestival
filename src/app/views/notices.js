// Ilmoituskeskus.
//
// =====================================================================
// TÄMÄ EI OLE TAUSTA-AINEISTOA
// =====================================================================
//
// AI-kirjausketjulla (`aiAudit`) ei ole selainta eikä sille tarvita
// sellaista: se on tietue siitä mitä tapahtui, ja sen arvo on siinä
// että se on olemassa.
//
// Ilmoitus on eri asia. Se kirjoitetaan nimenomaan käyttäjän
// luettavaksi, ja ilmoitus jota ei näytetä ei ole ilmoitus. Siksi tämä
// näkymä on olemassa ja siksi se on päivänäkymässä eikä asetuksissa.
//
// =====================================================================
// KOLME SÄÄNTÖÄ
// =====================================================================
//
// 1. TYHJÄ ON HYVÄ UUTINEN. Tyhjää keskusta ei piiloteta eikä täytetä
//    vinkeillä — se kertoo, ettei mitään odota.
//
// 2. JOKAINEN ILMOITUS KANTAA PERUSTELUN. Ilmoitus ilman perustelua on
//    käsky, ja käskyyn ei voi olla eri mieltä.
//
// 3. VAIN MIELEKKÄÄT TOIMINNOT. Toimintolista tulee domainista
//    (`actionsFor`), joten ristiriidalle ei tarjota torkutusta.

import { el, maybe } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { getState } from '../state.js';
import {
  NOTICE_KIND, NOTICE_STATUS, NOTICE_LEVEL, NOTICE_ACTION, noticeKindLabel,
  compareNotices, summarizeNotices, actionsFor
} from '../../domain/notificationCenter.js';
import { hasTable, isTableAvailable } from '../../data/schema.js';
import { serverUnavailableHintHtml } from '../schemaStatus.js';
import {
  readNotice, actOnNotice, dismissNotice, deleteNotice,
  snoozeReminderBy, completeReminder, acknowledgeReminder
} from '../assistantActions.js';
import { setTasksSegment, setGoalsSegment, setProfileSegment, findCalendarEvent } from '../state.js';
import { proposeReplan } from '../actions.js';
import { switchTab } from '../navigation.js';
import { openCalendarDay } from './calendar.js';
import { isIsoDate } from '../../domain/task.js';
import { fmtISO, todayMidnight } from '../../lib/datetime.js';

/** Onko keskus auki? Näkymän oma tila — ei kuulu sovelluksen tilaan. */
let open = false;

/** Näytetäänkö myös käsitellyt? */
let showHandled = false;

/** Toimintojen näkyvät nimet. Nimenomainen kartta, ei johdettu. */
const ACTION_LABELS = Object.freeze({
  [NOTICE_ACTION.OPEN]: 'Avaa',
  [NOTICE_ACTION.ACKNOWLEDGE]: 'Kuittaa',
  [NOTICE_ACTION.SNOOZE]: 'Torkuta 15 min',
  [NOTICE_ACTION.COMPLETE]: 'Hoidettu',
  [NOTICE_ACTION.REVIEW]: 'Tarkista',
  [NOTICE_ACTION.DISMISS]: 'Hylkää'
});

function levelClass(notice) {
  if (notice.level === NOTICE_LEVEL.URGENT) return ' is-urgent';
  return '';
}

function rowHtml(notice) {
  const lukematon = notice.status === NOTICE_STATUS.UNREAD;

  const napit = actionsFor(notice)
    .filter(action => ACTION_LABELS[action])
    .map(action => `<button class="assist-btn${action === NOTICE_ACTION.DISMISS ? '' : ' primary'}"`
      + ` data-notice-action="${escapeHtml(action)}"`
      + ` data-notice-id="${escapeHtml(notice.id)}">`
      + `${escapeHtml(ACTION_LABELS[action])}</button>`)
    .join('');

  return `
    <div class="assist-row${levelClass(notice)}${lukematon ? ' is-unread' : ''}${lukematon ? '' : ' is-closed'}">
      <div class="assist-title">${escapeHtml(notice.title)}</div>
      <div class="assist-meta">
        <span class="assist-tag${notice.level === NOTICE_LEVEL.URGENT ? ' tone-late' : notice.level === NOTICE_LEVEL.WARNING ? ' tone-warn' : ''}">
          ${escapeHtml(noticeKindLabel(notice.kind))}
        </span>
        ${escapeHtml(notice.createdDate || '')}
      </div>
      ${notice.reason ? `<div class="assist-reason">${escapeHtml(notice.reason)}</div>` : ''}
      <div class="assist-actions">
        ${napit}
        <button class="assist-btn danger" data-notice-delete="${escapeHtml(notice.id)}">Poista</button>
      </div>
    </div>`;
}

/** Renderöi ilmoituskeskus päivänäkymään. */
export function renderNotices() {
  const container = maybe('noticeCenterContainer');
  if (!container) return;

  const state = getState();
  const kaikki = [...state.notices].sort(compareNotices);
  const summary = summarizeNotices(kaikki);

  const naytettavat = showHandled
    ? kaikki
    : kaikki.filter(n => n.status === NOTICE_STATUS.UNREAD);

  const merkki = summary.badge > 0
    ? `<span class="notice-badge">${summary.badge}</span>`
    : '';

  const varoitus = isTableAvailable('notices')
    ? ''
    : hasTable('notices')
      ? serverUnavailableHintHtml()
      : `<p class="hint"><strong>Huom.</strong> Ilmoitukset säilyvät `
        + `toistaiseksi vain tämän istunnon ajan.</p>`;

  const sisalto = naytettavat.length === 0
    ? `<div class="assist-empty">${showHandled
        ? 'Ei ilmoituksia.'
        : 'Ei uusia ilmoituksia.'}</div>`
    : naytettavat.map(rowHtml).join('');

  const suodatin = kaikki.length > naytettavat.length || showHandled
    ? `<div class="assist-actions"><button class="assist-btn" id="noticesToggleHandled" type="button">`
      + `${showHandled ? 'Näytä vain uudet' : 'Näytä käsitellyt'}</button></div>`
    : '';

  container.innerHTML = `
    <details class="notice-center" id="noticeCenter"${open ? ' open' : ''}>
      <summary>Ilmoitukset ${merkki}</summary>
      ${varoitus}${sisalto}${suodatin}
    </details>`;

  const details = maybe('noticeCenter');
  if (details) {
    details.addEventListener('toggle', () => { open = details.open; });
  }
}

/** Profiilin osiot, joihin huomautus voi viedä (tuntematon -> Arki). */
const PROFILE_TARGETS = new Set(['daily', 'places', 'wellbeing']);

/**
 * Menohuomautuksen päivä: esiintymän päivä avaimesta
 * ('departure|event:<meno>:<päivä>|...'), muuten kertaluonteisen menon oma
 * päivä, muuten huomautuksen luontipäivä, muuten tämä päivä.
 */
export function calendarDateOf(notice) {
  const fromKey = typeof notice.key === 'string' ? /\|event:[^:|]+:(\d{4}-\d{2}-\d{2})\|/.exec(notice.key) : null;
  if (fromKey && isIsoDate(fromKey[1])) return fromKey[1];
  const event = notice.targetId ? findCalendarEvent(notice.targetId) : null;
  const recurring = event && Array.isArray(event.recurrenceWeekdays) && event.recurrenceWeekdays.length > 0;
  if (event && !recurring && isIsoDate(event.date)) return event.date;
  if (isIsoDate(notice.createdDate)) return notice.createdDate;
  return fmtISO(todayMidnight());
}

/**
 * Vie ilmoituksen kohteeseen.
 *
 * Siirtymä on NAVIGOINTI, ei toimenpide: se ei muuta mitään, se vain
 * näyttää missä asia on.
 */
export function openTarget(notice) {
  if (!notice) return;

  // Arjen asetuksiin viittaava huomautus (rytmi, maanantaivalmius,
  // myöhästely) on ehdotus, jonka käyttäjä hyväksyy itse Profiilissa.
  // Tarkistetaan ENNEN muutosehdotusta: nämä ovat lajiltaan REPLAN, mutta
  // eivät tehtävien siirtoehdotuksia.
  if (notice.targetType === 'settings') {
    switchTab('screen-profile');
    setProfileSegment(PROFILE_TARGETS.has(notice.targetId) ? notice.targetId : 'daily');
    return;
  }

  // Menon lähtöhuomautus: Kalenterin päivänäkymä sille päivälle.
  if (notice.targetType === 'calendar_event') {
    switchTab('screen-week');
    openCalendarDay(calendarDateOf(notice));
    return;
  }

  // MUUTOSEHDOTUS EI OLE KOHDE VAAN LASKELMA. Se rakennetaan vasta
  // kun käyttäjä pyytää -- ilmoituksessa ei ole eikä saa olla
  // valmista ehdotusta, koska se olisi mallin tuotosta kannassa.
  if (notice.kind === NOTICE_KIND.REPLAN) {
    proposeReplan('missed_task');
    switchTab('screen-goals');
    setGoalsSegment('plan');
    return;
  }

  if (!notice.targetType) return;

  if (notice.targetType === 'travel') {
    switchTab('screen-tasks');
    setTasksSegment('travel');
    return;
  }
  if (notice.targetType === 'task') {
    switchTab('screen-tasks');
    setTasksSegment('tasks');
    return;
  }
  switchTab('screen-tasks');
  setTasksSegment('reminders');
}

/** Kytke ilmoituskeskuksen tapahtumat. Kutsutaan kerran. */
export function initNotices() {
  const container = maybe('noticeCenterContainer');
  if (container) container.addEventListener('click', onClick);
}

async function onClick(event) {
  const toggleHandled = event.target.closest('#noticesToggleHandled');
  if (toggleHandled) {
    event.preventDefault();
    showHandled = !showHandled;
    renderNotices();
    return;
  }

  const remove = event.target.closest('[data-notice-delete]');
  if (remove) {
    await deleteNotice(remove.dataset.noticeDelete);
    return;
  }

  const button = event.target.closest('[data-notice-action]');
  if (!button) return;

  const { noticeAction, noticeId } = button.dataset;
  const notice = getState().notices.find(n => n.id === noticeId);
  if (!notice) return;

  switch (noticeAction) {
    case NOTICE_ACTION.OPEN:
      // Avaaminen merkitsee luetuksi. Se on rehellistä: käyttäjä näki sen.
      await readNotice(noticeId);
      openTarget(notice);
      break;

    case NOTICE_ACTION.ACKNOWLEDGE:
      if (notice.targetType === 'task' || notice.targetId) {
        await acknowledgeReminder(notice.targetId);
      }
      await actOnNotice(noticeId);
      break;

    case NOTICE_ACTION.SNOOZE:
      // TORKUTUS KOSKEE MUISTUTUSTA, EI KOHDETTA. Ilmoitus on vain
      // se paikka, josta torkutus pyydetään.
      if (notice.targetId) await snoozeReminderBy(notice.targetId, 15);
      await actOnNotice(noticeId);
      break;

    case NOTICE_ACTION.COMPLETE:
      if (notice.targetId) await completeReminder(notice.targetId);
      await actOnNotice(noticeId);
      break;

    case NOTICE_ACTION.REVIEW:
      await readNotice(noticeId);
      openTarget(notice);
      break;

    case NOTICE_ACTION.DISMISS:
      await dismissNotice(noticeId);
      break;

    default:
      break;
  }
}

/** Sulje keskus. Kutsutaan uloskirjautuessa. */
export function closeNoticeCenter() {
  open = false;
  showHandled = false;
}
