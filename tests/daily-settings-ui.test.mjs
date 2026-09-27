// Profiili → Arki (uni ja rytmi, aamurutiini, herätys, aamukatsaus, ateriat)
// ja Asetukset → Ohjaus ja puhe oikeassa (jäsennetyssä) index.html-DOMissa.
//
// Portit ovat tuotehaaralla kiinni: arjen asetukset tallentuvat
// muistivarastoon, profiili kulkee Supabase-korvikkeen läpi (echoClient).
// Android-herätyksen alusta on kaksoiskappale (setAlarmPlatformForTests):
// laitetta ei käytetä, eikä lupaa pyydetä ilman napautusta.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';
import { createDocument, installDocument, accessibleName, press, type, choose, isRendered } from './helpers/a11yDom.mjs';
import { echoClient, flush, USER } from './helpers/a11ySuunta.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { lifeSettingsRepo } from '../src/data/collectionsRepo.js';
import {
  resetState, getState, subscribe, setTasks, setProfile, setProfileSegment, setLifeSettings, currentLifeSettings,
  setSavedPlaces, setCalendarEvents, setCommuteObservations, setNotificationPreferences
} from '../src/app/state.js';
import { renderNotificationSettings } from '../src/app/views/notificationSettings.js';
import { morningPlanOn } from '../src/app/dailyLifeModel.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { resetDailyLifeActions, saveLifeSettings } from '../src/app/dailyLifeActions.js';
import { renderProfileSegments, initProfileSegments } from '../src/app/views/profileSegments.js';
import {
  renderDailySettings, initDailySettings, resetDailySettings, setAlarmPlatformForTests,
  ESCALATION_PRESETS, escalationFor, presetOf, validateSleepDraft, validateRoutineDraft, routineFromDraft,
  validateAlarmDraft, alarmFromDraft, validateMealDraft, mealRhythmFromDraft, readAlarmStatus, nextAlarmFor,
  alarmModeHint, musicPickNotice
} from '../src/app/views/dailySettings.js';
import {
  renderGuidanceSettings, initGuidanceSettings, resetGuidanceSettings, validateGuidanceDraft, guidanceChangesFrom
} from '../src/app/views/guidanceSettings.js';
import { validateEscalation, DEFAULT_ESCALATION } from '../src/domain/alarmPlan.js';
import {
  ALARM_MODE, ALARM_MODES, PROTECTION, REMINDER_TOPICS, DEFAULT_DELIVERY, DELIVERY, GUIDANCE_STYLE
} from '../src/domain/dailyLife.js';
import { normalizeTask } from '../src/domain/task.js';
import { clearToasts } from '../src/ui/toast.js';
import { closeConfirmDialogs } from '../src/ui/confirm.js';

const INDEX_HTML = read('index.html');

let mounted = null;

/** Profiili auki, Arki-osio ja Ohjaus piirretään jokaisesta tilamuutoksesta (kuten main.js). */
function mount({ client = echoClient(), segment = 'daily', alarmPlatform = { native: false, alarms: null } } = {}) {
  clearUser();
  clearLocalUserData();
  resetState();
  resetDailyLifeActions();
  resetDailySettings();
  resetGuidanceSettings();
  setAlarmPlatformForTests(alarmPlatform);
  const doc = createDocument(INDEX_HTML);
  const uninstall = installDocument(doc);
  setUser(USER);
  setClient(client);
  doc.getElementById('app').classList.remove('app-hidden');
  for (const screen of doc.querySelectorAll('.screen')) {
    const on = screen.id === 'screen-profile';
    screen.classList.toggle('active', on);
    screen.toggleAttribute('inert', !on);
    screen.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
  setProfileSegment(segment);
  initProfileSegments();
  initDailySettings();
  initGuidanceSettings();
  const render = () => {
    renderProfileSegments();
    renderDailySettings();
    renderGuidanceSettings();
  };
  const unsubscribe = subscribe(render);
  render();
  mounted = {
    doc, client, render,
    $: id => doc.getElementById(id),
    async unmount() {
      unsubscribe();
      clearToasts();
      closeConfirmDialogs();
      await flush(5);
      resetDailySettings();
      resetGuidanceSettings();
      setAlarmPlatformForTests(null);
      uninstall();
    }
  };
  return mounted;
}

beforeEach(() => { mounted = null; });

afterEach(async () => {
  if (mounted) await mounted.unmount();
  mounted = null;
  clearUser();
  resetState();
});

/** Korvaa repositorion metodi testin ajaksi (verkkovirhe). */
async function withFailing(repo, method, run) {
  const original = repo[method];
  repo[method] = async () => ({ ok: false, error: { message: 'verkko', userMessage: 'Yhteys katkesi.' } });
  try { return await run(); } finally { repo[method] = original; }
}

const text = node => node.textContent.replace(/\s+/g, ' ').trim();

function alertsIn(root) {
  return root.querySelectorAll('[role="alert"]').map(node => text(node)).filter(Boolean);
}

/** Kirjoita kenttään ja kerro siitä kuten näppäily (input) ja poistuminen (change). */
function fill(node, value) {
  type(node, value);
  node.dispatch('change');
}

// ================================================================ puhtaat apurit

test('voimistuksen tasot: jokainen kelpaa herätyssuunnitelmalle ja tunnistetaan takaisin', () => {
  assert.deepEqual(ESCALATION_PRESETS.map(p => p.label), ['Lempeä', 'Tavallinen', 'Voimakas']);
  for (const preset of ESCALATION_PRESETS) {
    for (const mode of ALARM_MODES) {
      const steps = escalationFor(preset.key, mode);
      assert.equal(validateEscalation(steps).valid, true, `${preset.key}/${mode}`);
      assert.equal(presetOf(steps), preset.key, `${preset.key}/${mode} tunnistetaan`);
      const speaks = steps.some(s => s.step === 'speech' || s.step === 'repeat_speech');
      assert.equal(speaks, mode === ALARM_MODE.SPEECH || mode === ALARM_MODE.COMBINATION,
        `puhe vain puhetavoissa (${preset.key}/${mode})`);
    }
  }
  // Oletusvoimistus on "Tavallinen"; tuntematon on mukautettu (null), ei arvattu taso.
  assert.equal(presetOf(DEFAULT_ESCALATION), 'normal');
  assert.equal(presetOf([{ afterSeconds: 0, step: 'loud' }, { afterSeconds: 30, step: 'soft' }]), null);
  assert.equal(presetOf(null), null);
  // Palautettu taulukko on kopio: muokkaus ei muuta tasoa.
  const copy = escalationFor('gentle', ALARM_MODE.SOUND);
  copy[0].afterSeconds = 99;
  assert.equal(ESCALATION_PRESETS[0].steps[0].afterSeconds, 0);
  assert.equal(Object.isFrozen(ESCALATION_PRESETS[0].steps[0]), true);
});

test('luonnosten tarkistukset: rajat, tyhjä ei ole nolla, kelvollinen läpäisee', () => {
  const sleep = { sleepTarget: '7.5', wakeTime: '06:45', weekendWakeShift: '60', weekendBedShift: '0', windDown: '30', bedtimeTarget: '' };
  assert.equal(validateSleepDraft(sleep).valid, true);
  assert.ok(validateSleepDraft({ ...sleep, sleepTarget: '15' }).errors.sleepTarget);
  assert.ok(validateSleepDraft({ ...sleep, sleepTarget: '' }).errors.sleepTarget, 'tyhjä unitavoite ei ole nolla');
  assert.ok(validateSleepDraft({ ...sleep, wakeTime: '' }).errors.wakeTime);
  assert.ok(validateSleepDraft({ ...sleep, windDown: '181' }).errors.windDown);
  assert.ok(validateSleepDraft({ ...sleep, weekendWakeShift: '-5' }).errors.weekendWakeShift);
  assert.ok(validateSleepDraft({ ...sleep, weekendBedShift: '1.5' }).errors.weekendBedShift, 'desimaali ei kelpaa minuuteiksi');
  assert.ok(validateSleepDraft({ ...sleep, bedtimeTarget: '25:00' }).errors.bedtimeTarget);
  assert.equal(validateSleepDraft(null).valid, false);

  const rows = [{ id: 'a', name: 'Suihku', minutes: '10', protection: PROTECTION.MANDATORY }];
  assert.equal(validateRoutineDraft(rows).valid, true);
  const bad = validateRoutineDraft([{ name: ' ', minutes: '0', protection: 'x' }]).errors;
  assert.ok(bad['0.name'] && bad['0.minutes'] && bad['0.protection']);
  assert.ok(validateRoutineDraft(Array.from({ length: 21 }, () => rows[0])).errors.list, 'enintään 20 vaihetta');
  assert.deepEqual(routineFromDraft([{ id: null, name: ' Kahvi ', minutes: '5', protection: PROTECTION.OPTIONAL }]),
    [{ name: 'Kahvi', minutes: 5, protection: PROTECTION.OPTIONAL }], 'uusi vaihe ilman tunnistetta');

  const alarm = { enabled: true, mode: ALARM_MODE.SOUND, preset: 'normal', snooze: '9', maxSnoozes: '3', timing: 'plan', weekdayTime: '', weekendTime: '' };
  assert.equal(validateAlarmDraft(alarm).valid, true);
  assert.ok(validateAlarmDraft({ ...alarm, snooze: '31' }).errors.snooze);
  assert.ok(validateAlarmDraft({ ...alarm, maxSnoozes: '4' }).errors.maxSnoozes);
  assert.ok(validateAlarmDraft({ ...alarm, timing: 'fixed' }).errors.times, 'kiinteä ilman aikaa');
  assert.equal(validateAlarmDraft({ ...alarm, timing: 'fixed', weekendTime: '08:30' }).valid, true);
  const saved = alarmFromDraft({ ...alarm, timing: 'plan', weekdayTime: '06:00' }, null);
  assert.equal(saved.followPlan, true);
  assert.equal(saved.weekdayTime, null, 'suunnitelman seuraaminen ei jätä kiinteää aikaa voimaan');

  const meals = { meals: [{ name: 'Lounas', time: '11:30', prep: '15' }], waterEvery: '', waterFrom: '', waterTo: '', supplements: [], lateCutoff: '' };
  assert.equal(validateMealDraft(meals).valid, true);
  assert.equal(mealRhythmFromDraft(meals).waterEveryMinutes, null, 'tyhjä väli on tuntematon, ei nolla');
  assert.ok(validateMealDraft({ ...meals, waterFrom: '08:00' }).errors.waterEveryMinutes);
  assert.ok(validateMealDraft({ ...meals, waterEvery: '10', waterFrom: '08:00', waterTo: '20:00' }).errors.waterEveryMinutes);
  assert.ok(validateMealDraft({ ...meals, waterEvery: '600', waterFrom: '08:00', waterTo: '20:00' }).errors.waterEveryMinutes);
  assert.ok(validateMealDraft({ ...meals, meals: [{ name: 'Iltapala', time: '', prep: '' }] }).errors['meals.0.time']);
  assert.ok(validateMealDraft({ ...meals, meals: [{ name: 'Iltapala', time: '21:00', prep: '2.5' }] }).errors['meals.0.prepMinutes']);
});

test('herätyksen tila luetaan varovasti: tuntematon on null, ei "kyllä"', () => {
  assert.deepEqual({ ...readAlarmStatus({ exactAllowed: true, fullScreenAllowed: false, soundName: ' Aamu ' }) },
    {
      supported: null, exact: true, fullScreen: false, soundName: 'Aamu', soundPicked: null,
      musicPicked: null, musicName: null, musicLost: null, reason: null
    });
  // Oma herätysmusiikki: laite kertoo valinnan, nimen ja menetetyn valinnan.
  assert.equal(readAlarmStatus({ musicPicked: true, musicName: ' Aamulaulu.mp3 ' }).musicName, 'Aamulaulu.mp3');
  assert.equal(readAlarmStatus({ musicPicked: false, musicLost: true }).musicLost, true);
  assert.equal(readAlarmStatus({ musicPicked: 'true' }).musicPicked, null, 'vain tosi boolean');
  // ManifestivalAlarm.status() kertoo vain soundPicked-lipun: valittu ääni ei näy oletusäänenä.
  assert.equal(readAlarmStatus({ supported: true, exact: true, fullScreen: true, soundPicked: true }).soundPicked, true);
  assert.equal(readAlarmStatus({ canScheduleExactAlarms: false }).exact, false);
  assert.equal(readAlarmStatus({ value: { canUseFullScreenIntent: true } }).fullScreen, true);
  for (const raw of [null, undefined, 'x', 42, { exactAllowed: 'true' }]) {
    const status = readAlarmStatus(raw);
    assert.equal(status.exact, null, JSON.stringify(raw));
    assert.equal(status.fullScreen, null);
  }
});

test('ohjauksen tarkistus ja muutokset: kaikki aiheet tallennetaan, kooste vaatii kellonajan', () => {
  const delivery = { ...DEFAULT_DELIVERY };
  const draft = { style: GUIDANCE_STYLE.ACTIVE, speech: true, delivery, digest: true, digestTime: '07:30' };
  assert.equal(validateGuidanceDraft(draft).valid, true);
  assert.ok(validateGuidanceDraft({ ...draft, digestTime: '' }).errors.digestTime);
  assert.ok(validateGuidanceDraft({ ...draft, style: 'kova' }).errors.style);
  assert.ok(validateGuidanceDraft({ ...draft, delivery: { ...delivery, meal: 'huuto' } }).errors['delivery.meal']);
  const changes = guidanceChangesFrom({ ...draft, digest: false, digestTime: '' }, { digestTime: '19:00' });
  assert.deepEqual(Object.keys(changes.delivery), [...REMINDER_TOPICS]);
  assert.equal(changes.digestTime, '19:00', 'tyhjä aika pitää tallennetun');
});

// ================================================================ Arki: piirto

test('Arki oletuksilla: kentät nimetty, rajat, ei virheitä, selain kertoo herätyksen rajan', async () => {
  const { $ } = mount();
  const daily = $('profileDailySection');
  assert.equal(isRendered(daily), true);

  // Uni ja rytmi profiilin ja asetusten oletuksista.
  assert.equal($('dsSleepTarget').value, '8');
  assert.equal($('dsWakeTime').value, '07:00');
  assert.equal($('dsWeekendWakeShift').value, '60');
  assert.equal($('dsWeekendBedShift').value, '60');
  assert.equal($('dsWindDown').value, '30');
  assert.equal($('dsBedtimeTarget').value, '');

  // Jokainen kenttä nimetty, numerokentillä rajat, painikkeilla tyyppi.
  for (const field of daily.querySelectorAll('input, select')) {
    assert.ok(accessibleName(field), `nimetön kenttä #${field.id}`);
    if (field.type === 'number') {
      assert.ok(field.hasAttribute('min') && field.hasAttribute('max'), `#${field.id} ilman rajoja`);
    }
  }
  for (const button of daily.querySelectorAll('button')) {
    assert.equal(button.getAttribute('type'), 'button', accessibleName(button));
    assert.ok(accessibleName(button), 'nimetön painike');
  }
  assert.deepEqual(alertsIn(daily), [], 'oletuksilla ei virheitä');

  // Tyhjä aamurutiini kertoo, mitä sen tilalla käytetään.
  assert.match(text($('dailyRoutineSettings')), /Ei vaiheita\. Silloin aamuun varataan profiilin aamutoimet \(1 h\)/);
  // Herätys pois päältä; selain sanoo suoraan, ettei herätys soi.
  assert.match(text($('dailyAlarmNext')), /Herätys ei ole käytössä/);
  assert.match(text($('dailyAlarmStatus')), /Herätys toimii vain Android-sovelluksessa/);
  assert.equal($('dsAlarmEnabled').checked, false);
  assert.equal($('dsAlarmTimingPlan').checked, true);
  assert.equal($('dsAlarmEscalation').value, 'normal', 'oletusvoimistus tunnistetaan Tavalliseksi');
  assert.equal($('dsMorningBrief').checked, false, 'puhe ja katsaus eivät ole oletuksena päällä');
  // Portti kiinni: kerrotaan, että asetukset säilyvät vain istunnon ajan.
  assert.match(text($('dailyLifeNotice')), /säilyvät toistaiseksi vain tämän istunnon ajan/);
});

test('Arkea ei lasketa, kun osio on piilossa; osion vaihto piirtää sen', async () => {
  const { $ } = mount({ segment: 'settings' });
  assert.equal($('dailySleepSettings').innerHTML, '', 'piilossa olevaa Arkea ei piirretty');
  assert.ok($('gsSave'), 'Ohjaus ja puhe piirretty Asetuksiin');
  $('segmentProfileDaily').click();
  assert.ok($('dsSleepSave'), 'vaihto piirsi Arjen');
});

// ================================================================ Arki: uni ja rytmi

test('uni ja rytmi: profiili tallentuu profiilin polkua, rytmi arjen asetuksiin', async () => {
  const { $, client } = mount();
  fill($('dsSleepTarget'), '7.5');
  fill($('dsWakeTime'), '06:30');
  fill($('dsWindDown'), '45');
  fill($('dsBedtimeTarget'), '22:30');
  $('dsSleepSave').click();
  await flush();

  const state = getState();
  assert.equal(state.profile.sleepTargetHours, 7.5);
  assert.equal(state.profile.defaultWakeTime, '06:30');
  assert.equal(state.profile.commuteMinutes, 30, 'muut profiilin kentät säilyivät');
  const upserts = client.calls.filter(call => call.table === 'profile' && call.operation === 'upsert');
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].payload.sleep_target_hours, 7.5);
  assert.equal(upserts[0].payload.default_wake_time, '06:30');

  const settings = currentLifeSettings(state);
  assert.equal(settings.windDownMinutes, 45);
  assert.equal(settings.bedtimeTarget, '22:30');
  assert.equal(settings.weekendWakeShiftMaxMinutes, 60, 'muuttamaton arvo ennallaan');
  // Asetukset-osion profiililomake näyttää saman arvon (se tallentaa koko profiilin).
  assert.equal($('pfSleepTarget').value, '7.5');
  assert.equal($('pfDefaultWake').value, '06:30');
  assert.equal($('dsWakeTime').value, '06:30', 'piirto tallennetusta');
  assert.match(text($('toastHost')), /Uni ja rytmi tallennettu/);
});

test('pelkkä rytmin muutos ei kirjoita profiilia (oletukset eivät ole käyttäjän dataa)', async () => {
  const { $, client } = mount();
  fill($('dsWeekendWakeShift'), '90');
  $('dsSleepSave').click();
  await flush();
  assert.equal(client.calls.filter(call => call.table === 'profile').length, 0);
  assert.equal(getState().profileExists, false);
  assert.equal(currentLifeSettings(getState()).weekendWakeShiftMaxMinutes, 90);
});

test('uni ja rytmi: virheet näkyvät kentän kohdalla (role=alert), mitään ei tallenneta', async () => {
  const { $, client } = mount();
  fill($('dsSleepTarget'), '20');
  fill($('dsWindDown'), '');
  $('dsSleepSave').click();
  await flush();
  const target = $('dsSleepTarget');
  assert.equal(target.getAttribute('aria-invalid'), 'true');
  assert.equal(target.getAttribute('aria-describedby'), 'dsSleepTargetError');
  assert.equal($('dsSleepTargetError').getAttribute('role'), 'alert');
  assert.match(text($('dsSleepTargetError')), /Unitavoite on 1–14 tuntia/);
  assert.match(text($('dsWindDownError')), /0–180/);
  assert.equal(client.calls.length, 0);
  assert.deepEqual(getState().lifeSettings, []);
  assert.equal($('dsSleepTarget').value, '20', 'kirjoitettu arvo jäi korjattavaksi');

  // Enter kentässä tallentaa: korjattu arvo menee läpi.
  fill($('dsSleepTarget'), '9');
  fill($('dsWindDown'), '20');
  $('dsSleepTarget').focus();
  press(mounted.doc, 'Enter');
  await flush();
  assert.equal(getState().profile.sleepTargetHours, 9);
  assert.equal($('dsSleepTargetError'), null, 'virhe poistui');
});

test('kesken oleva muokkaus säilyy, kun jokin muu tilassa muuttuu', async () => {
  const { $ } = mount();
  type($('dsWindDown'), '50');
  type($('dsAlarmSnooze'), '12');
  setTasks([normalizeTask({ id: 't1', title: 'Muu muutos', date: '2026-09-28' })]);
  assert.equal($('dsWindDown').value, '50');
  assert.equal($('dsAlarmSnooze').value, '12');
  // Toisen osion tallennus ei kirjoita tämän kenttiä uudelleen.
  $('dsMorningBrief').click();
  await flush();
  assert.equal(currentLifeSettings(getState()).morningBriefEnabled, true);
  assert.equal($('dsWindDown').value, '50');
  assert.equal($('dsAlarmSnooze').value, '12');
});

// ================================================================ Arki: aamurutiini

test('aamurutiini: lisää, nimeä, siirrä, poista ja tallenna suojausluokkineen', async () => {
  const { $ } = mount();
  $('dsStepAdd').click();
  assert.equal(mounted.doc.activeElement.id, 'dsStepName-0', 'fokus uuteen vaiheeseen');
  fill($('dsStepName-0'), 'Pukeutuminen');
  fill($('dsStepMinutes-0'), '10');
  choose($('dsStepProtection-0'), PROTECTION.MANDATORY);
  $('dsStepAdd').click();
  fill($('dsStepName-1'), 'Aamulenkki');
  fill($('dsStepMinutes-1'), '30');
  choose($('dsStepProtection-1'), PROTECTION.OPTIONAL);
  $('dsStepAdd').click();
  fill($('dsStepName-2'), 'Hengitys');
  fill($('dsStepMinutes-2'), '5');
  choose($('dsStepProtection-2'), PROTECTION.PROTECTED);

  // Hengitys ylös: se on nyt toinen, fokus seuraa siirrettyä vaihetta.
  mounted.doc.querySelector('[data-step-up="2"]').click();
  assert.equal($('dsStepName-1').value, 'Hengitys');
  assert.equal(mounted.doc.activeElement.getAttribute('data-step-up'), '1');
  assert.equal(mounted.doc.querySelector('[data-step-up="0"]').disabled, true, 'ensimmäinen ei voi nousta');
  assert.equal(accessibleName(mounted.doc.querySelector('[data-step-remove="1"]')), 'Poista vaihe: Hengitys');
  assert.match(text($('dailyRoutineSettings')), /Yhteensä 45 min/);

  // Lenkki pois.
  mounted.doc.querySelector('[data-step-remove="2"]').click();
  $('dsRoutineSave').click();
  await flush();

  const routine = currentLifeSettings(getState()).morningRoutine;
  assert.deepEqual(routine.map(s => [s.name, s.minutes, s.protection]), [
    ['Pukeutuminen', 10, PROTECTION.MANDATORY],
    ['Hengitys', 5, PROTECTION.PROTECTED]
  ]);
  assert.ok(routine.every(s => typeof s.id === 'string' && s.id), 'tunnisteet syntyivät tallennuksessa');
  assert.match(text($('toastHost')), /Aamurutiini tallennettu/);
});

test('toistuvien rivien kentät nimetään riveittäin: ruudunlukija erottaa vaiheen, aterian ja lisäravinteen', async () => {
  const { $ } = mount();
  $('dsStepAdd').click();
  $('dsStepAdd').click();
  $('dsMealAdd').click();
  $('dsMealAdd').click();
  $('dsSupAdd').click();
  $('dsSupAdd').click();

  const names = ids => ids.map(id => accessibleName($(id)));
  assert.deepEqual(names(['dsStepName-0', 'dsStepMinutes-0', 'dsStepProtection-0', 'dsStepName-1', 'dsStepMinutes-1', 'dsStepProtection-1']), [
    'Vaihe 1: Nimi', 'Vaihe 1: Minuutit', 'Vaihe 1: Suojaus', 'Vaihe 2: Nimi', 'Vaihe 2: Minuutit', 'Vaihe 2: Suojaus'
  ]);
  assert.deepEqual(names(['dsMealName-0', 'dsMealTime-0', 'dsMealPrep-0', 'dsMealName-1', 'dsMealTime-1']), [
    'Ateria 1: Ateria', 'Ateria 1: Aika', 'Ateria 1: Valmistelu (min)', 'Ateria 2: Ateria', 'Ateria 2: Aika'
  ]);
  assert.deepEqual(names(['dsSupName-0', 'dsSupTime-0', 'dsSupName-1', 'dsSupTime-1']), [
    'Lisäravinne 1: Lisäravinne', 'Lisäravinne 1: Aika', 'Lisäravinne 2: Lisäravinne', 'Lisäravinne 2: Aika'
  ]);
  // Rivin numero on vain ruudunlukijalle: näkyvä nimilappu ei muutu.
  const label = mounted.doc.querySelector('label[for="dsStepName-1"]');
  assert.equal(label.querySelector('.visually-hidden').textContent, 'Vaihe 2: ');

  // Koko Arki-osiossa kenttälistan nimet ovat yksilöllisiä.
  const all = $('profileDailySection').querySelectorAll('input, select').map(field => accessibleName(field));
  const duplicates = all.filter((name, index) => all.indexOf(name) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test('aamurutiini: puuttuva nimi ja kesto näkyvät virheinä; peruutus palauttaa tallennetun', async () => {
  const { $ } = mount();
  await saveLifeSettings({ morningRoutine: [{ id: 'aamu-1', name: 'Suihku', minutes: 10, protection: PROTECTION.MANDATORY }] });
  assert.equal($('dsStepName-0').value, 'Suihku');

  $('dsStepAdd').click();
  fill($('dsStepMinutes-1'), '0');
  $('dsRoutineSave').click();
  await flush();
  assert.match(text($('dsStepName-1Error')), /Anna vaiheelle nimi/);
  assert.match(text($('dsStepMinutes-1Error')), /1–240/);
  assert.equal($('dsStepName-1Error').getAttribute('role'), 'alert');
  assert.equal(currentLifeSettings(getState()).morningRoutine.length, 1, 'virheellistä ei tallennettu');

  $('dsRoutineCancel').click();
  assert.equal($('dsStepName-1'), null, 'luonnos hylättiin');
  assert.equal($('dsStepName-0').value, 'Suihku');
  assert.deepEqual(alertsIn($('dailyRoutineSettings')), []);
});

test('aamurutiini: enintään 20 vaihetta — lisäys estyy rajalla', async () => {
  const { $ } = mount();
  await saveLifeSettings({
    morningRoutine: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, name: `Vaihe ${i}`, minutes: 1, protection: PROTECTION.OPTIONAL }))
  });
  assert.equal($('dsStepAdd').disabled, true);
  assert.match(text($('dailyRoutineSettings')), /enintään 20/);
});

// ================================================================ Arki: herätys

test('herätys: tapa, voimistus ja kiinteä arkiaika tallentuvat; puhe mukaan vain puhetavassa', async t => {
  freezeLocalDate(t, '2026-09-29', '12:00'); // tiistai
  const { $ } = mount();
  $('dsAlarmEnabled').click();
  choose($('dsAlarmMode'), ALARM_MODE.COMBINATION);
  choose($('dsAlarmEscalation'), 'strong');
  assert.match(text($('dsAlarmEscalationHint')), /Kova ääni heti alusta\. Puhe kuuluu/);
  $('dsAlarmTimingFixed').click();
  assert.ok($('dsAlarmWeekday'), 'kiinteät ajat tulivat näkyviin');
  fill($('dsAlarmWeekday'), '06:15');
  fill($('dsAlarmSnooze'), '5');
  fill($('dsAlarmMaxSnoozes'), '2');
  $('dsAlarmSave').click();
  await flush();

  const alarm = currentLifeSettings(getState()).alarm;
  assert.equal(alarm.enabled, true);
  assert.equal(alarm.mode, ALARM_MODE.COMBINATION);
  assert.deepEqual(alarm.escalation, escalationFor('strong', ALARM_MODE.COMBINATION));
  assert.equal(validateEscalation(alarm.escalation).valid, true);
  assert.equal(alarm.followPlan, false);
  assert.equal(alarm.weekdayTime, '06:15');
  assert.equal(alarm.weekendTime, null);
  assert.equal(alarm.snoozeMinutes, 5);
  assert.equal(alarm.maxSnoozes, 2);

  // Seuraava herätys: huomenna (ke) klo 6.15 oman ajan mukaan.
  const next = nextAlarmFor(getState(), Date.now());
  assert.equal(next.date, '2026-09-30');
  assert.equal(next.time, '06:15');
  assert.match(text($('dailyAlarmNext')), /Seuraava herätys ke 30\.9\. klo 6\.15/);
  assert.match(text($('dailyAlarmNext')), /Oma arkiaamun herätysaikasi 6\.15/);
});

test('herätys: kiinteä aika ilman kellonaikaa on virhe (role=alert); suunnitelma ei vaadi aikaa', async () => {
  const { $ } = mount();
  $('dsAlarmEnabled').click();
  $('dsAlarmTimingFixed').click();
  $('dsAlarmSave').click();
  await flush();
  assert.equal($('dsAlarmTimesError').getAttribute('role'), 'alert');
  assert.match(text($('dsAlarmTimesError')), /Anna arki- tai viikonloppuherätyksen aika/);
  assert.equal(currentLifeSettings(getState()).alarm.enabled, false, 'ei tallennettu');

  $('dsAlarmTimingPlan').click();
  assert.equal($('dsAlarmWeekday'), null);
  $('dsAlarmSave').click();
  await flush();
  const alarm = currentLifeSettings(getState()).alarm;
  assert.equal(alarm.enabled, true);
  assert.equal(alarm.followPlan, true);
  assert.equal($('dsAlarmTimesError'), null);
});

test('herätys seuraa suunnitelmaa: aamun meno aikaistaa seuraavaa herätystä', async t => {
  freezeLocalDate(t, '2026-09-29', '20:00');
  const { $ } = mount();
  await saveLifeSettings({ alarm: { enabled: true, followPlan: true } });
  const plain = nextAlarmFor(getState(), Date.now());
  assert.equal(plain.date, '2026-09-30');
  assert.equal(plain.time, '07:00', 'profiilin arkiherätys');

  // Huomenna klo 7.30 meno, matka 20 min oma arvio: herätys aiemmin.
  const { saveCalendarEvent } = await import('../src/app/dailyLifeActions.js');
  await saveCalendarEvent({ title: 'Lääkäri', date: '2026-09-30', startTime: '07:30', durationMinutes: 30, travelMinutes: 20 });
  const early = nextAlarmFor(getState(), Date.now());
  assert.ok(early.time < '07:00', `herätys ${early.time}`);
  assert.equal(early.source, 'plan');
  assert.match(text($('dailyAlarmNext')), new RegExp(`klo ${Number(early.time.slice(0, 2))}\\.${early.time.slice(3)}`));
});

test('KRIITTINEN: Seuraava herätys samasta laskentapolusta kuin Tänään ja kalenteri', () => {
  // Ei näkymää: nextAlarmFor on puhdas tilan ja hetken funktio.
  const now = new Date(2026, 8, 29, 20, 0);
  setUser(USER);
  setProfile({ sleepTargetHours: 8, defaultWakeTime: '07:00', routineMinutes: 45, commuteMinutes: 30 }, true);
  setLifeSettings([{ id: 's1', arrivalBufferMinutes: 10, alarm: { enabled: true, followPlan: true } }]);

  // Opittu matka (hyväksytty, 4 x 45 min), paikalla ei omaa tavallista matka-aikaa:
  // lähtö 8.00 - 10 - 45 = 7.05, herätys 7.05 - 45 = 6.20.
  setSavedPlaces([{ id: 'p1', name: 'Työ', useLearned: true, overheadMinutes: 0, preparationMinutes: 0 }]);
  setCommuteObservations(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map((d, i) => ({
    id: `o${i}`, placeId: 'p1', observedOn: d, plannedDeparture: '07:00', actualDeparture: '07:00', travelMinutes: 45
  })));
  setCalendarEvents([{ id: 'e1', title: 'Työ', date: '2026-09-30', startTime: '08:00', durationMinutes: 480, placeId: 'p1' }]);
  assert.equal(morningPlanOn('2026-09-30', { now }).wakeTime, '06:20', 'Tänään-näkymän aamu');
  const learned = nextAlarmFor(getState(), now.getTime());
  assert.deepEqual([learned.date, learned.time], ['2026-09-30', '06:20']);
  assert.doesNotMatch(learned.reason, /profiilisi matka-ajasta/, 'opittua matkaa ei korvata profiilin arvauksella');

  // Kotona pidettävä meno ilman paikkaa: lähtö = alku, ei profiilin työmatkaa.
  setCalendarEvents([{ id: 'h1', title: 'Etäpalaveri', date: '2026-09-30', startTime: '07:30', durationMinutes: 30 }]);
  assert.equal(morningPlanOn('2026-09-30', { now }).wakeTime, '06:45');
  assert.equal(nextAlarmFor(getState(), now.getTime()).time, '06:45');

  // Lähtö edellisenä iltana (meno klo 0.30, matka 45 min): aamu ei ole sen herätys.
  setCalendarEvents([
    { id: 'n1', title: 'Yölento', date: '2026-09-30', startTime: '00:30', durationMinutes: 60, placeId: 'p1' },
    { id: 'e1', title: 'Työ', date: '2026-09-30', startTime: '08:00', durationMinutes: 480, placeId: 'p1' }
  ]);
  const both = nextAlarmFor(getState(), now.getTime());
  assert.deepEqual([both.date, both.time], ['2026-09-30', '06:20']);
});

test('herätys: "Seuraa suunnitelmaa" ja takaisin "Kiinteä aika" ei tyhjennä tallennettuja kellonaikoja', async () => {
  const { $ } = mount();
  await saveLifeSettings({ alarm: { enabled: true, followPlan: false, weekdayTime: '06:30', weekendTime: '08:15' } });
  assert.deepEqual([$('dsAlarmWeekday').value, $('dsAlarmWeekend').value], ['06:30', '08:15']);

  $('dsAlarmTimingPlan').click();
  assert.equal($('dsAlarmWeekday'), null, 'kiinteät ajat piiloon');
  $('dsAlarmTimingFixed').click();
  assert.deepEqual([$('dsAlarmWeekday').value, $('dsAlarmWeekend').value], ['06:30', '08:15'],
    'piilossa ollut kenttä ei ole tyhjä arvo');

  // Vain arkiajan muutos: viikonlopun tallennettu aika säilyy.
  fill($('dsAlarmWeekday'), '06:00');
  $('dsAlarmSave').click();
  await flush();
  const alarm = currentLifeSettings(getState()).alarm;
  assert.deepEqual([alarm.followPlan, alarm.weekdayTime, alarm.weekendTime], [false, '06:00', '08:15']);

  // Kirjoitettu (tallentamaton) aika säilyy myös edestakaisin vaihdossa.
  fill($('dsAlarmWeekend'), '09:00');
  $('dsAlarmTimingPlan').click();
  $('dsAlarmTimingFixed').click();
  assert.deepEqual([$('dsAlarmWeekday').value, $('dsAlarmWeekend').value], ['06:00', '09:00']);
  // "Seuraa suunnitelmaa" tallentuu ilman omia aikoja kuten ennenkin.
  $('dsAlarmTimingPlan').click();
  $('dsAlarmSave').click();
  await flush();
  const plan = currentLifeSettings(getState()).alarm;
  assert.deepEqual([plan.followPlan, plan.weekdayTime, plan.weekendTime], [true, null, null]);
});

test('mukautettu voimistus säilyy, kun tasoa ei vaihdeta', async () => {
  const custom = [{ afterSeconds: 0, step: 'soft' }, { afterSeconds: 120, step: 'loud' }, { afterSeconds: 240, step: 'loud' }];
  const { $ } = mount();
  await saveLifeSettings({ alarm: { escalation: custom } });
  assert.equal($('dsAlarmEscalation').value, 'custom');
  assert.match(accessibleName($('dsAlarmEscalation').selectedOption()), /mukautettu/);
  fill($('dsAlarmSnooze'), '10');
  $('dsAlarmSave').click();
  await flush();
  assert.deepEqual(currentLifeSettings(getState()).alarm.escalation, custom);
});

// ================================================================ Arki: Android-tila

function fakeAlarms({ status = { exactAllowed: false, fullScreenAllowed: true } } = {}) {
  const calls = { status: 0, openExactAlarmSettings: 0, openFullScreenSettings: 0, pickAlarmSound: 0 };
  let current = status;
  return {
    calls,
    set(next) { current = next; },
    async status() { calls.status += 1; return current; },
    async openExactAlarmSettings() { calls.openExactAlarmSettings += 1; return { opened: true }; },
    async openFullScreenSettings() { calls.openFullScreenSettings += 1; return { opened: true }; },
    async pickAlarmSound() { calls.pickAlarmSound += 1; return { picked: true }; }
  };
}

test('KRIITTINEN: Android-tila luetaan, mutta asetuksia ei avata eikä lupaa pyydetä ilman napautusta', async () => {
  const alarms = fakeAlarms();
  const { $, render } = mount({ alarmPlatform: { native: true, alarms } });
  await flush();
  render();
  setTasks([]);
  await saveLifeSettings({ windDownMinutes: 40 });
  await flush();
  assert.ok(alarms.calls.status >= 1, 'tila luettiin');
  assert.equal(alarms.calls.openExactAlarmSettings, 0);
  assert.equal(alarms.calls.openFullScreenSettings, 0);
  assert.equal(alarms.calls.pickAlarmSound, 0);

  const status = text($('dailyAlarmStatus'));
  assert.match(status, /Täsmälliset herätykset sallittu: ei/);
  assert.match(status, /Koko näytön herätys lukitulla näytöllä: kyllä/);
  assert.match(status, /Herätysääni: puhelimen oletusääni/);
  assert.doesNotMatch(status, /toimii vain Android-sovelluksessa/);
  assert.equal($('dsAlarmFullScreenBtn'), null, 'sallittua ei tarjota uudelleen');

  // Napautus avaa asetukset kerran ja lukee tilan uudelleen.
  alarms.set({ exactAllowed: true, fullScreenAllowed: true, soundName: 'Linnut' });
  const before = alarms.calls.status;
  $('dsAlarmExactBtn').click();
  await flush();
  assert.equal(alarms.calls.openExactAlarmSettings, 1);
  assert.ok(alarms.calls.status > before, 'tila luettiin napautuksen jälkeen');
  assert.match(text($('dailyAlarmStatus')), /Täsmälliset herätykset sallittu: kyllä/);
  assert.match(text($('dailyAlarmStatus')), /Herätysääni: Linnut/);
  assert.equal($('dsAlarmExactBtn'), null);

  $('dsAlarmSoundBtn').click();
  await flush();
  assert.equal(alarms.calls.pickAlarmSound, 1);
});

test('selaimessa herätyksen tilaa ei kysytä alustalta; teksti on rehellinen', async () => {
  const alarms = fakeAlarms();
  const { $ } = mount({ alarmPlatform: { native: false, alarms } });
  await flush();
  assert.equal(alarms.calls.status, 0);
  assert.match(text($('dailyAlarmStatus')), /Herätys toimii vain Android-sovelluksessa/);
  assert.equal($('dsAlarmExactBtn'), null);
});

test('Android ilman herätysliitäntää: tila ei tiedossa, ei lupauksia', async () => {
  const { $ } = mount({ alarmPlatform: { native: true, alarms: null } });
  await flush();
  const status = text($('dailyAlarmStatus'));
  assert.match(status, /Herätyksen tilaa ei saatu selville/);
  assert.doesNotMatch(status, /kyllä/);
});

test('oikea alusta Nodessa: ei natiivikuorta eikä herätysliitäntää -> selaimen teksti', async () => {
  const { $ } = mount({ alarmPlatform: null });
  await flush();
  assert.match(text($('dailyAlarmStatus')), /Herätys toimii vain Android-sovelluksessa/);
});

function musicAlarms({ status, pick }) {
  const alarms = fakeAlarms({ status });
  alarms.calls.pickAlarmMusic = 0;
  let outcome = pick;
  alarms.pickResult = next => { outcome = next; };
  alarms.pickAlarmMusic = async () => { alarms.calls.pickAlarmMusic += 1; return outcome; };
  return alarms;
}

test('oma musiikki: "Valitse musiikki" avaa valitsimen vain napautuksesta; tila kertoo valinnan rehellisesti', async () => {
  // trace-alarm-music-mode-fake: "Oma musiikki" oli valittavissa, mutta
  // musiikkia ei voinut valita, ja soi herätysääni.
  const base = { exactAllowed: true, fullScreenAllowed: true };
  const alarms = musicAlarms({ status: { ...base, musicPicked: false }, pick: { ok: true, picked: true, title: 'Aamulaulu.mp3' } });
  const { $ } = mount({ alarmPlatform: { native: true, alarms } });
  await flush();
  assert.equal(alarms.calls.pickAlarmMusic, 0, 'piirto ja tilan luku eivät avaa valitsinta');
  assert.equal(accessibleName($('dsAlarmMusicBtn')).startsWith('Valitse musiikki'), true);
  assert.match(text($('dailyAlarmStatus')), /Oma herätysmusiikki: ei valittu/);
  assert.match(text($('dsAlarmMusicHint')), /Ilman valittua musiikkia tapa Oma musiikki soi herätysäänellä/);

  // Valinta onnistuu: nimi tulee laitteen tilasta, ei valitsimen vastauksesta.
  alarms.set({ ...base, musicPicked: true, musicName: 'Aamulaulu.mp3' });
  $('dsAlarmMusicBtn').click();
  await flush();
  assert.equal(alarms.calls.pickAlarmMusic, 1);
  assert.equal(alarms.calls.pickAlarmSound, 0, 'musiikki ei avaa herätysäänen valitsinta');
  assert.match(text($('dailyAlarmStatus')), /Oma herätysmusiikki: Aamulaulu\.mp3/);
  assert.match(text($('dsAlarmMusicHint')), /Soi tavoilla Oma musiikki ja Ääni ja puhe/);
  assert.equal($('dsAlarmMusicNotice'), null);
  assert.match(text($('toastHost')), /Herätysmusiikki valittu/);

  // Tiedostoon ei saatu pysyvää oikeutta: selitys, aiempi valinta pysyy.
  alarms.pickResult({ ok: false, supported: true, picked: false, title: null, code: 'not-persistable' });
  $('dsAlarmMusicBtn').click();
  await flush();
  assert.match(text($('dsAlarmMusicNotice')), /ei anna sovellukselle pysyvää lupaa lukea sitä.*Aiempi valinta on ennallaan/);
  assert.match(text($('dailyAlarmStatus')), /Oma herätysmusiikki: Aamulaulu\.mp3/);

  // Käyttäjä sulki valitsimen itse: ei virheilmoitusta.
  alarms.pickResult({ ok: false, supported: true, picked: false, title: null, code: 'cancelled' });
  $('dsAlarmMusicBtn').click();
  await flush();
  assert.equal($('dsAlarmMusicNotice'), null);

  // Tiedosto tai lukuoikeus hävisi: ei väitetä valituksi.
  alarms.set({ ...base, musicPicked: false, musicLost: true });
  $('dsAlarmStatusRefresh').click();
  await flush();
  assert.match(text($('dailyAlarmStatus')), /Oma herätysmusiikki: ei enää käytettävissä/);
  assert.match(text($('dsAlarmMusicHint')), /herätys soi herätysäänellä\. Valitse musiikki uudelleen/);
  assert.equal(alarms.calls.pickAlarmMusic, 3, 'vain kolme napautusta');
});

test('oma musiikki: vanhassa sovellusversiossa (ei pickAlarmMusicia) ei painiketta eikä väitettä', async () => {
  const alarms = fakeAlarms({ status: { exactAllowed: true, fullScreenAllowed: true } });
  const { $ } = mount({ alarmPlatform: { native: true, alarms } });
  await flush();
  assert.equal($('dsAlarmMusicBtn'), null);
  assert.doesNotMatch(text($('dailyAlarmStatus')), /Oma herätysmusiikki/);
});

test('herätyksen tapa kertoo, mitä soi: Oma musiikki ilman valintaa on herätysääni', async () => {
  assert.equal(alarmModeHint(ALARM_MODE.SOUND), null);
  assert.equal(alarmModeHint(ALARM_MODE.SPEECH), null);
  const { $ } = mount();
  assert.equal($('dsAlarmModeHint'), null, 'oletustapa ei tarvitse selitystä');
  choose($('dsAlarmMode'), ALARM_MODE.MUSIC);
  assert.match(text($('dsAlarmModeHint')), /valitse kappale kohdasta "Valitse musiikki"\. Jos musiikkia ei ole valittu tai sitä ei voi soittaa, soi herätysääni\./);
  assert.equal($('dsAlarmMode').getAttribute('aria-describedby'), 'dsAlarmModeHint');
  choose($('dsAlarmMode'), ALARM_MODE.COMBINATION);
  assert.match(text($('dsAlarmModeHint')), /oma musiikki, jos olet valinnut sen, muuten herätysääni/);
});

test('musiikin valinnan tulos: epäonnistuminen selitetään, onnistuminen ja peruutus eivät', () => {
  assert.equal(musicPickNotice({ ok: true, picked: true }), null);
  assert.equal(musicPickNotice({ ok: false, code: 'cancelled' }), null);
  assert.match(musicPickNotice({ ok: false, code: 'not-persistable' }), /pysyvää lupaa/);
  assert.match(musicPickNotice({ ok: false, code: 'unsupported' }), /Tätä tiedostoa ei voi käyttää herätyksenä/);
  for (const outcome of [null, undefined, { ok: false, code: 'timeout' }, { ok: false, code: 'unavailable' }]) {
    assert.match(musicPickNotice(outcome), /Musiikin valinta ei onnistunut\. Aiempi valinta on ennallaan\./);
  }
});

test('näkymä ei kutsu asetusten avausta tai äänen valintaa muualta kuin napautuksesta', () => {
  const source = readCode('src/app/views/dailySettings.js');
  for (const method of ['openExactAlarmSettings', 'openFullScreenSettings', 'pickAlarmSound', 'pickAlarmMusic']) {
    const uses = [...source.matchAll(new RegExp(`'${method}'`, 'g'))].length;
    assert.equal(uses, 1, `${method} mainitaan vain napautuksen käsittelijässä`);
  }
  assert.doesNotMatch(source, /requestPermission|requestPermissions/);
});

// ================================================================ Arki: aamukatsaus

test('aamukatsauksen teksti vastaa laitteen toimintaa: sammutuksen jälkeen, tavasta riippumatta, ei torkussa', () => {
  // claims-morning-brief-silent: teksti lupasi katsauksen sammutuksen
  // jälkeen, mutta oletustavalla (herätysääni) mitään ei kuulunut.
  const { $ } = mount();
  const hint = text($('dsMorningBriefHint'));
  assert.match(hint, /Kun sammutat herätyksen Sammuta-painikkeella, puhelin lukee kerran lyhyen katsauksen/);
  assert.match(hint, /tavasta riippumatta, myös pelkällä herätysäänellä/);
  assert.match(hint, /Torkku ei lue katsausta/);
  assert.match(hint, /ilman tekoälyä/);
  assert.equal($('dsMorningBrief').getAttribute('aria-describedby'), 'dsMorningBriefHint');
});

test('aamukatsaus tallentuu heti; epäonnistuminen palauttaa ruudun tallennettuun', async () => {
  const { $ } = mount();
  $('dsMorningBrief').click();
  await flush();
  assert.equal(currentLifeSettings(getState()).morningBriefEnabled, true);
  assert.equal($('dsMorningBrief').checked, true);
  assert.equal($('dsMorningBrief').disabled, false);

  await withFailing(lifeSettingsRepo, 'update', async () => {
    $('dsMorningBrief').click();
    await flush();
  });
  assert.equal(currentLifeSettings(getState()).morningBriefEnabled, true, 'tila peruttiin');
  assert.equal($('dsMorningBrief').checked, true, 'ruutu ei valehtele');
  assert.match(text($('toastHost')), /Yhteys katkesi/);
});

// ================================================================ Arki: ateriat

test('vesimuistutukset: kerrotaan, että ne kuuluvat päivän muistutusrajaan (eivät katoa hiljaa)', () => {
  const { $ } = mount();
  assert.match(text($('dailyMealSettings')), /Vesimuistutukset kuuluvat päivän muistutusrajaan \(nyt \d+ päivässä\)/);
});

test('ateriat: lukematon numerosyöte (valmistelu, veden väli) on virhe, ei hiljaa tyhjä', async () => {
  const { $ } = mount();
  $('dsMealAdd').click();
  fill($('dsMealName-0'), 'Lounas');
  fill($('dsMealTime-0'), '11:30');
  const prep = $('dsMealPrep-0');
  prep.validity = { badInput: true };
  fill(prep, '');
  $('dsMealSave').click();
  await flush();
  assert.deepEqual(currentLifeSettings(getState()).mealRhythm.meals, [], 'ei tallennettu tuntemattomalla valmistelulla');
});

test('ateriat: ateria, vesi ja lisäravinne tallentuvat; väärä väli on virhe', async () => {
  const { $ } = mount();
  $('dsMealAdd').click();
  fill($('dsMealName-0'), 'Lounas');
  fill($('dsMealTime-0'), '11:30');
  fill($('dsMealPrep-0'), '15');
  $('dsMealAdd').click();
  fill($('dsMealName-1'), 'Aamupala');
  fill($('dsMealTime-1'), '07:15');
  fill($('dsWaterEvery'), '10');
  fill($('dsWaterFrom'), '09:00');
  fill($('dsWaterTo'), '18:00');
  $('dsSupAdd').click();
  fill($('dsSupName-0'), 'D-vitamiini');
  fill($('dsSupTime-0'), '08:00');
  $('dsMealSave').click();
  await flush();
  assert.equal($('dsWaterEveryError').getAttribute('role'), 'alert');
  assert.match(text($('dsWaterEveryError')), /vähintään 30|30–480/);
  assert.deepEqual(currentLifeSettings(getState()).mealRhythm.meals, [], 'ei tallennettu');

  fill($('dsWaterEvery'), '90');
  $('dsMealSave').click();
  await flush();
  const rhythm = currentLifeSettings(getState()).mealRhythm;
  assert.deepEqual(rhythm.meals.map(m => [m.name, m.time, m.prepMinutes]), [
    ['Aamupala', '07:15', null], ['Lounas', '11:30', 15]
  ], 'järjestetty kellonajan mukaan; tyhjä valmistelu on tuntematon');
  assert.equal(rhythm.waterEveryMinutes, 90);
  assert.equal(rhythm.waterFrom, '09:00');
  assert.deepEqual(rhythm.supplements.map(s => s.name), ['D-vitamiini']);
  assert.equal($('dsMealName-0').value, 'Aamupala', 'piirto tallennetusta');

  // Poisto ja peruutus.
  mounted.doc.querySelector('[data-meal-remove="0"]').click();
  assert.equal($('dsMealName-0').value, 'Lounas');
  $('dsMealCancel').click();
  assert.equal($('dsMealName-0').value, 'Aamupala', 'peruutus palautti tallennetun');
});

// ================================================================ Ohjaus ja puhe

test('ohjaus ja puhe: oletukset, tallennus ja kooste; virhe näkyy role=alert', async () => {
  const { $ } = mount({ segment: 'settings' });
  const root = $('guidanceSettings');
  assert.equal(isRendered(root), true);
  assert.equal($('gsStyle-rauhallinen').checked, true);
  assert.equal($('gsSpeech').checked, false, 'puhe ei ole oletuksena päällä');
  for (const topic of REMINDER_TOPICS) {
    const select = $(`gsDelivery-${topic}`);
    assert.equal(select.value, DEFAULT_DELIVERY[topic], topic);
    assert.ok(accessibleName(select), topic);
  }
  assert.equal($('gsDigest').checked, false);
  assert.equal($('gsDigestTime').value, '18:00');
  for (const field of root.querySelectorAll('input, select')) assert.ok(accessibleName(field), field.id);
  assert.match(text(root), /Aktiivinen/);
  assert.match(text(root), /toistetaan kerran/);

  $('gsDigest').click();
  fill($('gsDigestTime'), '');
  $('gsSave').click();
  await flush();
  assert.equal($('gsDigestTimeError').getAttribute('role'), 'alert');
  assert.equal(currentLifeSettings(getState()).digestEnabled, false);

  $('gsStyle-aktiivinen').click();
  $('gsSpeech').click();
  choose($('gsDelivery-departure'), DELIVERY.SOUND_AND_SPEECH);
  fill($('gsDigestTime'), '19:30');
  $('gsSave').click();
  await flush();
  const settings = currentLifeSettings(getState());
  assert.equal(settings.guidanceStyle, GUIDANCE_STYLE.ACTIVE);
  assert.equal(settings.speechEnabled, true);
  assert.equal(settings.delivery.departure, DELIVERY.SOUND_AND_SPEECH);
  assert.equal(settings.digestEnabled, true);
  assert.equal(settings.digestTime, '19:30');
  assert.deepEqual(Object.keys(settings.delivery).sort(), [...REMINDER_TOPICS].sort());
  assert.equal($('gsDigestTimeError'), null);

  // Palautus oletukseen korvaa aiemman valinnan (ei jää voimaan yhdistämisessä).
  choose($('gsDelivery-departure'), DEFAULT_DELIVERY.departure);
  $('gsSave').click();
  await flush();
  assert.equal(currentLifeSettings(getState()).delivery.departure, DEFAULT_DELIVERY.departure);
});

// ================================================================ muistutukset pois päältä

test('muistutukset pois (oletus): Arki ja Ohjaus kertovat, missä ne kytketään päälle, ja painike vie sinne', async () => {
  const { $ } = mount();
  const daily = $('dailyLifeNotice');
  assert.match(text(daily), /Arjen muistutukset ovat pois päältä\./);
  assert.match(text(daily), /nukkumaanmeno-, ateria-, lähtö- ja tapamuistutukset eivät tule/);
  assert.match(text(daily), /Profiili → Asetukset → Muistutukset → Käytä muistutuksia/);
  assert.deepEqual(alertsIn(daily), [], 'vihje ei ole virhe');
  const go = daily.querySelector('[data-open-reminders]');
  assert.equal(accessibleName(go), 'Siirry muistutuksiin');

  go.click();
  assert.equal(getState().profileSegment, 'settings', 'painike avaa Asetukset-osion');
  const guidance = $('gsRemindersOff');
  assert.ok(guidance && isRendered(guidance), 'Ohjaus ja puhe kertoo saman');
  assert.match(text(guidance), /Alla valitut toimitustavat eivät vielä tee mitään\./);
  assert.match(text(guidance), /Muistutukset → Käytä muistutuksia/);

  // Muistutusten pääkytkin piirrettynä: painike vie fokuksen siihen (ei kytke itse).
  // Testiympäristössä ilmoituksia ei tueta, joten kytkin on estetty; tuetulla
  // alustalla se on käytettävissä.
  renderNotificationSettings();
  $('nfEnabled').removeAttribute('disabled');
  guidance.querySelector('[data-open-reminders]').click();
  assert.ok(mounted.doc.activeElement === $('nfEnabled'), 'fokus Käytä muistutuksia -kytkimessä');
  assert.equal(getState().notificationPreferences.enabled, false, 'painike ei kytke muistutuksia');

  // Päällä: vihjeet poistuvat.
  setNotificationPreferences({ ...getState().notificationPreferences, enabled: true });
  assert.ok(!$('gsRemindersOff'), 'päällä: ei vihjettä Ohjauksessa');
  $('segmentProfileDaily').click();
  assert.doesNotMatch(text($('dailyLifeNotice')), /pois päältä/);
});

// ================================================================ uloskirjautuminen

test('uloskirjautuminen: luonnokset eivät siirry seuraavalle käyttäjälle', async () => {
  const { $, render } = mount();
  type($('dsWindDown'), '99');
  $('dsStepAdd').click();
  fill($('dsStepName-0'), 'Salainen vaihe');
  setProfileSegment('settings');
  $('gsStyle-napakka').click();

  resetDailySettings();
  resetGuidanceSettings();
  setLifeSettings([]);
  setProfile({}, false);
  setProfileSegment('daily');
  render();
  assert.equal($('dsWindDown').value, '30');
  assert.equal($('dsStepName-0'), null);
  setProfileSegment('settings');
  assert.equal($('gsStyle-rauhallinen').checked, true);
});
