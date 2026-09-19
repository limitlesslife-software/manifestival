// Saavutettavuus uusille virroille: puhe, komennot, tilin poisto, sijainti,
// lähtökortit ja offline-tila.
//
// Selaimetonta testausta: lähdetekstistä todistetaan rakenteelliset
// takuut (nimet, roolit, fokus, kosketuskohteet). Ruudunlukijan ja
// näppäimistön todellinen käyttö vaatii laitehyväksynnän (backlog).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';

const html = read('index.html');
const css = read('src/styles.css');

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start > -1, startMarker);
  const end = endMarker ? source.indexOf(endMarker, start) : source.length;
  return source.slice(start, end === -1 ? undefined : end);
}

/** Jokaisella input/textarea/select-kentällä on <label for=id> tai aria-label. */
function assertLabelled(markup, where) {
  const controls = [...markup.matchAll(/<(input|textarea|select)\b([^>]*)>/g)];
  assert.ok(controls.length > 0, where);
  for (const [, , attrs] of controls) {
    const id = /\bid="([^"]+)"/.exec(attrs);
    const hasAria = /aria-label(ledby)?="/.test(attrs);
    const hasLabel = id && new RegExp(`<label[^>]*\\bfor="${id[1]}"`).test(markup);
    assert.ok(hasAria || hasLabel, `${where}: nimeämätön kenttä ${attrs.trim().slice(0, 60)}`);
  }
}

// ------------------------------------------------------------------- puhe

test('puhepaneeli: dialogi, nimi ja modaalisuus', () => {
  const overlay = block(html, 'id="voiceOverlay"', '<script type="module"');
  assert.match(overlay, /role="dialog"/);
  assert.match(overlay, /aria-modal="true"/);
  assert.match(overlay, /aria-label="Puheohjaus"/);
});

test('puhepaneeli: tunnistetun tekstin kenttä on nimetty ja kaikki painikkeet ovat type=button', () => {
  const overlay = block(html, 'id="voiceOverlay"', '<script type="module"');
  assertLabelled(overlay, 'puhepaneeli');
  assert.match(overlay, /<label[^>]*for="vfTranscriptText"/);
  for (const [, attrs] of overlay.matchAll(/<button\b([^>]*)>/g)) {
    assert.match(attrs, /type="button"/, attrs.slice(0, 60));
  }
});

test('puhepaneeli: tilat kertovat itsensä ruudunlukijalle (status/alert) ja piilotetut tilat ovat piilossa', () => {
  const overlay = block(html, 'id="voiceOverlay"', '<script type="module"');
  assert.match(overlay, /id="voiceState-processing"[\s\S]*?role="status"/);
  assert.match(overlay, /id="voiceErrorMsg" role="alert"/);
  assert.match(overlay, /id="voiceTranscript" role="status"/);
  for (const state of ['processing', 'transcript', 'error', 'typefallback']) {
    assert.match(overlay, new RegExp(`id="voiceState-${state}" style="display:none;"`), state);
  }
});

test('puhepaneeli: fokus siirtyy sisään avattaessa, palaa avaajaan suljettaessa, Esc sulkee', () => {
  const voice = readCode('src/app/voice.js');
  assert.match(voice, /opener = typeof document !== 'undefined' \? document\.activeElement : null/);
  assert.match(voice, /close\.focus\(\)/);
  assert.match(voice, /opener\.focus\(\)/);
  assert.match(voice, /event\.key === 'Escape'/);
  assert.match(block(voice, 'function closeOverlay', 'function stopRecognition'), /stopRecognition\(\)/,
    'puhe ei jää kuuntelemaan suljetun paneelin takana');
});

test('puhepaneelin Enter lähettää muokatun tekstin, ei lisää rivinvaihtoa vahingossa', () => {
  const voice = readCode('src/app/voice.js');
  assert.match(voice, /event\.key === 'Enter'\) \{ event\.preventDefault\(\); submitTranscript/);
});

test('haun komentopainike on nimetty tekstillä', () => {
  assert.match(readCode('src/app/search.js'), /button\.textContent = `Tulkitse komentona/);
});

// ------------------------------------------------------------- tilin poisto

test('tilin poisto: jokainen kenttä nimetty, virheet ja tila kuulutetaan, vaarallinen painike oletuksena pois päältä', () => {
  const source = read('src/app/accountDeletion.js');
  const confirm = block(source, 'case FLOW.CONFIRM:', 'case FLOW.DELETING:');
  assertLabelled(confirm, 'poiston vahvistus');
  assert.match(confirm, /role="alert"/, 'varoitus kuulutetaan');
  assert.match(confirm, /id="pfDeletionStatus" role="status" aria-live="polite"/);
  assert.match(confirm, /aria-describedby="pfDeletionStatus"/);
  assert.match(confirm, /id="pfDeletionSubmitBtn"[^>]*disabled aria-disabled="true"/);

  assert.match(block(source, 'case FLOW.DELETING:', 'case FLOW.REAUTH:'), /role="status" aria-live="assertive"/);
  assert.match(block(source, 'case FLOW.FAILED:', 'case FLOW.DONE:'), /role="alert"/);
  assert.match(block(source, 'case FLOW.REAUTH:', 'case FLOW.FAILED:'), /role="alert"/);
});

test('tilin poisto: kentät eivät automaattitäydennä eikä korjaa, ja Esc peruu', () => {
  const source = read('src/app/accountDeletion.js');
  const confirm = block(source, 'case FLOW.CONFIRM:', 'case FLOW.DELETING:');
  assert.equal((confirm.match(/autocomplete="off"/g) || []).length, 2);
  assert.equal((confirm.match(/spellcheck="false"/g) || []).length, 2);
  assert.match(source, /event\.key === 'Escape'\) reset\(\)/);
  assert.match(source, /focus\('pfDeletionEmail'\)/, 'fokus siirtyy vahvistuskenttään');
  assert.match(block(source, 'function reset()', 'function wire()'), /focus\('pfDeletionPreviewBtn'\)/,
    'fokus ei katoa vaiheen vaihtuessa');
});

test('tilin poisto: lopullinen dialogi asettaa fokuksen Peruuta-painikkeeseen (tuhoava ei ole oletus)', () => {
  assert.match(read('src/ui/confirm.js'), /Fokus peruutukseen: vaarallinen toiminto ei saa olla oletusvalinta/);
  assert.match(read('src/app/accountDeletion.js'), /destructive: true/);
});

// ------------------------------------------------------------------- sijainti

test('sijaintiosio: tila kuulutetaan, painikkeet ovat tekstillisiä ja type=button', () => {
  const source = read('src/app/views/profile.js');
  const controls = block(source, 'function locationControlsHtml', 'function wireLocationControls');
  assert.match(controls, /id="pfLocationMsg" role="status" aria-live="polite"/);
  const buttons = [...controls.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)];
  assert.ok(buttons.length >= 3);
  for (const [, attrs, label] of buttons) {
    assert.match(attrs, /type="button"/);
    assert.ok(label.trim().length > 3, 'painikkeella ei ole tekstiä: ' + attrs);
  }
  assert.match(controls, /Sijaintia haetaan vain kun pyydät/);
});

// -------------------------------------------------------------------- lähtö

test('lähtökortti: tila ilmaistaan tekstillä (ei vain värillä) eikä jokainen kortti ole live-alue', () => {
  const source = read('src/app/views/travel.js');
  const card = block(source, 'const STATE_TAGS', 'function planRowHtml');
  for (const label of ['Ei vielä', 'Valmistaudu', 'Lähtö pian', 'Lähde nyt', 'Myöhässä']) {
    assert.ok(card.includes(label), label);
  }
  assert.equal(/role="status"|aria-live/.test(card), false,
    'kortin uudelleenrenderöinti ei saa kuulutella jokaista korttia');
  assert.match(card, /<label class="visually-hidden" for="est-/, 'matka-aikakenttä on nimetty');
});

// ---------------------------------------------------------------- offline

test('offline-tilarivi: painike, kuulutus, nimi ja poissa käytöstä kun ei vaadi toimintaa', () => {
  assert.match(html, /<button[^>]*class="sync-status"[^>]*id="syncStatus"[^>]*hidden[^>]*aria-live="polite"/);
  const status = read('src/app/offlineStatus.js');
  assert.match(status, /node\.disabled = !view\.needsReview/);
  assert.match(status, /setAttribute\('aria-label', view\.text \+ '\. Avaa tarkistus\.'\)/);
  assert.match(status, /node\.hidden = view\.text === ''/);
});

test('odottava tehtävä on merkitty tekstillä', () => {
  assert.match(read('src/app/views/tasks.js'), /Odottaa synkronointia/);
});

// --------------------------------------------- kosketuskohteet ja rivitys

test('kosketuskohteet: painikkeiden vähimmäiskorkeus on 44 px', () => {
  for (const selector of ['\\.form-btn', '\\.voice-btn', '\\.assist-btn']) {
    assert.match(css, new RegExp(`${selector}\\s*\\{[^}]*min-height:\\s*44px`), selector);
  }
  assert.match(css, /\.sync-status\.needs-review\s*\{[^}]*min-height:44px/);
});

test('suomen pitkät sanat rivittyvät: tilarivi ja tekstialue eivät vuoda leveyteen', () => {
  assert.match(css, /\.sync-status\s*\{\s*overflow-wrap:anywhere/);
  assert.match(css, /textarea\.voice-field\s*\{[^}]*resize:vertical/);
});

test('tila ei perustu pelkkään väriin: sävyn mukana on aina teksti', () => {
  const status = read('src/domain/offlineQueue.js');
  for (const text of ['Offline', 'Synkronoidaan', 'Synkronointi epäonnistui', 'Vaatii tarkistuksen']) {
    assert.ok(status.includes(text), text);
  }
});
