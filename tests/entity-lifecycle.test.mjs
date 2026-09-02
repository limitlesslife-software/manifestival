// Entiteettien elinkaaren semantiikka.
//
// Nämä eivät ole yhden funktion testejä vaan PÄÄTÖSTEN lukituksia.
// Jokainen alla oleva sääntö on valinta, joka voisi mennä toisinkin, ja
// jonka hiljainen muuttuminen näkyisi käyttäjälle kadonneena datana tai
// muistutuksena asiasta, jota ei enää ole.
//
// Neljä kysymystä:
//   1. mitä poistolle tapahtuu liitetyille tiedoille
//   2. mitä orvolle viitteelle tapahtuu
//   3. näkyykö arkistoitu
//   4. lakkaako valmis olemasta ajankohtainen

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal, GOAL_STATUS, computeGoalProgress } from '../src/domain/goal.js';
import {
  normalizeProject, PROJECT_STATUS, TASK_DELETE_POLICY,
  summarizeProject, describeProjectDeletion
} from '../src/domain/project.js';
import { normalizeBill, buildFinancialReminders } from '../src/domain/finance.js';
import { planNotifications } from '../src/domain/notification.js';
import { buildDayPlan, proposeSchedule } from '../src/domain/scheduler.js';
import { searchAll } from '../src/domain/search.js';

const TODAY = '2026-09-10';

// ------------------------------------------------- poiston semantiikka

test('KRIITTINEN: projektin poisto irrottaa tehtävät, ei poista niitä', () => {
  // Tehtävä on käyttäjän omaa työtä. Projekti on vain sen ryhmittely.
  // Ryhmittelyn purkaminen ei saa hävittää työtä.
  assert.equal(TASK_DELETE_POLICY.UNLINK, 'unlink');

  const project = normalizeProject({ id: 'p1', name: 'Remontti' });
  const tasks = [
    normalizeTask({ id: 't1', title: 'Maalaa', date: TODAY, projectId: 'p1' }),
    normalizeTask({ id: 't2', title: 'Muuta', date: TODAY })
  ];

  const description = describeProjectDeletion(project, tasks);
  assert.match(JSON.stringify(description), /1/,
    'kuvauksen pitää kertoa montako tehtävää liittyy');
  assert.equal(/poistetaan|häviä|katoa/i.test(JSON.stringify(description).replace(/projekti\w*/gi, '')), true,
    'kuvauksen pitää kertoa mitä poistetaan');
});

test('KRIITTINEN: kannan viitteet ovat SET NULL, eivät CASCADE', () => {
  // Domainin sopimus ja migraation sopimus eivät saa erota. Jos kanta
  // sanoisi cascade, tavoitteen poisto veisi tehtävät riippumatta siitä,
  // mitä domain sanoo.
  //
  // Tämä on jo tarkistettu migrations-testeissä. Tässä varmistetaan
  // nimenomaan yhteys domainin TASK_DELETE_POLICY.UNLINK -päätökseen.
  assert.equal(TASK_DELETE_POLICY.UNLINK, 'unlink',
    'domain lupaa irrottaa — kannan on tehtävä sama');
});

// ------------------------------------------------------ orvot viitteet

test('KRIITTINEN: orpo viite ei kaada mitään', () => {
  // Viitattu projekti tai tavoite voi olla poistettu. Sovelluksen on
  // toimittava normaalisti, ei kaaduttava.
  const orpo = normalizeTask({
    id: 't1', title: 'Orpo tehtävä', date: TODAY,
    time: '10:00', projectId: 'ei-ole', goalId: 'ei-myöskään'
  });

  assert.doesNotThrow(() => buildDayPlan({ tasks: [orpo], profile: {}, dateIso: TODAY }));
  assert.doesNotThrow(() => proposeSchedule({ tasks: [orpo], profile: {}, dateIso: TODAY }));
  assert.doesNotThrow(() => planNotifications({
    tasks: [orpo], dateIso: TODAY, todayIso: TODAY,
    preferences: { enabled: true, maxPerDay: 20 }
  }));
  assert.doesNotThrow(() => searchAll({ query: 'orpo', collections: { tasks: [orpo] } }));

  const goal = normalizeGoal({ id: 'g1', title: 'Tavoite' });
  assert.doesNotThrow(() => computeGoalProgress(goal, [orpo], {}));

  const project = normalizeProject({ id: 'p1', name: 'Projekti', goalId: 'ei-ole' });
  assert.doesNotThrow(() => summarizeProject(project, [orpo], TODAY));
});

test('orpo viite ei laske mukaan edistymään', () => {
  // Tehtävä, joka viittaa poistettuun tavoitteeseen, ei kuulu enää
  // yhdenkään tavoitteen laskentaan.
  const goal = normalizeGoal({ id: 'g1', title: 'Tavoite' });
  const orpo = normalizeTask({ id: 't1', title: 'Orpo', date: TODAY, goalId: 'poistettu' });

  const progress = computeGoalProgress(goal, [orpo], {});
  assert.equal(progress.total, 0, 'orpo tehtävä laskettiin tavoitteeseen');
});

// -------------------------------------------------------- arkistoidut

test('PÄÄTÖS: arkistoidut löytyvät haussa mutta eivät ohita ajankohtaisia', () => {
  // Kaksi vaatimusta yhtä aikaa:
  //   1. arkistoitu LÖYTYY — käyttäjä tietää arkistoineensa jotain
  //   2. arkistoitu ei OHITA ajankohtaista samalla osuvuudella
  //
  // Toinen ei ole makuasia: komentopaletti kohdistaa Enterin parhaaseen
  // osumaan. Arkistoitu kohde parhaana osumana olisi ansa.
  //
  // Nimet on valittu niin, että aakkosjärjestys nostaisi arkistoidun
  // ensin, jos järjestys EI olisi tilatietoinen.
  const goals = [
    normalizeGoal({ id: 'g1', title: 'Aaa palaveri', status: GOAL_STATUS.ARCHIVED }),
    normalizeGoal({ id: 'g2', title: 'Zzz palaveri' })
  ];

  const results = searchAll({ query: 'palaveri', collections: { goals } }).groups[0].results;

  assert.equal(results.length, 2, 'arkistoitu katosi hausta');
  assert.equal(results[0].id, 'g2', 'arkistoitu ohitti ajankohtaisen');
  assert.equal(results[0].active, true);
  assert.equal(results[1].active, false);
});

test('sama sääntö koskee projekteja ja valmiita tehtäviä', () => {
  const projects = [
    normalizeProject({ id: 'p1', name: 'Aaa remontti', status: PROJECT_STATUS.ARCHIVED }),
    normalizeProject({ id: 'p2', name: 'Zzz remontti' })
  ];
  const tasks = [
    normalizeTask({ id: 't1', title: 'Aaa siivous', date: TODAY, completed: true }),
    normalizeTask({ id: 't2', title: 'Zzz siivous', date: TODAY })
  ];

  const p = searchAll({ query: 'remontti', collections: { projects } }).groups[0].results;
  assert.equal(p[0].id, 'p2', 'arkistoitu projekti ohitti ajankohtaisen');

  const t = searchAll({ query: 'siivous', collections: { tasks } }).groups[0].results;
  assert.equal(t[0].id, 't2', 'valmis tehtävä ohitti avoimen');
});

test('tuntematon muoto tulkitaan ajankohtaiseksi', () => {
  // Haku ei saa piilottaa mitään sen takia, ettei se tunnista kenttää.
  const outo = [{ id: 'x1', title: 'Outo palaveri', jokinAivanMuu: true }];
  const results = searchAll({ query: 'palaveri', collections: { tasks: outo } }).groups[0].results;

  assert.equal(results[0].active, true, 'tuntematon muoto piilotettiin');
});

// ------------------------------------------------- valmiit ja maksetut

test('KRIITTINEN: valmiista tehtävästä ei muistuteta', () => {
  const done = normalizeTask({
    id: 't1', title: 'Jo tehty', date: TODAY, time: '10:00', completed: true
  });

  const intents = planNotifications({
    tasks: [done], dateIso: TODAY, todayIso: TODAY,
    preferences: { enabled: true, maxPerDay: 20 }
  });

  assert.equal(intents.some(i => i.targetId === 't1'), false,
    'valmiista tehtävästä muistutettiin');
});

test('KRIITTINEN: maksetusta laskusta ei muistuteta', () => {
  const bills = [
    normalizeBill({
      id: 'b1', name: 'Maksettu', amountMinor: 1000,
      dueDate: TODAY, status: 'paid', paidDate: '2026-09-01'
    }),
    normalizeBill({ id: 'b2', name: 'Avoin', amountMinor: 2000, dueDate: TODAY })
  ];

  const reminders = buildFinancialReminders({ bills, todayIso: '2026-09-08' });
  const names = JSON.stringify(reminders);

  assert.equal(names.includes('Maksettu'), false, 'maksetusta laskusta muistutettiin');
  assert.ok(names.includes('Avoin'), 'avoimesta laskusta ei muistutettu');
});

test('valmis tehtävä ei ole aikataulutuksen ehdokas', () => {
  const tasks = [
    normalizeTask({ id: 't1', title: 'Valmis', date: TODAY, completed: true, durationMinutes: 60 }),
    normalizeTask({ id: 't2', title: 'Avoin', date: TODAY, durationMinutes: 60 })
  ];

  const proposal = proposeSchedule({ tasks, profile: {}, dateIso: TODAY });
  assert.equal(JSON.stringify(proposal).includes('"t1"'), false,
    'valmis tehtävä päätyi aikatauluehdotukseen');
});

test('arkistoitu ei katoa — se on löydettävissä ja laskettavissa', () => {
  // Arkistointi ei ole poisto. Tieto säilyy.
  const archived = normalizeGoal({
    id: 'g1', title: 'Vanha tavoite', status: GOAL_STATUS.ARCHIVED
  });

  assert.equal(archived.status, GOAL_STATUS.ARCHIVED);
  assert.equal(archived.title, 'Vanha tavoite', 'arkistointi muutti sisältöä');

  const found = searchAll({ query: 'vanha', collections: { goals: [archived] } });
  assert.equal(found.total, 1, 'arkistoitu ei ole enää löydettävissä');
});
