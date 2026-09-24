// Tavoitteesta tekemiseksi — domainin säännöt.
//
// MITÄ TÄMÄ ERITYISESTI VARTIOI
//
// Viisi sääntöä, joiden rikkoutuminen ei näkyisi missään virheessä
// vaan väärässä suunnitelmassa — ja väärä suunnitelma näyttää
// täsmälleen yhtä valmiilta kuin oikea:
//
//   1. Ehdotettu ei ole hyväksytty, hyväksytty ei ole tallennettu.
//   2. Vuorokaudessa ei ole 24 suunniteltavaa tuntia.
//   3. Mikään automaatiotaso ei siirrä kiinteää työtä.
//   4. Tuntematon edistyminen ei ole nolla.
//   5. Mahdotonta suunnitelmaa ei piiloteta optimistisen sanamuodon taakse.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MILESTONE_STATUS, MILESTONE_RULE, normalizeMilestone, validateMilestone,
  milestonesForGoal, compareMilestones, nextOrderIndex, reorderMilestone,
  isOpenMilestone, isMilestoneOverdue, nextMilestone, outOfOrderMilestones,
  milestoneProgress, ruleSatisfied, markReached, markOpen, markSkipped
} from '../src/domain/milestone.js';

import {
  METRIC_DIRECTION, normalizeTarget, hasTarget, directionOf, metricProgress,
  describeTarget, validateTarget, progressFromSavings, formatNumber
} from '../src/domain/goalTarget.js';

import {
  PROGRESS_STRATEGY, HYBRID_WEIGHTS, computeProgress, inferStrategy,
  progressStrategyLabel
} from '../src/domain/goalProgress.js';

import {
  DEFAULT_BUFFER_RATIO, dayCapacity, horizonCapacity, horizonEnd,
  capacityUntil, remainingWork, feasibility, dailyRequirement
} from '../src/domain/capacity.js';

import {
  AUTOMATION_LEVEL, DEFAULT_AUTOMATION_LEVEL, normalizeAutomationLevel,
  requiresExplicitOptIn, allowsAutoMove, moveWindow, canMoveTo,
  explainRefusal, partitionMoves, automationLevelLabel
} from '../src/domain/automation.js';

import {
  SEVERITY, CONFLICT, detectOverlaps, detectCapacityConflicts,
  detectMilestoneConflicts, detectDependencyConflicts,
  detectPortfolioConflicts, detectAllConflicts, sortConflicts,
  hasBlocking, worstSeverity
} from '../src/domain/conflicts.js';

import {
  PLAN_STATUS, PLAN_KIND, LIMITS, normalizePlan, validatePlan, canTransition,
  applyEdit, approvePlan, rejectPlan, markCommitted, supersedePlan,
  toCommittable, summarizePlan, countIncluded, danglingRefs, included
} from '../src/domain/plan.js';

import {
  PLACEMENT, dependencyLevels, planHorizon, isMovable, summarizeHorizon
} from '../src/domain/planScheduler.js';

import {
  FORECAST, FORECAST_QUALITY, CORRECTION, forecastGoal, velocity,
  projectDoneDate, suggestCorrections, forecastLabel
} from '../src/domain/forecast.js';

import {
  REPLAN_TRIGGER, missedTasks, repeatedlySkippedRoutines,
  buildReplanProposal, describeChange, detectReplanTriggers, triggerLabel
} from '../src/domain/replan.js';

import { normalizeGoal, GOAL_STATUS, SCHEDULING_STATUSES } from '../src/domain/goal.js';
import { normalizeTask } from '../src/domain/task.js';
import { validatePlanResponse, buildPlanningContext } from '../src/ai/planSchema.js';

const TODAY = '2026-09-10';

let counter = 0;
const makeId = () => `id-${++counter}`;

// =====================================================================
// VÄLITAVOITTEET
// =====================================================================

test('välitavoite ei elä ilman tavoitetta', () => {
  const orpo = normalizeMilestone({ id: 'm1', title: 'X' });
  const { valid, errors } = validateMilestone(orpo);
  assert.equal(valid, false);
  assert.ok(errors.goalId);
});

test('KRIITTINEN: saavutettu välitavoite ilman päivää ei kelpaa', () => {
  // Tila ja päivä kulkevat yhdessä. Sama sääntö kuin maksetulla
  // laskulla: saavutettu ilman päivää on tieto joka ei kerro milloin.
  const ilmanPaivaa = normalizeMilestone({
    id: 'm1', goalId: 'g1', title: 'X', status: MILESTONE_STATUS.REACHED
  });
  assert.equal(validateMilestone(ilmanPaivaa).valid, false);

  const paivaIlmanTilaa = normalizeMilestone({
    id: 'm1', goalId: 'g1', title: 'X', reachedDate: TODAY
  });
  assert.equal(validateMilestone(paivaIlmanTilaa).valid, false);

  // Ja markReached muodostaa parin oikein.
  const oikein = markReached(
    normalizeMilestone({ id: 'm1', goalId: 'g1', title: 'X' }), TODAY);
  assert.equal(validateMilestone(oikein).valid, true);
  assert.equal(oikein.reachedDate, TODAY);
});

test('avoimeksi palauttaminen poistaa saavutuspäivän', () => {
  const reached = markReached(
    normalizeMilestone({ id: 'm1', goalId: 'g1', title: 'X' }), TODAY);
  const open = markOpen(reached);
  assert.equal(open.status, MILESTONE_STATUS.OPEN);
  assert.equal(open.reachedDate, null);
  assert.equal(validateMilestone(open).valid, true);
});

test('jonojärjestys nojaa indeksiin, ei päivään', () => {
  // Päivätön välitavoite ei saa pudota jonon loppuun vain siksi, ettei
  // sille ole vielä päätetty päivää.
  const queue = milestonesForGoal([
    normalizeMilestone({ id: 'b', goalId: 'g1', title: 'B', orderIndex: 1,
      targetDate: '2026-10-01' }),
    normalizeMilestone({ id: 'a', goalId: 'g1', title: 'A', orderIndex: 0 })
  ], 'g1');

  assert.deepEqual(queue.map(m => m.id), ['a', 'b']);
});

test('KRIITTINEN: seuraava järjestysnumero on suurin plus yksi, ei määrä', () => {
  // Poisto jättää aukon. Jos uusi rivi saisi määrän, se saisi jo
  // varatun paikan ja jono menisi sekaisin.
  const milestones = [
    normalizeMilestone({ id: 'a', goalId: 'g1', title: 'A', orderIndex: 0 }),
    normalizeMilestone({ id: 'c', goalId: 'g1', title: 'C', orderIndex: 5 })
  ];
  assert.equal(nextOrderIndex(milestones, 'g1'), 6);
  assert.equal(nextOrderIndex([], 'g1'), 0);
});

test('siirto jonossa kirjoittaa indeksit tiheiksi', () => {
  const milestones = [
    normalizeMilestone({ id: 'a', goalId: 'g1', title: 'A', orderIndex: 0 }),
    normalizeMilestone({ id: 'b', goalId: 'g1', title: 'B', orderIndex: 3 }),
    normalizeMilestone({ id: 'c', goalId: 'g1', title: 'C', orderIndex: 9 })
  ];

  const moved = reorderMilestone(milestones, 'g1', 'c', 'up');
  assert.deepEqual(moved.map(m => m.id), ['a', 'c', 'b']);
  assert.deepEqual(moved.map(m => m.orderIndex), [0, 1, 2]);

  // Reunat eivät liiku.
  assert.deepEqual(reorderMilestone(milestones, 'g1', 'a', 'up'), []);
  assert.deepEqual(reorderMilestone(milestones, 'g1', 'c', 'down'), []);
});

test('KRIITTINEN: mahdoton järjestys havaitaan', () => {
  // Kolmas välitavoite aikaisemmin kuin toinen on suunnitteluvirhe,
  // ei makuasia.
  const breaks = outOfOrderMilestones([
    normalizeMilestone({ id: 'a', goalId: 'g1', title: 'A', orderIndex: 0,
      targetDate: '2026-11-01' }),
    normalizeMilestone({ id: 'b', goalId: 'g1', title: 'B', orderIndex: 1,
      targetDate: '2026-10-01' })
  ], 'g1');

  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].after.id, 'b');
});

test('saavutettu välitavoite ei riko järjestystä', () => {
  // Mennyt järjestys on jo tapahtunut.
  const breaks = outOfOrderMilestones([
    markReached(normalizeMilestone({ id: 'a', goalId: 'g1', title: 'A',
      orderIndex: 0, targetDate: '2026-11-01' }), '2026-09-01'),
    normalizeMilestone({ id: 'b', goalId: 'g1', title: 'B', orderIndex: 1,
      targetDate: '2026-10-01' })
  ], 'g1');
  assert.equal(breaks.length, 0);
});

test('KRIITTINEN: ohitettu välitavoite ei laske eikä nosta edistymistä', () => {
  const milestones = [
    markReached(normalizeMilestone({ id: 'a', goalId: 'g1', title: 'A',
      orderIndex: 0 }), TODAY),
    normalizeMilestone({ id: 'b', goalId: 'g1', title: 'B', orderIndex: 1 }),
    markSkipped(normalizeMilestone({ id: 'c', goalId: 'g1', title: 'C',
      orderIndex: 2 }))
  ];

  const progress = milestoneProgress(milestones, 'g1');
  assert.equal(progress.percent, 50, 'ohitettu laskettiin mukaan');
  assert.equal(progress.total, 2);
  assert.equal(progress.skipped, 1);
});

test('KRIITTINEN: tavoite ilman välitavoitteita on tuntematon, ei nolla', () => {
  const progress = milestoneProgress([], 'g1');
  assert.equal(progress.known, false);
  assert.equal(progress.percent, null, 'tyhjä joukko tuotti nollan');
});

test('johdettu sääntö ei täyty tyhjällä joukolla', () => {
  // Tyhjän joukon pitäminen "täyttyneenä" merkitsisi jokaisen
  // liittämättömän välitavoitteen saavutetuksi heti.
  const milestone = normalizeMilestone({
    id: 'm1', goalId: 'g1', title: 'X', rule: MILESTONE_RULE.TASKS_DONE
  });
  assert.equal(ruleSatisfied(milestone, { tasks: [] }), null);
  assert.equal(ruleSatisfied(milestone, {
    tasks: [{ id: 't1', milestoneId: 'm1', completed: true }]
  }), true);
  assert.equal(ruleSatisfied(milestone, {
    tasks: [{ id: 't1', milestoneId: 'm1', completed: false }]
  }), false);

  // MANUAL ei ole johdettavissa.
  assert.equal(ruleSatisfied(
    normalizeMilestone({ id: 'm2', goalId: 'g1', title: 'Y' }), {}), null);
});

test('vain avoin välitavoite voi olla myöhässä', () => {
  const late = normalizeMilestone({ id: 'a', goalId: 'g1', title: 'A',
    targetDate: '2026-09-01' });
  assert.equal(isMilestoneOverdue(late, TODAY), true);

  assert.equal(isMilestoneOverdue(markSkipped(late), TODAY), false,
    'ohitettu ei ole myöhässä — se on päätös');
  assert.equal(isMilestoneOverdue(markReached(late, '2026-09-02'), TODAY), false);
});

test('nextMilestone palauttaa ensimmäisen avoimen', () => {
  const milestones = [
    markReached(normalizeMilestone({ id: 'a', goalId: 'g1', title: 'A',
      orderIndex: 0 }), TODAY),
    normalizeMilestone({ id: 'b', goalId: 'g1', title: 'B', orderIndex: 1 })
  ];
  assert.equal(nextMilestone(milestones, 'g1').id, 'b');
  assert.equal(nextMilestone([], 'g1'), null);
});

// =====================================================================
// MITTARI
// =====================================================================

test('KRIITTINEN: suunta johdetaan lukujen väliltä, ei kysytä', () => {
  // Sama luku, päinvastainen merkitys. Arvattu suunta kääntäisi
  // edistymisen ja taantumisen keskenään.
  const alas = normalizeTarget({ baselineValue: 90, targetValue: 75 });
  assert.equal(directionOf(alas), METRIC_DIRECTION.DECREASE);

  const ylos = normalizeTarget({ baselineValue: 0, targetValue: 10000 });
  assert.equal(directionOf(ylos), METRIC_DIRECTION.INCREASE);

  const yllapito = normalizeTarget({ baselineValue: 75, targetValue: 75 });
  assert.equal(directionOf(yllapito), METRIC_DIRECTION.MAINTAIN);

  // Ilman lähtöarvoa suuntaa ei voi päätellä.
  assert.equal(directionOf(normalizeTarget({ targetValue: 75 })), null);
});

test('KRIITTINEN: edistyminen lasketaan matkasta, ei arvosta', () => {
  // Painonpudotus 90 -> 82 tavoitteena 75 on 8/15 = 53 %.
  const laihdutus = metricProgress(normalizeTarget({
    metric: 'paino', unit: 'kg', baselineValue: 90, currentValue: 82, targetValue: 75
  }));
  assert.equal(laihdutus.percent, 53);
  assert.equal(laihdutus.regressed, false);

  // Säästö 0 -> 4000 tavoitteena 10000 on 40 %.
  const saasto = metricProgress(normalizeTarget({
    metric: 'säästöt', baselineValue: 0, currentValue: 4000, targetValue: 10000
  }));
  assert.equal(saasto.percent, 40);

  // SAMA KOODI MOLEMPIIN SUUNTIIN. Kaksi haaraa tarkoittaisi kaksi
  // paikkaa, joissa etumerkki voi mennä väärin päin.
});

test('KRIITTINEN: väärään suuntaan liikkuminen merkitään taantumiseksi', () => {
  const taantuma = metricProgress(normalizeTarget({
    metric: 'paino', baselineValue: 90, currentValue: 95, targetValue: 75
  }));
  assert.equal(taantuma.regressed, true);
  assert.equal(taantuma.percent, 0, 'negatiivinen edistyminen ei ole edistymistä');
});

test('KRIITTINEN: puuttuva luku tekee edistymisestä tuntemattoman', () => {
  for (const puuttuva of [
    { currentValue: 82, targetValue: 75 },
    { baselineValue: 90, targetValue: 75 },
    { baselineValue: 90, currentValue: 82 },
    {}
  ]) {
    const progress = metricProgress(normalizeTarget(puuttuva));
    assert.equal(progress.known, false, JSON.stringify(puuttuva));
    assert.equal(progress.percent, null, 'tuntematon tuotti nollan');
  }
});

test('ylläpitotavoite on binäärinen', () => {
  const paikallaan = metricProgress(normalizeTarget({
    metric: 'paino', baselineValue: 75, currentValue: 75, targetValue: 75
  }));
  assert.equal(paikallaan.percent, 100);
  assert.equal(paikallaan.reached, true);

  const liikkunut = metricProgress(normalizeTarget({
    metric: 'paino', baselineValue: 75, currentValue: 78, targetValue: 75
  }));
  assert.equal(liikkunut.percent, 0);
  assert.equal(liikkunut.regressed, true);
});

test('mittari ei ole rahaa: desimaalit säilyvät', () => {
  const target = normalizeTarget({ baselineValue: '90,5', currentValue: '82,4' });
  assert.equal(target.baselineValue, 90.5);
  assert.equal(target.currentValue, 82.4);
  assert.equal(formatNumber(82.4), '82,4');
  assert.equal(formatNumber(null), '');
});

test('mittari ilman nimeä ei kelpaa', () => {
  assert.equal(validateTarget(normalizeTarget({ targetValue: 75 })).valid, false);
  assert.equal(validateTarget(normalizeTarget({
    metric: 'paino', targetValue: 75
  })).valid, true);
  assert.equal(hasTarget(normalizeTarget({})), false);
  assert.equal(describeTarget(normalizeTarget({})), '');
});

// =====================================================================
// EDISTYMISSTRATEGIAT
// =====================================================================

const GOAL = normalizeGoal({ id: 'g1', title: 'Julkaise', targetDate: '2026-12-01' });

test('KRIITTINEN: tavoite ilman mitään on tuntematon, ei nolla', () => {
  const progress = computeProgress(GOAL, {});
  assert.equal(progress.known, false);
  assert.equal(progress.percent, null, 'tyhjä tavoite näytti nollaa');
  assert.ok(progress.reason);
});

test('strategia päätellään: mittari ennen välitavoitteita ennen tehtäviä', () => {
  assert.equal(inferStrategy(GOAL, {
    target: normalizeTarget({ metric: 'paino', targetValue: 75 })
  }), PROGRESS_STRATEGY.METRIC_BASED);

  assert.equal(inferStrategy(GOAL, {
    milestones: [normalizeMilestone({ id: 'm', goalId: 'g1', title: 'M' })]
  }), PROGRESS_STRATEGY.MILESTONE_BASED);

  assert.equal(inferStrategy(GOAL, {}), PROGRESS_STRATEGY.TASK_BASED);
});

test('käyttäjän oma valinta on vahvempi kuin päättely', () => {
  const manual = normalizeGoal({ ...GOAL, progressMode: 'manual', manualProgress: 42 });
  assert.equal(inferStrategy(manual, {
    target: normalizeTarget({ metric: 'x', targetValue: 1 })
  }), PROGRESS_STRATEGY.MANUAL);

  const progress = computeProgress(manual, {});
  assert.equal(progress.percent, 42);
  assert.equal(progress.derived, false, 'käsin merkitty esitettiin johdettuna');
});

test('KRIITTINEN: saavutettu tavoite on sata prosenttia strategiasta riippumatta', () => {
  const done = normalizeGoal({ ...GOAL, status: GOAL_STATUS.COMPLETED });
  const progress = computeProgress(done, {
    tasks: [normalizeTask({ id: 't1', title: 'X', goalId: 'g1', completed: false })]
  });
  assert.equal(progress.percent, 100);
  assert.equal(progress.derived, false);
});

test('KRIITTINEN: hybridi ei laske puuttuvaa osaa nollaksi', () => {
  // Puuttuva osa on POISSA, ei nolla. Painot normalisoidaan jäljelle
  // jäävien kesken, jottei puuttuva mittari painaisi edistymistä alas.
  const context = {
    milestones: [
      markReached(normalizeMilestone({ id: 'a', goalId: 'g1', title: 'A',
        orderIndex: 0 }), TODAY),
      normalizeMilestone({ id: 'b', goalId: 'g1', title: 'B', orderIndex: 1 })
    ],
    tasks: [
      normalizeTask({ id: 't1', title: 'X', goalId: 'g1', completed: true }),
      normalizeTask({ id: 't2', title: 'Y', goalId: 'g1', completed: true })
    ]
  };

  const hybrid = computeProgress(GOAL, context, PROGRESS_STRATEGY.HYBRID);
  assert.equal(hybrid.known, true);

  // Välitavoite 50 % (paino 0,5), tehtävät 100 % (paino 0,2).
  // Mittari puuttuu, joten painot normalisoidaan: 0,5/0,7 ja 0,2/0,7.
  // 50*0,714 + 100*0,286 = 64,3 -> 64.
  assert.equal(hybrid.percent, 64);
  assert.equal(hybrid.parts.length, 2, 'puuttuva osa laskettiin mukaan');

  const painot = hybrid.parts.reduce((sum, part) => sum + part.weight, 0);
  assert.ok(Math.abs(painot - 1) < 0.02, 'painot eivät normalisoitu ykköseksi');
});

test('hybridi on tuntematon jos yhtään osaa ei ole', () => {
  assert.equal(computeProgress(GOAL, {}, PROGRESS_STRATEGY.HYBRID).known, false);
});

test('hybridin painot ovat näkyvissä eivätkä piilotettuja', () => {
  assert.equal(HYBRID_WEIGHTS.milestone + HYBRID_WEIGHTS.metric
    + HYBRID_WEIGHTS.task, 1);
  assert.ok(progressStrategyLabel(PROGRESS_STRATEGY.HYBRID));
});

test('rahatavoitteen luku tulee Taloudesta eikä omasta mittarista', () => {
  const linked = normalizeGoal({ ...GOAL, savingsGoalId: 's1' });
  const savingsSummary = {
    goal: { targetMinor: 1000000, currentMinor: 400000, currency: 'EUR' },
    percent: 40,
    remainingMinor: 600000,
    reached: false
  };

  const progress = computeProgress(linked, { savingsSummary },
    PROGRESS_STRATEGY.METRIC_BASED);

  assert.equal(progress.percent, 40);
  assert.match(progress.reason, /Talous/);

  // Ja muunnos ei laske mitään itse.
  assert.equal(progressFromSavings(savingsSummary).percent, 40);
  assert.equal(progressFromSavings(null).known, false);
});

// =====================================================================
// KAPASITEETTI
// =====================================================================

test('KRIITTINEN: vuorokaudessa ei ole 24 suunniteltavaa tuntia', () => {
  const day = dayCapacity({ tasks: [], dateIso: TODAY });

  assert.ok(day.awakeMinutes < 1440, 'koko vuorokausi laskettiin valveilla oloksi');
  assert.ok(day.usableMinutes < day.awakeMinutes, 'puskuria ei vähennetty');
  assert.equal(day.bufferMinutes, Math.round(day.rawFreeMinutes * DEFAULT_BUFFER_RATIO));
});

test('kiinteä työ pienentää käytettävissä olevaa aikaa', () => {
  const tyhja = dayCapacity({ tasks: [], dateIso: TODAY });
  const varattu = dayCapacity({
    tasks: [normalizeTask({
      id: 't1', title: 'Palaveri', date: TODAY, time: '09:00', endTime: '12:00'
    })],
    dateIso: TODAY
  });

  assert.ok(varattu.usableMinutes < tyhja.usableMinutes);
  assert.equal(varattu.fixedMinutes, 180);
  assert.equal(varattu.counts.fixed, 1);
});

test('puskuria ei vähennetä kahdesti', () => {
  // Puskuri lasketaan VAPAASTA ajasta, ei valveillaoloajasta.
  const day = dayCapacity({ tasks: [], dateIso: TODAY, bufferRatio: 0.5 });
  assert.equal(day.usableMinutes + day.bufferMinutes, day.rawFreeMinutes);
});

test('puskuri ei voi olla koko päivä', () => {
  const liikaa = dayCapacity({ tasks: [], dateIso: TODAY, bufferRatio: 5 });
  assert.ok(liikaa.usableMinutes >= 0);
  const negatiivinen = dayCapacity({ tasks: [], dateIso: TODAY, bufferRatio: -1 });
  assert.equal(negatiivinen.bufferMinutes, 0);
});

test('horisontti rajataan eikä lasketa loputtomiin', () => {
  assert.equal(horizonCapacity({ fromIso: TODAY, toIso: '2026-09-16' }).dayCount, 7);
  assert.equal(horizonCapacity({ fromIso: TODAY, toIso: '2026-09-01' }).dayCount, 0);
  assert.equal(horizonEnd(TODAY, 7), '2026-09-16');
  assert.equal(horizonEnd('roska', 7), null);

  // Yläraja pitää.
  const pitka = horizonEnd(TODAY, 10000);
  assert.ok(pitka < '2028-01-01', 'horisonttia ei rajattu');
});

test('mennyt määräpäivä ei tuota kapasiteettia', () => {
  assert.equal(capacityUntil({
    todayIso: TODAY, deadlineIso: '2026-09-01'
  }), null, 'menneelle määräpäivälle laskettiin kapasiteettia');
});

test('KRIITTINEN: vain keskeneräinen työ lasketaan jäljellä olevaksi', () => {
  const remaining = remainingWork([
    normalizeTask({ id: 't1', title: 'A', completed: true, durationMinutes: 600 }),
    normalizeTask({ id: 't2', title: 'B', completed: false, durationMinutes: 60 }),
    normalizeTask({ id: 't3', title: 'C', completed: false })
  ]);

  assert.equal(remaining.taskCount, 2, 'valmis tehtävä laskettiin kuormaksi');
  assert.equal(remaining.estimatedCount, 1);
  assert.equal(remaining.estimateRatio, 0.5);
  assert.ok(remaining.minutes > 60, 'arviotonta tehtävää ei laskettu lainkaan');
});

test('mahdottomuus näkyy suhdelukuna', () => {
  const fit = feasibility({
    remaining: { minutes: 1000 },
    capacity: { totalUsableMinutes: 500 }
  });
  assert.equal(fit.feasible, false);
  assert.equal(fit.ratio, 2);

  // Nolla kapasiteettia ja nolla työtä on mahdollista, ei mahdotonta.
  assert.equal(feasibility({
    remaining: { minutes: 0 }, capacity: { totalUsableMinutes: 0 }
  }).ratio, 0);

  assert.equal(feasibility({}).feasible, null);
  assert.equal(dailyRequirement(700, 7), 100);
  assert.equal(dailyRequirement(700, 0), null);
});

// =====================================================================
// AUTOMAATIOTASOT
// =====================================================================

test('KRIITTINEN: oletus on varovaisin', () => {
  assert.equal(DEFAULT_AUTOMATION_LEVEL, AUTOMATION_LEVEL.SUGGEST_ONLY);
  assert.equal(normalizeAutomationLevel(undefined), 1);
  assert.equal(normalizeAutomationLevel(null), 1);
  assert.equal(normalizeAutomationLevel('roska'), 1);
  assert.equal(normalizeAutomationLevel(99), 1,
    'tuntematon arvo putosi lähimpään eikä varovaisimpaan');
  assert.equal(normalizeAutomationLevel(0), 1);
  assert.equal(normalizeAutomationLevel(-1), 1);
});

test('KRIITTINEN: taso 1 ei siirrä mitään', () => {
  assert.equal(allowsAutoMove(1), false);
  assert.equal(moveWindow(1, TODAY), null);
  assert.equal(canMoveTo(1, TODAY, TODAY), false,
    'taso 1 salli siirron samaan päivään');
  assert.match(explainRefusal(1, TODAY, '2026-09-11'), /hyväksyntä/i);
});

test('KRIITTINEN: taso 2 sallii vain saman päivän', () => {
  assert.equal(canMoveTo(2, TODAY, TODAY), true);
  assert.equal(canMoveTo(2, TODAY, '2026-09-11'), false);
  assert.equal(canMoveTo(2, TODAY, '2026-09-09'), false);
  assert.deepEqual(moveWindow(2, TODAY), { fromIso: TODAY, toIso: TODAY });
});

test('KRIITTINEN: taso 3 sallii vain saman viikon', () => {
  // 2026-09-10 on torstai. Viikko on ma 7.9. - su 13.9.
  const ikkuna = moveWindow(3, TODAY);
  assert.equal(ikkuna.fromIso, '2026-09-07');
  assert.equal(ikkuna.toIso, '2026-09-13');

  assert.equal(canMoveTo(3, TODAY, '2026-09-13'), true);
  assert.equal(canMoveTo(3, TODAY, '2026-09-14'), false, 'viikon raja vuoti');
  assert.equal(canMoveTo(3, TODAY, '2026-09-06'), false);
});

test('KRIITTINEN: taso 4 on rajattu horisonttiin, ei rajaton', () => {
  const ikkuna = moveWindow(4, TODAY, { horizonEndIso: '2026-10-08' });
  assert.equal(ikkuna.toIso, '2026-10-08');
  assert.equal(canMoveTo(4, TODAY, '2026-10-08', { horizonEndIso: '2026-10-08' }), true);
  assert.equal(canMoveTo(4, TODAY, '2026-12-01', { horizonEndIso: '2026-10-08' }), false,
    'taso 4 salli siirron horisontin ulkopuolelle');

  // Ilman horisonttia taso 4 ei laajene rajattomasti.
  assert.deepEqual(moveWindow(4, TODAY), { fromIso: TODAY, toIso: TODAY });
});

test('KRIITTINEN: taso 4 vaatii nimenomaisen valinnan', () => {
  assert.equal(requiresExplicitOptIn(4), true);
  for (const level of [1, 2, 3]) {
    assert.equal(requiresExplicitOptIn(level), false, `taso ${level}`);
  }
});

test('hyväksyntää vaativa siirto ei katoa', () => {
  const moves = [
    { taskId: 'a', fromDateIso: TODAY, toDateIso: TODAY },
    { taskId: 'b', fromDateIso: TODAY, toDateIso: '2026-09-20' }
  ];

  const { automatic, needsApproval } = partitionMoves(2, moves);
  assert.deepEqual(automatic.map(m => m.taskId), ['a']);
  assert.deepEqual(needsApproval.map(m => m.taskId), ['b']);
  assert.ok(needsApproval[0].reason, 'kiellolle ei annettu perustelua');

  // Taso 1: kaikki odottaa.
  assert.equal(partitionMoves(1, moves).automatic.length, 0);
  assert.equal(partitionMoves(1, moves).needsApproval.length, 2);
});

test('jokaisella tasolla on nimi', () => {
  for (const level of [1, 2, 3, 4]) {
    assert.ok(automationLevelLabel(level).length > 0);
  }
});

// =====================================================================
// RISTIRIIDAT
// =====================================================================

test('KRIITTINEN: vain kiinteä päällekkäisyys on estävä', () => {
  const kiinteat = [
    normalizeTask({ id: 'a', title: 'A', date: TODAY, time: '10:00', endTime: '11:00' }),
    normalizeTask({ id: 'b', title: 'B', date: TODAY, time: '10:30', endTime: '11:30' })
  ];
  const found = detectOverlaps(kiinteat);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, SEVERITY.BLOCKING);
  assert.equal(found[0].code, CONFLICT.OVERLAP);

  // Joustava päällekkäisyys on sijoitusvirhe, jonka aikatauluttaja korjaa.
  const joustavat = kiinteat.map(task =>
    normalizeTask({ ...task, schedulingState: 'auto' }));
  assert.equal(detectOverlaps(joustavat).length, 0);
});

test('mennyt määräpäivä on estävä eikä siitä lasketa kapasiteettia', () => {
  const mennyt = normalizeGoal({ id: 'g1', title: 'X', targetDate: '2026-09-01' });
  const found = detectCapacityConflicts({
    goal: mennyt,
    remaining: { minutes: 100, taskCount: 1, estimatedCount: 0, estimateRatio: 0 },
    capacity: { totalUsableMinutes: 0, dayCount: 0, days: [] },
    todayIso: TODAY
  });

  assert.equal(found.length, 1, 'menneelle määräpäivälle laskettiin lisäksi kapasiteettia');
  assert.equal(found[0].code, CONFLICT.DEADLINE_PAST);
  assert.equal(found[0].severity, SEVERITY.BLOCKING);
});

test('KRIITTINEN: mahdotonta ei esitetä tiukkana', () => {
  const found = detectCapacityConflicts({
    goal: GOAL,
    remaining: { minutes: 2000, taskCount: 5, estimatedCount: 0, estimateRatio: 0 },
    capacity: { totalUsableMinutes: 500, dayCount: 10, days: [] },
    todayIso: TODAY
  });

  const blocking = found.filter(c => c.severity === SEVERITY.BLOCKING);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].code, CONFLICT.INSUFFICIENT_CAPACITY);
  assert.match(blocking[0].message, /ei mahdu/);
});

test('tiukka on varoitus, ei este', () => {
  const found = detectCapacityConflicts({
    goal: GOAL,
    remaining: { minutes: 900, taskCount: 5, estimatedCount: 0, estimateRatio: 0 },
    capacity: { totalUsableMinutes: 1000, dayCount: 10, days: [] },
    todayIso: TODAY
  });

  const tight = found.find(c => c.code === CONFLICT.TIGHT_CAPACITY);
  assert.ok(tight);
  assert.equal(tight.severity, SEVERITY.WARNING);
});

test('heikko arviopohja kerrotaan huomiona', () => {
  const found = detectCapacityConflicts({
    goal: GOAL,
    remaining: { minutes: 100, taskCount: 4, estimatedCount: 3, estimateRatio: 0.75 },
    capacity: { totalUsableMinutes: 10000, dayCount: 10, days: [] },
    todayIso: TODAY
  });

  const weak = found.find(c => c.code === CONFLICT.WEAK_ESTIMATES);
  assert.ok(weak);
  assert.equal(weak.severity, SEVERITY.INFO);
});

test('riippuvuus ei saa olla seuraajansa jälkeen', () => {
  const tasks = [
    normalizeTask({ id: 'a', title: 'Edeltävä', date: '2026-09-20' }),
    normalizeTask({ id: 'b', title: 'Seuraava', date: '2026-09-15', dependsOn: ['a'] })
  ];
  const found = detectDependencyConflicts(tasks);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, SEVERITY.BLOCKING);

  // Valmis edeltäjä ei estä mitään.
  const valmis = [
    normalizeTask({ id: 'a', title: 'Edeltävä', date: '2026-09-20', completed: true }),
    normalizeTask({ id: 'b', title: 'Seuraava', date: '2026-09-15', dependsOn: ['a'] })
  ];
  assert.equal(detectDependencyConflicts(valmis).length, 0);

  // Puuttuva edeltäjä ohitetaan hiljaa: se on eri vika.
  const puuttuva = [
    normalizeTask({ id: 'b', title: 'Seuraava', date: '2026-09-15', dependsOn: ['x'] })
  ];
  assert.equal(detectDependencyConflicts(puuttuva).length, 0);
});

test('KRIITTINEN: portfolio havaitsee sen mitä tavoitekohtainen ei', () => {
  // Jokainen tavoite erikseen mahdollinen, kaikki yhdessä mahdottomia.
  const entries = [
    { goal: normalizeGoal({ id: 'g1', title: 'A' }), remaining: { minutes: 600 } },
    { goal: normalizeGoal({ id: 'g2', title: 'B' }), remaining: { minutes: 600 } },
    { goal: normalizeGoal({ id: 'g3', title: 'C' }), remaining: { minutes: 600 } }
  ];
  const capacity = { totalUsableMinutes: 1000, dayCount: 7, days: [] };

  // Erikseen jokainen mahtuu.
  for (const entry of entries) {
    const fit = feasibility({ remaining: entry.remaining, capacity });
    assert.equal(fit.feasible, true);
  }

  // Yhdessä eivät.
  const found = detectPortfolioConflicts(entries, capacity);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, SEVERITY.BLOCKING);
  assert.equal(found[0].code, CONFLICT.PORTFOLIO_OVERCOMMIT);
  assert.match(found[0].message, /Erikseen jokainen voi olla mahdollinen/);
});

test('yksi tavoite ei ole portfolio', () => {
  assert.equal(detectPortfolioConflicts([
    { goal: GOAL, remaining: { minutes: 100000 } }
  ], { totalUsableMinutes: 10, dayCount: 1, days: [] }).length, 0);
});

test('välitavoite tavoitteen määräpäivän jälkeen on varoitus', () => {
  const found = detectMilestoneConflicts({
    goal: GOAL,
    milestones: [normalizeMilestone({
      id: 'm1', goalId: 'g1', title: 'Myöhäinen', targetDate: '2027-01-01'
    })]
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].code, CONFLICT.MILESTONE_AFTER_GOAL);
  assert.equal(found[0].severity, SEVERITY.WARNING);
});

test('ristiriidat järjestyvät vakavimmasta lievimpään ja deterministisesti', () => {
  const sekaisin = [
    { code: 'b', severity: SEVERITY.INFO, message: 'B' },
    { code: 'a', severity: SEVERITY.BLOCKING, message: 'A' },
    { code: 'c', severity: SEVERITY.WARNING, message: 'C' }
  ];
  assert.deepEqual(sortConflicts(sekaisin).map(c => c.code), ['a', 'c', 'b']);
  assert.equal(hasBlocking(sekaisin), true);
  assert.equal(worstSeverity(sekaisin), SEVERITY.BLOCKING);
  assert.equal(worstSeverity([]), null);

  // Sama syöte tuottaa saman järjestyksen.
  assert.deepEqual(sortConflicts(sekaisin), sortConflicts([...sekaisin].reverse()));
});

test('detectAllConflicts kokoaa osat', () => {
  const found = detectAllConflicts({
    goal: GOAL,
    tasks: [
      normalizeTask({ id: 'a', title: 'A', date: TODAY, time: '10:00', endTime: '11:00' }),
      normalizeTask({ id: 'b', title: 'B', date: TODAY, time: '10:30', endTime: '11:30' })
    ],
    todayIso: TODAY
  });
  assert.ok(found.length >= 1);
  assert.equal(found[0].severity, SEVERITY.BLOCKING);
});

// =====================================================================
// AIKATAULUTUS
// =====================================================================

test('riippuvuudet järjestyvät topologisiksi tasoiksi', () => {
  const tasks = [
    normalizeTask({ id: 'c', title: 'C', dependsOn: ['b'] }),
    normalizeTask({ id: 'a', title: 'A' }),
    normalizeTask({ id: 'b', title: 'B', dependsOn: ['a'] })
  ];
  const levels = dependencyLevels(tasks);
  assert.equal(levels.get('a'), 0);
  assert.equal(levels.get('b'), 1);
  assert.equal(levels.get('c'), 2);
});

test('KRIITTINEN: kehä ei kaada aikatauluttajaa', () => {
  // Kaatuminen olisi huonompi vastaus: käyttäjä ei näkisi
  // suunnitelmaansa lainkaan. Kehä raportoidaan ristiriitana.
  const kehä = [
    normalizeTask({ id: 'a', title: 'A', dependsOn: ['b'] }),
    normalizeTask({ id: 'b', title: 'B', dependsOn: ['a'] })
  ];
  const levels = dependencyLevels(kehä);
  assert.ok(Number.isFinite(levels.get('a')));
  assert.ok(Number.isFinite(levels.get('b')));

  const result = planHorizon({ tasks: kehä, fromIso: TODAY, toIso: '2026-09-16' });
  assert.equal(result.placements.length, 2);
});

test('KRIITTINEN: kiinteää työtä ei siirretä millään tasolla', () => {
  const kiinteä = normalizeTask({
    id: 'fix', title: 'Palaveri', date: TODAY, time: '09:00', endTime: '10:00',
    schedulingState: 'manual'
  });

  assert.equal(isMovable(kiinteä), false);

  for (const level of [1, 2, 3, 4]) {
    const result = planHorizon({
      tasks: [kiinteä], fromIso: TODAY, toIso: '2026-10-08', automationLevel: level
    });
    assert.equal(result.placements.length, 0, `taso ${level} otti kiinteän ehdokkaaksi`);
    assert.equal(result.moves.length, 0, `taso ${level} ehdotti kiinteän siirtoa`);
  }
});

test('automaatin sijoittama työ on siirrettävissä', () => {
  const joustava = normalizeTask({
    id: 'flex', title: 'X', date: TODAY, time: '09:00', endTime: '10:00',
    schedulingState: 'auto'
  });
  assert.equal(isMovable(joustava), true);
});

test('päivätön mutta kellonajaton tehtävä on siirrettävissä', () => {
  // Kellonajan asettaminen on se ele, joka kiinnittää. Pelkkä päivä ei
  // ole lupaus tunnista.
  assert.equal(isMovable(normalizeTask({ id: 'x', title: 'X', date: TODAY })), true);
});

test('valmista tehtävää ei sijoiteta', () => {
  assert.equal(isMovable(normalizeTask({
    id: 'x', title: 'X', date: TODAY, completed: true
  })), false);
});

test('KRIITTINEN: määräpäivän jälkeen ei sijoiteta', () => {
  // Ennemmin `unplaced` ja näkyvä ristiriita kuin ehdotus, joka rikkoo
  // sen mitä käyttäjä pyysi.
  const iso = normalizeTask({
    id: 'iso', title: 'Iso', date: '2026-09-11', durationMinutes: 5000
  });
  const result = planHorizon({ tasks: [iso], fromIso: TODAY, toIso: '2026-10-08' });

  assert.equal(result.placements.length, 0);
  assert.equal(result.unplaced.length, 1);
  assert.match(result.unplaced[0].reason, /Ei sijoitettavissa/);
});

test('riippuvuus sijoitetaan ennen seuraajaansa', () => {
  const tasks = [
    normalizeTask({ id: 'a', title: 'A', durationMinutes: 600 }),
    normalizeTask({ id: 'b', title: 'B', durationMinutes: 600, dependsOn: ['a'] })
  ];
  const result = planHorizon({ tasks, fromIso: TODAY, toIso: '2026-09-20' });

  const a = result.placements.find(p => p.taskId === 'a');
  const b = result.placements.find(p => p.taskId === 'b');
  assert.ok(a && b);
  assert.ok(b.toDateIso >= a.toDateIso, 'seuraaja sijoitettiin ennen edeltäjäänsä');
});

test('KRIITTINEN: sijoitus ei ylitä päivän kapasiteettia', () => {
  const day = dayCapacity({ tasks: [], dateIso: TODAY });

  const tasks = Array.from({ length: 20 }, (_, i) =>
    normalizeTask({ id: `t${i}`, title: `T${i}`, durationMinutes: 120 }));

  const result = planHorizon({ tasks, fromIso: TODAY, toIso: TODAY });
  const sijoitettu = result.placements.reduce((sum, p) => sum + p.minutes, 0);

  assert.ok(sijoitettu <= day.usableMinutes, 'kapasiteetti ylittyi');
  assert.ok(result.unplaced.length > 0, 'ylimääräinen työ katosi');
});

test('sijoitus on deterministinen', () => {
  const tasks = [
    normalizeTask({ id: 'b', title: 'B', durationMinutes: 60, priority: 'normaali' }),
    normalizeTask({ id: 'a', title: 'A', durationMinutes: 60, priority: 'normaali' })
  ];
  const first = planHorizon({ tasks, fromIso: TODAY, toIso: '2026-09-16' });
  const second = planHorizon({ tasks, fromIso: TODAY, toIso: '2026-09-16' });
  assert.deepEqual(
    first.placements.map(p => p.taskId),
    second.placements.map(p => p.taskId));
});

test('määräpäivä painaa enemmän kuin prioriteetti', () => {
  // Kiire on tosiasia, prioriteetti on mielipide.
  const tasks = [
    normalizeTask({ id: 'tarkea', title: 'Tärkeä', durationMinutes: 600,
      priority: 'korkea' }),
    normalizeTask({ id: 'kiire', title: 'Kiireinen', durationMinutes: 600,
      priority: 'matala', date: '2026-09-11' })
  ];

  const result = planHorizon({ tasks, fromIso: TODAY, toIso: '2026-09-30' });
  const kiire = result.placements.find(p => p.taskId === 'kiire');
  const tarkea = result.placements.find(p => p.taskId === 'tarkea');
  assert.ok(kiire.toDateIso <= tarkea.toDateIso);
});

test('jokaisella sijoituksella on perustelu', () => {
  const result = planHorizon({
    tasks: [normalizeTask({ id: 'a', title: 'A', durationMinutes: 60 })],
    fromIso: TODAY, toIso: '2026-09-16'
  });
  assert.ok(result.placements[0].reason.length > 10);
});

test('horisontin yhteenveto ei väitä ylitäyttöä', () => {
  const result = planHorizon({
    tasks: [normalizeTask({ id: 'a', title: 'A', durationMinutes: 60 })],
    fromIso: TODAY, toIso: '2026-09-16'
  });
  const summary = summarizeHorizon(result);
  assert.ok(summary.ratio <= 1, 'sijoitus ylitti kapasiteetin');
  assert.equal(summary.placedCount, 1);
});

test('paikallaan pysyvä merkitään KEPT eikä siirroksi', () => {
  const task = normalizeTask({ id: 'a', title: 'A', date: TODAY, durationMinutes: 60 });
  const result = planHorizon({ tasks: [task], fromIso: TODAY, toIso: '2026-09-16' });
  assert.equal(result.placements[0].result, PLACEMENT.KEPT);
  assert.equal(result.moves.length, 0);
});

// =====================================================================
// ENNUSTE
// =====================================================================

test('KRIITTINEN: määräpäivätön tavoite ei ole aikataulussa', () => {
  const forecast = forecastGoal({
    goal: normalizeGoal({ id: 'g1', title: 'X' }), todayIso: TODAY
  });
  assert.equal(forecast.state, FORECAST.INSUFFICIENT_DATA);
  assert.notEqual(forecast.state, FORECAST.ON_TRACK,
    'määräpäivätön esitettiin aikataulussa olevana');
  assert.equal(forecast.quality, FORECAST_QUALITY.NONE);
});

test('mennyt määräpäivä on myöhässä', () => {
  const forecast = forecastGoal({
    goal: normalizeGoal({ id: 'g1', title: 'X', targetDate: '2026-09-01' }),
    todayIso: TODAY
  });
  assert.equal(forecast.state, FORECAST.DELAYED);
});

test('KRIITTINEN: heikko pohja merkitään karkeaksi', () => {
  const forecast = forecastGoal({
    goal: GOAL,
    remaining: { minutes: 100, taskCount: 4, estimatedCount: 3, estimateRatio: 0.75 },
    capacity: { totalUsableMinutes: 10000, dayCount: 30, days: [] },
    tasks: [],
    todayIso: TODAY
  });
  assert.equal(forecast.quality, FORECAST_QUALITY.WEAK);
  assert.match(forecast.reason, /karkea/i);
});

test('riittämätön aika on myöhässä eikä vaarassa', () => {
  const forecast = forecastGoal({
    goal: GOAL,
    remaining: { minutes: 10000, taskCount: 5, estimatedCount: 0, estimateRatio: 0 },
    capacity: { totalUsableMinutes: 1000, dayCount: 30, days: [] },
    tasks: [],
    todayIso: TODAY
  });
  assert.equal(forecast.state, FORECAST.DELAYED);
});

test('vauhtia ei lasketa yhdestä tehtävästä', () => {
  assert.equal(velocity([
    normalizeTask({ id: 'a', title: 'A', completed: true, date: '2026-09-05' })
  ], TODAY), null, 'yhdestä tehtävästä laskettiin vauhti');

  const kolme = velocity([
    normalizeTask({ id: 'a', title: 'A', completed: true, date: '2026-09-05' }),
    normalizeTask({ id: 'b', title: 'B', completed: true, date: '2026-09-06' }),
    normalizeTask({ id: 'c', title: 'C', completed: true, date: '2026-09-07' })
  ], TODAY);
  assert.ok(kolme > 0);
});

test('valmistumispäivä kuluttaa kapasiteettia päivä kerrallaan', () => {
  const capacity = {
    dayCount: 3,
    totalUsableMinutes: 300,
    days: [
      { dateIso: TODAY, usableMinutes: 100 },
      { dateIso: '2026-09-11', usableMinutes: 100 },
      { dateIso: '2026-09-12', usableMinutes: 100 }
    ]
  };

  assert.equal(projectDoneDate({
    remaining: { minutes: 150 }, capacity, todayIso: TODAY
  }), '2026-09-11');

  // Horisontti loppuu ensin -> null, ei arvaus.
  assert.equal(projectDoneDate({
    remaining: { minutes: 5000 }, capacity, todayIso: TODAY
  }), null);
});

test('KRIITTINEN: korjaavat toimet eivät luovuta tavoitetta', () => {
  const forecast = forecastGoal({
    goal: GOAL,
    remaining: { minutes: 10000, taskCount: 5, estimatedCount: 0, estimateRatio: 0 },
    capacity: { totalUsableMinutes: 1000, dayCount: 30, days: [] },
    tasks: [],
    todayIso: TODAY
  });

  const corrections = suggestCorrections({
    goal: GOAL, forecast, remaining: { minutes: 10000, taskCount: 5 }
  });

  const codes = corrections.map(c => c.code);
  assert.ok(codes.length > 0);
  assert.equal(codes.includes('abandon'), false, 'ehdotettiin luovuttamista');

  // MÄÄRÄPÄIVÄN SIIRTO ON VIIMEINEN: se on tehokkain ja tuhoavin,
  // koska se tekee ongelmasta näkymättömän muuttamatta mitään.
  assert.equal(codes[codes.length - 1], CORRECTION.MOVE_DEADLINE);
});

test('aikataulussa oleva tavoite ei saa turhia korjausehdotuksia', () => {
  const forecast = forecastGoal({
    goal: GOAL,
    remaining: { minutes: 100, taskCount: 2, estimatedCount: 0, estimateRatio: 0 },
    capacity: { totalUsableMinutes: 10000, dayCount: 30, days: [] },
    tasks: [
      normalizeTask({ id: 'a', title: 'A', completed: true, date: '2026-09-05' }),
      normalizeTask({ id: 'b', title: 'B', completed: true, date: '2026-09-06' }),
      normalizeTask({ id: 'c', title: 'C', completed: true, date: '2026-09-07' })
    ],
    todayIso: TODAY
  });

  assert.equal(forecast.state, FORECAST.ON_TRACK);
  assert.equal(suggestCorrections({ goal: GOAL, forecast }).length, 0);
  assert.ok(forecastLabel(forecast.state));
});

// =====================================================================
// UUDELLEENSUUNNITTELU
// =====================================================================

test('myöhässä ei tarkoita eilen', () => {
  const tasks = [
    normalizeTask({ id: 'a', title: 'A', date: '2026-09-05' }),
    normalizeTask({ id: 'b', title: 'B', date: TODAY }),
    normalizeTask({ id: 'c', title: 'C', date: '2026-09-05', completed: true })
  ];
  assert.deepEqual(missedTasks(tasks, TODAY).map(t => t.id), ['a']);
});

test('KRIITTINEN: tauolla olevan tavoitteen työtä ei suunnitella', () => {
  // Jos aikatauluttaja sijoittaisi tauolla olevan tavoitteen tehtäviä,
  // tauko ei tarkoittaisi mitään.
  const proposal = buildReplanProposal({
    tasks: [normalizeTask({ id: 'a', title: 'A', goalId: 'g2', date: '2026-09-05' })],
    goals: [normalizeGoal({ id: 'g2', title: 'Tauolla', status: GOAL_STATUS.PAUSED })],
    todayIso: TODAY
  });
  assert.equal(proposal.changes.length, 0);
});

test('vain aktiivinen tavoite kilpailee ajasta', () => {
  assert.deepEqual([...SCHEDULING_STATUSES], [GOAL_STATUS.ACTIVE]);
});

test('KRIITTINEN: muutosehdotus on delta eikä koko suunnitelma', () => {
  const tasks = [
    normalizeTask({ id: 'a', title: 'Myöhässä', date: '2026-09-05', durationMinutes: 60 }),
    normalizeTask({ id: 'b', title: 'Paikallaan', date: TODAY, durationMinutes: 60 })
  ];

  const proposal = buildReplanProposal({ tasks, todayIso: TODAY, automationLevel: 1 });

  assert.equal(proposal.changes.length, 1, 'paikallaan pysyvä listattiin muutoksena');
  assert.equal(proposal.changes[0].taskId, 'a');
  assert.equal(proposal.changes[0].overdue, true);
  assert.ok(describeChange(proposal.changes[0]).includes('jäi tekemättä'));
});

test('KRIITTINEN: taso 1 ei toteuta yhtään siirtoa automaattisesti', () => {
  const proposal = buildReplanProposal({
    tasks: [normalizeTask({ id: 'a', title: 'A', date: '2026-09-05', durationMinutes: 60 })],
    todayIso: TODAY,
    automationLevel: 1
  });
  assert.equal(proposal.automatic.length, 0);
  assert.equal(proposal.needsApproval.length, proposal.changes.length);
});

test('rutiinin toistuva väliin jääminen havaitaan poikkeuksista', () => {
  const routines = [{ id: 'r1', title: 'Lenkki', active: true }];
  const exceptions = ['2026-09-01', '2026-09-03', '2026-09-05'].map(date => ({
    id: `x-${date}`, routineId: 'r1', date, type: 'skip'
  }));

  const skipped = repeatedlySkippedRoutines(routines, exceptions, TODAY);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].skipCount, 3);

  // Kaksi kertaa ei vielä riitä.
  assert.equal(repeatedlySkippedRoutines(routines, exceptions.slice(0, 2), TODAY).length, 0);
});

test('laukaisimet havaitaan eikä ehdoteta ilman syytä', () => {
  const tyhja = detectReplanTriggers({ tasks: [], todayIso: TODAY });
  assert.equal(tyhja.needed, false, 'ehdotettiin uudelleensuunnittelua ilman syytä');

  const syyt = detectReplanTriggers({
    tasks: [normalizeTask({ id: 'a', title: 'A', date: '2026-09-05' })],
    milestones: [normalizeMilestone({
      id: 'm', goalId: 'g1', title: 'M', targetDate: '2026-09-01'
    })],
    todayIso: TODAY
  });
  assert.equal(syyt.needed, true);
  assert.deepEqual(syyt.triggers.map(t => t.trigger).sort(),
    [REPLAN_TRIGGER.MILESTONE_DELAYED, REPLAN_TRIGGER.MISSED_TASK].sort());
  assert.ok(triggerLabel(REPLAN_TRIGGER.MISSED_TASK));
});

test('ei siirrettävää sanotaan ääneen', () => {
  const proposal = buildReplanProposal({ tasks: [], todayIso: TODAY });
  assert.equal(proposal.changes.length, 0);
  assert.ok(proposal.summary.reason);
});

// =====================================================================
// SUUNNITELMAEHDOTUS
// =====================================================================

const RAW_PLAN = Object.freeze({
  goal: { title: 'Julkaise KartZeno', targetDate: '2026-12-01', confidence: 'high' },
  milestones: [{ ref: 'm1', title: 'Ominaisuusvalmis', targetDate: '2026-11-01' }],
  projects: [{ ref: 'p1', name: 'Julkaisuvalmius', milestoneRef: 'm1' }],
  tasks: [
    { ref: 't1', title: 'Viimeistele X', projectRef: 'p1', durationMinutes: 120 },
    { ref: 't2', title: 'Hyväksyntäajo', projectRef: 'p1', dependsOnRefs: ['t1'],
      durationMinutes: 60 }
  ],
  routines: [{ ref: 'r1', title: 'Viikkokatsaus', recurrenceType: 'weekly', weekdays: [1] }],
  assumptions: ['Oletin että julkaisu tarkoittaa Play-kauppaa.'],
  questions: ['Onko beta-testaajia jo olemassa?']
});

test('KRIITTINEN: ehdotettu ei ole hyväksytty', () => {
  const plan = normalizePlan({ ...RAW_PLAN, status: PLAN_STATUS.GENERATED });
  assert.equal(toCommittable(plan, { makeId }), null,
    'ehdotettu suunnitelma pääsi tallennettavaksi');
});

test('KRIITTINEN: katsottu ei ole hyväksytty', () => {
  const plan = applyEdit(
    normalizePlan({ ...RAW_PLAN, status: PLAN_STATUS.GENERATED }), {});
  assert.equal(plan.status, PLAN_STATUS.REVIEWED);
  assert.equal(toCommittable(plan, { makeId }), null);
});

test('KRIITTINEN: hylätty ei tuota mitään', () => {
  const plan = rejectPlan(normalizePlan({ ...RAW_PLAN, status: PLAN_STATUS.GENERATED }));
  assert.equal(plan.status, PLAN_STATUS.REJECTED);
  assert.equal(toCommittable(plan, { makeId }), null);

  // Hylätystä ei palata.
  assert.equal(canTransition(PLAN_STATUS.REJECTED, PLAN_STATUS.APPROVED), false);
  assert.equal(applyEdit(plan, {}), null);
});

test('KRIITTINEN: hyväksytty tuottaa tallennettavan', () => {
  const approved = approvePlan(
    normalizePlan({ ...RAW_PLAN, status: PLAN_STATUS.GENERATED }), '2026-09-10T10:00:00Z');

  assert.equal(approved.status, PLAN_STATUS.APPROVED);

  const committable = toCommittable(approved, { makeId });
  assert.ok(committable);
  assert.equal(committable.milestones.length, 1);
  assert.equal(committable.tasks.length, 2);
  assert.equal(committable.routines.length, 1);
});

test('KRIITTINEN: muokkaus hyväksynnän jälkeen palauttaa katsotuksi', () => {
  // Muuten käyttäjä voisi hyväksyä yhden suunnitelman ja tallentaa toisen.
  const approved = approvePlan(
    normalizePlan({ ...RAW_PLAN, status: PLAN_STATUS.GENERATED }));
  const edited = applyEdit(approved, {});

  assert.equal(edited.status, PLAN_STATUS.REVIEWED);
  assert.equal(toCommittable(edited, { makeId }), null);
});

test('KRIITTINEN: tyhjää suunnitelmaa ei voi hyväksyä', () => {
  const tyhja = normalizePlan({
    goal: { title: 'X' }, status: PLAN_STATUS.GENERATED
  });
  assert.equal(validatePlan(tyhja).valid, false);
  assert.equal(approvePlan(tyhja), null);
});

test('KRIITTINEN: mallin tunnisteita ei käytetä', () => {
  const approved = approvePlan(
    normalizePlan({ ...RAW_PLAN, status: PLAN_STATUS.GENERATED }));

  let ids = 0;
  const committable = toCommittable(approved, { makeId: () => `gen-${++ids}` });

  // Jokainen tunniste tulee generaattorista.
  for (const row of [committable.goal, ...committable.milestones,
    ...committable.projects, ...committable.tasks, ...committable.routines]) {
    if (!row) continue;
    assert.match(row.id, /^gen-\d+$/, `tunniste ei tullut generaattorista: ${row.id}`);
  }
});

test('KRIITTINEN: ehdotettu tehtävä ei ole ajastettu', () => {
  // Aika tulee aikatauluttajalta ja käyttäjän hyväksynnästä, ei
  // suunnittelijalta. Muuten hyväksytty suunnitelma täyttäisi
  // kalenterin kellonajoilla, joita kukaan ei valinnut.
  const approved = approvePlan(
    normalizePlan({ ...RAW_PLAN, status: PLAN_STATUS.GENERATED }));
  const committable = toCommittable(approved, { makeId });

  for (const task of committable.tasks) {
    assert.equal(task.time, null, 'ehdotus kiinnitti kellonajan');
    assert.equal(task.endTime, null);
    assert.equal(task.schedulingState, 'unscheduled');
    assert.equal(task.completed, false);
  }
});

test('paikalliset viittaukset käännetään oikeiksi tunnisteiksi', () => {
  const approved = approvePlan(
    normalizePlan({ ...RAW_PLAN, status: PLAN_STATUS.GENERATED }));
  const committable = toCommittable(approved, { makeId });

  const milestone = committable.milestones[0];
  const project = committable.projects[0];
  const [first, second] = committable.tasks;

  assert.equal(project.milestoneId, milestone.id);
  assert.equal(first.projectId, project.id);
  assert.deepEqual(second.dependsOn, [first.id]);
  assert.equal(first.goalId, committable.goalId);
});

test('KRIITTINEN: roikkuva viittaus estää hyväksynnän', () => {
  const rikki = normalizePlan({
    ...RAW_PLAN,
    status: PLAN_STATUS.GENERATED,
    tasks: [{ ref: 't9', title: 'X', projectRef: 'ei-ole' }]
  });

  assert.deepEqual(danglingRefs(rikki), ['ei-ole']);
  assert.equal(validatePlan(rikki).valid, false);
  assert.equal(approvePlan(rikki), null);
});

test('poissuljettu kohta ei päädy tallennukseen mutta säilyy ehdotuksessa', () => {
  const plan = normalizePlan({
    ...RAW_PLAN,
    status: PLAN_STATUS.GENERATED,
    routines: [{ ref: 'r1', title: 'Viikkokatsaus', excluded: true }]
  });

  assert.equal(plan.routines.length, 1, 'poissuljettu poistettiin ehdotuksesta');
  assert.equal(included(plan.routines).length, 0);

  const committable = toCommittable(approvePlan(plan), { makeId });
  assert.equal(committable.routines.length, 0);
  assert.equal(summarizePlan(plan).excluded, 1);
});

test('poissuljettuun viittaava kohta on roikkuva viittaus', () => {
  const plan = normalizePlan({
    ...RAW_PLAN,
    status: PLAN_STATUS.GENERATED,
    milestones: [{ ref: 'm1', title: 'M', excluded: true }]
  });
  assert.ok(danglingRefs(plan).includes('m1'));
});

test('tallennettu on päätetila', () => {
  const approved = approvePlan(
    normalizePlan({ ...RAW_PLAN, status: PLAN_STATUS.GENERATED }));
  const committed = markCommitted(approved, '2026-09-10T10:00:00Z', 'g99');

  assert.equal(committed.status, PLAN_STATUS.COMMITTED);
  assert.equal(committed.goalId, 'g99');
  assert.equal(markCommitted(committed), null, 'tallennettu tallennettiin uudelleen');
  assert.equal(applyEdit(committed, {}), null);
  assert.equal(toCommittable(committed, { makeId }), null);
});

test('korvattu ehdotus ei enää etene', () => {
  const superseded = supersedePlan(
    normalizePlan({ ...RAW_PLAN, status: PLAN_STATUS.GENERATED }));
  assert.equal(superseded.status, PLAN_STATUS.SUPERSEDED);
  assert.equal(approvePlan(superseded), null);
});

test('toCommittable vaatii tunnistegeneraattorin', () => {
  const approved = approvePlan(
    normalizePlan({ ...RAW_PLAN, status: PLAN_STATUS.GENERATED }));
  assert.equal(toCommittable(approved, {}), null);
  assert.equal(toCommittable(approved, { makeId: 'ei-funktio' }), null);
});

test('olemassa olevaan tavoitteeseen ei luoda uutta tavoitetta', () => {
  const approved = approvePlan(normalizePlan({
    ...RAW_PLAN, status: PLAN_STATUS.GENERATED, goalId: 'g-olemassa',
    kind: PLAN_KIND.REPLAN
  }));
  const committable = toCommittable(approved, { makeId, goalId: 'g-olemassa' });

  assert.equal(committable.goal, null, 'replan loi uuden tavoitteen');
  assert.equal(committable.goalId, 'g-olemassa');
});

test('ehdotuksen koko on rajattu', () => {
  const iso = normalizePlan({
    goal: { title: 'X' },
    status: PLAN_STATUS.GENERATED,
    tasks: Array.from({ length: 500 }, (_, i) => ({ ref: `t${i}`, title: `T${i}` }))
  });
  assert.equal(iso.tasks.length, LIMITS.tasks);
});

test('yhteenveto lasketaan sisällytetyistä', () => {
  const plan = normalizePlan({
    ...RAW_PLAN,
    status: PLAN_STATUS.GENERATED,
    tasks: [
      { ref: 't1', title: 'A', durationMinutes: 60 },
      { ref: 't2', title: 'B', excluded: true, durationMinutes: 600 }
    ]
  });

  const summary = summarizePlan(plan);
  assert.equal(summary.tasks, 1);
  assert.equal(summary.estimatedMinutes, 60, 'poissuljettu laskettiin kuormaan');
  assert.equal(countIncluded(plan), 1 + 1 + 1 + 1);
});

// =====================================================================
// TEKOÄLYN VASTAUS
// =====================================================================

test('KRIITTINEN: mallin tunniste ja kellonaika pudotetaan', () => {
  const result = validatePlanResponse(JSON.stringify({
    goal: { title: 'X' },
    tasks: [{
      ref: 't1', title: 'Tehtävä', id: 'OLEMASSA-OLEVA', time: '09:00',
      completed: true, schedulingState: 'manual', user_id: 'toinen-kayttaja'
    }]
  }), {});

  assert.equal(result.ok, true);
  const task = result.plan.tasks[0];
  assert.equal(task.id, undefined, 'mallin tunniste pääsi läpi');
  assert.equal(task.time, undefined);
  assert.equal(task.completed, undefined);

  // Ja hylätyt kentät kirjataan, jotta kehotteen ajautuminen huomataan.
  for (const field of ['id', 'time', 'completed', 'schedulingState', 'user_id']) {
    assert.ok(result.rejectedFields.includes(field), `${field} ei kirjattu`);
  }
});

test('KRIITTINEN: kelvoton vastaus hylätään kokonaan', () => {
  for (const roska of ['', 'ei json', '{', '[]', 'null', '{}',
    '{"goal":{}}', '{"goal":{"title":"X"}}', null, undefined, 42]) {
    const result = validatePlanResponse(roska, {});
    assert.equal(result.ok, false, `hyväksyttiin: ${String(roska)}`);
    assert.ok(result.reason, 'hylkäykselle ei annettu syytä');
    assert.equal(result.plan, undefined, 'hylätty vastaus palautti suunnitelman');
  }
});

test('koodilohkoon käärytty vastaus luetaan', () => {
  const json = JSON.stringify({
    goal: { title: 'X' }, tasks: [{ ref: 't1', title: 'A' }]
  });
  assert.equal(validatePlanResponse('```json\n' + json + '\n```', {}).ok, true);
  assert.equal(validatePlanResponse('Tässä suunnitelma:\n' + json, {}).ok, true);
});

test('liian pitkä vastaus hylätään', () => {
  assert.equal(validatePlanResponse('{'.repeat(100000), {}).ok, false);
});

test('KRIITTINEN: konteksti on lukuja eikä sisältöä', () => {
  const context = buildPlanningContext({
    goals: [
      normalizeGoal({ id: 'g1', title: 'Salainen tavoite', status: 'active',
        targetDate: '2026-10-01' })
    ],
    capacity: { dayCount: 7, totalUsableMinutes: 5040 },
    todayIso: TODAY
  });

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes('Salainen'), false,
    'tavoitteen nimi vuoti kontekstiin');
  assert.equal(typeof context.activeGoalCount, 'number');
  assert.equal(typeof context.nearestDeadlineDays, 'number');
  assert.equal(typeof context.weeklyFreeHours, 'number');
});
