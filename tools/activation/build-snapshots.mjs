// Generoi supabase/backup/snapshot_state_00NN.sql tiloille 0008–0014.
//
//   node tools/activation/build-snapshots.mjs          kirjoita tiedostot
//   node tools/activation/build-snapshots.mjs --check  vertaa levyyn (testit)
//
// MIKSI GENEROIDAAN
//
// Tilannekuvan on luettava TÄSMÄLLEEN ne taulut, jotka ovat olemassa
// tilassa 00NN: tasks ja profile (ennen 0001:tä) sekä jokainen
// `create table public.X` migraatioissa <= 00NN. Lista poimitaan
// migraatioista, jotta käsin kirjoitettu lista ei voi erkaantua niistä.
//
// MIKSI STAATTINEN LISTA JA YKSI LAUSE
//
// Yksi SELECT näkee koko kannan yhdellä MVCC-tilannekuvalla. Dynaaminen
// luku (query_to_xml) on VOLATILE ja lukisi joka taulun eri hetkellä —
// tulos voisi olla repeytynyt. Ks. tools/activation/snapshot-core.mjs.
//
// Tulos sisältää käyttäjän sisältöä (toisin kuin inventaario ja
// esitarkistukset), joten se asuu omassa hakemistossaan supabase/backup/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_STATES, tablesAtState, buildSnapshotStatement } from './snapshot-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT_DIR = 'supabase/backup';
export const snapshotPath = state => `${OUT_DIR}/snapshot_state_${state}.sql`;

export function readMigrations() {
  const dir = path.join(ROOT, 'supabase/migrations');
  return fs.readdirSync(dir)
    .filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()
    .map(n => ({ name: n.replace(/\.sql$/, ''), sql: fs.readFileSync(path.join(dir, n), 'utf8') }));
}

export function snapshotTables(state) {
  return tablesAtState(state, readMigrations());
}

const next = state => String(Number(state) + 1).padStart(4, '0');
/** Viimeisin tila: sen jälkeen ei ole vielä migraatiota. */
const LAST_STATE = SNAPSHOT_STATES[SNAPSHOT_STATES.length - 1];

function whenText(state) {
  if (state === '0009') {
    return [
      '-- MILLOIN: juuri ENNEN migraatiota 0010, sovellus suljettuna:',
      '--          preflight_0010.sql -> 0 FAIL -> TÄMÄ -> check -> 0010.',
      '--          Sama tiedosto kelpaa ennen 0010:n ROLLBACKin jälkeistä',
      '--          palautusta (kanta on silloin taas tilassa 0009).'
    ];
  }
  if (state === '0010') {
    return [
      '-- MILLOIN: 0010:n JÄLKEEN ennen kuin mitään peruutetaan:',
      '--          ennen aallon G revertiä aaltoon F, ennen 0010:n',
      '--          ROLLBACK-osiota ja ennen minkä tahansa palautuksen ajoa',
      '--          (nykytila talteen). Ennen migraatiota 0011 samoin.'
    ];
  }
  // 0013:n teksti on jäädytetty: tiedosto on junan lukitussa SQL-lähteessä
  // (J), ja sen on pysyttävä tavulleen samana. Se kelpaa sellaisenaan myös
  // vapaaehtoiseksi kuvaksi ennen migraatiota 0014.
  if (state === '0013') {
    return [
      '-- MILLOIN: ennen mitä tahansa peruutusta tai palautusta tilassa 0013',
      '--          (migraatiot 0001–0013 ajettu).'
    ];
  }
  if (state === LAST_STATE) {
    return [
      `-- MILLOIN: ennen mitä tahansa peruutusta tai palautusta tilassa ${state}`,
      `--          (migraatiot 0001–${state} ajettu), esim. ennen aallon K`,
      `--          revertiä tai migraation ${state} ROLLBACK-osiota.`
    ];
  }
  return [
    `-- MILLOIN: juuri ennen migraatiota ${next(state)} ja ennen mitä tahansa`,
    `--          peruutusta tai palautusta tilassa ${state}.`
  ];
}

function wrap(words, width = 66) {
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { lines.push(line.trim()); line = w; } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

export function buildSnapshotFile(state) {
  const tables = snapshotTables(state);
  const tableLines = wrap(tables.map((t, i) => (i < tables.length - 1 ? `${t},` : t)))
    .map(l => `--   ${l}`);
  return [
    '-- =====================================================================',
    `-- Manifestival — looginen tilannekuva, tila ${state} (VAIN LUKU)`,
    '-- =====================================================================',
    '--',
    '-- GENEROITU: node tools/activation/build-snapshots.mjs. ÄLÄ MUOKKAA',
    '-- KÄSIN — testi vertaa tiedostoa generaattoriin.',
    '--',
    `-- TÄMÄ TIEDOSTO ON TILALLE ${state}: migraatiot 0001–${state} ajettu${state === '0013' || state === LAST_STATE ? '.' : `, ${next(state)} ei.`}`,
    ...whenText(state),
    '--',
    '-- Ohje: docs/activation/0010-BACKUP-AND-RECOVERY.md',
    '--',
    '-- YKSI lause, VAIN LUKU: mitään ei luoda, muuteta eikä poisteta.',
    '-- Koko tulos tulee yhdestä MVCC-tilannekuvasta (ei repeytymistä).',
    '-- auth-skeemasta luetaan vain omistajan olemassaolo ja käyttäjien',
    '-- lukumäärä — ei sähköposteja, ei salasanoja, ei tunnisteita.',
    `-- Taulut (${tables.length}):`,
    ...tableLines,
    '--',
    '-- Jos ajo kaatuu virheeseen "relation ... does not exist", kanta on',
    '-- eri tilassa kuin tiedoston nimi: aja tilan mukainen tiedosto.',
    '-- `check` varoittaa, jos kannassa on tauluja, joita tämä ei kata.',
    '--',
    '-- SISÄLTÄÄ HENKILÖTIETOJA (otsikot, muistiinpanot, profiili, summat).',
    '-- Tulosta EI liitetä chattiin, issueen, committiin eikä pilveen.',
    '--',
    '-- MITÄ TEET TULOKSELLA',
    '--',
    '--   1. Tulostaulukossa on rivi 00 (MANIFEST) ja yksi rivi per taulu.',
    '--   2. Vie KOKO tulos tiedostoksi (CSV tai JSON). Älä kopioi soluja',
    '--      käsin: solu voi katketa, ja tiiviste hylkää katkenneen kopion.',
    '--   3. Tallenna tiedosto projektin hakemistoon .local-backups/db/.',
    '--   4. node tools/activation/restore-snapshot.mjs check <tiedosto> --save',
    '--      -> "TILANNEKUVA KUNNOSSA". Mikä tahansa muu = ota kuva uudelleen.',
    '',
    buildSnapshotStatement(state, tables)
  ].join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('build-snapshots.mjs')) {
  const check = process.argv.includes('--check');
  let stale = 0;
  if (!check) fs.mkdirSync(path.join(ROOT, OUT_DIR), { recursive: true });
  for (const state of SNAPSHOT_STATES) {
    const rel = snapshotPath(state);
    const full = path.join(ROOT, rel);
    const sql = buildSnapshotFile(state);
    if (check) {
      const onDisk = fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : '';
      if (onDisk !== sql) { console.error(`${rel} ei vastaa generaattoria`); stale += 1; } else console.log(`${rel}: ajan tasalla`);
    } else {
      fs.writeFileSync(full, sql);
      console.log(`kirjoitettu ${rel}`);
    }
  }
  if (stale) process.exit(1);
}
