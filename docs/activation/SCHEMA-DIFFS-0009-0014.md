# Skeemaerot 0009–0014 (kultaiset tiedostot)

GENEROITU: `node tools/pg-rehearsal/schema-diff-summary.mjs`. ÄLÄ MUOKKAA KÄSIN —
testi vertaa tätä kultaisiin tiedostoihin.

Lähde: `tools/pg-rehearsal/expected/schema-diff-00NN.txt`, jotka harjoittelu
tuottaa ajamalla migraation tuotannon muotoiseen kantaan (tila 0008 =
omistajan inventaario 2026-09-26) ja vertaamalla `public`-skeeman katalogia
ennen ja jälkeen (`lib.catalogItems`: taulut, sarakkeet, indeksit,
rajoitteet, politiikat, liipaisimet, funktiot, omistajat ja oikeudet).
`prodshape:chain` vertaa jokaista ajoa näihin: mikä tahansa poikkeama on
hylkäys. Poistoja sallitaan vain `ALLOWED_REMOVALS`-listan korvaukset.

| Migraatio | Uudet taulut | Uudet sarakkeet vanhoissa tauluissa | Rajoitteet | Indeksit | Politiikat | Liipaisimet | Poistettu |
|---|---|---|---|---|---|---|---|
| 0009 | 2 | 3 | 25 | 7 | 8 | 2 | 0 |
| 0010 | 1 | 12 | 21 | 4 | 4 | 1 | 1 |
| 0011 | 5 | 0 | 43 | 20 | 20 | 5 | 0 |
| 0012 | 4 | 1 | 38 | 15 | 16 | 4 | 0 |
| 0013 | 2 | 9 | 28 | 8 | 8 | 2 | 1 |
| 0014 | 10 | 0 | 108 | 29 | 40 | 10 | 0 |

Yhteistä kaikille uusille tauluille (todennettu riveistä): RLS päällä, neljä
`authenticated`-roolin politiikkaa (`auth.uid() = user_id`), `authenticated`
saa täsmälleen `arwd` (select/insert/update/delete), ei anon- eikä
PUBLIC-oikeutta. `service_role` säilyttää Supabasen oletusoikeudet
(`arwdDxtm`, ohittaa RLS:n kuten Supabasessa aina). Omistaja on migraation
ajava rooli (harjoittelussa `postgres`).

## 0009 — Talous 2.0 (aalto F)

**Uudet taulut (2):** `investments` (15 saraketta, RLS päällä), `transactions` (14 saraketta, RLS päällä)

**Uudet sarakkeet olemassa oleviin tauluihin (3):**

- `bills.iban` text (nullable)
- `bills.payee` text (nullable)
- `bills.reference` text (nullable)

**Rajoitteet (25):**

- `bills`: bills_iban_check (CHECK), bills_payee_length_check (CHECK), bills_reference_check (CHECK)
- `investments`: investments_amounts_check (CHECK), investments_currency_check (CHECK), investments_kind_check (CHECK), investments_name_check (CHECK), investments_owner_row_key (UNIQUE), investments_pkey (PRIMARY KEY), investments_quantity_check (CHECK), investments_unknown_value_check (CHECK), investments_user_id_fkey (FOREIGN KEY), investments_value_source_check (CHECK)
- `transactions`: transactions_amount_check (CHECK), transactions_currency_check (CHECK), transactions_description_length_check (CHECK), transactions_kind_check (CHECK), transactions_note_length_check (CHECK), transactions_origin_check (CHECK), transactions_owner_row_key (UNIQUE), transactions_pkey (PRIMARY KEY), transactions_source_kind_check (CHECK), transactions_source_pair_check (CHECK), transactions_transfer_category_check (CHECK), transactions_user_id_fkey (FOREIGN KEY)

**Vierasavaimet (2):**

- `investments.investments_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `transactions.transactions_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`

**Indeksit (7):** `investments_owner_row_key`, `investments_pkey`, `investments_user_name_idx`, `transactions_owner_row_key`, `transactions_pkey`, `transactions_user_date_idx`, `transactions_user_source_idx`

**Politiikat (8):** `investments` 4, `transactions` 4

**Liipaisimet (2):** `investments_touch_updated_at`, `transactions_touch_updated_at`

## 0010 — Tavoitteesta tekemiseksi (aalto G)

**Uudet taulut (1):** `milestones` (12 saraketta, RLS päällä)

**Uudet sarakkeet olemassa oleviin tauluihin (12):**

- `goals.baseline_value` numeric(20,4) (nullable)
- `goals.current_value` numeric(20,4) (nullable)
- `goals.measured_on` date (nullable)
- `goals.metric` text (nullable)
- `goals.savings_goal_id` text (nullable)
- `goals.target_value` numeric(20,4) (nullable)
- `goals.unit` text (nullable)
- `profile.automation_level` smallint NOT NULL, oletus `1`
- `profile.planning_buffer_ratio` numeric(3,2) NOT NULL, oletus `0.25`
- `projects.milestone_id` text (nullable)
- `tasks.depends_on` text[] NOT NULL, oletus `'{}'`
- `tasks.milestone_id` text (nullable)

**Korvattu / poistettu (1):**

- `goals.goals_status_check`: `CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'completed'::text, 'abandoned'::text, 'archived'::text])))`
  → korvaaja samalla nimellä: `CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'maintenance'::text, 'completed'::text, 'abandoned'::text, 'archived'::text])))`

**Rajoitteet (21):**

- `goals`: goals_metric_length_check (CHECK), goals_metric_pair_check (CHECK), goals_savings_exclusive_check (CHECK), goals_status_check (CHECK), goals_unit_length_check (CHECK)
- `milestones`: milestones_description_length_check (CHECK), milestones_goal_fkey (FOREIGN KEY), milestones_order_check (CHECK), milestones_owner_row_key (UNIQUE), milestones_pkey (PRIMARY KEY), milestones_reached_date_check (CHECK), milestones_rule_check (CHECK), milestones_status_check (CHECK), milestones_title_check (CHECK), milestones_user_id_fkey (FOREIGN KEY)
- `profile`: profile_automation_level_check (CHECK), profile_buffer_ratio_check (CHECK)
- `projects`: projects_milestone_fkey (FOREIGN KEY)
- `tasks`: tasks_depends_on_length_check (CHECK), tasks_depends_on_no_self_check (CHECK), tasks_milestone_fkey (FOREIGN KEY)

**Vierasavaimet (4):**

- `milestones.milestones_goal_fkey`: `FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE CASCADE`
- `milestones.milestones_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `projects.projects_milestone_fkey`: `FOREIGN KEY (user_id, milestone_id) REFERENCES milestones(user_id, id) ON DELETE SET NULL (milestone_id)`
- `tasks.tasks_milestone_fkey`: `FOREIGN KEY (user_id, milestone_id) REFERENCES milestones(user_id, id) ON DELETE SET NULL (milestone_id)`

**Indeksit (4):** `milestones_owner_row_key`, `milestones_pkey`, `milestones_user_goal_idx`, `milestones_user_target_idx`

**Politiikat (4):** `milestones` 4

**Liipaisimet (1):** `milestones_touch_updated_at`

## 0011 — Henkilökohtainen avustaja (aalto H)

**Uudet taulut (5):** `inbox_items` (11 saraketta, RLS päällä), `location_rules` (9 saraketta, RLS päällä), `notices` (13 saraketta, RLS päällä), `reminders` (17 saraketta, RLS päällä), `travel_plans` (17 saraketta, RLS päällä)

**Rajoitteet (43):**

- `inbox_items`: inbox_items_converted_check (CHECK), inbox_items_owner_row_key (UNIQUE), inbox_items_pkey (PRIMARY KEY), inbox_items_source_check (CHECK), inbox_items_status_check (CHECK), inbox_items_text_check (CHECK), inbox_items_user_id_fkey (FOREIGN KEY)
- `location_rules`: location_rules_owner_row_key (UNIQUE), location_rules_pkey (PRIMARY KEY), location_rules_place_check (CHECK), location_rules_task_fkey (FOREIGN KEY), location_rules_trigger_check (CHECK), location_rules_user_id_fkey (FOREIGN KEY)
- `notices`: notices_key_unique (UNIQUE), notices_kind_check (CHECK), notices_level_check (CHECK), notices_owner_row_key (UNIQUE), notices_pkey (PRIMARY KEY), notices_status_check (CHECK), notices_target_pair_check (CHECK), notices_title_check (CHECK), notices_user_id_fkey (FOREIGN KEY)
- `reminders`: reminders_alert_count_check (CHECK), reminders_lead_check (CHECK), reminders_owner_row_key (UNIQUE), reminders_pkey (PRIMARY KEY), reminders_snooze_count_check (CHECK), reminders_status_check (CHECK), reminders_target_check (CHECK), reminders_target_pair_check (CHECK), reminders_title_check (CHECK), reminders_trigger_check (CHECK), reminders_user_id_fkey (FOREIGN KEY)
- `travel_plans`: travel_plans_buffer_check (CHECK), travel_plans_minutes_check (CHECK), travel_plans_mode_check (CHECK), travel_plans_owner_row_key (UNIQUE), travel_plans_pkey (PRIMARY KEY), travel_plans_source_check (CHECK), travel_plans_task_fkey (FOREIGN KEY), travel_plans_title_check (CHECK), travel_plans_unknown_source_check (CHECK), travel_plans_user_id_fkey (FOREIGN KEY)

**Vierasavaimet (7):**

- `inbox_items.inbox_items_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `location_rules.location_rules_task_fkey`: `FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE SET NULL (task_id)`
- `location_rules.location_rules_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `notices.notices_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `reminders.reminders_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `travel_plans.travel_plans_task_fkey`: `FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE SET NULL (task_id)`
- `travel_plans.travel_plans_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`

**Indeksit (20):** `inbox_items_owner_row_key`, `inbox_items_pkey`, `inbox_items_user_captured_idx`, `inbox_items_user_status_idx`, `location_rules_owner_row_key`, `location_rules_pkey`, `location_rules_user_active_idx`, `notices_key_unique`, `notices_owner_row_key`, `notices_pkey`, `notices_user_created_idx`, `notices_user_status_idx`, `reminders_owner_row_key`, `reminders_pkey`, `reminders_user_due_idx`, `reminders_user_status_idx`, `reminders_user_target_idx`, `travel_plans_owner_row_key`, `travel_plans_pkey`, `travel_plans_user_arrival_idx`

**Politiikat (20):** `inbox_items` 4, `location_rules` 4, `notices` 4, `reminders` 4, `travel_plans` 4

**Liipaisimet (5):** `inbox_items_touch_updated_at`, `location_rules_touch_updated_at`, `notices_touch_updated_at`, `reminders_touch_updated_at`, `travel_plans_touch_updated_at`

## 0012 — Suunta (aalto I)

**Uudet taulut (4):** `alignment_reviews` (10 saraketta, RLS päällä), `life_areas` (11 saraketta, RLS päällä), `time_entries` (11 saraketta, RLS päällä), `weekly_capacities` (8 saraketta, RLS päällä)

**Uudet sarakkeet olemassa oleviin tauluihin (1):**

- `goals.life_area_id` text (nullable)

**Rajoitteet (38):**

- `alignment_reviews`: alignment_reviews_adjustments_check (CHECK), alignment_reviews_owner_row_key (UNIQUE), alignment_reviews_pkey (PRIMARY KEY), alignment_reviews_reflection_check (CHECK), alignment_reviews_snapshot_check (CHECK), alignment_reviews_user_id_fkey (FOREIGN KEY), alignment_reviews_version_check (CHECK), alignment_reviews_week_start_check (CHECK), alignment_reviews_week_unique (UNIQUE)
- `goals`: goals_life_area_fkey (FOREIGN KEY)
- `life_areas`: life_areas_category_check (CHECK), life_areas_category_unique (UNIQUE), life_areas_description_check (CHECK), life_areas_importance_check (CHECK), life_areas_name_check (CHECK), life_areas_name_unique (UNIQUE), life_areas_owner_row_key (UNIQUE), life_areas_pkey (PRIMARY KEY), life_areas_sort_order_check (CHECK), life_areas_target_check (CHECK), life_areas_user_id_fkey (FOREIGN KEY)
- `time_entries`: time_entries_goal_fkey (FOREIGN KEY), time_entries_life_area_fkey (FOREIGN KEY), time_entries_minutes_check (CHECK), time_entries_note_check (CHECK), time_entries_owner_row_key (UNIQUE), time_entries_pkey (PRIMARY KEY), time_entries_source_check (CHECK), time_entries_task_fkey (FOREIGN KEY), time_entries_user_id_fkey (FOREIGN KEY)
- `weekly_capacities`: weekly_capacities_energy_check (CHECK), weekly_capacities_minutes_check (CHECK), weekly_capacities_note_check (CHECK), weekly_capacities_owner_row_key (UNIQUE), weekly_capacities_pkey (PRIMARY KEY), weekly_capacities_user_id_fkey (FOREIGN KEY), weekly_capacities_week_start_check (CHECK), weekly_capacities_week_unique (UNIQUE)

**Vierasavaimet (8):**

- `alignment_reviews.alignment_reviews_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `goals.goals_life_area_fkey`: `FOREIGN KEY (user_id, life_area_id) REFERENCES life_areas(user_id, id) ON DELETE SET NULL (life_area_id)`
- `life_areas.life_areas_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `time_entries.time_entries_goal_fkey`: `FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE SET NULL (goal_id)`
- `time_entries.time_entries_life_area_fkey`: `FOREIGN KEY (user_id, life_area_id) REFERENCES life_areas(user_id, id) ON DELETE SET NULL (life_area_id)`
- `time_entries.time_entries_task_fkey`: `FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE SET NULL (task_id)`
- `time_entries.time_entries_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `weekly_capacities.weekly_capacities_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`

**Indeksit (15):** `alignment_reviews_owner_row_key`, `alignment_reviews_pkey`, `alignment_reviews_week_unique`, `goals_user_life_area_idx`, `life_areas_category_unique`, `life_areas_name_unique`, `life_areas_owner_row_key`, `life_areas_pkey`, `life_areas_user_active_idx`, `time_entries_owner_row_key`, `time_entries_pkey`, `time_entries_user_date_idx`, `weekly_capacities_owner_row_key`, `weekly_capacities_pkey`, `weekly_capacities_week_unique`

**Politiikat (16):** `alignment_reviews` 4, `life_areas` 4, `time_entries` 4, `weekly_capacities` 4

**Liipaisimet (4):** `alignment_reviews_touch_updated_at`, `life_areas_touch_updated_at`, `time_entries_touch_updated_at`, `weekly_capacities_touch_updated_at`

## 0013 — Suunta 2 (aalto J)

**Uudet taulut (2):** `alignment_item_settings` (9 saraketta, RLS päällä), `running_timers` (15 saraketta, RLS päällä)

**Uudet sarakkeet olemassa oleviin tauluihin (9):**

- `alignment_reviews.policy_version` smallint NOT NULL, oletus `1`
- `alignment_reviews.reflection_answers` jsonb NOT NULL, oletus `'{}'`
- `time_entries.ended_at` timestamp with time zone (nullable)
- `time_entries.occurrence_date` date (nullable)
- `time_entries.operation_id` text (nullable)
- `time_entries.project_id` text (nullable)
- `time_entries.routine_id` text (nullable)
- `time_entries.started_at` timestamp with time zone (nullable)
- `weekly_capacities.energy_budget_minutes` integer (nullable)

**Korvattu / poistettu (1):**

- `time_entries.time_entries_source_check`: `CHECK ((source = 'manual'::text))`

**Rajoitteet (28):**

- `alignment_item_settings`: alignment_item_settings_energy_check (CHECK), alignment_item_settings_item_id_check (CHECK), alignment_item_settings_item_unique (UNIQUE), alignment_item_settings_kind_check (CHECK), alignment_item_settings_owner_row_key (UNIQUE), alignment_item_settings_pkey (PRIMARY KEY), alignment_item_settings_user_id_fkey (FOREIGN KEY)
- `alignment_reviews`: alignment_reviews_policy_version_check (CHECK), alignment_reviews_reflection_answers_check (CHECK)
- `running_timers`: running_timers_goal_fkey (FOREIGN KEY), running_timers_life_area_fkey (FOREIGN KEY), running_timers_note_check (CHECK), running_timers_one_per_user (UNIQUE), running_timers_owner_row_key (UNIQUE), running_timers_paused_check (CHECK), running_timers_pkey (PRIMARY KEY), running_timers_project_fkey (FOREIGN KEY), running_timers_routine_fkey (FOREIGN KEY), running_timers_target_kind_check (CHECK), running_timers_task_fkey (FOREIGN KEY), running_timers_user_id_fkey (FOREIGN KEY)
- `time_entries`: time_entries_operation_check (CHECK), time_entries_operation_unique (UNIQUE), time_entries_project_fkey (FOREIGN KEY), time_entries_routine_fkey (FOREIGN KEY), time_entries_source_v2_check (CHECK), time_entries_span_check (CHECK)
- `weekly_capacities`: weekly_capacities_energy_budget_check (CHECK)

**Vierasavaimet (9):**

- `alignment_item_settings.alignment_item_settings_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `running_timers.running_timers_goal_fkey`: `FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE SET NULL (goal_id)`
- `running_timers.running_timers_life_area_fkey`: `FOREIGN KEY (user_id, life_area_id) REFERENCES life_areas(user_id, id) ON DELETE SET NULL (life_area_id)`
- `running_timers.running_timers_project_fkey`: `FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE SET NULL (project_id)`
- `running_timers.running_timers_routine_fkey`: `FOREIGN KEY (user_id, routine_id) REFERENCES routines(user_id, id) ON DELETE SET NULL (routine_id)`
- `running_timers.running_timers_task_fkey`: `FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE SET NULL (task_id)`
- `running_timers.running_timers_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `time_entries.time_entries_project_fkey`: `FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE SET NULL (project_id)`
- `time_entries.time_entries_routine_fkey`: `FOREIGN KEY (user_id, routine_id) REFERENCES routines(user_id, id) ON DELETE SET NULL (routine_id)`

**Indeksit (8):** `alignment_item_settings_item_unique`, `alignment_item_settings_owner_row_key`, `alignment_item_settings_pkey`, `running_timers_one_per_user`, `running_timers_owner_row_key`, `running_timers_pkey`, `time_entries_operation_unique`, `time_entries_user_routine_idx`

**Politiikat (8):** `alignment_item_settings` 4, `running_timers` 4

**Liipaisimet (2):** `alignment_item_settings_touch_updated_at`, `running_timers_touch_updated_at`

## 0014 — Arjen käyttöjärjestelmä (aalto K)

**Uudet taulut (10):** `calendar_events` (23 saraketta, RLS päällä), `commute_observations` (17 saraketta, RLS päällä), `exercise_sessions` (12 saraketta, RLS päällä), `habit_events` (8 saraketta, RLS päällä), `habit_plans` (13 saraketta, RLS päällä), `life_settings` (22 saraketta, RLS päällä), `place_aliases` (8 saraketta, RLS päällä), `saved_places` (15 saraketta, RLS päällä), `sleep_logs` (12 saraketta, RLS päällä), `wellbeing_checkins` (7 saraketta, RLS päällä)

**Rajoitteet (108):**

- `calendar_events`: calendar_events_all_day_check (CHECK), calendar_events_arrival_buffer_check (CHECK), calendar_events_category_check (CHECK), calendar_events_duration_check (CHECK), calendar_events_end_time_check (CHECK), calendar_events_goal_fkey (FOREIGN KEY), calendar_events_location_check (CHECK), calendar_events_notes_check (CHECK), calendar_events_overhead_check (CHECK), calendar_events_owner_row_key (UNIQUE), calendar_events_pkey (PRIMARY KEY), calendar_events_place_fkey (FOREIGN KEY), calendar_events_preparation_check (CHECK), calendar_events_skip_dates_check (CHECK), calendar_events_title_check (CHECK), calendar_events_travel_check (CHECK), calendar_events_travel_mode_check (CHECK), calendar_events_until_check (CHECK), calendar_events_user_id_fkey (FOREIGN KEY), calendar_events_weekdays_check (CHECK)
- `commute_observations`: commute_observations_event_id_check (CHECK), commute_observations_overhead_check (CHECK), commute_observations_owner_row_key (UNIQUE), commute_observations_pkey (PRIMARY KEY), commute_observations_place_fkey (FOREIGN KEY), commute_observations_preparation_check (CHECK), commute_observations_provider_check (CHECK), commute_observations_result_check (CHECK), commute_observations_source_check (CHECK), commute_observations_travel_check (CHECK), commute_observations_user_id_fkey (FOREIGN KEY), commute_observations_weekday_check (CHECK)
- `exercise_sessions`: exercise_sessions_actual_check (CHECK), exercise_sessions_goal_fkey (FOREIGN KEY), exercise_sessions_intensity_check (CHECK), exercise_sessions_kind_check (CHECK), exercise_sessions_note_check (CHECK), exercise_sessions_owner_row_key (UNIQUE), exercise_sessions_pkey (PRIMARY KEY), exercise_sessions_planned_check (CHECK), exercise_sessions_recovery_check (CHECK), exercise_sessions_user_id_fkey (FOREIGN KEY)
- `habit_events`: habit_events_action_check (CHECK), habit_events_note_check (CHECK), habit_events_owner_row_key (UNIQUE), habit_events_pkey (PRIMARY KEY), habit_events_plan_fkey (FOREIGN KEY), habit_events_user_id_fkey (FOREIGN KEY)
- `habit_plans`: habit_plans_baseline_check (CHECK), habit_plans_daily_target_check (CHECK), habit_plans_delivery_check (CHECK), habit_plans_kind_check (CHECK), habit_plans_min_interval_check (CHECK), habit_plans_name_check (CHECK), habit_plans_owner_row_key (UNIQUE), habit_plans_pkey (PRIMARY KEY), habit_plans_steps_check (CHECK), habit_plans_unit_cost_check (CHECK), habit_plans_user_id_fkey (FOREIGN KEY)
- `life_settings`: life_settings_alarm_check (CHECK), life_settings_arrival_buffer_check (CHECK), life_settings_currency_check (CHECK), life_settings_delivery_check (CHECK), life_settings_guidance_check (CHECK), life_settings_hourly_value_check (CHECK), life_settings_meal_rhythm_check (CHECK), life_settings_morning_routine_check (CHECK), life_settings_one_per_user (UNIQUE), life_settings_owner_row_key (UNIQUE), life_settings_pkey (PRIMARY KEY), life_settings_reminder_offset_check (CHECK), life_settings_user_id_fkey (FOREIGN KEY), life_settings_weekend_bed_check (CHECK), life_settings_weekend_wake_check (CHECK), life_settings_wind_down_check (CHECK)
- `place_aliases`: place_aliases_alias_check (CHECK), place_aliases_alias_unique (UNIQUE), place_aliases_confirmations_check (CHECK), place_aliases_owner_row_key (UNIQUE), place_aliases_pkey (PRIMARY KEY), place_aliases_place_fkey (FOREIGN KEY), place_aliases_user_id_fkey (FOREIGN KEY)
- `saved_places`: saved_places_address_check (CHECK), saved_places_area_check (CHECK), saved_places_arrival_buffer_check (CHECK), saved_places_name_check (CHECK), saved_places_note_check (CHECK), saved_places_overhead_check (CHECK), saved_places_owner_row_key (UNIQUE), saved_places_pkey (PRIMARY KEY), saved_places_preparation_check (CHECK), saved_places_provider_place_check (CHECK), saved_places_travel_mode_check (CHECK), saved_places_user_id_fkey (FOREIGN KEY), saved_places_usual_travel_check (CHECK)
- `sleep_logs`: sleep_logs_kind_check (CHECK), sleep_logs_note_check (CHECK), sleep_logs_owner_row_key (UNIQUE), sleep_logs_pkey (PRIMARY KEY), sleep_logs_source_check (CHECK), sleep_logs_user_id_fkey (FOREIGN KEY), sleep_logs_wake_date_unique (UNIQUE)
- `wellbeing_checkins`: wellbeing_checkins_control_check (CHECK), wellbeing_checkins_date_unique (UNIQUE), wellbeing_checkins_motivation_check (CHECK), wellbeing_checkins_owner_row_key (UNIQUE), wellbeing_checkins_pkey (PRIMARY KEY), wellbeing_checkins_user_id_fkey (FOREIGN KEY)

**Vierasavaimet (16):**

- `calendar_events.calendar_events_goal_fkey`: `FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE SET NULL (goal_id)`
- `calendar_events.calendar_events_place_fkey`: `FOREIGN KEY (user_id, place_id) REFERENCES saved_places(user_id, id) ON DELETE SET NULL (place_id)`
- `calendar_events.calendar_events_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `commute_observations.commute_observations_place_fkey`: `FOREIGN KEY (user_id, place_id) REFERENCES saved_places(user_id, id) ON DELETE CASCADE`
- `commute_observations.commute_observations_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `exercise_sessions.exercise_sessions_goal_fkey`: `FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE SET NULL (goal_id)`
- `exercise_sessions.exercise_sessions_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `habit_events.habit_events_plan_fkey`: `FOREIGN KEY (user_id, plan_id) REFERENCES habit_plans(user_id, id) ON DELETE CASCADE`
- `habit_events.habit_events_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `habit_plans.habit_plans_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `life_settings.life_settings_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `place_aliases.place_aliases_place_fkey`: `FOREIGN KEY (user_id, place_id) REFERENCES saved_places(user_id, id) ON DELETE CASCADE`
- `place_aliases.place_aliases_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `saved_places.saved_places_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `sleep_logs.sleep_logs_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `wellbeing_checkins.wellbeing_checkins_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`

**Indeksit (29):** `calendar_events_owner_row_key`, `calendar_events_pkey`, `calendar_events_user_date_idx`, `commute_observations_owner_row_key`, `commute_observations_pkey`, `commute_observations_user_place_idx`, `exercise_sessions_owner_row_key`, `exercise_sessions_pkey`, `exercise_sessions_user_date_idx`, `habit_events_owner_row_key`, `habit_events_pkey`, `habit_events_user_plan_idx`, `habit_plans_owner_row_key`, `habit_plans_pkey`, `life_settings_one_per_user`, `life_settings_owner_row_key`, `life_settings_pkey`, `place_aliases_alias_unique`, `place_aliases_owner_row_key`, `place_aliases_pkey`, `saved_places_owner_row_key`, `saved_places_pkey`, `saved_places_user_name_idx`, `sleep_logs_owner_row_key`, `sleep_logs_pkey`, `sleep_logs_wake_date_unique`, `wellbeing_checkins_date_unique`, `wellbeing_checkins_owner_row_key`, `wellbeing_checkins_pkey`

**Politiikat (40):** `calendar_events` 4, `commute_observations` 4, `exercise_sessions` 4, `habit_events` 4, `habit_plans` 4, `life_settings` 4, `place_aliases` 4, `saved_places` 4, `sleep_logs` 4, `wellbeing_checkins` 4

**Liipaisimet (10):** `calendar_events_touch_updated_at`, `commute_observations_touch_updated_at`, `exercise_sessions_touch_updated_at`, `habit_events_touch_updated_at`, `habit_plans_touch_updated_at`, `life_settings_touch_updated_at`, `place_aliases_touch_updated_at`, `saved_places_touch_updated_at`, `sleep_logs_touch_updated_at`, `wellbeing_checkins_touch_updated_at`
