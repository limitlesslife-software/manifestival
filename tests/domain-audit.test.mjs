// AI-kirjausketjun testit.
//
// Kirjaus vastaa kysymykseen "miksi tämä muuttui?" silloin kun käyttäjä
// ei muista tehneensä muutosta. Se ei ole analytiikkaa — ja testit
// varmistavat myös sen, ettei siitä tule sellaista.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_RESULT, AUDIT_RESULTS, MAX_INPUT_SUMMARY, MAX_AUDIT_ENTRIES,
  summarizeInput, normalizeAuditEntry, validateAuditEntry,
  appendAuditEntry, completeAuditEntry, entriesForDate,
  summarizeAudit, describeAuditEntry
} from '../src/domain/audit.js';

const NOW = '2026-09-02T10:00:00.000Z';

function entry(overrides = {}) {
  return normalizeAuditEntry({
    id: 'a1', timestamp: NOW, intent: 'create_task', risk: 'medium',
    proposal: 'Luo tehtävä: Soita Matille', ...overrides
  });
}

// -------------------------------------------------------- tiivistelmä

test('lyhyt syöte säilyy sellaisenaan', () => {
  assert.equal(summarizeInput('Muistuta soittamaan'), 'Muistuta soittamaan');
});

test('KRIITTINEN: pitkää syötettä ei tallenneta kokonaisuudessaan', () => {
  // "Soita Matille numeroon 040 1234567 ja kysy koetuloksista" on lause,
  // jonka käyttäjä ei odota säilyvän lokissa.
  const pitkä = 'Soita Matille numeroon 040 1234567 ja kysy koetuloksista '
    + 'sekä kerro että lääkäri soitti eilen ja pyysi soittamaan takaisin '
    + 'mahdollisimman pian koska asia on kiireellinen ja koskee sydäntä';

  const summary = summarizeInput(pitkä);

  assert.ok(summary.length <= MAX_INPUT_SUMMARY, `pituus ${summary.length}`);
  assert.ok(summary.length < pitkä.length);
  assert.equal(summary.includes('sydäntä'), false, 'loppuosa vuoti kirjaukseen');
});

test('katkaisu tehdään sanan rajalta', () => {
  // Puolikas sana näyttää virheeltä eikä lyhennykseltä.
  const summary = summarizeInput('sana '.repeat(60));
  assert.ok(summary.endsWith('…'));
  assert.equal(/\ssan…$/.test(summary), false, 'sana katkesi keskeltä');
});

test('välit siistitään', () => {
  assert.equal(summarizeInput('  liikaa    välejä  '), 'liikaa välejä');
  assert.equal(summarizeInput(null), '');
  assert.equal(summarizeInput(undefined), '');
});

// ------------------------------------------------------- normalisointi

test('normalizeAuditEntry on idempotentti', () => {
  const once = entry({ confirmed: true, executed: true, result: AUDIT_RESULT.EXECUTED });
  assert.deepEqual(normalizeAuditEntry(once), once);
});

test('tuntematon lopputulos putoaa turvalliseen oletukseen', () => {
  assert.equal(normalizeAuditEntry({ result: 'keksitty' }).result, AUDIT_RESULT.PROPOSED);
  assert.equal(normalizeAuditEntry({}).result, AUDIT_RESULT.PROPOSED);
});

test('totuusarvot eivät ole tulkinnanvaraisia', () => {
  // Vain nimenomainen true on true. "truthy" arvo ei riitä väittämään,
  // että käyttäjä vahvisti komennon.
  for (const value of ['kyllä', 1, {}, [], 'true']) {
    assert.equal(normalizeAuditEntry({ confirmed: value }).confirmed, false,
      JSON.stringify(value));
  }
  assert.equal(normalizeAuditEntry({ confirmed: true }).confirmed, true);
});

test('ehdotuksen pituus on rajattu', () => {
  const long = 'x'.repeat(500);
  assert.ok(normalizeAuditEntry({ proposal: long }).proposal.length <= 300);
});

// --------------------------------------------------------- validointi

test('kirjaus vaatii komennon ja aikaleiman', () => {
  const { valid, errors } = validateAuditEntry(normalizeAuditEntry({}));
  assert.equal(valid, false);
  assert.ok(errors.intent);
  assert.ok(errors.timestamp);
});

test('KRIITTINEN: suoritettu ilman vahvistusta hylätään', () => {
  // Sellainen kirjaus olisi merkki turvamallin rikkoutumisesta. Kirjaus
  // ei saa väittää sen tapahtuneen.
  const invalid = entry({ executed: true, confirmed: false });
  const { valid, errors } = validateAuditEntry(invalid);

  assert.equal(valid, false);
  assert.ok(errors.confirmed);
});

test('vahvistettu ja suoritettu on kelvollinen', () => {
  assert.equal(validateAuditEntry(
    entry({ executed: true, confirmed: true, result: AUDIT_RESULT.EXECUTED })).valid, true);
});

test('peruttu ilman suoritusta on kelvollinen', () => {
  assert.equal(validateAuditEntry(
    entry({ executed: false, confirmed: false, result: AUDIT_RESULT.CANCELLED })).valid, true);
});

// ------------------------------------------------------------- lista

test('uusin kirjaus on ensimmäisenä', () => {
  // Käyttäjä etsii lähes aina viimeisintä muutosta.
  let entries = [];
  entries = appendAuditEntry(entries, entry({ id: 'a1' }));
  entries = appendAuditEntry(entries, entry({ id: 'a2' }));

  assert.equal(entries[0].id, 'a2');
});

test('lisäys ei muuta annettua listaa', () => {
  const original = [entry({ id: 'a1' })];
  const updated = appendAuditEntry(original, entry({ id: 'a2' }));

  assert.equal(original.length, 1, 'alkuperäinen lista muuttui');
  assert.equal(updated.length, 2);
});

test('KRIITTINEN: loki ei kasva rajatta', () => {
  let entries = [];
  for (let index = 0; index < MAX_AUDIT_ENTRIES + 50; index++) {
    entries = appendAuditEntry(entries, entry({ id: 'a' + index }));
  }

  assert.equal(entries.length, MAX_AUDIT_ENTRIES);
  assert.equal(entries[0].id, 'a' + (MAX_AUDIT_ENTRIES + 49), 'uusin säilyi');
});

test('lisäys tyhjään tai puuttuvaan listaan toimii', () => {
  assert.equal(appendAuditEntry([], entry()).length, 1);
  assert.equal(appendAuditEntry(null, entry()).length, 1);
  assert.equal(appendAuditEntry(undefined, entry()).length, 1);
});

// --------------------------------------------------------- täydennys

test('kirjaus täydentyy eikä luo uutta riviä', () => {
  // Kaksi riviä näyttäisi kahdelta eri toiminnolta.
  const entries = [entry({ id: 'a1' }), entry({ id: 'a2' })];
  const updated = completeAuditEntry(entries, 'a1', {
    confirmed: true, executed: true, result: AUDIT_RESULT.EXECUTED
  });

  assert.equal(updated.length, 2);
  assert.equal(updated.find(e => e.id === 'a1').result, AUDIT_RESULT.EXECUTED);
  assert.equal(updated.find(e => e.id === 'a2').result, AUDIT_RESULT.PROPOSED);
});

test('tuntemattoman tunnisteen täydennys ei muuta mitään', () => {
  const entries = [entry({ id: 'a1' })];
  const updated = completeAuditEntry(entries, 'olematon', { executed: true });
  assert.deepEqual(updated, entries);
});

test('täydennys tyhjään listaan ei kaadu', () => {
  assert.deepEqual(completeAuditEntry([], 'a1', {}), []);
  assert.deepEqual(completeAuditEntry(null, 'a1', {}), []);
});

// ------------------------------------------------------- päiväkohtaisuus

test('kirjaukset löytyvät päivän mukaan', () => {
  const entries = [
    entry({ id: 'a1', timestamp: '2026-09-02T10:00:00.000Z' }),
    entry({ id: 'a2', timestamp: '2026-09-02T18:30:00.000Z' }),
    entry({ id: 'a3', timestamp: '2026-09-01T10:00:00.000Z' })
  ];

  assert.equal(entriesForDate(entries, '2026-09-02').length, 2);
  assert.equal(entriesForDate(entries, '2026-09-01').length, 1);
  assert.equal(entriesForDate(entries, '2026-09-03').length, 0);
});

test('kelvoton päivä ei tuota kirjauksia', () => {
  assert.deepEqual(entriesForDate([entry()], 'eilen'), []);
  assert.deepEqual(entriesForDate([entry()], null), []);
});

test('aikaleimaton kirjaus ei osu päivähakuun', () => {
  const entries = [normalizeAuditEntry({ intent: 'create_task' })];
  assert.deepEqual(entriesForDate(entries, '2026-09-02'), []);
});

// ------------------------------------------------------------ yhteenveto

test('yhteenveto laskee lopputulokset', () => {
  const summary = summarizeAudit([
    entry({ id: 'a1', result: AUDIT_RESULT.EXECUTED, confirmed: true, executed: true }),
    entry({ id: 'a2', result: AUDIT_RESULT.CANCELLED }),
    entry({ id: 'a3', result: AUDIT_RESULT.EXECUTED, confirmed: true, executed: true })
  ]);

  assert.equal(summary.total, 3);
  assert.equal(summary.byResult[AUDIT_RESULT.EXECUTED], 2);
  assert.equal(summary.byResult[AUDIT_RESULT.CANCELLED], 1);
  assert.equal(summary.confirmed, 2);
  assert.equal(summary.executed, 2);
  assert.equal(summary.latest.id, 'a1');
});

test('tyhjä yhteenveto on nollia eikä NaN', () => {
  const summary = summarizeAudit([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.latest, null);
  for (const value of Object.values(summary.byResult)) {
    assert.equal(value, 0);
    assert.equal(Number.isNaN(value), false);
  }
});

test('yhteenveto tuntee jokaisen lopputuloksen', () => {
  const summary = summarizeAudit([]);
  for (const result of AUDIT_RESULTS) {
    assert.equal(summary.byResult[result], 0, result);
  }
});

// ------------------------------------------------------------ kuvaukset

test('jokainen lopputulos selitetään käyttäjälle', () => {
  for (const result of AUDIT_RESULTS) {
    const text = describeAuditEntry(entry({ result }));
    assert.ok(text.length > 0, result);
    assert.ok(text.includes('Luo tehtävä'), result);
  }
});

test('kuvaus toimii ilman ehdotustekstiä', () => {
  const text = describeAuditEntry(normalizeAuditEntry({
    intent: 'create_task', timestamp: NOW, result: AUDIT_RESULT.EXECUTED
  }));
  assert.ok(text.includes('create_task'));
  assert.equal(describeAuditEntry(null), '');
});

// ------------------------------------------- mitä tämä EI ole

test('SÄÄNTÖ: kirjausketju ei ole analytiikkaa', () => {
  // Kirjauksessa ei ole kenttiä, jotka palvelisivat käytön mittaamista
  // eivätkä käyttäjän omaa muistia.
  const fields = Object.keys(entry());
  const forbidden = ['sessionId', 'deviceId', 'userAgent', 'ip', 'referrer',
    'campaign', 'experiment', 'cohort', 'durationMs'];

  for (const field of forbidden) {
    assert.equal(fields.includes(field), false, `analytiikkakenttä: ${field}`);
  }
});
