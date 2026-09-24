// Tuotannon muotoinen lähtötila ENNEN migraatiota 0001.
//
// Lähteet (repositorion totuus, ei arvaus):
//   docs/SCHEMA.md                     alkuperäiset sarakkeet
//   supabase/migrations/0001_*.sql     todennettu lähtötila: profile 1 rivi
//                                      id='me' (text), tasks 36 riviä ilman
//                                      user_id:tä, "salli kaikki" -politiikat
//   src/lib/rows.js TASK_COLUMNS_CORE  sovelluksen kirjoittamat 9 saraketta
//
// Sarakkeiden date/time/end_time tyyppi on docs/SCHEMA.md:ssä "date / text"
// ja "time / text" — sitä ei ole todennettu. Siksi lähtötila on
// parametroitu, ja harjoittelu ajetaan MOLEMMILLA muunnelmilla.
//
// Data on SYNTEETTISTÄ. Yhtään tuotannon riviä ei ole kopioitu.

export const VARIANTS = Object.freeze({
  text: { date: 'text', time: 'text' },
  typed: { date: 'date', time: 'time' }
});

const CATEGORIES = ['tyo', 'perhe', 'hyvinvointi', 'harrastus', 'koti', 'kehitys', 'talous', 'muu'];

export function baselineSql(variant = 'text') {
  const t = VARIANTS[variant];
  if (!t) throw new Error(`Tuntematon muunnelma ${variant}`);
  const rows = [];
  for (let i = 1; i <= 36; i++) {
    const id = i <= 10 ? `seed${i}` : `m${1756000000000 + i * 7919}x${i.toString(36)}`;
    const day = String(1 + (i % 28)).padStart(2, '0');
    const month = i % 2 ? '08' : '09';
    const hasTime = i % 3 !== 0;
    const hour = String(6 + (i % 14)).padStart(2, '0');
    const endHour = String(7 + (i % 14)).padStart(2, '0');
    const title = `Synteettinen tehtävä ${i}`;
    rows.push(`('${id}', '2026-${month}-${day}', ${hasTime ? `'${hour}:00'` : 'null'}, `
      + `${hasTime && i % 2 ? `'${endHour}:30'` : 'null'}, '${title}', '${CATEGORIES[i % 8]}', `
      + `${i % 5 === 0 ? `'muistiinpano ${i}'` : 'null'}, ${i % 4 === 0}, ${i % 9 === 1})`);
  }
  return `
create table public.tasks (
  id        text primary key,
  date      ${t.date},
  time      ${t.time},
  end_time  ${t.time},
  title     text,
  category  text,
  note      text,
  completed boolean default false,
  is_wake   boolean default false
);

create table public.profile (
  id                  text primary key,
  age                 integer,
  weight_kg           numeric,
  height_cm           numeric,
  sleep_target_hours  numeric default 8,
  default_wake_time   ${t.time} default '07:00',
  commute_minutes     integer default 30,
  routine_minutes     integer default 60
);

alter table public.tasks enable row level security;
alter table public.profile enable row level security;
create policy "Enable all access" on public.tasks for all using (true) with check (true);
create policy "Allow all" on public.profile for all using (true) with check (true);

insert into public.tasks (id, date, time, end_time, title, category, note, completed, is_wake) values
${rows.join(',\n')};

insert into public.profile (id, age, weight_kg, height_cm) values ('me', 40, 80, 180);
`;
}

export function usersSql() {
  return `
insert into auth.users (id, email) values
  ('2cc00622-f927-4604-a518-361a4328481b', 'owner@rehearsal.invalid'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'user-b@rehearsal.invalid')
on conflict (id) do nothing;
`;
}
