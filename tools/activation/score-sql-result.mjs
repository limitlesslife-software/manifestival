// Pisteytä liitetty esitarkistuksen tai varmistuksen tulos (ACT-12).
//
//   node tools/activation/score-sql-result.mjs tulos.txt
//   node tools/activation/score-sql-result.mjs --sql=supabase/verify/verify_0009.sql tulos.txt
//   node tools/activation/score-sql-result.mjs --json tulos.txt
//
// Syöte on supabase/preflight/preflight_00XX.sql:n tai
// supabase/verify/verify_00XX.sql:n tulostaulukko sellaisenaan
// Supabasen SQL-editorista kopioituna: sarkain-, pilkku- (CSV) tai
// putkierotettuna, otsikkorivin kanssa tai ilman. Sarakkeet:
//
//   check_no, section, check_name, status, details, poikkeavia_yhteensa
//
// PÄÄTÖS: GO vain, kun
//   - jokainen rivi on luettu (numerointi 01..N ilman aukkoja; jos --sql
//     annetaan, N = tiedoston tarkistusten määrä)
//   - yksikään status ei ole FAIL
//   - poikkeavia_yhteensa = 0 jokaisella rivillä
// Muuten STOP. Tätä ennen "0 FAIL" luettiin silmällä.
//
// Poistumiskoodi: 0 = GO, 1 = STOP, 2 = syötettä ei voitu lukea.
//
// Mitään ei lähetetä minnekään eikä kirjoiteta mihinkään.

import fs from 'node:fs';

const STATUSES = new Set(['PASS', 'FAIL', 'INFO']);

/** Jaa rivi soluiksi: sarkain, putki tai CSV-pilkku (lainausmerkit huomioiden). */
function cellsOf(line) {
  let cells;
  if (line.includes('\t')) cells = line.split('\t');
  else if (line.includes('|')) cells = line.split('|');
  else cells = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  cells = cells.map(c => c.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
  // Putkitaulukon reunat: | a | b | -> ['', a, b, '']
  if (cells.length && cells[0] === '' && line.trim().startsWith('|')) cells.shift();
  if (cells.length && cells[cells.length - 1] === '' && line.trim().endsWith('|')) cells.pop();
  return cells;
}

/**
 * Jäsennä liitetty tarkistustaulukko.
 *
 * @returns {{rows: {no: string, section: string|null, name: string|null,
 *   status: string, details: string|null, poikkeavia: number|null}[],
 *   pass: number, fail: number, info: number, poikkeavia: number|null,
 *   problems: string[]}|null} null jos syötteessä ei ole yhtään
 *   tarkistusriviä
 */
export function parseCheckTable(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  let header = null;
  const rows = [];
  const problems = [];

  for (const line of lines) {
    const cells = cellsOf(line);
    const lower = cells.map(c => c.toLowerCase());
    if (lower.includes('check_no') && lower.includes('status')) {
      header = {
        no: lower.indexOf('check_no'),
        section: lower.indexOf('section'),
        name: lower.indexOf('check_name'),
        status: lower.indexOf('status'),
        details: lower.indexOf('details'),
        poikkeavia: lower.indexOf('poikkeavia_yhteensa')
      };
      continue;
    }
    if (/^[-+=\s|]+$/.test(line)) continue; // psql-erotinrivi
    const at = (index, fallback) => (index >= 0 && index < cells.length ? cells[index] : fallback);
    const no = header ? at(header.no, '') : cells[0];
    if (!/^\d{2,3}$/.test(no || '')) continue;
    let status = header ? at(header.status, '') : cells.find((c, i) => i > 0 && STATUSES.has(c));
    status = String(status || '').toUpperCase();
    if (!STATUSES.has(status)) {
      problems.push(`tarkistus ${no}: tila "${status || '?'}" ei ole PASS/FAIL/INFO`);
      continue;
    }
    const statusIndex = header ? header.status : cells.indexOf(status);
    const poikkeaviaRaw = header && header.poikkeavia >= 0 ? at(header.poikkeavia, '') : cells[cells.length - 1];
    const poikkeavia = /^\d+$/.test(String(poikkeaviaRaw)) ? Number(poikkeaviaRaw) : null;
    rows.push({
      no,
      section: header ? at(header.section, null) : cells[1] ?? null,
      name: header ? at(header.name, null) : cells[2] ?? null,
      status,
      details: header ? at(header.details, null) : cells[statusIndex + 1] ?? null,
      poikkeavia
    });
  }

  if (!rows.length && !problems.length) return null;

  const count = status => rows.filter(r => r.status === status).length;
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.no)) problems.push(`tarkistus ${r.no} on liitetty kahdesti`);
    seen.add(r.no);
  }
  const numbers = rows.map(r => Number(r.no)).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) {
      problems.push(`numerointi katkeaa kohdassa ${String(i + 1).padStart(2, '0')}: liitos on vajaa`);
      break;
    }
  }
  const totals = new Set(rows.map(r => r.poikkeavia));
  let poikkeavia = null;
  if (totals.size === 1 && !totals.has(null)) poikkeavia = [...totals][0];
  else problems.push('poikkeavia_yhteensa puuttuu tai vaihtelee riveittäin');

  return { rows, pass: count('PASS'), fail: count('FAIL'), info: count('INFO'), poikkeavia, problems };
}

/**
 * Tarkistusten määrä generoidussa SQL-tiedostossa (esitarkistus tai
 * varmistus): eri `select 'NN'` -numerot, jotka aloittavat rivin.
 */
export function countChecksInSql(sql) {
  const numbers = new Set();
  for (const m of String(sql || '').matchAll(/\bselect\s+'(\d{2,3})'(?:::text)?(?:\s+as\s+check_no)?\s*,/g)) {
    numbers.add(m[1]);
  }
  return numbers.size;
}

/**
 * GO vain kun kaikki on luettu, 0 FAIL ja 0 poikkeavaa.
 *
 * @param {ReturnType<typeof parseCheckTable>} result
 * @param {{expectedChecks?: number}} [options]
 * @returns {{decision: 'GO'|'STOP', reasons: string[]}}
 */
export function decide(result, { expectedChecks = null } = {}) {
  if (!result) return { decision: 'STOP', reasons: ['tulosta ei voitu lukea'] };
  const reasons = [...result.problems];
  if (!result.rows.length) reasons.push('yhtään tarkistusriviä ei löytynyt');
  if (expectedChecks !== null && result.rows.length !== expectedChecks) {
    reasons.push(`tarkistuksia ${result.rows.length}, SQL-tiedostossa ${expectedChecks}: liitos on vajaa tai väärästä tiedostosta`);
  }
  if (result.fail > 0) {
    const failed = result.rows.filter(r => r.status === 'FAIL').map(r => `${r.no} ${r.name || ''}`.trim());
    reasons.push(`${result.fail} FAIL: ${failed.join('; ')}`);
  }
  if (result.poikkeavia !== null && result.poikkeavia !== 0) {
    reasons.push(`poikkeavia_yhteensa = ${result.poikkeavia}, odotus 0`);
  }
  return { decision: reasons.length ? 'STOP' : 'GO', reasons };
}

if (process.argv[1] && process.argv[1].endsWith('score-sql-result.mjs')) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const sqlArg = (args.map(a => /^--sql=(.+)$/.exec(a)).filter(Boolean).pop() || [])[1] || null;
  const file = args.find(a => !a.startsWith('--'));
  const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  const result = parseCheckTable(text);
  if (!result) {
    console.error('Syötettä ei voitu lukea: odotettiin tarkistustaulukkoa (check_no, status, …).');
    process.exit(2);
  }
  const expectedChecks = sqlArg ? countChecksInSql(fs.readFileSync(sqlArg, 'utf8')) : null;
  const verdict = decide(result, { expectedChecks });
  if (json) {
    console.log(JSON.stringify({ ...verdict, ...result, expectedChecks }, null, 2));
  } else {
    console.log(`${verdict.decision}: ${result.rows.length} tarkistusta — PASS ${result.pass}, FAIL ${result.fail}, INFO ${result.info}, poikkeavia_yhteensa ${result.poikkeavia ?? '?'}`);
    for (const r of verdict.reasons) console.log(`STOP  ${r}`);
  }
  process.exit(verdict.decision === 'GO' ? 0 : 1);
}
