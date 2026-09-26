// Kelloriippuvat testit (ACT-02): suhteellinen päivä + kirjaimellinen
// päivämäärä ilman jäädytettyä kelloa.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Kaksi testiä odotti, että "siirrä lääkäriaika perjantaille" tuottaa
// päivän 2026-09-25. Komentoputki (runTypedCommand, runVoiceCommand)
// ratkaisee suhteellisen päivän OIKEASTA kellosta, joten lauantaina 26.9.
// tulos oli 2.10. ja testit kaatuivat — myös jäädytetyissä ehdokkaissa
// H, I ja J, joiden esitarkistus vaatii 0 hylättyä (korjaus 5aa0d53).
//
// SÄÄNTÖ
//
// Testissä, joka ajaa komentoputkea suhteellisella päivällä
// ("huomenna", "perjantaille", "ensi viikolla" …), jokaisen väitetyn
// kirjaimellisen päivämäärän on joko oltava testin omassa lähtötilassa
// (setTasks/normalizeTask: rivi, joka EI muuttunut), tai testin on
// jäädytettävä kello (freezeLocalDate, tests/helpers/clock.mjs).
//
// Puhtaat funktiot, joille annetaan viitepäivä parametrina
// (parseTemporal(text, today), reconcileTemporal(…, MON)), eivät kuulu
// tähän: niiden tulos ei riipu ajopäivästä.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './helpers/sources.mjs';

/** Komentoputken sisäänkäynnit, jotka lukevat oikean kellon (src/app/commandBar.js: todayMidnight()). */
export const REAL_CLOCK_ENTRY_POINTS = Object.freeze(['runTypedCommand', 'runVoiceCommand']);

const PHRASE = /\b(huomenna|ylihuomenna|huomiselle|maanantai(?:lle|na)|tiistai(?:lle|na)|keskiviikko(?:na)?|keskiviikolle|torstai(?:lle|na)|perjantai(?:lle|na)|lauantai(?:lle|na)|sunnuntai(?:lle|na)|ensi viikolla|ensi viikon|ensi viikko)\b/i;
const DATE = /20\d\d-\d\d-\d\d/g;
const CLOCK = /freezeLocalDate\(|mock\.timers\.enable\(/;

function testBlocks(source) {
  const starts = [...source.matchAll(/^(?:test|it)\((['"`])(.*?)\1/gm)].map(m => ({ index: m.index, title: m[2] }));
  return starts.map((s, i) => ({ title: s.title, body: source.slice(s.index, starts[i + 1] ? starts[i + 1].index : source.length) }));
}

/**
 * @returns {{title: string, dates: string[]}[]} testit, jotka rikkovat säännön
 */
export function clockDependentTests(source) {
  const findings = [];
  const call = new RegExp(`\\b(?:${REAL_CLOCK_ENTRY_POINTS.join('|')})\\(\\s*(['"\`])(.*?)\\1`, 'g');
  for (const { title, body } of testBlocks(source)) {
    const relative = [...body.matchAll(call)].some(m => PHRASE.test(m[2]));
    if (!relative || CLOCK.test(body)) continue;
    const lines = body.split('\n');
    const setup = new Set(lines.filter(l => /normalizeTask\(|setTasks\(/.test(l)).flatMap(l => l.match(DATE) || []));
    const asserted = [...new Set(lines.filter(l => /\bassert\.\w+\(/.test(l)).flatMap(l => l.match(DATE) || []))];
    const unexplained = asserted.filter(d => !setup.has(d));
    if (unexplained.length) findings.push({ title, dates: unexplained });
  }
  return findings;
}

test('KRIITTINEN: yksikään testi ei väitä suhteellisen päivän tulosta ilman jäädytettyä kelloa', () => {
  const problems = [];
  for (const name of fs.readdirSync(path.join(ROOT, 'tests')).filter(n => n.endsWith('.test.mjs'))) {
    const source = fs.readFileSync(path.join(ROOT, 'tests', name), 'utf8');
    for (const f of clockDependentTests(source)) {
      problems.push(`${name}: "${f.title}" väittää ${f.dates.join(', ')} ilman freezeLocalDate-kutsua`);
    }
  }
  assert.deepEqual(problems, []);
});

test('sääntö tunnistaa synteettisen kelloriippuvan testin ja hyväksyy jäädytetyn', () => {
  const bad = `test('siirto', async () => {
  setTasks([normalizeTask({ id: 'a', title: 'x', date: '2026-09-20' })]);
  await runTypedCommand('siirrä x huomenna', {});
  assert.equal(getState().tasks[0].date, '2026-09-21');
});
`;
  assert.deepEqual(clockDependentTests(bad).map(f => f.dates), [['2026-09-21']]);
  const frozen = bad.replace("async () => {\n", "async (t) => {\n  freezeLocalDate(t, '2026-09-20');\n");
  assert.deepEqual(clockDependentTests(frozen), []);
  const unchanged = bad.replace("'2026-09-21');", "'2026-09-20');");
  assert.deepEqual(clockDependentTests(unchanged), [], 'muuttumaton lähtötila ei riipu kellosta');
});

test('sääntö olisi löytänyt 5aa0d53:n korjaamat testit (ehdollinen)', t => {
  let before;
  try {
    before = ['tests/command-bar.test.mjs', 'tests/voice-command-pipeline.test.mjs']
      .map(file => execFileSync('git', ['show', `6817380:${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    t.skip('commit 6817380 ei ole paikallisesti saatavilla'); return;
  }
  const titles = before.flatMap(source => clockDependentTests(source).map(f => f.title));
  assert.ok(titles.includes('epäselvän kohteen valinta suorittaa VALITUN rivin muutoksen'), titles.join('; '));
  assert.ok(titles.includes('puheella epäselvä kohde näyttää saman valitsimen kuin tekstillä'), titles.join('; '));
});
