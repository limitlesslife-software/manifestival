// Universaali kirjaus: mitä käyttäjä tarkoitti ja minne se kuuluu.
//
// =====================================================================
// KÄYTTÄJÄ EI VALITSE MODUULIA ENSIN
// =====================================================================
//
// "Vie auto katsastukseen ensi viikolla" on tehtävä.
// "Haluan laihtua 10 kiloa" on tavoite.
// "Lisää 120 euroa ruokamenoihin" on tapahtuma.
// "Pidä joka maanantai projektipalaveri" on rutiini.
//
// Käyttäjä ei tiedä eroa eikä hänen tarvitse. Hän kirjoittaa asian, ja
// järjestelmä EHDOTTAA minne se kuuluu.
//
// =====================================================================
// EHDOTUS EI OLE TOIMENPIDE
// =====================================================================
//
// Tämä moduuli EI luo mitään. Se tuottaa reitityspäätöksen, jonka
// sovelluskerros toteuttaa vasta käyttäjän hyväksynnän jälkeen.
//
// `routeOf()` palauttaa `null` kaikesta, mitä ei voi turvallisesti
// reitittää — ja epävarma reititys on `NOTE`, ei arvaus. Väärään
// moduuliin luotu rivi on pahempi kuin kirjaamaton rivi: se näyttää
// oikealta ja löytyy väärästä paikasta.
//
// =====================================================================
// SOVELLUS PÄÄTTÄÄ, EI MALLI
// =====================================================================
//
// Malli saa ehdottaa kohdetta. Sovellus tarkistaa, onko kohde olemassa,
// sallittu ja mielekäs. Tuntematon kohde EI ole virhe vaan
// epävarmuus — ja epävarmuus menee saapuviin, ei domainiin.

import { isIsoDate, isTimeOfDay, MAX_TITLE_LENGTH } from './task.js';
import { normalizeCategory } from './categories.js';
import { normalizePriority } from './priority.js';
import { normalizeExpenseCategory, normalizeIncomeCategory } from './financeCategories.js';
import { normalizeMinor } from './money.js';
import { RISK, isForbidden as isForbiddenOperation } from './risk.js';

/**
 * Mihin kirjaus kuuluu.
 *
 * Tämä on KOHDE, ei komento. `src/ai/intentSchema.js`:n `INTENT` on
 * verbi + kohde ("create_task"); tämä on pelkkä domain. Ero on
 * tarkoituksellinen: kirjaus ei muokkaa eikä poista mitään, se vain
 * luo — ja luontiin riittää tieto siitä, mihin.
 */
export const CAPTURE_KIND = Object.freeze({
  TASK: 'task',
  /** Tehtävä, jonka pääasia on muistutus eikä tekeminen. */
  REMINDER: 'reminder',
  GOAL: 'goal',
  PROJECT: 'project',
  ROUTINE: 'routine',
  /** Meno tai tulo. */
  TRANSACTION: 'transaction',
  BILL: 'bill',
  SAVINGS: 'savings',
  /** Määräaikaan saapuminen: "olla Kuopiossa klo 10". */
  TRAVEL: 'travel',
  /** Muistiinpano. Jää saapuviin sellaisenaan. */
  NOTE: 'note',
  /** Ei tulkittavissa. Kysytään käyttäjältä. */
  AMBIGUOUS: 'ambiguous'
});

export const CAPTURE_KINDS = Object.freeze(Object.values(CAPTURE_KIND));

const KIND_LABELS = Object.freeze({
  [CAPTURE_KIND.TASK]: 'Tehtävä',
  [CAPTURE_KIND.REMINDER]: 'Muistutus',
  [CAPTURE_KIND.GOAL]: 'Tavoite',
  [CAPTURE_KIND.PROJECT]: 'Projekti',
  [CAPTURE_KIND.ROUTINE]: 'Rutiini',
  [CAPTURE_KIND.TRANSACTION]: 'Rahatapahtuma',
  [CAPTURE_KIND.BILL]: 'Lasku',
  [CAPTURE_KIND.SAVINGS]: 'Säästötavoite',
  [CAPTURE_KIND.TRAVEL]: 'Matka ja lähtöaika',
  [CAPTURE_KIND.NOTE]: 'Muistiinpano',
  [CAPTURE_KIND.AMBIGUOUS]: 'Epäselvä'
});

export function captureKindLabel(kind) {
  return KIND_LABELS[kind] || KIND_LABELS[CAPTURE_KIND.NOTE];
}

/** Varmuus. Sama kolmiportainen asteikko kuin kuittiluennassa. */
export const CONFIDENCE = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
});

export const CONFIDENCE_LEVELS = Object.freeze(Object.values(CONFIDENCE));

/**
 * Varmuusraja, jonka alle jäävä tulkinta menee tarkistettavaksi.
 *
 * LOW ei riitä ehdotukseksi. Se ei tarkoita, että ehdotus olisi väärä —
 * se tarkoittaa, ettei käyttäjä saa luulla sitä varmaksi.
 */
export const REVIEW_THRESHOLD = CONFIDENCE.MEDIUM;

function confidenceRank(value) {
  return { high: 2, medium: 1, low: 0 }[value] ?? 0;
}

/** Vaatiiko tämä tulkinta erillisen tarkistuksen? */
export function needsReview(interpretation) {
  if (!interpretation) return true;
  if (interpretation.kind === CAPTURE_KIND.AMBIGUOUS) return true;
  return confidenceRank(interpretation.confidence)
    < confidenceRank(REVIEW_THRESHOLD);
}

function cleanText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInt(value, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return max ? Math.min(n, max) : n;
}

/**
 * Normalisoi tulkinta.
 *
 * TÄMÄ ON TEKOÄLYN TUOTTAMAA TIETOA. Se normalisoidaan yhtä tiukasti
 * kuin mikä tahansa ulkoinen syöte: kelvoton arvo muuttuu nulliksi eikä
 * arvaukseksi, ja tuntematon kohde putoaa muistiinpanoksi.
 */
export function normalizeInterpretation(input = {}) {
  const kind = CAPTURE_KINDS.includes(input.kind) ? input.kind : CAPTURE_KIND.NOTE;
  const confidence = CONFIDENCE_LEVELS.includes(input.confidence)
    ? input.confidence : CONFIDENCE.LOW;

  return {
    kind,
    confidence,

    /** Lyhyt nimi, joka näkyy luodussa rivissä. */
    title: cleanText(input.title, MAX_TITLE_LENGTH),

    /** Päivä ja kellonaika. Päivä ilman aikaa on täysin kelvollinen. */
    date: isIsoDate(input.date) ? input.date : null,
    time: isTimeOfDay(input.time) ? input.time : null,
    endTime: isTimeOfDay(input.endTime) ? input.endTime : null,
    durationMinutes: positiveInt(input.durationMinutes, 1440),

    category: input.category ? normalizeCategory(input.category) : null,
    priority: input.priority ? normalizePriority(input.priority) : null,

    /** Muistutuksen etuaika minuutteina. */
    reminderLeadMinutes: positiveInt(input.reminderLeadMinutes, 10080),

    /**
     * Rahasumma SENTTEINÄ, aina positiivinen.
     *
     * Suunta tulee `transactionKind`-kentästä, ei etumerkistä. Sama
     * sääntö kuin Talous 2.0:n tapahtumissa.
     */
    amountMinor: normalizeMinor(input.amountMinor),
    transactionKind: ['expense', 'income'].includes(input.transactionKind)
      ? input.transactionKind : null,
    financeCategory: cleanText(input.financeCategory, 40),

    /** Mitattava tavoite. Kolme lukua, suunta johdetaan. */
    metric: cleanText(input.metric, 60),
    unit: cleanText(input.unit, 20),
    baselineValue: numberOrNull(input.baselineValue),
    targetValue: numberOrNull(input.targetValue),

    /** Toistuvuus rutiineille. */
    recurrenceType: ['daily', 'weekly'].includes(input.recurrenceType)
      ? input.recurrenceType : null,
    weekdays: Array.isArray(input.weekdays)
      ? [...new Set(input.weekdays
        .map(d => Math.trunc(Number(d)))
        .filter(d => Number.isInteger(d) && d >= 1 && d <= 7))].sort()
      : [],

    /**
     * Matkakohde ja saapumisaika.
     *
     * TÄMÄ ON PAIKAN NIMI, EI KOORDINAATTI. Malli ei näe eikä tarvitse
     * käyttäjän sijaintia. Ks. `src/domain/travel.js`.
     */
    destination: cleanText(input.destination, 200),
    arrivalTime: isTimeOfDay(input.arrivalTime) ? input.arrivalTime : null,
    arrivalDate: isIsoDate(input.arrivalDate) ? input.arrivalDate : null,

    /** Mitä malli oletti ilman että käyttäjä sanoi sitä. */
    assumptions: (Array.isArray(input.assumptions) ? input.assumptions : [])
      .slice(0, 5)
      .map(text => cleanText(text, 200))
      .filter(Boolean),

    /** Mitä malli ei osannut päätellä. */
    question: cleanText(input.question, 200)
  };
}

/**
 * Onko tulkinta riittävä kohteeseensa?
 *
 * KOHDEKOHTAINEN VÄHIMMÄISVAATIMUS. Rahatapahtuma ilman summaa ei ole
 * rahatapahtuma; rutiini ilman toistuvuutta ei toistu. Puutteellinen
 * tulkinta ei ole virhe vaan epävarmuus — se menee tarkistettavaksi.
 */
export function validateInterpretation(interpretation) {
  const errors = {};
  if (!interpretation) return { valid: false, errors: { kind: 'Tulkintaa ei ole.' } };

  const { kind } = interpretation;

  if (kind === CAPTURE_KIND.AMBIGUOUS || kind === CAPTURE_KIND.NOTE) {
    // Muistiinpano ja epäselvä eivät vaadi mitään: ne jäävät saapuviin.
    return { valid: true, errors };
  }

  if (!interpretation.title) errors.title = 'Nimi puuttuu.';

  if (kind === CAPTURE_KIND.TRANSACTION) {
    if (interpretation.amountMinor === null) errors.amountMinor = 'Summa puuttuu.';
    else if (interpretation.amountMinor <= 0) {
      errors.amountMinor = 'Summan pitää olla suurempi kuin nolla.';
    }
    if (!interpretation.transactionKind) {
      errors.transactionKind = 'Onko kyseessä meno vai tulo?';
    }
  }

  if (kind === CAPTURE_KIND.BILL) {
    if (interpretation.amountMinor === null) errors.amountMinor = 'Summa puuttuu.';
    if (!interpretation.date) errors.date = 'Eräpäivä puuttuu.';
  }

  if (kind === CAPTURE_KIND.SAVINGS && interpretation.amountMinor === null) {
    errors.amountMinor = 'Tavoitesumma puuttuu.';
  }

  if (kind === CAPTURE_KIND.ROUTINE && !interpretation.recurrenceType) {
    errors.recurrenceType = 'Kuinka usein tämä toistuu?';
  }

  if (kind === CAPTURE_KIND.TRAVEL) {
    if (!interpretation.destination) errors.destination = 'Minne?';
    if (!interpretation.arrivalTime) errors.arrivalTime = 'Mihin aikaan pitää olla perillä?';
  }

  if (kind === CAPTURE_KIND.REMINDER && !interpretation.date) {
    errors.date = 'Milloin muistutan?';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// =====================================================================
// REITITYS
// =====================================================================

/**
 * Mihin domain-toimintoon tämä kirjaus menee?
 *
 * Palauttaa reittikuvauksen tai `null`, jos kirjausta ei voi
 * turvallisesti reitittää.
 *
 * TÄMÄ EI KUTSU MITÄÄN. Se kertoo, mitä kutsuttaisiin — ja
 * sovelluskerros kutsuu vasta hyväksynnän jälkeen. Reitin ja
 * toteutuksen erillisyys on koko turvamallin ydin: reitti voidaan
 * näyttää, tarkistaa ja hylätä ilman että mitään tapahtuu.
 */
export function routeOf(interpretation) {
  if (!interpretation) return null;

  const { kind } = interpretation;

  // EPÄSELVÄ JA MUISTIINPANO EIVÄT REITITY MIHINKÄÄN.
  //
  // Ne jäävät saapuviin. Se on tarkoitus: kirjaus onnistui, tulkinta
  // ei — ja käyttäjä päättää myöhemmin.
  if (kind === CAPTURE_KIND.NOTE || kind === CAPTURE_KIND.AMBIGUOUS) return null;

  const { valid } = validateInterpretation(interpretation);
  if (!valid) return null;

  const routes = {
    [CAPTURE_KIND.TASK]: { action: 'createTask', risk: RISK.MEDIUM },
    [CAPTURE_KIND.REMINDER]: { action: 'createTask', risk: RISK.MEDIUM },
    [CAPTURE_KIND.GOAL]: { action: 'createGoal', risk: RISK.MEDIUM },
    [CAPTURE_KIND.PROJECT]: { action: 'createProject', risk: RISK.MEDIUM },
    [CAPTURE_KIND.ROUTINE]: { action: 'createRoutine', risk: RISK.MEDIUM },
    [CAPTURE_KIND.TRANSACTION]: { action: 'createTransaction', risk: RISK.MEDIUM },
    [CAPTURE_KIND.BILL]: { action: 'createBill', risk: RISK.MEDIUM },
    [CAPTURE_KIND.SAVINGS]: { action: 'createSavingsGoal', risk: RISK.MEDIUM },
    [CAPTURE_KIND.TRAVEL]: { action: 'createTravelPlan', risk: RISK.MEDIUM }
  };

  const route = routes[kind];
  if (!route) return null;

  return Object.freeze({
    kind,
    action: route.action,
    risk: route.risk,
    /**
     * JOKAINEN REITTI VAATII VAHVISTUKSEN.
     *
     * Ei siksi, että ne olisivat vaarallisia, vaan siksi että ne
     * syntyvät tulkinnasta. Käyttäjä ei kirjoittanut riviä — hän
     * kirjoitti lauseen, ja joku muu päätti mitä se tarkoittaa.
     */
    requiresConfirmation: true,
    payload: payloadFor(interpretation)
  });
}

/**
 * Domain-toiminnon syöte tulkinnasta.
 *
 * MUUNNOS ON NIMENOMAINEN, EI LEVITYS. `{ ...interpretation }` olisi
 * lyhyempi ja päästäisi läpi jokaisen kentän, jota kukaan ei osannut
 * kieltää — myös sellaisen, jonka malli keksi.
 */
export function payloadFor(interpretation) {
  const i = interpretation;

  switch (i.kind) {
    case CAPTURE_KIND.TASK:
    case CAPTURE_KIND.REMINDER:
      return {
        title: i.title,
        date: i.date,
        time: i.time,
        endTime: i.endTime,
        durationMinutes: i.durationMinutes,
        category: i.category ?? undefined,
        priority: i.priority ?? undefined
      };

    case CAPTURE_KIND.GOAL:
      return {
        title: i.title,
        targetDate: i.date,
        category: i.category ?? undefined,
        priority: i.priority ?? undefined,
        metric: i.metric,
        unit: i.unit,
        baselineValue: i.baselineValue,
        currentValue: i.baselineValue,
        targetValue: i.targetValue
      };

    case CAPTURE_KIND.PROJECT:
      return {
        name: i.title,
        deadline: i.date,
        category: i.category ?? undefined,
        priority: i.priority ?? undefined
      };

    case CAPTURE_KIND.ROUTINE:
      return {
        title: i.title,
        recurrence: { type: i.recurrenceType, weekdays: i.weekdays },
        preferredTime: i.time,
        durationMinutes: i.durationMinutes,
        category: i.category ?? undefined,
        priority: i.priority ?? undefined,
        active: true
      };

    case CAPTURE_KIND.TRANSACTION:
      return {
        kind: i.transactionKind,
        amountMinor: i.amountMinor,
        date: i.date,
        description: i.title,
        category: i.transactionKind === 'income'
          ? normalizeIncomeCategory(i.financeCategory)
          : normalizeExpenseCategory(i.financeCategory)
      };

    case CAPTURE_KIND.BILL:
      return {
        name: i.title,
        amountMinor: i.amountMinor,
        dueDate: i.date
      };

    case CAPTURE_KIND.SAVINGS:
      return {
        name: i.title,
        targetMinor: i.amountMinor,
        targetDate: i.date
      };

    case CAPTURE_KIND.TRAVEL:
      return {
        title: i.title,
        destination: i.destination,
        arrivalDate: i.arrivalDate || i.date,
        arrivalTime: i.arrivalTime
      };

    default:
      return null;
  }
}

/**
 * Onko mallin ehdotus kielletty?
 *
 * Kirjaus ei koskaan poista eikä muuta mitään, joten kiellettyä
 * komentoa ei pitäisi voida edes ilmaista. Tarkistus on silti tässä:
 * malli voi palauttaa mitä tahansa, ja kiellettyjen lista on
 * olemassa juuri siksi.
 */
export function isForbidden(value) {
  return isForbiddenOperation(value);
}

/**
 * Ihmisluettava kuvaus siitä, mitä hyväksyntä tekisi.
 *
 * Käyttöliittymä näyttää tämän ennen hyväksyntää. Toimenpide, jota ei
 * voi lukea yhtenä lauseena, hyväksytään lukematta.
 */
export function describeRoute(route, interpretation) {
  if (!route) {
    return interpretation && interpretation.kind === CAPTURE_KIND.AMBIGUOUS
      ? 'En osannut tulkita tätä. Rivi jää saapuviin.'
      : 'Tallennetaan muistiinpanona saapuviin.';
  }

  const nimi = interpretation.title || '';

  switch (route.kind) {
    case CAPTURE_KIND.TASK:
      return `Luodaan tehtävä "${nimi}"`
        + (interpretation.date ? ` päivälle ${interpretation.date}` : '')
        + (interpretation.time ? ` klo ${interpretation.time}` : '') + '.';
    case CAPTURE_KIND.REMINDER:
      return `Luodaan muistutus "${nimi}" ${interpretation.date}`
        + (interpretation.time ? ` klo ${interpretation.time}` : '') + '.';
    case CAPTURE_KIND.GOAL:
      return `Luodaan tavoite "${nimi}"`
        + (interpretation.targetValue !== null
          ? ` (${interpretation.metric ?? 'mittari'} → ${interpretation.targetValue}`
            + `${interpretation.unit ? ' ' + interpretation.unit : ''})`
          : '') + '.';
    case CAPTURE_KIND.PROJECT:
      return `Luodaan projekti "${nimi}".`;
    case CAPTURE_KIND.ROUTINE:
      return `Luodaan rutiini "${nimi}"`
        + (interpretation.recurrenceType === 'daily' ? ' joka päivä' : ' viikoittain')
        + '.';
    case CAPTURE_KIND.TRANSACTION:
      return `Kirjataan ${interpretation.transactionKind === 'income' ? 'tulo' : 'meno'}`
        + ` "${nimi}".`;
    case CAPTURE_KIND.BILL:
      return `Luodaan lasku "${nimi}", eräpäivä ${interpretation.date}.`;
    case CAPTURE_KIND.SAVINGS:
      return `Luodaan säästötavoite "${nimi}".`;
    case CAPTURE_KIND.TRAVEL:
      return `Lasketaan lähtöaika kohteeseen ${interpretation.destination}`
        + ` klo ${interpretation.arrivalTime}.`;
    default:
      return 'Tallennetaan saapuviin.';
  }
}
