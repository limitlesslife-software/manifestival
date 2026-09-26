// Aikakirjausten lähtökori: mikä virhe pitää kirjauksen korissa ja mikä hylkää sen.
//
// VIKA: flush poisti korista kaiken, mikä ei ollut verkko- tai
// istuntovirhe. Hetkellinen 503 (PGRST002, skeemavälimuistin lataus),
// aikakatkaisu (57014) tai kannasta puuttuva sarake (PGRST204) pudotti
// käyttäjän kirjaaman ajan pysyvästi -- vaikka hänelle oli jo kerrottu,
// että aika on tallessa.
//
// SÄÄNTÖ: vain tiedon oma virhe (22xxx, 23xxx paitsi 23505) hylkää.
// Kaikki muu jättää kirjauksen koriin ja pysäyttää lähetyksen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTimeEntryWriter } from '../src/app/timeEntryWriter.js';

const USER_ID = 'dddddddd-5555-4555-8555-000000000001';

function writerWith(errorFor, { persistent = true } = {}) {
  let outbox = [
    { id: 'e1', entryDate: '2026-09-21', minutes: 30, operationId: 'op:e1' },
    { id: 'e2', entryDate: '2026-09-21', minutes: 15, operationId: 'op:e2' }
  ];
  const inserted = [];
  const repo = {
    isPersistent: () => persistent,
    insert: async entry => {
      const error = errorFor(entry);
      if (error) return { ok: false, error: { code: 'time_entries.insert', cause: error } };
      inserted.push(entry.id);
      return { ok: true, value: entry };
    }
  };
  const writer = createTimeEntryWriter({
    repo, userId: () => USER_ID,
    loadOutbox: () => outbox.slice(),
    saveOutbox: (_id, list) => { outbox = list; return { ok: true }; }
  });
  return { writer, outbox: () => outbox, inserted };
}

const KEEP = [
  ['PGRST204 (sarake puuttuu)', { code: 'PGRST204', message: "Could not find the 'operation_id' column", status: 400 }],
  ['PGRST205 (taulu puuttuu)', { code: 'PGRST205', message: "Could not find the table 'public.time_entries'", status: 404 }],
  ['42703', { code: '42703', message: 'column "operation_id" does not exist' }],
  ['PGRST002 (skeemavälimuisti)', { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.', status: 503 }],
  ['PGRST001', { code: 'PGRST001', status: 503 }],
  ['57014 (aikakatkaisu)', { code: '57014', message: 'canceling statement due to statement timeout' }],
  ['53300 (yhteydet loppu)', { code: '53300' }],
  ['503 ilman koodia', { message: 'Service Unavailable', status: 503 }],
  ['sovelluksen torjunta', { code: 'persistence_unavailable', message: 'x' }],
  ['42501', { code: '42501', message: 'permission denied' }]
];

for (const [name, error] of KEEP) {
  test(`KRIITTINEN: ${name} jättää kirjauksen koriin eikä hylkää sitä`, async () => {
    const { writer, outbox, inserted } = writerWith(() => error);
    const result = await writer.flush();
    assert.equal(result.sent, 0);
    assert.equal(result.left, 2);
    assert.deepEqual(result.rejected, []);
    assert.equal(outbox().length, 2, 'kori ennallaan');
    assert.deepEqual(inserted, []);
  });
}

test('suora kirjaus: skeema- tai palvelinvirhe jonottaa kirjauksen (ei virhettä käyttäjälle)', async () => {
  for (const [, error] of KEEP.slice(0, 9)) {
    const { writer, outbox } = writerWith(() => error);
    const result = await writer.insert({ id: 'e3', entryDate: '2026-09-21', minutes: 5, operationId: 'op:e3' });
    assert.deepEqual([result.ok, result.queued], [true, true], JSON.stringify(error));
    assert.equal(outbox().length, 3);
  }
});

test('validointivirhe (23514) hylkää kirjauksen yhä, ja muut lähtevät', async () => {
  const { writer, outbox, inserted } = writerWith(entry => (entry.id === 'e1' ? { code: '23514', message: 'check' } : null));
  const result = await writer.flush();
  assert.equal(result.sent, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].entry.id, 'e1');
  assert.deepEqual(inserted, ['e2']);
  assert.equal(outbox().length, 0);
});

test('arvovirhe (22P02) hylkää; kaksoiskappale (23505) on jo perillä', async () => {
  const { writer, outbox } = writerWith(entry => (entry.id === 'e1'
    ? { code: '22P02', message: 'invalid input syntax' }
    : { code: '23505', message: 'duplicate key' }));
  const result = await writer.flush();
  assert.equal(result.rejected.length, 1);
  assert.equal(result.sent, 1, '23505 lasketaan lähetetyksi');
  assert.equal(outbox().length, 0);
});

test('pysähtyy ensimmäiseen säilytettävään virheeseen ja säilyttää järjestyksen', async () => {
  const { writer, outbox, inserted } = writerWith(entry => (entry.id === 'e1' ? { code: 'PGRST002', status: 503 } : null));
  const result = await writer.flush();
  assert.deepEqual([result.sent, result.left], [0, 2]);
  assert.deepEqual(outbox().map(entry => entry.id), ['e1', 'e2']);
  assert.deepEqual(inserted, []);
});
