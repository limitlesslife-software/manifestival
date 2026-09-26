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
// Skenaariot: aloitus (vaihe 1/7, ei mitään ennen tallennusta),
// ensikäyttö (alue, tärkeys, tavoite, kapasiteetti), ajastin (alue
// kysytään, käynnistä, kello eteen, pysäytä), nopea kirjaus dialogista,
// Enter "Muu"-kentässä (oikea näppäily), kirjatun ajan alue jälkikäteen,
// arviojono (yksi kortti, viiveellä heräävä seuraava),
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
  s: () => window.__e2e.state(),
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

  ['päivän kortti: yksi asia huomattavaksi, syy näkyvissä', `(async () => {
    const card = H.text('#todayDirection');
    if (!card.includes('Tänään kannattaa huomata')) throw new Error(card);
    if (!H.html('#todayDirection').includes('Miksi tämä?')) throw new Error('syy puuttuu');
    const count = document.querySelectorAll('#todayDirection .dir-today-observation').length;
    if (count > 3) throw new Error('liikaa havaintoja: ' + count);
    return count + ' havaintoa päivän kortissa';
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
    await cdp.send('Input.insertText', { text: '25' });
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...enter });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
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
        // Funktio-skenaario tarvitsee CDP:tä (oikeat näppäilyt); muut ajetaan sivulla.
        const detail = typeof script === 'function' ? await script({ evaluate, cdp }) : await evaluate(script);
        results.push({ name, ok: true, detail });
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
