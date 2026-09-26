// Tapojen muutoksen moottori: vaihe, seuraava suunniteltu aika, päivän tila,
// edistyminen ja säästö.
//
// Kellonajat annetaan AINA eksplisiittisinä hetkinä. Hetket rakennetaan
// UTC:stä tunnetulla Helsingin erolla (+2 talvella, +3 kesällä), jotta testi
// ei nojaa samaan vyöhykemuunnokseen, jota se testaa. Kesäajan vaihdokset
// 2026: 29.3. klo 03 -> 04 ja 25.10. klo 04 -> 03.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  currentStep, nextPlannedTime, status, progress, moneySaved, habitActionText,
  HABIT_STATE, HABIT_STATES
} from '../src/domain/habitEngine.js';
import { HABIT_RULES } from '../src/domain/dailyLifeSignalsPolicy.js';
import { HABIT_ACTION, MAX_HABIT_STEPS } from '../src/domain/dailyLife.js';

const MIN = 60 * 1000;
/** Helsingin kesäaika (EEST, UTC+3). */
const summer = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+03:00`);
/** Helsingin talviaika (EET, UTC+2). */
const winter = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+02:00`);
const isoZ = ms => new Date(ms).toISOString();

function plan(overrides = {}) {
  return {
    id: 'p1', kind: 'nicotine', name: 'Nuuska', minIntervalMinutes: 60, dailyTarget: 8,
    baselinePerDay: 12, steps: [], reminderDelivery: 'silent', unitCostMinor: 50, active: true,
    createdAt: '2026-01-01T08:00:00Z', ...overrides
  };
}

let seq = 0;
function ev(ms, action = 'use', overrides = {}) {
  seq += 1;
  return { id: `e${String(seq).padStart(6, '0')}`, planId: 'p1', occurredAt: isoZ(ms), action, note: null, ...overrides };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

function shuffled(list, seed = 7) {
  const copy = [...list];
  let s = seed;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const SHAME = /epäonnist|retkah|huono|laiska|häpe|pitäisi/i;

// ================================================================ VAIHE

test('vaihe: ilman vaiheita käytetään suunnitelman omia arvoja', () => {
  const step = currentStep(plan(), '2026-06-01');
  assert.equal(step.source, 'plan');
  assert.equal(step.index, null);
  assert.equal(step.from, null);
  assert.equal(step.intervalMinutes, 60);
  assert.equal(step.dailyTarget, 8);
  assert.equal(step.nextStepFrom, null);
  assert.ok(Object.isFrozen(step));
});

test('vaihe: myöhäisin alkanut vaihe on voimassa, raja mukaan lukien', () => {
  const p = plan({
    steps: [
      { from: '2026-06-15', intervalMinutes: 90, dailyTarget: 6 },
      { from: '2026-06-01', intervalMinutes: 75, dailyTarget: 7 },
      { from: '2026-07-01', intervalMinutes: 120, dailyTarget: null }
    ]
  });
  assert.equal(currentStep(p, '2026-05-31').source, 'plan');
  assert.equal(currentStep(p, '2026-05-31').nextStepFrom, '2026-06-01');
  assert.equal(currentStep(p, '2026-06-01').intervalMinutes, 75, 'alkupäivä kuuluu vaiheeseen');
  assert.equal(currentStep(p, '2026-06-14').intervalMinutes, 75);
  assert.equal(currentStep(p, '2026-06-15').intervalMinutes, 90);
  assert.equal(currentStep(p, '2026-06-15').index, 1);
  const july = currentStep(p, '2026-07-02');
  assert.equal(july.intervalMinutes, 120);
  assert.equal(july.dailyTarget, 8, 'vaiheen tyhjä päivätavoite perii suunnitelman arvon');
  assert.equal(july.nextStepFrom, null);
  assert.equal(july.stepCount, 3);
});

test('vaihe: sama alkupäivä kahdesti ratkeaa samoin syötteen järjestyksestä riippumatta', () => {
  const steps = [
    { from: '2026-06-01', intervalMinutes: 75, dailyTarget: 7 },
    { from: '2026-06-01', intervalMinutes: 90, dailyTarget: 9 },
    { from: '2026-06-01', intervalMinutes: null, dailyTarget: 5 }
  ];
  const a = currentStep(plan({ steps }), '2026-06-02');
  const b = currentStep(plan({ steps: [...steps].reverse() }), '2026-06-02');
  assert.deepEqual(a, b);
  assert.equal(a.intervalMinutes, 90);
  assert.equal(a.stepCount, 1);
});

test('vaihe: vaiheita enintään MAX_HABIT_STEPS, roskavaiheet ohitetaan', () => {
  const steps = [];
  for (let i = 0; i < 80; i += 1) steps.push({ from: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`, intervalMinutes: 30 + i });
  steps.push(null, 'x', { from: '2026-02-30', intervalMinutes: 10 }, { from: '2026-01-05', intervalMinutes: 99999 });
  const step = currentStep(plan({ steps }), '2027-01-01');
  assert.ok(step.stepCount <= MAX_HABIT_STEPS);
  assert.equal(currentStep(plan({ steps: 'ei lista' }), '2026-01-01').stepCount, 0);
});

test('vaihe: roskasyöte palauttaa null eikä heitä', () => {
  assert.equal(currentStep(null, '2026-06-01'), null);
  assert.equal(currentStep([], '2026-06-01'), null);
  assert.equal(currentStep(plan(), '2026-02-30'), null);
  assert.equal(currentStep(plan(), null), null);
  const odd = currentStep({ minIntervalMinutes: '45', dailyTarget: -3 }, '2026-06-01');
  assert.equal(odd.intervalMinutes, 45);
  assert.equal(odd.dailyTarget, null, 'rajojen ulkopuolinen tavoite on tuntematon, ei nolla');
});

// ================================================================ SEURAAVA AIKA

test('seuraava suunniteltu aika = viimeisin käyttökerta + väli', () => {
  const use = summer('2026-06-10', '13:20');
  const next = nextPlannedTime({ plan: plan(), events: [ev(summer('2026-06-10', '09:00')), ev(use)], nowMs: use + 5 * MIN });
  assert.equal(next, use + 60 * MIN);
});

test('seuraava aika: ei käyttökertaa tai ei väliä -> null (tuntematon, ei "nyt heti")', () => {
  const now = summer('2026-06-10', '12:00');
  assert.equal(nextPlannedTime({ plan: plan(), events: [], nowMs: now }), null);
  assert.equal(nextPlannedTime({ plan: plan({ minIntervalMinutes: null }), events: [ev(now - MIN)], nowMs: now }), null);
  assert.equal(nextPlannedTime({ plan: plan(), events: [ev(now - MIN)], nowMs: NaN }), null);
  assert.equal(nextPlannedTime({ plan: null, events: [], nowMs: now }), null);
  assert.equal(nextPlannedTime(), null);
});

test('seuraava aika: toisen suunnitelman kirjaukset eivät vaikuta', () => {
  const now = summer('2026-06-10', '12:00');
  const mine = ev(summer('2026-06-10', '11:00'));
  const other = ev(summer('2026-06-10', '11:50'), 'use', { planId: 'toinen' });
  assert.equal(nextPlannedTime({ plan: plan(), events: [mine, other], nowMs: now }), summer('2026-06-10', '12:00'));
});

test('toiminnot: siirto lykkää 15 min, ohitus koko välin, kumpikaan ei aikaista', () => {
  const use = summer('2026-06-10', '10:00');
  const p = plan();
  // Siirto ennen suunniteltua aikaa ei muuta mitään.
  assert.equal(nextPlannedTime({ plan: p, events: [ev(use), ev(use + 10 * MIN, 'delay')], nowMs: use + 20 * MIN }),
    use + 60 * MIN);
  // Siirto suunniteltuna hetkenä: +15 min.
  assert.equal(nextPlannedTime({ plan: p, events: [ev(use), ev(use + 60 * MIN, 'delay')], nowMs: use + 61 * MIN }),
    use + 75 * MIN);
  // Ohitus: seuraava kerta välin päästä ohituksesta.
  assert.equal(nextPlannedTime({ plan: p, events: [ev(use), ev(use + 65 * MIN, 'skip')], nowMs: use + 66 * MIN }),
    use + 125 * MIN);
  // Uusi käyttökerta nollaa aiemmat siirrot.
  assert.equal(nextPlannedTime({
    plan: p, events: [ev(use), ev(use + 60 * MIN, 'delay'), ev(use + 80 * MIN)], nowMs: use + 81 * MIN
  }), use + 140 * MIN);
  // Siirto ei koskaan ole pidempi kuin väli.
  const short = plan({ minIntervalMinutes: 10 });
  assert.equal(nextPlannedTime({ plan: short, events: [ev(use), ev(use + 10 * MIN, 'delay')], nowMs: use + 11 * MIN }),
    use + 20 * MIN);
  // Ilman väliä siirto lykkää silti muistutusta.
  const noInterval = plan({ minIntervalMinutes: null });
  assert.equal(nextPlannedTime({ plan: noInterval, events: [ev(use, 'delay')], nowMs: use + MIN }),
    use + HABIT_RULES.DELAY_MINUTES * MIN);
});

test('seuraava aika: tulevaisuuden kirjaus ohitetaan, pieni kellojen ero sallitaan', () => {
  const now = summer('2026-06-10', '12:00');
  const withinSkew = ev(now + (HABIT_RULES.FUTURE_SKEW_MINUTES - 1) * MIN);
  const beyondSkew = ev(now + (HABIT_RULES.FUTURE_SKEW_MINUTES + 1) * MIN);
  assert.equal(nextPlannedTime({ plan: plan(), events: [withinSkew], nowMs: now }),
    now + (HABIT_RULES.FUTURE_SKEW_MINUTES - 1 + 60) * MIN);
  assert.equal(nextPlannedTime({ plan: plan(), events: [beyondSkew], nowMs: now }), null);
});

test('seuraava aika: vyöhykkeetön aikaleima tulkitaan annetun vyöhykkeen seinäkelloksi', () => {
  const now = summer('2026-06-10', '12:00');
  const local = { id: 'x', planId: 'p1', occurredAt: '2026-06-10T11:00:00', action: 'use' };
  assert.equal(nextPlannedTime({ plan: plan(), events: [local], nowMs: now }), summer('2026-06-10', '12:00'));
  const ny = nextPlannedTime({ plan: plan(), events: [local], nowMs: now + 10 * 3600 * 1000, timeZone: 'America/New_York' });
  assert.equal(ny, Date.parse('2026-06-10T12:00:00-04:00'));
});

// ================================================================ TILA

test('tila: odota -> "Seuraava suunniteltu aika 14.20"', () => {
  const use = summer('2026-06-10', '13:20');
  const s = status({ plan: plan(), events: [ev(use)], nowMs: summer('2026-06-10', '13:50') });
  assert.equal(s.state, HABIT_STATE.WAIT);
  assert.equal(s.minutesUntil, 30);
  assert.equal(s.nextAtMs, summer('2026-06-10', '14:20'));
  assert.equal(s.text, 'Seuraava suunniteltu aika 14.20');
  assert.equal(s.usesToday, 1);
  assert.equal(s.dailyTarget, 8);
  assert.equal(s.intervalMinutes, 60);
  assert.equal(s.todayIso, '2026-06-10');
  assert.ok(Object.isFrozen(s));
});

test('tila: raja — täsmälleen suunniteltuna hetkenä ok_now, millisekuntia ennen odota (1 min)', () => {
  const use = summer('2026-06-10', '13:20');
  const next = use + 60 * MIN;
  const at = status({ plan: plan(), events: [ev(use)], nowMs: next });
  assert.equal(at.state, HABIT_STATE.OK_NOW);
  assert.equal(at.minutesUntil, 0);
  assert.equal(at.text, 'Suunniteltu väli on kulunut.');
  const before = status({ plan: plan(), events: [ev(use)], nowMs: next - 1 });
  assert.equal(before.state, HABIT_STATE.WAIT);
  assert.equal(before.minutesUntil, 1, 'osaminuutti pyöristyy ylöspäin');
});

test('tila: ilman kirjauksia ok_now, ilman suunnitelmaa no_plan, ilman kelloa null', () => {
  const now = summer('2026-06-10', '08:00');
  const fresh = status({ plan: plan(), events: [], nowMs: now });
  assert.equal(fresh.state, HABIT_STATE.OK_NOW);
  assert.equal(fresh.nextAtMs, null);
  assert.equal(fresh.usesToday, 0);
  assert.equal(status({ plan: plan({ active: false }), events: [], nowMs: now }).state, HABIT_STATE.NO_PLAN);
  const none = status({ plan: null, events: [], nowMs: now });
  assert.equal(none.state, HABIT_STATE.NO_PLAN);
  assert.equal(none.usesToday, null, 'ilman suunnitelmaa kertamäärä on tuntematon');
  assert.equal(status({ plan: plan(), events: [], nowMs: 'nyt' }), null);
  assert.deepEqual([...HABIT_STATES].sort(), ['daily_target_reached', 'no_plan', 'ok_now', 'wait']);
});

test('tila: päivätavoite ohittaa välin, nolla ja ylitys kerrotaan neutraalisti', () => {
  const day = '2026-06-10';
  const uses = ['07:00', '08:30', '10:00'].map(t => ev(summer(day, t)));
  const reached = status({ plan: plan({ dailyTarget: 3 }), events: uses, nowMs: summer(day, '10:05') });
  assert.equal(reached.state, HABIT_STATE.DAILY_TARGET_REACHED);
  assert.equal(reached.nextAtMs, null);
  assert.equal(reached.minutesUntil, null);
  assert.equal(reached.text, 'Päivän suunniteltu määrä on käytetty (3/3).');
  const over = status({ plan: plan({ dailyTarget: 2 }), events: uses, nowMs: summer(day, '10:05') });
  assert.equal(over.text, 'Tänään 3 kertaa, suunnitelmassa 2.');
  const zero = status({ plan: plan({ dailyTarget: 0 }), events: [], nowMs: summer(day, '10:05') });
  assert.equal(zero.state, HABIT_STATE.DAILY_TARGET_REACHED);
  assert.equal(zero.text, 'Tälle päivälle ei ole suunniteltu kertoja.');
  const noTarget = status({ plan: plan({ dailyTarget: null }), events: uses, nowMs: summer(day, '11:30') });
  assert.equal(noTarget.state, HABIT_STATE.OK_NOW);
  assert.equal(noTarget.dailyTarget, null);
});

test('tila: keskiyö — eilisen 23.59 ei ole tämän päivän kerta, huomisen aika sanotaan huomenna', () => {
  const lateUse = summer('2026-06-10', '23:59');
  const s = status({ plan: plan(), events: [lateUse, summer('2026-06-11', '00:00')].map(ms => ev(ms)),
    nowMs: summer('2026-06-11', '00:10') });
  assert.equal(s.todayIso, '2026-06-11');
  assert.equal(s.usesToday, 1);
  const evening = status({ plan: plan({ minIntervalMinutes: 90 }), events: [ev(summer('2026-06-10', '23:10'))],
    nowMs: summer('2026-06-10', '23:15') });
  assert.equal(evening.text, 'Seuraava suunniteltu aika huomenna 00.40');
  const far = status({ plan: plan({ minIntervalMinutes: 1440 }), events: [ev(summer('2026-06-10', '23:10'))],
    nowMs: summer('2026-06-10', '23:15') });
  assert.equal(far.text, 'Seuraava suunniteltu aika huomenna 23.10');
  // Kuun ja vuoden vaihde.
  const nye = status({ plan: plan({ minIntervalMinutes: 120 }), events: [ev(winter('2026-12-31', '23:00'))],
    nowMs: winter('2026-12-31', '23:30') });
  assert.equal(nye.text, 'Seuraava suunniteltu aika huomenna 01.00');
});

test('tila: vaiheen vaihtuminen keskiyöllä muuttaa välin', () => {
  const p = plan({ steps: [{ from: '2026-06-11', intervalMinutes: 120, dailyTarget: 6 }] });
  const use = summer('2026-06-10', '23:30');
  const beforeMidnight = status({ plan: p, events: [ev(use)], nowMs: summer('2026-06-10', '23:40') });
  assert.equal(beforeMidnight.intervalMinutes, 60);
  const afterMidnight = status({ plan: p, events: [ev(use)], nowMs: summer('2026-06-11', '00:20') });
  assert.equal(afterMidnight.intervalMinutes, 120);
  assert.equal(afterMidnight.nextAtMs, use + 120 * MIN);
  assert.equal(afterMidnight.dailyTarget, 6);
});

test('KESÄAIKA: kevään vaihtoyönä väli on todellista aikaa, kello hyppää', () => {
  // 29.3.2026 klo 03.00 -> 04.00. Käyttö 02.30 (UTC+2) + 60 min = 04.30 (UTC+3).
  const use = winter('2026-03-29', '02:30');
  const s = status({ plan: plan(), events: [ev(use)], nowMs: use + 10 * MIN });
  assert.equal(s.nextAtMs, use + 60 * MIN);
  assert.equal(s.text, 'Seuraava suunniteltu aika 04.30');
  assert.equal(s.minutesUntil, 50);
  // Vaihtopäivä on 23 tuntia: 00.10 ja 23.50 ovat saman päivän kertoja.
  const day = status({
    plan: plan({ dailyTarget: null }),
    events: [ev(winter('2026-03-29', '00:10')), ev(summer('2026-03-29', '23:50')), ev(summer('2026-03-30', '00:05'))],
    nowMs: summer('2026-03-29', '23:55')
  });
  assert.equal(day.usesToday, 2);
});

test('KESÄAIKA: syksyn vaihtoyönä 03.30 esiintyy kahdesti, väli pysyy 60 minuuttina', () => {
  // 25.10.2026 klo 04.00 -> 03.00. Käyttö 03.30 kesäaikaa (00.30Z) + 60 min = 03.30 talviaikaa.
  const use = summer('2026-10-25', '03:30');
  const s = status({ plan: plan(), events: [ev(use)], nowMs: use + 30 * MIN });
  assert.equal(s.nextAtMs, use + 60 * MIN);
  assert.equal(s.text, 'Seuraava suunniteltu aika 03.30');
  assert.equal(s.minutesUntil, 30);
  // 25 tunnin päivä: 00.05 ja 23.55 ovat saman päivän kertoja.
  const day = status({
    plan: plan({ dailyTarget: null }),
    events: [ev(summer('2026-10-25', '00:05')), ev(winter('2026-10-25', '23:55'))],
    nowMs: winter('2026-10-25', '23:58')
  });
  assert.equal(day.usesToday, 2);
});

test('tila: "tänään" lasketaan annetussa vyöhykkeessä, ei koneen omassa', () => {
  const now = Date.parse('2026-06-11T02:30:00Z'); // Helsinki 05.30 11.6., New York 22.30 10.6.
  const events = [ev(Date.parse('2026-06-10T20:00:00Z'))];
  assert.equal(status({ plan: plan(), events, nowMs: now }).todayIso, '2026-06-11');
  assert.equal(status({ plan: plan(), events, nowMs: now }).usesToday, 0);
  const ny = status({ plan: plan(), events, nowMs: now, timeZone: 'America/New_York' });
  assert.equal(ny.todayIso, '2026-06-10');
  assert.equal(ny.usesToday, 1);
  // Tuntematon vyöhyke palaa oletukseen eikä kaada.
  assert.equal(status({ plan: plan(), events, nowMs: now, timeZone: 'Mars/Olympus' }).todayIso, '2026-06-11');
});

// ================================================================ EDISTYMINEN

function weekOfUses() {
  // 3.–9.6. kaksi kertaa päivässä (08.00 ja 10.30), 10.6. kolme.
  const events = [];
  for (let d = 3; d <= 9; d += 1) {
    const date = `2026-06-${String(d).padStart(2, '0')}`;
    events.push(ev(summer(date, '08:00')), ev(summer(date, '10:30')));
  }
  events.push(ev(summer('2026-06-10', '07:00')), ev(summer('2026-06-10', '09:00')), ev(summer('2026-06-10', '11:00')));
  events.push(ev(summer('2026-06-05', '12:00'), 'delay'), ev(summer('2026-06-06', '12:00'), 'skip'));
  return events;
}

test('edistyminen: kokonaiset päivät, tämä päivä erikseen, keskiarvo ja lähtötaso', () => {
  const r = progress({ plan: plan(), events: weekOfUses(), todayIso: '2026-06-10' });
  assert.equal(r.fromIso, '2026-06-03');
  assert.equal(r.toIso, '2026-06-09');
  assert.equal(r.days, 7);
  assert.equal(r.trackedDays, 7);
  assert.equal(r.uses, 14);
  assert.equal(r.delays, 1);
  assert.equal(r.skips, 1);
  assert.equal(r.usesPerDay, 2);
  assert.equal(r.meanIntervalMinutes, 150, 'yön tauko ei ole väli');
  assert.equal(r.baselinePerDay, 12);
  assert.equal(r.changeFromBaselinePercent, -83);
  assert.equal(r.today.uses, 3);
  assert.equal(r.byDay.length, 7);
  assert.equal(r.targetDays, 7);
  assert.equal(r.daysWithinTarget, 7);
  // (12 × 7 − 14) × 0,50 € = 35,00 €
  assert.equal(r.moneySavedMinor, 3500);
  assert.match(r.text, /keskimäärin 2 kertaa päivässä, lähtötaso 12\./);
  assert.match(r.text, /35,00/);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.byDay) && Object.isFrozen(r.byDay[0]) && Object.isFrozen(r.today));
});

test('edistyminen: seurantaa edeltävät päivät ovat tuntemattomia, eivät nollia', () => {
  const events = [ev(summer('2026-06-08', '09:00')), ev(summer('2026-06-09', '09:00'))];
  const r = progress({ plan: plan({ createdAt: '2026-06-07T12:00:00+03:00' }), events, todayIso: '2026-06-10' });
  assert.equal(r.trackingStart, '2026-06-07');
  assert.equal(r.trackedDays, 3);
  assert.deepEqual(r.byDay.map(d => d.uses), [null, null, null, null, 0, 1, 1]);
  assert.equal(r.usesPerDay, 0.7);
  assert.equal(r.daysWithEvents, 2);
  // Ilman luontiaikaa seuranta alkaa ensimmäisestä kirjauksesta.
  const noCreated = progress({ plan: plan({ createdAt: null }), events, todayIso: '2026-06-10' });
  assert.equal(noCreated.trackingStart, '2026-06-08');
  assert.equal(noCreated.trackedDays, 2);
  // Ei mitään tietoa -> keskiarvo, muutos ja säästö ovat tuntemattomia.
  const nothing = progress({ plan: plan({ createdAt: null }), events: [], todayIso: '2026-06-10' });
  assert.equal(nothing.trackedDays, 0);
  assert.equal(nothing.usesPerDay, null);
  assert.equal(nothing.changeFromBaselinePercent, null);
  assert.equal(nothing.moneySavedMinor, null);
  assert.equal(nothing.text, 'Edistymisestä ei ole vielä tietoa.');
});

test('edistyminen: säästö ja muutos ovat tuntemattomia ilman lähtötasoa tai hintaa', () => {
  const events = weekOfUses();
  const noCost = progress({ plan: plan({ unitCostMinor: null }), events, todayIso: '2026-06-10' });
  assert.equal(noCost.moneySavedMinor, null);
  assert.doesNotMatch(noCost.text, /Säästöä/);
  const noBaseline = progress({ plan: plan({ baselinePerDay: null }), events, todayIso: '2026-06-10' });
  assert.equal(noBaseline.changeFromBaselinePercent, null);
  assert.equal(noBaseline.moneySavedMinor, null);
  const zeroBaseline = progress({ plan: plan({ baselinePerDay: 0 }), events, todayIso: '2026-06-10' });
  assert.equal(zeroBaseline.changeFromBaselinePercent, null, 'nollalla ei jaeta');
  assert.equal(zeroBaseline.moneySavedMinor, -700, 'yli lähtötason: negatiivinen, ei piiloteta');
  assert.doesNotMatch(zeroBaseline.text, /Säästöä/, 'negatiivista säästöä ei kehystetä tekstissä');
});

test('moneySaved: kaava ja tuntemattomat', () => {
  assert.equal(moneySaved({ plan: plan(), uses: 20, trackedDays: 2 }), (24 - 20) * 50);
  assert.equal(moneySaved({ plan: plan(), uses: 0, trackedDays: 0 }), null, 'ei seurattuja päiviä');
  assert.equal(moneySaved({ plan: plan(), uses: null, trackedDays: 3 }), null);
  assert.equal(moneySaved({ plan: plan({ unitCostMinor: '' }), uses: 1, trackedDays: 1 }), null);
  assert.equal(moneySaved({ plan: plan({ unitCostMinor: 0 }), uses: 1, trackedDays: 1 }), 0, 'hinta 0 on tieto');
  assert.equal(moneySaved(), null);
});

test('edistyminen: kuun ja vuoden vaihde sekä ikkunan pituus', () => {
  const events = [ev(winter('2026-12-25', '10:00')), ev(winter('2026-12-31', '23:59')), ev(winter('2027-01-01', '00:00'))];
  const r = progress({ plan: plan(), events, todayIso: '2027-01-01' });
  assert.equal(r.fromIso, '2026-12-25');
  assert.equal(r.toIso, '2026-12-31');
  assert.equal(r.byDay[0].uses, 1);
  assert.equal(r.byDay[6].uses, 1);
  assert.equal(r.today.uses, 1);
  assert.equal(progress({ plan: plan(), events, todayIso: '2027-01-01', days: 1 }).byDay.length, 1);
  assert.equal(progress({ plan: plan(), events, todayIso: '2027-01-01', days: 'x' }).days, 7);
  assert.equal(progress({ plan: plan(), events, todayIso: '2027-01-01', days: 9999 }).days, 7);
  assert.equal(progress({ plan: plan(), events, todayIso: '2026-02-29' }), null);
});

test('KESÄAIKA: edistymisen päivärajat ovat paikallisia keskiöitä molempina vaihtopäivinä', () => {
  const events = [
    ev(winter('2026-03-29', '00:30')), ev(summer('2026-03-29', '23:30')), ev(summer('2026-03-30', '00:30')),
    ev(summer('2026-10-25', '00:30')), ev(winter('2026-10-25', '23:30')), ev(winter('2026-10-26', '00:30'))
  ];
  const spring = progress({ plan: plan({ createdAt: '2026-01-01T00:00:00Z' }), events, todayIso: '2026-03-31' });
  const springDay = spring.byDay.find(d => d.date === '2026-03-29');
  assert.equal(springDay.uses, 2);
  assert.equal(spring.byDay.find(d => d.date === '2026-03-30').uses, 1);
  const autumn = progress({ plan: plan({ createdAt: '2026-01-01T00:00:00Z' }), events, todayIso: '2026-10-27' });
  assert.equal(autumn.byDay.find(d => d.date === '2026-10-25').uses, 2);
  assert.equal(autumn.byDay.find(d => d.date === '2026-10-26').uses, 1);
});

// ================================================================ KUITTAUKSET JA SÄVY

test('kuittaukset ovat lyhyitä ja neutraaleja', () => {
  const now = summer('2026-06-10', '13:20');
  assert.equal(habitActionText('use', { nextAtMs: now + 60 * MIN, nowMs: now }), 'Kirjattu. Seuraava suunniteltu aika 14.20.');
  assert.equal(habitActionText('delay', {}), `Siirretty ${HABIT_RULES.DELAY_MINUTES} min myöhemmäksi.`);
  assert.equal(habitActionText('skip'), 'Ohitus kirjattu.');
  assert.equal(habitActionText('relapse'), null);
  assert.equal(habitActionText(HABIT_ACTION.USE, { nextAtMs: 'x', nowMs: now }), 'Kirjattu.');
});

test('SÄVY: yksikään teksti ei häpäise, syyllistä eikä käske', () => {
  const texts = [];
  const day = '2026-06-10';
  const uses = ['07:00', '08:30', '10:00'].map(t => ev(summer(day, t)));
  for (const target of [0, 1, 3, 8, null]) {
    for (const minutes of [null, 30, 60, 240]) {
      for (const time of ['06:00', '08:40', '10:05', '23:50']) {
        const p = plan({ dailyTarget: target, minIntervalMinutes: minutes });
        texts.push(status({ plan: p, events: uses, nowMs: summer(day, time) }).text);
        texts.push(progress({ plan: p, events: weekOfUses(), todayIso: day }).text);
      }
    }
  }
  texts.push(status({ plan: null, events: [], nowMs: summer(day, '10:00') }).text);
  for (const action of ['use', 'delay', 'skip']) texts.push(habitActionText(action, { nextAtMs: summer(day, '11:00'), nowMs: summer(day, '10:00') }));
  for (const text of texts) {
    assert.equal(typeof text, 'string');
    assert.doesNotMatch(text, SHAME, text);
  }
});

// ================================================================ KESTÄVYYS

test('DETERMINISMI: sama tulos sekoitetulla syötteellä ja kaksoiskirjauksilla', () => {
  const events = weekOfUses();
  const base = JSON.stringify(progress({ plan: plan(), events, todayIso: '2026-06-10' }));
  const now = summer('2026-06-10', '11:20');
  const baseStatus = JSON.stringify(status({ plan: plan(), events, nowMs: now }));
  for (let seed = 1; seed <= 20; seed += 1) {
    const mixed = shuffled([...events, ...events.slice(0, 5)], seed);
    assert.equal(JSON.stringify(progress({ plan: plan(), events: mixed, todayIso: '2026-06-10' })), base);
    assert.equal(JSON.stringify(status({ plan: plan(), events: mixed, nowMs: now })), baseStatus);
  }
});

test('syötettä ei muuteta', () => {
  const p = deepFreeze(plan({ steps: [{ from: '2026-06-05', intervalMinutes: 90, dailyTarget: 5 }] }));
  const events = deepFreeze(weekOfUses());
  const before = JSON.stringify({ p, events });
  status({ plan: p, events, nowMs: summer('2026-06-10', '12:00') });
  progress({ plan: p, events, todayIso: '2026-06-10' });
  nextPlannedTime({ plan: p, events, nowMs: summer('2026-06-10', '12:00') });
  currentStep(p, '2026-06-10');
  assert.equal(JSON.stringify({ p, events }), before);
});

test('ROSKA: mikään syöte ei kaada moottoria', () => {
  const garbage = [undefined, null, 0, -1, NaN, Infinity, '', 'x', [], {}, [null], { steps: {} },
    { id: {}, minIntervalMinutes: {}, dailyTarget: [], steps: [{ from: 5 }], createdAt: {} },
    { id: 'p1', minIntervalMinutes: 1e308, dailyTarget: '7', baselinePerDay: true, unitCostMinor: -5 }];
  const eventGarbage = [undefined, null, 'x', [null, 1, 'a', {}], [{ occurredAt: 'eilen', action: 'use' }],
    [{ occurredAt: 1e20, action: 'use', planId: 'p1' }], [{ occurredAt: '2026-06-10T25:00:00Z', action: 'use' }],
    [{ occurredAt: '2026-06-10T10:00:00+99:00', action: 'use' }], [{ occurredAt: {}, action: {} }],
    [{ id: {}, planId: [], occurredAt: '2026-06-10T10:00:00Z', action: 'use' }]];
  for (const p of garbage) {
    for (const events of eventGarbage) {
      for (const nowMs of [undefined, NaN, summer('2026-06-10', '12:00'), -1e19]) {
        assert.doesNotThrow(() => {
          status({ plan: p, events, nowMs, timeZone: {} });
          nextPlannedTime({ plan: p, events, nowMs });
          progress({ plan: p, events, todayIso: nowMs === undefined ? 'x' : '2026-06-10', days: {} });
          currentStep(p, '2026-06-10');
          moneySaved({ plan: p, uses: 'x', trackedDays: {} });
        });
      }
    }
  }
  assert.doesNotThrow(() => { status(); progress(); nextPlannedTime(); habitActionText(); });
});

test('SUORITUSKYKY: 100 000 kirjausta käsitellään lähes lineaarisesti', () => {
  const start = Date.parse('2025-06-01T05:00:00Z');
  const make = n => Array.from({ length: n }, (_, i) => ({
    id: `k${i}`, planId: 'p1', occurredAt: start + i * 7 * MIN, action: i % 10 === 0 ? 'skip' : 'use'
  }));
  const small = make(25000);
  const large = make(100000);
  const nowMs = start + 100000 * 7 * MIN;
  const todayIso = '2026-06-15';
  const time = events => {
    const t0 = performance.now();
    status({ plan: plan(), events, nowMs });
    progress({ plan: plan(), events, todayIso, days: 366 });
    return performance.now() - t0;
  };
  time(small); // lämmitys
  const tSmall = time(small);
  const tLarge = time(large);
  assert.ok(tLarge < 3000, `100 000 kirjausta kesti ${Math.round(tLarge)} ms`);
  assert.ok(tLarge < tSmall * 12 + 200, `kasvu ei ole lineaarista: ${Math.round(tSmall)} ms -> ${Math.round(tLarge)} ms`);
});
