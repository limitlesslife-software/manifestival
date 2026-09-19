// Komentokeskus: NYT, SEURAAVA ja PIAN.
//
// =====================================================================
// KOLME ASIAA, JOITA TÄMÄ TIEDOSTO VARTIOI YLI MUIDEN
// =====================================================================
//
// 1. TYHJÄ ON KELVOLLINEN VASTAUS. Jos mitään ei ole käsillä, `now` on
//    `null` — ei ensimmäinen mahdollinen tehtävä. Keksitty "nyt"
//    opettaisi käyttäjän epäilemään kaikkia vastauksia.
//
// 2. LÄHTÖAIKA ON ENSIMMÄINEN. Se on ainoa asia, jonka myöhästyminen
//    ei ole korjattavissa myöhemmin samana päivänä: bussi lähtee
//    ilman käyttäjää.
//
// 3. JÄRJESTYS ON SELITETTÄVISSÄ SAMOISTA LUVUISTA, joilla se tehtiin.
//    `explainRanking` lukee pisteytyksen osat — se ei kirjoita
//    perustelua erikseen, koska erikseen kirjoitettu perustelu
//    ajautuisi ennen pitkää erilleen todellisesta järjestyksestä.
//
// `collectCandidates` on PUHDAS: ei kelloa, ei satunnaisuutta, ei
// verkkoa. Jokainen testi antaa hetken itse.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANDIDATE_KIND, CANDIDATE_KINDS, UPCOMING_HORIZON_MINUTES, MAX_UPCOMING,
  NOW_WINDOW_MINUTES, compareCandidates, collectCandidates, nowNext,
  isAtHand, explainRanking, morningPlan, eveningSummary
} from '../src/domain/assistant.js';

import { normalizeTask } from '../src/domain/task.js';
import { normalizeReminder, REMINDER_STATUS } from '../src/domain/reminder.js';
import { normalizeTravelPlan, TRAVEL_SOURCE } from '../src/domain/travel.js';
import { normalizeInboxItem } from '../src/domain/inbox.js';

const TODAY = '2026-09-11';

function task(overrides = {}) {
  return normalizeTask({ id: 't1', title: 'Tehtävä', date: TODAY, ...overrides });
}

function reminder(overrides = {}) {
  return normalizeReminder({
    id: 'r1', title: 'Muistutus', dueDate: TODAY, dueTime: '09:00', ...overrides
  });
}

function travel(overrides = {}) {
  return normalizeTravelPlan({
    id: 'p1', title: 'Hammaslääkäri', destination: 'Keskusta',
    arrivalDate: TODAY, arrivalTime: '10:00',
    travelMinutes: 25, travelSource: TRAVEL_SOURCE.MANUAL,
    preparationMinutes: 10, arrivalBufferMinutes: 5,
    ...overrides
  });
}

// =====================================================================
// TYHJÄ
// =====================================================================

test('KRIITTINEN: tyhjä päivä vastaa tyhjää eikä keksi mitään', () => {
  const result = nowNext({ todayIso: TODAY, nowMinutes: 540 });

  assert.equal(result.empty, true);
  assert.equal(result.now, null);
  assert.equal(result.next, null);
  assert.deepEqual(result.upcoming, []);
  assert.ok(result.reason.length > 0);
});

test('kelvoton päivä ei tuota ehdokkaita', () => {
  assert.deepEqual(collectCandidates({ todayIso: 'eilen', nowMinutes: 540 }), []);
  assert.deepEqual(collectCandidates({ nowMinutes: 540 }), []);
});

test('valmis tehtävä ei ole ehdokas', () => {
  const candidates = collectCandidates({
    tasks: [task({ completed: true })], todayIso: TODAY, nowMinutes: 540
  });
  assert.equal(candidates.length, 0);
});

// =====================================================================
// JÄRJESTYS
// =====================================================================

test('KRIITTINEN: lähtöaika ohittaa kaiken muun', () => {
  const candidates = collectCandidates({
    tasks: [task({ id: 'a', title: 'Kokous', time: '09:10', durationMinutes: 60 })],
    reminders: [reminder()],
    travelPlans: [travel()],
    todayIso: TODAY,
    nowMinutes: 545
  });

  assert.ok(candidates.length >= 3);
  assert.equal(candidates[0].kind, CANDIDATE_KIND.DEPARTURE);
});

test('KRIITTINEN: saapuvat ovat aina viimeisenä', () => {
  const candidates = collectCandidates({
    tasks: [task({ id: 'a', title: 'Joustava' })],
    inboxItems: [normalizeInboxItem({ id: 'i1', text: 'Muista maito' })],
    todayIso: TODAY,
    nowMinutes: 540
  });

  assert.equal(candidates[candidates.length - 1].kind, CANDIDATE_KIND.INBOX);
});

test('aika painaa lajin sisällä eikä sen yli', () => {
  // Myöhässä oleva tehtävä ei ohita alkavaa kokousta, vaikka se olisi
  // myöhässä viikon.
  const candidates = collectCandidates({
    tasks: [
      task({ id: 'a', title: 'Kokous', time: '09:10', durationMinutes: 60 }),
      task({ id: 'b', title: 'Vanha', date: '2026-09-01' })
    ],
    todayIso: TODAY,
    nowMinutes: 540
  });

  assert.equal(candidates[0].kind, CANDIDATE_KIND.FIXED);
  assert.equal(candidates[1].kind, CANDIDATE_KIND.OVERDUE);
});

test('vanhin myöhässä oleva on ensimmäisenä myöhässä olevista', () => {
  const candidates = collectCandidates({
    tasks: [
      task({ id: 'uusi', title: 'Eilinen', date: '2026-09-10' }),
      task({ id: 'vanha', title: 'Viime kuun', date: '2026-08-01' })
    ],
    todayIso: TODAY,
    nowMinutes: 540
  });

  assert.deepEqual(candidates.map(c => c.id), ['vanha', 'uusi']);
});

test('järjestys on deterministinen myös tasatilanteessa', () => {
  const input = {
    tasks: [
      task({ id: 'b', title: 'Beeta' }),
      task({ id: 'a', title: 'Alfa' })
    ],
    todayIso: TODAY,
    nowMinutes: 540
  };

  const eka = collectCandidates(input).map(c => c.id);
  const toka = collectCandidates(input).map(c => c.id);
  assert.deepEqual(eka, toka);
  assert.deepEqual(eka, ['a', 'b'], 'tasatilanne ei ratkennut nimellä');
});

test('vertailu on järjestyksen ainoa sääntö', () => {
  const [a, b] = collectCandidates({
    tasks: [task({ id: 'a', title: 'Kokous', time: '09:10', durationMinutes: 30 })],
    inboxItems: [normalizeInboxItem({ id: 'i1', text: 'x' })],
    todayIso: TODAY, nowMinutes: 540
  });

  assert.ok(compareCandidates(a, b) < 0);
  assert.ok(compareCandidates(b, a) > 0);
  assert.equal(compareCandidates(a, a), 0);
});

// =====================================================================
// KÄSILLÄ OLEMINEN
// =====================================================================

test('KRIITTINEN: kolmen tunnin päässä oleva kokous ei ole "nyt"', () => {
  // Jos se olisi, sana "nyt" menettäisi merkityksensä.
  const result = nowNext({
    tasks: [task({ title: 'Kokous', time: '12:00', durationMinutes: 60 })],
    todayIso: TODAY,
    nowMinutes: 540
  });

  assert.equal(result.now, null);
  assert.ok(result.next);
  assert.equal(result.next.title, 'Kokous');
});

test('kokous puolen tunnin sisällä on käsillä', () => {
  const result = nowNext({
    tasks: [task({ title: 'Kokous', time: '09:30', durationMinutes: 60 })],
    todayIso: TODAY,
    nowMinutes: 540
  });

  assert.ok(result.now);
  assert.equal(result.now.title, 'Kokous');
});

test('käynnissä oleva kokous on käsillä ja merkitty käynnissä olevaksi', () => {
  const result = nowNext({
    tasks: [task({ title: 'Kokous', time: '09:00', durationMinutes: 60 })],
    todayIso: TODAY,
    nowMinutes: 570
  });

  assert.ok(result.now);
  assert.equal(result.now.running, true);
  assert.ok(/käynnissä/i.test(result.now.reason));
});

test('päättynyt sitoumus ei ole enää ehdokas', () => {
  const candidates = collectCandidates({
    tasks: [task({ title: 'Kokous', time: '08:00', durationMinutes: 30 })],
    todayIso: TODAY,
    nowMinutes: 540
  });
  assert.equal(candidates.length, 0);
});

test('ajaton työ on aina käsillä', () => {
  const result = nowNext({
    tasks: [task({ title: 'Joustava' })], todayIso: TODAY, nowMinutes: 540
  });
  assert.ok(result.now);
  assert.equal(result.now.kind, CANDIDATE_KIND.FLEXIBLE);
});

test('saapuvat eivät koskaan ole "nyt"', () => {
  const result = nowNext({
    inboxItems: [normalizeInboxItem({ id: 'i1', text: 'x' })],
    todayIso: TODAY, nowMinutes: 540
  });

  assert.equal(result.now, null);
  assert.equal(result.next.kind, CANDIDATE_KIND.INBOX);
});

test('isAtHand kestää tyhjän syötteen', () => {
  assert.equal(isAtHand(null, 540), false);
  assert.equal(isAtHand(undefined, 540), false);
});

test('käsilläolon ikkuna on puoli tuntia', () => {
  assert.equal(NOW_WINDOW_MINUTES, 30);
});

// =====================================================================
// PIAN
// =====================================================================

test('pian-lista rajataan horisonttiin', () => {
  const tasks = [];
  // Yksi joka tunti klo 9-20. Kaikki eivät mahdu neljän tunnin sisään.
  for (let h = 9; h <= 20; h += 1) {
    tasks.push(task({
      id: `t${h}`, title: `Kokous ${h}`,
      time: `${String(h).padStart(2, '0')}:00`, durationMinutes: 30
    }));
  }

  const result = nowNext({ tasks, todayIso: TODAY, nowMinutes: 540 });

  for (const entry of result.upcoming) {
    if (entry.minutes === null) continue;
    assert.ok(entry.minutes - 540 <= UPCOMING_HORIZON_MINUTES,
      `${entry.title} on horisontin ulkopuolella`);
  }
});

test('pian-lista on rajattu myös määrältään', () => {
  const tasks = [];
  for (let n = 0; n < 20; n += 1) {
    tasks.push(task({ id: `t${n}`, title: `Joustava ${n}` }));
  }
  const result = nowNext({ tasks, todayIso: TODAY, nowMinutes: 540 });
  assert.ok(result.upcoming.length <= MAX_UPCOMING);
});

test('nyt ja seuraava eivät ole sama rivi', () => {
  const result = nowNext({
    tasks: [
      task({ id: 'a', title: 'Joustava A' }),
      task({ id: 'b', title: 'Joustava B' })
    ],
    todayIso: TODAY, nowMinutes: 540
  });

  assert.ok(result.now);
  assert.ok(result.next);
  assert.notEqual(result.now.id, result.next.id);
  assert.equal(result.upcoming.some(e => e.id === result.next.id), false);
});

// =====================================================================
// MUISTUTUKSET JA LÄHTÖAIKA EHDOKKAINA
// =====================================================================

test('vain elävä muistutus on ehdokas', () => {
  const elava = collectCandidates({
    reminders: [reminder()], todayIso: TODAY, nowMinutes: 540
  });
  assert.equal(elava.length, 1);

  const peruttu = collectCandidates({
    reminders: [reminder({ status: REMINDER_STATUS.CANCELLED })],
    todayIso: TODAY, nowMinutes: 540
  });
  assert.equal(peruttu.length, 0);
});

test('erääntymätön muistutus ei ole ehdokas', () => {
  const candidates = collectCandidates({
    reminders: [reminder({ dueTime: '18:00' })], todayIso: TODAY, nowMinutes: 540
  });
  assert.equal(candidates.length, 0);
});

test('eilisen kuittaamaton muistutus sanoo päivänsä', () => {
  const [entry] = collectCandidates({
    reminders: [reminder({ dueDate: '2026-09-10' })],
    todayIso: TODAY, nowMinutes: 540
  });
  assert.ok(entry.reason.includes('2026-09-10'));
});

test('KRIITTINEN: tuntemattomasta matka-ajasta ei synny lähtöehdokasta', () => {
  const candidates = collectCandidates({
    travelPlans: [travel({ travelMinutes: null })],
    todayIso: TODAY, nowMinutes: 545
  });
  assert.equal(candidates.length, 0);
});

test('toisen päivän matka ei ole tämän päivän ehdokas', () => {
  const candidates = collectCandidates({
    travelPlans: [travel({ arrivalDate: '2026-09-12' })],
    todayIso: TODAY, nowMinutes: 545
  });
  assert.equal(candidates.length, 0);
});

test('myöhässä oleva lähtö sanotaan menneeksi', () => {
  const [entry] = collectCandidates({
    travelPlans: [travel()], todayIso: TODAY, nowMinutes: 600
  });
  assert.equal(entry.late, true);
  // Lähtömoottori (departureState) kertoo myöhästymisen minuutteina ja ajan.
  assert.ok(/myöhässä.*oli klo 09:30/i.test(entry.reason), entry.reason);
});

// =====================================================================
// SELITYS
// =====================================================================

test('KRIITTINEN: jokainen ehdokaslaji on selitettävissä', () => {
  for (const kind of CANDIDATE_KINDS) {
    const text = explainRanking({ kind, minutes: null, score: {} }, 540);
    assert.ok(text.length > 3, `lajille ${kind} ei tullut selitystä`);
    assert.notEqual(text, '.', `lajin ${kind} selitys on tyhjä`);
  }
});

test('selitys kertoo ajan suhteessa nykyhetkeen', () => {
  const base = { kind: CANDIDATE_KIND.FIXED, score: {} };

  assert.ok(explainRanking({ ...base, minutes: 600 }, 540).includes('60 min kuluttua'));
  assert.ok(explainRanking({ ...base, minutes: 480 }, 540).includes('60 min sitten'));
  assert.ok(explainRanking({ ...base, minutes: 540 }, 540).includes('juuri nyt'));
});

test('selitys tyhjästä on tyhjä eikä kaadu', () => {
  assert.equal(explainRanking(null, 540), '');
});

test('jokainen ehdokas kantaa perustelun', () => {
  const candidates = collectCandidates({
    tasks: [
      task({ id: 'a', title: 'Kokous', time: '09:10', durationMinutes: 30 }),
      task({ id: 'b', title: 'Joustava' }),
      task({ id: 'c', title: 'Vanha', date: '2026-09-01' })
    ],
    reminders: [reminder()],
    travelPlans: [travel()],
    inboxItems: [normalizeInboxItem({ id: 'i1', text: 'x' })],
    todayIso: TODAY,
    nowMinutes: 545
  });

  assert.ok(candidates.length >= 6);
  for (const entry of candidates) {
    assert.ok(entry.reason && entry.reason.length > 5,
      `ehdokkaalta ${entry.id} puuttuu perustelu`);
  }
});

test('jokainen ehdokas on jäädytetty', () => {
  const candidates = collectCandidates({
    tasks: [task()], todayIso: TODAY, nowMinutes: 540
  });
  for (const entry of candidates) {
    assert.equal(Object.isFrozen(entry), true);
  }
});

// =====================================================================
// AAMUN SUUNNITELMA
// =====================================================================

test('KRIITTINEN: aamun suunnitelma ei täytä aukkoja', () => {
  // Se kertoo mitä päivässä on ja paljonko tilaa jää. Automaattisesti
  // täytetty päivä on suunnitelma, jota kukaan ei valinnut.
  const plan = morningPlan({
    tasks: [task({ id: 'a', title: 'Joustava' })],
    capacity: { usableMinutes: 480 },
    todayIso: TODAY
  });

  assert.ok(plan);
  assert.equal(plan.flexible.length, 1);
  // Tuloksessa ei ole yhtäkään kenttää, joka ehdottaisi aikaa.
  assert.equal('proposals' in plan, false);
  assert.equal('schedule' in plan, false);
  assert.equal('assignedTimes' in plan, false);
});

test('ylibuukattu päivä sanotaan suoraan', () => {
  const plan = morningPlan({
    tasks: [
      task({ id: 'a', title: 'Iso', durationMinutes: 300 }),
      task({ id: 'b', title: 'Toinen iso', durationMinutes: 300 })
    ],
    capacity: { usableMinutes: 480 },
    todayIso: TODAY
  });

  assert.equal(plan.overbooked, true);
  assert.ok(plan.freeMinutes < 0, 'vapaa aika ei ole negatiivinen');
});

test('ilman kapasiteettia vapaa aika on tuntematon eikä nolla', () => {
  const plan = morningPlan({ tasks: [task()], todayIso: TODAY });
  assert.equal(plan.usableMinutes, null);
  assert.equal(plan.freeMinutes, null);
  assert.equal(plan.overbooked, false);
});

test('kiinteät järjestetään kellonajan mukaan', () => {
  const plan = morningPlan({
    tasks: [
      task({ id: 'b', title: 'Myöhempi', time: '14:00' }),
      task({ id: 'a', title: 'Aiempi', time: '09:00' })
    ],
    todayIso: TODAY
  });
  assert.deepEqual(plan.fixed.map(t => t.id), ['a', 'b']);
});

test('myöhässä olevat lasketaan mutta eivät ole päivän työtä', () => {
  const plan = morningPlan({
    tasks: [task({ id: 'a', title: 'Vanha', date: '2026-09-01' })],
    todayIso: TODAY
  });
  assert.equal(plan.overdueCount, 1);
  assert.equal(plan.flexible.length, 0);
  assert.equal(plan.fixed.length, 0);
});

test('kelvoton päivä ei tuota suunnitelmaa', () => {
  assert.equal(morningPlan({ todayIso: 'eilen' }), null);
});

// =====================================================================
// ILLAN KATSAUS
// =====================================================================

test('KRIITTINEN: illan katsaus ei merkitse mitään tehdyksi', () => {
  const tasks = [
    task({ id: 'a', title: 'Tekemätön' }),
    task({ id: 'b', title: 'Tehty', completed: true })
  ];

  const summary = eveningSummary({ tasks, todayIso: TODAY });

  assert.equal(summary.completedCount, 1);
  assert.equal(summary.unfinishedCount, 1);
  // Alkuperäiset rivit eivät muuttuneet.
  assert.equal(tasks[0].completed, false);
  assert.equal(tasks[1].completed, true);
});

test('siirtoehdotus on ehdotus eikä toimenpide', () => {
  const summary = eveningSummary({
    tasks: [
      task({ id: 'a', title: 'Ajaton' }),
      task({ id: 'b', title: 'Ajastettu', time: '09:00' })
    ],
    todayIso: TODAY
  });

  // Vain ajaton työ ehdotetaan siirrettäväksi: ajastettu oli
  // käyttäjän oma päätös, ja sen siirtäminen on eri asia.
  assert.deepEqual(summary.suggestedCarryOver.map(t => t.id), ['a']);
});

test('tyhjä päivä ei tuota valmistumisprosenttia', () => {
  // Nolla prosenttia tyhjästä päivästä olisi syytös.
  const summary = eveningSummary({ tasks: [], todayIso: TODAY });
  assert.equal(summary.completionRate, null);
});

test('valmistumisprosentti lasketaan päivän tehtävistä', () => {
  const summary = eveningSummary({
    tasks: [
      task({ id: 'a', completed: true }),
      task({ id: 'b', completed: true }),
      task({ id: 'c' }),
      task({ id: 'd' })
    ],
    todayIso: TODAY
  });
  assert.equal(summary.completionRate, 50);
});

test('kuittaamattomat muistutukset lasketaan', () => {
  const summary = eveningSummary({
    reminders: [reminder(), reminder({ id: 'r2', status: REMINDER_STATUS.CANCELLED })],
    todayIso: TODAY
  });
  assert.equal(summary.unacknowledgedCount, 1);
});

test('kelvoton päivä ei tuota katsausta', () => {
  assert.equal(eveningSummary({ todayIso: 'eilen' }), null);
});
