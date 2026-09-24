// Tavoitteen mitattava kohde.
//
// "Haluan pudottaa 10 kg" ei ole tehtävälista. Se on LUKU, joka liikkuu
// suuntaan tai toiseen, ja sen edistyminen on mitattavissa ilman että
// yhtäkään tehtävää merkitään tehdyksi.
//
// ---------------------------------------------------------------
// SUUNTA ON OSA TAVOITETTA
// ---------------------------------------------------------------
//
// 82 kg on edistystä, jos tavoite on 75 kg lähtien 90 kg:sta.
// 82 kg on taantumista, jos tavoite on 90 kg lähtien 75 kg:sta.
//
// Sama luku, päinvastainen merkitys. Ilman lähtöarvoa ja suuntaa
// mittarista ei voi laskea edistymistä lainkaan — ja arvattu suunta
// näyttäisi täsmälleen yhtä varmalta kuin tiedetty.
//
// Siksi mittarissa on kolme lukua eikä yhtä:
//
//   baseline   mistä lähdettiin
//   current    missä ollaan nyt
//   target     mihin pyritään
//
// Suunta JOHDETAAN näistä. Sitä ei kysytä erikseen, koska erikseen
// kysytty suunta voi olla ristiriidassa lukujen kanssa — ja silloin
// jompikumpi on väärässä ilman että kumpikaan kertoo sen.
//
// ---------------------------------------------------------------
// TUNTEMATON EI OLE NOLLA
// ---------------------------------------------------------------
//
// Jos lähtöarvoa ei ole, edistymistä ei lasketa. `known: false` on
// rehellinen; nolla prosenttia olisi väite siitä, ettei mitään ole
// tapahtunut.

/** Mittarin yksikkö on vapaa teksti, mutta pituus on rajattu. */
const MAX_UNIT = 20;
const MAX_LABEL = 60;

/**
 * Mittarin suunta.
 *
 * JOHDETTU, ei syötetty. Ks. tiedoston alku.
 */
export const METRIC_DIRECTION = Object.freeze({
  /** Tavoite on lähtöarvoa suurempi: säästöt, toistot, liikevaihto. */
  INCREASE: 'increase',
  /** Tavoite on lähtöarvoa pienempi: paino, velka, kulut. */
  DECREASE: 'decrease',
  /** Lähtöarvo on jo tavoite. Kyse on ylläpidosta. */
  MAINTAIN: 'maintain'
});

/**
 * Yleisiä yksiköitä käyttöliittymän valikkoon.
 *
 * Vapaa teksti kelpaa yhä: tämä on ehdotuslista eikä rajoite. Kaikkia
 * mitattavia asioita ei voi luetella etukäteen.
 */
export const COMMON_UNITS = Object.freeze([
  'kg', 'km', 'h', 'min', 'kpl', '%', '€', 'krt/vk'
]);

function cleanText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

/**
 * Luku tai null.
 *
 * MITTARI EI OLE RAHAA eikä sitä pidetä sentteinä: paino on 82,4 kg ja
 * matka 12,5 km. Rahatavoitteet kulkevat Talouden kautta, jossa summat
 * ovat kokonaislukuja sentteinä — ks. `src/domain/finance.js` ja tämän
 * tiedoston loppu.
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Onko tavoitteella mitattava kohde lainkaan? */
export function hasTarget(target) {
  return Boolean(target) && target.targetValue !== null;
}

/**
 * Normalisoi mitattava kohde.
 *
 * Kaikki kolme lukua ovat vapaaehtoisia erikseen, mutta edistymistä ei
 * lasketa ilman kaikkia kolmea. Se on tarkoituksellista: käyttäjä voi
 * kirjata tavoitteen ennen kuin tietää lähtöarvonsa.
 */
export function normalizeTarget(input = {}) {
  return {
    /** Mitä mitataan. Vapaa teksti: "paino", "säästöt", "juoksukilometrit". */
    metric: cleanText(input.metric, MAX_LABEL),
    unit: cleanText(input.unit, MAX_UNIT),

    baselineValue: numberOrNull(input.baselineValue),
    currentValue: numberOrNull(input.currentValue),
    targetValue: numberOrNull(input.targetValue),

    /** Milloin nykyarvo kirjattiin. Ilman tätä luku ei kerro ikäänsä. */
    measuredOn: typeof input.measuredOn === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(input.measuredOn)
      ? input.measuredOn : null
  };
}

/**
 * Mittarin suunta lähtö- ja tavoitearvosta.
 *
 * Palauttaa `null` kun suuntaa ei voi päätellä. Arvattu suunta olisi
 * pahin vaihtoehto: se kääntäisi edistymisen ja taantumisen keskenään.
 */
export function directionOf(target) {
  if (!target) return null;
  const { baselineValue, targetValue } = target;
  if (baselineValue === null || targetValue === null) return null;

  if (targetValue > baselineValue) return METRIC_DIRECTION.INCREASE;
  if (targetValue < baselineValue) return METRIC_DIRECTION.DECREASE;
  return METRIC_DIRECTION.MAINTAIN;
}

/**
 * Mittarin edistyminen prosentteina.
 *
 * Kaava on sama molempiin suuntiin, koska se lasketaan MATKASTA eikä
 * arvosta:
 *
 *   kuljettu / koko matka
 *
 * Painonpudotuksessa 90 -> 82 tavoitteena 75 on 8/15 = 53 %.
 * Säästämisessä 0 -> 4000 tavoitteena 10000 on 4000/10000 = 40 %.
 *
 * Sama koodi, ei kahta haaraa. Kaksi haaraa tarkoittaisi kaksi paikkaa,
 * joissa etumerkki voi mennä väärin päin.
 *
 * PALAUTTAA `known: false` KUN LASKEMINEN EI OLE MIELEKÄSTÄ. Tuntematon
 * ei ole nolla.
 */
export function metricProgress(target) {
  if (!target) return unknownProgress();

  const { baselineValue, currentValue, targetValue } = target;
  if (baselineValue === null || currentValue === null || targetValue === null) {
    return unknownProgress();
  }

  const span = targetValue - baselineValue;

  // YLLÄPITOTAVOITE: lähtöarvo on jo tavoite.
  //
  // Matkaa ei ole, joten osuutta siitä ei voi laskea. Vastaus on
  // binäärinen: ollaanko yhä tavoitteessa vai ei.
  if (span === 0) {
    const atTarget = currentValue === targetValue;
    return {
      known: true,
      percent: atTarget ? 100 : 0,
      direction: METRIC_DIRECTION.MAINTAIN,
      reached: atTarget,
      regressed: !atTarget,
      remaining: Math.abs(targetValue - currentValue)
    };
  }

  const travelled = currentValue - baselineValue;
  const ratio = travelled / span;

  return {
    known: true,
    // Rajataan 0-100. Yli sadan prosentin edistyminen on saavutus eikä
    // virhe, mutta palkki ei voi olla täydempi kuin täysi.
    percent: Math.max(0, Math.min(100, Math.round(ratio * 100))),
    direction: directionOf(target),
    reached: ratio >= 1,
    /** Onko liikuttu VÄÄRÄÄN suuntaan lähtöarvosta? */
    regressed: ratio < 0,
    remaining: Math.abs(targetValue - currentValue)
  };
}

function unknownProgress() {
  return {
    known: false,
    percent: null,
    direction: null,
    reached: false,
    regressed: false,
    remaining: null
  };
}

/**
 * Ihmisluettava kuvaus mittarista.
 *
 * Käytetään perusteluissa ja tavoitenäkymässä. Palauttaa tyhjän, kun
 * mittaria ei ole — tyhjä on parempi kuin "0 / 0".
 */
export function describeTarget(target) {
  if (!hasTarget(target)) return '';

  const unit = target.unit ? ` ${target.unit}` : '';
  const nimi = target.metric || 'Tavoite';

  if (target.currentValue === null) {
    return `${nimi}: tavoite ${formatNumber(target.targetValue)}${unit}`;
  }

  return `${nimi}: ${formatNumber(target.currentValue)}${unit}`
    + ` / ${formatNumber(target.targetValue)}${unit}`;
}

/** Suomalainen desimaalierotin, turhat nollat pois. */
export function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(Number(value.toFixed(3))).replace('.', ',');
}

export function validateTarget(target) {
  const errors = {};
  if (!target) return { valid: true, errors };

  // Mittari ilman nimeä on luku ilman merkitystä.
  if (target.targetValue !== null && !target.metric) {
    errors.metric = 'Kerro mitä mitataan.';
  }

  // Lähtöarvo ilman tavoitetta ei kerro mihin pyritään.
  if (target.baselineValue !== null && target.targetValue === null) {
    errors.targetValue = 'Anna tavoitearvo.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// =====================================================================
// TALOUSYHTEYS
// =====================================================================
//
// Rahatavoite ("säästä 10 000 euroa") on mittaritavoite, mutta sen
// laskenta kuuluu Taloudelle. Talous 2.0 osaa jo:
//
//   monthlyContributionMinor   paljonko kuussa, jotta ehtii
//   monthsToReach              kuinka monta kuukautta annetulla erällä
//   suggestSavingsMinor        ehdotus ylijäämästä
//
// TÄTÄ LASKENTAA EI TOISTETA TÄÄLLÄ. Kaksi toteutusta samasta
// kaavasta erkanisi ennemmin tai myöhemmin, ja toinen niistä olisi
// väärässä ilman että mikään kertoo sen.
//
// Sen sijaan tavoite VIITTAA säästötavoitteeseen, ja Talous laskee.

/**
 * Onko tavoite kytketty säästötavoitteeseen?
 *
 * Kytketty rahatavoite EI saa myös kantaa omaa mittariaan: kaksi
 * lukua samasta asiasta erkanisi heti kun toista päivitetään.
 */
export function isLinkedToSavings(goal) {
  return Boolean(goal && goal.savingsGoalId);
}

/**
 * Rahatavoitteen edistyminen SÄÄSTÖTAVOITTEESTA.
 *
 * Ottaa vastaan Talouden `summarizeSavingsGoal`-tuloksen eikä laske
 * mitään itse. Tämä funktio on pelkkä muunnos: se kääntää Talouden
 * vastauksen samaan muotoon kuin `metricProgress`, jotta tavoitteen
 * edistyminen voidaan näyttää yhdellä koodipolulla.
 *
 * @param {object|null} savingsSummary summarizeSavingsGoal(goal)
 */
export function progressFromSavings(savingsSummary) {
  if (!savingsSummary || !savingsSummary.goal) return unknownProgress();

  const { goal, percent, reached } = savingsSummary;
  if (goal.targetMinor === null) return unknownProgress();

  return {
    known: true,
    percent,
    direction: METRIC_DIRECTION.INCREASE,
    reached: Boolean(reached),
    regressed: false,
    remaining: savingsSummary.remainingMinor
  };
}
