// Avustajan suorituskyky realistisella kuormalla.
//
// =====================================================================
// KASVUN MUOTO, EI KELLONAIKA
// =====================================================================
//
// Kellolla mitattu raja kertoo koneen kuormasta yhtä paljon kuin
// koodista. Se kaatuu satunnaisesti, ja satunnaisesti kaatuva testi
// poistetaan ennen pitkää — jolloin se ei enää vahdi mitään.
//
// Siksi tämä mittaa DETERMINISTISESTI: kuinka monta kertaa syötettä
// luetaan, kun syöte kaksinkertaistuu. Lineaarinen algoritmi
// kaksinkertaistaa lukumäärän, neliöllinen nelinkertaistaa sen.
//
// Sama menetelmä kuin `tests/performance.test.mjs` ja
// `tests/goal-to-action-performance.test.mjs`. Sitä ei keksitä tässä
// uudelleen toisin.
//
// =====================================================================
// MIKSI JUURI NÄMÄ FUNKTIOT
// =====================================================================
//
// Hälytyskierros ajetaan KOLMENKYMMENEN SEKUNNIN VÄLEIN niin kauan kuin
// sovellus on auki. Se on ainoa tämän paketin koodi, joka ajetaan
// toistuvasti ilman käyttäjän tekoa — ja siksi ainoa, jonka
// neliöllisyys näkyisi puhelimen akussa eikä virhelokissa.
//
// `nowNext` ajetaan jokaisella renderöinnillä. Se lukee viittä
// kokoelmaa yhtä aikaa, ja sen ristiintarkistukset ovat helpoin paikka
// kirjoittaa neliöllinen silmukka vahingossa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTask } from '../src/domain/task.js';
import { normalizeReminder, evaluateReminders, REMINDER_TARGET, TRIGGER }
  from '../src/domain/reminder.js';
import { normalizeTravelPlan, TRAVEL_SOURCE, computeLeaveBy }
  from '../src/domain/travel.js';
import {
  normalizeNotice, addNotice, pruneNotices, summarizeNotices
} from '../src/domain/notificationCenter.js';
import { normalizeInboxItem, compareInboxItems, summarizeInbox, openItems }
  from '../src/domain/inbox.js';
import { nowNext, collectCandidates } from '../src/domain/assistant.js';

const pad = n => String(n).padStart(2, '0');

/** mulberry32 — sama siemen, sama aineisto, joka ajolla. */
function seeded(seed) {
  return function random() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Laskeva kääre.
 *
 * Jokainen kentän luku kasvattaa laskuria. Neliöllinen silmukka lukee
 * syötettä neliöllisesti, ja se näkyy lukumäärässä riippumatta siitä,
 * kuinka nopea kone on.
 */
function counting(entity) {
  const store = { ...entity };
  const wrapped = {};
  for (const key of Object.keys(store)) {
    Object.defineProperty(wrapped, key, {
      enumerable: true,
      get() { counting.total += 1; return store[key]; }
    });
  }
  return wrapped;
}
counting.total = 0;

const TODAY = '2026-09-11';
const NOW = 540;

// =====================================================================
// AINEISTO
// =====================================================================

function reminders(count) {
  const random = seeded(1337);
  return Array.from({ length: count }, (_, i) => normalizeReminder({
    id: `r${i}`,
    title: `Muistutus ${i}`,
    trigger: TRIGGER.AT_TIME,
    dueDate: TODAY,
    dueTime: `${pad(6 + (i % 16))}:${pad((i * 7) % 60)}`,
    // Joka kolmas on kiinnitetty tehtävään: orpoustarkistus on se
    // kohta, jossa ristiin lukeminen voisi olla neliöllistä.
    targetType: i % 3 === 0 ? REMINDER_TARGET.TASK : REMINDER_TARGET.STANDALONE,
    targetId: i % 3 === 0 ? `t${i}` : null,
    escalate: random() < 0.3
  }));
}

function tasks(count) {
  const random = seeded(99);
  return Array.from({ length: count }, (_, i) => normalizeTask({
    id: `t${i}`,
    title: `Tehtävä ${i}`,
    date: random() < 0.7 ? TODAY : '2026-09-01',
    time: random() < 0.3 ? `${pad(7 + (i % 12))}:00` : null,
    durationMinutes: 30,
    completed: random() < 0.2
  }));
}

function travelPlans(count) {
  return Array.from({ length: count }, (_, i) => normalizeTravelPlan({
    id: `p${i}`,
    title: `Matka ${i}`,
    destination: `Kohde ${i}`,
    arrivalDate: TODAY,
    arrivalTime: `${pad(8 + (i % 12))}:30`,
    // Joka neljännen kesto on TUNTEMATON. Tuntematon on tavallinen
    // tila eikä poikkeus, joten sen on oltava aineistossa.
    travelMinutes: i % 4 === 0 ? null : 15 + (i % 45),
    travelSource: i % 4 === 0 ? TRAVEL_SOURCE.UNKNOWN : TRAVEL_SOURCE.MANUAL,
    preparationMinutes: 10,
    arrivalBufferMinutes: 5
  }));
}

function notices(count) {
  return Array.from({ length: count }, (_, i) => normalizeNotice({
    id: `n${i}`,
    key: `reminder|r${i}|${TODAY}|09:00`,
    kind: 'reminder',
    level: ['info', 'warning', 'urgent'][i % 3],
    status: i % 2 === 0 ? 'unread' : 'read',
    title: `Ilmoitus ${i}`,
    createdDate: TODAY
  }));
}

function inboxItems(count) {
  return Array.from({ length: count }, (_, i) => normalizeInboxItem({
    id: `i${i}`,
    text: `Kirjaus ${i}`,
    capturedAt: `2026-09-${pad(1 + (i % 11))}T08:00:00.000Z`,
    status: i % 5 === 0 ? 'converted' : 'unprocessed',
    convertedKind: i % 5 === 0 ? 'task' : null
  }));
}

/**
 * Kaksinkertaistuvan syötteen kasvukerroin.
 *
 * =====================================================================
 * KOOT OVAT KUUDENTOISTA MONIKERTOJA, JA SE ON PAKOLLISTA
 * =====================================================================
 *
 * Aineiston kellonajat kiertävät jaksossa 16 (`pad(6 + (i % 16))`).
 * Jos koot eivät ole jakson monikertoja, eräänteneiden OSUUS eroaa
 * kahden mittauksen välillä — 100 rivillä 21 % ja 200 rivillä 19,5 %.
 *
 * Osuuden muutos näkyy kertoimessa vaikka algoritmi olisi täysin
 * lineaarinen. Mitattiin siis aineiston muotoa eikä koodia, ja
 * kerroin 2,9 näytti neliöllisyydeltä joka ei sitä ollut.
 *
 * Jakson monikerroilla osuus on sama molemmissa mittauksissa, ja
 * kerroin kertoo vain siitä mitä sen kuuluu kertoa.
 */
const PIENI = 128;
const ISO = 256;

function growth(measure) {
  const pieni = measure(PIENI);
  const iso = measure(ISO);
  assert.ok(pieni > 0, 'syötettä ei luettu lainkaan — mittaus ei toimi');
  return iso / pieni;
}

/**
 * Raja 2,8 päästää läpi hieman yli lineaarisen (lajittelu on n log n)
 * mutta kaataa neliöllisen selvästi: neliöllinen olisi ~4,0.
 */
const RAJA = 2.8;

// =====================================================================
// HÄLYTYSKIERROS
// =====================================================================

test('KRIITTINEN: muistutusten arviointi ei ole neliöllinen', () => {
  // Tämä ajetaan 30 sekunnin välein. Neliöllisyys ei näkyisi
  // virhelokissa vaan puhelimen akussa.
  const kerroin = growth(count => {
    const wrapped = reminders(count).map(counting);
    counting.total = 0;
    evaluateReminders({
      reminders: wrapped,
      todayIso: TODAY,
      nowMinutes: NOW,
      deliveredKeys: new Set(),
      lookup: { task: tasks(count) }
    });
    return counting.total;
  });

  assert.ok(kerroin < RAJA,
    `muistutusten arvioinnin kasvu on ${kerroin.toFixed(1)}× — neliöllistä`);
});

test('KRIITTINEN: orpoustarkistus ei kasva kohteiden neliönä', () => {
  // `isOrphaned` etsii kohteen kokoelmasta. Jos kumpikin kasvaa,
  // naiivi toteutus olisi n².
  //
  // Tämä MITTAA KOHTEITA eikä muistutuksia: kääre on tehtävien päällä.
  const mittaa = count => {
    const wrapped = tasks(count).map(counting);
    counting.total = 0;
    evaluateReminders({
      reminders: reminders(50),
      todayIso: TODAY,
      nowMinutes: NOW,
      lookup: { task: wrapped }
    });
    return counting.total;
  };

  const kerroin = mittaa(ISO) / mittaa(PIENI);

  // HUOM. Tämä saa olla lineaarinen kohteiden suhteen, mutta se EI ole
  // vakio: muistutusten määrä on kiinnitetty, joten kasvu tulee
  // pelkästään kokoelman läpikäynnistä.
  assert.ok(kerroin < RAJA,
    `orpoustarkistuksen kasvu on ${kerroin.toFixed(1)}× — neliöllistä`);
});

test('KRIITTINEN: ilmoitusten lisääminen ei ole neliöllistä', () => {
  // `addNotice` tarkistaa avaimen olemassaolon. Jos jokainen lisäys
  // käy koko listan läpi, sadan ilmoituksen kierros on n².
  //
  // Tämä on tietoinen kompromissi: lista on rajattu sataan
  // (`MAX_NOTICES`), joten n² sadalla on 10 000 lukua — ei mitään.
  // Mittaus on silti tässä, koska raja voi joskus nousta.
  const mittaa = count => {
    counting.total = 0;
    let list = [];
    for (const notice of notices(count).map(counting)) {
      list = addNotice(list, notice);
    }
    return counting.total;
  };

  const kerroin = mittaa(ISO) / mittaa(PIENI);

  // Raja on tässä LÖYSEMPI ja se sanotaan ääneen: avaintarkistus on
  // lineaarinen lisäystä kohti, joten kokonaisuus on tarkoituksella
  // neliöllinen. Raja 4,5 kaataa vasta kuutiollisen.
  assert.ok(kerroin < 4.5,
    `ilmoitusten lisäämisen kasvu on ${kerroin.toFixed(1)}× — pahempaa `
    + 'kuin neliöllinen');
});

test('KRIITTINEN: ilmoitusten karsinta ei ole neliöllinen', () => {
  const kerroin = growth(count => {
    const wrapped = notices(count).map(counting);
    counting.total = 0;
    pruneNotices(wrapped, { todayIso: TODAY });
    return counting.total;
  });

  assert.ok(kerroin < RAJA,
    `karsinnan kasvu on ${kerroin.toFixed(1)}× — neliöllistä`);
});

test('lähtöaikojen laskenta on lineaarinen', () => {
  const kerroin = growth(count => {
    const wrapped = travelPlans(count).map(counting);
    counting.total = 0;
    for (const plan of wrapped) computeLeaveBy(plan);
    return counting.total;
  });

  assert.ok(kerroin < RAJA,
    `lähtöaikojen kasvu on ${kerroin.toFixed(1)}×`);
});

// =====================================================================
// KOMENTOKESKUS
// =====================================================================

test('KRIITTINEN: ehdokkaiden keruu ei ole neliöllinen', () => {
  // `collectCandidates` käy tehtävät läpi KOLME kertaa: kiinteät,
  // myöhässä olevat ja joustavat. Kolme lineaarista läpikäyntiä on
  // lineaarinen — mutta yksi sisäkkäinen silmukka tekisi siitä n².
  const kerroin = growth(count => {
    const wrapped = tasks(count).map(counting);
    counting.total = 0;
    collectCandidates({
      tasks: wrapped,
      reminders: reminders(20),
      travelPlans: travelPlans(10),
      inboxItems: inboxItems(10),
      todayIso: TODAY,
      nowMinutes: NOW
    });
    return counting.total;
  });

  assert.ok(kerroin < RAJA,
    `ehdokkaiden keruun kasvu on ${kerroin.toFixed(1)}× — neliöllistä`);
});

test('KRIITTINEN: nowNext ei ole neliöllinen', () => {
  const kerroin = growth(count => {
    const wrapped = tasks(count).map(counting);
    counting.total = 0;
    nowNext({
      tasks: wrapped,
      reminders: reminders(20),
      travelPlans: travelPlans(10),
      inboxItems: inboxItems(10),
      todayIso: TODAY,
      nowMinutes: NOW
    });
    return counting.total;
  });

  assert.ok(kerroin < RAJA,
    `nowNextin kasvu on ${kerroin.toFixed(1)}× — neliöllistä`);
});

test('saapuvien lajittelu ja yhteenveto eivät ole neliöllisiä', () => {
  const kerroin = growth(count => {
    const wrapped = inboxItems(count).map(counting);
    counting.total = 0;
    [...wrapped].sort(compareInboxItems);
    summarizeInbox(wrapped);
    openItems(wrapped);
    return counting.total;
  });

  assert.ok(kerroin < RAJA,
    `saapuvien käsittelyn kasvu on ${kerroin.toFixed(1)}× — neliöllistä`);
});

// =====================================================================
// MENETELMÄ EI OLE TYHJÄ
// =====================================================================

test('KRIITTINEN: mittaus havaitsee neliöllisen algoritmin', () => {
  // Ilman tätä testiä koko tiedosto voisi olla vihreä siksi, ettei
  // mittaus mittaa mitään. Tarkoituksella neliöllinen silmukka
  // tuottaa selvästi rajan ylittävän kertoimen.
  const neliollinen = count => {
    const wrapped = tasks(count).map(counting);
    counting.total = 0;
    for (const a of wrapped) {
      for (const b of wrapped) {
        if (a.id === b.id) continue;
      }
    }
    return counting.total;
  };

  const kerroin = neliollinen(ISO) / neliollinen(PIENI);

  assert.ok(kerroin > 3.5,
    `tarkoituksella neliöllinen silmukka antoi vain ${kerroin.toFixed(1)}× — `
    + 'mittaus ei havaitse neliöllisyyttä');
});

test('KRIITTINEN: laskuri lukee syötettä oikeasti', () => {
  // Toinen puoli samasta: jos kääre ei laskisi mitään, jokainen
  // kerroin olisi NaN eikä yksikään vertailu kaatuisi.
  const wrapped = reminders(10).map(counting);
  counting.total = 0;
  evaluateReminders({
    reminders: wrapped, todayIso: TODAY, nowMinutes: NOW
  });

  assert.ok(counting.total > 10,
    `laskuri näki vain ${counting.total} lukua kymmenestä muistutuksesta`);
});

// =====================================================================
// REALISTINEN KUORMA TOIMII
// =====================================================================

test('vuoden ilmoitushistoria karsiutuu enimmäismäärään', () => {
  // Yksi ilmoitus päivässä vuoden ajan. Karsinnan jälkeen listassa on
  // enintään MAX_NOTICES, ja lukemattomat ovat säilyneet pidempään.
  const vuosi = Array.from({ length: 365 }, (_, i) => normalizeNotice({
    id: `n${i}`,
    key: `k${i}`,
    kind: 'reminder',
    status: i % 10 === 0 ? 'unread' : 'read',
    title: `Ilmoitus ${i}`,
    createdDate: new Date(Date.UTC(2026, 0, 1) + i * 86400000)
      .toISOString().slice(0, 10)
  }));

  const kept = pruneNotices(vuosi, { todayIso: '2026-12-31' });

  assert.ok(kept.length <= 100, `karsinnan jälkeen ${kept.length} riviä`);
  assert.ok(kept.length > 0, 'karsinta tyhjensi koko listan');

  // Ja yhteenveto toimii karsitulla listalla.
  const summary = summarizeNotices(kept);
  assert.equal(summary.total, kept.length);
});

test('tuhannen muistutuksen kierros tuottaa rajatun määrän hälytyksiä', () => {
  // Hälytysraja on muistutuskohtainen, joten tuhat muistutusta voi
  // tuottaa tuhat hälytystä. Se on oikein — mutta jokaisen on oltava
  // eri muistutuksesta, eikä yksikään saa toistua.
  const iso = reminders(1000);
  const { alerts } = evaluateReminders({
    reminders: iso, todayIso: TODAY, nowMinutes: 1439
  });

  const avaimet = new Set(alerts.map(a => a.key));
  assert.equal(avaimet.size, alerts.length,
    'sama avain esiintyi kahdesti samalla kierroksella');

  const lahteet = new Set(alerts.map(a => a.reminderId));
  assert.equal(lahteet.size, alerts.length,
    'sama muistutus tuotti kaksi hälytystä samalla kierroksella');
});

test('sadan matkan lähtöajat lasketaan ilman poikkeuksia', () => {
  // Joka neljännen kesto on tuntematon. Yksikään niistä ei saa
  // tuottaa lähtöaikaa eikä kaataa laskentaa.
  const plans = travelPlans(100);

  let tuntemattomia = 0;
  for (const plan of plans) {
    const result = computeLeaveBy(plan);
    if (!result.known) {
      tuntemattomia += 1;
      assert.equal(result.leaveByTime, null);
    } else {
      assert.ok(result.leaveByTime, 'tunnettu kesto ei tuottanut lähtöaikaa');
    }
  }

  assert.equal(tuntemattomia, 25, `tuntemattomia oli ${tuntemattomia}, odotettiin 25`);
});
