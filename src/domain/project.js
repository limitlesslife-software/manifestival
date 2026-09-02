// Projektien domain (V2).
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// MIKÄ PROJEKTI ON TÄSSÄ
// Ei ohjelmistoprojekti vaan käyttäjän elämän kokonaisuus, joka kestää
// pidempään kuin yksi tehtävä ja lyhyempään kuin koko elämänalue:
//
//   "Taloremontti"   "Manifestivalin julkaisu"   "Yrityksen kirjanpito"
//
// SUHDE TAVOITTEESEEN
// Tavoite kertoo MIKSI, projekti kertoo MINKÄ OSANA. Sama projekti voi
// palvella tavoitetta tai olla pelkkä ryhmittely ilman tavoitetta. Siksi
// yhteys on vapaaehtoinen.
//
// ---------------------------------------------------------------------
// KAKSI SÄÄNTÖÄ, JOTKA EIVÄT JOUSTA
// ---------------------------------------------------------------------
//
// 1. PROJEKTIN EDISTYMINEN ON JOHDETTU, EI TALLENNETTU.
//    Se lasketaan tehtävistä joka kerta uudelleen. Tallennettu prosentti
//    ajautuisi väistämättä eri suuntaan kuin todellisuus, ja kaksi
//    ristiriitaista totuutta on pahempi kuin yksi epätarkka.
//
// 2. PROJEKTIN POISTO EI POISTA TEHTÄVIÄ.
//    `projectId` nollataan. Työ on tehty, vaikka sen kehys purettaisiin.
//    Kaskadoiva poisto olisi tietohäviö, jota käyttäjä ei osaa odottaa
//    eikä voi perua. Ks. `TASK_DELETE_POLICY`.

import { normalizeCategory } from './categories.js';
import { normalizePriority, priorityWeight } from './priority.js';
import { isIsoDate, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } from './task.js';
import { parseISO } from '../lib/datetime.js';

export const PROJECT_STATUS = Object.freeze({
  /** Suunniteltu, ei vielä aloitettu. */
  PLANNED: 'planned',
  ACTIVE: 'active',
  ON_HOLD: 'on_hold',
  COMPLETED: 'completed',
  ARCHIVED: 'archived'
});

export const PROJECT_STATUSES = Object.freeze(Object.values(PROJECT_STATUS));

/** Tilat, joissa projekti on vielä elossa. */
export const OPEN_PROJECT_STATUSES = Object.freeze([
  PROJECT_STATUS.PLANNED,
  PROJECT_STATUS.ACTIVE,
  PROJECT_STATUS.ON_HOLD
]);

const STATUS_LABELS = Object.freeze({
  [PROJECT_STATUS.PLANNED]: 'Suunnitteilla',
  [PROJECT_STATUS.ACTIVE]: 'Käynnissä',
  [PROJECT_STATUS.ON_HOLD]: 'Odottaa',
  [PROJECT_STATUS.COMPLETED]: 'Valmis',
  [PROJECT_STATUS.ARCHIVED]: 'Arkistoitu'
});

export function projectStatusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS[PROJECT_STATUS.ACTIVE];
}

/**
 * Projektin riskitila.
 *
 * DETERMINISTINEN JA SELITETTÄVISSÄ. Ei "AI arvioi fiiliksellä" — jokainen
 * tila seuraa säännöstä, jonka voi kertoa käyttäjälle yhdellä lauseella.
 */
export const PROJECT_RISK = Object.freeze({
  ON_TRACK: 'on_track',
  AT_RISK: 'at_risk',
  OVERDUE: 'overdue',
  /** Projekti on valmis tai arkistoitu — riskiä ei ole. */
  CLOSED: 'closed'
});

/**
 * Kuinka monta avointa tehtävää päivää kohti katsotaan liialliseksi.
 *
 * Yli yksi avoin tehtävä jäljellä olevaa päivää kohti tarkoittaa, että
 * projektin pitäisi edetä nopeammin kuin päivä kerrallaan. Se ei ole
 * mahdotonta, mutta se on syy katsoa projektia.
 */
export const AT_RISK_TASKS_PER_DAY = 1;

/** Määräajan läheisyys, jonka sisällä riskiä aletaan arvioida. */
export const AT_RISK_HORIZON_DAYS = 14;

/**
 * Poistopolitiikka tehtäville, kun projekti poistetaan.
 *
 * Vakio on olemassa, jotta valinta on näkyvä ja testattava eikä piilotettu
 * yhden funktion sisään.
 */
export const TASK_DELETE_POLICY = Object.freeze({
  /** Oletus: tehtävät säilyvät, viite nollataan. */
  UNLINK: 'unlink'
});

export function isOpenProject(project) {
  return Boolean(project) && OPEN_PROJECT_STATUSES.includes(project.status);
}

export function isArchivedProject(project) {
  return Boolean(project) && project.status === PROJECT_STATUS.ARCHIVED;
}

/** Normalisoi mielivaltainen olio projektiksi. */
export function normalizeProject(input = {}) {
  const deadline = input.deadline ?? input.targetDate;

  return {
    id: input.id != null ? String(input.id) : null,
    name: String(input.name ?? input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),
    description: input.description
      ? String(input.description).trim().slice(0, MAX_DESCRIPTION_LENGTH)
      : null,
    category: normalizeCategory(input.category),
    priority: normalizePriority(input.priority),
    status: PROJECT_STATUSES.includes(input.status) ? input.status : PROJECT_STATUS.ACTIVE,
    /** Vapaaehtoinen yhteys tavoitteeseen. */
    goalId: input.goalId != null ? String(input.goalId) : null,
    startDate: isIsoDate(input.startDate) ? input.startDate : null,
    /**
     * Projektin oma määräaika. Eri asia kuin tehtävien määräajat: projekti
     * voi olla myöhässä vaikka yksikään tehtävä ei olisi, ja päinvastoin.
     */
    deadline: isIsoDate(deadline) ? deadline : null,
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
  if (project.deadline != null && !isIsoDate(project.deadline)) {
    errors.deadline = 'Määräaika ei kelpaa.';
  }
  if (project.startDate != null && !isIsoDate(project.startDate)) {
    errors.startDate = 'Aloituspäivä ei kelpaa.';
  }
  if (project.startDate && project.deadline && project.deadline < project.startDate) {
    errors.deadline = 'Määräaika ei voi olla ennen aloitusta.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Projektiin liitetyt tehtävät. */
export function tasksForProject(tasks, projectId) {
  if (!projectId || !Array.isArray(tasks)) return [];
  return tasks.filter(task => task && task.projectId === projectId);
}

/** Päiviä määräaikaan. Negatiivinen = myöhässä. null jos ei määräaikaa. */
export function daysUntilDeadline(project, todayIso) {
  if (!project || !project.deadline || !isIsoDate(todayIso)) return null;
  const deadline = parseISO(project.deadline);
  const today = parseISO(todayIso);
  return Math.round((deadline.getTime() - today.getTime()) / 86400000);
}

/**
 * Projektin riskitila.
 *
 * SÄÄNNÖT, kaikki selitettävissä käyttäjälle yhdellä lauseella:
 *
 *   CLOSED    projekti on valmis tai arkistoitu
 *   OVERDUE   määräaika on mennyt eikä projekti ole valmis
 *   AT_RISK   määräaikaan on enintään 14 päivää JA avoimia tehtäviä on
 *             enemmän kuin jäljellä olevia päiviä
 *   ON_TRACK  kaikki muut
 *
 * Ilman määräaikaa riskiä ei voi arvioida — silloin ON_TRACK, koska
 * keksitty huoli on huonompi kuin ei huolta.
 */
export function projectRisk(project, tasks = [], todayIso) {
  if (!project) return PROJECT_RISK.ON_TRACK;
  if (project.status === PROJECT_STATUS.COMPLETED || isArchivedProject(project)) {
    return PROJECT_RISK.CLOSED;
  }

  const days = daysUntilDeadline(project, todayIso);
  if (days === null) return PROJECT_RISK.ON_TRACK;
  if (days < 0) return PROJECT_RISK.OVERDUE;

  const open = tasksForProject(tasks, project.id).filter(task => !task.completed).length;
  if (open === 0) return PROJECT_RISK.ON_TRACK;
  if (days > AT_RISK_HORIZON_DAYS) return PROJECT_RISK.ON_TRACK;

  // Jäljellä olevat päivät lasketaan vähintään yhdeksi: määräaikapäivänäkin
  // on vielä yksi päivä aikaa tehdä työ.
  const daysLeft = Math.max(1, days);
  return open > daysLeft * AT_RISK_TASKS_PER_DAY ? PROJECT_RISK.AT_RISK : PROJECT_RISK.ON_TRACK;
}

const RISK_LABELS = Object.freeze({
  [PROJECT_RISK.ON_TRACK]: 'Aikataulussa',
  [PROJECT_RISK.AT_RISK]: 'Vaarassa',
  [PROJECT_RISK.OVERDUE]: 'Myöhässä',
  [PROJECT_RISK.CLOSED]: 'Päättynyt'
});

export function projectRiskLabel(risk) {
  return RISK_LABELS[risk] || RISK_LABELS[PROJECT_RISK.ON_TRACK];
}

/**
 * Projektin tilanne yhtenä oliona.
 *
 * Projektilla ei ole omaa edistymisprosenttia — se on tehtävien summa.
 * Tyhjä projekti on 0 %, ei 100 %: aloittamaton ei ole valmis.
 */
export function summarizeProject(project, tasks = [], todayIso = null) {
  const linked = tasksForProject(tasks, project.id);
  const completed = linked.filter(task => task.completed);
  const open = linked.filter(task => !task.completed);

  const overdueTasks = todayIso
    ? open.filter(task => {
      const due = task.deadline || task.date;
      return typeof due === 'string' && due < todayIso;
    })
    : [];

  const upcoming = [...open]
    .filter(task => task.deadline || task.date)
    .sort((a, b) => String(a.deadline || a.date).localeCompare(String(b.deadline || b.date)));

  return {
    project,
    total: linked.length,
    completed: completed.length,
    open: open.length,
    /** Valmis projekti on 100 % vaikka tehtäviä jäisi — käyttäjän päätös voittaa. */
    percent: project.status === PROJECT_STATUS.COMPLETED
      ? 100
      : linked.length === 0 ? 0 : Math.round((completed.length / linked.length) * 100),
    openTasks: open,
    completedTasks: completed,
    overdueTasks,
    nextTask: upcoming[0] || null,
    daysLeft: daysUntilDeadline(project, todayIso),
    risk: projectRisk(project, tasks, todayIso)
  };
}

/**
 * Järjestys: avoimet ensin, sitten prioriteetti, sitten nimi.
 * Deterministinen.
 */
export function compareProjects(a, b) {
  const aOpen = isOpenProject(a);
  const bOpen = isOpenProject(b);
  if (aOpen !== bOpen) return aOpen ? -1 : 1;

  const byPriority = priorityWeight(a.priority) - priorityWeight(b.priority);
  if (byPriority !== 0) return byPriority;

  return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'fi');
}

/** Kaikkien projektien yhteenveto tiloittain ryhmiteltynä. */
export function summarizeProjects(projects, tasks, todayIso = null) {
  const list = (projects || [])
    .map(project => summarizeProject(project, tasks, todayIso))
    .sort((a, b) => compareProjects(a.project, b.project));

  const byStatus = status => list.filter(entry => entry.project.status === status);

  return {
    all: list,
    planned: byStatus(PROJECT_STATUS.PLANNED),
    active: byStatus(PROJECT_STATUS.ACTIVE),
    onHold: byStatus(PROJECT_STATUS.ON_HOLD),
    completed: byStatus(PROJECT_STATUS.COMPLETED),
    archived: byStatus(PROJECT_STATUS.ARCHIVED),
    open: list.filter(entry => isOpenProject(entry.project)),
    closed: list.filter(entry => !isOpenProject(entry.project)),
    atRisk: list.filter(entry => entry.risk === PROJECT_RISK.AT_RISK),
    overdue: list.filter(entry => entry.risk === PROJECT_RISK.OVERDUE)
  };
}

/**
 * Mitä projektin poisto tekee tehtäville.
 *
 * Palauttaa KUVAUKSEN, ei suorita mitään. Käyttöliittymä näyttää tämän
 * vahvistuksessa, jotta käyttäjä tietää mitä tapahtuu ennen kuin päättää.
 */
export function describeProjectDeletion(project, tasks = []) {
  const linked = tasksForProject(tasks, project.id);
  return {
    policy: TASK_DELETE_POLICY.UNLINK,
    taskCount: linked.length,
    /** Yksikään tehtävä ei poistu. Tämä on osa sopimusta, ei toteutusdetalji. */
    tasksDeleted: 0,
    message: linked.length === 0
      ? 'Projektiin ei ole liitetty tehtäviä.'
      : `${linked.length} tehtävää säilyy. Niiden yhteys tähän projektiin poistetaan.`
  };
}
