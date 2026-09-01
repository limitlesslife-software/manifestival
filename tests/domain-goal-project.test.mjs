// Tavoitteiden, projektien ja määräaikojen testit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GOAL_STATUS, PROGRESS_MODE, normalizeGoal, validateGoal, computeGoalProgress,
  tasksForGoal, isGoalOverdue, daysUntilTarget, compareGoals, summarizeGoals,
  isOpenGoal, goalStatusLabel
} from '../src/domain/goal.js';
import {
  PROJECT_STATUS, normalizeProject, validateProject, tasksForProject,
  summarizeProject, summarizeProjects, isOpenProject, projectStatusLabel
} from '../src/domain/project.js';
import {
  normalizeTask, validateTask, isOverdue, daysUntilDeadline, deadlineUrgency,
  urgencyWeight, urgencyLabel, overdueTasks, URGENCY, SOON_DAYS
} from '../src/domain/task.js';

const TODAY = '2026-09-01';

const goal = (over = {}) => normalizeGoal({
  id: 'g1', title: 'Julkaise Manifestival', category: 'kehitys', ...over
});

const project = (over = {}) => normalizeProject({
  id: 'p1', name: 'Taloremontti', category: 'koti', ...over
});

const task = (over = {}) => normalizeTask({
  id: 't1', title: 'Tehtävä', date: TODAY, ...over
});

// ============================================================ TAVOITTEET

test('normalizeGoal antaa turvalliset oletukset', () => {
  const g = normalizeGoal({ id: 'x', title: '  Tavoite  ' });
  assert.equal(g.title, 'Tavoite');
  assert.equal(g.status, GOAL_STATUS.ACTIVE);
  assert.equal(g.progressMode, PROGRESS_MODE.TASK_BASED, 'oletus on johdettu edistyminen');
  assert.equal(g.manualProgress, 0);
});

test('normalizeGoal hylkää tuntemattoman tilan ja edistymistavan', () => {
  const g = normalizeGoal({ id: 'x', title: 'T', status: 'keksitty', progressMode: 'taika' });
  assert.equal(g.status, GOAL_STATUS.ACTIVE);
  assert.equal(g.progressMode, PROGRESS_MODE.TASK_BASED);
});

test('manuaalinen edistyminen rajataan välille 0–100', () => {
  assert.equal(normalizeGoal({ id: 'x', title: 'T', manualProgress: 150 }).manualProgress, 100);
  assert.equal(normalizeGoal({ id: 'x', title: 'T', manualProgress: -20 }).manualProgress, 0);
  assert.equal(normalizeGoal({ id: 'x', title: 'T', manualProgress: 'roska' }).manualProgress, 0);
});

test('validateGoal vaatii nimen', () => {
  assert.equal(validateGoal(goal()).valid, true);
  assert.ok(validateGoal(goal({ title: '  ' })).errors.title);
});

test('tavoite ei voi olla oma ylätavoitteensa', () => {
  const g = goal({ parentGoalId: 'g1' });
  assert.ok(validateGoal(g).errors.parentGoalId);
});

test('goalStatusLabel ja isOpenGoal', () => {
  assert.equal(goalStatusLabel(GOAL_STATUS.ACTIVE), 'Työn alla');
  assert.equal(goalStatusLabel('tuntematon'), 'Työn alla');
  assert.equal(isOpenGoal(goal()), true);
  assert.equal(isOpenGoal(goal({ status: GOAL_STATUS.COMPLETED })), false);
});

// ------------------------------------------------------- edistyminen

test('TASK_BASED: edistyminen johdetaan tehtävien tilasta', () => {
  const tasks = [
    task({ id: 'a', goalId: 'g1', completed: true }),
    task({ id: 'b', goalId: 'g1', completed: true }),
    task({ id: 'c', goalId: 'g1', completed: false }),
    task({ id: 'd', goalId: 'g1', completed: false })
  ];
  const progress = computeGoalProgress(goal(), tasks);
  assert.equal(progress.percent, 50);
  assert.equal(progress.completed, 2);
  assert.equal(progress.total, 4);
  assert.equal(progress.derived, true);
});

test('RAJATAPAUS: tavoite ilman tehtäviä on 0 %, ei 100 %', () => {
  // Naiivi toteutus laskisi 0/0 ja päätyisi NaN:iin tai 100 prosenttiin.
  // Tyhjä joukko ei ole saavutus.
  const progress = computeGoalProgress(goal(), []);
  assert.equal(progress.percent, 0);
  assert.equal(progress.total, 0);
  assert.ok(Number.isFinite(progress.percent));
});

test('edistyminen laskee vain omaan tavoitteeseen liitetyt tehtävät', () => {
  const tasks = [
    task({ id: 'a', goalId: 'g1', completed: true }),
    task({ id: 'b', goalId: 'toinen', completed: false }),
    task({ id: 'c', goalId: null, completed: false })
  ];
  const progress = computeGoalProgress(goal(), tasks);
  assert.equal(progress.total, 1);
  assert.equal(progress.percent, 100);
});

test('kaikki tehtävät valmiina antaa 100 %', () => {
  const tasks = [
    task({ id: 'a', goalId: 'g1', completed: true }),
    task({ id: 'b', goalId: 'g1', completed: true })
  ];
  assert.equal(computeGoalProgress(goal(), tasks).percent, 100);
});

test('MANUAL: käyttäjän luku voittaa tehtävät', () => {
  const g = goal({ progressMode: PROGRESS_MODE.MANUAL, manualProgress: 70 });
  const tasks = [task({ id: 'a', goalId: 'g1', completed: false })];
  const progress = computeGoalProgress(g, tasks);
  assert.equal(progress.percent, 70);
  assert.equal(progress.derived, false);
});

test('saavutettu tavoite on aina 100 % vaikka tehtäviä olisi kesken', () => {
  // Käyttäjän nimenomainen päätös voittaa lasketun arvon — sama periaate
  // kuin aikataulutuksessa.
  const g = goal({ status: GOAL_STATUS.COMPLETED });
  const tasks = [
    task({ id: 'a', goalId: 'g1', completed: false }),
    task({ id: 'b', goalId: 'g1', completed: false })
  ];
  const progress = computeGoalProgress(g, tasks);
  assert.equal(progress.percent, 100);
  assert.equal(progress.derived, false);
});

test('edistyminen pyöristetään kokonaisluvuksi', () => {
  const tasks = [
    task({ id: 'a', goalId: 'g1', completed: true }),
    task({ id: 'b', goalId: 'g1', completed: false }),
    task({ id: 'c', goalId: 'g1', completed: false })
  ];
  const progress = computeGoalProgress(goal(), tasks);
  assert.equal(progress.percent, 33);
  assert.equal(Number.isInteger(progress.percent), true);
});

test('tasksForGoal kestää puuttuvat arvot', () => {
  assert.deepEqual(tasksForGoal(null, 'g1'), []);
  assert.deepEqual(tasksForGoal([task()], null), []);
});

// ------------------------------------------------------- tavoitepäivä

test('tavoite on myöhässä tavoitepäivän jälkeen', () => {
  assert.equal(isGoalOverdue(goal({ targetDate: '2026-08-31' }), TODAY), true);
  assert.equal(isGoalOverdue(goal({ targetDate: TODAY }), TODAY), false, 'tänään ei ole myöhässä');
  assert.equal(isGoalOverdue(goal({ targetDate: '2026-09-02' }), TODAY), false);
  assert.equal(isGoalOverdue(goal(), TODAY), false, 'ilman tavoitepäivää ei ole myöhässä');
});

test('saavutettu tai arkistoitu tavoite ei ole myöhässä', () => {
  assert.equal(isGoalOverdue(goal({ targetDate: '2026-01-01', status: GOAL_STATUS.COMPLETED }), TODAY), false);
  assert.equal(isGoalOverdue(goal({ targetDate: '2026-01-01', status: GOAL_STATUS.ARCHIVED }), TODAY), false);
});

test('daysUntilTarget laskee päivät molempiin suuntiin', () => {
  assert.equal(daysUntilTarget(goal({ targetDate: '2026-09-08' }), TODAY), 7);
  assert.equal(daysUntilTarget(goal({ targetDate: TODAY }), TODAY), 0);
  assert.equal(daysUntilTarget(goal({ targetDate: '2026-08-30' }), TODAY), -2);
  assert.equal(daysUntilTarget(goal(), TODAY), null);
});

test('daysUntilTarget toimii kuukauden ja vuoden vaihteen yli', () => {
  assert.equal(daysUntilTarget(goal({ targetDate: '2026-10-01' }), '2026-09-30'), 1);
  assert.equal(daysUntilTarget(goal({ targetDate: '2027-01-01' }), '2026-12-31'), 1);
});

// --------------------------------------------------------- järjestys

test('compareGoals: avoimet ennen suljettuja, myöhässä olevat ensin', () => {
  const goals = [
    goal({ id: 'valmis', title: 'Valmis', status: GOAL_STATUS.COMPLETED }),
    goal({ id: 'normaali', title: 'Normaali' }),
    goal({ id: 'myohassa', title: 'Myöhässä', targetDate: '2026-08-01' })
  ];
  const sorted = [...goals].sort((a, b) => compareGoals(a, b, TODAY));
  assert.deepEqual(sorted.map(g => g.id), ['myohassa', 'normaali', 'valmis']);
});

test('TAKUU: tavoitteiden järjestys on deterministinen', () => {
  const goals = [
    goal({ id: 'b', title: 'Beeta' }),
    goal({ id: 'a', title: 'Alfa' }),
    goal({ id: 'c', title: 'Gamma' })
  ];
  const first = [...goals].sort((a, b) => compareGoals(a, b, TODAY)).map(g => g.id);
  const second = [...goals].reverse().sort((a, b) => compareGoals(a, b, TODAY)).map(g => g.id);
  assert.deepEqual(first, ['a', 'b', 'c']);
  assert.deepEqual(first, second);
});

test('summarizeGoals kokoaa kaiken näkymää varten', () => {
  const goals = [
    goal({ id: 'g1', title: 'Aktiivinen' }),
    goal({ id: 'g2', title: 'Tauolla', status: GOAL_STATUS.PAUSED }),
    goal({ id: 'g3', title: 'Valmis', status: GOAL_STATUS.COMPLETED }),
    goal({ id: 'g4', title: 'Myöhässä', targetDate: '2026-08-01' })
  ];
  const tasks = [
    task({ id: 'a', goalId: 'g1', completed: true }),
    task({ id: 'b', goalId: 'g1', completed: false })
  ];
  const summary = summarizeGoals(goals, tasks, TODAY);

  assert.equal(summary.all.length, 4);
  assert.equal(summary.active.length, 2);
  assert.equal(summary.paused.length, 1);
  assert.equal(summary.completed.length, 1);
  assert.equal(summary.overdueCount, 1);

  const first = summary.all.find(entry => entry.goal.id === 'g1');
  assert.equal(first.progress.percent, 50);
  assert.equal(first.openTasks.length, 1);
  assert.equal(first.completedTasks.length, 1);
});

test('summarizeGoals kestää tyhjät syötteet', () => {
  const summary = summarizeGoals(null, null, TODAY);
  assert.deepEqual(summary.all, []);
  assert.equal(summary.overdueCount, 0);
});

// ============================================================ PROJEKTIT

test('normalizeProject hyväksyy sekä name- että title-kentän', () => {
  assert.equal(normalizeProject({ id: 'x', name: 'Nimi' }).name, 'Nimi');
  assert.equal(normalizeProject({ id: 'x', title: 'Otsikko' }).name, 'Otsikko');
});

test('validateProject vaatii nimen', () => {
  assert.equal(validateProject(project()).valid, true);
  assert.ok(validateProject(project({ name: '  ' })).errors.name);
});

test('projectStatusLabel ja isOpenProject', () => {
  assert.equal(projectStatusLabel(PROJECT_STATUS.ON_HOLD), 'Odottaa');
  assert.equal(isOpenProject(project()), true);
  assert.equal(isOpenProject(project({ status: PROJECT_STATUS.COMPLETED })), false);
});

test('summarizeProject laskee tehtävien tilanteen', () => {
  const tasks = [
    task({ id: 'a', projectId: 'p1', completed: true }),
    task({ id: 'b', projectId: 'p1', completed: false }),
    task({ id: 'c', projectId: 'muu', completed: true })
  ];
  const summary = summarizeProject(project(), tasks);
  assert.equal(summary.total, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.open, 1);
  assert.equal(summary.percent, 50);
});

test('tyhjä projekti on 0 % eikä NaN', () => {
  const summary = summarizeProject(project(), []);
  assert.equal(summary.percent, 0);
  assert.ok(Number.isFinite(summary.percent));
});

test('summarizeProjects erottelee avoimet ja suljetut', () => {
  const projects = [
    project({ id: 'p1', name: 'Beeta' }),
    project({ id: 'p2', name: 'Alfa' }),
    project({ id: 'p3', name: 'Valmis', status: PROJECT_STATUS.COMPLETED })
  ];
  const summary = summarizeProjects(projects, []);
  assert.equal(summary.open.length, 2);
  assert.equal(summary.closed.length, 1);
  assert.deepEqual(summary.open.map(e => e.project.name), ['Alfa', 'Beeta'], 'aakkosjärjestys');
});

test('projekti voi liittyä tavoitteeseen', () => {
  assert.equal(project({ goalId: 'g1' }).goalId, 'g1');
  assert.equal(project().goalId, null, 'yhteys on vapaaehtoinen');
});

test('tasksForProject kestää puuttuvat arvot', () => {
  assert.deepEqual(tasksForProject(null, 'p1'), []);
  assert.deepEqual(tasksForProject([task()], null), []);
});

// ============================================================ MÄÄRÄAJAT

test('määräaika on eri asia kuin aikataulutus', () => {
  // Lasku erääntyy perjantaina mutta se on aikataulutettu keskiviikolle.
  const t = task({ date: '2026-09-02', deadline: '2026-09-04' });
  assert.equal(t.date, '2026-09-02');
  assert.equal(t.deadline, '2026-09-04');
  assert.notEqual(t.date, t.deadline);
});

test('kelvoton määräaika pudotetaan ja validointi kertoo siitä', () => {
  assert.equal(normalizeTask({ title: 'T', date: TODAY, deadline: 'roska' }).deadline, null);
  const invalid = { ...task(), deadline: '4.9.2026' };
  assert.ok(validateTask(invalid).errors.deadline);
});

test('isOverdue: määräaika menneisyydessä', () => {
  assert.equal(isOverdue(task({ deadline: '2026-08-31' }), TODAY), true);
  assert.equal(isOverdue(task({ deadline: TODAY }), TODAY), false, 'tänään ei ole myöhässä');
  assert.equal(isOverdue(task({ deadline: '2026-09-02' }), TODAY), false);
});

test('isOverdue: valmis tehtävä ei ole koskaan myöhässä', () => {
  assert.equal(isOverdue(task({ deadline: '2026-01-01', completed: true }), TODAY), false);
});

test('isOverdue: määräaika voittaa aikataulutetun päivän', () => {
  // Aikataulutettu menneisyyteen mutta määräaika tulevaisuudessa -> ei myöhässä.
  const t = task({ date: '2026-08-25', deadline: '2026-09-10' });
  assert.equal(isOverdue(t, TODAY), false, 'määräaika on ensisijainen');
});

test('isOverdue: ilman määräaikaa mennyt aikataulu on myöhässä', () => {
  assert.equal(isOverdue(task({ date: '2026-08-25', deadline: null }), TODAY), true);
});

test('isOverdue: aikatauluttamaton tehtävä ilman määräaikaa ei ole myöhässä', () => {
  assert.equal(isOverdue(normalizeTask({ title: 'T', date: null }), TODAY), false);
});

test('isOverdue kestää puuttuvat arvot', () => {
  assert.equal(isOverdue(null, TODAY), false);
  assert.equal(isOverdue(task({ deadline: '2026-01-01' }), 'roska'), false);
});

test('JOHDETTU TILA: myöhässä oleminen ei muuta tehtävää', () => {
  const t = task({ deadline: '2026-01-01' });
  const before = JSON.stringify(t);
  isOverdue(t, TODAY);
  isOverdue(t, '2030-01-01');
  assert.equal(JSON.stringify(t), before, 'funktio ei saa mutatoida tehtävää');
});

test('daysUntilDeadline laskee päivät', () => {
  assert.equal(daysUntilDeadline(task({ deadline: '2026-09-04' }), TODAY), 3);
  assert.equal(daysUntilDeadline(task({ deadline: TODAY }), TODAY), 0);
  assert.equal(daysUntilDeadline(task({ deadline: '2026-08-30' }), TODAY), -2);
  assert.equal(daysUntilDeadline(task(), TODAY), null);
});

test('deadlineUrgency luokittelee kiireellisyyden', () => {
  assert.equal(deadlineUrgency(task({ deadline: '2026-08-30' }), TODAY), URGENCY.OVERDUE);
  assert.equal(deadlineUrgency(task({ deadline: TODAY }), TODAY), URGENCY.TODAY);
  assert.equal(deadlineUrgency(task({ deadline: '2026-09-02' }), TODAY), URGENCY.TOMORROW);
  assert.equal(deadlineUrgency(task({ deadline: '2026-09-04' }), TODAY), URGENCY.SOON);
  assert.equal(deadlineUrgency(task({ deadline: '2026-12-01' }), TODAY), URGENCY.LATER);
  assert.equal(deadlineUrgency(task(), TODAY), URGENCY.NONE);
});

test('SOON-raja on täsmällinen', () => {
  const lastSoon = '2026-09-0' + (1 + SOON_DAYS);
  assert.equal(deadlineUrgency(task({ deadline: lastSoon }), TODAY), URGENCY.SOON);
  assert.equal(deadlineUrgency(task({ deadline: '2026-09-05' }), TODAY), URGENCY.LATER);
});

test('valmis tehtävä ei ole kiireellinen', () => {
  assert.equal(deadlineUrgency(task({ deadline: '2026-01-01', completed: true }), TODAY), URGENCY.NONE);
});

test('urgencyWeight järjestää kiireellisimmän ensin', () => {
  assert.ok(urgencyWeight(URGENCY.OVERDUE) < urgencyWeight(URGENCY.TODAY));
  assert.ok(urgencyWeight(URGENCY.TODAY) < urgencyWeight(URGENCY.TOMORROW));
  assert.ok(urgencyWeight(URGENCY.SOON) < urgencyWeight(URGENCY.LATER));
  assert.ok(urgencyWeight(URGENCY.LATER) < urgencyWeight(URGENCY.NONE));
  assert.equal(urgencyWeight('tuntematon'), urgencyWeight(URGENCY.NONE));
});

test('urgencyLabel antaa tekstin vain kiireellisille', () => {
  assert.equal(urgencyLabel(URGENCY.OVERDUE), 'Myöhässä');
  assert.equal(urgencyLabel(URGENCY.TODAY), 'Tänään');
  assert.equal(urgencyLabel(URGENCY.LATER), '', 'kaukainen määräaika ei ansaitse merkintää');
});

test('overdueTasks kerää kaikki myöhässä olevat', () => {
  const tasks = [
    task({ id: 'a', deadline: '2026-08-01' }),
    task({ id: 'b', deadline: '2026-12-01' }),
    task({ id: 'c', deadline: '2026-08-01', completed: true }),
    task({ id: 'd', date: '2026-08-01', deadline: null })
  ];
  assert.deepEqual(overdueTasks(tasks, TODAY).map(t => t.id), ['a', 'd']);
  assert.deepEqual(overdueTasks(null, TODAY), []);
});
