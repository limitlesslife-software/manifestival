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
  LOG_LEVEL, SENSITIVE_KEYS, REDACTED,
  redactForLog, isDevEnvironment, log, logWarn
} from '../src/lib/logger.js';

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
