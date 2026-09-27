// "Minun pitää käydä Motonetissä tällä viikolla" (paketti §44).
//
// Viikko ilman viikonpäivää ja kellonaikaa ei ole kalenterimeno vaan avoin
// asia: tehtävä ilman päivää, määräaikana viikon sunnuntai. Käyttäjä näkee
// ehdotuksen ja hyväksyy sen; vasta sitten tehtävä syntyy. Tänään-näkymän
// Avoimet asiat tarjoaa sille "Ehdota aikaa".
//
// Ennen tätä lause päätyi kysymykseen "Minä päivänä tällä viikolla?" ilman
// vaihtoehtoja, eikä mitään syntynyt.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { resetState, getState, setSavedPlaces, setCalendarEvents, setTasks } from '../src/app/state.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { runTypedCommand } from '../src/app/commandBar.js';
import { openEndedTasks, errandProposal, errandGroups } from '../src/app/views/todayDailyLife.js';
import { freezeLocalDate } from './helpers/clock.mjs';

const USER = { id: 'aaaaaaaa-9999-4000-8000-00000000000c', email: 'o@example.com' };
const MONDAY = new Date(2026, 8, 28, 12, 0); // maanantai 28.9.2026

let network = 0;
const offlineFetch = async () => { network += 1; throw new Error('ei verkkoa'); };

function ui({ accept = true, choose = null, now = MONDAY } = {}) {
  const seen = { confirms: [], choices: [] };
  return {
    seen,
    options: {
      fetchImpl: offlineFetch,
      now,
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

test('KRIITTINEN: "Minun pitää käydä Motonetissä tällä viikolla" -> vahvistettu avoin asia, määräaika sunnuntai', async t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([{ id: 'm', name: 'Motonet', usualTravelMinutes: 20 }]);
  const { seen, options } = ui();
  const result = await runTypedCommand('Minun pitää käydä Motonetissä tällä viikolla', options);
  assert.equal(result.ok, true);
  assert.equal(result.local, true);
  assert.equal(result.kind, 'create_task');
  assert.equal(network, 0, 'ei tekoälyä eikä verkkoa');
  assert.equal(seen.choices.length, 0, 'ei kysymystä päivästä');
  assert.equal(seen.confirms.length, 1, 'aina tarkistus ennen tallennusta');
  const preview = seen.confirms[0].preview;
  assert.equal(preview.destructive, false);
  assert.ok(preview.changes.some(row => row.label === 'Asia' && row.after === 'Käydä Motonetissä'));
  assert.ok(preview.changes.some(row => row.label === 'Määräaika' && /su 4\.10\./.test(row.after)));
  assert.ok(preview.changes.some(row => row.label === 'Aika' && /Ehdota aikaa/.test(row.after)));

  const [task] = getState().tasks;
  assert.equal(task.title, 'Käydä Motonetissä');
  // Tehtävällä on aina päivä (validateTask): avoin asia on määräpäivällään ilman kellonaikaa.
  assert.equal(task.date, '2026-10-04', 'määräpäivä, ei tätä päivää: asia odottaa ehdotusta');
  assert.equal(task.time, null);
  assert.equal(task.schedulingState, 'unscheduled');
  assert.equal(task.deadline, '2026-10-04', 'tämän viikon sunnuntai');
  assert.equal(getState().calendarEvents.length, 0, 'ei kalenterimenoa');

  // Tänään -> Avoimet asiat tarjoaa "Ehdota aikaa"; ehdotus ei muuta mitään.
  assert.deepEqual(openEndedTasks(getState(), '2026-09-28').map(entry => entry.id), [task.id]);
  const before = JSON.stringify(getState().tasks);
  const proposal = errandProposal(task, { state: getState(), now: MONDAY });
  assert.ok(proposal.proposal, proposal.reason);
  assert.ok(proposal.proposal.date >= '2026-09-28' && proposal.proposal.date <= '2026-10-04');
  assert.equal(JSON.stringify(getState().tasks), before);
});

test('"ensi viikolla": määräaika ensi viikon sunnuntai; Avoimet asiat näyttää sen, kun viikko on käsillä', async t => {
  freezeLocalDate(t, '2026-09-28');
  const { seen, options } = ui();
  const result = await runTypedCommand('Lisää renkaanvaihto ensi viikolla', options);
  assert.equal(result.ok, true);
  assert.equal(seen.confirms.length, 1);
  const [task] = getState().tasks;
  assert.deepEqual([task.title, task.date, task.time, task.deadline], ['Renkaanvaihto', '2026-10-11', null, '2026-10-11']);
  assert.deepEqual(openEndedTasks(getState(), '2026-09-28'), [], 'kaukaisempi määräaika ei ole vielä tämän viikon asia');
  assert.deepEqual(openEndedTasks(getState(), '2026-10-05').map(entry => entry.id), [task.id]);
});

test('peruttu tarkistus ei luo tehtävää', async t => {
  freezeLocalDate(t, '2026-09-28');
  const { options } = ui({ accept: false });
  const result = await runTypedCommand('Pitää soittaa verottajalle tällä viikolla', options);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(getState().tasks, []);
});

test('sunnuntaina "tällä viikolla" on tämä päivä', async t => {
  freezeLocalDate(t, '2026-10-04');
  const { options } = ui({ now: new Date(2026, 9, 4, 12, 0) });
  await runTypedCommand('Mun täytyy hoitaa verot tällä viikolla', options);
  const [task] = getState().tasks;
  assert.deepEqual([task.title, task.deadline], ['Hoitaa verot', '2026-10-04']);
});

test('menolla on kellonaika tai kalenterisana: viikon päivä kysytään vaihtoehtoina, ei umpikujaa', async t => {
  freezeLocalDate(t, '2026-09-28');
  const timed = ui({ choose: candidates => candidates.find(c => c.id === '2026-10-07') });
  const result = await runTypedCommand('Lisää kokous ensi viikolla klo 10', timed.options);
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'create_event');
  const [question] = timed.seen.choices;
  assert.equal(question.question, 'Minä päivänä ensi viikolla?');
  assert.deepEqual(question.candidates.map(c => c.id),
    ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  const [event] = getState().calendarEvents;
  assert.deepEqual([event.title, event.date, event.startTime], ['Kokous', '2026-10-07', '10:00']);

  // Tällä viikolla vain jäljellä olevat päivät.
  const calendar = ui({ choose: candidates => candidates[0] });
  await runTypedCommand('Lisää kalenteriin palaveri tällä viikolla klo 14', calendar.options);
  assert.deepEqual(calendar.seen.choices[0].candidates.map(c => c.id),
    ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal(getState().tasks.length, 0, 'meno ei ole tehtävä');
});

test('Avoimet asiat: päivätön tai määräpäivälleen ilman kellonaikaa merkitty; käyttäjän oma päivä tai kellonaika ei ole avoin', () => {
  const state = {
    tasks: [
      { id: 'undated', title: 'Päivätön', date: null, time: null, deadline: '2026-10-01', completed: false },
      { id: 'open', title: 'Avoin', date: '2026-10-02', time: null, deadline: '2026-10-02', completed: false },
      { id: 'own-day', title: 'Oma päivä', date: '2026-09-30', time: null, deadline: '2026-10-02', completed: false },
      { id: 'timed', title: 'Ajastettu', date: '2026-10-02', time: '10:00', deadline: '2026-10-02', completed: false },
      { id: 'done', title: 'Valmis', date: '2026-10-02', time: null, deadline: '2026-10-02', completed: true },
      { id: 'no-deadline', title: 'Ei määräaikaa', date: '2026-10-02', time: null, deadline: null, completed: false }
    ]
  };
  assert.deepEqual(openEndedTasks(state, '2026-09-28').map(task => task.id), ['undated', 'open']);
});

test('avoin asia ryhmittyy jo suunnitellun menon kanssa (asiointi samalla reissulla)', t => {
  freezeLocalDate(t, '2026-09-28');
  setSavedPlaces([
    { id: 'm', name: 'Motonet', area: 'Tammisto', usualTravelMinutes: 20 },
    { id: 'h', name: 'Hammaslääkäri', area: 'Tammisto', usualTravelMinutes: 20 }
  ]);
  setCalendarEvents([{ id: 'e1', title: 'Hammaslääkäri', date: '2026-10-01', startTime: '10:00', endTime: '11:00', placeId: 'h' }]);
  setTasks([{ id: 'x', title: 'Käydä Motonetissä', date: '2026-10-04', deadline: '2026-10-04' }]);
  const groups = errandGroups(getState(), '2026-09-28');
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].taskIds], ['x']);
  assert.match(groups[0].text, /Voit hoitaa samalla: Käydä Motonetissä\./);
});
