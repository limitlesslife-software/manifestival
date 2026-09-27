// Tallennetut paikat: tekstin tunnistus, opitut nimet ja ehdotukset (src/domain/places.js).
//
// PERIAATE: ei koskaan arvata. Varma tulos vain täsmällisestä nimestä tai
// vähintään kahdesti vahvistetusta opitusta nimestä, joka viittaa yhteen
// paikkaan. Kaikki muu on kysymys (ehdokkaat) tai "ei löytynyt".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode } from './helpers/sources.mjs';
import {
  resolvePlaceText, placeSuggestions, aliasConfidence, describeLearning, foldPlaceText,
  PLACE_MATCH, PLACE_CONFIDENCE, MIN_ALIAS_CONFIRMATIONS, MAX_PLACE_CANDIDATES
} from '../src/domain/places.js';

const place = (id, name, overrides = {}) => ({
  id, name, address: null, providerPlaceId: null, area: null, travelMode: 'driving', usualTravelMinutes: 20,
  preparationMinutes: null, arrivalBufferMinutes: null, overheadMinutes: null, useLearned: false, note: null,
  createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z', ...overrides
});
const alias = (id, placeId, text, confirmations, overrides = {}) => ({
  id, placeId, alias: text, confirmations, lastConfirmedAt: '2026-09-20T10:00:00Z',
  createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z', ...overrides
});

const PLACES = [
  place('kallio', 'Parturi Kallio', { area: 'Kallio', address: 'Fleminginkatu 1, Helsinki' }),
  place('haka', 'Parturi Hakaniemi', { area: 'Hakaniemi', address: 'Hämeentie 3, Helsinki' }),
  place('work', 'Työ', { address: 'Mannerheimintie 10, Helsinki' }),
  place('home', 'Koti', { area: 'Vallila' }),
  place('dentist', 'Hammaslääkäri Mehiläinen', { address: 'Runeberginkatu 47' })
];

// ------------------------------------------------------------ vertailumuoto

test('vertailumuoto: NFC, välilyönnit, reunat ja suomen pienet kirjaimet', () => {
  assert.equal(foldPlaceText('  PARTURI\t\n  Kallio  '), 'parturi kallio');
  assert.equal(foldPlaceText('A\u{30A}bo'), 'åbo', 'hajotettu Å kootaan');
  assert.equal(foldPlaceText('Ääkköset ÖÖ'), 'ääkköset öö');
  assert.equal(foldPlaceText('Koti\u{202E}'), 'koti', 'suuntaohjain ei muuta vertailua');
  for (const bad of [null, undefined, 5, {}, []]) assert.equal(foldPlaceText(bad), '');
  assert.equal(foldPlaceText('x'.repeat(1000)).length, 200);
});

// ------------------------------------------------------------ tunnistus

test('täsmällinen nimi: EXACT, varma, kirjainkoolla tai välilyönneillä ei väliä', () => {
  for (const text of ['Parturi Kallio', 'parturi kallio', '  PARTURI   KALLIO ']) {
    const result = resolvePlaceText(text, { places: PLACES, aliases: [] });
    assert.equal(result.status, PLACE_MATCH.EXACT, text);
    assert.equal(result.place.id, 'kallio');
    assert.equal(result.confidence, PLACE_CONFIDENCE.HIGH);
    assert.deepEqual(result.candidates.map(p => p.id), ['kallio']);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.candidates), true);
  }
});

test('KRIITTINEN: ei koskaan arvata kahden parturin välillä', () => {
  const result = resolvePlaceText('parturi', { places: PLACES, aliases: [] });
  assert.equal(result.status, PLACE_MATCH.AMBIGUOUS);
  assert.equal(result.place, null);
  assert.deepEqual(result.candidates.map(p => p.id), ['haka', 'kallio']);
  assert.equal(result.confidence, PLACE_CONFIDENCE.LOW);
  assert.match(result.reason, /Valitse oikea/);
});

test('opittu nimi voittaa vasta kahden vahvistuksen jälkeen ja vain yhdellä paikalla', () => {
  const once = resolvePlaceText('Parturi', { places: PLACES, aliases: [alias('a1', 'kallio', 'parturi', 1)] });
  assert.equal(once.status, PLACE_MATCH.AMBIGUOUS);
  assert.equal(once.place, null);
  // Kerran vahvistettu ensin, mutta muut nimeen sopivat pysyvät valittavina
  // (paketti §12: useampi ehdokas -> kysy).
  assert.deepEqual(once.candidates.map(p => p.id), ['kallio', 'haka']);
  assert.match(once.reason, /Tarkoititko paikkaa Parturi Kallio\?.*Valitse oikea\./);

  const twice = resolvePlaceText('Parturi', { places: PLACES, aliases: [alias('a1', 'kallio', 'parturi', 2)] });
  assert.equal(MIN_ALIAS_CONFIRMATIONS, 2);
  assert.equal(twice.status, PLACE_MATCH.LEARNED);
  assert.equal(twice.place.id, 'kallio');
  assert.equal(twice.confidence, PLACE_CONFIDENCE.MEDIUM);
  assert.match(twice.reason, /vahvistanut .* 2 kertaa/);

  const often = resolvePlaceText('parturi', { places: PLACES, aliases: [alias('a1', 'kallio', ' PARTURI ', 7)] });
  assert.deepEqual([often.status, often.confidence], [PLACE_MATCH.LEARNED, PLACE_CONFIDENCE.HIGH]);

  const split = resolvePlaceText('parturi', { places: PLACES, aliases: [
    alias('a1', 'kallio', 'parturi', 9), alias('a2', 'haka', 'parturi', 2)] });
  assert.equal(split.status, PLACE_MATCH.AMBIGUOUS, 'kaksi paikkaa samalla nimellä: kysytään');
  assert.equal(split.place, null);
  assert.deepEqual(split.candidates.map(p => p.id), ['kallio', 'haka'], 'useimmin vahvistettu ensin');
});

test('opittu nimi poistettuun paikkaan ei ratkaise mitään', () => {
  const result = resolvePlaceText('salille', { places: PLACES, aliases: [alias('a1', 'gym-deleted', 'salille', 5)] });
  assert.equal(result.status, PLACE_MATCH.NONE);
  assert.equal(result.place, null);
});

test('täsmällinen nimi voittaa opitun nimen', () => {
  const result = resolvePlaceText('Koti', { places: PLACES, aliases: [alias('a1', 'work', 'koti', 5)] });
  assert.deepEqual([result.status, result.place.id], [PLACE_MATCH.EXACT, 'home']);
});

test('sama nimi kahdella paikalla (datavirhe): kysytään, ei valita', () => {
  const places = [place('x1', 'Sali'), place('x2', 'sali')];
  const result = resolvePlaceText('SALI', { places });
  assert.equal(result.status, PLACE_MATCH.AMBIGUOUS);
  assert.deepEqual(result.candidates.map(p => p.id).sort(), ['x1', 'x2']);
});

test('osittaiset osumat ovat aina kysymyksiä: nimen alku, sana, osoite, alue, lause', () => {
  const byWord = resolvePlaceText('mehil', { places: PLACES });
  assert.deepEqual([byWord.status, byWord.candidates[0].id], [PLACE_MATCH.AMBIGUOUS, 'dentist']);
  assert.equal(byWord.place, null);
  const byAddress = resolvePlaceText('fleminginkatu', { places: PLACES });
  assert.deepEqual(byAddress.candidates.map(p => p.id), ['kallio']);
  const byArea = resolvePlaceText('vallila', { places: PLACES });
  assert.deepEqual(byArea.candidates.map(p => p.id), ['home']);
  const sentence = resolvePlaceText('hammaslääkäri mehiläinen klo 10', { places: PLACES });
  assert.deepEqual([sentence.status, sentence.candidates[0].id], [PLACE_MATCH.AMBIGUOUS, 'dentist']);
  const viaAlias = resolvePlaceText('hamma', { places: PLACES, aliases: [alias('a1', 'dentist', 'hammaslääkäri', 1)] });
  assert.deepEqual(viaAlias.candidates.map(p => p.id), ['dentist']);
  // Nimen alku on parempi kuin keskeltä osuva.
  const ranked = resolvePlaceText('ka', { places: [place('p1', 'Ostoskeskus Kamppi'), place('p2', 'Kahvila'),
    place('p3', 'Hakaniemen apteekki'), place('p4', 'Apteekki')] });
  assert.deepEqual(ranked.candidates.map(p => p.id), ['p2', 'p1', 'p3']);
});

test('ei osumaa, liian lyhyt haku tai tyhjä: NONE', () => {
  assert.equal(resolvePlaceText('Kuopio', { places: PLACES }).status, PLACE_MATCH.NONE);
  assert.equal(resolvePlaceText('a', { places: PLACES }).status, PLACE_MATCH.NONE, 'yksi merkki ei riitä');
  const empty = resolvePlaceText('   ', { places: PLACES });
  assert.deepEqual([empty.status, empty.confidence, empty.candidates.length], [PLACE_MATCH.NONE, PLACE_CONFIDENCE.NONE, 0]);
  assert.equal(resolvePlaceText('Koti', {}).status, PLACE_MATCH.NONE);
});

test('ehdokkaita enintään kahdeksan', () => {
  const many = Array.from({ length: 30 }, (_, i) => place(`s${i}`, `Sali ${String(i).padStart(2, '0')}`));
  const result = resolvePlaceText('sali', { places: many });
  assert.equal(result.candidates.length, MAX_PLACE_CANDIDATES);
  assert.equal(result.candidates[0].name, 'Sali 00');
});

test('deterministinen sekoitetulla syötteellä eikä muuta syötettä', () => {
  const aliases = [alias('a1', 'kallio', 'parturi', 3), alias('a2', 'haka', 'tukka', 1), alias('a3', 'dentist', 'hammas', 2)];
  const snapshot = structuredClone({ PLACES, aliases });
  const expected = ['parturi', 'tukka', 'hammas', 'ka', 'helsinki', 'Koti'].map(text => resolvePlaceText(text, { places: PLACES, aliases }));
  for (let rotation = 1; rotation < PLACES.length; rotation += 1) {
    const places = [...PLACES.slice(rotation), ...PLACES.slice(0, rotation)].reverse();
    const got = ['parturi', 'tukka', 'hammas', 'ka', 'helsinki', 'Koti'].map(text => resolvePlaceText(text, { places, aliases: [...aliases].reverse() }));
    assert.deepEqual(got, expected);
  }
  assert.deepEqual({ PLACES, aliases }, snapshot);
  assert.equal(Object.isFrozen(PLACES[0]), false);
});

// ------------------------------------------------------------ varmuus ja kuvaus

test('aliasConfidence: 0 none, 1 low, 2-3 medium, 4+ high', () => {
  assert.equal(aliasConfidence(0), PLACE_CONFIDENCE.NONE);
  assert.equal(aliasConfidence(1), PLACE_CONFIDENCE.LOW);
  assert.equal(aliasConfidence(2), PLACE_CONFIDENCE.MEDIUM);
  assert.equal(aliasConfidence(3), PLACE_CONFIDENCE.MEDIUM);
  assert.equal(aliasConfidence(4), PLACE_CONFIDENCE.HIGH);
  assert.equal(aliasConfidence(alias('a', 'p', 'x', 5)), PLACE_CONFIDENCE.HIGH);
  for (const bad of [null, undefined, NaN, -1, '3', {}, { confirmations: 'x' }]) {
    assert.equal(aliasConfidence(bad), PLACE_CONFIDENCE.NONE, String(bad));
  }
});

test('describeLearning: "Parturi → Parturi Kallio (vahvistettu 3 kertaa)"', () => {
  assert.equal(describeLearning(alias('a', 'kallio', 'parturi', 3), PLACES[0]), 'Parturi → Parturi Kallio (vahvistettu 3 kertaa)');
  assert.equal(describeLearning(alias('a', 'kallio', 'parturi', 1), PLACES[0]), 'Parturi → Parturi Kallio (vahvistettu kerran)');
  assert.equal(describeLearning(alias('a', 'home', 'äidin luo', 2), PLACES[3]), 'Äidin luo → Koti (vahvistettu 2 kertaa)');
  for (const [a, p] of [[null, PLACES[0]], [alias('a', 'x', '', 2), PLACES[0]], [alias('a', 'x', 'y', 0), PLACES[0]],
    [alias('a', 'x', 'y', 2), null], [alias('a', 'x', 'y', 2), { name: '  ' }]]) {
    assert.equal(describeLearning(a, p), null);
  }
});

// ------------------------------------------------------------ ehdotukset

test('ehdotukset: tallennetut ensin käytön mukaan, sitten tutut nimet ilman kaksoiskappaleita', () => {
  const aliases = [alias('a1', 'work', 'duuni', 9), alias('a2', 'home', 'kotiin', 2)];
  const travelPlans = [{ destination: 'Kuopio', origin: 'koti' }, { destination: 'Kuopio' }, { destination: 'Tampere' }];
  const list = placeSuggestions({ places: PLACES, aliases, travelPlans, locationRules: [{ place: 'Kauppa' }], limit: 20 });
  assert.deepEqual(list.map(s => s.name), [
    'Työ', 'Koti', 'Hammaslääkäri Mehiläinen', 'Parturi Hakaniemi', 'Parturi Kallio', 'Kuopio', 'Kauppa', 'Tampere'
  ]);
  assert.deepEqual({ ...list[0] }, { placeId: 'work', name: 'Työ', area: null, saved: true });
  assert.deepEqual({ ...list[5] }, { placeId: null, name: 'Kuopio', area: null, saved: false });
  assert.equal(Object.isFrozen(list), true);
  assert.equal(Object.isFrozen(list[0]), true);
});

test('ehdotukset haulla ja rajalla', () => {
  const list = placeSuggestions({ places: PLACES, query: 'par', travelPlans: [{ destination: 'Pariisi' }, { destination: 'Oulu' }] });
  assert.deepEqual(list.map(s => s.name), ['Parturi Hakaniemi', 'Parturi Kallio', 'Pariisi']);
  assert.equal(placeSuggestions({ places: PLACES }).length, 5);
  assert.equal(placeSuggestions({ places: PLACES, limit: 2 }).length, 2);
  assert.equal(placeSuggestions({ places: PLACES, limit: 0 }).length, 0);
  assert.equal(placeSuggestions({ places: PLACES, limit: -3 }).length, 5, 'kelvoton raja -> oletus');
  assert.deepEqual(placeSuggestions({}), []);
});

// ------------------------------------------------------------ kestävyys

test('kelvoton syöte ei koskaan kaada eikä tuota varmaa tulosta', () => {
  const garbagePlaces = [null, 1, 'x', [], { id: 5, name: 'X' }, { id: 'a' }, { id: 'b', name: '' }, { id: 'c', name: {} },
    { id: '', name: 'Tyhjä' }];
  const garbageAliases = [null, { placeId: 'c', alias: 5, confirmations: 3 }, { placeId: {}, alias: 'x', confirmations: 3 },
    { placeId: 'a', alias: 'x', confirmations: Infinity }];
  for (const text of [null, undefined, 5, {}, [], 'x', '\u{0}\u{7}', 'a'.repeat(100000)]) {
    for (const context of [undefined, null, 'x', { places: 'x', aliases: 5 }, { places: garbagePlaces, aliases: garbageAliases }]) {
      assert.doesNotThrow(() => resolvePlaceText(text, context));
      const result = resolvePlaceText(text, context);
      assert.notEqual(result.status, PLACE_MATCH.EXACT);
      assert.notEqual(result.status, PLACE_MATCH.LEARNED);
    }
  }
  assert.doesNotThrow(() => placeSuggestions({ places: garbagePlaces, aliases: garbageAliases, query: {}, travelPlans: 'x', locationRules: 5 }));
  assert.doesNotThrow(() => placeSuggestions(null));
});

test('suorituskyky: 2 000 paikkaa ja 20 000 opittua nimeä', () => {
  const places = Array.from({ length: 2000 }, (_, i) => place(`p${i}`, `Paikka ${i}`, { address: `Katu ${i}` }));
  const aliases = Array.from({ length: 20000 }, (_, i) => alias(`a${i}`, `p${i % 2000}`, `nimi ${i % 5000}`, 1 + (i % 4)));
  const started = performance.now();
  for (const text of ['paikka 1999', 'nimi 42', 'katu 7', 'ei ole', 'paikka']) resolvePlaceText(text, { places, aliases });
  placeSuggestions({ places, aliases, limit: 20 });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 4000, `liian hidas: ${Math.round(elapsed)} ms`);
});

test('paikkamoduuli ei tunne koordinaatteja eikä kirjoita mitään', () => {
  const code = readCode('src/domain/places.js');
  assert.equal(/\b(latitude|longitude|lat|lng|coords|geolocation)\b/.test(code), false);
  assert.equal(/Repo|insert|upsert|fetch\(/.test(code), false);
});
