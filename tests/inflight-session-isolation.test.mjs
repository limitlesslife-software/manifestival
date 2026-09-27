// Kesken olevat tekoälypyynnöt eivät ylitä istunnon rajaa.
//
// LÖYTYNYT BUGI, JOTA TÄMÄ TESTI VARTIOI
//
// Suunnitelmaehdotus (/api/plan) ja kuitin tai laskun luenta (/api/extract)
// kestävät sekunteja. Kumpikaan ei ottanut istunnon tilannekuvaa ennen
// odotusta, joten ketju
//
//   1. käyttäjä A pyytää suunnitelmaa ("lopeta tupakointi") tai lukee kuitin
//   2. A:n istunto päättyy (uloskirjautuminen toisessa välilehdessä,
//      tokenin vanheneminen, tilinvaihto)
//   3. käyttäjä B kirjautuu samassa välilehdessä
//   4. A:n vastaus saapuu
//
// kirjoitti A:n ehdotuksen B:n tilaan (pendingPlan / pendingExtraction).
// B näki A:n tavoitteen tai kuitin, ja hyväksyntä tallensi sen B:n tilille.
// Sama tapahtui, vaikka kukaan ei kirjautunut heti: vastaus jäi
// uloskirjautuneeseen tilaan odottamaan seuraavaa kirjautujaa.
//
// Suoja on sama kuin muualla (loadUserData, dailyLifeActions,
// syncNotifications): sessionSnapshot() ennen odotusta, isSameSession()
// sen jälkeen.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { getState, resetState } from '../src/app/state.js';
import { clearLocalUserData, scanImage } from '../src/app/actions.js';
import { requestPlan } from '../src/app/planning.js';
import { read } from './helpers/sources.mjs';

const A = { id: 'aaaaaaaa-0000-0000-0000-00000000000a', email: 'a@example.com' };
const B = { id: 'bbbbbbbb-0000-0000-0000-00000000000b', email: 'b@example.com' };

// ------------------------------------------------ selaimen tyngät kuvalle
//
// prepareImage() pienentää kuvan canvasilla ennen lähetystä. Node ei tunne
// Imagea eikä canvasia, joten ne korvataan pienimmällä mahdollisella.
URL.createObjectURL = () => 'blob:testi';
URL.revokeObjectURL = () => {};
globalThis.Image = class {
  set src(_value) {
    this.naturalWidth = 10;
    this.naturalHeight = 10;
    setImmediate(() => this.onload());
  }
};
globalThis.document = {
  createElement: () => ({
    getContext: () => ({ fillRect() {}, drawImage() {} }),
    toDataURL: () => 'data:image/jpeg;base64,AAAA'
  })
};

/** Vastaus, joka odottaa kunnes testi päästää sen läpi. */
function heldResponse(body) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => {
    await gate;
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(body) }] }) };
  };
  return { fetchImpl, release };
}

const PLAN_BODY = {
  goal: { title: 'Lopeta tupakointi ennen joulua', deadline: '2026-12-20' },
  milestones: [],
  projects: [],
  tasks: [{ ref: 't1', title: 'Soita terveyskeskuksen nikotiinineuvontaan', durationMinutes: 20 }],
  routines: []
};

const RECEIPT_BODY = { merchant: 'Apteekki Kallio', totalMinor: 4590, currency: 'EUR', date: '2026-09-26' };

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

/** Sama järjestys kuin main.js onSignedOut / auth.js SIGNED_OUT. */
function signOut() {
  clearUser();
  clearLocalUserData();
  resetState();
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  const client = fakeClient({ data: [], error: null });
  client.auth = { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) };
  setClient(client);
  setUser(A);
});

// =================================================== suunnitelmaehdotus

test('lähtötilanne: saman istunnon suunnitelmaehdotus menee tarkistettavaksi', async () => {
  const { fetchImpl, release } = heldResponse(PLAN_BODY);
  const pending = requestPlan({ goalText: 'Haluan lopettaa tupakoinnin', fetchImpl });
  await settle();
  release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(getState().pendingPlan.goal.title, 'Lopeta tupakointi ennen joulua');
});

test('REGRESSIO: A:n suunnitelmavastaus ei päädy B:n tarkistettavaksi', async () => {
  const { fetchImpl, release } = heldResponse(PLAN_BODY);
  const pending = requestPlan({ goalText: 'Haluan lopettaa tupakoinnin', fetchImpl });
  await settle();

  signOut();
  setUser(B);
  release();
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.discarded, true, 'hylkäys pitää erottaa virheestä, ettei B näe virheilmoitusta');
  assert.equal(getState().pendingPlan, null, 'A:n tavoite näkyi B:lle');
});

test('REGRESSIO: uloskirjautuneeseen tilaan saapunut suunnitelma ei odota seuraavaa kirjautujaa', async () => {
  const { fetchImpl, release } = heldResponse(PLAN_BODY);
  const pending = requestPlan({ goalText: 'Haluan lopettaa tupakoinnin', fetchImpl });
  await settle();

  signOut();
  release();
  const result = await pending;
  assert.equal(result.discarded, true);
  assert.equal(getState().pendingPlan, null);

  setUser(B);
  assert.equal(getState().pendingPlan, null, 'B näki myöhemmin A:n tavoitteen');
});

test('REGRESSIO: sama käyttäjä ulos ja takaisin ei saa vanhaa ehdotusta (sukupolvi)', async () => {
  const { fetchImpl, release } = heldResponse(PLAN_BODY);
  const pending = requestPlan({ goalText: 'Haluan lopettaa tupakoinnin', fetchImpl });
  await settle();

  signOut();
  setUser(A);
  release();
  const result = await pending;
  assert.equal(result.discarded, true);
  assert.equal(getState().pendingPlan, null);
});

test('suunnittelunäkymä ei näytä virhettä hylätystä vastauksesta', () => {
  const view = read('src/app/views/planning.js');
  assert.match(view, /if \(!result\.ok && !result\.discarded\) showError\(result\.error\);/);
});

// ====================================================== kuitin luenta

test('lähtötilanne: saman istunnon kuittiluenta menee tarkistettavaksi', async () => {
  const { fetchImpl, release } = heldResponse(RECEIPT_BODY);
  globalThis.fetch = fetchImpl;
  const pending = scanImage({ file: { type: 'image/jpeg', size: 1000 }, subject: 'receipt' });
  await settle();
  release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(getState().pendingExtraction.merchant, 'Apteekki Kallio');
});

test('REGRESSIO: A:n kuittiluenta ei päädy B:n tarkistettavaksi', async () => {
  const { fetchImpl, release } = heldResponse(RECEIPT_BODY);
  globalThis.fetch = fetchImpl;
  const pending = scanImage({ file: { type: 'image/jpeg', size: 1000 }, subject: 'receipt' });
  await settle();

  signOut();
  setUser(B);
  release();
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.discarded, true);
  assert.equal(getState().pendingExtraction ?? null, null, 'A:n kuitti näkyi B:lle');
});

test('REGRESSIO: uloskirjautuneeseen tilaan saapunut luenta ei odota seuraavaa kirjautujaa', async () => {
  const { fetchImpl, release } = heldResponse(RECEIPT_BODY);
  globalThis.fetch = fetchImpl;
  const pending = scanImage({ file: { type: 'image/jpeg', size: 1000 }, subject: 'bill' });
  await settle();

  signOut();
  release();
  const result = await pending;
  assert.equal(result.discarded, true);

  setUser(B);
  assert.equal(getState().pendingExtraction ?? null, null, 'B näki myöhemmin A:n laskun');
});

test('tapahtumanäkymä ei näytä virhettä hylätystä luennasta', () => {
  const view = read('src/app/views/transactions.js');
  assert.match(view, /if \(!result\.ok && !result\.discarded\) showError\(result\.error\);/);
});
