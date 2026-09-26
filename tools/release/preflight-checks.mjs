// Aktivoinnin esitarkistukset commitista — ilman checkoutia (ACT-08).
//
// MIKSI GIT SHOW EIKÄ TYÖPUU
//
// scripts/activation-preflight.mjs luki aiemmin vain uloskuitatun
// työpuun. Jäädytettyä ehdokasta (lukon deployTarget) ei voinut
// tarkistaa kuittaamatta sitä ulos, ja ulos kuittaaminen on juuri se
// tilamuutos, jota esitarkistuksen pitää välttää. Nyt jokainen tarkistus
// lukee tiedostot `git show <ref>:<polku>` -muodossa: sama koodi
// tarkistaa HEADin, lukitun SHA:n tai minkä tahansa commitin.
//
// MITÄ TÄMÄ EI TEE
//
// Ei aja testejä, ei käännä, ei kirjoita mitään, ei käynnistä
// prosesseja muuten kuin injektoidun git-kerroksen kautta (git show,
// git grep). Testit ja käännös ovat esitarkistuksen erillisten
// lippujen (--run-tests, --run-build) takana, eikä dry-run käytä niitä.
//
// SQL-TIEDOSTOT
//
// Migraatioaaltojen (F–J) esitarkistus- ja varmistustiedostot ovat vain
// lukon SQL-lähteessä (aallon J kärki) ja tuotehaarassa — eivät F:n,
// G:n, H:n tai I:n omassa kärjessä. Siksi migraatiotiedosto tarkistetaan
// sekä ehdokkaasta että SQL-lähteestä (samat tavut), ja preflight/verify
// SQL-lähteestä.

import { createHash } from 'node:crypto';

import { parseCacheVersion, parseGates, parseStatusDoc, parseTaskExtendedFields } from './state.mjs';
import {
  ALL_GATES, COLUMN_GATES, cacheVersionOf, describeMatrix, expectedMatrix,
  preflightPathOf, verifyPathOf, waveById, waveIndex
} from './waves.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');

/** Perustilan tiedostot, joiden on oltava jokaisessa ehdokkaassa. */
export const BASE_FILES = Object.freeze([
  'supabase/migrations/0001_auth_user_scoping.sql',
  'supabase/migrations/0002_task_domain_fields.sql',
  'supabase/migrations/0003_routines.sql',
  'supabase/migrations/0004_goals_projects.sql',
  'supabase/migrations/0005_notification_preferences.sql',
  'supabase/migrations/0006_wellbeing.sql',
  'supabase/migrations/0007_finance.sql',
  'supabase/migrations/0008_ai_audit.sql',
  'supabase/acceptance/precheck_0003_0008_auth_final.sql',
  'supabase/acceptance/verify_0003_0008_post_acceptance_final.sql',
  'supabase/verify/verify_0004_0008_final.sql',
  'docs/MIGRATIONS-0004-0008-PRODUCTION-RUNBOOK.md',
  'docs/ACTIVATION-0003-0008-RUNBOOK.md',
  'docs/PRODUCTION-STATUS.md'
]);

/**
 * Lue porttitaulukko sallien puuttuvat rivit: vain ne portit, jotka
 * commitin schema.js tuntee, vertaillaan.
 */
function statusDocGates(source, declared) {
  const full = parseStatusDoc(source);
  if (full) return full;
  if (!source) return null;
  const rows = String(source).split(/\r?\n/);
  const gates = {};
  for (const gate of declared) {
    const row = rows.find(r => r.includes('|') && r.includes('`' + gate + '`'));
    if (!row) return null;
    gates[gate] = /AKTIVOITU/.test(row);
  }
  return gates;
}

/**
 * Esitarkistukset yhdelle commitille.
 *
 * @param {object} options
 * @param {string} options.ref tarkistettava commit (SHA tai viite)
 * @param {string} options.wave väitetty aalto
 * @param {(ref: string, path: string) => string|null} options.gitShow
 * @param {(ref: string, regex: string, opts?: object) => string[]|null} [options.gitGrep]
 * @param {string} [options.sqlRef] SQL-lähde (lukon sqlSource.sha)
 * @param {string[]} [options.migrationFiles] repon migraatiot (polut) — jos
 *   annettu, 0001–0008 tarkistetaan tästä listasta
 * @returns {{section: string, name: string, ok: boolean, detail: string, blocking: boolean}[]}
 */
export function repoChecks({ ref, wave, gitShow, gitGrep = null, sqlRef = null, preload = null }) {
  const results = [];
  const check = (section, name, ok, detail = '', blocking = true) =>
    results.push({ section, name, ok: Boolean(ok), detail, blocking });

  if (!waveById(wave)) {
    check('portit', `Aalto ${wave} on tunnettu`, false, `tuntematon aalto: ${wave}`);
    return results;
  }

  // Valinnainen eräluku (git cat-file --batch): kaikki tarkistettavat
  // tiedostot yhdellä prosessilla.
  if (typeof preload === 'function') {
    const meta = waveById(wave);
    const own = ['src/data/schema.js', 'sw.js', 'docs/PRODUCTION-STATUS.md', ...BASE_FILES];
    if (meta.migrationFile) own.push(meta.migrationFile);
    preload(ref, own);
    if (sqlRef && meta.migration) {
      preload(sqlRef, [meta.migrationFile, preflightPathOf(meta.migration), verifyPathOf(meta.migration),
        ...(meta.verifyPrerequisite ? [verifyPathOf(meta.verifyPrerequisite)] : [])]);
    }
  }

  const schema = gitShow(ref, 'src/data/schema.js');
  const sw = gitShow(ref, 'sw.js');
  check('portit', 'src/data/schema.js on luettavissa', schema !== null, schema === null ? `puuttuu commitista ${ref}` : '');

  const gates = parseGates(schema, { allowMissing: true });
  const expected = expectedMatrix(wave);
  const differences = gates
    ? ALL_GATES.filter(g => gates[g] !== expected[g])
      .map(g => `${g}: on ${gates[g] ? 'auki' : 'kiinni'}, pitää olla ${expected[g] ? 'auki' : 'kiinni'}`)
    : ['porttilohkoa ei voitu lukea'];
  check('portit', `Porttimatriisi vastaa aaltoa ${wave}`, differences.length === 0,
    differences.length ? differences.join('; ') : describeMatrix(gates));

  const cache = parseCacheVersion(sw);
  check('portit', `CACHE_VERSION vastaa aaltoa ${wave}`, cache === cacheVersionOf(wave),
    cache === cacheVersionOf(wave) ? cache : `sw.js on ${cache || 'lukematon'}, odotettiin ${cacheVersionOf(wave)}`);

  check('portit', 'TASK_EXTENDED_FIELDS on yhä aktivoitu', parseTaskExtendedFields(schema), '');

  for (const [gate, openFrom] of Object.entries(COLUMN_GATES)) {
    const m = new RegExp(`export const ${gate} = (true|false);`).exec(schema || '');
    const actual = m ? m[1] === 'true' : false;
    const shouldBe = wave !== 'BASE' && waveIndex(wave) >= waveIndex(openFrom);
    check('portit', `Sarakeportti ${gate}`, actual === shouldBe,
      `${actual ? 'auki' : 'kiinni'} (aallossa ${wave} ${shouldBe ? 'auki' : 'kiinni'})`);
  }

  const declared = [...String(schema || '').matchAll(/^\s{2}(\w+):\s*(?:true|false)/gm)]
    .map(m => m[1]).filter(g => ALL_GATES.includes(g));
  const docGates = statusDocGates(gitShow(ref, 'docs/PRODUCTION-STATUS.md'), declared);
  const docDiff = docGates && gates ? declared.filter(g => docGates[g] !== gates[g]) : ['porttitaulukkoa ei voitu lukea'];
  check('portit', 'PRODUCTION-STATUS.md vastaa schema.js:ää', docDiff.length === 0,
    docDiff.length ? `eroavat: ${docDiff.join(', ')}` : '');

  for (const file of BASE_FILES) {
    const content = gitShow(ref, file);
    check('tiedostot', `${file.split('/').pop()} on commitissa`, content !== null && content.length > 0, file);
  }

  const meta = waveById(wave);
  if (meta.migration) {
    const migration = gitShow(ref, meta.migrationFile);
    check('migraatio', `Migraatio ${meta.migration} on ehdokkaassa`, migration !== null, meta.migrationFile);
    if (sqlRef) {
      const fromSource = gitShow(sqlRef, meta.migrationFile);
      check('migraatio', `Migraatio ${meta.migration} on SQL-lähteessä samoin tavuin`,
        fromSource !== null && migration !== null && sha256(fromSource) === sha256(migration),
        fromSource === null ? `puuttuu SQL-lähteestä ${sqlRef}` : (migration !== null && sha256(fromSource) !== sha256(migration) ? 'tavut eroavat' : sha256(fromSource)));
      for (const file of [preflightPathOf(meta.migration), verifyPathOf(meta.migration)]) {
        const content = gitShow(sqlRef, file);
        check('migraatio', `${file.split('/').pop()} on SQL-lähteessä`, content !== null,
          content === null ? `puuttuu SQL-lähteestä ${sqlRef}` : sha256(content));
      }
      if (meta.verifyPrerequisite) {
        const prereq = verifyPathOf(meta.verifyPrerequisite);
        check('migraatio', `${prereq.split('/').pop()} (edellytys) on SQL-lähteessä`, gitShow(sqlRef, prereq) !== null, prereq);
      }
    } else {
      check('migraatio', 'SQL-lähde (lukon sqlSource) on annettu', false,
        'migraatioaallon esitarkistus- ja varmistustiedostot tarkistetaan SQL-lähteestä');
    }
  }

  if (gitGrep) {
    const keys = gitGrep(ref, 'sk-ant-[A-Za-z0-9_-]{10,}');
    check('salaisuudet', 'Yhdessäkään commitin tiedostossa ei ole AI-avainta',
      Array.isArray(keys) && keys.length === 0, keys === null ? 'git grep epäonnistui' : keys.join(', '));
    const serviceRole = gitGrep(ref, 'service_role', { ignoreCase: true, pathspec: ['src'] });
    check('salaisuudet', 'service_role ei esiinny selaimen koodissa',
      Array.isArray(serviceRole) && serviceRole.length === 0, serviceRole === null ? 'git grep epäonnistui' : serviceRole.join(', '));
  }

  return results;
}

/** Estävät epäonnistumiset. */
export function blockingFailures(results) {
  return results.filter(r => !r.ok && r.blocking !== false);
}
