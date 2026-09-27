// Ateriarytmi: päivän muistutuskohteet ja rytmin validointi.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dailyMealItems, validateMealRhythm, waterReminderTimes, MEAL_ITEM_KIND, MEAL_ITEM_KINDS
} from '../src/domain/mealRhythm.js';
import { MEAL_RULES } from '../src/domain/dailyLifeSignalsPolicy.js';
import { MAX_MEALS, REMINDER_TOPIC } from '../src/domain/dailyLife.js';

const DAY = '2026-06-10';

function rhythm(overrides = {}) {
  return {
    meals: [
      { id: 'aamiainen', name: 'Aamiainen', time: '07:30', prepMinutes: 0 },
      { id: 'lounas', name: 'Lounas', time: '11:30', prepMinutes: 20 },
      { id: 'paivallinen', name: 'Päivällinen', time: '17:00', prepMinutes: 45 }
    ],
    waterEveryMinutes: 120,
    waterFrom: '08:00',
    waterTo: '20:00',
    supplements: [{ id: 'd', name: 'D-vitamiini', time: '07:30' }],
    lateEatingCutoff: '20:30',
    ...overrides
  };
}

function shuffled(list, seed) {
  const copy = [...list];
  let s = seed;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ================================================================ KOHTEET

test('päivän kohteet: ateriat, valmistelu, vesi, lisäravinne ja iltaraja aikajärjestyksessä', () => {
  const items = dailyMealItems({ mealRhythm: rhythm(), dateIso: DAY });
  assert.ok(Object.isFrozen(items) && items.every(Object.isFrozen));
  assert.ok(items.every(item => item.topic === REMINDER_TOPIC.MEAL && item.date === DAY));
  assert.ok(items.every(item => MEAL_ITEM_KINDS.includes(item.kind)));
  const summary = items.map(item => `${item.time} ${item.kind} ${item.title}`);
  assert.deepEqual(summary, [
    '07:30 meal Aamiainen',
    '07:30 supplement D-vitamiini',
    '08:00 water Vesitauko',
    '10:00 water Vesitauko',
    '11:10 meal_prep Valmistelu: Lounas',
    '11:30 meal Lounas',
    '12:00 water Vesitauko',
    '14:00 water Vesitauko',
    '16:00 water Vesitauko',
    '16:15 meal_prep Valmistelu: Päivällinen',
    '17:00 meal Päivällinen',
    '18:00 water Vesitauko',
    '20:00 water Vesitauko',
    '20:30 late_cutoff Ruokailun iltaraja'
  ]);
  const lounas = items.find(item => item.kind === MEAL_ITEM_KIND.MEAL && item.sourceId === 'lounas');
  assert.equal(lounas.id, `meal:${DAY}:meal:lounas`);
  assert.equal(new Set(items.map(item => item.id)).size, items.length, 'tunnisteet ovat yksilöllisiä');
});

test('tunnisteet ovat deterministisiä ja päiväkohtaisia', () => {
  const a = dailyMealItems({ mealRhythm: rhythm(), dateIso: DAY });
  const b = dailyMealItems({ mealRhythm: rhythm(), dateIso: DAY });
  assert.deepEqual(a, b);
  const tomorrow = dailyMealItems({ mealRhythm: rhythm(), dateIso: '2026-06-11' });
  assert.notEqual(a[0].id, tomorrow[0].id);
  assert.deepEqual(a.map(i => i.time), tomorrow.map(i => i.time));
});

test('DETERMINISMI: aterioiden ja lisäravinteiden järjestys ei vaikuta tulokseen', () => {
  const base = JSON.stringify(dailyMealItems({ mealRhythm: rhythm(), dateIso: DAY }));
  const noIds = rhythm({
    meals: [{ name: 'Välipala', time: '15:00' }, { name: 'Iltapala', time: '19:30', prepMinutes: 5 }],
    supplements: [{ name: 'Magnesium', time: '21:00' }, { name: 'Omega', time: '08:00' }]
  });
  const baseNoIds = JSON.stringify(dailyMealItems({ mealRhythm: noIds, dateIso: DAY }));
  for (let seed = 1; seed <= 15; seed += 1) {
    const r = rhythm();
    assert.equal(JSON.stringify(dailyMealItems({
      mealRhythm: { ...r, meals: shuffled(r.meals, seed), supplements: shuffled(r.supplements, seed) }, dateIso: DAY
    })), base);
    assert.equal(JSON.stringify(dailyMealItems({
      mealRhythm: { ...noIds, meals: shuffled(noIds.meals, seed), supplements: shuffled(noIds.supplements, seed) },
      dateIso: DAY
    })), baseNoIds);
  }
});

test('valmistelu, joka alkaisi edellisenä päivänä, jätetään pois', () => {
  const items = dailyMealItems({
    mealRhythm: { meals: [{ id: 'y', name: 'Yöpala', time: '00:20', prepMinutes: 30 }] }, dateIso: DAY
  });
  assert.deepEqual(items.map(i => i.kind), ['meal']);
  const exact = dailyMealItems({
    mealRhythm: { meals: [{ id: 'y', name: 'Yöpala', time: '00:30', prepMinutes: 30 }] }, dateIso: DAY
  });
  assert.deepEqual(exact.map(i => `${i.time} ${i.kind}`), ['00:00 meal_prep', '00:30 meal'], 'keskiyö on vielä sama päivä');
});

test('sama tunniste kahdesti tuottaa yhden kohteen (aikaisin voittaa)', () => {
  const items = dailyMealItems({
    mealRhythm: { meals: [{ id: 'x', name: 'B', time: '12:00' }, { id: 'x', name: 'A', time: '09:00' }] }, dateIso: DAY
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].time, '09:00');
});

// ================================================================ VESI

test('vesi: väli ja rajat, loppu mukaan lukien', () => {
  assert.deepEqual(waterReminderTimes({ waterEveryMinutes: 60, waterFrom: '08:00', waterTo: '11:00' }),
    ['08:00', '09:00', '10:00', '11:00']);
  assert.deepEqual(waterReminderTimes({ waterEveryMinutes: 45, waterFrom: '08:00', waterTo: '09:44' }),
    ['08:00', '08:45', '09:30']);
});

test('vesi: väli vähintään 30 min ja enintään 20 muistutusta päivässä', () => {
  const tight = waterReminderTimes({ waterEveryMinutes: 5, waterFrom: '08:00', waterTo: '09:00' });
  assert.deepEqual(tight, ['08:00', '08:30', '09:00'], 'liian tiheä väli pidennetään rajaan');
  const allDay = waterReminderTimes({ waterEveryMinutes: 30, waterFrom: '00:00', waterTo: '23:59' });
  assert.equal(allDay.length, MEAL_RULES.WATER_MAX_REMINDERS_PER_DAY);
  assert.equal(allDay[19], '09:30');
  const items = dailyMealItems({ mealRhythm: { waterEveryMinutes: 1, waterFrom: '00:00', waterTo: '23:59' }, dateIso: DAY });
  assert.ok(items.filter(i => i.kind === 'water').length <= MEAL_RULES.WATER_MAX_REMINDERS_PER_DAY);
});

test('vesi: puuttuva tai käänteinen aika ei keksi muistutuksia', () => {
  assert.deepEqual(waterReminderTimes({ waterEveryMinutes: 60, waterFrom: null, waterTo: '20:00' }), []);
  assert.deepEqual(waterReminderTimes({ waterEveryMinutes: null, waterFrom: '08:00', waterTo: '20:00' }), []);
  assert.deepEqual(waterReminderTimes({ waterEveryMinutes: 60, waterFrom: '20:00', waterTo: '08:00' }), [],
    'yön yli meneviä vesimuistutuksia ei ole');
  assert.deepEqual(waterReminderTimes({ waterEveryMinutes: 60, waterFrom: '08:00', waterTo: '08:00' }), []);
  assert.deepEqual(waterReminderTimes(), []);
});

// ================================================================ KESÄAIKA JA PÄIVÄT

test('KESÄAIKA: seinäkellon ajat pysyvät samoina vaihtopäivinä (29.3. ja 25.10.)', () => {
  const normal = dailyMealItems({ mealRhythm: rhythm(), dateIso: '2026-03-28' }).map(i => `${i.time} ${i.kind}`);
  for (const date of ['2026-03-29', '2026-10-25', '2026-12-31', '2027-01-01', '2028-02-29']) {
    assert.deepEqual(dailyMealItems({ mealRhythm: rhythm(), dateIso: date }).map(i => `${i.time} ${i.kind}`), normal, date);
  }
});

test('virheellinen päivä tai rytmi tuottaa tyhjän listan', () => {
  assert.deepEqual(dailyMealItems({ mealRhythm: rhythm(), dateIso: '2026-02-30' }), []);
  assert.deepEqual(dailyMealItems({ mealRhythm: null, dateIso: DAY }), []);
  assert.deepEqual(dailyMealItems({ mealRhythm: {}, dateIso: DAY }), []);
  assert.deepEqual(dailyMealItems(), []);
});

// ================================================================ VALIDOINTI

test('validointi: kelvollinen rytmi ja tyhjä rytmi', () => {
  assert.equal(validateMealRhythm(rhythm()).valid, true);
  assert.equal(validateMealRhythm(null).valid, true);
  assert.equal(validateMealRhythm({}).valid, true);
  assert.ok(Object.isFrozen(validateMealRhythm(rhythm())));
});

test('validointi: ajat, nimet ja valmistelu', () => {
  const result = validateMealRhythm({
    meals: [
      { name: '', time: '25:00' },
      { name: 'Yöpala', time: '00:10', prepMinutes: 30 },
      { name: 'Lounas', time: '11:30', prepMinutes: 999 },
      'roska'
    ],
    supplements: [{ name: 'X', time: '7:5' }],
    lateEatingCutoff: 'illalla'
  });
  assert.equal(result.valid, false);
  assert.match(result.errors['meals.0.name'], /nimi/);
  assert.match(result.errors['meals.0.time'], /HH:MM/);
  assert.match(result.errors['meals.1.prepMinutes'], /edellisenä päivänä/);
  assert.match(result.errors['meals.2.prepMinutes'], /0–240/);
  assert.ok(result.errors['meals.3']);
  assert.match(result.errors['supplements.0.time'], /HH:MM/);
  assert.match(result.errors.lateEatingCutoff, /HH:MM/);
});

test('validointi: aterioita enintään MAX_MEALS', () => {
  const meals = Array.from({ length: MAX_MEALS + 1 }, (_, i) => ({ name: `A${i}`, time: `${String(6 + i).padStart(2, '0')}:00` }));
  assert.match(validateMealRhythm({ meals }).errors.meals, new RegExp(String(MAX_MEALS)));
});

test('validointi: vesimuistutusten rajat', () => {
  const tooTight = validateMealRhythm({ waterEveryMinutes: 29, waterFrom: '08:00', waterTo: '20:00' });
  assert.match(tooTight.errors.waterEveryMinutes, /vähintään 30/);
  assert.equal(validateMealRhythm({ waterEveryMinutes: 30, waterFrom: '08:00', waterTo: '17:30' }).valid, true,
    'raja: 30 min ja tasan 20 muistutusta');
  const tooMany = validateMealRhythm({ waterEveryMinutes: 30, waterFrom: '08:00', waterTo: '18:00' });
  assert.match(tooMany.errors.waterEveryMinutes, /yli 20/);
  const reversed = validateMealRhythm({ waterEveryMinutes: 60, waterFrom: '20:00', waterTo: '08:00' });
  assert.match(reversed.errors.waterTo, /jälkeen/);
  const partial = validateMealRhythm({ waterEveryMinutes: 60 });
  assert.ok(partial.errors.waterFrom && partial.errors.waterTo);
});

// ================================================================ KESTÄVYYS

test('ROSKA: mikään syöte ei kaada, syötettä ei muuteta', () => {
  const garbage = [undefined, null, 0, 'x', [], {}, { meals: 'x' }, { meals: [null, 1, [], { time: {} }] },
    { supplements: [{ time: '08:00', name: {} }], waterEveryMinutes: {}, waterFrom: [], lateEatingCutoff: 5 },
    { meals: Array.from({ length: 1000 }, (_, i) => ({ id: i, name: 'x', time: '12:00', prepMinutes: 'NaN' })) }];
  for (const value of garbage) {
    assert.doesNotThrow(() => dailyMealItems({ mealRhythm: value, dateIso: DAY }));
    assert.doesNotThrow(() => validateMealRhythm(value));
    assert.doesNotThrow(() => waterReminderTimes(value || undefined));
  }
  for (const bad of [null, 5, 'x', true]) {
    assert.deepEqual(dailyMealItems(bad), []);
    assert.deepEqual(waterReminderTimes(bad), []);
  }
  const input = Object.freeze({ ...rhythm(), meals: Object.freeze(rhythm().meals.map(m => Object.freeze(m))) });
  const before = JSON.stringify(input);
  dailyMealItems({ mealRhythm: input, dateIso: DAY });
  validateMealRhythm(input);
  assert.equal(JSON.stringify(input), before);
});

test('teksteissä ei ole ravitsemusneuvoja eikä arvottamista', () => {
  const titles = dailyMealItems({ mealRhythm: rhythm(), dateIso: DAY }).map(i => i.title);
  const errors = Object.values(validateMealRhythm({
    meals: [{ name: '', time: 'x', prepMinutes: 999 }], waterEveryMinutes: 5, waterFrom: '20:00', waterTo: '08:00'
  }).errors);
  for (const text of [...titles, ...errors]) {
    assert.doesNotMatch(text, /epäterve|huono|liikaa|kalori|laihdu|pitäisi|häpe/i, text);
  }
});
