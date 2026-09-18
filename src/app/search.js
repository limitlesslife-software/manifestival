// Yhtenäinen haku: tehtävät, rutiinit, tavoitteet, projektit ja laskut.
//
// src/domain/search.js on puhdas, testattu hakumoottori. Tämä moduuli
// on ohut liima sen ja käyttöliittymän välissä: se kokoaa hakuun
// tarvittavat kokoelmat tilasta, näyttää tulokset ja vie valitun
// tuloksen oikeaan näkymään ja avaa sen muokkauslomakkeen.
//
// HAKU EI MUUTA MITÄÄN. Se on ainoa tässä tiedostossa oleva
// AI/tekoälykerroksesta riippumaton toiminto, joka koskee käyttäjän
// dataan — ja sekin vain LUKEE sitä.

import { escapeHtml } from '../lib/format.js';
import { el, maybe } from '../ui/dom.js';
import { getState, setTasksSegment, setGoalsSegment, setFinanceSegment } from './state.js';
import { switchTab } from './navigation.js';
import { searchAll, bestMatch, SEARCH_TYPE } from '../domain/search.js';
import { openEditForm } from './views/tasks.js';
import { openRoutineForm } from './views/routines.js';
import { openGoalForm } from './views/goals.js';
import { openProjectForm } from './views/projects.js';
import { openBillForm } from './views/finance.js';

/**
 * Reitti tulostyypistä: mihin näkymään ja osioon siirrytään, ja millä
 * funktiolla kohde avataan muokattavaksi.
 *
 * NIMETTY LUETTELO, EI HAKU NIMEN PERUSTEELLA — sama periaate kuin
 * src/app/capture.js:n ROUTE_ACTIONS: haku ei koskaan suorita mitä
 * tahansa vientiä, vain tästä käsin nimettyjä.
 */
export const RESULT_ROUTES = Object.freeze({
  [SEARCH_TYPE.TASK]: { screen: 'screen-tasks', segment: () => setTasksSegment('tasks'), open: openEditForm },
  [SEARCH_TYPE.ROUTINE]: { screen: 'screen-tasks', segment: () => setTasksSegment('routines'), open: openRoutineForm },
  [SEARCH_TYPE.GOAL]: { screen: 'screen-goals', segment: () => setGoalsSegment('goals'), open: openGoalForm },
  [SEARCH_TYPE.PROJECT]: { screen: 'screen-goals', segment: () => setGoalsSegment('projects'), open: openProjectForm },
  [SEARCH_TYPE.BILL]: { screen: 'screen-finance', segment: () => setFinanceSegment('bills'), open: openBillForm }
});

/** Korosta osuma indekseinä — escapetus ENSIN, merkintä VASTA SEN JÄLKEEN. */
export function highlightLabel(label, matchIndex, matchLength) {
  const text = String(label ?? '');
  if (matchIndex < 0 || matchLength <= 0 || matchIndex + matchLength > text.length) {
    return escapeHtml(text);
  }
  const before = escapeHtml(text.slice(0, matchIndex));
  const match = escapeHtml(text.slice(matchIndex, matchIndex + matchLength));
  const after = escapeHtml(text.slice(matchIndex + matchLength));
  return `${before}<mark>${match}</mark>${after}`;
}

function resultRow(result) {
  const label = highlightLabel(result.label, result.matchIndex, result.matchLength);
  return `<button class="search-result-row${result.active ? '' : ' is-inactive'}"
      type="button" data-result-id="${escapeHtml(result.id)}" data-result-type="${escapeHtml(result.type)}">
    <span>${label}</span>
  </button>`;
}

function renderResults(searchResult) {
  const container = maybe('searchResults');
  if (!container) return;

  if (searchResult.tooShort) {
    container.innerHTML = '';
    return;
  }

  if (searchResult.total === 0) {
    container.innerHTML = '<div class="search-empty">Ei osumia.</div>';
    return;
  }

  container.innerHTML = searchResult.groups.map(group => `
    <div class="search-group">
      <div class="search-group-label">${escapeHtml(group.label)}</div>
      ${group.results.map(resultRow).join('')}
    </div>`).join('');
}

/** Nykyisen hakukentän tulos. Uudelleenlasketaan joka näppäimellä. */
let currentResult = null;

function runSearch() {
  const input = maybe('searchInput');
  const query = input ? input.value : '';
  const state = getState();

  currentResult = searchAll({
    query,
    collections: {
      tasks: state.tasks,
      routines: state.routines,
      goals: state.goals,
      projects: state.projects,
      bills: state.bills
    }
  });
  renderResults(currentResult);
}

/** Siirry tulokseen: vaihda näkymä, osio, ja avaa muokkaus. */
function openResult(type, id) {
  const route = RESULT_ROUTES[type];
  if (!route) return;

  switchTab(route.screen);
  route.segment();
  route.open(id);
  closeSearch();
}

function openOverlay() {
  el('searchOverlay').classList.add('open');
  el('searchOverlay').setAttribute('aria-hidden', 'false');
}

export function closeSearch() {
  const overlay = maybe('searchOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

/** Avaa hakupaneeli ja tyhjennä edellinen haku. */
export function openSearch() {
  openOverlay();
  currentResult = null;
  const input = maybe('searchInput');
  const results = maybe('searchResults');
  if (input) input.value = '';
  if (results) results.innerHTML = '';
  if (input) input.focus();
}

/** Kytke haun tapahtumat. Kutsutaan kerran käynnistyksessä. */
export function initSearch() {
  el('searchFabBtn').addEventListener('click', openSearch);
  el('searchCloseX').addEventListener('click', closeSearch);

  el('searchOverlay').addEventListener('click', event => {
    if (event.target.id === 'searchOverlay') closeSearch();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && el('searchOverlay').classList.contains('open')) closeSearch();
  });

  el('searchInput').addEventListener('input', runSearch);

  el('searchInput').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const top = currentResult && bestMatch(currentResult);
    if (top) openResult(top.type, top.id);
  });

  maybe('searchResults').addEventListener('click', event => {
    const row = event.target.closest('[data-result-id]');
    if (!row) return;
    openResult(row.dataset.resultType, row.dataset.resultId);
  });
}
