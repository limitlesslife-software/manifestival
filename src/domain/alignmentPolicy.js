// Suunnan sääntöpolitiikka: kaikki kynnykset yhdessä paikassa.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// =====================================================================
// MIKSI YKSI MODUULI
// =====================================================================
//
// Ensimmäisessä versiossa kynnykset olivat `RULES`-olio alignment.js:ssä
// ja muutama maaginen luku muualla (ehdotusten enimmäismäärät, varauksen
// pituus). Kun sääntöjä viritetään oikeasta käytöstä, muutos tehdään
// TÄHÄN ja vain tähän; havaintomoottori, katsaus, päivän havainnot ja
// käyttöliittymän "Miksi tämä näkyy?" lukevat samat arvot.
//
// Kynnyksiä EI näytetä käyttäjälle säädettävinä. Ne ovat tuotteen
// päätöksiä, ja niiden muuttaminen muuttaa havaintojen merkitystä.
//
// =====================================================================
// VERSIO
// =====================================================================
//
// `POLICY_VERSION` tallentuu viikkokatsauksen tilannekuvaan. Kun
// kynnyksiä muutetaan, versio kasvaa, ja vanha katsaus kertoo yhä
// millä säännöillä sen havainnot syntyivät. Vanhoja tilannekuvia EI
// lasketa uudelleen: ne ovat historiaa.
//
//   1  ensimmäinen pystyviipale (kuormitus, huomiotta jääminen,
//      poikkeama, jännite). Katsaus ilman versiota = 1.
//   2  + energiakuormitus, päivän havaintojen järjestys, trendien
//      vähimmäisaineisto. Ajan kynnykset ennallaan.
//   3  harvan aineiston rajat: toteumaa verrataan tavoitteisiin vasta,
//      kun kirjaaminen on vakiintunut (seurannan kypsyys), ja
//      suunnitelman jakaumaa vasta, kun riittävä osa työstä on arvioitu.
//      Päivät ennen ensimmäistä kirjausta ja ennen alueen luontia ovat
//      tuntemattomia, eivät nollaa. Vanhat kynnykset ennallaan.
//      Kirjattu osuus (puolet) suhteutetaan käyttäjän ilmoittamaan
//      viitteeseen; ilman viitettä toteumaa ei verrata.

export const POLICY_VERSION = 3;

/** Versioiden kuvaukset historianäkymää varten. */
export const POLICY_VERSIONS = Object.freeze({
  1: 'Suunta 1: kuormitus, huomiotta jääminen, poikkeama ja jännite',
  2: 'Suunta 2: lisäksi energiakuormitus ja päivän havainnot',
  3: 'Suunta 3: harvan aineiston rajat (arvioiden ja kirjausten kattavuus)'
});

/**
 * Ajan säännöt. Versioiden 1–2 arvot ovat ennallaan; versio 3 lisää
 * harvan aineiston rajat (alempana).
 *
 * VERSIO 3: SEURANNAN KYPSYYS (trackingMaturity, alignment.js)
 *
 * Seurantajakso alkaa myöhäisimmästä näistä: viikon maanantai,
 * ensimmäinen koskaan kirjattu päivä, alueen luontipäivä. Toteumaa
 * verrataan tavoitteisiin vain, kun kirjaaminen on vakiintunut:
 *
 *   - jaksosta on kulunut vähintään NEGLECT_MIN_PROGRESS (3/7 viikkoa)
 *   - kirjauksia on vähintään ACTUAL_MIN_TRACKED_DAYS päivältä
 *   - kirjauksia on vähintään ACTUAL_MIN_DAY_COVERAGE jakson kuluneista
 *     päivistä (puolet, ylöspäin pyöristäen)
 *   - kirjattua aikaa on vähintään ACTUAL_MIN_LOGGED_SHARE (puolet)
 *     viitteestä, jonka KÄYTTÄJÄ ITSE on ilmoittanut. Viite on
 *     ensimmäinen olemassa oleva:
 *       1. viikon kapasiteetti x jakson osuus
 *       2. aktiivisten alueiden viikkotavoitteiden summa x jakson osuus
 *       3. jakson päiville (tähän päivään asti) päivätyn arvioidun työn summa
 *     Jos viitettä ei ole lainkaan, taso on enintään `partial`: kirjattua
 *     aikaa ei voi suhteuttaa mihinkään, eikä viitettä keksitä.
 *
 * Miksi puolet (ei 25 %): 70 min päivässä 30 tunnin kapasiteetilla on
 * noin 27 % viikosta. Sillä ei voi väittää, että muut alueet jäivät
 * huomiotta — kirjaamaton aika on tuntematon, ei nolla. Ilman viitettä
 * kaksi 10 minuutin kirjausta riitti aiemmin "vakiintuneeksi".
 *
 * Hystereesi viikon sisällä: kriteerit arvioidaan jakson jokaisen
 * kuluneen päivän lopussa. Kun `established` on saavutettu jonain
 * aiempana päivänä, taso pysyy loppuviikon, ellei päiväkattavuus petä.
 * Muuten perjantaiaamu (viite kasvaa, päivän kirjaukset puuttuvat)
 * pudottaisi tason takaisin.
 */
export const TIME_RULES = Object.freeze({
  /** Kuormitus on vahva, kun suunniteltu >= 120 % kapasiteetista. */
  OVERLOAD_STRONG_RATIO: 1.2,
  /** Mahdollinen kuormitus: tunnettu >= 90 % ja arvioimatonta työtä on. */
  OVERLOAD_POSSIBLE_RATIO: 0.9,

  /** Huomiotta jäämistä arvioidaan vain alueille, joiden tärkeys on >= 4. */
  NEGLECT_MIN_IMPORTANCE: 4,
  /** Alle 30 min viikkotavoitetta ei ole mielekäs mittari. */
  NEGLECT_MIN_TARGET_MINUTES: 30,
  /** Alle puolet odotetusta = huomiotta jäämässä. */
  NEGLECT_RATIO: 0.5,
  /** Viikko päättynyt ja alle neljännes = vahva. */
  NEGLECT_STRONG_RATIO: 0.25,
  /** Toteumaa verrataan vasta kun viikosta on kulunut 3/7 (torstaista). */
  NEGLECT_MIN_PROGRESS: 3 / 7,

  /** Jakauman poikkeama prosenttiyksikköinä. */
  MISALIGNMENT_POINTS: 15,
  MISALIGNMENT_STRONG_POINTS: 25,
  /** Jakaumaa ei arvioida alle kahden tunnin aineistosta. */
  MISALIGNMENT_MIN_MINUTES: 120,
  /** Jos alle 60 % ajasta on liitetty alueeseen, johtopäätös on vain tiedoksi. */
  MIN_ASSIGNED_COVERAGE: 0.6,
  /** Arvioitua kestoa alle puolella työstä = heikko aineisto. */
  MIN_ESTIMATE_COVERAGE: 0.5,

  /** v3: toteumaa verrataan vasta, kun kirjauksia on vähintään näin monelta päivältä. */
  ACTUAL_MIN_TRACKED_DAYS: 2,
  /** v3: ... ja vähintään tältä osuudelta seurantajakson kuluneista päivistä. */
  ACTUAL_MIN_DAY_COVERAGE: 0.5,
  /** v3: ... ja kirjattu aika >= tämä osuus käyttäjän ilmoittamasta viitteestä (kapasiteetti / tavoitteet / suunnitelma). */
  ACTUAL_MIN_LOGGED_SHARE: 0.5,
  /** v3: vahva huomiotta jääminen vain, kun seurantajakso kattoi vähintään 6/7 viikosta. */
  STRONG_MIN_TRACKED_FRACTION: 6 / 7,
  /** v3: suunnitelman jakaumaa ei arvioida, jos arvioitu osuus asioista on alle tämän. */
  PLAN_MIN_ESTIMATE_COVERAGE: 0.5,
  /** v3: suunnitelman jakauma on enintään tiedoksi, jos arvioitu osuus on alle tämän. */
  PLAN_FULL_ESTIMATE_COVERAGE: 0.8
});

/**
 * Energian säännöt (versio 2).
 *
 * Energiakuorma = suunniteltu aika, jonka käyttäjä on itse merkinnyt
 * kuormittavaksi (4) tai erittäin kuormittavaksi (5). Ks. energyLoad.js.
 */
export const ENERGY_RULES = Object.freeze({
  /** Tätä tasoa ja raskaampi on "kuormittavaa". */
  HEAVY_MIN_DEMAND: 4,
  /** Vahva, kun kuormittavaa >= 120 % käyttäjän omasta rajasta. */
  OVERLOAD_STRONG_RATIO: 1.2,
  /** Mahdollinen: >= 90 % rajasta ja osa työstä on arvioimatta kuormittavuuden osalta. */
  OVERLOAD_POSSIBLE_RATIO: 0.9,
  /** Ilman rajaa: oma energia-arvio <= 2 ... */
  LOW_ENERGY_LEVEL: 2,
  /** ... ja vähintään puolet tunnetusta suunnitellusta ajasta on kuormittavaa ... */
  LOW_ENERGY_HEAVY_SHARE: 0.5,
  /** ... ja kuormittavaa on vähintään kaksi tuntia. */
  LOW_ENERGY_MIN_HEAVY_MINUTES: 120
});

/** Päivän havaintojen säännöt. */
export const DAILY_RULES = Object.freeze({
  /** Montako havaintoa päivänäkymä näyttää enintään. */
  MAX_OBSERVATIONS: 3,
  /** Liittämättömiä viikon asioita vähintään näin monta, ennen kuin siitä kerrotaan. */
  UNASSIGNED_MIN_ITEMS: 3,
  /** Arvioimattomia vähintään näin monta, ennen kuin siitä kerrotaan. */
  UNESTIMATED_MIN_ITEMS: 3
});

/** Aineiston laadun säännöt (versio 2: toimenpiteet). */
export const QUALITY_RULES = Object.freeze({
  /** Kirjatusta ajasta alle tämä osuus alueisiin liitettynä = kerrotaan. */
  ACTUAL_ASSIGNED_WARN: 0.6,
  /** Suunnitellusta työstä alle tämä osuus arvioituna = kerrotaan. */
  ESTIMATE_COVERAGE_WARN: 0.8
});

/** Katsauksen ja ehdotusten säännöt. */
export const REVIEW_RULES = Object.freeze({
  MAX_PROPOSALS: 12,
  MAX_PAUSE_PROPOSALS: 3,
  /** Huomiotta jääneelle alueelle ehdotetun varauksen enimmäispituus. */
  RESERVE_BLOCK_MINUTES: 60,
  /** Kapasiteettiehdotus: toteuma poikkesi arviosta vähintään näin paljon. */
  CAPACITY_DEVIATION_RATIO: 0.25,
  /** ... ja vähintään näin monta minuuttia. */
  CAPACITY_DEVIATION_MIN_MINUTES: 120,
  /**
   * v3: ... ja kirjaaminen on vakiintunut ja kattoi vähintään tämän
   * osuuden viikosta. Osittain kirjattu viikko ei kerro kapasiteetista.
   */
  CAPACITY_MIN_TRACKED_FRACTION: 6 / 7,
  /** Tavoite, jonka alueella ei ole ollut toteumaa eikä suunnitelmaa näin moneen viikkoon, on "hiljainen". */
  INACTIVE_GOAL_WEEKS: 3
});

/** Trendien säännöt: johtopäätöksiä ei tehdä yhdestä viikosta. */
export const TREND_RULES = Object.freeze({
  /** Montako viikkoa historiaa näytetään. */
  WEEKS: 8,
  /** Muutoksesta kerrotaan vasta, kun peräkkäisiä viikkoja on vähintään näin monta. */
  MIN_WEEKS: 3,
  /** Aikamuutos, jota pienempää ei sanoiteta. */
  MIN_CHANGE_MINUTES: 60,
  /** Osuusmuutos prosenttiyksikköinä, jota pienempää ei sanoiteta. */
  MIN_CHANGE_POINTS: 10
});

/** Ajanseurannan säännöt. */
export const TIMER_RULES = Object.freeze({
  /** Alle puolen minuutin ajastus ei tuota kirjausta (pyöristyy nollaan). */
  MIN_LOGGED_MINUTES: 1,
  /** Pidempi ajastus pyydetään tarkistamaan ennen kirjausta: unohtunut ajastin. */
  REVIEW_AFTER_MINUTES: 12 * 60,
  /** Aloitusaika saa olla korkeintaan näin paljon tulevaisuudessa (kellojen ero). */
  MAX_FUTURE_SKEW_MS: 2 * 60 * 1000,
  /** Pikavalinnat minuutteina. */
  QUICK_MINUTES: Object.freeze([15, 30, 60])
});

/** Arvioinnin pikavalinnat minuutteina. */
export const ESTIMATE_PRESETS = Object.freeze([10, 30, 60, 120]);

/** Koko politiikka yhtenä oliona (katsaus ja testit). */
export const ALIGNMENT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  time: TIME_RULES,
  energy: ENERGY_RULES,
  daily: DAILY_RULES,
  quality: QUALITY_RULES,
  review: REVIEW_RULES,
  trend: TREND_RULES,
  timer: TIMER_RULES
});

/**
 * Tilannekuvan sääntöversio. Versio 1 -tilannekuvassa ei ollut kenttää,
 * joten puuttuva tarkoittaa 1:tä — ei nykyistä versiota.
 */
export function policyVersionOf(snapshot) {
  const version = snapshot && Number(snapshot.policyVersion);
  return Number.isInteger(version) && version >= 1 ? version : 1;
}
