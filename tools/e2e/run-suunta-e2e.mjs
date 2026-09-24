// Suunta E2E: paikallinen selainajo (headless Chrome, CDP). EI TUOTANTOA.
//
//   node tools/e2e/run-suunta-e2e.mjs
//
// TURVASÄÄNNÖT (ks. aiempi havainto vieraasta Chrome-prosessista):
//   - debug-portti valitaan vapaaksi JA todennetaan vapaaksi ennen
//     käynnistystä; vieraaseen Chromeen ei koskaan liitytä
//   - *.supabase.co ja Anthropic estetään DNS-tasolla
//     (--host-resolver-rules), ja jokainen pyyntö kirjataan: yksikin
//     yritys tuotantoon kaataa ajon
//   - profiili on projektin tmp/-hakemistossa ja poistetaan lopuksi
//
// Skenaariot: ensikäyttö (alue, tärkeys, tavoite, kapasiteetti),
// ajastin (käynnistä, kello eteen, pysäytä), nopea kirjaus dialogista,
// kuormitus + energia, huomiotta jääminen, poikkeama, päivän kortti,
// selitys (varapolku), viikkokatsaus, ehdotuksen esikatselu ja
// ryhmävahvistus, mobiilileveys ilman vaakavieritystä, saavutettava nimi
// jokaisella painikkeella ja kentällä.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml'
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function startServer(port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath.startsWith('/api/')) {
      res.writeHead(501, { 'Content-Type': 'application/json' }).end('{"error":"ei paikallisesti"}');
      return;
    }
    const filePath = path.resolve(ROOT, urlPath === '/' ? 'tools/e2e/suunta-harness.html' : urlPath.replace(/^\/+/, ''));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404).end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function cdpReachable(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
  }
  open() { return new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve); this.ws.addEventListener('error', reject); }); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(listener) { this.listeners.push(listener); }
  close() { this.ws.close(); }
}

const HELPERS = `
window.H = {
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  async waitFor(fn, label = 'ehto', timeout = 6000) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      try { const value = fn(); if (value) return value; } catch {}
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('aikakatkaisu: ' + label);
  },
  el(sel) { const node = document.querySelector(sel); if (!node) throw new Error('ei löydy: ' + sel); return node; },
  click(sel) { H.el(sel).click(); },
  fill(sel, value) {
    const node = H.el(sel);
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  },
  text(sel) { const node = document.querySelector(sel); return node ? node.textContent : ''; },
  html(sel) { const node = document.querySelector(sel); return node ? node.innerHTML : ''; },
  s: () => window.__e2e.state()
};
true;`;

const SCENARIOS = [
  ['ensikäyttö: elämänalueet, tärkeys, tavoite ja kapasiteetti', `(async () => {
    H.click('#dirAddArea');
    H.fill('#dirAreaName', 'Perhe'); H.fill('#dirAreaImportance', '5'); H.fill('#dirAreaTarget', '10');
    H.click('#dirAreaSave');
    await H.waitFor(() => H.s().lifeAreas.length === 1, 'ensimmäinen alue');
    H.click('#dirAddArea');
    H.fill('#dirAreaName', 'Työ'); H.fill('#dirAreaImportance', '3'); H.fill('#dirAreaTarget', '10'); H.fill('#dirAreaCategory', 'tyo');
    H.click('#dirAreaSave');
    await H.waitFor(() => H.s().lifeAreas.length === 2, 'toinen alue');
    H.fill('#dirCapacityHours', '20'); H.fill('#dirEnergyBudget', '2');
    H.click('#dirCapacitySave');
    await H.waitFor(() => H.s().weeklyCapacities.length === 1, 'kapasiteetti');
    const areas = H.text('#dirAreasList');
    const cap = H.s().weeklyCapacities[0];
    if (!areas.includes('Perhe') || !areas.includes('Erittäin tärkeä')) throw new Error('alue ei näy');
    if (cap.availableMinutes !== 1200 || cap.energyBudgetMinutes !== 120) throw new Error('kapasiteetti ' + JSON.stringify(cap));
    return 'alueet: ' + H.s().lifeAreas.map(a => a.name + ' ' + a.importance).join(', ') + '; kapasiteetti 20 h, kuormittavaa enintään 2 h';
  })()`],

  ['ajastin: käynnistä, 45 min kellossa, pysäytä -> ajastinkirjaus', `(async () => {
    H.click('#dirStartTimer');
    await H.waitFor(() => !H.el('#timerBar').hidden && H.text('#timerBar').includes('Käynnissä'), 'ajastinpalkki');
    window.__e2e.advance(45 * 60 * 1000);
    if (!H.text('#timerBar').includes('0:45')) throw new Error('palkki: ' + H.text('#timerBar'));
    H.click('#timerBar [data-timer="stop"]');
    await H.waitFor(() => H.s().timeEntries.length === 1, 'kirjaus');
    await H.waitFor(() => H.el('#timerBar').hidden, 'palkki piiloon');
    const entry = H.s().timeEntries[0];
    if (entry.minutes !== 45 || entry.source !== 'timer') throw new Error(JSON.stringify(entry));
    return 'kirjaus ' + entry.minutes + ' min, lähde ' + entry.source + ', operaatio ' + entry.operationId.slice(0, 6) + '…';
  })()`],

  ['nopea kirjaus: dialogi, alue, 30 min yhdellä napautuksella', `(async () => {
    H.click('#dirQuickLog');
    const dialog = await H.waitFor(() => document.querySelector('#timeLogDialog[open]'), 'dialogi auki');
    const perhe = H.s().lifeAreas.find(a => a.name === 'Perhe');
    H.fill('#timeLogArea', perhe.id);
    H.click('#timeLogDialog button[value="m:30"]');
    await H.waitFor(() => H.s().timeEntries.length === 2, 'toinen kirjaus');
    const entry = H.s().timeEntries[1];
    if (entry.lifeAreaId !== perhe.id || entry.minutes !== 30) throw new Error(JSON.stringify(entry));
    if (dialog.open) throw new Error('dialogi jäi auki');
    return 'kirjaus 30 min alueelle Perhe; dialogi suljettu';
  })()`],

  ['kuormitus ja energia: kaksi erillistä havaintoa', `(async () => {
    window.__e2e.setTasks([{ id: 'w1', title: 'Iso julkaisu', date: window.__e2e.todayIso(), durationMinutes: 1500, category: 'tyo' }]);
    await window.__e2e.tracking.saveItemSettings('task', 'w1', { energyDemand: 5 });
    await H.waitFor(() => H.text('#dirSignals').includes('Kuormitus ylittää kapasiteetin'), 'aikakuormitus');
    await H.waitFor(() => H.text('#dirSignals').includes('energiakuormaltaan raskas'), 'energiakuormitus');
    const severities = [...document.querySelectorAll('#dirSignals .dir-severity')].map(n => n.textContent);
    if (!severities.includes('Vahva')) throw new Error('vakavuus ei sanana: ' + severities);
    return 'havainnot: ' + [...document.querySelectorAll('#dirSignals .dir-signal-title')].map(n => n.textContent).join(' | ');
  })()`],

  ['huomiotta jääminen ja poikkeama tavoitteista', `(async () => {
    const tyo = H.s().lifeAreas.find(a => a.name === 'Työ');
    await window.__e2e.alignment.logTime({ entryDate: window.__e2e.todayIso(), minutes: 300, lifeAreaId: tyo.id });
    await H.waitFor(() => /Perhe/.test(H.text('#dirSignals')), 'Perhe-havainto');
    await H.waitFor(() => H.text('#dirSignals').includes('Työ vie enemmän kuin halusit'), 'poikkeama');
    return 'havainnot: ' + [...document.querySelectorAll('#dirSignals .dir-signal-title')].map(n => n.textContent).join(' | ');
  })()`],

  ['päivän kortti: yksi asia huomattavaksi, syy näkyvissä', `(async () => {
    const card = H.text('#todayDirection');
    if (!card.includes('Tänään kannattaa huomata')) throw new Error(card);
    if (!H.html('#todayDirection').includes('Miksi tämä?')) throw new Error('syy puuttuu');
    const count = document.querySelectorAll('#todayDirection .dir-today-observation').length;
    if (count > 3) throw new Error('liikaa havaintoja: ' + count);
    return count + ' havaintoa päivän kortissa';
  })()`],

  ['selitys: ilman palvelua deterministinen varapolku', `(async () => {
    const details = H.el('#dirSignals details.dir-why');
    details.open = true;
    H.click('#dirSignals [data-explain]');
    await H.waitFor(() => H.html('#dirSignals').includes('<strong>Selitys:</strong>'), 'selitys');
    if (H.html('#dirSignals').includes('Tekoälyn selitys')) throw new Error('väittää tekoälyä');
    return 'deterministinen selitys näkyy';
  })()`],

  ['viikkokatsaus: pohdinta tallentuu historiaan', `(async () => {
    H.fill('#dirAnswer-most_draining', 'Julkaisu kuormitti');
    H.click('#dirReviewSave');
    await H.waitFor(() => H.text('#dirReviewStatus').includes('Viikkokatsaus tallennettu.'), 'tallennus');
    await H.waitFor(() => H.text('#dirReviewHistory').includes('Vastattuja pohdintakysymyksiä: 1'), 'historia');
    const review = H.s().alignmentReviews[0];
    if (review.policyVersion !== 2 || review.reflectionAnswers.most_draining !== 'Julkaisu kuormitti') throw new Error(JSON.stringify(review));
    const sections = [...document.querySelectorAll('#dirReview h3')].map(n => n.textContent.split(' ')[0]);
    return 'osiot: ' + sections.join(', ');
  })()`],

  ['ensi viikko: valinta, esikatselu ennen/jälkeen ja ryhmävahvistus', `(async () => {
    const box = await H.waitFor(() => document.querySelector('#dirProposals input[data-adjust-select]'), 'ehdotus');
    const id = box.dataset.adjustSelect;
    box.click();
    H.click('#dirPreviewSelected');
    await H.waitFor(() => H.html('#dirProposalPreview').includes('<caption>'), 'esikatselu');
    if (!H.text('#dirProposalPreview').includes('Mitään ei ole vielä muutettu')) throw new Error('esikatselu väittää muutosta');
    const before = JSON.stringify(H.s().weeklyCapacities);
    await H.waitFor(() => !H.el('#dirApplySelected').disabled, 'vahvistuspainike');
    H.click('#dirApplySelected');
    const confirm = await H.waitFor(() => document.querySelector('#confirmDialog[open]'), 'vahvistusdialogi');
    const message = confirm.querySelector('#confirmMessage').textContent;
    if (JSON.stringify(H.s().weeklyCapacities) !== before) throw new Error('kirjoitti ennen vahvistusta');
    H.click('#confirmAccept');
    await H.waitFor(() => JSON.stringify(H.s().weeklyCapacities) !== before || H.s().tasks.some(t => t.id.startsWith('x')), 'muutos');
    return 'vahvistettu: ' + id + ' — dialogi: ' + message.split('\\n')[0];
  })()`],

  ['saavutettavuus: jokaisella painikkeella ja kentällä on nimi', `(async () => {
    const problems = [];
    for (const button of document.querySelectorAll('#screen-direction button, #timerBar button')) {
      if (!(button.textContent.trim() || button.getAttribute('aria-label'))) problems.push('painike ilman nimeä');
    }
    for (const field of document.querySelectorAll('#screen-direction input, #screen-direction select, #screen-direction textarea')) {
      if (field.type === 'checkbox' && field.closest('label')) continue;
      const labelled = field.id && document.querySelector('label[for="' + field.id + '"]');
      if (!labelled && !field.getAttribute('aria-label')) problems.push('kenttä ilman nimeä: ' + (field.id || field.name));
    }
    if (problems.length) throw new Error(problems.slice(0, 5).join('; '));
    return document.querySelectorAll('#screen-direction button').length + ' painiketta, kaikki nimettyjä';
  })()`]
];

const MOBILE = `(async () => {
  window.__e2e.render();
  H.click('#dirStartTimer');
  await H.waitFor(() => !H.el('#timerBar').hidden, 'ajastin');
  const widths = { page: document.documentElement.scrollWidth, viewport: window.innerWidth };
  H.click('#dirQuickLog');
  const dialog = await H.waitFor(() => document.querySelector('#timeLogDialog[open]'), 'dialogi');
  widths.dialog = Math.round(dialog.getBoundingClientRect().width);
  dialog.close('cancel');
  await H.waitFor(() => !document.querySelector('#timeLogDialog[open]'), 'dialogi kiinni');
  if (widths.page > widths.viewport + 1) throw new Error('vaakavieritys: ' + JSON.stringify(widths));
  if (widths.dialog > widths.viewport) throw new Error('dialogi ei mahdu: ' + JSON.stringify(widths));
  return 'leveys ' + widths.viewport + ' px: sivu ' + widths.page + ' px, dialogi ' + widths.dialog + ' px';
})()`;

async function main() {
  const chrome = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!chrome) throw new Error('Chromea ei löytynyt; aseta CHROME_PATH');

  const httpPort = await freePort();
  const debugPort = await freePort();
  if (await cdpReachable(debugPort)) throw new Error(`debug-portti ${debugPort} on jo käytössä — ei liitytä vieraaseen prosessiin`);

  const server = await startServer(httpPort);
  const profile = path.join(ROOT, 'tmp', `e2e-chrome-${process.pid}-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const browser = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--host-resolver-rules=MAP *.supabase.co ~NOTFOUND, MAP supabase.co ~NOTFOUND, MAP *.anthropic.com ~NOTFOUND, MAP cdn.jsdelivr.net ~NOTFOUND, MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND',
    'about:blank'
  ], { stdio: 'ignore' });

  const results = [];
  const requests = [];
  const consoleErrors = [];
  let cdp = null;
  try {
    let version = null;
    for (let i = 0; i < 80 && !version; i++) {
      await new Promise(r => setTimeout(r, 100));
      try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { /* käynnistyy */ }
    }
    if (!version) throw new Error('Chrome ei käynnistynyt');
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    cdp.on(message => {
      if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
      if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push(message.params.args.map(a => a.value || a.description).join(' '));
      }
    });
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/` });

    const evaluate = async expression => {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      }
      return response.result.value;
    };

    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (await evaluate('Boolean(window.__e2e && window.__e2e.ready)').catch(() => false)) break;
    }
    const bootErrors = await evaluate('window.__e2eErrors || []');
    if (bootErrors.length) throw new Error('käynnistysvirhe: ' + bootErrors.join('; '));
    await evaluate(HELPERS);

    for (const [name, script] of SCENARIOS) {
      try {
        results.push({ name, ok: true, detail: await evaluate(script) });
      } catch (error) {
        results.push({ name, ok: false, detail: error.message.split('\n')[0] });
      }
    }

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 3, mobile: true });
    try {
      results.push({ name: 'mobiili 360 px: ei vaakavieritystä, dialogi mahtuu', ok: true, detail: await evaluate(MOBILE) });
    } catch (error) {
      results.push({ name: 'mobiili 360 px', ok: false, detail: error.message.split('\n')[0] });
    }
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    server.close();
    await new Promise(r => setTimeout(r, 500));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  const forbidden = requests.filter(url => /supabase\.co|anthropic\.com/.test(url));
  results.push({ name: 'ei yhtään pyyntöä tuotantoon (Supabase/Anthropic)', ok: forbidden.length === 0,
    detail: forbidden.length ? forbidden.join(', ') : `${requests.length} pyyntöä, kaikki paikallisia` });
  results.push({ name: 'ei konsolivirheitä', ok: consoleErrors.length === 0, detail: consoleErrors.slice(0, 3).join(' | ') || 'ei virheitä' });

  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}\n      ${result.detail}`);
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nSUUNTA E2E: ${failed === 0 ? 'PASS' : 'FAIL'} (${results.length - failed}/${results.length})`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(error => {
  console.error('SUUNTA E2E: KESKEYTYI —', error.message);
  process.exitCode = 1;
});
