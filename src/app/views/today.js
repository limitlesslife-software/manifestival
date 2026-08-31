// Päivänäkymä.
//
// Käyttäjän pitää nähdä yhdellä silmäyksellä:
//   - mikä päivä on kyseessä ja miten kuormitettu se on
//   - mitä on aikataulutettu (aikajana, jossa NYT-hetki näkyy)
//   - mitä odottaa aikatauluttamista
//   - mitä on jo tehty
//   - mihin vielä mahtuisi jotain
//
// Aikajanan polku on tuotteen tunnusmerkki: logon joki-muoto, jossa jokainen
// tapahtuma on solmu ja nykyhetki hehkuu.

import { fmtISO, sameDay, todayMidnight, addDays } from '../../lib/datetime.js';
import { escapeHtml, WD_FULL, formatLongDate, formatTimeRange, formatDuration } from '../../lib/format.js';
import { categoryLabel } from '../../domain/categories.js';
import { priorityLabel, priorityTone } from '../../domain/priority.js';
import { toMinutes, durationOf } from '../../domain/task.js';
import { buildDayPlan, proposeSchedule, DEFAULT_TASK_MINUTES } from '../../domain/scheduler.js';
import { el, maybe, setText, toggle } from '../../ui/dom.js';
import { getState, setViewDate } from '../state.js';
import { toggleComplete, deleteTask, acceptProposal } from '../actions.js';
import { openEditForm } from './tasks.js';

const ROW_HEIGHT = 66;

/** Nykyhetki minuutteina. Erillinen funktio, jotta sen voi korvata testeissä. */
function nowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * Päättele mikä aikajanan kohta on "nyt" ja missä tilassa.
 *
 * HUOM: automaattiset ehdotukset (Herätys/Aamutoimet/Uni) eivät koskaan tule
 * valmiiksi, joten ne on jätettävä pois myöhässä-tarkistuksesta. Muuten
 * ensimmäinen niistä jäisi jumiin myöhässä-tilaan koko loppupäiväksi eikä
 * NYT siirtyisi enää oikeisiin tehtäviin.
 */
export function resolveNowState(items, currentMinutes) {
  if (currentMinutes == null) return { index: -1, status: 'running' };

  const endMinuteOf = (item, index) => {
    const explicit = durationOf(item);
    if (explicit) return toMinutes(item.time) + explicit;
    // Ei omaa kestoa: merkintä jatkuu seuraavaan aikataulutettuun kohtaan.
    for (let j = index + 1; j < items.length; j++) {
      if (items[j].time) return toMinutes(items[j].time);
    }
    return toMinutes(item.time);
  };

  // 1) Onko jokin kohde juuri nyt käynnissä oman aikaikkunansa perusteella?
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.time) continue;
    const start = toMinutes(item.time);
    const end = endMinuteOf(item, i);
    if (currentMinutes >= start && currentMinutes < end) {
      return {
        index: i,
        status: (!item.virtual && item.completed) ? 'early' : 'running'
      };
    }
  }

  // 2) Aukko: onko viimeisin OIKEA tehtävä jäänyt myöhässä?
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.virtual || !item.time || item.completed) continue;
    if (currentMinutes >= endMinuteOf(item, i)) return { index: i, status: 'late' };
  }

  return { index: -1, status: 'running' };
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

function renderTimeline(container, items, nowState) {
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

    const priorityTag = item.priority && item.priority !== 'normaali'
      ? `<span class="prio-tag prio-${priorityTone(item.priority)}">${escapeHtml(priorityLabel(item.priority))}</span>`
      : '';

    return `<div class="t-item ${isNow ? 'now ' + statusClass : ''} ${item.completed ? 'done' : ''}" style="height:${ROW_HEIGHT}px">
      <button class="chk ${item.completed ? 'done' : ''}" data-toggle="${escapeHtml(item.id)}"
              aria-pressed="${item.completed ? 'true' : 'false'}"
              aria-label="${item.completed ? 'Merkitse keskeneräiseksi' : 'Merkitse tehdyksi'}: ${escapeHtml(item.title)}">
        <svg aria-hidden="true"><use href="#i-check"/></svg>
      </button>
      <button class="t-body t-open" data-edit="${escapeHtml(item.id)}" aria-label="Muokkaa: ${escapeHtml(item.title)}">
        <span class="t-time">${escapeHtml(timeLabel)}</span>
        <span class="t-title">${item.isWake ? '☀ ' : ''}${escapeHtml(item.title)}${priorityTag}</span>
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

function renderUnscheduled(container, plan) {
  if (plan.unscheduled.length === 0) {
    container.innerHTML = '';
    return;
  }

  const rows = plan.unscheduled.map(task => {
    const duration = formatDuration(durationOf(task));
    const priorityTag = task.priority && task.priority !== 'normaali'
      ? `<span class="prio-tag prio-${priorityTone(task.priority)}">${escapeHtml(priorityLabel(task.priority))}</span>`
      : '';
    return `<div class="task-row">
      <button class="chk" data-toggle="${escapeHtml(task.id)}" aria-label="Merkitse tehdyksi: ${escapeHtml(task.title)}">
        <svg aria-hidden="true"><use href="#i-check"/></svg>
      </button>
      <button class="t-body t-open" data-edit="${escapeHtml(task.id)}" aria-label="Muokkaa: ${escapeHtml(task.title)}">
        <div class="t-title">${escapeHtml(task.title)}${priorityTag}</div>
        <div class="t-meta">
          <span class="task-cat-tag">${escapeHtml(categoryLabel(task.category))}</span>
          ${duration ? `<span>${escapeHtml(duration)}</span>` : ''}
        </div>
      </button>
    </div>`;
  }).join('');

  container.innerHTML = `
    <h2 class="section-title">Odottaa aikaa <span class="count-badge">${plan.unscheduled.length}</span></h2>
    <div class="section-body">${rows}</div>
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
        <div class="proposal-title">${escapeHtml(p.title)}</div>
        <div class="proposal-time">${escapeHtml(p.time)}–${escapeHtml(p.endTime)} · ${escapeHtml(p.reason)}</div>
      </div>
      <button class="form-btn primary proposal-accept" data-accept="${escapeHtml(p.taskId)}">Hyväksy</button>
    </div>`).join('');

  const unplaced = result.unplaced.length
    ? `<div class="hint proposal-empty">${result.unplaced.length} tehtävälle ei löytynyt tilaa tänään.</div>`
    : '';

  container.innerHTML = `<div class="proposal-list">${rows}</div>${unplaced}`;
}

function renderFreeSlots(container, plan) {
  const usable = plan.freeSlots.filter(slot => slot.minutes >= DEFAULT_TASK_MINUTES);
  if (usable.length === 0 || plan.load.count === 0) {
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

function attachHandlers(root) {
  root.querySelectorAll('[data-toggle]').forEach(node =>
    node.addEventListener('click', () => toggleComplete(node.dataset.toggle)));
  root.querySelectorAll('[data-edit]').forEach(node =>
    node.addEventListener('click', () => openEditForm(node.dataset.edit)));
  root.querySelectorAll('[data-del]').forEach(node =>
    node.addEventListener('click', event => {
      event.stopPropagation();
      deleteTask(node.dataset.del);
    }));
}

/** Renderöi koko päivänäkymä nykytilan perusteella. */
export function renderToday() {
  const state = getState();
  const date = state.viewDate;
  const dateIso = fmtISO(date);
  const isToday = sameDay(date, todayMidnight());

  setText('todayEyebrow', isToday ? 'TÄNÄÄN' : WD_FULL[date.getDay()].toUpperCase());
  setText('todayTitle', formatLongDate(date));
  toggle('todayJumpBtn', !isToday);

  const plan = buildDayPlan({
    tasks: state.tasks,
    profile: state.profile,
    dateIso,
    nowMinutes: isToday ? nowMinutes() : null
  });

  // Kuormituschip
  const chip = el('todayLoadChip');
  if (plan.load.count === 0) {
    chip.textContent = 'Ei suunniteltua';
    chip.className = 'load-chip tone-sage';
  } else {
    const label = plan.load.level === 'clay' ? 'Raskas'
      : plan.load.level === 'gold' ? 'Kohtalainen' : 'Kevyt';
    chip.innerHTML = `<span class="dot ${plan.load.level}"></span>${escapeHtml(label)} kuormitus`;
    chip.className = 'load-chip tone-' + plan.load.level;
  }

  // Valmiuschip
  const completionChip = el('todayCompletionChip');
  if (plan.load.count > 0) {
    completionChip.style.display = 'inline-flex';
    completionChip.textContent = `${plan.load.completed}/${plan.load.count} tehty`;
  } else {
    completionChip.style.display = 'none';
  }

  const nowState = resolveNowState(plan.timeline, plan.nowMinutes);
  renderTimeline(el('todayTimelineContainer'), plan.timeline, nowState);
  renderUnscheduled(el('todayUnscheduled'), plan);
  renderFreeSlots(el('todayFreeSlots'), plan);
  renderCompleted(el('todayCompleted'), plan);

  attachHandlers(el('screen-today'));

  // Ehdotuspainike
  const proposeBtn = maybe('proposeBtn');
  if (proposeBtn) {
    proposeBtn.addEventListener('click', () => {
      const result = proposeSchedule({
        tasks: getState().tasks,
        profile: getState().profile,
        dateIso
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
