-- Varmistus: 0002_task_domain_fields
-- VAIN LUKEVA. Runbookin PYSAYTYS 6.

-- 1. Kuusi uutta saraketta. Odotus: kuusi rivia.
select column_name as sarake, data_type as tyyppi,
       is_nullable as sallii_nullin, column_default as oletus
from information_schema.columns
where table_schema = 'public' and table_name = 'tasks'
  and column_name in ('description', 'duration_minutes', 'priority',
                      'scheduling_state', 'created_at', 'updated_at')
order by column_name;

-- 2. Tarkisteet. Odotus: kolme rivia.
select conname as rajoite, pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where conrelid = 'public.tasks'::regclass
  and conname in ('tasks_priority_check', 'tasks_scheduling_state_check',
                  'tasks_duration_minutes_check')
order by conname;

-- 3. Aikataulutuksen tila taytetty kaikille. Odotus: 0.
select count(*) as ilman_tilaa from public.tasks where scheduling_state is null;

-- 4. Prioriteetti taytetty kaikille. Odotus: 0.
select count(*) as ilman_prioriteettia from public.tasks where priority is null;

-- 5. Indeksi. Odotus: yksi rivi.
select indexname as indeksi from pg_indexes
where schemaname = 'public' and tablename = 'tasks'
  and indexname = 'tasks_user_date_priority_idx';
