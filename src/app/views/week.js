// Viikkonäkymä (Kalenteri-välilehden Viikko-osio; osiot ja viikon menot
// ovat calendar.js:ssä, tämä piirtää vanhan viikkonäkymän ennallaan).
//
// Viikko vastaa eri kysymykseen kuin päivä. Päivä kysyy "mitä nyt", viikko
// kysyy "onko tämä realistista". Siksi näkymä näyttää kuormituksen, määräajat,
// rästit ja tavoitteiden etenemisen — ei vain listaa tehtävistä.
//
// Kaikki viikkologiikka (rajat, ryhmittely, otsikot) on domain-moduuleissa,
// jotta rajatapaukset — sunnuntai, kuukauden vaihde, vuodenvaihde — voidaan
// testata ilman selainta.

import { fmtISO, addDays, sameDay, todayMidnight, loadClass } from '../../lib/datetime.js';
import { escapeHtml, WD_SHORT, formatTimeRange } from '../../lib/format.js';
import { categoryLabel } from '../../domain/categories.js';
import { priorityLabel, priorityTone } from '../../domain/priority.js';
import { deadlineUrgency, urgencyLabel, URGENCY } from '../../domain/task.js';
import {
  weekDayIsoList, weekRangeLabel, weekSummary, groupByDate, dayGroupLabel
} from '../../domain/week.js';
import { expandRoutines } from '../../domain/routine.js';
import { buildWeeklyReview, summarizeReview } from '../../domain/review.js';
import { el, maybe, setText } from '../../ui/dom.js';
import { getState, setWeekStart, showCalendarDay } from '../state.js';
import { toggleComplete } from '../actions.js';
import { openEditForm } from './tasks.js';
import { loadFailureHtml } from './loadNotice.js';

// ------------------------------------------------------------ viikkonauha

function renderStrip(container, state, routineOccurrences) {
  const summary = weekSummary(state.weekStart, state.tasks);
  const today = todayMidnight();

  // Rutiinit lasketaan kuormitukseen mukaan: ne vievät oikeaa aikaa.
  const routinesByDay = new Map();
  for (const occurrence of routineOccurrences) {
    routinesByDay.set(occurrence.date, (routinesByDay.get(occurrence.date) || 0) + 1);
  }

  container.innerHTML = summary.map(day => {
    const isToday = sameDay(day.date, today);
    const isViewed = sameDay(day.date, state.viewDate);
    const routineCount = routinesByDay.get(day.iso) || 0;
    const level = loadClass(day.total + routineCount);

    const dot = level ? `<span class="dot ${level}"></span>` : '<span class="dot-empty"></span>';
    const flag = day.hasHighPriority ? '<span class="prio-flag" aria-hidden="true"></span>' : '';

    return `<button class="day-col ${isToday ? 'today' : ''} ${isViewed ? 'viewed' : ''}"
        data-date="${day.iso}"
        aria-label="${WD_SHORT[day.date.getDay()]} ${day.date.getDate()}. — ${day.total} tehtävää, ${routineCount} rutiinia, ${day.completed} tehty"
        aria-current="${isToday ? 'date' : 'false'}">
      <span class="day-name">${WD_SHORT[day.date.getDay()]}</span>
      <span class="day-num">${day.date.getDate()}</span>
      ${dot}${flag}
    </button>`;
  }).join('');

  // Päivän napautus avaa kalenterin Päivä-osion samalle päivälle: ollaan
  // jo Kalenteri-välilehdellä, joten päivän aikataulu näkyy tässä, samalla
  // suunnitelmalla kuin Tänään-näkymässä.
  container.querySelectorAll('.day-col').forEach(node => {
    node.addEventListener('click', () => {
      showCalendarDay(node.dataset.date);
      const title = maybe('calTitle');
      if (title && typeof title.focus === 'function') title.focus();
    });
  });
}

/** ISO-viikon numero maanantaista: viikko kuuluu vuodelle, jolla sen torstai on. */
export function isoWeekNumber(monday) {
  const thursday = addDays(monday, 3);
  const firstOfYear = new Date(thursday.getFullYear(), 0, 1);
  // Pyöristys: kesäaika tekee vuorokaudesta 23 tai 25 tuntia.
  return Math.floor(Math.round((thursday - firstOfYear) / 86400000) / 7) + 1;
}

// ------------------------------------------------------------ yhteenveto

function renderSummary(container, review) {
  const { stats } = review;

  const cards = [
    { value: stats.planned, label: 'suunniteltu' },
    { value: stats.completed, label: 'valmiina' },
    { value: stats.open, label: 'avoinna' },
    { value: stats.overdue, label: 'myöhässä', tone: stats.overdue > 0 ? 'late' : '' }
  ];

  container.innerHTML = `
    <div class="week-stats">
      ${cards.map(card => `
        <div class="week-stat ${card.tone || ''}">
          <strong>${card.value}</strong>
          <span>${escapeHtml(card.label)}</span>
        </div>`).join('')}
    </div>
    <div class="hint week-summary-text">${escapeHtml(summarizeReview(stats))}</div>`;
}

// ------------------------------------------------------------ määräajat

function renderDeadlines(container, state, todayIso) {
  const withDeadlines = state.tasks
    .filter(task => !task.completed && task.deadline)
    .map(task => ({ task, urgency: deadlineUrgency(task, todayIso) }))
    .filter(entry => entry.urgency !== URGENCY.NONE && entry.urgency !== URGENCY.LATER)
    .sort((a, b) => String(a.task.deadline).localeCompare(String(b.task.deadline)));

  if (withDeadlines.length === 0) {
    container.innerHTML = '';
    return;
  }

  const rows = withDeadlines.slice(0, 6).map(({ task, urgency }) => {
    const tone = (urgency === URGENCY.OVERDUE || urgency === URGENCY.TODAY) ? 'clay' : 'sage';
    return `<div class="deadline-row">
      <button class="t-open deadline-body" data-edit="${escapeHtml(task.id)}"
              aria-label="Muokkaa: ${escapeHtml(task.title)}">
        <span class="deadline-title">${escapeHtml(task.title)}</span>
        <span class="prio-tag prio-${tone}">${escapeHtml(urgencyLabel(urgency))}</span>
      </button>
      <span class="deadline-date">${escapeHtml(dayGroupLabel(task.deadline))}</span>
    </div>`;
  }).join('');

  container.innerHTML = `
    <h2 class="section-title">Määräajat <span class="count-badge">${withDeadlines.length}</span></h2>
    <div class="section-body">${rows}</div>`;
}

// ------------------------------------------------------------ tavoitteet

function renderGoalProgress(container, review) {
  if (review.goalProgress.length === 0) {
    container.innerHTML = '';
    return;
  }

  const rows = review.goalProgress.slice(0, 4).map(entry => `
    <div class="week-goal ${entry.overdue ? 'late' : ''}">
      <div class="week-goal-head">
        <span class="week-goal-title">${escapeHtml(entry.goal.title)}</span>
        <span class="week-goal-percent">${entry.progress.percent} %</span>
      </div>
      <div class="progress">
        <div class="progress-fill ${entry.progress.percent >= 100 ? 'done' : entry.progress.percent >= 50 ? 'good' : 'start'}"
             style="width:${Math.max(0, Math.min(100, entry.progress.percent))}%"></div>
      </div>
    </div>`).join('');

  container.innerHTML = `
    <h2 class="section-title">Tavoitteet <span class="count-badge">${review.goalProgress.length}</span></h2>
    <div class="section-body">${rows}</div>`;
}

// ------------------------------------------------------------ viikon lista

function renderList(container, state, routineOccurrences) {
  const isoDays = weekDayIsoList(state.weekStart);
  const weekTasks = state.tasks.filter(task => isoDays.includes(task.date));

  if (weekTasks.length === 0 && routineOccurrences.length === 0) {
    // Epäonnistunut ensimmäinen lataus ei ole "tyhjä viikko".
    const notice = loadFailureHtml(state, ['tasks', 'routines', 'routineExceptions']);
    if (notice) {
      container.innerHTML = notice;
      return;
    }
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Viikko on vielä tyhjä.</div>
        <p>Valitse päivä yltä ja lisää ensimmäinen asia.</p>
      </div>`;
    return;
  }

  const groups = groupByDate(weekTasks);
  const routinesByDay = new Map();
  for (const occurrence of routineOccurrences) {
    if (!routinesByDay.has(occurrence.date)) routinesByDay.set(occurrence.date, []);
    routinesByDay.get(occurrence.date).push(occurrence);
  }

  let html = '';

  for (const dateIso of isoDays) {
    const tasks = groups.get(dateIso) || [];
    const routines = routinesByDay.get(dateIso) || [];
    if (tasks.length === 0 && routines.length === 0) continue;

    const done = tasks.filter(t => t.completed).length;
    html += `<div class="date-group-label">
      ${escapeHtml(dayGroupLabel(dateIso))}
      <span class="group-count">${done}/${tasks.length}</span>
    </div>`;

    html += routines.map(occurrence => `
      <div class="task-row routine-pending">
        <span class="routine-dot" aria-hidden="true"></span>
        <div class="t-body">
          <div class="t-title">${escapeHtml(occurrence.title)}<span class="routine-tag">RUTIINI</span></div>
          <div class="t-meta">
            ${occurrence.time ? `<span>${escapeHtml(occurrence.time)}</span>` : '<span class="muted">joustava</span>'}
            <span class="task-cat-tag">${escapeHtml(categoryLabel(occurrence.category))}</span>
          </div>
        </div>
      </div>`).join('');

    html += tasks.map(task => {
      const timeLabel = formatTimeRange(task.time, task.endTime);
      const priorityMark = task.priority && task.priority !== 'normaali'
        ? `<span class="prio-tag prio-${priorityTone(task.priority)}">${escapeHtml(priorityLabel(task.priority))}</span>`
        : '';
      const deadlineMark = task.deadline
        ? `<span class="prio-tag prio-sage">${escapeHtml(task.deadline)}</span>` : '';

      return `<div class="task-row ${task.completed ? 'done' : ''}">
        <button class="chk ${task.completed ? 'done' : ''}" data-toggle="${escapeHtml(task.id)}"
                aria-pressed="${task.completed ? 'true' : 'false'}"
                aria-label="${task.completed ? 'Merkitse keskeneräiseksi' : 'Merkitse tehdyksi'}: ${escapeHtml(task.title)}">
          <svg aria-hidden="true"><use href="#i-check"/></svg>
        </button>
        <button class="t-body t-open" data-edit="${escapeHtml(task.id)}" aria-label="Muokkaa: ${escapeHtml(task.title)}">
          <div class="t-title">${task.isWake ? '☀ ' : ''}${escapeHtml(task.title)}${priorityMark}</div>
          <div class="t-meta">
            ${timeLabel ? `<span>${escapeHtml(timeLabel)}</span>` : '<span class="muted">ei aikaa</span>'}
            <span class="task-cat-tag">${escapeHtml(categoryLabel(task.category))}</span>
            ${deadlineMark}
          </div>
        </button>
      </div>`;
    }).join('');
  }

  container.innerHTML = html;
}

// ------------------------------------------------------------ viikkokatsaus

function renderReview(container, review) {
  if (review.stats.planned === 0 && review.nextWeekTop.length === 0) {
    container.innerHTML = '';
    return;
  }

  const next = review.nextWeekTop.length
    ? `<div class="review-group">
         <div class="review-label">Ensi viikolla tärkeintä</div>
         ${review.nextWeekTop.map(entry => `
           <div class="review-row">
             <span>${escapeHtml(entry.task.title)}</span>
             <span class="muted">${escapeHtml(entry.reasons[0] || '')}</span>
           </div>`).join('')}
       </div>`
    : '';

  const busiest = review.stats.busiestDay
    ? `<div class="review-row"><span>Kuormittavin päivä</span>
       <span class="muted">${escapeHtml(dayGroupLabel(review.stats.busiestDay))}</span></div>`
    : '';

  container.innerHTML = `
    <details class="review-block">
      <summary class="section-title">Viikkokatsaus</summary>
      <div class="section-body">
        ${busiest}
        ${next}
      </div>
    </details>`;
}

// ------------------------------------------------------------ renderöinti

/** Renderöi viikkonäkymä nykytilan perusteella. */
export function renderWeek() {
  const state = getState();
  const isoDays = weekDayIsoList(state.weekStart);
  const todayIso = fmtISO(todayMidnight());

  setText('weekRangeLabel', `Viikko ${isoWeekNumber(state.weekStart)} · ${weekRangeLabel(state.weekStart)}`);

  const routineOccurrences = expandRoutines({
    routines: state.routines,
    from: isoDays[0],
    to: isoDays[6],
    exceptions: state.routineExceptions
  });

  const review = buildWeeklyReview({
    tasks: state.tasks,
    goals: state.goals,
    weekStartIso: isoDays[0],
    todayIso
  });

  renderStrip(el('weekStripContainer'), state, routineOccurrences);
  renderSummary(el('weekSummary'), review);
  renderDeadlines(el('weekDeadlines'), state, todayIso);
  renderGoalProgress(el('weekGoals'), review);
  renderList(el('weekListContainer'), state, routineOccurrences);
  renderReview(el('weekReview'), review);

  // Kytkennät kerralla koko näkymälle — listat on juuri korvattu, joten
  // kuuntelijat eivät kasaannu.
  const screen = el('screen-week');
  screen.querySelectorAll('[data-toggle]').forEach(node =>
    node.addEventListener('click', () => toggleComplete(node.dataset.toggle)));
  screen.querySelectorAll('[data-edit]').forEach(node =>
    node.addEventListener('click', () => openEditForm(node.dataset.edit)));
}

/** Viikkonavigointi. */
export function initWeekNavigation() {
  el('weekPrev').addEventListener('click', () =>
    setWeekStart(addDays(getState().weekStart, -7)));
  el('weekNext').addEventListener('click', () =>
    setWeekStart(addDays(getState().weekStart, 7)));
}
