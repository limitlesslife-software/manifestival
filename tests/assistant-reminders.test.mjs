// Muistutukset — tilakone, porrastus ja kaksoiskappaleiden esto.
//
// =====================================================================
// KOLME ASIAA, JOITA TÄMÄ TIEDOSTO VARTIOI YLI MUIDEN
// =====================================================================
//
// 1. TORKKU SIIRTÄÄ MUISTUTUSTA, EI MÄÄRÄPÄIVÄÄ. `snooze()` ei näe
//    kohdetta, joten se ei voi siirtää sitä. Tämä on rakenteellinen
//    tae, ja testi todistaa sen kutsumalla funktiota kohteen kanssa,
//    jota se ei saa muuttaa.
//
// 2. SAMA HÄLYTYS EI TULE KAHDESTI. `occurrenceKey` on deterministinen:
//    sama muistutus, sama porras, sama minuutti tuottaa saman avaimen.
//    Taustatarkistus voidaan ajaa niin usein kuin halutaan.
//
// 3. HÄLYTYSTEN MÄÄRÄ ON RAJATTU. Loputon toisto on helppo kirjoittaa
//    vahingossa: yksi ehto väärin päin ja käyttäjän puhelin soi
//    minuutin välein.
//
// `evaluateReminders` on PUHDAS: se ei lue kelloa. Jokainen testi
// antaa hetken itse, eikä yksikään käytä `Date.now()`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REMINDER_STATUS, REMINDER_STATUSES, LIVE_STATUSES, REMINDER_TARGET,
  TRIGGER, ESCALATION, ESCALATIONS, DEFAULT_ESCALATION_LEAD,
  MAX_ALERTS_PER_REMINDER, SNOOZE_OPTIONS, MAX_SNOOZE_MINUTES, MAX_SNOOZE_COUNT,
  normalizeReminder, validateReminder, dueMinutes, resolveTriggerTime,
  isDue, isExpired, isOrphaned, canTransition, transition, markDelivered,
  acknowledge, snooze, markCompleted, cancel, expire, occurrenceKey,
  escalationFor, evaluateReminders, explainAlert, reminderForTask,
  remindersForTarget, liveReminders, compareReminders, summarizeReminders,
  reminderStatusLabel
} from '../src/domain/reminder.js';

/** Kelvollinen muistutus, jonka päälle testit rakentavat. */
function reminder(overrides = {}) {
  return normalizeReminder({
    id: 'r1',
    title: 'Soita hammaslääkärille',
    trigger: TRIGGER.AT_TIME,
    dueDate: '2026-09-11',
    dueTime: '09:00',
    ...overrides
  });
}

const TODAY = '2026-09-11';

// =====================================================================
// NORMALISOINTI
// =====================================================================

test('tuntematon tila putoaa ajastetuksi', () => {
  assert.equal(normalizeReminder({ status: 'kissa' }).status,
    REMINDER_STATUS.SCHEDULED);
});

test('tuntematon kohdelaji putoaa vapaaksi', () => {
  assert.equal(normalizeReminder({ targetType: 'kissa' }).targetType,
    REMINDER_TARGET.STANDALONE);
});

test('KRIITTINEN: puuttuva etuaika on null eikä nolla', () => {
  // `Number(null)` on nolla, ja nollan etuaika tarkoittaisi "muistuta
  // täsmälleen silloin kun asia alkaa" — eri asia kuin "etuaikaa ei
  // ole asetettu".
  for (const value of [null, undefined, '']) {
    assert.equal(normalizeReminder({ leadMinutes: value }).leadMinutes, null,
      `arvo ${JSON.stringify(value)} muuttui nollaksi`);
  }
  assert.equal(normalizeReminder({ leadMinutes: 0 }).leadMinutes, 0);
});

test('negatiivinen etuaika hylätään', () => {
  assert.equal(normalizeReminder({ leadMinutes: -30 }).leadMinutes, null);
});

test('etuaika katkaistaan viikkoon', () => {
  assert.equal(normalizeReminder({ leadMinutes: 999999 }).leadMinutes, 10080);
});

test('hälytyslaskuri ei voi ylittää rajaa normalisoinnissakaan', () => {
  assert.equal(normalizeReminder({ alertCount: 99 }).alertCount,
    MAX_ALERTS_PER_REMINDER);
});

test('kelvoton päivä tai aika putoaa nulliksi', () => {
  const r = normalizeReminder({ dueDate: '11.9.2026', dueTime: '25:00' });
  assert.equal(r.dueDate, null);
  assert.equal(r.dueTime, null);
});

test('escalate on tosi vain nimenomaisesta true-arvosta', () => {
  assert.equal(normalizeReminder({ escalate: 'kyllä' }).escalate, false);
  assert.equal(normalizeReminder({ escalate: 1 }).escalate, false);
  assert.equal(normalizeReminder({ escalate: true }).escalate, true);
});

// =====================================================================
// VALIDOINTI
// =====================================================================

test('nimetön muistutus ei kelpaa', () => {
  const { valid, errors } = validateReminder(reminder({ title: '  ' }));
  assert.equal(valid, false);
  assert.ok(errors.title);
});

test('kohdelaji ilman tunnistetta ei kelpaa', () => {
  const { valid, errors } = validateReminder(reminder({
    targetType: REMINDER_TARGET.TASK, targetId: null
  }));
  assert.equal(valid, false);
  assert.ok(errors.targetId);
});

test('vapaa muistutus tunnisteen kanssa ei kelpaa', () => {
  const { valid, errors } = validateReminder(reminder({
    targetType: REMINDER_TARGET.STANDALONE, targetId: 't1'
  }));
  assert.equal(valid, false);
  assert.ok(errors.targetId);
});

test('kellonaikalaukaisin vaatii päivän ja ajan', () => {
  const { valid, errors } = validateReminder(reminder({
    dueDate: null, dueTime: null
  }));
  assert.equal(valid, false);
  assert.ok(errors.dueDate);
  assert.ok(errors.dueTime);
});

test('ennen kohdetta -laukaisin vaatii etuajan', () => {
  const { valid, errors } = validateReminder(reminder({
    trigger: TRIGGER.BEFORE_TARGET, leadMinutes: null
  }));
  assert.equal(valid, false);
  assert.ok(errors.leadMinutes);
});

test('nollan etuaika kelpaa: se tarkoittaa täsmälleen silloin', () => {
  assert.equal(validateReminder(reminder({
    trigger: TRIGGER.BEFORE_TARGET, leadMinutes: 0
  })).valid, true);
});

// =====================================================================
// AIKALASKENTA
// =====================================================================

test('hetki lasketaan ajasta, ja puuttuva aika on null eikä keskiyö', () => {
  assert.equal(dueMinutes(reminder({ dueTime: '09:30' })), 570);
  assert.equal(dueMinutes(reminder({ dueTime: null })), null);
});

test('kohteesta laskettu hetki on kohteen alku miinus etuaika', () => {
  const resolved = resolveTriggerTime(
    normalizeReminder({ trigger: TRIGGER.BEFORE_TARGET, leadMinutes: 30 }),
    { date: '2026-09-11', time: '09:00' });

  assert.equal(resolved.dateIso, '2026-09-11');
  assert.equal(resolved.time, '08:30');
});

test('KRIITTINEN: yli keskiyön menevä etuaika siirtää päivää taaksepäin', () => {
  // Kokous klo 08:00 ja yhdeksän tunnin etuaika on EDELLISEN päivän
  // klo 23:00 — ei saman päivän negatiivinen kellonaika.
  const resolved = resolveTriggerTime(
    normalizeReminder({ trigger: TRIGGER.BEFORE_TARGET, leadMinutes: 9 * 60 }),
    { date: '2026-09-11', time: '08:00' });

  assert.equal(resolved.dateIso, '2026-09-10');
  assert.equal(resolved.time, '23:00');
});

test('ilman kohdetta suhteellista hetkeä ei voi laskea', () => {
  assert.equal(resolveTriggerTime(
    normalizeReminder({ trigger: TRIGGER.BEFORE_TARGET, leadMinutes: 30 }),
    null), null);
});

test('myöhässä olevasta muistutetaan seuraavana aamuna', () => {
  const resolved = resolveTriggerTime(
    normalizeReminder({ trigger: TRIGGER.WHEN_OVERDUE }),
    { date: '2026-09-11' });

  assert.equal(resolved.dateIso, '2026-09-12');
  assert.equal(resolved.time, '09:00');
});

test('lähtöaikalaukaisinta ei lasketa täällä', () => {
  // LEAVE_BY tarvitsee matka-arvion, eikä muistutusmoduulilla ole sitä.
  assert.equal(resolveTriggerTime(
    normalizeReminder({ trigger: TRIGGER.LEAVE_BY }),
    { date: '2026-09-11', time: '09:00' }), null);
});

test('erääntyminen vertaa päivää ja minuutteja, ei aikaleimaa', () => {
  const r = reminder();
  assert.equal(isDue(r, { todayIso: TODAY, nowMinutes: 540 }), true);
  assert.equal(isDue(r, { todayIso: TODAY, nowMinutes: 539 }), false);
  // Eilinen muistutus on erääntynyt tänään.
  assert.equal(isDue(r, { todayIso: '2026-09-12', nowMinutes: 0 }), true);
});

test('kelvoton päivä ei eräännytä mitään', () => {
  assert.equal(isDue(reminder(), { todayIso: 'eilen', nowMinutes: 540 }), false);
});

test('takaraja vanhentaa muistutuksen', () => {
  const r = reminder({ untilTime: '17:00' });
  assert.equal(isExpired(r, { todayIso: TODAY, nowMinutes: 1020 }), false);
  assert.equal(isExpired(r, { todayIso: TODAY, nowMinutes: 1021 }), true);
});

// =====================================================================
// ORPOUS
// =====================================================================

test('KRIITTINEN: poistettu kohde tekee muistutuksesta orvon', () => {
  const r = reminder({ targetType: REMINDER_TARGET.TASK, targetId: 't1' });

  assert.equal(isOrphaned(r, { task: [{ id: 't1' }] }), false);
  assert.equal(isOrphaned(r, { task: [] }), true);
});

test('vapaa muistutus ei voi olla orpo', () => {
  assert.equal(isOrphaned(reminder(), { task: [] }), false);
});

test('puuttuva kokoelma ei tee orvoksi', () => {
  // Kokoelmaa ei ole ladattu — se on eri asia kuin että kohde on
  // poistettu. Väärä orpous peruisi muistutuksen turhaan.
  const r = reminder({ targetType: REMINDER_TARGET.TASK, targetId: 't1' });
  assert.equal(isOrphaned(r, {}), false);
});

// =====================================================================
// TILASIIRTYMÄT
// =====================================================================

test('päätetiloista ei pääse mihinkään', () => {
  for (const from of [REMINDER_STATUS.COMPLETED, REMINDER_STATUS.EXPIRED,
    REMINDER_STATUS.CANCELLED]) {
    for (const to of REMINDER_STATUSES) {
      assert.equal(canTransition(from, to), false,
        `tilasta ${from} pääsi tilaan ${to}`);
    }
  }
});

test('elävät tilat eivät sisällä päätetiloja', () => {
  for (const status of [REMINDER_STATUS.COMPLETED, REMINDER_STATUS.EXPIRED,
    REMINDER_STATUS.CANCELLED]) {
    assert.equal(LIVE_STATUSES.includes(status), false);
  }
});

test('toimitus kasvattaa hälytyslaskuria mutta ei rajan yli', () => {
  // Ajastetusta EI pääse suoraan toimitettuun: väli on `due`, ja se on
  // se hetki jossa muistutus on erääntynyt mutta ei vielä näytetty.
  assert.equal(markDelivered(reminder({ status: REMINDER_STATUS.SCHEDULED })), null);

  const delivered = markDelivered(reminder({
    status: REMINDER_STATUS.DUE, alertCount: 2
  }));
  assert.equal(delivered.alertCount, 3);

  const täysi = markDelivered(reminder({
    status: REMINDER_STATUS.DUE, alertCount: MAX_ALERTS_PER_REMINDER
  }));
  assert.equal(täysi.alertCount, MAX_ALERTS_PER_REMINDER);
});

test('kuittaus ei ole sama kuin tehty', () => {
  const acked = acknowledge(reminder({ status: REMINDER_STATUS.DELIVERED }));
  assert.equal(acked.status, REMINDER_STATUS.ACKNOWLEDGED);
  assert.notEqual(acked.status, REMINDER_STATUS.COMPLETED);
});

test('peruttu ja vanhentunut ovat päätetiloja', () => {
  assert.equal(cancel(reminder()).status, REMINDER_STATUS.CANCELLED);
  assert.equal(expire(reminder()).status, REMINDER_STATUS.EXPIRED);
  assert.equal(markCompleted(cancel(reminder())), null);
});

// =====================================================================
// TORKKU
// =====================================================================

test('KRIITTINEN: torkku ei voi koskea kohteeseen', () => {
  // `snooze` ei ota kohdetta vastaan eikä palauta sitä. Tämä testi
  // todistaa sen sitä kautta, mitä funktio palauttaa: pelkän
  // muistutuksen, jonka kentät ovat muistutuksen kenttiä.
  const r = reminder({
    status: REMINDER_STATUS.DUE,
    targetType: REMINDER_TARGET.TASK,
    targetId: 't1'
  });

  const snoozed = snooze(r, 15, { todayIso: TODAY, nowMinutes: 540 });

  assert.equal(snoozed.targetId, 't1', 'kohde vaihtui');
  assert.equal(snoozed.targetType, REMINDER_TARGET.TASK);
  assert.deepEqual(Object.keys(snoozed).sort(), Object.keys(r).sort(),
    'torkku tuotti kenttiä, joita muistutuksella ei ole');
});

test('torkku siirtää muistutuksen hetkeä', () => {
  const snoozed = snooze(reminder({ status: REMINDER_STATUS.DUE }), 15,
    { todayIso: TODAY, nowMinutes: 540 });

  assert.equal(snoozed.dueTime, '09:15');
  assert.equal(snoozed.dueDate, TODAY);
  assert.equal(snoozed.status, REMINDER_STATUS.SNOOZED);
  assert.equal(snoozed.snoozeCount, 1);
});

test('torkku yli keskiyön siirtää päivää eteenpäin', () => {
  const snoozed = snooze(reminder({
    status: REMINDER_STATUS.DUE, dueTime: '23:50'
  }), 30, { todayIso: TODAY, nowMinutes: 1430 });

  assert.equal(snoozed.dueTime, '00:20');
  assert.equal(snoozed.dueDate, '2026-09-12');
});

test('torkkujen määrä on rajattu', () => {
  assert.equal(snooze(reminder({
    status: REMINDER_STATUS.DUE, snoozeCount: MAX_SNOOZE_COUNT
  }), 15, { todayIso: TODAY, nowMinutes: 540 }), null);
});

test('kelvoton torkkuaika hylätään', () => {
  const r = reminder({ status: REMINDER_STATUS.DUE });
  const now = { todayIso: TODAY, nowMinutes: 540 };

  assert.equal(snooze(r, 0, now), null);
  assert.equal(snooze(r, -15, now), null);
  assert.equal(snooze(r, MAX_SNOOZE_MINUTES + 1, now), null);
  assert.equal(snooze(r, 'vartti', now), null);
});

test('jokainen torkkuvaihtoehto toimii', () => {
  for (const minutes of SNOOZE_OPTIONS) {
    const snoozed = snooze(reminder({ status: REMINDER_STATUS.DUE }), minutes,
      { todayIso: TODAY, nowMinutes: 540 });
    assert.ok(snoozed, `torkkuvaihtoehto ${minutes} ei toiminut`);
  }
});

test('torkku säilyttää käyttäjän asettaman takarajan', () => {
  const snoozed = snooze(reminder({
    status: REMINDER_STATUS.DUE, untilTime: '17:00'
  }), 15, { todayIso: TODAY, nowMinutes: 540 });

  assert.equal(snoozed.untilTime, '17:00',
    'torkku ohitti käyttäjän asettaman takarajan');
});

test('päätetilasta ei voi torkuttaa', () => {
  assert.equal(snooze(cancel(reminder()), 15,
    { todayIso: TODAY, nowMinutes: 540 }), null);
});

// =====================================================================
// KAKSOISKAPPALEIDEN ESTO
// =====================================================================

test('KRIITTINEN: sama hälytys tuottaa saman avaimen', () => {
  const r = reminder();
  const a = occurrenceKey(r, ESCALATION.GENTLE, { dateIso: TODAY, minutes: '09:00' });
  const b = occurrenceKey(r, ESCALATION.GENTLE, { dateIso: TODAY, minutes: '09:00' });
  assert.equal(a, b);
});

test('eri porras tuottaa eri avaimen', () => {
  const r = reminder();
  const gentle = occurrenceKey(r, ESCALATION.GENTLE, { dateIso: TODAY, minutes: '09:00' });
  const firm = occurrenceKey(r, ESCALATION.FIRM, { dateIso: TODAY, minutes: '09:00' });
  assert.notEqual(gentle, firm);
});

test('torkutettu muistutus on aidosti eri hälytys', () => {
  const r = reminder();
  const eka = occurrenceKey(r, ESCALATION.GENTLE, { dateIso: TODAY, minutes: '09:00' });
  const toka = occurrenceKey(r, ESCALATION.GENTLE, { dateIso: TODAY, minutes: '09:15' });
  assert.notEqual(eka, toka);
});

test('avaimeton muistutus ei tuota avainta', () => {
  assert.equal(occurrenceKey(normalizeReminder({ title: 'x' }), ESCALATION.GENTLE,
    { dateIso: TODAY, minutes: '09:00' }), null);
});

// =====================================================================
// PORRASTUS
// =====================================================================

test('ilman porrastusta erääntynyt tuottaa yhden hienovaraisen', () => {
  const r = reminder({ escalate: false });
  assert.equal(escalationFor(r, { todayIso: TODAY, nowMinutes: 540 }),
    ESCALATION.GENTLE);
  assert.equal(escalationFor(r, { todayIso: TODAY, nowMinutes: 539 }), null);
});

test('porrastus kulkee hienovaraisesta myöhästyneeseen', () => {
  const r = reminder({ escalate: true });

  const tunti = DEFAULT_ESCALATION_LEAD[ESCALATION.GENTLE];
  const vartti = DEFAULT_ESCALATION_LEAD[ESCALATION.FIRM];

  assert.equal(escalationFor(r, { todayIso: TODAY, nowMinutes: 540 - tunti - 1 }),
    null, 'hälytys tuli ennen ensimmäistä porrasta');
  assert.equal(escalationFor(r, { todayIso: TODAY, nowMinutes: 540 - tunti }),
    ESCALATION.GENTLE);
  assert.equal(escalationFor(r, { todayIso: TODAY, nowMinutes: 540 - vartti }),
    ESCALATION.FIRM);
  assert.equal(escalationFor(r, { todayIso: TODAY, nowMinutes: 540 }),
    ESCALATION.OVERDUE);
});

test('eilinen porrastettu muistutus on myöhässä', () => {
  assert.equal(escalationFor(reminder({ escalate: true }),
    { todayIso: '2026-09-12', nowMinutes: 0 }), ESCALATION.OVERDUE);
});

test('huominen ei hälytä vielä', () => {
  assert.equal(escalationFor(reminder({ escalate: true }),
    { todayIso: '2026-09-10', nowMinutes: 1439 }), null);
});

test('portaita on tasan kolme', () => {
  // Neljäs porras ei lisää tietoa vaan ärsytystä, ja ärsyttävä
  // muistutus opettaa käyttäjän ohittamaan kaikki muistutukset.
  assert.equal(ESCALATIONS.length, 3);
});

// =====================================================================
// ARVIOINTI
// =====================================================================

test('KRIITTINEN: evaluateReminders ei lue kelloa', () => {
  const r = reminder();
  const eka = evaluateReminders({
    reminders: [r], todayIso: TODAY, nowMinutes: 540
  });
  const toka = evaluateReminders({
    reminders: [r], todayIso: TODAY, nowMinutes: 540
  });
  assert.deepEqual(eka, toka, 'sama syöte tuotti eri tuloksen');
});

test('jo näytetty avain ei tuota uutta hälytystä', () => {
  const r = reminder();
  const eka = evaluateReminders({
    reminders: [r], todayIso: TODAY, nowMinutes: 540
  });
  assert.equal(eka.alerts.length, 1);

  const toka = evaluateReminders({
    reminders: [r], todayIso: TODAY, nowMinutes: 540,
    deliveredKeys: new Set(eka.alerts.map(a => a.key))
  });
  assert.equal(toka.alerts.length, 0, 'sama hälytys tuli kahdesti');
});

test('KRIITTINEN: hälytysrajan saavuttanut ei hälytä enää', () => {
  const { alerts } = evaluateReminders({
    reminders: [reminder({ alertCount: MAX_ALERTS_PER_REMINDER })],
    todayIso: TODAY, nowMinutes: 540
  });
  assert.equal(alerts.length, 0);
});

test('orpo ei hälytä vaan raportoidaan orpona', () => {
  const r = reminder({ targetType: REMINDER_TARGET.TASK, targetId: 't1' });
  const { alerts, orphaned } = evaluateReminders({
    reminders: [r], todayIso: TODAY, nowMinutes: 540, lookup: { task: [] }
  });

  assert.equal(alerts.length, 0);
  assert.equal(orphaned.length, 1);
  assert.equal(orphaned[0].id, 'r1');
});

test('vanhentunut ei hälytä vaan raportoidaan vanhentuneena', () => {
  const { alerts, expired } = evaluateReminders({
    reminders: [reminder({ untilTime: '08:00' })],
    todayIso: TODAY, nowMinutes: 540
  });
  assert.equal(alerts.length, 0);
  assert.equal(expired.length, 1);
});

test('jokainen hälytys kantaa perustelun', () => {
  // Hälytys ilman perustelua on käsky.
  const { alerts } = evaluateReminders({
    reminders: [reminder()], todayIso: TODAY, nowMinutes: 540
  });
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].reason && alerts[0].reason.length > 10);
  assert.ok(alerts[0].reason.includes('Soita hammaslääkärille'));
});

test('tyhjä syöte tuottaa tyhjän tuloksen eikä kaadu', () => {
  const result = evaluateReminders({ todayIso: TODAY, nowMinutes: 540 });
  assert.deepEqual(result, { alerts: [], expired: [], orphaned: [] });
});

test('null-rivit ohitetaan', () => {
  const result = evaluateReminders({
    reminders: [null, reminder(), undefined],
    todayIso: TODAY, nowMinutes: 540
  });
  assert.equal(result.alerts.length, 1);
});

// =====================================================================
// PERUSTELU
// =====================================================================

test('myöhästyneen perustelu kertoo milloin asia oli määrä hoitaa', () => {
  const text = explainAlert(reminder(), ESCALATION.OVERDUE,
    { todayIso: TODAY, nowMinutes: 600 });
  assert.ok(text.includes('09:00'));
});

test('eilisen myöhästyneen perustelu kertoo päivän', () => {
  const text = explainAlert(reminder(), ESCALATION.OVERDUE,
    { todayIso: '2026-09-12', nowMinutes: 600 });
  assert.ok(text.includes('2026-09-11'));
});

test('etukäteisperustelu kertoo jäljellä olevan ajan todellisista luvuista', () => {
  const text = explainAlert(reminder(), ESCALATION.GENTLE,
    { todayIso: TODAY, nowMinutes: 480 });
  // Tunti näytetään tunteina, ei kuutenakymmenenä minuuttina.
  assert.ok(text.includes('1 h'), `perustelu oli: ${text}`);

  const puoliTuntia = explainAlert(reminder(), ESCALATION.GENTLE,
    { todayIso: TODAY, nowMinutes: 510 });
  assert.ok(puoliTuntia.includes('30 min'), `perustelu oli: ${puoliTuntia}`);
});

test('yli tunnin jäljellä näytetään tunteina ja minuutteina', () => {
  const text = explainAlert(reminder({ dueTime: '12:00' }), ESCALATION.GENTLE,
    { todayIso: TODAY, nowMinutes: 540 });
  assert.ok(text.includes('3 h'), `perustelu oli: ${text}`);
});

// =====================================================================
// APUFUNKTIOT
// =====================================================================

test('tehtävästä syntyy muistutus etuajalla', () => {
  const r = reminderForTask(
    { id: 't1', title: 'Hammaslääkäri', date: '2026-09-11', time: '09:00' },
    { id: 'r9', leadMinutes: 30 });

  assert.equal(r.targetType, REMINDER_TARGET.TASK);
  assert.equal(r.targetId, 't1');
  assert.equal(r.dueTime, '08:30');
});

test('tehtävä ilman tunnistetta ei tuota muistutusta', () => {
  assert.equal(reminderForTask({ title: 'x' }, { id: 'r9' }), null);
  assert.equal(reminderForTask(null, { id: 'r9' }), null);
});

test('kohteen muistutukset suodatetaan lajilla JA tunnisteella', () => {
  const rows = [
    reminder({ id: 'a', targetType: REMINDER_TARGET.TASK, targetId: 't1' }),
    reminder({ id: 'b', targetType: REMINDER_TARGET.TASK, targetId: 't2' }),
    reminder({ id: 'c', targetType: REMINDER_TARGET.BILL, targetId: 't1' })
  ];
  assert.deepEqual(
    remindersForTarget(rows, REMINDER_TARGET.TASK, 't1').map(r => r.id), ['a']);
});

test('elävät muistutukset eivät sisällä päätetiloja', () => {
  const rows = [reminder({ id: 'a' }), cancel(reminder({ id: 'b' }))];
  assert.deepEqual(liveReminders(rows).map(r => r.id), ['a']);
});

test('järjestys on aikajärjestys', () => {
  const rows = [
    reminder({ id: 'b', dueDate: '2026-09-12', dueTime: '08:00' }),
    reminder({ id: 'a', dueDate: '2026-09-11', dueTime: '23:00' })
  ].sort(compareReminders);
  assert.deepEqual(rows.map(r => r.id), ['a', 'b']);
});

test('yhteenveto laskee elävät ja myöhässä olevat', () => {
  const rows = [
    reminder({ id: 'a' }),
    cancel(reminder({ id: 'b' })),
    reminder({ id: 'c', status: REMINDER_STATUS.SNOOZED })
  ];
  const summary = summarizeReminders(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.live, 2);
});

test('jokaisella tilalla on suomenkielinen nimi', () => {
  for (const status of REMINDER_STATUSES) {
    const label = reminderStatusLabel(status);
    assert.ok(label && label.length > 0, `tilalta ${status} puuttuu nimi`);
    assert.notEqual(label, status, `tilan ${status} nimi on tunniste`);
  }
});
