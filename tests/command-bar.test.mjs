// Testit src/app/commandBar.js:lle: koko putki lauseesta suoritukseen.
//
// confirmFn/chooseFn injektoidaan (kuten aiCommands.js:n runAiCommand()
// tekee `confirm`:lle) — sama periaate kuin muuallakin kirjausketjun
// testeissä: vahvistuslogiikka todistetaan suorittamalla se, ei
// lukemalla lähdekoodia, mutta ilman oikeaa DOM:ia.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { resetState, getState, setTasks } from '../src/app/state.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { normalizeTask } from '../src/domain/task.js';

import { runTypedCommand } from '../src/app/commandBar.js';

const USER = { id: 'aaaaaaaa-8888-0000-0000-000000000008', email: 'c@example.com' };

function fetchReturning(text) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] })
  });
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

test('tyhjä komento ei tee verkkokutsua', async () => {
  let called = false;
  const result = await runTypedCommand('   ', {
    fetchImpl: async () => { called = true; },
    confirmFn: async () => true,
    chooseFn: async () => null
  });
  assert.equal(result.status, 'empty');
  assert.equal(called, false);
});

test('tuntematon intentti hylätään ilman vahvistuskyselyä', async () => {
  let confirmCalled = false;
  const result = await runTypedCommand('mitä sää on tänään', {
    fetchImpl: fetchReturning('{"intent":"unknown"}'),
    confirmFn: async () => { confirmCalled = true; return true; },
    chooseFn: async () => null
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'rejected');
  assert.equal(confirmCalled, false, 'hylätty komento ei saa kysyä vahvistusta');
});

test('KRIITTINEN: peruttu vahvistus ei suorita mitään', async () => {
  const result = await runTypedCommand('luo tehtävä ostaa maitoa huomenna', {
    fetchImpl: fetchReturning('{"intent":"create_task","title":"Osta maitoa","date":"2026-09-19"}'),
    confirmFn: async () => false,
    chooseFn: async () => null
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'cancelled');
  assert.equal(getState().tasks.length, 0, 'peruttu komento ei saa luoda riviä');
});

test('vahvistettu luontikomento suorittaa createTaskin', async () => {
  const result = await runTypedCommand('luo tehtävä ostaa maitoa huomenna', {
    fetchImpl: fetchReturning('{"intent":"create_task","title":"Osta maitoa","date":"2026-09-19"}'),
    confirmFn: async () => true,
    chooseFn: async () => null
  });
  assert.equal(result.ok, true);
  assert.equal(getState().tasks.length, 1);
  assert.equal(getState().tasks[0].title, 'Osta maitoa');
});

test('vain lukeva komento ei kysy vahvistusta ja suoriutuu suoraan', async () => {
  let confirmCalled = false;
  const result = await runTypedCommand('näytä ensi viikko', {
    fetchImpl: fetchReturning('{"intent":"show_week_plan","date":"2026-09-25"}'),
    confirmFn: async () => { confirmCalled = true; return true; },
    chooseFn: async () => null
  });
  assert.equal(result.ok, true);
  assert.equal(confirmCalled, false, 'vain lukeva komento ei saa kysyä vahvistusta');
  assert.equal(getState().screen, 'screen-week');
});

test('KRIITTINEN: epäselvä kohde näyttää valitsimen eikä arvaa', async () => {
  setTasks([
    normalizeTask({ id: 'a', title: 'Lääkäriaika', date: '2026-09-20' }),
    normalizeTask({ id: 'b', title: 'Lääkäriaika', date: '2026-09-27' })
  ]);

  let seenCandidates = null;
  const result = await runTypedCommand('siirrä lääkäriaika perjantaille', {
    fetchImpl: fetchReturning('{"intent":"reschedule_task","targetName":"Lääkäriaika","date":"2026-09-25"}'),
    confirmFn: async () => true,
    chooseFn: async (candidates) => { seenCandidates = candidates; return null; }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'cancelled');
  assert.equal(seenCandidates.length, 2);
  assert.equal(getState().tasks[0].date, '2026-09-20', 'kumpaakaan riviä ei muutettu');
  assert.equal(getState().tasks[1].date, '2026-09-27');
});

test('epäselvän kohteen valinta suorittaa VALITUN rivin muutoksen', async (t) => {
  // "perjantaille" ratkaistaan oikeasta kellosta: maanantaina 21.9. se on 25.9.
  freezeLocalDate(t, '2026-09-21');
  setTasks([
    normalizeTask({ id: 'a', title: 'Lääkäriaika', date: '2026-09-20' }),
    normalizeTask({ id: 'b', title: 'Lääkäriaika', date: '2026-09-27' })
  ]);

  const result = await runTypedCommand('siirrä lääkäriaika perjantaille', {
    fetchImpl: fetchReturning('{"intent":"reschedule_task","targetName":"Lääkäriaika","date":"2026-09-25"}'),
    confirmFn: async () => true,
    chooseFn: async (candidates) => candidates.find(c => c.id === 'b')
  });

  assert.equal(result.ok, true);
  const byId = id => getState().tasks.find(t => t.id === id);
  assert.equal(byId('a').date, '2026-09-20', 'ei-valittu rivi säilyy koskemattomana');
  assert.equal(byId('b').date, '2026-09-25', 'valittu rivi muuttui');
});

test('verkkovirhe ei koskaan tuota arvattua komentoa', async () => {
  const result = await runTypedCommand('poista huominen tehtävä', {
    fetchImpl: async () => { throw new Error('verkko poikki'); },
    confirmFn: async () => true,
    chooseFn: async () => null
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
});

test('menolause käsitellään laitteella: /api/commandia ei kutsuta, vahvistus kysytään silti', async t => {
  freezeLocalDate(t, '2026-09-28');
  let called = 0;
  let confirmed = null;
  const result = await runTypedCommand('lisää parturi keskiviikkona klo 16', {
    now: new Date(2026, 8, 28, 12, 0),
    fetchImpl: async () => { called += 1; throw new Error('ei pitäisi kutsua'); },
    confirmFn: async proposal => { confirmed = proposal; return true; },
    chooseFn: async () => null
  });
  assert.equal(called, 0);
  assert.equal(result.ok, true);
  assert.equal(result.local, true);
  assert.equal(confirmed.preview.destructive, false);
  assert.equal(getState().calendarEvents[0].date, '2026-09-30');
  assert.equal(getState().tasks.length, 0, 'meno ei ole tehtävä');
});

test('KRIITTINEN: epäselvä menolause ilman valintaa ei tallenna eikä siirry tekoälylle arvattavaksi', async t => {
  freezeLocalDate(t, '2026-09-28');
  let called = 0;
  const result = await runTypedCommand('teatteri lauantaina seitsemältä', {
    now: new Date(2026, 8, 28, 12, 0),
    fetchImpl: async () => { called += 1; throw new Error('verkko poikki'); },
    confirmFn: async () => true,
    chooseFn: async () => null
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'cancelled');
  assert.equal(called, 0);
  assert.deepEqual(getState().calendarEvents, []);
});

test('kohde jota ei löydy ei tarjoa tyhjää valitsinta', async () => {
  const result = await runTypedCommand('merkitse olematon tehtävä tehdyksi', {
    fetchImpl: fetchReturning('{"intent":"complete_task","targetName":"Olematon"}'),
    confirmFn: async () => true,
    chooseFn: async () => { throw new Error('ei pitäisi kutsua tyhjällä ehdokaslistalla'); }
  });
  assert.equal(result.ok, false);
});

test('KRIITTINEN: tilin vaihto tekoälyn vastausta odotellessa hylkää komennon (ei B:n dialogia, auditointia eikä riviä)', async () => {
  // Bugijahti 2026-09-27: A:n komento päätyi B:n vahvistusdialogiin ja
  // B:n auditointiin, kun tili vaihtui 15 s:n odotuksen aikana.
  const OTHER = { id: 'bbbbbbbb-8888-0000-0000-00000000000b', email: 'b@example.com' };
  let confirmCalled = false;
  const result = await runTypedCommand('muistuta varaamaan aika psykiatrille torstaina', {
    fetchImpl: async () => {
      // Tili vaihtuu kesken pyynnön: uloskirjautuminen ja toisen kirjautuminen.
      clearUser();
      clearLocalUserData();
      resetState();
      setUser(OTHER);
      return fetchReturning('{"intent":"create_task","title":"Varaa aika psykiatrille","date":"2026-09-24"}')();
    },
    confirmFn: async () => { confirmCalled = true; return true; },
    chooseFn: async () => null
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'discarded');
  assert.equal(confirmCalled, false, 'A:n komentoa ei näytetä B:lle');
  assert.equal(getState().tasks.length, 0);
  assert.deepEqual(getState().aiAudit || [], [], 'A:n lause ei päädy B:n auditointiin');
});
