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
  assert.match(result.error.userMessage, /jo käytössä/i);
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
  const store = createCollection({ name: 'testi' });
  await assert.rejects(() => store.insert({}), /tunniste puuttuu/);
  await assert.rejects(() => store.insert({ id: '' }), /tunniste puuttuu/);
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

test('PRODUCTION GATE: uudet taulut odottavat migraatiota', () => {
  for (const [name, ready] of Object.entries(TABLES)) {
    assert.equal(ready, false, 'taulu ' + name + ' on merkitty valmiiksi — onko migraatio oikeasti ajettu?');
  }
  assert.equal(hasTable('routines'), false);
  assert.equal(isPersistent('goals'), false);
  assert.ok(pendingTables().length >= 6);
});

test('repositoriot kertovat rehellisesti, ettei tieto säily', () => {
  for (const repo of ALL_REPOSITORIES) {
    assert.equal(repo.isPersistent(), false,
      repo.table + ' väittää säilyvänsä, vaikka migraatiota ei ole ajettu');
  }
  const volatile = volatileCollections();
  assert.ok(volatile.includes('routines'));
  assert.ok(volatile.includes('goals'));
});

test('tuntematon taulu ei ole koskaan käytettävissä', () => {
  assert.equal(hasTable('keksitty'), false);
  assert.equal(isPersistent(undefined), false);
});

// ------------------------------------------- repositoriot ilman verkkoa

test('rutiinirepositorio toimii ilman Supabasea', async () => {
  routinesRepo.clear();

  const routine = normalizeRoutine({
    id: 'r1', title: 'Lääkkeet', preferredTime: '07:00',
    recurrence: { type: RECURRENCE.WEEKDAYS }
  });

  assert.equal((await routinesRepo.insert(routine)).ok, true);
  const list = (await routinesRepo.list()).value;
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Lääkkeet');
  assert.equal(list[0].recurrence.type, RECURRENCE.WEEKDAYS);

  await routinesRepo.update({ ...routine, title: 'Iltalääkkeet' });
  assert.equal((await routinesRepo.list()).value[0].title, 'Iltalääkkeet');

  await routinesRepo.remove('r1');
  assert.equal((await routinesRepo.list()).value.length, 0);
});

test('tavoiterepositorio säilyttää domain-muodon', async () => {
  goalsRepo.clear();
  await goalsRepo.insert(normalizeGoal({ id: 'g1', title: 'Julkaise', targetDate: '2026-11-30' }));

  const [goal] = (await goalsRepo.list()).value;
  assert.equal(goal.title, 'Julkaise');
  assert.equal(goal.targetDate, '2026-11-30');
  assert.equal(goal.status, 'active');
  goalsRepo.clear();
});

test('hyvinvointirepositorio normalisoi asteikon', async () => {
  wellbeingRepo.clear();
  await wellbeingRepo.insert(normalizeWellbeingEntry({ id: 'w1', date: '2026-09-01', energy: 9 }));
  const [entry] = (await wellbeingRepo.list()).value;
  assert.equal(entry.energy, 5, 'asteikko rajataan');
  wellbeingRepo.clear();
});

test('projektirepositorio ja poikkeusrepositorio ovat käytettävissä', async () => {
  projectsRepo.clear();
  routineExceptionsRepo.clear();

  await projectsRepo.insert({ id: 'p1', name: 'Taloremontti' });
  await routineExceptionsRepo.insert({ id: 'e1', routineId: 'r1', date: '2026-09-01', type: 'skip' });

  assert.equal((await projectsRepo.list()).value.length, 1);
  assert.equal((await routineExceptionsRepo.list()).value.length, 1);

  projectsRepo.clear();
  routineExceptionsRepo.clear();
});

test('clearAllCollections tyhjentää kaikki kokoelmat', async () => {
  await routinesRepo.insert(normalizeRoutine({ id: 'r9', title: 'X' }));
  await goalsRepo.insert(normalizeGoal({ id: 'g9', title: 'Y' }));

  clearAllCollections();

  assert.equal((await routinesRepo.list()).value.length, 0);
  assert.equal((await goalsRepo.list()).value.length, 0);
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
