// profile-taulun käyttö.
//
// profile käyttää mallia id = auth.uid(): yksi rivi per käyttäjä.
// Aiemmin tässä oli kiinteä id='me', jolloin kaikki käyttäjät jakoivat saman
// rivin. Ks. supabase/migrations/0001_auth_user_scoping.sql.

import { getClient } from './client.js';
import { requireUserId } from './session.js';
import { writeRefusal, noteSchemaError } from './schema.js';
import { ok, fail } from '../lib/result.js';
import { DEFAULT_PROFILE } from '../domain/scheduler.js';

const TABLE = 'profile';

/** Kannan rivi -> domain-profiili. Puuttuvat arvot saavat oletukset. */
export function profileFromRow(row) {
  if (!row) return { ...DEFAULT_PROFILE };
  return {
    age: row.age ?? null,
    weightKg: row.weight_kg ?? null,
    heightCm: row.height_cm ?? null,
    sleepTargetHours: row.sleep_target_hours || DEFAULT_PROFILE.sleepTargetHours,
    defaultWakeTime: row.default_wake_time || DEFAULT_PROFILE.defaultWakeTime,
    commuteMinutes: row.commute_minutes ?? DEFAULT_PROFILE.commuteMinutes,
    routineMinutes: row.routine_minutes ?? DEFAULT_PROFILE.routineMinutes
  };
}

/** Domain-profiili -> kannan rivi. Käyttäjän tunniste tulee istunnosta. */
export function profileToRow(profile, userId) {
  return {
    id: userId,
    age: profile.age,
    weight_kg: profile.weightKg,
    height_cm: profile.heightCm,
    sleep_target_hours: profile.sleepTargetHours,
    default_wake_time: profile.defaultWakeTime,
    commute_minutes: profile.commuteMinutes,
    routine_minutes: profile.routineMinutes
  };
}

/**
 * Lataa kirjautuneen käyttäjän profiili.
 * Uudella käyttäjällä ei ole vielä riviä — se ei ole virhe.
 * @returns {Promise<{ok:true,value:{profile:object,exists:boolean}}|{ok:false,error:AppError}>}
 */
export async function loadProfile() {
  try {
    const { data, error } = await getClient()
      .from(TABLE)
      .select('*')
      .eq('id', requireUserId())
      .maybeSingle();

    if (error) {
      noteSchemaError(TABLE, error);
      return fail('Profiilin lataus ei onnistunut.', { cause: error, code: 'profile.load' });
    }
    return ok({ profile: profileFromRow(data), exists: Boolean(data) });
  } catch (cause) {
    return fail('Profiilin lataus ei onnistunut.', { cause, code: 'profile.load' });
  }
}

/**
 * Tallenna profiili.
 * upsert eikä update: uudella käyttäjällä ei ole vielä riviä, ja aiempi
 * update-toteutus epäonnistui siinä tapauksessa hiljaisesti.
 */
export async function saveProfile(profile) {
  // Huoltotila (ydin puuttuu kannasta): ei kirjoiteta, syy kerrotaan.
  const refused = writeRefusal();
  if (refused) return refused;
  try {
    const { error } = await getClient()
      .from(TABLE)
      .upsert(profileToRow(profile, requireUserId()));

    if (error) {
      noteSchemaError(TABLE, error, [], { write: true });
      return fail('Profiilin tallennus ei onnistunut.', { cause: error, code: 'profile.save' });
    }
    return ok(profile);
  } catch (cause) {
    return fail('Profiilin tallennus ei onnistunut.', { cause, code: 'profile.save' });
  }
}
