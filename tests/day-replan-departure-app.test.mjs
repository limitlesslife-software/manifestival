// "Olen 15 min myöhässä" juuri ennen lähtöä sovelluksen kautta: yksi polku
// (src/app/dayReplanActions.js previewDayReplan) Tänään-kortille ja
// komentopalkin puheelle/tekstille.
//
// Keskiviikko 2026-09-30 klo 7.15. Palaveri klo 8 toimistolla: matka 25 min,
// pysäköinti ja kävely 5, perillä 10 min etuajassa (7.50), lähtö 7.20,
// valmistautuminen 15 min (7.05). Päivässä ei ole tehtäviä.
//
// Ennen korjausta vastaus oli "Mitään ei tarvitse siirtää: väljyys riittää"
// ja puhekomento no_change ilman mitään varoitusta.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, installDocument } from './helpers/a11yDom.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { read } from './helpers/sources.mjs';
import { echoClient } from './helpers/a11ySuunta.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import { clearLocalUserData } from '../src/app/actions.js';
import {
  resetState, getState, subscribe, setSavedPlaces, setCalendarEvents, setTasks
} from '../src/app/state.js';
import { resetDailyLifeActions } from '../src/app/dailyLifeActions.js';
import { previewDayReplan } from '../src/app/dayReplanActions.js';
import { runTypedCommand } from '../src/app/commandBar.js';
import { renderToday, initTodayNavigation } from '../src/app/views/today.js';
import { resetTodayDailyLife } from '../src/app/views/todayDailyLife.js';
import { INTERRUPTION_KIND } from '../src/domain/interruptions.js';
import { closeConfirmDialogs } from '../src/ui/confirm.js';
import { clearToasts } from '../src/ui/toast.js';

const INDEX_HTML = read('index.html');
const USER = Object.freeze({ id: 'dddd0005-5555-4555-8555-00000000d0d5', email: 'late@example.invalid' });
const WED = '2026-09-30';

const OFFICE = Object.freeze({
  id: 'p-office', name: 'Toimisto', address: 'Keskuskatu 1, Helsinki', travelMode: 'driving',
  usualTravelMinutes: 25, preparationMinutes: 15, arrivalBufferMinutes: 10, overheadMinutes: 5
});
const MEETING = Object.freeze({
  id: 'e-meet', title: 'Palaveri', date: WED, startTime: '08:00', endTime: '09:00', placeId: OFFICE.id
});

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
};

function seed() {
  setSavedPlaces([OFFICE]);
  setCalendarEvents([MEETING]);
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

test('KRIITTINEN: sovelluksen esikatselu käyttää lähtömoottorin lukuja, ei väitä väljyyden riittävän', t => {
  const now = freezeLocalDate(t, WED, '07:15');
  seed();
  const result = previewDayReplan({ kind: INTERRUPTION_KIND.RUNNING_LATE, minutes: 15 }, { state: getState(), now });
  assert.deepEqual([...result.changes], []);
  assert.equal(result.impacts.length, 1);
  const [impact] = result.impacts;
  assert.equal(impact.kind, 'departure');
  assert.equal(impact.title, 'Palaveri');
  assert.equal(impact.plannedLeaveTime, '07:20');
  assert.equal(impact.leaveTime, '07:35');
  assert.equal(impact.arrivalTime, '08:05');
  assert.equal(impact.startTime, '08:00');
  assert.equal(impact.lateMinutes, 5);
  assert.doesNotMatch(result.summary, /väljyys riittää/);
  assert.match(result.summary, /Ehdit perille noin klo 8\.05, eli myöhästyt noin 5 min/);
  assert.deepEqual(getState().calendarEvents.map(event => event.startTime), ['08:00'], 'meno ei liiku');
});

test('KRIITTINEN: puhe/teksti "olen 15 min myöhässä" kertoo myöhästymisen, ei kysy vahvistusta eikä muuta mitään', async t => {
  const now = freezeLocalDate(t, WED, '07:15');
  const doc = createDocument(INDEX_HTML);
  const uninstall = installDocument(doc);
  t.after(() => { clearToasts(); uninstall(); });
  seed();
  const confirms = [];
  let network = 0;
  const result = await runTypedCommand('olen 15 min myöhässä', {
    source: 'voice',
    now,
    fetchImpl: async () => { network += 1; throw new Error('ei verkkoa'); },
    confirmFn: async proposal => { confirms.push(proposal); return true; },
    chooseFn: async () => null
  });
  assert.equal(result.ok, true);
  assert.equal(result.local, true);
  assert.equal(result.status, 'no_change', 'mitään ei muuteta');
  assert.equal(confirms.length, 0);
  assert.equal(network, 0);
  assert.match(result.reason, /Palaveri klo 8\.00: lähtö myöhästyy 15 min/);
  assert.match(result.reason, /myöhästyt noin 5 min/);
  assert.doesNotMatch(result.reason, /väljyys riittää/);
  const toast = doc.getElementById('toastHost').textContent;
  assert.match(toast, /myöhästyt noin 5 min/, 'käyttäjä näkee sen myös ilman ehdotusta');
});

test('puheen ei-muutosta-vastaus näyttää myös varoitukset (kiinteä kohde, johon myöhästyminen osuu)', async t => {
  const now = freezeLocalDate(t, WED, '11:45');
  const doc = createDocument(INDEX_HTML);
  const uninstall = installDocument(doc);
  t.after(() => { clearToasts(); uninstall(); });
  setTasks([{ id: 't-own', title: 'Oma soitto', date: WED, time: '12:00', endTime: '12:15', schedulingState: 'manual' }]);
  const result = await runTypedCommand('olen 30 min myöhässä', {
    now, fetchImpl: async () => { throw new Error('ei verkkoa'); },
    confirmFn: async () => true, chooseFn: async () => null
  });
  assert.equal(result.status, 'no_change');
  const toast = doc.getElementById('toastHost').textContent;
  assert.match(toast, /Oma soitto klo 12\.00: ehdit vasta noin klo 12\.15, eli myöhästyt noin 15 min/);
  assert.match(toast, /Oma soitto klo 12\.00 on kiinteä, eikä sitä siirretä/);
});

test('Tänään-kortti: pelkkä meno riittää keskeytyskortille, ja ehdotus kertoo myöhästyvän lähdön', async t => {
  freezeLocalDate(t, WED, '07:15');
  // Näkymän päivä luetaan kellosta: tila nollataan vasta jäädytetyllä kellolla.
  clearUser();
  clearAllCollections();
  resetState();
  resetDailyLifeActions();
  resetTodayDailyLife();
  const doc = createDocument(INDEX_HTML);
  const uninstall = installDocument(doc);
  setUser(USER);
  setClient(echoClient());
  doc.getElementById('app').classList.remove('app-hidden');
  initTodayNavigation();
  const unsubscribe = subscribe(() => renderToday());
  t.after(async () => {
    unsubscribe();
    closeConfirmDialogs();
    await flush(4);
    clearToasts();
    resetTodayDailyLife();
    uninstall();
  });
  seed();
  renderToday();
  const card = doc.getElementById('todayInterruptions');
  assert.match(card.textContent, /Jos päivä muuttuu/, 'kortti näkyy, vaikka tehtäviä ei ole');
  card.querySelector('[data-td-action="interrupt"][data-kind="running_late"]').click();
  await flush();
  card.querySelector('[data-minutes="15"]').click();
  await flush();
  const text = card.textContent.replace(/\s+/g, ' ');
  assert.match(text, /Palaveri klo 8\.00: lähtö myöhästyy 15 min, lähdet noin klo 7\.35 \(suunniteltu klo 7\.20\)/);
  assert.match(text, /myöhästyt noin 5 min/);
  assert.doesNotMatch(text, /väljyys riittää/);
  assert.equal(card.querySelector('[data-td-action="replan-apply"]'), null, 'ei muutettavaa: ei "Tee muutokset" -painiketta');
  assert.ok(card.querySelector('[data-td-action="replan-cancel"]'));
});
