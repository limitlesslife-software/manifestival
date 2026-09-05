// RLS-hyväksyntätestin ajuri selaimessa.
//
// Tämä tiedosto tekee vain kolme asiaa: rakentaa clientit, kirjaa tilit
// sisään ja piirtää tuloksen. Kaikki päättely on acceptance.js:ssä,
// koska sitä voi yksikkötestata Nodessa ilman verkkoa.
//
// SALASANAT eivät päädy mihinkään: ne luetaan kentästä, annetaan
// supabase-js:lle ja kenttä tyhjennetään. Niitä ei tallenneta, ei
// logiteta eikä lähetetä minnekään muualle kuin Supabasen omaan
// auth-päätepisteeseen.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../src/data/config.js';
import { runAcceptance, formatReport, STATUS } from './acceptance.js';

const $ = id => document.getElementById(id);

/**
 * Sivun saa ajaa vain paikallisesti.
 *
 * Tämä sivu kirjaa sisään oikeita tuotantotilejä. Jos se päätyisi
 * julkaistuun sivustoon, se olisi valmis kirjautumislomake väärässä
 * paikassa. Sivu on suljettu pois julkaisusta (.vercelignore), mutta
 * poissulku on konfiguraatiota — tämä on koodia.
 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', ''];

function isLocal() {
  return LOCAL_HOSTS.includes(location.hostname);
}

/** Kolme erillistä clientiä samalle sivulle. */
function makeClient(storageKey) {
  // persistSession: false ja oma storageKey pitävät istunnot erillään.
  // Ilman niitä toinen sisäänkirjautuminen ylikirjoittaisi ensimmäisen,
  // ja "kaksi tiliä" olisi todellisuudessa yksi.
  return globalThis.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey
    }
  });
}

function setStatus(text, kind) {
  const box = $('status');
  box.textContent = text;
  box.className = kind || '';
}

function renderTable(rows) {
  const head = ['test_no', 'test_name', 'status', 'expected', 'actual', 'details'];
  const table = $('results');
  table.innerHTML = '';

  const headRow = document.createElement('tr');
  for (const column of head) {
    const cell = document.createElement('th');
    cell.textContent = column;
    headRow.appendChild(cell);
  }
  table.appendChild(headRow);

  for (const entry of rows) {
    const tr = document.createElement('tr');
    tr.className = entry.status.toLowerCase();
    for (const column of head) {
      const cell = document.createElement('td');
      cell.textContent = entry[column];
      tr.appendChild(cell);
    }
    table.appendChild(tr);
  }
}

/** Kirjaa tili sisään ja palauta sen tunniste. */
async function signIn(client, email, password, label) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Tilin ${label} kirjautuminen epäonnistui: ${error.message}`);
  if (!data || !data.user || !data.user.id) throw new Error(`Tilille ${label} ei saatu tunnistetta`);
  return data.user.id;
}

async function run() {
  const button = $('run');
  button.disabled = true;
  $('report').value = '';
  renderTable([]);

  const clients = {
    a: makeClient('rls-acceptance-a'),
    b: makeClient('rls-acceptance-b'),
    anon: makeClient('rls-acceptance-anon')
  };

  try {
    if (!isLocal()) {
      throw new Error('Tämä sivu ajetaan vain paikallisesti (npm run serve).');
    }
    if (!globalThis.supabase || typeof globalThis.supabase.createClient !== 'function') {
      throw new Error('supabase-js ei latautunut. Tarkista verkkoyhteys.');
    }

    const ownerAId = $('ownerA').value.trim();
    const expectedTaskCount = Number($('expectedCount').value);
    if (!ownerAId) throw new Error('Tilin A tunniste puuttuu.');
    if (!Number.isInteger(expectedTaskCount) || expectedTaskCount < 0) {
      throw new Error('Tehtävien lähtömäärä on virheellinen.');
    }

    setStatus('Kirjaudutaan sisään…');
    const signedInA = await signIn(clients.a, $('emailA').value.trim(), $('passwordA').value, 'A');
    if (signedInA !== ownerAId) {
      throw new Error(
        `Kirjautunut tili A ei ole odotettu omistaja.\n`
        + `odotettu: ${ownerAId}\nkirjautunut: ${signedInA}\n`
        + 'Testiä ei ajeta väärää tiliä vastaan.');
    }
    const userBId = await signIn(clients.b, $('emailB').value.trim(), $('passwordB').value, 'B');

    setStatus('Ajetaan T1–T6…');
    const { rows, summary } = await runAcceptance({
      ...clients,
      ownerAId,
      userBId,
      expectedTaskCount,
      runId: `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`,
      today: new Date().toISOString().slice(0, 10)
    });

    renderTable(rows);
    $('report').value = formatReport(rows, summary);
    setStatus(
      `${summary.verdict} — ${summary.pass}/${summary.total} PASS, `
      + `${summary.fail} FAIL, ${summary.error} ERROR, ${summary.skip} SKIP`,
      summary.verdict === 'PASS' ? 'pass' : 'fail');
  } catch (cause) {
    // Virhe ajossa EI ole hyväksytty tulos. Se näytetään sellaisenaan.
    setStatus(String(cause && cause.message ? cause.message : cause), 'fail');
    renderTable([{
      test_no: '-', test_name: 'ajo keskeytyi', status: STATUS.ERROR,
      expected: 'testi ajetaan loppuun', actual: String(cause && cause.message ? cause.message : cause),
      details: 'tulosta ei saa tulkita hyväksynnäksi'
    }]);
  } finally {
    // Salasanat pois DOMista JOKA TAPAUKSESSA — myös silloin, kun
    // kirjautuminen epäonnistui. Epäonnistunut yritys on juuri se hetki,
    // jolloin salasana muuten jäisi kenttään pisimmäksi aikaa.
    $('passwordA').value = '';
    $('passwordB').value = '';

    // Istunnot pois joka tapauksessa, myös virheen jälkeen.
    for (const client of Object.values(clients)) {
      try { await client.auth.signOut(); } catch { /* istuntoa ei ollut */ }
    }
    button.disabled = false;
  }
}

$('run').addEventListener('click', run);
$('copy').addEventListener('click', () => {
  $('report').select();
  document.execCommand('copy');
  setStatus('Raportti kopioitu leikepöydälle.');
});

if (!isLocal()) {
  setStatus('Tämä sivu toimii vain paikallisesti (npm run serve).', 'fail');
  $('run').disabled = true;
}
