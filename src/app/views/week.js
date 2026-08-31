// Viikkonäkymä.
//
// Viikkonauha näyttää kuormituksen yhdellä silmäyksellä ja päivän
// valitseminen avaa sen päivänäkymään. Alla viikon tehtävät päivittäin
// ryhmiteltynä.
//
// Kaikki viikkologiikka (rajat, ryhmittely, otsikot) on domain/week.js:ssä,
// jotta rajatapaukset — sunnuntai, kuukauden vaihde, vuodenvaihde — voidaan
// testata ilman selainta.

import { addDays, sameDay, todayMidnight, parseISO, loadClass } from '../../lib/datetime.js';
import { escapeHtml, WD_SHORT, formatTimeRange } from '../../lib/format.js';
import { categoryLabel } from '../../domain/categories.js';
import { priorityLabel, priorityTone } from '../../domain/priority.js';
import { weekDayIsoList, weekRangeLabel, weekSummary, groupByDate, dayGroupLabel } from '../../domain/week.js';
import { el, setText } from '../../ui/dom.js';
import { getState, setWeekStart, setViewDate } from '../state.js';
import { toggleComplete } from '../actions.js';
import { openEditForm } from './tasks.js';
import { switchTab } from '../navigation.js';

function renderStrip(container, state) {
  const summary = weekSummary(state.weekStart, state.tasks);
  const today = todayMidnight();

  container.innerHTML = summary.map(day => {
    const isToday = sameDay(day.date, today);
    const isViewed = sameDay(day.date, state.viewDate);
    const level = loadClass(day.total);
    const dot = level
      ? `<span class="dot ${level}"></span>`
      : '<span class="dot-empty"></span>';
    const flag = day.hasHighPriority ? '<span class="prio-flag" aria-hidden="true"></span>' : '';

    return `<button class="day-col ${isToday ? 'today' : ''} ${isViewed ? 'viewed' : ''}"
        data-date="${day.iso}"
        aria-label="${WD_SHORT[day.date.getDay()]} ${day.date.getDate()}. — ${day.total} tehtävää, ${day.completed} tehty"
        aria-current="${isToday ? 'date' : 'false'}">
      <span class="day-name">${WD_SHORT[day.date.getDay()]}</span>
      <span class="day-num">${day.date.getDate()}</span>
      ${dot}${flag}
    </button>`;
  }).join('');

  container.querySelectorAll('.day-col').forEach(node => {
    node.addEventListener('click', () => {
      setViewDate(parseISO(node.dataset.date));
      switchTab('screen-today');
    });
  });
}

function renderList(container, state) {
  const isoDays = weekDayIsoList(state.weekStart);
  const weekTasks = state.tasks.filter(task => isoDays.includes(task.date));

  if (weekTasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Viikko on vielä tyhjä.</div>
        <p>Valitse päivä yltä ja lisää ensimmäinen asia.</p>
      </div>`;
    return;
  }

  const groups = groupByDate(weekTasks);
  let html = '';

  for (const [dateIso, tasks] of groups) {
    const done = tasks.filter(t => t.completed).length;
    html += `<div class="date-group-label">
      ${escapeHtml(dayGroupLabel(dateIso))}
      <span class="group-count">${done}/${tasks.length}</span>
    </div>`;

    html += tasks.map(task => {
      const timeLabel = formatTimeRange(task.time, task.endTime);
      const priorityTag = task.priority && task.priority !== 'normaali'
        ? `<span class="prio-tag prio-${priorityTone(task.priority)}">${escapeHtml(priorityLabel(task.priority))}</span>`
        : '';
      return `<div class="task-row ${task.completed ? 'done' : ''}">
        <button class="chk ${task.completed ? 'done' : ''}" data-toggle="${escapeHtml(task.id)}"
                aria-pressed="${task.completed ? 'true' : 'false'}"
                aria-label="${task.completed ? 'Merkitse keskeneräiseksi' : 'Merkitse tehdyksi'}: ${escapeHtml(task.title)}">
          <svg aria-hidden="true"><use href="#i-check"/></svg>
        </button>
        <button class="t-body t-open" data-edit="${escapeHtml(task.id)}" aria-label="Muokkaa: ${escapeHtml(task.title)}">
          <div class="t-title">${task.isWake ? '☀ ' : ''}${escapeHtml(task.title)}${priorityTag}</div>
          <div class="t-meta">
            ${timeLabel ? `<span>${escapeHtml(timeLabel)}</span>` : '<span class="muted">ei aikaa</span>'}
            <span class="task-cat-tag">${escapeHtml(categoryLabel(task.category))}</span>
          </div>
        </button>
      </div>`;
    }).join('');
  }

  container.innerHTML = html;

  container.querySelectorAll('[data-toggle]').forEach(node =>
    node.addEventListener('click', () => toggleComplete(node.dataset.toggle)));
  container.querySelectorAll('[data-edit]').forEach(node =>
    node.addEventListener('click', () => openEditForm(node.dataset.edit)));
}

/** Renderöi viikkonäkymä nykytilan perusteella. */
export function renderWeek() {
  const state = getState();
  setText('weekRangeLabel', weekRangeLabel(state.weekStart));
  renderStrip(el('weekStripContainer'), state);
  renderList(el('weekListContainer'), state);
}

/** Viikkonavigointi. */
export function initWeekNavigation() {
  el('weekPrev').addEventListener('click', () =>
    setWeekStart(addDays(getState().weekStart, -7)));
  el('weekNext').addEventListener('click', () =>
    setWeekStart(addDays(getState().weekStart, 7)));
}
