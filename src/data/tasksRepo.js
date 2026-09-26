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
import { taskColumns, writeRefusal, noteSchemaError, COMPILE_COLUMN_GATES } from './schema.js';
import { normalizeTask } from '../domain/task.js';
import {
  toRow, fromRow, assertClientSafe, sameColumnValue, pgArrayLiteral
} from '../lib/rows.js';
import { ok, fail } from '../lib/result.js';

const TABLE = 'tasks';

// AJONAIKAINEN SKEEMATARKISTUS (src/data/schema.js):
//   - huoltotilassa (kannan ydin puuttuu) jokainen kirjoitus torjutaan
//     ENNEN verkkokutsua (writeRefusal), ja syy kerrotaan käyttäjälle
//   - skeemavirhe (PGRST204/42703) laskee sen sarakeportin, jolle puuttuva
//     sarake kuuluu (noteSchemaError); seuraava kirjoitus lähtee ilman sitä,
//     koska payloadFor laskee sarakejoukon joka kerta uudelleen
//   - kirjoitus kertoo olevansa kirjoitus ({ write: true } tai payloadin
//     avaimet): sen skeemavirhe on pysyvä istunnon ajan, lukemisen ei

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

    if (error) {
      noteSchemaError(TABLE, error);
      return fail('Tehtävien lataus ei onnistunut.', { cause: error, code: 'tasks.list' });
    }
    return ok((data || []).map(fromRow));
  } catch (cause) {
    return fail('Tehtävien lataus ei onnistunut.', { cause, code: 'tasks.list' });
  }
}

/**
 * Lisää tehtävä.
 *
 * Payload (ja sen sarakejoukko) rakennetaan synkronisesti ennen
 * ensimmäistä odotusta: offline-jono laskee juuri ennen kutsua, mitkä
 * kentät lisäys jättää pois (unwritableInsert), ja luottaa siihen, että
 * kyvykkyys ei ehdi muuttua välissä.
 */
export async function insertTask(task) {
  const refused = writeRefusal();
  if (refused) return refused;
  try {
    const { error } = await getClient()
      .from(TABLE)
      .insert(payloadFor(task));

    if (error) {
      noteSchemaError(TABLE, error, [], { write: true });
      return fail('Tehtävän tallennus ei onnistunut.', { cause: error, code: 'tasks.insert' });
    }
    return ok(task);
  } catch (cause) {
    return fail('Tehtävän tallennus ei onnistunut.', { cause, code: 'tasks.insert' });
  }
}

/** Päivitä tehtävä kokonaisuudessaan. */
export async function updateTask(task) {
  const refused = writeRefusal();
  if (refused) return refused;
  try {
    const { error } = await getClient()
      .from(TABLE)
      .update(payloadFor(task))
      .eq('user_id', requireUserId())
      .eq('id', task.id);

    if (error) {
      noteSchemaError(TABLE, error, [], { write: true });
      return fail('Muutoksen tallennus ei onnistunut.', { cause: error, code: 'tasks.update' });
    }
    return ok(task);
  } catch (cause) {
    return fail('Muutoksen tallennus ei onnistunut.', { cause, code: 'tasks.update' });
  }
}

/** Päivitä vain valmis-tila. Kevyempi kuin koko rivin kirjoitus. */
export async function setCompleted(id, completed) {
  const refused = writeRefusal();
  if (refused) return refused;
  try {
    const { error } = await getClient()
      .from(TABLE)
      .update({ completed })
      .eq('user_id', requireUserId())
      .eq('id', id);

    if (error) {
      noteSchemaError(TABLE, error, [], { write: true });
      return fail('Merkinnän tallennus ei onnistunut.', { cause: error, code: 'tasks.complete' });
    }
    return ok({ id, completed });
  } catch (cause) {
    return fail('Merkinnän tallennus ei onnistunut.', { cause, code: 'tasks.complete' });
  }
}

/** Poista tehtävä. */
export async function deleteTask(id) {
  const refused = writeRefusal();
  if (refused) return refused;
  try {
    const { error } = await getClient()
      .from(TABLE)
      .delete()
      .eq('user_id', requireUserId())
      .eq('id', id);

    if (error) {
      noteSchemaError(TABLE, error, [], { write: true });
      return fail('Poisto ei onnistunut.', { cause: error, code: 'tasks.delete' });
    }
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
  const refused = writeRefusal();
  if (refused) return refused;
  try {
    const { error } = await getClient()
      .from(TABLE)
      .update({ is_wake: false })
      .eq('user_id', requireUserId())
      .eq('date', dateIso)
      .neq('id', exceptId || '');

    if (error) {
      noteSchemaError(TABLE, error, [], { write: true });
      return fail('Herätysmerkinnän päivitys ei onnistunut.', { cause: error, code: 'tasks.wake' });
    }
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

    if (error) {
      noteSchemaError(TABLE, error);
      return fail('Tehtävän haku ei onnistunut.', { cause: error, code: 'tasks.get' });
    }
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

/** Sarakkeet, jotka tämä käännös kirjoittaisi, jos kanta tukisi kaikkea. */
const compileTaskColumns = () => taskColumns(gate => COMPILE_COLUMN_GATES[gate] === true);

/**
 * Muutoksen kentät, joita EI voi nyt kirjoittaa, koska kanta on käännöstä
 * jäljessä: jokainen sarake, johon kentän muutos osuisi, kuuluu ajon
 * aikana laskettuun sarakeporttiin.
 *
 * Sarakejoukko johdetaan rivimuunnoksesta (ei omaa kenttä -> sarake
 * -taulukkoa). Kenttä, jonka muutos osuu myös kirjoitettavaan sarakkeeseen
 * (esim. loppuaika muuttaa johdettua kestoa), on kirjoitettava.
 * Käännösaikaisesti kiinni oleva portti ei ole "odottava": sen kentät
 * elävät tarkoituksella vain istunnon muistissa (ks. schema.js).
 *
 * @param {object} changes muuttuvat domain-kentät
 * @param {object} expected rivi, jonka päälle muutos tehdään
 * @param {ReadonlyArray<string>} [columns] kirjoitettavat sarakkeet (testejä varten)
 * @returns {string[]} kentät
 */
export function unwritableTaskFields(changes, expected, columns = taskColumns()) {
  const compiled = compileTaskColumns();
  const base = payloadFor({ ...expected }, compiled);
  const out = [];
  for (const field of Object.keys(changes || {})) {
    const row = payloadFor({ ...expected, [field]: changes[field] }, compiled);
    const touched = Object.keys(row)
      .filter(column => column !== 'id' && !sameColumnValue(row[column], base[column]));
    if (touched.length > 0 && touched.every(column => !columns.includes(column))) out.push(field);
  }
  return out;
}

/**
 * Lisäyksen kentät, jotka EIVÄT tallennu, koska kanta on käännöstä
 * jäljessä (ajon aikana laskettu sarakeportti), ja tehtävä sellaisena kuin
 * kanta sen tallentaa: pois jätetyt sarakkeet saavat oletusarvonsa.
 *
 * Sama johdettu sääntö kuin unwritableTaskFields, lähtökohtana tallentuva
 * rivi: kenttä odottaa, jos sen arvo poikkeaa tallentuvasta ja ero osuu
 * vain laskettuihin sarakkeisiin. Offline-jono pitää ne odottamassa eikä
 * raportoi lisäystä kokonaan onnistuneeksi.
 *
 * @param {object} task lisättävä tehtävä
 * @param {ReadonlyArray<string>} [columns] kirjoitettavat sarakkeet (testejä varten)
 * @returns {{fields: string[], stored: object}}
 */
export function unwritableInsert(task, columns = taskColumns()) {
  const normalized = normalizeTask(task);
  const stored = normalizeTask(fromRow(payloadFor(normalized, columns)));
  return { fields: unwritableTaskFields(normalized, stored, columns), stored };
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
 * `unwritable` kertoo kentät, joita ei kirjoitettu, koska kanta ei vielä
 * tue niitä (ajon aikana laskettu portti). Ne EIVÄT ole tallentuneet,
 * vaikka `applied` olisi true: kutsuja pitää ne odottamassa (offline-jono)
 * eikä raportoi niitä onnistuneiksi.
 *
 * @returns {Promise<{ok:true,value:{applied:boolean,noop:boolean,unwritable:string[]}}|{ok:false,error:object}>}
 */
export async function patchTask(id, changes, expected) {
  const refused = writeRefusal();
  if (refused) return refused;
  try {
    const unwritable = unwritableTaskFields(changes, { ...expected, id });
    const { diff, guards } = partialPayloadFor({ ...expected, ...changes, id }, { ...expected, id });
    if (Object.keys(diff).length === 0) return ok({ applied: true, noop: true, unwritable });

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
    if (error) {
      noteSchemaError(TABLE, error, Object.keys(diff));
      return fail('Muutoksen tallennus ei onnistunut.', { cause: error, code: 'tasks.patch' });
    }
    return ok({ applied: Array.isArray(data) && data.length > 0, noop: false, unwritable });
  } catch (cause) {
    return fail('Muutoksen tallennus ei onnistunut.', { cause, code: 'tasks.patch' });
  }
}
