// TESTIKÄYTTÖÖN: tallennusvarasto, joka toimii kummallakin porttitilalla.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Tuotehaaralla portit ovat kiinni: repositoriot kirjoittavat
// muistivarastoon, ja testit lukivat tallennetun rivin `repo.memory`:stä.
// Julkaisuehdokkaassa (aalto K) kaikki portit ovat auki: sama toiminto
// kirjoittaa Supabase-asiakkaalle, jota testissä ei ole, ja jokainen
// tallennus epäonnistuu. Testi todistaisi silloin vain puuttuvasta
// kannasta -- ei siitä, mitä sen piti todistaa.
//
// Tämä asentaa auki olevalle portille muistinvaraisen Supabase-tyylisen
// palvelimen (multiTableServer.mjs) ja lukee tallennetun rivin siitä
// varastosta, jota repositorio oikeasti käyttää: kiinni olevalla portilla
// muistista, auki olevalla palvelimelta kannan rivinä (repo.mapping.fromRow).
// Kiinni olevalla portilla mikään ei muutu: asiakasta ei aseteta, joten
// testi ajaa täsmälleen saman polun kuin ennenkin.
//
// Sääntö (tests/helpers/gates.mjs): sama testi syvenee itsestään, kun
// portti kääntyy.

import { getUser } from '../../src/data/session.js';
import { setClient } from '../../src/data/client.js';
import { ALL_REPOSITORIES } from '../../src/data/collectionsRepo.js';
import { createMultiTableServer } from './multiTableServer.mjs';

/** Yksi palvelin testitiedostoa kohti; nollataan joka testissä. */
export const testStore = createMultiTableServer(() => getUser()?.id ?? null);

/** Onko yksikin repositorio kantapolulla (portti auki)? */
export const anyGateOpen = () => ALL_REPOSITORIES.some(repo => repo.isPersistent());

/**
 * Tyhjennä palvelin ja asenna se asiakkaaksi, jos yksikin portti on auki.
 * Kiinni olevalla portilla asiakasta ei kosketa (sama polku kuin ennen).
 *
 * @param {object} [client] kääre palvelimen ympärille (esim. pidätetty haku)
 */
export function resetTestStore(client = testStore) {
  testStore.reset();
  if (anyGateOpen()) setClient(client);
  return testStore;
}

/**
 * Tallennetut rivit domain-muodossa siitä varastosta, jota repositorio
 * käyttää. Muistivarasto ei erottele käyttäjiä, joten palvelinkaan ei.
 */
export async function storedRows(repo) {
  if (!repo.isPersistent()) return (await repo.memory.list()).value;
  return testStore.rows(repo.table).map(row => repo.mapping.fromRow({ ...row }));
}

/** Yksi tallennettu rivi tunnisteella, tai null. */
export async function storedRow(repo, id) {
  if (!repo.isPersistent()) return (await repo.memory.get(id)).value ?? null;
  return (await storedRows(repo)).find(row => String(row.id) === String(id)) ?? null;
}

/**
 * Korvaa taulun tallennetut rivit (kuten `repo.memory.replaceAll`).
 * Auki olevalla portilla rivit kulkevat repositorion omaa kirjoituspolkua
 * (`repo.insert`) palvelimelle, joten siemen on sama rivi, jonka sovellus
 * itse kirjoittaisi. Vaatii kirjautuneen käyttäjän (setUser).
 */
export async function seedStored(repo, rows) {
  if (!repo.isPersistent()) {
    await repo.memory.replaceAll(rows);
    return;
  }
  testStore.rows(repo.table).splice(0);
  for (const row of rows) {
    const result = await repo.insert(row);
    if (!result.ok) throw new Error(`${repo.table}: siemenrivi ${row.id} hylättiin (${result.error?.message})`);
  }
}

/**
 * Toinen laite muutti rivin: tallennus muuttuu, tämän laitteen tila ei.
 * Kiinni olevalla portilla muistirivi, auki olevalla kannan rivi
 * (repositorion omalla rivimuunnoksella, omistaja säilyy).
 */
export async function writeFromOtherDevice(repo, entity) {
  const normalized = repo.mapping.normalize(entity);
  if (!repo.isPersistent()) {
    const result = await repo.memory.update(normalized);
    if (!result.ok) throw new Error(`${repo.table}: toisen laitteen muutos ei osunut riviin ${normalized.id}`);
    return;
  }
  const row = testStore.rows(repo.table).find(r => String(r.id) === String(normalized.id));
  if (!row) throw new Error(`${repo.table}: toisen laitteen muutos ei osunut riviin ${normalized.id}`);
  Object.assign(row, repo.mapping.toRow(normalized));
}
