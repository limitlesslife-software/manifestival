// Tuttu paikka puheesta ilman valmiita lisänimiä (paketti §10-§12).
//
//   "Lisää parturi ensi tiistaille klo 16" + tallennettu "Parturi Kallio"
//     1. kerta: kysytään "Tarkoitatko paikkaa Parturi Kallio?" -> vahvistus -> nimitys opitaan (1)
//     2. kerta: kysytään uudelleen -> vahvistus -> (2)
//     3. kerta: liitetään automaattisesti, ei kysymystä
//   "palaveri huomenna klo 8 työpaikalla" + tallennettu "Työ" -> meno paikkaan Työ,
//     ja lähtö lasketaan paikan matka-ajasta.
//
// Lähtötilassa EI ole yhtään opittua nimitystä: oppimisen on käynnistyttävä
// pelkästä lauseesta. Useampi ehdokas -> kysytään aina; käyttäjä voi myös
// vastata "ei mikään näistä" ilman, että koko meno peruuntuu.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { resetState, getState, setSavedPlaces } from '../src/app/state.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { runTypedCommand } from '../src/app/commandBar.js';
import { NO_SAVED_PLACE } from '../src/app/localCommands.js';
import { departuresOn } from '../src/app/dailyLifeModel.js';
import { freezeLocalDate } from './helpers/clock.mjs';

const USER = { id: 'aaaaaaaa-9999-4000-8000-00000000000b', email: 'p@example.com' };
const MONDAY = new Date(2026, 8, 28, 12, 0); // maanantai 28.9.2026

let network = 0;
const offlineFetch = async () => { network += 1; throw new Error('ei verkkoa'); };

function ui({ accept = true, choose = null } = {}) {
  const seen = { confirms: [], choices: [] };
  return {
    seen,
    options: {
      fetchImpl: offlineFetch,
      now: MONDAY,
      confirmFn: async proposal => { seen.confirms.push(proposal); return accept; },
      chooseFn: async (candidates, question) => {
        seen.choices.push({ candidates, question });
        return typeof choose === 'function' ? choose(candidates, question) : null;
      }
    }
  };
}

const pick = id => candidates => candidates.find(c => c.id === id) || null;
const placeChoices = seen => seen.choices.filter(choice => choice.candidates.some(c => c.id === NO_SAVED_PLACE));

beforeEach(() => {
  network = 0;
  clearUser();
  clearLocalUserData();
  resetState();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

// ------------------------------------------------------------ "parturi" -> Parturi Kallio

test('KRIITTINEN: ilman valmiita nimityksiä "parturi" kysytään, kahdesti vahvistettu liitetään kolmannella kerralla itse', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([{ id: 'pk', name: 'Parturi Kallio', usualTravelMinutes: 20 }]);
  assert.deepEqual(getState().placeAliases, [], 'lähtötilassa ei opittuja nimityksiä');

  // 1. kerta: kysytään, vahvistetaan.
  const first = ui({ choose: pick('pk') });
  const r1 = await runTypedCommand('Lisää parturi ensi tiistaille klo 16', first.options);
  assert.equal(r1.ok, true);
  assert.equal(network, 0, 'paikallinen polku ei kutsu verkkoa');
  const [q1] = placeChoices(first.seen);
  assert.ok(q1, 'paikasta kysyttiin');
  assert.equal(q1.question, 'Tarkoitatko paikkaa Parturi Kallio?');
  assert.deepEqual(q1.candidates.map(c => c.label), ['Parturi Kallio', 'Ei mikään näistä (ilman tallennettua paikkaa)']);
  assert.ok(first.seen.confirms[0].preview.changes.some(row => row.label === 'Paikka' && row.after === 'Parturi Kallio'),
    'valittu paikka näkyy tarkistuksessa');
  let [event] = getState().calendarEvents;
  assert.deepEqual([event.title, event.placeId, event.locationText], ['Parturi', 'pk', null]);
  assert.deepEqual(getState().placeAliases.map(a => [a.alias, a.placeId, a.confirmations]), [['parturi', 'pk', 1]]);

  // 2. kerta: kerran vahvistettu ei vielä riitä -> kysytään uudelleen.
  const second = ui({ choose: pick('pk') });
  await runTypedCommand('Lisää parturi keskiviikkona klo 10', second.options);
  assert.equal(placeChoices(second.seen).length, 1, 'kerran vahvistettu kysytään vielä');
  assert.deepEqual(getState().placeAliases.map(a => [a.alias, a.placeId, a.confirmations]), [['parturi', 'pk', 2]]);

  // 3. kerta: liitetään automaattisesti, ei kysymystä (tarkistus näytetään silti).
  const third = ui();
  const r3 = await runTypedCommand('Lisää parturi perjantaina klo 9', third.options);
  assert.equal(r3.ok, true);
  assert.equal(third.seen.choices.length, 0, 'kahdesti vahvistettu: ei kysymystä');
  assert.equal(third.seen.confirms.length, 1, 'tarkistus ennen tallennusta');
  event = getState().calendarEvents.find(item => item.date === '2026-10-02');
  assert.deepEqual([event.title, event.placeId], ['Parturi', 'pk']);
  assert.equal(getState().placeAliases[0].confirmations, 3, 'hyväksytty käyttö vahvistaa opittua nimeä');

  // Opittu nimitys on sanan perusmuoto: taivutettukin muoto liittyy nyt suoraan.
  const fourth = ui();
  await runTypedCommand('Lisää hiustenleikkuu parturiin lauantaina klo 11', fourth.options);
  assert.equal(fourth.seen.choices.length, 0);
  event = getState().calendarEvents.find(item => item.date === '2026-10-03');
  assert.deepEqual([event.title, event.placeId, event.locationText], ['Hiustenleikkuu', 'pk', null]);
});

test('"ei mikään näistä": meno tallentuu ilman paikkaa, otsikkoa ei tallenneta sijainniksi eikä nimitystä opita', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([{ id: 'pk', name: 'Parturi Kallio', usualTravelMinutes: 20 }]);
  const { seen, options } = ui({ choose: pick(NO_SAVED_PLACE) });
  const result = await runTypedCommand('Lisää parturi ensi tiistaille klo 16', options);
  assert.equal(result.ok, true, 'kieltäytyminen paikasta ei peru menoa');
  assert.equal(seen.confirms.length, 1);
  assert.equal(seen.confirms[0].preview.changes.some(row => row.label === 'Paikka'), false);
  const [event] = getState().calendarEvents;
  assert.deepEqual([event.title, event.placeId, event.locationText], ['Parturi', null, null]);
  assert.deepEqual(getState().placeAliases, []);
});

test('peruttu tarkistus ei opeta nimitystä', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([{ id: 'pk', name: 'Parturi Kallio' }]);
  const { options } = ui({ accept: false, choose: pick('pk') });
  const result = await runTypedCommand('Lisää parturi ensi tiistaille klo 16', options);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(getState().calendarEvents, []);
  assert.deepEqual(getState().placeAliases, []);
});

test('KRIITTINEN: useampi ehdokas kysytään aina, myös kerran vahvistetun jälkeen', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([
    { id: 'pe', name: 'Motonet Espoo', usualTravelMinutes: 25 },
    { id: 'pv', name: 'Motonet Vantaa', usualTravelMinutes: 30 }
  ]);
  const first = ui({ choose: pick('pv') });
  await runTypedCommand('Lisää renkaat motonetille huomenna klo 10', first.options);
  const [q1] = placeChoices(first.seen);
  assert.ok(q1, 'pienellä kirjoitettu, epävarma paikka kysytään');
  assert.deepEqual(q1.candidates.filter(c => c.id !== NO_SAVED_PLACE).map(c => c.id).sort(), ['pe', 'pv']);
  assert.equal(getState().calendarEvents[0].placeId, 'pv');
  assert.equal(getState().calendarEvents[0].title, 'Renkaat', 'valittu paikka ei jää otsikkoon');

  // Kerran vahvistettu: kumpikin paikka on yhä valittavissa, vahvistettu ensin.
  const second = ui({ choose: pick('pe') });
  await runTypedCommand('Lisää pesu motonetissa keskiviikkona klo 10', second.options);
  const [q2] = placeChoices(second.seen);
  assert.deepEqual(q2.candidates.filter(c => c.id !== NO_SAVED_PLACE).map(c => c.id), ['pv', 'pe']);
  assert.equal(getState().calendarEvents.find(e => e.title === 'Pesu').placeId, 'pe');
});

// ------------------------------------------------------------ Työ

test('KRIITTINEN: "palaveri huomenna klo 8 työpaikalla" liittyy paikkaan Työ ja lähtö lasketaan sen matka-ajasta', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([
    { id: 'home', name: 'Koti', usualTravelMinutes: null },
    { id: 'work', name: 'Työ', usualTravelMinutes: 25 }
  ]);
  const { seen, options } = ui();
  const result = await runTypedCommand('palaveri huomenna klo 8 työpaikalla', options);
  assert.equal(result.ok, true);
  assert.equal(seen.choices.length, 0, 'yksi selvä paikka: ei kysymystä');
  assert.ok(seen.confirms[0].preview.changes.some(row => row.label === 'Paikka' && row.after === 'Työ'));
  const [event] = getState().calendarEvents;
  assert.deepEqual([event.title, event.placeId, event.locationText, event.date, event.startTime],
    ['Palaveri', 'work', null, '2026-09-29', '08:00']);

  const [item] = departuresOn('2026-09-29', { now: MONDAY });
  assert.equal(item.departure.known, true, 'matka-aika tiedossa paikasta');
  assert.equal(item.departure.parts.travel, 25);
  assert.ok(item.departure.leave.time < '07:35', `lähtö ennen menoa: ${item.departure.leave.time}`);
  assert.deepEqual(getState().placeAliases, [], 'paikan oma nimi ja sen synonyymi eivät ole uusia nimityksiä');
});

test('"töissä", "töihin" ja "työhön" tarkoittavat paikkaa Työ', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([{ id: 'home', name: 'Koti' }, { id: 'work', name: 'Työ', usualTravelMinutes: 25 }]);
  for (const [text, title] of [
    ['Lisää palaveri töissä huomenna klo 9', 'Palaveri'],
    ['Lisää koulutus töihin keskiviikkona klo 12', 'Koulutus'],
    ['Lisää inventaario työhön torstaina klo 14', 'Inventaario']
  ]) {
    const { seen, options } = ui();
    const result = await runTypedCommand(text, options);
    assert.equal(result.ok, true, text);
    assert.equal(seen.choices.length, 0, text);
    const event = getState().calendarEvents.find(item => item.title === title);
    assert.ok(event, text);
    assert.equal(event.placeId, 'work', text);
  }
});

test('"keskustassa" liitetään vain, jos tallennettu paikka vastaa; muuten ei kysymystä eikä arvausta', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([{ id: 'home', name: 'Koti' }, { id: 'work', name: 'Työ' }]);
  const plain = ui();
  await runTypedCommand('Lisää hammaslääkäri keskustassa huomenna klo 10', plain.options);
  assert.equal(plain.seen.choices.length, 0);
  assert.equal(getState().calendarEvents[0].placeId, null);

  setSavedPlaces([{ id: 'home', name: 'Koti' }, { id: 'city', name: 'Keskusta', usualTravelMinutes: 15 }]);
  const known = ui();
  await runTypedCommand('Lisää optikko keskustassa keskiviikkona klo 10', known.options);
  assert.equal(known.seen.choices.length, 0);
  const event = getState().calendarEvents.find(item => item.title === 'Optikko');
  assert.equal(event.placeId, 'city');
});

test('paikan nimi yhdyssanan osana ei ole paikkamaininta: ei turhaa kysymystä', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([{ id: 'home', name: 'Koti' }, { id: 'work', name: 'Työ' }]);
  for (const text of ['Lisää työpalaveri huomenna klo 10', 'Lisää kotisiivous lauantaina klo 10', 'Lisää työhaastattelu torstaina klo 13']) {
    const { seen, options } = ui();
    const result = await runTypedCommand(text, options);
    assert.equal(result.ok, true, text);
    assert.equal(seen.choices.length, 0, text);
  }
  assert.ok(getState().calendarEvents.every(event => event.placeId === null));
});
