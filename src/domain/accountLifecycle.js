// Tilin elinkaari: yksi totuudenlähde sille, mitä käyttäjän tiliin
// kuuluu, ja kuinka poisto vaikuttaisi siihen.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa, ei tietokantaa.
//
// -----------------------------------------------------------------------
// EI OMAA LISTAA — YKSI LÄHDE VIENNIN KANSSA
// -----------------------------------------------------------------------
// `EXPORTED_COLLECTIONS` (src/domain/dataExport.js) ON JO se käyttäjän
// omistamien tietotyyppien nimenomainen luettelo. Erillinen "poisto-
// inventaario" ajautuisi siitä eroon ensimmäisellä unohtuneella
// päivityksellä — juuri sitä riskiä Phase N pyytää pienentämään.
// Tämä moduuli lukee saman listan eikä koskaan omaa kopiotaan siitä.
//
// -----------------------------------------------------------------------
// KUIVA-AJO EI KOSKAAN POISTA MITÄÄN
// -----------------------------------------------------------------------
// `dryRunDeletion()` on puhdas laskenta: se ottaa vastaan käyttäjän
// jo ladatun oman datan (samassa muodossa kuin buildUserDataExport())
// ja kertoo mitä poisto TEKISI — rivimäärät, tallennustiedostojen
// kategoriat (ei ole yhtään, ks. alla) ja onko auth-tili ylipäätään
// poistettavissa nykyisellä backendillä. Se ei koske tietokantaan,
// tiedostojärjestelmään eikä Supabaseen millään tavalla.

import { EXPORTED_COLLECTIONS } from './dataExport.js';

export { EXPORTED_COLLECTIONS as ACCOUNT_OWNED_COLLECTIONS };

/**
 * Mihin tauluun ja omistajasarakkeeseen kukin inventaarion kokoelma
 * tallentuu, ja miten sen poisto tapahtuu.
 *
 * KAIKKI POISTUVAT YHDESSÄ ATOMISESTI: jokaisen taulun omistajasarake
 * viittaa `auth.users(id)` ... `on delete cascade`, joten auth-käyttäjän
 * poisto poistaa kaikki rivit yhdessä tietokantatransaktiossa.
 * Järjestyksellä (lapset ennen vanhempia) ei siksi ole väliä eikä
 * erillisiä DELETE-lauseita tarvita -- ne olisivat PostgREST-kutsuina
 * ei-atomisia ja jättäisivät puolikkaan tilin, jos yksi epäonnistuisi.
 * Väite ("jokainen taulu kaskadoituu") todistetaan migraatiotiedostoista
 * tests/account-deletion-inventory.test.mjs:ssä, ei oleteta.
 *
 * Kopio tästä on supabase/functions/_shared/accountInventory.js, koska
 * Edge Function ei voi tuoda selainpuolen src/-hakemistoa. Testi vaatii,
 * että kopio on täsmälleen sama.
 */
export const ACCOUNT_DATA_MAP = Object.freeze({
  tasks: { table: 'tasks', ownerColumn: 'user_id' },
  routines: { table: 'routines', ownerColumn: 'user_id' },
  routineExceptions: { table: 'routine_exceptions', ownerColumn: 'user_id' },
  goals: { table: 'goals', ownerColumn: 'user_id' },
  projects: { table: 'projects', ownerColumn: 'user_id' },
  bills: { table: 'bills', ownerColumn: 'user_id' },
  recurringExpenses: { table: 'recurring_expenses', ownerColumn: 'user_id' },
  savingsGoals: { table: 'savings_goals', ownerColumn: 'user_id' },
  wellbeing: { table: 'wellbeing_entries', ownerColumn: 'user_id' },
  notificationPreferences: { table: 'notification_preferences', ownerColumn: 'id' },
  profile: { table: 'profile', ownerColumn: 'id' },
  aiAudit: { table: 'ai_action_audit', ownerColumn: 'user_id' },
  transactions: { table: 'transactions', ownerColumn: 'user_id' },
  investments: { table: 'investments', ownerColumn: 'user_id' },
  milestones: { table: 'milestones', ownerColumn: 'user_id' },
  inboxItems: { table: 'inbox_items', ownerColumn: 'user_id' },
  reminders: { table: 'reminders', ownerColumn: 'user_id' },
  notices: { table: 'notices', ownerColumn: 'user_id' },
  travelPlans: { table: 'travel_plans', ownerColumn: 'user_id' },
  locationRules: { table: 'location_rules', ownerColumn: 'user_id' },
  lifeAreas: { table: 'life_areas', ownerColumn: 'user_id' },
  weeklyCapacities: { table: 'weekly_capacities', ownerColumn: 'user_id' },
  timeEntries: { table: 'time_entries', ownerColumn: 'user_id' },
  alignmentReviews: { table: 'alignment_reviews', ownerColumn: 'user_id' },
  alignmentItemSettings: { table: 'alignment_item_settings', ownerColumn: 'user_id' },
  runningTimers: { table: 'running_timers', ownerColumn: 'user_id' },
  savedPlaces: { table: 'saved_places', ownerColumn: 'user_id' },
  placeAliases: { table: 'place_aliases', ownerColumn: 'user_id' },
  calendarEvents: { table: 'calendar_events', ownerColumn: 'user_id' },
  commuteObservations: { table: 'commute_observations', ownerColumn: 'user_id' },
  lifeSettings: { table: 'life_settings', ownerColumn: 'user_id' },
  sleepLogs: { table: 'sleep_logs', ownerColumn: 'user_id' },
  habitPlans: { table: 'habit_plans', ownerColumn: 'user_id' },
  habitEvents: { table: 'habit_events', ownerColumn: 'user_id' },
  exerciseSessions: { table: 'exercise_sessions', ownerColumn: 'user_id' },
  wellbeingCheckins: { table: 'wellbeing_checkins', ownerColumn: 'user_id' }
});

/**
 * Käyttäjälle näytettävät nimet. Jokaisella inventaarion kokoelmalla on
 * oma (testi vaatii kattavuuden) -- raaka tekninen nimi ("routineExceptions")
 * ei kuulu poiston esikatseluun.
 */
export const ACCOUNT_DOMAIN_LABELS = Object.freeze({
  tasks: 'Tehtävät',
  routines: 'Rutiinit',
  routineExceptions: 'Rutiinien poikkeukset',
  goals: 'Tavoitteet',
  projects: 'Projektit',
  bills: 'Laskut',
  recurringExpenses: 'Toistuvat menot',
  savingsGoals: 'Säästötavoitteet',
  wellbeing: 'Hyvinvointimerkinnät',
  notificationPreferences: 'Muistutusasetukset',
  profile: 'Profiili',
  aiAudit: 'AI-toimintoloki',
  transactions: 'Talouden tapahtumat',
  investments: 'Sijoitukset',
  milestones: 'Välitavoitteet',
  inboxItems: 'Saapuneet kirjaukset',
  reminders: 'Muistutukset',
  notices: 'Ilmoitushistoria',
  travelPlans: 'Matkasuunnitelmat',
  locationRules: 'Paikkamuistutukset',
  lifeAreas: 'Elämänalueet',
  weeklyCapacities: 'Viikkokapasiteetit',
  timeEntries: 'Kirjattu aika',
  alignmentReviews: 'Viikkokatsaukset',
  alignmentItemSettings: 'Kuormittavuus- ja Suunta-asetukset',
  runningTimers: 'Käynnissä oleva ajastin',
  savedPlaces: 'Tallennetut paikat',
  placeAliases: 'Paikkojen lisänimet',
  calendarEvents: 'Kalenterin menot',
  commuteObservations: 'Kirjatut matka-ajat',
  lifeSettings: 'Arjen asetukset',
  sleepLogs: 'Unikirjaukset',
  habitPlans: 'Tapojen muutossuunnitelmat',
  habitEvents: 'Tapojen kirjaukset',
  exerciseSessions: 'Liikuntakerrat',
  wellbeingCheckins: 'Motivaatio ja hallinnan tunne'
});

/** Kokoelman käyttäjälle näytettävä nimi. Tuntematon nimi näytetään sellaisenaan. */
export function domainLabel(name) {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_DOMAIN_LABELS, name)
    ? ACCOUNT_DOMAIN_LABELS[name]
    : String(name);
}

/**
 * Kokoelmat, joiden säilytys- tai poistolinjaus vaatii tuote- tai
 * lakipäätöksen.
 *
 * `aiAudit` (AI-toimintoloki) poistuu nyt tilin mukana, koska se on
 * käyttäjän omaa dataa (sisältää tiivistelmän hänen syötteistään) ja
 * poistoperiaate on oletuksena "kaikki oma data pois". Jos lakisääteinen
 * tai turvallisuusperusteinen säilytysvelvoite todetaan, sen poikkeus
 * on OMISTAJAN PÄÄTÖS ja vaatii skeemamuutoksen (FK ei saa kaskadoitua) --
 * sitä ei ole toteutettu eikä sen puuttuminen ole hiljainen oletus.
 */
export const RETENTION_DECISIONS = Object.freeze({
  aiAudit: Object.freeze({
    decision: 'delete-with-account',
    ownerReviewRequired: true
  })
});

/**
 * Tallennustiedostojen kategoriat, joita tilin poisto koskisi.
 *
 * TYHJÄ LISTA ON TOTUUS, EI PUUTE. Kuitin ja laskun kuvaa ei tallenneta
 * minnekään (ks. docs/SECURITY.md "Kuitin kuva" ja
 * src/domain/receipts.js, jossa ei ole kuvakenttää). Profiilikuvaa tai
 * muuta tiedostotallennusta ei ole toteutettu. Jos sellainen joskus
 * lisätään, se on lisättävä TÄHÄN LISTAAN ensin — muuten poisto jättäisi
 * tiedoston orvoksi.
 */
export const STORED_FILE_CATEGORIES = Object.freeze([]);

/**
 * Onko auth-käyttäjän poisto (auth.users-rivi) mahdollista?
 *
 * Domain ei tiedä deploymentista, joten kutsuja kertoo sen: käyttöliittymä
 * antaa `ACCOUNT_DELETION.endpointEnabled` (src/data/config.js), joka on
 * false kunnes Supabase Edge Function `delete-account` on oikeasti
 * deployattu ja testattu. Oletus on EI -- poisto ei koskaan näy
 * mahdollisena vahingossa.
 *
 * Korotettu oikeus (auth.users-rivin poisto) elää vain Edge Functionissa
 * (supabase/functions/delete-account), ei selaimessa eikä `api/`-
 * hakemistossa; ks. docs/ACCOUNT-DELETION.md.
 */
export function authAccountDeletable(endpointEnabled = false) {
  return endpointEnabled === true;
}

/** Ihmisluettava syy, jos auth-tiliä ei voi poistaa. */
export function authAccountBlockedReason() {
  return 'Tilin poisto ei ole vielä käytössä: palvelinpuolen poistotoiminto on '
    + 'valmisteltu mutta sitä ei ole otettu käyttöön (ks. docs/ACCOUNT-DELETION.md).';
}

/**
 * Kuiva-ajo: mitä tilin poisto vaikuttaisi, ilman että mitään poistetaan.
 *
 * @param {object} data Kokoelmat nimillä (sama muoto kuin buildUserDataExport():lle)
 * @returns {{
 *   collections: Array<{name:string, count:number}>,
 *   totalRows: number,
 *   storedFileCategories: string[],
 *   authDeletable: boolean,
 *   blockers: string[]
 * }}
 */
export function dryRunDeletion(data = {}, { endpointEnabled = false } = {}) {
  const collections = EXPORTED_COLLECTIONS.map(name => {
    const value = data[name];
    const count = Array.isArray(value) ? value.length : (value && typeof value === 'object' ? 1 : 0);
    return { name, count };
  });

  const totalRows = collections.reduce((sum, entry) => sum + entry.count, 0);
  const authDeletable = authAccountDeletable(endpointEnabled);
  const blockers = authDeletable ? [] : [authAccountBlockedReason()];

  return {
    collections,
    totalRows,
    storedFileCategories: [...STORED_FILE_CATEGORIES],
    authDeletable,
    blockers
  };
}

/**
 * Testi, jonka pitäisi kaatua, jos joku käyttäjän omistama tietotyyppi
 * lisätään vientiin/tilaan mutta unohdetaan täältä.
 *
 * TÄMÄ MODUULI EI VOI KAATUA ITSESTÄÄN, KOSKA SE LUKEE SAMAN LISTAN —
 * mutta tests/account-lifecycle.test.mjs todistaa erikseen, että
 * EXPORTED_COLLECTIONS kattaa jokaisen rekisteröidyn repositorion
 * (ALL_REPOSITORIES) ja että jokainen sen nimi on src/app/state.js:n
 * alkutilan oma kenttä (vienti ja kuiva-ajo lukevat sen tilasta nimellä).
 */
export function collectionCount() {
  return EXPORTED_COLLECTIONS.length;
}

// -----------------------------------------------------------------------
// PALVELIMEN KUIVA-AJON ESIKATSELU
// -----------------------------------------------------------------------

/** Esikatselurivin tila: laskettu, taulua ei ole, laskenta epäonnistui. */
export const PREVIEW_ROW_STATE = Object.freeze({
  COUNTED: 'counted',
  ABSENT: 'absent',
  FAILED: 'failed'
});

/**
 * Palvelimen kuiva-ajon kokoelmat (supabase/functions/delete-account)
 * esikatseluriveiksi.
 *
 * MITÄÄN EI PUDOTETA. Aiemmin rivi, jonka määrä ei ollut kokonaisluku,
 * suodatettiin pois -- jolloin laskematon kokoelma näytti samalta kuin
 * tyhjä, ja käyttäjä luuli näkevänsä kaiken. Nyt jokainen kokoelma on
 * rivi tilansa kanssa: `present: false` (taulua ei ole tässä kannassa,
 * tuotanto ennen aaltoa J) on "ei käytössä", epäonnistunut laskenta on
 * "ei voitu laskea".
 *
 * @param {Array<{domain:string, rowCount:number|null, blockedReason:string|null, present?:boolean|null}>} domains
 * @returns {Array<{name:string, count:number|null, state:string}>}
 */
export function serverPreviewRows(domains) {
  if (!Array.isArray(domains)) return [];
  return domains
    .filter(entry => entry && typeof entry.domain === 'string')
    .map(entry => {
      if (entry.present === false) {
        return { name: entry.domain, count: 0, state: PREVIEW_ROW_STATE.ABSENT };
      }
      if (!entry.blockedReason && Number.isInteger(entry.rowCount) && entry.rowCount >= 0) {
        return { name: entry.domain, count: entry.rowCount, state: PREVIEW_ROW_STATE.COUNTED };
      }
      return { name: entry.domain, count: null, state: PREVIEW_ROW_STATE.FAILED };
    });
}

/**
 * Esikatselun koonti näytettäväksi.
 *
 * Näkyviin: rivejä sisältävät kokoelmat ja laskemattomat (ei nollia).
 * Puuttuvat taulut kootaan omaksi listakseen. Jos yksikin kokoelma jäi
 * laskematta, summa on alaraja (`partial`), ei väite kokonaismäärästä.
 * Paikallisen kuiva-ajon rivit ({name, count} ilman tilaa) ovat laskettuja.
 *
 * @param {Array<{name:string, count:number|null, state?:string}>} rows
 */
export function summarizePreview(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const stateOf = row => row.state || PREVIEW_ROW_STATE.COUNTED;
  const counted = list.filter(row => stateOf(row) === PREVIEW_ROW_STATE.COUNTED && row.count > 0);
  const failed = list.filter(row => stateOf(row) === PREVIEW_ROW_STATE.FAILED);
  const absent = list.filter(row => stateOf(row) === PREVIEW_ROW_STATE.ABSENT);
  return {
    rows: [...counted, ...failed],
    absent: absent.map(row => row.name),
    total: counted.reduce((sum, row) => sum + row.count, 0),
    partial: failed.length > 0
  };
}

/** Esikatselurivin oikean reunan arvo käyttäjälle. */
export function previewRowValue(row) {
  const state = row && row.state;
  if (state === PREVIEW_ROW_STATE.ABSENT) return 'ei käytössä';
  if (state === PREVIEW_ROW_STATE.FAILED) return 'ei voitu laskea';
  return String(row && Number.isInteger(row.count) ? row.count : 0);
}
