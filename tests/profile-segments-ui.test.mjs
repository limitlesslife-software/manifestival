// Profiilin osiot (Arki | Hyvinvointi | Paikat | Asetukset): runko, tila ja
// näppäimistö oikeassa (jäsennetyssä) index.html-DOMissa.
//
// Vanha profiilinäkymä siirtyi Asetukset-osioon SELLAISENAAN: jokainen
// aiempi tunniste on yhä olemassa, koska testit ja koodi viittaavat niihin
// (profile.js, notificationSettings.js, accountDeletion.js, render-cost).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { createDocument, installDocument, press, tabOrder, accessibleName, isRendered } from './helpers/a11yDom.mjs';
import {
  resetState, getState, subscribe, setProfileSegment, PROFILE_SEGMENTS
} from '../src/app/state.js';
import { renderProfileSegments, initProfileSegments } from '../src/app/views/profileSegments.js';

const HTML = read('index.html');
const FLAT = HTML.replace(/\r\n/g, '\n');

const TABS = Object.freeze([
  ['daily', 'segmentProfileDaily', 'profileDailySection', 'Arki'],
  // Aalto L: suojattu aika (oma aika, vapaa-aika, loma, väljyys).
  ['protected', 'segmentProfileProtected', 'profileProtectedSection', 'Suojattu aika'],
  ['wellbeing', 'segmentProfileWellbeing', 'profileWellbeingSection', 'Hyvinvointi'],
  ['places', 'segmentProfilePlaces', 'profilePlacesSection', 'Paikat'],
  ['settings', 'segmentProfileSettings', 'profileSettingsSection', 'Asetukset']
]);

/** Aiemman profiilinäkymän tunnisteet, joihin koodi ja testit viittaavat. */
const LEGACY_IDS = Object.freeze([
  'pfSchemaNotice', 'pfCapabilities', 'pfPreview', 'pfAge', 'pfWeight', 'pfHeight', 'pfSleepTarget',
  'pfDefaultWake', 'pfCommute', 'pfRoutine', 'pfSave', 'pfSavedMsg', 'pfErrorMsg', 'notificationSettings',
  'pfAccountDeletion'
]);

function profileSection() {
  const start = FLAT.indexOf('id="screen-profile"');
  assert.ok(start > -1);
  return FLAT.slice(start, FLAT.indexOf('</section>', start));
}

let doc = null;
let uninstall = null;
let unsubscribe = null;

beforeEach(() => {
  resetState();
  doc = createDocument(HTML);
  uninstall = installDocument(doc);
  // Profiili auki kuten switchTab sen jättää.
  const screen = doc.getElementById('screen-profile');
  screen.removeAttribute('inert');
  screen.setAttribute('aria-hidden', 'false');
  initProfileSegments();
  unsubscribe = subscribe(renderProfileSegments);
  renderProfileSegments();
});

afterEach(() => {
  unsubscribe();
  uninstall();
  resetState();
});

const $ = id => doc.getElementById(id);
const visibleSections = () => TABS.filter(([, , section]) => isRendered($(section))).map(([key]) => key);

// ================================================================ runko

test('profiilissa on osioiden tab-lista: viisi välilehteä, nimet ja kohdesäiliöt', () => {
  const section = profileSection();
  assert.match(section, /<div class="segment segment-scroll" role="tablist" aria-label="Profiilin osiot">/);
  const ids = [...section.matchAll(/<button class="segment-btn[^"]*" id="(segmentProfile\w+)"/g)].map(m => m[1]);
  assert.deepEqual(ids, TABS.map(([, tab]) => tab), 'järjestys Arki, Suojattu aika, Hyvinvointi, Paikat, Asetukset');
  for (const [, tabId, sectionId, label] of TABS) {
    const tab = $(tabId);
    assert.equal(tab.getAttribute('role'), 'tab');
    assert.equal(tab.getAttribute('type'), 'button');
    assert.equal(tab.getAttribute('aria-controls'), sectionId);
    assert.equal(accessibleName(tab), label);
    const panel = $(sectionId);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tabId);
    assert.ok($('screen-profile').contains(panel), `${sectionId} on profiilinäytöllä`);
  }
  // Tila ja HTML samaa mieltä osioista.
  assert.deepEqual(PROFILE_SEGMENTS.map(s => s.key), TABS.map(([key]) => key));
  assert.deepEqual(PROFILE_SEGMENTS.map(s => s.label), TABS.map(([, , , label]) => label));
});

test('KRIITTINEN: vanha profiilinäkymä on Asetukset-osiossa, jokainen tunniste ennallaan', () => {
  const settings = $('profileSettingsSection');
  for (const id of LEGACY_IDS) {
    const node = $(id);
    assert.ok(node, `#${id} puuttuu`);
    assert.ok(settings.contains(node), `#${id} ei ole Asetukset-osiossa`);
  }
  // Ohjaus ja puhe muistutusasetusten jälkeen, ennen tilin poistoa.
  const order = ['notificationSettings', 'guidanceSettings', 'pfAccountDeletion'].map(id => FLAT.indexOf(`id="${id}"`));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'järjestys: muistutukset, ohjaus, tilin poisto');
  assert.ok(settings.contains($('guidanceSettings')));
  // Uloskirjautuminen näkyy jokaisessa osiossa (ei minkään osion sisällä).
  const signout = $('signoutBtn');
  assert.ok($('screen-profile').contains(signout));
  for (const [, , sectionId] of TABS) assert.equal($(sectionId).contains(signout), false, sectionId);
});

test('Arki-osion säiliöt ja otsikot ovat valmiina (näkymä piirtää niihin)', () => {
  const daily = $('profileDailySection');
  for (const id of ['dailyLifeNotice', 'dailySleepSettings', 'dailyRoutineSettings', 'dailyAlarmNext', 'dailyAlarmStatus',
    'dailyAlarmSettings', 'dailyBriefSettings', 'dailyMealSettings']) {
    assert.ok(daily.contains($(id)), id);
  }
  for (const [id, title] of [['dailySleepTitle', 'Uni ja rytmi'], ['dailyRoutineTitle', 'Aamurutiini'],
    ['dailyAlarmTitle', 'Herätys'], ['dailyBriefTitle', 'Aamukatsaus'], ['dailyMealTitle', 'Ateriat']]) {
    assert.equal($(id).localName, 'h2');
    assert.equal(accessibleName($(id)), title);
  }
});

test('käynnistyssavu löytää osiot (tunniste alkaa "segment"), eikä ensimmäinen pelkkä .segment muutu', () => {
  const found = [...$('screen-profile').querySelectorAll('.segment[role="tablist"] > button.segment-btn[id^="segment"]')];
  assert.deepEqual(found.map(node => node.id), TABS.map(([, tab]) => tab));
  // accessibility.test: ensimmäinen täsmälleen class="segment" on Talouden kahden välilehden valitsin.
  const first = FLAT.indexOf('class="segment"');
  assert.ok(first < FLAT.indexOf('id="screen-profile"'), 'profiilin segmentti ei ole ensimmäinen pelkkä .segment');
});

// ================================================================ tila

test('oletus on Arki: vain se näkyy, sen välilehti on valittu ja ainoa sarkainpysäkki', () => {
  assert.equal(getState().profileSegment, 'daily');
  assert.deepEqual(visibleSections(), ['daily']);
  for (const [key, tabId] of TABS) {
    const tab = $(tabId);
    assert.equal(tab.getAttribute('aria-selected'), String(key === 'daily'), tabId);
    assert.equal(tab.classList.contains('active'), key === 'daily', tabId);
    assert.equal(tab.getAttribute('tabindex'), key === 'daily' ? '0' : '-1', tabId);
  }
  const stops = tabOrder(doc, { root: $('screen-profile') }).filter(node => node.classList.contains('segment-btn'));
  assert.deepEqual(stops.map(node => node.id), ['segmentProfileDaily']);
});

test('napautus vaihtaa osion tilan kautta; muut osiot piiloutuvat', () => {
  $('segmentProfileSettings').click();
  assert.equal(getState().profileSegment, 'settings');
  assert.deepEqual(visibleSections(), ['settings']);
  assert.equal($('segmentProfileSettings').getAttribute('aria-selected'), 'true');
  assert.equal($('segmentProfileDaily').getAttribute('aria-selected'), 'false');
  assert.equal(isRendered($('pfSave')), true, 'profiililomake näkyy Asetuksissa');

  $('segmentProfilePlaces').click();
  assert.deepEqual(visibleSections(), ['places']);
  assert.equal(isRendered($('pfSave')), false);
});

test('nuolinäppäimet, Home ja End liikkuvat välilehtien välillä ja kiertävät reunoilta', () => {
  $('segmentProfileDaily').focus();
  press(doc, 'ArrowRight');
  assert.equal(getState().profileSegment, 'protected');
  assert.equal(doc.activeElement.id, 'segmentProfileProtected');
  assert.deepEqual(visibleSections(), ['protected']);

  press(doc, 'End');
  assert.equal(getState().profileSegment, 'settings');
  assert.equal(doc.activeElement.id, 'segmentProfileSettings');

  press(doc, 'ArrowRight');
  assert.equal(getState().profileSegment, 'daily', 'viimeisestä ensimmäiseen');
  assert.equal(doc.activeElement.id, 'segmentProfileDaily');

  press(doc, 'ArrowLeft');
  assert.equal(getState().profileSegment, 'settings', 'ensimmäisestä viimeiseen');

  press(doc, 'Home');
  assert.equal(getState().profileSegment, 'daily');
  assert.equal(doc.activeElement.getAttribute('tabindex'), '0');

  // Muut näppäimet eivät vaihda osiota.
  const event = press(doc, 'a');
  assert.equal(event.defaultPrevented, false);
  assert.equal(getState().profileSegment, 'daily');
});

test('tuntematon osio palautuu Arkeen; nollaus palauttaa oletuksen', () => {
  setProfileSegment('settings');
  setProfileSegment('ei-tällaista');
  assert.equal(getState().profileSegment, 'daily');
  setProfileSegment(undefined);
  assert.equal(getState().profileSegment, 'daily');
  setProfileSegment('places');
  resetState();
  assert.equal(getState().profileSegment, 'daily');
});

test('osion vaihto ei koske muuhun tilaan (korvaava commit, ei mutaatiota)', () => {
  const before = getState();
  setProfileSegment('wellbeing');
  const after = getState();
  assert.notEqual(before, after);
  assert.equal(before.profileSegment, 'daily', 'vanha tila ennallaan');
  for (const key of Object.keys(before)) {
    if (key === 'profileSegment') continue;
    assert.equal(after[key], before[key], key);
  }
});
