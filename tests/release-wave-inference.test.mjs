// Aallon tunnistus commitista -- ei haaran nimestä.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// `scripts/activation-preflight.mjs` päätteli aiemmin haaran tilan
// pelkästä `git branch --show-current` -tuloksen PITUUDESTA: tyhjä
// merkkijono (irrallinen HEAD, jota tuottaa esim. julkaisuautomaatio,
// joka tarkistaa nimenomaisen commitin) käsiteltiin ESTEENÄ, ei
// tiedoksi. Tulos oli FAIL, joka näytti TÄSMÄLLEEN samalta kuin oikea
// porttivika riippumatta siitä, oliko porttimatriisi todellisuudessa
// aivan oikein.
//
// `tools/release/lineage.mjs`:n `isDetachedHead` ja `waveOfCommit`
// korvaavat sen KESTÄVÄLLÄ tunnisteella: `waveOfCommit` lukee
// annetun commitin OMAN `Release-Wave:`-trailerin, ei koskaan haaran
// nimeä. Se toimii identtisesti riippumatta siitä onko HEAD haaralla
// tai irrallinen.
//
// IRRALLISEN HEADIN TESTAUS
//
// Näiden testien EI SOPINUT irrottaa TÄMÄN työpuun omaa HEADia: se
// muuttaisi git-tilaa jaetusti kaikille tässä työpuussa
// samanaikaisesti ajettaville testiprosesseille (ks. myös
// `tests/production-lineage.test.mjs`:n saman periaatteen
// kommentti). Sen sijaan jokainen "irrallinen HEAD" -skenaario luo
// OMAN, TILAPÄISEN git worktreen (`git worktree add --detach`), joka
// jakaa objektikannan tämän repon kanssa mutta EI kosketa tämän
// työpuun HEADia. Se poistetaan aina lopuksi, myös virhetilanteessa.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import { isDetachedHead, waveOfCommit, waveOfCommitBody } from '../tools/release/lineage.mjs';
import { WAVES } from '../tools/release/waves.mjs';

// Tunnetut aaltocommitit tämän repon historiassa (Release-Wave-trailer
// commitviestissä, ks. tools/release/manifest.mjs:n discoverWaveCommits).
const WAVE_A_SHA = '703c28f365e62595db4150c6bb319f41c1743d1d';
const WAVE_B_SHA = 'ddfc356d7d0d055b3923cdbfefbcb0bb6d92ec9c';
const WAVE_C_SHA = 'cf259d0ef755f7e875cc9cd9c15405eba632e408';

// waves.mjs:n PRODUCTION.sha -- ennen ensimmäistäkään aaltoa, ei
// Release-Wave-traileria. Kelvollinen "mielivaltainen/tuntematon
// commit" -esimerkki: se ON olemassa ja on validi git-historian osa,
// mutta EI kanna aaltomerkintää.
const UNKNOWN_SHA = '63a96c5ab90b10a73369cd66e348f4a3774367e2';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Luo tilapäinen, irrallinen worktree annettuun committiin.
 * Kutsujan vastuulla on poistaa se (`removeWorktree`).
 *
 * PROJEKTIN TALLENNUSSÄÄNTÖ (ACT-08): tilapäinen työpuu luodaan
 * projektikansion sisälle, `<ROOT>/.claude/worktrees/tmp-*` (git-ignoroitu
 * .git/info/exclude:ssa), ei järjestelmän tmp-hakemistoon.
 */
function detachedWorktree(sha) {
  const parent = path.join(ROOT, '.claude', 'worktrees');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'tmp-wave-inference-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(ROOT) + path.sep), `työpuu projektikansion ulkopuolella: ${dir}`);
  // mkdtemp luo hakemiston; git worktree add vaatii olemattoman tai tyhjän.
  execFileSync('git', ['worktree', 'add', '--detach', dir, sha], { cwd: ROOT, stdio: 'ignore' });
  return dir;
}

function removeWorktree(dir) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    // Parhaansa mukaan -- jäänteen siivous ei saa kaataa testiä.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// =====================================================================
// NORMAALI HAARA
// =====================================================================

test('normaali haara: HEAD ei ole irrallinen tässä työpuussa', t => {
  if (!gitAvailable) { t.skip('git ei käytettävissä'); return; }
  // Tämä testi itse ajetaan tavallisella haaralla, ei irrallisena --
  // isDetachedHead(ROOT) kysyy juuri TÄTÄ työpuuta.
  assert.equal(isDetachedHead(ROOT), false);
});

test('KRIITTINEN: waveOfCommit tunnistaa aallot commitin sisällöstä riippumatta ajohetken haarasta', t => {
  if (!gitAvailable) { t.skip('git ei käytettävissä'); return; }
  // Ei vaadi erillistä worktreeta: mikä tahansa git-viite käy, eikä
  // tulos riipu siitä millä haaralla TÄMÄ työpuu sattuu olemaan. Juuri
  // se on koko korjauksen ydin.
  assert.equal(waveOfCommit(WAVE_A_SHA), 'A');
  assert.equal(waveOfCommit(WAVE_B_SHA), 'B');
  assert.equal(waveOfCommit(WAVE_C_SHA), 'C');
});

// =====================================================================
// ACT-07: F–J TUNNISTETAAN (aiempi lauseke tunsi vain BASE|A–E)
// =====================================================================

test('KRIITTINEN: trailer tunnistetaan jokaiselle aallolle synteettisestä viestistä', () => {
  for (const id of ['BASE', ...WAVES.map(w => w.id)]) {
    assert.equal(waveOfCommitBody(`feat(release): aalto\n\nRelease-Wave: ${id}\n`), id, id);
  }
  assert.equal(waveOfCommitBody('feat: ei traileria'), null);
  assert.equal(waveOfCommitBody('Release-Wave: M'), null);
});

test('KRIITTINEN: oikeat F- ja J-aaltocommitit tunnistetaan, J:n kärki ei kanna traileria', t => {
  if (!gitAvailable) { t.skip('git ei käytettävissä'); return; }
  const F_WAVE = 'e05c54bd4fa7d5afffe3efd6ca7a176b0162008e';
  const J_WAVE = 'e96942c296944b4ac1a86d96563f2a1370678d97';
  const J_TIP = '5df40b20cee4f35279a79888959d49c9af88bcc7';
  const present = sha => { try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; } };
  if (![F_WAVE, J_WAVE, J_TIP].every(present)) { t.skip('ehdokashistoria ei ole paikallisesti saatavilla'); return; }
  assert.equal(waveOfCommit(F_WAVE), 'F');
  assert.equal(waveOfCommit(J_WAVE), 'J');
  assert.equal(waveOfCommit(J_TIP), null);
});

// =====================================================================
// IRRALLINEN HEAD -- TUNNETTU AALTOCOMMIT
// =====================================================================

test('KRIITTINEN: irrallinen HEAD tunnetulla aaltocommitilla tunnistetaan oikein', t => {
  if (!gitAvailable) { t.skip('git ei käytettävissä'); return; }
  const dir = detachedWorktree(WAVE_C_SHA);
  try {
    assert.equal(isDetachedHead(dir), true,
      'tilapäinen worktree ei ollut irrallinen -- testi ei todista mitään');
    assert.equal(waveOfCommit('HEAD', dir), 'C',
      'tunnettu aalto C -commit ei tunnistunut irrallisella HEADilla');
  } finally {
    removeWorktree(dir);
  }
});

// =====================================================================
// IRRALLINEN HEAD -- TUNTEMATON/MIELIVALTAINEN COMMIT
// =====================================================================

test('KRIITTINEN: irrallinen HEAD tuntemattomassa commitissa ei arvaa aaltoa', t => {
  if (!gitAvailable) { t.skip('git ei käytettävissä'); return; }
  const dir = detachedWorktree(UNKNOWN_SHA);
  try {
    assert.equal(isDetachedHead(dir), true);
    assert.equal(waveOfCommit('HEAD', dir), null,
      'commitilla ei ole Release-Wave-traileria -- tunnisteen piti '
      + 'palauttaa null, ei arvata jotain aaltoa');
  } finally {
    removeWorktree(dir);
  }
});

// =====================================================================
// RISTIRIITA -- FAIL CLOSED, EI HILJAINEN VALINTA
// =====================================================================

test('KRIITTINEN: ristiriita commitin oman merkinnän ja pyydetyn aallon välillä havaitaan', t => {
  if (!gitAvailable) { t.skip('git ei käytettävissä'); return; }
  // Tämä on TÄSMÄLLEEN se ehto, jonka activation-preflight.mjs testaa:
  // commit on merkitty aalloksi C, operaattori pyytää aaltoa B.
  const commitinAalto = waveOfCommit(WAVE_C_SHA);
  const pyydettyAalto = 'B';

  assert.equal(commitinAalto, 'C');
  assert.notEqual(commitinAalto, pyydettyAalto);
  assert.equal(commitinAalto === null || commitinAalto === pyydettyAalto, false,
    'ristiriita jäi havaitsematta -- esitarkistus olisi hyväksynyt väärän aallon');
});

test('inkonsistentti porttimatriisi ei vastaa yhtäkään aaltoa -- resolveWave ei arvaa', async () => {
  // Tämä on aallon TOINEN riippumaton lähde (porttimatriisi + cache-
  // versio, ks. waves.mjs "KOLME RIIPPUMATONTA LÄHDETTÄ"), testattuna
  // täältä koska tehtävä nimenomaan vaatii regressiosuojan juuri tälle
  // "väärä yhdistelmä ei saa läpäistä hiljaa" -tapaukselle. Kattavampi
  // mutaatiomatriisi on tests/release-waves.test.mjs:ssä; tämä on
  // suora, minimaalinen todiste samasta invariantista.
  const { ALL_GATES, expectedMatrix, resolveWave } = await import('../tools/release/waves.mjs');

  const auttamattaSekoitettu = Object.fromEntries(
    ALL_GATES.map((gate, i) => [gate, i % 2 === 0]));

  // Tämä yhdistelmä ei saa olla mikään kuudesta sallitusta tilasta.
  const onSallittu = ['BASE', 'A', 'B', 'C', 'D', 'E'].some(id => {
    const odotettu = expectedMatrix(id);
    return ALL_GATES.every(g => auttamattaSekoitettu[g] === odotettu[g]);
  });
  assert.equal(onSallittu, false,
    'testin oma "sekoitettu" matriisi osui vahingossa sallittuun tilaan -- korjaa testiaineisto');

  assert.equal(resolveWave(auttamattaSekoitettu), null,
    'epäjohdonmukainen porttimatriisi tunnistettiin jonkin aallon tilaksi sen sijaan että hylättäisiin');
});

// =====================================================================
// ITSE KORJAUS: activation-preflight.mjs KÄYTTÄÄ NÄITÄ, EIKÄ VAIN
// HAARAN NIMEÄ, EIKÄ PYSÄYTÄ AKTIVOINTIA PELKÄSTÄ NIMEN PUUTTEESTA
// =====================================================================

test('KRIITTINEN: esitarkistus todentaa aallon commitin sisällöstä, ei vain haaran nimestä', () => {
  const koodi = read('scripts/activation-preflight.mjs');

  assert.match(koodi, /isDetachedHead/,
    'esitarkistus ei tunnista irrallista HEADia erikseen tyhjästä haaran nimestä');
  assert.match(koodi, /waveOfCommit\('HEAD', ROOT\)/,
    'esitarkistus ei todenna aaltoa commitin omasta Release-Wave-merkinnästä');

  // Haaran NIMEN puuttuminen (irrallinen HEAD) EI saa pysäyttää
  // aktivointia -- se on merkitty ei-estäväksi (blocking=false).
  const haaranNimiTarkistus = /tarkista\('haara', 'HEAD-tila on tunnistettu',[\s\S]{0,300}?\);/
    .exec(koodi);
  assert.ok(haaranNimiTarkistus, '"HEAD-tila on tunnistettu" -tarkistusta ei löytynyt');
  assert.match(haaranNimiTarkistus[0], /,\s*false\s*\)\s*;$/,
    'haaran NIMEN puuttuminen on yhä merkitty esteeksi -- irrallinen HEAD kaataisi '
    + 'esitarkistuksen vaikka aalto olisi täysin oikein');

  // Commitin OMAN aaltomerkinnän ristiriita ON edelleen este (fail
  // closed) -- sitä ei saa hiljentää samalla tavalla.
  const commitinTarkistus = /tarkista\('haara', 'Commitin oma aaltomerkintä[\s\S]{0,400}?\);/
    .exec(koodi);
  assert.ok(commitinTarkistus, 'commitin aaltomerkinnän ristiriitatarkistusta ei löytynyt');
  assert.equal(/,\s*false\s*\)\s*;$/.test(commitinTarkistus[0]), false,
    'commitin ja pyydetyn aallon ristiriita on merkitty ei-estäväksi -- '
    + 'sen PITÄÄ pysäyttää aktivointi, koska se on aito ambiguiteetti');
});

test('esteiden suodatus kunnioittaa blocking-lippua', () => {
  const koodi = read('scripts/activation-preflight.mjs');
  assert.match(koodi, /esteet = tulokset\.filter\(t => !t\.ok && t\.blocking !== false\)/,
    'esteiden suodatus ei ota blocking-lippua huomioon -- ei-estävä WARN '
    + 'pysäyttäisi aktivoinnin siitä huolimatta');
});
