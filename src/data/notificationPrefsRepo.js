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
import { hasTable, isTableMissing, writeRefusal, noteSchemaError } from './schema.js';
import { ok, fail, failWith, ERROR_CODE } from '../lib/result.js';
import { normalizePreferences, DEFAULT_PREFERENCES } from '../domain/notification.js';

const TABLE = 'notification_preferences';
const SCHEMA_KEY = 'notificationPreferences';

/** Käyttäjälle: tallennus odottaa, että asetukset on luettu palvelimelta. */
export const PREFERENCES_NOT_LOADED_MESSAGE = 'Muistutusasetuksia ei ole vielä haettu palvelimelta, '
  + 'joten muutosta ei tallennettu. Yritä hetken kuluttua uudelleen.';

/** Muistivarasto, kun taulua ei vielä ole. */
let memoryPreferences = null;

/**
 * Kenen asetukset on luettu kannasta tässä istunnossa (käyttäjän tunniste),
 * tai null.
 *
 * MIKSI: jos taulu todettiin latauksessa puuttuvaksi (ajonaikainen
 * tarkistus tai välimuistin vanha tieto), näkymä sai hiljaiset oletukset.
 * Kun taulu myöhemmin löytyy, oletusten päälle tehty muutos EI saa
 * korvata palvelimella jo olevaa riviä (upsert kirjoittaisi koko rivin).
 */
let serverLoadedFor = null;

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
  // Taulua ei ole kannassa (ajon aikana todettu): hiljaiset oletukset, ei
  // latausvirhettä. Tallennus torjutaan (ks. savePreferences).
  if (isTableMissing(SCHEMA_KEY)) return ok(normalizePreferences({}));

  const loaded = await readServerRow();
  if (!loaded.ok) {
    return fail('Muistutusasetusten lataus ei onnistunut.',
      { cause: loaded.cause, code: 'notificationPrefs.load' });
  }
  serverLoadedFor = loaded.userId;
  return ok(preferencesFromRow(loaded.row));
}

/** Käyttäjän rivi kannasta: { ok, row, userId } tai { ok: false, cause }. Ei heitä. */
async function readServerRow() {
  try {
    const userId = String(requireUserId());
    const { data, error } = await getClient()
      .from(TABLE)
      .select('*')
      .eq('id', requireUserId())
      .maybeSingle();

    if (error) {
      noteSchemaError(TABLE, error);
      return { ok: false, cause: error };
    }
    return { ok: true, row: data || null, userId };
  } catch (cause) {
    return { ok: false, cause };
  }
}

/**
 * Saako tallennus korvata palvelimen rivin? Kyllä, jos asetukset on luettu
 * kannasta tässä istunnossa. Muuten tarkistetaan ensin: jos riviä ei ole,
 * mitään ei korvata (uusi käyttäjä); jos rivi on, tallennus torjutaan --
 * käyttäjän muutos tehtiin oletusten, ei hänen omien asetustensa päälle.
 * Uudelleenlataus (src/app/schemaStatus.js) tuo oikeat asetukset näkyviin.
 */
async function ensureServerBaseline() {
  let userId;
  try { userId = String(requireUserId()); } catch { userId = null; }
  if (userId && serverLoadedFor === userId) return null;
  const loaded = await readServerRow();
  if (!loaded.ok) {
    return fail('Muistutusasetusten tallennus ei onnistunut.',
      { cause: loaded.cause, code: 'notificationPrefs.save' });
  }
  if (loaded.row) return failWith(ERROR_CODE.CONFLICT, PREFERENCES_NOT_LOADED_MESSAGE);
  serverLoadedFor = loaded.userId;
  return null;
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
  // Huoltotila tai kannasta puuttuva taulu: kerrotaan, ei teeskennellä.
  const refused = writeRefusal(SCHEMA_KEY);
  if (refused) return refused;
  // Oletusten päälle tehty muutos ei korvaa palvelimen riviä.
  const unknownBaseline = await ensureServerBaseline();
  if (unknownBaseline) return unknownBaseline;

  try {
    const { error } = await getClient()
      .from(TABLE)
      .upsert(preferencesToRow(normalized, requireUserId()));

    if (error) {
      noteSchemaError(TABLE, error);
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
  serverLoadedFor = null;
}

export { DEFAULT_PREFERENCES };
