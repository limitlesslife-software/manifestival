// Päivänäkymä: RAUHALLINEN TÄNÄÄN (aalto L).
//
// Näkymän tehtävä on VÄHENTÄÄ sitä, mitä käyttäjän pitää pitää mielessä
// (docs/MENTAL-LOAD-CORE.md). Se vastaa järjestyksessä:
//
//   1. Mihin keskityn?          enintään kolme fokusta (lifeLoad NOW) ja
//                               "Kaikki muu on tallessa (N)."
//   2. Mikä ei odota?           aikakriittinen: lähtö, erääntynyt muistutus
//   3. Mikä on suojattua?       loma, oma aika, vapaa-aika
//   4. Mitä tänään tapahtuu?    kiinteät menot aikajanalla, NYT-hetki näkyy
//   5. Mikä jäi aiemmilta?      yksi rauhallinen rivi, ei punainen lista
//   6. Rutiinit ja vapaat välit
//   7. Mikä on tehty?           valmiit, koottuna pois tieltä
//   8. Miten menee?             hyvinvointi ja illan katsaus
//
// Fokus ja "tallessa" tulevat samasta moottorista kuin Tallessa-näkymä
// (src/app/lifeLoadModel.js): sama asia ei näy kahdesti, eikä myöhässä
// oleva nouse fokukseen automaattisesti.
//
// Aikajanan polku on tuotteen tunnusmerkki: logon joki-muoto, jossa jokainen
// tapahtuma on solmu ja nykyhetki hehkuu.

import { loggedMinutesForOccurrence } from '../timeTracking.js';
import { openRoutineLog } from './timeLog.js';
import { formatMinutes } from '../../domain/lifeArea.js';
import { fmtISO, sameDay, todayMidnight, addDays } from '../../lib/datetime.js';
import { escapeHtml, WD_FULL, formatLongDate, formatTimeRange, formatDuration } from '../../lib/format.js';
import { categoryLabel } from '../../domain/categories.js';
import { priorityLabel, priorityTone } from '../../domain/priority.js';
import { toMinutes, durationOf, deadlineUrgency, urgencyLabel, URGENCY } from '../../domain/task.js';
import { proposeSchedule, blockKindOf, isEventOccurrence, DEFAULT_TASK_MINUTES } from '../../domain/scheduler.js';
import { checkinForDate } from '../../domain/wellbeingCheckin.js';
import { todayFocus, describeFocus } from '../../domain/focus.js';
import { buildEveningReview, summarizeReview } from '../../domain/review.js';
import { entryForDate, planningLoadSuggestion, loadStateLabel, assessLoadState } from '../../domain/wellbeing.js';
import { dayGroupLabel } from '../../domain/week.js';
import { nowNext, explainRanking, CANDIDATE_KIND } from '../../domain/assistant.js';
import { el, maybe, setText, toggle } from '../../ui/dom.js';
import { getState, setViewDate } from '../state.js';
import {
  toggleComplete, deleteTask, editTask, acceptProposal,
  skipRoutineOccurrence, restoreRoutineOccurrence, saveWellbeingEntry
} from '../actions.js';
import { saveWellbeingCheckin } from '../dailyLifeActions.js';
import { openEditForm } from './tasks.js';
import { loadFailureHtml } from './loadNotice.js';
import {
  dayPlanFor, calendarRange, modelFor, renderTodayDailyLife, initTodayDailyLife, timelineKindLabel
} from './todayDailyLife.js';
import { deviceOffsetMinutes } from '../deviceTime.js';
import { lifeLoadFor, focusTaskIds } from '../lifeLoadModel.js';
import { storedMessage, slippedItems, LOAD_HORIZON } from '../../domain/lifeLoad.js';
import { protectedDaySummary, isProtectedTimeBlock } from '../../domain/protectedTime.js';
import { deferFromToday, moveToDayWithRoom } from '../mentalLoadActions.js';
import { payBillWithTransaction } from '../actions.js';
import { setTasksSegment } from '../state.js';
import { switchTab } from '../navigation.js';
import { setStoredTab } from './stored.js';
import { formatMinutes as minutesText } from '../../domain/lifeArea.js';
import { renderSundayResetEntry } from './sundayReset.js';
import { weeklyPlanFor } from '../../domain/weeklyPlan.js';
import { weekStartOf } from '../../domain/weeklyCapacity.js';

const ROW_HEIGHT = 66;

/** Nykyhetki minuutteina. Erillinen funktio, jotta sen voi korvata testeissä. */
function nowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * Kalenterin meno (myös edelliseltä päivältä jatkuva osa) tai suojattu
 * lohko. Näitä ei kuitata eikä muokata tehtävänä: meno on kiinteä, ja
 * lohko (matka, valmistautuminen, uni ...) on johdettu menosta tai unesta.
 */
function isCalendarItem(item) {
  return Boolean(blockKindOf(item)) || isEventOccurrence(item) || item.continuation === true;
}

/**
 * Päättele mikä aikajanan kohta on "nyt" ja missä tilassa.
 *
 * HUOM: automaattiset ehdotukset (Herätys/Aamutoimet/Uni) eivät koskaan tule
 * valmiiksi, joten ne on jätettävä pois myöhässä-tarkistuksesta. Muuten
 * ensimmäinen niistä jäisi jumiin myöhässä-tilaan koko loppupäiväksi eikä
 * NYT siirtyisi enää oikeisiin tehtäviin.
 *
 * Sama koskee rutiiniesiintymiä: niitä ei kuitata vaan ohitetaan, joten ne
 * eivät voi olla myöhässä.
 *
 * Ja kalenterin menoja sekä suojattuja lohkoja (valmistautuminen, matka,
 * uni ...): niitä ei kuitata koskaan. Päättynyt meno ei ole "myöhässä".
 */
export function resolveNowState(items, currentMinutes) {
  if (currentMinutes == null) return { index: -1, status: 'running' };

  const endMinuteOf = (item, index) => {
    const explicit = durationOf(item);
    if (explicit) return toMinutes(item.time) + explicit;
    for (let j = index + 1; j < items.length; j++) {
      if (items[j].time) return toMinutes(items[j].time);
    }
    return toMinutes(item.time);
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.time) continue;
    const start = toMinutes(item.time);
    const end = endMinuteOf(item, i);
    if (currentMinutes >= start && currentMinutes < end) {
      return {
        index: i,
        status: (!item.virtual && !item.isRoutine && item.completed) ? 'early' : 'running'
      };
    }
  }

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.virtual || item.isRoutine || !item.time || item.completed || isCalendarItem(item)) continue;
    if (currentMinutes >= endMinuteOf(item, i)) return { index: i, status: 'late' };
  }

  return { index: -1, status: 'running' };
}

/** Aikajanan rivit ilman suojatun ajan lohkoja (ne ovat omassa osiossaan). */
export function timelineItems(items) {
  return (items || []).filter(item => !isProtectedTimeBlock(item));
}

function timelinePath(count) {
  const xs = [28, 18, 38];
  const points = Array.from({ length: count }, (_, i) => ({
    x: xs[i % 3],
    y: ROW_HEIGHT / 2 + i * ROW_HEIGHT
  }));
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const midY = (points[i - 1].y + points[i].y) / 2;
    d += ` C${points[i - 1].x},${midY} ${points[i].x},${midY} ${points[i].x},${points[i].y}`;
  }
  return { d, points };
}

function priorityTag(item) {
  if (!item.priority || item.priority === 'normaali') return '';
  return `<span class="prio-tag prio-${priorityTone(item.priority)}">${escapeHtml(priorityLabel(item.priority))}</span>`;
}

function deadlineTag(task, todayIso) {
  const urgency = deadlineUrgency(task, todayIso);
  const label = urgencyLabel(urgency);
  if (!label) return '';
  const tone = (urgency === URGENCY.OVERDUE || urgency === URGENCY.TODAY) ? 'clay' : 'sage';
  return `<span class="prio-tag prio-${tone}">${escapeHtml(label)}</span>`;
}

// ------------------------------------------------------------- aikajana

/** Aikajanan lähteet: tyhjä aikajana ei ole "avoin päivä", jos jokin näistä ei latautunut. */
const TIMELINE_DOMAINS = Object.freeze(['tasks', 'routines', 'routineExceptions']);

function renderTimeline(container, allItems, nowState, todayIso) {
  // Suojattu aika (oma aika, vapaa-aika, loma) näkyy omassa osiossaan
  // (renderProtected): sama asia ei näy kahdesti. NYT-tila on laskettu
  // samasta suodatetusta listasta (timelineItems), joten indeksi osuu.
  const items = timelineItems(allItems);
  // Epäonnistunut lataus: pelkät automaattiset rivit (herätys, aamutoimet,
  // uni) näyttäisivät päivän tyhjältä, vaikka tehtävät ovat tallessa.
  // Suojatut lohkot (uni, rauhoittuminen) ovat samanlaisia johdettuja
  // rivejä: ne eivät kerro, että tehtävät latautuivat.
  if (!items.some(item => !item.virtual && !blockKindOf(item))) {
    const notice = loadFailureHtml(getState(), TIMELINE_DOMAINS);
    if (notice) {
      container.innerHTML = notice;
      return;
    }
  }
  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Päivä on vielä avoin.</div>
        <p>Lisää ensimmäinen asia puhepainikkeella tai Tehtävät-näkymästä.</p>
      </div>`;
    return;
  }

  const totalHeight = items.length * ROW_HEIGHT;
  const { d, points } = timelinePath(items.length);

  const badgeText = nowState.status === 'late' ? 'MYÖHÄSSÄ'
    : nowState.status === 'early' ? 'ETUAJASSA' : 'NYT';
  const statusClass = nowState.status === 'late' ? 'late'
    : nowState.status === 'early' ? 'early' : '';
  const accent = nowState.status === 'late' ? 'var(--clay)'
    : nowState.status === 'early' ? 'var(--sage)' : 'var(--gold)';

  const circles = points.map((point, i) => {
    const isNow = i === nowState.index;
    const isStart = i === 0;
    const isEnd = i === points.length - 1;
    const color = isNow ? accent : isStart ? 'var(--gold)' : isEnd ? 'var(--forest)' : 'var(--path)';
    const r = isNow ? 6.5 : (isStart || isEnd) ? 5.5 : 4;
    const opacity = (isNow || isStart || isEnd) ? 1 : 0.8;
    const pulse = isNow
      ? `<circle class="now-pulse-ring" cx="${point.x}" cy="${point.y}" r="6" fill="none" style="stroke:${accent}" stroke-width="1.5"/>`
      : '';
    return `<circle cx="${point.x}" cy="${point.y}" r="${r}" style="fill:${color}" opacity="${opacity}"/>${pulse}`;
  }).join('');

  const rows = items.map((item, i) => {
    const isNow = i === nowState.index;
    const timeLabel = formatTimeRange(item.time, item.endTime) || 'Joskus tänään';

    // Automaattiset ehdotukset: herätys, aamutoimet, uni.
    if (item.virtual) {
      return `<div class="t-item t-virtual" style="height:${ROW_HEIGHT}px">
        <span class="chk chk-virtual" aria-hidden="true"></span>
        <div class="t-body">
          <span class="t-time">${escapeHtml(timeLabel)} <span class="auto-tag">AUTO</span></span>
          <span class="t-title">${escapeHtml(item.title)}</span>
          ${item.note ? `<span class="t-sub">${escapeHtml(item.note)}</span>` : ''}
        </div>
      </div>`;
    }

    // Suojattu lohko: valmistautuminen, matka, pysäköinti ja kävely, etuaika,
    // iltarauhoittuminen ja uni. Ei vapaata aikaa eikä kuitattavaa; laji
    // kerrotaan tekstinä, ei pelkkänä värinä.
    if (blockKindOf(item)) {
      const label = timelineKindLabel(item);
      const source = item.sourceTitle ? String(item.sourceTitle) : '';
      return `<div class="t-item t-block ${isNow ? 'now ' + statusClass : ''}" style="height:${ROW_HEIGHT}px">
        <span class="block-dot" aria-hidden="true"></span>
        <div class="t-body">
          <span class="t-time">${escapeHtml(timeLabel)} <span class="kind-tag">${escapeHtml(label)}</span></span>
          <span class="t-title">${escapeHtml(source || label)}</span>
          <span class="t-sub">Suojattu aika, ei vapaata</span>
        </div>
        ${isNow ? `<span class="now-badge ${statusClass}">${badgeText}</span>` : ''}
      </div>`;
    }

    // Kalenterin meno: kiinteä sitoumus, jota ei kuitata eikä siirretä täältä.
    if (isCalendarItem(item)) {
      const place = item.locationText ? String(item.locationText) : '';
      const sub = item.continuation ? 'Jatkuu edelliseltä päivältä' : place;
      return `<div class="t-item t-event ${isNow ? 'now ' + statusClass : ''}" style="height:${ROW_HEIGHT}px">
        <span class="event-dot" aria-hidden="true"></span>
        <div class="t-body">
          <span class="t-time">${escapeHtml(timeLabel)} <span class="kind-tag">${escapeHtml(timelineKindLabel(item))}</span></span>
          <span class="t-title">${escapeHtml(item.title)}</span>
          ${sub ? `<span class="t-sub">${escapeHtml(sub)}</span>` : ''}
        </div>
        ${isNow ? `<span class="now-badge ${statusClass}">${badgeText}</span>` : ''}
      </div>`;
    }

    // Rutiiniesiintymä: erottuu tehtävästä, koska sitä ei kuitata vaan
    // ohitetaan. Kuittausruudun tilalla on ohituspainike.
    if (item.isRoutine) {
      return `<div class="t-item t-routine ${isNow ? 'now ' + statusClass : ''}" style="height:${ROW_HEIGHT}px">
        <span class="routine-dot" aria-hidden="true"></span>
        <div class="t-body">
          <span class="t-time">${escapeHtml(timeLabel)} <span class="routine-tag">RUTIINI</span></span>
          <span class="t-title">${escapeHtml(item.title)}${priorityTag(item)}</span>
          ${item.note ? `<span class="t-sub">${escapeHtml(item.note)}</span>` : ''}
        </div>
        ${routineLogButton(item.routineId, item.date, item.title)}
        <button class="skip-btn" data-skip-routine="${escapeHtml(item.routineId)}"
                data-skip-date="${escapeHtml(item.date)}"
                aria-label="Ohita tänään: ${escapeHtml(item.title)}">Ohita</button>
        ${isNow ? `<span class="now-badge ${statusClass}">${badgeText}</span>` : ''}
      </div>`;
    }

    return `<div class="t-item ${isNow ? 'now ' + statusClass : ''} ${item.completed ? 'done' : ''}" style="height:${ROW_HEIGHT}px">
      <button class="chk ${item.completed ? 'done' : ''}" data-toggle="${escapeHtml(item.id)}"
              aria-pressed="${item.completed ? 'true' : 'false'}"
              aria-label="${item.completed ? 'Merkitse keskeneräiseksi' : 'Merkitse tehdyksi'}: ${escapeHtml(item.title)}">
        <svg aria-hidden="true"><use href="#i-check"/></svg>
      </button>
      <button class="t-body t-open" data-edit="${escapeHtml(item.id)}" aria-label="Muokkaa: ${escapeHtml(item.title)}">
        <span class="t-time">${escapeHtml(timeLabel)}</span>
        <span class="t-title">${item.isWake ? '☀ ' : ''}${escapeHtml(item.title)}${priorityTag(item)}${deadlineTag(item, todayIso)}</span>
        ${item.note ? `<span class="t-sub">${escapeHtml(item.note)}</span>` : ''}
      </button>
      ${isNow ? `<span class="now-badge ${statusClass}">${badgeText}</span>` : ''}
    </div>`;
  }).join('');

  container.innerHTML = `<div class="timeline" style="height:${totalHeight}px">
    <svg class="timeline-path" viewBox="0 0 56 ${totalHeight}" style="height:${totalHeight}px"
         preserveAspectRatio="none" aria-hidden="true">
      <path d="${d}" fill="none" style="stroke:var(--path)" stroke-width="2.4" stroke-linecap="round" opacity=".5"/>
      ${circles}
    </svg>
    <div class="timeline-items">${rows}</div>
  </div>`;
}

/**
 * Rutiinin esiintymän kirjauspainike. Näyttää jo kirjatun ajan, jotta
 * käyttäjä näkee ettei kirjausta tarvita uudelleen.
 */
function routineLogButton(routineId, dateIso, title) {
  if (getState().lifeAreas.length === 0) return '';
  const logged = loggedMinutesForOccurrence(routineId, dateIso);
  const label = logged > 0 ? `Kirjattu ${formatMinutes(logged)}` : 'Kirjaa';
  return `<button class="skip-btn log-btn${logged > 0 ? ' is-logged' : ''}" data-log-routine="${escapeHtml(routineId)}"
            data-log-date="${escapeHtml(dateIso)}"
            aria-label="${escapeHtml(logged > 0 ? `Kirjattu ${formatMinutes(logged)}, lisää aikaa` : 'Kirjaa käytetty aika')}: ${escapeHtml(title)}">${escapeHtml(label)}</button>`;
}

// ---------------------------------------------------------------- fokus

/** Rauhallinen fokus: enintään kolme ja "Kaikki muu on tallessa (N)". */
function renderCalmFocus(container, load, weeklyPlan = null) {
  const stored = storedMessage(load.storedCount);
  const rows = load.now.map(entry => (entry.kind === 'bill' ? calmBillRow(entry) : calmTaskRow(entry))).join('');
  const empty = load.now.length === 0
    ? `<p class="calm-empty">${escapeHtml(load.vacation
      ? 'Olet lomalla. Joustava työ odottaa loman jälkeen.'
      : load.dayRoomMinutes === 0
        ? 'Tänään ei ole tilaa joustavalle työlle, ja se on hyvä niin.'
        : 'Tänään ei ole mitään pakollista.')}</p>`
    : '';
  const energy = load.lowEnergy
    ? '<p class="hint">Energiasi on tänään matalalla, joten päivään on varattu tavallista vähemmän.</p>' : '';
  const room = Number.isFinite(load.dayRoomMinutes) && load.now.length > 0
    ? `<p class="hint calm-room">Fokus vie noin ${escapeHtml(minutesText(load.nowMinutes))}; joustavaa aikaa on ${escapeHtml(minutesText(load.dayRoomMinutes))}.</p>`
    : '';
  // Sunnuntain nollauksessa valitut viikon prioriteetit (enintään kolme):
  // muistutus siitä, mikä on tärkeää, ei uusi lista tehtävää.
  const priorities = weeklyPlan && Array.isArray(weeklyPlan.priorities) && weeklyPlan.priorities.length
    ? `<p class="hint calm-week">Tämän viikon tärkeimmät: ${weeklyPlan.priorities.slice(0, 3).map(p => escapeHtml(p.title)).join(' · ')}</p>`
    : '';
  container.innerHTML = `
    <section class="focus-block calm-focus" aria-labelledby="calmFocusTitle">
      <h2 class="section-title" id="calmFocusTitle">Tänään keskityn <span class="count-badge">${load.now.length}/3</span></h2>
      ${priorities}${energy}
      ${rows}${empty}${room}
      <div class="calm-stored" role="note">
        <p class="calm-stored-title">${escapeHtml(stored.title)}</p>
        <p class="calm-stored-text">${escapeHtml(stored.text)}</p>
        ${load.storedCount > 0
          ? '<button type="button" class="ghost-btn small" data-open-stored="THIS_WEEK">Näytä tallessa olevat</button>'
          : ''}
      </div>
    </section>`;
}

function calmTaskRow(entry) {
  const task = entry.item;
  const reasons = entry.reasons.filter(reason => reason && reason !== 'Myöhässä').slice(0, 3).join(' · ');
  return `
    <div class="focus-row">
      <button class="chk" data-toggle="${escapeHtml(task.id)}"
              aria-label="Merkitse tehdyksi: ${escapeHtml(task.title)}">
        <svg aria-hidden="true"><use href="#i-check"/></svg>
      </button>
      <button class="t-open focus-body" data-edit="${escapeHtml(task.id)}"
              aria-label="Muokkaa: ${escapeHtml(task.title)}">
        <div class="focus-title">${escapeHtml(task.title)}</div>
        <div class="focus-reason">${escapeHtml(reasons)}</div>
      </button>
      <button type="button" class="skip-btn" data-defer-today="${escapeHtml(task.id)}"
              aria-label="Ei tänään: ${escapeHtml(task.title)}">Ei tänään</button>
    </div>`;
}

function calmBillRow(entry) {
  return `
    <div class="focus-row">
      <span class="routine-dot" aria-hidden="true"></span>
      <div class="focus-body">
        <div class="focus-title">${escapeHtml(entry.title)}</div>
        <div class="focus-reason">${escapeHtml(entry.reasons.join(' · '))}</div>
      </div>
      <button type="button" class="skip-btn" data-bill-paid="${escapeHtml(entry.id)}"
              aria-label="Merkitse maksetuksi: ${escapeHtml(entry.title)}">Maksettu</button>
    </div>`;
}

/** Aiemmilta päiviltä jääneet: yksi rauhallinen rivi (ei punaista listaa). */
function renderSlipped(container, load) {
  const slipped = slippedItems(load);
  if (slipped.length === 0) {
    container.innerHTML = '';
    return;
  }
  const count = slipped.length;
  container.innerHTML = `
    <section class="calm-slipped" aria-label="Aiemmilta päiviltä">
      <p>${escapeHtml(count === 1 ? 'Yksi asia jäi aiemmilta päiviltä.' : `${count} asiaa jäi aiemmilta päiviltä.`)}
        Ne ovat tallessa — valitse niille aika, kun ehdit.</p>
      <button type="button" class="ghost-btn small" data-open-stored="THIS_WEEK">Valitse aika</button>
    </section>`;
}

/** Suojattu aika tänään: loma, oma aika ja vapaa-aika omana osionaan. */
function renderProtected(container, state, dateIso, plan) {
  if (!container) return;
  const summary = protectedDaySummary({ periods: state.protectedPeriods || [], blocks: plan.blocks || [], dateIso });
  const parts = [];
  if (summary.vacation) {
    parts.push(`<p class="calm-vacation"><strong>Lomalla.</strong> Joustava työ ja jono odottavat loman jälkeen. Kiinteät menot näkyvät aikajanalla.</p>`);
  }
  const line = block => `<li>${escapeHtml(block.title)} ${escapeHtml(formatTimeRange(block.time, block.endTime) || '')}</li>`;
  if (summary.ownTime.length) {
    parts.push(`<div class="calm-protected-group"><div class="review-label">Oma aika (${escapeHtml(minutesText(summary.ownMinutes))})</div><ul>${summary.ownTime.map(line).join('')}</ul></div>`);
  }
  if (summary.freeTime.length) {
    parts.push(`<div class="calm-protected-group"><div class="review-label">Vapaa-aika (${escapeHtml(minutesText(summary.freeMinutes))})</div><ul>${summary.freeTime.map(line).join('')}</ul></div>`);
  }
  container.innerHTML = parts.length === 0 ? '' : `
    <section class="focus-block calm-protected" aria-labelledby="calmProtectedTitle">
      <h2 class="section-title" id="calmProtectedTitle">Suojattu aika</h2>
      ${parts.join('')}
      <p class="hint">Tähän ei sijoiteta tehtäviä.</p>
    </section>`;
}

function renderFocus(container, state, dateIso, todayIso, load = null) {
  if (load) {
    renderCalmFocus(container, load, weeklyPlanFor(state.weeklyPlans || [], weekStartOf(todayIso)));
    return;
  }
  const entries = todayFocus({ tasks: state.tasks, dateIso, todayIso, limit: 3 });

  if (entries.length === 0) {
    container.innerHTML = '';
    return;
  }

  const summary = describeFocus(entries);
  const rows = entries.map(entry => `
    <div class="focus-row">
      <button class="chk" data-toggle="${escapeHtml(entry.task.id)}"
              aria-label="Merkitse tehdyksi: ${escapeHtml(entry.task.title)}">
        <svg aria-hidden="true"><use href="#i-check"/></svg>
      </button>
      <button class="t-open focus-body" data-edit="${escapeHtml(entry.task.id)}"
              aria-label="Muokkaa: ${escapeHtml(entry.task.title)}">
        <div class="focus-title">${escapeHtml(entry.task.title)}</div>
        <div class="focus-reason">${escapeHtml(entry.reasons.join(' · '))}</div>
      </button>
    </div>`).join('');

  container.innerHTML = `
    <section class="focus-block" aria-label="Päivän tärkeimmät">
      <h2 class="section-title">Tärkeintä nyt <span class="count-badge">${entries.length}</span></h2>
      <div class="hint focus-summary">${escapeHtml(summary.text)}</div>
      ${rows}
    </section>`;
}

// ------------------------------------------------------------- myöhässä

function renderOverdue(container, plan) {
  if (plan.overdue.length === 0) {
    container.innerHTML = '';
    return;
  }

  const rows = plan.overdue.slice(0, 6).map(task => `
    <div class="task-row overdue">
      <button class="chk" data-toggle="${escapeHtml(task.id)}"
              aria-label="Merkitse tehdyksi: ${escapeHtml(task.title)}">
        <svg aria-hidden="true"><use href="#i-check"/></svg>
      </button>
      <button class="t-body t-open" data-edit="${escapeHtml(task.id)}"
              aria-label="Muokkaa: ${escapeHtml(task.title)}">
        <div class="t-title">${escapeHtml(task.title)}</div>
        <div class="t-meta">
          <span class="overdue-since">${escapeHtml(dayGroupLabel(task.deadline || task.date))}</span>
          <span class="task-cat-tag">${escapeHtml(categoryLabel(task.category))}</span>
        </div>
      </button>
    </div>`).join('');

  container.innerHTML = `
    <section class="overdue-block" aria-label="Myöhässä">
      <h2 class="section-title tone-late">Myöhässä <span class="count-badge late">${plan.overdue.length}</span></h2>
      ${rows}
      ${plan.overdue.length > 6 ? `<div class="hint">+ ${plan.overdue.length - 6} muuta</div>` : ''}
    </section>`;
}

// --------------------------------------------- aikatauluttamattomat

function renderUnscheduled(container, sourcePlan, focusIds = null) {
  // Tänään: aikatauluttamattomista näytetään vain fokuksen asiat (ne ovat
  // jo fokuksessa, joten tässä vain rutiinit). Muut ovat tallessa.
  const plan = focusIds
    ? { ...sourcePlan, unscheduled: [] }
    : sourcePlan;
  if (plan.unscheduled.length === 0 && plan.flexibleRoutines.length === 0) {
    container.innerHTML = '';
    return;
  }

  const taskRows = plan.unscheduled.map(task => {
    const duration = formatDuration(durationOf(task));
    return `<div class="task-row">
      <button class="chk" data-toggle="${escapeHtml(task.id)}"
              aria-label="Merkitse tehdyksi: ${escapeHtml(task.title)}">
        <svg aria-hidden="true"><use href="#i-check"/></svg>
      </button>
      <button class="t-body t-open" data-edit="${escapeHtml(task.id)}"
              aria-label="Muokkaa: ${escapeHtml(task.title)}">
        <div class="t-title">${escapeHtml(task.title)}${priorityTag(task)}</div>
        <div class="t-meta">
          <span class="task-cat-tag">${escapeHtml(categoryLabel(task.category))}</span>
          ${duration ? `<span>${escapeHtml(duration)}</span>` : ''}
        </div>
      </button>
    </div>`;
  }).join('');

  const routineRows = plan.flexibleRoutines.map(occurrence => `
    <div class="task-row routine-pending">
      <span class="routine-dot" aria-hidden="true"></span>
      <div class="t-body">
        <div class="t-title">${escapeHtml(occurrence.title)}<span class="routine-tag">RUTIINI</span></div>
        <div class="t-meta">
          <span>${escapeHtml(formatDuration(occurrence.durationMinutes) || '')}</span>
          <span class="task-cat-tag">${escapeHtml(categoryLabel(occurrence.category))}</span>
        </div>
      </div>
      ${routineLogButton(occurrence.routineId, occurrence.date, occurrence.title)}
      <button class="skip-btn" data-skip-routine="${escapeHtml(occurrence.routineId)}"
              data-skip-date="${escapeHtml(occurrence.date)}"
              aria-label="Ohita tänään: ${escapeHtml(occurrence.title)}">Ohita</button>
    </div>`).join('');

  const total = plan.unscheduled.length + plan.flexibleRoutines.length;

  container.innerHTML = `
    <h2 class="section-title">Odottaa aikaa <span class="count-badge">${total}</span></h2>
    <div class="section-body">${routineRows}${taskRows}</div>
    <button class="ghost-btn" id="proposeBtn">Ehdota ajat automaattisesti</button>
    <div id="proposalContainer"></div>`;
}

function renderProposals(container, result) {
  if (!container) return;

  if (result.proposals.length === 0) {
    container.innerHTML = `<div class="hint proposal-empty">${
      result.unplaced.length
        ? 'Päivä on jo täynnä. Siirrä jotain toiselle päivälle tai lyhennä kestoja.'
        : 'Ei ehdotettavaa.'
    }</div>`;
    return;
  }

  const rows = result.proposals.map(p => `
    <div class="proposal-row">
      <div class="proposal-info">
        <div class="proposal-title">${escapeHtml(p.title)}${p.kind === 'routine' ? '<span class="routine-tag">RUTIINI</span>' : ''}</div>
        <div class="proposal-time">${escapeHtml(p.time)}–${escapeHtml(p.endTime)} · ${escapeHtml(p.reason)}</div>
      </div>
      ${p.kind === 'task'
        ? `<button class="form-btn primary proposal-accept" data-accept="${escapeHtml(p.taskId)}">Hyväksy</button>`
        : '<span class="hint proposal-note">Rutiini</span>'}
    </div>`).join('');

  const unplaced = result.unplaced.length
    ? `<div class="hint proposal-empty">${result.unplaced.length} asialle ei löytynyt tilaa tänään.</div>`
    : '';

  container.innerHTML = `<div class="proposal-list">${rows}</div>${unplaced}`;
}

function renderFreeSlots(container, plan) {
  const usable = plan.freeSlots.filter(slot => slot.minutes >= DEFAULT_TASK_MINUTES);
  if (usable.length === 0 || (plan.load.count === 0 && plan.load.routines === 0 && !plan.load.events)) {
    container.innerHTML = '';
    return;
  }
  const total = usable.reduce((sum, slot) => sum + slot.minutes, 0);
  const chips = usable.slice(0, 4)
    .map(slot => `<span class="slot-chip">${escapeHtml(slot.startTime)}–${escapeHtml(slot.endTime)}</span>`)
    .join('');
  container.innerHTML = `
    <h2 class="section-title">Vapaana ${escapeHtml(formatDuration(total) || '')}</h2>
    <div class="slot-row">${chips}</div>`;
}

function renderCompleted(container, plan) {
  if (plan.completed.length === 0) {
    container.innerHTML = '';
    return;
  }
  const rows = plan.completed.map(task => `
    <div class="task-row done">
      <button class="chk done" data-toggle="${escapeHtml(task.id)}" aria-pressed="true"
              aria-label="Merkitse keskeneräiseksi: ${escapeHtml(task.title)}">
        <svg aria-hidden="true"><use href="#i-check"/></svg>
      </button>
      <button class="t-body t-open" data-edit="${escapeHtml(task.id)}" aria-label="Muokkaa: ${escapeHtml(task.title)}">
        <div class="t-title">${escapeHtml(task.title)}</div>
      </button>
    </div>`).join('');

  container.innerHTML = `
    <details class="completed-block">
      <summary class="section-title">Tehty <span class="count-badge">${plan.completed.length}</span></summary>
      <div class="section-body">${rows}</div>
    </details>`;
}

// ---------------------------------------------------------- hyvinvointi
//
// OTSIKKO ON "HYVINVOINTI", EI "MITEN MENEE?".
//
// Osio oli olemassa ja toimi, mutta käyttäjä ei löytänyt sitä. Syy ei
// ollut puuttuva näkymä vaan nimi: koko käyttöliittymässä ei esiintynyt
// sanaa "hyvinvointi" kertaakaan, joten sitä etsivä ei voinut osua
// siihen. Osio on lisäksi suljettu <details>, eli sen otsikko on ainoa
// asia joka näkyy ennen avaamista.
//
// Ystävällinen kysymys ei kadonnut -- se siirtyi sisälle vihjeeksi.
// Otsikon tehtävä on löytyä, vihjeen tehtävä on selittää.

function renderWellbeing(container, state, dateIso, plan) {
  const entry = entryForDate(state.wellbeing, dateIso);
  // Motivaatio ja hallinnan tunne omassa taulussaan (wellbeing_checkins),
  // samalla päivällä. Puuttuva arvo ei ole nolla: yhtään pistettä ei valita.
  const checkin = checkinForDate(state.wellbeingCheckins || [], dateIso);
  const suggestion = planningLoadSuggestion({ entry, plan });
  const stateLabel = loadStateLabel(assessLoadState(entry));

  const scale = (name, label, current, attribute = 'data-wb-metric') => `
    <div class="wb-metric">
      <span class="wb-label">${escapeHtml(label)}</span>
      <div class="wb-scale" role="radiogroup" aria-label="${escapeHtml(label)}">
        ${[1, 2, 3, 4, 5].map(value => `
          <button type="button" class="wb-dot ${current === value ? 'selected' : ''}"
                  ${attribute}="${name}" data-wb-value="${value}"
                  role="radio" aria-checked="${current === value ? 'true' : 'false'}"
                  aria-label="${escapeHtml(label)} ${value}">${value}</button>`).join('')}
      </div>
    </div>`;

  container.innerHTML = `
    <details class="wellbeing-block">
      <summary class="section-title">Hyvinvointi
        ${entry ? `<span class="count-badge">${escapeHtml(stateLabel)}</span>` : ''}
      </summary>
      <div class="section-body">
        ${scale('energy', 'Energia', entry ? entry.energy : null)}
        ${scale('mood', 'Mieliala', entry ? entry.mood : null)}
        ${scale('stress', 'Kuormitus', entry ? entry.stress : null)}
        ${scale('motivation', 'Motivaatio', checkin ? checkin.motivation : null, 'data-wb-checkin')}
        ${scale('control', 'Hallinnan tunne', checkin ? checkin.control : null, 'data-wb-checkin')}
        ${suggestion.suggestion
          ? `<div class="wb-suggestion ${suggestion.actionable ? 'actionable' : ''}">${escapeHtml(suggestion.suggestion)}</div>`
          : ''}
        <div class="hint">Miten menee? Merkintä on vain sinulle.
             Se ei muuta suunnitelmaasi itsestään.</div>
      </div>
    </details>`;
}

// -------------------------------------------------------- illan katsaus

function renderEveningReview(container, state, dateIso, todayIso) {
  const review = buildEveningReview({ tasks: state.tasks, dateIso, todayIso });

  if (review.stats.planned === 0 && review.tomorrowTop.length === 0) {
    container.innerHTML = '';
    return;
  }

  const moves = review.moveCandidates.length
    ? `<div class="review-group">
         <div class="review-label">Voisi siirtyä huomiselle</div>
         ${review.moveCandidates.map(task => `
           <div class="review-row">
             <span>${escapeHtml(task.title)}</span>
             <button class="ghost-btn small" data-move-task="${escapeHtml(task.id)}">Siirrä</button>
           </div>`).join('')}
       </div>`
    : '';

  const stuck = review.stuck.length
    ? `<div class="review-group">
         <div class="review-label tone-late">Määräaika painaa</div>
         ${review.stuck.map(task => `<div class="review-row"><span>${escapeHtml(task.title)}</span></div>`).join('')}
       </div>`
    : '';

  const tomorrow = review.tomorrowTop.length
    ? `<div class="review-group">
         <div class="review-label">Huomenna tärkeintä</div>
         ${review.tomorrowTop.map(entry => `
           <div class="review-row"><span>${escapeHtml(entry.task.title)}</span>
           <span class="muted">${escapeHtml(entry.reasons[0] || '')}</span></div>`).join('')}
       </div>`
    : '';

  container.innerHTML = `
    <details class="review-block">
      <summary class="section-title">Päivän katsaus</summary>
      <div class="section-body">
        <div class="review-summary">${escapeHtml(summarizeReview(review.stats))}</div>
        ${moves}${stuck}${tomorrow}
      </div>
    </details>`;
}

// ------------------------------------------------------------ kytkennät

function attachHandlers(root, dateIso) {
  root.querySelectorAll('[data-toggle]').forEach(node =>
    node.addEventListener('click', () => toggleComplete(node.dataset.toggle)));
  root.querySelectorAll('[data-edit]').forEach(node =>
    node.addEventListener('click', () => openEditForm(node.dataset.edit)));
  root.querySelectorAll('[data-del]').forEach(node =>
    node.addEventListener('click', event => {
      event.stopPropagation();
      deleteTask(node.dataset.del);
    }));

  // Rutiinin ohitus koskee VAIN tätä päivää — rutiini itse ei muutu.
  root.querySelectorAll('[data-skip-routine]').forEach(node =>
    node.addEventListener('click', () =>
      skipRoutineOccurrence(node.dataset.skipRoutine, node.dataset.skipDate)));

  // Rutiinin esiintymän kirjaus: kesto on vain ehdotus, ja esiintymän
  // identiteetti (rutiini + päivä) estää vahingossa tehdyn kaksoiskirjauksen.
  root.querySelectorAll('[data-log-routine]').forEach(node =>
    node.addEventListener('click', () =>
      openRoutineLog(node.dataset.logRoutine, node.dataset.logDate)));

  root.querySelectorAll('[data-restore-routine]').forEach(node =>
    node.addEventListener('click', () =>
      restoreRoutineOccurrence(node.dataset.restoreRoutine, node.dataset.restoreDate)));

  root.querySelectorAll('[data-wb-metric]').forEach(node =>
    node.addEventListener('click', () => {
      const current = getState();
      const existing = entryForDate(current.wellbeing, dateIso) || { date: dateIso };
      saveWellbeingEntry({
        ...existing,
        date: dateIso,
        [node.dataset.wbMetric]: Number(node.dataset.wbValue)
      });
    }));

  // Motivaatio ja hallinnan tunne: yksi rivi päivää kohti, toinen arvo säilyy.
  root.querySelectorAll('[data-wb-checkin]').forEach(node =>
    node.addEventListener('click', () => {
      saveWellbeingCheckin({ date: dateIso, [node.dataset.wbCheckin]: Number(node.dataset.wbValue) });
    }));

  // Rauhallinen tänään: "Ei tänään" (kapasiteettijarrun mukaan), laskun
  // maksu ja siirtymä Tallessa-näkymään.
  root.querySelectorAll('[data-defer-today]').forEach(node =>
    node.addEventListener('click', () =>
      deferFromToday(node.dataset.deferToday, { todayIso: fmtISO(todayMidnight()) })));
  root.querySelectorAll('[data-bill-paid]').forEach(node =>
    node.addEventListener('click', () => payBillWithTransaction(node.dataset.billPaid)));
  root.querySelectorAll('[data-open-stored]').forEach(node =>
    node.addEventListener('click', () => {
      setStoredTab(node.dataset.openStored || LOAD_HORIZON.THIS_WEEK);
      setTasksSegment('stored');
      switchTab('screen-tasks');
    }));

  // Siirto huomiselle tarkistaa kohdepäivän tilan (kapasiteettijarru):
  // täydelle päivälle ei siirretä, vaan seuraavalle, jolla on tilaa.
  root.querySelectorAll('[data-move-task]').forEach(node =>
    node.addEventListener('click', () => {
      const tomorrow = fmtISO(addDays(getState().viewDate, 1));
      moveToDayWithRoom(node.dataset.moveTask, { preferIso: tomorrow });
    }));
}

// ---------------------------------------------------------- renderöinti

/**
 * Komentokeskus: NYT ja SEURAAVA.
 *
 * =====================================================================
 * TYHJÄ ON KELVOLLINEN VASTAUS
 * =====================================================================
 *
 * Jos mitään ei ole käsillä, lohko kertoo sen eikä näytä ensimmäistä
 * mahdollista tehtävää. Keksitty "nyt" opettaisi käyttäjän epäilemään
 * kaikkia vastauksia.
 *
 * =====================================================================
 * TÄMÄ EI KORVAA FOKUSLOHKOA
 * =====================================================================
 *
 * Fokus vastaa kysymykseen "mihin keskityn tänään". Tämä vastaa
 * kysymykseen "mitä juuri nyt". Ne ovat eri kysymyksiä, ja siksi ne
 * ovat eri lohkoja: lähtöaika, erääntynyt muistutus ja käsittelemättömät
 * saapuvat eivät ole fokusta — ne ovat asioita jotka eivät odota.
 *
 * Lohko näkyy VAIN kuluvana päivänä. Eilisen "nyt" olisi merkityksetön.
 */
function renderNowNext(container, state, plan, dateIso, todayIso, isToday) {
  if (!container) return;

  if (!isToday) {
    container.innerHTML = '';
    return;
  }

  const minutes = nowMinutes();
  // Sama fokus kuin Rauhallinen tänään -lohkossa (lifeLoad): myöhässä oleva
  // tai joustava työ nousee "Nyt"-kortille vain, jos se on päivän fokuksessa.
  const load = lifeLoadFor(state, { todayIso, nowMinutes: minutes });
  const result = nowNext({
    focusTaskIds: load ? focusTaskIds(load) : null,
    tasks: state.tasks,
    reminders: state.reminders,
    travelPlans: state.travelPlans,
    routineOccurrences: plan.routineOccurrences,
    inboxItems: state.inboxItems,
    todayIso,
    nowMinutes: minutes,
    // Matkojen lähtö laitteen vyöhykkeellä (kesäajan vaihtoyö), kuten muistutuksissa.
    offsetMinutesFn: deviceOffsetMinutes
  });

  if (result.empty) {
    container.innerHTML = `
      <div class="assist-empty" id="nowNextEmpty">
        Mitään ei ole juuri nyt käsillä.
      </div>`;
    return;
  }

  const kortti = (otsikko, entry) => {
    if (!entry) return '';
    const kiire = entry.kind === CANDIDATE_KIND.DEPARTURE
      || entry.kind === CANDIDATE_KIND.OVERDUE;

    return `
      <div class="assist-row${kiire ? ' is-urgent' : ''}">
        <div class="assist-meta"><span class="assist-tag${kiire ? ' tone-late' : ''}">${escapeHtml(otsikko)}</span></div>
        <div class="assist-title">${escapeHtml(entry.title)}</div>
        <div class="assist-reason">${escapeHtml(entry.reason)}</div>
        <div class="assist-reason">${escapeHtml(explainRanking(entry, minutes))}</div>
      </div>`;
  };

  const pian = result.upcoming.length === 0 ? '' : `
    <div class="assist-row">
      <div class="assist-meta"><span class="assist-tag">Pian</span></div>
      ${result.upcoming.map(entry =>
        `<div class="assist-reason">${escapeHtml(entry.title)} — `
        + `${escapeHtml(explainRanking(entry, minutes))}</div>`).join('')}
    </div>`;

  container.innerHTML = kortti('Nyt', result.now)
    + kortti('Seuraava', result.next)
    + pian;
}

/** Renderöi koko päivänäkymä nykytilan perusteella. */
export function renderToday() {
  const state = getState();
  const now = new Date();
  const date = state.viewDate;
  const dateIso = fmtISO(date);
  const todayIso = fmtISO(todayMidnight());
  const isToday = sameDay(date, todayMidnight());

  setText('todayEyebrow', isToday ? 'TÄNÄÄN' : WD_FULL[date.getDay()].toUpperCase());
  setText('todayTitle', formatLongDate(date));
  toggle('todayJumpBtn', !isToday);

  // Kalenterin menot ja suojatut lohkot (valmistautuminen, matka, uni ...)
  // ovat aikajanalla eivätkä vapaata aikaa. Sama suunnitelma kuin
  // keskeytyksen uudelleensuunnittelussa (todayDailyLife.js). Yksi malli
  // koko piirrolle: sama päivän lähtö lasketaan vain kerran.
  const model = modelFor(state, now);
  const plan = dayPlanFor(dateIso, {
    state,
    now,
    nowMinutes: isToday ? nowMinutes() : null,
    todayIso,
    model
  });

  // Kuormituschip
  const chip = el('todayLoadChip');
  if (plan.load.count === 0 && plan.load.routines === 0 && !plan.load.events) {
    chip.textContent = 'Ei suunniteltua';
    chip.className = 'load-chip tone-sage';
  } else {
    const label = plan.load.level === 'clay' ? 'Raskas'
      : plan.load.level === 'gold' ? 'Kohtalainen' : 'Kevyt';
    chip.innerHTML = `<span class="dot ${plan.load.level || 'sage'}"></span>${escapeHtml(label)} kuormitus`;
    chip.className = 'load-chip tone-' + (plan.load.level || 'sage');
  }

  // Valmiuschip
  const completionChip = el('todayCompletionChip');
  if (plan.load.count > 0) {
    completionChip.style.display = 'inline-flex';
    completionChip.textContent = `${plan.load.completed}/${plan.load.count} tehty`;
  } else {
    completionChip.style.display = 'none';
  }

  const nowState = resolveNowState(timelineItems(plan.timeline), plan.nowMinutes);

  // Rauhallinen tänään: yksi kuormamoottori (lifeLoad) vain kuluvalle
  // päivälle. Muina päivinä näkymä on suunnitelma kyseiselle päivälle.
  const load = isToday ? lifeLoadFor(state, { todayIso, nowMinutes: plan.nowMinutes }) : null;
  const focusIds = load ? focusTaskIds(load) : null;

  renderNowNext(maybe('todayNowNext'), state, plan, dateIso, todayIso, isToday);
  renderFocus(el('todayFocus'), state, dateIso, todayIso, load);
  if (load) renderSlipped(el('todayOverdue'), load);
  else renderOverdue(el('todayOverdue'), plan);
  renderProtected(maybe('todayProtected'), state, dateIso, plan);
  // Sunnuntain nollaus: pieni kortti la–su ja maanantaiaamuna, kunnes viikko on suljettu.
  const weekReset = maybe('todayWeekReset');
  if (weekReset) {
    if (isToday) renderSundayResetEntry(weekReset, { state, now });
    else weekReset.innerHTML = '';
  }
  renderTimeline(el('todayTimelineContainer'), plan.timeline, nowState, todayIso);
  renderUnscheduled(el('todayUnscheduled'), plan, focusIds);
  renderFreeSlots(el('todayFreeSlots'), plan);
  renderCompleted(el('todayCompleted'), plan);
  renderWellbeing(el('todayWellbeing'), state, dateIso, plan);
  renderEveningReview(el('todayReview'), state, dateIso, todayIso);

  // Arjen kortit: seuraava lähtö, aamu, tavat, keskeytykset, avoimet asiat
  // ja huominen. Omat säiliöt ja kerran kytketyt kuuntelijat.
  renderTodayDailyLife({ state, now, isToday, plan: isToday ? plan : null, model, focusIds });

  attachHandlers(el('screen-today'), dateIso);

  const proposeBtn = maybe('proposeBtn');
  if (proposeBtn) {
    proposeBtn.addEventListener('click', () => {
      const current = getState();
      // Ehdotus kiertää menot, matkat ja suojatun levon kuten aikajana.
      const calendar = calendarRange(dateIso, dateIso, { state: current });
      // Tänään ehdotetaan aikoja vain fokuksen asioille: muut ovat tallessa
      // eivätkä saa kellonaikaa huomaamatta.
      const todayLoad = dateIso === todayIso ? lifeLoadFor(current, { todayIso }) : null;
      const allowed = todayLoad ? focusTaskIds(todayLoad) : null;
      const result = proposeSchedule({
        tasks: allowed
          ? current.tasks.filter(task => task.date !== dateIso || task.time || allowed.has(task.id))
          : current.tasks,
        profile: current.profile,
        dateIso,
        routines: current.routines,
        exceptions: current.routineExceptions,
        todayIso,
        events: calendar.events,
        blocks: calendar.blocks,
        nowMinutes: dateIso === todayIso ? nowMinutes() : null
      });
      const container = maybe('proposalContainer');
      renderProposals(container, result);
      if (container) {
        container.querySelectorAll('[data-accept]').forEach(node =>
          node.addEventListener('click', async () => {
            const proposal = result.proposals.find(p => p.taskId === node.dataset.accept);
            if (proposal) await acceptProposal(proposal);
          }));
      }
    });
  }
}

/** Päivänavigointi: edellinen, seuraava, paluu tähän päivään. */
export function initTodayNavigation() {
  el('todayPrev').addEventListener('click', () => setViewDate(addDays(getState().viewDate, -1)));
  el('todayNext').addEventListener('click', () => setViewDate(addDays(getState().viewDate, 1)));
  el('todayJumpBtn').addEventListener('click', () => setViewDate(todayMidnight()));

  // Arjen korttien painikkeet: kuuntelija kerran säiliöön (renderHtml ei
  // kirjoita muuttumatonta merkintää uudelleen, joten solmukohtainen
  // kytkentä joka piirrossa ei toimisi).
  initTodayDailyLife();

  // Pyyhkäisy vasemmalle/oikealle vaihtaa päivää kosketusnäytöllä.
  const screen = el('screen-today');
  let startX = 0;
  let startY = 0;
  let tracking = false;

  screen.addEventListener('touchstart', event => {
    if (event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  screen.addEventListener('touchend', event => {
    if (!tracking) return;
    tracking = false;
    const dx = event.changedTouches[0].clientX - startX;
    const dy = event.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      setViewDate(addDays(getState().viewDate, dx < 0 ? 1 : -1));
    }
  }, { passive: true });
}
