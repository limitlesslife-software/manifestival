-- =====================================================================
-- Manifestival — aktivoinnin inventaario 0001–0015 (VAIN LUKU)
-- =====================================================================
--
-- GENEROITU: node tools/activation/build-inventory.mjs. ÄLÄ MUOKKAA
-- KÄSIN — testi vertaa tiedostoa generaattoriin.
--
-- Aja Supabase Dashboardissa: SQL Editor -> New query -> liitä -> Run.
-- YKSI lause, YKSI taulukko. Mitään ei luoda, muuteta eikä poisteta.
-- Ei käyttäjän sisältöä: vain rakenne, lukumäärät ja tilat.
--
-- MITÄ TEET TULOKSELLA
--
--   Kopioi RIVIN 00 solu "arvo" (yksi JSON-rivi) ja liitä se Claudelle.
--   Vaihtoehto: valitse koko tulostaulukko, kopioi ja liitä.
--   Claude ajaa: node tools/activation/score-inventory.mjs
--   ja kertoo seuraavan portin.
--
-- Migraatioiden tunnistuslistat on poimittu migraatioiden omista
-- esitarkistuksista, joten luku tarkoittaa samaa kuin migraation oma
-- viesti: 0 = ajamaton, täysi = ajettu, muu = kesken.
-- Täydet luvut: 0002=12 0003=25 0004=36|37 0005=9 0006=10 0007=39 0008=11 0009=39 0010=38 0011=72 0012=58 0013=46 0014=153 0015=47
--   (0004: 37 jos routines on olemassa. 0012: 57 kun 0013 on ajettu,
--    koska 0013 korvaa rajoitteen time_entries_source_check, ja 56 kun
--    myös 0015 on ajettu, koska 0015 poistaa life_areas_category_unique.)

with rivit as (
  select '01'::text as nro, 'kanta'::text as osio, 'PostgreSQL server_version_num'::text as tarkistus,
         (current_setting('server_version_num'))::text as arvo
  union all
  select '02'::text as nro, 'kanta'::text as osio, 'PostgreSQL versio'::text as tarkistus,
         (current_setting('server_version'))::text as arvo
  union all
  select '03'::text as nro, 'kanta'::text as osio, 'Tietokanta'::text as tarkistus,
         (current_database())::text as arvo
  union all
  select '04'::text as nro, 'kanta'::text as osio, 'Hetki (UTC)'::text as tarkistus,
         (to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'))::text as arvo
  union all
  select '10'::text as nro, 'migraatio'::text as osio, '0001 tasks.user_id'::text as tarkistus,
         ((select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks' and column_name = 'user_id'))::text as arvo
  union all
  select '11'::text as nro, 'migraatio'::text as osio, '0002 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks'
        and column_name in ('description', 'duration_minutes', 'priority',
        'scheduling_state', 'created_at', 'updated_at')
        union all
        select 1 from pg_constraint
        where conrelid = to_regclass('public.tasks')
        and conname in ('tasks_priority_check', 'tasks_scheduling_state_check',
        'tasks_duration_minutes_check')
        union all
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'touch_updated_at'
        union all
        select 1 from pg_trigger
        where tgrelid = to_regclass('public.tasks')
        and tgname = 'tasks_touch_updated_at' and not tgisinternal
        union all
        select 1 from pg_indexes
        where schemaname = 'public' and tablename = 'tasks'
        and indexname = 'tasks_user_date_priority_idx'
      ) kaikki)::text as arvo
  union all
  select '12'::text as nro, 'migraatio'::text as osio, '0003 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public' and tablename in ('routines', 'routine_exceptions')
        union all
        select 1 from pg_constraint
        where conname in ('routines_recurrence_type_check', 'routines_scheduling_check',
        'routines_priority_check', 'routines_duration_check',
        'routines_title_check', 'routines_date_range_check',
        'routines_weekdays_check', 'routine_exceptions_type_check',
        'routine_exceptions_duration_check',
        'routine_exceptions_unique_day', 'routines_owner_row_key')
        union all
        select 1 from pg_indexes
        where schemaname = 'public'
        and indexname in ('routines_user_active_idx', 'routine_exceptions_user_date_idx')
        union all
        select 1 from pg_trigger
        where not tgisinternal
        and tgname in ('routines_touch_updated_at', 'routine_exceptions_touch_updated_at')
        union all
        select 1 from pg_policies
        where schemaname = 'public' and tablename in ('routines', 'routine_exceptions')
      ) kaikki)::text as arvo
  union all
  select '13'::text as nro, 'migraatio'::text as osio, '0004 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public' and tablename in ('goals', 'projects')
        union all
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks'
        and column_name in ('deadline', 'goal_id', 'project_id')
        union all
        select 1 from pg_constraint
        where conname in ('goals_status_check', 'goals_progress_mode_check',
        'goals_manual_progress_check', 'goals_priority_check',
        'goals_title_check', 'goals_parent_not_self_check',
        'goals_owner_row_key', 'goals_parent_goal_fkey',
        'goals_project_id_fkey',
        'projects_priority_check', 'projects_date_range_check',
        'projects_status_check', 'projects_name_check',
        'projects_owner_row_key', 'projects_goal_id_fkey',
        'tasks_goal_id_fkey', 'tasks_project_id_fkey',
        'routines_goal_id_fkey')
        union all
        select 1 from pg_indexes
        where schemaname = 'public'
        and indexname in ('goals_user_status_idx', 'projects_user_status_idx',
        'tasks_user_goal_idx', 'tasks_user_deadline_idx')
        union all
        select 1 from pg_trigger
        where not tgisinternal
        and tgname in ('goals_touch_updated_at', 'projects_touch_updated_at')
        union all
        select 1 from pg_policies
        where schemaname = 'public' and tablename in ('goals', 'projects')
      ) kaikki)::text as arvo
  union all
  select '14'::text as nro, 'migraatio'::text as osio, '0005 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public' and tablename = 'notification_preferences'
        union all
        select 1 from pg_constraint
        where conname in ('notification_preferences_lead_check',
        'notification_preferences_max_per_day_check',
        'notification_preferences_time_format_check')
        union all
        select 1 from pg_trigger
        where not tgisinternal
        and tgname = 'notification_preferences_touch_updated_at'
        union all
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'notification_preferences'
      ) kaikki)::text as arvo
  union all
  select '15'::text as nro, 'migraatio'::text as osio, '0006 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public' and tablename = 'wellbeing_entries'
        union all
        select 1 from pg_constraint
        where conname in ('wellbeing_entries_unique_day',
        'wellbeing_entries_scale_check',
        'wellbeing_entries_sleep_check')
        union all
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'wellbeing_entries_user_date_idx'
        union all
        select 1 from pg_trigger
        where not tgisinternal and tgname = 'wellbeing_entries_touch_updated_at'
        union all
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'wellbeing_entries'
      ) kaikki)::text as arvo
  union all
  select '16'::text as nro, 'migraatio'::text as osio, '0007 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public'
        and tablename in ('bills', 'recurring_expenses', 'savings_goals')
        union all
        select 1 from pg_constraint
        where conname in ('recurring_expenses_cadence_check',
        'recurring_expenses_amount_check',
        'recurring_expenses_day_check',
        'recurring_expenses_currency_check',
        'recurring_expenses_name_check',
        'recurring_expenses_owner_row_key',
        'bills_status_check', 'bills_amount_check',
        'bills_currency_check', 'bills_name_check',
        'bills_paid_date_check',
        'bills_task_id_fkey', 'bills_recurring_expense_id_fkey',
        'savings_goals_amount_check',
        'savings_goals_currency_check',
        'savings_goals_name_check',
        'tasks_owner_row_key')
        union all
        select 1 from pg_indexes
        where schemaname = 'public'
        and indexname in ('recurring_expenses_user_active_idx',
        'bills_user_status_due_idx', 'bills_user_due_idx',
        'savings_goals_user_idx')
        union all
        select 1 from pg_trigger
        where not tgisinternal
        and tgname in ('bills_touch_updated_at',
        'recurring_expenses_touch_updated_at',
        'savings_goals_touch_updated_at')
        union all
        select 1 from pg_policies
        where schemaname = 'public'
        and tablename in ('bills', 'recurring_expenses', 'savings_goals')
      ) kaikki)::text as arvo
  union all
  select '17'::text as nro, 'migraatio'::text as osio, '0008 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public' and tablename = 'ai_action_audit'
        union all
        select 1 from pg_constraint
        where conname in ('ai_action_audit_result_check',
        'ai_action_audit_risk_check',
        'ai_action_audit_summary_length_check',
        'ai_action_audit_proposal_length_check',
        'ai_action_audit_confirmed_check')
        union all
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'ai_action_audit_user_time_idx'
        union all
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'ai_action_audit'
      ) kaikki)::text as arvo
  union all
  select '18'::text as nro, 'migraatio'::text as osio, '0009 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public'
        and tablename in ('transactions', 'investments')
        union all
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'bills'
        and column_name in ('payee', 'iban', 'reference')
        union all
        select 1 from pg_constraint
        where conname in ('transactions_kind_check',
        'transactions_origin_check',
        'transactions_amount_check',
        'transactions_currency_check',
        'transactions_source_pair_check',
        'transactions_source_kind_check',
        'transactions_transfer_category_check',
        'transactions_description_length_check',
        'transactions_note_length_check',
        'transactions_owner_row_key',
        'investments_kind_check',
        'investments_value_source_check',
        'investments_quantity_check',
        'investments_amounts_check',
        'investments_currency_check',
        'investments_name_check',
        'investments_unknown_value_check',
        'investments_owner_row_key',
        'bills_payee_length_check',
        'bills_iban_check',
        'bills_reference_check')
        union all
        select 1 from pg_indexes
        where schemaname = 'public'
        and indexname in ('transactions_user_date_idx',
        'transactions_user_source_idx',
        'investments_user_name_idx')
        union all
        select 1 from pg_trigger
        where not tgisinternal
        and tgname in ('transactions_touch_updated_at',
        'investments_touch_updated_at')
        union all
        select 1 from pg_policies
        where schemaname = 'public'
        and tablename in ('transactions', 'investments')
      ) kaikki)::text as arvo
  union all
  select '19'::text as nro, 'migraatio'::text as osio, '0010 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public' and tablename = 'milestones'
        union all
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'goals'
        and column_name in ('metric', 'unit', 'baseline_value', 'current_value',
        'target_value', 'measured_on', 'savings_goal_id')
        union all
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks'
        and column_name in ('milestone_id', 'depends_on')
        union all
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'projects'
        and column_name in ('milestone_id')
        union all
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'profile'
        and column_name in ('automation_level', 'planning_buffer_ratio')
        union all
        select 1 from pg_constraint
        where conname in ('milestones_status_check',
        'milestones_rule_check',
        'milestones_title_check',
        'milestones_reached_date_check',
        'milestones_order_check',
        'milestones_description_length_check',
        'milestones_goal_fkey',
        'milestones_owner_row_key',
        'goals_metric_pair_check',
        'goals_savings_exclusive_check',
        'goals_metric_length_check',
        'goals_unit_length_check',
        'tasks_depends_on_length_check',
        'tasks_depends_on_no_self_check',
        'tasks_milestone_fkey',
        'projects_milestone_fkey',
        'profile_automation_level_check',
        'profile_buffer_ratio_check')
        union all
        select 1 from pg_indexes
        where schemaname = 'public'
        and indexname in ('milestones_user_goal_idx', 'milestones_user_target_idx')
        union all
        select 1 from pg_trigger
        where not tgisinternal and tgname = 'milestones_touch_updated_at'
        union all
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'milestones'
      ) kaikki)::text as arvo
  union all
  select '20'::text as nro, 'migraatio'::text as osio, '0011 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public'
        and tablename in ('inbox_items', 'reminders', 'notices',
        'travel_plans', 'location_rules')
        union all
        select 1 from pg_constraint
        where conname in (
        'inbox_items_status_check', 'inbox_items_source_check',
        'inbox_items_text_check', 'inbox_items_converted_check',
        'inbox_items_owner_row_key',
        'reminders_status_check', 'reminders_target_check',
        'reminders_trigger_check', 'reminders_title_check',
        'reminders_target_pair_check', 'reminders_alert_count_check',
        'reminders_snooze_count_check', 'reminders_lead_check',
        'reminders_owner_row_key',
        'notices_kind_check', 'notices_level_check', 'notices_status_check',
        'notices_title_check', 'notices_target_pair_check',
        'notices_owner_row_key', 'notices_key_unique',
        'travel_plans_mode_check', 'travel_plans_source_check',
        'travel_plans_title_check', 'travel_plans_minutes_check',
        'travel_plans_buffer_check', 'travel_plans_unknown_source_check',
        'travel_plans_owner_row_key', 'travel_plans_task_fkey',
        'location_rules_trigger_check', 'location_rules_place_check',
        'location_rules_owner_row_key', 'location_rules_task_fkey')
        union all
        select 1 from pg_indexes
        where schemaname = 'public'
        and indexname in (
        'inbox_items_user_status_idx', 'inbox_items_user_captured_idx',
        'reminders_user_due_idx', 'reminders_user_status_idx',
        'reminders_user_target_idx',
        'notices_user_status_idx', 'notices_user_created_idx',
        'travel_plans_user_arrival_idx', 'location_rules_user_active_idx')
        union all
        select 1 from pg_trigger
        where not tgisinternal
        and tgname in ('inbox_items_touch_updated_at', 'reminders_touch_updated_at',
        'notices_touch_updated_at', 'travel_plans_touch_updated_at',
        'location_rules_touch_updated_at')
        union all
        select 1 from pg_policies
        where schemaname = 'public'
        and tablename in ('inbox_items', 'reminders', 'notices',
        'travel_plans', 'location_rules')
      ) kaikki)::text as arvo
  union all
  select '21'::text as nro, 'migraatio'::text as osio, '0012 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public'
        and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
        'alignment_reviews')
        union all
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'goals'
        and column_name = 'life_area_id'
        union all
        select 1 from pg_constraint
        where conname in (
        'life_areas_name_check', 'life_areas_description_check',
        'life_areas_importance_check', 'life_areas_target_check',
        'life_areas_category_check', 'life_areas_sort_order_check',
        'life_areas_owner_row_key', 'life_areas_name_unique',
        'life_areas_category_unique',
        'weekly_capacities_week_start_check', 'weekly_capacities_minutes_check',
        'weekly_capacities_energy_check', 'weekly_capacities_note_check',
        'weekly_capacities_owner_row_key', 'weekly_capacities_week_unique',
        'time_entries_minutes_check', 'time_entries_source_check',
        'time_entries_note_check', 'time_entries_owner_row_key',
        'time_entries_life_area_fkey', 'time_entries_goal_fkey',
        'time_entries_task_fkey',
        'alignment_reviews_week_start_check', 'alignment_reviews_version_check',
        'alignment_reviews_snapshot_check', 'alignment_reviews_reflection_check',
        'alignment_reviews_adjustments_check', 'alignment_reviews_owner_row_key',
        'alignment_reviews_week_unique',
        'goals_life_area_fkey')
        union all
        select 1 from pg_indexes
        where schemaname = 'public'
        and indexname in ('life_areas_user_active_idx', 'time_entries_user_date_idx',
        'goals_user_life_area_idx')
        union all
        select 1 from pg_trigger
        where not tgisinternal
        and tgname in ('life_areas_touch_updated_at', 'weekly_capacities_touch_updated_at',
        'time_entries_touch_updated_at', 'alignment_reviews_touch_updated_at')
        union all
        select 1 from pg_policies
        where schemaname = 'public'
        and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
        'alignment_reviews')
      ) kaikki)::text as arvo
  union all
  select '22'::text as nro, 'migraatio'::text as osio, '0013 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public'
        and tablename in ('running_timers', 'alignment_item_settings')
        union all
        select 1 from information_schema.columns
        where table_schema = 'public'
        and ((table_name = 'time_entries'
        and column_name in ('project_id', 'routine_id', 'occurrence_date',
        'operation_id', 'started_at', 'ended_at'))
        or (table_name = 'weekly_capacities' and column_name = 'energy_budget_minutes')
        or (table_name = 'alignment_reviews'
        and column_name in ('policy_version', 'reflection_answers')))
        union all
        select 1 from pg_constraint
        where conname in (
        'time_entries_source_v2_check', 'time_entries_operation_check',
        'time_entries_operation_unique', 'time_entries_project_fkey',
        'time_entries_routine_fkey', 'time_entries_span_check',
        'weekly_capacities_energy_budget_check',
        'alignment_reviews_policy_version_check', 'alignment_reviews_reflection_answers_check',
        'running_timers_target_kind_check', 'running_timers_paused_check',
        'running_timers_note_check', 'running_timers_owner_row_key',
        'running_timers_one_per_user', 'running_timers_life_area_fkey',
        'running_timers_goal_fkey', 'running_timers_task_fkey',
        'running_timers_project_fkey', 'running_timers_routine_fkey',
        'alignment_item_settings_kind_check', 'alignment_item_settings_item_id_check',
        'alignment_item_settings_energy_check', 'alignment_item_settings_owner_row_key',
        'alignment_item_settings_item_unique')
        union all
        select 1 from pg_indexes
        where schemaname = 'public'
        and indexname in ('time_entries_user_routine_idx')
        union all
        select 1 from pg_trigger
        where not tgisinternal
        and tgname in ('running_timers_touch_updated_at',
        'alignment_item_settings_touch_updated_at')
        union all
        select 1 from pg_policies
        where schemaname = 'public'
        and tablename in ('running_timers', 'alignment_item_settings')
      ) kaikki)::text as arvo
  union all
  select '23'::text as nro, 'migraatio'::text as osio, '0014 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public'
        and tablename in ('saved_places', 'place_aliases', 'calendar_events',
        'commute_observations', 'life_settings', 'sleep_logs',
        'habit_plans', 'habit_events', 'exercise_sessions',
        'wellbeing_checkins')
        union all
        select 1 from pg_constraint
        where conname in (
        'saved_places_name_check', 'saved_places_address_check',
        'saved_places_provider_place_check', 'saved_places_area_check',
        'saved_places_travel_mode_check', 'saved_places_usual_travel_check',
        'saved_places_preparation_check', 'saved_places_arrival_buffer_check',
        'saved_places_overhead_check', 'saved_places_note_check',
        'saved_places_owner_row_key',
        'place_aliases_alias_check', 'place_aliases_confirmations_check',
        'place_aliases_owner_row_key', 'place_aliases_alias_unique',
        'place_aliases_place_fkey',
        'calendar_events_title_check', 'calendar_events_all_day_check',
        'calendar_events_end_time_check', 'calendar_events_duration_check',
        'calendar_events_category_check', 'calendar_events_location_check',
        'calendar_events_travel_mode_check', 'calendar_events_travel_check',
        'calendar_events_preparation_check', 'calendar_events_arrival_buffer_check',
        'calendar_events_overhead_check', 'calendar_events_weekdays_check',
        'calendar_events_until_check', 'calendar_events_skip_dates_check',
        'calendar_events_notes_check', 'calendar_events_owner_row_key',
        'calendar_events_place_fkey', 'calendar_events_goal_fkey',
        'commute_observations_event_id_check', 'commute_observations_weekday_check',
        'commute_observations_travel_check', 'commute_observations_provider_check',
        'commute_observations_preparation_check', 'commute_observations_overhead_check',
        'commute_observations_result_check', 'commute_observations_source_check',
        'commute_observations_owner_row_key', 'commute_observations_place_fkey',
        'life_settings_one_per_user', 'life_settings_weekend_wake_check',
        'life_settings_weekend_bed_check', 'life_settings_wind_down_check',
        'life_settings_arrival_buffer_check', 'life_settings_guidance_check',
        'life_settings_reminder_offset_check', 'life_settings_hourly_value_check',
        'life_settings_currency_check', 'life_settings_alarm_check',
        'life_settings_morning_routine_check', 'life_settings_meal_rhythm_check',
        'life_settings_delivery_check', 'life_settings_owner_row_key',
        'sleep_logs_wake_date_unique', 'sleep_logs_source_check',
        'sleep_logs_kind_check', 'sleep_logs_note_check', 'sleep_logs_owner_row_key',
        'habit_plans_kind_check', 'habit_plans_name_check',
        'habit_plans_min_interval_check', 'habit_plans_daily_target_check',
        'habit_plans_baseline_check', 'habit_plans_steps_check',
        'habit_plans_delivery_check', 'habit_plans_unit_cost_check',
        'habit_plans_owner_row_key',
        'habit_events_action_check', 'habit_events_note_check',
        'habit_events_owner_row_key', 'habit_events_plan_fkey',
        'exercise_sessions_kind_check', 'exercise_sessions_planned_check',
        'exercise_sessions_actual_check', 'exercise_sessions_intensity_check',
        'exercise_sessions_recovery_check', 'exercise_sessions_note_check',
        'exercise_sessions_owner_row_key', 'exercise_sessions_goal_fkey',
        'wellbeing_checkins_motivation_check', 'wellbeing_checkins_control_check',
        'wellbeing_checkins_date_unique', 'wellbeing_checkins_owner_row_key')
        union all
        select 1 from pg_indexes
        where schemaname = 'public'
        and indexname in (
        'saved_places_user_name_idx', 'calendar_events_user_date_idx',
        'commute_observations_user_place_idx', 'habit_events_user_plan_idx',
        'exercise_sessions_user_date_idx')
        union all
        select 1 from pg_trigger
        where not tgisinternal
        and tgname in ('saved_places_touch_updated_at', 'place_aliases_touch_updated_at',
        'calendar_events_touch_updated_at',
        'commute_observations_touch_updated_at',
        'life_settings_touch_updated_at', 'sleep_logs_touch_updated_at',
        'habit_plans_touch_updated_at', 'habit_events_touch_updated_at',
        'exercise_sessions_touch_updated_at',
        'wellbeing_checkins_touch_updated_at')
        union all
        select 1 from pg_policies
        where schemaname = 'public'
        and tablename in ('saved_places', 'place_aliases', 'calendar_events',
        'commute_observations', 'life_settings', 'sleep_logs',
        'habit_plans', 'habit_events', 'exercise_sessions',
        'wellbeing_checkins')
      ) kaikki)::text as arvo
  union all
  select '24'::text as nro, 'migraatio'::text as osio, '0015 objekteja'::text as tarkistus,
         (select count(*) from (
        select 1 from pg_tables
        where schemaname = 'public'
        and tablename in ('protected_periods', 'weekly_plans')
        union all
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks'
        and column_name in ('horizon', 'waiting_on', 'follow_up_date', 'archived_at',
        'reschedule_count', 'original_date')
        union all
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'life_areas'
        and column_name in ('kind')
        union all
        select 1 from pg_constraint
        where conname in (
        'life_areas_kind_check',
        'tasks_horizon_check', 'tasks_waiting_on_check', 'tasks_reschedule_count_check',
        'tasks_waiting_on_horizon_check',
        'protected_periods_kind_check', 'protected_periods_recurrence_check',
        'protected_periods_title_check', 'protected_periods_note_check',
        'protected_periods_weekdays_check', 'protected_periods_target_check',
        'protected_periods_strength_check', 'protected_periods_dates_check',
        'protected_periods_times_check', 'protected_periods_once_check',
        'protected_periods_weekly_check', 'protected_periods_weekly_target_check',
        'protected_periods_vacation_check', 'protected_periods_span_check',
        'protected_periods_owner_row_key',
        'weekly_plans_week_start_check', 'weekly_plans_priorities_check',
        'weekly_plans_planned_minutes_check', 'weekly_plans_note_check',
        'weekly_plans_week_unique', 'weekly_plans_owner_row_key')
        union all
        select 1 from pg_indexes
        where schemaname = 'public'
        and indexname in ('life_areas_user_category_idx', 'protected_periods_user_active_idx')
        union all
        select 1 from pg_trigger
        where not tgisinternal
        and tgname in ('protected_periods_touch_updated_at', 'weekly_plans_touch_updated_at')
        union all
        select 1 from pg_policies
        where schemaname = 'public'
        and tablename in ('protected_periods', 'weekly_plans')
      ) kaikki)::text as arvo
  union all
  select '30'::text as nro, 'migraatio'::text as osio, '0013 korvaava lähderajoite (time_entries_source_v2_check)'::text as tarkistus,
         ((select count(*) from pg_constraint where conname = 'time_entries_source_v2_check'))::text as arvo
  union all
  select '40'::text as nro, 'esiehto'::text as osio, 'Hyväksytty omistaja auth.users-taulussa (0010–0015 vaativat)'::text as tarkistus,
         ((select count(*) from auth.users where id = '2cc00622-f927-4604-a518-361a4328481b'::uuid))::text as arvo
  union all
  select '41'::text as nro, 'esiehto'::text as osio, 'Auth-käyttäjiä (lukumäärä)'::text as tarkistus,
         ((select count(*) from auth.users))::text as arvo
  union all
  select '42'::text as nro, 'esiehto'::text as osio, 'Omistajan rivin avaimet (goals, projects, tasks, routines, recurring_expenses)'::text as tarkistus,
         ((select count(*) from pg_constraint where contype = 'u' and conname in
        ('goals_owner_row_key', 'projects_owner_row_key', 'tasks_owner_row_key',
         'routines_owner_row_key', 'recurring_expenses_owner_row_key')))::text as arvo
  union all
  select '43'::text as nro, 'esiehto'::text as osio, 'touch_updated_at on INVOKER ja search_path kiinnitetty'::text as tarkistus,
         ((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'touch_updated_at' and not p.prosecdef
          and exists (select 1 from unnest(p.proconfig) a where a like 'search\_path=%')))::text as arvo
  union all
  select '44'::text as nro, 'esiehto'::text as osio, 'Tavoitteita, joiden tila ei kelpaa 0010:n rajoitteelle'::text as tarkistus,
         (case when to_regclass('public.goals') is null then 'puuttuu' else
       (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.goals
          where status not in ('active','paused','maintenance','completed','abandoned','archived')$q$,
          false, true, '')))[1]::text end)::text as arvo
  union all
  select '45'::text as nro, 'esiehto'::text as osio, 'Avoimia idle in transaction -istuntoja (lukitsisivat migraation)'::text as tarkistus,
         ((select count(*) from pg_stat_activity where datname = current_database()
        and state in ('idle in transaction', 'idle in transaction (aborted)') and pid <> pg_backend_pid()))::text as arvo
  union all
  select '50'::text as nro, 'turva'::text as osio, 'Public-tauluja ilman RLS:ää'::text as tarkistus,
         ((select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity))::text as arvo
  union all
  select '51'::text as nro, 'turva'::text as osio, 'anon-roolin tauluoikeuksia'::text as tarkistus,
         ((select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'))::text as arvo
  union all
  select '52'::text as nro, 'turva'::text as osio, 'PUBLIC-roolin tauluoikeuksia'::text as tarkistus,
         ((select count(*) from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.grantee = 0))::text as arvo
  union all
  select '60'::text as nro, 'data'::text as osio, 'tasks.date tietotyyppi'::text as tarkistus,
         ((select data_type from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'date'))::text as arvo
  union all
  select '61'::text as nro, 'data'::text as osio, 'tasks.time tietotyyppi'::text as tarkistus,
         ((select data_type from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'time'))::text as arvo
  union all
  select '62'::text as nro, 'data'::text as osio, 'Tehtäviä, joilla kesto'::text as tarkistus,
         (case when (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks' and column_name = 'duration_minutes') = 0 then 'puuttuu'
        else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.tasks where duration_minutes is not null', false, true, '')))[1]::text end)::text as arvo
  union all
  select '63'::text as nro, 'data'::text as osio, 'rivejä: tasks'::text as tarkistus,
         (case when to_regclass('public.tasks') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.tasks', false, true, '')))[1]::text end)::text as arvo
  union all
  select '64'::text as nro, 'data'::text as osio, 'rivejä: profile'::text as tarkistus,
         (case when to_regclass('public.profile') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.profile', false, true, '')))[1]::text end)::text as arvo
  union all
  select '65'::text as nro, 'data'::text as osio, 'rivejä: goals'::text as tarkistus,
         (case when to_regclass('public.goals') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.goals', false, true, '')))[1]::text end)::text as arvo
  union all
  select '66'::text as nro, 'data'::text as osio, 'rivejä: projects'::text as tarkistus,
         (case when to_regclass('public.projects') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.projects', false, true, '')))[1]::text end)::text as arvo
  union all
  select '67'::text as nro, 'data'::text as osio, 'rivejä: routines'::text as tarkistus,
         (case when to_regclass('public.routines') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.routines', false, true, '')))[1]::text end)::text as arvo
  union all
  select '68'::text as nro, 'data'::text as osio, 'rivejä: routine_exceptions'::text as tarkistus,
         (case when to_regclass('public.routine_exceptions') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.routine_exceptions', false, true, '')))[1]::text end)::text as arvo
  union all
  select '69'::text as nro, 'data'::text as osio, 'rivejä: notification_preferences'::text as tarkistus,
         (case when to_regclass('public.notification_preferences') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.notification_preferences', false, true, '')))[1]::text end)::text as arvo
  union all
  select '70'::text as nro, 'data'::text as osio, 'rivejä: wellbeing_entries'::text as tarkistus,
         (case when to_regclass('public.wellbeing_entries') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.wellbeing_entries', false, true, '')))[1]::text end)::text as arvo
  union all
  select '71'::text as nro, 'data'::text as osio, 'rivejä: bills'::text as tarkistus,
         (case when to_regclass('public.bills') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.bills', false, true, '')))[1]::text end)::text as arvo
  union all
  select '72'::text as nro, 'data'::text as osio, 'rivejä: recurring_expenses'::text as tarkistus,
         (case when to_regclass('public.recurring_expenses') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.recurring_expenses', false, true, '')))[1]::text end)::text as arvo
  union all
  select '73'::text as nro, 'data'::text as osio, 'rivejä: savings_goals'::text as tarkistus,
         (case when to_regclass('public.savings_goals') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.savings_goals', false, true, '')))[1]::text end)::text as arvo
  union all
  select '74'::text as nro, 'data'::text as osio, 'rivejä: ai_action_audit'::text as tarkistus,
         (case when to_regclass('public.ai_action_audit') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.ai_action_audit', false, true, '')))[1]::text end)::text as arvo
  union all
  select '75'::text as nro, 'data'::text as osio, 'rivejä: transactions'::text as tarkistus,
         (case when to_regclass('public.transactions') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.transactions', false, true, '')))[1]::text end)::text as arvo
  union all
  select '76'::text as nro, 'data'::text as osio, 'rivejä: investments'::text as tarkistus,
         (case when to_regclass('public.investments') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.investments', false, true, '')))[1]::text end)::text as arvo
  union all
  select '77'::text as nro, 'data'::text as osio, 'rivejä: milestones'::text as tarkistus,
         (case when to_regclass('public.milestones') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.milestones', false, true, '')))[1]::text end)::text as arvo
  union all
  select '78'::text as nro, 'data'::text as osio, 'rivejä: inbox_items'::text as tarkistus,
         (case when to_regclass('public.inbox_items') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.inbox_items', false, true, '')))[1]::text end)::text as arvo
  union all
  select '79'::text as nro, 'data'::text as osio, 'rivejä: reminders'::text as tarkistus,
         (case when to_regclass('public.reminders') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.reminders', false, true, '')))[1]::text end)::text as arvo
  union all
  select '80'::text as nro, 'data'::text as osio, 'rivejä: notices'::text as tarkistus,
         (case when to_regclass('public.notices') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.notices', false, true, '')))[1]::text end)::text as arvo
  union all
  select '81'::text as nro, 'data'::text as osio, 'rivejä: travel_plans'::text as tarkistus,
         (case when to_regclass('public.travel_plans') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.travel_plans', false, true, '')))[1]::text end)::text as arvo
  union all
  select '82'::text as nro, 'data'::text as osio, 'rivejä: location_rules'::text as tarkistus,
         (case when to_regclass('public.location_rules') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.location_rules', false, true, '')))[1]::text end)::text as arvo
  union all
  select '83'::text as nro, 'data'::text as osio, 'rivejä: life_areas'::text as tarkistus,
         (case when to_regclass('public.life_areas') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.life_areas', false, true, '')))[1]::text end)::text as arvo
  union all
  select '84'::text as nro, 'data'::text as osio, 'rivejä: weekly_capacities'::text as tarkistus,
         (case when to_regclass('public.weekly_capacities') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.weekly_capacities', false, true, '')))[1]::text end)::text as arvo
  union all
  select '85'::text as nro, 'data'::text as osio, 'rivejä: time_entries'::text as tarkistus,
         (case when to_regclass('public.time_entries') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.time_entries', false, true, '')))[1]::text end)::text as arvo
  union all
  select '86'::text as nro, 'data'::text as osio, 'rivejä: alignment_reviews'::text as tarkistus,
         (case when to_regclass('public.alignment_reviews') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.alignment_reviews', false, true, '')))[1]::text end)::text as arvo
  union all
  select '87'::text as nro, 'data'::text as osio, 'rivejä: running_timers'::text as tarkistus,
         (case when to_regclass('public.running_timers') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.running_timers', false, true, '')))[1]::text end)::text as arvo
  union all
  select '88'::text as nro, 'data'::text as osio, 'rivejä: alignment_item_settings'::text as tarkistus,
         (case when to_regclass('public.alignment_item_settings') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.alignment_item_settings', false, true, '')))[1]::text end)::text as arvo
  union all
  select '89'::text as nro, 'data'::text as osio, 'Tehtäviä, joilla kesto > 0 (rivin 62 tarkennus)'::text as tarkistus,
         (case when (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks' and column_name = 'duration_minutes') = 0 then 'puuttuu'
        else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.tasks where duration_minutes > 0', false, true, '')))[1]::text end)::text as arvo
  union all
  select '90'::text as nro, 'data'::text as osio, 'rivejä: saved_places'::text as tarkistus,
         (case when to_regclass('public.saved_places') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.saved_places', false, true, '')))[1]::text end)::text as arvo
  union all
  select '91'::text as nro, 'data'::text as osio, 'rivejä: place_aliases'::text as tarkistus,
         (case when to_regclass('public.place_aliases') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.place_aliases', false, true, '')))[1]::text end)::text as arvo
  union all
  select '92'::text as nro, 'data'::text as osio, 'rivejä: calendar_events'::text as tarkistus,
         (case when to_regclass('public.calendar_events') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.calendar_events', false, true, '')))[1]::text end)::text as arvo
  union all
  select '93'::text as nro, 'data'::text as osio, 'rivejä: commute_observations'::text as tarkistus,
         (case when to_regclass('public.commute_observations') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.commute_observations', false, true, '')))[1]::text end)::text as arvo
  union all
  select '94'::text as nro, 'data'::text as osio, 'rivejä: life_settings'::text as tarkistus,
         (case when to_regclass('public.life_settings') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.life_settings', false, true, '')))[1]::text end)::text as arvo
  union all
  select '95'::text as nro, 'data'::text as osio, 'rivejä: sleep_logs'::text as tarkistus,
         (case when to_regclass('public.sleep_logs') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.sleep_logs', false, true, '')))[1]::text end)::text as arvo
  union all
  select '96'::text as nro, 'data'::text as osio, 'rivejä: habit_plans'::text as tarkistus,
         (case when to_regclass('public.habit_plans') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.habit_plans', false, true, '')))[1]::text end)::text as arvo
  union all
  select '97'::text as nro, 'data'::text as osio, 'rivejä: habit_events'::text as tarkistus,
         (case when to_regclass('public.habit_events') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.habit_events', false, true, '')))[1]::text end)::text as arvo
  union all
  select '98'::text as nro, 'data'::text as osio, 'rivejä: exercise_sessions'::text as tarkistus,
         (case when to_regclass('public.exercise_sessions') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.exercise_sessions', false, true, '')))[1]::text end)::text as arvo
  union all
  select '99'::text as nro, 'data'::text as osio, 'rivejä: wellbeing_checkins'::text as tarkistus,
         (case when to_regclass('public.wellbeing_checkins') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.wellbeing_checkins', false, true, '')))[1]::text end)::text as arvo
  union all
  select '31'::text as nro, 'data'::text as osio, 'rivejä: protected_periods'::text as tarkistus,
         (case when to_regclass('public.protected_periods') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.protected_periods', false, true, '')))[1]::text end)::text as arvo
  union all
  select '32'::text as nro, 'data'::text as osio, 'rivejä: weekly_plans'::text as tarkistus,
         (case when to_regclass('public.weekly_plans') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.weekly_plans', false, true, '')))[1]::text end)::text as arvo
  union all
  select '33'::text as nro, 'data'::text as osio, 'Päivättömiä tehtäviä (tasks.date is null, mahdollinen 0015:n jälkeen)'::text as tarkistus,
         (case when to_regclass('public.tasks') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.tasks where date is null', false, true, '')))[1]::text end)::text as arvo
)
select '00' as nro, 'tiiviste' as osio, 'KOPIOI TÄMÄ SOLU CLAUDELLE' as tarkistus,
       json_build_object('inventory', 'mv-activation-v1',
                         'rows', json_object_agg(r.nro, r.arvo order by r.nro))::text as arvo
  from rivit r
union all
select nro, osio, tarkistus, arvo from rivit
order by 1;
