// Esitarkistukset commitista git show'lla (ACT-08): lukitun ehdokkaan voi
// tarkistaa kuittaamatta sitä ulos, eikä oletusajo käännä, testaa eikä
// kirjoita mitään.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROOT, read } from './helpers/sources.mjs';
import { shaOf, stubGit } from './helpers/activation-history.mjs';
import { BROWSER_PATHSPEC, blockingFailures, preflightVerdict, repoChecks } from '../tools/release/preflight-checks.mjs';
import { createGit } from '../tools/release/git-layer.mjs';
import { SQL_SOURCE_WAVE } from '../tools/activation/train-map.mjs';

const lock = JSON.parse(read('docs/activation/release-train-c-j.json'));
const realGit = createGit({ cwd: ROOT });

/** Tynkä-gitin näkymä + perustilan tiedostot, joita repoChecks vaatii. */
function stubShow(overrides = {}) {
  const git = stubGit();
  const base = {
    'docs/PRODUCTION-STATUS.md': null,
    'supabase/migrations/0001_auth_user_scoping.sql': '--', 'supabase/migrations/0002_task_domain_fields.sql': '--',
    'supabase/migrations/0003_routines.sql': '--', 'supabase/migrations/0004_goals_projects.sql': '--',
    'supabase/migrations/0005_notification_preferences.sql': '--', 'supabase/migrations/0006_wellbeing.sql': '--',
    'supabase/migrations/0007_finance.sql': '--', 'supabase/migrations/0008_ai_audit.sql': '--',
    'supabase/acceptance/precheck_0003_0008_auth_final.sql': '--',
    'supabase/acceptance/verify_0003_0008_post_acceptance_final.sql': '--',
    'supabase/verify/verify_0004_0008_final.sql': '--',
    'docs/MIGRATIONS-0004-0008-PRODUCTION-RUNBOOK.md': '#', 'docs/ACTIVATION-0003-0008-RUNBOOK.md': '#'
  };
  return (ref, file) => {
    if (file in overrides && (overrides[file].ref === undefined || overrides[file].ref === ref)) return overrides[file].content;
    if (file === 'docs/PRODUCTION-STATUS.md') {
      const schema = git.show(ref, 'src/data/schema.js') || '';
      return [...schema.matchAll(/^\s{2}(\w+):\s*(true|false)/gm)]
        .map(m => `| \`${m[1]}\` | 00xx | ${m[2] === 'true' ? 'AKTIVOITU' : 'kiinni'} |`).join('\n');
    }
    if (file in base) return base[file];
    return git.show(ref, file);
  };
}

test('KRIITTINEN: synteettinen H: puuttuva verify_0011.sql SQL-lähteessä -> FAIL', () => {
  const ok = repoChecks({ ref: shaOf('H'), wave: 'H', gitShow: stubShow(), sqlRef: shaOf('J') });
  assert.deepEqual(blockingFailures(ok).map(r => `${r.name}: ${r.detail}`), []);

  const gitShow = stubShow({ 'supabase/verify/verify_0011.sql': { ref: shaOf('J'), content: null } });
  const failing = blockingFailures(repoChecks({ ref: shaOf('H'), wave: 'H', gitShow, sqlRef: shaOf('J') }));
  assert.ok(failing.some(r => /verify_0011\.sql on SQL-lähteessä/.test(r.name)), failing.map(r => r.name).join('; '));
});

test('väärä aalto, väärä välimuisti tai puuttuva SQL-lähde -> FAIL', () => {
  assert.ok(blockingFailures(repoChecks({ ref: shaOf('F'), wave: 'G', gitShow: stubShow(), sqlRef: shaOf('J') }))
    .some(r => /Porttimatriisi vastaa aaltoa G/.test(r.name)));
  assert.ok(blockingFailures(repoChecks({ ref: shaOf('F'), wave: 'F', gitShow: stubShow() }))
    .some(r => /SQL-lähde/.test(r.name)));
  const git = stubGit();
  const wrongCache = stubShow({ 'sw.js': { ref: shaOf('D'), content: git.show(shaOf('D'), 'sw.js').replace("'v17'", "'v16'") } });
  assert.ok(blockingFailures(repoChecks({ ref: shaOf('D'), wave: 'D', gitShow: wrongCache }))
    .some(r => /CACHE_VERSION/.test(r.name)));
});

test('salaisuushaku: osuma -> FAIL, grep-virhe -> FAIL (ei hiljaista läpäisyä)', () => {
  const found = repoChecks({ ref: shaOf('D'), wave: 'D', gitShow: stubShow(), gitGrep: () => ['src/app/x.js'] });
  assert.ok(blockingFailures(found).some(r => /AI-avainta/.test(r.name)));
  const broken = repoChecks({ ref: shaOf('D'), wave: 'D', gitShow: stubShow(), gitGrep: () => null });
  assert.ok(blockingFailures(broken).some(r => /git grep epäonnistui/.test(r.detail)));
});

test('KRIITTINEN: service_role-haku kattaa selaimessa ajettavan RLS-hyväksyntäsivun (tools/rls-acceptance)', () => {
  const calls = [];
  const gitGrep = (ref, regex, opts = {}) => { calls.push({ regex, pathspec: opts.pathspec || [] }); return /service_role/.test(regex) && (opts.pathspec || []).includes('tools/rls-acceptance') ? ['tools/rls-acceptance/main.js'] : []; };
  const results = repoChecks({ ref: shaOf('D'), wave: 'D', gitShow: stubShow(), gitGrep });
  const serviceRole = calls.find(c => /service_role/.test(c.regex));
  assert.deepEqual(serviceRole.pathspec, [...BROWSER_PATHSPEC]);
  assert.deepEqual(BROWSER_PATHSPEC, ['src', 'tools/rls-acceptance']);
  const failing = blockingFailures(results);
  assert.ok(failing.some(r => /service_role ei esiinny selaimen koodissa \(src, tools\/rls-acceptance\)/.test(r.name) && /tools\/rls-acceptance\/main\.js/.test(r.detail)),
    failing.map(r => `${r.name}: ${r.detail}`).join('; '));
});

test('KRIITTINEN: loppupäätös kertoo, jos testejä tai koontia EI ajettu', () => {
  assert.equal(preflightVerdict({ wave: 'D', total: 30, blocking: 0, testsRun: false, buildRun: false }),
    'AKTIVOINNIN ESITARKISTUS (D): PASS (testejä/koontia ei ajettu) — 30 tarkistusta');
  assert.match(preflightVerdict({ wave: 'D', total: 30, blocking: 0, testsRun: true, buildRun: false }), /PASS \(koontia ei ajettu\)/);
  assert.match(preflightVerdict({ wave: 'D', total: 30, blocking: 0, testsRun: false, buildRun: true }), /PASS \(testejä ei ajettu\)/);
  assert.match(preflightVerdict({ wave: 'D', total: 30, blocking: 0, testsRun: true, buildRun: true }), /PASS \(testit ja koonti ajettu\)/);
  assert.match(preflightVerdict({ wave: 'F', total: 30, blocking: 2, testsRun: false, buildRun: false }), /FAIL \(2\/30 estettä; testejä\/koontia ei ajettu\)/);
  const cli = read('scripts/activation-preflight.mjs');
  assert.match(cli, /preflightVerdict\(\{/, 'CLI ei käytä yhteistä päätöstekstiä');
  assert.match(cli, /testsRun: testitAjettu, buildRun: käännösAjettu/);
  assert.equal(/ESITARKISTUS \(\$\{ODOTETTU_AALTO\}\): PASS/.test(cli), false, 'CLI:ssä on yhä oma PASS-teksti');
});

test('oikea historia (ehdollinen): lukitut F..K läpäisevät esitarkistuksen ilman checkoutia', t => {
  const targets = lock.waves.filter(w => ['F', 'G', 'H', 'I', 'J', 'K'].includes(w.wave));
  assert.equal(targets.length, 6, 'lukosta puuttuu migraatioaalto');
  if (!targets.every(w => realGit.revParse(w.deployTarget)) || !realGit.revParse(lock.sqlSource.sha)) {
    t.skip('ehdokashistoria ei ole paikallisesti saatavilla'); return;
  }
  for (const w of targets) {
    const failures = blockingFailures(repoChecks({ ref: w.deployTarget, wave: w.wave, gitShow: realGit.show, sqlRef: lock.sqlSource.sha, preload: realGit.showMany }));
    assert.deepEqual(failures.map(r => `${r.name}: ${r.detail}`), [], w.wave);
  }
});

test('oikea historia: HEAD (aalto L) ja salaisuushaku läpäisevät', t => {
  if (!realGit.revParse('HEAD')) { t.skip('git ei käytettävissä'); return; }
  // Aaltocommit K: HEAD ei ole perustila vaan aallon K deploykohde. Sen
  // porttimatriisin, välimuistin ja sarakeporttien on vastattava aaltoa K.
  // Tämän haaran lukko kattaa aallot C–J (SQL-lähde J), eikä siinä ole
  // 0014:ää: K:n SQL (0014 sekä sen esitarkistus ja varmistus) luetaan
  // HEADista. Lukko kirjoitetaan K:lla tuotehaaralle ehdokkaan jälkeen.
  // Aaltocommit L: lukko kattaa C–K (SQL-lähde K); L:n SQL (0015) luetaan HEADista.
  assert.ok(['K', 'L'].includes(SQL_SOURCE_WAVE), SQL_SOURCE_WAVE);
  const failures = blockingFailures(repoChecks({ ref: 'HEAD', wave: 'L', gitShow: realGit.show, gitGrep: realGit.grep, sqlRef: 'HEAD' }));
  assert.deepEqual(failures.map(r => `${r.name}: ${r.detail}`), []);
});

test('KRIITTINEN: preflight-checks.mjs ei kirjoita, ei poista eikä käännä', () => {
  const code = read('tools/release/preflight-checks.mjs');
  for (const forbidden of ['writeFileSync', 'appendFileSync', 'rmSync', 'unlinkSync', 'spawn', 'execFile', 'build-web', 'build:web']) {
    assert.equal(code.includes(forbidden), false, `preflight-checks.mjs: ${forbidden}`);
  }
});

test('KRIITTINEN: esitarkistus ajaa testit ja käännöksen vain erillisillä lipuilla', () => {
  const code = read('scripts/activation-preflight.mjs');
  assert.match(code, /const AJA_TESTIT = ARGS\.includes\('--run-tests'\)/);
  assert.match(code, /const AJA_KÄÄNNÖS = ARGS\.includes\('--run-build'\)/);
  assert.match(code, /if \(AJA_TESTIT && onHead\) \{\s*const testit = ajaSkripti\('test'\)/);
  assert.match(code, /if \(AJA_KÄÄNNÖS && onHead\) \{\s*const build = ajaSkripti\('build:web'\)/);
  assert.equal((code.match(/ajaSkripti\('build:web'\)/g) || []).length, 1);
  assert.equal((code.match(/ajaSkripti\('test'\)/g) || []).length, 1);
  assert.match(code, /repoChecks\(/, 'esitarkistus ei käytä git show -tarkistuksia');
  assert.match(code, /--sha=/);
});

test('KRIITTINEN: release-wave-inference luo tilapäiset työpuut projektikansioon (.claude/worktrees/tmp-*)', () => {
  const code = read('tests/release-wave-inference.test.mjs');
  assert.match(code, /path\.join\(ROOT, '\.claude', 'worktrees'\)/);
  assert.match(code, /'tmp-wave-inference-'/);
  assert.equal(/os\.tmpdir\(\)/.test(code), false, 'työpuu luodaan yhä järjestelmän tmp-hakemistoon');
});
