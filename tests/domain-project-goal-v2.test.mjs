// Projektien ja tavoitteiden V2-testit.
//
// Painopiste on niissä kohdissa, joissa kaksi totuutta voisi erkaantua:
// johdettu edistyminen, riskiarvio ja poistopolitiikka.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_STATUS, PROJECT_STATUSES, PROJECT_RISK, TASK_DELETE_POLICY,
  AT_RISK_HORIZON_DAYS,
  normalizeProject, validateProject, isOpenProject, isArchivedProject,
  daysUntilDeadline, projectRisk, projectRiskLabel,
  summarizeProject, summarizeProjects, compareProjects, describeProjectDeletion,
  projectStatusLabel
} from '../src/domain/project.js';

import {
  GOAL_STATUS, PROGRESS_MODE, PROGRESS_MODES,
  normalizeGoal, computeGoalProgress, projectsForGoal, routinesForGoal,
  goalStatusLabel
} from '../src/domain/goal.js';

import { normalizeTask } from '../src/domain/task.js';
import { normalizeRoutine } from '../src/domain/routine.js';

const TODAY = '2026-03-15';

function project(overrides = {}) {
  return normalizeProject({ id: 'p1', name: 'Taloremontti', ...overrides });
}

function task(id, overrides = {}) {
  return normalizeTask({
    id, title: 'Tehtävä ' + id, date: TODAY, completed: false, ...overrides
  });
}

// ================================================================ PROJEKTIT

test('projektilla on viisi tilaa ja jokaisella nimilappu', () => {
  assert.equal(PROJECT_STATUSES.length, 5);
  assert.ok(PROJECT_STATUSES.includes(PROJECT_STATUS.PLANNED));
  for (const status of PROJECT_STATUSES) {
    assert.ok(projectStatusLabel(status).length > 0, status);
  }
});

test('normalizeProject on idempotentti', () => {
  const once = project({
    priority: 'korkea', startDate: '2026-01-01', deadline: '2026-06-30',
    description: '  kuvaus  ', goalId: 'g1'
  });
  assert.deepEqual(normalizeProject(once), once);
});

test('vanha targetDate luetaan määräajaksi', () => {
  // Aiempi malli käytti nimeä targetDate. Nimi vaihtui, mutta vanhan
  // nimen hylkääminen olisi kadottanut tiedon hiljaa.
  const migrated = normalizeProject({ id: 'p1', name: 'X', targetDate: '2026-06-30' });
  assert.equal(migrated.deadline, '2026-06-30');
});

test('projekti vaatii nimen', () => {
  const { valid, errors } = validateProject(normalizeProject({}));
  assert.equal(valid, false);
  assert.ok(errors.name);
});

test('määräaika ei voi olla ennen aloitusta', () => {
  const invalid = project({ startDate: '2026-06-01', deadline: '2026-05-01' });
  const { valid, errors } = validateProject(invalid);
  assert.equal(valid, false);
  assert.ok(errors.deadline);

  assert.equal(validateProject(
    project({ startDate: '2026-05-01', deadline: '2026-06-01' })).valid, true);
});

test('avoimet tilat erotetaan päättyneistä', () => {
  for (const status of ['planned', 'active', 'on_hold']) {
    assert.equal(isOpenProject(project({ status })), true, status);
  }
  for (const status of ['completed', 'archived']) {
    assert.equal(isOpenProject(project({ status })), false, status);
  }
  assert.equal(isArchivedProject(project({ status: 'archived' })), true);
});

// ------------------------------------------------------------- edistyminen

test('KRIITTINEN: projektin edistyminen on johdettu eikä tallennettu', () => {
  // Tallennettu prosentti ajautuisi väistämättä eri suuntaan kuin
  // todellisuus. Kentän puuttuminen on osa sopimusta.
  const p = project();
  assert.equal('percent' in p, false);
  assert.equal('progress' in p, false);

  const summary = summarizeProject(p, [
    task('t1', { projectId: 'p1', completed: true }),
    task('t2', { projectId: 'p1', completed: false })
  ], TODAY);
  assert.equal(summary.percent, 50);
});

test('tyhjä projekti on 0 %, ei 100 %', () => {
  assert.equal(summarizeProject(project(), [], TODAY).percent, 0);
});

test('valmis projekti on 100 % vaikka tehtäviä jäisi', () => {
  // Käyttäjän nimenomainen päätös voittaa lasketun arvon.
  const summary = summarizeProject(project({ status: PROJECT_STATUS.COMPLETED }), [
    task('t1', { projectId: 'p1', completed: false })
  ], TODAY);
  assert.equal(summary.percent, 100);
});

test('vain projektin omat tehtävät lasketaan', () => {
  const summary = summarizeProject(project(), [
    task('t1', { projectId: 'p1', completed: true }),
    task('t2', { projectId: 'p2', completed: false }),
    task('t3', { completed: false })
  ], TODAY);

  assert.equal(summary.total, 1);
  assert.equal(summary.percent, 100);
});

test('yhteenveto erottelee myöhässä olevat ja seuraavan tehtävän', () => {
  const summary = summarizeProject(project(), [
    task('t1', { projectId: 'p1', date: '2026-03-01' }),
    task('t2', { projectId: 'p1', date: '2026-03-20' }),
    task('t3', { projectId: 'p1', date: '2026-03-10', completed: true })
  ], TODAY);

  assert.equal(summary.overdueTasks.length, 1);
  assert.equal(summary.overdueTasks[0].id, 't1');
  assert.equal(summary.nextTask.id, 't1', 'aikaisin avoin ensin');
});

// ----------------------------------------------------------------- riski

test('ilman määräaikaa riskiä ei arvioida', () => {
  // Keksitty huoli on huonompi kuin ei huolta.
  const risk = projectRisk(project(), [task('t1', { projectId: 'p1' })], TODAY);
  assert.equal(risk, PROJECT_RISK.ON_TRACK);
  assert.equal(daysUntilDeadline(project(), TODAY), null);
});

test('mennyt määräaika on myöhässä', () => {
  const risk = projectRisk(project({ deadline: '2026-03-01' }), [], TODAY);
  assert.equal(risk, PROJECT_RISK.OVERDUE);
});

test('valmis tai arkistoitu projekti ei ole koskaan myöhässä', () => {
  for (const status of [PROJECT_STATUS.COMPLETED, PROJECT_STATUS.ARCHIVED]) {
    assert.equal(projectRisk(project({ status, deadline: '2020-01-01' }), [], TODAY),
      PROJECT_RISK.CLOSED, status);
  }
});

test('KRIITTINEN: riski on deterministinen ja selitettävissä', () => {
  // Sääntö: määräaikaan enintään 14 päivää JA avoimia tehtäviä enemmän
  // kuin jäljellä olevia päiviä.
  const deadline = '2026-03-20'; // 5 päivää TODAYsta

  const fiveTasks = Array.from({ length: 5 }, (unused, i) =>
    task('t' + i, { projectId: 'p1' }));
  assert.equal(projectRisk(project({ deadline }), fiveTasks, TODAY),
    PROJECT_RISK.ON_TRACK, '5 tehtävää 5 päivässä on juuri ja juuri mahdollista');

  const sixTasks = Array.from({ length: 6 }, (unused, i) =>
    task('t' + i, { projectId: 'p1' }));
  assert.equal(projectRisk(project({ deadline }), sixTasks, TODAY),
    PROJECT_RISK.AT_RISK, '6 tehtävää 5 päivässä on liikaa');
});

test('kaukainen määräaika ei tuota riskiä vaikka työtä olisi paljon', () => {
  const far = '2026-12-31';
  const many = Array.from({ length: 50 }, (unused, i) => task('t' + i, { projectId: 'p1' }));
  assert.equal(projectRisk(project({ deadline: far }), many, TODAY), PROJECT_RISK.ON_TRACK);
});

test('riskiarvio alkaa vasta horisontin sisällä', () => {
  const withinHorizon = '2026-03-25';  // 10 pv
  const beyondHorizon = '2026-04-15';  // 31 pv
  const many = Array.from({ length: 40 }, (unused, i) => task('t' + i, { projectId: 'p1' }));

  assert.equal(projectRisk(project({ deadline: withinHorizon }), many, TODAY),
    PROJECT_RISK.AT_RISK);
  assert.equal(projectRisk(project({ deadline: beyondHorizon }), many, TODAY),
    PROJECT_RISK.ON_TRACK);
  assert.ok(AT_RISK_HORIZON_DAYS > 0);
});

test('ilman avoimia tehtäviä ei ole riskiä', () => {
  assert.equal(projectRisk(project({ deadline: '2026-03-16' }), [
    task('t1', { projectId: 'p1', completed: true })
  ], TODAY), PROJECT_RISK.ON_TRACK);
});

test('jokaisella riskitilalla on nimilappu', () => {
  for (const risk of Object.values(PROJECT_RISK)) {
    assert.ok(projectRiskLabel(risk).length > 0, risk);
  }
});

// ------------------------------------------------------------- poisto

test('KRIITTINEN: projektin poisto ei koskaan poista tehtäviä', () => {
  // Työ on tehty, vaikka sen kehys purettaisiin. Kaskadoiva poisto olisi
  // tietohäviö, jota käyttäjä ei osaa odottaa eikä voi perua.
  const description = describeProjectDeletion(project(), [
    task('t1', { projectId: 'p1' }),
    task('t2', { projectId: 'p1' })
  ]);

  assert.equal(description.policy, TASK_DELETE_POLICY.UNLINK);
  assert.equal(description.tasksDeleted, 0);
  assert.equal(description.taskCount, 2);
  assert.match(description.message, /säilyy/);
});

test('poiston kuvaus kertoo myös tyhjästä projektista', () => {
  const description = describeProjectDeletion(project(), []);
  assert.equal(description.taskCount, 0);
  assert.equal(description.tasksDeleted, 0);
  assert.ok(description.message.length > 0);
});

// ---------------------------------------------------------- ryhmittely

test('yhteenveto ryhmittelee tilat ja riskit', () => {
  const projects = [
    normalizeProject({ id: 'a', name: 'Aktiivinen', status: PROJECT_STATUS.ACTIVE }),
    normalizeProject({ id: 'b', name: 'Suunnitteilla', status: PROJECT_STATUS.PLANNED }),
    normalizeProject({ id: 'c', name: 'Odottaa', status: PROJECT_STATUS.ON_HOLD }),
    normalizeProject({ id: 'd', name: 'Valmis', status: PROJECT_STATUS.COMPLETED }),
    normalizeProject({ id: 'e', name: 'Arkisto', status: PROJECT_STATUS.ARCHIVED }),
    normalizeProject({ id: 'f', name: 'Myöhässä', deadline: '2026-01-01' })
  ];

  const summary = summarizeProjects(projects, [], TODAY);

  assert.equal(summary.all.length, 6);
  assert.equal(summary.planned.length, 1);
  assert.equal(summary.completed.length, 1);
  assert.equal(summary.archived.length, 1);
  assert.equal(summary.open.length, 4, 'planned + active + on_hold + myöhässä');
  assert.equal(summary.overdue.length, 1);
});

test('järjestys on deterministinen', () => {
  const projects = [
    normalizeProject({ id: 'c', name: 'Ceta', priority: 'normaali' }),
    normalizeProject({ id: 'a', name: 'Alfa', priority: 'korkea' }),
    normalizeProject({ id: 'b', name: 'Beta', status: PROJECT_STATUS.ARCHIVED })
  ];

  const first = summarizeProjects(projects, [], TODAY).all.map(e => e.project.id);
  const second = summarizeProjects([...projects].reverse(), [], TODAY).all.map(e => e.project.id);

  assert.deepEqual(first, second);
  assert.equal(first[0], 'a', 'korkea prioriteetti ensin');
  assert.equal(first[2], 'b', 'arkistoitu viimeisenä');
  assert.equal(compareProjects(projects[1], projects[2]) < 0, true);
});

// ================================================================ TAVOITTEET

test('tavoitteella on neljä edistymistapaa', () => {
  assert.equal(PROGRESS_MODES.length, 4);
  for (const mode of ['manual', 'task_based', 'project_based', 'routine_based']) {
    assert.ok(PROGRESS_MODES.includes(mode), mode);
  }
});

test('luovutettu on eri asia kuin arkistoitu', () => {
  // Arkistointi on siivousta, luovuttaminen on päätös.
  assert.ok(GOAL_STATUS.ABANDONED);
  assert.notEqual(GOAL_STATUS.ABANDONED, GOAL_STATUS.ARCHIVED);
  assert.equal(goalStatusLabel(GOAL_STATUS.ABANDONED), 'Luovutettu');
});

test('projektipohjainen edistyminen lasketaan tehtävistä, ei keskiarvosta', () => {
  // Kymmenen tehtävän projekti ei ole yhtä painava kuin yhden tehtävän
  // projekti. Keskiarvo antaisi niille saman painon.
  const goal = normalizeGoal({
    id: 'g1', title: 'Julkaise', progressMode: PROGRESS_MODE.PROJECT_BASED
  });
  const projects = [
    normalizeProject({ id: 'p1', name: 'Iso', goalId: 'g1' }),
    normalizeProject({ id: 'p2', name: 'Pieni', goalId: 'g1' })
  ];
  const tasks = [
    ...Array.from({ length: 9 }, (unused, i) =>
      task('big' + i, { projectId: 'p1', completed: false })),
    task('small', { projectId: 'p2', completed: true })
  ];

  const progress = computeGoalProgress(goal, tasks, { projects });

  assert.equal(progress.mode, PROGRESS_MODE.PROJECT_BASED);
  assert.equal(progress.total, 10);
  assert.equal(progress.completed, 1);
  assert.equal(progress.percent, 10, 'keskiarvo olisi antanut 50 %');
  assert.equal(progress.projectCount, 2);
});

test('projektipohjainen tavoite ilman projekteja on 0 %', () => {
  const goal = normalizeGoal({
    id: 'g1', title: 'X', progressMode: PROGRESS_MODE.PROJECT_BASED
  });
  assert.equal(computeGoalProgress(goal, [], { projects: [] }).percent, 0);
  assert.equal(computeGoalProgress(goal, []).percent, 0, 'ilman kontekstia');
});

test('rutiinipohjainen edistyminen on osuus käytössä olevista', () => {
  // Rutiinilla ei ole "valmis"-tilaa — se on sääntö. Ainoa mielekäs
  // tulkinta on "pidänkö kiinni siitä mitä lupasin".
  const goal = normalizeGoal({
    id: 'g1', title: 'Pysy kunnossa', progressMode: PROGRESS_MODE.ROUTINE_BASED
  });
  const routines = [
    normalizeRoutine({ id: 'r1', title: 'Kuntosali', goalId: 'g1', active: true }),
    normalizeRoutine({ id: 'r2', title: 'Lenkki', goalId: 'g1', active: true }),
    normalizeRoutine({ id: 'r3', title: 'Venyttely', goalId: 'g1', active: false }),
    normalizeRoutine({ id: 'r4', title: 'Muu', goalId: 'g2', active: true })
  ];

  const progress = computeGoalProgress(goal, [], { routines });

  assert.equal(progress.mode, PROGRESS_MODE.ROUTINE_BASED);
  assert.equal(progress.total, 3, 'vain tämän tavoitteen rutiinit');
  assert.equal(progress.completed, 2);
  assert.equal(progress.percent, 67);
});

test('rutiinilla on vapaaehtoinen yhteys tavoitteeseen', () => {
  assert.equal(normalizeRoutine({ id: 'r1', title: 'X' }).goalId, null);
  assert.equal(normalizeRoutine({ id: 'r1', title: 'X', goalId: 'g1' }).goalId, 'g1');
});

test('liitosten haku suodattaa oikein', () => {
  const projects = [
    normalizeProject({ id: 'p1', name: 'A', goalId: 'g1' }),
    normalizeProject({ id: 'p2', name: 'B', goalId: 'g2' })
  ];
  const routines = [
    normalizeRoutine({ id: 'r1', title: 'A', goalId: 'g1' }),
    normalizeRoutine({ id: 'r2', title: 'B' })
  ];

  assert.equal(projectsForGoal(projects, 'g1').length, 1);
  assert.equal(routinesForGoal(routines, 'g1').length, 1);
  assert.deepEqual(projectsForGoal(projects, null), []);
  assert.deepEqual(routinesForGoal(null, 'g1'), []);
});

test('saavutettu tavoite on 100 % kaikilla edistymistavoilla', () => {
  for (const mode of PROGRESS_MODES) {
    const goal = normalizeGoal({
      id: 'g1', title: 'X', status: GOAL_STATUS.COMPLETED, progressMode: mode
    });
    assert.equal(computeGoalProgress(goal, [], { projects: [], routines: [] }).percent,
      100, mode);
  }
});

test('edistyminen on aina kokonaisluku välillä 0-100', () => {
  for (const mode of PROGRESS_MODES) {
    const goal = normalizeGoal({
      id: 'g1', title: 'X', progressMode: mode, manualProgress: 250
    });
    const progress = computeGoalProgress(goal, [
      task('t1', { goalId: 'g1', completed: true })
    ], { projects: [], routines: [] });

    assert.equal(Number.isInteger(progress.percent), true, mode);
    assert.ok(progress.percent >= 0 && progress.percent <= 100, mode);
  }
});
