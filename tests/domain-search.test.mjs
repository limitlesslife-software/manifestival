// Haun testit.
//
// Haku ei muuta mitään, joten se saa olla anteliaampi kuin AI:n kohteen
// tunnistus. Testit varmistavat sekä hyödyllisyyden että sen, ettei
// käyttäjän kirjoittama teksti voi kaataa hakua tai vuotaa merkintään.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEARCH_TYPE, SEARCH_TYPES, MAX_RESULTS_PER_TYPE, MIN_QUERY_LENGTH,
  normalizeForSearch, searchCollection, searchAll, bestMatch, searchTypeLabel
} from '../src/domain/search.js';

const collections = {
  tasks: [
    { id: 't1', title: 'Soita Matille', description: null },
    { id: 't2', title: 'Osta maitoa', description: 'kaupasta' },
    { id: 't3', title: 'Maalaa aita', description: null }
  ],
  routines: [{ id: 'r1', title: 'Aamulääkkeet' }],
  goals: [{ id: 'g1', title: 'Julkaise Manifestival' }],
  projects: [{ id: 'p1', name: 'Autotallin remontti' }],
  bills: [{ id: 'b1', name: 'Sähkölasku' }]
};

// ------------------------------------------------------------ normalisointi

test('haku ei välitä kirjainkoosta eikä ylimääräisistä väleistä', () => {
  assert.equal(normalizeForSearch('  Soita   MATILLE '), 'soita matille');
  assert.equal(normalizeForSearch(null), '');
  assert.equal(normalizeForSearch(undefined), '');
});

test('haku sietää diakriittien puuttumisen', () => {
  // Tämä on TIETOINEN ERO entityResolveriin: haku ei muuta mitään, joten
  // anteliaisuus on hyödyllistä. Resolverissa sama taitto olisi vaarallista.
  assert.equal(normalizeForSearch('ääni'), normalizeForSearch('aani'));
  assert.equal(normalizeForSearch('Sähkölasku'), normalizeForSearch('sahkolasku'));
  assert.equal(normalizeForSearch('työ'), normalizeForSearch('tyo'));
});

test('diakriittitön haku löytää ääkkösellisen', () => {
  const results = searchCollection({
    entities: collections.bills, query: 'sahko', type: SEARCH_TYPE.BILL
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'b1');
});

// ------------------------------------------------------------- osumat

test('täsmällinen osuma on ensimmäisenä', () => {
  const results = searchCollection({
    entities: [
      { id: 'a', title: 'Maito ja leipä' },
      { id: 'b', title: 'Maito' },
      { id: 'c', title: 'Osta maito' }
    ],
    query: 'Maito',
    type: SEARCH_TYPE.TASK
  });

  assert.equal(results[0].id, 'b', 'täsmällinen ensin');
  assert.equal(results[1].id, 'a', 'alkuosuma ennen sanaosumaa');
});

test('osuma kuvauksessa on vähemmän merkittävä kuin otsikossa', () => {
  const results = searchCollection({
    entities: [
      { id: 'a', title: 'Kaupassa käynti', description: null },
      { id: 'b', title: 'Osta maitoa', description: 'kaupassa' }
    ],
    query: 'kaupassa',
    type: SEARCH_TYPE.TASK
  });

  assert.equal(results[0].id, 'a', 'otsikko-osuma ensin');
  assert.ok(results[0].score > results[1].score);
});

test('haku palauttaa korostuksen indekseinä eikä merkintänä', () => {
  // HTML:n palauttaminen hausta olisi XSS-reitti. Käyttöliittymä
  // escapettaa ensin ja korostaa vasta sitten.
  const [result] = searchCollection({
    entities: [{ id: 't1', title: 'Osta maitoa' }],
    query: 'maito',
    type: SEARCH_TYPE.TASK
  });

  assert.equal(result.matchIndex, 5);
  assert.equal(result.matchLength, 5);
  assert.equal(result.label.includes('<'), false);
  assert.equal(typeof result.matchIndex, 'number');
});

test('tulosten määrä on rajattu tyyppiä kohti', () => {
  const many = Array.from({ length: 30 }, (unused, index) =>
    ({ id: 't' + index, title: 'Tehtävä ' + index }));

  const results = searchCollection({ entities: many, query: 'Tehtävä', type: SEARCH_TYPE.TASK });
  assert.equal(results.length, MAX_RESULTS_PER_TYPE);
});

test('järjestys on deterministinen', () => {
  const entities = [
    { id: 'c', title: 'Osta juustoa' },
    { id: 'a', title: 'Osta maitoa' },
    { id: 'b', title: 'Osta leipää' }
  ];

  const first = searchCollection({ entities, query: 'Osta', type: SEARCH_TYPE.TASK });
  const second = searchCollection({
    entities: [...entities].reverse(), query: 'Osta', type: SEARCH_TYPE.TASK
  });

  assert.deepEqual(first.map(r => r.id), second.map(r => r.id));
});

// ------------------------------------------------------------- rajaukset

test('liian lyhyt hakusana ei tuota tuloksia', () => {
  // Yksi merkki osuisi lähes kaikkeen eikä kertoisi mitään.
  const result = searchAll({ query: 'a', collections });
  assert.equal(result.tooShort, true);
  assert.equal(result.total, 0);
  assert.deepEqual(result.groups, []);
  assert.ok(MIN_QUERY_LENGTH >= 2);
});

test('tyhjä hakusana ei osu mihinkään', () => {
  for (const query of ['', '   ', null, undefined]) {
    const result = searchAll({ query, collections });
    assert.equal(result.total, 0, JSON.stringify(query));
  }
});

test('tunnisteeton rivi ohitetaan', () => {
  const results = searchCollection({
    entities: [{ title: 'Ilman tunnistetta' }, { id: 't1', title: 'Ilman tunnistetta' }],
    query: 'Ilman',
    type: SEARCH_TYPE.TASK
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 't1');
});

test('tuntematon tietotyyppi ei kaada hakua', () => {
  assert.deepEqual(searchCollection({
    entities: [{ id: 'x', title: 'X' }], query: 'X', type: 'tuntematon'
  }), []);
});

// ------------------------------------------------------------ turvallisuus

test('KRIITTINEN: hakusana ei päädy säännölliseksi lausekkeeksi', () => {
  // Käyttäjän kirjoittama "(" kaataisi haun ja "(a+)+$" jumittaisi
  // selaimen (ReDoS). Vertailu tehdään merkkijono-operaatioilla.
  const dangerous = [
    '(', ')', '[', ']', '{', '}', '*', '+', '?', '|', '^', '$', '\\',
    '(a+)+$', '.*.*.*.*.*', '[a-z]{1000}', '\\u0000'
  ];

  for (const query of dangerous) {
    assert.doesNotThrow(
      () => searchAll({ query, collections }),
      'kaatui hakusanalla: ' + query);
  }
});

test('KRIITTINEN: haku ei palauta HTML:ää', () => {
  const xss = { id: 'x1', title: '<img src=x onerror=alert(1)>', description: '<script>' };
  const [result] = searchCollection({
    entities: [xss], query: 'img', type: SEARCH_TYPE.TASK
  });

  // Teksti palautetaan sellaisenaan — escapetus on käyttöliittymän vastuu.
  // Olennaista on, ettei haku LISÄÄ merkintää tekstin ympärille.
  assert.equal(result.label, xss.title);
  assert.equal(result.label.includes('<mark>'), false);
  assert.equal(result.label.includes('<b>'), false);
  assert.equal('html' in result, false);
});

test('erikoismerkit hakusanassa löytävät itsensä', () => {
  const results = searchCollection({
    entities: [{ id: 't1', title: 'Laske 2 + 2' }],
    query: '2 + 2',
    type: SEARCH_TYPE.TASK
  });
  assert.equal(results.length, 1);
});

// ------------------------------------------------------- yhdistetty haku

test('haku kattaa kaikki tietotyypit ja ryhmittelee ne', () => {
  const result = searchAll({ query: 'ma', collections });

  assert.equal(result.tooShort, false);
  assert.ok(result.groups.length > 0);

  for (const group of result.groups) {
    assert.ok(SEARCH_TYPES.includes(group.type), group.type);
    assert.ok(group.label.length > 0);
    assert.ok(group.results.length > 0);
  }
});

test('ryhmät järjestyvät parhaan osuman mukaan', () => {
  // Käyttäjä odottaa relevanteinta ylimmäs, ei aina tehtäviä ensin.
  const result = searchAll({
    query: 'Sähkölasku',
    collections: {
      tasks: [{ id: 't1', title: 'Maksa sähkölasku joskus' }],
      bills: [{ id: 'b1', name: 'Sähkölasku' }]
    }
  });

  assert.equal(result.groups[0].type, SEARCH_TYPE.BILL, 'täsmällinen osuma ensin');
});

test('tyhjät ryhmät jätetään pois', () => {
  const result = searchAll({
    query: 'Autotalli',
    collections
  });

  assert.equal(result.groups.every(group => group.results.length > 0), true);
  assert.equal(result.groups.some(group => group.type === SEARCH_TYPE.PROJECT), true);
});

test('paras osuma löytyy kaikista ryhmistä', () => {
  const result = searchAll({ query: 'Autotallin remontti', collections });
  const best = bestMatch(result);

  assert.equal(best.type, SEARCH_TYPE.PROJECT);
  assert.equal(best.id, 'p1');
});

test('paras osuma tyhjästä tuloksesta on null', () => {
  assert.equal(bestMatch(searchAll({ query: 'löytymätön', collections })), null);
  assert.equal(bestMatch(null), null);
});

test('puuttuvat kokoelmat eivät kaada hakua', () => {
  assert.doesNotThrow(() => searchAll({ query: 'testi', collections: {} }));
  assert.doesNotThrow(() => searchAll({ query: 'testi' }));
  assert.equal(searchAll({ query: 'testi', collections: {} }).total, 0);
});

test('jokaisella tietotyypillä on nimilappu', () => {
  for (const type of SEARCH_TYPES) {
    assert.ok(searchTypeLabel(type).length > 0, type);
  }
  assert.equal(searchTypeLabel('tuntematon'), 'tuntematon');
});

// ------------------------------------------------------------ suorituskyky

test('haku selviää suuresta aineistosta', () => {
  const big = {
    tasks: Array.from({ length: 1000 }, (unused, i) => ({ id: 't' + i, title: 'Tehtävä ' + i })),
    routines: Array.from({ length: 500 }, (unused, i) => ({ id: 'r' + i, title: 'Rutiini ' + i })),
    goals: Array.from({ length: 200 }, (unused, i) => ({ id: 'g' + i, title: 'Tavoite ' + i })),
    projects: Array.from({ length: 200 }, (unused, i) => ({ id: 'p' + i, name: 'Projekti ' + i })),
    bills: Array.from({ length: 1000 }, (unused, i) => ({ id: 'b' + i, name: 'Lasku ' + i }))
  };

  const started = Date.now();
  const result = searchAll({ query: 'tehtävä', collections: big });
  const elapsed = Date.now() - started;

  assert.ok(result.total > 0);
  assert.ok(elapsed < 1000, `haku kesti ${elapsed} ms — liian hidas`);
});
