// Tilin poiston vahvistusvirta: tilakone, asiakas ja käyttöliittymän invariantit.
//
// EI OIKEAA POISTOA. Asiakas testataan injektoidulla fetchillä, ja
// tilakone on puhdas. Käyttöliittymämoduulin DOM-osuutta ei suoriteta
// (ei selainta) -- sen turvaominaisuudet todistetaan lähdetekstistä,
// kuten muuallakin tässä repossa (security-invariants.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';
import {
  FLOW, FLOW_EVENT, DELETION_PHRASE, initialFlowState, nextFlowState, confirmationStatus
} from '../src/domain/accountDeletionFlow.js';
import {
  ACCOUNT_DOMAIN_LABELS, domainLabel, authAccountDeletable, dryRunDeletion,
  PREVIEW_ROW_STATE, serverPreviewRows, summarizePreview, previewRowValue
} from '../src/domain/accountLifecycle.js';
import { EXPORTED_COLLECTIONS } from '../src/domain/dataExport.js';
import { ACCOUNT_DELETION, SUPABASE_URL } from '../src/data/config.js';
import {
  previewAccountDeletion, executeAccountDeletion, deletionErrorMessage
} from '../src/data/accountDeletionClient.js';
import { CONFIRMATION_PHRASE } from '../supabase/functions/delete-account/handler.js';

const READY = { endpointEnabled: true, previewSeen: true, confirmationReady: true };

function walk(events, context = READY, start = initialFlowState()) {
  return events.reduce((state, event) => nextFlowState(state, event, context), start);
}

// ------------------------------------------------------------- tilakone

test('KRIITTINEN: vahvistuslause on sama selaimessa ja palvelimella', () => {
  assert.equal(DELETION_PHRASE, CONFIRMATION_PHRASE);
});

test('normaali polku: idle -> preview -> confirm -> deleting -> done', () => {
  const steps = [];
  let state = initialFlowState();
  for (const event of [FLOW_EVENT.OPEN_PREVIEW, FLOW_EVENT.BEGIN_CONFIRM, FLOW_EVENT.SUBMIT, FLOW_EVENT.SUCCEEDED]) {
    state = nextFlowState(state, event, READY);
    steps.push(state.step);
  }
  assert.deepEqual(steps, [FLOW.PREVIEW, FLOW.CONFIRM, FLOW.DELETING, FLOW.DONE]);
});

test('KRIITTINEN: yksittäinen SUBMIT ei koskaan käynnistä poistoa suoraan lähtötilasta', () => {
  for (const step of [FLOW.IDLE, FLOW.PREVIEW, FLOW.DONE, FLOW.FAILED, FLOW.REAUTH]) {
    const state = nextFlowState({ step, errorCode: null }, FLOW_EVENT.SUBMIT, READY);
    assert.notEqual(state.step, FLOW.DELETING, step);
  }
  assert.equal(nextFlowState(initialFlowState(), FLOW_EVENT.SUBMIT, READY).step, FLOW.IDLE);
});

test('KRIITTINEN: poisto ei käynnisty ilman jokaista ehtoa erikseen', () => {
  const confirming = { step: FLOW.CONFIRM, errorCode: null };
  for (const missing of ['endpointEnabled', 'previewSeen', 'confirmationReady']) {
    const context = { ...READY, [missing]: false };
    assert.equal(nextFlowState(confirming, FLOW_EVENT.SUBMIT, context).step, FLOW.CONFIRM, missing);
    const undefinedContext = { ...READY };
    delete undefinedContext[missing];
    assert.equal(nextFlowState(confirming, FLOW_EVENT.SUBMIT, undefinedContext).step, FLOW.CONFIRM, missing + ' puuttuu');
  }
  // Epätosi-arvot, jotka eivät ole true: ei saa läpäistä.
  for (const value of [1, 'true', {}, [], null]) {
    assert.equal(nextFlowState(confirming, FLOW_EVENT.SUBMIT, { ...READY, confirmationReady: value }).step, FLOW.CONFIRM);
  }
});

test('KRIITTINEN: kun palvelinpoisto ei ole käytössä, CONFIRM-vaiheeseen ei päästä', () => {
  const state = walk([FLOW_EVENT.OPEN_PREVIEW, FLOW_EVENT.BEGIN_CONFIRM, FLOW_EVENT.SUBMIT],
    { ...READY, endpointEnabled: false });
  assert.equal(state.step, FLOW.PREVIEW);
});

test('tuplaklikkaus: toinen SUBMIT DELETING-tilassa ei tee mitään', () => {
  const deleting = { step: FLOW.DELETING, errorCode: null };
  assert.equal(nextFlowState(deleting, FLOW_EVENT.SUBMIT, READY), deleting);
});

test('poistoa ei voi perua kesken eikä valmiina', () => {
  for (const step of [FLOW.DELETING, FLOW.DONE]) {
    const state = { step, errorCode: null };
    assert.equal(nextFlowState(state, FLOW_EVENT.CANCEL, READY).step, step);
  }
  for (const step of [FLOW.PREVIEW, FLOW.CONFIRM, FLOW.FAILED, FLOW.REAUTH]) {
    assert.equal(nextFlowState({ step, errorCode: null }, FLOW_EVENT.CANCEL, READY).step, FLOW.IDLE);
  }
});

test('tulokset hyväksytään vain kesken poiston', () => {
  for (const event of [FLOW_EVENT.SUCCEEDED, FLOW_EVENT.FAILED, FLOW_EVENT.NEEDS_REAUTH]) {
    for (const step of [FLOW.IDLE, FLOW.PREVIEW, FLOW.CONFIRM]) {
      assert.equal(nextFlowState({ step, errorCode: null }, event, READY).step, step, `${event} @ ${step}`);
    }
  }
});

test('epäonnistuminen säilyttää virhekoodin ja sallii uudelleenyrityksen vahvistukseen', () => {
  let state = walk([FLOW_EVENT.OPEN_PREVIEW, FLOW_EVENT.BEGIN_CONFIRM, FLOW_EVENT.SUBMIT]);
  state = nextFlowState(state, FLOW_EVENT.FAILED, { errorCode: 'network' });
  assert.deepEqual(state, { step: FLOW.FAILED, errorCode: 'network' });
  state = nextFlowState(state, FLOW_EVENT.RETRY, READY);
  assert.equal(state.step, FLOW.CONFIRM, 'uusi yritys vaatii uuden vahvistuksen, ei suoraan DELETING');
});

test('tuore kirjautuminen vaaditaan -> REAUTH, mitään ei poistettu', () => {
  const state = walk([FLOW_EVENT.OPEN_PREVIEW, FLOW_EVENT.BEGIN_CONFIRM, FLOW_EVENT.SUBMIT, FLOW_EVENT.NEEDS_REAUTH]);
  assert.equal(state.step, FLOW.REAUTH);
  assert.equal(state.errorCode, 'recent_login_required');
});

test('tuntematon tapahtuma ja rikkinäinen tila eivät kaada eivätkä etene', () => {
  assert.equal(nextFlowState(initialFlowState(), 'poista_heti', READY).step, FLOW.IDLE);
  assert.equal(nextFlowState(undefined, FLOW_EVENT.OPEN_PREVIEW, READY).step, FLOW.PREVIEW);
  assert.equal(nextFlowState(null, FLOW_EVENT.SUBMIT, READY).step, FLOW.IDLE);
  assert.equal(nextFlowState({}, FLOW_EVENT.SUBMIT, READY).step, FLOW.IDLE);
});

// ---------------------------------------------------------- vahvistus

test('confirmationStatus: sähköposti kirjainkoosta riippumatta, lause täsmälleen', () => {
  const base = { expectedEmail: 'Alice@Example.com' };
  assert.equal(confirmationStatus({ ...base, emailInput: ' alice@example.COM ', phraseInput: ` ${DELETION_PHRASE} ` }).ready, true);
  assert.equal(confirmationStatus({ ...base, emailInput: 'alice@example.com', phraseInput: 'poista tilini' }).ready, false);
  assert.equal(confirmationStatus({ ...base, emailInput: 'muu@example.com', phraseInput: DELETION_PHRASE }).ready, false);
  assert.equal(confirmationStatus({ ...base, emailInput: '', phraseInput: DELETION_PHRASE }).ready, false);
  assert.equal(confirmationStatus({ ...base, emailInput: 'alice@example.com', phraseInput: '' }).ready, false);
  assert.equal(confirmationStatus({ ...base }).ready, false);
});

test('confirmationStatus: tili ilman sähköpostia vaatii vain lauseen', () => {
  assert.equal(confirmationStatus({ expectedEmail: null, phraseInput: DELETION_PHRASE }).ready, true);
  assert.equal(confirmationStatus({ expectedEmail: '', phraseInput: 'x' }).ready, false);
});

// ------------------------------------------------ kyvykkyys ja esikatselu

test('KRIITTINEN: palvelinpoisto on oletuksena pois päältä eikä domain väitä muuta', () => {
  assert.equal(ACCOUNT_DELETION.endpointEnabled, false,
    'endpointEnabled saa olla true vasta kun funktio on oikeasti deployattu ja testattu (omistajan päätös)');
  assert.equal(authAccountDeletable(), false);
  assert.equal(authAccountDeletable(false), false);
  for (const value of [1, 'true', {}, undefined, null]) assert.equal(authAccountDeletable(value), false);
  assert.equal(authAccountDeletable(true), true);
});

test('dryRunDeletion: estosyy näkyy kun poisto ei ole käytössä, poistuu kun on', () => {
  assert.equal(dryRunDeletion({}).blockers.length, 1);
  assert.equal(dryRunDeletion({}, { endpointEnabled: true }).blockers.length, 0);
});

// ------------------------------------ palvelimen esikatselu: mitään ei pudoteta

const SERVER_DOMAINS = [
  { domain: 'tasks', rowCount: 5, action: 'delete', blockedReason: null, present: true },
  { domain: 'goals', rowCount: 0, action: 'delete', blockedReason: null, present: true },
  { domain: 'bills', rowCount: null, action: 'delete', blockedReason: 'count_failed', present: null },
  { domain: 'timeEntries', rowCount: 0, action: 'delete', blockedReason: null, present: false },
  { domain: 'lifeAreas', rowCount: 0, action: 'delete', blockedReason: null, present: false }
];

test('KRIITTINEN: palvelimen esikatselu ei pudota laskematonta eikä puuttuvaa kokoelmaa', () => {
  const rows = serverPreviewRows(SERVER_DOMAINS);
  assert.equal(rows.length, SERVER_DOMAINS.length, 'jokainen kokoelma on rivi');
  assert.deepEqual(rows.find(row => row.name === 'bills'), { name: 'bills', count: null, state: PREVIEW_ROW_STATE.FAILED });
  assert.deepEqual(rows.find(row => row.name === 'timeEntries'), { name: 'timeEntries', count: 0, state: PREVIEW_ROW_STATE.ABSENT });
  assert.deepEqual(rows.find(row => row.name === 'tasks'), { name: 'tasks', count: 5, state: PREVIEW_ROW_STATE.COUNTED });

  const summary = summarizePreview(rows);
  assert.deepEqual(summary.rows.map(row => row.name), ['tasks', 'bills'],
    'rivejä sisältävät ja laskemattomat näkyvät, nollat eivät');
  assert.deepEqual(summary.absent, ['timeEntries', 'lifeAreas']);
  assert.equal(summary.total, 5);
  assert.equal(summary.partial, true, 'laskematon kokoelma tekee summasta alarajan');

  assert.equal(previewRowValue(rows.find(row => row.name === 'bills')), 'ei voitu laskea');
  assert.equal(previewRowValue(rows.find(row => row.name === 'timeEntries')), 'ei käytössä');
  assert.equal(previewRowValue(rows.find(row => row.name === 'tasks')), '5');
});

test('esikatselu: vanhan muotoinen vastaus (ei present-kenttää) ja rikkinäiset rivit', () => {
  const rows = serverPreviewRows([
    { domain: 'tasks', rowCount: 3, blockedReason: null },
    { domain: 'goals', rowCount: null, blockedReason: 'count_failed' },
    { domain: 'bills', rowCount: -1, blockedReason: null },
    null, { rowCount: 1 }
  ]);
  assert.deepEqual(rows.map(row => [row.name, row.state]), [
    ['tasks', PREVIEW_ROW_STATE.COUNTED], ['goals', PREVIEW_ROW_STATE.FAILED], ['bills', PREVIEW_ROW_STATE.FAILED]
  ]);
  assert.deepEqual(serverPreviewRows(undefined), []);
});

test('esikatselu: paikallisen kuiva-ajon rivit ovat laskettuja, summa ei ole alaraja', () => {
  const local = dryRunDeletion({ tasks: [{}, {}], goals: [] }).collections;
  const summary = summarizePreview(local);
  assert.equal(summary.total, 2);
  assert.equal(summary.partial, false);
  assert.deepEqual(summary.rows.map(row => row.name), ['tasks']);
  assert.deepEqual(summary.absent, []);
});

test('KRIITTINEN: käyttöliittymä näyttää laskemattomat ja puuttuvat eikä suodata niitä pois', () => {
  const ui = readCode('src/app/accountDeletion.js');
  assert.match(ui, /previewRows = serverPreviewRows\(result\.value\.domains\)/);
  assert.equal(/\.filter\(entry => Number\.isInteger\(entry\.rowCount\)\)/.test(ui), false,
    'laskematon kokoelma ei saa kadota esikatselusta');
  const rowsFn = ui.slice(ui.indexOf('function rowsHtml'), ui.indexOf('function previewHtml'));
  assert.match(rowsFn, /previewRowValue\(row\)/, 'rivin arvo kertoo tilan (ei käytössä / ei voitu laskea)');
  assert.match(rowsFn, /summary\.absent/, 'puuttuvat taulut luetellaan');
  assert.match(ui, /summary\.partial \? 'vähintään ' : ''/, 'osittainen summa ei väitä kokonaismäärää');
});

test('jokaisella inventaarion kokoelmalla on käyttäjälle näytettävä nimi', () => {
  assert.deepEqual(Object.keys(ACCOUNT_DOMAIN_LABELS).sort(), [...EXPORTED_COLLECTIONS].sort());
  for (const name of EXPORTED_COLLECTIONS) {
    assert.match(domainLabel(name), /\S/);
    assert.notEqual(domainLabel(name), name, `${name}: raaka tekninen nimi ei kelpaa`);
  }
  assert.equal(domainLabel('__proto__'), '__proto__');
  assert.equal(domainLabel('constructor'), 'constructor');
});

// -------------------------------------------------------------- asiakas

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  impl.calls = calls;
  return impl;
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('KRIITTINEN: lippu pois -> ei verkkokutsua, rehellinen "ei käytössä"', async () => {
  const fetchImpl = fakeFetch(() => json(200, { ok: true }));
  for (const call of [
    () => previewAccountDeletion({ accessToken: 't', fetchImpl }),
    () => executeAccountDeletion({ accessToken: 't', confirmEmail: 'a@b.fi', confirmPhrase: DELETION_PHRASE, fetchImpl })
  ]) {
    const result = await call();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'accountDeletion.unavailable');
    assert.equal(result.error.userMessage, deletionErrorMessage('unavailable'));
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('ilman tokenia ei tehdä kutsua', async () => {
  const fetchImpl = fakeFetch(() => json(200, { ok: true }));
  const result = await executeAccountDeletion({ accessToken: null, enabled: true, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('KRIITTINEN: pyyntö on POST oikeaan funktioon, vain sallituilla kentillä, tokenilla otsikossa', async () => {
  const fetchImpl = fakeFetch(() => json(200, { ok: true, deleted: true, complete: true }));
  const result = await executeAccountDeletion({
    accessToken: 'tok.en.value', confirmEmail: 'a@b.fi', confirmPhrase: DELETION_PHRASE, enabled: true, fetchImpl
  });
  assert.equal(result.ok, true);

  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, `${SUPABASE_URL}/functions/v1/${ACCOUNT_DELETION.functionName}`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer tok.en.value');
  assert.deepEqual(JSON.parse(init.body), { mode: 'delete', confirmEmail: 'a@b.fi', confirmPhrase: DELETION_PHRASE });
  assert.equal(/userId|user_id/.test(init.body), false, 'käyttäjätunnistetta ei lähetetä -- palvelin johtaa sen tokenista');
});

test('esikatselu lähettää vain mode=dry_run', async () => {
  const fetchImpl = fakeFetch(() => json(200, { ok: true, domains: [] }));
  await previewAccountDeletion({ accessToken: 'tok.en.value', enabled: true, fetchImpl });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { mode: 'dry_run' });
});

test('palvelimen virhekoodit kääntyvät omiksi viesteiksi, palvelimen tekstiä ei näytetä', async () => {
  for (const [status, code, expected] of [
    [401, 'auth_invalid', 'auth_invalid'],
    [403, 'recent_login_required', 'recent_login_required'],
    [400, 'confirmation_mismatch', 'confirmation_mismatch'],
    [500, 'auth_delete_failed', 'auth_delete_failed'],
    [500, 'jokin_tuntematon', 'internal']
  ]) {
    const fetchImpl = fakeFetch(() => json(status, { ok: false, error: { code, message: 'SISÄINEN salaisuus sb_secret_X' } }));
    const result = await executeAccountDeletion({ accessToken: 'tok.en.value', enabled: true, fetchImpl, confirmPhrase: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'accountDeletion.' + expected);
    assert.equal(result.error.userMessage, deletionErrorMessage(expected));
    assert.equal(result.error.userMessage.includes('salaisuus'), false);
  }
});

test('verkko- ja aikakatkaisuvirheet ovat erillisiä eivätkä väitä onnistumista', async () => {
  const network = await executeAccountDeletion({
    accessToken: 'tok.en.value', enabled: true, fetchImpl: async () => { throw new Error('ECONNRESET'); }
  });
  assert.equal(network.error.code, 'accountDeletion.network');

  const timeout = await executeAccountDeletion({
    accessToken: 'tok.en.value', enabled: true,
    fetchImpl: async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; }
  });
  assert.equal(timeout.error.code, 'accountDeletion.timeout');
});

test('KRIITTINEN: 200 ilman ok:true tai ei-JSON-vastaus ei ole onnistuminen', async () => {
  for (const response of [
    json(200, {}),
    json(200, { ok: false }),
    json(200, null),
    { ok: true, status: 200, json: async () => { throw new Error('ei json'); } }
  ]) {
    const result = await executeAccountDeletion({
      accessToken: 'tok.en.value', enabled: true, fetchImpl: async () => response
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'accountDeletion.bad_response');
  }
});

test('deletionErrorMessage: tuntematon koodi (myös prototyyppinimi) antaa yleisen viestin', () => {
  assert.equal(deletionErrorMessage('constructor'), deletionErrorMessage('internal'));
  assert.equal(deletionErrorMessage(undefined), deletionErrorMessage('internal'));
});

// ---------------------------------------- käyttöliittymän lähdeinvariantit

test('KRIITTINEN: käyttöliittymä ei kutsu poistoa ilman lopullista dialogia ja tilakoneen SUBMIT-lukkoa', () => {
  const ui = readCode('src/app/accountDeletion.js');
  const confirmAt = ui.indexOf('confirmAction(');
  const submitAt = ui.indexOf('FLOW_EVENT.SUBMIT');
  const executeAt = ui.indexOf('executeAccountDeletion({');
  assert.ok(confirmAt > -1 && submitAt > -1 && executeAt > -1);
  assert.ok(confirmAt < submitAt, 'lopullinen vahvistus pitää kysyä ennen SUBMIT-siirtymää');
  assert.ok(submitAt < executeAt, 'SUBMIT-lukko pitää läpäistä ennen palvelinkutsua');
  assert.ok(ui.includes('destructive: true'), 'lopullinen dialogi on tuhoava');
});

test('poistopainike on oletuksena pois päältä, Enter ei laukaise poistoa, ja tuplaklikkaus on suojattu', () => {
  const ui = read('src/app/accountDeletion.js');
  assert.match(ui, /id="pfDeletionSubmitBtn"[^>]*disabled aria-disabled="true"/);
  assert.match(ui, /event\.key === 'Enter'\) event\.preventDefault\(\)/);
  assert.ok(ui.includes('singleFlight('), 'submit pitää olla suojattu tuplaklikkaukselta');
});

test('käyttöliittymä puhdistaa paikallisen tilan ja kirjautuu ulos onnistuneen poiston jälkeen', () => {
  const ui = read('src/app/accountDeletion.js');
  assert.ok(ui.includes("signOut({ scope: 'local' })"));
  assert.ok(ui.includes('clearLocalUserData()'), 'varapolku siivoaa tilan vaikka uloskirjautuminen epäonnistuu');
  assert.ok(ui.includes('queueAuthNote('), 'päätetila kerrotaan käyttäjälle uloskirjautumisen jälkeen');
  assert.ok(ui.includes('complete'), 'epätäydellinen jälkitarkistus ei saa näyttää täydeltä onnistumiselta');
});

test('KRIITTINEN: selainkoodissa ei ole korotettua avainta eikä funktion koodia', () => {
  for (const file of ['src/app/accountDeletion.js', 'src/data/accountDeletionClient.js', 'src/domain/accountDeletionFlow.js', 'src/data/config.js']) {
    const text = read(file);
    assert.equal(/service_role|SERVICE_ROLE|SUPABASE_SECRET|sb_secret_/.test(text), false, file);
  }
});

test('profiilinäkymä delegoi poiston eikä sisällä omaa poistologiikkaa', () => {
  const profile = read('src/app/views/profile.js');
  assert.ok(profile.includes('renderAccountDeletionSection'));
  assert.equal(profile.includes('dryRunDeletion'), false);
  assert.equal(profile.includes('executeAccountDeletion'), false);
});
