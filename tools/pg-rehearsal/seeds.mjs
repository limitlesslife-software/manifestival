// Synteettinen sovellusdata kahdelle käyttäjälle.
//
// Rivit kirjoitetaan roolina `authenticated` ja käyttäjän omalla JWT:llä
// — täsmälleen kuten sovellus kirjoittaa PostgRESTin kautta. user_id:tä
// EI lähetetä: kannan oletus auth.uid() asettaa sen (SERVER_OWNED_FIELDS).
// Näin siemennys itsessään todistaa, että sovelluksen kirjoituspolku
// toimii kunkin migraation jälkeen.
//
// `since` = migraatio, jonka jälkeen taulu on olemassa. Taulu
// siemennetään heti sen migraation jälkeen, jotta myöhemmät migraatiot
// ajetaan olemassa olevaa dataa vasten ("legacy rows without new fields").

export const WEEK = '2026-09-21'; // maanantai (isodow 1)

/** p = rivitunnisteiden etuliite ('a' / 'b'). */
export const SEEDS = Object.freeze([
  { table: 'profile', since: '0001', owner: 'id', ownerOnlyB: true,
    sql: () => `insert into public.profile (age) values (33)` },
  { table: 'tasks', since: '0003',
    sql: p => `insert into public.tasks (id, date, time, title, category, completed, is_wake, description, duration_minutes, priority)
               values ('${p}-task', '2026-09-22', '09:00', 'Synteettinen', 'tyo', false, false, 'kuvaus', 45, 'korkea')` },
  { table: 'routines', since: '0003',
    sql: p => `insert into public.routines (id, title, duration_minutes, recurrence_type) values ('${p}-rout', 'Kävely', 30, 'daily')` },
  { table: 'routine_exceptions', since: '0003',
    sql: p => `insert into public.routine_exceptions (id, routine_id, date, type) values ('${p}-rex', '${p}-rout', '2026-09-23', 'skip')` },
  { table: 'goals', since: '0004',
    sql: p => `insert into public.goals (id, title, status) values ('${p}-goal', 'Tavoite', 'active'),
                                                              ('${p}-goal-old', 'Vanha', 'paused')` },
  { table: 'projects', since: '0004',
    sql: p => `insert into public.projects (id, name, goal_id, status) values ('${p}-proj', 'Projekti', '${p}-goal', 'active')` },
  { table: 'notification_preferences', since: '0005', owner: 'id',
    sql: () => `insert into public.notification_preferences (enabled) values (true)` },
  { table: 'wellbeing_entries', since: '0006',
    sql: p => `insert into public.wellbeing_entries (id, date, energy, mood) values ('${p}-wb', '2026-09-22', 3, 4)` },
  { table: 'recurring_expenses', since: '0007',
    sql: p => `insert into public.recurring_expenses (id, name, amount_minor, next_due_date) values ('${p}-rec', 'Vuokra', 85000, '2026-10-01')` },
  { table: 'savings_goals', since: '0007',
    sql: p => `insert into public.savings_goals (id, name, target_minor) values ('${p}-sav', 'Puskuri', 300000)` },
  { table: 'bills', since: '0007',
    sql: p => `insert into public.bills (id, name, amount_minor, due_date, recurring_expense_id, task_id) values ('${p}-bill', 'Sähkö', 1234, '2026-10-05', '${p}-rec', '${p}-task')` },
  { table: 'ai_action_audit', since: '0008',
    sql: p => `insert into public.ai_action_audit (id, intent, risk) values ('${p}-audit', 'create_task', 'low')` },
  { table: 'transactions', since: '0009',
    sql: p => `insert into public.transactions (id, kind, amount_minor, date) values ('${p}-tx', 'expense', 990, '2026-09-22')` },
  { table: 'investments', since: '0009',
    sql: p => `insert into public.investments (id, name, kind) values ('${p}-inv', 'Indeksirahasto', 'fund')` },
  { table: 'milestones', since: '0010',
    sql: p => `insert into public.milestones (id, goal_id, title) values ('${p}-ms', '${p}-goal', 'Välietappi')` },
  { table: 'inbox_items', since: '0011',
    sql: p => `insert into public.inbox_items (id, text) values ('${p}-inbox', 'Muista soittaa')` },
  { table: 'reminders', since: '0011',
    sql: p => `insert into public.reminders (id, title) values ('${p}-rem', 'Muistutus')` },
  { table: 'notices', since: '0011',
    sql: p => `insert into public.notices (id, notice_key, kind, title) values ('${p}-notice', 'k-${p}', 'reminder', 'Ilmoitus')` },
  { table: 'travel_plans', since: '0011',
    sql: p => `insert into public.travel_plans (id, title, task_id) values ('${p}-travel', 'Matka', '${p}-task')` },
  { table: 'location_rules', since: '0011',
    sql: p => `insert into public.location_rules (id, place, task_id) values ('${p}-loc', 'Koti', '${p}-task')` },
  { table: 'life_areas', since: '0012',
    sql: p => `insert into public.life_areas (id, name, importance, target_minutes_per_week) values ('${p}-la', 'Terveys', 5, 300)` },
  { table: 'weekly_capacities', since: '0012',
    sql: p => `insert into public.weekly_capacities (id, week_start, available_minutes, energy_level) values ('${p}-cap', '${WEEK}', 1200, 3)` },
  { table: 'time_entries', since: '0012',
    sql: p => `insert into public.time_entries (id, entry_date, minutes, life_area_id, goal_id, task_id) values ('${p}-te', '2026-09-22', 30, '${p}-la', '${p}-goal', '${p}-task')` },
  { table: 'alignment_reviews', since: '0012',
    sql: p => `insert into public.alignment_reviews (id, week_start, snapshot) values ('${p}-rev', '${WEEK}', '{"v":1}')` },
  { table: 'running_timers', since: '0013',
    sql: p => `insert into public.running_timers (id, target_kind, task_id, started_at) values ('${p}-timer', 'task', '${p}-task', now() - interval '20 minutes')` },
  { table: 'alignment_item_settings', since: '0013',
    sql: p => `insert into public.alignment_item_settings (id, item_kind, item_id, energy_demand) values ('${p}-ais', 'task', '${p}-task', 4)` },
  { table: 'time_entries', since: '0013', extra: true,
    sql: p => `insert into public.time_entries (id, entry_date, minutes, life_area_id, project_id, routine_id, occurrence_date, operation_id, source, started_at, ended_at)
               values ('${p}-te2', '2026-09-23', 25, '${p}-la', '${p}-proj', '${p}-rout', '2026-09-23', 'op:${p}:1', 'timer', '2026-09-23T07:00:00Z', '2026-09-23T07:25:00Z')` },
  // 0014 (aalto K): kymmenen uutta taulua. Järjestys noudattaa
  // yhdistelmävierasavaimia: paikka ennen lisänimeä, menoa ja havaintoa;
  // suunnitelma ennen kirjausta. Meno ja liikuntakerta viittaavat 0004:n
  // tavoitteeseen, joten rls-skenaarion ristiviittauskoe kattaa myös
  // viitteen vanhaan tauluun. Havainnon event_id EI ole vierasavain.
  { table: 'saved_places', since: '0014',
    sql: p => `insert into public.saved_places (id, name, address, area, travel_mode, usual_travel_minutes, preparation_minutes, overhead_minutes)
               values ('${p}-place', 'Kuntosali', 'Keskuskatu 1', 'Keskusta', 'walking', 15, 10, 5)` },
  { table: 'place_aliases', since: '0014',
    sql: p => `insert into public.place_aliases (id, place_id, alias, confirmations, last_confirmed_at)
               values ('${p}-alias', '${p}-place', 'sali', 2, '2026-09-22T08:00:00Z')` },
  { table: 'calendar_events', since: '0014',
    sql: p => `insert into public.calendar_events (id, title, event_date, start_time, end_time, all_day, place_id, goal_id, recurrence_weekdays, recurrence_until, skip_dates)
               values ('${p}-event', 'Salivuoro', '2026-09-24', '17:00', '18:00', false, '${p}-place', '${p}-goal', '{4}', '2026-12-31', '{2026-10-01}')` },
  { table: 'commute_observations', since: '0014',
    sql: p => `insert into public.commute_observations (id, place_id, event_id, observed_on, weekday, planned_departure, actual_departure, arrival_at, travel_minutes, arrival_result)
               values ('${p}-commute', '${p}-place', 'event:${p}-event:2026-09-24', '2026-09-24', 4, '16:30', '16:33', '16:50', 17, 'on_time')` },
  { table: 'life_settings', since: '0014',
    sql: p => `insert into public.life_settings (id, bedtime_target, alarm, morning_routine, meal_rhythm, delivery)
               values ('${p}-life', '22:30', '{"enabled": false}', '[{"id": "r1", "name": "Aamupala", "minutes": 15}]', '{}', '{"wake": "critical_escalation"}')` },
  { table: 'sleep_logs', since: '0014',
    sql: p => `insert into public.sleep_logs (id, wake_date, planned_bedtime, actual_bedtime, planned_wake, actual_wake)
               values ('${p}-sleep', '2026-09-24', '22:30', '23:05', '06:30', '06:40')` },
  { table: 'habit_plans', since: '0014',
    sql: p => `insert into public.habit_plans (id, kind, name, min_interval_minutes, daily_target, baseline_per_day, steps)
               values ('${p}-habit', 'nicotine', 'Nuuska', 90, 8, 10, '[{"from": "2026-09-21", "intervalMinutes": 90, "dailyTarget": 8}]')` },
  { table: 'habit_events', since: '0014',
    sql: p => `insert into public.habit_events (id, plan_id, occurred_at, action)
               values ('${p}-hevent', '${p}-habit', '2026-09-24T08:00:00Z', 'use')` },
  { table: 'exercise_sessions', since: '0014',
    sql: p => `insert into public.exercise_sessions (id, session_date, kind, planned_minutes, intensity, goal_id)
               values ('${p}-ex', '2026-09-24', 'juoksu', 30, 3, '${p}-goal')` },
  { table: 'wellbeing_checkins', since: '0014',
    sql: p => `insert into public.wellbeing_checkins (id, date, motivation, control) values ('${p}-wbc', '2026-09-24', 4, 3)` }
]);

/** Taulut, joissa omistajasarake on `id` eikä `user_id`. */
export const ID_OWNED = Object.freeze(new Set(['profile', 'notification_preferences']));
