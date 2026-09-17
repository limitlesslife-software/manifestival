// Sovelluksen etu-/taustatilan sovittimen testit.
//
// src/platform/lifecycle.js kytkee kaksi asiaa: Capacitorin App-liitännäisen
// resume/pause-tapahtumat natiivissa, ja document.visibilitychange-tapahtuman
// aina (myös natiivissa, varajärjestelmänä). Kumpaakaan ei voi todentaa
// oikealla laitteella tästä ympäristöstä käsin — testataan siis muunnos ja
// kytkentälogiikka, ei sitä näkeekö käyttäjä oikeasti mitään.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_CAPACITOR = globalThis.Capacitor;

function fakeAppPlugin() {
  const listeners = {};
  return {
    listeners,
    addListener(event, handler) {
      (listeners[event] ||= []).push(handler);
    },
    emit(event) {
      for (const handler of listeners[event] || []) handler();
    }
  };
}

function installShell(appPlugin) {
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: appPlugin ? { App: appPlugin } : {}
  };
}

const lifecycle = await import('../src/platform/lifecycle.js');

beforeEach(() => {
  delete globalThis.Capacitor;
  lifecycle.resetLifecycleBinding();
});

afterEach(() => {
  if (ORIGINAL_CAPACITOR === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = ORIGINAL_CAPACITOR;
  lifecycle.resetLifecycleBinding();
});

test('liitännäistä ei löydy selaimesta', () => {
  assert.equal(lifecycle.isNativeLifecycleAvailable(), false);
  assert.equal(lifecycle.plugin(), null);
});

test('liitännäinen löytyy natiivikuoresta jossa se on rekisteröity', () => {
  installShell(fakeAppPlugin());
  assert.equal(lifecycle.isNativeLifecycleAvailable(), true);
});

test('natiivi resume-tapahtuma kutsuu onResume-käsittelijää', () => {
  const app = fakeAppPlugin();
  installShell(app);

  let resumed = 0;
  lifecycle.bindLifecycle({ onResume: () => { resumed++; } });

  app.emit('resume');
  assert.equal(resumed, 1);
});

test('natiivi pause-tapahtuma kutsuu onPause-käsittelijää', () => {
  const app = fakeAppPlugin();
  installShell(app);

  let paused = 0;
  lifecycle.bindLifecycle({ onPause: () => { paused++; } });

  app.emit('pause');
  assert.equal(paused, 1);
});

test('KRIITTINEN: kytkentä tehdään tasan kerran — toinen kutsu ei lisää kuuntelijaa', () => {
  const app = fakeAppPlugin();
  installShell(app);

  let resumed = 0;
  const first = lifecycle.bindLifecycle({ onResume: () => { resumed++; } });
  const second = lifecycle.bindLifecycle({ onResume: () => { resumed++; } });

  assert.equal(first, true, 'ensimmäinen kutsu tekee kytkennän');
  assert.equal(second, false, 'toinen kutsu ei tee mitään');

  app.emit('resume');
  assert.equal(resumed, 1, 'vain ensimmäisen kutsun käsittelijä on kytketty');
});

test('selaimessa puuttuva App-liitännäinen ei kaada kytkentää', () => {
  // Ei natiivikuorta lainkaan: globaalia Capacitoria ei ole.
  let resumed = 0;
  const bound = lifecycle.bindLifecycle({ onResume: () => { resumed++; } });
  assert.equal(bound, true, 'kytkentä onnistuu myös ilman natiivia liitännäistä');
});

test('onResume ja onPause ovat valinnaisia — puuttuva käsittelijä ei kaada', () => {
  const app = fakeAppPlugin();
  installShell(app);
  assert.doesNotThrow(() => {
    lifecycle.bindLifecycle({});
    app.emit('resume');
    app.emit('pause');
  });
});

test('resetLifecycleBinding sallii uuden kytkennän testien välillä', () => {
  installShell(fakeAppPlugin());
  assert.equal(lifecycle.bindLifecycle({}), true);
  assert.equal(lifecycle.bindLifecycle({}), false);
  lifecycle.resetLifecycleBinding();
  assert.equal(lifecycle.bindLifecycle({}), true, 'nollauksen jälkeen kytkentä on taas mahdollinen');
});
