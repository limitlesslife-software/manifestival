// Paikalliset komennot ennen tekoälyä (src/app/localCommands.js) kirjoitettuna
// ja puhuttuna (src/app/commandBar.js runTypedCommand).
//
//   "Lisää parturi ensi tiistaille klo 16"  -> meno kalenteriin ilman tekoälyä
//   "Teatteri lauantaina seitsemältä"       -> kysytään: klo 7 vai klo 19
//   "olen 10 min myöhässä"                  -> päivän muutosehdotus, vahvistus, toteutus
//
// Vahvistus- ja valintadialogit injektoidaan (confirmFn, chooseFn) kuten
// command-bar.test.mjs:ssä. fetchImpl heittää: paikallinen polku ei saa
// koskaan kutsua verkkoa.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { clearLocalUserData } from '../src/app/actions.js';
import {
  resetState, getState, setTasks, setSavedPlaces, setPlaceAliases, setRoutines
} from '../src/app/state.js';
import { setClient } from '../src/data/client.js';
import { placeAliasesRepo } from '../src/data/collectionsRepo.js';
import { fakeClient } from './helpers/gates.mjs';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeRoutine, RECURRENCE } from '../src/domain/routine.js';
import { runTypedCommand } from '../src/app/commandBar.js';
import { runLocalCommand, previewInterruption } from '../src/app/localCommands.js';
import { readCode } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';

const USER = { id: 'aaaaaaaa-9999-4000-8000-000000000009', email: 'v@example.com' };
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);
const MONDAY = at(2026, 9, 28, 12, 0); // maanantai 28.9.2026

let network = 0;
const offlineFetch = async () => { network += 1; throw new Error('ei verkkoa'); };

function ui({ accept = true, choose = null } = {}) {
  const seen = { confirms: [], choices: [], phases: [] };
  return {
    seen,
    options: {
      fetchImpl: offlineFetch,
      now: MONDAY,
      onPhase: phase => seen.phases.push(phase),
      confirmFn: async proposal => { seen.confirms.push(proposal); return accept; },
      chooseFn: async (candidates, question) => {
        seen.choices.push({ candidates, question });
        return typeof choose === 'function' ? choose(candidates, question) : null;
      }
    }
  };
}

beforeEach(() => {
  network = 0;
  clearUser();
  clearLocalUserData();
  resetState();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

// ------------------------------------------------------------ menon luonti

test('selvä lause: meno kalenteriin ilman tekoälyä ja ilman verkkoa, tarkistuksen kautta', async t => {
  freezeLocalDate(t, '2026-09-28');
  const { seen, options } = ui();
  const result = await runTypedCommand('Lisää parturi ensi tiistaille klo 16', options);
  assert.equal(result.ok, true);
  assert.equal(result.local, true);
  assert.equal(result.kind, 'create_event');
  assert.equal(network, 0, 'paikallinen komento ei kutsu verkkoa');
  assert.equal(seen.confirms.length, 1, 'aina tarkistus ennen tallennusta');
  assert.equal(seen.choices.length, 0, 'selvästä ei kysytä');
  const preview = seen.confirms[0].preview;
  assert.equal(preview.destructive, false);
  assert.ok(preview.changes.some(row => row.label === 'Aika' && /klo 16\.00/.test(row.after)));

  const [event] = getState().calendarEvents;
  assert.equal(event.title, 'Parturi');
  // Jäsentimen tulkinta: maanantaina 'ensi tiistai' on huominen (src/domain/fiTemporal.js).
  assert.equal(event.date, '2026-09-29');
  assert.equal(event.startTime, '16:00');
  assert.equal(event.allDay, false);
  assert.ok(seen.phases.indexOf('confirmation') < seen.phases.indexOf('executing'));
});

test('KRIITTINEN: peruttu tarkistus ei tallenna mitään', async t => {
  freezeLocalDate(t, '2026-09-28');
  const { options } = ui({ accept: false });
  const result = await runTypedCommand('Lisää parturi ensi tiistaille klo 16', options);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(getState().calendarEvents, []);
});

test('epäselvä kellonaika kysytään (klo 7 vai 19), ei arvata', async t => {
  freezeLocalDate(t, '2026-09-28');
  const { seen, options } = ui({ choose: candidates => candidates.find(c => c.id === '19:00') });
  const result = await runTypedCommand('Teatteri lauantaina seitsemältä', options);
  assert.equal(result.ok, true);
  assert.equal(seen.choices.length, 1);
  assert.deepEqual(seen.choices[0].candidates.map(c => c.id).sort(), ['07:00', '19:00']);
  assert.match(seen.choices[0].question, /klo 7 vai klo 19/);
  const [event] = getState().calendarEvents;
  assert.equal(event.startTime, '19:00');
  assert.equal(event.date, '2026-10-03');
});

test('epäselvän kysymyksen peruminen ei tallenna eikä kysy tekoälyltä', async t => {
  freezeLocalDate(t, '2026-09-28');
  const { options } = ui({ choose: () => null });
  const result = await runTypedCommand('Teatteri lauantaina seitsemältä', options);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(getState().calendarEvents, []);
  assert.equal(network, 0);
});

test('puuttuva päivä kysytään valintana (tänään / huomenna), kesto päättää loppuajan', async t => {
  freezeLocalDate(t, '2026-09-28');
  const { seen, options } = ui({ choose: candidates => candidates[1] });
  const result = await runTypedCommand('Lisää hammaslääkäri klo 9.30 kestää tunnin', options);
  assert.equal(result.ok, true);
  assert.deepEqual(seen.choices[0].candidates.map(c => c.id), ['2026-09-28', '2026-09-29']);
  const [event] = getState().calendarEvents;
  assert.deepEqual([event.date, event.startTime, event.endTime], ['2026-09-29', '09:30', '10:30']);
});

test('tallennettu paikka tunnistetaan; epäselvä nimi kysytään ja nimitys opitaan vasta hyväksynnän jälkeen', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([
    { id: 'pe', name: 'Motonet Espoo', usualTravelMinutes: 25 },
    { id: 'pv', name: 'Motonet Vantaa', usualTravelMinutes: 30 }
  ]);
  const { seen, options } = ui({ choose: candidates => candidates.find(c => c.id === 'pv') });
  const result = await runTypedCommand('Lisää renkaanvaihto Motonetissa huomenna klo 10', options);
  assert.equal(result.ok, true);
  const placeQuestion = seen.choices.find(choice => choice.candidates.some(c => c.id === 'pv'));
  assert.ok(placeQuestion, 'paikasta kysyttiin');
  assert.deepEqual(placeQuestion.candidates.map(c => c.label).sort(), ['Motonet Espoo', 'Motonet Vantaa']);
  const [event] = getState().calendarEvents;
  assert.equal(event.placeId, 'pv');
  assert.equal(event.locationText, null);
  const aliases = getState().placeAliases;
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].placeId, 'pv');
  assert.equal(aliases[0].alias, 'motonetissa');
});

test('peruttu meno ei opeta paikan nimitystä', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([
    { id: 'pe', name: 'Motonet Espoo' }, { id: 'pv', name: 'Motonet Vantaa' }
  ]);
  const { options } = ui({ accept: false, choose: candidates => candidates.find(c => c.id === 'pv') });
  await runTypedCommand('Lisää renkaanvaihto Motonetissa huomenna klo 10', options);
  assert.deepEqual(getState().placeAliases, []);
});

test('opittu nimitys vahvistuu hyväksytyssä menossa; paikan oma nimi ei ole nimitys', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([{ id: 'pk', name: 'Kamppi' }]);
  const alias = { id: 'a1', placeId: 'pk', alias: 'salille', confirmations: 2 };
  setPlaceAliases([alias]);
  await placeAliasesRepo.insert(alias);
  const { options } = ui();
  await runTypedCommand('Lisää treeni salille huomenna klo 18', options);
  const [event] = getState().calendarEvents;
  assert.equal(event.placeId, 'pk');
  assert.equal(getState().placeAliases.find(a => a.id === 'a1').confirmations, 3);

  await runTypedCommand('Lisää kahvi Kampissa huomenna klo 12', options);
  assert.equal(getState().placeAliases.length, 1, 'paikan omaa nimeä ei tallenneta nimitykseksi');
});

// ------------------------------------------------------------ tekoäly ja turva

test('tuhoava lause ei koskaan kulje paikallisesti: se menee tekoälyn vahvistettuun polkuun', async t => {
  freezeLocalDate(t, '2026-09-28');
  const { seen, options } = ui();
  const result = await runTypedCommand('poista huominen parturi', options);
  assert.equal(result.local, undefined);
  assert.equal(network, 1, 'tekoälyn putki yritettiin');
  assert.equal(result.status, 'error', 'verkkovirhe ei tuota arvattua komentoa');
  assert.equal(seen.confirms.length, 0);
});

test('tehtävälause ei ole meno: tekoäly hoitaa sen kuten ennenkin', async () => {
  const result = await runLocalCommand('luo tehtävä ostaa maitoa huomenna', { confirmFn: async () => true, chooseFn: async () => null }, { now: MONDAY });
  assert.equal(result, null);
});

test('puhuttu komento kulkee saman paikallisen polun (source voice)', async t => {
  freezeLocalDate(t, '2026-09-28');
  const { seen, options } = ui();
  const result = await runTypedCommand('lisää palaveri huomenna kello 14', { ...options, source: 'voice' });
  assert.equal(result.ok, true);
  assert.equal(result.local, true);
  assert.equal(seen.confirms.length, 1);
  assert.equal(getState().calendarEvents[0].startTime, '14:00');
});

// ------------------------------------------------------------ keskeytys

function flexibleTask(id, time, minutes = 30) {
  return normalizeTask({
    id, title: `Työ ${id}`, date: '2026-09-28', time, durationMinutes: minutes, schedulingState: 'auto', completed: false
  });
}

test('"olen 10 min myöhässä": ehdotus näytetään, hyväksyntä siirtää joustavan tehtävän', async t => {
  freezeLocalDate(t, '2026-09-28');
  setTasks([flexibleTask('t1', '12:05'), normalizeTask({
    id: 'm1', title: 'Oma kiinteä', date: '2026-09-28', time: '15:00', durationMinutes: 30, schedulingState: 'manual'
  })]);
  const { seen, options } = ui();
  const result = await runTypedCommand('olen 10 min myöhässä', options);
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'interruption');
  assert.equal(seen.confirms.length, 1);
  const rows = seen.confirms[0].preview.changes;
  assert.ok(rows.some(row => row.label === 'Työ t1'));
  const moved = getState().tasks.find(task => task.id === 't1');
  assert.notEqual(moved.time, '12:05', 'joustava tehtävä siirtyi');
  assert.equal(moved.schedulingState, 'auto', 'siirto ei tee joustavasta kiinteää');
  assert.equal(getState().tasks.find(task => task.id === 'm1').time, '15:00', 'itse ajastettu ei liiku');
});

test('keskeytyksen peruminen ei muuta mitään', async t => {
  freezeLocalDate(t, '2026-09-28');
  setTasks([flexibleTask('t1', '12:05')]);
  const { options } = ui({ accept: false });
  const result = await runTypedCommand('olen 10 min myöhässä', options);
  assert.equal(result.status, 'cancelled');
  assert.equal(getState().tasks[0].time, '12:05');
});

test('määrä puuttuu ("olen myöhässä"): kysytään, ei arvata', async t => {
  freezeLocalDate(t, '2026-09-28');
  setTasks([flexibleTask('t1', '12:05')]);
  const { seen, options } = ui({ choose: candidates => candidates.find(c => c.id === '15') });
  const result = await runTypedCommand('olen myöhässä', options);
  assert.equal(seen.choices.length, 1);
  assert.match(seen.choices[0].question, /myöhässä/);
  assert.equal(result.ok, true);
});

test('rutiinin kerran ohitus toteutetaan rutiinin omalla toiminnolla', async t => {
  freezeLocalDate(t, '2026-09-28');
  setRoutines([normalizeRoutine({
    id: 'r1', title: 'Lenkki', active: true, recurrence: { type: RECURRENCE.DAILY, weekdays: [] },
    durationMinutes: 45
  })]);
  // Joustava rutiini (ei kiinteää kellonaikaa): ohitus on tämän päivän kerta.
  const preview = previewInterruption({ kind: 'skip_item', minutes: null, targetText: 'lenkin', toDate: null, onDate: null },
    { now: MONDAY });
  const skip = preview.changes.find(change => change.routineId === 'r1');
  assert.equal(skip.kind, 'skip');
  const { options } = ui();
  const result = await runTypedCommand('jätän lenkin väliin', options);
  assert.equal(result.ok, true);
  assert.ok(getState().routineExceptions.some(e => e.routineId === 'r1' && e.date === '2026-09-28' && e.type === 'skip'));
});

test('ei muutettavaa: kerrotaan, ei kysytä vahvistusta', async t => {
  freezeLocalDate(t, '2026-09-28');
  const { seen, options } = ui();
  const result = await runTypedCommand('olen 10 min myöhässä', options);
  assert.equal(result.status, 'no_change');
  assert.equal(seen.confirms.length, 0);
});

test('paikallinen polku ei kirjaa raakatekstiä lokiin', () => {
  const code = readCode('src/app/localCommands.js');
  const calls = [...code.matchAll(/logEvent\('[^']+',\s*(\{[^}]*\})/g)].map(m => m[1]);
  assert.ok(calls.length >= 2);
  for (const args of calls) {
    assert.equal(/\b(text|title|trimmed|placeText|question|summary)\b/.test(args), false, args);
  }
});
