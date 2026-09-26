// Saavutettavuus Day 1: fokus ja live-alueet uudelleenpiirron yli (CRIT-03)
// sekä ehdotusten valintaruutujen nimet (CRIT-05).
//
// Suunta piirtää säiliönsä uudelleen jokaisella tilamuutoksella. Ennen
// korjausta painettu painike irtosi DOMista (fokus -> <body>), ja sama
// role="alert"/"status"-ilmoitus kirjoitettiin uudelleen joka piirrolla.
// Testit ajetaan jäsennetyssä index.html-DOMissa (tests/helpers/a11yDom.mjs),
// jossa poistettu fokusoitu elementti vie fokuksen bodyyn kuten selaimessa.
//
// Solmuja verrataan assertSameNode-apuvälineellä, ei assert.equal:lla
// (ks. sen kommentti).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { freezeLocalDate } from './helpers/clock.mjs';
import {
  press, choose, type, accessibleName, assertSameNode, assertDifferentNode
} from './helpers/a11yDom.mjs';
import { mountSuunta, echoClient, flush, USER } from './helpers/a11ySuunta.mjs';
import { getState, setTasks, setGoals, setDomainLoadStatus } from '../src/app/state.js';
import { createGoal } from '../src/app/actions.js';
import { createLifeArea, saveWeeklyCapacity } from '../src/app/alignment.js';
import {
  startTracking, cancelTracking, setTimerRepoForTests, discardPendingTracking, pendingTimer
} from '../src/app/timeTracking.js';
import { adoptLoadedTimers } from '../src/app/timerState.js';
import { saveTimer } from '../src/data/timerStore.js';
import { renderHtml, setHtml, captureFocus, restoreFocus, reannounce } from '../src/ui/dom.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal } from '../src/domain/goal.js';

const THURSDAY = '2026-09-17';
const WEEK = '2026-09-14';

const task = (id, date, minutes, extra = {}) =>
  normalizeTask({ id, title: 'Tehtävä ' + id, date, durationMinutes: minutes, ...extra });

let app = null;
afterEach(async () => {
  if (app) await app.unmount();
  app = null;
});

function mount(options) {
  app = mountSuunta(options);
  return app;
}

// ================================================================ AJASTINPALKKI

test('CRIT-03 KRIITTINEN: Tauko ja Jatka säilyttävät fokuksen samassa painikkeessa (ei <body>)', async (t) => {
  const start = freezeLocalDate(t, THURSDAY, '10:00').getTime();
  const { doc } = mount();
  setTasks([task('w1', THURSDAY, 60, { title: 'Raportti' })]);
  await startTracking({ kind: 'task', id: 'w1' }, { now: start });
  const bar = doc.getElementById('timerBar');
  assert.equal(bar.hidden, false);
  const toggle = bar.querySelector('[data-timer="pause"]');
  toggle.focus();
  assertSameNode(doc.activeElement, toggle);

  press(doc, 'Enter');
  await flush();
  assertSameNode(doc.activeElement, toggle, 'fokus pysyy painetussa painikkeessa');
  assert.equal(toggle.isConnected, true);
  assert.equal(toggle.dataset.timer, 'resume');
  assert.equal(toggle.textContent, 'Jatka');
  assert.equal(bar.classList.contains('is-paused'), true);
  assert.equal(bar.querySelector('.timer-state').textContent, 'Tauolla', 'tila tekstinä, ei vain värinä');
  assert.equal(toggle.hasAttribute('aria-disabled'), false, 'kesken-tila poistuu');

  press(doc, 'Enter');
  await flush();
  assertSameNode(doc.activeElement, toggle);
  assert.equal(toggle.dataset.timer, 'pause');
  assert.equal(toggle.textContent, 'Tauko');
  assert.equal(bar.querySelector('.timer-state').textContent, 'Käynnissä');
});

test('CRIT-03: asiaan liittymätön tilamuutos ei irrota ajastinpalkin painiketta', async (t) => {
  const start = freezeLocalDate(t, THURSDAY, '10:00').getTime();
  const { doc } = mount();
  setTasks([task('w1', THURSDAY, 60)]);
  await startTracking({ kind: 'task', id: 'w1' }, { now: start });
  const stop = doc.querySelector('#timerBar [data-timer="stop"]');
  stop.focus();
  // Esim. resume-päivityksen kymmenet tilamuutokset.
  for (let i = 0; i < 5; i += 1) setTasks([...getState().tasks, task(`x${i}`, THURSDAY, 15)]);
  assertSameNode(doc.activeElement, stop);
  assert.equal(stop.isConnected, true);
});

test('CRIT-03: ajastinpalkki piirretään uudelleen vain, kun ajastin vaihtuu tai katoaa', async (t) => {
  const start = freezeLocalDate(t, THURSDAY, '10:00').getTime();
  const { doc, render } = mount();
  await startTracking({ kind: 'none' }, { now: start });
  const bar = doc.getElementById('timerBar');
  const first = bar.querySelector('.timer-state');
  render();
  assertSameNode(bar.querySelector('.timer-state'), first, 'sama ajastin: sama rakenne');
  await cancelTracking({ confirmFn: async () => true });
  assert.equal(bar.hidden, true);
  assert.equal(bar.innerHTML, '');
  await startTracking({ kind: 'none' }, { now: start + 60000 });
  assertDifferentNode(bar.querySelector('.timer-state'), first, 'uusi ajastin: uusi rakenne');
  assert.equal(bar.querySelectorAll('[data-timer="pause"]').length, 1);
});

// ================================================================ SUUNNAN LISTAT

test('CRIT-03: kohdistuksen "Ohita nyt" vie fokuksen seuraavan rivin ensimmäiseen ohjaimeen, viimeisen jälkeen otsikkoon', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { doc } = mount();
  await createLifeArea({ name: 'Perhe', importance: 5, categoryKey: 'perhe' });
  setTasks([task('u1', THURSDAY, 30, { category: 'koti' }), task('u2', THURSDAY, 30, { category: 'koti' })]);
  doc.getElementById('dirOpenUnassigned').focus();
  press(doc, 'Enter');
  const skip = doc.querySelector('[data-assign-skip="task:u1"]');
  assert.ok(skip !== null, 'kohdistusrivit näkyvät');
  skip.focus();
  press(doc, 'Enter');
  assertSameNode(doc.activeElement, doc.getElementById('dirAssignCat-task:u2'), 'seuraavan rivin ensimmäinen ohjain');
  doc.querySelector('[data-assign-skip="task:u2"]').focus();
  press(doc, 'Enter');
  const heading = doc.getElementById('dirUnassignedTitle');
  assertSameNode(doc.activeElement, heading, 'ei rivejä jäljellä: osion otsikko');
  assert.equal(heading.getAttribute('tabindex'), '-1', 'otsikko ei tule sarkainjärjestykseen');
});

test('CRIT-03: kuormittavuusarvio vie fokuksen seuraavan rivin ensimmäiseen valintaan', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { doc } = mount();
  await createLifeArea({ name: 'Työ', importance: 3, categoryKey: 'tyo' });
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 1200, energyBudgetMinutes: 120 });
  setTasks([task('e1', THURSDAY, 60, { category: 'tyo' }), task('e2', THURSDAY, 30, { category: 'tyo' })]);
  const open = doc.querySelector('#dirQuality [data-quality-action="rate_energy"]');
  assert.ok(open !== null, 'kuormittavuuden arviointi tarjotaan');
  open.focus();
  press(doc, 'Enter');
  doc.querySelector('[data-energy-rate="task:e1"][data-level="3"]').focus();
  press(doc, 'Enter');
  await flush();
  assert.equal(doc.querySelector('[data-energy-rate="task:e1"]') === null, true, 'arvioitu rivi poistui');
  assertSameNode(doc.activeElement, doc.querySelector('[data-energy-rate="task:e2"][data-level="1"]'));
});

test('CRIT-03: tavoitteen aluevalinta säilyttää fokuksen, vaikka rivi siirtyy toiseen ryhmään', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { doc } = mount();
  await createLifeArea({ name: 'Perhe', importance: 5 });
  // Oikean toiminnon kautta: tila JA repositorio (portti auki tai kiinni).
  const created = await createGoal({ title: 'Lapset' });
  assert.equal(created.ok, true);
  const id = created.goal.id;
  const select = doc.getElementById(`dirGoalArea-${id}`);
  select.focus();
  choose(select, getState().lifeAreas[0].id);
  await flush();
  assert.equal(getState().goals[0].lifeAreaId, getState().lifeAreas[0].id, 'liitos tallentui');
  const after = doc.getElementById(`dirGoalArea-${id}`);
  assertSameNode(doc.activeElement, after, 'fokus samassa valinnassa uudessa ryhmässä');
  assert.equal(after.value, getState().lifeAreas[0].id);
});

// Pidätys koskee VAIN tehtävän päivitystä: auki olevalla lifeAreas-portilla
// (aktivointiaalto J) alueen luonti kulkee samaa korviketta ja jäi ennen
// odottamaan, jolloin koko `node --test` jumittui. Aikaraja kaataa testin
// nopeasti, jos jokin kirjoitus silti jää odottamaan.
test('CRIT-03: arviojonon painike säilyy muun tilamuutoksen yli; tallennuksen ajan fokus on kortin otsikossa', { timeout: 10_000 }, async (t) => {
  freezeLocalDate(t, THURSDAY);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const client = echoClient({ hold, holdWhen: (table, operation) => table === 'tasks' && operation === 'update' });
  const { doc } = mount({ client });
  try {
    await createLifeArea({ name: 'Työ', importance: 3, categoryKey: 'tyo' });
    setTasks([task('q1', THURSDAY, null, { category: 'tyo' }), task('q2', THURSDAY, null, { category: 'tyo' })]);
    doc.getElementById('dirOpenEstimate').focus();
    press(doc, 'Enter');
    const chip = doc.querySelector('#dirEstimate [data-queue-estimate="task:q1"][data-minutes="30"]');
    chip.focus();
    const progress = doc.querySelector('#dirEstimate [role="status"]');
    setGoals([normalizeGoal({ id: 'g9', title: 'Muu', status: 'active' })]);
    assertSameNode(doc.activeElement, chip, 'sama painike muun tilamuutoksen jälkeen');
    assertSameNode(doc.querySelector('#dirEstimate [role="status"]'), progress, 'edistyminen (role=status) ei kirjoitu uudelleen');

    press(doc, 'Enter');
    await flush(3);
    assert.ok(client.calls.some(call => call.table === 'tasks' && call.operation === 'update'),
      'arvio lähti tehtävän päivityksenä, joka on pidätetty');
    assertSameNode(doc.activeElement, doc.getElementById('dirQueueTitle-main'), 'tallennus kesken: otsikko, ei <body>');
    release();
    await flush();
    assert.equal(getState().tasks.find(x => x.id === 'q1').durationMinutes, 30);
    assertSameNode(doc.activeElement, doc.getElementById('dirQueueTitle-main'));
    assert.match(doc.getElementById('dirQueueTitle-main').textContent, /Tehtävä q2/);
  } finally {
    release();
  }
});

// ================================================================ LIVE-ALUEET

test('CRIT-03 KRIITTINEN: sama latausvirhe (role=alert) ei kirjoitu uudelleen joka piirrolla', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { doc, render } = mount();
  setDomainLoadStatus('lifeAreas', false, { message: 'verkko' });
  const alert = doc.querySelector('#dirPersistNote [role="alert"]');
  assert.ok(alert !== null, 'latausvirhe näkyy');
  const today = doc.querySelector('#todayDirection [role="status"]');
  assert.ok(today !== null, 'päivän kortti kertoo latausvirheen');
  for (let i = 0; i < 3; i += 1) render();
  setTasks([task('z', THURSDAY, 15)]);
  assertSameNode(doc.querySelector('#dirPersistNote [role="alert"]'), alert, 'sama solmu: ruudunlukija ei lue uudelleen');
  assertSameNode(doc.querySelector('#todayDirection [role="status"]'), today);
  setDomainLoadStatus('lifeAreas', true);
  assert.equal(doc.querySelector('#dirPersistNote [role="alert"]') === null, true, 'korjaantunut virhe poistuu');
});

test('CRIT-03: aloituksen kortti ei kirjoitu uudelleen muuttumattomana; fokus säilyy', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { doc, render } = mount();
  const title = doc.getElementById('dirSetupTitle');
  assert.ok(title !== null, 'aloitus näkyy ilman alueita');
  const chip = doc.querySelector('#dirSetup [data-setup-draft="Perhe"]');
  chip.focus();
  render();
  setTasks([task('z', THURSDAY, 15)]);
  assertSameNode(doc.getElementById('dirSetupTitle'), title);
  assertSameNode(doc.activeElement, chip);
});

test('avattu "Miksi tämä näkyy?" pysyy auki ja fokus summaryssa, kun luvut päivittyvät', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { doc } = mount();
  await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'tyo' });
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 120 });
  setTasks([task('o1', THURSDAY, 300, { category: 'tyo' })]);
  const details = doc.querySelector('#dirSignals details.dir-why');
  assert.ok(details !== null, 'havainnolla on "Miksi?"-osio');
  details.querySelector('summary').focus();
  press(doc, 'Enter');
  assert.equal(details.open, true);
  const before = doc.getElementById('dirSignals').innerHTML;
  setTasks([task('o1', THURSDAY, 320, { category: 'tyo' })]);
  assert.notEqual(doc.getElementById('dirSignals').innerHTML, before, 'luvut muuttuivat: osio piirrettiin uudelleen');
  const again = doc.querySelector('#dirSignals details.dir-why');
  assert.equal(again.open, true, 'auki pysyy');
  assertSameNode(doc.activeElement, again.querySelector('summary'));
});

// ================================================================ NIMET

test('CRIT-05: ehdotusten valintaruuduilla on yksilöllinen nimi "Valitse: <ehdotus>"', async (t) => {
  freezeLocalDate(t, '2026-09-20');
  const { doc } = mount();
  await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'tyo' });
  await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 600, categoryKey: 'perhe' });
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 600 });
  await saveWeeklyCapacity({ weekStart: '2026-09-21', availableMinutes: 600 });
  setTasks([
    task('n1', '2026-09-22', 500, { category: 'tyo' }),
    task('n2', '2026-09-23', 300, { category: 'tyo', priority: 'matala' })
  ]);
  const boxes = doc.querySelectorAll('#dirProposals input[type="checkbox"]');
  assert.ok(boxes.length >= 2, `valintaruutuja ${boxes.length}`);
  const names = boxes.map(accessibleName);
  assert.equal(new Set(names).size, names.length, names.join(' | '));
  for (const [index, box] of boxes.entries()) {
    const title = box.closest('.assist-row').querySelector('.assist-title').textContent;
    assert.equal(names[index], `Valitse: ${title}`);
  }
  // Näkyvä teksti pysyy lyhyenä: nimen alku on näkyvä "Valitse" (WCAG 2.5.3).
  assert.equal(boxes[0].closest('label').querySelector('.visually-hidden').textContent.startsWith(':'), true);
  assert.equal(accessibleName(doc.getElementById('dirProposals')), 'Mitä muutan ensi viikolla?', 'ryhmällä on nimi');
});

// ================================================================ APUVÄLINE

test('dom.js: setHtml kirjoittaa uudelleen, jos DOMia on muutettu käsin välissä', async () => {
  const { doc } = mount();
  const host = doc.getElementById('dirPersistNote');
  assert.equal(setHtml(host, '<p class="hint">A</p>'), true);
  assert.equal(setHtml(host, '<p class="hint">A</p>'), false, 'sama merkintä: ei kirjoitusta');
  host.querySelector('p').textContent = 'käsin muutettu';
  assert.equal(setHtml(host, '<p class="hint">A</p>'), true, 'piirretty tila palautetaan');
  assert.equal(host.textContent, 'A');
});

test('dom.js: reannounce korvaa ilmoituksen samanlaisella uudella solmulla; säiliön merkintä ei muutu', async () => {
  const { doc } = mount();
  const host = doc.getElementById('dirPersistNote');
  setHtml(host, '<p class="field-error" id="x-err" role="alert">Virhe</p>');
  const before = doc.getElementById('x-err');
  const after = reannounce(before);
  assertDifferentNode(after, before);
  assert.equal(after.isConnected, true);
  assert.equal(before.isConnected, false);
  assert.equal(after.getAttribute('role'), 'alert');
  assert.equal(after.textContent, 'Virhe');
  assert.equal(setHtml(host, '<p class="field-error" id="x-err" role="alert">Virhe</p>'), false,
    'sama merkintä: seuraava piirto ei kirjoita (eikä kuuluta) uudelleen');
});

// ================================================================ TOISTETTU TOIMINTO

test('aloitus: "Lisää" jo valitulla nimellä tyhjentää kentän, vaikka kortin merkintä ei muutu', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { doc } = mount();
  doc.querySelector('#dirSetup [data-setup-draft="Perhe"]').focus();
  press(doc, 'Enter');
  const input = doc.getElementById('dirSetupCustomName');
  type(input, 'Perhe');
  input.focus();
  press(doc, 'Enter');
  assertSameNode(doc.getElementById('dirSetupCustomName'), input, 'kortti ei piirtynyt uudelleen');
  assert.equal(input.value, '', 'kirjoitettu nimi ei jää näkyviin');
  assert.match(doc.getElementById('dirSetupCard').textContent, /Valittu: Perhe\./);
});

test('aloitus: tyhjä nimi ja "Lisää" kahdesti kuuluttaa virheen uudelleen; kenttä viittaa virheeseen', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { doc } = mount();
  doc.querySelector('#dirSetup [data-setup="add-custom"]').focus();
  press(doc, 'Enter');
  const first = doc.getElementById('dirSetupError');
  assert.ok(first !== null, 'virhe näkyy');
  assert.equal(first.getAttribute('role'), 'alert');
  assert.equal(first.textContent, 'Kirjoita alueelle nimi.');
  const input = doc.getElementById('dirSetupCustomName');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), 'dirSetupError');
  assert.equal(doc.activeElement.dataset.setup, 'add-custom', 'fokus pysyy Lisää-painikkeessa');

  press(doc, 'Enter');
  const second = doc.getElementById('dirSetupError');
  assertDifferentNode(second, first, 'toistettu toiminto: uusi role=alert-solmu kuulutetaan');
  assert.equal(second.textContent, 'Kirjoita alueelle nimi.');
  assertSameNode(doc.getElementById('dirSetupCustomName'), input, 'vain ilmoitus vaihtui, ei kenttä');

  // Muu tilamuutos ei kuuluta samaa virhettä uudelleen (CRIT-03).
  setTasks([task('z', THURSDAY, 15)]);
  assertSameNode(doc.getElementById('dirSetupError'), second);
});

test('arviojono: sama virheellinen minuuttimäärä kuulutetaan uudelleen; kenttä viittaa virheeseen', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { doc } = mount();
  await createLifeArea({ name: 'Työ', importance: 3, categoryKey: 'tyo' });
  setTasks([task('q1', THURSDAY, null, { category: 'tyo' })]);
  doc.getElementById('dirOpenEstimate').focus();
  press(doc, 'Enter');
  doc.querySelector('#dirEstimate [data-queue-custom="task:q1"]').focus();
  press(doc, 'Enter');
  type(doc.getElementById('dirQueueCustom-main'), '0');
  doc.querySelector('#dirEstimate [data-queue-estimate="task:q1"][data-minutes="custom"]').focus();
  press(doc, 'Enter');
  const first = doc.getElementById('dirQueueError-main');
  assert.ok(first !== null, 'virhe näkyy');
  assert.equal(first.getAttribute('role'), 'alert');
  const input = doc.getElementById('dirQueueCustom-main');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), 'dirQueueError-main');
  assert.equal(doc.activeElement.dataset.minutes, 'custom', 'fokus pysyy Tallenna arvio -painikkeessa');

  press(doc, 'Enter');
  const second = doc.getElementById('dirQueueError-main');
  assertDifferentNode(second, first, 'sama virheellinen arvo uudelleen: uusi role=alert-solmu');
  assert.equal(second.textContent, first.textContent);
  assert.equal(getState().tasks[0].durationMinutes ?? null, null, 'mitään ei tallennettu');
});

// ================================================================ AJASTINPALKKI: KESKEN JA TYHJENNYS

/** Ajastimen kanta, jonka päivitykset voi pidättää (ajastintoiminto kesken). */
function timerRepo({ hold = null } = {}) {
  return {
    isPersistent: () => true,
    insert: async timer => ({ ok: true, value: timer }),
    update: async () => { if (hold) await hold; return { ok: true }; },
    remove: async () => ({ ok: true }),
    list: async () => ({ ok: true, value: [] })
  };
}

test('CRIT-03: tyhjentynyt kirjaamattoman ajastuksen lokero vie fokuksen palkin painikkeeseen, ei <body>', async (t) => {
  const start = freezeLocalDate(t, THURSDAY, '10:00').getTime();
  const { doc, render } = mount();
  setTimerRepoForTests(timerRepo());
  saveTimer(USER.id, { id: 'local-L', startedAt: new Date(start - 60 * 60000).toISOString(), targetKind: 'none' });
  adoptLoadedTimers([{ id: 'remote-R', startedAt: new Date(start - 30 * 60000).toISOString(), targetKind: 'none' }]);
  render();
  const bar = doc.getElementById('timerBar');
  const discard = bar.querySelector('[data-timer="pending-discard"]');
  assert.ok(discard !== null, 'kirjaamaton ajastus näkyy palkissa');
  discard.focus();

  const gone = await discardPendingTracking({ confirmFn: async () => true });
  assert.equal(gone.cancelled, true);
  assert.equal(pendingTimer(), null);
  render();
  assert.equal(bar.querySelector('[data-timer="pending-discard"]'), null, 'lokero tyhjeni');
  const toggle = bar.querySelector('[data-timer="pause"]');
  assertSameNode(doc.activeElement, toggle, 'palkin oma painike, ei <body>');
  assert.equal(toggle.hasAttribute('tabindex'), false, 'painike pysyy sarkainjärjestyksessä');
});

test('CRIT-03: ajastintoiminnon ajan KAIKKI palkin painikkeet ovat aria-disabled, ja tila poistuu lopuksi', { timeout: 10_000 }, async (t) => {
  const start = freezeLocalDate(t, THURSDAY, '10:00').getTime();
  const { doc } = mount();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  try {
    setTimerRepoForTests(timerRepo({ hold }));
    await startTracking({ kind: 'none' }, { now: start });
    const bar = doc.getElementById('timerBar');
    const buttons = () => bar.querySelectorAll('[data-timer]');
    assert.equal(buttons().length, 3, 'Tauko, Pysäytä ja kirjaa, Hylkää');
    bar.querySelector('[data-timer="pause"]').focus();
    press(doc, 'Enter');
    await flush(3);
    for (const button of buttons()) {
      assert.equal(button.getAttribute('aria-disabled'), 'true', `kesken: ${button.dataset.timer}`);
    }
    release();
    await flush();
    for (const button of buttons()) {
      assert.equal(button.hasAttribute('aria-disabled'), false, `valmis: ${button.dataset.timer}`);
    }
    assert.equal(bar.querySelector('[data-timer="resume"]') !== null, true, 'tauko tallentui');
  } finally {
    release();
  }
});

test('dom.js: renderHtml palauttaa fokuksen avaimella; estetty sama ohjain -> varaotsikko', async () => {
  const { doc } = mount();
  const host = doc.getElementById('dirQuality');
  renderHtml(host, '<button type="button" data-x="1">Yksi</button><button type="button" data-x="2">Kaksi</button>');
  host.querySelector('[data-x="2"]').focus();
  renderHtml(host, '<p>uusi</p><button type="button" data-x="2">Kaksi</button>');
  assertSameNode(doc.activeElement, host.querySelector('[data-x="2"]'));
  const state = captureFocus(host);
  host.innerHTML = '<button type="button" data-x="2" disabled>Kaksi</button>';
  const focused = restoreFocus(host, state, { fallback: ['dirSignalsTitle'] });
  assertSameNode(focused, doc.getElementById('dirSignalsTitle'));
  assertSameNode(doc.activeElement, focused);
});
