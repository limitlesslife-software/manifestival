// Suunta 2: valinnainen tekoälyselitys ja sen varapolku.
//
// YDIN EI RIIPU TEKOÄLYSTÄ: jokainen epäonnistuminen palauttaa
// deterministisen suomenkielisen selityksen. Lähtevä konteksti on
// minimoitu: ei aluenimiä, ei otsikoita, ei pohdintoja.
//
// Selitys on oletuksena POIS (AI_EXPLAIN_ENABLED = false). Tämän
// tiedoston testit kytkevät sen päälle testikoukulla, jotta itse
// kutsupolku tulee testatuksi; pois-tila testataan erikseen.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  explainWithFallback, explanationContext, acceptableExplanation, aiExplainEnabled,
  setAiExplainEnabledForTests, AI_EXPLAIN_ENABLED, MAX_EXPLANATION_LENGTH
} from '../src/ai/alignmentExplainClient.js';
import { restoreAreaNames } from '../src/ai/alignmentContext.js';
import { analyzeWeek, SIGNAL } from '../src/domain/alignment.js';
import { explainSignal } from '../src/domain/alignmentReview.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';
import { normalizeWeeklyCapacity } from '../src/domain/weeklyCapacity.js';
import { readCode } from './helpers/sources.mjs';

const require = createRequire(import.meta.url);
const { validateExplainRequest } = require('../api/_validateExplain.js');
const explainApi = require('../api/explain.js');

before(() => setAiExplainEnabledForTests(true));
after(() => setAiExplainEnabledForTests(null));

const WEEK = '2026-09-14';
const areas = [
  normalizeLifeArea({ id: 'fam', name: 'Avioero ja lapset', importance: 5, targetMinutesPerWeek: 600, categoryKey: 'perhe' }),
  normalizeLifeArea({ id: 'work', name: 'Työ', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'tyo' })
];
// Muutettu sääntöversiossa 3: työn 600 min kirjataan ma–ke kolmena
// päivänä (ennen yksi kirjaus tiistaina). Yhden päivän kirjaus ei enää
// riitä toteuman vertailuun; huomiotta jäämisen luvut ovat ennallaan
// (perjantaina odotettu 600 x 4/7 ≈ 5,5 h).
const analysis = analyzeWeek({
  weekStart: WEEK, todayIso: '2026-09-18', areas,
  tasks: [normalizeTask({ id: 't', title: 'Terapia-aika salaa', date: '2026-09-15', durationMinutes: 900, category: 'tyo' })],
  timeEntries: [
    normalizeTimeEntry({ id: 'e1', entryDate: '2026-09-14', minutes: 200, lifeAreaId: 'work' }),
    normalizeTimeEntry({ id: 'e', entryDate: '2026-09-15', minutes: 200, lifeAreaId: 'work', note: 'yksityinen muistiinpano' }),
    normalizeTimeEntry({ id: 'e3', entryDate: '2026-09-16', minutes: 200, lifeAreaId: 'work' })
  ],
  capacity: normalizeWeeklyCapacity({ id: 'c', weekStart: WEEK, availableMinutes: 600 })
});
const neglect = analysis.signals.find(signal => signal.kind === SIGNAL.NEGLECT);
const overload = analysis.signals.find(signal => signal.kind === SIGNAL.OVERLOAD);
const tension = analysis.signals.find(signal => signal.kind === SIGNAL.TARGET_TENSION);

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Lähetetty runko annetulle havainnolle. */
async function sentBodyFor(signal) {
  let sent = null;
  await explainWithFallback({
    analysis, signal, areas, accessToken: 'token',
    fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return response(404, {}); }
  });
  return sent;
}

// ================================================================ KATKAISIN

test('KATKAISIN: tekoälyselitys on käännösaikaisesti pois', () => {
  // Käyttöönotto on omistajan päätös (docs/SUUNTA-ACTIVATION-GO-NOGO.md).
  // Jos tämä kaatuu, lippu on käännetty: varmista että päätös on kirjattu
  // ja että palvelimen EXPLAIN_ENABLED on asetettu samassa julkaisussa.
  assert.equal(AI_EXPLAIN_ENABLED, false);
  assert.match(readCode('src/ai/alignmentExplainClient.js'), /export const AI_EXPLAIN_ENABLED = false;/);
});

test('KATKAISIN pois: fetchiä ei kutsuta, deterministinen selitys', async () => {
  setAiExplainEnabledForTests(false);
  try {
    assert.equal(aiExplainEnabled(), false);
    let calls = 0;
    const result = await explainWithFallback({
      analysis, signal: neglect, areas, accessToken: 'token',
      fetchImpl: async () => { calls++; return response(200, { text: 'A1 on saanut vähemmän aikaa kuin toivoit.' }); }
    });
    assert.equal(calls, 0, 'ei verkkokutsua');
    assert.equal(result.source, 'deterministic');
    assert.equal(result.failure, 'disabled');
    assert.ok(result.text.includes(explainSignal(neglect, areas).text));
  } finally {
    setAiExplainEnabledForTests(true);
  }
});

test('KATKAISIN pois: explainSignalOptionally ei lue istuntoa eikä kutsu verkkoa', async () => {
  const { explainSignalOptionally } = await import('../src/app/alignment.js');
  setAiExplainEnabledForTests(false);
  try {
    let calls = 0;
    const result = await explainSignalOptionally(neglect, analysis, {
      accessToken: 'token', fetchImpl: async () => { calls++; return response(200, { text: 'x'.repeat(40) }); }
    });
    assert.equal(calls, 0);
    assert.equal(result.source, 'deterministic');
    assert.equal(result.failure, 'disabled');
  } finally {
    setAiExplainEnabledForTests(true);
  }
});

// ================================================================ KONTEKSTI

test('lähtevä konteksti: vain valittu havainto, alueet tunnuksina, ei otsikoita eikä muistiinpanoja', async () => {
  let sent = null;
  await explainWithFallback({
    analysis, signal: neglect, areas, accessToken: 'token',
    fetchImpl: async (url, init) => { sent = { url, init }; return response(200, { text: 'A1 on saanut vähemmän aikaa kuin toivoit. Haluatko varata aikaa vai muuttaa tavoitetta?' }); }
  });
  const body = sent.init.body;
  assert.match(sent.url, /\/api\/explain$/);
  for (const secret of ['Avioero', 'Terapia', 'yksityinen', 'Työ']) {
    assert.equal(body.includes(secret), false, `vuoto: ${secret}`);
  }
  const parsed = JSON.parse(body);
  assert.equal(parsed.context.signals.length, 1);
  assert.equal(parsed.context.areas.length, 1);
  assert.match(parsed.context.areas[0].area, /^A\d+$/);
  assert.equal(sent.init.headers.Authorization, 'Bearer token');
});

test('minimointi: viikkotason kuormitus ei lähetä alueita eikä sääntötekstiä', async () => {
  assert.ok(overload, 'aineistossa on kuormitushavainto');
  const sent = await sentBodyFor(overload);
  assert.deepEqual(sent.context.areas, []);
  assert.equal('rules' in sent.context, false, 'säännöt elävät vain palvelimella');
});

test('minimointi: tavoitejännite lähettää vain tärkeyden ja tavoitteen', async () => {
  assert.ok(tension, 'aineistossa on tavoitejännite');
  const sent = await sentBodyFor(tension);
  assert.equal(sent.context.areas.length, 2);
  for (const row of sent.context.areas) {
    assert.deepEqual(Object.keys(row).sort(), ['area', 'importance', 'targetHours']);
  }
});

test('REGRESSIO: tuntiluku kulkee tuntinimellä koko ketjun läpi (selain -> validointi -> kehote)', () => {
  // Ennen: "targetMinutes":10 tarkoitti 10 tuntia.
  const { context } = explanationContext(analysis, neglect);
  const validation = validateExplainRequest({ context });
  assert.equal(validation.ok, true);
  const message = explainApi.buildUserMessage(validation.value);
  assert.match(message, /"targetHours":10/);
  assert.match(message, /"expectedByNowHours":5\.5/);
  assert.doesNotMatch(message, /Minutes"/);
  for (const signal of analysis.signals) {
    const serialized = JSON.stringify(explanationContext(analysis, signal).context);
    assert.doesNotMatch(serialized, /Minutes"/, signal.kind);
  }
});

test('minimoitu konteksti: tunnit puolen tunnin tarkkuudella, ei tunnisteita', () => {
  const { context } = explanationContext(analysis, neglect);
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes('"fam"') || serialized.includes('"work"'), false, 'alueiden tunnisteet eivät lähde');
  for (const value of Object.values(context.signals[0].metrics)) {
    if (typeof value === 'number') assert.equal(value * 2, Math.round(value * 2));
  }
});

// ================================================================ VASTAUS

test('onnistunut vastaus: aluenimet palautetaan paikallisesti', async () => {
  const result = await explainWithFallback({
    analysis, signal: neglect, areas, accessToken: 'token',
    fetchImpl: async () => response(200, { text: 'A1 on saanut vähemmän aikaa kuin toivoit. Haluatko varata aikaa?' })
  });
  assert.equal(result.source, 'ai');
  assert.match(result.text, /^Avioero ja lapset on saanut/);
});

test('VARAPOLKU: verkkovirhe, palvelinvirhe, aikakatkaisu, ei tokenia -> deterministinen selitys', async () => {
  const expected = explainSignal(neglect, areas);
  const cases = [
    { accessToken: null, fetchImpl: async () => response(200, { text: 'x'.repeat(50) }) },
    { accessToken: 't', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } },
    { accessToken: 't', fetchImpl: async () => response(502, { error: 'Selitys epaonnistui' }) },
    { accessToken: 't', fetchImpl: async () => response(503, { error: 'Palvelu ei ole käytössä' }) },
    { accessToken: 't', fetchImpl: async () => response(200, {}) },
    { accessToken: 't', fetchImpl: async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; } }
  ];
  for (const options of cases) {
    const result = await explainWithFallback({ analysis, signal: neglect, areas, ...options });
    assert.equal(result.source, 'deterministic');
    assert.equal(result.title, expected.title);
    assert.ok(result.text.includes(expected.text));
    assert.ok(result.failure);
  }
});

test('VARAPOLKU: vastaus, joka väittää muuttaneensa jotain tai ohjaa linkkiin, hylätään', async () => {
  for (const text of [
    'Muutin tavoitteesi puolestasi pienemmäksi, jotta viikko mahtuu.',
    'Lue lisää osoitteesta https://example.com/elamanohjeet ja toimi niin.',
    'lyhyt',
    // Perfekti, muut imperfektit ja passiivi.
    'Olen muuttanut tavoitettasi, jotta viikko näyttää kevyemmältä.',
    'Olemme lisänneet viikkoosi kaksi tuntia lepoa, jotta jaksat.',
    'Lisäsin kalenteriisi kaksi tuntia perheaikaa torstaille.',
    'Kevensin viikkoasi poistamalla kaksi tehtävää, joten tilaa on nyt.',
    'Vaihdoin A1:n tärkeyden neljään, koska se näytti sopivalta.',
    'Tavoitteesi on nyt muutettu vastaamaan todellista käytettävissä olevaa aikaa.',
    // Linkit ilman http-alkua.
    'Katso ohjeet sivulta www.example.com ennen kuin päätät mitään.',
    'Lue [tämä opas](esimerkki) ennen kuin päätät viikon suunnasta.'
  ]) {
    assert.equal(acceptableExplanation(text), false, text);
    const result = await explainWithFallback({ analysis, signal: neglect, areas, accessToken: 't', fetchImpl: async () => response(200, { text }) });
    assert.equal(result.source, 'deterministic', text);
  }
});

test('kysymys vaihtoehdoista on sallittu', () => {
  for (const text of [
    'Haluatko varata aikaa vai muuttaa tavoitetta?',
    'A1 on saanut vähemmän aikaa kuin toivoit. Voit keventää viikkoa, muuttaa tavoitetta tai jatkaa ennallaan.'
  ]) {
    assert.equal(acceptableExplanation(text), true, text);
  }
});

test('REGRESSIO: liian pitkä vastaus hylätään, ei katkaista kesken lauseen', async () => {
  const long = 'Tämä on pitkä selitys viikon tilanteesta. '.repeat(40);
  assert.ok(long.length > MAX_EXPLANATION_LENGTH);
  assert.equal(acceptableExplanation(long), false);
  const result = await explainWithFallback({ analysis, signal: neglect, areas, accessToken: 't', fetchImpl: async () => response(200, { text: long }) });
  assert.equal(result.source, 'deterministic');
  assert.equal(result.failure, 'rejected');
  const exact = 'ä'.repeat(MAX_EXPLANATION_LENGTH);
  assert.equal(acceptableExplanation(exact), true, 'rajan mittainen kelpaa');
  assert.equal(MAX_EXPLANATION_LENGTH, explainApi.MAX_TEXT_LENGTH, 'sama raja selaimella ja palvelimella');
});

test('ääkköset kadottanut suomi hylätään pituudesta riippumatta', () => {
  for (const text of [
    'Ala lisaa tai poista mitaan, A1 on saanut vahemman aikaa kuin toivoit talla viikolla.',
    'Ala huolestu: A1 sai 2 tuntia.',
    'A1:n tarkeys on 5, mutta aikaa oli vain 2 tuntia.',
    'Nayttaa siltä, etta A1 jäi vajaaksi.'
  ]) {
    assert.equal(acceptableExplanation(text), false, text);
  }
});

test('pitkä vastaus ilman yhtään ääkköstä hylätään (muuta kieltä)', () => {
  const english = 'A1 has received less time than you wanted this week. Would you like to plan more time for it, '
    + 'change the target, or keep things as they are? Nothing has been changed, and you can decide later on '
    + 'when the week is clearer.';
  assert.ok(english.length >= 200);
  assert.equal(acceptableExplanation(english), false);
});

test('REGRESSIO: oikea suomi ilman ääkkösiä kelpaa (ei hylätä pelkän ä/ö-puutteen takia)', async () => {
  const text = 'A1 on saanut 2 tuntia, tavoite on 10 tuntia viikossa. Haluatko varata sille aikaa torstaille?';
  assert.ok(text.length > 80 && !/[äöÄÖ]/.test(text), 'esimerkki on yli 80 merkkiä ilman ääkkösiä');
  assert.equal(acceptableExplanation(text), true);
  // "tarkemmin", "tarkentaa" ovat oikeaa suomea: ne eivät osu ääkkösettömiin sanoihin.
  assert.equal(acceptableExplanation('Voit tarkentaa tavoitetta: A1 on saanut 2 tuntia, tavoite on 10 tuntia.'), true);
  const result = await explainWithFallback({ analysis, signal: neglect, areas, accessToken: 't', fetchImpl: async () => response(200, { text }) });
  assert.equal(result.source, 'ai');
});

// ================================================================ NIMIEN PALAUTUS

test('REGRESSIO: aluenimen $-merkit eivät ole korvauskaava, puuttuva nimi pitää tunnuksen', () => {
  assert.equal(restoreAreaNames('A1 jäi vajaaksi', new Map([['A1', "Raha $& $' $$ $1 $`"]])),
    "Raha $& $' $$ $1 $` jäi vajaaksi");
  assert.equal(restoreAreaNames('A1 ja A2', new Map([['A1', undefined], ['A2', '']])), 'A1 ja A2');
  assert.equal(restoreAreaNames('A3 on tuntematon', new Map([['A1', 'Perhe']])), 'A3 on tuntematon');
  // Palautettu nimi ei osu seuraavaan tunnukseen.
  assert.equal(restoreAreaNames('A1 ja A2', new Map([['A1', 'Projekti A2'], ['A2', 'Perhe']])), 'Projekti A2 ja Perhe');
});

// ================================================================ RAKENNE

test('selitys ei kirjoita mitään: asiakas ei tuo repositorioita eikä toimintoja', () => {
  const imports = [...readCode('src/ai/alignmentExplainClient.js').matchAll(/from '([^']+)'/g)].map(m => m[1]);
  assert.equal(imports.some(path => /data\/(collectionsRepo|tasksRepo)|app\//.test(path)), false);
  const endpoint = readCode('api/explain.js');
  assert.equal(/\.from\(|insert\(|update\(|supabase/i.test(endpoint.replace(/\/\/.*$/gm, '')), false);
});

test('lokitus: vain lähde ja lopputulos, ei tekstiä eikä aluenimiä', () => {
  const app = readCode('src/app/alignment.js');
  const call = /logEvent\('alignment\.explanation', \{([^}]*)\}\)/.exec(app);
  assert.ok(call, 'selityksen lokirivi puuttuu');
  assert.equal(/text|name|title|reflection/.test(call[1]), false, call[1]);
});
