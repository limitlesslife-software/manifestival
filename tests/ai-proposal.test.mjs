// AI-ehdotuksen validoinnin testit.
//
// AI on ehdottava kerros, jonka tuotokseen ei luoteta. Nämä testit
// varmistavat, ettei mallin vastaus voi tuoda sovellukseen kelvottomia
// arvoja, tuntemattomia kenttiä tai mielivaltaista dataa.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  extractJson, validateProposal, fallbackProposal,
  PROPOSAL_FIELDS, ALLOWED, MAX_NOTE_LENGTH, MAX_PROPOSAL_MINUTES
} from '../src/ai/proposalSchema.js';
import { CATEGORY_KEYS } from '../src/domain/categories.js';
import { PRIORITY_KEYS } from '../src/domain/priority.js';
import { MAX_TITLE_LENGTH } from '../src/domain/task.js';

const TODAY = '2026-08-31';
const ROOT = path.resolve(import.meta.dirname, '..');

// ------------------------------------------------------------ JSON-poiminta

test('extractJson lukee pelkän JSON-objektin', () => {
  assert.deepEqual(extractJson('{"title":"Testi"}'), { title: 'Testi' });
});

test('extractJson poistaa koodilohkomerkinnät', () => {
  assert.deepEqual(extractJson('```json\n{"title":"Testi"}\n```'), { title: 'Testi' });
  assert.deepEqual(extractJson('```\n{"title":"Testi"}\n```'), { title: 'Testi' });
});

test('extractJson poimii objektin selittävän tekstin seasta', () => {
  const text = 'Tässä ehdotus:\n{"title":"Soita"}\nToivottavasti sopii.';
  assert.deepEqual(extractJson(text), { title: 'Soita' });
});

test('extractJson palauttaa null kelvottomasta syötteestä', () => {
  for (const bad of ['', 'ei mitään', '{rikki', '[1,2,3]', null, undefined, 42]) {
    assert.equal(extractJson(bad), null, 'hyväksyi: ' + JSON.stringify(bad));
  }
});

test('extractJson ei hyväksy taulukkoa objektina', () => {
  assert.equal(extractJson('[{"title":"x"}]'), null);
});

// -------------------------------------------------------------- validointi

test('kelvollinen ehdotus hyväksytään ja normalisoidaan', () => {
  const { valid, proposal } = validateProposal({
    title: 'Karting-harjoitus', date: '2026-09-01', time: '16:00', endTime: '17:00',
    durationMinutes: 60, category: 'harrastus', priority: 'korkea', note: 'varusteet mukaan'
  }, { today: TODAY });

  assert.equal(valid, true);
  assert.equal(proposal.title, 'Karting-harjoitus');
  assert.equal(proposal.date, '2026-09-01');
  assert.equal(proposal.category, 'harrastus');
  assert.equal(proposal.priority, 'korkea');
});

test('TURVA: tuntemattomat kentät hylätään eivätkä päädy ehdotukseen', () => {
  const { proposal, rejected } = validateProposal({
    title: 'X', date: TODAY,
    user_id: 'vieras', completed: true, id: 'huijaus', __proto__: {}, sql: 'DROP TABLE'
  }, { today: TODAY });

  for (const key of Object.keys(proposal)) {
    assert.ok(PROPOSAL_FIELDS.includes(key), 'ehdotukseen päätyi tuntematon kenttä: ' + key);
  }
  assert.equal('user_id' in proposal, false);
  assert.equal('completed' in proposal, false);
  assert.ok(rejected.includes('user_id'));
  assert.ok(rejected.includes('sql'));
});

test('TURVA: keksittyä kategoriaa ei hyväksytä', () => {
  const { proposal, rejected } = validateProposal(
    { title: 'X', date: TODAY, category: 'salainen-kategoria' }, { today: TODAY });
  assert.equal(proposal.category, 'muu');
  assert.ok(rejected.includes('category'));
});

test('TURVA: keksittyä prioriteettia ei hyväksytä', () => {
  const { proposal, rejected } = validateProposal(
    { title: 'X', date: TODAY, priority: 'ULTRAKIIREELLINEN' }, { today: TODAY });
  assert.equal(proposal.priority, 'normaali');
  assert.ok(rejected.includes('priority'));
});

test('kelvoton päivämäärä korvautuu tällä päivällä', () => {
  const { proposal, rejected } = validateProposal(
    { title: 'X', date: 'huomenna joskus' }, { today: TODAY });
  assert.equal(proposal.date, TODAY);
  assert.ok(rejected.includes('date'));
});

test('kelvoton kellonaika pudotetaan', () => {
  const { proposal, rejected } = validateProposal(
    { title: 'X', date: TODAY, time: '25:99' }, { today: TODAY });
  assert.equal(proposal.time, null);
  assert.ok(rejected.includes('time'));
});

test('loppuaika ilman alkuaikaa pudotetaan', () => {
  const { proposal, rejected } = validateProposal(
    { title: 'X', date: TODAY, time: null, endTime: '15:00' }, { today: TODAY });
  assert.equal(proposal.endTime, null);
  assert.ok(rejected.includes('endTime'));
});

test('nollan mittainen aikaväli pudotetaan', () => {
  const { proposal } = validateProposal(
    { title: 'X', date: TODAY, time: '09:00', endTime: '09:00' }, { today: TODAY });
  assert.equal(proposal.endTime, null);
});

test('merkkijono "null" tulkitaan tyhjäksi', () => {
  // Malli palauttaa toisinaan merkkijonon "null" oikean null-arvon sijaan.
  const { proposal } = validateProposal(
    { title: 'X', date: TODAY, time: 'null', note: 'NULL' }, { today: TODAY });
  assert.equal(proposal.time, null);
  assert.equal(proposal.note, null);
});

test('kesto rajataan vuorokauteen ja pyöristetään', () => {
  assert.equal(validateProposal({ title: 'X', date: TODAY, durationMinutes: 99999 }, { today: TODAY }).proposal.durationMinutes, MAX_PROPOSAL_MINUTES);
  assert.equal(validateProposal({ title: 'X', date: TODAY, durationMinutes: 30.6 }, { today: TODAY }).proposal.durationMinutes, 31);
  assert.equal(validateProposal({ title: 'X', date: TODAY, durationMinutes: -5 }, { today: TODAY }).proposal.durationMinutes, null);
});

test('liian pitkä otsikko ja muistiinpano katkaistaan', () => {
  const { proposal } = validateProposal({
    title: 'a'.repeat(MAX_TITLE_LENGTH + 100),
    note: 'b'.repeat(MAX_NOTE_LENGTH + 100),
    date: TODAY
  }, { today: TODAY });
  assert.equal(proposal.title.length, MAX_TITLE_LENGTH);
  assert.equal(proposal.note.length, MAX_NOTE_LENGTH);
});

test('otsikon puuttuessa käytetään käyttäjän omaa tekstiä', () => {
  const { valid, proposal } = validateProposal(
    { date: TODAY }, { today: TODAY, fallbackTitle: 'muista ostaa maitoa' });
  assert.equal(valid, true);
  assert.equal(proposal.title, 'muista ostaa maitoa');
});

test('ilman otsikkoa ja varatekstiä ehdotus hylätään', () => {
  const { valid, reason } = validateProposal({ date: TODAY }, { today: TODAY });
  assert.equal(valid, false);
  assert.match(reason, /otsikko/i);
});

test('objektiton vastaus hylätään', () => {
  for (const bad of [null, undefined, 'teksti', 42, []]) {
    assert.equal(validateProposal(bad, { today: TODAY }).valid, false);
  }
});

// --------------------------------------------------------- varaehdotus

test('fallbackProposal säilyttää käyttäjän tekstin', () => {
  const p = fallbackProposal('  soita huomenna äidille  ', TODAY);
  assert.equal(p.title, 'soita huomenna äidille');
  assert.equal(p.date, TODAY);
  assert.equal(p.category, 'muu');
  assert.equal(p.priority, 'normaali');
});

test('fallbackProposal kestää tyhjän syötteen', () => {
  assert.equal(fallbackProposal('', TODAY).title, 'Uusi tehtävä');
});

// -------------------------------- palvelimen ja selaimen yhdenmukaisuus

test('REGRESSIO: palvelimen prompt käyttää samoja kategorioita kuin domain', () => {
  const require = createRequire(import.meta.url);
  const parse = require(path.join(ROOT, 'api', 'parse.js'));
  assert.deepEqual(parse.CATEGORY_KEYS, [...CATEGORY_KEYS],
    'api/parse.js ja src/domain/categories.js ovat ajautuneet erilleen');
});

test('REGRESSIO: palvelimen prompt käyttää samoja prioriteetteja kuin domain', () => {
  const require = createRequire(import.meta.url);
  const parse = require(path.join(ROOT, 'api', 'parse.js'));
  assert.deepEqual(parse.PRIORITY_KEYS, [...PRIORITY_KEYS],
    'api/parse.js ja src/domain/priority.js ovat ajautuneet erilleen');
});

test('prompt sisältää kaikki sallitut arvot ja pyydetyt kentät', () => {
  const require = createRequire(import.meta.url);
  const parse = require(path.join(ROOT, 'api', 'parse.js'));
  const prompt = parse.buildPrompt({ transcript: 'testi', today: TODAY, weekday: 'maanantai' });

  for (const key of ALLOWED.category) assert.ok(prompt.includes(key), 'promptista puuttuu kategoria ' + key);
  for (const key of ALLOWED.priority) assert.ok(prompt.includes(key), 'promptista puuttuu prioriteetti ' + key);
  for (const field of ['title', 'date', 'time', 'endTime', 'durationMinutes', 'category', 'priority', 'note']) {
    assert.ok(prompt.includes(field), 'promptista puuttuu kenttä ' + field);
  }
});

test('TURVA: prompt upottaa käyttäjän tekstin JSON-koodattuna', () => {
  const require = createRequire(import.meta.url);
  const parse = require(path.join(ROOT, 'api', 'parse.js'));
  const prompt = parse.buildPrompt({
    transcript: 'testi" ja sitten\nuusi rivi',
    today: TODAY,
    weekday: 'maanantai'
  });
  // JSON.stringify suojaa lainausmerkit ja rivinvaihdot, joten käyttäjän
  // teksti ei voi katkaista promptin rakennetta.
  assert.ok(prompt.includes('\\"'), 'lainausmerkit pitää suojata');
  assert.ok(prompt.includes('\\n'), 'rivinvaihdot pitää suojata');
});

test('index.html ei sisällä AI-jäsennyslogiikkaa', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.equal(html.includes('api.anthropic.com'), false);
  assert.equal(html.includes('ANTHROPIC_API_KEY'), false);
});
