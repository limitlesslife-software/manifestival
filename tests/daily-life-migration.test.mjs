// Migraatio 0014 ja sovelluksen tietokerros: sama totuus molemmissa päissä.
//
// OMINAISUUSTESTI: satunnaisilla ja roskasyötteillä normalisoitu olio, jonka
// validointi hyväksyy, tuottaa AINA rivin, jonka kannan CHECK-rajoitteet
// hyväksyvät. Jos domainin raja ja SQL:n raja erkanevat, sovellus lupaisi
// tallentaa jotain, minkä kanta hylkää (23514) — tai hylkäisi turhaan.
// Predikaatit alla ovat 0014_daily_life.sql:n CHECK-lauseiden suora käännös.
//
// Lisäksi: jokaisen taulun rivimuunnos kulkee edestakaisin (toRow -> fromRow)
// muuttumatta, eikä yksikään sarake ole sijaintitietoa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import {
  savedPlacesRepo, placeAliasesRepo, calendarEventsRepo, commuteObservationsRepo, lifeSettingsRepo,
  sleepLogsRepo, habitPlansRepo, habitEventsRepo, exerciseSessionsRepo, wellbeingCheckinsRepo
} from '../src/data/collectionsRepo.js';
import { validateSavedPlace, validatePlaceAlias } from '../src/domain/savedPlace.js';
import { validateCalendarEvent } from '../src/domain/calendarEvent.js';
import { validateCommuteObservation } from '../src/domain/commuteObservation.js';
import { validateLifeSettings } from '../src/domain/lifeSettings.js';
import { validateSleepLog } from '../src/domain/sleepLog.js';
import { validateHabitPlan, validateHabitEvent } from '../src/domain/habit.js';
import { validateExerciseSession } from '../src/domain/exerciseSession.js';
import { validateWellbeingCheckin } from '../src/domain/wellbeingCheckin.js';

const SQL = read('supabase/migrations/0014_daily_life.sql');

// ---------------------------------------------------------------- satunnaisuus

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GARBAGE = [null, undefined, '', ' ', 'x', 'null', NaN, Infinity, -1, 0, 1, 5, 60, 241, 481, 1441, 99999, 1e12,
  true, false, [], {}, '2026-02-30', '2026-09-29', '25:00', '07:30', 'a'.repeat(90), 'b'.repeat(310), 'c'.repeat(2100),
  'Työ', '  Parturi  ', 'driving', 'walking', 'rocket', [1, 2, 9], [1, 3, 5], ['2026-09-30'], 'use', 'teleport'];

function pick(rand, list) { return list[Math.floor(rand() * list.length)]; }

/**
 * Kelvollisia arvoja pakollisille kentille: ilman näitä päivämäärää vaativat
 * taulut hyväksyisivät vain harvoja satunnaissyötteitä, ja ominaisuus jäisi
 * lähes tyhjäksi. Roska sekoitetaan silti joukkoon.
 */
const VALID = {
  date: ['2026-09-29', '2026-10-25', '2026-03-29', '2028-02-29'], observedOn: ['2026-09-28'], wakeDate: ['2026-09-28'],
  weekday: [1, 3, 7], placeId: ['p1'], planId: ['h1'], title: ['Parturi', 'Työ'], kind: ['Juoksu', 'nicotine', 'generic'],
  name: ['Työ', 'Nikotiini'], alias: ['duuni'], startTime: ['07:30', '16:00', null], occurredAt: ['2026-09-28T08:00:00.000Z'],
  action: ['use', 'delay', 'skip'], motivation: [1, 3, 5], control: [2, 4], travelMinutes: [35, 90],
  actualBedtime: ['22:45', '00:30'], actualWake: ['06:10'], durationMinutes: [45, 90]
};

// ---------------------------------------------------------------- SQL-predikaatit

const len = v => (typeof v === 'string' ? v.length : NaN);
const nonBlank = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optLen = (v, max) => v === null || len(v) <= max;
const optBetween = (v, lo, hi) => v === null || (Number.isInteger(v) && v >= lo && v <= hi);
const between = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const isTime = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v);
const optTime = v => v === null || isTime(v);
const jsonSize = v => JSON.stringify(v).length;
const MODES = ['driving', 'transit', 'walking', 'cycling', 'other'];
const DELIVERY = ['silent', 'vibrate', 'sound', 'speech', 'sound_and_speech', 'critical_escalation'];

const CHECKS = {
  saved_places: r => nonBlank(r.name, 80) && optLen(r.address, 300) && optLen(r.provider_place_id, 200)
    && optLen(r.area, 80) && MODES.includes(r.travel_mode) && optBetween(r.usual_travel_minutes, 1, 1440)
    && optBetween(r.preparation_minutes, 0, 480) && optBetween(r.arrival_buffer_minutes, 0, 240)
    && optBetween(r.overhead_minutes, 0, 240) && optLen(r.note, 500) && typeof r.use_learned === 'boolean',
  place_aliases: r => nonBlank(r.alias, 80) && between(r.confirmations, 1, 10000) && typeof r.place_id === 'string',
  calendar_events: r => nonBlank(r.title, 200) && isDate(r.event_date) && r.all_day === (r.start_time === null)
    && optTime(r.start_time) && optTime(r.end_time) && (r.end_time === null || r.start_time !== null)
    && optBetween(r.duration_minutes, 1, 1440) && nonBlank(r.category, 40) && optLen(r.location_text, 200)
    && (r.travel_mode === null || MODES.includes(r.travel_mode)) && optBetween(r.travel_minutes, 1, 1440)
    && optBetween(r.preparation_minutes, 0, 480) && optBetween(r.arrival_buffer_minutes, 0, 240)
    && optBetween(r.overhead_minutes, 0, 240)
    && Array.isArray(r.recurrence_weekdays) && r.recurrence_weekdays.length <= 7
    && r.recurrence_weekdays.every(d => between(d, 1, 7))
    && (r.recurrence_until === null || (isDate(r.recurrence_until) && r.recurrence_until >= r.event_date))
    && Array.isArray(r.skip_dates) && r.skip_dates.length <= 366 && r.skip_dates.every(isDate)
    && optLen(r.notes, 2000),
  commute_observations: r => typeof r.place_id === 'string' && (r.event_id === null || (len(r.event_id) >= 1 && len(r.event_id) <= 100))
    && isDate(r.observed_on) && between(r.weekday, 1, 7) && optTime(r.planned_departure) && optTime(r.actual_departure)
    && optTime(r.arrival_at) && optBetween(r.travel_minutes, 1, 1440) && optBetween(r.provider_minutes, 1, 1440)
    && optBetween(r.preparation_minutes, 0, 480) && optBetween(r.overhead_minutes, 0, 240)
    && (r.arrival_result === null || ['early', 'on_time', 'late'].includes(r.arrival_result))
    && ['user_confirmed', 'departure_ack'].includes(r.source ?? 'user_confirmed'),
  life_settings: r => between(r.weekend_wake_shift_max_minutes, 0, 240) && between(r.weekend_bed_shift_max_minutes, 0, 240)
    && between(r.wind_down_minutes, 0, 180) && between(r.arrival_buffer_minutes, 0, 120)
    && ['rauhallinen', 'napakka', 'aktiivinen'].includes(r.guidance_style) && between(r.reminder_offset_minutes, 0, 60)
    && (r.hourly_value_minor === null || between(r.hourly_value_minor, 1, 1000000000)) && /^[A-Z]{3}$/.test(r.currency)
    && r.alarm && typeof r.alarm === 'object' && !Array.isArray(r.alarm) && jsonSize(r.alarm) <= 8192
    && Array.isArray(r.morning_routine) && jsonSize(r.morning_routine) <= 8192
    && r.meal_rhythm && typeof r.meal_rhythm === 'object' && !Array.isArray(r.meal_rhythm) && jsonSize(r.meal_rhythm) <= 8192
    && r.delivery && typeof r.delivery === 'object' && !Array.isArray(r.delivery) && jsonSize(r.delivery) <= 4096
    && optTime(r.bedtime_target) && isTime(r.digest_time),
  sleep_logs: r => isDate(r.wake_date) && ['user', 'alarm'].includes(r.source) && ['opportunity', 'measured'].includes(r.kind)
    && optLen(r.note, 500) && optTime(r.planned_bedtime) && optTime(r.actual_bedtime) && optTime(r.planned_wake) && optTime(r.actual_wake),
  habit_plans: r => ['nicotine', 'generic'].includes(r.kind) && nonBlank(r.name, 80) && optBetween(r.min_interval_minutes, 1, 1440)
    && optBetween(r.daily_target, 0, 200) && optBetween(r.baseline_per_day, 0, 200)
    && Array.isArray(r.steps) && jsonSize(r.steps) <= 8192 && DELIVERY.includes(r.reminder_delivery)
    && optBetween(r.unit_cost_minor, 0, 10000000) && typeof r.active === 'boolean',
  habit_events: r => typeof r.plan_id === 'string' && ['use', 'delay', 'skip'].includes(r.action) && optLen(r.note, 200)
    && typeof r.occurred_at === 'string' && !Number.isNaN(Date.parse(r.occurred_at)),
  exercise_sessions: r => isDate(r.session_date) && nonBlank(r.kind, 60) && optBetween(r.planned_minutes, 1, 1440)
    && optBetween(r.actual_minutes, 1, 1440) && optBetween(r.intensity, 1, 5) && optBetween(r.recovery_demand, 1, 5)
    && optLen(r.note, 500),
  wellbeing_checkins: r => isDate(r.date) && optBetween(r.motivation, 1, 5) && optBetween(r.control, 1, 5)
};

const TABLES = [
  { repo: savedPlacesRepo, validate: validateSavedPlace, fields: ['name', 'address', 'area', 'travelMode', 'usualTravelMinutes',
    'preparationMinutes', 'arrivalBufferMinutes', 'overheadMinutes', 'useLearned', 'note', 'providerPlaceId'] },
  { repo: placeAliasesRepo, validate: validatePlaceAlias, fields: ['placeId', 'alias', 'confirmations'] },
  { repo: calendarEventsRepo, validate: validateCalendarEvent, fields: ['title', 'date', 'startTime', 'endTime', 'durationMinutes',
    'allDay', 'category', 'locationText', 'placeId', 'travelMode', 'travelMinutes', 'preparationMinutes',
    'arrivalBufferMinutes', 'overheadMinutes', 'recurrenceWeekdays', 'recurrenceUntil', 'skipDates', 'notes'] },
  { repo: commuteObservationsRepo, validate: validateCommuteObservation, fields: ['placeId', 'eventId', 'observedOn', 'weekday',
    'plannedDeparture', 'actualDeparture', 'arrivalAt', 'travelMinutes', 'providerMinutes', 'preparationMinutes',
    'overheadMinutes', 'arrivalResult', 'source'] },
  { repo: lifeSettingsRepo, validate: validateLifeSettings, fields: ['weekendWakeShiftMaxMinutes', 'weekendBedShiftMaxMinutes',
    'windDownMinutes', 'bedtimeTarget', 'arrivalBufferMinutes', 'guidanceStyle', 'speechEnabled', 'reminderOffsetMinutes',
    'digestEnabled', 'digestTime', 'hourlyValueMinor', 'currency', 'alarm', 'morningRoutine', 'mealRhythm', 'delivery'] },
  { repo: sleepLogsRepo, validate: validateSleepLog, fields: ['wakeDate', 'plannedBedtime', 'actualBedtime', 'plannedWake',
    'actualWake', 'source', 'kind', 'note'] },
  { repo: habitPlansRepo, validate: validateHabitPlan, fields: ['kind', 'name', 'minIntervalMinutes', 'dailyTarget',
    'baselinePerDay', 'steps', 'reminderDelivery', 'unitCostMinor', 'active'] },
  { repo: habitEventsRepo, validate: validateHabitEvent, fields: ['planId', 'occurredAt', 'action', 'note'] },
  { repo: exerciseSessionsRepo, validate: validateExerciseSession, fields: ['date', 'kind', 'plannedMinutes', 'actualMinutes',
    'intensity', 'recoveryDemand', 'goalId', 'note'] },
  { repo: wellbeingCheckinsRepo, validate: validateWellbeingCheckin, fields: ['date', 'motivation', 'control'] }
];

test('KRIITTINEN: jokainen 0014:n taulu on SQL:ssä ja sillä on CHECK-predikaatti', () => {
  for (const { repo } of TABLES) {
    assert.match(SQL, new RegExp(`create table public\\.${repo.table} \\(`), repo.table);
    assert.ok(CHECKS[repo.table], repo.table);
  }
});

test('KRIITTINEN: validoitu olio tuottaa aina kannan hyväksymän rivin (ominaisuustesti, 400 × 10)', () => {
  const rand = mulberry32(20260927);
  for (const { repo, validate, fields } of TABLES) {
    let accepted = 0;
    for (let i = 0; i < 400; i += 1) {
      const input = { id: `t-${i}` };
      for (const field of fields) {
        if (VALID[field] && rand() < 0.6) input[field] = pick(rand, VALID[field]);
        else if (rand() < 0.85) input[field] = pick(rand, GARBAGE);
      }
      if (repo.table === 'habit_events' && rand() < 0.5) input.occurredAt = '2026-09-28T08:00:00.000Z';
      let normalized;
      assert.doesNotThrow(() => { normalized = repo.mapping.normalize(input); }, `${repo.table}: normalize heitti`);
      let verdict;
      assert.doesNotThrow(() => { verdict = validate(normalized); }, `${repo.table}: validate heitti`);
      if (!verdict.valid) continue;
      accepted += 1;
      const row = repo.mapping.toRow(normalized);
      assert.equal(CHECKS[repo.table](row), true,
        `${repo.table}: validointi hyväksyi, mutta kanta hylkäisi: ${JSON.stringify(row).slice(0, 400)}`);
      for (const forbidden of ['user_id', 'created_at', 'updated_at']) {
        assert.equal(forbidden in row, false, `${repo.table}: ${forbidden}`);
      }
    }
    // Ominaisuus ei ole tyhjä: jokaisessa taulussa riittävästi hyväksyttyjä.
    assert.ok(accepted >= 20, `${repo.table}: vain ${accepted} hyväksyttyä`);
  }
});

test('KRIITTINEN: tyypillinen rivi kulkee edestakaisin (toRow -> fromRow) muuttumatta', () => {
  const samples = {
    saved_places: { id: 'p1', name: 'Työ', address: 'Katu 1', travelMode: 'transit', usualTravelMinutes: 35, useLearned: true },
    place_aliases: { id: 'a1', placeId: 'p1', alias: 'duuni', confirmations: 3, lastConfirmedAt: '2026-09-28T08:00:00.000Z' },
    calendar_events: { id: 'e1', title: 'Parturi', date: '2026-09-29', startTime: '16:00', durationMinutes: 45,
      placeId: 'p1', recurrenceWeekdays: [2], recurrenceUntil: '2026-12-31', skipDates: ['2026-10-06'] },
    commute_observations: { id: 'o1', placeId: 'p1', observedOn: '2026-09-28', weekday: 1, plannedDeparture: '06:05',
      actualDeparture: '06:12', travelMinutes: 38, arrivalResult: 'on_time' },
    life_settings: { id: 's1', windDownMinutes: 45, guidanceStyle: 'napakka', alarm: { enabled: true } },
    sleep_logs: { id: 'l1', wakeDate: '2026-09-28', actualBedtime: '22:45', actualWake: '06:10' },
    habit_plans: { id: 'h1', kind: 'nicotine', name: 'Nikotiini', minIntervalMinutes: 120, dailyTarget: 6 },
    habit_events: { id: 'v1', planId: 'h1', occurredAt: '2026-09-28T08:00:00.000Z', action: 'use' },
    exercise_sessions: { id: 'x1', date: '2026-09-28', kind: 'Juoksu', actualMinutes: 30, intensity: 3 },
    wellbeing_checkins: { id: 'w1', date: '2026-09-28', motivation: 4, control: 2 }
  };
  for (const { repo } of TABLES) {
    const normalized = repo.mapping.normalize(samples[repo.table]);
    const row = { ...repo.mapping.toRow(normalized), created_at: '2026-09-28T08:00:00Z', updated_at: '2026-09-28T09:00:00Z' };
    const back = repo.mapping.fromRow(row);
    const strip = o => { const { createdAt, updatedAt, ...rest } = o; return rest; };
    assert.deepEqual(strip(back), strip(normalized), repo.table);
    assert.equal(back.createdAt, '2026-09-28T08:00:00Z', `${repo.table}: created_at luetaan`);
  }
});

test('KRIITTINEN: yksikään 0014:n sarake ei ole sijaintitietoa', () => {
  const columns = [...SQL.matchAll(/^ {2}(\w+)\s+(?:text|integer|int|bigint|smallint|boolean|date|time|timestamptz|jsonb|uuid|numeric)/gm)]
    .map(m => m[1]);
  assert.ok(columns.length > 60, `sarakkeita ${columns.length}`);
  for (const column of columns) {
    assert.equal(/lat|lng|lon(?!g)|geo|gps|coord|point|geometry|location_history/i.test(column), false, column);
  }
});
