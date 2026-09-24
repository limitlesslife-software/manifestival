// Pääseekö käyttäjä domainiin käsiksi?
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Portti avaa TALLENNUKSEN. Se ei avaa käyttöliittymää eikä luo
// näkymää. Taulu, RLS, repositorio ja domain-logiikka voivat olla
// täydellisiä samalla kun käyttäjä ei pääse ominaisuuteen lainkaan.
//
// Kaikki aiemmat tarkistukset katsoivat kantaa. Yksikään ei kysynyt,
// löytääkö käyttäjä ominaisuuden — ja siksi kolme puuttuvaa
// käyttöliittymää pääsi julkaisujunaan asti huomaamatta:
//
//   talous     ei näkymää lainkaan      -> aalto D estetty
//   projektit  ei näkymää lainkaan      -> aalto B osittainen
//   hyvinvointi näkymä oli, mutta nimellä "Miten menee?"
//
// Tämä tiedosto todentaa `tools/release/reachability.mjs` -matriisin
// jokaisen väitteen lähdekoodista. Matriisi ei siis ole proosaa vaan
// tarkistettu tila.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { REACH, REACHABILITY, reachabilityOf, unreachableGates }
  from '../tools/release/reachability.mjs';
import { ALL_GATES, WAVES, cumulativeGates } from '../tools/release/waves.mjs';

const NEWLINE = String.fromCharCode(10);

/** Kaikki käyttöliittymäkoodi yhtenä merkkijonona. */
function uiSource() {
  // LISTA ON NIMENOMAINEN. Uusi näkymä on lisättävä tänne käsin, ja se
  // on tarkoituksellista: näkymä joka ei ole tässä listassa ei ole
  // mukana tavoitettavuuden tarkistuksessa, ja juuri sellainen näkymä
  // jäi aiemmin löytymättä.
  const views = ['goals', 'goalDetail', 'notificationSettings', 'planning',
                 'profile', 'routines', 'tasks', 'today', 'week'];
  return [read('index.html'), ...views.map(v => read(`src/app/views/${v}.js`))]
    .join(NEWLINE);
}

// =====================================================================
// MATRIISI KATTAA KAIKEN
// =====================================================================

test('KRIITTINEN: jokaisella kymmenellä portilla on tavoitettavuusrivi', () => {
  assert.equal(REACHABILITY.length, ALL_GATES.length);
  for (const gate of ALL_GATES) {
    const row = reachabilityOf(gate);
    assert.ok(row, `portilta ${gate} puuttuu tavoitettavuusrivi`);
    assert.ok(Object.values(REACH).includes(row.reach),
      `${gate}: tuntematon tila ${row.reach}`);
    assert.ok(row.note && row.note.length > 20,
      `${gate}: perustelu puuttuu tai on liian lyhyt`);
  }
});

// =====================================================================
// TAVOITETTAVAKSI VÄITETTY ON OIKEASTI TAVOITETTAVISSA
// =====================================================================

test('KRIITTINEN: tavoitettavan domainin todiste löytyy lähdekoodista', () => {
  for (const row of REACHABILITY) {
    if (row.reach !== REACH.REACHABLE) continue;

    assert.ok(row.evidence, `${row.gate}: todiste puuttuu`);
    assert.ok(row.label, `${row.gate}: näkyvä nimi puuttuu`);
    assert.ok(row.nav, `${row.gate}: navigointipolku puuttuu`);

    // Näkymätiedosto on olemassa ja se on oikeasti käyttöliittymäkoodia.
    const view = read(row.evidence.view);
    assert.ok(view.length > 0, `${row.gate}: näkymätiedostoa ei ole`);

    // Väitetty HTML-tunniste on index.html:ssä JA näkymä renderöi siihen.
    if (row.evidence.html) {
      assert.ok(read('index.html').includes(`id="${row.evidence.html}"`),
        `${row.gate}: index.html:stä puuttuu id="${row.evidence.html}"`);
      assert.ok(view.includes(row.evidence.html),
        `${row.gate}: ${row.evidence.view} ei viittaa tunnisteeseen`
        + ` ${row.evidence.html}`);
    }
  }
});

test('KRIITTINEN: käyttäjän näkemä nimi esiintyy käyttöliittymässä', () => {
  // TÄMÄ ON SE TESTI, JOKA OLISI LÖYTÄNYT HYVINVOINTIVIAN.
  //
  // Näkymä oli olemassa ja toimi, mutta sanaa "hyvinvointi" ei
  // esiintynyt käyttöliittymässä kertaakaan — otsikko oli "Miten
  // menee?". Käyttäjä etsi sitä nimellä eikä voinut löytää.
  const ui = uiSource();

  for (const row of REACHABILITY) {
    if (row.reach !== REACH.REACHABLE) continue;
    assert.ok(ui.includes(row.label),
      `${row.gate}: nimeä "${row.label}" ei esiinny käyttöliittymässä,`
      + ' joten sitä etsivä käyttäjä ei löydä ominaisuutta');
  }
});

test('KRIITTINEN: hyvinvointi löytyy nimellä eikä pelkällä kysymyksellä', () => {
  // Erikseen kirjoitettu auki, koska tämä on se yksittäinen korjaus
  // jonka käyttäjä pyysi.
  const today = read('src/app/views/today.js');

  // Haku ALKAA lohkon kohdalta. Tiedostossa on useampi <summary>, ja
  // ensimmäinen niistä on eri lohkossa ("Tehty").
  const alku = today.indexOf('<details class="wellbeing-block">');
  assert.ok(alku > -1, 'hyvinvointilohkoa ei löytynyt');
  const summary = today.slice(alku, today.indexOf('</summary>', alku));
  assert.ok(summary.includes('Hyvinvointi'),
    'hyvinvointilohkon otsikko ei sisällä sanaa Hyvinvointi');
  assert.ok(read('index.html').includes('id="todayWellbeing"'),
    'hyvinvointilohkon säiliö puuttuu index.html:stä');
});

// =====================================================================
// PUUTTUVAKSI VÄITETTY ON OIKEASTI PUUTTUVA
// =====================================================================

test('KRIITTINEN: puuttuvaksi merkittyä domainia ei ole käyttöliittymässä', () => {
  // Tämä on matriisin tärkein ehto. Jos joku rakentaa talouden
  // käyttöliittymän, tämä testi kaatuu — ja silloin aallon D
  // valmiustila, hyväksyntäpaketti ja docs/UI-REACHABILITY.md on
  // päivitettävä samassa yhteydessä.
  //
  // Puuttuva ominaisuus ei voi hiljaa muuttua olemassa olevaksi eikä
  // päinvastoin.
  const ui = uiSource();

  const MERKIT = {
    projects: ['Projektit', 'projectsRepo', 'getState().projects'],
    recurringExpenses: ['Toistuvat kulut', 'recurringExpensesRepo'],
    savingsGoals: ['Säästötavoitteet', 'savingsGoalsRepo'],
    bills: ['Laskut', 'billsRepo']
  };

  for (const gate of unreachableGates()) {
    for (const merkki of MERKIT[gate] || []) {
      assert.equal(ui.includes(merkki), false,
        `${gate} on merkitty puuttuvaksi, mutta käyttöliittymässä on`
        + ` "${merkki}". Päivitä tools/release/reachability.mjs,`
        + ' aallon valmiustila ja docs/UI-REACHABILITY.md.');
    }
  }

  // JOKAINEN KYMMENESTÄ DOMAINISTA ON NYT TAVOITETTAVISSA.
  //
  // Aiemmin tässä oli neljä puuttuvaa: projektit ja talouden kolme.
  // Ne rakennettiin olemassa olevan domain-mallin päälle. Jos joukko
  // muuttuu kumpaan tahansa suuntaan, tämä kaatuu ja pakottaa
  // päivittämään aaltojen valmiustilan ja dokumentaation.
  assert.deepEqual([...unreachableGates()].sort(), [],
    'puuttuvien joukko muuttui — päivitä dokumentaatio ja aaltojen valmius');
});

test('KRIITTINEN: puuttuva käyttöliittymä ei silti riko latauspolkua', () => {
  // Rivit ladataan tilaan vaikka niitä ei renderöidä. Se on
  // vaaratonta ja tarkoituksellista: kun käyttöliittymä joskus
  // rakennetaan, data on jo paikallaan.
  //
  // Olennaista on, ETTEI lataus kaadu puuttuvaan näkymään.
  const actions = read('src/app/actions.js');
  for (const setter of ['setBills', 'setRecurringExpenses',
                        'setSavingsGoals', 'setProjects']) {
    assert.ok(actions.includes(setter),
      `latauspolku ei aseta ${setter} — data katoaisi kun UI rakennetaan`);
  }
});

// =====================================================================
// AALLON VALMIUS VASTAA TAVOITETTAVUUTTA
// =====================================================================

test('KRIITTINEN: aallon valmiustila vastaa sen domainien tavoitettavuutta', () => {
  // Juna ei saa väittää valmiiksi aaltoa, jonka ominaisuuteen käyttäjä
  // ei pääse. Tämä johtaa valmiustilan tavoitettavuudesta eikä luota
  // käsin kirjoitettuun arvoon.
  for (const wave of WAVES) {
    const rows = wave.gates.map(reachabilityOf);
    const puuttuvia = rows.filter(r => r.reach === REACH.NO_UI).length;

    let odotettu;
    if (puuttuvia === 0) odotettu = 'READY';
    else if (puuttuvia === wave.gates.length) odotettu = 'BLOCKED';
    else odotettu = 'PARTIAL';

    assert.equal(wave.readiness, odotettu,
      `aalto ${wave.id}: valmiustila on ${wave.readiness}, mutta`
      + ` ${puuttuvia}/${wave.gates.length} domainilta puuttuu käyttöliittymä`);
  }
});

test('KRIITTINEN: estetty aalto on merkitty estetyksi myös paketissaan', () => {
  for (const wave of WAVES) {
    const paketti = read(`docs/acceptance/WAVE-${wave.id}.md`);

    if (wave.readiness === 'BLOCKED') {
      assert.match(paketti, /VALMIUS: ESTETTY/,
        `WAVE-${wave.id}.md ei varoita, ettei aaltoa saa deployata`);
    }
    if (wave.readiness === 'PARTIAL') {
      assert.match(paketti, /VALMIUS: OSITTAINEN/,
        `WAVE-${wave.id}.md ei kerro, että osa domaineista on käyttökelvoton`);
    }
    if (wave.readiness === 'READY') {
      assert.equal(/VALMIUS: (ESTETTY|OSITTAINEN)/.test(paketti), false,
        `WAVE-${wave.id}.md varoittaa vaikka aalto on valmis`);
    }
  }
});

test('KRIITTINEN: tavoitettavuusdokumentti vastaa matriisia', () => {
  const doc = read('docs/UI-REACHABILITY.md');

  for (const row of REACHABILITY) {
    assert.ok(doc.includes('`' + row.gate + '`'),
      `docs/UI-REACHABILITY.md ei mainitse porttia ${row.gate}`);
  }
  for (const gate of unreachableGates()) {
    assert.ok(doc.includes(gate), `puuttuva domain ${gate} ei ole dokumentissa`);
  }

  // Jokaisella tavoitettavalla domainilla on dokumentissa se nimi,
  // jolla käyttäjä sen löytää.
  for (const row of REACHABILITY) {
    if (row.reach !== REACH.REACHABLE) continue;
    assert.ok(doc.includes(row.label),
      `dokumentti ei kerro nimeä "${row.label}" (${row.gate})`);
  }

  // Ja se kuvaa rahan ja päivien sopimukset, jotka talousosio toi.
  assert.match(doc, /sentte/i, 'dokumentti ei kerro rahan yksikköä');
  assert.match(doc, /pilkku/i, 'dokumentti ei kerro desimaalierottimista');
});

// =====================================================================
// NAVIGAATIO
// =====================================================================

test('KRIITTINEN: jokainen navigaatiovälilehti johtaa olemassa olevaan näkymään', () => {
  const html = read('index.html');
  const screens = [...html.matchAll(/data-screen="([^"]+)"/g)].map(m => m[1]);

  assert.ok(screens.length >= 5, `välilehtiä löytyi vain ${screens.length}`);
  for (const screen of new Set(screens)) {
    assert.ok(html.includes(`id="${screen}"`),
      `välilehti ${screen} osoittaa näkymään jota ei ole`);
  }

  // Ja navigointimoduuli tuntee täsmälleen samat näkymät.
  const nav = read('src/app/navigation.js');
  for (const screen of new Set(screens)) {
    assert.ok(nav.includes(`'${screen}'`),
      `navigation.js ei tunne näkymää ${screen}`);
  }
});

test('KRIITTINEN: perustilan hyväksyntäpaketti kattaa jokaisen osion', () => {
  // Paketti on se, jonka mukaan käyttäjä testaa. Jos osio puuttuu
  // siitä, sitä ei testata — ja juuri niin talous jäi aiemmin
  // huomaamatta.
  const paketti = read('docs/acceptance/BASE-FIX.md');

  // RAJAUS AALTOIHIN A-E.
  //
  // Perustilan korjaus on deployattu commit, ja sen hyväksyntäpaketti
  // on tietue siitä mitä silloin testattiin. Myöhempi työ ei voi
  // lisätä siihen osioita jälkikäteen -- yritys tekisi paketista
  // väitteen hyväksynnästä, jota ei tehty.
  //
  // Uudemmat domainit kuuluvat oman aaltonsa pakettiin, ja testi
  // "paketti kertoo oikeat portit" vartioi sitä.
  const perustilanPortit = new Set(cumulativeGates('E'));

  for (const row of REACHABILITY) {
    if (row.reach !== REACH.REACHABLE) continue;
    if (!perustilanPortit.has(row.gate)) continue;
    assert.ok(paketti.includes(row.label),
      `BASE-FIX.md ei ohjaa tarkistamaan osiota "${row.label}"`);
  }

  // Ja uudemmat domainit ovat oman aaltonsa paketissa.
  for (const row of REACHABILITY) {
    if (row.reach !== REACH.REACHABLE) continue;
    if (perustilanPortit.has(row.gate)) continue;

    const wave = WAVES.find(w => w.gates.includes(row.gate));
    assert.ok(wave, `${row.gate} ei ole missään aallossa`);
    assert.ok(read(`docs/acceptance/WAVE-${wave.id}.md`).includes(row.label),
      `WAVE-${wave.id}.md ei ohjaa tarkistamaan osiota "${row.label}"`);
  }

  // Ja se kertoo mitä EI pidä odottaa: portit ovat kiinni, joten uusi
  // rivi ei säily sivun latauksen yli.
  assert.match(paketti, /portit ovat kiinni/i,
    'paketti ei kerro, ettei tieto vielä säily');
  assert.ok(paketti.includes('UI-REACHABILITY.md'),
    'ei viittaa tavoitettavuusdokumenttiin');
});

test('kumulatiiviset portit kattavat kaikki tavoitettavuusrivit', () => {
  // Junan VIIMEINEN aalto luetaan määrittelystä eikä kirjoiteta tähän
  // kirjaimena. Aallon lisääminen olisi muuten muutos kahteen paikkaan,
  // ja tämä testi kertoisi vanhentuneen totuuden hiljaa.
  const kaikki = new Set(cumulativeGates(WAVES[WAVES.length - 1].id));
  for (const row of REACHABILITY) {
    assert.ok(kaikki.has(row.gate), `${row.gate} ei ole missään aallossa`);
  }
});
