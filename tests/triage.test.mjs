// Saapuvien deterministinen ehdotus ja erän päätös (src/domain/triage.js).
//
// Tämä päivä on keskiviikko 30.9.2026: viikon loppu on su 4.10., ensi
// maanantai 5.10. Ehdotus ei käytä tekoälyä, joten sama teksti tuottaa
// aina saman tuloksen.
//
// PÄIVÄTÖN SÄÄNTÖ todistetaan kummallakin porttitilalla puhtaana
// funktiona (allowDateless true/false): portti on käännösaikainen, ja
// sovelluskerroksen testi (brain-dump.test.mjs) ajaa sen tilan, joka
// haarassa on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  proposeTriage, planTriageDecision, triageSummary, describeTriageOutcome, categoryFromText,
  waitingFromText, triageHorizonLabel, triageDecisionLabel,
  TRIAGE_EVENT, TRIAGE_DECISION, TRIAGE_DECISIONS, TRIAGE_KEEP_REASON, DATELESS_GATE_HINT
} from '../src/domain/triage.js';
import { TASK_HORIZON, normalizeTask, validateTask } from '../src/domain/task.js';
import { NATURE } from '../src/domain/itemNature.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { readCode } from './helpers/sources.mjs';

const TODAY = '2026-09-30';
const AREAS = [
  normalizeLifeArea({ id: 'koti', name: 'Koti', categoryKey: 'koti', sortOrder: 1 }),
  normalizeLifeArea({ id: 'raha', name: 'Talous', categoryKey: 'talous', sortOrder: 2 }),
  normalizeLifeArea({ id: 'terveys', name: 'Terveys', categoryKey: 'hyvinvointi', kind: 'WELLBEING', sortOrder: 3 }),
  normalizeLifeArea({ id: 'perhe', name: 'Perhe', categoryKey: null, sortOrder: 4 }),
  normalizeLifeArea({ id: 'duuni', name: 'Työ', categoryKey: 'tyo', sortOrder: 5 }),
  normalizeLifeArea({ id: 'soitto', name: 'Musiikki', categoryKey: 'harrastus', kind: 'ENJOYMENT', sortOrder: 6 })
];
const propose = (text, extra = {}) => proposeTriage(text, { areas: AREAS, todayIso: TODAY, ...extra });

// =====================================================================
// HORISONTTI PÄIVÄSTÄ JA VIIKOSTA
// =====================================================================

test('"tänään" -> Tänään, päivä tänään, päiväsana pois otsikosta', () => {
  const p = propose('Lenkki tänään');
  assert.equal(p.horizon, TASK_HORIZON.NOW);
  assert.equal(p.date, TODAY);
  assert.equal(p.title, 'Lenkki');
});

test('"huomenna" -> tällä viikolla (to 1.10.), päivä talteen', () => {
  const p = propose('osta maito huomenna');
  assert.equal(p.horizon, TASK_HORIZON.THIS_WEEK);
  assert.equal(p.date, '2026-10-01');
  assert.equal(p.title, 'Osta maito');
});

test('viikonpäivä tällä viikolla -> THIS_WEEK; ensi viikon päivä -> LATER', () => {
  assert.equal(propose('Imuroi lauantaina').horizon, TASK_HORIZON.THIS_WEEK);
  assert.equal(propose('Imuroi lauantaina').date, '2026-10-03');
  const next = propose('Vie auto katsastukseen maanantaina');
  assert.equal(next.date, '2026-10-05');
  assert.equal(next.horizon, TASK_HORIZON.LATER);
});

test('"tällä viikolla" ilman päivää -> THIS_WEEK ilman päivää', () => {
  const p = propose('siivoa tällä viikolla');
  assert.equal(p.horizon, TASK_HORIZON.THIS_WEEK);
  assert.equal(p.date, null);
  assert.equal(p.title, 'Siivoa');
});

test('"ensi viikolla" -> LATER ilman keksittyä päivää', () => {
  const p = propose('Palaveri ensi viikolla');
  assert.equal(p.horizon, TASK_HORIZON.LATER);
  assert.equal(p.date, null);
});

test('päivä + kellonaika -> meno (EVENT), otsikko samalla jäsentimellä kuin menon luonti', () => {
  const p = propose('Hammaslääkäri perjantaina klo 14');
  assert.equal(p.horizon, TRIAGE_EVENT);
  assert.equal(p.date, '2026-10-02');
  assert.equal(p.time, '14:00');
  assert.equal(p.title, 'Hammaslääkäri');
});

test('kellonaika ilman päivää ei keksi päivää eikä ole meno', () => {
  const p = propose('Kahvit klo 14');
  assert.equal(p.date, null);
  assert.equal(p.time, '14:00');
  assert.notEqual(p.horizon, TRIAGE_EVENT);
  assert.equal(p.title, 'Kahvit klo 14', 'kellonaika jää otsikkoon, kun sitä ei tallenneta');
});

test('epäselvä viikonpäivä (sama kuin tänään) ei tuota päivää', () => {
  const p = propose('Soita pankkiin keskiviikkona');
  assert.equal(p.date, null);
});

// =====================================================================
// ODOTTAMINEN, EPÄRÖINTI JA KIIRE
// =====================================================================

test('"odotan X:ltä" -> WAITING; kaksoispiste-muoto antaa nimen', () => {
  const p = propose('odotan vastausta HSY:ltä');
  assert.equal(p.horizon, TASK_HORIZON.WAITING);
  assert.equal(p.waitingOn, 'HSY');
});

test('"odotan Pekalta" -> taivutettu muoto säilyy (astevaihtelua ei arvata)', () => {
  assert.equal(propose('Odotan Pekalta rahoja').waitingOn, 'Pekalta');
});

test('"kun X vastaa" -> WAITING, X perusmuodossa', () => {
  const p = propose('kun isännöitsijä vastaa, sovi remontti');
  assert.equal(p.horizon, TASK_HORIZON.WAITING);
  assert.equal(p.waitingOn, 'isännöitsijä');
});

test('"X:n vastausta" -> WAITING, odotettava asia nimettynä', () => {
  assert.equal(propose('Odotan Mikan vastausta').waitingOn, 'Mikan vastaus');
  assert.equal(propose('HSY:n päätöstä odotellaan').waitingOn, 'HSY:n päätös');
});

test('pelkkä "odotan" -> WAITING ilman nimeä; "paketti odottaa noutoa" ei ole odotusta', () => {
  const plain = propose('odotan pakettia');
  assert.equal(plain.horizon, TASK_HORIZON.WAITING);
  assert.equal(plain.waitingOn, null);
  assert.notEqual(propose('Paketti odottaa noutoa').horizon, TASK_HORIZON.WAITING);
  assert.equal(waitingFromText('Soita Mikalle').waiting, false);
});

test('odotus voittaa päivän; päivästä tulee tarkistuspäivä', () => {
  const p = propose('Odotan Mikan vastausta perjantaina');
  assert.equal(p.horizon, TASK_HORIZON.WAITING);
  assert.equal(p.followUpDate, '2026-10-02');
});

test('"joskus", "ehkä", "jos ehdin" -> NOT_YET, myös päivän ja kellonajan kanssa', () => {
  for (const text of ['Joskus voisi opetella kitaraa', 'ehkä uusi matto', 'Jos ehdin, leivo pullaa',
    'Ehkä leffaan perjantaina klo 18']) {
    assert.equal(propose(text).horizon, TASK_HORIZON.NOT_YET, text);
  }
});

test('"ei kiire" -> LATER; "heti" -> NOW', () => {
  assert.equal(propose('Ikkunat, ei kiire').horizon, TASK_HORIZON.LATER);
  assert.equal(propose('Kirjoita raportti heti').horizon, TASK_HORIZON.NOW);
});

test('ei vihjettä -> horisontti null ("Päätä myöhemmin")', () => {
  const p = propose('jotain epämääräistä');
  assert.equal(p.horizon, null);
  assert.ok(p.reasons.includes('Päätä myöhemmin'));
  assert.equal(triageHorizonLabel(null), 'Päätä myöhemmin');
  assert.match(triageSummary(p, { areas: AREAS }), /^Ehdotus: Päätä myöhemmin · Arjen ylläpito$/);
});

// =====================================================================
// KATEGORIA, ALUE JA LUONNE
// =====================================================================

test('lasku / maksa -> talous, velvoite, alueen omistaja', () => {
  for (const text of ['Maksa sähkölasku', 'vakuutuksen eräpäivä', 'Laskut']) {
    const p = propose(text);
    assert.equal(p.categoryKey, 'talous', text);
    assert.equal(p.areaId, 'raha', text);
    assert.equal(p.nature, NATURE.OBLIGATION, text);
  }
});

test('sali / lenkki / uni -> hyvinvointi; hyvinvointialue antaa luonteen', () => {
  for (const text of ['Salille illalla', 'lenkki', 'Enemmän unta']) {
    const p = propose(text);
    assert.equal(p.categoryKey, 'hyvinvointi', text);
    assert.equal(p.areaId, 'terveys', text);
    assert.equal(p.nature, NATURE.WELLBEING, text);
  }
  // "uni" on kokonainen sana: "universumi" ei ole hyvinvointia.
  assert.notEqual(categoryFromText('universumi-dokkari')?.categoryKey, 'hyvinvointi');
});

test('harrastussanat -> harrastus ja ilo', () => {
  const p = propose('Kitaratunti');
  assert.equal(p.categoryKey, 'harrastus');
  assert.equal(p.areaId, 'soitto');
  assert.equal(p.nature, NATURE.ENJOYMENT);
});

test('siivoa / pyykit -> koti ja arjen ylläpito', () => {
  for (const text of ['siivoa kylpyhuone', 'Pyykit koneeseen']) {
    const p = propose(text);
    assert.equal(p.categoryKey, 'koti', text);
    assert.equal(p.nature, NATURE.MAINTENANCE, text);
  }
});

test('työsanat -> työ ja velvoite', () => {
  const p = propose('Valmistele palaveri');
  assert.equal(p.categoryKey, 'tyo');
  assert.equal(p.areaId, 'duuni');
  assert.equal(p.nature, NATURE.OBLIGATION);
});

test('jaettu kategoria: aktiivinen, pienin järjestys voittaa; passiivinen ei', () => {
  const areas = [
    normalizeLifeArea({ id: 'b', name: 'Kakkoskoti', categoryKey: 'koti', sortOrder: 2 }),
    normalizeLifeArea({ id: 'a', name: 'Koti', categoryKey: 'koti', sortOrder: 1, active: false }),
    normalizeLifeArea({ id: 'c', name: 'Mökki', categoryKey: 'koti', sortOrder: 3 })
  ];
  assert.equal(proposeTriage('imuroi', { areas, todayIso: TODAY }).areaId, 'b');
});

test('alueen nimi tekstissä kelpaa, kun kategoriaa ei ole', () => {
  const p = propose('Perheen kanssa retki');
  assert.equal(p.areaId, 'perhe');
});

test('tavoitteen otsikko tekstissä -> tavoitteen askel', () => {
  const p = proposeTriage('Maratonin kuntosuunnitelma', {
    areas: [], todayIso: TODAY, goals: [{ id: 'g1', title: 'Maraton', status: 'active' }, { id: 'g2', title: 'Kitara', status: 'paused' }]
  });
  assert.equal(p.goalId, 'g1');
  assert.equal(p.nature, NATURE.GOAL_ACTION);
  assert.equal(proposeTriage('kitaraa', { goals: [{ id: 'g2', title: 'Kitara', status: 'paused' }] }).goalId, null,
    'tauolla oleva tavoite ei saa askelia ehdotuksena');
});

test('ilman tätä päivää päiviä ei jäsennetä (ei kelloa domainissa)', () => {
  const p = proposeTriage('Hammaslääkäri perjantaina klo 14', { areas: AREAS });
  assert.equal(p.date, null);
  assert.equal(p.horizon, null);
});

test('ehdotus on deterministinen ja moduuli puhdas', () => {
  const first = JSON.stringify(propose('Maksa sähkölasku huomenna'));
  for (let i = 0; i < 50; i += 1) assert.equal(JSON.stringify(propose('Maksa sähkölasku huomenna')), first);
  const source = readCode('src/domain/triage.js');
  for (const forbidden of ['Date.now', 'new Date(', 'Math.random', 'fetch(', 'document', 'localStorage']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('tyhjä ja kelvoton syöte eivät kaada', () => {
  for (const value of [null, undefined, '', '   ', 42, {}]) {
    const p = proposeTriage(value, { areas: AREAS, todayIso: TODAY });
    assert.equal(p.horizon, null);
  }
});

// =====================================================================
// YHDEN RIVIN YHTEENVETO
// =====================================================================

test('yhteenveto on yksi lyhyt rivi: horisontti · alue · luonne', () => {
  assert.equal(triageSummary(propose('siivoa tällä viikolla'), { areas: AREAS }),
    'Ehdotus: Tällä viikolla · Koti · Arjen ylläpito');
  assert.equal(triageSummary(propose('Hammaslääkäri perjantaina klo 14'), { areas: AREAS }),
    'Ehdotus: Meno pe 2.10. klo 14:00 · Terveys · Hyvinvointi');
  assert.equal(triageSummary(propose('Odotan Mikan vastausta'), { areas: AREAS }),
    'Ehdotus: Odottaa: Mikan vastaus · Arjen ylläpito');
  assert.equal(triageSummary(propose('osta maito huomenna'), { areas: AREAS }),
    'Ehdotus: Tällä viikolla (to 1.10.) · Koti · Arjen ylläpito');
  assert.equal(triageSummary(propose('Soita äidille'), { areas: [] }), 'Ehdotus: Päätä myöhemmin · Perhe · Arjen ylläpito');
});

// =====================================================================
// PÄÄTÖS -> DOMAIN-RIVI, KUMMALLAKIN PORTTITILALLA
// =====================================================================

const plan = (text, decision, extra = {}) => planTriageDecision(text, decision, {
  proposal: propose(text), areas: AREAS, todayIso: TODAY, ...extra
});

test('PORTTI KIINNI: päivättömät päätökset jättävät rivin Saapuviin, ei keksittyä päivää', () => {
  for (const decision of [TRIAGE_DECISION.THIS_WEEK, TRIAGE_DECISION.LATER, TRIAGE_DECISION.NOT_YET, TRIAGE_DECISION.WAITING]) {
    const result = plan('siivoa kylpyhuone', decision, { allowDateless: false });
    assert.deepEqual(result, { action: 'keep', reason: TRIAGE_KEEP_REASON.DATELESS_GATE }, decision);
  }
});

test('PORTTI KIINNI: Tänään = päivä tänään; Menoksi ja Hylkää toimivat', () => {
  const now = plan('siivoa kylpyhuone', TRIAGE_DECISION.NOW, { allowDateless: false });
  assert.equal(now.action, 'task');
  assert.equal(now.payload.date, TODAY);
  assert.equal(now.payload.horizon, undefined, 'erä ei pinnaa fokukseen: horisontti johdetaan päivästä');
  assert.equal(now.payload.category, 'koti');
  assert.equal(validateTask(normalizeTask(now.payload), { allowDateless: false }).valid, true);

  const event = plan('Hammaslääkäri perjantaina klo 14', TRIAGE_DECISION.EVENT, { allowDateless: false });
  assert.equal(event.action, 'event');
  assert.deepEqual([event.payload.title, event.payload.date, event.payload.startTime, event.payload.allDay],
    ['Hammaslääkäri', '2026-10-02', '14:00', false]);
  assert.deepEqual(plan('mitä vain', TRIAGE_DECISION.DISMISS, { allowDateless: false }), { action: 'dismiss' });
});

test('PORTTI AUKI: päivätön horisontti tallentuu ilman päivää ja läpäisee validoinnin', () => {
  for (const decision of [TRIAGE_DECISION.THIS_WEEK, TRIAGE_DECISION.LATER, TRIAGE_DECISION.NOT_YET]) {
    const result = plan('siivoa kylpyhuone', decision, { allowDateless: true });
    assert.equal(result.action, 'task', decision);
    assert.equal(result.payload.date, null, decision);
    assert.equal(result.payload.horizon, decision);
    assert.equal(validateTask(normalizeTask(result.payload), { allowDateless: true }).valid, true, decision);
  }
});

test('PORTTI AUKI: Odottaa… käyttää annettua tekstiä, muuten ehdotusta; tarkistuspäivä ehdotuksesta', () => {
  const own = plan('Odotan Mikan vastausta perjantaina', TRIAGE_DECISION.WAITING, { allowDateless: true, waitingOn: '  Mika  ' });
  assert.equal(own.payload.horizon, TASK_HORIZON.WAITING);
  assert.equal(own.payload.waitingOn, 'Mika');
  assert.equal(own.payload.followUpDate, '2026-10-02');
  const fallback = plan('Odotan Mikan vastausta', TRIAGE_DECISION.WAITING, { allowDateless: true, waitingOn: '' });
  assert.equal(fallback.payload.waitingOn, 'Mikan vastaus');
  const task = normalizeTask(fallback.payload);
  assert.equal(task.waitingOn, 'Mikan vastaus');
  assert.equal(validateTask(task, { allowDateless: true }).valid, true);
});

test('Menoksi vaatii päivän: ilman päivää rivi jää Saapuviin', () => {
  assert.deepEqual(plan('Kahvit klo 14', TRIAGE_DECISION.EVENT, { allowDateless: true }),
    { action: 'keep', reason: TRIAGE_KEEP_REASON.NO_DATE });
  const allDay = plan('Mummon synttärit lauantaina', TRIAGE_DECISION.EVENT, { allowDateless: false });
  assert.equal(allDay.action, 'event');
  assert.equal(allDay.payload.allDay, true);
  assert.equal(allDay.payload.startTime, null);
});

test('Tänään säilyttää kellonajan vain, kun ehdotuksen päivä on tänään', () => {
  assert.equal(plan('Soita pankkiin tänään klo 10', TRIAGE_DECISION.NOW).payload.time, '10:00');
  const moved = plan('Hammaslääkäri perjantaina klo 14', TRIAGE_DECISION.NOW);
  assert.equal(moved.payload.date, TODAY);
  assert.equal(moved.payload.time, null, 'toisen päivän kellonaikaa ei siirretä tälle päivälle');
});

test('rivin aluevalinta ratkaisee kategorian; "Ei aluetta" pitää sanojen kategorian', () => {
  assert.equal(plan('siivoa kylpyhuone', TRIAGE_DECISION.NOW, { areaId: 'duuni' }).payload.category, 'tyo');
  assert.equal(plan('siivoa kylpyhuone', TRIAGE_DECISION.NOW, { areaId: 'perhe' }).payload.category, 'muu',
    'kategoriaton alue: ei väärää kategoriaa');
  assert.equal(plan('siivoa kylpyhuone', TRIAGE_DECISION.NOW, { areaId: null }).payload.category, 'koti');
  assert.equal(plan('jotain', TRIAGE_DECISION.NOW).payload.category, 'muu');
});

test('tavoitteen askel kulkee tehtävälle ja menolle', () => {
  const proposal = proposeTriage('Maratonin lenkki tänään', { todayIso: TODAY, goals: [{ id: 'g1', title: 'Maraton' }] });
  const result = planTriageDecision('Maratonin lenkki tänään', TRIAGE_DECISION.NOW, { proposal, todayIso: TODAY });
  assert.equal(result.payload.goalId, 'g1');
});

test('tuntematon päätös ei tee mitään', () => {
  assert.equal(plan('siivoa', 'DELETE_ALL').action, 'keep');
  assert.deepEqual([...TRIAGE_DECISIONS].sort(), ['DISMISS', 'EVENT', 'LATER', 'NOT_YET', 'NOW', 'THIS_WEEK', 'WAITING']);
  assert.equal(triageDecisionLabel(TRIAGE_DECISION.EVENT), 'Menoksi');
});

test('KRIITTINEN: kiinni olevalla portilla mikään päätös ei tuota keksittyä päivää', () => {
  const texts = ['siivoa', 'osta maito huomenna', 'Odotan Mikan vastausta perjantaina', 'Palaveri ensi viikolla',
    'Hammaslääkäri perjantaina klo 14', 'joskus kitara'];
  for (const text of texts) {
    const proposal = propose(text);
    for (const decision of TRIAGE_DECISIONS) {
      const result = planTriageDecision(text, decision, { proposal, areas: AREAS, todayIso: TODAY, allowDateless: false });
      if (!result.payload) continue;
      const allowed = decision === TRIAGE_DECISION.NOW ? TODAY : proposal.date;
      assert.equal(result.payload.date, allowed, `${text} / ${decision}`);
    }
  }
});

// =====================================================================
// LOPPUTULOS SANOIKSI
// =====================================================================

test('lopputulos: siirrot, menot, hylkäykset ja rehellinen porttivihje', () => {
  assert.equal(describeTriageOutcome({ decision: TRIAGE_DECISION.THIS_WEEK, converted: [{ id: 'a' }, { id: 'b' }] }),
    'Siirretty 2 asiaa: Tällä viikolla.');
  assert.equal(describeTriageOutcome({ decision: TRIAGE_DECISION.EVENT, converted: [{ id: 'a' }] }),
    'Lisätty kalenteriin: 1 meno.');
  assert.equal(describeTriageOutcome({ decision: TRIAGE_DECISION.DISMISS, dismissed: 3 }),
    'Hylätty 3 asiaa. Voit palauttaa ne käsitellyistä.');
  const gate = describeTriageOutcome({ decision: TRIAGE_DECISION.LATER, kept: [{ id: 'a', reason: TRIAGE_KEEP_REASON.DATELESS_GATE }] });
  assert.equal(gate, `${DATELESS_GATE_HINT} Asia on tallessa Saapuvissa.`);
  assert.match(gate, /Päivätön tallennus tulee käyttöön, kun palvelin on päivitetty \(migraatio 0015\)\./);
  assert.match(describeTriageOutcome({ decision: TRIAGE_DECISION.EVENT, kept: [{ id: 'a', reason: TRIAGE_KEEP_REASON.NO_DATE }] }),
    /Menoksi sopii vain asia, jolla on päivä\. 1 asia jäi Saapuviin\./);
  assert.match(describeTriageOutcome({ decision: TRIAGE_DECISION.NOW, failed: [{ id: 'a' }, { id: 'b' }] }),
    /2 asiaa ei tallentunut\. Ne ovat yhä Saapuvissa\./);
  assert.equal(describeTriageOutcome({ decision: TRIAGE_DECISION.NOW }), '');
});

test('sävy: ei syyllistäviä sanoja lopputuloksissa eikä ehdotuksissa', () => {
  const source = readCode('src/domain/triage.js');
  for (const word of ['myöhässä', 'laiminlyö', 'epäonnistuit', 'pitäisi']) {
    assert.equal(source.toLocaleLowerCase('fi').includes(word), false, word);
  }
});
