// Aktivoinnin inventaario, esitarkistukset 0009–0013 ja pisteytys.
//
// Oikean kannan todiste on tools/pg-rehearsal (inventaario ja jokainen
// esitarkistus jokaisessa junan tilassa, READ ONLY -transaktiossa).
// Nämä testit vartioivat ilman kantaa sen, mikä voi rikkoutua koodissa:
//
//   1. generoidut SQL-tiedostot ovat ajan tasalla generaattorin kanssa
//      (tunnistuslistat poimitaan migraatioista — käsin muokattu tiedosto
//      voisi erkaantua migraatiosta)
//   2. tiedostot ovat vain lukevia ja yksilauseisia (Supabasen editori
//      näyttää vain viimeisen tuloksen)
//   3. pisteytys tekee oikean päätöksen oikean kannan tuottamista
//      tuloksista (tests/fixtures/activation-inventory, generoitu
//      harjoittelusta: node tools/pg-rehearsal/rehearse.mjs
//      --only=inventory --fixtures=tests/fixtures/activation-inventory)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import { buildInventorySql } from '../tools/activation/build-inventory.mjs';
import { buildPreflight, PREFLIGHT_NUMBERS } from '../tools/activation/build-preflights.mjs';
import {
  REQUIRED_ROWS, ROW, TABLE_REQUIRED_ROWS, classificationLines, classifyActivation, classifyResolved,
  codeWaveFromOrigin, parseInventory, resolveCodeWave, scoreInventory
} from '../tools/activation/score-inventory.mjs';
import { expectedMatrix } from '../tools/release/waves.mjs';

const lf = text => text.replace(/\r\n/g, '\n');
const INVENTORY = 'supabase/acceptance/activation_readonly_inventory.sql';
const FIXTURES = path.join(ROOT, 'tests/fixtures/activation-inventory');
const fixture = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** Koodi ilman kommentteja ja merkkijonoliteraaleja. */
function code(sql) {
  return sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .replace(/\$q\$[\s\S]*?\$q\$/g, "''").replace(/'[^']*'/g, "''").toLowerCase();
}

test('KRIITTINEN: inventaario on ajan tasalla migraatioiden kanssa', () => {
  assert.equal(lf(read(INVENTORY)), buildInventorySql(),
    'aja: node tools/activation/build-inventory.mjs');
});

test('KRIITTINEN: esitarkistukset 0009–0013 ovat ajan tasalla migraatioiden kanssa', () => {
  for (const n of PREFLIGHT_NUMBERS) {
    assert.equal(lf(read(`supabase/preflight/preflight_${n}.sql`)), buildPreflight(n),
      `preflight_${n}.sql: aja node tools/activation/build-preflights.mjs`);
  }
});

test('KRIITTINEN: inventaario ja esitarkistukset ovat vain lukevia ja yksilauseisia', () => {
  const files = [INVENTORY, ...PREFLIGHT_NUMBERS.map(n => `supabase/preflight/preflight_${n}.sql`)];
  for (const file of files) {
    const c = code(read(file));
    assert.equal(/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|comment|lock|vacuum|call|do)\b/.test(c),
      false, `${file}: kirjoittava lause`);
    assert.equal(c.trim().replace(/;\s*$/, '').includes(';'), false, `${file}: useampi lause`);
  }
});

test('inventaario ei lue käyttäjän sisältöä (nimet, muistiinpanot, pohdinnat, summat)', () => {
  const c = code(read(INVENTORY));
  // 'text' (inbox_items.text) jätetään pois: sana on myös tyyppimuunnos ::text.
  for (const column of ['title', 'name', 'note', 'description', 'reflection', 'snapshot',
    'email', 'amount_minor', 'iban', 'payee', 'place', 'destination']) {
    assert.equal(new RegExp(`select[^;]*\\b${column}\\b`).test(c.replace(/column_name\s*=\s*''/g, '')),
      false, `lukee saraketta ${column}`);
  }
});

test('KRIITTINEN: tuotannon nykytila (0008): GO, seuraava 0009 / aalto F', () => {
  const result = scoreInventory(parseInventory(fixture('state-0008.json')));
  assert.equal(result.decision, 'GO');
  assert.equal(result.nextMigration, '0009');
  assert.equal(result.nextWave, 'F');
  assert.match(result.nextAction, /aallot D ja E on deployattu ja E teknisesti hyväksytty \(AUTOMATED_TECHNICAL_ACCEPTANCE\)/);
  assert.match(result.nextAction, /"hyväksyn 0009\/F"/);
});

test('jokainen junan tila johtaa seuraavaan migraatioon', () => {
  // 0013 -> 0014: aalto K (arjen käyttöjärjestelmä) seuraa J:tä.
  const expected = { '0009': '0010', '0010': '0011', '0011': '0012', '0012': '0013', '0013': '0014' };
  for (const [state, next] of Object.entries(expected)) {
    const result = scoreInventory(parseInventory(fixture(`state-${state}.json`)));
    assert.equal(result.decision, 'GO', `tila ${state}: ${result.stops.join('; ')}`);
    assert.equal(result.nextMigration, next, `tila ${state}`);
  }
});

test('KRIITTINEN: keskeneräinen migraatio pysäyttää', () => {
  const result = scoreInventory(parseInventory(fixture('state-0011-partial-0012.json')));
  assert.equal(result.decision, 'STOP');
  assert.equal(result.facts.migrations['0012'], 'partial');
  assert.ok(result.stops.some(s => /0012 on KESKEN/.test(s)));
});

test('KRIITTINEN: puuttuva omistaja (väärä projekti) pysäyttää', () => {
  const result = scoreInventory(parseInventory(fixture('state-0008-no-owner.json')));
  assert.equal(result.decision, 'STOP');
  assert.ok(result.stops.some(s => /omistajaa/.test(s)));
});

test('syöte kelpaa CSV-solusta (lainausmerkit tuplattu) ja taulukkona', () => {
  const cell = fixture('state-0010.json').trim();
  const csv = `nro,osio,tarkistus,arvo\n00,tiiviste,KOPIOI,"${cell.replace(/"/g, '""')}"\n`;
  assert.equal(scoreInventory(parseInventory(csv)).nextMigration, '0011');

  const rows = JSON.parse(cell).rows;
  const table = Object.entries(rows).map(([k, v]) => `${k}\tosio\ttarkistus\t${v}`).join('\n');
  assert.equal(scoreInventory(parseInventory(table)).nextMigration, '0011');
});

test('lukukelvoton syöte ei tuota päätöstä', () => {
  assert.equal(parseInventory('hei'), null);
  assert.equal(parseInventory(''), null);
});

test('turvapoikkeama pysäyttää vaikka migraatiot olisivat kunnossa', () => {
  const rows = { ...JSON.parse(fixture('state-0008.json')).rows, 51: '3' };
  const result = scoreInventory(rows);
  assert.equal(result.decision, 'STOP');
  assert.ok(result.stops.some(s => /anon/.test(s)));
});

test('avoin transaktio on varoitus, ei pysäytys', () => {
  const rows = { ...JSON.parse(fixture('state-0008.json')).rows, 45: '1' };
  const result = scoreInventory(rows);
  assert.equal(result.decision, 'GO');
  assert.ok(result.warnings.some(w => /idle in transaction/.test(w)));
});

// =====================================================================
// ACT-11: PUUTTUVA RIVI EI OLE "KUNNOSSA"
// =====================================================================

const rows0008 = () => ({ ...JSON.parse(fixture('state-0008.json')).rows });

test('KRIITTINEN: puuttuva rivi 43, 44 tai 45 pysäyttää (ei hiljaista GO:ta)', () => {
  for (const key of ['43', '44', '45']) {
    const rows = rows0008();
    delete rows[key];
    const result = scoreInventory(rows);
    assert.equal(result.decision, 'STOP', `rivi ${key}`);
    assert.ok(result.stops.some(s => s.startsWith(`rivi ${key} puuttuu`)), result.stops.join('; '));
  }
  for (const key of ['44', '45']) {
    const rows = rows0008();
    rows[key] = 'puuttuu';
    assert.equal(scoreInventory(rows).decision, 'STOP', `rivi ${key} = puuttuu`);
  }
});

test('puuttuva rivi 01 ei väitä versiota 17.10 riittämättömäksi', () => {
  const rows = rows0008();
  delete rows['01'];
  const result = scoreInventory(rows);
  assert.equal(result.decision, 'STOP');
  assert.ok(result.stops.some(s => /^rivi 01 puuttuu/.test(s)));
  assert.equal(result.stops.some(s => /17\.10.*vähintään/.test(s)), false, result.stops.join('; '));

  const old = { ...rows0008(), '01': '140009', '02': '14.9' };
  assert.ok(scoreInventory(old).stops.some(s => /server_version_num 140009 \(14\.9\)/.test(s)));
});

test('puuttuva migraatiorivi: viesti sanoo "puuttuu", ei "undefined"', () => {
  const rows = rows0008();
  delete rows['22'];
  const result = scoreInventory(rows);
  assert.equal(result.decision, 'STOP');
  assert.ok(result.stops.some(s => /rivi 22 puuttuu/.test(s)));
  assert.equal(result.stops.some(s => /undefined/.test(s)), false, result.stops.join('; '));
});

test('KRIITTINEN: taulukko ilman rivejä 50–52 ei ole inventaario (exit 2)', () => {
  const rows = rows0008();
  const table = Object.entries(rows).filter(([k]) => !['50', '51', '52'].includes(k))
    .map(([k, v]) => `${k}\tosio\ttarkistus\t${v}`).join('\n');
  assert.equal(parseInventory(table), null);
  // Mikä tahansa yli kymmenen rivin taulukko ei enää kelpaa.
  const random = Array.from({ length: 20 }, (_, i) => `${String(i + 10)}\ta\tb\t1`).join('\n');
  assert.equal(parseInventory(random), null);
  assert.ok(TABLE_REQUIRED_ROWS.includes('50') && TABLE_REQUIRED_ROWS.includes('30'));
});

test('JSON-solu kelpaa myös muotoiltuna (välilyönnit)', () => {
  const pretty = JSON.stringify({ inventory: 'mv-activation-v1', rows: rows0008() }, null, 2);
  assert.equal(scoreInventory(parseInventory(pretty)).nextMigration, '0009');
});

test('rivi 89 (kesto > 0) on inventaariossa ja pisteytyksen faktoissa, mutta ei pakollinen', () => {
  const sql = read(INVENTORY);
  assert.match(sql, /select '89'::text as nro/);
  assert.match(sql, /duration_minutes > 0/);
  assert.equal(ROW.tasksWithPositiveDuration, '89');
  assert.equal(REQUIRED_ROWS.includes('89'), false);
  const withRow = { ...rows0008(), 89: '1' };
  assert.equal(scoreInventory(withRow).facts.tasksWithPositiveDuration, 1);
  assert.equal(scoreInventory(rows0008()).facts.tasksWithPositiveDuration, null);
});

// =====================================================================
// ACT-05: KOODIAALTO + KANTA -> SEURAAVA TOIMENPIDE
// =====================================================================

const CODE_WAVES = ['BASE', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];

/** Täysi odotustaulukko: tila -> koodiaalto -> [päätös, laji, aalto, migraatio]. */
const EXPECTED_ACTIONS = {
  '0008': { C: ['GO', 'DEPLOY', 'D'], D: ['GO', 'DEPLOY', 'E'], E: ['GO', 'MIGRATE', 'F', '0009'] },
  '0009': { E: ['GO', 'DEPLOY', 'F'], F: ['GO', 'MIGRATE', 'G', '0010'] },
  '0010': { F: ['GO', 'DEPLOY', 'G'], G: ['GO', 'MIGRATE', 'H', '0011'] },
  '0011': { G: ['GO', 'DEPLOY', 'H'], H: ['GO', 'MIGRATE', 'I', '0012'] },
  '0012': { H: ['GO', 'DEPLOY', 'I'], I: ['GO', 'MIGRATE', 'J', '0013'] },
  '0013': { I: ['GO', 'DEPLOY', 'J'], J: ['GO', 'MIGRATE', 'K', '0014'] },
  // 0014 on junan viimeinen migraatio: K:n jälkeen ei ole seuraavaa toimenpidettä.
  '0014': { J: ['GO', 'DEPLOY', 'K'], K: ['GO', 'DONE', 'K'] }
};
const DB_WAVE = { '0008': 'E', '0009': 'F', '0010': 'G', '0011': 'H', '0012': 'I', '0013': 'J', '0014': 'K' };

test('KRIITTINEN: koko taulukko — tila 0008–0014 × koodiaalto BASE, A–K', () => {
  for (const [state, expectations] of Object.entries(EXPECTED_ACTIONS)) {
    const rows = parseInventory(fixture(`state-${state}.json`));
    const dbIndex = CODE_WAVES.indexOf(DB_WAVE[state]);
    for (const codeWave of CODE_WAVES) {
      const c = classifyActivation(rows, { codeWave });
      const label = `${state} × ${codeWave}`;
      assert.equal(c.currentDbWave, DB_WAVE[state], label);
      assert.equal(c.lastMigration, state, label);
      const expected = expectations[codeWave];
      if (expected) {
        const [decision, kind, wave, migration] = expected;
        assert.equal(c.decision, decision, `${label}: ${c.reason}`);
        assert.equal(c.nextAction.kind, kind, label);
        assert.equal(c.nextAction.wave, wave, label);
        if (migration) assert.equal(c.nextAction.migration, migration, label);
      } else {
        assert.equal(c.decision, 'STOP', `${label}: ${c.reason}`);
        const ahead = CODE_WAVES.indexOf(codeWave) > dbIndex;
        assert.equal(c.nextAction.kind, ahead ? 'ROLLBACK_CODE' : 'STOP', label);
      }
    }
  }
});

test('ACT-05 yksityiskohdat: esitarkistus, varmuuskopio, verify_0012-edellytys ja sallitut aallot', () => {
  const at = (state, codeWave) => classifyActivation(parseInventory(fixture(`state-${state}.json`)), { codeWave });
  assert.equal(at('0008', 'E').nextAction.preflight, 'supabase/preflight/preflight_0009.sql');
  assert.equal(at('0008', 'E').nextAction.ownerGate, 'OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED');
  assert.equal(at('0008', 'C').nextAction.ownerGate, 'OWNER_DEPLOY_APPROVAL_REQUIRED');
  assert.equal(at('0008', 'C').nextAction.requiresAcceptanceOf, 'C');
  assert.equal(at('0009', 'F').nextAction.backupRequired, true);
  assert.equal(at('0008', 'E').nextAction.backupRequired, false);
  assert.equal(at('0012', 'I').nextAction.verifyPrerequisite, 'supabase/verify/verify_0012.sql');
  assert.equal(at('0009', 'E').nextAction.verify, 'supabase/verify/verify_0009.sql');
  assert.match(at('0008', 'F').reason, /koodi edellä kantaa/);
  assert.deepEqual(at('0008', 'C').allowedCodeWaves, ['C', 'D', 'E']);
  assert.deepEqual(at('0010', 'G').allowedCodeWaves, ['F', 'G']);
  assert.equal(at('0013', 'J').nextAction.kind, 'MIGRATE');
  assert.equal(at('0013', 'J').nextAction.migration, '0014');
  assert.equal(at('0013', 'J').nextAction.verifyPrerequisite, 'supabase/verify/verify_0013.sql');
  assert.equal(at('0013', 'J').nextAction.backupRequired, false);
});

test('KRIITTINEN: keskeneräinen 0012 tai 0014 ja puuttuva omistaja pysäyttävät jokaisella koodiaallolla', () => {
  for (const name of ['state-0011-partial-0012.json', 'state-0013-partial-0014.json', 'state-0008-no-owner.json']) {
    const rows = parseInventory(fixture(name));
    for (const codeWave of [...CODE_WAVES, null]) {
      const c = classifyActivation(rows, { codeWave });
      assert.equal(c.decision, 'STOP', `${name} × ${codeWave}`);
      assert.equal(c.nextAction.kind, 'STOP', `${name} × ${codeWave}`);
    }
  }
});

test('KRIITTINEN: koodiaalto tuntematon -> STOP VERIFY_CODE_WAVE, odotus silti kerrotaan', () => {
  const c = classifyActivation(parseInventory(fixture('state-0008.json')), { codeWave: null });
  assert.equal(c.decision, 'STOP');
  assert.equal(c.nextAction.kind, 'VERIFY_CODE_WAVE');
  assert.equal(c.expectedCodeWave, 'E');
  assert.equal(c.currentDbWave, 'E');
  // Kannan terveys (scoreInventory) on ennallaan GO.
  assert.equal(c.base.decision, 'GO');
});

test('CLI-rivit: CURRENT_DB_WAVE, EXPECTED_CODE_WAVE, NEXT_ACTION ja GO/STOP + syy', async () => {
  const { classificationLines } = await import('../tools/activation/score-inventory.mjs');
  const rows = parseInventory(fixture('state-0008.json'));
  const go = classificationLines(classifyActivation(rows, { codeWave: 'C' }));
  assert.equal(go[0], 'CURRENT_DB_WAVE: E (viimeisin ajettu migraatio 0008)');
  assert.equal(go[1], 'EXPECTED_CODE_WAVE: E (sallitut koodiaallot: C, D, E)');
  assert.equal(go[3], 'NEXT_ACTION: DEPLOY D');
  assert.match(go[4], /^GO: kanta 0008 tukee aaltoa E, tuotannossa C: deployaa D/);
  const migrate = classificationLines(classifyActivation(parseInventory(fixture('state-0009.json')), { codeWave: 'F' }));
  assert.match(migrate[3], /^NEXT_ACTION: MIGRATE G 0010 \[esitarkistus supabase\/preflight\/preflight_0010\.sql\] \[VARMUUSKOPIO PAKOLLINEN\]/);
  const stop = classificationLines(classifyActivation(rows, { codeWave: 'F' }));
  assert.match(stop[4], /^STOP: koodi edellä kantaa/);
});

test('hyväksytty aalto ja lukon SHA kulkevat toimenpiteeseen', () => {
  const lock = JSON.parse(read('docs/activation/release-train-c-j.json'));
  const c = classifyActivation(parseInventory(fixture('state-0008.json')), { codeWave: 'C', acceptedWaves: ['C'], lock });
  assert.equal(c.nextAction.requiresAcceptanceOf, null);
  assert.equal(c.nextAction.expectedSha, lock.waves.find(w => w.wave === 'D').deployTarget);
});

// =====================================================================
// TUOTANNON INVENTAARIO 2026-09-26 (rekonstruoitu yhteenvedosta)
// =====================================================================

const PRODUCTION = 'production-2026-09-26.json';

test('KRIITTINEN: tuotannon inventaario 2026-09-26: kanta GO (0008), koodi C -> DEPLOY D', () => {
  const rows = parseInventory(fixture(PRODUCTION));
  const base = scoreInventory(rows);
  assert.equal(base.decision, 'GO', base.stops.join('; '));
  assert.equal(base.nextMigration, '0009');
  assert.equal(base.facts.postgres, '17.6');
  assert.equal(base.facts.authUsers, 1);
  assert.equal(base.facts.tasks, 36);
  assert.equal(base.facts.tasksWithDuration, 0);
  const c = classifyActivation(rows, { codeWave: 'C' });
  assert.equal(c.decision, 'GO');
  assert.equal(c.currentDbWave, 'E');
  assert.equal(c.nextAction.kind, 'DEPLOY');
  assert.equal(c.nextAction.wave, 'D');
});

test('KRIITTINEN: tuotannon fixture kertoo provenienssin, ja rivi 43 on merkitty johdetuksi', () => {
  const parsed = JSON.parse(fixture(PRODUCTION));
  const p = parsed.provenance;
  assert.equal(p.reconstructed, true);
  assert.equal(p.capturedOn, '2026-09-26');
  assert.ok(fs.existsSync(path.join(ROOT, p.doc)), p.doc);
  assert.equal(parsed.rows['43'], '1');
  assert.match(p.derived['43'], /EI HAVAITTU/);
  // Jokainen rivi on joko havaittu tai johdettu — ei kolmatta, selittämätöntä luokkaa.
  for (const key of Object.keys(parsed.rows)) {
    assert.ok(p.observed.includes(key) || key in p.derived, `rivi ${key}: ei havaittu eikä johdettu`);
    assert.equal(p.observed.includes(key) && key in p.derived, false, `rivi ${key}: sekä havaittu että johdettu`);
  }
  for (const key of Object.keys(p.omitted)) assert.equal(key in parsed.rows, false, `rivi ${key} on pois jätetty mutta mukana`);
  // Dokumentin "Johdettu"-taulukko nimeää jokaisen johdetun rivin (yksittäin tai välinä 11–17).
  const doc = read(p.doc);
  const section = doc.slice(doc.indexOf('## Johdettu'), doc.indexOf('## Jätetty pois'));
  const named = new Set();
  for (const m of section.matchAll(/^\| \**(\d{2})(?:–(\d{2}))?\**/gm)) {
    const from = Number(m[1]);
    const to = Number(m[2] || m[1]);
    for (let n = from; n <= to; n++) named.add(String(n).padStart(2, '0'));
  }
  assert.deepEqual([...named].sort(), Object.keys(p.derived).sort(), 'dokumentin johdetut rivit eivät vastaa fixturea');
});

// ---------------------------------------------------------------------
// --code-wave=origin-main: matriisi JA välimuisti (classifyDeployedState)
// ---------------------------------------------------------------------

const origin = (wave, cacheVersion) => ({ available: true, sha: 'ab'.repeat(20), gates: expectedMatrix(wave), cacheVersion });

test('KRIITTINEN: --code-wave=origin-main: peruutusmatriisi (C + v18) -> STOP TRAIN_HALTED_RECUT_REQUIRED', async () => {
  const rows = parseInventory(fixture('state-0008.json'));
  const resolved = await resolveCodeWave('origin-main', { originState: () => origin('C', 'v18') });
  assert.equal(resolved.codeWave, null, 'peruutusta ei saa lukea aalloksi C');
  assert.equal(resolved.stop.class, 'TRAIN_HALTED_RECUT_REQUIRED');
  assert.match(resolved.stop.reason, /aallon D peruutus/);
  const c = classifyResolved(rows, resolved);
  assert.equal(c.decision, 'STOP');
  assert.equal(c.nextAction.kind, 'TRAIN_HALTED_RECUT_REQUIRED');
  assert.match(classificationLines(c).join('\n'), /STOP: TRAIN_HALTED_RECUT_REQUIRED/);
  // Sama kanta ja oikea C (v16) -> DEPLOY D: ero tulee vain välimuistista.
  const ok = await resolveCodeWave('origin-main', { originState: () => origin('C', 'v16') });
  assert.equal(ok.stop, null);
  assert.equal(classifyResolved(rows, ok).nextAction.kind, 'DEPLOY');
});

test('KRIITTINEN: --code-wave=origin-main: epäjohdonmukainen tila -> STOP PRODUCTION_INCONSISTENT', async () => {
  const rows = parseInventory(fixture('state-0008.json'));
  for (const bad of [origin('D', 'v16'), origin('C', null), { ...origin('C', 'v16'), gates: null }, origin('K', 'v25'), origin('J', 'v22')]) {
    const resolved = codeWaveFromOrigin(bad);
    assert.equal(resolved.stop && resolved.stop.class, 'PRODUCTION_INCONSISTENT', JSON.stringify(bad.cacheVersion));
    assert.equal(classifyResolved(rows, resolved).decision, 'STOP');
  }
  const missing = await resolveCodeWave('origin-main', { originState: () => ({ available: false }) });
  assert.equal(classifyResolved(rows, missing).nextAction.kind, 'VERIFY_CODE_WAVE');
});

test('score-inventory-komentorivi ei lue origin/mainin aaltoa pelkästä matriisista', () => {
  const src = read('tools/activation/score-inventory.mjs');
  assert.equal(/origin\.wave/.test(src), false, 'CLI käyttää yhä origin.wave-kenttää (matriisi ilman välimuistia)');
  assert.match(src, /classifyResolved\(rows, resolved\)/);
});

test('KRIITTINEN: pelkillä havaituilla riveillä pisteytys pysähtyy ja nimeää puuttuvat rivit', () => {
  const parsed = JSON.parse(fixture(PRODUCTION));
  const observed = Object.fromEntries(Object.entries(parsed.rows).filter(([k]) => parsed.provenance.observed.includes(k)));
  const result = scoreInventory(observed);
  assert.equal(result.decision, 'STOP');
  for (const key of ['10', '11', '17', '22', '43']) {
    assert.ok(result.stops.some(s => s.startsWith(`rivi ${key} puuttuu`)), `rivi ${key}: ${result.stops.join('; ')}`);
  }
});
