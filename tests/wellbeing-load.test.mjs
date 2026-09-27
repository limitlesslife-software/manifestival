// Hyvinvoinnin kuorman kevennys (aalto L): yksi muistutusputki
// (notificationPolicy.applyNotificationPolicy / alarmSync), ei toista
// hyvinvointimoduulia.
//
//   - aiheen voi kytkeä kokonaan pois (life_settings.delivery[aihe] = 'off'),
//     ja vain se aihe poistuu
//   - vesi ja lisäravinteet kelpaavat koosteeseen (eivät ohita sitä)
//   - korkea kuorma keventää valinnaiset kehotteet, välttämättömät ennallaan
//   - Tänään-näkymän hyvinvointirivit ovat rajattuja

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyNotificationPolicy, isDigestible, optionalTopicOf, isOptionalPrompt, isLowValueWellbeing,
  applyTopicOff, offTopicsOf, reminderLoadLevel, LOAD_LEVEL, LOAD_RULES, LOAD_SUPPRESSIBLE_TOPICS
} from '../src/domain/notificationPolicy.js';
import { NOTIFICATION_TYPE, LEVEL, createIntent } from '../src/domain/notification.js';
import {
  OPTIONAL_TOPIC, OPTIONAL_TOPICS, DELIVERY_OFF, REMINDER_TOPICS, DEFAULT_DELIVERY, GUIDANCE_STYLE, optionalTopicLabel
} from '../src/domain/dailyLife.js';
import { normalizeDelivery, mergeLifeSettings, topicOff, offTopics } from '../src/domain/lifeSettings.js';
import { boundWellnessRows, WELLNESS_CARD_LIMIT } from '../src/domain/wellbeing.js';
import { guidanceChangesFrom, GUIDANCE_OPTIONAL_TOPICS } from '../src/app/views/guidanceSettings.js';
import { resetState, setLifeSettings, setNotificationPreferences, setWellbeing } from '../src/app/state.js';
import { reminderLoad, dailyLifeReminderPlan } from '../src/app/alarmSync.js';
import { readCode } from './helpers/sources.mjs';

const T = NOTIFICATION_TYPE;
const DAY = '2026-09-29';
const PREFS = Object.freeze({ enabled: true, maxPerDay: 30 });

function make(type, time, { level = LEVEL.REMINDER, targetId = `${type}-${time}`, date = DAY, ...extra } = {}) {
  const intent = createIntent({ type, level, date, time, title: 'Muistutus', body: 'Runko', targetId, extra });
  assert.ok(intent, `testiaikomus kelpaa: ${type}`);
  return intent;
}

const water = (time, over = {}) => make(T.MEAL, time, { mealKind: 'water', ...over });
const supplement = (time, over = {}) => make(T.MEAL, time, { mealKind: 'supplement', ...over });
const meal = (time, over = {}) => make(T.MEAL, time, over);
const lateCutoff = (time, over = {}) => make(T.MEAL, time, { mealKind: 'late_cutoff', ...over });
const habit = (time, over = {}) => make(T.HABIT, time, { habitPlanId: 'nik', ...over });
const leaveNow = time => make(T.DEPARTURE_LEAVE_NOW, time, { level: LEVEL.CRITICAL });
const deadline = time => make(T.DEADLINE_WARNING, time, { level: LEVEL.ACTION });

/** Monipuolinen päivä: valinnaiset ja välttämättömät sekaisin. */
function day() {
  return [
    water('10:00'), water('12:00'), supplement('09:00'), meal('11:30'), lateCutoff('20:00'),
    habit('14:00'), leaveNow('17:00'), deadline('13:00')
  ];
}

const ids = list => list.map(intent => intent.id).sort();
const byKind = (list, kind) => list.filter(intent => intent.mealKind === kind);

// =====================================================================
// AIHEEN TUNNISTUS
// =====================================================================

test('optionalTopicOf: vesi, lisäravinne, ateria (myös iltaraja), tapa, oma aihe; muut eivät ole valinnaisia', () => {
  assert.equal(optionalTopicOf(water('10:00')), OPTIONAL_TOPIC.WATER);
  assert.equal(optionalTopicOf(supplement('09:00')), OPTIONAL_TOPIC.SUPPLEMENT);
  assert.equal(optionalTopicOf(meal('11:30')), OPTIONAL_TOPIC.MEAL);
  assert.equal(optionalTopicOf(lateCutoff('20:00')), OPTIONAL_TOPIC.MEAL);
  assert.equal(optionalTopicOf(habit('14:00')), OPTIONAL_TOPIC.HABIT);
  assert.equal(optionalTopicOf(make(T.TASK_REMINDER, '08:00', { optionalTopic: 'exercise' })), OPTIONAL_TOPIC.EXERCISE);
  assert.equal(optionalTopicOf(make(T.TASK_REMINDER, '08:00', { optionalTopic: 'checkin' })), OPTIONAL_TOPIC.CHECKIN);
  assert.equal(optionalTopicOf(leaveNow('17:00')), null);
  assert.equal(optionalTopicOf(deadline('13:00')), null);
  assert.equal(optionalTopicOf(null), null);
});

test('isOptionalPrompt: vesi, lisäravinne ja tapa kyllä; ateria, lähtö ja määräaika eivät', () => {
  assert.equal(isOptionalPrompt(water('10:00')), true);
  assert.equal(isOptionalPrompt(supplement('09:00')), true);
  assert.equal(isOptionalPrompt(habit('14:00')), true);
  assert.equal(isOptionalPrompt(meal('11:30')), false, 'syöminen on perustarve');
  assert.equal(isOptionalPrompt(leaveNow('17:00')), false);
  assert.equal(isOptionalPrompt(deadline('13:00')), false);
  assert.equal(isOptionalPrompt(supplement('09:00', { essential: true })), false, 'välttämätön ei kevene');
  assert.ok(LOAD_SUPPRESSIBLE_TOPICS.every(topic => OPTIONAL_TOPICS.includes(topic)));
});

// =====================================================================
// AIHE POIS
// =====================================================================

test('aihe pois: vesi pois poistaa vain vesitauot; ateriat ja lisäravinteet säilyvät', () => {
  const out = applyNotificationPolicy(day(), { settings: { delivery: { water: DELIVERY_OFF } }, preferences: PREFS });
  assert.equal(byKind(out, 'water').length, 0);
  assert.equal(byKind(out, 'supplement').length, 1);
  assert.ok(out.some(intent => intent.type === T.MEAL && !intent.mealKind), 'ateria säilyy');
  assert.ok(out.some(intent => intent.type === T.HABIT));
});

test('aihe pois: ateriat pois poistaa ateriat ja iltarajan, mutta ei vettä eikä lisäravinteita', () => {
  const out = applyNotificationPolicy(day(), { settings: { delivery: { meal: DELIVERY_OFF } }, preferences: PREFS });
  assert.equal(out.some(intent => intent.type === T.MEAL && !intent.mealKind), false);
  assert.equal(byKind(out, 'late_cutoff').length, 0);
  assert.equal(byKind(out, 'water').length, 2);
  assert.equal(byKind(out, 'supplement').length, 1);
});

test('aihe pois: tavat pois poistaa tapamuistutukset (myös nikotiini); lähtö ja määräaika ennallaan', () => {
  const out = applyNotificationPolicy(day(), { settings: { delivery: { habit: DELIVERY_OFF } }, preferences: PREFS });
  assert.equal(out.some(intent => intent.type === T.HABIT), false);
  assert.ok(out.some(intent => intent.type === T.DEPARTURE_LEAVE_NOW));
  assert.ok(out.some(intent => intent.type === T.DEADLINE_WARNING));
});

test('aihe pois: välttämätöntä aihetta (lähtö) ei voi kytkeä pois tätä kautta', () => {
  const out = applyNotificationPolicy(day(), { settings: { delivery: { departure: DELIVERY_OFF } }, preferences: PREFS });
  assert.ok(out.some(intent => intent.type === T.DEPARTURE_LEAVE_NOW));
  assert.equal(offTopicsOf({ delivery: { departure: DELIVERY_OFF } }).size, 0);
});

test('applyTopicOff: ilman pois kytkettyjä aiheita lista palautuu sellaisenaan', () => {
  const list = day();
  assert.equal(applyTopicOff(list, null), list);
  assert.equal(applyTopicOff(list, { delivery: {} }), list);
  assert.deepEqual(ids(applyTopicOff(list, { delivery: { supplement: DELIVERY_OFF } })),
    ids(list.filter(intent => intent.mealKind !== 'supplement')));
});

test('asetukset: normalizeDelivery säilyttää off-arvon valinnaisille aiheille ja pudottaa muut', () => {
  const normalized = normalizeDelivery({
    meal: DELIVERY_OFF, habit: DELIVERY_OFF, water: DELIVERY_OFF, supplement: DELIVERY_OFF,
    exercise: DELIVERY_OFF, checkin: DELIVERY_OFF, departure: DELIVERY_OFF, bedtime: 'vibrate', routine: 'on'
  });
  assert.deepEqual(normalized, {
    meal: 'off', habit: 'off', bedtime: 'vibrate', water: 'off', supplement: 'off', exercise: 'off', checkin: 'off'
  });
  assert.deepEqual(normalizeDelivery({ water: 'on', supplement: 'sound' }), {}, 'päälle/pois-aihe tallentuu vain off-arvona');
});

test('asetukset: kentittäinen yhdistäminen voi kytkeä aiheen takaisin päälle (on poistaa avaimen)', () => {
  const off = mergeLifeSettings({ id: 's1' }, { delivery: { water: DELIVERY_OFF, meal: DELIVERY_OFF } });
  assert.equal(topicOff(off, OPTIONAL_TOPIC.WATER), true);
  assert.deepEqual([...offTopics(off)].sort(), ['meal', 'water']);
  const on = mergeLifeSettings(off, { delivery: { water: 'on', meal: 'vibrate' } });
  assert.equal(topicOff(on, OPTIONAL_TOPIC.WATER), false);
  assert.equal(topicOff(on, OPTIONAL_TOPIC.MEAL), false);
  assert.equal(on.delivery.meal, 'vibrate');
  assert.equal(Object.hasOwn(on.delivery, 'water'), false);
});

test('asetusnäkymä: pois kytketyt aiheet tallentuvat off-arvoina; ilman valintoja aiheet ennallaan', () => {
  const base = { style: GUIDANCE_STYLE.CALM, speech: false, delivery: { ...DEFAULT_DELIVERY }, digest: false, digestTime: '' };
  assert.deepEqual(Object.keys(guidanceChangesFrom(base, null).delivery), [...REMINDER_TOPICS]);
  const topicsOff = { meal: false, water: true, supplement: false, habit: true };
  const changes = guidanceChangesFrom({ ...base, topicsOff }, null);
  assert.equal(changes.delivery.water, DELIVERY_OFF);
  assert.equal(changes.delivery.habit, DELIVERY_OFF);
  assert.equal(changes.delivery.meal, DEFAULT_DELIVERY.meal);
  assert.equal(changes.delivery.supplement, 'on', 'päälle kytketty kirjoitetaan, jotta yhdistäminen poistaa vanhan off-arvon');
  assert.deepEqual(GUIDANCE_OPTIONAL_TOPICS, ['meal', 'water', 'supplement', 'habit']);
  for (const topic of OPTIONAL_TOPICS) assert.ok(optionalTopicLabel(topic).length > 0, topic);
});

// =====================================================================
// KOOSTE
// =====================================================================

test('kooste: vesi ja lisäravinne ovat koosteeseen kelpaavia; ateria ja iltaraja eivät', () => {
  assert.equal(isDigestible(water('10:00')), true);
  assert.equal(isDigestible(supplement('09:00')), true);
  assert.equal(isDigestible(meal('11:30')), false);
  assert.equal(isDigestible(lateCutoff('20:00')), false);
  assert.equal(isLowValueWellbeing(water('10:00')), true);
  assert.equal(isLowValueWellbeing(meal('11:30')), false);
});

test('kooste päällä: vedet ja lisäravinne yhdistyvät koosteeseen, ateria tulee omana', () => {
  const out = applyNotificationPolicy(day(), { settings: { digestEnabled: true, digestTime: '18:00' }, preferences: PREFS });
  const digest = out.find(intent => intent.type === T.DIGEST);
  assert.ok(digest, 'kooste syntyi');
  const merged = new Set(digest.mergedIds);
  for (const intent of [water('10:00'), water('12:00'), supplement('09:00')]) assert.ok(merged.has(intent.id), intent.id);
  assert.equal(byKind(out, 'water').length, 0, 'vesi ei ohita koostetta');
  assert.ok(out.some(intent => intent.type === T.MEAL && !intent.mealKind), 'ateria-aika hetkeen sidottuna');
});

test('kooste pois: vesitauot tulevat tavallisesti (normaali kuorma ei pudota mitään)', () => {
  const out = applyNotificationPolicy(day(), { settings: {}, preferences: PREFS });
  assert.equal(byKind(out, 'water').length, 2);
  assert.deepEqual(ids(out), ids(applyNotificationPolicy(day(), { settings: {}, preferences: PREFS, loadLevel: LOAD_LEVEL.NORMAL })));
});

// =====================================================================
// KORKEA KUORMA
// =====================================================================

test('korkea kuorma, kooste päällä: vesi, lisäravinne ja tapa siirtyvät koosteeseen', () => {
  const settings = { digestEnabled: true, digestTime: '18:00' };
  const out = applyNotificationPolicy(day(), { settings, preferences: PREFS, loadLevel: LOAD_LEVEL.HIGH });
  assert.equal(out.some(intent => intent.type === T.HABIT), false, 'tapa ei tule omana');
  const digest = out.find(intent => intent.type === T.DIGEST);
  assert.ok(digest.mergedIds.includes(habit('14:00').id), 'tapa koosteessa');
  assert.ok(out.some(intent => intent.type === T.MEAL && !intent.mealKind), 'ateria ennallaan');
});

test('korkea kuorma, kooste pois: valinnaiset jäävät pois, välttämättömät ja ateriat ennallaan', () => {
  const normal = applyNotificationPolicy(day(), { settings: {}, preferences: PREFS });
  const high = applyNotificationPolicy(day(), { settings: {}, preferences: PREFS, loadLevel: LOAD_LEVEL.HIGH });
  assert.equal(byKind(high, 'water').length, 0);
  assert.equal(byKind(high, 'supplement').length, 0);
  assert.equal(high.some(intent => intent.type === T.HABIT), false);
  const essential = list => list.filter(intent => !isOptionalPrompt(intent));
  assert.deepEqual(essential(high).map(intent => [intent.id, intent.delivery]), essential(normal).map(intent => [intent.id, intent.delivery]));
  assert.ok(high.some(intent => intent.type === T.DEPARTURE_LEAVE_NOW && intent.level === LEVEL.CRITICAL));
  assert.ok(high.some(intent => intent.type === T.DEADLINE_WARNING));
});

test('korkea kuorma: välttämätöksi merkitty (essential) ja kriittinen eivät kevene', () => {
  const list = [supplement('09:00', { essential: true }), make(T.TASK_REMINDER, '08:00', { optionalTopic: 'exercise', level: LEVEL.CRITICAL })];
  const out = applyNotificationPolicy(list, { settings: {}, preferences: PREFS, loadLevel: LOAD_LEVEL.HIGH });
  assert.equal(out.length, 2);
});

test('korkea kuorma rajataan annettuihin päiviin (loadDates)', () => {
  const tomorrow = '2026-09-30';
  const list = [water('10:00'), water('10:00', { date: tomorrow, targetId: 'w-huomenna' })];
  const out = applyNotificationPolicy(list, { settings: {}, preferences: PREFS, loadLevel: LOAD_LEVEL.HIGH, loadDates: [DAY] });
  assert.deepEqual(out.map(intent => intent.date), [tomorrow]);
});

test('reminderLoadLevel: stressi >= 4 tai energia <= 2, viikon kuormitus tai ylivuoto = korkea; tuntematon ei ole korkea', () => {
  assert.equal(LOAD_RULES.HIGH_STRESS_MIN, 4);
  assert.equal(LOAD_RULES.LOW_ENERGY_MAX, 2);
  assert.equal(reminderLoadLevel({ wellbeingEntry: { stress: 4 } }), LOAD_LEVEL.HIGH);
  assert.equal(reminderLoadLevel({ wellbeingEntry: { energy: 2 } }), LOAD_LEVEL.HIGH);
  assert.equal(reminderLoadLevel({ wellbeingEntry: { stress: 3, energy: 3 } }), LOAD_LEVEL.NORMAL);
  assert.equal(reminderLoadLevel({ wellbeingEntry: { stress: null, energy: null } }), LOAD_LEVEL.NORMAL);
  assert.equal(reminderLoadLevel({}), LOAD_LEVEL.NORMAL);
  assert.equal(reminderLoadLevel({ weekOverloaded: true }), LOAD_LEVEL.HIGH);
  assert.equal(reminderLoadLevel({ capacityOverflow: true }), LOAD_LEVEL.HIGH);
});

// =====================================================================
// SOVELLUSKERROS: YKSI PUTKI
// =====================================================================

const MORNING = new Date(2026, 8, 29, 8, 0);

function seedRhythm(settings = {}) {
  setNotificationPreferences(PREFS);
  setLifeSettings([{
    id: 's1',
    mealRhythm: {
      meals: [{ id: 'lounas', name: 'Lounas', time: '11:30', prepMinutes: 0 }],
      supplements: [{ id: 'dvit', name: 'D-vitamiini', time: '09:00' }],
      waterEveryMinutes: 120, waterFrom: '10:00', waterTo: '16:00'
    },
    ...settings
  }]);
}

beforeEach(() => {
  resetState();
});

test('alarmSync.reminderLoad: päivän stressi 5 -> korkea kuorma vain tälle päivälle', () => {
  setWellbeing([{ id: 'w1', date: DAY, stress: 5 }]);
  const load = reminderLoad({ now: MORNING });
  assert.equal(load.level, LOAD_LEVEL.HIGH);
  assert.deepEqual(load.dates, [DAY]);
  assert.deepEqual(load.reasons, ['wellbeing']);
  resetState();
  assert.equal(reminderLoad({ now: MORNING }).level, LOAD_LEVEL.NORMAL);
  assert.deepEqual(reminderLoad({ now: MORNING, capacityOverflow: true }).reasons, ['capacity_overflow']);
});

test('yksi putki: raskaana päivänä vesi ja lisäravinne jäävät pois, ateria tulee', () => {
  seedRhythm();
  const normal = dailyLifeReminderPlan({ now: MORNING }).intents.filter(intent => intent.date === DAY);
  assert.ok(byKind(normal, 'water').length > 0 && byKind(normal, 'supplement').length === 1);
  setWellbeing([{ id: 'w1', date: DAY, stress: 5 }]);
  const plan = dailyLifeReminderPlan({ now: MORNING });
  const today = plan.intents.filter(intent => intent.date === DAY);
  assert.equal(plan.load.level, LOAD_LEVEL.HIGH);
  assert.equal(byKind(today, 'water').length, 0);
  assert.equal(byKind(today, 'supplement').length, 0);
  assert.ok(today.some(intent => intent.type === T.MEAL && !intent.mealKind), 'ateria säilyy');
  // Huominen ei kevene tämän päivän merkinnästä.
  const tomorrow = plan.intents.filter(intent => intent.date === '2026-09-30');
  assert.ok(byKind(tomorrow, 'water').length > 0);
});

test('yksi putki: vesi pois asetuksista -> ei vesitaukoja, lisäravinne ja ateria tulevat', () => {
  seedRhythm({ delivery: { water: DELIVERY_OFF } });
  const intents = dailyLifeReminderPlan({ now: MORNING }).intents;
  assert.equal(byKind(intents, 'water').length, 0);
  assert.ok(byKind(intents, 'supplement').length > 0);
  assert.ok(intents.some(intent => intent.type === T.MEAL && !intent.mealKind));
});

test('yksi putki: sama politiikka koskee kaikkia muistutuksia (ei toista hyvinvointiputkea)', () => {
  const code = readCode('src/app/alarmSync.js');
  assert.equal((code.match(/applyNotificationPolicy\(/g) || []).length, 1, 'yksi politiikan kutsu');
  assert.match(code, /loadLevel: currentLoad\.level/);
});

// =====================================================================
// RAJATUT KORTIT
// =====================================================================

test('rajatut kortit: enintään kaksi riviä näkyvissä, loput avattavissa; ajankohtaiset ensin', () => {
  assert.equal(WELLNESS_CARD_LIMIT, 2);
  const rows = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, due: id === 'd' }));
  const { visible, hidden, hiddenCount } = boundWellnessRows(rows);
  assert.deepEqual(visible.map(row => row.id), ['d', 'a']);
  assert.deepEqual(hidden.map(row => row.id), ['b', 'c', 'e']);
  assert.equal(hiddenCount, 3);
});

test('rajatut kortit: kaksi riviä -> ei piilotettuja; tyhjät pois; kelvoton raja -> oletus', () => {
  assert.equal(boundWellnessRows([{ id: 'a' }, { id: 'b' }]).hiddenCount, 0);
  assert.deepEqual(boundWellnessRows([null, { id: 'a' }, undefined]).visible.map(row => row.id), ['a']);
  assert.equal(boundWellnessRows([{}, {}, {}], -1).visible.length, WELLNESS_CARD_LIMIT);
  assert.deepEqual(boundWellnessRows(null), { visible: [], hidden: [], hiddenCount: 0 });
});

test('Tänään-näkymän tapakortti käyttää rajausta ja sanoo, että hyvinvointi on valinnaista', () => {
  const code = readCode('src/app/views/todayDailyLife.js');
  assert.match(code, /boundWellnessRows\(rows\)/);
  assert.match(code, /Näytä loput \(\$\{hiddenCount\}\)/);
  assert.match(code, /Valinnaista tukea, ei tehtävälista/);
});
