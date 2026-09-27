// Migraatiopakettien blob-tiivisteet (docs/activation/MIGRATION-BUNDLES.md).
//
//   node tools/pg-rehearsal/bundle-hashes.mjs           tulosta taulukko
//   node tools/pg-rehearsal/bundle-hashes.mjs --write   päivitä taulukko dokumenttiin
//   node tools/pg-rehearsal/bundle-hashes.mjs --check   vertaa (testit), poistumiskoodi 1 jos eroaa
//
// Tiiviste on git-blob-tiiviste (sama kuin `git hash-object <polku>` ja
// `git rev-parse HEAD:<polku>`): sha1("blob <pituus>\0<sisältö>"), sisältö
// LF-rivinvaihdoin kuten .gitattributes (* text=auto) sen tallentaa.
// Operaattori vertaa ajettavaa tiedostoa tähän ennen ajoa.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, isMain } from './lib.mjs';

export const BUNDLES_DOC = 'docs/activation/MIGRATION-BUNDLES.md';
export const START = '<!-- blob-taulukko:alku (node tools/pg-rehearsal/bundle-hashes.mjs --write) -->';
export const END = '<!-- blob-taulukko:loppu -->';

export const BUNDLE_FILES = Object.freeze({
  '0009': Object.freeze(['supabase/preflight/preflight_0009.sql', 'supabase/migrations/0009_finance_2.sql', 'supabase/verify/verify_0009.sql']),
  '0010': Object.freeze(['supabase/preflight/preflight_0010.sql', 'supabase/migrations/0010_goal_to_action.sql', 'supabase/verify/verify_0010.sql']),
  '0011': Object.freeze(['supabase/preflight/preflight_0011.sql', 'supabase/migrations/0011_personal_assistant.sql', 'supabase/verify/verify_0011.sql']),
  '0012': Object.freeze(['supabase/preflight/preflight_0012.sql', 'supabase/migrations/0012_life_alignment.sql', 'supabase/verify/verify_0012.sql']),
  '0013': Object.freeze(['supabase/preflight/preflight_0013.sql', 'supabase/migrations/0013_alignment_reality.sql', 'supabase/verify/verify_0013.sql']),
  '0014': Object.freeze(['supabase/preflight/preflight_0014.sql', 'supabase/migrations/0014_daily_life.sql', 'supabase/verify/verify_0014.sql'])
});

/** git-blob-tiiviste tekstitiedostolle (CRLF -> LF kuten text=auto). */
export function gitBlobHash(text) {
  const body = Buffer.from(String(text).replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest('hex');
}

export function bundleTable() {
  const lines = ['| Migraatio | Tiedosto | git-blob (`git hash-object <polku>`) |', '|---|---|---|'];
  for (const [n, files] of Object.entries(BUNDLE_FILES)) {
    for (const f of files) lines.push(`| ${n} | \`${f}\` | \`${gitBlobHash(readFileSync(join(ROOT, f), 'utf8'))}\` |`);
  }
  return lines.join('\n');
}

/** Korvaa merkkien välinen taulukko. Heittää, jos merkit puuttuvat. */
export function withTable(doc, table = bundleTable()) {
  const text = doc.replace(/\r\n/g, '\n');
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error(`${BUNDLES_DOC}: blob-taulukon merkit puuttuvat`);
  return `${text.slice(0, a + START.length)}\n${table}\n${text.slice(b)}`;
}

if (isMain(import.meta.url)) {
  const file = join(ROOT, BUNDLES_DOC);
  if (process.argv.includes('--write')) {
    const raw = readFileSync(file, 'utf8');
    const next = withTable(raw);
    writeFileSync(file, raw.includes('\r\n') ? next.replace(/\n/g, '\r\n') : next);
    console.log(`päivitetty ${BUNDLES_DOC}`);
  } else if (process.argv.includes('--check')) {
    const raw = readFileSync(file, 'utf8');
    if (raw.replace(/\r\n/g, '\n') !== withTable(raw)) { console.error(`${BUNDLES_DOC}: blob-taulukko ei vastaa tiedostoja`); process.exit(1); }
    console.log(`${BUNDLES_DOC}: blob-taulukko ajan tasalla`);
  } else {
    console.log(bundleTable());
  }
}
