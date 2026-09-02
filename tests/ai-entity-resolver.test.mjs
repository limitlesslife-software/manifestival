// Kohteen tunnistuksen testit.
//
// Tämä on AI-putken vaarallisin kohta. Väärin tunnistettu kohde tarkoittaa
// väärän tiedon muuttamista, ja käyttäjä huomaa sen vasta myöhemmin — jos
// koskaan. Siksi testit painottuvat siihen, MILLOIN resolver kieltäytyy.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESOLUTION, MAX_CANDIDATES, normalizeForMatch, resolveByName, resolveTarget,
  openTasksOnly, unpaidBillsOnly, describeResolution
} from '../src/ai/entityResolver.js';

const task = (id, title, extra = {}) => ({ id, title, completed: false, ...extra });

// ------------------------------------------------------------ normalisointi

test('normalisointi siistii välit ja kirjainkoon', () => {
  assert.equal(normalizeForMatch('  Soita   Matille  '), 'soita matille');
  assert.equal(normalizeForMatch('SOITA MATILLE'), 'soita matille');
  assert.equal(normalizeForMatch(null), '');
  assert.equal(normalizeForMatch(undefined), '');
  assert.equal(normalizeForMatch(''), '');
});

test('unicode normalisoidaan, jotta yhdistetty ja hajotettu muoto vastaavat', () => {
  // "ä" voi olla yksi koodipiste tai a + yhdistyvä treema. Käyttäjä ei näe
  // eroa, joten resolverin ei pidä nähdä sitäkään.
  // Muodot rakennetaan koodipisteistä eikä kirjoiteta kirjaimina:
  // lähdetiedosto voi normalisoitua editorissa, jolloin testi vertaisi
  // vahingossa samaa merkkijonoa itseensä ja menisi läpi todistamatta mitään.
  const composed = 'Hämeenkatu';       // ä yhtenä koodipisteenä
  const decomposed = 'Hämeenkatu';    // a + yhdistyvä treema
  assert.notEqual(composed, decomposed, 'testidata ei ole erilaista');
  assert.equal(normalizeForMatch(composed), normalizeForMatch(decomposed));
});

test('KRIITTINEN: ä, ö ja å eivät taitu a:ksi ja o:ksi', () => {
  // Suomessa ne ovat omia kirjaimiaan. Taittaminen tekisi sanoista "sää" ja
  // "saa" saman kohteen — ja mutaatio osuisi väärään tehtävään.
  assert.notEqual(normalizeForMatch('sää'), normalizeForMatch('saa'));
  assert.notEqual(normalizeForMatch('työ'), normalizeForMatch('tyo'));
  assert.notEqual(normalizeForMatch('måndag'), normalizeForMatch('mandag'));
});

// ------------------------------------------------------------------- EXACT

test('yksiselitteinen nimi tunnistetaan', () => {
  const result = resolveByName({
    entities: [task('t1', 'Soita Matille'), task('t2', 'Osta maitoa')],
    query: 'Soita Matille',
    entityType: 'task'
  });

  assert.equal(result.status, RESOLUTION.EXACT);
  assert.equal(result.match.id, 't1');
  assert.equal(result.tier, 'exact');
});

test('kirjainkoko ja ylimääräiset välit eivät estä tunnistusta', () => {
  for (const query of ['soita matille', 'SOITA MATILLE', '  Soita   Matille ']) {
    const result = resolveByName({
      entities: [task('t1', 'Soita Matille')], query, entityType: 'task'
    });
    assert.equal(result.status, RESOLUTION.EXACT, query);
  }
});

test('osittainen nimi riittää, jos se on yksiselitteinen', () => {
  const result = resolveByName({
    entities: [task('t1', 'Soita Matille asiasta'), task('t2', 'Osta maitoa')],
    query: 'Soita',
    entityType: 'task'
  });
  assert.equal(result.status, RESOLUTION.EXACT);
  assert.equal(result.match.id, 't1');
  assert.equal(result.tier, 'prefix');
});

test('täsmällinen osuma voittaa osittaiset', () => {
  // Ilman osumatasoja "Osta maitoa" olisi epäselvä aina kun pidempi
  // versio on olemassa — ja käyttäjä ei saisi koskaan tehtyä mitään.
  const result = resolveByName({
    entities: [
      task('t1', 'Osta maitoa'),
      task('t2', 'Osta maitoa ja leipää'),
      task('t3', 'Osta maitoa kaupasta')
    ],
    query: 'Osta maitoa',
    entityType: 'task'
  });

  assert.equal(result.status, RESOLUTION.EXACT);
  assert.equal(result.match.id, 't1');
  assert.equal(result.tier, 'exact');
});

test('nimi luetaan myös name-kentästä', () => {
  const result = resolveByName({
    entities: [{ id: 'p1', name: 'Autotallin remontti' }],
    query: 'Autotallin remontti',
    entityType: 'project'
  });
  assert.equal(result.status, RESOLUTION.EXACT);
  assert.equal(result.match.label, 'Autotallin remontti');
});

// --------------------------------------------------------------- AMBIGUOUS

test('KRIITTINEN: sama nimi eri päivinä on epäselvä', () => {
  // Tämä on se tapaus, jossa arvaaminen muuttaisi väärää tietoa.
  const result = resolveByName({
    entities: [
      task('t1', 'Lääkäriaika', { date: '2026-03-10' }),
      task('t2', 'Lääkäriaika', { date: '2026-03-17' })
    ],
    query: 'Lääkäriaika',
    entityType: 'task'
  });

  assert.equal(result.status, RESOLUTION.AMBIGUOUS);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.match, undefined, 'epäselvässä ei saa olla valittua kohdetta');
  assert.deepEqual(result.candidates.map(c => c.date), ['2026-03-10', '2026-03-17']);
});

test('sama nimi eri projekteissa on epäselvä', () => {
  const result = resolveByName({
    entities: [
      task('t1', 'Palaveri', { projectId: 'p1' }),
      task('t2', 'Palaveri', { projectId: 'p2' })
    ],
    query: 'Palaveri',
    entityType: 'task'
  });
  assert.equal(result.status, RESOLUTION.AMBIGUOUS);
});

test('osittainen nimi, joka osuu useaan, on epäselvä', () => {
  const result = resolveByName({
    entities: [
      task('t1', 'Osta maitoa'),
      task('t2', 'Osta leipää'),
      task('t3', 'Osta juustoa')
    ],
    query: 'Osta',
    entityType: 'task'
  });

  assert.equal(result.status, RESOLUTION.AMBIGUOUS);
  assert.equal(result.candidates.length, 3);
});

test('vaihtoehtojen määrä rajataan mutta kokonaismäärä kerrotaan', () => {
  const entities = Array.from({ length: 12 }, (unused, index) =>
    task('t' + index, 'Osta tavaraa ' + index));

  const result = resolveByName({ entities, query: 'Osta', entityType: 'task' });

  assert.equal(result.status, RESOLUTION.AMBIGUOUS);
  assert.equal(result.candidates.length, MAX_CANDIDATES);
  assert.equal(result.totalMatches, 12, 'käyttäjälle pitää kertoa todellinen määrä');
});

test('vaihtoehtojen järjestys on deterministinen', () => {
  const entities = [
    task('t3', 'Osta juustoa'), task('t1', 'Osta maitoa'), task('t2', 'Osta leipää')
  ];
  const first = resolveByName({ entities, query: 'Osta', entityType: 'task' });
  const second = resolveByName({ entities: [...entities].reverse(), query: 'Osta', entityType: 'task' });

  assert.deepEqual(first.candidates.map(c => c.id), second.candidates.map(c => c.id));
});

// --------------------------------------------------------------- NOT_FOUND

test('tuntematon nimi ei osu mihinkään', () => {
  const result = resolveByName({
    entities: [task('t1', 'Soita Matille')],
    query: 'Osta auto',
    entityType: 'task'
  });
  assert.equal(result.status, RESOLUTION.NOT_FOUND);
  assert.deepEqual(result.candidates, []);
});

test('KRIITTINEN: tyhjä hakusana ei osu koskaan mihinkään', () => {
  // Tyhjä merkkijono sisältyy JOKAISEEN merkkijonoon. Ilman tätä torjuntaa
  // "poista" ilman kohdetta osuisi kaikkiin tehtäviin kerralla.
  for (const query of ['', '   ', null, undefined]) {
    const result = resolveByName({
      entities: [task('t1', 'A'), task('t2', 'B')],
      query,
      entityType: 'task'
    });
    assert.equal(result.status, RESOLUTION.NOT_FOUND, JSON.stringify(query));
    assert.deepEqual(result.candidates, []);
  }
});

test('kirjoitusvirhe ei osu — sumeaa hakua ei ole tarkoituksella', () => {
  // Sumea haku arvaisi, ja arvaus mutaatiossa on juuri se mitä ei haluta.
  const result = resolveByName({
    entities: [task('t1', 'Soita Matille')],
    query: 'Sotia Matille',
    entityType: 'task'
  });
  assert.equal(result.status, RESOLUTION.NOT_FOUND);
});

test('tyhjä joukko ei kaadu', () => {
  assert.equal(resolveByName({ entities: [], query: 'mitä vain' }).status, RESOLUTION.NOT_FOUND);
  assert.equal(resolveByName({ query: 'mitä vain' }).status, RESOLUTION.NOT_FOUND);
});

test('tunnisteeton rivi ohitetaan', () => {
  const result = resolveByName({
    entities: [{ title: 'Ilman tunnistetta' }, task('t1', 'Ilman tunnistetta')],
    query: 'Ilman tunnistetta',
    entityType: 'task'
  });
  assert.equal(result.status, RESOLUTION.EXACT);
  assert.equal(result.match.id, 't1');
});

// ------------------------------------------------------------- suodattimet

test('valmis tehtävä rajataan pois mutaation kohteista', () => {
  const result = resolveByName({
    entities: [
      task('t1', 'Soita Matille', { completed: true }),
      task('t2', 'Soita Matille', { completed: false })
    ],
    query: 'Soita Matille',
    entityType: 'task',
    filter: openTasksOnly
  });

  assert.equal(result.status, RESOLUTION.EXACT, 'suodatus poisti epäselvyyden');
  assert.equal(result.match.id, 't2');
});

test('pelkkä valmis tehtävä ei löydy avoimista', () => {
  const result = resolveByName({
    entities: [task('t1', 'Soita Matille', { completed: true })],
    query: 'Soita Matille',
    entityType: 'task',
    filter: openTasksOnly
  });
  assert.equal(result.status, RESOLUTION.NOT_FOUND);
});

test('maksettu ja peruttu lasku rajataan pois', () => {
  const bills = [
    { id: 'b1', name: 'Sähkölasku', status: 'paid' },
    { id: 'b2', name: 'Sähkölasku', status: 'cancelled' },
    { id: 'b3', name: 'Sähkölasku', status: 'upcoming' }
  ];
  const result = resolveByName({
    entities: bills, query: 'Sähkölasku', entityType: 'bill', filter: unpaidBillsOnly
  });

  assert.equal(result.status, RESOLUTION.EXACT);
  assert.equal(result.match.id, 'b3');
});

// ------------------------------------------------------- tunniste vs. nimi

test('tunniste voittaa nimen', () => {
  const result = resolveTarget({
    entities: [task('t1', 'Eka'), task('t2', 'Toka')],
    id: 't2',
    name: 'Eka',
    entityType: 'task'
  });
  assert.equal(result.status, RESOLUTION.EXACT);
  assert.equal(result.match.id, 't2');
  assert.equal(result.tier, 'id');
});

test('tuntematon tunniste ei putoa nimihakuun', () => {
  // Jos tunniste on annettu mutta ei löydy, nimeen turvautuminen voisi osua
  // aivan eri riviin kuin mitä pyydettiin.
  const result = resolveTarget({
    entities: [task('t1', 'Eka')],
    id: 'olematon',
    name: 'Eka',
    entityType: 'task'
  });
  assert.equal(result.status, RESOLUTION.NOT_FOUND);
});

test('ilman tunnistetta käytetään nimeä', () => {
  const result = resolveTarget({
    entities: [task('t1', 'Eka')], name: 'Eka', entityType: 'task'
  });
  assert.equal(result.status, RESOLUTION.EXACT);
});

test('tyhjä tunniste ei kelpaa tunnisteeksi', () => {
  const result = resolveTarget({
    entities: [task('t1', 'Eka')], id: '   ', name: 'Eka', entityType: 'task'
  });
  assert.equal(result.status, RESOLUTION.EXACT, 'pitäisi pudota nimihakuun');
  assert.equal(result.tier, 'exact');
});

// ------------------------------------------------------------- kuvaukset

test('tunnistuksen tulos selitetään käyttäjälle ymmärrettävästi', () => {
  const notFound = resolveByName({ entities: [], query: 'Kadonnut', entityType: 'task' });
  assert.match(describeResolution(notFound), /Kadonnut/);

  const ambiguous = resolveByName({
    entities: [task('t1', 'Sama'), task('t2', 'Sama')], query: 'Sama', entityType: 'task'
  });
  assert.match(describeResolution(ambiguous), /2 vaihtoehtoa/);

  const exact = resolveByName({ entities: [task('t1', 'Yksi')], query: 'Yksi', entityType: 'task' });
  assert.match(describeResolution(exact), /Yksi/);

  assert.equal(typeof describeResolution(null), 'string');
});
