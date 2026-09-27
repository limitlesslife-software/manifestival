// Profiili → Paikat (src/app/views/placesSettings.js) oikeassa, jäsennetyssä
// DOMissa: paikkojen luonti, muokkaus ja poisto, opitut nimitykset,
// oppimisen nollaus, omista matkoista opitun keston hyväksyntä,
// myöhästelyehdotus ja oletusetuaika. Tallennus kulkee muistivaraston
// kautta, kun portit ovat kiinni (tuotehaara), ja kantaa jäljittelevän
// palvelimen kautta, kun ne ovat auki (helpers/gateAwareStore.mjs).
//
// Säiliön (#profilePlacesSection) luo profiilinäkymä muualla; testi luo
// oman säiliönsä.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDocument, installDocument, press, type, choose, accessibleName, assertSameNode
} from './helpers/a11yDom.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { read } from './helpers/sources.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import {
  clearAllCollections, savedPlacesRepo, placeAliasesRepo, commuteObservationsRepo
} from '../src/data/collectionsRepo.js';
import { isTableAvailable } from '../src/data/schema.js';
import {
  resetState, getState, subscribe, setSavedPlaces, setPlaceAliases, setCommuteObservations, currentLifeSettings
} from '../src/app/state.js';
import { resetDailyLifeActions } from '../src/app/dailyLifeActions.js';
import {
  renderPlacesSettings, initPlacesSettings, resetPlacesSettings
} from '../src/app/views/placesSettings.js';
import { closeConfirmDialogs } from '../src/ui/confirm.js';
import { clearToasts } from '../src/ui/toast.js';
import { resetTestStore, seedStored, storedRow, storedRows } from './helpers/gateAwareStore.mjs';

const USER = Object.freeze({ id: 'ddddaaaa-5555-4555-8555-00000000d0de', email: 'places@example.invalid' });
const TODAY = '2026-09-28';

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
};

function mount(t) {
  freezeLocalDate(t, TODAY);
  clearUser();
  clearAllCollections();
  resetTestStore();
  resetState();
  resetDailyLifeActions();
  resetPlacesSettings();
  const doc = createDocument('<main><section id="host" aria-label="Paikat"></section></main>');
  const uninstall = installDocument(doc);
  setUser(USER);
  const container = doc.getElementById('host');
  initPlacesSettings(container);
  const unsubscribe = subscribe(() => renderPlacesSettings(container));
  renderPlacesSettings(container);
  t.after(async () => {
    unsubscribe();
    closeConfirmDialogs();
    await flush(4);
    clearToasts();
    resetPlacesSettings();
    uninstall();
    clearUser();
  });
  return {
    doc,
    container,
    q: selector => container.querySelector(selector),
    qa: selector => container.querySelectorAll(selector),
    byId: id => doc.getElementById(id),
    text: () => container.textContent.replace(/\s+/g, ' ')
  };
}

/**
 * Rivit sekä tilaan että tallennukseen (päivitys ja poisto kulkevat
 * repositorion kautta): muistiin tai kantaan porttitilan mukaan.
 */
async function seed(repo, setter, rows) {
  await seedStored(repo, rows);
  setter(rows);
}

async function answerConfirm(doc, accept) {
  await flush(3);
  const dialog = doc.getElementById('confirmDialog');
  assert.ok(dialog && dialog.open, 'vahvistusdialogi on auki');
  doc.getElementById(accept ? 'confirmAccept' : 'confirmCancel').click();
  await flush();
}

function action(view, name, id = null) {
  const selector = id ? `[data-action="${name}"][data-id="${id}"]` : `[data-action="${name}"]`;
  const button = view.q(selector);
  assert.ok(button, `painike ${selector} puuttuu`);
  return button;
}

function observations(placeId, minutes, extra = {}) {
  return minutes.map((travelMinutes, i) => ({
    id: `${placeId}-o${i}`, placeId, observedOn: `2026-09-${String(10 + i).padStart(2, '0')}`, weekday: 1,
    travelMinutes, source: 'user_confirmed', ...extra
  }));
}

// ================================================================ perusnäkymä

test('tyhjä tila: ohje, lisäyspainike ja oletusetuaika 10 min valittuna tekstinä ja aria-pressedinä', t => {
  const view = mount(t);
  assert.match(view.text(), /Ei vielä tallennettuja paikkoja/);
  assert.ok(view.q('[data-action="place-add"]'));
  const chips = view.qa('[data-action="buffer-set"]');
  assert.deepEqual(chips.map(chip => accessibleName(chip)), ['5 min', '10 min', '15 min']);
  assert.deepEqual(chips.map(chip => chip.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  assert.deepEqual(chips.map(chip => chip.textContent.trim().startsWith('✓')), [false, true, false],
    'valinta näkyy merkkinä, ei pelkkänä värinä');
  assert.match(view.text(), /Nyt 10 min\./, 'valinta näkyy myös tekstinä');
  assert.equal(view.q('[data-section="late"]'), null, 'ei ehdotusta ilman havaintoja');
});

test('paikan luonti: luvut tallentuvat, tyhjä on null eikä nolla, puuttuva matka-aika kerrotaan', async t => {
  const view = mount(t);
  action(view, 'place-add').click();
  assertSameNode(view.doc.activeElement, view.byId('plcName'), 'fokus nimikenttään');
  assert.match(view.q('[data-form-root="place"]').textContent, /Sijaintiasi ei seurata eikä tallenneta/);
  type(view.byId('plcName'), 'Työ');
  type(view.byId('plcAddress'), 'Esimerkkikatu 1');
  type(view.byId('plcArea'), 'Keskusta');
  choose(view.byId('plcMode'), 'transit');
  type(view.byId('plcTravel'), '35');
  type(view.byId('plcPrep'), '10');
  type(view.byId('plcOverhead'), '0');
  type(view.byId('plcNote'), 'Sisäänkäynti takapihalta');
  action(view, 'place-save').click();
  await flush();

  const [place] = getState().savedPlaces;
  assert.deepEqual(
    [place.name, place.address, place.area, place.travelMode, place.usualTravelMinutes, place.preparationMinutes,
      place.arrivalBufferMinutes, place.overheadMinutes, place.note, place.useLearned],
    ['Työ', 'Esimerkkikatu 1', 'Keskusta', 'transit', 35, 10, null, 0, 'Sisäänkäynti takapihalta', false]);
  const row = view.q(`[data-place-row="${place.id}"]`).textContent.replace(/\s+/g, ' ');
  assert.match(row, /Julkisilla · oma arvio 35 min/);
  assert.match(row, /etuaika oletus \(10 min\)/, 'tyhjä etuaika = oletus, ei nolla');
  assert.match(row, /pysäköinti ja kävely 0 min/, 'annettu nolla on arvo');
  assertSameNode(view.doc.activeElement, action(view, 'place-edit', place.id), 'fokus tallennetun paikan riville');

  action(view, 'place-add').click();
  type(view.byId('plcName'), 'Parturi');
  press(view.doc, 'Enter');
  await flush();
  const barber = getState().savedPlaces.find(item => item.name === 'Parturi');
  assert.equal(barber.usualTravelMinutes, null);
  assert.equal(barber.travelMode, 'driving', 'kannan oletuskulkutapa');
  assert.match(view.q(`[data-place-row="${barber.id}"]`).textContent, /Matka-aika puuttuu — lisää oma arvio/);
});

test('lukematon numerosyöte ("10-15") on kentän virhe, ei hiljaa tyhjä', async t => {
  // type=number antaa arvoksi '' ja validity.badInput = true (bugijahti ui-9).
  const view = mount(t);
  action(view, 'place-add').click();
  type(view.byId('plcName'), 'Työ');
  const travel = view.byId('plcTravel');
  travel.validity = { badInput: true };
  type(travel, '');
  action(view, 'place-save').click();
  await flush();
  assert.equal(getState().savedPlaces.length, 0, 'ei tallennettu ilman matka-aikaa');
  assert.match(view.byId('plcTravelError').textContent, /1–1440/);
});

test('paikan virheet: nimi pakollinen, rajat, sama nimi toisella paikalla', async t => {
  const view = mount(t);
  await seed(savedPlacesRepo, setSavedPlaces, [{ id: 'p-work', name: 'Työ' }]);
  action(view, 'place-add').click();
  type(view.byId('plcTravel'), '0');
  type(view.byId('plcPrep'), '999');
  action(view, 'place-save').click();
  await flush();
  assert.equal(getState().savedPlaces.length, 1, 'mitään ei tallennettu');
  assert.match(view.byId('plcNameError').textContent, /Anna paikalle nimi/);
  assert.match(view.byId('plcTravelError').textContent, /1–1440/, 'nollan minuutin matka ei ole arvo');
  assert.match(view.byId('plcPrepError').textContent, /0–480/);
  assert.equal(view.byId('plcNameError').getAttribute('role'), 'alert');
  assertSameNode(view.doc.activeElement, view.byId('plcName'));

  type(view.byId('plcName'), 'TYÖ');
  type(view.byId('plcTravel'), '');
  type(view.byId('plcPrep'), '');
  action(view, 'place-save').click();
  await flush();
  assert.equal(getState().savedPlaces.length, 1);
  assert.match(view.byId('plcNameError').textContent, /Sinulla on jo tämänniminen paikka/);
  assertSameNode(view.doc.activeElement, view.byId('plcName'));
  assert.equal(view.q('[data-action="place-save"]').disabled, false, 'painike vapautui');
});

test('paikan muokkaus; poisto kysyy vahvistuksen ja peruutus säilyttää', async t => {
  const view = mount(t);
  await seed(savedPlacesRepo, setSavedPlaces, [{ id: 'p1', name: 'Sali', usualTravelMinutes: 20, travelMode: 'cycling' }]);
  action(view, 'place-edit', 'p1').click();
  assert.equal(view.byId('plcName').value, 'Sali');
  assert.equal(view.byId('plcTravel').value, '20');
  assert.equal(view.byId('plcMode').value, 'cycling');
  assert.equal(view.byId('plcBuffer').value, '', 'tuntematon etuaika on tyhjä');
  type(view.byId('plcTravel'), '25');
  action(view, 'place-save').click();
  await flush();
  assert.equal(getState().savedPlaces.length, 1);
  assert.equal(getState().savedPlaces[0].usualTravelMinutes, 25);
  assert.equal((await storedRow(savedPlacesRepo, 'p1')).usualTravelMinutes, 25, 'muutos ei tallentunut');

  action(view, 'place-delete', 'p1').click();
  await answerConfirm(view.doc, false);
  assert.equal(getState().savedPlaces.length, 1, 'peruutus ei poista');
  const again = action(view, 'place-delete', 'p1');
  assert.equal(again.disabled, false, 'painike vapautui');
  assertSameNode(view.doc.activeElement, again, 'peruutuksen jälkeen fokus palaa poistopainikkeeseen');

  action(view, 'place-delete', 'p1').click();
  await answerConfirm(view.doc, true);
  assert.deepEqual(getState().savedPlaces, []);
  assert.deepEqual(await storedRows(savedPlacesRepo), [], 'poisto ei poistanut tallennettua paikkaa');
  assertSameNode(view.doc.activeElement, action(view, 'place-add'), 'fokus lisäyspainikkeeseen');
});

// ================================================================ nimitykset ja oppiminen

test('opitut nimitykset: vahvistusmäärä näkyy, poisto nimetyllä painikkeella', async t => {
  const view = mount(t);
  await seed(savedPlacesRepo, setSavedPlaces, [{ id: 'p1', name: 'Työ' }]);
  await seed(placeAliasesRepo, setPlaceAliases, [
    { id: 'a1', placeId: 'p1', alias: 'duuni', confirmations: 3 },
    { id: 'a2', placeId: 'p1', alias: 'työpaikka', confirmations: 1 }
  ]);
  const row = view.q('[data-place-row="p1"]').textContent.replace(/\s+/g, ' ');
  assert.match(row, /Tunnetut nimitykset/);
  assert.match(row, /”duuni” · vahvistettu 3 kertaa/);
  assert.match(row, /”työpaikka” · vahvistettu kerran/);

  const remove = action(view, 'alias-delete', 'a1');
  assert.equal(accessibleName(remove), 'Poista nimitys duuni');
  remove.click();
  await flush();
  assert.deepEqual(getState().placeAliases.map(alias => alias.id), ['a2']);
  assertSameNode(view.doc.activeElement, action(view, 'alias-delete', 'a2'), 'fokus seuraavaan nimitykseen');
});

test('Nollaa oppiminen: vahvistus, nimitykset ja havainnot pois, oma arvio säilyy', async t => {
  const view = mount(t);
  await seed(savedPlacesRepo, setSavedPlaces, [{ id: 'p1', name: 'Työ', usualTravelMinutes: 35, useLearned: true }]);
  await seed(placeAliasesRepo, setPlaceAliases, [{ id: 'a1', placeId: 'p1', alias: 'duuni', confirmations: 2 }]);
  await seed(commuteObservationsRepo, setCommuteObservations, observations('p1', [30, 31, 40, 38]));

  const reset = action(view, 'place-reset', 'p1');
  assert.equal(accessibleName(reset), 'Nollaa oppiminen: Työ');
  reset.click();
  await answerConfirm(view.doc, false);
  assert.equal(getState().placeAliases.length, 1, 'peruutus ei nollaa');

  action(view, 'place-reset', 'p1').click();
  await answerConfirm(view.doc, true);
  await flush();
  const state = getState();
  assert.deepEqual(state.placeAliases, []);
  assert.deepEqual(state.commuteObservations, []);
  assert.equal(state.savedPlaces[0].useLearned, false);
  assert.equal(state.savedPlaces[0].usualTravelMinutes, 35, 'oma arvio säilyi');
  assert.equal(view.q('[data-action="place-reset"]'), null, 'nollattavaa ei enää ole');
  // Sama tallennuksessa (muisti tai kanta): seuraava lataus ei tuo oppimista takaisin.
  assert.deepEqual(await storedRows(placeAliasesRepo), []);
  assert.deepEqual(await storedRows(commuteObservationsRepo), []);
  const place = await storedRow(savedPlacesRepo, 'p1');
  assert.deepEqual([place.useLearned, place.usualTravelMinutes], [false, 35]);
});

test('oppiminen: 6 matkan mediaani ehdotetaan, hyväksyntä ottaa käyttöön, alle 3 matkaa ei ehdoteta', async t => {
  const view = mount(t);
  await seed(savedPlacesRepo, setSavedPlaces, [
    { id: 'p1', name: 'Työ', usualTravelMinutes: 30 },
    { id: 'p2', name: 'Sali', usualTravelMinutes: 15 },
    { id: 'p3', name: 'Mökki', usualTravelMinutes: 90, useLearned: true }
  ]);
  await seed(commuteObservationsRepo, setCommuteObservations, [
    ...observations('p1', [34, 36, 38, 38, 40, 42]),
    ...observations('p2', [14, 16])
  ]);
  assert.match(view.q('[data-place-row="p3"]').textContent.replace(/\s+/g, ' '),
    /Kuitattuja matkoja 0\. Opittua kestoa käytetään, kun matkoja on vähintään 3\. Siihen asti käytetään omaa arviotasi\./,
    'lupa ilman matkoja ei teeskentele opittua kestoa');

  const work = () => view.q('[data-place-row="p1"]').textContent.replace(/\s+/g, ' ');
  assert.match(work(), /Viimeisten 6 matkan mediaani oli 38 min — käytä tätä\?/);
  assert.equal(getState().savedPlaces[0].useLearned, false, 'ehdotus ei muuta mitään');

  action(view, 'learned-usual', 'p1').click();
  await flush();
  assert.equal(getState().savedPlaces.find(p => p.id === 'p1').usualTravelMinutes, 38);
  assert.equal(view.q('[data-action="learned-usual"][data-id="p1"]'), null, 'sama luku, ei enää ehdotusta');
  assertSameNode(view.doc.activeElement, action(view, 'learned-on', 'p1'));

  action(view, 'learned-on', 'p1').click();
  await flush();
  assert.equal(getState().savedPlaces.find(p => p.id === 'p1').useLearned, true);
  assert.match(work(), /Opittu kesto on käytössä\. Lähtö lasketaan 40 minuutin mukaan/);
  assertSameNode(view.doc.activeElement, action(view, 'learned-off', 'p1'), 'fokus vastakkaiseen valintaan');

  action(view, 'learned-off', 'p1').click();
  await flush();
  assert.equal(getState().savedPlaces.find(p => p.id === 'p1').useLearned, false);

  const gym = view.q('[data-place-row="p2"]').textContent.replace(/\s+/g, ' ');
  assert.match(gym, /Kuitattuja matkoja 2\. Opittua kestoa ehdotetaan, kun matkoja on vähintään 3\./);
  assert.equal(view.q('[data-action="learned-on"][data-id="p2"]'), null);
});

test('oppiminen viikonpäivän ja lähtöajan mukaan: tarkentuneet luvut näkyvät perusteluineen, harva ryhmä ei', async t => {
  const view = mount(t);
  await seed(savedPlacesRepo, setSavedPlaces, [{ id: 'p1', name: 'Työ', usualTravelMinutes: 30, useLearned: true }]);
  const trip = (observedOn, plannedDeparture, travelMinutes, i) => ({
    id: `b-${i}`, placeId: 'p1', observedOn, plannedDeparture, actualDeparture: plannedDeparture,
    travelMinutes, source: 'user_confirmed', createdAt: `${observedOn}T06:00:00Z`
  });
  // Maanantait 8.10 hitaita (4), tiistait 8.30 nopeita (3), keskiviikko vain kerran.
  await seed(commuteObservationsRepo, setCommuteObservations, [
    trip('2026-08-31', '08:10', 48, 1), trip('2026-09-07', '08:10', 50, 2),
    trip('2026-09-14', '08:10', 52, 3), trip('2026-09-21', '08:10', 50, 4),
    trip('2026-09-08', '08:30', 29, 5), trip('2026-09-15', '08:30', 30, 6), trip('2026-09-22', '08:30', 28, 7),
    trip('2026-09-23', '17:00', 25, 8)
  ]);
  const row = view.q('[data-place-row="p1"]').textContent.replace(/\s+/g, ' ');
  assert.match(row, /Opittu kesto on käytössä\./);
  assert.match(row, /Näinä aikoina lähtö lasketaan niiden omista matkoista:/);
  assert.match(row, /Maanantaisin klo 8\.00–8\.30 lähteneet: mediaani 50 min, varman päälle 52 min \(4 matkaa\)/);
  assert.match(row, /Tiistaisin klo 8\.30–9\.00 lähteneet: mediaani 29 min, varman päälle 30 min \(3 matkaa\)/);
  assert.doesNotMatch(row, /Keskiviikkoisin/, 'yksi matka ei tarkenna mitään');
  assert.match(row, /Tarkennus tarvitsee vähintään 3 matkaa samalta viikonpäivältä ja lähtöajalta \(30 min\)\./);
  assert.equal(getState().savedPlaces[0].useLearned, true, 'näkymä ei muuta mitään');

  // Ilman hyväksyntää sama tieto on ehdotuksen perustelu.
  action(view, 'learned-off', 'p1').click();
  await flush();
  assert.match(view.q('[data-place-row="p1"]').textContent.replace(/\s+/g, ' '),
    /Käyttöön otettuna lähtö tarkentuu näinä aikoina niiden omista matkoista:/);
});

// ================================================================ myöhästely ja etuaika

test('myöhästelyehdotus: kysymys ei muuta mitään; "Ei nyt" piilottaa; hyväksyntä ja palautus', async t => {
  const view = mount(t);
  await seed(savedPlacesRepo, setSavedPlaces, [{ id: 'p1', name: 'Työ', usualTravelMinutes: 30 }]);
  await seed(commuteObservationsRepo, setCommuteObservations,
    observations('p1', [30, 30, 30, 30], { plannedDeparture: '07:30', actualDeparture: '07:38' }));

  const late = () => view.q('[data-section="late"]');
  assert.match(late().textContent, /Olet viime kerroilla lähtenyt keskimäärin 8 min suunniteltua myöhemmin\./);
  assert.match(late().textContent, /Aloitetaanko lähtömuistutus 10 min aikaisemmin\?/);
  assert.doesNotMatch(late().textContent, /myöhästel|huono|taas/i, 'neutraali sävy');
  assert.deepEqual(getState().lifeSettings, [], 'ehdotus ei tallentanut mitään');

  action(view, 'offset-dismiss').click();
  assert.equal(late(), null, '"Ei nyt" piilottaa ehdotuksen');
  assert.deepEqual(getState().lifeSettings, []);
  resetPlacesSettings();
  renderPlacesSettings(view.container);
  assert.ok(late(), 'uusi istunto kysyy uudelleen');

  action(view, 'offset-accept').click();
  await flush();
  assert.equal(currentLifeSettings(getState()).reminderOffsetMinutes, 10);
  assert.match(late().textContent, /Lähtömuistutus tulee nyt 10 min tavallista aikaisemmin\./);
  assert.equal(view.q('[data-action="offset-accept"]'), null, 'hyväksytty ehdotus ei toistu');
  assertSameNode(view.doc.activeElement, action(view, 'offset-clear'));

  action(view, 'offset-clear').click();
  await flush();
  assert.equal(currentLifeSettings(getState()).reminderOffsetMinutes, 0);
});

test('valmistautumisehdotus paikalle: perusteltu kysymys, "Ei nyt" piilottaa, hyväksyntä tallentaa eikä toistu ilman uutta näyttöä', async t => {
  const view = mount(t);
  await seed(savedPlacesRepo, setSavedPlaces, [
    { id: 'p1', name: 'Työ', usualTravelMinutes: 30, travelMode: 'driving' },
    { id: 'p2', name: 'Sali', usualTravelMinutes: 15, preparationMinutes: 5 }
  ]);
  const departed = (placeId, preparationMinutes, actualDeparture, prefix, count = 4) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i}`, placeId, observedOn: `2026-09-${String(14 + i).padStart(2, '0')}`,
      plannedDeparture: '07:30', actualDeparture, preparationMinutes, source: 'user_confirmed',
      createdAt: `2026-09-${String(14 + i).padStart(2, '0')}T05:00:00Z`
    }));
  await seed(commuteObservationsRepo, setCommuteObservations, [
    ...departed('p1', 10, '07:38', 'w'),
    ...departed('p2', 5, '07:32', 'g')
  ]);
  const work = () => view.q('[data-place-row="p1"]').textContent.replace(/\s+/g, ' ');
  assert.match(work(), /Olet viime kerroilla lähtenyt keskimäärin 8 min suunniteltua myöhemmin\. Pidennetäänkö valmistautumista 10 minuutista 20 minuuttiin\?/);
  assert.match(work(), /Perustuu 4 viimeisimpään kuittaamaasi lähtöön tähän paikkaan\. Valmistautumiseen on nyt varattu kulkutavan oletus\. Mitään ei muuteta ilman hyväksyntääsi\./);
  assert.equal(view.q('[data-action="prep-accept"][data-id="p2"]'), null, '2 min myöhässä ei ole syy ehdottaa');
  assert.equal(getState().savedPlaces.find(p => p.id === 'p1').preparationMinutes, null, 'ehdotus ei muuttanut mitään');
  const accept = action(view, 'prep-accept', 'p1');
  assert.equal(accessibleName(accept), 'Varaa valmistautumiseen 20 min: Työ');
  assert.equal(accessibleName(action(view, 'prep-dismiss', 'p1')), 'Ei nyt: Työ');

  action(view, 'prep-dismiss', 'p1').click();
  assert.equal(view.q('[data-action="prep-accept"][data-id="p1"]'), null, '"Ei nyt" piilottaa');
  assertSameNode(view.doc.activeElement, action(view, 'place-edit', 'p1'));
  resetPlacesSettings();
  renderPlacesSettings(view.container);
  assert.ok(view.q('[data-action="prep-accept"][data-id="p1"]'), 'uusi istunto kysyy uudelleen');

  action(view, 'prep-accept', 'p1').click();
  await flush();
  assert.equal(getState().savedPlaces.find(p => p.id === 'p1').preparationMinutes, 20);
  assert.match(work(), /valmistautuminen 20 min/);
  assert.equal(view.q('[data-action="prep-accept"][data-id="p1"]'), null,
    'vanhat lähdöt (10 min valmistautumisella) eivät heti todista uutta pidennystä');
  assertSameNode(view.doc.activeElement, action(view, 'place-edit', 'p1'));

  // Uusi näyttö: neljä lähtöä 20 min valmistautumisella, yhä 6 min myöhässä.
  setCommuteObservations([...getState().commuteObservations, ...departed('p1', 20, '07:36', 'n')]
    .map((o, i) => (o.id.startsWith('n-') ? { ...o, observedOn: `2026-09-2${i % 4}`, createdAt: `2026-09-2${i % 4}T06:00:00Z` } : o)));
  assert.match(work(), /Pidennetäänkö valmistautumista 20 minuutista 30 minuuttiin\?/);
});

test('oletusetuaika: 5/10/15 yhdellä napautuksella, oma arvo, virheellinen oma arvo ja Escape', async t => {
  const view = mount(t);
  const chip = minutes => view.q(`[data-action="buffer-set"][data-value="${minutes}"]`);
  chip(15).click();
  await flush();
  assert.equal(currentLifeSettings(getState()).arrivalBufferMinutes, 15);
  assert.equal(chip(15).getAttribute('aria-pressed'), 'true');
  assert.equal(chip(10).getAttribute('aria-pressed'), 'false');
  assertSameNode(view.doc.activeElement, chip(15), 'fokus pysyy valitussa');

  action(view, 'buffer-custom').click();
  const input = view.byId('plcBufferCustom');
  assertSameNode(view.doc.activeElement, input);
  assert.equal(input.value, '15');
  assert.equal(input.getAttribute('min'), '0');
  assert.equal(input.getAttribute('max'), '120');
  type(input, '500');
  action(view, 'buffer-save').click();
  await flush();
  assert.match(view.byId('plcBufferCustomError').textContent, /0–120/);
  assert.equal(currentLifeSettings(getState()).arrivalBufferMinutes, 15, 'virheellinen arvo ei tallentunut');

  type(view.byId('plcBufferCustom'), '25');
  press(view.doc, 'Enter');
  await flush();
  assert.equal(currentLifeSettings(getState()).arrivalBufferMinutes, 25);
  const custom = action(view, 'buffer-custom');
  assert.equal(accessibleName(custom), 'Oma: 25 min');
  assert.equal(custom.textContent.trim(), '✓ Oma: 25 min');
  assert.equal(custom.getAttribute('aria-pressed'), 'true');
  assert.ok(view.qa('[data-action="buffer-set"]').every(button => button.getAttribute('aria-pressed') === 'false'));

  custom.click();
  press(view.doc, 'Escape');
  assert.equal(view.byId('plcBufferCustom'), null, 'Escape sulkee oman arvon kentän');
  assertSameNode(view.doc.activeElement, action(view, 'buffer-custom'));
});

// ================================================================ suojaus, saavutettavuus, näppäimistö

test('TURVA: nimi, osoite, alue, nimitys ja muistiinpano suojataan', async t => {
  const view = mount(t);
  const evil = '<img src=x onerror=alert(1)>';
  await seed(savedPlacesRepo, setSavedPlaces, [{
    id: 'p"1', name: evil, address: '<script>alert(1)</script>', area: '<b>alue</b>', note: '"><i>muisti</i>'
  }]);
  await seed(placeAliasesRepo, setPlaceAliases, [{ id: 'a1', placeId: 'p"1', alias: '<svg onload=alert(1)>', confirmations: 2 }]);
  for (const selector of ['img', 'script', 'b', 'i', 'svg[onload]']) {
    assert.equal(view.q(selector), null, `käyttäjän teksti ei luonut elementtiä ${selector}`);
  }
  const text = view.text();
  assert.ok(text.includes(evil));
  assert.ok(text.includes('<script>alert(1)</script>'));
  const edit = view.q('[data-action="place-edit"]');
  assert.equal(edit.getAttribute('data-id'), 'p"1');
  assert.equal(accessibleName(edit), `Muokkaa paikkaa ${evil}`);
  edit.click();
  assert.equal(view.byId('plcName').value, evil);
  assert.equal(view.byId('plcNote').value, '"><i>muisti</i>');
  assert.equal(view.q('i'), null);
});

test('saavutettavuus: jokaisella ohjaimella on nimi ja tyyppi, numerokentillä rajat, Escape palauttaa fokuksen', async t => {
  const view = mount(t);
  await seed(savedPlacesRepo, setSavedPlaces, [{ id: 'p1', name: 'Työ', usualTravelMinutes: 30 }]);
  await seed(placeAliasesRepo, setPlaceAliases, [{ id: 'a1', placeId: 'p1', alias: 'duuni', confirmations: 2 }]);
  await seed(commuteObservationsRepo, setCommuteObservations,
    observations('p1', [30, 32, 34, 36], { plannedDeparture: '07:30', actualDeparture: '07:40' }));
  action(view, 'buffer-custom').click();
  const opener = action(view, 'place-edit', 'p1');
  opener.click();

  const controls = view.qa('button, input, select, textarea');
  assert.ok(controls.length > 20, `ohjaimia ${controls.length}`);
  for (const control of controls) {
    assert.ok(accessibleName(control).length > 0, `nimetön ohjain: ${control.outerHTML.slice(0, 90)}`);
    if (control.localName === 'button') assert.ok(control.hasAttribute('type'));
    if (control.getAttribute('type') === 'number') {
      assert.ok(control.hasAttribute('min') && control.hasAttribute('max'), `${control.id}: min ja max`);
    }
  }
  assert.equal(accessibleName(view.byId('plcUseLearned')), 'Käytä omista matkoista opittua kestoa');
  assert.ok(view.byId('plcBuffer').getAttribute('aria-describedby').includes('plcBufferHint'),
    'oletusarvon selitys luetaan kentän kanssa');

  assertSameNode(view.doc.activeElement, view.byId('plcName'));
  press(view.doc, 'Escape');
  assert.equal(view.byId('plcName'), null);
  assertSameNode(view.doc.activeElement, action(view, 'place-edit', 'p1'), 'fokus palasi avaajaan');
});

test('kuuntelijat kerran, luonnos säilyy taustan piirrossa, nollaus tyhjentää', async t => {
  const view = mount(t);
  initPlacesSettings(view.container);
  initPlacesSettings(view.container);
  action(view, 'place-add').click();
  type(view.byId('plcName'), 'Kirjasto');
  setCommuteObservations([]);
  assert.equal(view.byId('plcName').value, 'Kirjasto', 'taustamuutos ei pyyhkinyt kirjoitusta');
  const save = action(view, 'place-save');
  save.click();
  save.click();
  await flush();
  assert.equal(getState().savedPlaces.length, 1, 'yksi tallennus');

  action(view, 'place-add').click();
  type(view.byId('plcName'), 'Keskeneräinen');
  resetPlacesSettings();
  renderPlacesSettings(view.container);
  assert.equal(view.byId('plcName'), null, 'edellisen käyttäjän luonnos ei jää näkyviin');
});

test('tallennuksen tila näkyy: portti kiinni -> "vain tämän istunnon ajan"', t => {
  const view = mount(t);
  const keys = ['savedPlaces', 'placeAliases', 'commuteObservations', 'lifeSettings'];
  const notice = view.q('.lh-notice');
  if (keys.every(key => isTableAvailable(key))) assert.equal(notice, null);
  else assert.match(notice.textContent, /vain tämän istunnon ajan/);
});

test('lähdekoodi: ei sijaintia, ei lokia, ei index.html-riippuvuutta, yksi kuuntelijasidonta', () => {
  const source = read('src/app/views/placesSettings.js');
  assert.doesNotMatch(source, /geolocation|latitude|longitude|\blat\b|\blng\b|coords/i, 'ei sijaintia');
  assert.doesNotMatch(source, /console\.|logEvent|logFailure/);
  assert.doesNotMatch(source, /(?<![.\w])(?:el|maybe)\(/, 'säiliö annetaan parametrina');
  assert.doesNotMatch(source, /document\.addEventListener|window\.addEventListener/);
  assert.match(source, /bound\.has\(container\)/, 'sidonta kerran säiliötä kohti');
  assert.match(source, /singleFlight/);
});
