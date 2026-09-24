// Automaatiotasot: mitä järjestelmä saa tehdä kysymättä.
//
// =====================================================================
// OLETUS ON VAROVAISIN
// =====================================================================
//
// Taso 1 on oletus, ja se on tarkoituksellinen. Käyttäjä, joka ei ole
// tehnyt valintaa, ei ole antanut lupaa — ja hiljaisuutta ei tulkita
// luvaksi. Tason nostaminen on aina käyttäjän oma teko.
//
// Tasoa 4 EI voi ottaa käyttöön vahingossa: se vaatii nimenomaisen
// valinnan, ja `requiresExplicitOptIn` kertoo sen kutsupaikalle.
//
// =====================================================================
// MIKÄÄN TASO EI SIIRRÄ KIINTEÄÄ
// =====================================================================
//
// Käyttäjän itse asettama aika on koskematon jokaisella tasolla, myös
// neljännellä. `isMovableByScheduler` (src/domain/task.js) on se
// portti, ja tämä moduuli kaventaa sitä — ei koskaan laajenna.
//
// Tämä on tuotteen keskeinen lupaus: järjestelmä ei tuhoa käyttäjän
// omaa päätöstä. Automaatiotaso päättää kuinka pitkälle JOUSTAVAA työtä
// saa siirtää, ei sitä, mikä on joustavaa.

import { fmtISO, parseISO, addDays, startOfWeek } from '../lib/datetime.js';
import { isIsoDate } from './task.js';

/**
 * Automaatiotasot.
 *
 * Numerot ovat järjestykseltään merkityksellisiä: suurempi taso sallii
 * kaiken minkä pienempikin. Vertailu `>=`:llä on siksi turvallinen.
 */
export const AUTOMATION_LEVEL = Object.freeze({
  /** Ehdottaa vain. Jokainen siirto vaatii hyväksynnän. */
  SUGGEST_ONLY: 1,
  /** Saa siirtää joustavaa työtä SAMAN PÄIVÄN sisällä. */
  SAME_DAY: 2,
  /** Saa siirtää joustavaa työtä SAMAN VIIKON sisällä. */
  SAME_WEEK: 3,
  /** Saa optimoida joustavaa työtä sovituissa rajoissa. */
  OPTIMIZE: 4
});

export const AUTOMATION_LEVELS = Object.freeze(Object.values(AUTOMATION_LEVEL));

/** Oletus. Varovaisin mahdollinen. */
export const DEFAULT_AUTOMATION_LEVEL = AUTOMATION_LEVEL.SUGGEST_ONLY;

const LEVEL_LABELS = Object.freeze({
  [AUTOMATION_LEVEL.SUGGEST_ONLY]: 'Vain ehdotukset',
  [AUTOMATION_LEVEL.SAME_DAY]: 'Saman päivän sisällä',
  [AUTOMATION_LEVEL.SAME_WEEK]: 'Saman viikon sisällä',
  [AUTOMATION_LEVEL.OPTIMIZE]: 'Automaattinen optimointi'
});

const LEVEL_DESCRIPTIONS = Object.freeze({
  [AUTOMATION_LEVEL.SUGGEST_ONLY]:
    'Manifestival ehdottaa, sinä päätät. Mitään ei siirretä ilman hyväksyntääsi.',
  [AUTOMATION_LEVEL.SAME_DAY]:
    'Manifestival saa järjestellä joustavaa työtä saman päivän sisällä. '
    + 'Itse asettamiasi aikoja ei siirretä.',
  [AUTOMATION_LEVEL.SAME_WEEK]:
    'Manifestival saa siirtää joustavaa työtä saman viikon sisällä. '
    + 'Itse asettamiasi aikoja ei siirretä.',
  [AUTOMATION_LEVEL.OPTIMIZE]:
    'Manifestival saa optimoida joustavaa työtä horisontin sisällä. '
    + 'Itse asettamiasi aikoja ei siirretä, eikä määräaikoja ylitetä.'
});

export function automationLevelLabel(level) {
  return LEVEL_LABELS[normalizeAutomationLevel(level)];
}

export function automationLevelDescription(level) {
  return LEVEL_DESCRIPTIONS[normalizeAutomationLevel(level)];
}

/**
 * Normalisoi taso.
 *
 * Tuntematon arvo putoaa VAROVAISIMPAAN, ei lähimpään. Rikkinäinen
 * asetus ei saa avata automaatiota.
 */
export function normalizeAutomationLevel(value) {
  const n = Math.trunc(Number(value));
  return AUTOMATION_LEVELS.includes(n) ? n : DEFAULT_AUTOMATION_LEVEL;
}

/**
 * Vaatiiko taso nimenomaisen valinnan?
 *
 * Taso 4 antaa järjestelmän muuttaa suunnitelmaa ilman että käyttäjä
 * näkee muutosta ennen sen tapahtumista. Se on eri asia kuin tasot 2 ja
 * 3, joissa liike on rajattu näkyvään ikkunaan — ja siksi se vaatii
 * oman päätöksensä.
 */
export function requiresExplicitOptIn(level) {
  return normalizeAutomationLevel(level) === AUTOMATION_LEVEL.OPTIMIZE;
}

/** Saako tällä tasolla siirtää mitään ilman hyväksyntää? */
export function allowsAutoMove(level) {
  return normalizeAutomationLevel(level) > AUTOMATION_LEVEL.SUGGEST_ONLY;
}

/**
 * Sallittu siirtoikkuna tasolle.
 *
 * Palauttaa `{ fromIso, toIso }` tai `null`, jos automaattista siirtoa
 * ei sallita lainkaan.
 *
 * IKKUNA LASKETAAN TEHTÄVÄN NYKYISESTÄ PÄIVÄSTÄ, ei tästä päivästä.
 * Taso 2 tarkoittaa "saman päivän sisällä" — sen päivän, jossa tehtävä
 * on, ei sen jossa käyttäjä sattuu olemaan.
 *
 * @param {number} level
 * @param {string} taskDateIso  tehtävän nykyinen päivä
 * @param {object} [options]
 * @param {string} [options.horizonEndIso] taso 4:n uloin raja
 */
export function moveWindow(level, taskDateIso, { horizonEndIso = null } = {}) {
  const normalized = normalizeAutomationLevel(level);
  if (!isIsoDate(taskDateIso)) return null;

  if (normalized === AUTOMATION_LEVEL.SUGGEST_ONLY) return null;

  if (normalized === AUTOMATION_LEVEL.SAME_DAY) {
    return { fromIso: taskDateIso, toIso: taskDateIso };
  }

  if (normalized === AUTOMATION_LEVEL.SAME_WEEK) {
    // Viikko luetaan sovelluksen omasta viikkokäsityksestä
    // (maanantai-alkuinen), ei kirjoiteta tähän uudelleen.
    const weekStart = startOfWeek(parseISO(taskDateIso));
    return {
      fromIso: fmtISO(weekStart),
      toIso: fmtISO(addDays(weekStart, 6))
    };
  }

  // TASO 4: horisontin sisällä, mutta ei rajattomasti.
  //
  // Ilman ylärajaa optimoija saisi siirtää tehtävän vuoden päähän ja
  // kutsua sitä optimoinniksi.
  return {
    fromIso: taskDateIso,
    toIso: horizonEndIso && horizonEndIso >= taskDateIso ? horizonEndIso : taskDateIso
  };
}

/**
 * Saako tehtävän siirtää päivästä toiseen tällä tasolla?
 *
 * KOLME EHTOA, JOISTA JOKAINEN VOI ESTÄÄ YKSIN:
 *
 *   1. tehtävä on joustava (kutsuja tarkistaa `isMovableByScheduler`)
 *   2. taso sallii automaattisen siirron
 *   3. kohdepäivä on sallitussa ikkunassa
 *
 * Tämä funktio vastaa ehtoihin 2 ja 3. Ehto 1 on tehtävän oma
 * ominaisuus eikä automaatiotason asia — sen sekoittaminen tähän
 * tarkoittaisi kahta paikkaa, jossa kiinteä työ voi vahingossa muuttua
 * siirrettäväksi.
 */
export function canMoveTo(level, fromDateIso, toDateIso, options = {}) {
  const sallittu = moveWindow(level, fromDateIso, options);
  if (!sallittu) return false;
  if (!isIsoDate(toDateIso)) return false;
  return toDateIso >= sallittu.fromIso && toDateIso <= sallittu.toIso;
}

/**
 * Miksi siirto ei ollut sallittu?
 *
 * Käyttöliittymä näyttää tämän. Kielto ilman perustelua on mielivaltaa,
 * ja käyttäjä ei voi korjata sitä mitä hän ei ymmärrä.
 */
export function explainRefusal(level, fromDateIso, toDateIso) {
  const normalized = normalizeAutomationLevel(level);

  if (normalized === AUTOMATION_LEVEL.SUGGEST_ONLY) {
    return 'Automaatiotaso on "vain ehdotukset", joten siirto odottaa hyväksyntääsi.';
  }

  const sallittu = moveWindow(normalized, fromDateIso);
  if (!sallittu) return 'Siirtoa ei voitu arvioida.';

  if (normalized === AUTOMATION_LEVEL.SAME_DAY) {
    return 'Automaatiotaso sallii siirron vain saman päivän sisällä.';
  }
  if (normalized === AUTOMATION_LEVEL.SAME_WEEK) {
    return 'Automaatiotaso sallii siirron vain saman viikon sisällä'
      + ` (${sallittu.fromIso} – ${sallittu.toIso}).`;
  }
  return 'Siirto olisi horisontin ulkopuolella.';
}

/**
 * Suodata siirrot, jotka taso sallii tehdä ilman hyväksyntää.
 *
 * Palauttaa kaksi joukkoa: automaattisesti sallitut ja hyväksyntää
 * vaativat. KUMPIKAAN EI OLE TYHJENNYS: hyväksyntää vaativa siirto ei
 * katoa, se odottaa käyttäjää.
 *
 * @param {number} level
 * @param {Array<{taskId:string, fromDateIso:string, toDateIso:string}>} moves
 */
export function partitionMoves(level, moves = [], options = {}) {
  const automatic = [];
  const needsApproval = [];

  for (const move of moves) {
    if (!move) continue;
    if (canMoveTo(level, move.fromDateIso, move.toDateIso, options)) {
      automatic.push(move);
    } else {
      needsApproval.push({
        ...move,
        reason: explainRefusal(level, move.fromDateIso, move.toDateIso)
      });
    }
  }

  return { automatic, needsApproval };
}
