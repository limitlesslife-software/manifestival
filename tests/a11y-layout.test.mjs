// Saavutettavuus Day 1: kosketusalueet vähintään 44 px (CRIT-05) ja
// 360 px leveä näyttö ilman vaakavieritystä (aloitus, arviojono,
// ajastinpalkki, kirjausdialogi). Staattinen tarkistus styles.css:stä;
// oikea selainmittaus on tools/e2e:n mobiiliskenaariossa.
//
// Ennen: "Palaa tähän viikkoon" noin 16 px korkea (ei täytettä),
// viikon nuolet 36 x 36, valintarivit (Karkea arvio, Valitse, Älä kysy
// tätä) noin 20 px ja ruutu 16 x 16.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';
import { parseRules, declarations, px } from './helpers/a11yCss.mjs';

const CSS = read('src/styles.css');
const RULES = parseRules(CSS);
const MIN_TARGET = 44;
/** 360 px näyttö, kapean näytön sivutäyte 16 px kummallakin puolella. */
const NARROW_CONTENT = 360 - 2 * 16;

function decl(selector, property) {
  return declarations(RULES, selector)[property];
}

function targetHeight(selector) {
  return Math.max(px(decl(selector, 'min-height')) ?? 0, px(decl(selector, 'height')) ?? 0);
}

// ================================================================ KOSKETUSALUEET

test('CRIT-05 KRIITTINEN: viikon nuolet, "Palaa tähän viikkoon" ja valintarivit ovat vähintään 44 px', () => {
  assert.ok(px(decl('.nav-arrow', 'width')) >= MIN_TARGET, '.nav-arrow leveys');
  assert.ok(px(decl('.nav-arrow', 'height')) >= MIN_TARGET, '.nav-arrow korkeus');
  assert.ok(targetHeight('.jump-link') >= MIN_TARGET, '.jump-link');
  assert.match(decl('.jump-link', 'padding') || '', /^0 \d+px$/, '.jump-link: vaakatäyte leventää kohdetta');
  assert.ok(targetHeight('.checkbox-row') >= MIN_TARGET, '.checkbox-row');
  assert.ok(targetHeight('.check-row') >= MIN_TARGET, '.check-row');
  for (const selector of ['.checkbox-row input', '.check-row input']) {
    assert.ok(px(decl(selector, 'width')) >= 20 && px(decl(selector, 'height')) >= 20, `${selector} vähintään 20 px`);
  }
  // Fokus näkyy myös uudessa kohteessa.
  assert.match(decl('.jump-link:focus-visible', 'outline') || '', /solid/);
});

/**
 * Onko elementillä (luokat) 44 px:n korkeus jostain säännöstä, jonka
 * viimeinen osa koostuu vain sen luokista (esim. `.timer-actions .assist-btn`
 * tai `.dir-quick .assist-btn` käy `assist-btn`-painikkeelle).
 */
function hasTargetRule(classes, tag) {
  return RULES.some(rule => rule.media === null && rule.selectors.some(selector => {
    const last = selector.split(/[\s>]+/).pop();
    const match = /^([a-z]*)((?:\.[\w-]+)+)(\[[^\]]+\])?$/.exec(last);
    if (!match) return false;
    if (match[1] && match[1] !== tag) return false;
    const needed = match[2].split('.').filter(Boolean);
    if (!needed.every(cls => classes.includes(cls))) return false;
    if (match[3]) return false;
    return Math.max(px(rule.decls['min-height']) ?? 0, px(rule.decls.height) ?? 0) >= MIN_TARGET;
  }));
}

/** Staattiset luokat merkinnästä: `${...}`-osat jätetään pois. */
function staticClasses(attribute) {
  return attribute.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(cls => /^[\w-]+$/.test(cls));
}

function suuntaMarkup() {
  const html = read('index.html');
  const start = html.indexOf('id="screen-direction"');
  const screen = html.slice(start, html.indexOf('</section>', start));
  const bar = /<div class="timer-bar"[^>]*><\/div>/.exec(html)[0];
  return [screen, bar, ...['src/app/views/direction.js', 'src/app/views/directionSetup.js', 'src/app/views/timeLog.js'].map(readCode)];
}

test('CRIT-05: jokainen Day 1 -näkymän painike ja valintarivi on vähintään 44 px korkea', () => {
  const missing = [];
  let checked = 0;
  for (const source of suuntaMarkup()) {
    for (const match of source.matchAll(/<(button|label)\b[^>]*?\bclass="([^"]*)"/g)) {
      const [, tag, attribute] = match;
      const classes = staticClasses(attribute);
      if (tag === 'label' && !classes.some(cls => /checkbox-row|check-row|dir-setup-choice/.test(cls))) continue;
      if (classes.length === 0) continue;
      checked += 1;
      if (!hasTargetRule(classes, tag)) missing.push(`<${tag} class="${attribute}">`);
    }
  }
  assert.ok(checked >= 30, `tarkistettiin ${checked}`);
  assert.deepEqual([...new Set(missing)], []);
});

test('CRIT-05: aloituksen, arviojonon ja kirjauksen kentät ja "Miksi?"-avaimet ovat vähintään 44 px', () => {
  for (const selector of [
    '.dir-setup input[type="text"], .dir-setup input[type="number"], .dir-setup select',
    '.dir-assign-row select, .dir-estimate-row input',
    '.dir-time-assign select',
    '.time-log-custom input, .time-log-body select',
    '.dir-goal-row select',
    '.dir-setup-choice',
    '.dir-setup-dismiss',
    '.dir-why summary',
    '.dir-history summary',
    '.time-log-preset',
    '.assist-btn',
    '.form-btn'
  ]) {
    const first = selector.split(',')[0].trim();
    assert.ok(targetHeight(first) >= MIN_TARGET, selector);
  }
});

// ================================================================ 360 PX

const DAY1_PREFIXES = ['.dir-setup', '.dir-queue', '.dir-estimate', '.time-log', '.timer-', '.dir-presets',
  '.dir-quick', '.dir-time-assign', '.checkbox-row', '.check-row', '.jump-link', '.nav-arrow', '.nav-row', '.dir-goal-row'];

test('360 px: aloituksen, arviojonon ja ajastimen säännöissä ei ole kapeaa näyttöä leveämpiä mittoja', () => {
  const offenders = [];
  for (const rule of RULES) {
    if (!rule.selectors.some(selector => DAY1_PREFIXES.some(prefix => selector.includes(prefix)))) continue;
    for (const property of ['width', 'min-width', 'flex-basis']) {
      const value = px(rule.decls[property]);
      if (value !== null && value > NARROW_CONTENT) offenders.push(`${rule.selectors.join(', ')} ${property}:${value}px`);
    }
    const basis = /^\S+\s+\S+\s+(\d+(?:\.\d+)?)px$/.exec(rule.decls.flex || '');
    if (basis && Number(basis[1]) > NARROW_CONTENT) offenders.push(`${rule.selectors.join(', ')} flex:${rule.decls.flex}`);
    if (/nowrap/.test(rule.decls['white-space'] || '')) offenders.push(`${rule.selectors.join(', ')} white-space:nowrap`);
  }
  assert.deepEqual(offenders, []);
});

test('360 px: rivit rivittyvät ja pitkät nimet katkeavat (ei vaakavieritystä)', () => {
  for (const selector of ['.dir-setup-choices', '.dir-setup-inline', '.dir-setup-nav', '.dir-presets', '.dir-quick',
    '.timer-bar', '.timer-info', '.timer-actions', '.dir-queue-done li', '.time-log-custom', '.assist-actions']) {
    assert.equal(decl(selector, 'flex-wrap'), 'wrap', `${selector} rivittyy`);
  }
  for (const selector of ['.dir-setup-title', '.dir-setup-fieldset legend', '.timer-target', '.dir-queue-done li span']) {
    assert.equal(decl(selector, 'overflow-wrap'), 'anywhere', `${selector}: pitkä nimi katkeaa`);
  }
  assert.equal(decl('.assist-title', 'word-break'), 'break-word');
  // Fieldsetin oletus min-width:min-content venyttäisi sisällön leveyteen.
  assert.equal(decl('.dir-setup-fieldset', 'min-width'), '0');
  assert.equal(decl('.timer-pending-slot', 'min-width'), '0');
  for (const selector of ['.dir-setup-choice', '.dir-setup input[type="text"]', '.time-log-custom input']) {
    assert.equal(decl(selector, 'max-width'), '100%', `${selector} max-width`);
  }
  assert.match(decl('.time-log-dialog', 'max-width'), /calc\(100vw - 24px\)/);
  assert.equal(decl('.screen', 'overflow-x'), 'hidden');
  const narrow = declarations(RULES, '.screen', { media: '@media (max-width:380px)' });
  assert.equal(narrow['padding-left'], '16px');
});

test('360 px: viikon navigointi mahtuu (kaksi 44 px nuolta ja otsikko)', () => {
  const arrows = 2 * px(decl('.nav-arrow', 'width')) + 2 * px(decl('.nav-row', 'gap'));
  assert.ok(NARROW_CONTENT - arrows >= 180, `otsikolle jää ${NARROW_CONTENT - arrows} px`);
  assert.equal(decl('.nav-arrow', 'flex-shrink'), '0');
});

test('CSS:n piilotukset, joihin näppäimistötesti nojaa, ovat yhä styles.css:ssä', () => {
  // tests/helpers/a11ySuunta.mjs CSS_HIDDEN
  assert.equal(decl('.dir-setup-active .dir-section:not(.dir-setup)', 'display'), 'none');
  assert.equal(decl('.dir-setup-active #dirQuickActions', 'display'), 'none');
  assert.equal(decl('.voice-overlay', 'display'), 'none');
  assert.equal(decl('.voice-overlay.open', 'display'), 'flex');
});
