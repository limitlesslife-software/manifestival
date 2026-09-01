// AI-komentojen intent-putken ja turvamallin testit.
//
// AI:n tuotokseen ei luoteta. Nämä testit varmistavat, ettei mallin vastaus
// voi tuoda sovellukseen komentoa, jota sovellus ei tunne, eikä ohittaa
// käyttäjän vahvistusta.
//
// Testit eivät kutsu Anthropicia. Ne käyttävät kiinteitä esimerkkivastauksia
// — se on nopeaa, ilmaista ja toistettavaa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INTENT, INTENTS, FORBIDDEN_INTENTS, RISK, COMMANDS,
  isAllowedIntent, resolveCommand, needsConfirmation
} from '../src/ai/intentSchema.js';
import { RECURRENCE } from '../src/domain/routine.js';

const TODAY = '2026-09-01';
const context = { today: TODAY };

// ------------------------------------------------------------ allowlist

test('sallitut intentit on määritelty nimenomaisesti', () => {
  assert.deepEqual([...INTENTS].sort(), [
    'complete_task', 'create_goal', 'create_routine', 'create_task',
    'show_day', 'show_week', 'update_task'
  ]);
  for (const intent of INTENTS) {
    assert.ok(COMMANDS[intent], 'komento puuttuu rekisteristä: ' + intent);
  }
});

test('TURVA: poistoa ei ole allowlistissä lainkaan', () => {
  // Poisto ei ole "vaarallinen komento jota rajoitetaan" vaan komento, jota
  // ei ole olemassa. Sitä ei voi kutsua millään syötteellä.
  for (const intent of INTENTS) {
    assert.equal(intent.includes('delete'), false, 'poistokomento allowlistissä: ' + intent);
    assert.equal(intent.includes('remove'), false);
  }
});

test('TURVA: jokainen kielletty intentti hylätään', () => {
  for (const intent of FORBIDDEN_INTENTS) {
    const result = resolveCommand({ intent, title: 'X' }, context);
    assert.equal(result.ok, false, 'kielletty intentti meni läpi: ' + intent);
    assert.equal(result.forbidden, true);
  }
});

test('TURVA: tuntematon intentti hylätään turvallisesti', () => {
  for (const intent of ['keksitty', 'DROP TABLE tasks', '', null, 42, {}]) {
    const result = resolveCommand({ intent, title: 'X' }, context);
    assert.equal(result.ok, false, 'meni läpi: ' + JSON.stringify(intent));
    assert.match(result.reason, /tuntematon/i);
  }
});

test('isAllowedIntent tunnistaa vain rekisterin komennot', () => {
  assert.equal(isAllowedIntent(INTENT.CREATE_TASK), true);
  assert.equal(isAllowedIntent('delete_task'), false);
  assert.equal(isAllowedIntent('toString'), false, 'prototyypin kentät eivät ole komentoja');
  assert.equal(isAllowedIntent('constructor'), false);
});

test('objektiton vastaus hylätään', () => {
  for (const bad of [null, undefined, 'teksti', 42, []]) {
    assert.equal(resolveCommand(bad, context).ok, false);
  }
});

// -------------------------------------------------- rakenteen turvallisuus

test('TURVA: sisäkkäiset oliot hylätään payloadissa', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_TASK,
    title: 'X',
    saastuke: { $ne: null }
  }, context);
  assert.equal(result.ok, false);
  assert.match(result.reason, /kelvoton kenttä/i);
});

test('TURVA: funktiot ja monimutkaiset arvot hylätään', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_TASK,
    title: 'X',
    weekdays: [{ evil: true }]
  }, context);
  assert.equal(result.ok, false);
});

test('TURVA: user_id ei päädy komentoon', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_TASK,
    title: 'Tehtävä',
    user_id: '11111111-1111-1111-1111-111111111111'
  }, context);
  assert.equal(result.ok, true);
  assert.equal('user_id' in result.command.payload, false,
    'omistajuutta ei saa voida asettaa AI:n kautta');
});

test('TURVA: tuntemattomat kentät eivät päädy payloadiin', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_TASK,
    title: 'Tehtävä',
    completed: true,
    id: 'huijaus',
    sql: 'DROP TABLE tasks'
  }, context);
  assert.equal(result.ok, true);
  assert.equal('completed' in result.command.payload, false);
  assert.equal('id' in result.command.payload, false);
  assert.equal('sql' in result.command.payload, false);
});

// -------------------------------------------------------- vahvistus

test('TURVA: kaikki muuttavat komennot vaativat vahvistuksen', () => {
  for (const intent of INTENTS) {
    const definition = COMMANDS[intent];
    if (definition.risk === RISK.READ_ONLY) continue;
    assert.equal(definition.requiresConfirmation, true,
      'muuttava komento ilman vahvistusta: ' + intent);
  }
});

test('vain lukevat komennot ohittavat vahvistuksen', () => {
  const show = resolveCommand({ intent: INTENT.SHOW_DAY }, context);
  assert.equal(needsConfirmation(show.command), false);

  const create = resolveCommand({ intent: INTENT.CREATE_TASK, title: 'X' }, context);
  assert.equal(needsConfirmation(create.command), true);
});

test('needsConfirmation on turvallinen puuttuvalle komennolle', () => {
  assert.equal(needsConfirmation(null), true);
  assert.equal(needsConfirmation(undefined), true);
});

// ------------------------------------------------- luonnollinen kieli

test('"Muistuta minua huomenna kello 14 soittamaan Jannelle"', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_TASK,
    title: 'Soita Jannelle',
    date: '2026-09-02',
    time: '14:00',
    category: 'perhe'
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.command.intent, INTENT.CREATE_TASK);
  assert.equal(result.command.payload.title, 'Soita Jannelle');
  assert.equal(result.command.payload.date, '2026-09-02');
  assert.equal(result.command.payload.time, '14:00');
  assert.equal(result.command.requiresConfirmation, true);
});

test('"Joka arkiaamu kello 7 lääkkeet"', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_ROUTINE,
    title: 'Lääkkeet',
    recurrence: RECURRENCE.WEEKDAYS,
    time: '07:00',
    durationMinutes: 5,
    category: 'hyvinvointi'
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.recurrence, RECURRENCE.WEEKDAYS);
  assert.equal(result.command.payload.preferredTime, '07:00');
  assert.equal(result.command.payload.durationMinutes, 5);
});

test('"Haluan saada Manifestivalin julkaistua marraskuussa"', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_GOAL,
    title: 'Julkaise Manifestival',
    targetDate: '2026-11-30',
    category: 'kehitys'
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.title, 'Julkaise Manifestival');
  assert.equal(result.command.payload.targetDate, '2026-11-30');
});

test('"Merkitse auton pesu tehdyksi"', () => {
  const result = resolveCommand({
    intent: INTENT.COMPLETE_TASK,
    targetTitle: 'Auton pesu'
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.targetTitle, 'Auton pesu');
  assert.equal(result.command.payload.completed, true);
  assert.equal(result.command.requiresConfirmation, true,
    'kuittaus muuttaa dataa, joten se vahvistetaan');
});

test('"Siirrä huomisen hammaslääkäri kello kolmeen"', () => {
  const result = resolveCommand({
    intent: INTENT.UPDATE_TASK,
    targetTitle: 'Hammaslääkäri',
    time: '15:00'
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.targetTitle, 'Hammaslääkäri');
  assert.equal(result.command.payload.changes.time, '15:00');
  assert.equal(result.command.risk, RISK.MEDIUM);
});

test('"Näytä huominen"', () => {
  const result = resolveCommand({ intent: INTENT.SHOW_DAY, date: '2026-09-02' }, context);
  assert.equal(result.ok, true);
  assert.equal(result.command.payload.date, '2026-09-02');
  assert.equal(result.command.risk, RISK.READ_ONLY);
});

test('"Näytä viikko" ilman päivää käyttää tätä päivää', () => {
  const result = resolveCommand({ intent: INTENT.SHOW_WEEK }, context);
  assert.equal(result.ok, true);
  assert.equal(result.command.payload.date, TODAY);
});

// -------------------------------------------------------- validointi

test('otsikoton tehtävä hylätään', () => {
  const result = resolveCommand({ intent: INTENT.CREATE_TASK, date: TODAY }, context);
  assert.equal(result.ok, false);
  assert.match(result.reason, /otsikko/i);
});

test('kelvoton päivämäärä korvautuu tällä päivällä', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_TASK, title: 'X', date: 'huomenna joskus'
  }, context);
  assert.equal(result.ok, true);
  assert.equal(result.command.payload.date, TODAY);
  assert.ok(result.command.rejectedFields.includes('date'));
});

test('kelvoton kellonaika pudotetaan', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_TASK, title: 'X', time: '25:99'
  }, context);
  assert.equal(result.command.payload.time, null);
  assert.ok(result.command.rejectedFields.includes('time'));
});

test('keksitty kategoria ja prioriteetti normalisoidaan', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_TASK, title: 'X',
    category: 'salainen', priority: 'ULTRA'
  }, context);
  assert.equal(result.command.payload.category, 'muu');
  assert.equal(result.command.payload.priority, 'normaali');
  assert.ok(result.command.rejectedFields.includes('category'));
  assert.ok(result.command.rejectedFields.includes('priority'));
});

test('loppuaika ilman alkuaikaa pudotetaan', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_TASK, title: 'X', endTime: '15:00'
  }, context);
  assert.equal(result.command.payload.endTime, null);
});

test('määräaika hyväksytään erillisenä aikataulutuksesta', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_TASK, title: 'Maksa lasku',
    date: '2026-09-02', deadline: '2026-09-05'
  }, context);
  assert.equal(result.command.payload.date, '2026-09-02');
  assert.equal(result.command.payload.deadline, '2026-09-05');
});

test('kohteeton muutoskomento hylätään', () => {
  const result = resolveCommand({ intent: INTENT.UPDATE_TASK, time: '15:00' }, context);
  assert.equal(result.ok, false);
  assert.match(result.reason, /kohdetehtävää/i);
});

test('muutoskomento ilman muutosta hylätään', () => {
  const result = resolveCommand({ intent: INTENT.UPDATE_TASK, targetTitle: 'X' }, context);
  assert.equal(result.ok, false);
  assert.match(result.reason, /muutosta/i);
});

test('REGRESSIO: muutos koskee vain nimenomaisesti annettuja kenttiä', () => {
  // Aiemmin normalizeCategory(undefined) palautti 'muu' ja
  // normalizePriority(undefined) palautti 'normaali', jolloin pelkkä ajan
  // siirto olisi ylikirjoittanut myös kategorian ja prioriteetin.
  // Käyttäjä olisi menettänyt tietoa pyytämättä sitä.
  const result = resolveCommand({
    intent: INTENT.UPDATE_TASK,
    targetTitle: 'Hammaslääkäri',
    time: '15:00'
  }, context);

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.command.payload.changes), ['time'],
    'vain aika saa muuttua');
  assert.equal('category' in result.command.payload.changes, false);
  assert.equal('priority' in result.command.payload.changes, false);
  assert.equal('date' in result.command.payload.changes, false);
});

test('muutos voi koskea useaa kenttää, jos ne annetaan', () => {
  const result = resolveCommand({
    intent: INTENT.UPDATE_TASK,
    targetTitle: 'Palaveri',
    time: '09:00',
    priority: 'korkea',
    deadline: '2026-09-10'
  }, context);
  assert.deepEqual(
    Object.keys(result.command.payload.changes).sort(),
    ['deadline', 'priority', 'time']
  );
});

test('uusi otsikko annetaan omassa kentässään', () => {
  const result = resolveCommand({
    intent: INTENT.UPDATE_TASK,
    targetTitle: 'Vanha nimi',
    newTitle: 'Uusi nimi'
  }, context);
  assert.equal(result.command.payload.targetTitle, 'Vanha nimi');
  assert.equal(result.command.payload.changes.title, 'Uusi nimi');
});

test('kohteeton kuittauskomento hylätään', () => {
  const result = resolveCommand({ intent: INTENT.COMPLETE_TASK }, context);
  assert.equal(result.ok, false);
});

test('mukautettu rutiini ilman viikonpäiviä hylätään', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_ROUTINE, title: 'X', recurrence: RECURRENCE.CUSTOM_WEEKDAYS
  }, context);
  assert.equal(result.ok, false);
  assert.match(result.reason, /viikonpäivät/i);
});

test('rutiinin viikonpäivät normalisoidaan', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_ROUTINE, title: 'Sali',
    recurrence: RECURRENCE.CUSTOM_WEEKDAYS, weekdays: [5, 1, 5, 99]
  }, context);
  assert.equal(result.ok, true);
  assert.deepEqual(result.command.payload.weekdays, [1, 5]);
});

test('tuntematon toistotyyppi korvautuu päivittäisellä', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_ROUTINE, title: 'X', recurrence: 'joka-toinen-tiistai'
  }, context);
  assert.equal(result.command.payload.recurrence, RECURRENCE.DAILY);
  assert.ok(result.command.rejectedFields.includes('recurrence'));
});

// ------------------------------------------------ payload-kääre

test('payload voi olla joko juuressa tai omassa kentässään', () => {
  const flat = resolveCommand({ intent: INTENT.CREATE_TASK, title: 'A' }, context);
  const wrapped = resolveCommand({ intent: INTENT.CREATE_TASK, payload: { title: 'A' } }, context);
  assert.equal(flat.command.payload.title, 'A');
  assert.equal(wrapped.command.payload.title, 'A');
});

// ------------------------------------------------------- kuvaukset

test('jokainen komento kuvaa itsensä käyttäjälle', () => {
  const samples = [
    { intent: INTENT.CREATE_TASK, title: 'Soita' },
    { intent: INTENT.CREATE_ROUTINE, title: 'Lääkkeet' },
    { intent: INTENT.CREATE_GOAL, title: 'Julkaise' },
    { intent: INTENT.COMPLETE_TASK, targetTitle: 'Pesu' },
    { intent: INTENT.UPDATE_TASK, targetTitle: 'Lääkäri', time: '15:00' },
    { intent: INTENT.SHOW_DAY },
    { intent: INTENT.SHOW_WEEK }
  ];
  for (const sample of samples) {
    const result = resolveCommand(sample, context);
    assert.equal(result.ok, true, sample.intent + ' epäonnistui');
    assert.ok(result.command.description.length > 5,
      'kuvaus puuttuu: ' + sample.intent);
    assert.ok(result.command.label.length > 0);
  }
});

// ------------------------------------------------------ determinismi

test('TAKUU: sama syöte tuottaa saman komennon', () => {
  const raw = { intent: INTENT.CREATE_TASK, title: 'Testi', date: TODAY, time: '10:00' };
  const runs = Array.from({ length: 5 }, () =>
    JSON.stringify(resolveCommand(raw, context)));
  assert.equal(new Set(runs).size, 1);
});

test('resolveCommand ei mutatoi syötettä', () => {
  const raw = { intent: INTENT.CREATE_TASK, title: 'Testi', category: 'keksitty' };
  const before = JSON.stringify(raw);
  resolveCommand(raw, context);
  assert.equal(JSON.stringify(raw), before);
});
