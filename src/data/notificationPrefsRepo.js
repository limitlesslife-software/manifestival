// Muistutusasetusten tallennus.
//
// Yksi rivi per käyttäjä, kuten profile-taulussa: omistajuus on
// id-sarakkeessa eikä erillisessä user_id-sarakkeessa.
//
// SKEEMAPORTTI
// Taulua ei ole vielä olemassa (migraatio 0005 ajamatta), joten asetukset
// elävät istunnon muistissa. Käyttöliittymä kertoo sen käyttäjälle. Tämä on
// tarkoituksellinen valinta: teeskennelty tallennus olisi pahempi kuin
// puuttuva, koska käyttäjä luulisi säätäneensä muistutuksensa pysyvästi.
//
// TURVALLISUUS: Supabase-polulla rivi rajataan aina requireUserId():llä.
// Omistajuuden asettaa tietokanta (DEFAULT auth.uid()), ei selain.

import { getClient } from './client.js';
import { requireUserId } from './session.js';
import { hasTable } from './schema.js';
import { ok, fail } from '../lib/result.js';
import { normalizePreferences, DEFAULT_PREFERENCES } from '../domain/notification.js';

const TABLE = 'notification_preferences';
const SCHEMA_KEY = 'notificationPreferences';

/** Muistivarasto, kun taulua ei vielä ole. */
let memoryPreferences = null;

/** Säilyvätkö asetukset tallennuksen yli juuri nyt? */
export function isPersistent() {
  return hasTable(SCHEMA_KEY);
}

/** Kannan rivi -> domain. Puuttuvat arvot saavat oletukset. */
export function preferencesFromRow(row) {
  if (!row) return normalizePreferences({});
  return normalizePreferences({
    enabled: row.enabled,
    taskLeadMinutes: row.task_lead_minutes,
    routineLeadMinutes: row.routine_lead_minutes,
    dailyPlanTime: row.daily_plan_time,
    eveningReviewTime: row.evening_review_time,
    dailyPlanEnabled: row.daily_plan_enabled,
    eveningReviewEnabled: row.evening_review_enabled,
    deadlineWarningsEnabled: row.deadline_warnings_enabled,
    maxPerDay: row.max_per_day,
    quietHours: { from: row.quiet_hours_from, to: row.quiet_hours_to }
  });
}

/**
 * Domain -> kannan rivi.
 *
 * `id` on ainoa omistajuuskenttä ja se tulee istunnosta. created_at ja
 * updated_at ovat palvelimen omia — client ei kirjoita niitä koskaan.
 */
export function preferencesToRow(preferences, userId) {
  const prefs = normalizePreferences(preferences);
  return {
    id: userId,
    enabled: prefs.enabled,
    task_lead_minutes: prefs.taskLeadMinutes,
    routine_lead_minutes: prefs.routineLeadMinutes,
    daily_plan_time: prefs.dailyPlanTime,
    evening_review_time: prefs.eveningReviewTime,
    daily_plan_enabled: prefs.dailyPlanEnabled,
    evening_review_enabled: prefs.eveningReviewEnabled,
    deadline_warnings_enabled: prefs.deadlineWarningsEnabled,
    max_per_day: prefs.maxPerDay,
    quiet_hours_from: prefs.quietHours.from,
    quiet_hours_to: prefs.quietHours.to
  };
}

/**
 * Lataa asetukset.
 *
 * Uudella käyttäjällä ei ole riviä — se ei ole virhe vaan tavallisin tila.
 * Oletukset ovat tarkoituksella hiljaiset: `enabled: false`.
 */
export async function loadPreferences() {
  if (!isPersistent()) {
    return ok(memoryPreferences ? { ...memoryPreferences } : normalizePreferences({}));
  }

  try {
    const { data, error } = await getClient()
      .from(TABLE)
      .select('*')
      .eq('id', requireUserId())
      .maybeSingle();

    if (error) {
      return fail('Muistutusasetusten lataus ei onnistunut.',
        { cause: error, code: 'notificationPrefs.load' });
    }
    return ok(preferencesFromRow(data));
  } catch (cause) {
    return fail('Muistutusasetusten lataus ei onnistunut.',
      { cause, code: 'notificationPrefs.load' });
  }
}

/**
 * Tallenna asetukset.
 *
 * upsert eikä update: uudella käyttäjällä ei ole vielä riviä, ja pelkkä
 * update epäonnistuisi siinä tapauksessa hiljaisesti.
 */
export async function savePreferences(preferences) {
  const normalized = normalizePreferences(preferences);

  if (!isPersistent()) {
    memoryPreferences = normalized;
    return ok(normalized);
  }

  try {
    const { error } = await getClient()
      .from(TABLE)
      .upsert(preferencesToRow(normalized, requireUserId()));

    if (error) {
      return fail('Muistutusasetusten tallennus ei onnistunut.',
        { cause: error, code: 'notificationPrefs.save' });
    }
    return ok(normalized);
  } catch (cause) {
    return fail('Muistutusasetusten tallennus ei onnistunut.',
      { cause, code: 'notificationPrefs.save' });
  }
}

/** Tyhjennä muistivarasto. Kutsutaan uloskirjautumisessa. */
export function clearPreferences() {
  memoryPreferences = null;
}

export { DEFAULT_PREFERENCES };
