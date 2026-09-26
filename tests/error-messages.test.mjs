// Virheen syy -> käyttäjän viesti (ERR-02, ERR-05, ERR-06, ERR-10, ERR-13, ERR-21).
//
// Nämä testit lukitsevat kolme asiaa:
//   1. Syy valitsee viestin: verkko, vanhentunut istunto, ajamaton
//      migraatio, kahden laitteen kilpa ja palvelimen hylkäys eivät enää
//      näytä samaa "Tallennus ei onnistunut." -tekstiä.
//   2. Luokittelu on src/domain/offlineQueue.js:n classifyError -- ei
//      rinnakkaista taksonomiaa.
//   3. Mikään käyttäjälle näkyvä viesti ei sisällä koodia, taulun tai
//      rajoitteen nimeä, palvelimen tekstiä eikä käyttäjän arvoja, eikä
//      konsoliloki tulosta käyttäjän arvoja.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { read, ROOT } from './helpers/sources.mjs';
import { fakeClient, isGateOpen } from './helpers/gates.mjs';
import {
  describeError, DESCRIBED_CLASSES, CONFLICT_MESSAGES, NOT_FOUND_MESSAGE, constraintNameOf,
  dominantClass, loadSummaryMessage, loadAdvice, aiEndpointMessage, startupFailureMessage,
  UNEXPECTED_ERROR_MESSAGE, ERROR_OP
} from '../src/lib/errorMessages.js';
import { classifyError, ERROR_CLASS } from '../src/domain/offlineQueue.js';
import {
  ERROR_CODE, AppError, fail, logError, redactDbDetail, redactQuotedValues, logFailure
} from '../src/lib/result.js';
import { failFromCause, failFromThrown } from '../src/data/repoErrors.js';
import * as tasksRepo from '../src/data/tasksRepo.js';
import * as profileRepo from '../src/data/profileRepo.js';
import { ALL_REPOSITORIES, goalsRepo } from '../src/data/collectionsRepo.js';
import { setClient } from '../src/data/client.js';
import { setUser, clearUser } from '../src/data/session.js';
import { normalizeTask } from '../src/domain/task.js';

const USER = { id: 'aaaaaaaa-5555-4555-8555-000000000055', email: 'virhe@example.com' };

afterEach(() => {
  clearUser();
  setClient(null);
});

// ------------------------------------------------------------ apurit

const TABLE_NAMES = [...new Set([
  'tasks', 'profile', 'notification_preferences', ...ALL_REPOSITORIES.map(repo => repo.table)
])];

/** Käyttäjälle näkyvä teksti ei saa sisältää teknisiä tunnisteita. */
function assertUserSafe(message, context = '') {
  assert.equal(typeof message, 'string', 'viesti ei ole merkkijono ' + context);
  assert.ok(message.length > 0, 'tyhjä viesti ' + context);
  assert.doesNotMatch(message, /PGRST|\b\d{2}[0-9A-Z]{3}\b|constraint|relation|supabase|JWT|AppError|"|[a-z]+_[a-z_]+/i,
    `${context}: ${message}`);
  for (const table of TABLE_NAMES) {
    assert.equal(new RegExp(`\\b${table}\\b`, 'i').test(message), false, `taulun nimi ${table} viestissä: ${message}`);
  }
}

/** Syy -> { code, userMessage } samalla polulla kuin repositoriot. */
function described(cause, op = ERROR_OP.SAVE, fallback = 'Tallennus ei onnistunut.') {
  return describeError(cause, { op, fallback, errorClass: classifyError(cause) });
}

// =========================================================== ERR-05

test('ERR-05: luokat ovat classifyErrorin luokat, ei rinnakkaista taksonomiaa', () => {
  assert.deepEqual([...DESCRIBED_CLASSES].sort(), Object.values(ERROR_CLASS).sort());
  // lib-kerros ei importoi domainia (tests/architecture.test.mjs): luokka
  // annetaan kutsujalta, eikä errorMessages.js luokittele itse.
  const source = read('src/lib/errorMessages.js');
  assert.doesNotMatch(source, /from '\.\.\/domain\//);
  assert.doesNotMatch(read('src/data/repoErrors.js').replace(/^\s*\/\/.*$/gm, ''), /PGRST\d|status >=|23505/,
    'repoErrors.js ei saa luokitella itse');
});

const CASES = [
  { name: 'verkko (fetch)', cause: { message: 'TypeError: Failed to fetch', code: '' },
    code: ERROR_CODE.NETWORK_ERROR, match: /Ei yhteyttä palvelimeen\. Muutosta ei tallennettu/ },
  { name: 'vanhentunut istunto', cause: { code: 'PGRST301', status: 401, message: 'JWT expired' },
    code: ERROR_CODE.AUTH_REQUIRED, match: /Kirjautumisesi on vanhentunut/ },
  { name: 'taulu puuttuu', cause: { code: 'PGRST205', status: 404, message: "Could not find the table 'public.life_areas'" },
    code: ERROR_CODE.PERSISTENCE_UNAVAILABLE, match: /päivitys kesken/ },
  { name: 'sarake puuttuu', cause: { code: '42703', message: 'column "x" of relation "goals" does not exist' },
    code: ERROR_CODE.PERSISTENCE_UNAVAILABLE, match: /päivitys kesken/ },
  { name: 'palvelin ei vastaa', cause: { code: 'PGRST002', status: 503, message: 'Could not query the database for the schema cache' },
    code: ERROR_CODE.SERVICE_UNAVAILABLE, match: /Palvelu ei vastannut juuri nyt/ },
  { name: 'tarkistusrajoite', cause: { code: '23514', message: 'new row for relation "time_entries" violates check constraint "x"' },
    code: ERROR_CODE.VALIDATION_ERROR, match: /Palvelin ei hyväksynyt tietoja/ },
  { name: 'oikeus puuttuu', cause: { code: '42501', status: 403, message: 'new row violates row-level security policy' },
    code: ERROR_CODE.PERMISSION_DENIED, match: /oikeutta/ },
  { name: 'liitetty kohde poistettu', cause: { code: '23503', message: 'insert or update on table "tasks" violates foreign key constraint' },
    code: ERROR_CODE.CONFLICT, match: /Liitettyä kohdetta ei enää ole/ },
  { name: 'tuntematon rajoite', cause: { code: '23505', message: 'duplicate key value violates unique constraint "tasks_pkey"' },
    code: ERROR_CODE.CONFLICT, match: /jo tallennettu/ },
  { name: 'tuntematon', cause: { code: 'outo', message: 'jotain' },
    code: ERROR_CODE.UNKNOWN, match: /^Tallennus ei onnistunut\.$/ }
];

for (const entry of CASES) {
  test(`ERR-05: ${entry.name} -> ${entry.code}`, () => {
    const result = described(entry.cause);
    assert.equal(result.code, entry.code);
    assert.match(result.userMessage, entry.match);
    assertUserSafe(result.userMessage, entry.name);
  });
}

test('ERR-05: kahden laitteen uniikkikilpa kertoo mikä on jo olemassa (rajoitteen nimi vain avaimena)', () => {
  for (const [constraint, message] of Object.entries(CONFLICT_MESSAGES)) {
    const cause = {
      code: '23505',
      message: `duplicate key value violates unique constraint "${constraint}"`,
      details: 'Key (user_id, name)=(u, Terapia) already exists.'
    };
    assert.equal(constraintNameOf(cause), constraint);
    // Myös AppErrorin sisällä (repositorion palauttama muoto).
    const wrapped = new AppError('x', { cause });
    const result = described(wrapped);
    assert.equal(result.code, ERROR_CODE.CONFLICT, constraint);
    assert.equal(result.userMessage, message, constraint);
    assertUserSafe(result.userMessage, constraint);
  }
  assert.match(CONFLICT_MESSAGES.life_areas_name_unique, /tämänniminen elämänalue/);
  assert.match(CONFLICT_MESSAGES.alignment_reviews_week_unique, /Pohdintasi on yhä kentässä/);
});

test('ERR-05: operaatio valitsee sanamuodon ja tuntemattomalle jää operaation oma teksti', () => {
  const network = { message: 'TypeError: Failed to fetch', code: '' };
  assert.match(described(network, 'load').userMessage, /Näet viimeksi ladatut tiedot/);
  assert.match(described(network, 'delete').userMessage, /Mitään ei poistettu/);
  assert.equal(described({ code: 'outo' }, 'load', 'Tehtävien lataus ei onnistunut.').userMessage,
    'Tehtävien lataus ei onnistunut.');
  // Laite tietää olevansa offline: tuntematon on verkko.
  assert.equal(describeError({ code: 'outo' }, { offline: true, errorClass: 'unknown' }).code, ERROR_CODE.NETWORK_ERROR);
});

test('ERR-05: jokainen mahdollinen viesti on käyttäjälle turvallinen', () => {
  for (const errorClass of DESCRIBED_CLASSES) {
    for (const op of Object.values(ERROR_OP)) {
      for (const cause of [{}, { code: '42501' }, { status: 403 }, { code: '23503' }, { code: 'PGRST116' }]) {
        assertUserSafe(describeError(cause, { op, errorClass }).userMessage, `${errorClass}/${op}`);
      }
    }
  }
  for (const message of [...Object.values(CONFLICT_MESSAGES), NOT_FOUND_MESSAGE, UNEXPECTED_ERROR_MESSAGE]) {
    assertUserSafe(message);
  }
});

test('ERR-05: repositorio palauttaa tyypitetyn virheen ja säilyttää syyn luokittelua varten', async () => {
  setUser(USER);
  setClient(fakeClient({ data: null, error: { code: 'PGRST301', status: 401, message: 'JWT expired' } }));
  const listed = await tasksRepo.listTasks();
  assert.equal(listed.ok, false);
  assert.equal(listed.error.code, ERROR_CODE.AUTH_REQUIRED);
  assert.equal(listed.error.op, 'tasks.list');
  assert.match(listed.error.userMessage, /Kirjaudu uudelleen sisään/);
  // Jonotus ja lähtökori luokittelevat yhä alkuperäisen syyn.
  assert.equal(classifyError(listed.error), ERROR_CLASS.AUTH);

  setClient(fakeClient({ data: null, error: { code: 'PGRST002', status: 503, message: 'schema cache' } }));
  const profile = await profileRepo.saveProfile({ age: 30 });
  assert.equal(profile.error.code, ERROR_CODE.SERVICE_UNAVAILABLE);
  assertUserSafe(profile.error.userMessage);

  // Heitetty poikkeus ei ole verkkovirhe (supabase-js palauttaa verkkovirheen).
  setClient(fakeClient({ throws: new Error('Ei kirjautunutta käyttäjää') }));
  const thrown = await tasksRepo.insertTask(normalizeTask({ id: 't1', date: '2026-09-28', title: 'x' }));
  assert.equal(thrown.error.code, ERROR_CODE.UNKNOWN);
  assert.equal(thrown.error.userMessage, 'Tehtävän tallennus ei onnistunut.');
});

test('ERR-05: failFromCause/failFromThrown eivät koskaan käytä syyn tekstiä viestinä', () => {
  const secret = 'SALAINEN-PALVELINTEKSTI';
  for (const cause of [{ message: secret }, { code: '22P02', message: `invalid input syntax: "${secret}"` }, new Error(secret)]) {
    for (const fn of [failFromCause, failFromThrown]) {
      const result = fn(cause, { op: 'save', fallback: 'Tallennus ei onnistunut.', code: 'x.insert' });
      assert.equal(result.ok, false);
      assert.equal(result.error.userMessage.includes(secret), false);
      assert.equal(result.error.cause, cause);
    }
  }
});

// ------------------------------------------ turvallisuusinvariantti (ERR-05/13)

/** Kutsun argumentit ylimmällä tasolla (lainausmerkit ja sulkeet huomioiden). */
function callArguments(source, index) {
  const args = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (let i = index; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      current += ch;
      if (ch === '\\') { current += source[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) { args.push(current.trim()); return args; }
      depth -= 1;
    }
    if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  return args;
}

function callsOf(source, name) {
  const out = [];
  const pattern = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    if (/function\s+$/.test(source.slice(Math.max(0, match.index - 9), match.index))) continue;
    out.push(callArguments(source, match.index + match[0].length));
  }
  return out;
}

const LITERAL = /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")(?:\s*\+\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"))*$/;

/** Vakion arvo, jos se on määritelty kiinteänä merkkijonona tiedostossa. */
function constantLiteral(name, sources) {
  for (const source of sources) {
    const match = new RegExp(`const ${name} =\\s*((?:'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")(?:\\s*\\+\\s*(?:'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"))*)\\s*;`).exec(source);
    if (match) return match[1];
  }
  return null;
}

function userMessageOk(argument, sources, messagesObjectOk) {
  const text = argument.trim();
  if (LITERAL.test(text)) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(text)) return constantLiteral(text, sources) !== null;
  if (/^MESSAGES(\.[a-z_]+|\[[a-z_]+\])$/.test(text)) return messagesObjectOk;
  const ternary = /^[\w.!]+ \? ([\s\S]+) : ([\s\S]+)$/.exec(text);
  if (ternary) {
    return userMessageOk(ternary[1], sources, messagesObjectOk) && userMessageOk(ternary[2], sources, messagesObjectOk);
  }
  return /^described\.userMessage$/.test(text);
}

test('TURVA (ERR-05/13): jokaisen src/data/-moduulin virheviesti on kiinteä tai describeErrorin tulos', () => {
  const dir = path.join(ROOT, 'src/data');
  const helperSources = [read('src/lib/errorMessages.js'), read('src/data/schema.js')];
  const problems = [];
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
    const rel = `src/data/${file}`;
    const source = read(rel).replace(/^\s*\/\/.*$/gm, '');
    const sources = [source, ...helperSources];
    // MESSAGES-olio: vain avain: 'kiinteä teksti' -rivejä.
    const messagesBody = /const MESSAGES = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(source);
    const messagesOk = Boolean(messagesBody) && messagesBody[1].split('\n').map(line => line.trim()).filter(Boolean)
      .every(line => /^[a-z_]+: '(?:[^'\\]|\\.)*',?$/.test(line));

    for (const args of callsOf(source, 'fail')) {
      if (!userMessageOk(args[0], sources, messagesOk)) problems.push(`${rel}: fail(${args[0]})`);
    }
    for (const args of callsOf(source, 'failWith')) {
      if (!/^(ERROR_CODE\.[A-Z_]+|described\.code)$/.test(args[0])) problems.push(`${rel}: failWith-koodi ${args[0]}`);
      if (!userMessageOk(args[1], sources, messagesOk)) problems.push(`${rel}: failWith(…, ${args[1]})`);
    }
    // repoErrors.js on itse apurin määrittely (failWith(described.code, described.userMessage)).
    for (const name of file === 'repoErrors.js' ? [] : ['failFromCause', 'failFromThrown']) {
      for (const args of callsOf(source, name)) {
        const fallback = /fallback: ('(?:[^'\\]|\\.)*')/.exec(args[1] || '');
        if (!fallback) problems.push(`${rel}: ${name} ilman kiinteää fallbackia`);
      }
    }
    // Syyn viestiä luetaan vain diagnostiikkaan (esim. schema.js poimii
    // puuttuvan sarakkeen nimen): käyttäjäviestiksi se ei päädy.
    assert.equal(/error\.message|\.userMessage = /.test(source), false, `${rel}: palvelimen viesti käyttäjäviestiksi`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('TURVA (ERR-05/13): kiinteät virheviestit src/data/-moduuleissa eivät sisällä teknisiä tunnisteita', () => {
  const dir = path.join(ROOT, 'src/data');
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
    const source = read(`src/data/${file}`).replace(/^\s*\/\/.*$/gm, '');
    for (const name of ['fail', 'failWith']) {
      for (const args of callsOf(source, name)) {
        const argument = name === 'fail' ? args[0] : args[1];
        const literals = [...String(argument).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);
        const constant = /^[A-Z][A-Z0-9_]*$/.test(argument) ? constantLiteral(argument, [source, read('src/data/schema.js')]) : null;
        const all = constant ? [...constant.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]).join('') : literals.join('');
        if (all) assertUserSafe(all, `src/data/${file}`);
      }
    }
    for (const match of source.matchAll(/fallback: '((?:[^'\\]|\\.)*)'/g)) assertUserSafe(match[1], `src/data/${file}`);
  }
});

// =========================================================== ERR-06

test('ERR-06 KRIITTINEN: nollan rivin päivitys on "kohdetta ei enää ole", ei onnistuminen', async () => {
  setUser(USER);
  const client = fakeClient({ data: [], error: null, updateData: [] });
  setClient(client);
  const task = normalizeTask({ id: 'poistettu-toisaalla', date: '2026-09-28', title: 'x' });
  const updated = await tasksRepo.updateTask(task);
  assert.equal(updated.ok, false, 'poistetun rivin päivitys väitti onnistuneensa');
  assert.equal(updated.error.code, ERROR_CODE.NOT_FOUND);
  assert.equal(updated.error.userMessage, 'Kohdetta ei enää ole – se on ehkä poistettu toisella laitteella. Päivitä näkymä.');
  assert.equal(client.calls.at(-1).returning, 'id', 'päivitys ei pyytänyt osuneita rivejä');

  const completed = await tasksRepo.setCompleted('poistettu-toisaalla', true);
  assert.equal(completed.ok, false);
  assert.equal(completed.error.code, ERROR_CODE.NOT_FOUND);

  // Oletusvastaus: päivitys osuu (fakeClient palauttaa lähetetyn rivin).
  setClient(fakeClient());
  assert.equal((await tasksRepo.updateTask(task)).ok, true);
});

test('ERR-06: kokoelmarepositorion nollan rivin päivitys kantapolulla', {
  skip: !isGateOpen('goals') && 'portti kiinni: muistipolku palauttaa memory.missing (data-collections.test.mjs)'
}, async () => {
  setUser(USER);
  setClient(fakeClient({ data: [], error: null, updateData: [] }));
  const missing = await goalsRepo.update({ id: 'toisaalla-poistettu', title: 'Tavoite' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, ERROR_CODE.NOT_FOUND);
  assert.equal(missing.error.userMessage, NOT_FOUND_MESSAGE);
  setClient(fakeClient());
  assert.equal((await goalsRepo.update({ id: 'olemassa', title: 'Tavoite' })).ok, true);
});

test('ERR-06: kokoelmarepositorion päivitys ketjuttaa .select(\'id\'):n ja tunnistaa nollan rivin', () => {
  const source = read('src/data/collectionsRepo.js');
  const update = source.slice(source.indexOf('    async update(entity) {'), source.indexOf('    async remove(id) {'));
  assert.match(update, /\.eq\('id', normalized\.id\)\s*\.select\('id'\)/);
  assert.match(update, /data\.length === 0\)[\s\S]*failWith\(ERROR_CODE\.NOT_FOUND, NOT_FOUND_MESSAGE/);
});

// =========================================================== ERR-02

const SECRET = 'SALAISUUS';

test('ERR-02 KRIITTINEN: redactDbDetail ei vuoda sisäkkäisillä, parittomilla tai monirivisillä arvoilla', () => {
  const cases = [
    `Key (user_id, name)=(u, ${SECRET} (oma (vko))) already exists.`,
    `Key (user_id, name)=(u, ${SECRET} (oma) already exists.`,
    `Key (user_id, name)=(u, ${SECRET}) ja muu) already exists.`,
    `Key (user_id, name)=(u, ${SECRET} already exists toinen) already exists.`,
    `Key (life_area_id)=(${SECRET}) is not present in table "life_areas".`,
    `Key (user_id, week_start)=(u, ${SECRET}) conflicts with existing key (user_id, week_start)=(u, ${SECRET}).`,
    `Failing row contains (r1, u, 2026-09-22, Rivi yksi\n${SECRET} pohdinta).`,
    `Failing row contains (r1, u, Rivi yksi\r\n${SECRET} (sulku).`,
    `Jotain aivan muuta: ${SECRET}`
  ];
  for (const detail of cases) {
    const out = redactDbDetail(detail);
    assert.equal(out.includes(SECRET), false, `vuoto: ${JSON.stringify(detail)} -> ${out}`);
  }
  // Rakenne säilyy diagnostiikkaa varten.
  assert.equal(redactDbDetail('Key (user_id, name)=(u, Terapia (oma) already exists.'),
    'Key (user_id, name)=(…) already exists.');
  assert.equal(redactDbDetail('Key (life_area_id)=(x) is not present in table "life_areas".'),
    'Key (life_area_id)=(…) is not present in table "life_areas".');
  assert.equal(redactDbDetail('Failing row contains (a,\nb).'), 'Failing row contains (…).');
  assert.equal(redactDbDetail(null), '');
  assert.equal(redactDbDetail(undefined), '');
  assert.equal(redactDbDetail('Jotain muuta'), '[poistettu]');
});

test('ERR-02: satunnaiset nimet sulkeilla ja rivinvaihdoilla eivät koskaan päädy tulosteeseen', () => {
  const alphabet = ['(', ')', '\n', '\r\n', ' ', 'a', 'Ö', ',', '"', '=', ')=('];
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 300; round++) {
    let name = SECRET;
    for (let i = 0; i < 8; i++) name += alphabet[Math.floor(random() * alphabet.length)];
    for (const template of [
      value => `Key (user_id, name)=(u, ${value}) already exists.`,
      value => `Failing row contains (x, ${value}, y).`,
      value => `Key (goal_id)=(${value}) is not present in table "goals".`
    ]) {
      const out = redactDbDetail(template(name));
      assert.equal(out.includes(SECRET), false, JSON.stringify(name) + ' -> ' + out);
    }
  }
});

test('ERR-02: lainatut arvot poistetaan viestistä ja vihjeestä, rajoitteen nimi säilyy', () => {
  assert.equal(redactQuotedValues(`invalid input syntax for type integer: "${SECRET}"`),
    'invalid input syntax for type integer: "…"');
  assert.equal(redactQuotedValues('duplicate key value violates unique constraint "life_areas_name_unique"'),
    'duplicate key value violates unique constraint "life_areas_name_unique"');
  assert.equal(redactQuotedValues(null), '');
});

/** console.error talteen yhdeksi merkkijonoksi. */
function captureConsoleError(fn) {
  const printed = [];
  const original = console.error;
  console.error = (...args) => printed.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try { fn(); } finally { console.error = original; }
  return printed.join('\n');
}

test('ERR-02 KRIITTINEN: logError suodattaa jokaisen syötteen, myös muun kuin AppErrorin', () => {
  const raw = { code: '23505', message: 'duplicate key value violates unique constraint "life_areas_name_unique"',
    details: `Key (user_id, name)=(u, ${SECRET}) already exists.`, hint: null };
  const out = [
    captureConsoleError(() => logError(raw)),
    captureConsoleError(() => logError({ code: '22P02', message: `invalid input syntax for type integer: "${SECRET}"` })),
    captureConsoleError(() => logError(new Error(`invalid input value for enum goal_status: "${SECRET}"`))),
    captureConsoleError(() => logError(`${SECRET} merkkijonona`)),
    captureConsoleError(() => logError(fail('Tallennus ei onnistunut.', { cause: `${SECRET} merkkijonosyy` }).error)),
    captureConsoleError(() => logError(fail('Tallennus ei onnistunut.', {
      cause: { code: '22P02', message: `invalid input syntax: "${SECRET}"`, hint: `käytä: "${SECRET}"` }
    }).error))
  ].join('\n');
  assert.equal(out.includes(SECRET), false, out);
  assert.match(out, /life_areas_name_unique/, 'rajoitteen nimi säilyy diagnostiikassa');
  assert.match(out, /22P02/);
  assert.equal(out.includes('null'), false, 'puuttuva tieto tulostui merkkijonona "null"');
});

test('ERR-14: logFailure kirjaa vain nimen, koodin ja tilan', () => {
  const printed = [];
  const original = console.error;
  console.error = (...args) => printed.push(JSON.stringify(args));
  try {
    logFailure('auth.signout_failed', Object.assign(new Error(`viesti ${SECRET}`), { code: 'x1', status: 500 }));
  } finally {
    console.error = original;
  }
  const out = printed.join('\n');
  assert.equal(out.includes(SECRET), false);
  assert.match(out, /auth\.signout_failed/);
  assert.match(out, /"errorName":"Error"/);
  assert.match(out, /"status":500/);
});

// ================================================== ERR-05/17 latauksen kooste

test('ERR-05: latauksen koosteen teksti valitaan yleisimmän syyn mukaan', () => {
  assert.match(loadSummaryMessage(['auth', 'auth', 'schema']), /Kirjaudu uudelleen sisään/);
  assert.doesNotMatch(loadSummaryMessage(['auth']), /yhteys/, 'istuntovirhe ei ole yhteysvirhe');
  assert.doesNotMatch(loadSummaryMessage(['schema', 'schema']), /yhteys/);
  assert.match(loadSummaryMessage(['unavailable', 'unavailable', 'network']), /hetken päästä/);
  // Tasapelissä verkko: se on yleisin syy, ja päivitys auttaa.
  assert.equal(loadSummaryMessage(['network', 'schema']),
    'Osa tiedoista ei latautunut. Mitään ei kadonnut — päivitä, kun yhteys toimii.');
  assert.equal(dominantClass([]), null);
  assert.equal(dominantClass(['keksitty']), 'unknown');
  for (const kind of DESCRIBED_CLASSES) {
    assertUserSafe(loadSummaryMessage([kind]), kind);
    assertUserSafe(loadAdvice([kind]), kind);
  }
});

// =========================================================== ERR-10

test('ERR-10: AI-päätepisteen virhe näytetään HTTP-tilan mukaan, ei palvelimen tekstinä', () => {
  assert.match(aiEndpointMessage(401), /Kirjaudu uudelleen/);
  assert.match(aiEndpointMessage(403), /Kirjaudu uudelleen/);
  assert.equal(aiEndpointMessage(413), 'Teksti on liian pitkä.');
  assert.equal(aiEndpointMessage(413, { subject: 'image' }), 'Kuva on liian suuri.');
  assert.match(aiEndpointMessage(429), /Odota hetki/);
  assert.match(aiEndpointMessage(500), /Rivi on tallessa saapuvissa/);
  assert.match(aiEndpointMessage(0), /Rivi on tallessa saapuvissa/);
  assert.match(aiEndpointMessage(400), /Rivi on tallessa saapuvissa/);
  assert.match(aiEndpointMessage(502, { subject: 'image' }), /hetken päästä/);
  for (const status of [0, 400, 401, 403, 404, 413, 429, 500, 502, 504]) {
    for (const subject of ['capture', 'image']) assertUserSafe(aiEndpointMessage(status, { subject }), String(status));
  }
});

// =========================================================== ERR-21

test('ERR-21: käynnistysvirhe ei käske päivittämään sivua natiivissa, ja offline kertoo yhteydestä', () => {
  const native = startupFailureMessage({ native: true });
  assert.doesNotMatch(native, /sivu/i);
  assert.match(native, /avaa se uudelleen/);
  assert.match(startupFailureMessage({ native: true, offline: true }), /verkkoyhteyttä/);
  assert.doesNotMatch(startupFailureMessage({ native: true, offline: true }), /sivu/i);
  assert.match(startupFailureMessage({ offline: true }), /verkkoyhteyttä/);
  assert.match(startupFailureMessage({}), /Lataa sivu uudelleen/);
});
