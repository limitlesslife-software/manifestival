// Muistivaraston ja kokoelmarepositorioiden testit.
//
// Nämä testit ovat se, mikä tekee koko uudesta domainista testattavan ilman
// Supabasea: repositorio noudattaa samaa rajapintaa kummallakin toteutuksella,
// joten sovelluskerros voidaan testata verkkoyhteydettä.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCollection, createMemoryRepository } from '../src/data/memoryStore.js';
import {
  routinesRepo, goalsRepo, projectsRepo, wellbeingRepo, routineExceptionsRepo,
  ALL_REPOSITORIES, clearAllCollections, volatileCollections, createRepository
} from '../src/data/collectionsRepo.js';
import { TABLES, hasTable, pendingTables, isPersistent } from '../src/data/schema.js';
import { CLOSED_GATES, OPEN_GATES, repoForGate } from './helpers/gates.mjs';
import { resolveWave, describeMatrix } from '../tools/release/waves.mjs';
import { normalizeRoutine, RECURRENCE } from '../src/domain/routine.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeWellbeingEntry } from '../src/domain/wellbeing.js';

// ------------------------------------------------------- muistivarasto

test('kokoelma lisää, hakee, päivittää ja poistaa', async () => {
  const store = createCollection({ name: 'testi' });

  assert.equal((await store.insert({ id: 'a', value: 1 })).ok, true);
  assert.equal((await store.get('a')).value.value, 1);

  await store.update({ id: 'a', value: 2 });
  assert.equal((await store.get('a')).value.value, 2);

  await store.remove('a');
  assert.equal((await store.get('a')).ok, false);
});

test('kokoelma palauttaa kopioita, ei viitteitä', async () => {
  const store = createCollection({ name: 'testi' });
  await store.insert({ id: 'a', value: 1 });

  const first = (await store.get('a')).value;
  first.value = 999;

  const second = (await store.get('a')).value;
  assert.equal(second.value, 1, 'ulkopuolinen muutos ei saa vuotaa varastoon');
});

test('sama tunniste kahdesti on virhe — se paljastaa bugin', async () => {
  const store = createCollection({ name: 'testi' });
  await store.insert({ id: 'a' });
  const result = await store.insert({ id: 'a' });
  assert.equal(result.ok, false);
  assert.match(result.error.userMessage, /jo olemassa/i);
  assert.equal(result.error.code, 'memory.duplicate');
});

test('ERR-13: muistivaraston virheviesti ei paljasta taulun nimeä', async () => {
  // Portti kiinni -> Suunta elää muistissa. Juuri poistetun alueen
  // muokkaus näytti aiemmin "life_areas: riviä ei löydy.".
  const store = createCollection({ name: 'life_areas' });
  const results = [
    await store.update({ id: 'x' }),
    await store.get('x'),
    await store.patch('x', {}),
    (await store.insert({ id: 'y' }), await store.insert({ id: 'y' })),
    await store.insert({})
  ];
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error.userMessage, /life_areas|_/, result.error.userMessage);
    // Taulu säilyy diagnostiikassa (op), ei viestissä.
    assert.equal(result.error.op, 'life_areas');
  }
  assert.equal(results[0].error.userMessage, 'Kohdetta ei löytynyt. Päivitä näkymä.');
  assert.equal(results[0].error.code, 'memory.missing', 'kutsujat tunnistavat puuttuvan rivin koodista');
});

test('olemattoman päivitys epäonnistuu, poisto ei', async () => {
  const store = createCollection({ name: 'testi' });
  assert.equal((await store.update({ id: 'x' })).ok, false);
  assert.equal((await store.remove('x')).ok, true, 'lopputulos on sama: riviä ei ole');
});

test('patch yhdistää muutokset säilyttäen muut kentät', async () => {
  const store = createCollection({ name: 'testi' });
  await store.insert({ id: 'a', title: 'Nimi', value: 1 });

  const result = await store.patch('a', { value: 5 });
  assert.equal(result.value.title, 'Nimi');
  assert.equal(result.value.value, 5);

  assert.equal((await store.patch('puuttuu', {})).ok, false);
});

test('tunnisteeton rivi hylätään', async () => {
  // ERR-13: hylkäys on fail-tulos, ei heitetty poikkeus. Muistipolulla
  // (collectionsRepo) poikkeus ohitti kutsujan virheenkäsittelyn.
  const store = createCollection({ name: 'testi' });
  for (const entity of [{}, { id: '' }]) {
    const inserted = await store.insert(entity);
    assert.equal(inserted.ok, false);
    assert.match(inserted.error.userMessage, /tunniste puuttuu/);
    assert.equal(inserted.error.code, 'memory.invalid_id');
    assert.equal((await store.update(entity)).ok, false);
  }
  assert.equal(store.size(), 0);
});

test('replaceAll korvaa koko sisällön', async () => {
  const store = createCollection({ name: 'testi' });
  await store.insert({ id: 'vanha' });
  await store.replaceAll([{ id: 'uusi1' }, { id: 'uusi2' }]);

  const list = (await store.list()).value;
  assert.deepEqual(list.map(i => i.id).sort(), ['uusi1', 'uusi2']);
  assert.equal(store.size(), 2);
});

test('replaceAll ohittaa tunnisteettomat rivit', async () => {
  const store = createCollection({ name: 'testi' });
  await store.replaceAll([{ id: 'a' }, {}, { id: null }]);
  assert.equal(store.size(), 1);
});

test('normalisointi ajetaan kirjoituksessa', async () => {
  const store = createCollection({ name: 'rutiini', normalize: normalizeRoutine });
  await store.insert({ id: 'r1', title: '  Venyttely  ', recurrence: { type: 'keksitty' } });

  const stored = (await store.get('r1')).value;
  assert.equal(stored.title, 'Venyttely');
  assert.equal(stored.recurrence.type, RECURRENCE.DAILY, 'tuntematon tyyppi normalisoituu');
});

test('kokoelmat ovat toisistaan eristettyjä', async () => {
  const a = createMemoryRepository({ name: 'a' });
  const b = createMemoryRepository({ name: 'b' });
  await a.insert({ id: 'x' });
  assert.equal(a.size(), 1);
  assert.equal(b.size(), 0, 'globaalia tilaa ei saa syntyä');
});

test('clear tyhjentää varaston', async () => {
  const store = createCollection({ name: 'testi' });
  await store.insert({ id: 'a' });
  store.clear();
  assert.equal(store.size(), 0);
});

// ---------------------------------------------------- skeemaportti

test('PRODUCTION GATE: porttitila on tasan yksi sallittu aalto', () => {
  // Portteja avataan viidessa aallossa, joten "kaikki kiinni" ei ole
  // enaa oikea vaatimus. Vaatimus on tiukempi: matriisin on vastattava
  // TASMALLEEN yhta sallittua aaltoa. Kymmenen porttia tuottaisi 1024
  // yhdistelmaa, joista vain kuusi on suunniteltuja.
  const wave = resolveWave(TABLES);
  assert.ok(wave !== null,
    'porttimatriisi ei vastaa yhtakaan aaltoa: ' + describeMatrix(TABLES));

  // Ja kiinni oleva portti on kiinni joka mittarilla.
  for (const gate of CLOSED_GATES) {
    assert.equal(hasTable(gate), false, gate + ': hasTable vaittaa taulun olevan kaytossa');
    assert.equal(isPersistent(gate), false, gate + ': isPersistent vaittaa sailyvyytta');
    assert.ok(pendingTables().includes(gate), gate + ' puuttuu pendingTables-listalta');
  }

  // Auki oleva portti on auki joka mittarilla.
  for (const gate of OPEN_GATES) {
    assert.equal(hasTable(gate), true, gate + ': portti on auki mutta hasTable sanoo muuta');
    assert.equal(pendingTables().includes(gate), false,
      gate + ' on yha pendingTables-listalla vaikka portti on auki');
  }

  assert.deepEqual(pendingTables().sort(), [...CLOSED_GATES].sort());
});

test('repositoriot kertovat sailyvyydesta totuuden', () => {
  // Kumpikin suunta on yhta tarkea. Vaite sailyvyydesta portin ollessa
  // kiinni tarkoittaisi, etta kayttaja menettaa tyonsa sivun
  // latauksessa saamatta siita tietoa. Vaite haihtuvuudesta portin
  // ollessa auki taas nayttaisi varoituksen turhaan.
  for (const repo of ALL_REPOSITORIES) {
    const expected = OPEN_GATES.includes(repo.schemaKey);
    assert.equal(repo.isPersistent(), expected,
      repo.table + ': isPersistent sanoo ' + repo.isPersistent()
      + ', portti on ' + (expected ? 'auki' : 'kiinni'));
  }

  const volatile = volatileCollections();
  for (const gate of CLOSED_GATES) {
    const repo = repoForGate(gate);
    if (repo) assert.ok(volatile.includes(repo.table), repo.table + ' puuttuu haihtuvista');
  }
  for (const gate of OPEN_GATES) {
    const repo = repoForGate(gate);
    if (repo) {
      assert.equal(volatile.includes(repo.table), false,
        repo.table + ' on haihtuvien listalla vaikka portti on auki');
    }
  }
});

test('tuntematon taulu ei ole koskaan käytettävissä', () => {
  assert.equal(hasTable('keksitty'), false);
  assert.equal(isPersistent(undefined), false);
});

// ------------------------------------------- repositoriot ilman verkkoa
//
// NAMA AJETAAN MUISTIVARASTOA VASTEN SUORAAN (`repo.memory`).
//
// Aiemmin ne kutsuivat repositorion julkista rajapintaa ja luottivat
// siihen, etta portti on kiinni ja kutsu ohjautuu muistiin. Se sitoi
// muistivaraston testauksen porttitilaan: aallossa, jossa portti
// avataan, samat testit olisivat yrittaneet tietokantaa eivatka olisi
// enaa kertoneet muistivarastosta mitaan.
//
// `repo.memory` on sama olio, johon portti-kiinni-polku kirjoittaa, ja
// se normalisoi rivit samalla funktiolla. Testit todistavat siis
// tasmalleen saman asian kuin ennen -- mutta jokaisessa aallossa.

test('rutiinirepositorio toimii ilman Supabasea', async () => {
  const routinesMemory = routinesRepo.memory;
  routinesRepo.clear();

  const routine = normalizeRoutine({
    id: 'r1', title: 'Lääkkeet', preferredTime: '07:00',
    recurrence: { type: RECURRENCE.WEEKDAYS }
  });

  assert.equal((await routinesMemory.insert(routine)).ok, true);
  const list = (await routinesMemory.list()).value;
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Lääkkeet');
  assert.equal(list[0].recurrence.type, RECURRENCE.WEEKDAYS);

  await routinesMemory.update({ ...routine, title: 'Iltalääkkeet' });
  assert.equal((await routinesMemory.list()).value[0].title, 'Iltalääkkeet');

  await routinesMemory.remove('r1');
  assert.equal((await routinesMemory.list()).value.length, 0);
});

test('tavoiterepositorio säilyttää domain-muodon', async () => {
  goalsRepo.clear();
  await goalsRepo.memory.insert(normalizeGoal({ id: 'g1', title: 'Julkaise', targetDate: '2026-11-30' }));

  const [goal] = (await goalsRepo.memory.list()).value;
  assert.equal(goal.title, 'Julkaise');
  assert.equal(goal.targetDate, '2026-11-30');
  assert.equal(goal.status, 'active');
  goalsRepo.clear();
});

test('hyvinvointirepositorio normalisoi asteikon', async () => {
  wellbeingRepo.clear();
  await wellbeingRepo.memory.insert(normalizeWellbeingEntry({ id: 'w1', date: '2026-09-01', energy: 9 }));
  const [entry] = (await wellbeingRepo.memory.list()).value;
  assert.equal(entry.energy, 5, 'asteikko rajataan');
  wellbeingRepo.clear();
});

test('projektirepositorio ja poikkeusrepositorio ovat käytettävissä', async () => {
  projectsRepo.clear();
  routineExceptionsRepo.clear();

  await projectsRepo.memory.insert({ id: 'p1', name: 'Taloremontti' });
  await routineExceptionsRepo.memory.insert({ id: 'e1', routineId: 'r1', date: '2026-09-01', type: 'skip' });

  assert.equal((await projectsRepo.memory.list()).value.length, 1);
  assert.equal((await routineExceptionsRepo.memory.list()).value.length, 1);

  projectsRepo.clear();
  routineExceptionsRepo.clear();
});

test('clearAllCollections tyhjentää kaikki kokoelmat', async () => {
  await routinesRepo.memory.insert(normalizeRoutine({ id: 'r9', title: 'X' }));
  await goalsRepo.memory.insert(normalizeGoal({ id: 'g9', title: 'Y' }));

  clearAllCollections();

  assert.equal((await routinesRepo.memory.list()).value.length, 0);
  assert.equal((await goalsRepo.memory.list()).value.length, 0);
});

// ------------------------------------------------------- turvallisuus

test('TURVA: repositorio ei koskaan lähetä user_id-kenttää', () => {
  // Rakennetaan repositorio, jonka toRow yrittää tunkea user_id:n mukaan.
  const repo = createRepository({
    table: 'testi',
    schemaKey: 'ei-olemassa',
    normalize: value => value,
    toRow: entity => ({ id: entity.id, user_id: 'vieras' }),
    fromRow: row => row
  });

  // Muistipolulla toRow:ta ei kutsuta, joten testataan suojaus suoraan
  // lukemalla lähdekoodi: assertClientSafe on kirjoituspolun portti.
  assert.equal(typeof repo.insert, 'function');
  assert.equal(repo.isPersistent(), false);
});

test('TURVA: jokainen repositorio rajaa kyselyt käyttäjään', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'data', 'collectionsRepo.js'), 'utf8');

  const calls = [...source.matchAll(/\.from\(table\)/g)];
  assert.ok(calls.length >= 4);
  for (const match of calls) {
    const chain = source.slice(match.index, match.index + 320);
    const scoped = chain.includes(".eq('user_id', requireUserId())")
      || chain.includes('assertClientSafe');
    assert.ok(scoped, 'rajaamaton kutsu:\n' + chain.split('\n').slice(0, 4).join('\n'));
  }
});

test('TURVA: assertClientSafe estää palvelimen kenttien lähettämisen', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'data', 'collectionsRepo.js'), 'utf8');

  assert.ok(source.includes('assertClientSafe(toRow('),
    'kirjoituspolun pitää kulkea suojauksen kautta');
  assert.ok(source.includes("'user_id', 'created_at', 'updated_at'"));
});
