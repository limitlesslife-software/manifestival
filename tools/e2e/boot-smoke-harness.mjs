// Käynnistyssavun selainvaljas. Ajaja (tools/e2e/boot-smoke.mjs) tarjoilee
// tämän osoitteessa /__smoke/harness.mjs. EI TUOTANTOA.
//
// EHDOKKAAN OMA KOODI: index.html:n runko, /src/styles.css,
// /src/data/client.js ja /src/app/main.js (ja kaikki mitä se importoi, myös
// ehdokkaan oma src/data/schema.js käännösaikaisine portteineen) tulevat
// ehdokkaan työpuusta. Tästä repositoriosta tulevat vain tämä valjas,
// kannan korvike (fakeSupabase.mjs) ja siemen (seeds.mjs).
//
// Käynnistys on sovelluksen oma: start() -> initAuth (tekaistu istunto
// ilman tokenia palautuu) -> onSignedIn -> loadUserData -> renderAll.
// Valjas vain odottaa, ohittaa ensikäytön opastuksen, jos se näkyy, ja
// antaa ajajalle mittarit (window.__smoke).
//
// SOVITUS EHDOKKAAN RAJAPINTAAN (feature detection, raportoidaan):
//   - kannan korvike asetetaan client.js:n setClient()-funktiolla
//     (tai default.setClient); jos kumpaakaan ei ole, käynnistys keskeytyy
//     ennen main.js:ää eikä mitään tuotantoon lähtevää ladata
//   - initAuth: vain todetaan (main.js kutsuu sitä itse)

import { createFakeDatabase, createFakeSupabase } from './fakeSupabase.mjs';
import { SEEDS, OWNER_USER_ID, OWNER_EMAIL } from './seeds.mjs';

const errors = (window.__smokeErrors ||= []);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function localIso(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ------------------------------------------------------------ kanta

const todayIso = localIso(new Date());
const seed = SEEDS.owner({ todayIso, userId: OWNER_USER_ID });
const database = createFakeDatabase({ tables: seed.tables });

// Hiljaisuus = kantaan ei ole koskettu hetkeen (latausketju on valmis).
let lastActivity = performance.now();
let queries = 0;
for (const name of ['selectRows', 'insertRows', 'updateRows', 'deleteRows']) {
  const original = database[name];
  database[name] = (...args) => {
    queries += 1;
    lastActivity = performance.now();
    return original(...args);
  };
}

const fake = createFakeSupabase({ database, session: { user: { id: OWNER_USER_ID, email: OWNER_EMAIL } } });
const originalFrom = fake.from;
fake.from = table => {
  lastActivity = performance.now();
  return originalFrom(table);
};

/** Odota, kunnes kantaan ei ole koskettu `quietMs` millisekuntiin. */
async function settle({ quietMs = 400, minMs = 150, timeoutMs = 8000 } = {}) {
  const start = performance.now();
  await sleep(minMs);
  while (performance.now() - start < timeoutMs) {
    if (performance.now() - lastActivity >= quietMs) return true;
    await sleep(40);
  }
  return false;
}

// --------------------------------------------------------- merkintä

const staticCounts = {};
const intervals = [];

/** index.html:n runko sivulle (ei skriptejä): ehdokkaan oma merkintä. */
async function mountMarkup() {
  const response = await fetch('/index.html', { cache: 'no-store' });
  if (!response.ok) throw new Error(`ehdokkaan index.html: HTTP ${response.status}`);
  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
  for (const screen of doc.querySelectorAll('.screen[id]')) {
    staticCounts[screen.id] = screen.querySelectorAll('*').length;
  }
  for (const node of [...doc.body.childNodes]) {
    if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === 'SCRIPT') continue;
    document.body.appendChild(document.importNode(node, true));
  }
}

const visibleText = node => (node && node.innerText ? node.innerText.replace(/\s+/g, ' ').trim() : '');

/** Alapalkin välilehdet ja kunkin näytön osiovälilehdet ehdokkaan merkinnästä. */
function navigation() {
  const tabs = [...document.querySelectorAll('.tab-btn[data-screen]')];
  return tabs.map(tab => {
    const screen = document.getElementById(tab.dataset.screen);
    const segments = screen
      ? [...screen.querySelectorAll('.segment[role="tablist"] > button.segment-btn[id^="segment"]')]
        .map(button => ({ id: button.id, label: visibleText(button) || button.textContent.trim() }))
      : [];
    return { screen: tab.dataset.screen, label: tab.textContent.trim(), exists: Boolean(screen), segments };
  });
}

/** Näytön tila napautuksen jälkeen. */
function measure(screenId, segmentId = null) {
  const screen = document.getElementById(screenId);
  if (!screen) return { exists: false };
  const text = visibleText(screen);
  const segment = segmentId ? document.getElementById(segmentId) : null;
  const startup = document.querySelector('.startup-error');
  return {
    exists: true,
    active: screen.classList.contains('active') && !screen.hasAttribute('inert'),
    visible: typeof screen.checkVisibility === 'function' ? screen.checkVisibility() : screen.offsetParent !== null,
    textLength: text.length,
    snippet: text.slice(0, 70),
    dynamic: screen.querySelectorAll('*').length - (staticCounts[screenId] || 0),
    selected: segment ? segment.getAttribute('aria-selected') === 'true' || segment.classList.contains('active') : null,
    startupError: startup ? visibleText(startup) : null
  };
}

async function tap(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error('ei löydy: ' + selector);
  node.click();
  return settle();
}

function until(predicate, timeoutMs) {
  const start = performance.now();
  return new Promise(resolve => {
    const check = () => {
      let value = false;
      try { value = predicate(); } catch { /* ei vielä */ }
      if (value || performance.now() - start > timeoutMs) { resolve(Boolean(value)); return; }
      setTimeout(check, 25);
    };
    check();
  });
}

// ------------------------------------------------------ käynnistys

async function boot() {
  localStorage.clear();
  sessionStorage.clear();
  await mountMarkup();
  const adaptations = [];

  const client = await import('/src/data/client.js');
  if (typeof client.setClient === 'function') {
    client.setClient(fake);
    adaptations.push('setClient (sama rajapinta kuin tuotehaarassa)');
  } else if (client.default && typeof client.default.setClient === 'function') {
    client.default.setClient(fake);
    adaptations.push('SOVITETTU: default.setClient');
  } else {
    throw new Error('ehdokkaan src/data/client.js: setClient puuttuu — kannan korviketta ei voi asettaa, main.js:ää ei käynnistetä');
  }
  const auth = await import('/src/app/auth.js').catch(() => null);
  adaptations.push(auth && typeof auth.initAuth === 'function'
    ? `initAuth(${auth.initAuth.length} parametri) löytyi; main.js kutsuu sitä itse`
    : 'HUOM: src/app/auth.js initAuth puuttuu');

  // Service worker ei kuulu savuun: välimuisti ei saa tarjoilla vanhaa
  // moduulia, eikä sw.js hae mitään.
  if (navigator.serviceWorker) navigator.serviceWorker.register = async () => null;

  let gates = null;
  try {
    const schema = await import('/src/data/schema.js');
    gates = {
      tables: schema.TABLES ? { ...schema.TABLES } : null,
      columns: schema.COMPILE_COLUMN_GATES ? { ...schema.COMPILE_COLUMN_GATES } : null
    };
  } catch (error) {
    gates = { error: String(error && error.message) };
  }

  // Sovelluksen omat pitkät ajastimet (esim. main.js:n 30 s NYT-kierros)
  // talteen: ajaja ajaa ne kerran heti näyttöjen jälkeen (tick), ettei
  // savun tarvitse odottaa oikeaa aikaa. Ajastimet toimivat myös normaalisti.
  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => {
    const id = realSetInterval(fn, ms, ...rest);
    if (typeof fn === 'function' && Number(ms) >= 10000) intervals.push({ fn, ms: Number(ms), args: rest });
    return id;
  };

  // OIKEA KÄYNNISTYS (ehdokkaan oma main.js).
  await import('/src/app/main.js');

  const app = document.getElementById('app');
  const gate = document.getElementById('authGate');
  const shown = await until(() => (app && !app.classList.contains('app-hidden'))
    || (gate && gate.classList.contains('open')) || document.querySelector('.startup-error'), 15000);
  await settle({ quietMs: 600, timeoutMs: 12000 });

  let onboarding = 'ei näkynyt';
  const overlay = document.getElementById('onboarding');
  if (overlay && overlay.getAttribute('aria-hidden') === 'false') {
    const skip = document.getElementById('onboardingSkip');
    if (skip) {
      skip.click();
      onboarding = 'näkyi, ohitettu (Ohita)';
      await settle();
    } else {
      onboarding = 'näkyi, Ohita-painiketta ei ole';
    }
  }

  window.__smoke = {
    ready: true,
    info: {
      todayIso,
      userId: OWNER_USER_ID,
      seed: Object.fromEntries(Object.entries(seed.tables).map(([table, rows]) => [table, rows.length])),
      adaptations,
      gates,
      onboarding,
      appVisible: Boolean(app && !app.classList.contains('app-hidden')),
      authGateOpen: Boolean(gate && gate.classList.contains('open')),
      startupError: document.querySelector('.startup-error') ? visibleText(document.querySelector('.startup-error')) : null,
      shownInTime: shown
    },
    settle,
    tap,
    measure,
    navigation,
    /**
     * Aja sovelluksen omat pitkät ajastimet kerran. Kutsu erillisessä
     * tehtävässä: poikkeus on käsittelemätön kuten oikeassa kierroksessa
     * (ajaja näkee sen sijainteineen).
     */
    async tick() {
      for (const interval of intervals) setTimeout(() => interval.fn(...interval.args), 0);
      await settle();
      return intervals.map(interval => interval.ms);
    },
    stats: () => ({ queries, writes: database.writes(), unsupported: fake.unsupported() })
  };
}

boot().catch(error => { errors.push('boot: ' + (error && error.stack ? error.stack : String(error))); });
