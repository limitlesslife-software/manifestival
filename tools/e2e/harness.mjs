// Suunta E2E -valjas selaimessa. Ks. suunta-harness.html.
//
// OIKEA KÄYNNISTYS: valjas liittää index.html:n koko rungon sivulle,
// asettaa tekaistun Supabase-asiakkaan (tools/e2e/fakeSupabase.mjs) ja
// importoi src/app/main.js:n. Sovellus käynnistyy omalla polullaan:
// start() -> initAuth (istunto palautuu) -> onSignedIn -> skeematarkistus
// -> loadUserData -> renderAll -> ensikäytön opastus. Näkymiä ei kytketä
// käsin.
//
// Kanta on sivun sessionStoragessa (sama välilehti säilyttää sen
// uudelleenlatauksen yli), joten sivun uudelleenlataus ajaa saman
// käynnistyksen uudelleen ja loadUserData lukee tallennetut rivit.
// localStorage (ajastimen kopio, offline-jono, lähtökori, asetukset) on
// sovelluksen oma, kuten laitteella.
//
// URL-parametrit (ajaja asettaa):
//   reset=1        tyhjennä laitteen tallennus ja kanta, siemennä kanta
//   seed=legacy    siemen (tools/e2e/seeds.mjs); oletus tyhjä kanta
//   clock=ISO      kellon alkuhetki (paikallinen aika), esim. keskiviikko 10.00
//   gates=J        J-portit (ajaja tarjoilee import mapin); oletus haaran omat
//   gates=K        K-portit, kaikki portit auki (arjen E2E, run-daily-life-e2e.mjs)
//   onboarding=skip  ohita ensikäytön opastus käynnistyksessä
// reset, seed ja clock poistetaan osoitteesta heti: uudelleenlataus ei nollaa.
//
// Siirrettävä kello: Date.now() ja `new Date()` palauttavat oikean ajan
// plus siirtymän (säilyy uudelleenlatauksen yli). Muut Date-muodot
// (päivämäärä argumenttina) ovat ennallaan.
//
// Offline: navigator.onLine palauttaa false ja jokainen kysely palauttaa
// supabase-js:n verkkovirheen. Sivu itse latautuu paikalliselta
// palvelimelta (tuotannossa service worker); se on tämän valjaan raja.

import { createFakeDatabase, createFakeSupabase, OWNER_BY_ID } from './fakeSupabase.mjs';
import { SEEDS, LEGACY_USER_ID, LEGACY_EMAIL } from './seeds.mjs';

const KEYS = Object.freeze({
  db: 'e2e.fakeDb.v1', clock: 'e2e.clockOffsetMs', offline: 'e2e.offline', session: 'e2e.session', ids: 'e2e.seedIds'
});
const params = new URLSearchParams(location.search);
const errors = (window.__e2eErrors ||= []);

function readJson(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  sessionStorage.setItem(key, JSON.stringify(value));
}

function localIso(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ------------------------------------------------------------ nollaus

const RealDate = Date;
if (params.get('reset') === '1') {
  localStorage.clear();
  sessionStorage.clear();
  const clock = params.get('clock');
  const target = clock ? new RealDate(clock).getTime() : NaN;
  writeJson(KEYS.clock, Number.isFinite(target) ? target - RealDate.now() : 0);
  const seedName = params.get('seed') || 'empty';
  const seed = SEEDS[seedName];
  if (!seed) throw new Error('tuntematon siemen: ' + seedName);
  const today = localIso(new RealDate(RealDate.now() + readJson(KEYS.clock, 0)));
  const { tables, ids } = seed({ todayIso: today, userId: LEGACY_USER_ID });
  writeJson(KEYS.db, tables);
  writeJson(KEYS.ids, { ...ids, seed: seedName, today });
  writeJson(KEYS.session, { user: { id: LEGACY_USER_ID, email: LEGACY_EMAIL } });
  const clean = new URL(location.href);
  for (const key of ['reset', 'seed', 'clock']) clean.searchParams.delete(key);
  history.replaceState(null, '', clean.pathname + clean.search);
}

// --------------------------------------------------------------- kello

let offset = Number(readJson(KEYS.clock, 0)) || 0;
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...args);
  }
  static now() { return RealDate.now() + offset; }
}
globalThis.Date = ShiftedDate;

// ------------------------------------------------------------- offline

let offline = readJson(KEYS.offline, false) === true;
Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => !offline });

// --------------------------------------------------------------- kanta

const database = createFakeDatabase({ tables: readJson(KEYS.db, {}) });
const persistDb = () => writeJson(KEYS.db, database.snapshot());
// Istunto ilman access tokenia: sovellus ei tee yhtään tekoälykutsua.
const fake = createFakeSupabase({
  database,
  session: readJson(KEYS.session, null),
  isOffline: () => offline,
  onWrite: persistDb,
  onSessionChange: session => writeJson(KEYS.session, session)
});

// ------------------------------------------------------------ merkintä

/** index.html:n runko sivulle (ei skriptejä): sama merkintä kuin tuotannossa. */
async function mountMarkup() {
  const response = await fetch('/index.html', { cache: 'no-store' });
  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
  for (const node of [...doc.body.childNodes]) {
    if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === 'SCRIPT') continue;
    document.body.appendChild(document.importNode(node, true));
  }
}

function until(predicate, label, timeout = 10000) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      let value = false;
      try { value = predicate(); } catch { /* ei vielä */ }
      if (value) { resolve(value); return; }
      if (performance.now() - start > timeout) { reject(new Error('aikakatkaisu: ' + label)); return; }
      setTimeout(check, 20);
    };
    check();
  });
}

async function boot() {
  await mountMarkup();
  const client = await import('/src/data/client.js');
  client.setClient(fake);
  // Service worker ei kuulu tähän ajoon (sw.js: scripts/smoke.mjs): välimuisti
  // ei saa tarjoilla vanhaa moduulia uudelleenlatauksessa.
  if (navigator.serviceWorker) navigator.serviceWorker.register = async () => null;

  const schema = await import('/src/data/schema.js');
  const gates = {
    mode: params.get('gates') || 'closed',
    tables: { ...schema.TABLES },
    columns: { ...schema.COMPILE_COLUMN_GATES }
  };
  if (gates.mode === 'J' && !(gates.tables.lifeAreas && gates.tables.runningTimers && gates.columns.ALIGNMENT_REALITY_FIELDS)) {
    throw new Error('J-portit eivät tulleet voimaan (import map)');
  }
  // Aalto K avaa kaikki portit: jokainen taulu- ja sarakeportti auki.
  if (gates.mode === 'K' && !(Object.values(gates.tables).every(Boolean) && Object.values(gates.columns).every(Boolean))) {
    throw new Error('K-portit eivät tulleet voimaan (import map)');
  }

  // OIKEA KÄYNNISTYS.
  await import('/src/app/main.js');

  const state = await import('/src/app/state.js');
  const onboarding = await import('/src/app/onboarding.js');
  const session = readJson(KEYS.session, null);
  const overlayShown = () => document.getElementById('onboarding').getAttribute('aria-hidden') === 'false';
  if (session) {
    // onSignedIn on valmis, kun lataus on tehty ja opastus on päätetty.
    await until(() => state.getState().dataLoadStatus.profile && (overlayShown() || onboarding.onboardingDone()),
      'kirjautuminen ja lataus');
    if (params.get('onboarding') === 'skip' && overlayShown()) document.getElementById('onboardingSkip').click();
  } else {
    await until(() => document.getElementById('authGate').classList.contains('open'), 'kirjautumisportti');
  }
  await new Promise(resolve => setTimeout(resolve, 50));

  const direction = await import('/src/app/views/direction.js');
  const timeLog = await import('/src/app/views/timeLog.js');
  const alignment = await import('/src/app/alignment.js');
  const tracking = await import('/src/app/timeTracking.js');
  const actions = await import('/src/app/actions.js');
  const datetime = await import('/src/lib/datetime.js');
  const task = await import('/src/domain/task.js');
  const rows = await import('/src/lib/rows.js');
  const domainAlignment = await import('/src/domain/alignment.js');

  const render = () => {
    timeLog.renderTimerBar();
    direction.renderTodayDirection();
    direction.renderDirection();
  };
  const userId = () => (readJson(KEYS.session, null)?.user?.id) || null;
  const ownRows = table => database.rows(table)
    .filter(row => String(OWNER_BY_ID.includes(table) ? row.id : row.user_id) === String(userId()));

  window.__e2e = {
    ready: true,
    gates,
    seed: readJson(KEYS.ids, {}),
    userId,
    advance: ms => {
      offset += ms;
      writeJson(KEYS.clock, offset);
      render();
    },
    todayIso: () => datetime.fmtISO(new Date()),
    state: () => state.getState(),
    /**
     * Korvaa käyttäjän tehtävät (skenaarion lähtötilanne): kantaan ja tilaan
     * samat rivit, jotta sovelluksen päivitys osuu olemassa olevaan riviin.
     */
    setTasks: list => {
      const normalized = list.map(t => task.normalizeTask(t));
      const columns = [...rows.TASK_COLUMNS_PLANNING, ...rows.TASK_COLUMNS_LINKS];
      const others = database.rows('tasks').filter(row => String(row.user_id) !== String(userId()));
      database.setRows('tasks', [...others, ...normalized.map(t => ({ ...rows.toRow(t, columns), user_id: userId() }))]);
      persistDb();
      state.setTasks(normalized);
    },
    setOffline: on => {
      offline = Boolean(on);
      writeJson(KEYS.offline, offline);
      window.dispatchEvent(new Event(offline ? 'offline' : 'online'));
    },
    isOffline: () => offline,
    db: {
      rows: ownRows,
      writes: () => database.writes(),
      unsupported: () => fake.unsupported()
    },
    loadUserData: () => actions.loadUserData(),
    SIGNAL: domainAlignment.SIGNAL,
    alignment, tracking, timeLog, render,
    errors
  };
}

window.addEventListener('error', event => { errors.push(String(event.message)); });
window.addEventListener('unhandledrejection', event => { errors.push(String(event.reason)); });
boot().catch(error => { errors.push('boot: ' + error.message); });
