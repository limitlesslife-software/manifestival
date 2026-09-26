// Talous 2.0 -- käyttöliittymä, portit ja kuvan elinkaari.
//
// MITÄ TÄMÄ ERITYISESTI VARTIOI
//
//   1. Kuitin kuva ei päädy mihinkään pysyvään.
//   2. Portin ollessa kiinni kantaan ei oteta yhteyttä lainkaan.
//   3. Portin auettua lähtevä rivi on täsmälleen migraation mukainen.
//   4. Käyttöliittymä ei väitä maksavansa laskuja.
//
// Näkymiä ei renderöidä tässä: DOMia ei ole. Tarkistukset kohdistuvat
// lähdekoodiin ja repositorioiden rivimuunnoksiin, jotka ovat
// tarkasteltavissa myös portin ollessa kiinni.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import {
  transactionsRepo, investmentsRepo, billsRepo, ALL_REPOSITORIES
} from '../src/data/collectionsRepo.js';
import {
  TABLES, BILL_PAYMENT_FIELDS, volatileBillFields, pendingTables
} from '../src/data/schema.js';
import { fitWithin } from '../src/app/receiptCapture.js';

const NEWLINE = String.fromCharCode(10);

// =====================================================================
// KUVAN ELINKAARI
// =====================================================================

test('KRIITTINEN: kuvaa ei tallenneta mihinkään pysyvään', () => {
  // Kuitin kuva kertoo missä olit, milloin ja mitä ostit. Ainoa
  // turvallinen tapa käsitellä sitä on olla säilyttämättä sitä.
  const lahteet = [
    'src/app/receiptCapture.js',
    'src/app/views/transactions.js',
    'src/app/actions.js',
    'src/app/state.js'
  ];

  for (const tiedosto of lahteet) {
    const koodi = read(tiedosto)
      .split(NEWLINE)
      .filter(rivi => !rivi.trim().startsWith('//') && !rivi.trim().startsWith('*'))
      .join(NEWLINE);

    assert.equal(/localStorage/.test(koodi), false,
      `${tiedosto}: kuvaketju koskee localStorageen`);
    assert.equal(/sessionStorage/.test(koodi), false,
      `${tiedosto}: kuvaketju koskee sessionStorageen`);
    assert.equal(/indexedDB/i.test(koodi), false,
      `${tiedosto}: kuvaketju koskee IndexedDB:hen`);
    assert.equal(/\.storage\b/.test(koodi), false,
      `${tiedosto}: kuvaketju koskee Supabase Storageen`);
  }
});

test('KRIITTINEN: tiedostovalitsin tyhjennetään aina', () => {
  // <input type="file"> pitää valitun tiedoston muistissa niin kauan
  // kuin arvo on asetettu. Ilman tyhjennystä kuitti jäisi elämään
  // DOMiin senkin jälkeen kun luenta on hyväksytty.
  const capture = read('src/app/receiptCapture.js');
  assert.match(capture, /export function releaseFileInput/,
    'vapautusfunktiota ei ole');

  const view = read('src/app/views/transactions.js');
  assert.ok(view.includes('releaseFileInput'), 'näkymä ei vapauta valitsinta');

  // Ja vapautus tapahtuu finally-lohkossa: epäonnistunut luenta ei saa
  // jättää kuvaa DOMiin.
  const handler = view.slice(view.indexOf('async function handleFileChosen'));
  const body = handler.slice(0, handler.indexOf(NEWLINE + '}'));
  assert.ok(body.includes('finally'), 'vapautus ei ole finally-lohkossa');
  assert.ok(body.includes('releaseFileInput'), 'finally ei vapauta valitsinta');
});

test('KRIITTINEN: object-URL vapautetaan aina', () => {
  const capture = read('src/app/receiptCapture.js');
  const prepare = capture.slice(capture.indexOf('export async function prepareImage'));
  const body = prepare.slice(0, prepare.indexOf(NEWLINE + '}'));

  assert.ok(body.includes('createObjectURL'), 'object-URL ei ole käytössä');
  assert.ok(body.includes('finally'), 'vapautus ei ole finally-lohkossa');
  assert.ok(body.includes('revokeObjectURL'), 'object-URL jää vapauttamatta');
});

test('kuva pienennetään ennen lähetystä eikä koskaan suurenneta', () => {
  // Pienempi kuva on vähemmän tietoa. Suurentaminen ei lisäisi tietoa
  // mutta kasvattaisi lähetettävää määrää.
  assert.deepEqual(fitWithin(4000, 3000), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(3000, 4000), { width: 1200, height: 1600 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(1600, 1600), { width: 1600, height: 1600 });

  // Mahdottomat mitat eivät kaada mitään.
  assert.deepEqual(fitWithin(0, 0), { width: 1, height: 1 });
  assert.deepEqual(fitWithin(-5, 10), { width: 1, height: 1 });
});

test('KRIITTINEN: luennassa ei kulje kuvaa tilaan asti', () => {
  // Tila on se paikka, josta kuva päätyisi vahingossa vientiin,
  // lokiin tai kantaan. Sinne menee vain luenta.
  const state = read('src/app/state.js');
  const pending = state.slice(state.indexOf('pendingExtraction'));

  assert.equal(/image|photo|base64|dataUrl/i.test(pending.slice(0, 800)), false,
    'tilan luentakenttä mainitsee kuvan');
});

test('palvelin ei lokita kuvadataa', () => {
  // Base64-pätkä lokissa olisi juuri se kuitti, jota ei ollut
  // tarkoitus säilyttää.
  const extract = read('api/extract.js');

  for (const rivi of extract.split(NEWLINE)) {
    if (!rivi.includes('console.')) continue;
    assert.equal(/\bimage\b|\bbase64\b|validation\.value|req\.body/.test(rivi), false,
      `lokirivi voi sisältää kuvadataa: ${rivi.trim()}`);
  }
});

test('palvelin ei palauta kuvaa vastauksessa', () => {
  const extract = read('api/extract.js');
  const vastaus = [...extract.matchAll(/res\.status\(200\)\.json\(([^;]+)\)/g)];
  assert.ok(vastaus.length > 0, 'onnistunutta vastausta ei löytynyt');

  for (const [, runko] of vastaus) {
    assert.equal(/image|base64/i.test(runko), false,
      `vastaus sisältää kuvan: ${runko}`);
  }
});

// =====================================================================
// PORTIT
// =====================================================================

test('KRIITTINEN: Talous 2.0:n portit ovat kiinni', () => {
  // Migraatiota 0009 ei ole ajettu. Auki oleva portti kaataisi
  // jokaisen kirjoituksen koodilla 42P01 tai 42703.
  assert.equal(TABLES.transactions, false);
  assert.equal(TABLES.investments, false);
  assert.equal(BILL_PAYMENT_FIELDS, false);

  assert.ok(pendingTables().includes('transactions'));
  assert.ok(pendingTables().includes('investments'));
});

test('KRIITTINEN: portin ollessa kiinni tieto ei väitä säilyvänsä', () => {
  assert.equal(transactionsRepo.isPersistent(), false);
  assert.equal(investmentsRepo.isPersistent(), false);
  assert.deepEqual(volatileBillFields(), ['payee', 'iban', 'reference']);
});

test('KRIITTINEN: kiinni oleva portti käyttää muistivarastoa', async () => {
  // Ei tietokantayhteyttä: getClient() heittäisi, koska asiakasta ei
  // ole asetettu. Jos nämä menevät läpi, tietokantapolkua ei ajettu.
  const tapahtuma = await transactionsRepo.insert({
    id: 'ui-t-1', kind: 'expense', amountMinor: 1250,
    date: '2026-09-10', category: 'ruoka'
  });
  assert.equal(tapahtuma.ok, true);

  const sijoitus = await investmentsRepo.insert({
    id: 'ui-i-1', name: 'Rahasto', kind: 'fund', costBasisMinor: 100000
  });
  assert.equal(sijoitus.ok, true);

  const lista = await transactionsRepo.list();
  assert.ok(lista.value.some(r => r.id === 'ui-t-1'));

  transactionsRepo.clear();
  investmentsRepo.clear();
});

test('uudet repositoriot ovat mukana latauksessa ja tyhjennyksessä', () => {
  const taulut = ALL_REPOSITORIES.map(repo => repo.table);
  assert.ok(taulut.includes('transactions'));
  assert.ok(taulut.includes('investments'));

  // Ja lataus hakee ne. Ilman tätä portin avaaminen ei näyttäisi
  // mitään ennen sivun uudelleenlatausta.
  const actions = read('src/app/actions.js');
  assert.ok(actions.includes('transactionsRepo.list()'));
  assert.ok(actions.includes('investmentsRepo.list()'));
});

// =====================================================================
// RIVIMUUNNOS VASTAA MIGRAATIOTA
// =====================================================================
//
// Portti on kiinni, joten tietokantapolkua ei voi ajaa. `mapping`
// paljastaa muunnoksen sellaisenaan, jotta voidaan tarkistaa
// TÄSMÄLLEEN mitä kantaan lähtisi portin auettua -- avaamatta sitä.

const MIGRAATIO = read('supabase/migrations/0009_finance_2.sql');

/** Taulun sarakkeet migraation create table -lauseesta. */
function sarakkeet(taulu) {
  const osa = new RegExp(`create table public\\.${taulu} \\(([\\s\\S]*?)\\n\\);`)
    .exec(MIGRAATIO);
  assert.ok(osa, `migraatiosta ei löydy taulua ${taulu}`);

  return osa[1].split(NEWLINE)
    .map(rivi => rivi.trim())
    .filter(rivi => rivi && !rivi.startsWith('--'))
    .map(rivi => rivi.split(/\s+/)[0])
    .filter(nimi => /^[a-z_]+$/.test(nimi));
}

test('KRIITTINEN: tapahtuman rivimuunnos vastaa migraatiota 0009', () => {
  const rivi = transactionsRepo.mapping.toRow(
    transactionsRepo.mapping.normalize({
      id: 't1', kind: 'income', amountMinor: 250000, currency: 'EUR',
      date: '2026-09-01', category: 'palkka', description: 'Palkka',
      note: 'syyskuu', sourceKind: 'bill', sourceId: 'b1'
    }));

  const kannassa = new Set(sarakkeet('transactions'));

  for (const kentta of Object.keys(rivi)) {
    assert.ok(kannassa.has(kentta),
      `rivimuunnos lähettää saraketta jota ei ole: ${kentta}`);
  }

  // Palvelimen omistamia kenttiä ei lähetetä.
  for (const kielletty of ['user_id', 'created_at', 'updated_at']) {
    assert.equal(kielletty in rivi, false,
      `client lähettää palvelimen kenttää: ${kielletty}`);
  }

  // Ja summa on kokonaisluku sentteinä.
  assert.equal(Number.isInteger(rivi.amount_minor), true);
  assert.equal(rivi.amount_minor > 0, true);
});

test('KRIITTINEN: sijoituksen rivimuunnos vastaa migraatiota 0009', () => {
  const rivi = investmentsRepo.mapping.toRow(
    investmentsRepo.mapping.normalize({
      id: 'h1', name: 'ETF', symbol: 'IWDA', kind: 'etf', quantity: 12.5,
      costBasisMinor: 250000, currentValueMinor: 300000,
      valuedOn: '2026-09-01', valueSource: 'manual', currency: 'EUR',
      targetValueMinor: 500000, note: 'kuukausisäästö'
    }));

  const kannassa = new Set(sarakkeet('investments'));

  for (const kentta of Object.keys(rivi)) {
    assert.ok(kannassa.has(kentta),
      `rivimuunnos lähettää saraketta jota ei ole: ${kentta}`);
  }

  for (const kielletty of ['user_id', 'created_at', 'updated_at']) {
    assert.equal(kielletty in rivi, false);
  }

  // MÄÄRÄ EI OLE RAHAA: se saa olla murtoluku.
  assert.equal(rivi.quantity, 12.5);
  assert.equal(Number.isInteger(rivi.cost_basis_minor), true);
});

test('KRIITTINEN: laskun maksutietoja EI lähetetä portin ollessa kiinni', () => {
  // Sarakkeet payee, iban ja reference syntyvät migraatiossa 0009.
  // Niiden lähettäminen -- NULLINAKIN -- kaataisi jokaisen laskun
  // tallennuksen koodilla 42703.
  const rivi = billsRepo.mapping.toRow(
    billsRepo.mapping.normalize({
      id: 'b1', name: 'Sähkö', amountMinor: 4550, dueDate: '2026-09-20',
      payee: 'Sähköyhtiö', iban: 'FI21 1234 5600 0007 85', reference: '123'
    }));

  assert.equal(BILL_PAYMENT_FIELDS, false, 'testi olettaa portin olevan kiinni');

  for (const kentta of ['payee', 'iban', 'reference']) {
    assert.equal(kentta in rivi, false,
      `maksutieto ${kentta} lähetettiin vaikka saraketta ei ole`);
  }
});

test('laskun maksutiedot säilyvät domain-mallissa vaikka niitä ei lähetetä', () => {
  // Portin ollessa kiinni tieto elää istunnon muistissa. Se ei saa
  // kadota mallista -- vain kantaan lähettämisestä.
  const lasku = billsRepo.mapping.normalize({
    id: 'b1', name: 'Sähkö', amountMinor: 4550, dueDate: '2026-09-20',
    payee: 'Sähköyhtiö', iban: 'fi21 1234 5600 0007 85', reference: '1234 56789'
  });

  assert.equal(lasku.payee, 'Sähköyhtiö');
  assert.equal(lasku.iban, 'FI21 1234 5600 0007 85', 'IBAN ei siistiytynyt');
  assert.equal(lasku.reference, '1234 56789');
});

test('IBAN siistiytyy mutta ei hylkää tuntematonta muotoa', () => {
  // Tiukka maakohtainen tarkistus estäisi kirjaamasta ulkomaista
  // tiliä, jonka muotoa emme tunne. Sovellus ei maksa mitään, joten
  // väärä IBAN ei aiheuta täällä vahinkoa.
  const siisti = tunnus => billsRepo.mapping.normalize({
    id: 'b', name: 'X', amountMinor: 1, dueDate: '2026-09-01', iban: tunnus
  }).iban;

  assert.equal(siisti('fi21123456000007 85'), 'FI21123456000007 85');
  assert.equal(siisti('  '), null);
  assert.equal(siisti(null), null);
  assert.equal(siisti('DE89-3704-0044-0532-0130-00'), 'DE89370400440532013000');
});

// =====================================================================
// VIENTI
// =====================================================================

test('KRIITTINEN: vienti kattaa taloushistorian mutta ei kuvaa', async () => {
  const { EXPORTED_COLLECTIONS, buildUserDataExport } =
    await import('../src/domain/dataExport.js');

  // Käyttäjän oma taloushistoria kuuluu vientiin. Ilman näitä vienti
  // menettäisi sen hiljaa.
  assert.ok(EXPORTED_COLLECTIONS.includes('transactions'));
  assert.ok(EXPORTED_COLLECTIONS.includes('investments'));

  // KESKEN OLEVA LUENTA EI KUULU VIENTIIN. Se on väliaikainen eikä
  // kokoelma lainkaan -- ja se on ainoa paikka, jossa kuvasta luettu
  // tieto elää ennen hyväksyntää.
  assert.equal(EXPORTED_COLLECTIONS.includes('pendingExtraction'), false);

  // Eikä viety tapahtuma voi sisältää kuvaa: mallissa ei ole kenttää.
  const vienti = buildUserDataExport({
    transactions: [{
      id: 't1', kind: 'expense', amountMinor: 2490, date: '2026-09-10',
      category: 'ruoka', description: 'Ruokakauppa'
    }]
  });

  const teksti = JSON.stringify(vienti);
  assert.equal(/image|base64|dataUrl|photo/i.test(teksti), false,
    'vienti sisältää kuvaan viittaavan kentän');
});

// =====================================================================
// KÄYTTÖLIITTYMÄ EI VÄITÄ MAKSAVANSA
// =====================================================================

test('KRIITTINEN: käyttöliittymä kertoo ettei rahaa siirretä', () => {
  const html = read('index.html');
  const finance = read('src/app/views/finance.js');
  const transactions = read('src/app/views/transactions.js');
  const investments = read('src/app/views/investments.js');

  // Maksutietojen yhteydessä sanotaan ääneen, ettei sovellus maksa.
  assert.match(html, /ei maksa laskuja eikä siirrä rahaa/i,
    'laskulomake ei kerro, ettei sovellus maksa laskuja');

  // Kuitin yhteydessä sanotaan, ettei kuvaa tallenneta ja että luenta
  // on ehdotus.
  assert.match(html, /tallenneta minnekään/i,
    'kuvan käsittelystä ei kerrota');
  assert.match(html, /ehdotus/i, 'luennan luonnetta ei kerrota');

  // Sijoituksissa sanotaan, ettei kursseja haeta.
  assert.match(html, /ei hae kursseja/i, 'sijoitusnäkymä ei kerro puuttuvaa hintatietoa');

  // Budjetissa sanotaan, ettei luku ole tilin saldo.
  assert.match(transactions, /ei tilin saldoa/i,
    'budjetti ei erota kirjattua erotusta tilin saldosta');

  // Säästösiirto on kirjaus, ei siirto.
  assert.match(html, /Manifestival ei siirrä rahaa/i,
    'säästösiirto ei kerro luonnettaan');

  void finance;
  void investments;
});

test('KRIITTINEN: näkymä ei kutsu kantaa eikä luo tunnisteita', () => {
  // Sivuvaikutukset kuuluvat toimintokerrokselle.
  for (const tiedosto of [
    'src/app/views/transactions.js', 'src/app/views/investments.js'
  ]) {
    const koodi = read(tiedosto);
    assert.equal(/getClient\(/.test(koodi), false, `${tiedosto} kutsuu kantaa`);
    assert.equal(/crypto\.randomUUID/.test(koodi), false,
      `${tiedosto} luo tunnisteita`);
    assert.equal(/Math\.random/.test(koodi), false, `${tiedosto} arpoo lukuja`);
  }
});

test('KRIITTINEN: sijoitusnäkymä ei hae kursseja mistään', () => {
  const koodi = read('src/app/views/investments.js');
  assert.equal(/\bfetch\(/.test(koodi), false, 'sijoitusnäkymä tekee verkkopyynnön');
});

test('vain kuvan luenta tekee verkkopyynnön, ja se menee omaan palvelimeen', () => {
  const capture = read('src/app/receiptCapture.js');
  const pyynnot = [...capture.matchAll(/[^a-zA-Z.]fetch\(([^,]+),/g)].map(m => m[1].trim());

  assert.deepEqual(pyynnot, ['apiUrl(API.extract)'],
    'kuvan luenta ottaa yhteyttä muualle kuin omaan palvelimeen');

  // Eikä avainta ole selainkoodissa. Anthropic saa esiintyä
  // kommentissa -- avain ei missään muodossa. Otsake `x-api-key` ja
  // avaimen etuliite `sk-ant-` ovat ne, jotka paljastaisivat vuodon.
  assert.equal(/x-api-key|sk-ant-|ANTHROPIC_API_KEY/.test(capture), false,
    'selainkoodissa on API-avain tai sen otsake');
});

test('kirjaustavan vaihto sulkee toisen kirjaustavan', () => {
  // Kaksi kirjaustapaa auki yhtä aikaa tarkoittaisi, että käyttäjä voi
  // täyttää lomakkeen ja lukea kuitin, eikä tietäisi kumpi tallentuu.
  const view = read('src/app/views/transactions.js');
  const handler = view.slice(view.indexOf("el('txModeScan')"));
  const body = handler.slice(0, handler.indexOf('});'));

  assert.ok(body.includes('closeTransactionForm'),
    'kuvasta-tilaan siirtyminen ei sulje lomaketta');
});

test('kohteen vaihto unohtaa kesken olevan luennan', () => {
  // Kuitin luenta laskuna näyttäisi laskulta. Kesken oleva luenta
  // koskee toista kohdetta, joten se unohdetaan.
  const view = read('src/app/views/transactions.js');

  for (const nappi of ['scanKindReceipt', 'scanKindBill']) {
    const handler = view.slice(view.indexOf(`el('${nappi}')`));
    const body = handler.slice(0, handler.indexOf('});'));
    assert.ok(body.includes('clearPendingExtraction'),
      `${nappi} ei unohda kesken olevaa luentaa`);
  }
});

test('uloskirjautuminen nollaa kuvan ja kesken olevan luennan', () => {
  const main = read('src/app/main.js');
  assert.ok(main.includes('resetTransactionViews'),
    'uloskirjautuminen ei nollaa tapahtumanäkymää');

  const view = read('src/app/views/transactions.js');
  const reset = view.slice(view.indexOf('export function resetTransactionViews'));
  const body = reset.slice(0, reset.indexOf(NEWLINE + '}'));
  assert.ok(body.includes('releaseFileInput'), 'nollaus ei vapauta valitsinta');
});
