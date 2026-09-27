// Aallot ja taukopisteet: mitä sovellus kirjoittaa kantaan kunkin
// migraation ympärillä.
//
// Juna (docs/activation/release-train-c-j.json): 0009 ajetaan aallon E
// ollessa tuotannossa, sen jälkeen deployataan F; 0010 ajetaan F:n aikana
// ja sen jälkeen G; jne. Jokainen migraation jälkeinen hetki on TAUKO:
// juna voi pysähtyä siihen päiviksi. Tauolla
//
//   1. elävä aalto kirjoittaa (vanhan koodin rivimuoto uuteen skeemaan)
//   2. seuraava aalto kirjoittaa (uuden koodin rivimuoto, portit auki)
//   3. saman migraation verify ajetaan uudelleen datan kanssa (0 FAIL)
//   4. seuraavan migraation preflight ajetaan (0 FAIL)
//   5. kirjataan, estääkö kirjoitettu data migraation ROLLBACKin
//
// RIVIMUODOT OVAT SOVELLUKSEN OMIA: src/data/collectionsRepo.js
// repo.mapping.toRow(repo.mapping.normalize(x)), src/lib/rows.js
// toRow(normalizeTask(x), taskColumns()), profileToRow ja
// preferencesToRow — ladattuina aallon sarakeporteilla
// (app-gate-hooks.mjs). Käsin kirjoitettua SQL-muotoa ei ole.

import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, OWNER, wirePayload, noteRead } from './lib.mjs';
import { WAVES, COLUMN_GATES, cumulativeGates, waveIndex } from '../release/waves.mjs';

export const TRAIN_FILE = 'docs/activation/release-train-c-j.json';

/** Taukopisteet: migraation jälkeen elävä aalto ja seuraavaksi deployattava. */
export const PAUSES = Object.freeze([
  Object.freeze({ after: '0008', live: 'E', next: null }),
  Object.freeze({ after: '0009', live: 'E', next: 'F' }),
  Object.freeze({ after: '0010', live: 'F', next: 'G' }),
  Object.freeze({ after: '0011', live: 'G', next: 'H' }),
  Object.freeze({ after: '0012', live: 'H', next: 'I' }),
  Object.freeze({ after: '0013', live: 'I', next: 'J' }),
  // 0014 ajetaan aallon J ollessa tuotannossa; sen jälkeen deployataan K.
  Object.freeze({ after: '0014', live: 'J', next: 'K' })
]);

/**
 * Junan aallot: avoimet taulut (TABLES-avaimet) ja auki olevat sarakeportit.
 *
 * Lukitut aallot (C–J) luetaan lukkotiedostosta sellaisenaan. Aalto, jota
 * lukko ei vielä tunne (K: aaltocommit rakennetaan J v2:n päälle vasta
 * myöhemmin, eikä lukkoa kirjoiteta ilman sitä), JOHDETAAN
 * tools/release/waves.mjs:stä: kumulatiiviset tauluportit ja sarakeportit,
 * jotka ovat auenneet viimeistään tässä aallossa. `locked: false` kertoo
 * raportissa, ettei aaltoa ole vielä lukittu.
 */
export function trainWaves(file = TRAIN_FILE) {
  const raw = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  const waves = Array.isArray(raw.waves) ? raw.waves : null;
  if (!waves) throw new Error(`${file}: waves-lista puuttuu`);
  const out = {};
  for (const w of waves) {
    if (!Array.isArray(w.gatesCumulative) || !w.columnGates) {
      throw new Error(`${file}: aallolta ${w.wave} puuttuu gatesCumulative tai columnGates`);
    }
    out[w.wave] = Object.freeze({
      wave: w.wave,
      migration: w.migration || null,
      tables: Object.freeze([...w.gatesCumulative]),
      gates: Object.freeze(Object.entries(w.columnGates).filter(([, v]) => v && v.expected === true).map(([k]) => k).sort()),
      locked: true
    });
  }
  const lastLocked = Math.max(...waves.map(w => waveIndex(w.wave) ?? -1));
  for (const w of WAVES) {
    if (out[w.id] || waveIndex(w.id) <= lastLocked) continue;
    const index = waveIndex(w.id);
    out[w.id] = Object.freeze({
      wave: w.id,
      migration: w.migrationFile ? basename(w.migrationFile) : null,
      tables: Object.freeze([...cumulativeGates(w.id)]),
      gates: Object.freeze(Object.entries(COLUMN_GATES).filter(([, opens]) => waveIndex(opens) <= index).map(([k]) => k).sort()),
      locked: false
    });
  }
  return out;
}

let hooksRegistered = false;
const moduleCache = new Map();

/** Lataa sovelluksen rivimuunnokset annetuilla sarakeporteilla. */
export async function loadAppModules(gates) {
  const key = [...gates].sort().join(',');
  if (moduleCache.has(key)) return moduleCache.get(key);
  if (!hooksRegistered) {
    register('./app-gate-hooks.mjs', import.meta.url);
    hooksRegistered = true;
  }
  const url = rel => `${pathToFileURL(join(ROOT, rel)).href}?mvgates=${encodeURIComponent(key)}`;
  const [repos, rows, schema, task, profile, prefs] = await Promise.all([
    import(url('src/data/collectionsRepo.js')),
    import(url('src/lib/rows.js')),
    import(url('src/data/schema.js')),
    import(url('src/domain/task.js')),
    import(url('src/data/profileRepo.js')),
    import(url('src/data/notificationPrefsRepo.js'))
  ]);
  for (const f of ['src/data/collectionsRepo.js', 'src/lib/rows.js', 'src/data/schema.js',
    'src/domain/task.js', 'src/data/profileRepo.js', 'src/data/notificationPrefsRepo.js', TRAIN_FILE]) {
    // Alkuperätietoon: rivimuodot tulivat näistä tiedostoista.
    noteRead(f);
  }
  const mods = { repos, rows, schema, task, profile, prefs, gates: key ? key.split(',') : [] };
  moduleCache.set(key, mods);
  return mods;
}

/** Päivämäärä aallon järjestysnumerosta (uniikit päivät/viikot per aalto). */
export const WAVE_INDEX = Object.freeze({ C: 0, D: 1, E: 2, F: 3, G: 4, H: 5, I: 6, J: 7, K: 8 });
function isoDay(base, days) {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Aallon kirjoitukset: järjestetty lista PostgREST-operaatioita
 * { table, method, payload, match?, onConflict?, label }.
 *
 * `prefix`   uusien rivien tunnisteiden etuliite (uniikki per kirjoitussarja)
 * `legacyTaskId`  olemassa oleva tehtävä, johon riippuvuus voi viitata
 * `upsertOwnRows` profile/notification_preferences upsert (sovellus tekee
 *                 sen AINA omaan riviinsä — muuttaa tuotannon riviä)
 */
export async function waveWrites(waveName, { prefix, legacyTaskId = 'seed1', upsertOwnRows = true, train = trainWaves(), slot = null } = {}) {
  const wave = train[waveName];
  if (!wave) throw new Error(`Tuntematon aalto ${waveName}`);
  const mods = await loadAppModules(wave.gates);
  const open = new Set(wave.tables);
  const gate = g => wave.gates.includes(g);
  const P = prefix;
  const n = slot ?? WAVE_INDEX[waveName] ?? 0;
  const day = isoDay('2026-09-01', n);
  const monday = isoDay('2026-10-05', 7 * n);
  const ops = [];
  const repoFor = key => {
    const repo = mods.repos.ALL_REPOSITORIES.find(r => r.schemaKey === key);
    if (!repo) throw new Error(`Repositoriota ${key} ei löytynyt`);
    return repo;
  };
  const toRowOf = (key, entity) => {
    const repo = repoFor(key);
    return wirePayload(repo.mapping.toRow(repo.mapping.normalize(entity)));
  };
  const idOwned = new Set(['profile', 'notification_preferences']);
  const add = (key, table, entity, change, { remove = false } = {}) => {
    if (key && !open.has(key)) return false;
    const row = key ? toRowOf(key, entity) : entity;
    ops.push({ table, method: 'insert', payload: row, label: `${waveName}:${table}:insert` });
    if (change) {
      const updated = key ? toRowOf(key, { ...entity, ...change }) : { ...entity, ...change };
      ops.push({ table, method: 'update', payload: updated, match: { user_id: OWNER, id: row.id },
                 label: `${waveName}:${table}:update` });
    }
    if (remove) ops.push({ table, method: 'delete', match: { user_id: OWNER, id: row.id }, label: `${waveName}:${table}:delete` });
    return true;
  };

  const has = key => open.has(key);
  const ids = {
    area: has('lifeAreas') ? `${P}-la` : null,
    goal: `${P}-goal`,
    milestone: has('milestones') ? `${P}-ms` : null,
    project: `${P}-proj`,
    routine: `${P}-rout`,
    task: `${P}-task`
  };

  // Järjestys noudattaa vierasavaimia: alue -> tavoite -> välitavoite ->
  // projekti -> rutiini -> tehtävä -> muut.
  add('lifeAreas', 'life_areas',
    { id: ids.area, name: `Terveys ${P}`, importance: 5, targetMinutesPerWeek: 300, active: true },
    { importance: 4 });
  add('goals', 'goals', {
    id: ids.goal, title: `Tavoite ${P}`, category: 'kehitys', priority: 'normaali', status: 'active',
    progressMode: 'task_based', metric: 'paino', unit: 'kg', baselineValue: 90, currentValue: 85.5,
    targetValue: 75, measuredOn: day, lifeAreaId: ids.area
  }, { currentValue: 84.2 });
  if (gate('GOAL_MAINTENANCE_MODE')) {
    add('goals', 'goals', { id: `${P}-goal-maint`, title: `Ylläpito ${P}`, status: 'maintenance', category: 'hyvinvointi' });
  }
  add('milestones', 'milestones',
    { id: ids.milestone, goalId: ids.goal, title: `Välietappi ${P}`, targetDate: isoDay(day, 30), orderIndex: 1, rule: 'manual' },
    { orderIndex: 2 });
  add('projects', 'projects', {
    id: ids.project, name: `Projekti ${P}`, category: 'kehitys', priority: 'normaali', status: 'active',
    goalId: ids.goal, startDate: day, deadline: isoDay(day, 60), milestoneId: ids.milestone
  }, { status: 'on_hold' });
  add('routines', 'routines', {
    id: ids.routine, title: `Kävely ${P}`, durationMinutes: 30,
    recurrence: { type: 'weekly', weekdays: [1, 3, 5] }, preferredTime: '07:30', goalId: ids.goal
  }, { durationMinutes: 35 });
  add('routineExceptions', 'routine_exceptions',
    { id: `${P}-rex`, routineId: ids.routine, date: day, type: 'skip' }, { type: 'skip', note: 'sairas' });

  // Tehtävä: sama polku kuin tasksRepo.payloadFor.
  const taskEntity = {
    id: ids.task, date: day, time: '10:00', endTime: '10:45', title: `Tehtävä ${P}`, category: 'tyo',
    note: null, completed: false, isWake: false, description: 'kuvaus', durationMinutes: 45,
    priority: 'korkea', schedulingState: 'manual', milestoneId: ids.milestone, dependsOn: [legacyTaskId]
  };
  const taskRow = e => wirePayload(mods.rows.toRow(mods.task.normalizeTask(e), mods.schema.taskColumns()));
  add(null, 'tasks', taskRow(taskEntity));
  ops.push({ table: 'tasks', method: 'update', payload: taskRow({ ...taskEntity, completed: true }),
             match: { user_id: OWNER, id: ids.task }, label: `${waveName}:tasks:update` });

  add('wellbeing', 'wellbeing_entries', { id: `${P}-wb`, date: day, energy: 3, mood: 4, stress: 2, sleepHours: 7.5 },
    { mood: 5 });
  add('recurringExpenses', 'recurring_expenses',
    { id: `${P}-rec`, name: `Vuokra ${P}`, amountMinor: 85000, cadence: 'monthly', dayOfMonth: 1, nextDueDate: isoDay(day, 30) },
    { amountMinor: 86000 });
  add('savingsGoals', 'savings_goals', { id: `${P}-sav`, name: `Puskuri ${P}`, targetMinor: 300000, currentMinor: 1000 },
    { currentMinor: 2000 });
  add('bills', 'bills', {
    id: `${P}-bill`, name: `Sähkö ${P}`, amountMinor: 4590, dueDate: isoDay(day, 10), status: 'open',
    taskId: ids.task, recurringExpenseId: has('recurringExpenses') ? `${P}-rec` : null,
    payee: 'Sähköyhtiö Oy', iban: 'FI21 1234 5600 0007 85', reference: '1232'
  }, { status: 'paid', paidDate: isoDay(day, 9) });
  add('aiAudit', 'ai_action_audit',
    { id: `${P}-audit`, inputSummary: 'lisää tehtävä', intent: 'create_task', risk: 'low', targetType: 'task', targetId: ids.task },
    { confirmed: true, executed: true, result: 'executed' });
  add('transactions', 'transactions',
    { id: `${P}-tx`, kind: 'expense', amountMinor: 990, date: day, description: 'Kahvi' }, { amountMinor: 1090 });
  add('investments', 'investments',
    { id: `${P}-inv`, name: `Indeksirahasto ${P}`, kind: 'fund', quantity: 10.5, costBasisMinor: 100000 },
    { quantity: 11 });
  // capturedAt: src/app/capture.js asettaa sen aina (toRow lähettäisi muuten
  // nimenomaisen nullin, jolloin kannan oletus now() ei päde -> 23502).
  add('inboxItems', 'inbox_items', { id: `${P}-inbox`, text: 'Muista soittaa', capturedAt: `${day}T09:00:00.000Z` },
    { status: 'processed' });
  add('reminders', 'reminders', { id: `${P}-rem`, title: 'Muistutus', dueDate: isoDay(day, 5), dueTime: '09:00' },
    { dueTime: '09:30' });
  add('notices', 'notices', { id: `${P}-notice`, key: `k-${P}`, kind: 'reminder', title: 'Ilmoitus', createdDate: day },
    { status: 'read' });
  add('travelPlans', 'travel_plans', {
    id: `${P}-travel`, title: 'Matka', origin: 'Koti', destination: 'Keskusta', arrivalDate: isoDay(day, 5),
    arrivalTime: '10:00', mode: 'driving', travelMinutes: 25, travelSource: 'manual', taskId: ids.task
  }, { travelMinutes: 30 });
  add('locationRules', 'location_rules',
    { id: `${P}-loc`, place: 'Koti', triggerType: 'arriving', message: 'Muista', active: true, taskId: ids.task },
    { active: false });
  add('weeklyCapacities', 'weekly_capacities',
    { id: `${P}-cap`, weekStart: monday, availableMinutes: 1200, energyLevel: 3, energyBudgetMinutes: 600 },
    { availableMinutes: 1100 });
  add('timeEntries', 'time_entries', {
    id: `${P}-te`, entryDate: day, minutes: 25, lifeAreaId: ids.area, goalId: ids.goal, taskId: ids.task,
    projectId: ids.project, routineId: ids.routine, occurrenceDate: day, operationId: `op:${P}:1`,
    source: 'timer', startedAt: `${day}T07:00:00.000Z`, endedAt: `${day}T07:25:00.000Z`
  }, { minutes: 30, endedAt: `${day}T07:30:00.000Z` });
  add('alignmentReviews', 'alignment_reviews',
    { id: `${P}-rev`, weekStart: monday, snapshot: { v: 1 }, reflection: null, adjustments: [], policyVersion: 1, reflectionAnswers: {} },
    { completedAt: `${day}T18:00:00.000Z` });
  add('runningTimers', 'running_timers',
    { id: `${P}-timer`, targetKind: 'task', taskId: ids.task, startedAt: `${day}T08:00:00.000Z` },
    { pausedSeconds: 60 }, { remove: true });
  add('alignmentItemSettings', 'alignment_item_settings',
    { id: `${P}-ais`, itemKind: 'task', itemId: ids.task, energyDemand: 4 }, { energyDemand: 3 });

  // Aalto K (0014): arjen käyttöjärjestelmän kymmenen taulua. Järjestys
  // noudattaa yhdistelmävierasavaimia: paikka -> lisänimi, meno,
  // havainto; suunnitelma -> kirjaus. Meno ja liikuntakerta viittaavat
  // tämän sarjan tavoitteeseen (aalto B:n taulu).
  const place = has('savedPlaces') ? `${P}-place` : null;
  add('savedPlaces', 'saved_places', {
    id: place, name: `Kuntosali ${P}`, address: 'Keskuskatu 1', area: 'Keskusta', travelMode: 'walking',
    usualTravelMinutes: 15, preparationMinutes: 10, arrivalBufferMinutes: 5, overheadMinutes: 5
  }, { useLearned: true, usualTravelMinutes: 17 });
  add('placeAliases', 'place_aliases',
    { id: `${P}-alias`, placeId: place, alias: `Sali ${P}`, confirmations: 1, lastConfirmedAt: `${day}T08:00:00.000Z` },
    { confirmations: 2 });
  add('calendarEvents', 'calendar_events', {
    id: `${P}-event`, title: `Salivuoro ${P}`, date: day, startTime: '17:00', endTime: '18:00', durationMinutes: 60,
    category: 'hyvinvointi', locationText: 'Keskuskatu 1', placeId: place, travelMinutes: 20,
    recurrenceWeekdays: [2, 4], recurrenceUntil: isoDay(day, 90), skipDates: [isoDay(day, 7)], goalId: ids.goal
  }, { skipDates: [isoDay(day, 7), isoDay(day, 14)] });
  // Koko päivän meno: ei alkuaikaa (calendar_events_all_day_check).
  add('calendarEvents', 'calendar_events',
    { id: `${P}-event-allday`, title: `Mökkiviikonloppu ${P}`, date: isoDay(day, 3), allDay: true }, null,
    { remove: true });
  add('commuteObservations', 'commute_observations', {
    id: `${P}-commute`, placeId: place, eventId: `event:${P}-event:${day}`, observedOn: day,
    plannedDeparture: '16:30', actualDeparture: '16:34', arrivalAt: '16:52', travelMinutes: 18,
    arrivalResult: 'on_time', source: 'departure_ack'
  }, { arrivalResult: 'late' });
  add('lifeSettings', 'life_settings', {
    id: `${P}-life`, bedtimeTarget: '22:30', windDownMinutes: 45, speechEnabled: true, hourlyValueMinor: 2500,
    alarm: { enabled: true, weekdayTime: '06:30', weekendTime: '08:00' },
    morningRoutine: [{ id: 'r1', name: 'Aamupala', minutes: 15, protection: 'protected' },
                     { id: 'r2', name: 'Suihku', minutes: 10, protection: 'optional' }],
    mealRhythm: { meals: [{ id: 'm1', name: 'Lounas', time: '11:30', prepMinutes: 15 }] },
    delivery: { departure: 'critical_escalation', habit: 'silent' }
  }, { reminderOffsetMinutes: 5, digestEnabled: true });
  add('sleepLogs', 'sleep_logs', {
    id: `${P}-sleep`, wakeDate: day, plannedBedtime: '22:30', actualBedtime: '23:10', plannedWake: '06:30', actualWake: '06:45'
  }, { note: 'heräsin kerran' });
  add('habitPlans', 'habit_plans', {
    id: `${P}-habit`, kind: 'nicotine', name: `Nuuska ${P}`, minIntervalMinutes: 90, dailyTarget: 8, baselinePerDay: 10,
    steps: [{ from: day, intervalMinutes: 90, dailyTarget: 8 }, { from: isoDay(day, 14), intervalMinutes: 120, dailyTarget: 6 }],
    unitCostMinor: 60
  }, { dailyTarget: 7 });
  add('habitEvents', 'habit_events',
    { id: `${P}-hevent`, planId: `${P}-habit`, occurredAt: `${day}T08:00:00.000Z`, action: 'delay' }, { action: 'use' });
  add('exerciseSessions', 'exercise_sessions', {
    id: `${P}-ex`, date: day, kind: 'juoksu', plannedMinutes: 30, intensity: 3, recoveryDemand: 2, goalId: ids.goal
  }, { actualMinutes: 35 });
  add('wellbeingCheckins', 'wellbeing_checkins', { id: `${P}-wbc`, date: day, motivation: 4, control: 3 }, { control: 4 });

  if (upsertOwnRows) {
    // Sovellus tallentaa profiilin ja muistutusasetukset AINA upsertilla
    // (profileRepo.saveProfile, notificationPrefsRepo.savePreferences).
    ops.push({ table: 'profile', method: 'upsert', onConflict: 'id', label: `${waveName}:profile:upsert`,
      payload: wirePayload(mods.profile.profileToRow({
        age: 41, weightKg: 80.5, heightCm: 180, sleepTargetHours: 7.5, defaultWakeTime: '06:30',
        commuteMinutes: 20, routineMinutes: 45 }, OWNER)) });
    if (has('notificationPreferences')) {
      ops.push({ table: 'notification_preferences', method: 'upsert', onConflict: 'id',
        label: `${waveName}:notification_preferences:upsert`,
        payload: wirePayload(mods.prefs.preferencesToRow({ enabled: true, maxPerDay: 5 }, OWNER)) });
    }
  }
  for (const op of ops) if (idOwned.has(op.table) && op.match) op.match = { id: OWNER };
  return ops;
}

/** Sarakeavaimet, jotka aalto lähettää kuhunkin tauluun (yksikkötestit). */
export async function shapeKeys(waveName, train = trainWaves()) {
  const ops = await waveWrites(waveName, { prefix: 'k', train });
  const out = {};
  for (const op of ops) {
    if (op.method !== 'insert' && op.method !== 'upsert') continue;
    out[op.table] = [...new Set([...(out[op.table] || []), ...Object.keys(op.payload)])].sort();
  }
  return out;
}
