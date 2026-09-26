// Saavutettavuus Day 1: värikontrasti lasketaan styles.css:n :root-
// muuttujista ja säännöistä (CRIT-05).
//
// Jokainen rivi alla on Day 1 -käytössä näkyvä teksti: aloitus, alueet,
// kapasiteetti, arviojono, ajastinpalkki, kirjausdialogi, katsaus,
// vahvistusdialogit, virheet ja tilarivit sekä puhepaneeli. Väri ja
// tausta luetaan säännöistä (ei kovakoodattuna testiin), läpikuultava
// tausta yhdistetään alla olevaan kuten selain sen piirtää, ja raja on
// WCAG AA: 4,5:1 pienelle tekstille, 3:1 isolle tekstille ja kuvakkeille.
//
// Ennen: --text-3 #93A29A valkoisella 2,67:1, synkronoinnin varoitus 2,07:1,
// virhe 3,05:1, offline-palkki ja virheilmoitus 3,98:1, onnistumisilmoitus
// 2,96:1, "Palaa tähän viikkoon" 2,87:1.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import {
  parseRules, declarations, rootTokens, parseColor, composite, contrast, isLargeText, fontWeight, px
} from './helpers/a11yCss.mjs';

const RULES = parseRules(read('src/styles.css'));
const TOKENS = rootTokens(RULES);

/** Viimeisin ilmoitettu arvo valitsinketjusta (sama elementti, tarkempi viimeisenä). */
function lastDeclared(chain, ...properties) {
  let value;
  for (const selector of chain) {
    const decls = declarations(RULES, selector);
    for (const property of properties) if (decls[property] !== undefined) value = decls[property];
  }
  return value;
}

function backgroundOf(chain) {
  const value = lastDeclared(chain, 'background', 'background-color');
  return value === undefined ? null : parseColor(value, TOKENS);
}

/** Tausta kerroksittain: token/väri tai valitsinketju (elementin oma tausta). */
function backdrop(layers) {
  let color = null;
  for (const layer of layers) {
    const top = typeof layer === 'string' ? parseColor(layer.startsWith('--') ? `var(${layer})` : layer, TOKENS) : backgroundOf(layer);
    color = color ? composite(top, color) : top;
  }
  if (!color) throw new Error('tausta puuttuu');
  return color;
}

/**
 * Kontrasti: teksti (valitsinketju `el`) taustan `on` päällä. Elementin
 * oma tausta (jos ilmoitettu) lisätään päällimmäiseksi; opacity haalistaa
 * tekstin taustaansa kohti.
 */
function measure({ el, on = ['--cream'], size = null, weight = null, graphic = false }) {
  const own = backgroundOf(el);
  const bg = own ? composite(own, backdrop(on)) : backdrop(on);
  const colorValue = lastDeclared(el, 'color');
  if (colorValue === undefined) throw new Error(`${el.join(' / ')}: väri puuttuu`);
  let fg = composite(parseColor(colorValue, TOKENS), bg);
  const opacity = lastDeclared(el, 'opacity');
  if (opacity !== undefined) fg = composite([...fg.slice(0, 3), Number(opacity)], bg);
  const fontSize = size ?? px(lastDeclared(el, 'font-size'));
  const fontWeightValue = weight ?? fontWeight(lastDeclared(el, 'font-weight')) ?? 400;
  if (!graphic && fontSize === null) throw new Error(`${el.join(' / ')}: fonttikoko puuttuu (anna size)`);
  const ratio = contrast(fg, bg);
  const required = graphic || isLargeText(fontSize, fontWeightValue) ? 3 : 4.5;
  return { ratio, required, fontSize, fontWeight: fontWeightValue };
}

const CARD = ['--cream', '--cream-card'];
const RUNNING = [['.timer-bar']];
const PAUSED = [['.timer-bar', '.timer-bar.is-paused']];

/** Day 1 -tekstit. `what` kertoo missä teksti näkyy. */
const PAIRS = [
  // Aloitus ja Suunnan osiot
  { what: 'aloituksen vaihe (Vaihe 1/7)', el: ['.dir-setup-step'], on: ['--cream', ['.dir-setup']] },
  { what: 'aloituksen otsikko', el: ['.dir-setup-title'], on: ['--cream', ['.dir-setup']] },
  { what: 'aloituksen vihje', el: ['.hint'], on: ['--cream', ['.dir-setup']] },
  { what: 'aloituksen valinta', el: ['.dir-setup-choice'], on: ['--cream', ['.dir-setup']] },
  { what: 'aloituksen valittu valinta', el: ['.dir-setup-choice', '.dir-setup-choice:has(input:checked)'], on: ['--cream', ['.dir-setup']] },
  { what: 'ehdotettu alue valittuna', el: ['.assist-btn', '.dir-setup-chip[aria-pressed="true"]'], on: ['--cream', ['.dir-setup']] },
  { what: '"Näytä koko Suunta"', el: ['.dir-setup-dismiss'], on: ['--cream', ['.dir-setup']] },
  { what: 'osion otsikko (Havainnot, Elämänalueet)', el: ['.section-title'] },
  { what: 'yläotsikko (SUUNTA)', el: ['.eyebrow'] },
  { what: '"Palaa tähän viikkoon"', el: ['.jump-link'] },
  { what: 'rivin teksti', el: ['.dir-line'] },
  { what: 'tuntematon (ilman arviota)', el: ['.dir-line', '.dir-unknown'] },
  { what: 'havainnon sääntörivi (Miksi tämä näkyy?)', el: ['.dir-rule'], on: ['--cream', ['.dir-signal']] },
  { what: 'havainnon otsikko', el: ['.dir-signal-title'], on: ['--cream', ['.dir-signal']] },
  { what: 'vakavuus Tiedoksi', el: ['.dir-severity'], on: ['--cream', ['.dir-signal']] },
  { what: 'vakavuus Huomio', el: ['.dir-severity', '.dir-attention .dir-severity'], on: ['--cream', ['.dir-signal']] },
  { what: 'vakavuus Vahva', el: ['.dir-severity', '.dir-strong .dir-severity'], on: ['--cream', ['.dir-signal']] },
  { what: 'ehdotuksen perustelu', el: ['.assist-reason'], on: ['--cream', ['.assist-row']] },
  { what: 'rivin lisätieto', el: ['.assist-meta'], on: ['--cream', ['.assist-row']] },
  { what: 'tunniste (Tehty, Odottaa lähetystä)', el: ['.assist-tag'], on: ['--cream', ['.assist-row']] },
  { what: 'tunniste varoitus (Odottaa synkronointia)', el: ['.assist-tag', '.assist-tag.tone-warn'], on: ['--cream', ['.assist-row']] },
  { what: 'tunniste kiireellinen', el: ['.assist-tag', '.assist-tag.tone-late'], on: ['--cream', ['.assist-row']] },
  { what: 'RUTIINI-merkki arviojonossa', el: ['.routine-tag'], on: ['--cream', ['.assist-row']] },
  { what: 'Suunnan päiväkortin otsikko', el: ['.dir-today-title'], on: ['--cream', ['.dir-today']] },
  { what: 'kentän nimi', el: ['.field-label'], on: ['--cream', ['.add-form']] },
  { what: 'kentän virhe lomakkeella', el: ['.field-error'], on: ['--cream', ['.add-form']] },
  { what: 'kentän virhe aloituksessa', el: ['.field-error'], on: ['--cream', ['.dir-setup']] },
  { what: 'valintarivi (Karkea arvio, Valitse)', el: ['.checkbox-row'], on: ['--cream', ['.assist-row']] },
  { what: 'valintarivi (Käytössä)', el: ['.check-row'], on: ['--cream', ['.add-form']] },
  { what: 'painike', el: ['.assist-btn'] },
  { what: 'painike vaarallinen (Poista, Hylkää)', el: ['.assist-btn', '.assist-btn.danger'] },
  { what: 'painike ensisijainen', el: ['.assist-btn', '.assist-btn.primary'] },
  { what: 'lomakepainike ensisijainen', el: ['.form-btn', '.form-btn.primary'] },
  { what: 'lomakepainike toissijainen', el: ['.form-btn', '.form-btn.secondary'] },
  { what: 'vahvistusdialogin vaarallinen', el: ['.form-btn', '.form-btn.danger'], on: [['.confirm-dialog']] },
  // Kirjausdialogi ja vahvistukset
  { what: 'dialogin otsikko', el: ['.confirm-title'], on: [['.confirm-dialog']] },
  { what: 'dialogin viesti', el: ['.confirm-message'], on: [['.confirm-dialog']] },
  { what: 'pikavalinnan vihje (hyväksyn arvion)', el: ['.form-btn', '.form-btn.secondary', '.time-log-hint'], on: [['.confirm-dialog'], ['.form-btn.secondary']] },
  { what: 'AI-ehdotuksen varoitus', el: ['.proposal-warning'], on: [['.confirm-dialog']] },
  // Ajastinpalkki
  { what: 'ajastin: tila Käynnissä', el: ['.timer-bar', '.timer-state'], on: RUNNING },
  { what: 'ajastin: tila Tauolla', el: ['.timer-bar', '.timer-state'], on: PAUSED },
  { what: 'ajastin: kohde', el: ['.timer-bar', '.timer-target'], on: RUNNING },
  { what: 'ajastin: kohde tauolla', el: ['.timer-bar', '.timer-target'], on: PAUSED },
  { what: 'ajastin: painike', el: ['.assist-btn', '.timer-bar .assist-btn'], on: RUNNING },
  { what: 'ajastin: painike tauolla', el: ['.assist-btn', '.timer-bar .assist-btn'], on: PAUSED },
  { what: 'ajastin: ensisijainen painike', el: ['.assist-btn', '.timer-bar .assist-btn', '.timer-bar .assist-btn.primary'], on: RUNNING },
  { what: 'ajastin: kirjaamaton ajastus (vihje)', el: ['.hint', '.timer-bar .hint'], on: RUNNING },
  { what: 'ajastin: kirjaamaton ajastus tauolla', el: ['.hint', '.timer-bar .hint'], on: PAUSED },
  { what: 'ajastin: kellon siirtymä', el: ['.hint', '.timer-skew'], on: RUNNING },
  // Tila- ja virherivit
  { what: 'synkronointi', el: ['.sync-status'] },
  { what: 'synkronointi: varoitus', el: ['.sync-status', '.sync-status.tone-warn'] },
  { what: 'synkronointi: virhe', el: ['.sync-status', '.sync-status.tone-error'] },
  { what: 'offline-palkki', el: ['.offline-banner'] },
  { what: 'skeemapalkki', el: ['.schema-banner'] },
  { what: 'ilmoitus', el: ['.toast', '.toast-info'] },
  { what: 'ilmoitus: onnistui', el: ['.toast', '.toast-success'] },
  { what: 'ilmoitus: virhe', el: ['.toast', '.toast-error'] },
  { what: 'kirjautumisen virhe', el: ['.auth-msg', '.auth-msg.error'] },
  { what: 'käynnistysvirhe', el: ['.startup-error'] },
  { what: 'huoltokatkon tila', el: ['.schema-maintenance-status'] },
  { what: 'kirjauksen tila', el: ['.capture-status'] },
  { what: 'huomautus (savi)', el: ['.notice', '.notice.tone-clay'] },
  { what: 'välilehti', el: ['.tab-btn'], on: ['--cream', ['.tab-bar']] },
  // Puhepaneeli
  { what: 'puhe: otsikko', el: ['.voice-label'], on: [['.voice-sheet']] },
  { what: 'puhe: litteraatti', el: ['.voice-transcript'], on: [['.voice-sheet']] },
  { what: 'puhe: lähde', el: ['.voice-source'], on: [['.voice-sheet']] },
  { what: 'puhe: mikrofoni', el: ['.voice-mic-btn'], on: [['.voice-sheet']] },
  { what: 'puhe: tallenna', el: ['.voice-btn', '.voice-btn.save'], on: [['.voice-sheet']] },
  { what: 'puhe: peruuta', el: ['.voice-btn', '.voice-btn.cancel'], on: [['.voice-sheet']] },
  { what: 'puhe: sulje (kuvake)', el: ['.voice-close-x'], on: [['.voice-sheet']], graphic: true },
  { what: 'kirjaus: sanelu päällä (kuvake)', el: ['.capture-mic', '.capture-mic[aria-pressed="true"]'], graphic: true }
];

test('CRIT-05 KRIITTINEN: --text-3 täyttää 4,5:1 valkoisella ja kermalla (pieni teksti)', () => {
  const text3 = parseColor('var(--text-3)', TOKENS);
  const white = contrast(text3, parseColor('var(--cream-card)', TOKENS));
  const cream = contrast(text3, parseColor('var(--cream)', TOKENS));
  assert.ok(white >= 4.5, `--text-3 valkoisella ${white.toFixed(2)}:1`);
  assert.ok(cream >= 4.5, `--text-3 kermalla ${cream.toFixed(2)}:1`);
});

test('CRIT-05 KRIITTINEN: jokainen Day 1 -teksti täyttää WCAG AA -kontrastin', (t) => {
  const failures = [];
  const table = [];
  for (const pair of PAIRS) {
    const result = measure(pair);
    table.push(`${result.ratio.toFixed(2).padStart(5)}:1 (vaatimus ${result.required}) ${pair.what}`);
    if (result.ratio < result.required) failures.push(`${pair.what}: ${result.ratio.toFixed(2)}:1 < ${result.required}:1`);
  }
  t.diagnostic(table.join('\n'));
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('tekstisävyt ovat tummempia kuin logon sävyt, ja logon sävyt jäävät reunoihin ja palkkeihin', () => {
  for (const [ink, brand] of [['--sage-ink', '--sage'], ['--gold-ink', '--gold'], ['--clay-ink', '--clay'], ['--path-ink', '--path']]) {
    assert.ok(ink in TOKENS, `${ink} määritelty`);
    const white = parseColor('#FFFFFF', TOKENS);
    assert.ok(contrast(parseColor(`var(${ink})`, TOKENS), white) > contrast(parseColor(`var(${brand})`, TOKENS), white), ink);
  }
  // Palkki ja vakavuuden reunaviiva käyttävät yhä logon sävyä (ei tekstiä).
  assert.equal(declarations(RULES, '.dir-bar.is-over .dir-bar-fill').background, 'var(--clay)');
  assert.equal(declarations(RULES, '.dir-signal.dir-strong')['border-left-color'], 'var(--clay)');
});

test('yksikään sääntö ei käytä logon kirkasta sävyä tekstin värinä valkoisen tai kerman päällä', () => {
  const offenders = [];
  for (const rule of RULES) {
    const color = rule.decls.color;
    if (!color) continue;
    if (/^var\(--(sage|gold|clay|path)\)$/.test(color)) offenders.push(`${rule.selectors.join(', ')} { color:${color} }`);
  }
  // Kuvakkeet (ei tekstiä), joiden vieressä on aina teksti.
  const decorative = ['.add-row svg'];
  assert.deepEqual(offenders.filter(line => !decorative.some(selector => line.startsWith(selector))), []);
});

test('mittari laskee oikein: tunnetut suhteet', () => {
  const white = [255, 255, 255, 1];
  const black = [0, 0, 0, 1];
  assert.equal(contrast(white, black).toFixed(1), '21.0');
  assert.equal(contrast(parseColor('#93A29A', TOKENS), white).toFixed(2), '2.67', 'vanha --text-3');
  assert.equal(isLargeText(24, 400), true);
  assert.equal(isLargeText(19, 700), true);
  assert.equal(isLargeText(18, 700), false);
  const halfWhite = composite([255, 255, 255, 0.5], black);
  assert.deepEqual(halfWhite.map(Math.round), [128, 128, 128, 1]);
});
