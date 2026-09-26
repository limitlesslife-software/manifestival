// Aktivoinnin orkestroija: yksi aalto kerrallaan, omistajan porteilla.
//
//   npm run activation:orchestrate
//       kuivaharjoitus (oletus): lue tila, tarkista lukko, kerro seuraava
//       askel ja mikä portti on auki. Ei kirjoita, ei pushaa.
//
//   npm run activation:orchestrate -- --inventory=inv.txt --preflight-result=pre.txt
//       migraatioaalto: esitarkistuksen tulos (0 FAIL) -> STOP_OWNER_MIGRATION
//
//   npm run activation:orchestrate -- --inventory=inv.txt --verify-result=ver.txt
//       migraation jälkeen: varmistus (0 poikkeavaa) -> STOP_OWNER_DEPLOY
//
//   npm run activation:orchestrate -- --execute-deploy --approved-sha=<40 merkkiä>
//       DEPLOY: vain kun --approved-sha on lukon deployTarget, tuotannon
//       aallon tekninen hyväksyntä ja ehdokkaan vihreä testiajo on
//       kirjattu päiväkirjaan. Compare-and-swap (ls-remote main ==
//       odotettu edellinen), sitten git push origin <sha>:refs/heads/main
//       (ei koskaan force), sitten VERIFY_LIVE, TECH_ACCEPTANCE ja
//       päiväkirja.
//
//   npm run activation:orchestrate -- --record-acceptance=C --sha=<40 merkkiä> [--verify-result=ver.txt]
//       kirjaa tuotannossa olevan aallon AUTOMATED_TECHNICAL_ACCEPTANCE
//       live-todennuksesta (sama kuin production:verify-assets
//       --record-acceptance). Vaatii verkon (vain GET).
//
//   npm run activation:orchestrate -- --record-candidate-tests=D --sha=<40> --tests-result=tulos.txt
//       kirjaa ehdokkaan oman `node --test` -ajon (vain vihreä kirjataan)
//
//   npm run activation:orchestrate -- --verify-rollback-of=D [--record]
//       todenna peruutus (ACT-10); --record kirjaa sen, ja juna pysähtyy
//       tilaan TRAIN_HALTED_RECUT_REQUIRED kunnes lukko kirjoitetaan uudelleen
//
// Muut liput: --wave=<X> (varmistus: seuraavan aallon on oltava tämä),
// --offline (ei live-GET:iä; deploy ja kirjaus vaativat verkon), --json,
// --journal=<polku projektikansiossa>, --poll-timeout=<s>, --poll-interval=<s>.
//
// HYVÄKSYNTÄ TULEE OMISTAJALTA. --approved-sha on omistajan oman viestin
// ("hyväksyn D", "hyväksyn 0009/F") kirjaus komentoriville; agentti ei
// saa keksiä sitä. Käsin tehtävä UI-hyväksyntä ei ole portti
// (LIVE_USE_VALIDATION_PENDING, docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md),
// joten --accepted-lippua ei enää ole. Orkestroija ei koskaan etene
// seuraavaan aaltoon itsestään. Päiväkirja on paikallinen ja git-ignoroitu.
//
// Logiikka: tools/activation/orchestrate.mjs. Poistumiskoodi: 0 = askel
// valmis (tai juna valmis), 1 = STOP / odottaa, 2 = syötettä ei voitu lukea.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { ROOT } from '../tools/release/state.mjs';
import { createGit, isFullSha } from '../tools/release/git-layer.mjs';
import { getOnlyFetch } from '../tools/release/live-assets.mjs';
import { WAVE_IDS } from '../tools/release/waves.mjs';
import {
  JOURNAL_PATH, recordCandidateTests, recordTechnicalAcceptance, resolveJournalPath, runOrchestrator, verifyRollback
} from '../tools/activation/orchestrate.mjs';

const args = process.argv.slice(2);
const arg = name => (args.map(a => new RegExp(`^--${name}=(.+)$`).exec(a)).filter(Boolean).pop() || [])[1] || null;
const flag = name => args.includes(`--${name}`);
const out = line => process.stdout.write(`${line}\n`);
const waveArg = name => {
  const value = arg(name);
  if (!value) return null;
  const upper = value.toUpperCase();
  if (!WAVE_IDS.includes(upper)) { out(`  Tuntematon aalto --${name}=${value}`); process.exit(2); }
  return upper;
};

const executeDeploy = flag('execute-deploy');
const approvedSha = arg('approved-sha');
const offline = flag('offline');
const journalPath = arg('journal') || JOURNAL_PATH;

try {
  resolveJournalPath(ROOT, journalPath);
} catch (err) {
  out(`  STOP: ${err.message}`);
  process.exit(2);
}
if (arg('accepted') || flag('accepted')) {
  out('  STOP: --accepted on poistettu. Käsin tehtävä UI-hyväksyntä ei ole junan portti');
  out('  (LIVE_USE_VALIDATION_PENDING). Tuotannon aallon tekninen hyväksyntä kirjataan:');
  out('  npm run production:verify-assets -- --wave=<X> --sha=<40 merkkiä> --record-acceptance');
  process.exit(2);
}
if (approvedSha && !isFullSha(approvedSha)) {
  out(`  STOP: --approved-sha vaatii täyden 40-merkkisen SHA:n (annettiin ${approvedSha})`);
  process.exit(2);
}
if (executeDeploy && offline) {
  out('  STOP: --execute-deploy vaatii tuotannon todennuksen verkosta (poista --offline)');
  process.exit(2);
}

const readInput = name => {
  const file = arg(name);
  if (!file) return null;
  const full = path.resolve(ROOT, file);
  if (!fs.existsSync(full)) { out(`  STOP: --${name}: tiedostoa ${file} ei ole`); process.exit(2); }
  return fs.readFileSync(full, 'utf8');
};

const deps = {
  git: createGit({ allowPush: executeDeploy }),
  fs,
  root: ROOT,
  fetchImpl: offline ? null : getOnlyFetch,
  now: () => new Date(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
};

// ------------------------------------------------ erilliset kirjaustilat

const acceptanceWave = waveArg('record-acceptance');
if (acceptanceWave) {
  if (offline) { out('  STOP: teknisen hyväksynnän kirjaus vaatii live-todennuksen (poista --offline)'); process.exit(2); }
  const sha = arg('sha');
  if (!isFullSha(sha)) { out('  STOP: --record-acceptance vaatii --sha=<40 merkkiä> (tuotannon commit)'); process.exit(2); }
  const result = await recordTechnicalAcceptance(deps, {
    wave: acceptanceWave, sha, verifyResult: readInput('verify-result'), inventoryPath: arg('inventory'), journalPath
  });
  for (const [id, text] of Object.entries(result.checks)) out(`  OK      ${id}: ${text}`);
  for (const p of result.problems) out(`  STOP    ${p}`);
  out(result.ok
    ? `  KIRJATTU: aalto ${acceptanceWave} = AUTOMATED_TECHNICAL_ACCEPTANCE (käyttötodennus LIVE_USE_VALIDATION_PENDING) -> ${result.journal.path}`
    : `  EI KIRJATTU: aallon ${acceptanceWave} teknistä hyväksyntää ei voitu todentaa`);
  process.exit(result.ok ? 0 : 1);
}

const testsWave = waveArg('record-candidate-tests');
if (testsWave) {
  const result = recordCandidateTests(deps, {
    wave: testsWave, sha: arg('sha'), testsText: readInput('tests-result'), journalPath
  });
  out(result.ok
    ? `  KIRJATTU: ehdokkaan ${testsWave} testit ${result.entry.pass}/${result.entry.tests} PASS -> ${result.journal.path}`
    : `  EI KIRJATTU: ${result.reason}`);
  process.exit(result.ok ? 0 : 1);
}

const rollbackWave = waveArg('verify-rollback-of');
if (rollbackWave) {
  if (offline) { out('  STOP: peruutuksen todennus vaatii verkon'); process.exit(2); }
  const result = await verifyRollback(deps, { rollbackOf: rollbackWave, record: flag('record'), journalPath });
  out(`  PERUUTUS (${rollbackWave}): ${result.ok ? 'täsmää' : 'EI täsmää'} — tuotannossa ${result.live.state} (${result.live.cacheVersion})`);
  for (const p of result.problems) out(`    ${p}`);
  if (result.journal) out(`  KIRJATTU: TRAIN_HALTED_RECUT_REQUIRED -> ${result.journal.path}`);
  process.exit(result.ok ? 0 : 1);
}

// ------------------------------------------------------------ pääajo

const result = await runOrchestrator(deps, {
  live: !offline,
  inventoryPath: arg('inventory'),
  preflightResult: readInput('preflight-result'),
  verifyResult: readInput('verify-result'),
  executeDeploy,
  approvedSha,
  wave: waveArg('wave'),
  journalPath,
  pollTimeoutMs: arg('poll-timeout') ? Number(arg('poll-timeout')) * 1000 : undefined,
  pollIntervalMs: arg('poll-interval') ? Number(arg('poll-interval')) * 1000 : undefined
});

if (flag('json')) {
  out(JSON.stringify({ plan: result.plan, deploy: result.deploy, live: result.live, journal: result.journal }, null, 2));
} else {
  const plan = result.plan;
  const byKind = kind => (plan.pendingGates || []).filter(g => g.kind === kind);
  out('');
  out(`  AKTIVOINNIN ORKESTROIJA${executeDeploy ? '' : ' (kuivaharjoitus)'}`);
  out('');
  for (const s of plan.steps) {
    out(`  ${s.status.padEnd(7)} ${s.name}`);
    for (const d of s.detail) out(`            ${d}`);
  }
  for (const w of plan.warnings || []) out(`  HUOM    ${w}`);
  for (const [title, kind] of [['OMISTAJAN HYVÄKSYNNÄT', 'OWNER_APPROVAL'], ['OMISTAJAN VAIN LUKEVA SQL', 'OWNER_INPUT'], ['KONEELLISET PORTIT (Claude)', 'TECHNICAL']]) {
    const gates = byKind(kind);
    if (!gates.length) continue;
    out('');
    out(`  ${title}:`);
    for (const g of gates) out(`    ${g.class} — ${g.detail}`);
  }
  for (const lu of plan.liveUse || []) {
    out('');
    out(`  LIVE_USE_VALIDATION_PENDING ${lu.wave} (tiedoksi — ei estä junaa, ei PASS; ${lu.doc}):`);
    for (const item of lu.items) out(`    - ${item}`);
  }
  out('');
  out(`  TILA: ${plan.state || plan.decision}${plan.reason ? ` — ${plan.reason}` : ''}`);
  out('');
}
process.exit(result.exitCode);
