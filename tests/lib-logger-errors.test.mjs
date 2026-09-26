// Virhemallin ja lokituksen testit.
//
// Loki päätyy konsoliin, ruudunkaappauksiin ja tukipyyntöihin. Käyttäjän
// oma päiväkirja ei saa päätyä sinne siksi, että joku halusi debugata
// tallennusta.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ERROR_CODE, ERROR_CODES, AppError, ok, fail, failWith, isKnownErrorCode
} from '../src/lib/result.js';

import {
  LOG_LEVEL, SENSITIVE_KEYS, REDACTED, FREE_TEXT, LONG_TEXT,
  redactForLog, isDevEnvironment, isSensitiveKey, log, logWarn, logEvent,
  logFailure, failureFields
} from '../src/lib/logger.js';
import { jsFilesIn, readCode } from './helpers/sources.mjs';

// ---------------------------------------------------------- virhekoodit

test('virhekoodit ovat tyypitettyjä eivätkä merkkijonovertailua', () => {
  // Ilman koodia jokainen virheen käsittely vertaisi suomenkielistä
  // viestiä — ja hajoaisi ensimmäisestä sanamuodon korjauksesta.
  assert.ok(ERROR_CODES.length >= 9);
  for (const code of ERROR_CODES) {
    assert.equal(typeof code, 'string');
    assert.equal(isKnownErrorCode(code), true, code);
  }
});

test('tuntematon koodi putoaa turvallisesti unknowniin', () => {
  const result = failWith('keksitty_koodi', 'Jotain meni pieleen.');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODE.UNKNOWN);
  assert.equal(isKnownErrorCode('keksitty_koodi'), false);
});

test('failWith säilyttää käyttäjäviestin ja koodin erillään', () => {
  const result = failWith(ERROR_CODE.AMBIGUOUS_TARGET,
    'Löytyi useita vaihtoehtoja. Valitse mitä tarkoitat.',
    { cause: new Error('sisäinen') });

  assert.equal(result.error.code, ERROR_CODE.AMBIGUOUS_TARGET);
  assert.match(result.error.userMessage, /Valitse/);
  assert.equal(result.error.cause.message, 'sisäinen');
});

test('vanha fail toimii ennallaan', () => {
  const result = fail('Viesti', { code: 'oma.koodi' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'oma.koodi');
});

test('ok palauttaa arvon', () => {
  assert.deepEqual(ok(42), { ok: true, value: 42 });
});

test('KRIITTINEN: diagnostiikka ei päädy käyttäjäviestiin', () => {
  const error = new AppError('Tallennus ei onnistunut.', {
    code: ERROR_CODE.NETWORK_ERROR,
    cause: { message: 'ECONNREFUSED 10.0.0.1:5432', details: 'sisäinen polku' }
  });

  assert.equal(error.userMessage, 'Tallennus ei onnistunut.');
  assert.equal(error.userMessage.includes('ECONNREFUSED'), false);
  assert.match(error.toDiagnostic(), /ECONNREFUSED/, 'kehittäjä näkee syyn');
});

// ------------------------------------------------------------- lokitus

test('KRIITTINEN: arkaluontoiset kentät korvataan lokissa', () => {
  const context = {
    token: 'salainen',
    email: 'kayttaja@example.com',
    title: 'Soita lääkärille koetuloksista',
    note: 'HIV-testi',
    amountMinor: 12995,
    energy: 2,
    apiKey: 'sk-ant-123',
    user_id: '11111111-1111-1111-1111-111111111111'
  };

  const cleaned = redactForLog(context);

  for (const key of Object.keys(context)) {
    assert.equal(cleaned[key], REDACTED, `${key} vuoti lokiin`);
  }

  const text = JSON.stringify(cleaned);
  for (const secret of ['salainen', 'kayttaja@example.com', 'HIV-testi',
    'sk-ant-123', '12995', 'Soita lääkärille']) {
    assert.equal(text.includes(secret), false, `arvo vuoti: ${secret}`);
  }
});

test('kenttä säilyy vaikka arvo korvataan', () => {
  // "note: [poistettu]" kertoo että muistiinpano oli olemassa — usein
  // juuri se mitä debugatessa tarvitaan.
  const cleaned = redactForLog({ note: 'salainen', id: 't1' });
  assert.equal('note' in cleaned, true);
  assert.equal(cleaned.note, REDACTED);
  assert.equal(cleaned.id, 't1', 'vaaraton kenttä säilyy');
});

test('suodatus ei välitä kirjainkoosta', () => {
  const cleaned = redactForLog({ Token: 'x', EMAIL: 'y', Note: 'z' });
  assert.equal(cleaned.Token, REDACTED);
  assert.equal(cleaned.EMAIL, REDACTED);
  assert.equal(cleaned.Note, REDACTED);
});

test('suodatus toimii sisäkkäisissä rakenteissa', () => {
  const cleaned = redactForLog({
    task: { id: 't1', title: 'salainen', meta: { note: 'myös salainen' } }
  });
  assert.equal(cleaned.task.id, 't1');
  assert.equal(cleaned.task.title, REDACTED);
  assert.equal(cleaned.task.meta.note, REDACTED);
});

test('pitkä lista lyhennetään lokissa', () => {
  // Sata riviä konsolissa hukuttaa olennaisen.
  const cleaned = redactForLog(Array.from({ length: 50 }, (unused, i) => ({ id: i })));
  assert.equal(cleaned.length, 6, '5 riviä + yhteenveto');
  assert.match(String(cleaned[5]), /45 muuta/);
});

test('syvä rakenne ei kaada suodatusta', () => {
  let deep = { id: 1 };
  for (let index = 0; index < 30; index++) deep = { level: deep };
  assert.doesNotThrow(() => redactForLog(deep));
});

test('jokainen arkaluontoinen kenttä on listattu pienaakkosin', () => {
  // Vertailu tehdään pienaakkosilla, joten isolla kirjoitettu merkintä
  // listassa ei osuisi koskaan.
  for (const key of SENSITIVE_KEYS) {
    assert.equal(key, key.toLowerCase(), `listassa isoja kirjaimia: ${key}`);
  }
});

test('lokitasot ovat järjestyksessä ja tunnettuja', () => {
  assert.deepEqual(Object.values(LOG_LEVEL).sort(), ['debug', 'error', 'info', 'warn']);
});

test('lokitus ei kaadu ilman kontekstia', () => {
  assert.doesNotThrow(() => log(LOG_LEVEL.WARN, 'pelkkä viesti'));
  assert.doesNotThrow(() => logWarn('viesti', null));
  assert.doesNotThrow(() => logWarn('viesti', undefined));
});

test('ympäristön tunnistus toimii ilman selainta', () => {
  // Testeissä ja Nodessa ei ole locationia. Silloin oletetaan kehitys —
  // tuotannossa location on aina olemassa.
  assert.equal(typeof isDevEnvironment(), 'boolean');
});

test('KRIITTINEN: lokitus ei lähetä mitään ulos', () => {
  // Ulkoista telemetriaa ei ole. Moduuli saa koskea vain konsoliin.
  const source = readLoggerSource();
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'sendBeacon',
    'navigator.send', 'WebSocket', 'import(']) {
    assert.equal(source.includes(forbidden), false,
      `logger sisältää ulkoisen kutsun: ${forbidden}`);
  }
});

function readLoggerSource() {
  // Luetaan lähdekoodi, koska väite koskee sitä mitä moduuli VOI tehdä,
  // ei vain sitä mitä se tässä ajossa teki.
  return readFileSync(new URL('../src/lib/logger.js', import.meta.url), 'utf8');
}

// ------------------------------------------------ ERR-15, ERR-16, raakavirheet

/** Kaappaa konsolin ulostulon (kaikki tasot) yhdeksi tekstiksi. */
function captureConsole(fn) {
  const lines = [];
  const originals = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[method] = console[method];
    console[method] = (...args) => lines.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  }
  try { fn(); } finally { Object.assign(console, originals); }
  return lines.join('\n');
}

/** Aseta globaalit hetkeksi (location, Capacitor) ja palauta ne. */
function withGlobals(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: values[key], configurable: true, writable: true });
  }
  try {
    return fn();
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('ERR-15: Suunnan ja PostgRESTin kenttänimet ovat arkaluontoisia', () => {
  for (const key of ['reflection', 'reflectionanswers', 'answer', 'answers', 'label',
    'detail', 'details', 'hint', 'message', 'metric', 'unit', 'summary', 'content',
    'body', 'query', 'note', 'title', 'name']) {
    assert.ok(SENSITIVE_KEYS.includes(key), `${key} puuttuu listasta`);
  }
  // Kirjainkoko ja ala-/väliviiva eivät tee kentästä eri kenttää.
  for (const key of ['reflection_answers', 'reflectionAnswers', 'Reflection-Answers', 'userId', 'USER_ID']) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  for (const key of ['code', 'status', 'count', 'minutes', 'kind']) {
    assert.equal(isSensitiveKey(key), false, `${key} ei ole sisältöä`);
  }
  const cleaned = redactForLog({ reflection_answers: { q1: 'yksityinen' }, details: 'Key (name)=(Terapia)', code: '23505' });
  assert.equal(cleaned.reflection_answers, REDACTED);
  assert.equal(cleaned.details, REDACTED);
  assert.equal(cleaned.code, '23505');
});

test('ERR-15 KRIITTINEN: logEvent korvaa nimen ja pohdinnan, koodi säilyy', () => {
  const out = captureConsole(() =>
    logEvent('a.b', { label: 'Terapia ryhmä', reflection: 'x', code: 'tasks.update' }));
  assert.match(out, /"code":"tasks\.update"/);
  assert.match(out, /"label":"\[poistettu\]"/);
  assert.match(out, /"reflection":"\[poistettu\]"/);
  assert.equal(out.includes('Terapia'), false);
});

test('ERR-15 KRIITTINEN: logEvent pitää vain koodin näköiset merkkijonot', () => {
  // Avain, jota ei ole listattu, ei päästä vapaata tekstiä läpi: uusi
  // kutsu `logEvent('x', { kind: area.name })` ei vuoda nimeä.
  const out = captureConsole(() => logEvent('alignment.test', {
    kind: 'Terapia ryhmä', other: 'Äiti', punct: 'Soita!', state: 'needs_review',
    op: 'tasks.update', id: 'op-123:abc', empty: '', long: 'x'.repeat(61)
  }));
  for (const secret of ['Terapia', 'Äiti', 'Soita!', 'xxxx']) {
    assert.equal(out.includes(secret), false, secret);
  }
  assert.match(out, /"kind":"\[teksti\]"/);
  assert.match(out, /"other":"\[teksti\]"/);
  assert.match(out, /"state":"needs_review"/);
  assert.match(out, /"op":"tasks\.update"/);
  assert.match(out, /"id":"op-123:abc"/);
  assert.match(out, /"empty":""/);
  assert.match(out, /"long":"\[pitkä\]"/);
  assert.equal(FREE_TEXT, '[teksti]');
  assert.equal(LONG_TEXT, '[pitkä]');
});

test('ERR-16 KRIITTINEN: natiivikuori ei ole kehitysympäristö, vaikka origin on localhost', () => {
  const native = { isNativePlatform: () => true, getPlatform: () => 'android' };
  withGlobals({ location: { hostname: 'localhost' }, Capacitor: native }, () => {
    assert.equal(isDevEnvironment(), false, 'APK:n https://localhost tulkittiin kehitykseksi');
    const quiet = captureConsole(() => {
      log(LOG_LEVEL.INFO, 'alignment.capacity_saved', { minutes: 1500 });
      logEvent('alignment.time_logged', { minutes: 30 });
    });
    assert.equal(quiet, '', 'INFO-tapahtuma päätyi logcatiin');
    const loud = captureConsole(() => logEvent('offline.replay', { failed: 1 }, LOG_LEVEL.WARN));
    assert.match(loud, /offline\.replay/, 'varoitukset kirjataan yhä');
  });
  // Selaimen localhost ilman natiivikuorta on yhä kehitys.
  withGlobals({ location: { hostname: 'localhost' }, Capacitor: { isNativePlatform: () => false } }, () => {
    assert.equal(isDevEnvironment(), true);
  });
  withGlobals({ location: { hostname: 'manifestival-ten.vercel.app' } }, () => {
    assert.equal(isDevEnvironment(), false);
  });
});

test('KRIITTINEN: logFailure kirjaa vain nimen, koodin ja tilan — ei viestiä eikä rivin arvoja', () => {
  const postgrest = {
    name: 'PostgrestError', code: '23505', status: 409,
    message: 'duplicate key value violates unique constraint "life_areas_name_unique"',
    details: 'Key (user_id, name)=(2cc00622-f927-4604-a518-361a4328481b, Terapia) already exists.',
    hint: 'salainen vihje'
  };
  const out = captureConsole(() => logFailure('alignment.area_save_failed', postgrest));
  assert.match(out, /alignment\.area_save_failed/);
  assert.match(out, /"errorName":"PostgrestError"/);
  assert.match(out, /"code":"23505"/);
  assert.match(out, /"status":409/);
  for (const secret of ['Terapia', '2cc00622', 'duplicate key', 'salainen', 'life_areas_name_unique']) {
    assert.equal(out.includes(secret), false, secret);
  }
  assert.deepEqual(Object.keys(failureFields(postgrest)).sort(), ['code', 'errorName', 'status']);
});

test('logFailure: kääreen syy luetaan, vapaa teksti ei kelpaa koodiksi', () => {
  const wrapped = { name: 'AppError', cause: { code: 'PGRST116', status: '406', message: 'Terapia' } };
  assert.deepEqual(failureFields(wrapped), { errorName: 'AppError', code: 'PGRST116', status: 406 });
  // Koodi, joka onkin lause, ei ole koodi.
  assert.equal(failureFields({ code: 'Soita äidille' }).code, null);
  const thrown = new TypeError('Failed to fetch https://x.supabase.co/rest/v1/life_areas?name=eq.Terapia');
  const out = captureConsole(() => logFailure('reconnect.refresh_failed', thrown));
  assert.match(out, /"errorName":"TypeError"/);
  assert.equal(out.includes('Terapia'), false);
  assert.equal(out.includes('supabase.co'), false);
  // Ei-olio: vain tyyppi.
  assert.deepEqual(failureFields('Terapia'), { errorName: 'string', code: null, status: null });
  assert.deepEqual(failureFields(undefined), { errorName: 'undefined', code: null, status: null });
  // Tapahtuman nimi on tunniste: vapaa teksti hylätään kokonaan.
  assert.equal(captureConsole(() => logFailure('Tallennus epäonnistui: Terapia', postgrestLike())), '');
});

function postgrestLike() {
  return { name: 'PostgrestError', code: '23505', message: 'Terapia' };
}

/**
 * Kutsun ylätason argumentit: `source[open]` on avaava sulku. Merkkijonot
 * ja sisäkkäiset sulut huomioidaan, jotta pilkku lauseen sisällä ei jaa
 * argumenttia.
 */
function callArguments(source, open) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let index = open; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      current += ch;
      if (ch === '\\') { current += source[index + 1]; index += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if ('([{'.includes(ch)) {
      depth += 1;
      if (depth === 1) continue;
    } else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        return args;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  return args;
}

const STRING_LITERAL = /^(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|`[^`$]*`)$/;

test('KRIITTINEN: src/app ei tulosta raakoja virheolioita konsoliin', () => {
  // PostgRESTin virheolio kantaa rivin arvoja (details, message), ja
  // console.warn('…', error) tulosti ne sellaisenaan — myös tuotannossa ja
  // APK:n logcatiin. Sovelluskerros kirjaa epäonnistumiset logFailurella;
  // konsolikutsu saa kantaa vain kiinteää tekstiä.
  const offenders = [];
  let checked = 0;
  for (const file of jsFilesIn('src/app')) {
    const code = readCode(file);
    for (const match of code.matchAll(/console\.(\w+)\(/g)) {
      checked += 1;
      const args = callArguments(code, match.index + match[0].length - 1);
      if (!args.every(arg => STRING_LITERAL.test(arg))) {
        offenders.push(`${file}: ${code.slice(match.index, match.index + 90).split('\n')[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'raaka arvo konsolikutsussa');
  // Tarkistin itse: tunnistaa raakavirheen eikä kaadu literaaliin.
  const sample = "console.warn('a, b', error); console.error(\"ok\");";
  assert.deepEqual(callArguments(sample, sample.indexOf('(')), ["'a, b'", 'error']);
  assert.equal(STRING_LITERAL.test('error'), false);
  assert.equal(STRING_LITERAL.test("'Manifestival: x'"), true);
  assert.ok(checked >= 0);
});

test('KRIITTINEN: tilakuuntelijan virhe kirjataan ilman virheen sisältöä', async () => {
  // Dynaaminen todiste yhdestä korvatusta paikasta: näkymän kaatuminen
  // tilan päivityksessä ei vie viestiä (joka voi sisältää otsikon)
  // konsoliin, mutta tapahtuma ja virheen nimi näkyvät.
  const { subscribe, setLifeAreas, resetState } = await import('../src/app/state.js');
  resetState();
  const unsubscribe = subscribe(() => { throw new RangeError('Terapia ryhmä: näkymä kaatui'); });
  try {
    const out = captureConsole(() => setLifeAreas([]));
    assert.match(out, /state\.listener_failed/);
    assert.match(out, /"errorName":"RangeError"/);
    assert.equal(out.includes('Terapia'), false, 'virheviesti päätyi konsoliin');
  } finally {
    unsubscribe();
    resetState();
  }
});
