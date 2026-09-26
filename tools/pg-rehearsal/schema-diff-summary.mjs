// Ihmisluettava yhteenveto kultaisista skeemaeroista
// (tools/pg-rehearsal/expected/schema-diff-00NN.txt) ->
// docs/activation/SCHEMA-DIFFS-0009-0013.md.
//
//   node tools/pg-rehearsal/schema-diff-summary.mjs           kirjoita dokumentti
//   node tools/pg-rehearsal/schema-diff-summary.mjs --check   vertaa (testit)
//
// Kultaiset tiedostot syntyvät harjoittelusta (rehearse.mjs --only=
// prodshape:chain --write-golden) ja prodshape:chain vertaa jokaista ajoa
// niihin. Tämä dokumentti on niistä johdettu, joten se ei voi erkaantua.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, isMain } from './lib.mjs';

export const SUMMARY_DOC = 'docs/activation/SCHEMA-DIFFS-0009-0013.md';
const NUMBERS = ['0009', '0010', '0011', '0012', '0013'];
const TITLES = {
  '0009': 'Talous 2.0 (aalto F)', '0010': 'Tavoitteesta tekemiseksi (aalto G)', '0011': 'Henkilökohtainen avustaja (aalto H)',
  '0012': 'Suunta (aalto I)', '0013': 'Suunta 2 (aalto J)'
};

/** Puhdas: jäsennä kultaisen tiedoston rivit. */
export function parseGolden(text) {
  const out = { added: [], removed: [] };
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('+ ')) out.added.push(line.slice(2));
    else if (line.startsWith('- ')) out.removed.push(line.slice(2));
  }
  return out;
}

const field = (item, key) => (new RegExp(`:${key}=([^:]*)`).exec(item) || [])[1] ?? '';

function describe(diff) {
  const rels = diff.added.filter(l => /^rel:\w+:r:/.test(l)).map(l => l.split(':')[1]);
  const newTables = new Set(rels);
  const cols = diff.added.filter(l => l.startsWith('col:')).map(l => {
    const [, rest] = l.split(/^col:/);
    const [tc, type] = rest.split(':');
    const [table, column] = tc.split('.');
    return { table, column, type, notnull: field(l, 'notnull') === 'true', def: field(l, 'default') };
  });
  const cons = diff.added.filter(l => l.startsWith('con:')).map(l => {
    const parts = l.split(':');
    const def = parts.slice(3).join(':').replace(/:validated=\w+$/, '');
    const kind = /^CHECK/.test(def) ? 'CHECK' : /^FOREIGN KEY/.test(def) ? 'FOREIGN KEY' : /^UNIQUE/.test(def) ? 'UNIQUE'
      : /^PRIMARY KEY/.test(def) ? 'PRIMARY KEY' : 'muu';
    return { table: parts[1], name: parts[2], def, kind };
  });
  const idx = diff.added.filter(l => l.startsWith('idx:')).map(l => l.split(':')[1]);
  const pols = diff.added.filter(l => l.startsWith('pol:')).map(l => { const p = l.split(':'); return { table: p[1], name: p[2], cmd: p[4] }; });
  const trgs = diff.added.filter(l => l.startsWith('trg:')).map(l => { const p = l.split(':'); return { table: p[1], name: p[2] }; });
  const fns = diff.added.filter(l => l.startsWith('fn:')).map(l => l.split(':')[1]);
  const acl = Object.fromEntries(diff.added.filter(l => /^rel:\w+:r:/.test(l)).map(l => [l.split(':')[1], field(l, 'acl')]));
  const rls = Object.fromEntries(diff.added.filter(l => /^rel:\w+:r:/.test(l)).map(l => [l.split(':')[1], field(l, 'rls')]));
  return { newTables, cols, cons, idx, pols, trgs, fns, acl, rls };
}

const code = s => `\`${s}\``;

export function summaryMarkdown(root = ROOT) {
  const parsed = Object.fromEntries(NUMBERS.map(n => {
    const file = join(root, `tools/pg-rehearsal/expected/schema-diff-${n}.txt`);
    if (!existsSync(file)) throw new Error(`kultainen tiedosto puuttuu: ${file}`);
    return [n, parseGolden(readFileSync(file, 'utf8'))];
  }));
  const out = [];
  out.push('# Skeemaerot 0009–0013 (kultaiset tiedostot)');
  out.push('');
  out.push('GENEROITU: `node tools/pg-rehearsal/schema-diff-summary.mjs`. ÄLÄ MUOKKAA KÄSIN —');
  out.push('testi vertaa tätä kultaisiin tiedostoihin.');
  out.push('');
  out.push('Lähde: `tools/pg-rehearsal/expected/schema-diff-00NN.txt`, jotka harjoittelu');
  out.push('tuottaa ajamalla migraation tuotannon muotoiseen kantaan (tila 0008 =');
  out.push('omistajan inventaario 2026-09-26) ja vertaamalla `public`-skeeman katalogia');
  out.push('ennen ja jälkeen (`lib.catalogItems`: taulut, sarakkeet, indeksit,');
  out.push('rajoitteet, politiikat, liipaisimet, funktiot, omistajat ja oikeudet).');
  out.push('`prodshape:chain` vertaa jokaista ajoa näihin: mikä tahansa poikkeama on');
  out.push('hylkäys. Poistoja sallitaan vain `ALLOWED_REMOVALS`-listan korvaukset.');
  out.push('');
  out.push('| Migraatio | Uudet taulut | Uudet sarakkeet vanhoissa tauluissa | Rajoitteet | Indeksit | Politiikat | Liipaisimet | Poistettu |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const n of NUMBERS) {
    const d = describe(parsed[n]);
    const oldCols = d.cols.filter(c => !d.newTables.has(c.table));
    out.push(`| ${n} | ${d.newTables.size} | ${oldCols.length} | ${d.cons.length} | ${d.idx.length} | ${d.pols.length} | ${d.trgs.length} | ${parsed[n].removed.length} |`);
  }
  out.push('');
  out.push('Yhteistä kaikille uusille tauluille (todennettu riveistä): RLS päällä, neljä');
  out.push('`authenticated`-roolin politiikkaa (`auth.uid() = user_id`), `authenticated`');
  out.push('saa täsmälleen `arwd` (select/insert/update/delete), ei anon- eikä');
  out.push('PUBLIC-oikeutta. `service_role` säilyttää Supabasen oletusoikeudet');
  out.push('(`arwdDxtm`, ohittaa RLS:n kuten Supabasessa aina). Omistaja on migraation');
  out.push('ajava rooli (harjoittelussa `postgres`).');
  for (const n of NUMBERS) {
    const d = describe(parsed[n]);
    out.push('');
    out.push(`## ${n} — ${TITLES[n]}`);
    out.push('');
    const tables = [...d.newTables].sort();
    if (tables.length) {
      out.push(`**Uudet taulut (${tables.length}):** ${tables.map(t => `${code(t)} (${d.cols.filter(c => c.table === t).length} saraketta, RLS ${d.rls[t] === 'true' ? 'päällä' : 'POIS'})`).join(', ')}`);
      out.push('');
    }
    const oldCols = d.cols.filter(c => !d.newTables.has(c.table));
    if (oldCols.length) {
      out.push(`**Uudet sarakkeet olemassa oleviin tauluihin (${oldCols.length}):**`);
      out.push('');
      for (const c of oldCols) {
        out.push(`- ${code(`${c.table}.${c.column}`)} ${c.type}${c.notnull ? ' NOT NULL' : ' (nullable)'}${c.def ? `, oletus ${code(c.def)}` : ''}`);
      }
      out.push('');
    }
    const removed = parsed[n].removed;
    if (removed.length) {
      out.push(`**Korvattu / poistettu (${removed.length}):**`);
      out.push('');
      for (const r of removed) {
        const p = r.split(':');
        const replacement = d.cons.find(c => c.name === p[2]);
        out.push(`- ${code(`${p[1]}.${p[2]}`)}: \`${p.slice(3).join(':').replace(/:validated=\w+$/, '')}\``);
        if (replacement) out.push(`  → korvaaja samalla nimellä: \`${replacement.def}\``);
      }
      out.push('');
    }
    const byTable = {};
    for (const c of d.cons) (byTable[c.table] ||= []).push(c);
    out.push(`**Rajoitteet (${d.cons.length}):**`);
    out.push('');
    for (const [t, list] of Object.entries(byTable).sort()) {
      out.push(`- ${code(t)}: ${list.map(c => `${c.name} (${c.kind})`).join(', ')}`);
    }
    const fks = d.cons.filter(c => c.kind === 'FOREIGN KEY');
    if (fks.length) {
      out.push('');
      out.push(`**Vierasavaimet (${fks.length}):**`);
      out.push('');
      for (const c of fks) out.push(`- ${code(`${c.table}.${c.name}`)}: \`${c.def}\``);
    }
    out.push('');
    out.push(`**Indeksit (${d.idx.length}):** ${d.idx.sort().map(code).join(', ') || '–'}`);
    out.push('');
    out.push(`**Politiikat (${d.pols.length}):** ${Object.entries(d.pols.reduce((a, p) => ((a[p.table] = (a[p.table] || 0) + 1), a), {})).map(([t, k]) => `${code(t)} ${k}`).join(', ') || '–'}`);
    out.push('');
    out.push(`**Liipaisimet (${d.trgs.length}):** ${d.trgs.map(t => code(t.name)).join(', ') || '–'}`);
    if (d.fns.length) {
      out.push('');
      out.push(`**Funktiot (${d.fns.length}):** ${d.fns.map(code).join(', ')}`);
    }
  }
  out.push('');
  return out.join('\n');
}

if (isMain(import.meta.url)) {
  const file = join(ROOT, SUMMARY_DOC);
  const md = summaryMarkdown();
  if (process.argv.includes('--check')) {
    const onDisk = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
    if (onDisk !== md) { console.error(`${SUMMARY_DOC} ei vastaa kultaisia tiedostoja`); process.exit(1); }
    console.log(`${SUMMARY_DOC}: ajan tasalla`);
  } else {
    writeFileSync(file, md);
    console.log(`kirjoitettu ${SUMMARY_DOC}`);
  }
}
