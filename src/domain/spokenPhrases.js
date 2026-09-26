// Puhutut muistutukset: suomenkieliset lauseet aiheittain ja ohjaustyyleittäin.
//
// PUHDAS MODUULI. Ei kelloa, ei puhesynteesiä, ei DOM:ia. Tämä moduuli vain
// PÄÄTTÄÄ MITÄ SANOTAAN; ääneen lukeminen kuuluu alustalle (natiivi
// TextToSpeech tai selaimen puhesynteesi), ja vain käyttäjän luvalla
// (life_settings.speechEnabled + aiheen toimitustapa).
//
// YKSITYISYYS
// Lause kuuluu kaikille, jotka ovat samassa huoneessa. Siksi lauseisiin EI
// KOSKAAN tule käyttäjän kirjoittamaa tekstiä: ei tapahtuman otsikkoa, ei
// paikan nimeä, ei muistiinpanoa, ei aterian eikä tavan nimeä. Mukaan
// pääsevät vain kellonajat ja minuuttimäärät, jotka moduuli muotoilee itse.
// Funktio ei edes ota vastaan vapaata tekstiä.
//
// LUVUT LUONNOLLISESTI
// Kellonaika sanotaan suomalaisittain pisteellä ilman etunollaa: "6.05",
// "23.00". Minuutit taivutetaan: "viiden minuutin päästä". Puhesyntetisaattori
// lukee "06:05" helposti "nolla kuusi kaksoispiste nolla viisi".
//
// SÄVY
// Rauhallinen (oletus): lempeä ja lyhyt. Napakka: mahdollisimman lyhyt.
// Aktiivinen: vähän enemmän tietoa ja rohkaisua. Ei koskaan syyllistämistä,
// ei käskyjä huutomerkein, ei terveysväitteitä.

import { GUIDANCE_STYLE, GUIDANCE_STYLES, HABIT_KIND } from './dailyLife.js';
import { NOTIFICATION_TYPE } from './notification.js';

/** Puhutun lauseen enimmäispituus merkkeinä. Pidempi on jo luento, ei muistutus. */
export const MAX_SPOKEN_LENGTH = 120;

/** Lähtöketjun "lähtö pian" -vaiheen oletus (minuuttia ennen lähtöä). */
export const DEFAULT_LEAVE_SOON_MINUTES = 5;

/**
 * Lisälause, jota ei ole omana ilmoitustyyppinään: lähtö nyt -muistutuksen
 * toisto aktiivisella tyylillä.
 */
export const PHRASE_REPEAT_LEAVE_NOW = 'departure_leave_now_repeat';

// ------------------------------------------------------------ luvut

const ONES_NOMINATIVE = Object.freeze(['nolla', 'yksi', 'kaksi', 'kolme', 'neljä', 'viisi',
  'kuusi', 'seitsemän', 'kahdeksan', 'yhdeksän']);
const ONES_GENITIVE = Object.freeze(['nollan', 'yhden', 'kahden', 'kolmen', 'neljän', 'viiden',
  'kuuden', 'seitsemän', 'kahdeksan', 'yhdeksän']);

/**
 * Kokonaisluku 0–99 sanoina perusmuodossa ("kaksikymmentäviisi") tai
 * genetiivissä ("kahdenkymmenenviiden"). Muut luvut numeroina: puhe-
 * syntetisaattori osaa ne, ja muistutuksissa niitä ei juuri tarvita.
 *
 * @param {number} value
 * @param {'nominative'|'genitive'} [form]
 */
export function numberWords(value, form = 'nominative') {
  if (!Number.isInteger(value) || value < 0) return null;
  if (value > 99) return String(value);
  const genitive = form === 'genitive';
  const ones = genitive ? ONES_GENITIVE : ONES_NOMINATIVE;
  if (value < 10) return ones[value];
  if (value === 10) return 'kymmenen';
  if (value < 20) return ones[value - 10] + 'toista';
  const tens = Math.floor(value / 10);
  const unit = value % 10;
  const tensWord = genitive ? ONES_GENITIVE[tens] + 'kymmenen' : ONES_NOMINATIVE[tens] + 'kymmentä';
  return unit === 0 ? tensWord : tensWord + ones[unit];
}

/** 'HH:MM' → '6.05'. Kelvoton → null. */
export function spokenTime(time) {
  if (typeof time !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  return `${Number(match[1])}.${match[2]}`;
}

/** "viiden minuutin päästä"; yksi minuutti: "minuutin päästä". Kelvoton → null. */
export function spokenMinutesFromNow(minutes) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return null;
  if (minutes === 1) return 'minuutin päästä';
  return `${numberWords(minutes, 'genitive')} minuutin päästä`;
}

function capitalize(text) {
  return text ? text.charAt(0).toLocaleUpperCase('fi') + text.slice(1) : text;
}

/** Muistutusten määrä: "yksi pieni muistutus" / "kolme pientä muistutusta". */
function spokenReminderCount(count) {
  if (count === 1) return 'yksi pieni muistutus';
  return `${numberWords(count)} pientä muistutusta`;
}

// ------------------------------------------------------------ sävy

/** Sanamuodon sävy ohjaustyylistä. Tuntematon tyyli on rauhallinen (oletus). */
export function wordingForStyle(style) {
  return GUIDANCE_STYLES.includes(style) ? style : GUIDANCE_STYLE.CALM;
}

const CALM = GUIDANCE_STYLE.CALM;
const BRISK = GUIDANCE_STYLE.BRISK;
const ACTIVE = GUIDANCE_STYLE.ACTIVE;

/** Valitse sävyn mukainen lause. */
function pick(style, variants) {
  return variants[style] ?? variants[CALM];
}

// Jokainen rakentaja saa vain muotoillut, turvalliset osat (kellonaika,
// minuuttimäärä). Rakentaja palauttaa null, kun lausetta ei ole.
const BUILDERS = Object.freeze({
  [NOTIFICATION_TYPE.DEPARTURE_PREPARE]: (style, ctx) => pick(style, {
    [CALM]: 'Valmistaudu lähtöön.',
    [BRISK]: 'Lähtövalmistelut nyt.',
    [ACTIVE]: ctx.time
      ? `Nyt on hyvä hetki aloittaa lähtövalmistelut. Lähtö on kello ${ctx.time}.`
      : 'Nyt on hyvä hetki aloittaa lähtövalmistelut.'
  }),

  [NOTIFICATION_TYPE.DEPARTURE_LEAVE_IN_5]: (style, ctx) => {
    const soon = spokenMinutesFromNow(ctx.minutes ?? DEFAULT_LEAVE_SOON_MINUTES);
    if (!soon) return null;
    return pick(style, {
      [CALM]: `${capitalize(soon)} pitää lähteä.`,
      [BRISK]: `Lähtö ${soon}.`,
      [ACTIVE]: `${capitalize(soon)} lähdetään. Tarkista, että tarvittavat tavarat ovat mukana.`
    });
  },

  [NOTIFICATION_TYPE.DEPARTURE_LEAVE_NOW]: style => pick(style, {
    [CALM]: 'Nyt kannattaa lähteä, jotta olet hyvissä ajoin paikalla.',
    [BRISK]: 'Nyt on lähdön aika.',
    [ACTIVE]: 'Nyt on lähdön aika. Kun lähdet nyt, olet hyvissä ajoin paikalla.'
  }),

  [PHRASE_REPEAT_LEAVE_NOW]: () => 'Muistutus: nyt on lähdön aika.',

  // Vanha matkasuunnitelman lähtömuistutus (10 min ennen).
  [NOTIFICATION_TYPE.DEPARTURE_REMINDER]: (style, ctx) => {
    const soon = spokenMinutesFromNow(ctx.minutes ?? 10);
    if (!soon) return null;
    return pick(style, {
      [CALM]: `${capitalize(soon)} on hyvä lähteä.`,
      [BRISK]: `Lähtö ${soon}.`,
      [ACTIVE]: `${capitalize(soon)} on hyvä lähteä. Tarkista, että tarvittavat tavarat ovat mukana.`
    });
  },

  [NOTIFICATION_TYPE.WIND_DOWN]: (style, ctx) => pick(style, {
    [CALM]: 'On hyvä hetki alkaa rauhoittua illaksi.',
    [BRISK]: 'Iltarauhoittumisen aika.',
    [ACTIVE]: ctx.bedtime
      ? `Nyt kannattaa aloittaa iltarauhoittuminen. Nukkumaanmeno on kello ${ctx.bedtime}.`
      : 'Nyt kannattaa aloittaa iltarauhoittuminen.'
  }),

  [NOTIFICATION_TYPE.BEDTIME]: (style, ctx) => pick(style, {
    [CALM]: 'Nyt on hyvä aika mennä nukkumaan.',
    [BRISK]: 'Nukkumaanmenon aika.',
    [ACTIVE]: ctx.wake
      ? `Nyt on hyvä aika mennä nukkumaan. Herätys on kello ${ctx.wake}.`
      : 'Nyt on hyvä aika mennä nukkumaan.'
  }),

  [NOTIFICATION_TYPE.MEAL]: (style, ctx) => {
    if (ctx.prep === false) {
      return pick(style, {
        [CALM]: 'Nyt on hyvä aika syödä.',
        [BRISK]: 'Ruoka-aika.',
        [ACTIVE]: 'Nyt on hyvä aika syödä. Ota hetki rauhassa.'
      });
    }
    return pick(style, {
      [CALM]: 'Nyt on hyvä aika aloittaa ruoan valmistus.',
      [BRISK]: 'Ruoanvalmistuksen aika.',
      [ACTIVE]: ctx.time
        ? `Nyt on hyvä aika aloittaa ruoan valmistus, niin ateria on valmis kello ${ctx.time}.`
        : 'Nyt on hyvä aika aloittaa ruoan valmistus.'
    });
  },

  [NOTIFICATION_TYPE.HABIT]: (style, ctx) => {
    const nicotine = ctx.habitKind === HABIT_KIND.NICOTINE;
    const what = nicotine ? 'nikotiiniaika' : 'aika';
    return pick(style, {
      [CALM]: `Seuraava suunniteltu ${what} on nyt.`,
      [BRISK]: `Suunniteltu ${what}.`,
      [ACTIVE]: `Seuraava suunniteltu ${what} on nyt. Voit myös siirtää sitä myöhemmäksi.`
    });
  },

  [NOTIFICATION_TYPE.EVENING_BEFORE]: (style, ctx) => {
    if (!ctx.firstLeave) {
      return pick(style, {
        [CALM]: 'Huomenna ei ole sovittuja lähtöjä.',
        [BRISK]: 'Huomenna ei lähtöjä.',
        [ACTIVE]: 'Huomenna ei ole sovittuja lähtöjä. Voit suunnitella aamun rauhassa.'
      });
    }
    return pick(style, {
      [CALM]: `Huomenna ensimmäinen lähtö on kello ${ctx.firstLeave}.`,
      [BRISK]: `Huomenna lähtö kello ${ctx.firstLeave}.`,
      [ACTIVE]: `Huomenna ensimmäinen lähtö on kello ${ctx.firstLeave}. Tavarat kannattaa valmistella jo illalla.`
    });
  },

  [NOTIFICATION_TYPE.MORNING_BRIEF]: (style, ctx) => {
    if (!ctx.firstLeave) {
      return pick(style, {
        [CALM]: 'Hyvää huomenta. Tänään ei ole sovittuja lähtöjä.',
        [BRISK]: 'Huomenta. Ei lähtöjä tänään.',
        [ACTIVE]: 'Hyvää huomenta! Tänään ei ole sovittuja lähtöjä, joten aamun voi ottaa rauhassa.'
      });
    }
    return pick(style, {
      [CALM]: `Hyvää huomenta. Tänään ensimmäinen lähtö on kello ${ctx.firstLeave}.`,
      [BRISK]: `Huomenta. Lähtö kello ${ctx.firstLeave}.`,
      [ACTIVE]: `Hyvää huomenta! Tänään ensimmäinen lähtö on kello ${ctx.firstLeave}.`
    });
  },

  [NOTIFICATION_TYPE.DIGEST]: (style, ctx) => {
    if (!Number.isInteger(ctx.count) || ctx.count < 1 || ctx.count > 99) return null;
    const phrase = spokenReminderCount(ctx.count);
    return pick(style, {
      [CALM]: `Sinulla on ${phrase}.`,
      [BRISK]: ctx.count === 1 ? 'Yksi muistutus.' : `${capitalize(numberWords(ctx.count))} muistutusta.`,
      [ACTIVE]: `Sinulla on ${phrase}. Katso ne, kun sinulle sopii.`
    });
  },

  [NOTIFICATION_TYPE.TASK_REMINDER]: (style, ctx) => {
    if (!ctx.time) {
      return pick(style, {
        [CALM]: 'Seuraava asia alkaa pian.',
        [BRISK]: 'Seuraava asia pian.',
        [ACTIVE]: 'Seuraava asia alkaa pian. Nyt on hyvä hetki valmistautua.'
      });
    }
    return pick(style, {
      [CALM]: `Seuraava asia alkaa kello ${ctx.time}.`,
      [BRISK]: `Kello ${ctx.time} seuraava asia.`,
      [ACTIVE]: `Seuraava asia alkaa kello ${ctx.time}. Nyt on hyvä hetki valmistautua.`
    });
  },

  [NOTIFICATION_TYPE.ROUTINE_REMINDER]: (style, ctx) => pick(style, {
    [CALM]: ctx.time ? `Seuraava rutiini alkaa kello ${ctx.time}.` : 'Seuraava rutiini alkaa pian.',
    [BRISK]: 'Rutiinin aika.',
    [ACTIVE]: ctx.time
      ? `Seuraava rutiini alkaa kello ${ctx.time}. Hyvä hetki valmistautua.`
      : 'Seuraava rutiini alkaa pian. Hyvä hetki valmistautua.'
  }),

  [NOTIFICATION_TYPE.DEADLINE_WARNING]: style => pick(style, {
    [CALM]: 'Sinulla on lähestyvä määräaika.',
    [BRISK]: 'Määräaika lähestyy.',
    [ACTIVE]: 'Sinulla on lähestyvä määräaika. Katso tehtävä, kun ehdit.'
  }),

  [NOTIFICATION_TYPE.DAILY_PLAN]: () => 'Päivän suunnitelma on valmiina.',
  [NOTIFICATION_TYPE.EVENING_REVIEW]: () => 'Päivän katsaus on valmiina.'
});

/** Lajit, joille on lause. */
export const PHRASE_KINDS = Object.freeze(Object.keys(BUILDERS));

/**
 * Puhuttava lause tai null.
 *
 * @param {string} kind  ilmoitustyyppi (NOTIFICATION_TYPE) tai PHRASE_REPEAT_LEAVE_NOW
 * @param {object} [context]
 * @param {string} [context.style]      ohjaustyyli (GUIDANCE_STYLE); oletus rauhallinen
 * @param {number} [context.minutes]    minuutteja (lähtö pian)
 * @param {string} [context.time]       'HH:MM': lähtö, aterian valmistuminen, tehtävän alku
 * @param {string} [context.bedtime]    'HH:MM' iltarauhoittumiseen
 * @param {string} [context.wake]       'HH:MM' nukkumaanmenoon
 * @param {string} [context.firstLeave] 'HH:MM' tai null (illan ja aamun kooste)
 * @param {string} [context.habitKind]  HABIT_KIND
 * @param {boolean}[context.prep]       ateria: false = ruoka-aika, muuten valmistus
 * @param {number} [context.count]      koosteen muistutusten määrä
 * @returns {string|null} enintään MAX_SPOKEN_LENGTH merkkiä
 */
export function spokenPhrase(kind, context) {
  try {
    return buildPhrase(kind, context);
  } catch {
    // Vihamielinen konteksti (heittävä getteri) ei kaada muistutusta:
    // ilmoitus näkyy silti, se vain jää sanomatta.
    return null;
  }
}

function buildPhrase(kind, context) {
  const builder = typeof kind === 'string' && Object.hasOwn(BUILDERS, kind) ? BUILDERS[kind] : null;
  if (!builder) return null;
  const raw = context && typeof context === 'object' ? context : {};

  // Vain tunnetut, muotoillut osat pääsevät lauseeseen. Vapaa teksti ei
  // voi päätyä ääneen, koska sitä ei edes lueta tästä oliosta.
  const safe = {
    minutes: Number.isInteger(raw.minutes) ? raw.minutes : undefined,
    time: spokenTime(raw.time),
    bedtime: spokenTime(raw.bedtime),
    wake: spokenTime(raw.wake),
    firstLeave: spokenTime(raw.firstLeave),
    habitKind: raw.habitKind === HABIT_KIND.NICOTINE ? HABIT_KIND.NICOTINE : HABIT_KIND.GENERIC,
    prep: raw.prep !== false,
    count: Number.isInteger(raw.count) ? raw.count : null
  };

  const text = builder(wordingForStyle(raw.style), safe);
  if (typeof text !== 'string' || !text) return null;
  // Rakenteellinen yläraja: jos lause jostain syystä venyisi, sitä ei
  // katkaista kesken sanan vaan jätetään sanomatta.
  return text.length <= MAX_SPOKEN_LENGTH ? text : null;
}
