// Migraatio 0015 ja sovelluksen tietokerros: sama totuus molemmissa päissä.
//
// OMINAISUUSTESTI: satunnaisilla ja roskasyötteillä normalisoitu olio, jonka
// validointi hyväksyy, tuottaa AINA rivin, jonka kannan CHECK-rajoitteet
// hyväksyvät. Jos domainin raja ja SQL:n raja erkanevat, sovellus lupaisi
// tallentaa jotain, minkä kanta hylkää (23514) — tai hylkäisi turhaan.
// Predikaatit alla ovat 0015_mental_load.sql:n CHECK-lauseiden suora käännös.
//
// Käänteinen suunta: edustavat VIRHEELLISET rivit (jokainen suojatun ajan
// sääntö, maanantaisääntö, > 5 prioriteettia, odotus ilman WAITING-
// horisonttia) hylkää sekä predikaatti että domainin validointi. Sama
// joukko ajetaan oikeaan PostgreSQL 17:ään harjoittelussa
// (tools/pg-rehearsal/rehearse.mjs, lifecycle 0015).
//
// Lisäksi: objektien määrä (47) on johdettu SQL:stä eikä vain väitetty.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { protectedPeriodsRepo, weeklyPlansRepo } from '../src/data/collectionsRepo.js';
import { validateProtectedPeriod, normalizeProtectedPeriod } from '../src/domain/protectedTime.js';
import { validateWeeklyPlan, normalizeWeeklyPlan, WEEKLY_PRIORITY_DB_LIMIT } from '../src/domain/weeklyPlan.js';
import { normalizeTask, validateTask, TASK_HORIZONS } from '../src/domain/task.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { AREA_KINDS } from '../src/domain/itemNature.js';
import { toRow as taskToRow, TASK_COLUMNS_MENTAL_LOAD } from '../src/lib/rows.js';

const SQL = read('supabase/migrations/0015_mental_load.sql');

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

function pick(rand, list) { return list[Math.floor(rand() * list.length)]; }

const GARBAGE = [null, undefined, '', ' ', 'x', 'null', NaN, Infinity, -1, 0, 1, 7, 8, 60, 10080, 10081, 99999, 1e12,
  true, false, [], {}, '2026-02-30', '2026-09-28', '2026-09-29', '25:00', '07:30', '19:00:00', 'a'.repeat(70),
  'b'.repeat(600), 'c'.repeat(1200), [1, 2, 9], [7], [1, 3, 5], [0], ['2026-09-30'], 'OWN_TIME', 'FREE_TIME',
  'VACATION', 'once', 'weekly', 'weekly_target', 'firm', 'soft', 'WAITING', 'LATER', 'ARCHIVED'];

const VALID_PERIOD = {
  kind: ['OWN_TIME', 'FREE_TIME', 'VACATION'],
  recurrence: ['once', 'weekly', 'weekly_target'],
  startDate: ['2026-09-28', '2026-12-20', '2028-02-29'],
  endDate: ['2026-09-28', '2027-01-06', '2027-12-31', '2026-09-01'],
  weekdays: [[7], [1, 2, 3, 4, 5], [6, 7], [3, 3, 9]],
  startTime: ['07:00', '17:00', '21:30', null],
  endTime: ['08:00', '19:00', '23:59', '06:00', null],
  targetMinutes: [0, 600, 900, 10080],
  strength: ['firm', 'soft'],
  title: ['Oma ilta', '  Sunnuntai  ', 'Loma'],
  note: ['Lepoa', 'x'.repeat(480)]
};

// ---------------------------------------------------------------- SQL-predikaatit

const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const isTime = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v);
const optLen = (v, max) => v === null || (typeof v === 'string' && v.length <= max);
const nonBlankOpt = (v, max) => v === null || (typeof v === 'string' && v.trim().length > 0 && v.length <= max);
const optBetween = (v, lo, hi) => v === null || (Number.isInteger(v) && v >= lo && v <= hi);
const minutes = v => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const isoDow = v => { const d = new Date(v + 'T00:00:00Z').getUTCDay(); return d === 0 ? 7 : d; };

const PERIOD_CHECKS = {
  kind: r => ['OWN_TIME', 'FREE_TIME', 'VACATION'].includes(r.kind),
  recurrence: r => ['once', 'weekly', 'weekly_target'].includes(r.recurrence),
  title: r => nonBlankOpt(r.title, 60),
  note: r => optLen(r.note, 500),
  weekdays: r => r.weekdays === null
    || (Array.isArray(r.weekdays) && r.weekdays.length >= 1 && r.weekdays.length <= 7
        && r.weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7)),
  target: r => optBetween(r.target_minutes, 0, 10080),
  strength: r => ['firm', 'soft'].includes(r.strength),
  dates: r => (r.start_date === null || isDate(r.start_date)) && (r.end_date === null || isDate(r.end_date))
    && (r.start_date === null || r.end_date === null || r.end_date >= r.start_date),
  times: r => (r.start_time === null || isTime(r.start_time)) && (r.end_time === null || isTime(r.end_time))
    && (r.end_time === null || r.start_time !== null)
    && (r.start_time === null || r.end_time === null || minutes(r.start_time) < minutes(r.end_time)),
  once: r => r.recurrence !== 'once' || (r.start_date !== null && r.weekdays === null),
  weekly: r => r.recurrence !== 'weekly' || (r.weekdays !== null && r.weekdays.length >= 1),
  weekly_target: r => (r.recurrence === 'weekly_target' && r.kind === 'FREE_TIME' && r.target_minutes !== null
      && r.start_time === null && r.end_time === null && r.weekdays === null)
    || (r.recurrence !== 'weekly_target' && r.target_minutes === null),
  vacation: r => r.kind !== 'VACATION' || (r.recurrence === 'once' && r.start_time === null && r.end_time === null),
  span: r => r.recurrence !== 'once' || r.end_date === null || r.start_date === null || days(r.start_date, r.end_date) < 366,
  active: r => typeof r.active === 'boolean'
};
const periodAccepted = row => Object.values(PERIOD_CHECKS).every(check => check(row));

const PLAN_CHECKS = {
  week_start: r => isDate(r.week_start) && isoDow(r.week_start) === 1,
  priorities: r => Array.isArray(r.priorities) && r.priorities.length <= 5,
  planned_minutes: r => optBetween(r.planned_minutes, 0, 10080),
  note: r => optLen(r.note, 1000)
};
const planAccepted = row => Object.values(PLAN_CHECKS).every(check => check(row));

const TASK_CHECKS = {
  horizon: r => r.horizon === null || ['NOW', 'THIS_WEEK', 'LATER', 'NOT_YET', 'WAITING'].includes(r.horizon),
  waiting_on: r => r.waiting_on === null || (r.waiting_on.trim().length > 0 && r.waiting_on.length <= 200),
  reschedule_count: r => Number.isInteger(r.reschedule_count) && r.reschedule_count >= 0 && r.reschedule_count <= 10000,
  waiting_on_horizon: r => r.horizon === 'WAITING' || r.waiting_on === null,
  follow_up_date: r => r.follow_up_date === null || isDate(r.follow_up_date),
  original_date: r => r.original_date === null || isDate(r.original_date)
};
const taskAccepted = row => Object.values(TASK_CHECKS).every(check => check(row));

// ---------------------------------------------------------------- SQL-lähde

test('KRIITTINEN: 0015 luo taulut ja jokaisella sopimuksen CHECKillä on predikaatti', () => {
  for (const table of ['protected_periods', 'weekly_plans']) {
    assert.match(SQL, new RegExp(`create table public\\.${table} \\(`), table);
  }
  const periodChecks = [...SQL.matchAll(/add constraint protected_periods_(\w+)_check/g)].map(m => m[1]);
  assert.deepEqual(periodChecks.sort(), ['dates', 'kind', 'note', 'once', 'recurrence', 'span', 'strength',
    'target', 'times', 'title', 'vacation', 'weekdays', 'weekly', 'weekly_target']);
  for (const name of periodChecks) assert.ok(PERIOD_CHECKS[name], `protected_periods_${name}_check`);
  const planChecks = [...SQL.matchAll(/add constraint weekly_plans_(\w+)_check/g)].map(m => m[1]);
  for (const name of planChecks) assert.ok(PLAN_CHECKS[name], `weekly_plans_${name}_check`);
  assert.match(SQL, /add constraint weekly_plans_week_unique unique \(user_id, week_start\)/);
  assert.match(SQL, /check \(extract\(isodow from week_start\) = 1\)/);
  assert.match(SQL, /jsonb_typeof\(priorities\) = 'array' and jsonb_array_length\(priorities\) <= 5/);
  // NULL-turvallinen: horisontti NULL + odotus hylätään (NULL = 'WAITING' olisi NULL -> CHECK hyväksyisi).
  assert.match(SQL, /check \(waiting_on is null or \(horizon is not null and horizon = 'WAITING'\)\);/);
  assert.match(SQL, /alter table public\.tasks alter column date drop not null;/);
  assert.match(SQL, /alter table public\.life_areas drop constraint life_areas_category_unique;/);
  assert.match(SQL, /create index life_areas_user_category_idx\s+on public\.life_areas \(user_id, category_key\);/);
});

test('KRIITTINEN: kannan arvojoukot ovat domainin arvojoukot', () => {
  const inList = name => {
    const m = new RegExp(`${name} in \\(([^)]*)\\)`).exec(SQL);
    assert.ok(m, name);
    return m[1].match(/'([A-Z_a-z]+)'/g).map(s => s.slice(1, -1));
  };
  assert.deepEqual(inList('horizon'), [...TASK_HORIZONS]);
  assert.deepEqual(inList('check \\(kind'), [...AREA_KINDS]);
  assert.equal(TASK_HORIZONS.includes('ARCHIVED'), false, 'arkistointi on archived_at, ei horisontti');
});

test('KRIITTINEN: objektien määrä 47 on johdettu SQL:stä (taulut, sarakkeet, rajoitteet, indeksit, liipaisimet, politiikat)', () => {
  const tables = [...SQL.matchAll(/^create table public\.(\w+)/gm)].length;
  const columns = [...SQL.matchAll(/^alter table public\.(tasks|life_areas) add column (\w+)/gm)].length;
  const constraints = [...SQL.matchAll(/^\s+add constraint (\w+)/gm)].map(m => m[1]);
  const indexes = [...SQL.matchAll(/^create index (\w+)/gm)].length;
  const triggers = [...SQL.matchAll(/^create trigger (\w+)/gm)].length;
  const policies = [...SQL.matchAll(/^create policy (\w+)/gm)].length;
  assert.deepEqual({ tables, columns, constraints: constraints.length, indexes, triggers, policies },
    { tables: 2, columns: 7, constraints: 26, indexes: 2, triggers: 2, policies: 8 });
  assert.equal(tables + columns + constraints.length + indexes + triggers + policies, 47);
  assert.match(SQL, /OBJEKTIEN MÄÄRÄ: 47/);
  assert.match(SQL, /if olemassa = 47 then/);
  // Jokainen luotu rajoite on tunnistuslistassa (muuten osittainen ajo jäisi näkemättä).
  const detection = /select count\(\*\) into olemassa from \(\n([\s\S]*?)\n\s*\) kaikki;/.exec(SQL.replace(/\r\n/g, '\n'))[1];
  for (const name of constraints) assert.ok(detection.includes(`'${name}'`), name);
});

test('KRIITTINEN: tasks ja life_areas lukitaan kerralla ennen ensimmäistä muutosta, auth.users-lukko viimeisenä', () => {
  const lock = SQL.indexOf('lock table public.tasks, public.life_areas in access exclusive mode;');
  const firstAlter = SQL.search(/^alter table public\.(tasks|life_areas) add column/m);
  const firstCreate = SQL.search(/^create table public\./m);
  const detection = SQL.indexOf('if olemassa = 47 then');
  assert.ok(lock > 0 && detection > 0 && detection < lock, 'uudelleenajon tunnistus ennen lukitusta');
  assert.ok(lock < firstAlter, 'lukitus ennen ALTERia');
  assert.ok(firstAlter < firstCreate, 'uudet taulut (auth.users-vierasavain) vasta ALTERien jälkeen');
  assert.match(SQL, /^set local lock_timeout = '5s';$/m);
  assert.equal((SQL.match(/^begin;$/gm) || []).length, 1);
  assert.equal((SQL.match(/^commit;$/gm) || []).length, 1);
});

test('KRIITTINEN: RLS neljällä politiikalla per taulu, to authenticated, ei anon-oikeuksia', () => {
  for (const table of ['protected_periods', 'weekly_plans']) {
    assert.match(SQL, new RegExp(`alter table public\\.${table} enable row level security;`));
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      assert.match(SQL, new RegExp(`create policy ${table}_${cmd}_own on public\\.${table}\\r?\\n\\s+for ${cmd} to authenticated`), `${table} ${cmd}`);
    }
    assert.match(SQL, new RegExp(`for update to authenticated using \\(auth\\.uid\\(\\) = user_id\\)\\r?\\n\\s+with check \\(auth\\.uid\\(\\) = user_id\\);`));
    assert.match(SQL, new RegExp(`revoke all on public\\.${table} from anon;`));
    assert.match(SQL, new RegExp(`grant select, insert, update, delete on public\\.${table} to authenticated;`));
    assert.match(SQL, new RegExp(`add constraint ${table}_owner_row_key unique \\(user_id, id\\);`));
    assert.match(SQL, new RegExp(`create trigger ${table}_touch_updated_at[\\s\\S]*?execute function public\\.touch_updated_at\\(\\);`));
  }
  assert.doesNotMatch(SQL, /^grant [^;]* to anon/m);
  assert.doesNotMatch(SQL, /^grant [^;]* to public/m);
});

// ---------------------------------------------------------------- ominaisuustestit

/**
 * Toistuvuuden kannalta olennaiset kentät saavat useimmiten kelvollisen
 * arvon, muut harvoin: muuten lähes jokainen syöte rikkoisi jonkin
 * rakennesäännön, ja ominaisuus jäisi tyhjäksi. Roska sekoitetaan silti.
 */
const RELEVANT = {
  once: ['startDate', 'endDate', 'startTime', 'endTime'],
  weekly: ['weekdays', 'startTime', 'endTime', 'startDate', 'endDate'],
  weekly_target: ['targetMinutes']
};

test('KRIITTINEN: validoitu suojattu jakso tuottaa aina kannan hyväksymän rivin (3000 syötettä)', () => {
  const rand = mulberry32(20260927);
  const fields = Object.keys(VALID_PERIOD).concat(['active']);
  let accepted = 0;
  for (let i = 0; i < 3000; i += 1) {
    const input = { id: `pp-${i}` };
    const recurrence = rand() < 0.9 ? pick(rand, VALID_PERIOD.recurrence) : pick(rand, GARBAGE);
    const relevant = RELEVANT[recurrence] || [];
    for (const field of fields) {
      const likely = field === 'kind' || field === 'strength' || field === 'title' || relevant.includes(field);
      const roll = rand();
      if (field === 'recurrence') input.recurrence = recurrence;
      else if (VALID_PERIOD[field] && roll < (likely ? 0.75 : 0.08)) input[field] = pick(rand, VALID_PERIOD[field]);
      else if (roll > 0.92) input[field] = pick(rand, GARBAGE);
    }
    const normalized = protectedPeriodsRepo.mapping.normalize(input);
    const verdict = validateProtectedPeriod(normalized);
    const row = protectedPeriodsRepo.mapping.toRow(normalized);
    if (verdict.valid) {
      accepted += 1;
      assert.equal(periodAccepted(row), true,
        `validointi hyväksyi, mutta kanta hylkäisi: ${JSON.stringify(row)} ${JSON.stringify(Object.entries(PERIOD_CHECKS).filter(([, c]) => !c(row)).map(([n]) => n))}`);
    }
    // Käänteinen: kanta hylkää -> domain hylkää (muistipolku ei lupaa enempää kuin kanta).
    if (!periodAccepted(row) && normalized.kind && normalized.recurrence) {
      assert.equal(verdict.valid, false, `kanta hylkää, domain hyväksyy: ${JSON.stringify(row)}`);
    }
    for (const forbidden of ['user_id', 'created_at', 'updated_at']) assert.equal(forbidden in row, false, forbidden);
  }
  assert.ok(accepted >= 150, `vain ${accepted} hyväksyttyä`);
});

test('KRIITTINEN: validoitu viikkosuunnitelma tuottaa aina kannan hyväksymän rivin (1000 syötettä)', () => {
  const rand = mulberry32(1015);
  let accepted = 0;
  for (let i = 0; i < 1000; i += 1) {
    const count = Math.floor(rand() * 9);
    const priorities = Array.from({ length: count }, (_, k) => pick(rand, [
      { ref: `task:t${k}`, title: `Tehtävä ${k}` }, { ref: 'text', title: `Teksti ${k}` }, { title: '' }, null,
      { ref: 'bogus', title: 'x' }, { ref: `goal:g${k}`, title: 'y'.repeat(250) }]));
    const input = {
      id: `wp-${i}`,
      weekStart: pick(rand, ['2026-09-28', '2026-09-29', '2026-10-05', '2027-01-04', '2026-02-30', null]),
      priorities,
      plannedMinutes: pick(rand, [null, 0, 600, 10080, 20000, -5, 'x']),
      closedAt: pick(rand, [null, '2026-09-27T18:00:00.000Z']),
      note: pick(rand, [null, 'Hyvä viikko', 'n'.repeat(1500)])
    };
    const normalized = weeklyPlansRepo.mapping.normalize(input);
    const verdict = validateWeeklyPlan(normalized, { limit: WEEKLY_PRIORITY_DB_LIMIT });
    const row = weeklyPlansRepo.mapping.toRow(normalized);
    if (verdict.valid) {
      accepted += 1;
      assert.equal(planAccepted(row), true, `validointi hyväksyi, kanta hylkäisi: ${JSON.stringify(row).slice(0, 300)}`);
    }
    // Normalisointi rajaa aina kannan rajaan: yli viiden ei koskaan lähde.
    assert.ok(row.priorities.length <= 5);
  }
  assert.ok(accepted >= 200, `vain ${accepted} hyväksyttyä`);
});

test('KRIITTINEN: validoitu tehtävä tuottaa aina kannan hyväksymät 0015-sarakkeet (1500 syötettä)', () => {
  const rand = mulberry32(15);
  let accepted = 0;
  let dateless = 0;
  for (let i = 0; i < 1500; i += 1) {
    const input = {
      id: `t-${i}`,
      title: pick(rand, ['Soita', 'Pese auto', '']),
      date: pick(rand, ['2026-09-28', null, undefined, '2026-02-30']),
      horizon: pick(rand, [...TASK_HORIZONS, null, 'ARCHIVED', 'x']),
      waitingOn: pick(rand, [null, 'Matti', '  ', 'w'.repeat(250), 'Vakuutusyhtiö']),
      followUpDate: pick(rand, [null, '2026-10-01', 'huomenna']),
      archivedAt: pick(rand, [null, '2026-09-27T10:00:00.000Z', '']),
      rescheduleCount: pick(rand, [0, 1, 3, 10000, 20000, -2, 'x', null]),
      originalDate: pick(rand, [null, '2026-09-20', 'eilen'])
    };
    const normalized = normalizeTask(input);
    const verdict = validateTask(normalized, { allowDateless: true });
    const row = taskToRow(normalized, TASK_COLUMNS_MENTAL_LOAD);
    assert.deepEqual(Object.keys(row).sort(), [...TASK_COLUMNS_MENTAL_LOAD].sort());
    if (verdict.valid) {
      accepted += 1;
      if (normalized.date == null) dateless += 1;
      assert.equal(taskAccepted(row), true, `validointi hyväksyi, kanta hylkäisi: ${JSON.stringify(row)}`);
    }
    // Normalisointi yksin riittää CHECK-rajoitteille: odotus nollautuu ilman WAITINGia.
    assert.equal(taskAccepted(row), true, `normalisoitu rivi rikkoo CHECKin: ${JSON.stringify(row)}`);
  }
  assert.ok(accepted >= 200, `vain ${accepted} hyväksyttyä`);
  assert.ok(dateless >= 20, `päivättömiä vain ${dateless}`);
});

test('KRIITTINEN: alueen laji on aina yksi kannan kuudesta arvosta', () => {
  for (const kind of [...AREA_KINDS, null, undefined, 'bogus', 'standard', 7]) {
    const area = normalizeLifeArea({ id: 'a', name: 'Työ', kind });
    assert.ok(AREA_KINDS.includes(area.kind), String(kind));
  }
});

// ---------------------------------------------------------------- virheelliset rivit

/** Edustavat virheelliset rivit: sama joukko ajetaan oikeaan kantaan (rehearsal lifecycle). */
const INVALID_PERIODS = Object.freeze([
  ['kertajakso ilman alkupäivää', { kind: 'OWN_TIME', recurrence: 'once' }],
  ['kertajaksolla viikonpäivät', { kind: 'OWN_TIME', recurrence: 'once', startDate: '2026-10-01', weekdays: [1] }],
  ['loppu ennen alkua', { kind: 'OWN_TIME', recurrence: 'once', startDate: '2026-10-02', endDate: '2026-10-01' }],
  ['viikoittainen ilman viikonpäiviä', { kind: 'FREE_TIME', recurrence: 'weekly' }],
  ['viikkotavoite omalle ajalle', { kind: 'OWN_TIME', recurrence: 'weekly_target', targetMinutes: 600 }],
  ['viikkotavoite ilman lukua', { kind: 'FREE_TIME', recurrence: 'weekly_target' }],
  ['viikkotavoitteella kellonaika', { kind: 'FREE_TIME', recurrence: 'weekly_target', targetMinutes: 600, startTime: '17:00' }],
  ['luku ilman viikkotavoitetta', { kind: 'FREE_TIME', recurrence: 'weekly', weekdays: [7], targetMinutes: 60 }],
  ['viikkotavoite yli viikon', { kind: 'FREE_TIME', recurrence: 'weekly_target', targetMinutes: 10081 }],
  ['loma viikoittain', { kind: 'VACATION', recurrence: 'weekly', weekdays: [6] }],
  ['loma kellonajalla', { kind: 'VACATION', recurrence: 'once', startDate: '2026-12-20', startTime: '08:00' }],
  ['alku ei ennen loppua', { kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [2], startTime: '19:00', endTime: '18:00' }],
  ['loppuaika ilman alkua', { kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [2], endTime: '18:00' }],
  ['yli vuoden kertajakso', { kind: 'VACATION', recurrence: 'once', startDate: '2026-01-01', endDate: '2027-01-02' }]
]);

test('KRIITTINEN: jokaisen suojatun ajan säännön rikkova rivi hylätään sekä kannassa että domainissa', () => {
  for (const [label, input] of INVALID_PERIODS) {
    const normalized = normalizeProtectedPeriod({ id: 'x', ...input });
    // Raakarivi (normalisoinnin ohi) sellaisenaan: kanta hylkää.
    const raw = {
      kind: input.kind, recurrence: input.recurrence, title: null, note: null, active: true, strength: 'firm',
      start_date: input.startDate ?? null, end_date: input.endDate ?? null, weekdays: input.weekdays ?? null,
      start_time: input.startTime ?? null, end_time: input.endTime ?? null, target_minutes: input.targetMinutes ?? null
    };
    assert.equal(periodAccepted(raw), false, `kanta hyväksyisi: ${label}`);
    assert.equal(validateProtectedPeriod(normalized).valid, false, `domain hyväksyisi: ${label}`);
  }
});

test('KRIITTINEN: viikkosuunnitelma — maanantaisääntö ja enintään viisi prioriteettia', () => {
  const base = { week_start: '2026-09-28', priorities: [], planned_minutes: null, note: null };
  assert.equal(planAccepted(base), true);
  assert.equal(planAccepted({ ...base, week_start: '2026-09-29' }), false, 'tiistai');
  assert.equal(planAccepted({ ...base, week_start: '2026-10-04' }), false, 'sunnuntai');
  assert.equal(planAccepted({ ...base, priorities: Array.from({ length: 6 }, (_, i) => ({ ref: 'text', title: `p${i}` })) }), false);
  assert.equal(planAccepted({ ...base, priorities: Array.from({ length: 5 }, (_, i) => ({ ref: 'text', title: `p${i}` })) }), true);
  assert.equal(validateWeeklyPlan(normalizeWeeklyPlan({ weekStart: '2026-09-29' })).valid, false);
  assert.equal(normalizeWeeklyPlan({ weekStart: '2026-09-28',
    priorities: Array.from({ length: 8 }, (_, i) => ({ title: `p${i}` })) }).priorities.length, 5);
});

test('KRIITTINEN: odotus — WAITING + waiting_on kelpaa, muu horisontti + waiting_on hylätään', () => {
  const row = over => ({ horizon: null, waiting_on: null, follow_up_date: null, archived_at: null,
    reschedule_count: 0, original_date: null, ...over });
  assert.equal(taskAccepted(row({ horizon: 'WAITING', waiting_on: 'Matti' })), true);
  assert.equal(taskAccepted(row({ horizon: 'WAITING' })), true, 'odottaa ilman nimeä');
  assert.equal(taskAccepted(row({ horizon: 'LATER', waiting_on: 'Matti' })), false);
  assert.equal(taskAccepted(row({ waiting_on: 'Matti' })), false, 'horisontti null');
  assert.equal(taskAccepted(row({ horizon: 'WAITING', waiting_on: '   ' })), false, 'tyhjä odotus');
  assert.equal(taskAccepted(row({ horizon: 'ARCHIVED' })), false);
  assert.equal(taskAccepted(row({ reschedule_count: 10001 })), false);
  assert.equal(taskAccepted(row({ archived_at: '2026-09-27T10:00:00Z', horizon: 'NOT_YET' })), true, 'arkistoitu');
  // Domain: odotus nollautuu, jos horisontti ei ole WAITING (normalizeTask).
  assert.equal(normalizeTask({ title: 'x', date: '2026-09-28', horizon: 'LATER', waitingOn: 'Matti' }).waitingOn, null);
});

// ---------------------------------------------------------------- E2E-korvike

test('korvike (tools/e2e/fakeSupabase.mjs) tuntee 0015:n rajoitteet ja time-muodon', async () => {
  const { createFakeDatabase, CHECK_CONSTRAINTS, TIME_COLUMNS, UNIQUE_CONSTRAINTS } = await import('../tools/e2e/fakeSupabase.mjs');
  const uid = 'aaaaaaaa-0000-4000-8000-000000000001';
  const db = createFakeDatabase();
  const ok = (table, row) => assert.equal(db.insertRows(table, uid, row).error, undefined, `${table} ${JSON.stringify(row)}`);
  const code = (table, row) => db.insertRows(table, uid, row).error?.code;
  // Kategoria saa olla jaettu (0015 poisti uniikkiuden) — mutta ei tilassa 0014.
  ok('life_areas', { id: 'la1', name: 'Kuoro', category_key: 'harrastus', kind: 'ENJOYMENT' });
  ok('life_areas', { id: 'la2', name: 'Soitto', category_key: 'harrastus', kind: 'OWN_TIME' });
  const k = createFakeDatabase({ through: '0014' });
  assert.equal(k.insertRows('life_areas', uid, { id: 'x1', name: 'A', category_key: 'koti' }).error, undefined);
  assert.equal(k.insertRows('life_areas', uid, { id: 'x2', name: 'B', category_key: 'koti' }).error?.code, '23505');
  assert.equal(k.insertRows('tasks', uid, { id: 't-k', title: 'x', waiting_on: 'Matti' }).error, undefined, 'tila 0014: ei 0015:n CHECKejä');
  // CHECK: odotus vain WAITING-horisontilla (myös NULL-horisontti hylätään).
  ok('tasks', { id: 't1', date: null, title: 'x', horizon: 'WAITING', waiting_on: 'Matti' });
  assert.equal(code('tasks', { id: 't2', title: 'x', horizon: 'LATER', waiting_on: 'Matti' }), '23514');
  assert.equal(code('tasks', { id: 't3', title: 'x', waiting_on: 'Matti' }), '23514');
  assert.equal(db.updateRows('tasks', uid, { horizon: 'LATER' }, [{ column: 'id', op: 'eq', arg: 't1' }]).error?.code, '23514');
  // Viikkosuunnitelma: maanantai, enintään viisi, yksi viikkoa kohti.
  ok('weekly_plans', { id: 'w1', week_start: '2026-09-28', priorities: [] });
  assert.equal(code('weekly_plans', { id: 'w2', week_start: '2026-09-28', priorities: [] }), '23505');
  assert.equal(code('weekly_plans', { id: 'w3', week_start: '2026-09-29', priorities: [] }), '23514');
  assert.equal(code('weekly_plans', { id: 'w4', week_start: '2026-10-05', priorities: [1, 2, 3, 4, 5, 6] }), '23514');
  // Suojattu aika: kellonajat palautuvat HH:MM:SS, säännöt kuten kannassa.
  ok('protected_periods', { id: 'p1', kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [2], start_time: '18:00', end_time: '20:00' });
  assert.equal(db.rows('protected_periods')[0].start_time, '18:00:00');
  assert.equal(code('protected_periods', { id: 'p2', kind: 'VACATION', recurrence: 'weekly', weekdays: [6] }), '23514');
  assert.equal(code('protected_periods', { id: 'p3', kind: 'OWN_TIME', recurrence: 'weekly_target', target_minutes: 600 }), '23514');
  assert.deepEqual(TIME_COLUMNS.protected_periods, ['start_time', 'end_time']);
  assert.deepEqual(UNIQUE_CONSTRAINTS.weekly_plans, [['weekly_plans_week_unique', ['user_id', 'week_start']]]);
  // Korvikkeen säännöt ovat samat kuin SQL:ssä nimettyinä.
  for (const [table, list] of Object.entries(CHECK_CONSTRAINTS)) {
    for (const [name] of list) assert.match(SQL, new RegExp(`add constraint ${name}\\b`), `${table}: ${name}`);
  }
});
