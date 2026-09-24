// Talouden kululuokat.
//
// MIKSI NÄMÄ OVAT ERI ASIA KUIN src/domain/categories.js
//
// `categories.js` sisältää ELÄMÄNALUEET: Työ, Perhe, Hyvinvointi,
// Harrastus, Koti, Kehitys, Talous, Muu. Ne kertovat mihin elämän
// osa-alueeseen tehtävä tai tavoite liittyy, ja "Talous" on niistä
// yksi.
//
// Rahankäytön luokat vastaavat eri kysymykseen: mihin raha meni.
// "Ruoka" ei ole elämänalue eikä "Talous" ole kululuokka — kaikki
// kulut ovat taloutta. Kahden eri kysymyksen pakottaminen samaan
// luetteloon tekisi kummastakin huonomman.
//
// Nämä ovat siis rinnakkainen, ei päällekkäinen käsite. Tapahtumalla
// on kululuokka; tehtävällä on elämänalue.
//
// MUOKATTAVUUS MYÖHEMMIN
//
// Luettelo on vakio, koska omat luokat vaatisivat oman taulunsa ja
// omistajuutensa. Rakenne ei kuitenkaan estä sitä: kaikki koodi
// kulkee `normalizeExpenseCategory`-funktion kautta, joten lähde voi
// myöhemmin olla käyttäjän oma lista ilman että kutsupaikat muuttuvat.

/** Kululuokat. Avain on pysyvä, otsikko on käännettävissä. */
export const EXPENSE_CATEGORIES = Object.freeze([
  { key: 'asuminen',     label: 'Asuminen' },
  { key: 'ruoka',        label: 'Ruoka' },
  { key: 'liikkuminen',  label: 'Liikkuminen' },
  { key: 'auto',         label: 'Auto' },
  { key: 'terveys',      label: 'Terveys' },
  { key: 'vakuutukset',  label: 'Vakuutukset' },
  { key: 'laskut',       label: 'Laskut' },
  { key: 'harrastukset', label: 'Harrastukset' },
  { key: 'viihde',       label: 'Viihde' },
  { key: 'lapset',       label: 'Lapset ja perhe' },
  { key: 'ostokset',     label: 'Ostokset' },
  { key: 'tyo',          label: 'Työ' },
  { key: 'saastaminen',  label: 'Säästäminen' },
  { key: 'sijoittaminen', label: 'Sijoittaminen' },
  { key: 'muu',          label: 'Muu' }
]);

export const EXPENSE_CATEGORY_KEYS =
  Object.freeze(EXPENSE_CATEGORIES.map(category => category.key));

export const DEFAULT_EXPENSE_CATEGORY = 'muu';

/**
 * Tuloluokat.
 *
 * Erillinen luettelo, koska tulon ja menon luokat eivät ole sama
 * kysymys. "Ruoka" ei ole tulolaji, eikä "Palkka" ole kululuokka.
 * Yhdistetty luettelo tarjoaisi kummassakin lomakkeessa puolet
 * vääriä vaihtoehtoja.
 */
export const INCOME_CATEGORIES = Object.freeze([
  { key: 'palkka',      label: 'Palkka' },
  { key: 'yritystulo',  label: 'Yritystulo' },
  { key: 'etuus',       label: 'Etuus' },
  { key: 'palautus',    label: 'Palautus' },
  { key: 'lahja',       label: 'Lahja' },
  { key: 'myynti',      label: 'Myynti' },
  { key: 'korko',       label: 'Korko tai osinko' },
  { key: 'muu',         label: 'Muu tulo' }
]);

export const INCOME_CATEGORY_KEYS =
  Object.freeze(INCOME_CATEGORIES.map(category => category.key));

export const DEFAULT_INCOME_CATEGORY = 'muu';

/** Kululuokan otsikko, tai avain sellaisenaan jos luokka on tuntematon. */
export function expenseCategoryLabel(key) {
  const found = EXPENSE_CATEGORIES.find(category => category.key === key);
  return found ? found.label : 'Muu';
}

/** Tuloluokan otsikko. */
export function incomeCategoryLabel(key) {
  const found = INCOME_CATEGORIES.find(category => category.key === key);
  return found ? found.label : 'Muu tulo';
}

/** Tuntematon luokka normalisoituu oletukseksi, ei jää roikkumaan. */
export function normalizeExpenseCategory(key) {
  return EXPENSE_CATEGORY_KEYS.includes(key) ? key : DEFAULT_EXPENSE_CATEGORY;
}

export function normalizeIncomeCategory(key) {
  return INCOME_CATEGORY_KEYS.includes(key) ? key : DEFAULT_INCOME_CATEGORY;
}

/**
 * Luokan otsikko tapahtumalajin mukaan.
 *
 * Siirrolla ei ole kululuokkaa: se ei ole kulutusta eikä tuloa vaan
 * rahan siirtymistä paikasta toiseen.
 */
export function categoryLabelForKind(kind, key) {
  if (kind === 'income') return incomeCategoryLabel(key);
  if (kind === 'transfer') return 'Siirto';
  return expenseCategoryLabel(key);
}
