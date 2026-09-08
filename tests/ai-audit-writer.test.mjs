// AI-kirjausketjun kirjoituspolku.
//
// LÖYDÖS, JOKA TÄMÄN AIHEUTTI
//
// Kirjausketju oli rakennettu kokonaan: taulu, RLS, repositorio,
// rivimuunnos, domain-normalisointi ja pituusrajat. Sovellus jopa
// kirjasi tapahtumat -- mutta VAIN muistiin (`setAiAudit`). Yhtään
// kutsua `aiAuditRepo.insert`-funktioon ei ollut koko lähdepuussa.
//
// Portin avaaminen olisi siis muuttanut yhden luvun muistista kannaksi
// eikä tuottanut yhtään riviä. Kirjausketju olisi näyttänyt
// aktivoidulta ja ollut tyhjä.
//
// SOPIMUS, JOTA NÄMÄ TESTIT VARTIOIVAT
//
//   1. ehdotus kirjataan sekä tilaan että kantaan
//   2. lopputulos päivittää saman rivin, ei luo uutta
//   3. kirjauksen epäonnistuminen EI muuta päätoiminnon lopputulosta
//   4. kantaan ei mene raakaa syötettä, avaimia eikä ylipitkiä kenttiä

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { recordProposal, completeAudit } from '../src/app/aiCommands.js';
import { aiAuditRepo } from '../src/data/collectionsRepo.js';
import { getState, setAiAudit, resetState } from '../src/app/state.js';
import { normalizeAuditEntry, AUDIT_RESULT } from '../src/domain/audit.js';
import { setClient } from '../src/data/client.js';
import { setUser, clearUser } from '../src/data/session.js';
import { read } from './helpers/sources.mjs';
import { fakeClient, isGateOpen } from './helpers/gates.mjs';

const NEWLINE = String.fromCharCode(10);

function proposalWith(overrides = {}) {
  return {
    audit: normalizeAuditEntry({
      id: 'audit-1',
      timestamp: '2026-09-10T08:00:00.000Z',
      intent: 'create_task',
      risk: 'medium',
      targetType: 'task',
      proposal: 'Luodaan tehtävä: Osta maitoa',
      result: AUDIT_RESULT.PROPOSED,
      ...overrides
    })
  };
}

/**
 * Portti ratkaisee, MIHIN kirjaus menee -- ei sitä, meneekö se.
 *
 * Portin ollessa kiinni repositorio kirjoittaa muistivarastoon, auki
 * ollessaan kantaan. Sama kutsu kummassakin. Nämä testit tarkistavat
 * kirjoituksen SISÄLLÖN, joten niiden on luettava se siitä paikasta
 * johon se juuri tässä aallossa päätyi.
 *
 * Ilman tätä testit olisivat vihreitä perustilassa ja punaisia
 * aallossa E -- eli juuri siinä aallossa jota ne koskevat.
 */
const GATE_OPEN = isGateOpen('aiAudit');

function writeRecorder() {
  const client = fakeClient({ data: null, error: null });
  if (GATE_OPEN) setClient(client);

  return {
    async writes() {
      // Kirjaus on tulosta odottamaton, joten annetaan mikrotaskien
      // valmistua ennen lukemista.
      await Promise.resolve();
      await Promise.resolve();

      if (GATE_OPEN) {
        return client.calls
          .filter(call => call.table === 'ai_action_audit')
          .map(call => ({ op: call.operation, row: call.payload }));
      }
      const stored = await aiAuditRepo.memory.list();
      return stored.value.map(entry => ({
        op: 'memory', row: aiAuditRepo.mapping.toRow(entry)
      }));
    }
  };
}

beforeEach(() => {
  resetState();
  setAiAudit([]);
  aiAuditRepo.clear();
  clearUser();
  setClient(null);
});

// =====================================================================
// KIRJAUS MENEE MYÖS KANTAAN
// =====================================================================

test('KRIITTINEN: ehdotus kirjataan sekä tilaan että repositorioon', async () => {
  const recorder = writeRecorder();
  const id = recordProposal(proposalWith());
  assert.equal(id, 'audit-1');

  // Tila saa rivin heti -- käyttöliittymä näyttää sen.
  assert.equal(getState().aiAudit.length, 1);
  assert.equal(getState().aiAudit[0].id, 'audit-1');

  // Ja repositorio saa saman rivin.
  const writes = await recorder.writes();
  assert.equal(writes.length, 1,
    'kirjausta ei kirjoitettu repositorioon lainkaan');
  assert.equal(writes[0].row.id, 'audit-1');
  if (GATE_OPEN) assert.equal(writes[0].op, 'insert');
});

test('KRIITTINEN: lopputulos päivittää saman rivin eikä luo uutta', async () => {
  const recorder = writeRecorder();

  recordProposal(proposalWith());
  await Promise.resolve();
  completeAudit('audit-1', {
    confirmed: true, executed: true, result: AUDIT_RESULT.EXECUTED
  });

  assert.equal(getState().aiAudit.length, 1, 'tilaan syntyi toinen rivi');

  const writes = await recorder.writes();

  if (GATE_OPEN) {
    // Kantapolulla nähdään molemmat kutsut: lisäys ja PÄIVITYS.
    assert.deepEqual(writes.map(w => w.op), ['insert', 'update'],
      'lopputulos ei päivittänyt riviä tai loi uuden');
    for (const write of writes) assert.equal(write.row.id, 'audit-1');
    assert.equal(writes[1].row.executed, true, 'lopputulos ei tallentunut');
    assert.equal(writes[1].row.confirmed, true);
  } else {
    // Muistipolulla nähdään lopputila: yksi rivi, päivitettynä.
    assert.equal(writes.length, 1, 'repositorioon syntyi toinen rivi');
    assert.equal(writes[0].row.executed, true, 'lopputulos ei tallentunut');
    assert.equal(writes[0].row.confirmed, true);
  }
});

// =====================================================================
// KIRJAUS EI SAA KAATAA PÄÄTOIMINTOA
// =====================================================================

test('KRIITTINEN: repositorion virhe ei kaada kirjausta eikä muuta paluuarvoa', async () => {
  // Jos kirjaus saisi kaataa komennon, verkkokatko kirjausta
  // tallennettaessa peruisi käyttäjältä toiminnon joka jo tehtiin.
  const alkuperainen = aiAuditRepo.insert;
  aiAuditRepo.insert = () => Promise.reject(new Error('verkko poikki'));

  try {
    const id = recordProposal(proposalWith());
    assert.equal(id, 'audit-1', 'paluuarvo muuttui kirjauksen virheestä');
    assert.equal(getState().aiAudit.length, 1,
      'tilaan kirjaaminen jäi tekemättä repositorion virheen takia');
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    aiAuditRepo.insert = alkuperainen;
  }
});

test('KRIITTINEN: synkroninen heitto kirjauksessa ei vuoda kutsujalle', async () => {
  const alkuperainen = aiAuditRepo.insert;
  aiAuditRepo.insert = () => { throw new Error('odottamaton'); };

  try {
    assert.doesNotThrow(() => recordProposal(proposalWith()),
      'kirjauksen heitto vuoti päätoiminnolle');
    assert.equal(getState().aiAudit.length, 1);
  } finally {
    aiAuditRepo.insert = alkuperainen;
  }
});

test('KRIITTINEN: fail-tulos kirjauksesta ei muuta päätoiminnon semantiikkaa', async () => {
  const alkuperainen = aiAuditRepo.insert;
  aiAuditRepo.insert = () => Promise.resolve({ ok: false, error: { message: 'RLS' } });

  try {
    const id = recordProposal(proposalWith());
    assert.equal(id, 'audit-1');
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    aiAuditRepo.insert = alkuperainen;
  }
});

test('tunnisteeton ehdotus ei kirjaa mitään', () => {
  assert.equal(recordProposal(null), null);
  assert.equal(recordProposal({}), null);
  assert.equal(getState().aiAudit.length, 0);
});

test('tuntematon tunniste ei luo riviä täydennyksessä', async () => {
  completeAudit('ei-ole', { executed: true });
  await Promise.resolve();

  assert.equal(getState().aiAudit.length, 0);
  const tallennetut = await aiAuditRepo.memory.list();
  assert.equal(tallennetut.value.length, 0);
});

// =====================================================================
// MITÄ KANTAAN MENEE
// =====================================================================

test('KRIITTINEN: kantaan ei mene raakaa syötettä eikä ylipitkiä kenttiä', async () => {
  const recorder = writeRecorder();

  recordProposal(proposalWith({
    id: 'audit-2',
    input: 'x'.repeat(1000),
    proposal: 'y'.repeat(1000)
  }));

  const writes = await recorder.writes();
  assert.equal(writes.length, 1);
  const rivi = writes[0].row;

  assert.ok(rivi.input_summary.length <= 200,
    `tiivistelmä on ${rivi.input_summary.length} merkkiä`);
  assert.ok(rivi.proposal.length <= 300,
    `ehdotus on ${rivi.proposal.length} merkkiä`);
  assert.equal(rivi.input_summary.length === 1000, false,
    'raaka syöte tallentui sellaisenaan');
});

test('KRIITTINEN: kirjoituspolku ei lähetä omistajuutta eikä salaisuuksia', () => {
  // Rivimuunnos on sama jota insert käyttää, joten se kertoo täsmälleen
  // mitä kantaan lähtee.
  const rivi = aiAuditRepo.mapping.toRow(aiAuditRepo.mapping.normalize(
    proposalWith({ id: 'audit-3' }).audit));

  for (const kielletty of ['user_id', 'created_at', 'updated_at',
                           'raw_input', 'prompt', 'response', 'api_key']) {
    assert.equal(Object.prototype.hasOwnProperty.call(rivi, kielletty), false,
      `kirjaus lähettää kentän ${kielletty}`);
  }
});

test('KRIITTINEN: kirjoituspolku on olemassa lähdekoodissa', () => {
  // Aiemmin koko lähdepuussa oli tasan yksi aiAuditRepo-kutsu, ja se
  // oli list(). Tämä testi on se, joka olisi paljastanut sen.
  const koodi = read('src/app/aiCommands.js');

  assert.ok(koodi.includes('aiAuditRepo.insert('),
    'kirjausta ei kirjoiteta repositorioon');
  assert.ok(koodi.includes('aiAuditRepo.update('),
    'lopputulosta ei päivitetä repositorioon');

  // Ja se on tulosta odottamaton: persistAudit ei palauta mitään eikä
  // sitä awaitata kutsupaikoissa.
  assert.ok(koodi.includes('function persistAudit('),
    'kirjaus ei kulje erillisen, virheet nielevän polun kautta');
  assert.equal(/await\s+persistAudit/.test(koodi), false,
    'kirjausta odotetaan -- päätoiminto hidastuu ja voi kaatua siihen');

  const alku = koodi.indexOf('function persistAudit(');
  const runko = koodi.slice(alku, koodi.indexOf(NEWLINE + '}', alku));
  assert.ok(runko.includes('logError'), 'kirjauksen virhe katoaa hiljaa');
  assert.ok(runko.includes('try {'), 'synkroninen heitto vuotaisi kutsujalle');
});
