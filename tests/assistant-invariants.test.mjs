// Avustajan invariantit: tilinvaihto, offline ja rajat, joita ei saa ylittää.
//
// =====================================================================
// MITÄ TÄMÄ VARTIOI
// =====================================================================
//
// Kolme asiaa, joista jokainen on löytynyt tässä repositoriossa
// aiemmin jostain muusta kokoelmasta:
//
//   1. MUISTIVARASTO ON MODUULITASOINEN. Portin ollessa kiinni tieto
//      elää yhdessä instanssissa koko sivun eliniän. Ilman
//      nimenomaista tyhjennystä seuraava käyttäjä näkee edellisen
//      rivit — eikä RLS voi estää sitä, koska palvelimelta ei haeta
//      mitään.
//
//   2. TILA EI OLE SAMA ASIA KUIN VARASTO. `resetState()` nollaa
//      sovelluksen tilan mutta ei repositorion sisuksia. Molemmat on
//      tyhjennettävä, ja molemmat on testattava erikseen.
//
//   3. RAJA ILMAN TESTIÄ EI OLE RAJA. Hälytysten enimmäismäärä,
//      torkkujen määrä ja saapuvien katto ovat vakioita, joita on
//      helppo muuttaa vahingossa — ja joiden rikkoutuminen näkyy
//      käyttäjälle puhelimena joka soi minuutin välein.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  inboxRepo, remindersRepo, noticesRepo, travelPlansRepo, locationRulesRepo,
  ALL_REPOSITORIES, clearAllCollections
} from '../src/data/collectionsRepo.js';
import { setClient } from '../src/data/client.js';
import { setUser, clearUser } from '../src/data/session.js';
import { TABLES } from '../src/data/schema.js';

import {
  MAX_ALERTS_PER_REMINDER, MAX_SNOOZE_COUNT, MAX_SNOOZE_MINUTES,
  SNOOZE_OPTIONS, normalizeReminder, snooze, evaluateReminders,
  REMINDER_STATUS, REMINDER_TARGET, TRIGGER
} from '../src/domain/reminder.js';
import { MAX_OPEN_ITEMS, MAX_TEXT_LENGTH, normalizeInboxItem, atCapacity }
  from '../src/domain/inbox.js';
import { MAX_NOTICES, RETENTION_DAYS, normalizeNotice, addNotice, pruneNotices }
  from '../src/domain/notificationCenter.js';
import { MAX_TRAVEL_MINUTES, normalizeTravelPlan, computeLeaveBy }
  from '../src/domain/travel.js';
import { EXPORTED_COLLECTIONS, buildUserDataExport, REDACTED_FIELDS }
  from '../src/domain/dataExport.js';

const A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'a@example.com' };
const B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', email: 'b@example.com' };

const ASSISTANT_REPOS = Object.freeze([
  inboxRepo, remindersRepo, noticesRepo, travelPlansRepo, locationRulesRepo
]);

/** Kelvollinen rivi jokaiselle uudelle kokoelmalle. */
const ROWS = Object.freeze({
  inbox_items: { id: 'x-inbox', text: 'Salainen ajatus' },
  reminders: {
    id: 'x-rem', title: 'Salainen muistutus',
    trigger: TRIGGER.AT_TIME, dueDate: '2026-09-11', dueTime: '09:00'
  },
  notices: {
    id: 'x-not', key: 'salainen|avain', kind: 'reminder',
    title: 'Salainen ilmoitus', createdDate: '2026-09-11'
  },
  travel_plans: {
    id: 'x-tra', title: 'Salainen matka', destination: 'Salainen paikka',
    arrivalDate: '2026-09-11', arrivalTime: '10:00'
  },
  location_rules: { id: 'x-loc', place: 'Salainen paikka' }
});

beforeEach(() => {
  clearAllCollections();
  clearUser();
  setClient(null);
});

// =====================================================================
// TILINVAIHTO
// =====================================================================

test('KRIITTINEN: avustajan kokoelmat eivät vuoda seuraavalle käyttäjälle', async () => {
  // Portin ollessa kiinni palvelimelle ei mennä lainkaan, joten RLS ei
  // ole edes mukana kuvassa. Suojaus on yksinomaan asiakaspuolella.
  setUser(A);

  for (const repo of ASSISTANT_REPOS) {
    const result = await repo.insert(ROWS[repo.table]);
    assert.equal(result.ok, true, `${repo.table}: A:n rivin kirjoitus epäonnistui`);
  }

  // Uloskirjautuminen.
  clearAllCollections();
  clearUser();

  setUser(B);

  const vuotaneet = [];
  for (const repo of ASSISTANT_REPOS) {
    const list = await repo.list();
    if (list.ok && list.value.length > 0) {
      vuotaneet.push(`${repo.table}: ${list.value.length} riviä`);
    }
  }

  assert.deepEqual(vuotaneet, [],
    'edellisen käyttäjän rivit näkyvät seuraavalle:\n' + vuotaneet.join('\n'));
});

test('KRIITTINEN: yksikään avustajan kokoelma ei jää tyhjennyksen ulkopuolelle', async () => {
  // Osittainen tyhjennys olisi pahin mahdollinen lopputulos: se
  // näyttäisi toimivan ja vuotaisi silti.
  setUser(A);
  for (const repo of ASSISTANT_REPOS) await repo.insert(ROWS[repo.table]);

  clearAllCollections();

  for (const repo of ASSISTANT_REPOS) {
    const list = await repo.list();
    assert.equal(list.value.length, 0, `${repo.table} ei tyhjentynyt`);
  }
});

test('viisi uutta repositoriota on mukana kokonaislistassa', () => {
  // Repositorio, joka ei ole listassa, jää `clearAllCollections`in
  // ulkopuolelle — ja juuri sellainen puuttuminen aiheutti aiemman
  // ristiinvuodon.
  for (const repo of ASSISTANT_REPOS) {
    assert.ok(ALL_REPOSITORIES.includes(repo),
      `${repo.table} puuttuu ALL_REPOSITORIES-listalta`);
  }
});

// =====================================================================
// OFFLINE JA VERKKOVIRHE
// =====================================================================

test('KRIITTINEN: kirjaus ei katoa kun kanta on saavuttamattomissa', async () => {
  // Portti on kiinni, joten kirjoitus menee muistivarastoon eikä
  // verkkoon. Se on tarkoitus: kirjaus ei saa epäonnistua siksi että
  // verkko on poikki.
  assert.equal(TABLES.inboxItems, false,
    'tämä testi olettaa portin olevan kiinni');

  setUser(A);
  setClient(null);   // ei asiakasta lainkaan

  const result = await inboxRepo.insert(ROWS.inbox_items);
  assert.equal(result.ok, true, 'kirjaus epäonnistui ilman verkkoa');

  const list = await inboxRepo.list();
  assert.equal(list.value.length, 1, 'kirjattu rivi ei näy');
});

test('kiinni oleva kokoelma kertoo rehellisesti, ettei tieto säily', () => {
  for (const repo of ASSISTANT_REPOS) {
    assert.equal(repo.isPersistent(), false,
      `${repo.table} väittää säilyvänsä vaikka portti on kiinni`);
  }
});

// =====================================================================
// RAJAT
// =====================================================================

test('KRIITTINEN: hälytysten enimmäismäärä on viisi', () => {
  // Loputon toisto on helppo kirjoittaa vahingossa: yksi ehto väärin
  // päin ja käyttäjän puhelin soi minuutin välein.
  assert.equal(MAX_ALERTS_PER_REMINDER, 5);

  const tayteen = normalizeReminder({
    id: 'r1', title: 'x', dueDate: '2026-09-11', dueTime: '09:00',
    alertCount: MAX_ALERTS_PER_REMINDER
  });

  const { alerts } = evaluateReminders({
    reminders: [tayteen], todayIso: '2026-09-11', nowMinutes: 540
  });
  assert.equal(alerts.length, 0, 'rajan saavuttanut hälytti silti');
});

test('KRIITTINEN: torkkujen määrä on rajattu', () => {
  assert.equal(MAX_SNOOZE_COUNT, 10);

  const tayteen = normalizeReminder({
    id: 'r1', title: 'x', status: REMINDER_STATUS.DUE,
    dueDate: '2026-09-11', dueTime: '09:00', snoozeCount: MAX_SNOOZE_COUNT
  });

  assert.equal(snooze(tayteen, 15, { todayIso: '2026-09-11', nowMinutes: 540 }),
    null, 'rajan saavuttanutta sai torkuttaa');
});

test('KRIITTINEN: torkku ei voi ylittää vuorokautta', () => {
  assert.equal(MAX_SNOOZE_MINUTES, 1440);

  const r = normalizeReminder({
    id: 'r1', title: 'x', status: REMINDER_STATUS.DUE,
    dueDate: '2026-09-11', dueTime: '09:00'
  });

  assert.equal(snooze(r, MAX_SNOOZE_MINUTES + 1,
    { todayIso: '2026-09-11', nowMinutes: 540 }), null);
});

test('jokainen torkkuvaihtoehto mahtuu rajan sisään', () => {
  for (const minutes of SNOOZE_OPTIONS) {
    assert.ok(minutes > 0 && minutes <= MAX_SNOOZE_MINUTES,
      `torkkuvaihtoehto ${minutes} on rajan ulkopuolella`);
  }
});

test('KRIITTINEN: saapuvien katto koskee vain avoimia', () => {
  assert.equal(MAX_OPEN_ITEMS, 200);

  const avoimet = Array.from({ length: MAX_OPEN_ITEMS },
    (_, i) => normalizeInboxItem({ id: `a${i}`, text: `x${i}` }));
  assert.equal(atCapacity(avoimet), true);

  // Yksi vähemmän mahtuu.
  assert.equal(atCapacity(avoimet.slice(1)), false);
});

test('teksti katkaistaan eikä hylätä', () => {
  // Katkaisu säilyttää käyttäjän ajatuksen; hylkäys söisi sen.
  const pitka = 'x'.repeat(MAX_TEXT_LENGTH * 2);
  const item = normalizeInboxItem({ id: 'a', text: pitka });
  assert.equal(item.text.length, MAX_TEXT_LENGTH);
});

test('KRIITTINEN: ilmoitushistorian rajat ovat voimassa', () => {
  assert.equal(MAX_NOTICES, 100);
  assert.equal(RETENTION_DAYS, 30);

  const liikaa = Array.from({ length: MAX_NOTICES + 40 }, (_, i) =>
    normalizeNotice({
      id: `n${i}`, key: `k${i}`, kind: 'reminder', title: `x${i}`,
      createdDate: '2026-09-11'
    }));

  assert.equal(pruneNotices(liikaa, { todayIso: '2026-09-11' }).length,
    MAX_NOTICES);
});

test('KRIITTINEN: matka-aika on rajattu vuorokauteen', () => {
  assert.equal(MAX_TRAVEL_MINUTES, 1440);
  assert.equal(normalizeTravelPlan({ travelMinutes: 99999 }).travelMinutes,
    MAX_TRAVEL_MINUTES);
});

// =====================================================================
// VIENTI
// =====================================================================

test('KRIITTINEN: avustajan kokoelmat ovat viennissä', () => {
  // Vienti ilman niitä menettäisi käyttäjän oman tekstin hiljaa.
  for (const name of ['inboxItems', 'reminders', 'notices', 'travelPlans',
    'locationRules']) {
    assert.ok(EXPORTED_COLLECTIONS.includes(name),
      `kokoelma ${name} puuttuu viennistä`);
  }
});

test('KRIITTINEN: kesken oleva tulkinta EI ole viennissä', () => {
  // Sama päätös kuin kuittiluennalla ja suunnitelmaehdotuksella:
  // väliaikainen tila ei päädy vientiin eikä varmuuskopioon.
  for (const name of ['pendingCapture', 'pendingExtraction', 'pendingPlan',
    'pendingReplan', 'voiceState']) {
    assert.equal(EXPORTED_COLLECTIONS.includes(name), false,
      `väliaikainen tila ${name} on viennissä`);
  }
});

test('KRIITTINEN: viennissä ei ole ääntä eikä koordinaatteja', () => {
  const vienti = buildUserDataExport({
    inboxItems: [normalizeInboxItem({
      id: 'i1', text: 'Muista maito', source: 'voice'
    })],
    travelPlans: [normalizeTravelPlan({
      id: 'p1', title: 'Matka', origin: 'Koti', destination: 'Keskusta',
      arrivalDate: '2026-09-11', arrivalTime: '10:00'
    })]
  });

  const teksti = JSON.stringify(vienti);

  assert.equal(/audio|recording|base64|mediaRecorder/i.test(teksti), false,
    'viennissä on ääneen viittaava kenttä');
  assert.equal(/latitude|longitude|"lat"|"lon"|coordinates/i.test(teksti), false,
    'viennissä on koordinaatti');

  // Ja käyttäjän oma teksti ON mukana: se on koko viennin tarkoitus.
  assert.ok(teksti.includes('Muista maito'), 'käyttäjän teksti katosi viennistä');
  assert.ok(teksti.includes('Keskusta'), 'määränpään nimi katosi viennistä');
});

test('vienti pudottaa omistajatunnisteen myös uusista riveistä', () => {
  // Suodatus tehdään NIMEN perusteella koko puusta, joten uusien
  // kokoelmien ei pitäisi tarvita mitään erityistä. Tarkistetaan silti.
  assert.ok(REDACTED_FIELDS.includes('user_id'));
  assert.ok(REDACTED_FIELDS.includes('userId'));

  const vienti = buildUserDataExport({
    reminders: [{ id: 'r1', title: 'x', user_id: 'salainen', userId: 'salainen' }]
  });

  assert.equal(JSON.stringify(vienti).includes('salainen'), false,
    'omistajatunniste päätyi vientiin');
});

// =====================================================================
// TUNTEMATON PYSYY TUNTEMATTOMANA
// =====================================================================

test('KRIITTINEN: tuntematon matka-aika ei tuota lähtöaikaa missään polussa', () => {
  // Tämä on koko matkamoduulin tärkein sääntö, ja se testataan tässä
  // uudelleen invarianttina: yksikin polku, joka laskee lähtöajan
  // tuntemattomasta, tekisi käyttäjästä myöhässä olevan.
  const polut = [
    { travelMinutes: null },
    { travelMinutes: null, travelSource: 'provider' },
    { travelMinutes: undefined },
    { travelMinutes: '' },
    { travelMinutes: 'ei tietoa' },
    { travelMinutes: -5 }
  ];

  for (const muunnos of polut) {
    const plan = normalizeTravelPlan({
      id: 'p1', title: 'x', destination: 'y',
      arrivalDate: '2026-09-11', arrivalTime: '10:00',
      ...muunnos
    });

    assert.equal(plan.travelMinutes, null,
      `syöte ${JSON.stringify(muunnos)} ei tuottanut tuntematonta`);

    const leaveBy = computeLeaveBy(plan);
    assert.equal(leaveBy.known, false,
      `syöte ${JSON.stringify(muunnos)} tuotti lähtöajan`);
    assert.equal(leaveBy.leaveByTime, null);
  }
});

test('KRIITTINEN: puuttuva etuaika ei muutu nollaksi missään polussa', () => {
  for (const value of [null, undefined, '', 'ei mitään', -1]) {
    assert.equal(
      normalizeReminder({ leadMinutes: value }).leadMinutes, null,
      `arvo ${JSON.stringify(value)} muuttui luvuksi`);
  }
});

// =====================================================================
// KAKSOISKAPPALEIDEN ESTO PÄÄSTÄ PÄÄHÄN
// =====================================================================

test('KRIITTINEN: sama hälytys ei tuota kahta ilmoitusta', () => {
  const reminder = normalizeReminder({
    id: 'r1', title: 'Soita', dueDate: '2026-09-11', dueTime: '09:00'
  });

  const eka = evaluateReminders({
    reminders: [reminder], todayIso: '2026-09-11', nowMinutes: 540
  });
  assert.equal(eka.alerts.length, 1);

  // Ensimmäinen este: kutsujan avainjoukko.
  const toka = evaluateReminders({
    reminders: [reminder], todayIso: '2026-09-11', nowMinutes: 540,
    deliveredKeys: new Set(eka.alerts.map(a => a.key))
  });
  assert.equal(toka.alerts.length, 0);

  // Toinen este: lista hylkää saman avaimen vaikka esto pettäisi.
  let lista = [];
  const notice = normalizeNotice({
    id: 'n1', key: eka.alerts[0].key, kind: 'reminder',
    title: 'Soita', createdDate: '2026-09-11'
  });
  lista = addNotice(lista, notice);
  lista = addNotice(lista, { ...notice, id: 'n2' });

  assert.equal(lista.length, 1, 'sama avain meni listaan kahdesti');
});

test('orpo muistutus ei hälytä vaan raportoidaan orpona', () => {
  const orpo = normalizeReminder({
    id: 'r1', title: 'Soita', dueDate: '2026-09-11', dueTime: '09:00',
    targetType: REMINDER_TARGET.TASK, targetId: 'poistettu'
  });

  const { alerts, orphaned } = evaluateReminders({
    reminders: [orpo], todayIso: '2026-09-11', nowMinutes: 540,
    lookup: { task: [] }
  });

  assert.equal(alerts.length, 0, 'orpo hälytti');
  assert.equal(orphaned.length, 1, 'orpoa ei raportoitu');
});

test('tunnistejoukko ja taulukko antavat saman tuloksen', () => {
  // `evaluateReminders` rakentaa tunnistejoukot kerran kierrosta
  // kohti. Jos joukko ja taulukko erkanisivat, orpous riippuisi siitä
  // kumpaa kutsuja sattui käyttämään.
  const reminder = normalizeReminder({
    id: 'r1', title: 'Soita', dueDate: '2026-09-11', dueTime: '09:00',
    targetType: REMINDER_TARGET.TASK, targetId: 't1'
  });

  const taulukolla = evaluateReminders({
    reminders: [reminder], todayIso: '2026-09-11', nowMinutes: 540,
    lookup: { task: [{ id: 't1' }] }
  });

  const joukolla = evaluateReminders({
    reminders: [reminder], todayIso: '2026-09-11', nowMinutes: 540,
    lookup: { task: new Set(['t1']) }
  });

  assert.equal(taulukolla.orphaned.length, joukolla.orphaned.length);
  assert.equal(taulukolla.alerts.length, joukolla.alerts.length);
});
