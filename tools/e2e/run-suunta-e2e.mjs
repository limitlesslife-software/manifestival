// Suunta E2E: paikallinen selainajo (headless Chrome, CDP). EI TUOTANTOA.
//
//   node tools/e2e/run-suunta-e2e.mjs            kaikki ryhmät
//   E2E_GROUPS=legacy node tools/e2e/run-...     vain vanhan käyttäjän ryhmä
//   E2E_GATES_REF=<ref>                          J-porttien lähde (oletus rehearsal/wave-j-v1)
//
// TURVASÄÄNNÖT (ks. aiempi havainto vieraasta Chrome-prosessista):
//   - debug-portti valitaan vapaaksi JA todennetaan vapaaksi ennen
//     käynnistystä; vieraaseen Chromeen ei koskaan liitytä
//   - *.supabase.co ja Anthropic estetään DNS-tasolla
//     (--host-resolver-rules), ja jokainen pyyntö kirjataan: yksikin
//     yritys tuotantoon kaataa ajon
//   - profiili on projektin tmp/-hakemistossa ja poistetaan lopuksi
//
// KÄYNNISTYS: valjas (tools/e2e/harness.mjs) käynnistää sovelluksen
// oikealla polulla (src/app/main.js) tekaistulla istunnolla ja
// tallentavalla kannan korvikkeella (tools/e2e/fakeSupabase.mjs).
// Uudelleenlataus on oikea sivun uudelleenlataus (Page.reload): main.js
// käynnistyy uudelleen ja loadUserData lukee kannan rivit.
//
// RYHMÄT (jokainen alkaa tyhjältä laitteelta):
//   closed   haaran omat portit (Suunta muistissa), tyhjä kanta:
//            aiemmat skenaariot
//   J        aallon J portit (ks. tools/e2e/gates.mjs), tyhjä kanta:
//            samat skenaariot tallentuvalla Suunnalla
//   legacy   aallon J portit, vanhan käyttäjän kanta (tools/e2e/seeds.mjs):
//            aloitus, alue, kapasiteetti, tavoite, arvio, ajastin,
//            uudelleenlataus, pysäytys, katsaus, ensi viikko, liitos,
//            näppäimistö ja offline
//
// ODOTTAA RINNAKKAISTA PAKETTIA: skenaario, jonka korjaus tulee toisesta
// paketista, on PENDING_ON-listassa. Sen epäonnistuminen ei kaada ajoa,
// mutta onnistuminen kaataa ("poista merkintä"): merkintä ei jää
// unohduksiin, kun korjaus on integroitu.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveGateMode, GATES_QUERY, harnessHtml } from './gates.mjs';

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

const HARNESS_PAGE = 'tools/e2e/suunta-harness.html';

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

function startServer(port, { gatedSchema }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const urlPath = decodeURIComponent(url.pathname);
    if (urlPath.startsWith('/api/')) {
      res.writeHead(501, { 'Content-Type': 'application/json' }).end('{"error":"ei paikallisesti"}');
      return;
    }
    const headers = type => ({ 'Content-Type': type, 'Cache-Control': 'no-store' });
    if (urlPath === '/' || urlPath === '/' + HARNESS_PAGE) {
      const template = fs.readFileSync(path.join(ROOT, HARNESS_PAGE), 'utf8');
      res.writeHead(200, headers(MIME['.html'])).end(harnessHtml(template, url.searchParams.get('gates')));
      return;
    }
    if (urlPath === '/src/data/schema.js' && url.searchParams.get(GATES_QUERY) === 'J') {
      res.writeHead(200, headers(MIME['.js'])).end(gatedSchema);
      return;
    }
    const filePath = path.resolve(ROOT, urlPath.replace(/^\/+/, ''));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404).end('404'); return; }
      res.writeHead(200, headers(MIME[path.extname(filePath)] || 'application/octet-stream')).end(data);
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
  s: () => window.__e2e.state(),
  // Kannan rivit (kirjautuneen käyttäjän), kuten palvelin ne näkee.
  db: table => window.__e2e.db.rows(table),
  tab: screen => H.click('.tab-btn[data-screen="' + screen + '"]'),
  // Tallennus on valmis vasta, kun painike ei ole enää varattu (tuplaklikkaussuoja):
  // tila päivittyy optimistisesti jo ennen kuin tallennus on palannut.
  idle: (sel, label) => H.waitFor(() => !H.el(sel).disabled && !H.el(sel).hasAttribute('aria-busy'), label || ('valmis: ' + sel))
};
true;`;

// F2: aloituksen tarkistukset (ajetaan 360 px leveydellä, ks. SCENARIOS).
const SETUP_SCENARIO = `(async () => {
    const setup = H.el('#dirSetup');
    if (setup.hidden || !H.text('#dirSetup').includes('Vaihe 1/7')) throw new Error('aloitus ei näy: ' + H.text('#dirSetup'));
    if (getComputedStyle(H.el('#dirQuickActions')).display !== 'none') throw new Error('pikatoiminnot eivät väisty');
    if (setup.querySelector('[data-setup="skip"]')) throw new Error('aluetta voi ohittaa');
    H.click('#dirSetup [data-setup-draft="Perhe"]');
    H.click('#dirSetup [data-setup-draft="Työ"]');
    H.click('#dirSetup [data-setup="to-importance"]');
    await H.waitFor(() => H.text('#dirSetup').includes('Vaihe 2/7'), 'vaihe 2');
    if (setup.querySelector('input[type="radio"]:checked')) throw new Error('tärkeys valittu valmiiksi');
    if (!H.el('#dirSetup [data-setup="save-areas"]').disabled) throw new Error('tallennus sallittu ilman tärkeyttä');
    const problems = [];
    for (const button of setup.querySelectorAll('button')) {
      if (!(button.textContent.trim() || button.getAttribute('aria-label'))) problems.push('painike ilman nimeä');
      if (button.getBoundingClientRect().height < 43.5) problems.push('alle 44 px: ' + button.textContent.trim());
    }
    for (const input of setup.querySelectorAll('input')) {
      if (!input.closest('label') && !(input.id && document.querySelector('label[for="' + input.id + '"]'))) problems.push('kenttä ilman nimeä');
    }
    for (const label of setup.querySelectorAll('label.dir-setup-choice')) {
      if (label.getBoundingClientRect().height < 43.5) problems.push('valinta alle 44 px');
    }
    if (problems.length) throw new Error(problems.slice(0, 4).join('; '));
    if (document.documentElement.scrollWidth > window.innerWidth + 1) throw new Error('vaakavieritys aloituksessa');
    if (H.s().lifeAreas.length !== 0) throw new Error('luonnos loi alueen');
    H.click('#dirSetup [data-setup="back"]');
    await H.waitFor(() => H.text('#dirSetup').includes('Vaihe 1/7'), 'takaisin vaiheeseen 1');
    H.click('#dirSetup [data-setup-draft="Perhe"]');
    H.click('#dirSetup [data-setup-draft="Työ"]');
    return 'vaihe 1/7 ja 2/7 näkyvät, tärkeyttä ei valittu, ei alueita ennen tallennusta; '
      + 'leveys ' + window.innerWidth + ' px, sivu ' + document.documentElement.scrollWidth + ' px';
  })()`;

const SCENARIOS = [
  // F2: ilman alueita Suunta avautuu aloitukseen (vaihe 1/7) ja muu näkymä
  // väistyy. Skenaario ei tallenna mitään: seuraava skenaario luo alueet
  // tavallisella lomakkeella, joka toimii yhä (ohjelmallinen napautus).
  // Ajetaan 360 px leveydellä: aloitus on puhelimen ensinäkymä.
  ['aloitus: vaihe 1/7, muu Suunta väistyy, ohjaimet nimetty, mitään ei luoda ennen tallennusta (360 px)', async ({ evaluate, cdp }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 3, mobile: true });
    try {
      return await evaluate(SETUP_SCENARIO);
    } finally {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    }
  }],

  ['ensikäyttö: elämänalueet, tärkeys, tavoite ja kapasiteetti', `(async () => {
    H.click('#dirAddArea');
    H.fill('#dirAreaName', 'Perhe'); H.fill('#dirAreaImportance', '5'); H.fill('#dirAreaTarget', '10');
    H.click('#dirAreaSave');
    await H.waitFor(() => H.s().lifeAreas.length === 1, 'ensimmäinen alue');
    await H.idle('#dirAreaSave', 'ensimmäinen tallennus valmis');
    H.click('#dirAddArea');
    H.fill('#dirAreaName', 'Työ'); H.fill('#dirAreaImportance', '3'); H.fill('#dirAreaTarget', '10'); H.fill('#dirAreaCategory', 'tyo');
    H.click('#dirAreaSave');
    await H.waitFor(() => H.s().lifeAreas.length === 2, 'toinen alue');
    await H.idle('#dirAreaSave', 'toinen tallennus valmis');
    H.fill('#dirCapacityHours', '20'); H.fill('#dirEnergyBudget', '2');
    H.click('#dirCapacitySave');
    await H.waitFor(() => H.s().weeklyCapacities.length === 1, 'kapasiteetti');
    await H.idle('#dirCapacitySave', 'kapasiteetin tallennus valmis');
    const areas = H.text('#dirAreasList');
    const cap = H.s().weeklyCapacities[0];
    if (!areas.includes('Perhe') || !areas.includes('Erittäin tärkeä')) throw new Error('alue ei näy');
    if (cap.availableMinutes !== 1200 || cap.energyBudgetMinutes !== 120) throw new Error('kapasiteetti ' + JSON.stringify(cap));
    return 'alueet: ' + H.s().lifeAreas.map(a => a.name + ' ' + a.importance).join(', ') + '; kapasiteetti 20 h, kuormittavaa enintään 2 h';
  })()`],

  ['ajastin: käynnistä, 45 min kellossa, pysäytä -> ajastinkirjaus', `(async () => {
    // F6: "Aloita ajanseuranta" kysyy alueen ennen käynnistystä ("Ei aluetta"
    // on yhä sallittu, ja tämä skenaario käyttää sitä kuten ennenkin).
    H.click('#dirStartTimer');
    const chooser = await H.waitFor(() => document.querySelector('#timeLogDialog[open]'), 'aluevalinta');
    if (!chooser.querySelector('#timeLogArea')) throw new Error('aluevalinta puuttuu');
    if (chooser.querySelector('.time-log-preset')) throw new Error('käynnistysdialogissa kirjausvalintoja');
    H.click('#timeLogDialog button[value="timer"]');
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
    // Toinen kehote auki olevan päälle hylätään: ei kahta kuuntelijaa, ei väärää kohdetta.
    const second = await window.__e2e.timeLog.openGeneralLog();
    if (second.action !== 'busy') throw new Error('toinen dialogi avautui: ' + JSON.stringify(second));
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
    // Sääntöversio 3: kirjaukset ovat yhdeltä päivältä, joten toteumaa ei
    // vielä verrata; poikkeama tulee suunnitelmasta (kaikki arvioitu), ja
    // sen otsikko sanoo sen ("vie suunnitelmassa enemmän"), perusta näkyvissä.
    await H.waitFor(() => H.text('#dirSignals').includes('Työ vie suunnitelmassa enemmän kuin halusit'), 'poikkeama');
    if (!H.text('#dirSignals').includes('suunnitelman perusteella')) throw new Error('perusta ei näy');
    return 'havainnot: ' + [...document.querySelectorAll('#dirSignals .dir-signal-title')].map(n => n.textContent).join(' | ');
  })()`],

  // Kortti luetaan Tänään-välilehdeltä, kuten käyttäjä sen näkee (piirto
  // voi rajautua näkyvään välilehteen), ja palataan Suuntaan.
  ['päivän kortti: yksi asia huomattavaksi, syy näkyvissä', `(async () => {
    H.tab('screen-today');
    try {
      await H.waitFor(() => H.el('#screen-today').classList.contains('active')
        && H.text('#todayDirection').includes('Tänään kannattaa huomata'), 'päivän kortti');
      if (!H.html('#todayDirection').includes('Miksi tämä?')) throw new Error('syy puuttuu');
      const count = document.querySelectorAll('#todayDirection .dir-today-observation').length;
      if (count > 3) throw new Error('liikaa havaintoja: ' + count);
      return count + ' havaintoa päivän kortissa';
    } finally {
      H.tab('screen-direction');
      await H.waitFor(() => H.el('#screen-direction').classList.contains('active'), 'takaisin Suuntaan');
    }
  })()`],

  ['selitys: tekoäly oletuksena pois, päällä deterministinen varapolku', `(async () => {
    if (document.querySelector('#dirSignals [data-explain]')) throw new Error('tekoälypainike näkyy, vaikka AI_EXPLAIN_ENABLED = false');
    const explainClient = await import('/src/ai/alignmentExplainClient.js');
    explainClient.setAiExplainEnabledForTests(true);
    try {
      window.__e2e.render();
      const details = H.el('#dirSignals details.dir-why');
      details.open = true;
      H.click('#dirSignals [data-explain]');
      await H.waitFor(() => H.html('#dirSignals').includes('<strong>Selitys:</strong>'), 'selitys');
      if (H.html('#dirSignals').includes('Tekoälyn selitys')) throw new Error('väittää tekoälyä');
    } finally {
      explainClient.setAiExplainEnabledForTests(null);
      window.__e2e.render();
    }
    return 'pois: ei painiketta; päällä ilman tokenia: deterministinen selitys';
  })()`],

  ['viikkokatsaus: pohdinta tallentuu historiaan', `(async () => {
    H.fill('#dirAnswer-most_draining', 'Julkaisu kuormitti');
    H.click('#dirReviewSave');
    await H.waitFor(() => H.text('#dirReviewStatus').includes('Viikkokatsaus tallennettu.'), 'tallennus');
    await H.waitFor(() => H.text('#dirReviewHistory').includes('Vastattuja pohdintakysymyksiä: 1'), 'historia');
    const review = H.s().alignmentReviews[0];
    // Sääntöversio 3 (harvan aineiston rajat); ennen 2.
    if (review.policyVersion !== 3 || review.reflectionAnswers.most_draining !== 'Julkaisu kuormitti') throw new Error(JSON.stringify(review));
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

  // Löydös yön katselmoinnissa: "Muu"-kentässä oli min="1" step="5", jolloin
  // selain hylkäsi 30 min (kelvolliset 1, 6, 11, ... 31) ja esti koko
  // dialogin. Aiempi skenaario käytti pikavalintaa kenttä tyhjänä.
  ['muu-kenttä: kirjoitettu 30 min kelpaa selaimelle ja kirjautuu', `(async () => {
    const before = H.s().timeEntries.length;
    H.click('#dirQuickLog');
    const dialog = await H.waitFor(() => document.querySelector('#timeLogDialog[open]'), 'dialogi auki');
    const tyo = H.s().lifeAreas.find(a => a.name === 'Työ');
    H.fill('#timeLogArea', tyo.id);
    H.fill('#timeLogMinutes', '30');
    const input = document.querySelector('#timeLogMinutes');
    if (!input.checkValidity()) throw new Error('selain hylkää 30 min: ' + input.validationMessage);
    H.click('#timeLogDialog button[value="custom"]');
    await H.waitFor(() => H.s().timeEntries.length === before + 1, 'kirjaus muu-kentästä');
    const entry = H.s().timeEntries[H.s().timeEntries.length - 1];
    if (entry.minutes !== 30 || entry.lifeAreaId !== tyo.id) throw new Error(JSON.stringify(entry));
    if (dialog.open) throw new Error('dialogi jäi auki');
    return '30 min kirjoitettuna kirjautui alueelle Työ; dialogi suljettu';
  })()`],

  // CRIT-04: Enter tekstikentässä lähettää lomakkeen ENSIMMÄISELLÄ submit-
  // painikkeella. Ennen se oli pikavalinta "15 min". Synteettinen
  // KeyboardEvent ei laukaise implisiittistä lähetystä, joten Enter
  // lähetetään oikeana näppäilynä CDP:n kautta.
  ['näppäimistö: Enter "Muu"-kentässä kirjaa kirjoitetun arvon; alkufokus otsikossa', async ({ evaluate, cdp }) => {
    const before = await evaluate(`(async () => {
      H.click('#dirQuickLog');
      await H.waitFor(() => document.querySelector('#timeLogDialog[open]'), 'dialogi auki');
      const focused = document.activeElement && document.activeElement.id;
      if (focused !== 'timeLogTitle') throw new Error('alkufokus: ' + focused);
      H.el('#timeLogMinutes').focus();
      return H.s().timeEntries.length;
    })()`);
    await typeAndEnter(cdp, '25');
    return evaluate(`(async () => {
      await H.waitFor(() => H.s().timeEntries.length === ${before} + 1, 'kirjaus Enterillä');
      const entry = H.s().timeEntries[H.s().timeEntries.length - 1];
      if (entry.minutes !== 25) throw new Error('Enter kirjasi ' + entry.minutes + ' min');
      if (document.querySelector('#timeLogDialog[open]')) throw new Error('dialogi jäi auki');
      return 'Enter kirjasi kirjoitetut 25 min; alkufokus otsikossa, ei pikavalinnassa';
    })()`);
  }],

  ['kaksoisnapautus "Kirjaa aikaa": yksi kirjaus', `(async () => {
    const before = H.s().timeEntries.length;
    H.fill('#dirTimeDate', window.__e2e.todayIso());
    H.fill('#dirTimeMinutes', '20');
    const button = document.querySelector('#dirTimeSave');
    button.click();
    button.click();
    await H.waitFor(() => H.s().timeEntries.length > before, 'kirjaus');
    await new Promise(resolve => setTimeout(resolve, 300));
    const added = H.s().timeEntries.length - before;
    if (added !== 1) throw new Error('kaksoisnapautus loi ' + added + ' kirjausta');
    return 'yksi 20 min kirjaus kahdesta napautuksesta';
  })()`],

  ['kohdistus jälkikäteen (F6): alueeton kirjaus liitetään alueeseen listasta', `(async () => {
    const select = await H.waitFor(() => document.querySelector('#dirTimeList select[data-time-area]'), 'liitä alueeseen');
    const id = select.dataset.timeArea;
    if (!document.querySelector('label[for="' + select.id + '"]')) throw new Error('valinnalla ei nimeä');
    const tyo = H.s().lifeAreas.find(a => a.name === 'Työ');
    const minutes = H.s().timeEntries.find(e => e.id === id).minutes;
    H.fill('#dirTimeList select[data-time-area="' + id + '"]', tyo.id);
    await H.waitFor(() => H.s().timeEntries.find(e => e.id === id).lifeAreaId === tyo.id, 'alue tallentui');
    if (H.s().timeEntries.find(e => e.id === id).minutes !== minutes) throw new Error('minuutit muuttuivat');
    return minutes + ' min kirjaus liitettiin alueeseen Työ';
  })()`],

  ['arviojono (F4): yksi kortti, seuraava herää viiveellä, ohitus ei kirjoita', `(async () => {
    const today = window.__e2e.todayIso();
    window.__e2e.setTasks([...H.s().tasks,
      { id: 'q1', title: 'Arvioitava yksi', date: today, category: 'tyo' },
      { id: 'q2', title: 'Arvioitava kaksi', date: today, category: 'tyo' }]);
    H.click('#dirOpenEstimate');
    await H.waitFor(() => document.querySelector('#dirEstimate [data-queue-card="task:q1"]'), 'kortti q1');
    if (document.querySelectorAll('#dirEstimate [data-queue-card]').length !== 1) throw new Error('useampi kortti');
    H.click('#dirEstimate [data-queue-estimate="task:q1"][data-minutes="30"]');
    await H.waitFor(() => H.s().tasks.find(t => t.id === 'q1').durationMinutes === 30, 'arvio tallentui');
    await H.waitFor(() => document.querySelector('#dirEstimate [data-queue-card="task:q2"]'), 'kortti q2');
    const early = document.querySelector('#dirEstimate [data-queue-estimate="task:q2"][data-minutes="10"]');
    if (!early.disabled) throw new Error('seuraava kortti heti napautettavissa (kaksoisnapautus)');
    await H.waitFor(() => !document.querySelector('#dirEstimate [data-queue-estimate="task:q2"][data-minutes="10"]').disabled, 'kortti herää');
    H.click('#dirEstimate [data-queue-skip="task:q2"]');
    await H.waitFor(() => H.text('#dirEstimate').includes('Jonon asiat on käyty läpi'), 'jono läpi');
    if (H.s().tasks.find(t => t.id === 'q2').durationMinutes !== null) throw new Error('ohitus kirjoitti');
    H.click('#dirEstimate [data-queue-finish]');
    await H.waitFor(() => H.el('#dirEstimateSection').hidden, 'osio kiinni');
    return 'q1 = 30 min, q2 ohitettu kirjoittamatta; seuraavan kortin painikkeet heräsivät viiveellä';
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
  // F6: käynnistys kysyy alueen ensin; dialogin leveys tarkistetaan samalla.
  H.click('#dirStartTimer');
  const chooser = await H.waitFor(() => document.querySelector('#timeLogDialog[open]'), 'aluevalinta');
  if (Math.round(chooser.getBoundingClientRect().width) > window.innerWidth) throw new Error('aluevalinta ei mahdu');
  H.click('#timeLogDialog button[value="timer"]');
  await H.waitFor(() => !H.el('#timerBar').hidden, 'ajastin');
  await H.waitFor(() => !document.querySelector('#timeLogDialog[open]'), 'aluevalinta kiinni');
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

const MOBILE_SCENARIO = ['mobiili 360 px: ei vaakavieritystä, dialogi mahtuu', async ({ evaluate, cdp }) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 3, mobile: true });
  return evaluate(MOBILE);
}];

/** Kirjoita teksti fokusoituun kenttään ja paina Enter oikeina näppäilyinä. */
async function typeAndEnter(cdp, text) {
  if (text) await cdp.send('Input.insertText', { text });
  const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...enter });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
}

// =====================================================================
// VANHA KÄYTTÄJÄ (J-portit): 36 tehtävää ilman kestoa, 1 tavoite,
// 1 projekti, ei alueita. Kanta: tools/e2e/seeds.mjs legacyUserSeed.
// Kello: tämän viikon keskiviikko klo 10 (viikonpäivä ei vaihtele ajosta
// toiseen). Skenaariot jatkavat samaa istuntoa järjestyksessä.
// =====================================================================

const LEGACY_WRITE_TABLES = ['tasks', 'goals', 'projects', 'life_areas', 'weekly_capacities', 'time_entries',
  'alignment_reviews', 'alignment_item_settings', 'running_timers'];

const LEGACY_SCENARIOS = [
  ['legacy: 36 tehtävää ilman kestoa, 1 tavoite, 1 projekti, ei alueita: Suunta avautuu aloitukseen, '
    + 'vanha data kuitataan, ei huomiotta jäämis- eikä poikkeamaväitteitä, ei automaattisia kirjoituksia', `(async () => {
    const e = window.__e2e;
    if (e.gates.mode !== 'J' || !e.gates.tables.lifeAreas || !e.gates.columns.ALIGNMENT_REALITY_FIELDS) throw new Error('ei J-portteja: ' + JSON.stringify(e.gates));
    const s = H.s();
    // Siemen tuli OIKEAN latauksen kautta (loadUserData), ei tilaan käsin.
    if (s.tasks.length !== 36 || s.tasks.some(t => t.durationMinutes != null || t.completed)) throw new Error('tehtävät: ' + s.tasks.length);
    if (s.goals.length !== 1 || s.projects.length !== 1 || s.projects[0].goalId !== s.goals[0].id) throw new Error('tavoite/projekti');
    if (s.lifeAreas.length !== 0 || !s.profileExists) throw new Error('alueita tai profiili puuttuu');
    // Ensikäytön opastus tälle käyttäjälle tällä laitteella: suljetaan omalla painikkeellaan.
    await H.waitFor(() => H.el('#onboarding').getAttribute('aria-hidden') === 'false', 'ensikäytön opastus');
    H.click('#onboardingSkip');
    H.tab('screen-direction');
    await H.waitFor(() => H.el('#screen-direction').classList.contains('active'), 'Suunta auki');
    const setup = H.el('#dirSetup');
    if (setup.hidden || !H.text('#dirSetup').includes('1/7')) throw new Error('aloitus ei näy');
    if (setup.querySelector('[data-setup="skip"]')) throw new Error('aluetta voi ohittaa');
    // F9: vanha data kuitataan oikeilla luvuilla (koko Suunnan aluelistassa).
    const legacy = H.text('#dirAreaSuggestions .dir-legacy');
    for (const part of ['36 tehtävää', '1 tavoite', '1 projekti']) {
      if (!legacy.includes(part)) throw new Error('kuittaus ilman "' + part + '": ' + legacy);
    }
    const kinds = e.alignment.analyzeCurrentWeek().signals.map(signal => signal.kind);
    if (kinds.includes(e.SIGNAL.NEGLECT) || kinds.includes(e.SIGNAL.MISALIGNMENT)) throw new Error('väite ilman alueita: ' + kinds);
    if (document.querySelectorAll('#dirSignals .dir-signal, #todayDirection .dir-today-observation').length > 0) throw new Error('havaintoja ilman alueita');
    const all = e.db.writes();
    const writes = all.filter(w => ${JSON.stringify(LEGACY_WRITE_TABLES)}.includes(w.table));
    if (writes.length > 0) throw new Error('automaattinen kirjoitus: ' + JSON.stringify(writes));
    const other = [...new Set(all.map(w => w.table + ':' + w.op))];
    return '36 tehtävää (0 kestollista), 1 tavoite, 1 projekti ladattu; aloitus 1/7; kuittaus: "' + legacy.slice(0, 60) + '…"; '
      + 'havainnot: ' + (kinds.join(', ') || 'ei yhtään') + '; Suunnan ja vanhan datan kirjoituksia 0'
      + (other.length ? ' (muut käynnistyksen kirjoitukset: ' + other.join(', ') + ')' : ', ei muitakaan kirjoituksia');
  })()`],

  ['legacy: elämänalue omalla tärkeydellä (ei esivalintaa, kategoria ei kytkeydy hiljaa) -> kantaan', `(async () => {
    H.click('#dirSetup [data-setup-draft="Terveys"]');
    H.click('#dirSetup [data-setup="to-importance"]');
    await H.waitFor(() => H.text('#dirSetup').includes('2/7'), 'vaihe 2');
    if (document.querySelector('#dirSetup input[type="radio"]:checked')) throw new Error('tärkeys valittu valmiiksi');
    const category = document.querySelector('#dirSetup [data-setup-category="0"]');
    if (!category || category.checked) throw new Error('kategorian kytkentä puuttuu tai on valittu valmiiksi');
    if (!H.el('#dirSetup [data-setup="save-areas"]').disabled) throw new Error('tallennus sallittu ilman tärkeyttä');
    H.click('#dirSetup input[data-setup-importance="0"][value="4"]');
    await H.waitFor(() => !H.el('#dirSetup [data-setup="save-areas"]').disabled, 'tallennus sallittu');
    H.click('#dirSetup [data-setup="save-areas"]');
    await H.waitFor(() => H.db('life_areas').length === 1 && H.s().lifeAreas.length === 1, 'alue kannassa');
    await H.waitFor(() => H.text('#dirSetup').includes('3/7'), 'vaihe 3');
    const row = H.db('life_areas')[0];
    if (row.name !== 'Terveys' || row.importance !== 4 || row.category_key !== null) throw new Error(JSON.stringify(row));
    const touched = window.__e2e.db.writes().filter(w => ['tasks', 'goals', 'projects'].includes(w.table));
    if (touched.length) throw new Error('alue kirjoitti vanhaan dataan: ' + JSON.stringify(touched));
    return 'life_areas: Terveys, tärkeys 4 (valittu itse), category_key null; tehtäviin ja tavoitteisiin ei kirjoitettu';
  })()`],

  ['legacy: kapasiteetti (vaihe 4, ei oletusarvoa) -> kantaan', `(async () => {
    H.click('#dirSetup [data-setup="skip"]');
    await H.waitFor(() => document.querySelector('#dirSetupCapacity'), 'kapasiteettivaihe');
    if (H.el('#dirSetupCapacity').value !== '') throw new Error('kapasiteetilla oletus: ' + H.el('#dirSetupCapacity').value);
    H.fill('#dirSetupCapacity', '20');
    H.click('#dirSetup [data-setup="save-capacity"]');
    await H.waitFor(() => H.db('weekly_capacities').length === 1, 'kapasiteetti kannassa');
    const row = H.db('weekly_capacities')[0];
    if (row.available_minutes !== 1200 || row.week_start !== window.__e2e.seed.monday) throw new Error(JSON.stringify(row));
    return 'weekly_capacities: ' + row.week_start + ' 1200 min (tavoitevaihe ohitettu itse)';
  })()`],

  ['legacy: vanha tavoite liitetään alueeseen (vaihe 5), kuittaus luvuin -> goals.life_area_id kantaan', `(async () => {
    const goalId = window.__e2e.seed.goalId;
    const select = await H.waitFor(() => document.querySelector('#dirSetup [data-setup-goal="' + goalId + '"]'), 'tavoitevaihe');
    const hint = H.text('#dirSetupLegacy');
    for (const part of ['36 tehtävää', '1 tavoite', '1 projekti']) {
      if (!hint.includes(part)) throw new Error('vaiheen 5 kuittaus ilman "' + part + '": ' + hint);
    }
    if (select.value !== '') throw new Error('tavoitteelle valittu alue valmiiksi');
    const area = H.s().lifeAreas[0];
    H.fill('#dirSetup [data-setup-goal="' + goalId + '"]', area.id);
    await H.waitFor(() => H.db('goals')[0].life_area_id === area.id, 'tavoitteen alue kannassa');
    const project = H.db('projects')[0];
    if (project.goal_id !== goalId) throw new Error('projektin liitos muuttui');
    H.click('#dirSetup [data-setup="finish-step"]');
    await H.waitFor(() => H.text('#dirSetup').includes('6/7'), 'vaihe 6');
    return 'goals.life_area_id = Terveys; projekti seuraa tavoitettaan (goal_id ennallaan)';
  })()`],

  ['legacy: arviojono (vaihe 6): yksi tämän viikon tehtävä arvioidaan -> duration_minutes kantaan', `(async () => {
    const card = await H.waitFor(() => document.querySelector('#dirSetup [data-queue-card]'), 'arviokortti');
    if (document.querySelectorAll('#dirSetup [data-queue-card]').length !== 1) throw new Error('useampi kortti');
    const key = card.dataset.queueCard;
    const id = key.replace(/^task:/, '');
    await H.waitFor(() => !document.querySelector('#dirSetup [data-queue-estimate="' + key + '"][data-minutes="30"]').disabled, 'kortti valmis');
    H.click('#dirSetup [data-queue-estimate="' + key + '"][data-minutes="30"]');
    await H.waitFor(() => (H.db('tasks').find(t => t.id === id) || {}).duration_minutes === 30, 'arvio kannassa');
    const others = H.db('tasks').filter(t => t.id !== id && t.duration_minutes !== null);
    if (others.length) throw new Error('muita arvioita: ' + others.length);
    window.__e2eEstimated = id;
    H.click('#dirSetup [data-setup="finish-step"]');
    await H.waitFor(() => H.text('#dirSetup').includes('7/7'), 'vaihe 7');
    return 'tasks ' + id + ': duration_minutes 30; muut 35 ennallaan';
  })()`],

  ['legacy: ajastin alueelle (vaihe 7) -> running_timers-rivi kantaan, aloitus valmis', `(async () => {
    const area = H.s().lifeAreas[0];
    H.fill('#dirSetupTimerArea', area.id);
    await H.waitFor(() => !H.el('#dirSetup [data-setup="start-timer"]').disabled, 'käynnistyspainike');
    H.click('#dirSetup [data-setup="start-timer"]');
    await H.waitFor(() => !H.el('#timerBar').hidden && document.querySelector('#timerBar [data-timer="stop"]'), 'ajastinpalkki');
    await H.waitFor(() => H.db('running_timers').length === 1, 'ajastin kannassa');
    const row = H.db('running_timers')[0];
    if (row.life_area_id !== area.id) throw new Error(JSON.stringify(row));
    await H.waitFor(() => !H.el('#screen-direction').classList.contains('dir-setup-active'), 'aloitus valmis, koko Suunta näkyvissä');
    // Kello eteen ennen uudelleenlatausta: kulunut aika ei saa kadota.
    window.__e2e.advance(25 * 60 * 1000);
    return 'running_timers: 1 rivi (Terveys); aloitus valmis; kello +25 min';
  })()`],

  ['legacy: uudelleenlataus: ajastin yhä käynnissä, alue, kapasiteetti, tavoitteen alue ja arvio säilyvät, opastus ei palaa', async ({ evaluate, reload }) => {
    const before = await evaluate(`({ timer: H.s().runningTimers[0], estimated: window.__e2eEstimated })`);
    await reload();
    return evaluate(`(async () => {
      const s = H.s();
      const timer = s.runningTimers[0];
      if (!timer || timer.id !== ${JSON.stringify(before.timer.id)} || timer.startedAt !== ${JSON.stringify(before.timer.startedAt)}) throw new Error('ajastin: ' + JSON.stringify(timer));
      await H.waitFor(() => !H.el('#timerBar').hidden && document.querySelector('#timerBar [data-timer="stop"]'), 'ajastinpalkki');
      if (!/0:2[5-9]/.test(H.text('#timerBar'))) throw new Error('kulunut aika: ' + H.text('#timerBar'));
      if (s.lifeAreas.length !== 1 || s.lifeAreas[0].importance !== 4) throw new Error('alue');
      if (s.weeklyCapacities.length !== 1 || s.weeklyCapacities[0].availableMinutes !== 1200) throw new Error('kapasiteetti');
      if (s.goals[0].lifeAreaId !== s.lifeAreas[0].id) throw new Error('tavoitteen alue katosi');
      const estimated = s.tasks.find(t => t.id === ${JSON.stringify(before.estimated)});
      if (!estimated || estimated.durationMinutes !== 30) throw new Error('arvio katosi');
      if (H.el('#onboarding').getAttribute('aria-hidden') !== 'true') throw new Error('opastus palasi');
      if (!H.el('#screen-direction').classList.contains('active')) throw new Error('viimeisin näkymä ei palautunut');
      return 'sama ajastin (' + H.text('#timerBar .timer-elapsed') + '), alue, 20 h, tavoitteen alue ja 30 min arvio tallessa; opastus ei palannut';
    })()`);
  }],

  ['legacy: toinen laite: ajastin palautuu kannasta, kun laitteen kopio puuttuu', async ({ evaluate, reload }) => {
    const id = await evaluate(`(() => {
      const timer = H.s().runningTimers[0];
      localStorage.removeItem('manifestival.timer.v1.' + window.__e2e.userId());
      return timer.id;
    })()`);
    await reload();
    return evaluate(`(async () => {
      await H.waitFor(() => H.s().runningTimers[0] && !H.el('#timerBar').hidden, 'ajastin kannasta');
      if (H.s().runningTimers[0].id !== ${JSON.stringify(id)}) throw new Error('eri ajastin');
      if (!localStorage.getItem('manifestival.timer.v1.' + window.__e2e.userId())) throw new Error('laitteen kopio ei palautunut');
      return 'running_timers-rivi palautti saman ajastimen ja laitteen kopion';
    })()`);
  }],

  ['legacy: pysäytys: toteuma kirjautuu kerran kantaan, Suunta päivittyy', `(async () => {
    const area = H.s().lifeAreas[0];
    const rowBefore = window.__e2e.alignment.analyzeCurrentWeek().areas.find(r => r.id === area.id);
    if (rowBefore.actualMinutes !== 0) throw new Error('toteuma ennen pysäytystä ' + rowBefore.actualMinutes);
    const listBefore = H.text('#dirAreasList');
    window.__e2e.advance(15 * 60 * 1000);
    const shown = H.text('#timerBar .timer-elapsed');
    H.click('#timerBar [data-timer="stop"]');
    await H.waitFor(() => H.db('time_entries').length === 1 && H.db('running_timers').length === 0, 'kirjaus kannassa, ajastin pois');
    await H.waitFor(() => H.el('#timerBar').hidden, 'palkki piiloon');
    const entry = H.db('time_entries')[0];
    if (entry.minutes < 40 || entry.minutes > 41 || entry.source !== 'timer' || entry.life_area_id !== area.id) throw new Error(JSON.stringify(entry));
    if (!entry.operation_id || !entry.started_at || !entry.ended_at) throw new Error('0013-sarakkeet puuttuvat: ' + JSON.stringify(entry));
    if (H.s().timeEntries.length !== 1) throw new Error('tilassa ' + H.s().timeEntries.length + ' kirjausta');
    const analysis = window.__e2e.alignment.analyzeCurrentWeek();
    const row = analysis.areas.find(r => r.id === area.id);
    if (row.actualMinutes !== entry.minutes) throw new Error('Suunnan toteuma ' + row.actualMinutes);
    await H.waitFor(() => H.text('#dirAreasList') !== listBefore, 'aluelista päivittyi');
    const kinds = analysis.signals.map(signal => signal.kind);
    if (kinds.includes(window.__e2e.SIGNAL.NEGLECT)) throw new Error('ensimmäisen viikon kirjaus teki alueesta huomiotta jäävän');
    return 'time_entries: ' + entry.minutes + ' min (palkki ' + shown + '), lähde timer, 1 rivi; Suunnan toteuma ' + row.actualMinutes
      + ' min; havainnot: ' + (kinds.join(', ') || 'ei yhtään');
  })()`],

  ['legacy: tehtävä liitetään tavoitteeseen lomakkeella, liitos säilyy uudelleenlatauksessa (F1)', async ({ evaluate, reload }) => {
    const taskId = await evaluate(`(async () => {
      const goalId = window.__e2e.seed.goalId;
      const monday = window.__e2e.seed.monday;
      const task = H.s().tasks.find(t => t.date >= monday && t.durationMinutes == null && !t.goalId);
      H.tab('screen-tasks');
      const edit = await H.waitFor(() => document.querySelector('#screen-tasks [data-edit="' + task.id + '"]'), 'tehtävä listassa');
      edit.click();
      await H.waitFor(() => !H.el('#addForm').hidden && getComputedStyle(H.el('#addForm')).display !== 'none', 'lomake auki');
      H.fill('#afGoal', goalId);
      H.click('#afSave');
      await H.waitFor(() => (H.db('tasks').find(t => t.id === task.id) || {}).goal_id === goalId, 'goal_id kannassa');
      await H.idle('#afSave', 'tallennus valmis');
      return task.id;
    })()`);
    await reload();
    return evaluate(`(async () => {
      const goalId = window.__e2e.seed.goalId;
      const task = H.s().tasks.find(t => t.id === ${JSON.stringify(taskId)});
      if (!task || task.goalId !== goalId) throw new Error('liitos katosi: ' + JSON.stringify(task && task.goalId));
      const area = H.s().lifeAreas[0];
      const row = window.__e2e.alignment.analyzeCurrentWeek().areas.find(r => r.id === area.id);
      if (!(row.plannedUnknown > 0 || row.plannedMinutes > 0)) throw new Error('tehtävä ei näy alueen luvuissa: ' + JSON.stringify(row));
      H.tab('screen-direction');
      await H.waitFor(() => H.el('#screen-direction').classList.contains('active'), 'Suunta');
      return 'tasks.goal_id säilyi; alueen suunnitelmassa ' + row.plannedMinutes + ' min + ' + row.plannedUnknown + ' arvioimatonta';
    })()`);
  }],

  ['legacy: viikkokatsaus tallentuu kantaan ja historiaan', `(async () => {
    H.fill('#dirAnswer-most_draining', 'Vanhat rästit painoivat');
    H.click('#dirReviewSave');
    await H.waitFor(() => H.db('alignment_reviews').length === 1, 'katsaus kannassa');
    const row = H.db('alignment_reviews')[0];
    if (row.week_start !== window.__e2e.seed.monday || (row.reflection_answers || {}).most_draining !== 'Vanhat rästit painoivat') throw new Error(JSON.stringify(row));
    if (row.policy_version !== 3) throw new Error('sääntöversio ' + row.policy_version);
    await H.waitFor(() => H.text('#dirReviewHistory').trim() !== '', 'historia');
    return 'alignment_reviews: ' + row.week_start + ', sääntöversio ' + row.policy_version + ', pohdinta tallessa';
  })()`],

  ['legacy: ensi viikon esikatselu ei kirjoita; vahvistettu muutos kantaan', `(async () => {
    const box = await H.waitFor(() => document.querySelector('#dirProposals input[data-adjust-select]'), 'ehdotus');
    const id = box.dataset.adjustSelect;
    box.click();
    const writesBefore = window.__e2e.db.writes().length;
    H.click('#dirPreviewSelected');
    await H.waitFor(() => H.html('#dirProposalPreview').includes('<caption>'), 'esikatselu');
    await H.waitFor(() => !H.el('#dirApplySelected').disabled, 'vahvistuspainike');
    H.click('#dirApplySelected');
    await H.waitFor(() => document.querySelector('#confirmDialog[open]'), 'vahvistusdialogi');
    if (window.__e2e.db.writes().length !== writesBefore) throw new Error('esikatselu tai dialogi kirjoitti kantaan');
    H.click('#confirmAccept');
    await H.waitFor(() => window.__e2e.db.writes().length > writesBefore, 'muutos kantaan');
    const written = window.__e2e.db.writes().slice(writesBefore).map(w => w.table + ':' + w.op);
    return 'vahvistettu ' + id + ' -> ' + written.join(', ');
  })()`],

  ['legacy: näppäimistö: Enter "Muu"-kentässä kirjaa kirjoitetut minuutit kantaan', async ({ evaluate, cdp }) => {
    const before = await evaluate(`(async () => {
      H.click('#dirQuickLog');
      await H.waitFor(() => document.querySelector('#timeLogDialog[open]'), 'dialogi auki');
      H.fill('#timeLogArea', H.s().lifeAreas[0].id);
      H.el('#timeLogMinutes').focus();
      return H.db('time_entries').length;
    })()`);
    await typeAndEnter(cdp, '25');
    return evaluate(`(async () => {
      await H.waitFor(() => H.db('time_entries').length === ${before} + 1, 'kirjaus kannassa');
      const row = H.db('time_entries').find(r => r.source === 'manual' && r.minutes === 25);
      if (!row) throw new Error('Enter kirjasi: ' + JSON.stringify(H.db('time_entries').map(r => r.minutes)));
      if (document.querySelector('#timeLogDialog[open]')) throw new Error('dialogi jäi auki');
      return 'Enter kirjasi 25 min (ei pikavalintaa 15 min) alueelle ' + H.s().lifeAreas[0].name;
    })()`);
  }],

  { name: 'legacy: offline: jonossa oleva kirjaus näkyy uudelleenlatauksen jälkeen ja lähtee kerran, kun yhteys palaa',
    // Offline-lataus kirjaa jokaisen epäonnistuneen kokoelman konsoliin (logError):
    // odotettua tässä skenaariossa.
    allowConsoleErrors: true,
    run: async ({ evaluate, reload }) => {
      const queued = await evaluate(`(async () => {
        const rowsBefore = H.db('time_entries').length;
        window.__e2e.setOffline(true);
        H.click('#dirQuickLog');
        await H.waitFor(() => document.querySelector('#timeLogDialog[open]'), 'dialogi auki');
        H.fill('#timeLogArea', H.s().lifeAreas[0].id);
        H.fill('#timeLogMinutes', '10');
        H.click('#timeLogDialog button[value="custom"]');
        await H.waitFor(() => window.__e2e.alignment.pendingTimeEntryCount() === 1, 'kirjaus lähtökorissa');
        if (H.db('time_entries').length !== rowsBefore) throw new Error('offline-kirjaus meni kantaan');
        const entry = H.s().timeEntries.find(e => e.minutes === 10);
        if (!entry) throw new Error('kirjaus ei näy');
        return { id: entry.id, operationId: entry.operationId, rowsBefore };
      })()`);
      await reload();
      return evaluate(`(async () => {
        if (navigator.onLine !== false) throw new Error('uudelleenlataus ei ollut offline');
        const visible = H.s().timeEntries.filter(e => e.operationId === ${JSON.stringify(queued.operationId)});
        if (visible.length !== 1) throw new Error('offline-latauksen jälkeen näkyy ' + visible.length + ' kpl');
        if (window.__e2e.alignment.pendingTimeEntryCount() !== 1) throw new Error('lähtökori tyhjeni');
        if (!document.querySelector('#dirTimeList [data-time-delete="' + visible[0].id + '"]')) throw new Error('kirjaus ei näy Toteuma-listassa');
        window.__e2e.setOffline(false);
        await H.waitFor(() => H.db('time_entries').filter(r => r.operation_id === ${JSON.stringify(queued.operationId)}).length === 1
          && window.__e2e.alignment.pendingTimeEntryCount() === 0, 'lähetys yhteyden palattua', 10000);
        await H.sleep(300);
        const rows = H.db('time_entries').filter(r => r.operation_id === ${JSON.stringify(queued.operationId)});
        const shown = H.s().timeEntries.filter(e => e.operationId === ${JSON.stringify(queued.operationId)});
        if (rows.length !== 1 || shown.length !== 1) throw new Error('kannassa ' + rows.length + ', näkyvissä ' + shown.length);
        return '10 min lähtökorissa -> näkyi offline-latauksen jälkeen -> yhteyden palattua kannassa kerran ja näkyvissä kerran';
      })()`);
    } },

  // CRIT-03: ajastinpalkin uudelleenpiirto (innerHTML) hävitti fokuksen.
  // Korjaus kuuluu saavutettavuuspakettiin (timeLog.js renderTimerBar):
  // ks. PENDING_ON.
  ['legacy: näppäimistö: Tauko pitää fokuksen ajastinpalkissa', async ({ evaluate, cdp }) => {
    await evaluate(`(async () => {
      if (H.s().runningTimers.length === 0) {
        H.click('#dirStartTimer');
        await H.waitFor(() => document.querySelector('#timeLogDialog[open]'), 'aluevalinta');
        H.click('#timeLogDialog button[value="timer"]');
      }
      const pause = await H.waitFor(() => document.querySelector('#timerBar [data-timer="pause"]'), 'Tauko');
      pause.focus();
      if (document.activeElement !== pause) throw new Error('Tauko ei saa fokusta');
      return true;
    })()`);
    await typeAndEnter(cdp, '');
    return evaluate(`(async () => {
      await H.waitFor(() => H.s().runningTimers[0] && H.s().runningTimers[0].pausedAt, 'tauolla');
      await H.waitFor(() => document.querySelector('#timerBar [data-timer="resume"]'), 'Jatka');
      await H.sleep(100);
      const active = document.activeElement;
      if (!active || !H.el('#timerBar').contains(active) || !active.matches('[data-timer="resume"], [data-timer="pause"]')) {
        const where = !active ? 'ei mitään' : active === document.body ? 'body (fokus katosi)'
          : active.tagName + (active.id ? '#' + active.id : '') + ' ' + (active.textContent || '').trim().slice(0, 20);
        throw new Error('fokus: ' + where);
      }
      return 'Enter Tauko-painikkeella: tauolla, fokus "' + active.textContent.trim() + '"-painikkeessa';
    })()`);
  }]
];

/**
 * Skenaariot, joiden korjaus tulee rinnakkaisesta paketista. Epäonnistuminen
 * raportoidaan ODOTTAA-rivinä eikä kaada ajoa; onnistuminen kaataa, jotta
 * merkintä poistetaan heti integraation jälkeen.
 */
// Tyhjä: saavutettavuuspaketti (renderTimerBar, CRIT-03) on integroitu, ja
// Tauko-fokus-skenaario on tavallinen, kaatava skenaario.
const PENDING_ON = Object.freeze({});

const OPEN_DIRECTION = `(async () => {
  H.tab('screen-direction');
  await H.waitFor(() => H.el('#screen-direction').classList.contains('active'), 'Suunta auki');
  return true;
})()`;

/** Tämän viikon keskiviikko klo 10 paikallista aikaa (legacy-ryhmän kello). */
function wednesdayTen(now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
  const weekday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - weekday + 2);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:00`;
}

const GROUPS = [
  { key: 'closed', label: 'suljetut portit', query: { gates: 'closed', seed: 'empty', onboarding: 'skip' },
    setup: OPEN_DIRECTION, scenarios: [...SCENARIOS, MOBILE_SCENARIO] },
  { key: 'J', label: 'J-portit', query: { gates: 'J', seed: 'empty', onboarding: 'skip' },
    setup: OPEN_DIRECTION, scenarios: [...SCENARIOS, MOBILE_SCENARIO] },
  { key: 'legacy', label: 'J-portit, vanha käyttäjä', query: { gates: 'J', seed: 'legacy', clock: wednesdayTen() },
    setup: null, scenarios: LEGACY_SCENARIOS }
];

function normalizeScenario(entry) {
  if (Array.isArray(entry)) return { name: entry[0], run: entry[1], allowConsoleErrors: false };
  return { allowConsoleErrors: false, ...entry };
}

async function main() {
  const chrome = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!chrome) throw new Error('Chromea ei löytynyt; aseta CHROME_PATH');

  const wanted = (process.env.E2E_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean);
  const groups = GROUPS.filter(group => wanted.length === 0 || wanted.includes(group.key));
  const schemaSource = fs.readFileSync(path.join(ROOT, 'src/data/schema.js'), 'utf8');
  // J-portit ratkaistaan vain, jos jokin valittu ryhmä tarvitsee niitä: pelkkä
  // suljettujen porttien ajo ei kaadu J-ehdokkaan ja junan eroon.
  const needsJ = groups.some(group => group.query.gates === 'J');
  const jGates = needsJ ? resolveGateMode('J', { cwd: ROOT, schemaSource }) : { source: null, provenance: 'ei tarvita' };
  console.log(`J-portit: ${jGates.provenance}`);

  const httpPort = await freePort();
  const debugPort = await freePort();
  if (await cdpReachable(debugPort)) throw new Error(`debug-portti ${debugPort} on jo käytössä — ei liitytä vieraaseen prosessiin`);

  const server = await startServer(httpPort, { gatedSchema: jGates.source });
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
  let allowConsole = false;
  let allowedConsole = 0;
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
      // Poikkeus ei ole koskaan odotettu, konsolin virherivi vain luvallisessa skenaariossa.
      if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        if (allowConsole) allowedConsole += 1;
        else consoleErrors.push(message.params.args.map(a => a.value || a.description).join(' '));
      }
    });
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const evaluate = async expression => {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      }
      return response.result.value;
    };

    // Käynnistys (ensimmäinen lataus tai uudelleenlataus) on valmis, kun
    // valjas on nähnyt kirjautumisen ja latauksen loppuun (harness.mjs boot).
    const waitReady = async label => {
      for (let i = 0; i < 150; i++) {
        await new Promise(r => setTimeout(r, 100));
        const ready = await evaluate('Boolean(window.__e2e && window.__e2e.ready && !window.__e2eUnloading) || (window.__e2eErrors || []).length > 0')
          .catch(() => false);
        if (ready) break;
      }
      const bootErrors = await evaluate('window.__e2eErrors || []').catch(() => ['ei vastausta']);
      if (bootErrors.length) throw new Error(`${label}: käynnistysvirhe: ${bootErrors.join('; ')}`);
      if (!(await evaluate('Boolean(window.__e2e && window.__e2e.ready)').catch(() => false))) throw new Error(`${label}: valjas ei käynnistynyt`);
      await evaluate(HELPERS);
    };
    // Vanha sivu merkitään ennen latausta: odotus ei saa lukea sen
    // valmiutta tai virheitä ennen kuin uusi sivu on vaihtunut tilalle.
    const leavePage = () => evaluate('window.__e2eUnloading = true; window.__e2eErrors = []; true').catch(() => false);
    const reload = async () => {
      await leavePage();
      await cdp.send('Page.reload', {});
      await waitReady('uudelleenlataus');
    };

    for (const group of groups) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
      const query = new URLSearchParams({ reset: '1', ...group.query });
      await leavePage();
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/?${query}` });
      try {
        await waitReady(group.label);
        if (group.setup) await evaluate(group.setup);
      } catch (error) {
        results.push({ name: `[${group.label}] käynnistys`, ok: false, detail: error.message.split('\n')[0] });
        continue;
      }
      if (group.query.clock) console.log(`[${group.label}] kello: ${group.query.clock}`);

      for (const scenario of group.scenarios.map(normalizeScenario)) {
        const name = `[${group.label}] ${scenario.name}`;
        allowConsole = scenario.allowConsoleErrors;
        try {
          // Funktio-skenaario tarvitsee CDP:tä (oikeat näppäilyt, uudelleenlataus); muut ajetaan sivulla.
          const detail = typeof scenario.run === 'function' ? await scenario.run({ evaluate, cdp, reload }) : await evaluate(scenario.run);
          results.push({ name, ok: true, detail, pendingOn: PENDING_ON[scenario.name] });
        } catch (error) {
          results.push({ name, ok: false, detail: error.message.split('\n')[0], pendingOn: PENDING_ON[scenario.name] });
        } finally {
          allowConsole = false;
        }
      }
      const unsupported = await evaluate('window.__e2e ? window.__e2e.db.unsupported() : []').catch(() => []);
      results.push({ name: `[${group.label}] kannan korvike tuki jokaisen kyselyn`, ok: unsupported.length === 0,
        detail: unsupported.length ? unsupported.join(', ') : 'ei tukemattomia kyselyjä' });
    }
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    server.close();
    await new Promise(r => setTimeout(r, 500));
    // Windows voi pitää profiilin tiedostoja hetken lukossa Chromen sulkeuduttua.
    // Siivouksen epäonnistuminen ei saa peittää varsinaista tulosta (EPERM).
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      console.warn(`HUOM  väliaikaisprofiilia ei voitu poistaa (${error.code}); poista käsin: ${path.relative(ROOT, profile)}`);
    }
  }

  const forbidden = requests.filter(url => /supabase\.co|anthropic\.com/.test(url));
  results.push({ name: 'ei yhtään pyyntöä tuotantoon (Supabase/Anthropic)', ok: forbidden.length === 0,
    detail: forbidden.length ? forbidden.join(', ') : `${requests.length} pyyntöä, kaikki paikallisia` });
  results.push({ name: 'ei konsolivirheitä', ok: consoleErrors.length === 0,
    detail: consoleErrors.slice(0, 3).join(' | ') || `ei virheitä${allowedConsole ? ` (offline-skenaarion odotetut latausvirheet: ${allowedConsole})` : ''}` });

  let failed = 0;
  let pending = 0;
  for (const result of results) {
    let label = result.ok ? 'PASS' : 'FAIL';
    let detail = result.detail;
    if (result.pendingOn && !result.ok) {
      label = 'ODOTTAA';
      detail = `${detail}\n      (korjaus: ${result.pendingOn})`;
      pending += 1;
    } else if (result.pendingOn && result.ok) {
      label = 'FAIL';
      detail = `${detail}\n      (onnistui: poista PENDING_ON-merkintä, korjaus ${result.pendingOn} on integroitu)`;
    }
    if (label === 'FAIL') failed += 1;
    console.log(`${label}  ${result.name}\n      ${detail}`);
  }
  const passed = results.length - failed - pending;
  console.log(`\nSUUNTA E2E: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${results.length}${pending ? `, odottaa ${pending}` : ''})`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(error => {
  console.error('SUUNTA E2E: KESKEYTYI —', error.message);
  process.exitCode = 1;
});
