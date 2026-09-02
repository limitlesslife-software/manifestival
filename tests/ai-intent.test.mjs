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
  INTENT, INTENTS, FORBIDDEN_INTENTS, RISK, RISK_LEVELS, COMMANDS,
  isAllowedIntent, resolveCommand, needsConfirmation
} from '../src/ai/intentSchema.js';
import { RECURRENCE } from '../src/domain/routine.js';

const TODAY = '2026-09-01';
const context = { today: TODAY };

// ------------------------------------------------------------ allowlist

test('sallitut intentit on määritelty nimenomaisesti', () => {
  assert.deepEqual([...INTENTS].sort(), [
    'complete_task',
    'create_bill', 'create_goal', 'create_project', 'create_routine', 'create_task',
    'delete_goal', 'delete_project', 'delete_routine', 'delete_task',
    'mark_bill_paid',
    'reschedule_task', 'schedule_task',
    'set_notification_preference',
    'show_day_plan', 'show_week_plan',
    'uncomplete_task',
    'update_bill', 'update_goal', 'update_project', 'update_routine', 'update_task'
  ]);
  for (const intent of INTENTS) {
    assert.ok(COMMANDS[intent], 'komento puuttuu rekisteristä: ' + intent);
  }
});

test('TURVA: poistokomennot ovat korkeaa riskiä ja vaativat tarkan kohteen', () => {
  // MUUTOS V1:STÄ. Aiemmin poistoa ei ollut allowlistilla lainkaan — se oli
  // yksinkertaisin mahdollinen suoja, mutta tarkoitti ettei "poista se
  // peruttu palaveri" toiminut lainkaan.
  //
  // V2 sallii poiston ja korvaa puuttuvan suojan kahdella tiukemmalla:
  // eksplisiittinen vahvistus, jota ei voi kytkeä pois, ja vaatimus siitä
  // että kohde on tunnistettu YKSISELITTEISESTI.
  const deleteIntents = INTENTS.filter(intent => intent.startsWith('delete_'));
  assert.equal(deleteIntents.length, 4, 'odotettiin neljä poistokomentoa');

  for (const intent of deleteIntents) {
    const definition = COMMANDS[intent];
    assert.equal(definition.risk, RISK.HIGH, intent + ': poiston pitää olla HIGH');
    assert.equal(definition.requiresExactTarget, true,
      intent + ': poisto ei saa edetä epäselvällä kohteella');
  }
});

test('TURVA: massapoistoa ei ole olemassa', () => {
  // Yksittäisen rivin poisto voidaan vahvistaa mielekkäästi yhdellä
  // dialogilla. "Poista kaikki" ei voi — siksi sitä ei ole allowlistillä.
  for (const intent of INTENTS) {
    assert.equal(/all|everything|account/.test(intent), false,
      'massapoisto allowlistillä: ' + intent);
  }
  for (const forbidden of ['delete_all', 'delete_everything', 'delete_account']) {
    assert.equal(isAllowedIntent(forbidden), false, forbidden);
    assert.ok(FORBIDDEN_INTENTS.includes(forbidden), forbidden + ' puuttuu kielletyistä');
  }
});

test('TURVA: poistokomento vaatii eksplisiittisen vahvistuksen', () => {
  const result = resolveCommand({
    intent: INTENT.DELETE_TASK, targetTitle: 'Peruttu palaveri'
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.command.risk, RISK.HIGH);
  assert.equal(result.command.requiresConfirmation, true);
  assert.equal(result.command.requiresExplicitConfirmation, true);
  assert.equal(result.command.requiresExactTarget, true);
  assert.equal(needsConfirmation(result.command), true);
});

test('TURVA: poisto ilman kohdetta hylätään', () => {
  for (const intent of ['delete_task', 'delete_routine', 'delete_goal', 'delete_project']) {
    const result = resolveCommand({ intent }, context);
    assert.equal(result.ok, false, intent + ': kohteeton poisto meni läpi');
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
  assert.equal(isAllowedIntent(INTENT.DELETE_TASK), true, 'poisto on nyt olemassa');
  assert.equal(isAllowedIntent('delete_all'), false, 'massapoistoa ei ole');
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
  // Vahvistus JOHDETAAN riskitasosta eikä ole rekisterissä erillisenä
  // kenttänä. Yksi totuuden lähde: jos vahvistus olisi oma lippunsa, se
  // voisi joutua ristiriitaan riskitason kanssa — ja ristiriidassa
  // väärä puoli voittaisi hiljaa.
  for (const intent of INTENTS) {
    const definition = COMMANDS[intent];
    assert.ok(RISK_LEVELS.includes(definition.risk),
      intent + ': tuntematon riskitaso ' + definition.risk);

    if (definition.risk === RISK.LOW) continue;
    assert.equal(needsConfirmation({ risk: definition.risk }), true,
      'muuttava komento ilman vahvistusta: ' + intent);
  }
});

test('TURVA: jokainen riskitaso on nimenomaisesti valittu', () => {
  // Oletusarvo on vaarallisin mahdollinen puuttuva päätös: uusi komento
  // päätyisi vahingossa matalimpaan luokkaan eikä kysyisi mitään.
  for (const intent of INTENTS) {
    const definition = COMMANDS[intent];
    if (intent.startsWith('delete_')) {
      assert.equal(definition.risk, RISK.HIGH, intent);
    } else if (intent.startsWith('show_')) {
      assert.equal(definition.risk, RISK.LOW, intent);
    } else {
      assert.equal(definition.risk, RISK.MEDIUM, intent);
    }
  }
});

test('vain lukevat komennot ohittavat vahvistuksen', () => {
  const show = resolveCommand({ intent: INTENT.SHOW_DAY_PLAN }, context);
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
  assert.equal(result.command.payload.targetName, 'Auton pesu');
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
  assert.equal(result.command.payload.targetName, 'Hammaslääkäri');
  assert.equal(result.command.payload.changes.time, '15:00');
  assert.equal(result.command.risk, RISK.MEDIUM);
});

test('"Näytä huominen"', () => {
  const result = resolveCommand({ intent: INTENT.SHOW_DAY_PLAN, date: '2026-09-02' }, context);
  assert.equal(result.ok, true);
  assert.equal(result.command.payload.date, '2026-09-02');
  assert.equal(result.command.risk, RISK.LOW);
});

test('"Näytä viikko" ilman päivää käyttää tätä päivää', () => {
  const result = resolveCommand({ intent: INTENT.SHOW_WEEK_PLAN }, context);
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
  assert.equal(result.command.payload.targetName, 'Vanha nimi');
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
    { intent: INTENT.SHOW_DAY_PLAN },
    { intent: INTENT.SHOW_WEEK_PLAN }
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

// ------------------------------------------------ V2: uudet intentit

test('"Lisää kuntosalirutiini maanantaille, keskiviikolle ja perjantaille"', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_ROUTINE,
    title: 'Kuntosali',
    recurrence: RECURRENCE.CUSTOM_WEEKDAYS,
    weekdays: [1, 3, 5]
  }, context);

  assert.equal(result.ok, true);
  assert.deepEqual(result.command.payload.weekdays, [1, 3, 5]);
  assert.equal(result.command.risk, RISK.MEDIUM);
});

test('"Siirrä huominen palaveri kahdella tunnilla"', () => {
  const result = resolveCommand({
    intent: INTENT.RESCHEDULE_TASK,
    targetTitle: 'Palaveri',
    shiftMinutes: 120
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.shiftMinutes, 120);
  assert.match(result.command.description, /2 h eteenpäin/);
});

test('kohtuuton siirto hylätään mutta komento ei kaadu', () => {
  // Yli vuorokauden siirto on todennäköisemmin väärinymmärrys kuin tarkoitus.
  const result = resolveCommand({
    intent: INTENT.RESCHEDULE_TASK,
    targetTitle: 'Palaveri',
    shiftMinutes: 99999,
    time: '15:00'
  }, context);

  assert.equal(result.ok, true, 'kelvollinen aika pelastaa komennon');
  assert.equal(result.command.payload.shiftMinutes, null);
  assert.ok(result.command.rejectedFields.includes('shiftMinutes'));
});

test('siirto ilman uutta aikaa hylätään', () => {
  const result = resolveCommand({
    intent: INTENT.RESCHEDULE_TASK, targetTitle: 'Palaveri'
  }, context);
  assert.equal(result.ok, false);
});

test('"Lisää projekti autotallin remontti ja sille deadline 30.9."', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_PROJECT,
    name: 'Autotallin remontti',
    deadline: '2026-09-30'
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.name, 'Autotallin remontti');
  assert.equal(result.command.payload.deadline, '2026-09-30');
  assert.equal(result.command.targetType, 'project');
});

test('"Merkitse sähkölasku maksetuksi"', () => {
  const result = resolveCommand({
    intent: INTENT.MARK_BILL_PAID, targetName: 'Sähkölasku'
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.targetName, 'Sähkölasku');
  assert.equal(result.command.payload.paidDate, TODAY, 'oletuksena tänään');
});

test('KRIITTINEN: laskun summa muunnetaan sentteihin heti rajalla', () => {
  // AI puhuu euroista, sovellus säilyttää sentit. Jos liukuluku pääsisi
  // syvemmälle, pyöristysvirhe kertautuisi summattaessa.
  const result = resolveCommand({
    intent: INTENT.CREATE_BILL,
    name: 'Sähkölasku',
    amount: 129.95,
    dueDate: '2026-09-30'
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.amountMinor, 12995);
  assert.equal(Number.isInteger(result.command.payload.amountMinor), true);
});

test('lasku ilman eräpäivää hylätään', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_BILL, name: 'Sähkölasku', amount: 50
  }, context);
  assert.equal(result.ok, false);
  assert.match(result.reason, /eräpäivä/i);
});

test('valuutta normalisoidaan isoiksi kirjaimiksi', () => {
  const result = resolveCommand({
    intent: INTENT.CREATE_BILL, name: 'X', amount: 1, dueDate: TODAY, currency: 'eur'
  }, context);
  assert.equal(result.command.payload.currency, 'EUR');
});

test('muistutusasetusten muutos rajataan sallittuihin arvoihin', () => {
  const result = resolveCommand({
    intent: INTENT.SET_NOTIFICATION_PREFERENCE,
    enabled: true,
    maxPerDay: 999,
    taskLeadMinutes: 15,
    quietHoursFrom: '23:00'
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.changes.enabled, true);
  assert.equal(result.command.payload.changes.taskLeadMinutes, 15);
  assert.equal(result.command.payload.changes.quietHoursFrom, '23:00');
  assert.equal('maxPerDay' in result.command.payload.changes, false, 'yli rajan');
  assert.ok(result.command.rejectedFields.includes('maxPerDay'));
});

test('KRIITTINEN: uncomplete ei ole sama komento kuin complete', () => {
  // Yhdellä komennolla ja totuusarvolla nämä sekoittuisivat helposti, ja
  // "merkitse tehdyksi" voisi kumota valmiin tehtävän.
  const done = resolveCommand({ intent: INTENT.COMPLETE_TASK, targetTitle: 'X' }, context);
  const undone = resolveCommand({ intent: INTENT.UNCOMPLETE_TASK, targetTitle: 'X' }, context);

  assert.equal(done.command.payload.completed, true);
  assert.equal(undone.command.payload.completed, false);
});

test('päivitys ei koskaan ylikirjoita antamattomia kenttiä', () => {
  // Sama suoja kuin tehtävillä, nyt myös rutiineille, tavoitteille,
  // projekteille ja laskuille. Ilman `provided`-erottelua normalisointi
  // täyttäisi puuttuvat kentät oletusarvoilla ja tallennus ylikirjoittaisi
  // ne hiljaa.
  const cases = [
    [INTENT.UPDATE_ROUTINE, { routineId: 'r1', time: '08:00' }, ['preferredTime']],
    [INTENT.UPDATE_GOAL, { goalId: 'g1', status: 'paused' }, ['status']],
    [INTENT.UPDATE_PROJECT, { projectId: 'p1', deadline: '2026-12-01' }, ['deadline']],
    [INTENT.UPDATE_BILL, { billId: 'b1', amount: 10 }, ['amountMinor']]
  ];

  for (const [intent, raw, expected] of cases) {
    const result = resolveCommand({ intent, ...raw }, context);
    assert.equal(result.ok, true, intent);
    assert.deepEqual(Object.keys(result.command.payload.changes).sort(),
      [...expected].sort(), intent);
  }
});

test('päivitys ilman muutosta hylätään', () => {
  for (const [intent, raw] of [
    [INTENT.UPDATE_ROUTINE, { routineId: 'r1' }],
    [INTENT.UPDATE_GOAL, { goalId: 'g1' }],
    [INTENT.UPDATE_PROJECT, { projectId: 'p1' }],
    [INTENT.UPDATE_BILL, { billId: 'b1' }]
  ]) {
    const result = resolveCommand({ intent, ...raw }, context);
    assert.equal(result.ok, false, intent + ': tyhjä muutos meni läpi');
  }
});

test('jokainen komento kertoo kohdetyyppinsä', () => {
  for (const intent of INTENTS) {
    assert.ok(COMMANDS[intent].targetType, intent + ': targetType puuttuu');
  }
});
