// Suunta: saavutettavuus (HTML-runko ja tuotettu HTML) ja suorituskyky.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';
import { analyzeWeek } from '../src/domain/alignment.js';
import { proposeAdjustments } from '../src/domain/alignmentReview.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeRoutine } from '../src/domain/routine.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';
import { normalizeWeeklyCapacity } from '../src/domain/weeklyCapacity.js';

const HTML = read('index.html').replace(/\r\n/g, '\n');

function screen(id) {
  const start = HTML.indexOf(`id="${id}"`);
  assert.ok(start > -1, id);
  const end = HTML.indexOf('</section>', start);
  return HTML.slice(start, end);
}

// ================================================================ SAAVUTETTAVUUS

test('Suunta on yksi välilehti, näkymä on tabpanel ja piilossa ruudunlukijalta kunnes avataan', () => {
  const tabs = [...HTML.matchAll(/<button class="tab-btn[^"]*"[^>]*data-screen="([^"]+)"/g)].map(m => m[1]);
  assert.equal(tabs.filter(t => t === 'screen-direction').length, 1);
  assert.equal(tabs.length, 7, 'yksi uusi välilehti, ei kymmentä');
  assert.match(HTML, /<section class="screen" id="screen-direction" role="tabpanel" aria-label="Suunta" aria-hidden="true" inert>/);
  const nav = readCode('src/app/navigation.js');
  assert.match(nav, /'screen-direction'/);
});

test('jokaisella Suunnan lomakekentällä on nimilappu', () => {
  const section = screen('screen-direction');
  const fields = [...section.matchAll(/<(input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(m => m[2]);
  assert.ok(fields.length >= 12, `kenttiä ${fields.length}`);
  for (const id of fields) {
    assert.ok(section.includes(`for="${id}"`), `kentältä ${id} puuttuu label`);
  }
});

test('virheilmoitukset ilmoitetaan (role=alert) ja tilaviestit (role=status); havainnot ovat live-alue', () => {
  const section = screen('screen-direction');
  for (const id of ['dirAreaNameError', 'dirAreaTargetError', 'dirCapacityError', 'dirTimeMinutesError']) {
    assert.match(section, new RegExp(`id="${id}" role="alert"`), id);
  }
  assert.match(section, /id="dirReviewStatus" role="status"/);
  assert.match(section, /id="dirCapacityWarning" role="status"/);
  assert.match(section, /id="dirSignals" aria-live="polite"/);
});

test('navigointinuolilla on saavutettava nimi; osioilla otsikot', () => {
  const section = screen('screen-direction');
  assert.match(section, /id="dirPrev" type="button" aria-label="Edellinen viikko"/);
  assert.match(section, /id="dirNext" type="button" aria-label="Seuraava viikko"/);
  for (const title of ['Havainnot', 'Tämä viikko', 'Elämänalueet', 'Tavoitteet', 'Toteuma', 'Viikkokatsaus']) {
    assert.match(section, new RegExp(`<h2 class="section-title" id="\\w+">${title}</h2>`), title);
  }
});

test('KRIITTINEN: vakavuus ei ole vain väriä, ja kaavioilla on tekstivastine', () => {
  const view = readCode('src/app/views/direction.js');
  assert.match(view, /<span class="dir-severity">\$\{escapeHtml\(SEVERITY_LABELS\[signal\.severity\]\)\}<\/span>/,
    'vakavuus kirjoitetaan sanana');
  assert.match(view, /role="img" aria-label="\$\{escapeHtml\(label\)\}"/, 'palkilla on tekstivastine');
  // Jokaisen palkin luvut ovat myös näkyvänä tekstinä (weekSummaryHtml kirjoittaa labelin riville).
  assert.match(view, /<p class="dir-line">\$\{escapeHtml\(label\)\}/);
});

test('kosketuskohteet: "Miksi?"- ja historia-avaimet sekä valinnat vähintään 44 px', () => {
  const css = read('src/styles.css');
  assert.match(css, /\.dir-why summary \{[^}]*min-height:44px/);
  assert.match(css, /\.dir-history summary \{[^}]*min-height:44px/);
  assert.match(css, /\.dir-goal-row select \{[^}]*min-height:44px/);
  assert.match(css, /\.dir-why summary:focus-visible \{[^}]*outline/);
});

test('suomenkieliset tekstit mahtuvat: ei kiinteitä leveyksiä eikä yksirivisyyden pakotusta', () => {
  const css = read('src/styles.css');
  const block = css.slice(css.indexOf('/* ============ SUUNTA'), css.indexOf('@media (prefers-reduced-motion'));
  assert.equal(/white-space:\s*nowrap/.test(block), false);
  assert.equal(/(?<![-\w])width:\s*\d{3,}px/.test(block), false,
    'ei yli 99 px kiinteitä leveyksiä (max-width on sallittu yläraja)');
  assert.match(block, /\.dir-signal-head \{[^}]*flex-wrap:wrap/);
});

// ================================================================ SUORITUSKYKY

function largeFixture(scale = 1) {
  const WEEK = '2026-09-14';
  const areas = Array.from({ length: 12 }, (_, i) => normalizeLifeArea({
    id: `a${i}`, name: `Alue ${i}`, importance: 1 + (i % 5), targetMinutesPerWeek: 120 + i * 30,
    categoryKey: ['tyo', 'perhe', 'hyvinvointi', 'harrastus', 'koti', 'kehitys', 'talous', 'muu'][i] || null
  }));
  const goals = Array.from({ length: 300 * scale }, (_, i) => normalizeGoal({
    id: `g${i}`, title: `T${i}`, lifeAreaId: i % 3 === 0 ? `a${i % 12}` : null,
    parentGoalId: i > 10 && i % 3 !== 0 ? `g${i - 1}` : null
  }));
  const categories = ['tyo', 'perhe', 'koti', 'muu'];
  const tasks = Array.from({ length: 6000 * scale }, (_, i) => normalizeTask({
    id: `t${i}`, title: `T${i}`, date: `2026-09-${String(8 + (i % 20)).padStart(2, '0')}`,
    durationMinutes: i % 7 === 0 ? null : 15 + (i % 90), goalId: i % 4 === 0 ? `g${i % (300 * scale)}` : null,
    category: categories[i % 4]
  }));
  const routines = Array.from({ length: 60 }, (_, i) => normalizeRoutine({
    id: `r${i}`, title: `R${i}`, durationMinutes: 20, recurrence: { type: 'daily', weekdays: [] },
    goalId: `g${i}`, active: true
  }));
  const timeEntries = Array.from({ length: 3000 * scale }, (_, i) => normalizeTimeEntry({
    id: `e${i}`, entryDate: `2026-09-${String(10 + (i % 10)).padStart(2, '0')}`, minutes: 10 + (i % 50),
    lifeAreaId: i % 2 ? `a${i % 12}` : null, taskId: i % 2 ? null : `t${i}`
  }));
  return {
    weekStart: WEEK, todayIso: '2026-09-17', areas, goals, tasks, routines, timeEntries,
    capacity: normalizeWeeklyCapacity({ id: 'c', weekStart: WEEK, availableMinutes: 2400 })
  };
}

function timed(fn, rounds = 5) {
  let best = Infinity;
  for (let i = 0; i < rounds; i += 1) {
    const started = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
  }
  return best;
}

test('suorituskyky: iso aineisto (6000 tehtävää, 300 tavoitetta, 3000 kirjausta) analysoidaan päivittäiseen käyttöön riittävän nopeasti', () => {
  const input = largeFixture(1);
  const analysis = analyzeWeek(input);
  assert.ok(analysis.planned.itemCount > 1000);
  const ms = timed(() => analyzeWeek(input));
  // Väljä raja: CI-kone voi olla hidas. Tavoite on alle 50 ms kehityskoneella.
  assert.ok(ms < 400, `analyysi kesti ${ms.toFixed(1)} ms`);
  const proposalMs = timed(() => proposeAdjustments(analysis, {
    areas: input.areas, goals: input.goals, tasks: input.tasks, nextWeekAnalysis: analysis
  }));
  assert.ok(proposalMs < 400, `ehdotukset kestivät ${proposalMs.toFixed(1)} ms`);
});

test('suorituskyky: kasvu on lineaarista, ei neliöllistä (kaksinkertainen aineisto < 4x aika)', () => {
  const small = largeFixture(1);
  const big = largeFixture(2);
  analyzeWeek(small); analyzeWeek(big); // lämmitys
  const a = timed(() => analyzeWeek(small), 7);
  const b = timed(() => analyzeWeek(big), 7);
  assert.ok(b < Math.max(a * 4, a + 20), `1x ${a.toFixed(1)} ms, 2x ${b.toFixed(1)} ms`);
});

test('näkymä laskee analyysin kerran renderöintiä kohti', () => {
  const view = readCode('src/app/views/direction.js');
  const render = view.slice(view.indexOf('export function renderDirection'), view.indexOf('export function renderTodayDirection'));
  assert.equal((render.match(/analyzeCurrentWeek\(/g) || []).length, 1);
});
