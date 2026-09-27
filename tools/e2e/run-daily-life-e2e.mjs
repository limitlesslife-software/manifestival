// Arjen käyttöjärjestelmän E2E: paikallinen selainajo (headless Chrome, CDP).
// EI TUOTANTOA.
//
//   node tools/e2e/run-daily-life-e2e.mjs        kaikki ryhmät (npm run e2e:daily-life)
//   E2E_GROUPS=K node tools/e2e/run-...          vain K-porttien ryhmä
//   E2E_K_GATES_REF=<ref>                        K-porttien lähde, kun K-ehdokas on
//                                                leikattu (oletus: junan määrittely)
//
// TURVASÄÄNNÖT (samat kuin Suunta E2E:ssä, tools/e2e/run-suunta-e2e.mjs):
//   - debug-portti valitaan vapaaksi JA todennetaan vapaaksi ennen
//     käynnistystä; vieraaseen Chromeen ei koskaan liitytä
//   - *.supabase.co ja Anthropic estetään DNS-tasolla
//     (--host-resolver-rules), ja jokainen pyyntö kirjataan: yksikin
//     yritys tuotantoon kaataa ajon. Lisäksi jokainen muu kuin paikallinen
//     pyyntö kaataa ajon. Avaa reitti -linkkiä ei koskaan avata (sen osoite
//     luetaan), ja Googlen nimet on varmuuden vuoksi estetty DNS-tasolla.
//   - profiili on projektin tmp/-hakemistossa ja poistetaan lopuksi;
//     poiston onnistuminen on oma tulosrivinsä
//
// KÄYNNISTYS: sama valjas kuin Suunta E2E:ssä (tools/e2e/harness.mjs):
// oikea src/app/main.js, tekaistu istunto ja tallentava kannan korvike
// (tools/e2e/fakeSupabase.mjs). Uudelleenlataus on oikea Page.reload:
// main.js käynnistyy uudelleen ja loadUserData lukee kannan rivit (0014:n
// time-sarakkeet kannan omassa muodossa HH:MM:SS). Kello on tämän viikon
// keskiviikko klo 10, joten viikonpäivä ja lähtöajat eivät vaihtele.
//
// RYHMÄT (jokainen alkaa tyhjältä laitteelta ja tyhjältä kannalta):
//   closed   haaran omat portit: 0014:n taulut eivät ole käytössä. Arjen
//            näkymät kertovat rehellisesti, että tieto säilyy vain istunnon
//            ajan, kantaan ei kirjoiteta mitään, eikä mikään kaadu
//   K        aallon K portit (tools/e2e/gates.mjs; K-ehdokasta ei vielä
//            ole, joten portit tulevat junan määrittelystä): kalenteri,
//            toisto ja ohitus, kuukausi, puuttuva matka-aika, näppäimistö,
//            Arki, ohjaustyyli, Paikat, Hyvinvointi ja Tänään-kortit.
//            Jokainen todennetaan näkymästä JA kannan riveistä, ja
//            tallennus todennetaan oikean uudelleenlatauksen yli.
//            Skenaariot jatkavat samaa istuntoa järjestyksessä.
//
// ODOTTAA KORJAUSTA (PENDING_ON, sama mekanismi kuin Suunta E2E:ssä):
// skenaario, joka paljastaa sovelluksen vian, on PENDING_ON-listassa vian
// kuvauksen kanssa. Sen epäonnistuminen ei kaada ajoa, mutta onnistuminen
// kaataa ("poista merkintä"): merkintä ei jää unohduksiin korjauksen jälkeen.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveGateMode, GATES_QUERY, harnessHtml } from './gates.mjs';
import { CHROME_CANDIDATES, MIME, freePort, cdpReachable, Cdp, PAGE_HELPERS, pressKey } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS_PAGE = 'tools/e2e/suunta-harness.html';

/** Migraation 0014 taulut (aalto K). Suljetuilla porteilla niihin ei kirjoiteta. */
export const DAILY_LIFE_TABLES = Object.freeze(['saved_places', 'place_aliases', 'calendar_events',
  'commute_observations', 'life_settings', 'sleep_logs', 'habit_plans', 'habit_events',
  'exercise_sessions', 'wellbeing_checkins']);

/** Tuotannon nimet: yksikin pyyntö niihin kaataa ajon. */
const PRODUCTION = /supabase\.co|anthropic\.com/;
/** Paikalliset ja sivun sisäiset osoitteet; kaikki muu on ulkoinen pyyntö. */
const LOCAL = /^(https?:\/\/127\.0\.0\.1:\d+\/|data:|blob:|about:)/;

/**
 * Pyyntöjen tarkastus: tuotantoon yrittäneet, muut ulkoiset ja DNS-tasolla
 * estetyt (ERR_NAME_NOT_RESOLVED). Puhdas funktio (testit).
 *
 * @param {string[]} requests  jokaisen pyynnön osoite (Network.requestWillBeSent)
 * @param {{url: string, errorText: string}[]} [failures]  Network.loadingFailed
 */
export function auditRequests(requests, failures = []) {
  const list = Array.isArray(requests) ? requests : [];
  return {
    total: list.length,
    production: list.filter(url => PRODUCTION.test(url)),
    external: list.filter(url => !LOCAL.test(url)),
    blocked: (failures || []).filter(failure => /ERR_NAME_NOT_RESOLVED/.test(failure.errorText || ''))
      .map(failure => failure.url)
  };
}

/**
 * Tulosrivin luokitus. PENDING_ON-merkitty epäonnistuminen on ODOTTAA (ei
 * kaada ajoa); merkitty onnistuminen on FAIL, jotta merkintä poistetaan.
 */
export function classifyResult({ ok, pendingOn, warn = false }) {
  if (pendingOn && !ok) return 'ODOTTAA';
  if (pendingOn && ok) return 'FAIL';
  if (!ok) return 'FAIL';
  // Onnistunut, mutta varauksin (esim. profiilin poisto siirtyi irralliselle siivoajalle).
  return warn ? 'HUOM' : 'PASS';
}

function startServer(port, { gatedSchemas }) {
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
    const gated = url.searchParams.get(GATES_QUERY);
    if (urlPath === '/src/data/schema.js' && gated) {
      // Porttitila, jota ajo ei ratkaissut: ei hiljaista varapolkua haaran portteihin.
      if (!gatedSchemas[gated]) { res.writeHead(404).end('porttitilaa ei ratkaistu: ' + gated); return; }
      res.writeHead(200, headers(MIME['.js'])).end(gatedSchemas[gated]);
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

/** Tämän viikon keskiviikko klo 10 paikallista aikaa (ryhmien kello). */
export function wednesdayTen(now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
  const weekday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - weekday + 2);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:00`;
}

// =====================================================================
// SIVUN APURIT (window.H laajennettuna arjen näkymille)
// =====================================================================

export const DAILY_HELPERS = `
Object.assign(window.H, {
  today: () => window.__e2e.todayIso(),
  addDays(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  },
  isoWeekday(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
  },
  shown(sel) {
    const node = document.querySelector(sel);
    return Boolean(node) && !node.hidden && getComputedStyle(node).display !== 'none';
  },
  squash: text => String(text || '').replace(/\\s+/g, ' ').trim(),
  /** Aktiivinen elementti tekstinä (virheilmoituksiin). */
  focused() {
    const node = document.activeElement;
    if (!node || node === document.body) return 'body';
    return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '')
      + (node.dataset && node.dataset.screen ? '[' + node.dataset.screen + ']' : '')
      + (node.dataset && node.dataset.calDay ? '[' + node.dataset.calDay + ']' : '')
      + ' "' + H.squash(node.getAttribute('aria-label') || node.textContent).slice(0, 30) + '"';
  },
  /** Päivänäkymän rivit sellaisina kuin käyttäjä ne näkee. */
  rows() {
    return [...document.querySelectorAll('#calDayAgenda li.cal-row')].map(li => {
      const open = li.querySelector('[data-cal-open]');
      const route = li.querySelector('a[data-cal-route]');
      return {
        kind: H.squash((li.querySelector('.cal-kind') || {}).textContent),
        time: H.squash((li.querySelector('.cal-row-time') || {}).textContent),
        title: H.squash((li.querySelector('.cal-row-title') || {}).textContent),
        protected: li.classList.contains('is-protected'),
        text: H.squash(li.textContent),
        departure: H.squash((li.querySelector('.cal-departure') || {}).textContent),
        detail: H.squash((li.querySelector('.cal-departure-detail') || {}).textContent),
        unknownTravel: Boolean(li.querySelector('.cal-departure.is-unknown')),
        routeHref: route ? route.getAttribute('href') : null,
        routeTarget: route ? route.getAttribute('target') : null,
        routeRel: route ? route.getAttribute('rel') : null,
        eventId: open ? open.dataset.calOpen : null,
        date: open ? open.dataset.calDate : null
      };
    });
  },
  event: title => H.rows().find(row => row.kind === 'Meno' && row.title === title) || null,
  toasts: () => [...document.querySelectorAll('#toastHost .toast')].map(node => H.squash(node.textContent)),
  toast: (part, label) => H.waitFor(() => H.toasts().find(text => text.includes(part)), label || ('ilmoitus: ' + part)),
  dialog: () => document.querySelector('#confirmDialog[open]'),
  async openTab(screen) {
    H.tab(screen);
    await H.waitFor(() => H.el('#' + screen).classList.contains('active'), 'näkymä ' + screen);
  },
  async calendar(view) {
    await H.openTab('screen-week');
    const segment = { day: '#segmentCalDay', week: '#segmentCalWeek', month: '#segmentCalMonth' }[view || 'day'];
    H.click(segment);
    await H.waitFor(() => H.el(segment).getAttribute('aria-selected') === 'true', 'kalenterin osio ' + view);
  },
  /** Kalenterin päivä: siirry päivänavigaatiolla (Edellinen/Seuraava), kuten käyttäjä. */
  async gotoDay(iso) {
    await H.calendar('day');
    for (let guard = 0; guard < 400 && H.s().calendarDate !== iso; guard += 1) {
      H.click(H.s().calendarDate < iso ? '#calNext' : '#calPrev');
      await H.sleep(0);
    }
    await H.waitFor(() => H.s().calendarDate === iso, 'päivä ' + iso);
    await H.sleep(30);
  },
  async profile(segment) {
    await H.openTab('screen-profile');
    const id = '#segmentProfile' + segment.charAt(0).toUpperCase() + segment.slice(1);
    H.click(id);
    await H.waitFor(() => H.el(id).getAttribute('aria-selected') === 'true', 'profiilin osio ' + segment);
  },
  /**
   * Uusi meno lomakkeella (Kalenteri -> Päivä -> Uusi meno).
   * fields: { title, date, start, duration, place, location, travel, prep, early, overhead, repeat: [1..7] }
   */
  async newEvent(fields) {
    await H.calendar('day');
    H.click('#calNewEvent');
    await H.waitFor(() => H.shown('#calEventForm') && document.activeElement === H.el('#ceTitle'), 'menolomake auki');
    if (H.text('#calFormTitle') !== 'Uusi meno') throw new Error('lomakkeen otsikko: ' + H.text('#calFormTitle'));
    H.fill('#ceTitle', fields.title);
    if (fields.date) H.fill('#ceDate', fields.date);
    H.fill('#ceStart', fields.start);
    if (fields.duration) H.fill('#ceDuration', String(fields.duration));
    if (fields.place) H.fill('#cePlace', fields.place);
    if (fields.location) {
      H.fill('#cePlace', '__muu__');
      H.fill('#ceLocation', fields.location);
    }
    for (const [key, id] of [['travel', '#ceTravel'], ['prep', '#cePrep'], ['early', '#ceEarly'], ['overhead', '#ceOverhead']]) {
      if (fields[key] !== undefined) H.fill(id, String(fields[key]));
    }
    for (const day of fields.repeat || []) H.click('#ceRepeat' + day);
    const before = H.s().calendarEvents.length;
    H.click('#ceSave');
    await H.waitFor(() => !H.shown('#calEventForm') && H.s().calendarEvents.length === before + 1, 'meno tallennettu');
    return H.s().calendarEvents.find(event => event.title === fields.title);
  },
  /** Vahvistusdialogi: otsikko tarkistetaan, sitten hyväksy tai peru. Palauttaa viestin. */
  async confirm(accept, title) {
    const dialog = await H.waitFor(() => H.dialog(), 'vahvistusdialogi: ' + title);
    const shown = H.squash(dialog.querySelector('#confirmTitle').textContent);
    if (title && shown !== title) throw new Error('vahvistuksen otsikko: ' + shown);
    const message = H.squash(dialog.querySelector('#confirmMessage').textContent);
    H.click(accept ? '#confirmAccept' : '#confirmCancel');
    await H.waitFor(() => !H.dialog(), 'vahvistus kiinni');
    return message;
  }
});
true;`;

/**
 * Sivulla ajettava funktio. Lähdekoodi sarjallistetaan, joten funktio ei
 * saa viitata Noden muuttujiin: vain window, document, H ja argumentti.
 */
export const onPage = (fn, arg = null) => `(${fn.toString()})(${JSON.stringify(arg)})`;

// =====================================================================
// SULJETUT PORTIT: rehellinen heikennys
// =====================================================================

const CLOSED_SCENARIOS = [
  { name: 'suljetut portit: Kalenteri kertoo, että menot säilyvät vain istunnon ajan; meno ei mene kantaan eikä väitä tallentuneensa',
    run: ({ page }) => page(async tables => {
      await H.calendar('day');
      const notice = H.squash(H.text('#calNotice'));
      if (!notice.includes('Menot säilyvät toistaiseksi vain tämän istunnon ajan.')) throw new Error('huomautus: ' + notice);
      const event = await H.newEvent({ title: 'Hammaslääkäri', start: '15:00', duration: 45, travel: 30 });
      // Käyttäjälle kerrotaan heti, ettei meno tallennu (ei pelkkää "onnistui").
      await H.toast('Menot säilyvät toistaiseksi vain tämän istunnon ajan.', 'istunnon rajan ilmoitus');
      const row = await H.waitFor(() => H.event('Hammaslääkäri'), 'meno päivänäkymässä');
      const writes = window.__e2e.db.writes().filter(write => tables.includes(write.table));
      if (writes.length) throw new Error('kirjoitti kantaan suljetulla portilla: ' + JSON.stringify(writes));
      if (H.db('calendar_events').length !== 0) throw new Error('calendar_events-rivejä kannassa');
      return 'huomautus näkyy; meno muistissa (' + row.departure + '); ilmoitus "säilyvät vain istunnon ajan"; '
        + '0014-tauluihin 0 kirjoitusta (meno ' + event.id.slice(0, 6) + '…)';
    }, DAILY_LIFE_TABLES) },

  { name: 'suljetut portit: Profiilin Arki, Hyvinvointi, Paikat ja Asetukset kertovat tallennuksen rajasta; ohjaustyyli ei mene kantaan',
    run: ({ page }) => page(async tables => {
      const found = [];
      await H.profile('daily');
      await H.waitFor(() => H.text('#dailyLifeNotice').includes('Arjen asetukset säilyvät toistaiseksi vain tämän istunnon ajan.'), 'Arki-huomautus');
      found.push('Arki');
      await H.profile('wellbeing');
      await H.waitFor(() => H.text('#profileWellbeingSection').includes('Hyvinvoinnin kirjaukset säilyvät toistaiseksi vain tämän istunnon ajan.'), 'Hyvinvointi-huomautus');
      found.push('Hyvinvointi');
      await H.profile('places');
      await H.waitFor(() => H.text('#profilePlacesSection').includes('Paikat, opitut nimitykset ja asetukset säilyvät toistaiseksi vain tämän istunnon ajan.'), 'Paikat-huomautus');
      found.push('Paikat');
      await H.profile('settings');
      await H.waitFor(() => H.text('#guidanceSettings').includes('Ohjauksen asetukset säilyvät toistaiseksi vain tämän istunnon ajan.'), 'ohjauksen huomautus');
      found.push('Asetukset');
      H.click('#gsStyle-napakka');
      H.click('#gsSave');
      await H.toast('Arjen asetukset säilyvät toistaiseksi vain tämän istunnon ajan.', 'istunnon rajan ilmoitus');
      await H.idle('#gsSave', 'ohjauksen tallennus valmis');
      if ((H.s().lifeSettings[0] || {}).guidanceStyle !== 'napakka') throw new Error('valinta ei näy tilassa');
      const writes = window.__e2e.db.writes().filter(write => tables.includes(write.table));
      if (writes.length) throw new Error('kirjoitti kantaan suljetulla portilla: ' + JSON.stringify(writes));
      return 'huomautus: ' + found.join(', ') + '; Napakka muistissa, ilmoitus istunnon rajasta, 0 kantakirjoitusta';
    }, DAILY_LIFE_TABLES) },

  { name: 'suljetut portit: uudelleenlataus ei kaadu; istunnon meno ja asetus ovat poissa, kuten luvattiin, ja huomautus näkyy yhä',
    run: async ({ page, reload }) => {
      await reload();
      return page(async tables => {
        if (H.s().calendarEvents.length !== 0) throw new Error('meno palasi ilman kantaa');
        if (H.s().lifeSettings.length !== 0) throw new Error('asetus palasi ilman kantaa');
        await H.calendar('day');
        await H.waitFor(() => H.text('#calNotice').includes('Menot säilyvät toistaiseksi vain tämän istunnon ajan.'), 'huomautus');
        if (H.event('Hammaslääkäri')) throw new Error('meno näkyy yhä');
        await H.profile('settings');
        await H.waitFor(() => H.el('#gsStyle-rauhallinen').checked, 'oletustyyli');
        const rows = tables.reduce((sum, table) => sum + H.db(table).length, 0);
        if (rows !== 0) throw new Error('0014-tauluissa ' + rows + ' riviä');
        return 'käynnistys ok; ei menoa, oletustyyli Rauhallinen; 0014-tauluissa 0 riviä';
      }, DAILY_LIFE_TABLES);
    } }
];

// =====================================================================
// K-PORTIT: arjen näkymät tallentuvalla kannalla
// =====================================================================

const K_SCENARIOS = [
  // a. Kalenteri: meno uudella tallennetulla paikalla ja omalla matka-arviolla.
  { name: 'K/a kalenteri: uusi meno uudella tallennetulla paikalla ja omalla matka-arviolla -> suojatut Matka, Valmistautuminen ja Etuaika, "Lähde 14.15", Avaa reitti; uudelleenlataus säilyttää',
    run: async ({ page, reload }) => {
      const EXPECTED = {
        departure: 'Lähde 14.15 · valmistaudu 14.00 · perillä 14.50',
        detail: 'Matka 30 min (oma arvio) · pysäköinti ja kävely 5 min · etuaika 10 min',
        blocks: [['Valmistautuminen', '14.00–14.15'], ['Matka', '14.15–14.45'],
          ['Pysäköinti ja kävely', '14.45–14.50'], ['Etuaika', '14.50–15.00'], ['Meno', '15.00–15.45']],
        address: 'Urho Kekkosen katu 1, Helsinki'
      };
      const check = expected => {
        const rows = H.rows();
        const event = H.event('Hammaslääkäri');
        if (!event) throw new Error('meno ei näy päivänäkymässä: ' + rows.map(r => r.kind + ' ' + r.title).join(' | '));
        if (event.departure !== expected.departure) throw new Error('lähtö: "' + event.departure + '"');
        if (event.detail !== expected.detail) throw new Error('erittely: "' + event.detail + '"');
        const timeline = rows.filter(r => r.time.startsWith('14.') || r.title === 'Hammaslääkäri').map(r => [r.kind, r.time]);
        if (JSON.stringify(timeline) !== JSON.stringify(expected.blocks)) throw new Error('aikajana: ' + JSON.stringify(timeline));
        for (const kind of ['Valmistautuminen', 'Matka', 'Pysäköinti ja kävely', 'Etuaika']) {
          const row = rows.find(r => r.kind === kind);
          if (!row.protected || !row.text.includes('suojattu')) throw new Error(kind + ' ei ole suojattu: ' + row.text);
        }
        if (!event.text.includes('Hammaslääkäri Kamppi')) throw new Error('paikka ei näy: ' + event.text);
        const href = event.routeHref || '';
        if (!href.startsWith('https://www.google.com/maps/dir/')) throw new Error('Avaa reitti: ' + href);
        if (!href.includes('destination=' + encodeURIComponent(expected.address)) || !href.includes('travelmode=driving')) {
          throw new Error('reitin kohde: ' + href);
        }
        if (event.routeTarget !== '_blank' || !/noopener/.test(event.routeRel || '')) throw new Error('linkin target/rel');
        return event;
      };
      const created = await page(async ({ EXPECTED, check }) => {
        const verify = eval('(' + check + ')');
        // 1) Uusi tallennettu paikka (Profiili -> Paikat): nimi ja osoite, ei omaa matka-arviota.
        await H.profile('places');
        H.click('#profilePlacesSection [data-action="place-add"]');
        await H.waitFor(() => document.activeElement && document.activeElement.id === 'plcName', 'paikkalomake');
        H.fill('#plcName', 'Hammaslääkäri Kamppi');
        H.fill('#plcAddress', EXPECTED.address);
        H.click('#profilePlacesSection [data-action="place-save"]');
        await H.waitFor(() => H.db('saved_places').length === 1 && !document.querySelector('#plcName'), 'paikka kannassa');
        const place = H.db('saved_places')[0];
        if (place.name !== 'Hammaslääkäri Kamppi' || place.address !== EXPECTED.address || place.usual_travel_minutes !== null
          || place.travel_mode !== 'driving') throw new Error('saved_places: ' + JSON.stringify(place));
        // 2) Uusi meno tälle päivälle klo 15: paikka, oma matka-arvio 30, valmistautuminen 15, etuaika 10, pysäköinti 5.
        await H.calendar('day');
        H.click('#calNewEvent');
        await H.waitFor(() => H.shown('#calEventForm'), 'menolomake');
        if (H.el('#ceDate').value !== H.today()) throw new Error('oletuspäivä ' + H.el('#ceDate').value);
        H.fill('#ceTitle', 'Hammaslääkäri');
        H.fill('#ceStart', '15:00');
        H.fill('#ceDuration', '45');
        H.fill('#cePlace', place.id);
        const hint = H.squash(H.text('#cePlaceHint'));
        if (!hint.startsWith('Oletukset paikasta Hammaslääkäri Kamppi: matka ei arviota')) throw new Error('paikan vihje: ' + hint);
        H.fill('#ceTravel', '30');
        H.fill('#cePrep', '15');
        H.fill('#ceEarly', '10');
        H.fill('#ceOverhead', '5');
        H.click('#ceSave');
        await H.waitFor(() => H.db('calendar_events').length === 1 && !H.shown('#calEventForm'), 'meno kannassa');
        await H.toast('Meno lisätty kalenteriin.');
        const row = H.db('calendar_events')[0];
        const want = { title: 'Hammaslääkäri', event_date: H.today(), start_time: '15:00:00', end_time: null, duration_minutes: 45,
          all_day: false, place_id: place.id, location_text: null, travel_minutes: 30, preparation_minutes: 15,
          arrival_buffer_minutes: 10, overhead_minutes: 5, skip_dates: [], recurrence_weekdays: [] };
        for (const [key, value] of Object.entries(want)) {
          if (JSON.stringify(row[key]) !== JSON.stringify(value)) throw new Error('calendar_events.' + key + ' = ' + JSON.stringify(row[key]));
        }
        // Piirto voi olla kesken: odota, ja aikakatkaisussa näytä tarkka syy (verify heittää sen).
        const event = await H.waitFor(() => { try { return verify(EXPECTED); } catch { return null; } }, 'päivänäkymä', 3000)
          .catch(() => verify(EXPECTED));
        return { placeId: place.id, eventId: row.id, route: event.routeHref };
      }, { EXPECTED, check: check.toString() });
      await reload();
      return page(async ({ EXPECTED, check, ids }) => {
        const verify = eval('(' + check + ')');
        await H.calendar('day');
        const state = H.s().calendarEvents.find(event => event.id === ids.eventId);
        if (!state || state.startTime !== '15:00' || state.placeId !== ids.placeId) throw new Error('tila: ' + JSON.stringify(state));
        await H.waitFor(() => H.event('Hammaslääkäri'), 'meno uudelleenlatauksen jälkeen');
        verify(EXPECTED);
        return 'saved_places + calendar_events (start_time 15:00:00, matka 30, valmistautuminen 15, etuaika 10, pysäköinti 5); '
          + EXPECTED.departure + '; suojatut rivit 14.00–15.00; ' + ids.route.slice(0, 44) + '…; säilyi uudelleenlatauksessa';
      }, { EXPECTED, check: check.toString(), ids: created });
    } },

  // b. Toistuva meno ja yhden kerran ohitus.
  { name: 'K/b toistuva meno: "Ohita tämä kerta" (vahvistus, peruutus ei kirjoita) poistaa vain sen päivän; uudelleenlataus säilyttää',
    run: async ({ page, reload }) => {
      const ids = await page(async () => {
        const today = H.today();
        const weekday = H.isoWeekday(today);
        const next = H.addDays(today, 7);
        const after = H.addDays(today, 14);
        const event = await H.newEvent({ title: 'Sähly', start: '18:00', duration: 90, repeat: [weekday] });
        const dbRow = () => H.db('calendar_events').find(row => row.id === event.id);
        if (JSON.stringify(dbRow().recurrence_weekdays) !== JSON.stringify([weekday]) || dbRow().skip_dates.length !== 0) {
          throw new Error('toisto kannassa: ' + JSON.stringify(dbRow()));
        }
        await H.gotoDay(next);
        const occurrence = await H.waitFor(() => H.event('Sähly'), 'toistuva kerta ensi viikolla');
        if (!occurrence.text.includes('toistuu') || occurrence.date !== next) throw new Error('kerta: ' + occurrence.text);
        document.querySelector('#calDayAgenda [data-cal-open="' + event.id + '"]').click();
        await H.waitFor(() => H.shown('#calEventForm') && H.shown('#ceSkip'), 'lomake ja "Ohita tämä kerta"');
        if (H.text('#calFormTitle') !== 'Muokkaa menoa') throw new Error('otsikko: ' + H.text('#calFormTitle'));
        if (!H.text('#calFormNote').includes('Voit myös ohittaa vain kerran')) throw new Error('huomautus: ' + H.text('#calFormNote'));
        // Peruutus ei muuta mitään.
        H.click('#ceSkip');
        await H.confirm(false, 'Ohitetaanko tämä kerta?');
        await H.sleep(100);
        if (dbRow().skip_dates.length !== 0) throw new Error('peruttu ohitus kirjoitti kantaan');
        H.click('#ceSkip');
        const message = await H.confirm(true, 'Ohitetaanko tämä kerta?');
        await H.waitFor(() => JSON.stringify(dbRow().skip_dates) === JSON.stringify([next]), 'ohitus kannassa');
        await H.waitFor(() => !H.shown('#calEventForm') && !H.event('Sähly'), 'kerta poissa päivänäkymästä');
        await H.gotoDay(after);
        await H.waitFor(() => H.event('Sähly'), 'seuraava kerta näkyy yhä');
        await H.gotoDay(today);
        await H.waitFor(() => H.event('Sähly'), 'tämän päivän kerta näkyy yhä');
        return { id: event.id, next, after, message };
      });
      await reload();
      return page(async ids => {
        const event = H.s().calendarEvents.find(item => item.id === ids.id);
        if (!event || JSON.stringify(event.skipDates) !== JSON.stringify([ids.next])) throw new Error('ohitus ei säilynyt: ' + JSON.stringify(event));
        await H.gotoDay(ids.next);
        await H.sleep(80);
        if (H.event('Sähly')) throw new Error('ohitettu kerta palasi');
        await H.gotoDay(ids.after);
        await H.waitFor(() => H.event('Sähly'), 'seuraava kerta uudelleenlatauksen jälkeen');
        await H.gotoDay(H.today());
        await H.waitFor(() => H.event('Sähly'), 'tämä kerta uudelleenlatauksen jälkeen');
        return 'toisto [' + H.isoWeekday(H.today()) + '], skip_dates [' + ids.next + ']; vahvistus: "' + ids.message.slice(0, 50)
          + '…"; vain ' + ids.next + ' poissa, ' + ids.after + ' ja tänään näkyvät; säilyi uudelleenlatauksessa';
      }, ids);
    } },

  // c. Kuukausi: maanantai ensin, napautus avaa päivän, nuolet siirtävät fokusta.
  { name: 'K/c kuukausi: ruudukko alkaa maanantaista, päivän napautus avaa Päivä-näkymän sille päivälle, nuolinäppäimet ja Enter',
    run: async ({ page, cdp, reload }) => {
      // Uudelleenlataus ensin: ruudukon luvut tulevat kannan riveistä (K/a, K/b), eivät istunnon muistista.
      await reload();
      const info = await page(async () => {
        const segments = ['#segmentCalDay', '#segmentCalWeek', '#segmentCalMonth'].map(sel => H.squash(H.text(sel)));
        if (segments.join() !== 'Päivä,Viikko,Kuukausi') throw new Error('osiot: ' + segments);
        // Viikko: tämän viikon menot (K/a ja K/b) päivittäin.
        await H.calendar('week');
        await H.waitFor(() => H.shown('#calWeekSection') && H.text('#calWeekEvents').includes('Sähly')
          && H.text('#calWeekEvents').includes('Hammaslääkäri'), 'viikon menot');
        await H.calendar('month');
        await H.waitFor(() => H.shown('#calMonthSection') && document.querySelector('#calMonthGrid [data-cal-day]'), 'kuukausiruudukko');
        if (H.shown('#calDaySection')) throw new Error('päivä näkyy kuukauden kanssa');
        const head = [...document.querySelectorAll('#calMonthGrid .cal-month-head span')].map(node => node.textContent.trim());
        const cells = [...document.querySelectorAll('#calMonthGrid [data-cal-day]')];
        const first = cells[0].dataset.calDay;
        if (H.isoWeekday(first) !== 1 || head[0] !== 'ma') throw new Error('ruudukko alkaa ' + first + ' / ' + head.join(' '));
        if (cells.length % 7 !== 0) throw new Error(cells.length + ' ruutua');
        const month = H.today().slice(0, 7);
        if (!(first <= month + '-01' && H.addDays(first, 6) >= month + '-01')) throw new Error('kuun 1. ei ensimmäisellä rivillä');
        const todayCell = cells.find(cell => cell.dataset.calDay === H.today());
        if (!todayCell || todayCell.getAttribute('aria-current') !== 'date') throw new Error('tämä päivä ei ole merkitty');
        if (cells.filter(cell => cell.getAttribute('tabindex') === '0').length !== 1) throw new Error('sarkainkohteita ei tasan yksi');
        for (const cell of cells) {
          if (cell.getBoundingClientRect().height < 43.5) throw new Error('ruutu alle 44 px');
          if (!cell.getAttribute('aria-label')) throw new Error('ruudulla ei nimeä');
        }
        // Menojen määrät sanoina: tänään Hammaslääkäri + Sähly; ensi viikon ohitettu kerta ei näy.
        const label = iso => { const cell = cells.find(node => node.dataset.calDay === iso); return cell ? cell.getAttribute('aria-label') : ''; };
        if (!/: 2 menoa, tänään/.test(label(H.today()))) throw new Error('tämän päivän ruutu: ' + label(H.today()));
        const skipped = H.addDays(H.today(), 7);
        if (skipped.slice(0, 7) === H.today().slice(0, 7) && !/: ei merkintöjä/.test(label(skipped))) {
          throw new Error('ohitetun kerran ruutu: ' + label(skipped));
        }
        // Napautus: kuun 10. päivä (tai 11., jos tänään on 10.) -> Päivä-näkymä, fokus otsikkoon.
        const target = month + (H.today().endsWith('-10') ? '-11' : '-10');
        document.querySelector('#calMonthGrid [data-cal-day="' + target + '"]').click();
        await H.waitFor(() => H.s().calendarView === 'day' && H.s().calendarDate === target, 'päivä avautui');
        await H.waitFor(() => H.shown('#calDaySection') && !H.shown('#calMonthSection'), 'päiväosio näkyvissä');
        if (H.el('#segmentCalDay').getAttribute('aria-selected') !== 'true') throw new Error('Päivä-osio ei valittu');
        if (document.activeElement !== H.el('#calTitle')) throw new Error('fokus: ' + H.focused());
        const title = H.text('#calTitle');
        const [, m, d] = target.split('-').map(Number);
        if (!title.endsWith(' ' + d + '.' + m + '.')) throw new Error('otsikko: ' + title);
        // Takaisin kuukauteen: valittu päivä on ainoa sarkainkohde; fokus siihen.
        H.click('#segmentCalMonth');
        await H.waitFor(() => H.shown('#calMonthSection'), 'kuukausi');
        const focusable = document.querySelector('#calMonthGrid [data-cal-day][tabindex="0"]');
        if (!focusable || focusable.dataset.calDay !== target) throw new Error('valittu päivä ei ole sarkainkohde');
        focusable.focus();
        return { head: head.join(' '), first, count: cells.length, target, title };
      });
      const moves = [];
      for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'End', 'Home']) {
        const before = await page(() => document.activeElement && document.activeElement.dataset.calDay);
        await pressKey(cdp, key);
        const result = await page(({ key, before }) => {
          const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7,
            End: 7 - H.isoWeekday(before), Home: 1 - H.isoWeekday(before) }[key];
          const expected = H.addDays(before, delta);
          const node = document.activeElement;
          const now = node && node.dataset ? node.dataset.calDay : null;
          return { now, expected, tabindex: node ? node.getAttribute('tabindex') : null };
        }, { key, before });
        if (result.now !== result.expected || result.tabindex !== '0') {
          throw new Error(key + ': fokus ' + result.now + ' (tabindex ' + result.tabindex + '), odotettiin ' + result.expected);
        }
        moves.push(key + ' ' + before.slice(5) + '→' + result.now.slice(5));
      }
      const focused = await page(() => document.activeElement.dataset.calDay);
      await pressKey(cdp, 'Enter');
      const opened = await page(async iso => {
        await H.waitFor(() => H.s().calendarView === 'day' && H.s().calendarDate === iso, 'Enter avasi päivän');
        const title = H.text('#calTitle');
        H.click('#calToday');
        await H.waitFor(() => H.s().calendarDate === H.today(), 'takaisin tähän päivään');
        return title;
      }, focused);
      return 'uudelleenlatauksen jälkeen: osiot Päivä/Viikko/Kuukausi, viikolla menot; otsikot ' + info.head
        + ', ensimmäinen ' + info.first + ' (ma), ' + info.count + ' ruutua, tänään "2 menoa", ohitettu kerta "ei merkintöjä"; napautus ' + info.target
        + ' -> "' + info.title + '", fokus otsikossa; ' + moves.join(', ') + '; Enter -> "' + opened + '"';
    } },

  // d. Paikka ilman matka-aikaa.
  { name: 'K/d meno paikalla ilman matka-aikaa: "Matka-aika puuttuu", ei keksittyä lähtöä; "lisää oma arvio" avaa lomakkeen matka-aikakenttään',
    run: async ({ page, reload }) => {
      const first = await page(async () => {
        const place = H.s().savedPlaces.find(item => item.name === 'Hammaslääkäri Kamppi');
        if (!place || place.usualTravelMinutes !== null) throw new Error('paikka ilman omaa matka-arviota puuttuu (K/a)');
        const event = await H.newEvent({ title: 'Kontrollikäynti', start: '12:00', duration: 30, place: place.id });
        const row = await H.waitFor(() => H.event('Kontrollikäynti'), 'meno näkyy');
        if (!row.unknownTravel || row.departure !== 'Matka-aika puuttuu — lisää oma arvio') throw new Error('lähtö: ' + row.departure);
        if (/Lähde/.test(row.text)) throw new Error('keksitty lähtöaika: ' + row.text);
        const earlyRows = H.rows().filter(r => r.protected && r.time.startsWith('11.'));
        if (earlyRows.length) throw new Error('matkalohkoja ilman matka-aikaa: ' + earlyRows.map(r => r.kind + ' ' + r.time).join(', '));
        const dbRow = () => H.db('calendar_events').find(item => item.id === event.id);
        if (dbRow().travel_minutes !== null || dbRow().place_id !== place.id) throw new Error('calendar_events: ' + JSON.stringify(dbRow()));
        const button = document.querySelector('#calDayAgenda [data-cal-travel="' + event.id + '"]');
        if (!button || H.squash(button.textContent) !== 'lisää oma arvio') throw new Error('painike "lisää oma arvio" puuttuu');
        button.click();
        await H.waitFor(() => H.shown('#calEventForm') && document.activeElement === H.el('#ceTravel'), 'fokus matka-aikakentässä');
        if (H.text('#calFormTitle') !== 'Muokkaa menoa' || H.el('#ceTitle').value !== 'Kontrollikäynti') throw new Error('väärä meno lomakkeella');
        if (H.el('#ceTravel').value !== '') throw new Error('matka-aika esitäytetty: ' + H.el('#ceTravel').value);
        H.fill('#ceTravel', '20');
        H.click('#ceSave');
        await H.waitFor(() => dbRow().travel_minutes === 20 && !H.shown('#calEventForm'), 'matka-aika kannassa');
        // 12.00 - etuaika 10 (oletus) - pysäköinti 5 (oletus) - matka 20 = 11.25; valmistautuminen 10 (oletus).
        const known = await H.waitFor(() => { const r = H.event('Kontrollikäynti'); return r && !r.unknownTravel ? r : null; }, 'lähtö lasketaan');
        if (known.departure !== 'Lähde 11.25 · valmistaudu 11.15 · perillä 11.50') throw new Error('lähtö arvion jälkeen: ' + known.departure);
        return { id: event.id, text: '"Matka-aika puuttuu — lisää oma arvio", ei lohkoja; painike avasi "Muokkaa menoa" fokus #ceTravel; '
          + 'oma arvio 20 min -> ' + known.departure };
      });
      await reload();
      return page(async first => {
        await H.calendar('day');
        const row = await H.waitFor(() => H.event('Kontrollikäynti'), 'meno uudelleenlatauksen jälkeen');
        const db = H.db('calendar_events').find(item => item.id === first.id);
        if (db.travel_minutes !== 20 || row.departure !== 'Lähde 11.25 · valmistaudu 11.15 · perillä 11.50') {
          throw new Error('uudelleenlatauksen jälkeen: ' + db.travel_minutes + ' / ' + row.departure);
        }
        return first.text + '; calendar_events.travel_minutes 20 säilyi uudelleenlatauksessa';
      }, first);
    } },

  // i. Näppäimistö.
  { name: 'K/i näppäimistö: Tab tavoittaa kalenterin osiot ja "Uusi meno"; Escape sulkee menolomakkeen ja fokus palaa avaajaan',
    run: async ({ page, cdp, reload }) => {
      // Oikean uudelleenlatauksen jälkeen (menot kannasta). Lähtökohta: alapalkin
      // Kalenteri-välilehti, kuten välilehden valinnan jälkeen.
      await reload();
      await page(async () => {
        await H.calendar('day');
        const tab = H.el('.tab-btn[data-screen="screen-week"]');
        tab.focus();
        if (document.activeElement !== tab) throw new Error('välilehti ei saa fokusta');
      });
      const path = [];
      for (let i = 0; i < 80 && path[path.length - 1] !== 'calNewEvent'; i += 1) {
        await pressKey(cdp, 'Tab');
        path.push(await page(() => {
          const node = document.activeElement;
          if (!node || node === document.body) return 'body';
          if (node.closest('[inert]')) return 'INERT:' + (node.id || node.tagName);
          return node.id || (node.tagName.toLowerCase() + (node.dataset.screen ? ':' + node.dataset.screen : ''));
        }));
      }
      const order = ['segmentCalDay', 'segmentCalWeek', 'segmentCalMonth', 'calNewEvent'].map(id => path.indexOf(id));
      if (order.some(index => index < 0) || order.some((index, i) => i > 0 && index <= order[i - 1])) {
        throw new Error('sarkainjärjestys: ' + path.join(' > '));
      }
      if (path.some(step => step.startsWith('INERT:'))) throw new Error('fokus piilotettuun näkymään: ' + path.join(' > '));
      const segmentsToNew = path.slice(order[0], order[3] + 1).join(' > ');
      // Enter "Uusi meno" -> lomake, kirjoitus, Escape -> kiinni, ei tallennusta, fokus takaisin "Uusi meno".
      await pressKey(cdp, 'Enter');
      await page(async () => {
        await H.waitFor(() => H.shown('#calEventForm') && document.activeElement === H.el('#ceTitle'), 'lomake auki, fokus otsikossa');
      });
      await cdp.send('Input.insertText', { text: 'Keskeneräinen' });
      await pressKey(cdp, 'Escape');
      const first = await page(async () => {
        await H.waitFor(() => !H.shown('#calEventForm'), 'Escape sulki lomakkeen');
        if (H.s().calendarEvents.some(event => event.title === 'Keskeneräinen')) throw new Error('Escape tallensi');
        if (document.activeElement !== H.el('#calNewEvent')) throw new Error('fokus Escapen jälkeen: ' + H.focused());
        // Toinen avaaja: menon "Hammaslääkäri" rivi.
        const row = [...document.querySelectorAll('#calDayAgenda [data-cal-open]')]
          .find(node => H.squash((node.querySelector('.cal-row-title') || {}).textContent) === 'Hammaslääkäri');
        if (!row) throw new Error('menon riviä ei löydy');
        row.focus();
        return row.dataset.calOpen;
      });
      await pressKey(cdp, 'Enter');
      await page(async () => {
        await H.waitFor(() => H.shown('#calEventForm') && H.text('#calFormTitle') === 'Muokkaa menoa'
          && document.activeElement === H.el('#ceTitle'), 'muokkauslomake auki');
      });
      await pressKey(cdp, 'Escape');
      const second = await page(async id => {
        await H.waitFor(() => !H.shown('#calEventForm'), 'Escape sulki muokkauslomakkeen');
        const node = document.activeElement;
        if (!node || !node.matches('[data-cal-open]') || node.dataset.calOpen !== id) throw new Error('fokus: ' + H.focused());
        return H.focused();
      }, first);
      return 'Tab välilehdeltä (' + path.length + ' painallusta): ' + path.join(' > ') + ' — osiot ennen "Uusi meno": '
        + segmentsToNew + '; Escape -> #calNewEvent; rivin lomake: Escape -> ' + second;
    } },

  // e. Profiili -> Arki.
  { name: 'K/e Profiili -> Arki: arkiherätys, nukkumaanmeno ja unentarve tallentuvat (profile + life_settings) ja säilyvät uudelleenlatauksessa',
    run: async ({ page, reload }) => {
      const saved = await page(async () => {
        await H.profile('daily');
        await H.waitFor(() => document.querySelector('#dsSleepTarget'), 'Uni ja rytmi');
        // K-porteilla ei tallennusrajan varoitusta. Muistutusten pois päältä
        // -vihje saa näkyä (oletuksena muistutukset ovat pois päältä).
        const notice = H.squash(H.text('#dailyLifeNotice'));
        if (/säilyvät toistaiseksi vain tämän istunnon ajan/.test(notice)) throw new Error('tallennusraja K-porteilla: ' + notice);
        if (notice && !/Arjen muistutukset ovat pois päältä/.test(notice)) throw new Error('odottamaton huomautus K-porteilla: ' + notice);
        H.fill('#dsSleepTarget', '7.5');
        H.fill('#dsWakeTime', '06:30');
        H.fill('#dsBedtimeTarget', '22:45');
        H.click('#dsSleepSave');
        await H.toast('Uni ja rytmi tallennettu.');
        await H.idle('#dsSleepSave', 'tallennus valmis');
        const profile = H.db('profile')[0];
        const settings = H.db('life_settings');
        if (!profile || profile.sleep_target_hours !== 7.5 || profile.default_wake_time !== '06:30') throw new Error('profile: ' + JSON.stringify(profile));
        if (settings.length !== 1 || settings[0].bedtime_target !== '22:45:00') throw new Error('life_settings: ' + JSON.stringify(settings));
        return 'profile 7.5 h / 06:30, life_settings.bedtime_target 22:45:00';
      });
      await reload();
      return page(async saved => {
        await H.profile('daily');
        await H.waitFor(() => document.querySelector('#dsSleepTarget'), 'Uni ja rytmi');
        const values = ['#dsSleepTarget', '#dsWakeTime', '#dsBedtimeTarget'].map(sel => H.el(sel).value);
        if (JSON.stringify(values) !== JSON.stringify(['7.5', '06:30', '22:45'])) throw new Error('uudelleenlatauksen jälkeen: ' + values.join(', '));
        return saved + '; uudelleenlatauksen jälkeen kentät ' + values.join(' / ');
      }, saved);
    } },

  // e2. Profiili -> Asetukset: ohjaustyyli.
  { name: 'K/e ohjaustyyli (Rauhallinen / Napakka / Aktiivinen): Napakka tallentuu samalle life_settings-riville ja säilyy',
    run: async ({ page, reload }) => {
      const saved = await page(async () => {
        await H.profile('settings');
        await H.waitFor(() => document.querySelector('#gsSave'), 'Ohjaus ja puhe');
        const labels = ['rauhallinen', 'napakka', 'aktiivinen'].map(key => H.squash(H.el('label[for="gsStyle-' + key + '"]').textContent));
        if (labels.join(',') !== 'Rauhallinen,Napakka,Aktiivinen') throw new Error('tyylit: ' + labels);
        if (!H.el('#gsStyle-rauhallinen').checked) throw new Error('oletus ei ole Rauhallinen');
        H.click('#gsStyle-napakka');
        H.click('#gsSave');
        await H.toast('Ohjaus ja puhe tallennettu.');
        await H.idle('#gsSave', 'tallennus valmis');
        const rows = H.db('life_settings');
        if (rows.length !== 1 || rows[0].guidance_style !== 'napakka' || rows[0].bedtime_target !== '22:45:00') {
          throw new Error('life_settings: ' + JSON.stringify(rows.map(r => [r.guidance_style, r.bedtime_target])));
        }
        return labels.join(' / ');
      });
      await reload();
      return page(async labels => {
        await H.profile('settings');
        await H.waitFor(() => document.querySelector('#gsStyle-napakka'), 'Ohjaus ja puhe');
        const checked = ['rauhallinen', 'napakka', 'aktiivinen'].filter(key => H.el('#gsStyle-' + key).checked);
        if (checked.join() !== 'napakka') throw new Error('valittu uudelleenlatauksen jälkeen: ' + checked);
        return labels + ': Napakka -> life_settings.guidance_style napakka (sama rivi, nukkumaanmeno säilyi); säilyi uudelleenlatauksessa';
      }, saved);
    } },

  // f. Profiili -> Paikat.
  { name: 'K/f Profiili -> Paikat: uusi paikka, etuajan muokkaus, "Nollaa oppiminen" vaatii vahvistuksen, poisto vahvistuksella',
    run: async ({ page, reload }) => {
      const result = await page(async () => {
        await H.profile('places');
        const root = '#profilePlacesSection';
        if (H.text(root).includes('säilyvät toistaiseksi vain')) throw new Error('istuntohuomautus K-porteilla');
        H.click(root + ' [data-action="place-add"]');
        await H.waitFor(() => document.activeElement && document.activeElement.id === 'plcName', 'paikkalomake');
        H.fill('#plcName', 'Kuntosali');
        H.fill('#plcAddress', 'Mannerheimintie 5, Helsinki');
        H.fill('#plcTravel', '15');
        H.click(root + ' [data-action="place-save"]');
        const created = await H.waitFor(() => H.db('saved_places').find(place => place.name === 'Kuntosali'), 'paikka kannassa');
        await H.waitFor(() => !document.querySelector('#plcName'), 'lomake kiinni');
        if (created.usual_travel_minutes !== 15 || created.arrival_buffer_minutes !== null) throw new Error('saved_places: ' + JSON.stringify(created));
        const id = created.id;
        const dbRow = () => H.db('saved_places').find(place => place.id === id);
        const rowText = () => { const li = document.querySelector(root + ' [data-place-row="' + id + '"]'); return li ? H.squash(li.textContent) : null; };
        // Tuntematon etuaika näkyy oletuksena, ei nollana.
        if (!rowText().includes('oma arvio 15 min') || !rowText().includes('etuaika oletus (10 min)')) throw new Error('rivi: ' + rowText());
        // Muokkaus: oma etuaika 20 min ja opitun keston lupa.
        H.click(root + ' [data-action="place-edit"][data-id="' + id + '"]');
        await H.waitFor(() => document.querySelector('#plcBuffer'), 'muokkauslomake');
        if (H.el('#plcTravel').value !== '15' || H.el('#plcBuffer').value !== '') throw new Error('lomakkeen arvot');
        H.fill('#plcBuffer', '20');
        H.click('#plcUseLearned');
        H.click(root + ' [data-action="place-save"]');
        await H.waitFor(() => dbRow().arrival_buffer_minutes === 20 && dbRow().use_learned === true, 'muokkaus kannassa');
        await H.waitFor(() => rowText() && rowText().includes('saavu etuajassa 20 min'), 'rivi päivittyi');
        // Nollaa oppiminen: vahvistus; peruutus ei muuta mitään.
        const reset = () => document.querySelector(root + ' [data-action="place-reset"][data-id="' + id + '"]');
        await H.waitFor(reset, '"Nollaa oppiminen" -painike');
        reset().click();
        const cancelled = await H.confirm(false, 'Nollataanko oppiminen?');
        await H.sleep(100);
        if (dbRow().use_learned !== true) throw new Error('peruttu nollaus muutti paikkaa');
        await H.waitFor(reset, 'painike jäi peruutuksen jälkeen');
        reset().click();
        await H.confirm(true, 'Nollataanko oppiminen?');
        await H.waitFor(() => dbRow().use_learned === false, 'nollaus kannassa');
        await H.toast('Oppiminen nollattu. Oma arviosi säilyi.');
        if (dbRow().usual_travel_minutes !== 15) throw new Error('oma arvio ei säilynyt');
        await H.waitFor(() => !reset(), '"Nollaa oppiminen" poistui');
        // Oletusetuaika 15 min (life_settings).
        H.click(root + ' [data-action="buffer-set"][data-value="15"]');
        await H.waitFor(() => (H.db('life_settings')[0] || {}).arrival_buffer_minutes === 15, 'oletusetuaika kannassa');
        await H.waitFor(() => H.el(root + ' [data-action="buffer-set"][data-value="15"]').getAttribute('aria-pressed') === 'true', 'valinta näkyy');
        // Poisto vahvistuksella.
        H.click(root + ' [data-action="place-delete"][data-id="' + id + '"]');
        const removal = await H.confirm(true, 'Poistetaanko paikka?');
        await H.waitFor(() => !dbRow() && rowText() === null, 'paikka poistettu');
        if (H.db('life_settings').length !== 1) throw new Error('life_settings-rivejä ' + H.db('life_settings').length);
        return { id, cancelled: cancelled.slice(0, 40), removal: removal.slice(0, 40) };
      });
      await reload();
      return page(async result => {
        await H.profile('places');
        const root = '#profilePlacesSection';
        await H.waitFor(() => H.text(root).includes('Hammaslääkäri Kamppi'), 'paikat uudelleenlatauksen jälkeen');
        if (document.querySelector(root + ' [data-place-row="' + result.id + '"]') || H.s().savedPlaces.some(p => p.id === result.id)) {
          throw new Error('poistettu paikka palasi');
        }
        if (!H.text(root).includes('Nyt 15 min.')) throw new Error('oletusetuaika ei säilynyt');
        return 'Kuntosali: oma arvio 15, etuaika tuntematon -> "oletus (10 min)", muokkaus 20 min + opittu lupa; '
          + 'nollaus kysyi ("' + result.cancelled + '…"), peruutus ei kirjoittanut, vahvistus nollasi; oletusetuaika 15; '
          + 'poisto kysyi ("' + result.removal + '…"); säilyi uudelleenlatauksessa';
      }, result);
    } },

  // g. Profiili -> Hyvinvointi.
  { name: 'K/g Profiili -> Hyvinvointi: nikotiinisuunnitelma, liikuntakerta ja unikirjaukset tallentuvat; puuttuva arvo on tuntematon, ei 0; uudelleenlataus säilyttää',
    run: async ({ page, reload }) => {
      const verify = () => {
        const root = '#profileWellbeingSection';
        const today = H.today();
        const yesterday = H.addDays(today, -1);
        const text = sel => { const node = document.querySelector(root + ' ' + sel); return node ? H.squash(node.textContent) : null; };
        const plan = H.s().habitPlans.find(item => item.name === 'Nikotiinipussit');
        const session = H.s().exerciseSessions.find(item => item.kind === 'Juoksu');
        if (!plan || !session) throw new Error('suunnitelma tai liikuntakerta puuttuu tilasta');
        const habit = text('[data-habit-row="' + plan.id + '"]') || '';
        for (const part of ['Nikotiinipussit', 'Nikotiini', 'Käytössä', 'väli vähintään 1 h 30 min', 'päivätavoite 8 kertaa',
          'Säästöä ei lasketa ilman lähtötasoa ja yksikköhintaa.']) {
          if (!habit.includes(part)) throw new Error('suunnitelman rivi ilman "' + part + '": ' + habit);
        }
        const exercise = text('[data-exercise-row="' + session.id + '"]') || '';
        if (!exercise.includes('toteutunut 35 min')) throw new Error('liikunta: ' + exercise);
        if (/suunniteltu|rasittavuus|palautumistarve|\b0 min/.test(exercise)) throw new Error('tuntematon näytetään arvona: ' + exercise);
        const night = text('[data-sleep-row="' + today + '"]') || '';
        if (!night.includes('nukkumaan 23.15 · heräsi 6.40 · vuoteessa 7 h 25 min')) throw new Error('uni tänään: ' + night);
        const partial = text('[data-sleep-row="' + yesterday + '"]') || '';
        if (!partial.includes('nukkumaan 23.50') || !partial.includes('vuoteessa oloaika ei tiedossa')) throw new Error('uni eilen: ' + partial);
        // Vointi 14 pv: päivä ilman merkintää on "ei merkintää", keskiarvossa ei lukuja.
        const day = text('tr[data-date="' + today + '"]') || '';
        if (!day.includes('ei merkintää')) throw new Error('päivä ilman merkintää: ' + day);
        const averages = [...document.querySelectorAll(root + ' tfoot td')].map(td => H.squash(td.textContent));
        if (averages.some(cell => /\d/.test(cell))) throw new Error('keskiarvo ilman merkintöjä: ' + averages.join(' | '));
        return { habit, exercise, night, partial };
      };
      const ids = await page(async check => {
        const verify = eval('(' + check + ')');
        await H.profile('wellbeing');
        const root = '#profileWellbeingSection';
        await H.waitFor(() => document.querySelector(root + ' [data-action="habit-add"]'), 'Hyvinvointi');
        if (H.text(root).includes('säilyvät toistaiseksi vain')) throw new Error('istuntohuomautus K-porteilla');
        // 1) Nikotiinisuunnitelma: väli 90 min, päivätavoite 8; lähtötaso ja hinta jätetään tyhjiksi.
        H.click(root + ' [data-action="habit-add"]');
        await H.waitFor(() => document.activeElement && document.activeElement.id === 'wbhHabitName', 'suunnitelmalomake');
        H.fill('#wbhHabitName', 'Nikotiinipussit');
        H.fill('#wbhHabitKind', 'nicotine');
        H.fill('#wbhHabitInterval', '90');
        H.fill('#wbhHabitTarget', '8');
        H.click(root + ' [data-action="habit-save"]');
        const plan = await H.waitFor(() => H.db('habit_plans')[0], 'habit_plans-rivi');
        await H.waitFor(() => !document.querySelector('#wbhHabitName'), 'lomake kiinni');
        const wantPlan = { kind: 'nicotine', name: 'Nikotiinipussit', min_interval_minutes: 90, daily_target: 8,
          baseline_per_day: null, unit_cost_minor: null, active: true, steps: [], reminder_delivery: 'silent' };
        for (const [key, value] of Object.entries(wantPlan)) {
          if (JSON.stringify(plan[key]) !== JSON.stringify(value)) throw new Error('habit_plans.' + key + ' = ' + JSON.stringify(plan[key]));
        }
        // 2) Liikuntakerta: vain toteutunut kesto; suunniteltu ja arviot jäävät tuntemattomiksi.
        H.click(root + ' [data-action="exercise-add"]');
        await H.waitFor(() => document.activeElement && document.activeElement.id === 'wbhExerciseKind', 'liikuntalomake');
        if (H.el('#wbhExerciseDate').value !== H.today()) throw new Error('liikunnan oletuspäivä');
        H.fill('#wbhExerciseKind', 'Juoksu');
        H.fill('#wbhExerciseActual', '35');
        H.click(root + ' [data-action="exercise-save"]');
        const session = await H.waitFor(() => H.db('exercise_sessions')[0], 'exercise_sessions-rivi');
        await H.waitFor(() => !document.querySelector('#wbhExerciseKind'), 'lomake kiinni');
        const wantSession = { session_date: H.today(), kind: 'Juoksu', actual_minutes: 35, planned_minutes: null,
          intensity: null, recovery_demand: null, goal_id: null };
        for (const [key, value] of Object.entries(wantSession)) {
          if (JSON.stringify(session[key]) !== JSON.stringify(value)) throw new Error('exercise_sessions.' + key + ' = ' + JSON.stringify(session[key]));
        }
        // 3) Unikirjaukset: tämä aamu (nukkumaan ja herääminen) ja eilinen (vain nukkumaanmeno).
        H.click(root + ' [data-action="sleep-add"]');
        await H.waitFor(() => document.querySelector('#wbhSleepDate'), 'unilomake');
        if (H.el('#wbhSleepDate').value !== H.today()) throw new Error('unen oletuspäivä');
        H.fill('#wbhSleepBedtime', '23:15');
        H.fill('#wbhSleepWake', '06:40');
        H.click(root + ' [data-action="sleep-save"]');
        await H.waitFor(() => H.db('sleep_logs').length === 1 && !document.querySelector('#wbhSleepDate'), 'ensimmäinen yö');
        H.click(root + ' [data-action="sleep-add"]');
        await H.waitFor(() => document.querySelector('#wbhSleepDate'), 'unilomake');
        const yesterday = H.addDays(H.today(), -1);
        H.fill('#wbhSleepDate', yesterday);
        H.fill('#wbhSleepBedtime', '23:50');
        H.click(root + ' [data-action="sleep-save"]');
        await H.waitFor(() => H.db('sleep_logs').length === 2 && !document.querySelector('#wbhSleepDate'), 'toinen yö');
        const night = H.db('sleep_logs').find(log => log.wake_date === H.today());
        const partial = H.db('sleep_logs').find(log => log.wake_date === yesterday);
        if (night.actual_bedtime !== '23:15:00' || night.actual_wake !== '06:40:00' || night.kind !== 'opportunity' || night.source !== 'user') {
          throw new Error('sleep_logs: ' + JSON.stringify(night));
        }
        if (partial.actual_bedtime !== '23:50:00' || partial.actual_wake !== null) throw new Error('sleep_logs eilen: ' + JSON.stringify(partial));
        verify();
        return { plan: plan.id, session: session.id };
      }, verify.toString());
      await reload();
      return page(async ({ check, ids }) => {
        const verify = eval('(' + check + ')');
        await H.profile('wellbeing');
        await H.waitFor(() => document.querySelector('#profileWellbeingSection [data-habit-row="' + ids.plan + '"]'), 'suunnitelma uudelleenlatauksen jälkeen');
        const seen = verify();
        return 'habit_plans (nicotine, 90 min, 8/pv, lähtötaso ja hinta null), exercise_sessions (35 min, muut null), '
          + 'sleep_logs x2 (23:15:00–06:40:00; eilen vain 23:50:00); näkyvissä: "' + seen.night + '", "'
          + seen.partial.slice(0, 60) + '"; ei nollia tuntemattomille; säilyi uudelleenlatauksessa';
      }, { check: verify.toString(), ids });
    } },

  // g2. Tapakirjaus (käyttö / lykkäys / väliin).
  { name: 'K/g tapakirjaus: käyttö, lykkäys tai väliin jättäminen tallentuu habit_events-riviksi ja säilyy',
    run: async ({ page, reload }) => {
      const logged = await page(async () => {
        const plan = H.s().habitPlans.find(item => item.name === 'Nikotiinipussit');
        if (!plan) throw new Error('suunnitelma puuttuu (K/g)');
        const candidates = [];
        const scopes = [['screen-today', '#screen-today'], ['wellbeing', '#profileWellbeingSection']];
        for (const [where, selector] of scopes) {
          if (where === 'screen-today') await H.openTab('screen-today');
          else await H.profile('wellbeing');
          await H.sleep(50);
          for (const node of document.querySelectorAll(selector + ' button, ' + selector + ' [role="button"]')) {
            const label = H.squash((node.getAttribute('aria-label') || '') + ' ' + node.textContent);
            const action = node.getAttribute('data-action') || '';
            if (/habit-(log|use|delay|skip|event)/.test(action)
              || (label.includes(plan.name) && /(kirjaa|käyt|lykkä|väliin)/i.test(label) && !/muokkaa|poista/i.test(label))) {
              candidates.push(node);
            }
          }
          if (candidates.length) break;
        }
        if (!candidates.length) {
          throw new Error('tapakirjauksen ohjainta ei ole Tänään-näkymässä eikä Profiili -> Hyvinvointi -osiossa: '
            + 'dailyLifeActions.logHabitEvent ei ole kytketty yhteenkään näkymään');
        }
        const before = H.db('habit_events').length;
        candidates[0].click();
        await H.waitFor(() => H.db('habit_events').length === before + 1, 'habit_events-rivi kannassa');
        const row = H.db('habit_events')[H.db('habit_events').length - 1];
        if (row.plan_id !== plan.id || !['use', 'delay', 'skip'].includes(row.action)) throw new Error('habit_events: ' + JSON.stringify(row));
        return { id: row.id, action: row.action };
      });
      await reload();
      return page(async logged => {
        if (!H.s().habitEvents.some(event => event.id === logged.id)) throw new Error('kirjaus ei säilynyt');
        return 'habit_events: ' + logged.action + '; säilyi uudelleenlatauksessa';
      }, logged);
    } },

  // h. Tänään: voinnin kortti (motivaatio ja hallinnan tunne).
  { name: 'K/h Tänään: voinnin kortti (motivaatio ja hallinnan tunne) tallentaa wellbeing_checkins-rivin',
    run: async ({ page, reload }) => {
      const saved = await page(async () => {
        await H.openTab('screen-today');
        const scope = H.el('#screen-today');
        // Hyvinvointi-kortti on suljettu <details>: avataan kuten käyttäjä.
        for (const details of scope.querySelectorAll('details')) details.open = true;
        await H.sleep(50);
        const groups = [...scope.querySelectorAll('[role="radiogroup"]')].map(group => group.getAttribute('aria-label'));
        const pick = name => [...scope.querySelectorAll('button, input')].find(node => H.squash(node.getAttribute('aria-label')) === name);
        if (!pick('Motivaatio 4') || !pick('Hallinnan tunne 3')) {
          throw new Error('Tänään-näkymässä ei ole motivaation eikä hallinnan tunteen valintaa (asteikot: ' + groups.join(', ')
            + '): dailyLifeActions.saveWellbeingCheckin ei ole kytketty yhteenkään näkymään');
        }
        pick('Motivaatio 4').click();
        await H.waitFor(() => H.db('wellbeing_checkins').some(row => row.motivation === 4), 'motivaatio kannassa');
        pick('Hallinnan tunne 3').click();
        await H.waitFor(() => H.db('wellbeing_checkins').some(row => row.control === 3), 'hallinnan tunne kannassa');
        const rows = H.db('wellbeing_checkins');
        if (rows.length !== 1 || rows[0].date !== H.today()) throw new Error('wellbeing_checkins: ' + JSON.stringify(rows));
        return rows[0].id;
      });
      await reload();
      return page(async id => {
        const checkin = H.s().wellbeingCheckins.find(item => item.id === id);
        if (!checkin || checkin.motivation !== 4 || checkin.control !== 3) throw new Error('ei säilynyt: ' + JSON.stringify(checkin));
        return 'wellbeing_checkins: motivaatio 4, hallinnan tunne 3; säilyi uudelleenlatauksessa';
      }, saved);
    } }
];

/**
 * Skenaariot, jotka paljastivat sovelluksen vian. Epäonnistuminen on
 * ODOTTAA-rivi eikä kaada ajoa; onnistuminen kaataa, jotta merkintä
 * poistetaan korjauksen jälkeen. Arvo on vian kuvaus (mitä, missä).
 */
// Tyhjä. Ensimmäinen ajo (99624c2) löysi kaksi vikaa: tapakirjausta ja
// motivaation ja hallinnan tunteen kirjausta ei ollut missään näkymässä.
// Tänään-kortit (U3, 33ea009) toivat molemmat; ajo 27.9.2026 merkitsi ne
// onnistuneiksi, joten merkinnät poistettiin.
export const PENDING_ON = Object.freeze({});

/**
 * Konsolivirheet, jotka ovat odotettuja (skenaarion nimi -> syy). Tyhjä:
 * yksikään arjen skenaario ei saa tuottaa konsolivirhettä.
 */
export const EXPECTED_CONSOLE_ERRORS = Object.freeze({});

export const GROUPS = Object.freeze([
  { key: 'closed', label: 'suljetut portit',
    query: { gates: 'closed', seed: 'empty', onboarding: 'skip', clock: wednesdayTen() }, scenarios: CLOSED_SCENARIOS },
  { key: 'K', label: 'K-portit',
    query: { gates: 'K', seed: 'empty', onboarding: 'skip', clock: wednesdayTen() }, scenarios: K_SCENARIOS }
]);

// =====================================================================
// AJO
// =====================================================================

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// SELAIMEN SULKEMINEN JA PROFIILIN POISTO
//
// Windowsissa kuormitetulla koneella lopetettu Chrome (ja sen lapset) voi
// pitää profiilin tiedostoja auki vielä pitkään: TerminateProcess on
// asynkroninen, ja lapsiprosessi voi käynnistyä uudelleen, jos se ehtii
// kuolla ennen pääprosessia. Siksi:
//   1. oma prosessipuu lopetetaan (taskkill /PID <oma pid> /T /F; muualla kill)
//   2. odotetaan, kunnes yksikään OMA Chrome-prosessi ei ole enää käynnissä;
//      jäljelle jääneet lopetetaan pid:llä. Oma = komentorivillä tämän ajon
//      yksilöllinen profiilihakemisto (pid + aikaleima): vieraat Chromet eivät
//      voi osua, eikä mitään lopeteta nimellä.
//   3. profiili poistetaan uudelleenyrityksin
//   4. jos lukko ei silti vapaudu ajon aikana, irrallinen siivoaja jatkaa
//      TÄMÄN profiilihakemiston poistoa ajon jälkeen (enintään 15 min), ja
//      tulosrivi on HUOM eikä PASS

/** Tämän ajon käynnissä olevat Chrome-prosessit (Windows; muualla tyhjä). */
function ownBrowserPids(profile) {
  if (process.platform !== 'win32') return [];
  const name = path.basename(profile).replace(/[^\w-]/g, '');
  const query = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" | `
    + `Where-Object { $_.CommandLine -like '*${name}*' } | ForEach-Object { $_.ProcessId }`;
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true });
  return String(out.stdout || '').split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
}

/** Lopeta oma selain ja odota, että sen jokainen prosessi on todella poissa. */
async function closeBrowser(browser, exited, profile) {
  const notes = [];
  if (browser.exitCode === null && Number.isInteger(browser.pid)) {
    if (process.platform === 'win32') {
      const tree = spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
      notes.push('taskkill /T ' + (tree.error ? tree.error.code : `status ${tree.status}`));
    }
    if (browser.exitCode === null) browser.kill();
  }
  await Promise.race([exited, sleep(5000)]);
  const stragglers = new Set();
  const deadline = Date.now() + 90000;
  let alive = ownBrowserPids(profile);
  while (alive.length && Date.now() < deadline) {
    for (const pid of alive) {
      stragglers.add(pid);
      spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
    }
    await sleep(2000);
    alive = ownBrowserPids(profile);
  }
  if (stragglers.size) notes.push(`jälkeen jääneet omat prosessit lopetettu pid:llä (${stragglers.size})`);
  if (alive.length) notes.push(`yhä sammumassa: ${alive.join(', ')}`);
  return notes.join('; ') || 'sammui';
}

/** Poista profiili uudelleenyrityksin. */
async function removeProfile(profile, { budgetMs = 60000 } = {}) {
  let lastError = '';
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      lastError = error.code || String(error.message);
    }
    if (!fs.existsSync(profile)) return { removed: true, attempts: attempt, lastError };
    if (Date.now() > deadline) return { removed: false, attempts: attempt, lastError };
    await sleep(500);
  }
}

/**
 * Irrallinen siivoaja: jatkaa YHDEN tämän ajon profiilihakemiston poistoa
 * ajon jälkeen. Polku tarkistetaan (projektin tmp/, arjen E2E:n nimi), ja
 * siivoaja lopettaa 15 minuutin jälkeen.
 */
export function deferredCleanupScript(profile) {
  return `const fs = require('fs');
const target = ${JSON.stringify(profile)};
const end = Date.now() + 15 * 60 * 1000;
const tick = () => {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  if (fs.existsSync(target) && Date.now() < end) setTimeout(tick, 3000);
};
tick();`;
}

function scheduleDeferredCleanup(profile) {
  const inside = path.dirname(profile) === path.join(ROOT, 'tmp') && /^e2e-daily-chrome-\d+-\d+$/.test(path.basename(profile));
  if (!inside) return false;
  const child = spawn(process.execPath, ['-e', deferredCleanupScript(profile)], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return true;
}

async function main() {
  const chrome = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!chrome) throw new Error('Chromea ei löytynyt; aseta CHROME_PATH');

  const wanted = (process.env.E2E_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean);
  const groups = GROUPS.filter(group => wanted.length === 0 || wanted.includes(group.key));
  const schemaSource = fs.readFileSync(path.join(ROOT, 'src/data/schema.js'), 'utf8');
  const gatedSchemas = {};
  for (const mode of new Set(groups.map(group => group.query.gates))) {
    const resolved = resolveGateMode(mode, { cwd: ROOT, schemaSource });
    if (resolved.source) gatedSchemas[mode] = resolved.source;
    console.log(`${mode}-portit: ${resolved.provenance}`
      + (resolved.fromTrain ? ` — LÄHDE: junan määrittely (tools/release/waves.mjs), ei ehdokashaaraa` : ''));
  }

  const httpPort = await freePort();
  const debugPort = await freePort();
  if (await cdpReachable(debugPort)) throw new Error(`debug-portti ${debugPort} on jo käytössä — ei liitytä vieraaseen prosessiin`);
  console.log(`debug-portti ${debugPort} vapaa (ei CDP-vastausta ennen käynnistystä), palvelin 127.0.0.1:${httpPort}`);

  const server = await startServer(httpPort, { gatedSchemas });
  const profile = path.join(ROOT, 'tmp', `e2e-daily-chrome-${process.pid}-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const browser = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--host-resolver-rules=MAP *.supabase.co ~NOTFOUND, MAP supabase.co ~NOTFOUND, MAP *.anthropic.com ~NOTFOUND, MAP cdn.jsdelivr.net ~NOTFOUND, MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND, MAP www.google.com ~NOTFOUND, MAP maps.google.com ~NOTFOUND',
    'about:blank'
  ], { stdio: 'ignore' });
  const exited = new Promise(resolve => browser.once('exit', resolve));

  const results = [];
  const requests = [];
  const requestUrls = new Map();
  const failures = [];
  const consoleErrors = [];
  const allowedConsole = [];
  let allowConsole = null;
  let cdp = null;
  try {
    let version = null;
    for (let i = 0; i < 80 && !version; i++) {
      await new Promise(r => setTimeout(r, 100));
      try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { /* käynnistyy */ }
    }
    if (!version) throw new Error('Chrome ei käynnistynyt');
    if (browser.exitCode !== null) throw new Error('oma Chrome sammui: portissa vastaa jokin muu');
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    cdp.on(message => {
      if (message.method === 'Network.requestWillBeSent') {
        requests.push(message.params.request.url);
        requestUrls.set(message.params.requestId, message.params.request.url);
      }
      if (message.method === 'Network.loadingFailed') {
        failures.push({ url: requestUrls.get(message.params.requestId) || '?', errorText: message.params.errorText });
      }
      // Poikkeus ei ole koskaan odotettu; konsolin virherivi vain nimetyssä skenaariossa.
      if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        const text = message.params.args.map(a => a.value || a.description).join(' ');
        if (allowConsole) allowedConsole.push(`${allowConsole}: ${text}`);
        else consoleErrors.push(text);
      }
      // Sovellus käyttää <dialog>-elementtejä; selaimen oma dialogi olisi vika (ja jumittaisi ajon).
      if (message.method === 'Page.javascriptDialogOpening') {
        consoleErrors.push('selaimen dialogi: ' + message.params.message);
        cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
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
    const page = (fn, arg) => evaluate(onPage(fn, arg));

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
      await evaluate(PAGE_HELPERS);
      await evaluate(DAILY_HELPERS);
    };
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
        const gates = await evaluate('window.__e2e.gates.mode');
        if (gates !== group.query.gates) throw new Error(`porttitila ${gates}, odotettiin ${group.query.gates}`);
      } catch (error) {
        results.push({ name: `[${group.label}] käynnistys`, ok: false, detail: error.message.split('\n')[0] });
        continue;
      }
      console.log(`[${group.label}] kello: ${group.query.clock}`);

      for (const scenario of group.scenarios) {
        const name = `[${group.label}] ${scenario.name}`;
        allowConsole = EXPECTED_CONSOLE_ERRORS[scenario.name] || null;
        try {
          const detail = await scenario.run({ evaluate, page, cdp, reload });
          results.push({ name, ok: true, detail, pendingOn: PENDING_ON[scenario.name] });
        } catch (error) {
          results.push({ name, ok: false, detail: error.message.split('\n')[0], pendingOn: PENDING_ON[scenario.name] });
          // Epäonnistunut skenaario voi jättää lomakkeen tai dialogin auki: seuraava alkaa siististä näkymästä.
          await evaluate(`(() => { const d = document.querySelector('dialog[open]'); if (d) d.close('cancel'); return true; })()`).catch(() => {});
        } finally {
          allowConsole = null;
        }
      }
      const unsupported = await evaluate('window.__e2e ? window.__e2e.db.unsupported() : []').catch(() => []);
      results.push({ name: `[${group.label}] kannan korvike tuki jokaisen kyselyn`, ok: unsupported.length === 0,
        detail: unsupported.length ? unsupported.join(', ') : 'ei tukemattomia kyselyjä' });
    }
  } finally {
    if (cdp) cdp.close();
    const closed = await closeBrowser(browser, exited, profile);
    server.close();
    const removal = await removeProfile(profile);
    const relative = path.relative(ROOT, profile);
    const how = `selain: ${closed}; poistoyrityksiä ${removal.attempts}`
      + (removal.lastError ? `, viimeisin virhe ${removal.lastError}` : '');
    if (removal.removed) {
      results.push({ name: 'väliaikainen Chrome-profiili poistettu (tmp/)', ok: true, detail: `${relative} poistettu (${how})` });
    } else {
      const deferred = scheduleDeferredCleanup(profile);
      results.push({ name: 'väliaikainen Chrome-profiili poistettu (tmp/)', ok: deferred, warn: true,
        detail: deferred
          ? `lukko ei vapautunut ajon aikana; irrallinen siivoaja poistaa ${relative} heti kun Windows vapauttaa sen (${how})`
          : `EI POISTETTU: poista käsin ${relative} (${how})` });
    }
  }

  const audit = auditRequests(requests, failures);
  results.push({ name: 'ei yhtään pyyntöä tuotantoon (Supabase/Anthropic)', ok: audit.production.length === 0,
    detail: audit.production.length ? audit.production.join(', ')
      : `${audit.total} pyyntöä, tuotantoon 0, DNS-tasolla estettyjä ${audit.blocked.length}` });
  results.push({ name: 'ei yhtään ulkoista pyyntöä (vain 127.0.0.1)', ok: audit.external.length === 0,
    detail: audit.external.length ? audit.external.slice(0, 5).join(', ') : 'kaikki paikallisia' });
  results.push({ name: 'ei konsolivirheitä eikä käsittelemättömiä poikkeuksia koko ajossa', ok: consoleErrors.length === 0,
    detail: consoleErrors.slice(0, 3).join(' | ')
      || `ei virheitä${allowedConsole.length ? ` (odotetut: ${allowedConsole.join(' | ')})` : ' (odotettuja virheitä ei ole määritelty)'}` });

  let failed = 0;
  let pending = 0;
  let warned = 0;
  for (const result of results) {
    const label = classifyResult(result);
    let detail = result.detail;
    if (label === 'ODOTTAA') {
      detail = `${detail}\n      (${result.pendingOn})`;
      pending += 1;
    } else if (result.pendingOn && result.ok) {
      detail = `${detail}\n      (onnistui: poista PENDING_ON-merkintä, vika on korjattu: ${result.pendingOn})`;
    }
    if (label === 'FAIL') failed += 1;
    if (label === 'HUOM') warned += 1;
    console.log(`${label}  ${result.name}\n      ${detail}`);
  }
  const passed = results.length - failed - pending - warned;
  console.log(`\nARJEN E2E: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${results.length}`
    + `${pending ? `, odottaa ${pending}` : ''}${warned ? `, huomioita ${warned}` : ''})`);
  process.exitCode = failed === 0 ? 0 : 1;
}

// Ajetaan vain suoraan käynnistettynä: testit importoivat puhtaat osat.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('ARJEN E2E: KESKEYTYI —', error.message);
    process.exitCode = 1;
  });
}
