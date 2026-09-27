// Poistettu ilmoitus ei palaa lukemattomana, kun sen ehto on yhä voimassa.
//
// LÖYTYNYT BUGI, JOTA TÄMÄ TESTI VARTIOI
//
// "Poista" (deleteNotice) poisti rivin tilasta ja kannasta. Kaksoiskappaleiden
// esto katsoi vain olemassa olevia ilmoituksia (addNoticeToState ja
// runReminderSweep:n deliveredKeys), joten seuraava kierros — 30 sekunnin
// välein — loi saman avaimen uudelleen lukemattomana ja merkki palasi:
//
//   muistutus 'r1|gentle|<päivä>|08:00' poistetaan 08:01 -> takaisin 08:02
//   myöhästymisehdotus 'lateness|10' poistetaan -> takaisin seuraavalla kierroksella
//
// Muistutus on jo 'delivered', eikä delivered -> delivered ole sallittu
// siirtymä, joten hälytyslaskuri ei kasva eikä MAX_ALERTS_PER_REMINDER
// koskaan pysäytä toistoa.
//
// Korjaus: poistetun ilmoituksen AVAIN kirjataan poistetuksi (sama avain,
// jolla kaksoiskappaleet muutenkin estetään), ja jokainen luontipolku
// kunnioittaa sitä addNoticeToState-funktion kautta.

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import * as S from '../src/app/state.js';
import { clearAllCollections, noticesRepo, remindersRepo } from '../src/data/collectionsRepo.js';
import { runReminderSweep, deleteNotice } from '../src/app/assistantActions.js';
import { runDailyLifeNotices } from '../src/app/dailyLifeNotices.js';
import { normalizeNotice, NOTICE_KIND } from '../src/domain/notificationCenter.js';
import { fmtISO } from '../src/lib/datetime.js';
import { resetTestStore, storedRows } from './helpers/gateAwareStore.mjs';

const USER = { id: 'aaaaaaaa-0000-0000-0000-00000000000a', email: 'a@example.com' };

beforeEach(() => {
  mock.restoreAll();
  clearAllCollections();
  // Portin ollessa auki ilmoitukset kulkevat kantaa jäljittelevälle palvelimelle.
  resetTestStore();
  clearUser();
  S.resetState();
  setUser(USER);
});

/** Tänään annettuun kellonaikaan (paikallinen aika, kuten sovelluksessa). */
function at(hours, minutes) {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
}

const noticesWith = prefix => S.getState().notices.filter(n => n.key && n.key.startsWith(prefix));

function seedLateness() {
  S.setProfile({ sleepTargetHours: 8, defaultWakeTime: '06:30', commuteMinutes: 30, routineMinutes: 45 }, true);
  S.setSavedPlaces([{ id: 'p1', name: 'Työ', usualTravelMinutes: 30 }]);
  S.setLifeSettings([{ id: 's1' }]);
  // Neljä lähtöä noin kymmenen minuuttia myöhässä -> ehdotus aiemmasta muistutuksesta.
  S.setCommuteObservations([1, 2, 3, 4].map(i => ({
    id: `o${i}`, placeId: 'p1', observedOn: `2026-09-2${i}`,
    plannedDeparture: '07:30', actualDeparture: '07:40'
  })));
}

// =============================================================== muistutus

test('REGRESSIO: poistettu muistutusilmoitus ei palaa seuraavalla kierroksella', async () => {
  const reminder = {
    id: 'r1', title: 'Lääkkeet', dueDate: fmtISO(new Date()), dueTime: '08:00', status: 'scheduled'
  };
  // Muistutus on tallennettu (muisti tai kanta porttitilan mukaan) ja ladattu.
  assert.equal((await remindersRepo.insert(reminder)).ok, true);
  S.setReminders([reminder]);

  await runReminderSweep({ now: at(8, 1) });
  const [created] = noticesWith('r1|');
  assert.ok(created, 'lähtötilanne: muistutus tuotti ilmoituksen');

  assert.equal(await deleteNotice(created.id), true);
  assert.equal(noticesWith('r1|').length, 0);

  await runReminderSweep({ now: at(8, 2) });
  await runReminderSweep({ now: at(8, 3) });

  assert.deepEqual(noticesWith('r1|').map(n => `${n.key} ${n.status}`), [],
    'poistettu ilmoitus palasi lukemattomana');
  const stored = await storedRows(noticesRepo);
  assert.equal(stored.filter(n => n.key === created.key).length, 0, 'kantaan kirjoitettiin uusi rivi');
});

// ======================================================== arjen ilmoitus

test('REGRESSIO: poistettu myöhästymisehdotus ei palaa, vaikka ehto on yhä voimassa', async () => {
  seedLateness();
  const now = new Date(2026, 8, 29, 12, 0);
  await runDailyLifeNotices({ now });
  const [lateness] = noticesWith('lateness|');
  assert.ok(lateness, 'lähtötilanne: ehdotus syntyi');

  await deleteNotice(lateness.id);
  await runDailyLifeNotices({ now: new Date(2026, 8, 29, 12, 1) });

  assert.equal(noticesWith('lateness|').length, 0, 'poistettu ehdotus palasi lukemattomana');
});

// ================================================== kaikki luontipolut

test('addNoticeToState torjuu poistetun avaimen (lähtö-, suunnitelma- ja muut kierrokset)', async () => {
  const original = normalizeNotice({
    id: 'n1', key: 'replan|missed_task|2026-09-29', kind: NOTICE_KIND.REPLAN,
    title: '2 tehtävää on myöhässä', createdDate: '2026-09-29'
  });
  assert.equal(S.addNoticeToState(original), true);
  await deleteNotice('n1');

  assert.equal(S.addNoticeToState({ ...original, id: 'n2' }), false);
  assert.equal(S.getState().notices.length, 0);
});

test('epäonnistunut poisto palauttaa ilmoituksen eikä jätä avainta poistetuksi', async () => {
  const original = normalizeNotice({
    id: 'n1', key: 'evening|2026-09-29', kind: NOTICE_KIND.REMINDER,
    title: 'Huomenna aikainen lähtö', createdDate: '2026-09-29'
  });
  S.addNoticeToState(original);
  mock.method(noticesRepo, 'remove', async () => ({ ok: false, error: 'verkko' }));

  assert.equal(await deleteNotice('n1'), false);

  assert.deepEqual(S.getState().notices.map(n => n.id), ['n1'], 'ilmoitus ei palautunut');
  // Palautunut rivi toimii kuten ennenkin: toinen samalla avaimella on kaksoiskappale.
  assert.equal(S.addNoticeToState({ ...original, id: 'n2' }), false);
  mock.restoreAll();
  // Kun poisto sitten onnistuu, avain kirjataan normaalisti.
  assert.equal(await deleteNotice('n1'), true);
  assert.equal(S.addNoticeToState({ ...original, id: 'n3' }), false);
});

test('poistokirjaus on istuntokohtainen: uloskirjautuminen unohtaa sen', async () => {
  const original = normalizeNotice({
    id: 'n1', key: 'rhythm|2026-09-26', kind: NOTICE_KIND.REMINDER,
    title: 'Viikonlopun rytmi', createdDate: '2026-09-26'
  });
  S.addNoticeToState(original);
  await deleteNotice('n1');

  // main.js onSignedOut -> resetState. Edellisen käyttäjän poistot eivät
  // kuulu seuraavalle, eikä niitä säilytetä muistissa hänen nähtäväkseen.
  S.resetState();
  assert.equal(S.addNoticeToState({ ...original, id: 'n2' }), true);
});
