// Ilmoituskeskus — kaksoiskappaleet, järjestys ja säilytys.
//
// =====================================================================
// KAKSI ASIAA, JOITA TÄMÄ TIEDOSTO VARTIOI YLI MUIDEN
// =====================================================================
//
// 1. SAMA AVAIN ON YKSI MERKINTÄ. Avain periytyy hälytykseltä, joten
//    kaksoiskappaleiden esto toimii yli koko ketjun: muistutuksen
//    `occurrenceKey` -> merkinnän `key` -> kannan `notices_key_unique`.
//    Kolme estettä, joista mikään ei ole ainoa.
//
// 2. LUKEMATON SÄILYY KAKSI KERTAA PIDEMPÄÄN. Merkintä, jolle käyttäjä
//    ei ole tehnyt mitään, on juuri se jonka hän saattoi missata. Sen
//    poistaminen ensin olisi täsmälleen väärin päin.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTICE_KIND, NOTICE_KINDS, NOTICE_STATUS, NOTICE_STATUSES,
  NOTICE_LEVEL, NOTICE_LEVELS, NOTICE_ACTION, NOTICE_ACTIONS,
  MAX_NOTICES, RETENTION_DAYS,
  normalizeNotice, validateNotice, addNotice, hasNotice, pruneNotices,
  compareNotices, canTransition, markRead, markActed, markDismissed,
  unreadNotices, summarizeNotices, actionsFor,
  noticeFromAlert, noticeFromDeparture, noticeFromConflict, noticeKindLabel
} from '../src/domain/notificationCenter.js';

import { ESCALATION } from '../src/domain/reminder.js';

const TODAY = '2026-09-11';

function notice(overrides = {}) {
  return normalizeNotice({
    id: 'n1',
    key: 'reminder|r1|2026-09-11|09:00',
    kind: NOTICE_KIND.REMINDER,
    level: NOTICE_LEVEL.INFO,
    title: 'Soita hammaslääkärille',
    reason: 'Muistutan tästä nyt, koska asia alkaa 30 min kuluttua.',
    createdDate: TODAY,
    ...overrides
  });
}

// =====================================================================
// NORMALISOINTI JA VALIDOINTI
// =====================================================================

test('tuntematon laji, taso ja tila putoavat turvallisiin oletuksiin', () => {
  const n = normalizeNotice({ kind: 'kissa', level: 'hätä', status: 'outo' });
  assert.equal(n.kind, NOTICE_KIND.REMINDER);
  assert.equal(n.level, NOTICE_LEVEL.INFO);
  assert.equal(n.status, NOTICE_STATUS.UNREAD);
});

test('avaimeton merkintä ei kelpaa', () => {
  const { valid, errors } = validateNotice(notice({ key: null }));
  assert.equal(valid, false);
  assert.ok(errors.key);
});

test('otsikoton merkintä ei kelpaa', () => {
  const { valid, errors } = validateNotice(notice({ title: '  ' }));
  assert.equal(valid, false);
  assert.ok(errors.title);
});

test('kohdelaji ja tunniste kulkevat parina', () => {
  const vainLaji = validateNotice(notice({ targetType: 'task', targetId: null }));
  assert.equal(vainLaji.valid, false);

  const vainTunniste = validateNotice(notice({ targetType: null, targetId: 't1' }));
  assert.equal(vainTunniste.valid, false);

  assert.equal(validateNotice(notice({ targetType: 'task', targetId: 't1' })).valid,
    true);
});

test('kelvollinen merkintä ilman kohdetta kelpaa', () => {
  assert.equal(validateNotice(notice()).valid, true);
});

// =====================================================================
// KAKSOISKAPPALEIDEN ESTO
// =====================================================================

test('KRIITTINEN: sama avain ei tuota toista merkintää', () => {
  const list = addNotice([], notice());
  assert.equal(list.length, 1);

  const again = addNotice(list, notice({ id: 'n2' }));
  assert.equal(again.length, 1);
  assert.equal(again, list, 'lista vaihtui vaikka mitään ei lisätty');
});

test('eri avain lisätään', () => {
  const list = addNotice(addNotice([], notice()),
    notice({ id: 'n2', key: 'reminder|r2|2026-09-11|10:00' }));
  assert.equal(list.length, 2);
});

test('avaimeton merkintä ei mene listaan', () => {
  const list = addNotice([], notice({ key: null }));
  assert.equal(list.length, 0);
});

test('lisäys ei mutatoi alkuperäistä listaa', () => {
  const original = [];
  addNotice(original, notice());
  assert.equal(original.length, 0);
});

test('avaimen olemassaolo voidaan kysyä suoraan', () => {
  const list = addNotice([], notice());
  assert.equal(hasNotice(list, 'reminder|r1|2026-09-11|09:00'), true);
  assert.equal(hasNotice(list, 'jokin-muu'), false);
  assert.equal(hasNotice(list, null), false);
});

test('KRIITTINEN: avain periytyy hälytykseltä merkinnälle', () => {
  // Tämä on se kohta, jossa esto siirtyy muistutuksesta
  // ilmoituskeskukseen. Jos avain vaihtuisi tässä, sama hälytys
  // tuottaisi merkinnän joka kierroksella.
  const alert = {
    key: 'r1|gentle|2026-09-11|09:00',
    title: 'Soita', escalation: ESCALATION.GENTLE,
    targetType: 'task', targetId: 't1', reason: 'koska'
  };

  const n = noticeFromAlert(alert, { id: 'n1', createdDate: TODAY });
  assert.equal(n.key, alert.key);
});

test('lähtöilmoituksen avain sisältää päivän ja suunnitelman', () => {
  const n = noticeFromDeparture(
    { id: 'p1', title: 'Hammaslääkäri', destination: 'Keskusta' },
    { id: 'n1', todayIso: TODAY, reason: 'Lähde nyt.' });

  assert.ok(n.key.includes('p1'));
  assert.ok(n.key.includes(TODAY));
});

test('myöhässä oleva lähtö on eri merkintä kuin ajoissa oleva', () => {
  const plan = { id: 'p1', title: 'Hammaslääkäri' };
  const ajoissa = noticeFromDeparture(plan, { id: 'a', todayIso: TODAY });
  const myohassa = noticeFromDeparture(plan, { id: 'b', todayIso: TODAY, late: true });

  assert.notEqual(ajoissa.key, myohassa.key);
  assert.equal(myohassa.level, NOTICE_LEVEL.URGENT);
});

test('tunnisteeton lähde ei tuota merkintää', () => {
  assert.equal(noticeFromDeparture(null, { id: 'n1', todayIso: TODAY }), null);
  assert.equal(noticeFromDeparture({}, { id: 'n1', todayIso: TODAY }), null);
  assert.equal(noticeFromAlert(null, { id: 'n1', createdDate: TODAY }), null);
  assert.equal(noticeFromAlert({ title: 'x' }, { id: 'n1', createdDate: TODAY }),
    null);
});

// =====================================================================
// TASOT
// =====================================================================

test('myöhästynyt hälytys on kiireellinen, tavallinen ei', () => {
  const base = { key: 'k', title: 'x', targetType: 'standalone' };

  assert.equal(noticeFromAlert({ ...base, escalation: ESCALATION.OVERDUE },
    { id: 'n', createdDate: TODAY }).level, NOTICE_LEVEL.URGENT);
  assert.equal(noticeFromAlert({ ...base, escalation: ESCALATION.FIRM },
    { id: 'n', createdDate: TODAY }).level, NOTICE_LEVEL.WARNING);
  assert.equal(noticeFromAlert({ ...base, escalation: ESCALATION.GENTLE },
    { id: 'n', createdDate: TODAY }).level, NOTICE_LEVEL.INFO);
});

test('vapaan muistutuksen kohde ei päädy merkintään', () => {
  const n = noticeFromAlert({
    key: 'k', title: 'x', escalation: ESCALATION.GENTLE,
    targetType: 'standalone', targetId: 'ei-pitäisi-olla'
  }, { id: 'n', createdDate: TODAY });

  assert.equal(n.targetType, null);
  assert.equal(n.targetId, null);
});

test('ristiriidasta syntyy merkintä, jonka taso seuraa vakavuutta', () => {
  const blocking = noticeFromConflict(
    { code: 'overbooked', severity: 'blocking', message: 'Päivä on täynnä.' },
    { id: 'n1', todayIso: TODAY });

  assert.equal(blocking.kind, NOTICE_KIND.CONFLICT);
  assert.equal(blocking.level, NOTICE_LEVEL.URGENT);
  assert.ok(blocking.reason);
});

test('koodittomasta ristiriidasta ei synny merkintää', () => {
  assert.equal(noticeFromConflict({}, { id: 'n1', todayIso: TODAY }), null);
});

// =====================================================================
// TILASIIRTYMÄT
// =====================================================================

test('käsitelty ei palaa käsittelemättömäksi', () => {
  for (const from of [NOTICE_STATUS.ACTED, NOTICE_STATUS.DISMISSED]) {
    for (const to of NOTICE_STATUSES) {
      assert.equal(canTransition(from, to), false,
        `tilasta ${from} pääsi tilaan ${to}`);
    }
  }
});

test('luettu voi vielä muuttua toimituksi tai hylätyksi', () => {
  const read = markRead(notice());
  assert.equal(read.status, NOTICE_STATUS.READ);
  assert.equal(markActed(read).status, NOTICE_STATUS.ACTED);
  assert.equal(markDismissed(read).status, NOTICE_STATUS.DISMISSED);
});

test('luettua ei voi lukea uudelleen', () => {
  assert.equal(markRead(markRead(notice())), null);
});

// =====================================================================
// TOIMINNOT
// =====================================================================

test('jokaisella lajilla on nimenomainen toimintolista', () => {
  // Ilman karttaa käyttöliittymä tarjoaisi "torkuta" ristiriidalle.
  for (const kind of NOTICE_KINDS) {
    const actions = actionsFor(notice({ kind }));
    assert.ok(actions.length > 0, `lajilta ${kind} puuttuvat toiminnot`);
    for (const action of actions) {
      assert.ok(NOTICE_ACTIONS.includes(action),
        `lajilla ${kind} on tuntematon toiminto ${action}`);
    }
  }
});

test('torkutus tarjotaan vain muistutukselle', () => {
  for (const kind of NOTICE_KINDS) {
    const actions = actionsFor(notice({ kind }));
    if (kind === NOTICE_KIND.REMINDER) {
      assert.ok(actions.includes(NOTICE_ACTION.SNOOZE));
    } else {
      assert.equal(actions.includes(NOTICE_ACTION.SNOOZE), false,
        `lajille ${kind} tarjottiin torkutusta`);
    }
  }
});

test('käsitellylle tarjotaan vain avaaminen', () => {
  const acted = markActed(notice());
  assert.deepEqual(actionsFor(acted), [NOTICE_ACTION.OPEN]);
});

test('tyhjälle merkinnälle ei tarjota mitään', () => {
  assert.deepEqual(actionsFor(null), []);
});

// =====================================================================
// JÄRJESTYS
// =====================================================================

test('käsittelemättömät ensin', () => {
  const rows = [
    markRead(notice({ id: 'a', key: 'a', createdAt: '2026-09-11T12:00:00Z' })),
    notice({ id: 'b', key: 'b', createdAt: '2026-09-11T08:00:00Z' })
  ].sort(compareNotices);

  assert.deepEqual(rows.map(n => n.id), ['b', 'a']);
});

test('kiireellinen nousee käsittelemättömien sisällä', () => {
  const rows = [
    notice({ id: 'a', key: 'a', level: NOTICE_LEVEL.INFO,
      createdAt: '2026-09-11T12:00:00Z' }),
    notice({ id: 'b', key: 'b', level: NOTICE_LEVEL.URGENT,
      createdAt: '2026-09-11T08:00:00Z' })
  ].sort(compareNotices);

  assert.deepEqual(rows.map(n => n.id), ['b', 'a']);
});

test('saman tason sisällä uusin ensin', () => {
  const rows = [
    notice({ id: 'a', key: 'a', createdAt: '2026-09-11T08:00:00Z' }),
    notice({ id: 'b', key: 'b', createdAt: '2026-09-11T12:00:00Z' })
  ].sort(compareNotices);

  assert.deepEqual(rows.map(n => n.id), ['b', 'a']);
});

test('käsittelemättömät suodatetaan ja järjestetään', () => {
  const rows = [
    notice({ id: 'a', key: 'a' }),
    markActed(notice({ id: 'b', key: 'b' }))
  ];
  assert.deepEqual(unreadNotices(rows).map(n => n.id), ['a']);
});

// =====================================================================
// SÄILYTYS
// =====================================================================

test('KRIITTINEN: lukematon säilyy kaksi kertaa pidempään', () => {
  const vanha = shift(TODAY, -(RETENTION_DAYS + 5));

  const luettu = markRead(notice({ id: 'a', key: 'a', createdDate: vanha }));
  const lukematon = notice({ id: 'b', key: 'b', createdDate: vanha });

  const kept = pruneNotices([luettu, lukematon], { todayIso: TODAY });

  assert.deepEqual(kept.map(n => n.id), ['b'],
    'lukematon karsittiin ennen luettua');
});

test('erittäin vanha lukematonkin karsiutuu', () => {
  const ikivanha = shift(TODAY, -(RETENTION_DAYS * 2 + 5));
  const kept = pruneNotices(
    [notice({ id: 'a', key: 'a', createdDate: ikivanha })], { todayIso: TODAY });
  assert.equal(kept.length, 0);
});

test('tuore säilyy', () => {
  const kept = pruneNotices([notice()], { todayIso: TODAY });
  assert.equal(kept.length, 1);
});

test('määräraja leikkaa listan vaikka kaikki olisivat tuoreita', () => {
  // Ikä hoitaa tavallisen käytön; määrä suojaa poikkeukselta, jossa
  // yksi päivä tuottaa satoja merkintöjä.
  const rows = Array.from({ length: MAX_NOTICES + 50 }, (_, n) =>
    notice({ id: `n${n}`, key: `k${n}` }));

  assert.equal(pruneNotices(rows, { todayIso: TODAY }).length, MAX_NOTICES);
});

test('päivätön merkintä ei karsiudu iän perusteella', () => {
  const kept = pruneNotices([notice({ createdDate: null })], { todayIso: TODAY });
  assert.equal(kept.length, 1);
});

test('kelvoton tämä päivä ei karsi mitään iän perusteella', () => {
  const vanha = notice({ createdDate: '2020-01-01' });
  assert.equal(pruneNotices([vanha], { todayIso: 'eilen' }).length, 1);
});

test('null-rivit siivoutuvat karsinnassa', () => {
  const kept = pruneNotices([null, notice(), undefined], { todayIso: TODAY });
  assert.equal(kept.length, 1);
});

// =====================================================================
// YHTEENVETO
// =====================================================================

test('yhteenveto laskee lukemattomat ja kiireelliset', () => {
  const rows = [
    notice({ id: 'a', key: 'a', level: NOTICE_LEVEL.URGENT }),
    notice({ id: 'b', key: 'b' }),
    markActed(notice({ id: 'c', key: 'c', level: NOTICE_LEVEL.URGENT }))
  ];

  const summary = summarizeNotices(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.unread, 2);
  assert.equal(summary.urgent, 1, 'käsitelty kiireellinen laskettiin mukaan');
  assert.equal(summary.badge, 2);
});

test('nolla ei ole merkki', () => {
  assert.equal(summarizeNotices([]).badge, 0);
});

test('jokaisella lajilla on suomenkielinen nimi', () => {
  for (const kind of NOTICE_KINDS) {
    const label = noticeKindLabel(kind);
    assert.ok(label && label.length > 0, `lajilta ${kind} puuttuu nimi`);
    assert.notEqual(label, kind, `lajin ${kind} nimi on tunniste`);
  }
});

test('tasoja on kolme', () => {
  assert.equal(NOTICE_LEVELS.length, 3);
});

/** Päivä siirrettynä. Testin oma apuri — domain ei lue kelloa. */
function shift(iso, days) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000)
    .toISOString().slice(0, 10);
}
