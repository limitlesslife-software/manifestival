// Projektien domain.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// MIKÄ PROJEKTI ON TÄSSÄ
// Ei ohjelmistoprojekti vaan käyttäjän elämän kokonaisuus, joka kestää
// pidempään kuin yksi tehtävä ja lyhyempään kuin koko elämänalue:
//
//   "Taloremontti"   "Manifestivalin julkaisu"   "Yrityksen kirjanpito"
//
// Konseptidokumentin luku 19 puhuu tehtävien ryhmittelystä kodin, ajoneuvojen,
// yrityksen ja kehityksen projekteihin.
//
// SUHDE TAVOITTEESEEN
// Tavoite kertoo MIKSI, projekti kertoo MINKÄ OSANA. Sama projekti voi palvella
// tavoitetta ("julkaise Manifestival marraskuussa") tai olla pelkkä ryhmittely
// ilman tavoitetta ("kodin ylläpito"). Siksi yhteys on vapaaehtoinen.

import { normalizeCategory } from './categories.js';
import { isIsoDate, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } from './task.js';

export const PROJECT_STATUS = Object.freeze({
  ACTIVE: 'active',
  ON_HOLD: 'on_hold',
  COMPLETED: 'completed',
  ARCHIVED: 'archived'
});

export const PROJECT_STATUSES = Object.freeze(Object.values(PROJECT_STATUS));

export const OPEN_PROJECT_STATUSES = Object.freeze([
  PROJECT_STATUS.ACTIVE,
  PROJECT_STATUS.ON_HOLD
]);

const STATUS_LABELS = Object.freeze({
  [PROJECT_STATUS.ACTIVE]: 'Käynnissä',
  [PROJECT_STATUS.ON_HOLD]: 'Odottaa',
  [PROJECT_STATUS.COMPLETED]: 'Valmis',
  [PROJECT_STATUS.ARCHIVED]: 'Arkistoitu'
});

export function projectStatusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS[PROJECT_STATUS.ACTIVE];
}

export function isOpenProject(project) {
  return OPEN_PROJECT_STATUSES.includes(project.status);
}

/** Normalisoi mielivaltainen olio projektiksi. */
export function normalizeProject(input = {}) {
  return {
    id: input.id != null ? String(input.id) : null,
    name: String(input.name ?? input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),
    description: input.description
      ? String(input.description).trim().slice(0, MAX_DESCRIPTION_LENGTH)
      : null,
    category: normalizeCategory(input.category),
    status: PROJECT_STATUSES.includes(input.status) ? input.status : PROJECT_STATUS.ACTIVE,
    /** Vapaaehtoinen yhteys tavoitteeseen. */
    goalId: input.goalId != null ? String(input.goalId) : null,
    targetDate: isIsoDate(input.targetDate) ? input.targetDate : null,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateProject(project) {
  const errors = {};

  const name = String(project.name ?? '').trim();
  if (!name) errors.name = 'Anna projektille nimi.';
  else if (name.length > MAX_TITLE_LENGTH) errors.name = 'Nimi on liian pitkä.';

  if (!PROJECT_STATUSES.includes(project.status)) errors.status = 'Tuntematon tila.';
  if (project.targetDate != null && !isIsoDate(project.targetDate)) {
    errors.targetDate = 'Tavoitepäivä ei kelpaa.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Projektiin liitetyt tehtävät. */
export function tasksForProject(tasks, projectId) {
  if (!projectId || !Array.isArray(tasks)) return [];
  return tasks.filter(task => task.projectId === projectId);
}

/**
 * Projektin tilanne yhtenä oliona.
 * Projektilla ei ole omaa edistymisprosenttia — se on tehtävien summa.
 */
export function summarizeProject(project, tasks = []) {
  const linked = tasksForProject(tasks, project.id);
  const completed = linked.filter(task => task.completed);
  const open = linked.filter(task => !task.completed);

  return {
    project,
    total: linked.length,
    completed: completed.length,
    open: open.length,
    percent: linked.length === 0 ? 0 : Math.round((completed.length / linked.length) * 100),
    openTasks: open,
    completedTasks: completed
  };
}

/** Järjestys: avoimet ensin, sitten nimen mukaan. Deterministinen. */
export function compareProjects(a, b) {
  const aOpen = isOpenProject(a);
  const bOpen = isOpenProject(b);
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'fi');
}

/** Kaikkien projektien yhteenveto. */
export function summarizeProjects(projects, tasks) {
  const list = (projects || [])
    .map(project => summarizeProject(project, tasks))
    .sort((a, b) => compareProjects(a.project, b.project));

  return {
    all: list,
    open: list.filter(entry => isOpenProject(entry.project)),
    closed: list.filter(entry => !isOpenProject(entry.project))
  };
}
