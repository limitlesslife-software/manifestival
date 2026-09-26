// E2E-valjaan siemenet: kannan rivit sellaisina kuin ne ovat tuotannossa.
//
// Puhdas moduuli (selain ja Node). Päivät annetaan (todayIso), kelloa ei lueta.
//
// VANHA KÄYTTÄJÄ (legacy): käyttäjä, joka on käyttänyt sovellusta ennen
// Suuntaa. Tuotannossa hänellä on:
//   - 36 avointa tehtävää ilman kestoa: rästissä, tällä viikolla ja ensi
//     viikolla. Kesto (duration_minutes) on null, koska vanha lomake ei
//     kysynyt sitä; osalla on alkuaika ilman loppuaikaa (ei johdettua
//     kestoa). Liitokset (goal_id, project_id, deadline) ovat null: ennen
//     F1-korjausta sovellus ei kirjoittanut niitä koskaan.
//   - yksi tavoite ja yksi projekti, joka on liitetty tavoitteeseen
//   - profiili
//   - ei elämänalueita, kapasiteettia, kirjauksia eikä ajastinta
// Sarakkeet ovat aallon J kannan sarakkeet (0001–0013): migraatioiden
// lisäämät sarakkeet ovat oletusarvoissaan (priority 'normaali',
// scheduling_state 'unscheduled'/'manual', depends_on {}, life_area_id null).

export const LEGACY_USER_ID = 'e2e00000-0000-4000-8000-000000000001';
export const LEGACY_EMAIL = 'e2e@example.invalid';

/** Siemenen koko: testi vaatii nämä (tests/life-alignment-e2e-harness.test.mjs). */
export const LEGACY_COUNTS = Object.freeze({ tasks: 36, overdue: 12, thisWeek: 12, nextWeek: 12, goals: 1, projects: 1 });

export const LEGACY_GOAL_ID = 'e2e-goal-puolimaraton';
export const LEGACY_PROJECT_ID = 'e2e-project-treeniohjelma';

const TITLES = Object.freeze([
  'Soita vakuutusyhtiöön', 'Siivoa varasto', 'Vie pullot kauppaan', 'Varaa hammaslääkäri',
  'Päivitä CV', 'Maksa sähkölasku', 'Korjaa pyörän jarrut', 'Lue kirjakerhon kirja',
  'Kysy tarjous ikkunoista', 'Pese auto', 'Järjestä valokuvat', 'Palauta kirjaston kirjat'
]);
const CATEGORIES = Object.freeze(['koti', 'tyo', 'perhe', 'hyvinvointi', 'talous', 'harrastus', 'kehitys', 'muu']);

/** Päivä + n päivää ISO-muodossa (UTC-laskenta, ei aikavyöhykettä). */
export function addDays(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Viikon maanantai. */
export function mondayOf(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(iso, -weekday);
}

function stamp(iso) {
  return `${iso}T08:00:00.000+00:00`;
}

/**
 * Vanhan käyttäjän kanta.
 *
 * @param {object} input
 * @param {string} input.todayIso  valjaan kellon päivä
 * @param {string} [input.userId]
 * @returns {{ tables: Record<string, object[]>, ids: object }}
 */
export function legacyUserSeed({ todayIso, userId = LEGACY_USER_ID }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(todayIso))) throw new Error('legacyUserSeed: todayIso puuttuu');
  const monday = mondayOf(todayIso);
  const created = stamp(addDays(monday, -60));
  const buckets = [
    // Rästi: kahden edellisen viikon arkipäivät (ennen tätä maanantaita).
    { key: 'overdue', dates: i => addDays(monday, -14 + (i % 10) + (i % 10 >= 5 ? 2 : 0)) },
    // Tämä viikko: maanantaista sunnuntaihin, myös tänään.
    { key: 'week', dates: i => addDays(monday, i % 7) },
    // Ensi viikko.
    { key: 'next', dates: i => addDays(monday, 7 + (i % 7)) }
  ];
  const tasks = [];
  buckets.forEach((bucket, b) => {
    for (let i = 0; i < 12; i++) {
      const n = b * 12 + i;
      const timed = n % 3 === 0;
      tasks.push({
        id: `e2e-legacy-task-${String(n + 1).padStart(2, '0')}`,
        user_id: userId,
        date: bucket.dates(i),
        time: timed ? `${String(8 + (n % 9)).padStart(2, '0')}:00` : null,
        end_time: null,
        title: `${TITLES[i]} (${n + 1})`,
        category: CATEGORIES[n % CATEGORIES.length],
        note: '',
        completed: false,
        is_wake: false,
        created_at: created,
        updated_at: created,
        description: null,
        duration_minutes: null,
        priority: 'normaali',
        scheduling_state: timed ? 'manual' : 'unscheduled',
        deadline: null,
        goal_id: null,
        project_id: null,
        milestone_id: null,
        depends_on: []
      });
    }
  });

  const goals = [{
    id: LEGACY_GOAL_ID, user_id: userId, title: 'Juoksen puolimaratonin', description: 'Kevään tapahtumaan',
    category: 'hyvinvointi', priority: 'normaali', status: 'active', target_date: addDays(monday, 120),
    progress_mode: 'task_based', manual_progress: 0, parent_goal_id: null, project_id: null,
    metric: null, unit: null, baseline_value: null, current_value: null, target_value: null,
    measured_on: null, savings_goal_id: null, life_area_id: null,
    created_at: created, updated_at: created
  }];
  const projects = [{
    id: LEGACY_PROJECT_ID, user_id: userId, name: 'Treeniohjelma', description: null,
    category: 'hyvinvointi', priority: 'normaali', status: 'active', goal_id: LEGACY_GOAL_ID,
    start_date: addDays(monday, -30), deadline: addDays(monday, 110), milestone_id: null,
    created_at: created, updated_at: created
  }];
  const profile = [{
    id: userId, age: 41, weight_kg: 78, height_cm: 180, sleep_target_hours: 8,
    default_wake_time: '06:45', commute_minutes: 25, routine_minutes: 30,
    created_at: created, updated_at: created
  }];

  return {
    tables: { tasks, goals, projects, profile },
    ids: { goalId: LEGACY_GOAL_ID, projectId: LEGACY_PROJECT_ID, monday }
  };
}

/** Tyhjä kanta (nykyiset skenaariot): vain käyttäjä, ei rivejä. */
export function emptySeed() {
  return { tables: {}, ids: {} };
}

// OMISTAJA (owner): käynnistyssavu (tools/e2e/boot-smoke.mjs) käynnistää
// jokaisen junan ehdokkaan omalla koodillaan tällä kannalla. Sama vanha
// käyttäjä kuin yllä, tuotannon omistajan tunnuksella, ja lisäksi rivit,
// jotka omistajalla on tuotannossa: ilmoitusasetukset (0005; rivi on
// olemassa, koska asetukset on tallennettu) ja yksi hyvinvointimerkintä
// (0006). Sähköposti on tekaistu: savu ei kirjaudu eikä lähetä mitään.

export const OWNER_USER_ID = '2cc00622-f927-4604-a518-361a4328481b';
export const OWNER_EMAIL = 'omistaja-savu@example.invalid';
export const OWNER_COUNTS = Object.freeze({ ...LEGACY_COUNTS, profile: 1, notificationPreferences: 1, wellbeing: 1 });

/**
 * Omistajan kanta käynnistyssavulle.
 *
 * @param {object} input
 * @param {string} input.todayIso  selaimen paikallinen päivä
 * @param {string} [input.userId]
 */
export function ownerSmokeSeed({ todayIso, userId = OWNER_USER_ID }) {
  const { tables, ids } = legacyUserSeed({ todayIso, userId });
  const created = tables.profile[0].created_at;
  const notification_preferences = [{
    id: userId, enabled: true, task_lead_minutes: 10, routine_lead_minutes: 5,
    daily_plan_time: '07:30', evening_review_time: '21:00', daily_plan_enabled: true,
    evening_review_enabled: true, deadline_warnings_enabled: true, max_per_day: 12,
    quiet_hours_from: '22:00', quiet_hours_to: '06:30', created_at: created, updated_at: created
  }];
  const wellbeing_entries = [{
    id: 'e2e-owner-wellbeing-01', user_id: userId, date: addDays(todayIso, -1),
    energy: 3, mood: 4, stress: 2, sleep_hours: 7.5, note: 'Nukuin hyvin',
    created_at: created, updated_at: created
  }];
  return { tables: { ...tables, notification_preferences, wellbeing_entries }, ids: { ...ids, userId } };
}

export const SEEDS = Object.freeze({ legacy: legacyUserSeed, empty: emptySeed, owner: ownerSmokeSeed });
