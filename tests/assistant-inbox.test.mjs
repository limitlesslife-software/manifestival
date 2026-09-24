// Saapuvat ja kirjauksen reititys — domain.
//
// =====================================================================
// KAKSI ASIAA, JOITA TÄMÄ TIEDOSTO VARTIOI YLI MUIDEN
// =====================================================================
//
// 1. MUUNNETTU ON PÄÄTETILA. Paluu siitä tarkoittaisi kahta riviä
//    samasta asiasta: saapuvan palauttaminen ei poista siitä syntynyttä
//    tehtävää, joten toinen hyväksyntä loisi kaksoiskappaleen.
//
// 2. REITITYS EI KUTSU MITÄÄN. `routeOf` kertoo mitä tehtäisiin ja
//    palauttaa jäätyneen kuvauksen. Se ei voi luoda riviä, koska sillä
//    ei ole mitään millä luoda — eikä se saa koskaan saada.
//
// Kellon ja tunnisteiden lukeminen ei kuulu domainiin, joten jokainen
// testi antaa ne itse.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INBOX_STATUS, INBOX_STATUSES, OPEN_INBOX_STATUSES, CAPTURE_SOURCE,
  MAX_TEXT_LENGTH, MAX_OPEN_ITEMS,
  normalizeInboxItem, validateInboxItem, canTransition, transition,
  attachProposal, acceptItem, markConverted, dismissItem, restoreItem,
  isOpenItem, compareInboxItems, openItems, summarizeInbox, atCapacity,
  itemsForDate, inboxStatusLabel
} from '../src/domain/inbox.js';

import {
  CAPTURE_KIND, CAPTURE_KINDS, CONFIDENCE, REVIEW_THRESHOLD,
  needsReview, normalizeInterpretation, validateInterpretation,
  routeOf, payloadFor, describeRoute, isForbidden, captureKindLabel
} from '../src/domain/capture.js';

import { FORBIDDEN_INTENTS, RISK } from '../src/domain/risk.js';

/** Kelvollinen rivi, jonka päälle testit rakentavat. */
function item(overrides = {}) {
  return normalizeInboxItem({
    id: 'i1',
    text: 'Soita hammaslääkärille',
    capturedAt: '2026-09-11T08:00:00.000Z',
    ...overrides
  });
}

// =====================================================================
// NORMALISOINTI
// =====================================================================

test('tuntematon tila putoaa käsittelemättömäksi', () => {
  assert.equal(normalizeInboxItem({ status: 'kissa' }).status,
    INBOX_STATUS.UNPROCESSED);
});

test('tuntematon lähde putoaa tekstiksi', () => {
  assert.equal(normalizeInboxItem({ source: 'telepatia' }).source,
    CAPTURE_SOURCE.TEXT);
});

test('teksti katkaistaan enimmäispituuteen eikä hylätä', () => {
  // Katkaisu on parempi kuin hylkäys: käyttäjän ajatus säilyy, ja
  // kanta hyväksyy rivin. Hylkäys söisi koko kirjauksen.
  const long = 'x'.repeat(MAX_TEXT_LENGTH + 500);
  assert.equal(normalizeInboxItem({ text: long }).text.length, MAX_TEXT_LENGTH);
});

test('teksti trimmataan', () => {
  assert.equal(normalizeInboxItem({ text: '  kahvia  ' }).text, 'kahvia');
});

test('tunniste on merkkijono tai null, ei koskaan luku', () => {
  assert.equal(normalizeInboxItem({ id: 42 }).id, '42');
  assert.equal(normalizeInboxItem({}).id, null);
});

test('ääntä ei ole rivissä missään muodossa', () => {
  // Puheesta tullut rivi kantaa LITTEROINNIN. Äänitallennetta ei
  // kirjoiteta mihinkään, eikä kentälle ole nimeä.
  const voice = normalizeInboxItem({
    text: 'muista maito', source: CAPTURE_SOURCE.VOICE,
    audio: 'data:audio/webm;base64,AAAA', recording: 'x', audioUrl: 'blob:y'
  });

  assert.equal(voice.source, CAPTURE_SOURCE.VOICE);
  for (const key of Object.keys(voice)) {
    assert.equal(/audio|recording|voiceclip|blob/i.test(key), false,
      `saapuvassa rivissä on äänikenttä ${key}`);
  }
  assert.equal(JSON.stringify(voice).includes('base64'), false);
});

// =====================================================================
// VALIDOINTI
// =====================================================================

test('tyhjä teksti ei kelpaa', () => {
  const { valid, errors } = validateInboxItem(item({ text: '   ' }));
  assert.equal(valid, false);
  assert.ok(errors.text);
});

test('muunnettu ilman kohdelajia ei kelpaa', () => {
  const { valid, errors } = validateInboxItem(
    item({ status: INBOX_STATUS.CONVERTED }));
  assert.equal(valid, false);
  assert.ok(errors.convertedKind);
});

test('kohdelaji ilman muunnostilaa ei kelpaa', () => {
  const { valid, errors } = validateInboxItem(
    item({ status: INBOX_STATUS.UNPROCESSED, convertedKind: 'task' }));
  assert.equal(valid, false);
  assert.ok(errors.convertedKind);
});

test('muunnettu kohdelajin kanssa kelpaa', () => {
  assert.equal(validateInboxItem(item({
    status: INBOX_STATUS.CONVERTED, convertedKind: 'task', convertedId: 't1'
  })).valid, true);
});

// =====================================================================
// TILASIIRTYMÄT
// =====================================================================

test('muunnettu on päätetila: mikään siirtymä ei lähde siitä', () => {
  for (const to of INBOX_STATUSES) {
    assert.equal(canTransition(INBOX_STATUS.CONVERTED, to), false,
      `muunnetusta pääsi tilaan ${to}`);
  }
});

test('hylätystä voi palata käsittelemättömäksi mutta ei muualle', () => {
  assert.equal(canTransition(INBOX_STATUS.DISMISSED, INBOX_STATUS.UNPROCESSED), true);
  for (const to of INBOX_STATUSES.filter(s => s !== INBOX_STATUS.UNPROCESSED)) {
    assert.equal(canTransition(INBOX_STATUS.DISMISSED, to), false,
      `hylätystä pääsi tilaan ${to}`);
  }
});

test('kielletty siirtymä palauttaa nullin eikä heitä', () => {
  assert.equal(transition(item({ status: INBOX_STATUS.CONVERTED }),
    INBOX_STATUS.UNPROCESSED), null);
});

test('ehdotuksen liittäminen vie ehdotettuun tai tarkistettavaan', () => {
  const proposed = attachProposal(item(), { kind: CAPTURE_KIND.TASK });
  assert.equal(proposed.status, INBOX_STATUS.PROPOSED);

  const review = attachProposal(item(), { kind: CAPTURE_KIND.TASK },
    { needsReview: true });
  assert.equal(review.status, INBOX_STATUS.NEEDS_REVIEW);
});

test('ehdotusta ei voi liittää muunnettuun riviin', () => {
  assert.equal(attachProposal(
    item({ status: INBOX_STATUS.CONVERTED, convertedKind: 'task' }),
    { kind: CAPTURE_KIND.TASK }), null);
});

test('KRIITTINEN: muunnos vaatii hyväksynnän ensin', () => {
  // Suora hyppy ehdotetusta muunnettuun ohittaisi sen hetken, jossa
  // käyttäjä sanoo kyllä.
  const proposed = attachProposal(item(), { kind: CAPTURE_KIND.TASK });
  assert.equal(markConverted(proposed, 'task', 't1'), null);

  const accepted = acceptItem(proposed);
  assert.equal(accepted.status, INBOX_STATUS.ACCEPTED);

  const converted = markConverted(accepted, 'task', 't1');
  assert.equal(converted.status, INBOX_STATUS.CONVERTED);
  assert.equal(converted.convertedKind, 'task');
  assert.equal(converted.convertedId, 't1');
});

test('muunnos ilman kohdelajia ei onnistu', () => {
  const accepted = acceptItem(item());
  assert.equal(markConverted(accepted, null, 't1'), null);
  assert.equal(markConverted(accepted, '', 't1'), null);
});

test('KRIITTINEN: ehdotus katoaa kun rivi muunnetaan', () => {
  // Säilytettynä ehdotus päätyisi vientiin ja varmuuskopioon ilman
  // että sillä on enää käyttöä. `verify_0011.sql` tarkistus 47
  // havaitsee, jos tämä lakkaa pitämästä paikkansa.
  const accepted = acceptItem(attachProposal(item(), { kind: CAPTURE_KIND.TASK }));
  assert.equal(markConverted(accepted, 'task', 't1').proposal, null);
});

test('KRIITTINEN: ehdotus katoaa kun rivi hylätään', () => {
  const proposed = attachProposal(item(), { kind: CAPTURE_KIND.TASK });
  const dismissed = dismissItem(proposed);
  assert.equal(dismissed.status, INBOX_STATUS.DISMISSED);
  assert.equal(dismissed.proposal, null);
});

test('palautettu rivi on puhdas: ei ehdotusta eikä kohdetta', () => {
  const restored = restoreItem(dismissItem(item()));
  assert.equal(restored.status, INBOX_STATUS.UNPROCESSED);
  assert.equal(restored.proposal, null);
  assert.equal(restored.convertedKind, null);
  assert.equal(restored.convertedId, null);
});

test('muunnettua riviä ei voi palauttaa', () => {
  const converted = markConverted(acceptItem(item()), 'task', 't1');
  assert.equal(restoreItem(converted), null);
});

// =====================================================================
// LISTA JA YHTEENVETO
// =====================================================================

test('avoimet tilat eivät sisällä päätetiloja', () => {
  assert.equal(OPEN_INBOX_STATUSES.includes(INBOX_STATUS.CONVERTED), false);
  assert.equal(OPEN_INBOX_STATUSES.includes(INBOX_STATUS.DISMISSED), false);
});

test('avoin rivi tunnistetaan tilasta', () => {
  assert.equal(isOpenItem(item()), true);
  assert.equal(isOpenItem(markConverted(acceptItem(item()), 'task', 't1')), false);
  assert.equal(isOpenItem(null), false);
});

test('järjestys: avoimet ensin, uusin ensin', () => {
  const vanha = item({ id: 'a', capturedAt: '2026-09-01T08:00:00.000Z' });
  const uusi = item({ id: 'b', capturedAt: '2026-09-10T08:00:00.000Z' });
  const suljettu = markConverted(
    acceptItem(item({ id: 'c', capturedAt: '2026-09-11T08:00:00.000Z' })),
    'task', 't1');

  const sorted = [vanha, suljettu, uusi].sort(compareInboxItems);
  assert.deepEqual(sorted.map(i => i.id), ['b', 'a', 'c']);
});

test('openItems suodattaa päätetilat pois', () => {
  const rows = [
    item({ id: 'a' }),
    markConverted(acceptItem(item({ id: 'b' })), 'task', 't1'),
    dismissItem(item({ id: 'c' }))
  ];
  assert.deepEqual(openItems(rows).map(i => i.id), ['a']);
});

test('yhteenveto laskee avoimet ja tarkistettavat', () => {
  const rows = [
    item({ id: 'a' }),
    attachProposal(item({ id: 'b' }), {}, { needsReview: true }),
    markConverted(acceptItem(item({ id: 'c' })), 'task', 't1')
  ];
  const summary = summarizeInbox(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.open, 2);
  assert.equal(summary.needsReview, 1);
  assert.equal(summary.converted, 1);
});

test('tyhjä yhteenveto on nollia eikä kaadu', () => {
  const summary = summarizeInbox([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.open, 0);
});

test('katto laskee vain avoimet rivejä', () => {
  const avoimet = Array.from({ length: MAX_OPEN_ITEMS },
    (_, n) => item({ id: `a${n}` }));
  assert.equal(atCapacity(avoimet), true);

  // Sama määrä suljettuja ei täytä kattoa: ne eivät odota ketään.
  const suljetut = avoimet.map(
    (row, n) => markConverted(acceptItem(row), 'task', `t${n}`));
  assert.equal(atCapacity(suljetut), false);
});

test('päivän rivit rajataan kirjaushetkestä', () => {
  const rows = [
    item({ id: 'a', capturedAt: '2026-09-11T08:00:00.000Z' }),
    item({ id: 'b', capturedAt: '2026-09-12T08:00:00.000Z' })
  ];
  assert.deepEqual(itemsForDate(rows, '2026-09-11').map(i => i.id), ['a']);
});

test('jokaisella tilalla on suomenkielinen nimi', () => {
  for (const status of INBOX_STATUSES) {
    const label = inboxStatusLabel(status);
    assert.ok(label && label.length > 0, `tilalta ${status} puuttuu nimi`);
    assert.notEqual(label, status, `tilan ${status} nimi on tunniste`);
  }
});

// =====================================================================
// REITITYS
// =====================================================================

test('KRIITTINEN: routeOf ei kutsu mitään eikä palauta funktiota', () => {
  const route = routeOf(normalizeInterpretation({
    kind: CAPTURE_KIND.TASK, title: 'Osta maitoa', confidence: 'high'
  }));

  assert.ok(route);
  assert.equal(typeof route.action, 'string');
  for (const value of Object.values(route)) {
    assert.notEqual(typeof value, 'function',
      'reitti sisältää funktion — se olisi kutsuttava toteutus');
  }
  assert.equal(Object.isFrozen(route), true);
});

test('KRIITTINEN: jokainen reitti vaatii vahvistuksen', () => {
  // Ei siksi että ne olisivat vaarallisia, vaan siksi että ne
  // syntyvät tulkinnasta: käyttäjä kirjoitti lauseen, ja joku muu
  // päätti mitä se tarkoittaa.
  const kinds = [
    [CAPTURE_KIND.TASK, { title: 'Osta maitoa' }],
    [CAPTURE_KIND.GOAL, { title: 'Opettele espanjaa' }],
    [CAPTURE_KIND.PROJECT, { title: 'Keittiöremontti' }],
    [CAPTURE_KIND.BILL, { title: 'Sähkö', amountMinor: 4550, date: '2026-10-01' }]
  ];

  for (const [kind, extra] of kinds) {
    const route = routeOf(normalizeInterpretation({
      kind, confidence: 'high', ...extra
    }));
    if (!route) continue;
    assert.equal(route.requiresConfirmation, true,
      `reitti ${kind} ei vaadi vahvistusta`);
  }
});

test('muistiinpano ja epäselvä eivät reitity mihinkään', () => {
  for (const kind of [CAPTURE_KIND.NOTE, CAPTURE_KIND.AMBIGUOUS]) {
    assert.equal(routeOf(normalizeInterpretation({
      kind, title: 'jotain', confidence: 'high'
    })), null, `${kind} reitittyi`);
  }
});

test('kelvoton tulkinta ei reitity', () => {
  // Tehtävä ilman otsikkoa ei ole tehtävä.
  assert.equal(routeOf(normalizeInterpretation({
    kind: CAPTURE_KIND.TASK, title: '', confidence: 'high'
  })), null);
});

test('null ja määrittelemätön eivät reitity', () => {
  assert.equal(routeOf(null), null);
  assert.equal(routeOf(undefined), null);
});

test('yksikään reitti ei ole korkeariskinen', () => {
  // Kirjaus ei koskaan poista eikä muuta olemassa olevaa. Korkea riski
  // tarkoittaa peruuttamatonta, eikä kirjauksella ole sellaista polkua.
  for (const kind of CAPTURE_KINDS) {
    const route = routeOf(normalizeInterpretation({
      kind, title: 'x', confidence: 'high', amountMinor: 100,
      date: '2026-09-11', time: '09:00', destination: 'Keskusta',
      arrivalTime: '10:00', recurrenceType: 'daily', transactionKind: 'expense'
    }));
    if (!route) continue;
    assert.notEqual(route.risk, RISK.HIGH, `reitti ${kind} on korkeariskinen`);
  }
});

test('KRIITTINEN: yksikään reitti ei nimeä poistavaa toimintoa', () => {
  for (const kind of CAPTURE_KINDS) {
    const route = routeOf(normalizeInterpretation({
      kind, title: 'x', confidence: 'high', amountMinor: 100,
      date: '2026-09-11', time: '09:00', destination: 'Keskusta',
      arrivalTime: '10:00', recurrenceType: 'daily', transactionKind: 'expense'
    }));
    if (!route) continue;
    assert.match(route.action, /^create/,
      `reitti ${kind} nimeää toiminnon ${route.action}`);
  }
});

// =====================================================================
// KIELLETYT TOIMENPITEET
// =====================================================================

test('jokainen kielletty toimenpide tunnistetaan', () => {
  for (const forbidden of FORBIDDEN_INTENTS) {
    assert.equal(isForbidden(forbidden), true, `${forbidden} meni läpi`);
    assert.equal(isForbidden(`tee ${forbidden} nyt`), true);
    assert.equal(isForbidden(forbidden.toUpperCase()), true);
  }
});

test('tavallinen teksti ei ole kielletty', () => {
  assert.equal(isForbidden('Osta maitoa'), false);
  assert.equal(isForbidden(null), false);
  assert.equal(isForbidden(''), false);
});

// =====================================================================
// LUOTTAMUS
// =====================================================================

test('matala luottamus vaatii tarkistuksen', () => {
  assert.equal(needsReview(normalizeInterpretation({
    kind: CAPTURE_KIND.TASK, title: 'x', confidence: CONFIDENCE.LOW
  })), true);
});

test('korkea luottamus ei vaadi tarkistusta', () => {
  assert.equal(needsReview(normalizeInterpretation({
    kind: CAPTURE_KIND.TASK, title: 'x', confidence: CONFIDENCE.HIGH
  })), false);
});

test('epäselvä vaatii tarkistuksen luottamuksesta riippumatta', () => {
  assert.equal(needsReview(normalizeInterpretation({
    kind: CAPTURE_KIND.AMBIGUOUS, title: 'x', confidence: CONFIDENCE.HIGH
  })), true);
});

test('tuntematon luottamus putoaa matalaan', () => {
  const i = normalizeInterpretation({
    kind: CAPTURE_KIND.TASK, title: 'x', confidence: 'täysin varma'
  });
  assert.equal(i.confidence, CONFIDENCE.LOW);
  assert.equal(needsReview(i), true);
});

// =====================================================================
// KUVAUS
// =====================================================================

test('jokainen reitti on kuvattavissa yhtenä lauseena', () => {
  // Toimenpide, jota ei voi lukea yhtenä lauseena, hyväksytään
  // lukematta.
  for (const kind of CAPTURE_KINDS) {
    const interpretation = normalizeInterpretation({
      kind, title: 'Osta maitoa', confidence: 'high', amountMinor: 250,
      date: '2026-09-11', time: '09:00', destination: 'Keskusta',
      arrivalTime: '10:00', recurrenceType: 'daily', transactionKind: 'expense'
    });
    const route = routeOf(interpretation);
    if (!route) continue;

    const text = describeRoute(route, interpretation);
    assert.ok(typeof text === 'string' && text.length > 10,
      `reitin ${kind} kuvaus on tyhjä tai liian lyhyt`);
    assert.ok(text.includes('Osta maitoa') || text.includes('Keskusta'),
      `reitin ${kind} kuvaus ei kerro mistä on kyse: ${text}`);
  }
});

test('jokaisella kirjauslajilla on suomenkielinen nimi', () => {
  for (const kind of CAPTURE_KINDS) {
    const label = captureKindLabel(kind);
    assert.ok(label && label.length > 0, `lajilta ${kind} puuttuu nimi`);
    assert.notEqual(label, kind, `lajin ${kind} nimi on tunniste`);
  }
});

// =====================================================================
// HYÖTYKUORMA
// =====================================================================

test('hyötykuorma ei koskaan sisällä tunnistetta', () => {
  // Tunnisteet tuottaa sovelluskerros. Jos malli voisi ehdottaa
  // tunnistetta, se voisi ehdottaa olemassa olevan rivin tunnistetta
  // — ja luonnista tulisi päällekirjoitus.
  for (const kind of CAPTURE_KINDS) {
    const payload = payloadFor(normalizeInterpretation({
      kind, title: 'x', confidence: 'high', amountMinor: 100,
      date: '2026-09-11', time: '09:00', destination: 'Keskusta',
      arrivalTime: '10:00', recurrenceType: 'daily', transactionKind: 'expense',
      id: 'PAHA-ID', userId: 'toinen-kayttaja'
    }));
    if (!payload) continue;
    assert.equal('id' in payload, false, `lajin ${kind} hyötykuormassa on id`);
    assert.equal('userId' in payload, false,
      `lajin ${kind} hyötykuormassa on userId`);
    assert.equal('user_id' in payload, false);
  }
});

test('tuntematon laji ei tuota hyötykuormaa', () => {
  assert.equal(payloadFor({ kind: 'kissa' }), null);
});

test('tapahtuman kategoria normalisoidaan suunnan mukaan', () => {
  const meno = payloadFor(normalizeInterpretation({
    kind: CAPTURE_KIND.TRANSACTION, title: 'Ruokakauppa', amountMinor: 1250,
    date: '2026-09-11', transactionKind: 'expense', financeCategory: 'ruoka',
    confidence: 'high'
  }));
  assert.equal(meno.kind, 'expense');
  assert.ok(meno.category);

  const tulo = payloadFor(normalizeInterpretation({
    kind: CAPTURE_KIND.TRANSACTION, title: 'Palkka', amountMinor: 250000,
    date: '2026-09-11', transactionKind: 'income', financeCategory: 'palkka',
    confidence: 'high'
  }));
  assert.equal(tulo.kind, 'income');
  assert.ok(tulo.category);
});

// =====================================================================
// TULKINNAN VALIDOINTI
// =====================================================================

test('matka ilman määränpäätä tai saapumisaikaa ei kelpaa', () => {
  const puuttuu = validateInterpretation(normalizeInterpretation({
    kind: CAPTURE_KIND.TRAVEL, title: 'Hammaslääkäri', confidence: 'high'
  }));
  assert.equal(puuttuu.valid, false);
  assert.ok(puuttuu.errors.destination);
  assert.ok(puuttuu.errors.arrivalTime);
});

test('rutiini ilman toistuvuutta ei kelpaa', () => {
  const { valid, errors } = validateInterpretation(normalizeInterpretation({
    kind: CAPTURE_KIND.ROUTINE, title: 'Aamulenkki', confidence: 'high'
  }));
  assert.equal(valid, false);
  assert.ok(errors.recurrenceType);
});

test('muistutus ilman päivää ei kelpaa', () => {
  const { valid, errors } = validateInterpretation(normalizeInterpretation({
    kind: CAPTURE_KIND.REMINDER, title: 'Soita', confidence: 'high'
  }));
  assert.equal(valid, false);
  assert.ok(errors.date);
});

test('REVIEW_THRESHOLD on keskitaso eikä korkein', () => {
  // Jos kynnys olisi korkein, jokainen tulkinta menisi tarkistukseen
  // ja tarkistuksesta tulisi napin painallus.
  assert.equal(REVIEW_THRESHOLD, CONFIDENCE.MEDIUM);
});
