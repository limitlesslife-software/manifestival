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
import { normalizeTask } from '../domain/task.js';
import {
  toRow, fromRow, assertClientSafe, sameColumnValue, pgArrayLiteral
} from '../lib/rows.js';
import { ok, fail } from '../lib/result.js';

const TABLE = 'tasks';

/**
 * Rakentaa kirjoitus-payloadin nykyisen skeemakyvykkyyden mukaan.
 *
 * NORMALISOINTI TEHDÄÄN TÄÄLLÄ, EI KUTSUPAIKASSA.
 *
 * Aiemmin tämä luotti siihen, että jokainen kutsuja on ajanut
 * normalizeTaskin. Se piti paikkansa, mutta se oli sopimus eikä rakenne:
 * mikään ei estänyt uutta kutsupaikkaa rakentamasta tehtäväoliota käsin.
 * Migraation 0002 jälkeen se ei ole enää tyylikysymys — `priority` ja
 * `scheduling_state` ovat NOT NULL, ja toRow lähettäisi normalisoimatta
 * jääneestä oliosta nimenomaisen nullin. Nimenomainen null EI ota
 * sarakkeen oletusarvoa käyttöön: kanta hylkää rivin, ja JOKAINEN
 * tallennus epäonnistuisi.
 *
 * normalizeTask ei heitä koskaan ja on idempotentti, joten sen ajaminen
 * uudelleen jo normalisoidulle oliolle ei muuta mitään. Sama malli on
 * käytössä kaikissa muissa repositorioissa (collectionsRepo).
 */
function payloadFor(task, columns = taskColumns()) {
  return assertClientSafe(toRow(normalizeTask(task), columns));
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

/**
 * Hae yksi tehtävä tunnisteella. `value` on null, jos riviä ei ole.
 * Käytetään offline-jonon toistossa: palvelimen nykytila ennen kirjoitusta.
 */
export async function getTask(id) {
  try {
    const { data, error } = await getClient()
      .from(TABLE)
      .select('*')
      .eq('user_id', requireUserId())
      .eq('id', id)
      .maybeSingle();

    if (error) return fail('Tehtävän haku ei onnistunut.', { cause: error, code: 'tasks.get' });
    return ok(data ? fromRow(data) : null);
  } catch (cause) {
    return fail('Tehtävän haku ei onnistunut.', { cause, code: 'tasks.get' });
  }
}

/**
 * Osittainen kirjoitus: vain sarakkeet, jotka poikkeavat toisistaan.
 *
 * Molemmat puolet kulkevat payloadForin kautta (skeemaportti, normalisointi
 * ja assertClientSafe), joten erotus ei voi sisältää saraketta, jota koko
 * rivin kirjoitus ei saisi lähettää. `guards` kertoo jokaisen muuttuvan
 * sarakkeen nykyarvon ehdollista kirjoitusta varten.
 *
 * Taulukkosarakkeet (depends_on) verrataan arvoina (sameColumnValue):
 * identiteettivertailu teki jokaisesta taulukosta "muuttuneen", jolloin
 * pelkkä otsikon muutos lähetti myös depends_on-sarakkeen ja käytti sitä
 * vertailuehtona. `columns` on testejä varten; oletus on portin mukainen.
 */
export function partialPayloadFor(next, current, columns = taskColumns()) {
  const nextRow = payloadFor(next, columns);
  const currentRow = payloadFor(current, columns);
  const diff = {};
  const guards = {};
  for (const column of Object.keys(nextRow)) {
    if (column === 'id') continue;
    if (!sameColumnValue(nextRow[column], currentRow[column])) {
      diff[column] = nextRow[column];
      guards[column] = currentRow[column] === undefined ? null : currentRow[column];
    }
  }
  return { diff, guards };
}

/**
 * Ehdollisen kirjoituksen vertailuehto yhdelle sarakkeelle.
 *
 *   null      -> is null
 *   taulukko  -> eq PostgreSQL-taulukkoliteraalina ({"a","b"})
 *   muu       -> eq arvona
 *
 * Taulukko suoraan `.eq`:lle muuttuisi URL:ssa muotoon `sarake=eq.` ja
 * kanta vastaisi 22P02 — jokainen offline-muokkauksen toisto kaatuisi
 * aallosta G alkaen.
 */
export function guardFilter(value) {
  if (value === null || value === undefined) return ['is', null];
  if (Array.isArray(value)) return ['eq', pgArrayLiteral(value)];
  return ['eq', value];
}

/**
 * Päivitä vain muuttuneet sarakkeet EHDOLLISESTI (compare-and-set).
 *
 * `expected` on rivi sellaisena kuin kutsuja sen juuri luki. Jokainen
 * muuttuva sarake ehdollistetaan siihen, että se on yhä `expected`-arvossaan
 * -- jos joku ehti muuttaa sitä lukemisen ja kirjoituksen välissä,
 * yhtään riviä ei päivity (`applied: false`) eikä palvelimen uudempaa
 * arvoa ylikirjoiteta. Erotus laskee mikä oikeasti muuttuu.
 *
 * @returns {Promise<{ok:true,value:{applied:boolean,noop:boolean}}|{ok:false,error:object}>}
 */
export async function patchTask(id, changes, expected) {
  try {
    const { diff, guards } = partialPayloadFor({ ...expected, ...changes, id }, { ...expected, id });
    if (Object.keys(diff).length === 0) return ok({ applied: true, noop: true });

    let query = getClient()
      .from(TABLE)
      .update(diff)
      .eq('user_id', requireUserId())
      .eq('id', id);
    for (const [column, value] of Object.entries(guards)) {
      const [method, arg] = guardFilter(value);
      query = query[method](column, arg);
    }

    const { data, error } = await query.select('id');
    if (error) return fail('Muutoksen tallennus ei onnistunut.', { cause: error, code: 'tasks.patch' });
    return ok({ applied: Array.isArray(data) && data.length > 0, noop: false });
  } catch (cause) {
    return fail('Muutoksen tallennus ei onnistunut.', { cause, code: 'tasks.patch' });
  }
}
