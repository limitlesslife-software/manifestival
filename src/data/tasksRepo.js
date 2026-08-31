// tasks-taulun käyttö.
//
// VASTUU: vain tietokanta. Tämä moduuli ei kirjoita DOM:iin, ei renderöi
// eikä muuta sovelluksen tilaa. Se palauttaa tuloksen ja kutsuja päättää
// mitä sillä tehdään. Aiemmin nämä funktiot mutatoivat globaalia tilaa,
// kutsuivat renderAll() ja tekivät verkkokutsun — kolme vastuuta yhdessä.
//
// TURVALLISUUS:
//   - jokainen kysely rajataan requireUserId():llä
//   - user_id:tä ei koskaan lähetetä: kanta asettaa sen (DEFAULT auth.uid())
//   - assertClientSafe() kaataa kutsun, jos kielletty kenttä livahtaisi mukaan

import { getClient } from './client.js';
import { requireUserId } from './session.js';
import { taskColumns } from './schema.js';
import { toRow, fromRow, assertClientSafe } from '../lib/rows.js';
import { ok, fail } from '../lib/result.js';

const TABLE = 'tasks';

/** Rakentaa kirjoitus-payloadin nykyisen skeemakyvykkyyden mukaan. */
function payloadFor(task) {
  return assertClientSafe(toRow(task, taskColumns()));
}

/**
 * Hae kirjautuneen käyttäjän kaikki tehtävät.
 * @returns {Promise<{ok:true,value:Array}|{ok:false,error:AppError}>}
 */
export async function listTasks() {
  try {
    const { data, error } = await getClient()
      .from(TABLE)
      .select('*')
      .eq('user_id', requireUserId());

    if (error) return fail('Tehtävien lataus ei onnistunut.', { cause: error, code: 'tasks.list' });
    return ok((data || []).map(fromRow));
  } catch (cause) {
    return fail('Tehtävien lataus ei onnistunut.', { cause, code: 'tasks.list' });
  }
}

/** Lisää tehtävä. */
export async function insertTask(task) {
  try {
    const { error } = await getClient()
      .from(TABLE)
      .insert(payloadFor(task));

    if (error) return fail('Tehtävän tallennus ei onnistunut.', { cause: error, code: 'tasks.insert' });
    return ok(task);
  } catch (cause) {
    return fail('Tehtävän tallennus ei onnistunut.', { cause, code: 'tasks.insert' });
  }
}

/** Päivitä tehtävä kokonaisuudessaan. */
export async function updateTask(task) {
  try {
    const { error } = await getClient()
      .from(TABLE)
      .update(payloadFor(task))
      .eq('user_id', requireUserId())
      .eq('id', task.id);

    if (error) return fail('Muutoksen tallennus ei onnistunut.', { cause: error, code: 'tasks.update' });
    return ok(task);
  } catch (cause) {
    return fail('Muutoksen tallennus ei onnistunut.', { cause, code: 'tasks.update' });
  }
}

/** Päivitä vain valmis-tila. Kevyempi kuin koko rivin kirjoitus. */
export async function setCompleted(id, completed) {
  try {
    const { error } = await getClient()
      .from(TABLE)
      .update({ completed })
      .eq('user_id', requireUserId())
      .eq('id', id);

    if (error) return fail('Merkinnän tallennus ei onnistunut.', { cause: error, code: 'tasks.complete' });
    return ok({ id, completed });
  } catch (cause) {
    return fail('Merkinnän tallennus ei onnistunut.', { cause, code: 'tasks.complete' });
  }
}

/** Poista tehtävä. */
export async function deleteTask(id) {
  try {
    const { error } = await getClient()
      .from(TABLE)
      .delete()
      .eq('user_id', requireUserId())
      .eq('id', id);

    if (error) return fail('Poisto ei onnistunut.', { cause: error, code: 'tasks.delete' });
    return ok({ id });
  } catch (cause) {
    return fail('Poisto ei onnistunut.', { cause, code: 'tasks.delete' });
  }
}

/**
 * Nollaa herätysmerkintä päivän muilta tehtäviltä.
 * Päivällä voi olla vain yksi herätysankkuri.
 */
export async function clearOtherWakeFlags(dateIso, exceptId) {
  try {
    const { error } = await getClient()
      .from(TABLE)
      .update({ is_wake: false })
      .eq('user_id', requireUserId())
      .eq('date', dateIso)
      .neq('id', exceptId || '');

    if (error) return fail('Herätysmerkinnän päivitys ei onnistunut.', { cause: error, code: 'tasks.wake' });
    return ok(true);
  } catch (cause) {
    return fail('Herätysmerkinnän päivitys ei onnistunut.', { cause, code: 'tasks.wake' });
  }
}
