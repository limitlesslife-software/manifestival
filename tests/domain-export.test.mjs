// Datan viennin ja tuonnin testit.
//
// Vienti on tiedosto, joka päätyy latauskansioon, pilveen ja mahdollisesti
// sähköpostiin. Salaisuus siinä olisi salaisuus kaikkialla. Siksi
// painopiste on siinä, MITÄ EI VIEDÄ.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPORT_VERSION, EXPORT_KIND, EXPORTED_COLLECTIONS, REDACTED_FIELDS,
  IMPORT_STATUS,
  redact, buildUserDataExport, serializeExport,
  parseImport, buildImportPreview, analyzeImportConflicts
} from '../src/domain/dataExport.js';

const NOW = '2026-09-02T10:00:00.000Z';

function sampleData() {
  return {
    tasks: [{ id: 't1', title: 'Soita Matille', completed: false }],
    routines: [{ id: 'r1', title: 'Aamulääkkeet', active: true }],
    routineExceptions: [{ id: 'x1', routineId: 'r1', date: '2026-09-03', type: 'skip' }],
    goals: [{ id: 'g1', title: 'Julkaise' }],
    projects: [{ id: 'p1', name: 'Remontti' }],
    bills: [{ id: 'b1', name: 'Sähkö', amountMinor: 8450, currency: 'EUR' }],
    recurringExpenses: [{ id: 'e1', name: 'Netti', amountMinor: 2990 }],
    savingsGoals: [{ id: 's1', name: 'Hätävara', targetMinor: 600000 }],
    wellbeing: [{ id: 'w1', date: '2026-09-01', energy: 3 }],
    notificationPreferences: { enabled: false, maxPerDay: 12 },
    profile: { age: 34, sleepTargetHours: 8 },
    aiAudit: [{ id: 'a1', intent: 'create_task', result: 'executed' }]
  };
}

// ------------------------------------------------------------- rakenne

test('vienti on versioitu ja tunnistettavissa', () => {
  const exported = buildUserDataExport(sampleData(), { exportedAt: NOW });

  assert.equal(exported.kind, EXPORT_KIND);
  assert.equal(exported.manifestivalExportVersion, EXPORT_VERSION);
  assert.equal(exported.exportedAt, NOW);
  assert.equal(Number.isInteger(exported.manifestivalExportVersion), true);
});

test('vienti kattaa jokaisen luetellun tietotyypin', () => {
  const exported = buildUserDataExport(sampleData(), { exportedAt: NOW });
  for (const name of EXPORTED_COLLECTIONS) {
    assert.ok(name in exported.data, 'puuttuu viennistä: ' + name);
  }
});

test('puuttuva kokoelma viedään tyhjänä eikä jätetä pois', () => {
  // Tuonti näkee silloin eron "ei ollut mitään" ja "kenttää ei ollut".
  const exported = buildUserDataExport({ tasks: [{ id: 't1', title: 'X' }] },
    { exportedAt: NOW });

  for (const name of EXPORTED_COLLECTIONS) {
    assert.ok(name in exported.data, name);
  }
  assert.deepEqual(exported.data.goals, []);
});

test('rivimäärät kerrotaan erikseen', () => {
  const exported = buildUserDataExport(sampleData(), { exportedAt: NOW });
  assert.equal(exported.counts.tasks, 1);
  assert.equal(exported.counts.profile, 1, 'olio lasketaan yhdeksi');
});

test('vienti on deterministinen', () => {
  const data = sampleData();
  assert.deepEqual(
    buildUserDataExport(data, { exportedAt: NOW }),
    buildUserDataExport(data, { exportedAt: NOW }));
});

test('vienti sarjallistuu luettavaksi JSONiksi', () => {
  const text = serializeExport(buildUserDataExport(sampleData(), { exportedAt: NOW }));
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('\n'), 'sisennys puuttuu');
  assert.doesNotThrow(() => JSON.parse(text));
});

// ------------------------------------------------------------ salaisuudet

test('KRIITTINEN: vienti ei koskaan sisällä salaisuuksia', () => {
  // Testi rakentaa datan, jossa JOKAINEN kielletty kenttä esiintyy
  // useassa paikassa ja eri syvyyksissä.
  const poisoned = {
    tasks: [{
      id: 't1', title: 'X',
      user_id: '11111111-1111-1111-1111-111111111111',
      token: 'salainen-token',
      nested: { apiKey: 'sk-ant-123', deeper: { refreshToken: 'r-123' } }
    }],
    profile: {
      age: 34,
      password: 'hunter2',
      session: { accessToken: 'a-1', credentials: { secret: 's' } }
    },
    aiAudit: [{ id: 'a1', intent: 'create_task', anonKey: 'eyJ...' }]
  };

  const text = serializeExport(buildUserDataExport(poisoned, { exportedAt: NOW }));

  for (const field of REDACTED_FIELDS) {
    assert.equal(text.includes(`"${field}"`), false, `vienti sisältää kentän ${field}`);
  }

  // Myös arvot itsessään ovat poissa.
  for (const value of ['salainen-token', 'sk-ant-123', 'r-123', 'hunter2', 'a-1', 'eyJ...',
    '11111111-1111-1111-1111-111111111111']) {
    assert.equal(text.includes(value), false, `vienti sisältää arvon ${value}`);
  }
});

test('suodatus säilyttää muut kentät', () => {
  const cleaned = redact({
    id: 't1', title: 'Säilyy', token: 'katoaa',
    nested: { keep: 1, apiKey: 'katoaa' }
  });

  assert.equal(cleaned.title, 'Säilyy');
  assert.equal(cleaned.nested.keep, 1);
  assert.equal('token' in cleaned, false);
  assert.equal('apiKey' in cleaned.nested, false);
});

test('suodatus ei välitä kirjainkoosta', () => {
  const cleaned = redact({ Token: 'x', USER_ID: 'y', ApiKey: 'z', ok: 1 });
  assert.deepEqual(cleaned, { ok: 1 });
});

test('suodatus toimii taulukoissa ja syvissä rakenteissa', () => {
  const cleaned = redact([
    { token: 'x', ok: 1 },
    { list: [{ secret: 'y', ok: 2 }] }
  ]);
  assert.deepEqual(cleaned, [{ ok: 1 }, { list: [{ ok: 2 }] }]);
});

test('suodatus ei jää jumiin syvään rakenteeseen', () => {
  // Syklinen rakenne ei ole mahdollinen JSONissa, mutta syvä on. Raja
  // estää pinon loppumisen.
  let deep = { ok: 1 };
  for (let index = 0; index < 40; index++) deep = { level: deep };
  assert.doesNotThrow(() => redact(deep));
});

test('yksinkertaiset arvot säilyvät sellaisenaan', () => {
  assert.equal(redact('teksti'), 'teksti');
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  assert.equal(redact(true), true);
});

// -------------------------------------------------------------- tuonti

test('kelvollinen vienti tuodaan takaisin', () => {
  const text = serializeExport(buildUserDataExport(sampleData(), { exportedAt: NOW }));
  const result = parseImport(text);

  assert.equal(result.status, IMPORT_STATUS.OK);
  assert.equal(result.preview.version, EXPORT_VERSION);
  assert.ok(result.preview.totalRows > 0);
});

test('rikkinäinen JSON hylätään selkeästi', () => {
  const result = parseImport('{ tämä ei ole json');
  assert.equal(result.status, IMPORT_STATUS.INVALID_JSON);
  assert.ok(result.reason);
  assert.equal(result.preview, undefined);
});

test('vieras tiedosto hylätään', () => {
  const result = parseImport(JSON.stringify({ some: 'other app' }));
  assert.equal(result.status, IMPORT_STATUS.NOT_MANIFESTIVAL);
});

test('KRIITTINEN: uudempaa versiota ei yritetä arvata', () => {
  // Uudempi versio voi sisältää rakenteita, joita tämä versio ei ymmärrä.
  // Arvaaminen turmelisi käyttäjän tiedot.
  const result = parseImport(JSON.stringify({
    kind: EXPORT_KIND,
    manifestivalExportVersion: EXPORT_VERSION + 5,
    data: {}
  }));

  assert.equal(result.status, IMPORT_STATUS.UNSUPPORTED_VERSION);
  assert.match(result.reason, new RegExp(String(EXPORT_VERSION + 5)));
});

test('puuttuva tai kelvoton versio hylätään', () => {
  for (const version of [undefined, null, 0, -1, 'yksi', 1.5]) {
    const result = parseImport(JSON.stringify({
      kind: EXPORT_KIND, manifestivalExportVersion: version, data: {}
    }));
    assert.equal(result.status, IMPORT_STATUS.UNSUPPORTED_VERSION, String(version));
  }
});

test('puuttuva data-osio hylätään', () => {
  for (const data of [undefined, null, 'teksti', []]) {
    const result = parseImport(JSON.stringify({
      kind: EXPORT_KIND, manifestivalExportVersion: EXPORT_VERSION, data
    }));
    assert.equal(result.status, IMPORT_STATUS.INVALID_STRUCTURE, JSON.stringify(data));
  }
});

test('taulukko juuressa ei ole kelvollinen tuonti', () => {
  assert.equal(parseImport('[]').status, IMPORT_STATUS.INVALID_STRUCTURE);
});

test('esikatselu kertoo mitä tiedostossa on', () => {
  const exported = buildUserDataExport(sampleData(), { exportedAt: NOW });
  const preview = buildImportPreview(exported);

  const tasks = preview.collections.find(entry => entry.name === 'tasks');
  assert.equal(tasks.count, 1);
  assert.equal(tasks.present, true);
  assert.equal(preview.exportedAt, NOW);
});

test('KRIITTINEN: tuonti ei kirjoita mitään', () => {
  // Tässä aallossa tuonti on PARSE + VALIDATE + PREVIEW. Massakirjoitus
  // ilman konfliktimallia olisi paras tapa tuhota olemassa oleva data.
  const original = sampleData();
  const snapshot = JSON.stringify(original);

  const text = serializeExport(buildUserDataExport(original, { exportedAt: NOW }));
  parseImport(text);

  assert.equal(JSON.stringify(original), snapshot, 'tuonti muutti lähdedataa');
});

// -------------------------------------------------------- konfliktit

test('konfliktianalyysi erottaa uudet ja törmäävät rivit', () => {
  const incoming = buildUserDataExport({
    tasks: [{ id: 't1', title: 'Vanha' }, { id: 't2', title: 'Uusi' }]
  }, { exportedAt: NOW });

  const analysis = analyzeImportConflicts(incoming, {
    tasks: [{ id: 't1', title: 'Nykyinen' }]
  });

  const tasks = analysis.conflicts.find(entry => entry.name === 'tasks');
  assert.equal(tasks.incoming, 2);
  assert.equal(tasks.existing, 1);
  assert.equal(tasks.collisions, 1);
  assert.equal(tasks.newRows, 1);
  assert.equal(analysis.totalCollisions, 1);
  assert.equal(analysis.totalNew, 1);
});

test('konfliktianalyysi tyhjää nykytilaa vasten ei löydä törmäyksiä', () => {
  const incoming = buildUserDataExport({
    tasks: [{ id: 't1', title: 'X' }]
  }, { exportedAt: NOW });

  const analysis = analyzeImportConflicts(incoming, {});
  assert.equal(analysis.totalCollisions, 0);
  assert.equal(analysis.totalNew, 1);
});

test('konfliktianalyysi ei kaadu puuttuviin kenttiin', () => {
  assert.doesNotThrow(() => analyzeImportConflicts({ data: {} }, {}));
  assert.doesNotThrow(() => analyzeImportConflicts({}, {}));
});

// ------------------------------------------------------------- kierros

test('vienti ja tuonti säilyttävät rivimäärät', () => {
  const data = sampleData();
  const text = serializeExport(buildUserDataExport(data, { exportedAt: NOW }));
  const result = parseImport(text);

  assert.equal(result.status, IMPORT_STATUS.OK);
  assert.equal(result.parsed.data.tasks.length, data.tasks.length);
  assert.equal(result.parsed.data.bills.length, data.bills.length);
  assert.equal(result.parsed.data.profile.age, data.profile.age);
});

test('rahasummat säilyvät kokonaislukuina viennin läpi', () => {
  const text = serializeExport(buildUserDataExport(sampleData(), { exportedAt: NOW }));
  const result = parseImport(text);

  const bill = result.parsed.data.bills[0];
  assert.equal(bill.amountMinor, 8450);
  assert.equal(Number.isInteger(bill.amountMinor), true);
});
