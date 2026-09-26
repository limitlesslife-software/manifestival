// Loogisen tilannekuvan tarkistus, vertailu ja palautus.
//
//   node tools/activation/restore-snapshot.mjs check   <vienti> [--save] [--out=DIR]
//   node tools/activation/restore-snapshot.mjs compare <vienti> [--tables=a,b] [--out=DIR]
//   node tools/activation/restore-snapshot.mjs restore <vienti> [--dry-run] [--prune] [--tables=a,b] [--out=DIR]
//
// <vienti> = supabase/backup/snapshot_state_00NN.sql:n tulos SQL-editorista
// tiedostoksi vietynä (CSV, sarkainerotettu tai JSON).
//
//   check    todentaa MANIFESTin ja jokaisen taulun tiivisteen, rivimäärät
//            ja viite-eheyden; tulostaa luvut ajopäiväkirjaan. --save
//            arkistoi viennin ja raportin tuloshakemistoon.
//   compare  kirjoittaa compare.sql:n: YKSI vain lukeva SELECT, joka kertoo
//            taulukohtaisesti SAMA / SAMA+N UUTTA / MUUTTUNUT.
//   restore  kirjoittaa palautusskriptin: yksi transaktio, joka tarkistaa
//            itsensä ja kaatuu (mitään tallentamatta), ellei jokainen
//            tilannekuvan rivi ole lopuksi tavu tavulta sama.
//            --dry-run: sama skripti, joka päättyy rollback;iin.
//            --prune:   poistaa myös tilannekuvan jälkeen luodut rivit.
//            --tables:  vain nimetyt taulut. Yhdessä --prune-valinnan kanssa
//                       kieltäytyy, ellei jokainen valittuun tauluun
//                       viittaava taulu ole myös valittu (listaa puuttuvat).
//
//   check hylkää myös kuvan, jonka RLS suodatti (rooli ei ohittanut
//   rivitason suojausta): sellainen kuva on sisäisesti eheä mutta vajaa.
//
// TIETOSUOJA (docs/activation/0010-BACKUP-AND-RECOVERY.md): vienti ja
// palautusskripti sisältävät henkilötietoja. Tämä työkalu kirjoittaa VAIN
// git-ignoroituun polkuun projektin sisällä (oletus
// .local-backups/db/<UTC>_state_00NN/), kieltäytyy versionhallitusta
// polusta eikä koskaan ylikirjoita. Päätteeseen ei tulosteta sisältöä:
// vain lukumäärät, tiivisteet ja tunnisteet.
//
// Poistumiskoodit: 0 = kunnossa, 1 = tilannekuva hylätty, 2 = käyttö- tai
// tulospolkuvirhe.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  parseExport, parseSnapshot, buildRestoreSql, buildCompareSql, describeSnapshot, defaultOutputDir,
  pruneSelectionProblem
} from './snapshot-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = `Käyttö:
  node tools/activation/restore-snapshot.mjs check   <vienti> [--save] [--out=DIR]
  node tools/activation/restore-snapshot.mjs compare <vienti> [--tables=a,b] [--out=DIR]
  node tools/activation/restore-snapshot.mjs restore <vienti> [--dry-run] [--prune] [--tables=a,b] [--out=DIR]`;

class Refusal extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

function parseArgs(argv) {
  const [command, file, ...rest] = argv;
  const flags = { dryRun: false, prune: false, save: false, tables: null, out: null };
  for (const a of rest) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--prune') flags.prune = true;
    else if (a === '--save') flags.save = true;
    else if (a.startsWith('--tables=')) flags.tables = a.slice(9).split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--out=')) flags.out = a.slice(6);
    else throw new Refusal(`tuntematon valitsin ${a}\n${USAGE}`);
  }
  if (!['check', 'compare', 'restore'].includes(command) || !file) throw new Refusal(USAGE);
  if (command !== 'restore' && (flags.dryRun || flags.prune)) throw new Refusal('--dry-run ja --prune koskevat vain restore-komentoa');
  if (command !== 'check' && flags.save) throw new Refusal('--save koskee vain check-komentoa');
  return { command, file, flags };
}

const git = args => spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
const toPosix = p => p.split(path.sep).join('/');

function repoRelative(abs) {
  const rel = path.relative(ROOT, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

/** Tarkista kaikki tulostiedostot ENNEN kuin mitään kirjoitetaan. */
function prepareOutputs(outDir, names) {
  const abs = path.resolve(ROOT, outDir);
  const rel = repoRelative(abs);
  if (rel === null) {
    throw new Refusal(`Tuloshakemiston on oltava projektin sisällä (${ROOT}), git-ignoroituna. Oletus: .local-backups/db/.`);
  }
  const probe = git(['rev-parse', '--is-inside-work-tree']);
  if (probe.status !== 0) throw new Refusal('git ei ole käytettävissä: en voi todentaa, että tulospolku on ignoroitu.');
  const files = [];
  for (const name of names) {
    const fileRel = `${rel}/${name}`;
    if (git(['ls-files', '--error-unmatch', '--', fileRel]).status === 0) {
      throw new Refusal(`${fileRel} on versionhallinnassa. Tilannekuva sisältää henkilötietoja: en kirjoita versionhallittuun polkuun.`);
    }
    if (git(['check-ignore', '-q', '--', fileRel]).status !== 0) {
      throw new Refusal(`${fileRel} ei ole git-ignoroitu. Tilannekuva sisältää henkilötietoja: kirjoitan vain ignoroituun polkuun (oletus .local-backups/db/).`);
    }
    const full = path.join(abs, name);
    if (fs.existsSync(full)) throw new Refusal(`${fileRel} on jo olemassa. En koskaan ylikirjoita — valitse toinen --out.`);
    files.push({ full, rel: fileRel });
  }
  fs.mkdirSync(abs, { recursive: true });
  return files;
}

/** Kirjoita vain uuteen tiedostoon (wx = kaatuu, jos tiedosto ilmestyi välissä). */
function writeNew(file, content) {
  fs.writeFileSync(file.full, content, { flag: 'wx' });
}

function readSnapshot(file) {
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) throw new Refusal(`vientiä ei löydy: ${file}`);
  const rel = repoRelative(abs);
  if (rel !== null && git(['check-ignore', '-q', '--', rel]).status !== 0) {
    console.error(`VAROITUS: ${rel} on projektin sisällä mutta EI git-ignoroitu. Siirrä vienti hakemistoon .local-backups/db/.`);
  }
  const bytes = fs.readFileSync(abs);
  let snap;
  try {
    snap = parseSnapshot(parseExport(bytes.toString('utf8')));
  } catch (error) {
    const e = new Refusal(`TILANNEKUVA HYLÄTTY:\n  ${String(error.message).split('\n').join('\n  ')}\n`
      + 'Ota tilannekuva uudelleen ja vie KOKO tulos tiedostoksi.', 1);
    throw e;
  }
  return { abs, bytes, snap };
}

const suffix = flags => [
  flags.tables ? flags.tables.join('+') : null,
  flags.prune ? 'prune' : null,
  flags.dryRun ? 'dry-run' : null
].filter(Boolean).map(s => `.${s}`).join('');

function main(argv) {
  const { command, file, flags } = parseArgs(argv);
  const { abs, bytes, snap } = readSnapshot(file);
  const outDir = flags.out || defaultOutputDir(snap.manifest);
  const report = describeSnapshot(snap);

  if (command === 'check') {
    console.log(report);
    if (flags.save) {
      const ext = path.extname(abs) || '.txt';
      const [copy, log] = prepareOutputs(outDir, [`vienti${ext}`, 'check.txt']);
      writeNew(copy, bytes);
      const fileMd5 = createHash('md5').update(bytes).digest('hex');
      writeNew(log, `${report}\n  vienti          ${copy.rel} (md5 ${fileMd5}, ${bytes.length} t)\n`);
      console.log(`\nArkistoitu: ${copy.rel}\n            ${log.rel}`);
    } else {
      console.log(`\nArkistoi: lisää --save (kohde ${outDir}/).`);
    }
    return 0;
  }

  if (command === 'compare') {
    const sql = buildCompareSql(snap, { tables: flags.tables });
    const [out] = prepareOutputs(outDir, [`compare${suffix(flags)}.sql`]);
    writeNew(out, sql);
    console.log(`Kirjoitettu ${out.rel}`);
    console.log('Aja SQL-editorissa milloin tahansa (vain luku). Odotus: SAMA tai SAMA+N UUTTA.');
    console.log('Tiedosto sisältää vain tunnisteita ja tiivisteitä, ei sisältöä.');
    return 0;
  }

  if (flags.prune && flags.tables) {
    let problem;
    try { problem = pruneSelectionProblem(snap, flags.tables); } catch (error) { throw new Refusal(error.message); }
    if (problem) throw new Refusal(`KIELTÄYDYN: ${problem}`);
  }
  let sql;
  try {
    sql = buildRestoreSql(snap, { tables: flags.tables, prune: flags.prune, dryRun: flags.dryRun });
  } catch (error) { throw new Refusal(error.message); }
  const [out] = prepareOutputs(outDir, [`restore${suffix(flags)}.sql`]);
  writeNew(out, sql);
  console.log(`Kirjoitettu ${out.rel} (${Buffer.byteLength(sql)} t)`);
  if (flags.dryRun) {
    console.log('KUIVAHARJOITUS: päättyy rollback;iin. Onnistunut ajo = ei ERROR-riviä; mitään ei tallennu.');
  } else {
    console.log('TODELLINEN PALAUTUS. Aja ensin sama --dry-run -versio. Sovellus kiinni kaikilta laitteilta.');
    console.log('Jälkeenpäin: compare.sql -> SAMA, sitten verify-tiedosto, sitten F5 sovelluksessa.');
  }
  console.log('SISÄLTÄÄ HENKILÖTIETOJA: älä liitä chattiin, issueen tai committiin.');
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('restore-snapshot.mjs')) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(error.message);
      process.exitCode = error.code;
    } else {
      console.error(`VIRHE: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
