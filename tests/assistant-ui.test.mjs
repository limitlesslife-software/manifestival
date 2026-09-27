// Avustajan käyttöliittymä, portit ja kirjausketjun turvarajat.
//
// =====================================================================
// MITÄ TÄMÄ ERITYISESTI VARTIOI
// =====================================================================
//
//   1. ÄÄNTÄ EI TALLENNETA. Puhesyötteen sovitin antaa tekstin eikä
//      mitään muuta, eikä kirjausketjussa ole tallennusta.
//
//   2. REITTI EI OLE KUTSU. Mallin nimeämä toiminto ratkaistaan
//      NIMETYSTÄ luettelosta. Dynaaminen haku antaisi mallin nimetä
//      minkä tahansa viedyn funktion — myös `deleteTask`.
//
//   3. KOORDINAATTEJA EI OLE missään kerroksessa: ei domainissa, ei
//      repositoriossa, ei käyttöliittymässä, ei migraatiossa.
//
//   4. PORTIN OLLESSA KIINNI kantaan ei oteta yhteyttä, ja
//      käyttöliittymä sanoo sen ääneen.
//
// Näkymiä ei renderöidä: DOMia ei ole. Tarkistukset kohdistuvat
// lähdekoodiin, repositorioiden rivimuunnoksiin ja HTML-runkoon.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import {
  inboxRepo, remindersRepo, noticesRepo, travelPlansRepo, locationRulesRepo,
  ALL_REPOSITORIES, volatileCollections
} from '../src/data/collectionsRepo.js';
import { TABLES, pendingTables } from '../src/data/schema.js';
import { TASKS_SEGMENTS } from '../src/app/state.js';
import { REACHABILITY, REACH, reachabilityOf }
  from '../tools/release/reachability.mjs';

const NEWLINE = String.fromCharCode(10);

/** Lähdekoodi ilman kommenttirivejä. Kommentti ei ole toteutus. */
function code(path) {
  return read(path)
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*')
      && !line.trim().startsWith('/*'))
    .join(NEWLINE);
}

/** Avustajan kaikki kerrokset yhtenä joukkona. */
const LAYERS = Object.freeze([
  'src/domain/inbox.js',
  'src/domain/capture.js',
  'src/domain/reminder.js',
  'src/domain/travel.js',
  'src/domain/notificationCenter.js',
  'src/domain/assistant.js',
  'src/app/capture.js',
  'src/app/assistantActions.js',
  'src/app/speechInput.js',
  'src/app/views/inbox.js',
  'src/app/views/reminders.js',
  'src/app/views/travel.js',
  'src/app/views/notices.js'
]);

// =====================================================================
// ÄÄNTÄ EI TALLENNETA
// =====================================================================

test('KRIITTINEN: puhesyöte ei tallenna ääntä mihinkään', () => {
  // Äänitallenne kertoo ihmisestä paljon enemmän kuin se mitä hän
  // sanoi. Tunnistin antaa tekstin, ja äänivirta katoaa.
  const adapter = code('src/app/speechInput.js');

  for (const kielletty of ['MediaRecorder', 'getUserMedia', 'AudioContext',
    'createMediaStreamSource', 'Blob(']) {
    assert.equal(adapter.includes(kielletty), false,
      `speechInput.js käyttää rakennetta ${kielletty} — se tallentaisi ääntä`);
  }

  assert.equal(/localStorage|sessionStorage|indexedDB/i.test(adapter), false,
    'speechInput.js kirjoittaa selaimen varastoon');
});

test('KRIITTINEN: kirjausketjussa ei ole äänikenttää', () => {
  // Rivi kantaa LITTEROINNIN, koska litterointi on silloin se mitä
  // käyttäjä sanoi — ei välivaihe matkalla johonkin muuhun.
  for (const tiedosto of ['src/domain/inbox.js', 'src/app/capture.js',
    'src/data/collectionsRepo.js']) {
    const source = code(tiedosto);
    assert.equal(/\baudio(Url|Blob|Data)?\s*[:=]/i.test(source), false,
      `${tiedosto}: kirjausketjussa on äänikenttä`);
    assert.equal(/recordingUrl|voiceClip/i.test(source), false,
      `${tiedosto}: kirjausketjussa on äänitallenne`);
  }
});

test('KRIITTINEN: kirjausketju ei kirjoita selaimen varastoon', () => {
  // Kirjaus menee kantaan tai istunnon muistiin — ei levylle. Levylle
  // kirjoitettu kirjaus jäisi seuraavan käyttäjän löydettäväksi.
  for (const tiedosto of ['src/app/capture.js', 'src/app/views/inbox.js',
    'src/app/assistantActions.js']) {
    const source = code(tiedosto);
    assert.equal(/localStorage/.test(source), false,
      `${tiedosto}: kirjoittaa localStorageen`);
    assert.equal(/sessionStorage/.test(source), false,
      `${tiedosto}: kirjoittaa sessionStorageen`);
    assert.equal(/indexedDB/i.test(source), false,
      `${tiedosto}: kirjoittaa IndexedDB:hen`);
  }
});

// =====================================================================
// REITTI EI OLE KUTSU
// =====================================================================

test('KRIITTINEN: reitin toiminto ratkaistaan nimetystä luettelosta', () => {
  const source = read('src/app/capture.js');

  // Luettelo on olemassa ja se on jäädytetty.
  assert.match(source, /const ROUTE_ACTIONS = Object\.freeze\(\{/,
    'reittiluetteloa ei ole tai sitä ei ole jäädytetty');

  // Ja siinä on VAIN luovia toimintoja.
  const block = source.slice(
    source.indexOf('const ROUTE_ACTIONS'),
    source.indexOf('});', source.indexOf('const ROUTE_ACTIONS')));

  const names = [...block.matchAll(/^\s{2}(\w+),?$/gm)].map(m => m[1]);
  assert.ok(names.length >= 6, `reittejä löytyi vain ${names.length}`);

  for (const name of names) {
    assert.match(name, /^create/,
      `reittiluettelossa on toiminto ${name}, joka ei luo mitään`);
  }
});

test('KRIITTINEN: kirjaus ei tuo yhtäkään poistavaa toimintoa', () => {
  const source = code('src/app/capture.js');

  // `deleteInboxItem` on tässä moduulissa määritelty ja se on
  // KÄYTTÄJÄN oma toiminto saapuvien rivin poistoon — ei reitti.
  // Tuotujen joukossa ei silti saa olla yhtäkään poistavaa.
  const imports = source.slice(0, source.indexOf('const ROUTE_ACTIONS'));

  for (const kielletty of ['deleteTask', 'deleteGoal', 'deleteProject',
    'deleteRoutine', 'deleteBill', 'deleteTransaction', 'deleteInvestment',
    'clearAllCollections']) {
    assert.equal(imports.includes(kielletty), false,
      `capture.js tuo poistavan toiminnon ${kielletty}`);
  }
});

test('KRIITTINEN: hyväksyntä tarkistaa päätetilan ennen kirjoitusta', () => {
  // Painikkeen kahdesti painaminen on tavallista, ei virhe. Jo
  // muunnettu rivi ei saa muuntua uudelleen.
  const source = read('src/app/capture.js');
  const start = source.indexOf('export async function approveItem');
  assert.ok(start > -1, 'approveItem ei löytynyt');

  const body = source.slice(start, source.indexOf('\n}', start));

  const tarkistus = body.indexOf('INBOX_STATUS.CONVERTED');
  const kutsu = body.indexOf('await action(');

  assert.ok(tarkistus > -1, 'approveItem ei tarkista päätetilaa');
  assert.ok(kutsu > -1, 'approveItem ei kutsu toimintoa');
  assert.ok(tarkistus < kutsu,
    'päätetila tarkistetaan vasta kirjoituksen jälkeen');

  // JA UUDELLEEN VAHVISTUKSEN JÄLKEEN. Vahvistus on odotus, ja rivi
  // voi muuttua sen aikana.
  const tarkistuksia = body.slice(0, kutsu).split('INBOX_STATUS.CONVERTED').length - 1;
  assert.ok(tarkistuksia >= 2,
    `päätetila tarkistettiin ${tarkistuksia} kertaa ennen kirjoitusta, `
    + 'odotettiin vähintään kaksi (ennen vahvistusta ja sen jälkeen)');
});

test('KRIITTINEN: jokainen reitti vaatii vahvistuksen ennen kutsua', () => {
  const source = read('src/app/capture.js');
  const start = source.indexOf('export async function approveItem');
  const body = source.slice(start, source.indexOf('\n}', start));

  const vahvistus = body.indexOf('confirmAction');
  const kutsu = body.indexOf('await action(');

  assert.ok(vahvistus > -1, 'approveItem ei kysy vahvistusta');
  assert.ok(vahvistus < kutsu, 'vahvistus kysytään vasta kirjoituksen jälkeen');
});

// =====================================================================
// KOORDINAATTEJA EI OLE
// =====================================================================

test('KRIITTINEN: yksikään kerros ei mainitse koordinaatteja kenttänä', () => {
  // Koordinaatti kannassa olisi koordinaatti varmuuskopiossa,
  // viennissä ja mahdollisessa vuodossa.
  const hahmo = /\b(latitude|longitude|coords?|coordinates|geolocation|geoFence)\s*[:=]/i;

  for (const tiedosto of [...LAYERS, 'src/data/collectionsRepo.js']) {
    const source = code(tiedosto);
    assert.equal(hahmo.test(source), false,
      `${tiedosto}: koordinaattikenttä lähdekoodissa`);
  }
});

test('KRIITTINEN: migraatio ei luo koordinaattisaraketta', () => {
  const migraatio = read('supabase/migrations/0011_personal_assistant.sql')
    .split(NEWLINE)
    .filter(rivi => !rivi.trim().startsWith('--'))
    .join(NEWLINE);

  assert.equal(/\b(lat|lon|latitude|longitude|coord|geom|geography|point)\s+\w/i
    .test(migraatio), false, 'migraatio luo koordinaattisarakkeen');
});

test('KRIITTINEN: varmistus etsii koordinaattisaraketta nimenomaisesti', () => {
  // Tämä on ainoa tarkistus koko varmistustiedostossa, joka etsii
  // jotain mitä EI SAA OLLA.
  const varmistus = read('supabase/verify/verify_0011.sql');
  assert.match(varmistus, /koordinaattisaraketta/,
    'varmistus ei etsi koordinaattisaraketta');
  assert.match(varmistus, /lat\|lon\|coord/,
    'varmistuksen koordinaattihaku ei kata odotettuja nimiä');
});

test('matkasuunnitelma tallentaa nimet eikä pisteitä', () => {
  const row = travelPlansRepo.mapping.toRow({
    id: 'p1', title: 'Hammaslääkäri', origin: 'Koti', destination: 'Keskusta',
    arrivalDate: '2026-09-11', arrivalTime: '10:00', mode: 'driving',
    travelMinutes: 25, travelSource: 'manual', estimatedAt: null,
    preparationMinutes: 10, arrivalBufferMinutes: 5, taskId: null, note: null
  });

  assert.equal(row.origin, 'Koti');
  assert.equal(row.destination, 'Keskusta');
  for (const key of Object.keys(row)) {
    assert.equal(/lat|lon|coord|geo|point/i.test(key), false,
      `riviin päätyi koordinaattisarake ${key}`);
  }
});

// =====================================================================
// PORTIT
// =====================================================================

test('KRIITTINEN: viisi avustajan porttia ovat yhdessä: kaikki kiinni tai kaikki auki', () => {
  // Sama migraatio (0011), sama aalto (H). Osittain avattu joukko
  // tarkoittaisi, että jokin kirjoitus menee tauluun jota ei ole.
  const tilat = ['inboxItems', 'reminders', 'notices', 'travelPlans', 'locationRules']
    .map(gate => TABLES[gate] === true);
  assert.ok(tilat.every(Boolean) || tilat.every(t => !t), `osittain auki: ${tilat}`);
});

test('kiinni oleva portti näkyy odottavien listalla, auki oleva ei', () => {
  const odottavat = new Set(pendingTables());
  for (const gate of ['inboxItems', 'reminders', 'notices', 'travelPlans',
    'locationRules']) {
    assert.equal(odottavat.has(gate), TABLES[gate] !== true,
      `portti ${gate}: odottavien lista ei vastaa porttia`);
  }
});

test('kiinni oleva kokoelma on haihtuvien listalla', () => {
  const haihtuvat = new Set(volatileCollections());
  for (const repo of [inboxRepo, remindersRepo, noticesRepo, travelPlansRepo,
    locationRulesRepo]) {
    const auki = TABLES[repo.schemaKey] === true;
    assert.equal(haihtuvat.has(repo.table), !auki,
      `${repo.table}: haihtuvien lista ei vastaa porttia`);
    assert.equal(repo.isPersistent(), auki,
      `${repo.table}: säilyvyysväite ei vastaa porttia`);
  }
});

test('KRIITTINEN: jokainen näkymä kertoo kun tieto ei säily', () => {
  // Käyttöliittymä ei saa väittää tallentavansa jotain mitä se ei
  // tallenna. Varoitus on sidottu porttiin, ei kirjoitettu käsin:
  // portin auetessa se katoaa itsestään.
  for (const tiedosto of ['src/app/views/inbox.js', 'src/app/views/reminders.js',
    'src/app/views/travel.js', 'src/app/views/notices.js']) {
    const source = read(tiedosto);
    // Näkymät lukevat portin ajonaikaisen accessorin kautta
    // (isTableAvailable = käännösaikainen JA kannan tarkistus), jotta
    // palvelimelta puuttuva ominaisuus ei väitä tallentuvansa.
    assert.match(source, /TABLES\.\w+|isTableAvailable\('\w+'\)/,
      `${tiedosto} ei lue porttia lainkaan`);
    assert.match(source, /istunnon ajan/,
      `${tiedosto} ei kerro, ettei tieto säily`);
  }
});

// =====================================================================
// KÄYTTÖLIITTYMÄN RUNKO
// =====================================================================

test('KRIITTINEN: jokaisen tavoitettavuusrivin tunniste on index.html:ssä', () => {
  const html = read('index.html');

  for (const gate of ['inboxItems', 'reminders', 'notices', 'travelPlans',
    'locationRules']) {
    const row = reachabilityOf(gate);
    assert.ok(row, `portilta ${gate} puuttuu tavoitettavuusrivi`);
    assert.equal(row.reach, REACH.REACHABLE,
      `portti ${gate} ei ole tavoitettavissa`);
    assert.ok(html.includes(`id="${row.evidence.html}"`),
      `index.html:stä puuttuu id="${row.evidence.html}"`);
  }
});

test('kirjauspalkki on olemassa ja sillä on saavutettava nimilappu', () => {
  const html = read('index.html');

  assert.ok(html.includes('id="captureInput"'), 'kirjauskenttä puuttuu');
  assert.ok(html.includes('id="captureSendBtn"'), 'kirjauspainike puuttuu');
  assert.ok(html.includes('id="captureMicBtn"'), 'mikrofonipainike puuttuu');

  // Kenttä ilman nimilappua on ruudunlukijalle nimetön.
  assert.match(html, /<label[^>]*for="captureInput"/,
    'kirjauskentältä puuttuu label');
  assert.match(html, /id="captureMicBtn"[^>]*aria-label=/,
    'mikrofonipainikkeelta puuttuu aria-label');
});

test('virheilmoituksilla ja tilaviesteillä on oikea rooli', () => {
  const html = read('index.html');
  assert.match(html, /id="captureError"[^>]*role="alert"/,
    'kirjauksen virheellä ei ole role="alert"');
  assert.match(html, /id="captureStatus"[^>]*role="status"/,
    'kirjauksen tilaviestillä ei ole role="status"');
});

test('jokaisella tekemisen osiolla on painike ja lohko', () => {
  const html = read('index.html');
  const tasks = read('src/app/views/tasks.js');

  for (const segment of TASKS_SEGMENTS) {
    const tab = `segment${segment.key.charAt(0).toUpperCase()}${segment.key.slice(1)}`;
    assert.ok(html.includes(`id="${tab}"`),
      `osiolta ${segment.key} puuttuu painike ${tab}`);
    assert.ok(tasks.includes(`'${segment.key}'`),
      `tasks.js ei tunne osiota ${segment.key}`);
  }

  for (const section of ['tasksSection', 'routinesSection', 'inboxSection',
    'remindersSection', 'travelSection']) {
    assert.ok(html.includes(`id="${section}"`),
      `lohko ${section} puuttuu index.html:stä`);
  }
});

test('jokaisella lomakekentällä on nimilappu', () => {
  const html = read('index.html');

  const kentat = ['rmTitle', 'rmDate', 'rmTime', 'rmUntil', 'rmTask', 'rmNote',
    'tvTitle', 'tvOrigin', 'tvDestination', 'tvDate', 'tvTime', 'tvMode',
    'tvMinutes', 'tvPrep', 'tvBuffer', 'tvTask',
    'lrPlace', 'lrTrigger', 'lrMessage'];

  for (const id of kentat) {
    assert.ok(html.includes(`id="${id}"`), `kenttä ${id} puuttuu`);
    assert.match(html, new RegExp(`for="${id}"`),
      `kentältä ${id} puuttuu nimilappu`);
  }
});

// =====================================================================
// KÄYTTÖLIITTYMÄ EI LUPAA LIIKAA
// =====================================================================

test('KRIITTINEN: muistutusnäkymä ei lupaa taustaherätystä', () => {
  // Käyttäjä, joka luulee saavansa hälytyksen suljetusta sovelluksesta,
  // jättää tekemättä sen mitä oli tekemässä.
  const source = read('src/app/views/reminders.js');

  assert.match(source, /sovellus on auki/,
    'muistutusnäkymä ei kerro, milloin muistutukset lasketaan');
  assert.match(source, /background\.capability\(\)/,
    'taustatuki kirjoitetaan käsin sen sijaan että se luettaisiin sovittimelta');
});

test('KRIITTINEN: matkanäkymä ei näytä lähtöaikaa tuntemattomasta kestosta', () => {
  const source = read('src/app/views/travel.js');
  const start = source.indexOf('function leaveByHtml');
  assert.ok(start > -1, 'leaveByHtml ei löytynyt');

  const body = source.slice(start, source.indexOf('\n}', start));

  // Tuntematon tarkistetaan ENNEN kuin kellonaikaa muodostetaan.
  const tarkistus = body.indexOf('departure.known');
  const kellonaika = body.indexOf('departure.message');

  assert.ok(tarkistus > -1, 'leaveByHtml ei tarkista tuntemattomuutta');
  assert.ok(tarkistus < kellonaika,
    'kellonaika muodostetaan ennen tuntemattomuuden tarkistusta');
});

test('KRIITTINEN: matkanäkymä ei väitä hakevansa matka-aikaa', () => {
  const source = read('src/app/views/travel.js');
  assert.match(source, /hasTravelProvider/,
    'näkymä ei lue palveluntarjoajan tilaa');
  assert.match(source, /ei haeta mist/,
    'näkymä ei kerro, ettei matka-aikaa haeta mistään');
});

test('KRIITTINEN: paikkamuistutusta ei luoda päällä olevana', () => {
  const source = read('src/app/views/travel.js');
  const start = source.indexOf('async function submitLocationRuleForm');
  const body = source.slice(start, source.indexOf('\n}', start));

  assert.equal(/active\s*:/.test(body), false,
    'lomake asettaa active-kentän — uusi sääntö voisi syntyä päällä');
});

test('KRIITTINEN: säännön päälle kytkeminen kysyy vahvistuksen', () => {
  const source = read('src/app/assistantActions.js');
  const start = source.indexOf('export async function toggleLocationRule');
  const body = source.slice(start, source.indexOf('\n}', start));

  assert.match(body, /confirmAction/,
    'päälle kytkeminen ei kysy vahvistusta');

  // JA VAIN PÄÄLLE. Pois kytkeminen on siirtymä turvallisempaan
  // suuntaan eikä tarvitse kitkaa.
  assert.match(body, /if \(active && !previous\.active\)/,
    'vahvistus kysytään myös pois kytkettäessä');
});

test('ilmoituskeskus tarjoaa vain domainin sallimat toiminnot', () => {
  const source = read('src/app/views/notices.js');
  assert.match(source, /actionsFor\(notice\)/,
    'toimintolista rakennetaan käsin domainin sijaan');
});

// =====================================================================
// UUUDELLEENKÄYTTÖ JA ELINKAARI
// =====================================================================

test('KRIITTINEN: uloskirjautuminen tyhjentää kesken olevan kirjauksen', () => {
  // Kirjauskenttä voi sisältää mitä tahansa, mitä edellinen käyttäjä
  // oli kirjoittamassa.
  const main = read('src/app/main.js');
  assert.match(main, /closeCaptureReview\(\)/,
    'uloskirjautuminen ei tyhjennä kirjausta');
  assert.match(main, /closeNoticeCenter\(\)/,
    'uloskirjautuminen ei nollaa ilmoituskeskusta');
  assert.match(main, /closeReminderForm\(\)/,
    'uloskirjautuminen ei sulje muistutuslomaketta');
  assert.match(main, /closeTravelForm\(\)/,
    'uloskirjautuminen ei sulje matkalomaketta');
});

test('hälytyskierros ei kaada sovellusta verkkovirheestä', () => {
  const main = read('src/app/main.js');
  const start = main.indexOf('function runAssistantSweeps');
  assert.ok(start > -1, 'hälytyskierrosta ei ole');

  const body = main.slice(start, main.indexOf('\n}', start));
  assert.match(body, /\.catch\(/,
    'hälytyskierros ei nappaa virhettä — verkkovirhe kaataisi käyttöliittymän');
});

test('avustajan kokoelmat ladataan vaikka näkymä puuttuisi', () => {
  // Jos lataus jätettäisiin tekemättä, tieto katoaisi sinä hetkenä
  // kun näkymä rakennetaan.
  const actions = read('src/app/actions.js');
  for (const setter of ['setInboxItems', 'setReminders', 'setNotices',
    'setTravelPlans', 'setLocationRules']) {
    assert.ok(actions.includes(setter),
      `latauspolku ei aseta ${setter}`);
  }
});

test('jokaisella uudella repositoriolla on portti ja normalisointi', () => {
  for (const repo of [inboxRepo, remindersRepo, noticesRepo, travelPlansRepo,
    locationRulesRepo]) {
    assert.ok(repo.schemaKey, `${repo.table}: schemaKey puuttuu`);
    assert.ok(repo.schemaKey in TABLES,
      `${repo.table}: schemaKey ${repo.schemaKey} ei ole porttitaulussa`);
    assert.equal(typeof repo.mapping.toRow, 'function');
    assert.equal(typeof repo.mapping.fromRow, 'function');
    assert.equal(typeof repo.mapping.normalize, 'function');
  }
});

test('repositorioita on kolmekymmentäkolme', () => {
  // Luku on käsin laskettu ja tarkoituksella: uusi repositorio kaataa
  // tämän, ja se on oikea hetki tarkistaa, että sillä on portti,
  // migraatio, varmistus ja tavoitettavuusrivi. 0013 toi kaksi:
  // running_timers ja alignment_item_settings. 0014 toi kymmenen
  // (arjen käyttöjärjestelmä).
  assert.equal(ALL_REPOSITORIES.length, 33,
    `repositorioita on ${ALL_REPOSITORIES.length}`);
});

test('tavoitettavuusmatriisi kattaa kaikki kolmekymmentäneljä', () => {
  // 0013 toi kaksi porttia: runningTimers ja alignmentItemSettings.
  // 0014 toi kymmenen. Niiden näkymät rakennetaan erikseen: siihen asti
  // ne ovat rehellisesti ilman käyttöliittymää (aalto K ESTETTY), ja
  // joukko luetellaan nimeltä.
  assert.equal(REACHABILITY.length, 34);
  assert.deepEqual(REACHABILITY.filter(r => r.reach === REACH.NO_UI).map(r => r.gate).sort(),
    ['calendarEvents', 'commuteObservations', 'exerciseSessions', 'habitEvents', 'habitPlans',
      'lifeSettings', 'placeAliases', 'savedPlaces', 'sleepLogs', 'wellbeingCheckins'],
    'jokin muu kuin aallon K domain on ilman käyttöliittymää');
});
