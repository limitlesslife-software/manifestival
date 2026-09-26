// Käyttöliittymän tavoitettavuus: pääseekö käyttäjä domainiin käsiksi?
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Portti avaa TALLENNUKSEN. Se ei avaa käyttöliittymää eikä luo
// näkymää. Taulu, RLS, repositorio ja domain-logiikka voivat olla
// täydellisiä samalla kun käyttäjä ei pääse ominaisuuteen lainkaan --
// ja silloin portin avaaminen ei anna hänelle mitään.
//
// Tämä huomattiin vasta kun käyttäjä etsi tuotannosta hyvinvointia ja
// taloutta eikä löytänyt kumpaakaan. Hyvinvointi oli olemassa mutta
// väärän nimen takana; taloutta ei ollut lainkaan. Kumpikaan ei näkynyt
// missään tarkistuksessa, koska jokainen niistä katsoi kantaa.
//
// Molemmat on nyt korjattu: hyvinvointi löytyy nimellä, ja projekteille
// sekä taloudelle rakennettiin oma käyttöliittymä olemassa olevan
// domain-mallin päälle. Yksikään kymmenestä domainista ei ole enää
// tavoittamattomissa.
//
// TÄMÄ TAULUKKO EI OLE PROOSAA
//
// Jokainen väite on todennettavissa lähdekoodista, ja
// `tests/ui-reachability.test.mjs` tarkistaa ne joka ajolla. Jos joku
// lisää talouden käyttöliittymän, testi kaatuu -- ja silloin tämä
// taulukko ja aallon valmiustila on päivitettävä samassa yhteydessä.

/** Käyttäjän tavoitettavuuden tila. */
export const REACH = Object.freeze({
  /** Näkymä on olemassa ja käyttäjä löytää sen navigaatiosta. */
  REACHABLE: 'REACHABLE',
  /** Näkymää ei ole lainkaan. Käyttäjä ei voi luoda eikä nähdä rivejä. */
  NO_UI: 'NO_UI',
  /** Ei käyttäjän näkymä lainkaan -- tausta-aineisto. */
  BACKGROUND: 'BACKGROUND'
});

/**
 * Kahdeksantoista domainia ja se, miten käyttäjä pääsee niihin.
 *
 * `evidence` on koneellisesti tarkistettava todiste:
 *   html      id, jonka on oltava index.html:ssä
 *   view      tiedosto, jonka on renderöitävä siihen
 *   label     teksti, jonka käyttäjä näkee ja jolla hän etsii
 *   nav       polku sanoin
 */
export const REACHABILITY = Object.freeze([
  Object.freeze({
    gate: 'notificationPreferences',
    reach: REACH.REACHABLE,
    label: 'Muistutukset',
    nav: 'Profiili -> Muistutukset',
    evidence: { html: 'notificationSettings', view: 'src/app/views/notificationSettings.js' },
    crud: 'luku ja tallennus',
    note: 'Renderöidään Profiili-näkymään omana lohkonaan.'
  }),
  Object.freeze({
    gate: 'wellbeing',
    reach: REACH.REACHABLE,
    label: 'Hyvinvointi',
    nav: 'Tänään -> Hyvinvointi (avattava lohko)',
    evidence: { html: 'todayWellbeing', view: 'src/app/views/today.js' },
    crud: 'luku ja tallennus (energia, mieliala, kuormitus)',
    note: 'Otsikko oli aiemmin "Miten menee?", eikä sanaa hyvinvointi '
        + 'esiintynyt käyttöliittymässä kertaakaan. Käyttäjä ei löytänyt '
        + 'osiota. Otsikko korjattiin; lohko on yhä <details>, eli se '
        + 'avataan klikkaamalla.'
  }),
  Object.freeze({
    gate: 'goals',
    reach: REACH.REACHABLE,
    label: 'Tavoitteet',
    nav: 'Tavoitteet (alapalkin välilehti)',
    evidence: { html: 'goalsListContainer', view: 'src/app/views/goals.js' },
    crud: 'luonti, luku, muokkaus, poisto',
    note: 'Oma välilehti alapalkissa.'
  }),
  Object.freeze({
    gate: 'projects',
    reach: REACH.REACHABLE,
    label: 'Projektit',
    nav: 'Tavoitteet -> Projektit (segmentti)',
    evidence: { html: 'projectsListContainer', view: 'src/app/views/projects.js' },
    crud: 'luonti, luku, muokkaus, poisto, tavoitteeseen liittäminen ja irrotus',
    note: 'Tavoitteet-välilehden toinen segmentti, sama kaava kuin '
        + 'Tekeminen-välilehdellä (Tehtävät / Rutiinit). Projekti voi olla '
        + 'itsenäinen tai liitetty tavoitteeseen; valikossa on vain '
        + 'käyttäjän omat avoimet tavoitteet, ja kannan '
        + 'yhdistelmävierasavain on varsinainen este.'
  }),
  Object.freeze({
    gate: 'routines',
    reach: REACH.REACHABLE,
    label: 'Rutiinit',
    nav: 'Tekeminen -> Rutiinit (segmentti)',
    evidence: { html: 'routinesListContainer', view: 'src/app/views/routines.js' },
    crud: 'luonti, luku, muokkaus, poisto',
    note: 'Tehtävät-välilehden toinen segmentti.'
  }),
  Object.freeze({
    gate: 'routineExceptions',
    reach: REACH.REACHABLE,
    label: 'Ohita',
    nav: 'Tänään -> rutiinin kohdalla "Ohita"',
    evidence: { html: null, view: 'src/app/views/today.js' },
    crud: 'luonti ja peruutus (ohitus)',
    note: 'Poikkeuksella ei ole omaa näkymää eikä se tarvitse sellaista: '
        + 'se syntyy rutiinin ohittamisesta ja peruuntuu palauttamisesta.'
  }),
  Object.freeze({
    gate: 'recurringExpenses',
    reach: REACH.REACHABLE,
    label: 'Toistuvat menot',
    nav: 'Talous -> Toistuvat menot (segmentti)',
    evidence: { html: 'expensesListContainer', view: 'src/app/views/finance.js' },
    crud: 'luonti, luku, muokkaus, poisto, käytöstä poisto',
    note: 'Summa kulkee sentteinä: lomake jäsentää tekstin '
        + 'parseMoneyToMinor-funktiolla ja näyttö muotoillaan '
        + 'formatMoney-funktiolla. Menon poisto EI poista siitä '
        + 'syntyneitä laskuja.'
  }),
  Object.freeze({
    gate: 'savingsGoals',
    reach: REACH.REACHABLE,
    label: 'Säästötavoitteet',
    nav: 'Talous -> Säästötavoitteet (segmentti)',
    evidence: { html: 'savingsListContainer', view: 'src/app/views/finance.js' },
    crud: 'luonti, luku, muokkaus, poisto',
    note: 'Edistyminen lasketaan percentOf-funktiolla, joka palauttaa '
        + 'nollan myös nollatavoitteelle -- jakolaskua nollalla ei tehdä. '
        + 'Ylitys näkyy täytenä, ei yli sadan prosentin.'
  }),
  Object.freeze({
    gate: 'bills',
    reach: REACH.REACHABLE,
    label: 'Laskut',
    nav: 'Talous -> Laskut (segmentti)',
    evidence: { html: 'billsListContainer', view: 'src/app/views/finance.js' },
    crud: 'luonti, luku, muokkaus, poisto, maksetuksi merkintä',
    note: 'Tila ja maksupäivä kulkevat yhdessä: maksettu lasku ilman '
        + 'maksupäivää olisi tieto joka ei kerro milloin, ja kanta '
        + 'hylkäisi sen. Lasku voi liittyä toistuvaan menoon; liitos '
        + 'katkeaa menon poistuessa mutta lasku säilyy.'
  }),
  Object.freeze({
    gate: 'aiAudit',
    reach: REACH.BACKGROUND,
    label: null,
    nav: null,
    evidence: null,
    crud: 'kirjoitus AI-komennoista, ei käyttäjän näkymää',
    note: 'Kirjausketju on tausta-aineisto eikä käyttäjän näkymä. '
        + 'Kirjoituspolku puuttui kokonaan ja lisättiin: '
        + 'aiCommands.recordProposal ja completeAudit kirjoittavat nyt '
        + 'myös repositorioon. Selainta kirjausten lukemiseen ei ole.'
  }),
  Object.freeze({
    gate: 'transactions',
    reach: REACH.REACHABLE,
    label: 'Tapahtumat',
    nav: 'Talous -> Tapahtumat (segmentti)',
    evidence: { html: 'transactionsListContainer', view: 'src/app/views/transactions.js' },
    crud: 'luonti (meno, tulo, kuitista), luku, muokkaus, poisto',
    note: 'Suunta tulee lajista eikä etumerkistä: summa on aina '
        + 'positiivinen ja lomake avataan eri painikkeesta menolle ja '
        + 'tulolle. Kuitista luettu tapahtuma vaatii käyttäjän '
        + 'hyväksynnän eikä tallennu ilman sitä.'
  }),
  Object.freeze({
    gate: 'investments',
    reach: REACH.REACHABLE,
    label: 'Sijoitukset',
    nav: 'Talous -> Sijoitukset (segmentti)',
    evidence: { html: 'investmentsListContainer', view: 'src/app/views/investments.js' },
    crud: 'luonti, luku, muokkaus, poisto, arvon käsin päivitys',
    note: 'Kursseja ei haeta mistään. Arvo on käyttäjän kirjaama tai '
        + 'tuntematon, ja tuntematon näytetään tuntemattomana eikä '
        + 'nollana. Vanhentunut arvo merkitään vanhaksi.'
  }),
  Object.freeze({
    gate: 'milestones',
    reach: REACH.REACHABLE,
    label: 'Välitavoitteet',
    nav: 'Tavoitteet -> tavoitteen "Suunnitelma ja välitavoitteet"',
    evidence: { html: 'goalDetailContainer', view: 'src/app/views/goalDetail.js' },
    crud: 'luonti, luku, muokkaus, poisto, järjestys, saavutetuksi merkintä',
    note: 'Välitavoite on tila eikä työsäiliö: se joko on saavutettu tai '
        + 'ei. Poisto ei vie liitettyjä tehtäviä mukanaan, vaan katkaisee '
        + 'liitoksen — työ on tehty tai tekemättä riippumatta siitä, onko '
        + 'sen tarkistuspiste yhä olemassa.'
  }),
  Object.freeze({
    gate: 'inboxItems',
    reach: REACH.REACHABLE,
    label: 'Saapuvat',
    nav: 'Tänään -> kirjauspalkki; Tekeminen -> Saapuvat',
    evidence: { html: 'inboxListContainer', view: 'src/app/views/inbox.js' },
    crud: 'kirjaus, tulkinta, hyväksyntä, hylkäys, palautus, poisto',
    note: 'Kirjauspalkki on päivänäkymän yläreunassa, koska kirjaus on '
        + 'se teko joka tapahtuu useimmin. RIVI SYNTYY ENNEN TULKINTAA: '
        + 'verkkokatko ei syö käyttäjän ajatusta. Tulkinta on ehdotus, '
        + 'ja mitään ei synny ilman hyväksyntää.'
  }),
  Object.freeze({
    gate: 'reminders',
    reach: REACH.REACHABLE,
    label: 'Muistutukset',
    nav: 'Tekeminen -> Muistutukset',
    evidence: { html: 'remindersListContainer', view: 'src/app/views/reminders.js' },
    crud: 'luonti, luku, muokkaus, torkutus, kuittaus, peruutus, poisto',
    note: 'Näkymä sanoo ääneen, että muistutukset lasketaan kun '
        + 'sovellus on auki: taustaherätystä ei ole eikä sitä luvata. '
        + 'Torkutus siirtää muistutusta EIKÄ kohteen määräaikaa. '
        + 'Orpo muistutus perutaan näkyvästi, ei poisteta hiljaa.'
  }),
  Object.freeze({
    gate: 'notices',
    reach: REACH.REACHABLE,
    label: 'Ilmoitukset',
    nav: 'Tänään -> Ilmoitukset (avattava lohko)',
    evidence: { html: 'noticeCenterContainer', view: 'src/app/views/notices.js' },
    crud: 'luku, kuittaus, torkutus, hylkäys, poisto',
    note: 'Tämä EI ole tausta-aineistoa kuten aiAudit: ilmoitus '
        + 'kirjoitetaan nimenomaan käyttäjän luettavaksi, ja ilmoitus '
        + 'jota ei näytetä ei ole ilmoitus. Toimintolista tulee '
        + 'domainista, joten ristiriidalle ei tarjota torkutusta.'
  }),
  Object.freeze({
    gate: 'travelPlans',
    reach: REACH.REACHABLE,
    label: 'Matkat',
    nav: 'Tekeminen -> Matka',
    evidence: { html: 'travelListContainer', view: 'src/app/views/travel.js' },
    crud: 'luonti, luku, muokkaus, matka-ajan käsin kirjaus, poisto',
    note: 'TUNTEMATON NÄYTETÄÄN TUNTEMATTOMANA. Jos matka-aikaa ei '
        + 'tiedetä, lähtöaikaa ei näytetä kellonaikana vaan syy '
        + 'kerrotaan ja kesto voi kirjata itse. Reittipalvelua ei ole, '
        + 'eikä koordinaatteja tallenneta missään vaiheessa.'
  }),
  Object.freeze({
    gate: 'locationRules',
    reach: REACH.REACHABLE,
    label: 'Paikkamuistutukset',
    nav: 'Tekeminen -> Matka -> Paikkamuistutukset',
    evidence: { html: 'locationRulesContainer', view: 'src/app/views/travel.js' },
    crud: 'luonti, luku, muokkaus, päälle/pois, poisto',
    note: 'SÄÄNTÖ ON DATAA, EI TOTEUTUS. Geoaitaa ei ole eikä sitä voi '
        + 'luvata ilman laitehyväksyntää; säännön voi kirjata, nähdä '
        + 'ja testata. Uusi sääntö on oletuksena POIS PÄÄLTÄ, ja '
        + 'päälle kytkeminen kysyy vahvistuksen.'
  }),
  Object.freeze({
    gate: 'lifeAreas',
    reach: REACH.REACHABLE,
    label: 'Elämänalueet',
    nav: 'Suunta -> Elämänalueet',
    evidence: { html: 'dirAreasList', view: 'src/app/views/direction.js' },
    crud: 'luonti, luku, muokkaus, pois käytöstä, poisto',
    note: 'Käyttäjä määrittelee alueet, tärkeyden ja viikon aikatavoitteen. '
        + 'Oletusalueita ei luoda: ehdotukset ovat aloitusapu.'
  }),
  Object.freeze({
    gate: 'weeklyCapacities',
    reach: REACH.REACHABLE,
    label: 'Kapasiteetti',
    nav: 'Suunta -> Tämä viikko -> Kapasiteetti',
    evidence: { html: 'dirCapacityHours', view: 'src/app/views/direction.js' },
    crud: 'luku ja tallennus viikkoa kohti',
    note: 'Yksi arvo viikkoa kohti. Yli 60 h tuottaa varoituksen, ei estä.'
  }),
  Object.freeze({
    gate: 'timeEntries',
    reach: REACH.REACHABLE,
    label: 'Toteuma',
    nav: 'Suunta -> Toteuma',
    evidence: { html: 'dirTimeList', view: 'src/app/views/direction.js' },
    crud: 'luonti, luku, poisto',
    note: 'Käyttäjän kirjaama aika. Arviota ei kopioida toteumaksi.'
  }),
  Object.freeze({
    gate: 'alignmentReviews',
    reach: REACH.REACHABLE,
    label: 'Viikkokatsaus',
    nav: 'Suunta -> Viikkokatsaus',
    evidence: { html: 'dirReviewHistory', view: 'src/app/views/direction.js' },
    crud: 'luonti, luku, päivitys',
    note: 'Tilannekuva on historiaa. Muutosehdotukset vaativat vahvistuksen yksitellen.'
  }),
  Object.freeze({
    gate: 'runningTimers',
    reach: REACH.REACHABLE,
    label: 'Ajanseuranta',
    nav: 'Kaikki näkymät -> ajastinpalkki (käynnistys: Suunta, tehtävä, projekti, rutiini)',
    evidence: { html: 'timerBar', view: 'src/app/views/timeLog.js' },
    crud: 'käynnistys, tauko, jatko, pysäytys (kirjaus), hylkäys',
    note: 'Enintään yksi ajastin käyttäjää kohti. Kesto johdetaan aikaleimoista; laite säilyttää ajastimen uudelleenlatauksen yli.'
  }),
  Object.freeze({
    gate: 'alignmentItemSettings',
    reach: REACH.REACHABLE,
    label: 'Kuormittavuus',
    nav: 'Tehtävä -> Kuormittavuus (myös rutiini, projekti ja Suunta -> Arvioi tehtäviä)',
    evidence: { html: 'afEnergy', view: 'src/app/views/tasks.js' },
    crud: 'luonti, luku, muokkaus, poisto kohteen mukana',
    note: 'Käyttäjän oma kuormittavuus 1–5, tarkoituksella ilman aluetta ja karkea arvio. Ei päätellä otsikosta.'
  })
]);

/** Domainit, joita käyttäjä ei tavoita lainkaan. */
export function unreachableGates() {
  return REACHABILITY.filter(row => row.reach === REACH.NO_UI).map(row => row.gate);
}

/** Yhden portin tavoitettavuusrivi. */
export function reachabilityOf(gate) {
  return REACHABILITY.find(row => row.gate === gate) || null;
}
