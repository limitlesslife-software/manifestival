// Saavutettavuuden regressiotestit.
//
// Nämä eivät korvaa oikeaa saavutettavuusauditointia ruudunlukijalla, mutta ne
// estävät tavallisimmat ja helpoiten palautuvat virheet: nimetön painike,
// nimetön lomakekenttä, klikattava div, katoava fokus.
//
// Manifestival on suunnattu kiireisille ihmisille, joista osa käyttää sitä
// yhdellä kädellä liikkeessä. Näppäimistö- ja ruudunlukijatuki ei ole
// lisäominaisuus vaan osa samaa tavoitetta.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { browserModules, read, readIndexHtml } from './helpers/sources.mjs';

const html = readIndexHtml();
const css = read('src/styles.css');

/** Näkymät sellaisina kuin navigaatio ne tuntee — yksi totuuden lähde. */
function declaredScreens() {
  const source = read('src/app/navigation.js');
  const block = /export const SCREENS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(source);
  assert.ok(block, 'SCREENS-listaa ei löytynyt navigation.js:stä');
  return [...block[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
}

/** Kaikki merkintä: index.html + moduulien tuottamat HTML-koosteet. */
function allMarkup() {
  return [html, ...browserModules().map(read)].join('\n');
}

// --------------------------------------------------------- perusrakenne

test('dokumentilla on kieli ja otsikko', () => {
  assert.match(html, /<html lang="fi">/);
  assert.match(html, /<title>Manifestival<\/title>/);
});

test('viewport sallii zoomauksen', () => {
  const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html);
  assert.ok(viewport);
  // maximum-scale=1 estäisi zoomauksen — se on saavutettavuusongelma
  // näkörajoitteisille ja poistettiin WP2:ssa.
  assert.equal(viewport[1].includes('maximum-scale'), false,
    'zoomausta ei saa estää');
  assert.equal(viewport[1].includes('user-scalable=no'), false);
});

test('näkymillä on rooli ja saavutettava nimi', () => {
  const screens = [...html.matchAll(/<section class="screen[^"]*" id="(screen-[^"]+)"([^>]*)>/g)];
  // Lukumäärä luetaan navigation.js:stä, jottei testi jää jälkeen kun
  // sovellukseen lisätään näkymä.
  assert.equal(screens.length, declaredScreens().length,
    'näkymien määrä ei vastaa navigation.js:n SCREENS-listaa');
  assert.deepEqual(screens.map(match => match[1]), declaredScreens());
  for (const [, id, attributes] of screens) {
    assert.ok(attributes.includes('role="tabpanel"'), id + ': rooli puuttuu');
    assert.ok(attributes.includes('aria-label='), id + ': nimi puuttuu');
  }
});

test('navigaatio on merkitty tab-listaksi', () => {
  assert.match(html, /<nav class="tab-bar" role="tablist" aria-label="[^"]+"/);
  const tabs = [...html.matchAll(/<button class="tab-btn[^"]*"([^>]*)>/g)];
  assert.equal(tabs.length, declaredScreens().length,
    'jokaisella näkymällä on oltava välilehti');
  for (const [, attributes] of tabs) {
    assert.ok(attributes.includes('role="tab"'), 'tab-rooli puuttuu');
    assert.ok(attributes.includes('aria-selected='), 'aria-selected puuttuu');
  }
});

// ------------------------------------------------------------- painikkeet

test('jokaisella ikonipainikkeella on saavutettava nimi', () => {
  // Painike, jonka sisältö on pelkkä SVG, on ruudunlukijalle nimetön ellei
  // sillä ole aria-labelia.
  const nameless = [];
  for (const match of allMarkup().matchAll(/<button([^>]*)>\s*(<svg[\s\S]{0,200}?<\/svg>|<span[^>]*><\/span>)\s*<\/button>/g)) {
    const attributes = match[1];
    if (!attributes.includes('aria-label')) nameless.push(match[0].slice(0, 80));
  }
  assert.deepEqual(nameless, [], 'nimettömiä ikonipainikkeita:\n' + nameless.join('\n'));
});

test('kaikilla painikkeilla on type-attribuutti', () => {
  // Ilman type-määrettä painike on lomakkeen sisällä submit ja lähettää sen
  // vahingossa. Sovelluksessa on kaksi lomaketta.
  const missing = [];
  for (const match of html.matchAll(/<button((?:(?!>)[\s\S])*)>/g)) {
    if (!/\stype="/.test(match[1])) missing.push(match[0].slice(0, 70));
  }
  assert.deepEqual(missing, [], 'painikkeita ilman type-määrettä:\n' + missing.join('\n'));
});

test('koristeelliset SVG:t on piilotettu ruudunlukijalta', () => {
  const visible = [];
  for (const source of [html, ...browserModules().map(read)]) {
    for (const match of source.matchAll(/<svg((?:(?!>)[\s\S])*)>/g)) {
      const attributes = match[1];
      if (attributes.includes('aria-hidden')) continue;
      if (attributes.includes('role=')) continue;
      if (attributes.includes('class="timeline-path"')) continue;
      visible.push(match[0].slice(0, 70));
    }
  }
  assert.deepEqual(visible, [],
    'SVG ilman aria-hidden — ruudunlukija lukisi sen sisällön:\n' + visible.join('\n'));
});

// ------------------------------------------------------------- lomakkeet

test('jokaisella lomakekentällä on nimi', () => {
  const labelledIds = new Set([...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map(m => m[1]));
  const unlabelled = [];

  for (const match of html.matchAll(/<(input|select|textarea)((?:(?!>)[\s\S])*)>/g)) {
    const attributes = match[2];
    const idMatch = /\bid="([^"]+)"/.exec(attributes);
    if (!idMatch) continue;

    const id = idMatch[1];
    const hasLabel = labelledIds.has(id);
    const hasAria = attributes.includes('aria-label');
    // Checkbox voi olla label-elementin sisällä ilman for-määrettä.
    const isWrapped = attributes.includes('type="checkbox"');

    if (!hasLabel && !hasAria && !isWrapped) unlabelled.push(id);
  }

  assert.deepEqual(unlabelled, [], 'nimettömiä lomakekenttiä: ' + unlabelled.join(', '));
});

test('numerokentillä on järkevät rajat', () => {
  const numeric = [...html.matchAll(/<input type="number"((?:(?!>)[\s\S])*)>/g)];
  assert.ok(numeric.length >= 5);
  for (const [full, attributes] of numeric) {
    assert.ok(attributes.includes('min='), 'min puuttuu: ' + full.slice(0, 60));
    assert.ok(attributes.includes('max='), 'max puuttuu: ' + full.slice(0, 60));
  }
});

// --------------------------------------------------------------- dialogit

test('dialogeilla on modaalisemantiikka', () => {
  for (const id of ['onboarding', 'voiceOverlay']) {
    const pattern = new RegExp('id="' + id + '"([\\s\\S]{0,300})');
    const context = pattern.exec(html);
    const before = html.slice(Math.max(0, html.indexOf('id="' + id + '"') - 200),
      html.indexOf('id="' + id + '"') + 200);
    assert.ok(context, id + ' puuttuu');
    assert.ok(before.includes('role="dialog"'), id + ': role="dialog" puuttuu');
    assert.ok(before.includes('aria-modal="true"'), id + ': aria-modal puuttuu');
  }
});

test('vahvistusdialogi käyttää natiivia dialog-elementtiä', () => {
  // Natiivi <dialog> tuo fokusloukun, Esc-näppäimen ja oikean semantiikan
  // ilman omaa toteutusta.
  const confirm = read('src/ui/confirm.js');
  assert.ok(confirm.includes("createElement('dialog')"));
  assert.ok(confirm.includes('showModal'));
  assert.ok(confirm.includes('cancelButton.focus()'),
    'fokuksen pitää mennä peruutukseen, ei vaaralliseen toimintoon');
});

test('ilmoitukset kerrotaan ruudunlukijalle', () => {
  const toast = read('src/ui/toast.js');
  assert.ok(toast.includes("setAttribute('aria-live'"), 'aria-live puuttuu');
  assert.ok(toast.includes("role', tone === 'error' ? 'alert' : 'status'"),
    'virheen pitää olla alert, muut status');
});

// ----------------------------------------------------- näppäimistökäyttö

test('välilehtien välillä voi liikkua nuolinäppäimillä', () => {
  const navigation = read('src/app/navigation.js');
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.ok(navigation.includes(key), 'näppäin puuttuu: ' + key);
  }
  assert.ok(navigation.includes("setAttribute('tabindex'"),
    'vain aktiivisen välilehden pitää olla sarkainjärjestyksessä');
});

test('piilotettu näkymä on poissa sarkainjärjestyksestä', () => {
  const navigation = read('src/app/navigation.js');
  assert.ok(navigation.includes("setAttribute('inert'"),
    'inert estää fokuksen piilotettuun näkymään');
  assert.ok(navigation.includes("aria-hidden"), 'aria-hidden puuttuu');
});

test('lomakkeen voi sulkea Escillä ja tallentaa Enterillä', () => {
  const tasks = read('src/app/views/tasks.js');
  assert.ok(tasks.includes("event.key === 'Escape'"));
  assert.ok(tasks.includes("event.key === 'Enter'"));
});

test('puhepaneelin voi sulkea Escillä', () => {
  assert.ok(read('src/app/voice.js').includes("event.key === 'Escape'"));
});

test('klikattavat rivit ovat painikkeita, eivät divejä', () => {
  // Aiemmin rivit olivat <div data-edit> joilla oli click-kuuntelija —
  // näppäimistöllä niihin ei päässyt lainkaan.
  const withDataEdit = [];
  for (const file of browserModules()) {
    const source = read(file);
    for (const match of source.matchAll(/<(\w+)[^>]*data-edit=/g)) {
      if (match[1] !== 'button') withDataEdit.push(file + ': <' + match[1] + '>');
    }
    for (const match of source.matchAll(/<(\w+)[^>]*data-toggle=/g)) {
      if (match[1] !== 'button') withDataEdit.push(file + ': <' + match[1] + '>');
    }
  }
  assert.deepEqual(withDataEdit, [],
    'klikattavia ei-painikkeita:\n' + withDataEdit.join('\n'));
});

// ------------------------------------------------------------- fokus ja tila

test('interaktiivisilla elementeillä on näkyvä fokus', () => {
  const focusable = ['.nav-arrow', '.chk', '.tab-btn', '.day-col', '.task-del',
                     '.auth-tab', '.form-btn', '.signout-btn', '.t-open',
                     '.add-row', '.ghost-btn', '.fab', '.voice-btn'];
  const missing = focusable.filter(selector => !css.includes(selector + ':focus-visible'));
  assert.deepEqual(missing, [], 'fokusindikaattori puuttuu: ' + missing.join(', '));
});

test('kuittauspainike kertoo tilansa', () => {
  const sources = browserModules().map(read).join('\n');
  assert.ok(sources.includes('aria-pressed='), 'aria-pressed puuttuu kuittauksesta');
});

test('liikkeen vähentämistä kunnioitetaan', () => {
  assert.ok(css.includes('@media (prefers-reduced-motion:reduce)'));
  for (const animated of ['.fab-ring', '.now-pulse-ring', '.toast']) {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion:reduce)'));
    assert.ok(block.includes(animated), animated + ' jatkaisi animointia');
  }
});

test('latautuvat alueet kertovat tilansa', () => {
  assert.ok(html.includes('role="status"'), 'lataustilan pitää olla status');
  assert.ok(read('src/ui/dom.js').includes("setAttribute('aria-busy'"),
    'aria-busy puuttuu työn ajalta');
});

// ------------------------------------------------------------ responsiivisuus

test('kapea näyttö on huomioitu', () => {
  assert.ok(css.includes('@media (max-width:380px)'), 'kapean näytön säännöt puuttuvat');
});

test('vaakasuuntainen ylivuoto on estetty', () => {
  assert.ok(css.includes('overflow-x:hidden'), 'näkymä voisi vuotaa sivusuunnassa');
});

test('lomakerivit rivittyvät kapealla näytöllä', () => {
  const formRow = css.slice(css.indexOf('.form-row {'), css.indexOf('.form-row {') + 120);
  assert.ok(formRow.includes('flex-wrap:wrap'), 'lomakerivit puristuisivat kapealla näytöllä');
});
