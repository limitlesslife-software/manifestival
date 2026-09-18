// Testit src/ai/commandClient.js:lle: /api/command-kutsun onnistuminen,
// virheet ja se, ettei verkkovirheestä koskaan synny arvattua komentoa.
//
// EI OIKEAA VERKKOA. fetchImpl injektoidaan, kuten muissakin AI-clientin
// testeissä — deterministinen ja nopea.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requestCommand, weekdayName } from '../src/ai/commandClient.js';

function textResponse(text, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => ({ content: [{ type: 'text', text }] })
  };
}

test('tyhjä teksti hylätään ilman verkkokutsua', async () => {
  let called = false;
  const result = await requestCommand({
    text: '   ', today: '2026-09-18',
    fetchImpl: async () => { called = true; return textResponse('{}'); }
  });
  assert.equal(result.ok, false);
  assert.equal(called, false, 'tyhjä komento ei saa kuluttaa verkkokutsua eikä kiintiötä');
});

test('onnistunut vastaus palauttaa poimitun JSON:in', async () => {
  const result = await requestCommand({
    text: 'siirrä hammaslääkäri perjantaille', today: '2026-09-18', weekday: 'perjantai',
    fetchImpl: async () => textResponse('{"intent":"reschedule_task","targetName":"hammaslääkäri","date":"2026-09-19"}')
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.raw, {
    intent: 'reschedule_task', targetName: 'hammaslääkäri', date: '2026-09-19'
  });
});

test('markdown-koodilohko ei estä JSON:in poimintaa', async () => {
  const result = await requestCommand({
    text: 'poista huominen muistutus', today: '2026-09-18',
    fetchImpl: async () => textResponse('```json\n{"intent":"delete_task","targetName":"muistutus"}\n```')
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.raw.intent, 'delete_task');
});

test('vastaus jossa ei ole JSON:ia palauttaa rehellisen epäonnistumisen, ei arvausta', async () => {
  const result = await requestCommand({
    text: 'jotain epäselvää', today: '2026-09-18',
    fetchImpl: async () => textResponse('En ymmärtänyt, voitko tarkentaa?')
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'aiCommand.noJson');
});

test('401 kertoo uudelleenkirjautumisesta eikä paljasta palvelimen tilaa', async () => {
  const result = await requestCommand({
    text: 'poista tehtävä X', today: '2026-09-18',
    fetchImpl: async () => textResponse('', { ok: false, status: 401 })
  });
  assert.equal(result.ok, false);
  assert.match(result.error.userMessage, /kirjaudu/i);
});

test('429 kertoo rajoituksesta', async () => {
  const result = await requestCommand({
    text: 'poista tehtävä X', today: '2026-09-18',
    fetchImpl: async () => textResponse('', { ok: false, status: 429 })
  });
  assert.equal(result.ok, false);
  assert.match(result.error.userMessage, /liian monta/i);
});

test('verkkovirhe ei koskaan tuota arvattua komentoa', async () => {
  const result = await requestCommand({
    text: 'poista tehtävä X', today: '2026-09-18',
    fetchImpl: async () => { throw new Error('verkko poikki'); }
  });
  assert.equal(result.ok, false, 'komennolle ei ole turvallista varaehdotusta — epäonnistuminen kerrotaan');
  assert.equal(result.error.code, 'aiCommand.network');
});

test('aikakatkaisu raportoituu erikseen verkkovirheestä', async () => {
  const result = await requestCommand({
    text: 'poista tehtävä X', today: '2026-09-18',
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'aiCommand.timeout');
});

test('weekdayName palauttaa suomenkielisen nimen', () => {
  // 2026-09-18 on perjantai.
  assert.equal(weekdayName(new Date('2026-09-18T12:00:00')), 'perjantai');
});
