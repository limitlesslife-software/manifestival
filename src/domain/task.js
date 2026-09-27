// Tehtävän domain-malli: normalisointi, validointi ja järjestys.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei globaalia tilaa. Kaikki funktiot
// ovat testattavissa suoraan.
//
// HUOM skeemasta: osa kentistä (description, durationMinutes, priority,
// schedulingState) elää tällä hetkellä VAIN domainissa ja käyttöliittymässä.
// Ne eivät vielä tallennu tietokantaan, koska se vaatisi migraation 0002:n
// ajamisen tuotantoon. Ks. src/data/schema.js ja docs/SCHEMA.md.
// Domain on kirjoitettu valmiiksi oikein, jotta migraation jälkeen ei tarvita
// uutta refaktorointia.

import { normalizeCategory } from './categories.js';
import { normalizePriority, priorityWeight } from './priority.js';

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;

/** Aikataulutuksen tila. Erottaa käyttäjän päätöksen automaatin ehdotuksesta. */
export const SCHEDULING = Object.freeze({
  /** Käyttäjä on itse asettanut ajan. Automaatti ei saa siirtää tätä. */
  MANUAL: 'manual',
  /** Käyttäjä on hyväksynyt automaatin ehdottaman ajan. Automaatti saa siirtää. */
  AUTO: 'auto',
  /** Ei aikaa. Odottaa sijoittamista. */
  UNSCHEDULED: 'unscheduled'
});

/**
 * Tehtävän horisontti (migraatio 0015, tasks.horizon).
 *
 * TALLENNETAAN VAIN KÄYTTÄJÄN VALINTA. null = johdetaan päivästä ja
 * määräajasta (src/domain/lifeLoad.js). Arkistointi on oma kenttänsä
 * (archivedAt), ei horisontti.
 *
 *   NOW        käyttäjä valitsi tämän päivän fokukseksi (päivä = tänään)
 *   THIS_WEEK  tällä viikolla, päivää ei tarvitse päättää
 *   LATER      myöhemmin, ilman keksittyä päivää
 *   NOT_YET    ei vielä: tallessa, ei tekeillä
 *   WAITING    odottaa toista ihmistä tai tahoa (waitingOn)
 */
export const TASK_HORIZON = Object.freeze({
  NOW: 'NOW',
  THIS_WEEK: 'THIS_WEEK',
  LATER: 'LATER',
  NOT_YET: 'NOT_YET',
  WAITING: 'WAITING'
});
export const TASK_HORIZONS = Object.freeze(Object.values(TASK_HORIZON));

/** Odottaa kenelle -tekstin enimmäispituus (kannan CHECK 0015). */
export const MAX_WAITING_ON_LENGTH = 200;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Onko arvo kalenterissa OLEVA ISO-päivä.
 *
 * Date.parse() hyväksyy "2026-02-31" ja "2026-04-31" (V8 sallii päivän 31
 * kuukaudesta riippumatta), joten pelkkä jäsennys ei riitä: AI:n tai tuonnin
 * mahdoton päivä menisi läpi ja kaatuisi vasta kannassa. Kiertotarkistus
 * vaatii, että vuosi, kuukausi ja päivä säilyvät jäsennyksen jälkeen.
 */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  // setUTCFullYear eikä Date.UTC: jälkimmäinen tulkitsee vuodet 0-99 vuosiksi 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function isTimeOfDay(value) {
  return typeof value === 'string' && HHMM.test(value);
}

/** 'HH:MM' -> minuutteja keskiyöstä. */
export function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Minuutteja keskiyöstä -> 'HH:MM'. Kiertää vuorokauden yli. */
export function fromMinutes(total) {
  const wrapped = ((Math.round(total) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/**
 * Tehtävän kesto minuutteina.
 * Ensisijaisesti alku- ja loppuajasta, muuten erillisestä kestokentästä.
 * Keskiyön yli menevä väli lasketaan oikein (esim. 22:00–06:00 = 480).
 */
export function durationOf(task) {
  if (task.time && task.endTime) {
    const start = toMinutes(task.time);
    const end = toMinutes(task.endTime);

    // NOLLAN MITTAINEN VÄLI EI OLE KESTO.
    //
    // Tässä oli kuollut haara: `span === 0 ? null : span`. Se ei voinut
    // koskaan toteutua, koska yhtä suurilla ajoilla `end > start` on
    // epätosi ja kierto laski (1440 - start) + end = 1440. Sama alku- ja
    // loppuaika tuotti siis vuorokauden mittaisen tehtävän — ja
    // aikataulumoottorissa se olisi varannut koko päivän.
    //
    // `validateTask` hylkää yhtä suuret ajat, joten tila on kelvoton
    // syöte eikä sitä pitäisi päästä tallentamaan. Se ei kuitenkaan ole
    // syy tuottaa siitä väärää lukua: normalisointi ajetaan ennen
    // validointia, ja kelvoton rivi voi tulla myös kannasta tai
    // tuonnista.
    if (start === end) return null;

    return end > start ? end - start : (1440 - start) + end;
  }
  if (Number.isFinite(task.durationMinutes) && task.durationMinutes > 0) {
    return task.durationMinutes;
  }
  return null;
}

/**
 * Tehtävän tosiasiallinen loppuaika.
 * Jos loppuaikaa ei ole mutta kesto tiedetään, se lasketaan.
 */
export function effectiveEndTime(task) {
  if (task.endTime) return task.endTime;
  if (task.time && Number.isFinite(task.durationMinutes) && task.durationMinutes > 0) {
    return fromMinutes(toMinutes(task.time) + task.durationMinutes);
  }
  return null;
}


/** Aikataulutuksen tila johdettuna. Ei koskaan luota pelkkään tallennettuun arvoon. */
export function schedulingStateOf(task) {
  if (!task.time) return SCHEDULING.UNSCHEDULED;
  return task.schedulingState === SCHEDULING.AUTO ? SCHEDULING.AUTO : SCHEDULING.MANUAL;
}

/**
 * Saako automaattinen aikataulutus siirtää tätä tehtävää?
 *
 * EI, jos käyttäjä on itse asettanut ajan. Tämä on tuotteen keskeinen lupaus:
 * järjestelmä ei saa tuhota käyttäjän omaa päätöstä (konseptidokumentti,
 * luku 7: "Joustavuus ilman hallinnan menetystä").
 */
export function isMovableByScheduler(task) {
  if (task.completed) return false;
  if (task.isWake) return false;
  return schedulingStateOf(task) !== SCHEDULING.MANUAL;
}

/**
 * Normalisoi mielivaltaisen olion tehtäväksi.
 * Tuntemattomat kentät pudotetaan, virheelliset arvot korvataan oletuksilla.
 * Ei koskaan heitä poikkeusta — validointiin käytä validateTask().
 */
/**
 * Trimmattu teksti tai null. Tyhjä merkkijono EI ole kelvollinen arvo:
 * "ei arvoa" on kannassa null, eikä samalle asialle saa olla kahta
 * esitystapaa.
 */
function normalizeText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

/**
 * Riippuvuuslista.
 *
 * Yläraja on tarkoituksellinen: kymmenen edeltäjää on jo paljon, ja
 * rajaton lista olisi tapa rakentaa verkko, jonka läpikäynti on
 * kallista eikä kukaan pysty lukemaan.
 */
function normalizeDependsOn(value, ownId) {
  if (!Array.isArray(value)) return [];
  const self = ownId != null ? String(ownId) : null;
  const seen = new Set();

  for (const entry of value) {
    if (entry == null) continue;
    const id = String(entry).trim();
    if (!id || id === self) continue;
    seen.add(id);
    if (seen.size >= 10) break;
  }
  return [...seen];
}

export function normalizeTask(input = {}) {
  const time = isTimeOfDay(input.time) ? input.time : null;
  const endTime = isTimeOfDay(input.endTime) ? input.endTime : null;

  const rawDuration = Number(input.durationMinutes);
  const manualDuration = Number.isFinite(rawDuration) && rawDuration > 0
    ? Math.round(rawDuration)
    : null;

  /**
   * KESTOLLA ON YKSI TOTUUDEN LÄHDE.
   *
   * Alku- ja loppuaika ovat yhdessä VÄLI, ja väli on tosiasia: 01:00–02:00
   * on kuusikymmentä minuuttia riippumatta siitä, mitä kestokenttään on
   * joskus kirjoitettu. Erillinen kestokenttä on ARVIO, ja arviota
   * tarvitaan vain silloin kun väliä ei ole.
   *
   * Aiemmin nämä kaksi elivät rinnakkain ilman sääntöä. `durationOf()`
   * osasi valita välin, mutta tallennettu `durationMinutes` jäi
   * koskemattomaksi — joten tehtävällä saattoi olla väli 01:00–02:00 ja
   * kesto 30, eikä `validateTask` pitänyt sitä virheenä. Kumpi luku
   * näkyi, riippui siitä kuka kysyi:
   *
   *   durationOf(task)        -> 60   (aikajanan pituus, ajoittaja)
   *   task.durationMinutes    -> 30   (lomake, rutiiniesiintymät)
   *
   * Käyttäjä näki lomakkeessa 30 ja aikajanalla tunnin mittaisen lohkon.
   * Kaksi näkymää samasta tehtävästä, eri luku kummassakin.
   *
   * Nyt johdos tehdään tässä, jolloin ristiriitaa ei voi enää syntyä:
   * kentässä ja välissä on aina sama luku. Manuaalinen arvio säilyy
   * sellaisenaan silloin — ja vain silloin — kun väliä ei ole.
   */
  const derivedDuration = (time && endTime) ? durationOf({ time, endTime }) : null;
  const durationMinutes = derivedDuration ?? manualDuration;

  return {
    id: input.id != null ? String(input.id) : null,
    title: String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),
    // Trimmaus ENNEN tyhjyystarkistusta. Aiemmin pelkkiä välilyöntejä
    // sisältänyt kuvaus muuttui tyhjäksi merkkijonoksi, jolloin "ei
    // kuvausta" oli kannassa kahdessa muodossa: null ja ''. Ennen
    // migraatiota 0002 sillä ei ollut väliä, koska kenttä ei säilynyt.
    // Sen jälkeen ero on pysyvä, ja `description is null` -kysely ohittaisi
    // juuri ne rivit, joissa on pelkkiä välilyöntejä.
    description: normalizeText(input.description, MAX_DESCRIPTION_LENGTH),
    date: isIsoDate(input.date) ? input.date : null,
    /**
     * Määräaika — MILLOIN TEHTÄVÄN ON OLTAVA VALMIS.
     *
     * Tämä on eri asia kuin `date`, joka kertoo milloin tehtävä on
     * AIKATAULUTETTU. Lasku voi erääntyä perjantaina, vaikka aikoisit maksaa
     * sen keskiviikkona. Määräaika EI siis aikatauluta tehtävää — se on
     * kiireellisyyssignaali aikataulumoottorille.
     */
    deadline: isIsoDate(input.deadline) ? input.deadline : null,
    /** Vapaaehtoinen yhteys tavoitteeseen. Enintään yksi. */
    goalId: input.goalId != null ? String(input.goalId) : null,
    /** Vapaaehtoinen yhteys projektiin. */
    projectId: input.projectId != null ? String(input.projectId) : null,

    /**
     * Vapaaehtoinen yhteys välitavoitteeseen.
     *
     * Migraatio 0010, EI AJETTU. Portin ollessa kiinni tämä elää
     * istunnon muistissa. Ks. GOAL_PLANNING_FIELDS src/data/schema.js.
     */
    milestoneId: input.milestoneId != null ? String(input.milestoneId) : null,

    /**
     * Tehtävät, joiden on oltava tehty ennen tätä.
     *
     * ITSEVIITTAUS PUDOTETAAN. Tehtävä, joka riippuu itsestään, ei ole
     * mahdoton vaan mahdoton tulkita — ja se kaataisi topologisen
     * järjestyksen aikatauluttajassa.
     *
     * Kaksoiskappaleet poistetaan: sama riippuvuus kahdesti ei tarkoita
     * mitään, mutta se painaisi järjestystä kahdesti.
     */
    dependsOn: normalizeDependsOn(input.dependsOn, input.id),
    time,
    endTime,
    durationMinutes,
    category: normalizeCategory(input.category),
    priority: normalizePriority(input.priority),
    completed: Boolean(input.completed),
    isWake: Boolean(input.isWake),
    note: input.note ? String(input.note) : null,
    schedulingState: time
      ? (input.schedulingState === SCHEDULING.AUTO ? SCHEDULING.AUTO : SCHEDULING.MANUAL)
      : SCHEDULING.UNSCHEDULED,

    // ------------------------------------------------ mielen kuorma (0015)
    //
    // Migraatio 0015, EI AJETTU. Portin MENTAL_LOAD_FIELDS ollessa kiinni
    // nämä elävät istunnon muistissa. Ks. docs/MENTAL-LOAD-CORE.md.
    /** Käyttäjän valitsema horisontti tai null (johdetaan). */
    horizon: TASK_HORIZONS.includes(input.horizon) ? input.horizon : null,
    /** Kenen tai minkä tahon varassa asia odottaa (vain WAITING). */
    waitingOn: input.horizon === TASK_HORIZON.WAITING ? normalizeText(input.waitingOn, MAX_WAITING_ON_LENGTH) : null,
    /** Odottavan asian tarkistuspäivä (valinnainen). */
    followUpDate: isIsoDate(input.followUpDate) ? input.followUpDate : null,
    /** Poistettu näkyvistä (arkisto). ISO-aikaleima tai null. */
    archivedAt: typeof input.archivedAt === 'string' && input.archivedAt ? input.archivedAt : null,
    /** Montako kertaa keskeneräisen tehtävän päivää on siirretty (PLAN_CHURN). */
    rescheduleCount: Number.isInteger(Number(input.rescheduleCount)) && Number(input.rescheduleCount) > 0
      ? Math.min(Number(input.rescheduleCount), 10000) : 0,
    /** Ensimmäinen suunniteltu päivä ennen siirtoja. */
    originalDate: isIsoDate(input.originalDate) ? input.originalDate : null,

    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

/**
 * Siirretäänkö keskeneräisen tehtävän päivää? Palauttaa kentät, jotka
 * siirto päivittää: laskuri kasvaa ja alkuperäinen päivä jää talteen
 * ENSIMMÄISESSÄ siirrossa. Ei muutosta, jos päivä ei vaihdu tai tehtävä
 * on valmis. Yksi sääntö kaikille siirtopoluille (lomake, uudelleen-
 * suunnittelu, viikkokatsaus, Sunnuntain nollaus).
 *
 * @returns {object} lisättävät kentät (tyhjä, jos ei siirtoa)
 */
export function reschedulePatch(task, nextDate) {
  if (!task || task.completed) return {};
  const from = isIsoDate(task.date) ? task.date : null;
  const to = isIsoDate(nextDate) ? nextDate : null;
  if (!from || from === to) return {};
  return {
    rescheduleCount: Math.min((Number.isInteger(task.rescheduleCount) ? task.rescheduleCount : 0) + 1, 10000),
    originalDate: isIsoDate(task.originalDate) ? task.originalDate : from
  };
}

/** Onko tehtävä arkistoitu (poistettu näkyvistä)? */
export function isArchived(task) {
  return Boolean(task && task.archivedAt);
}

/**
 * Validoi tehtävän. Palauttaa { valid, errors } jossa errors on
 * kenttä -> suomenkielinen viesti.
 */
export function validateTask(task, { allowDateless = false } = {}) {
  const errors = {};

  const title = String(task.title ?? '').trim();
  if (!title) errors.title = 'Anna tehtävälle nimi.';
  else if (title.length > MAX_TITLE_LENGTH) errors.title = `Nimi on liian pitkä (enintään ${MAX_TITLE_LENGTH} merkkiä).`;

  // PÄIVÄTÖN TEHTÄVÄ (omistajan päätös 2): sallittu, kun käyttäjä on
  // valinnut horisontin (tällä viikolla, myöhemmin, ei vielä, odottaa) JA
  // kanta tukee sitä (MENTAL_LOAD_FIELDS, kutsuja kertoo allowDateless).
  // Keksittyä päivää ei pakoteta, mutta kellonaika vaatii päivän.
  const datelessOk = allowDateless && task.date == null
    && task.horizon && task.horizon !== TASK_HORIZON.NOW && !task.time;
  if (!isIsoDate(task.date) && !datelessOk) {
    errors.date = allowDateless ? 'Valitse päivä tai "Myöhemmin".'
      : task.horizon && task.date == null
        ? 'Valitse päivä. Päivätön tallennus tulee käyttöön, kun palvelin on päivitetty (migraatio 0015).'
        : 'Valitse päivämäärä.';
  }
  if (task.horizon != null && !TASK_HORIZONS.includes(task.horizon)) errors.horizon = 'Horisontti ei kelpaa.';
  if (task.waitingOn != null && task.horizon !== TASK_HORIZON.WAITING) {
    errors.waitingOn = 'Odotus kuuluu vain odottavalle asialle.';
  }
  if (task.waitingOn && String(task.waitingOn).length > MAX_WAITING_ON_LENGTH) {
    errors.waitingOn = `Enintään ${MAX_WAITING_ON_LENGTH} merkkiä.`;
  }
  if (task.followUpDate != null && !isIsoDate(task.followUpDate)) errors.followUpDate = 'Tarkistuspäivä ei kelpaa.';

  if (task.time != null && !isTimeOfDay(task.time)) errors.time = 'Kellonaika ei kelpaa.';
  if (task.endTime != null && !isTimeOfDay(task.endTime)) errors.endTime = 'Loppuaika ei kelpaa.';

  if (task.endTime && !task.time) errors.endTime = 'Anna ensin alkuaika.';
  if (task.time && task.endTime && task.time === task.endTime) {
    errors.endTime = 'Loppuajan pitää poiketa alkuajasta.';
  }

  if (task.description && String(task.description).length > MAX_DESCRIPTION_LENGTH) {
    errors.description = 'Kuvaus on liian pitkä.';
  }

  if (task.durationMinutes != null) {
    const d = Number(task.durationMinutes);
    if (!Number.isFinite(d) || d <= 0) errors.durationMinutes = 'Keston pitää olla positiivinen.';
    else if (d > 1440) errors.durationMinutes = 'Kesto ei voi ylittää vuorokautta.';
  }

  if (task.deadline != null && !isIsoDate(task.deadline)) {
    errors.deadline = 'Määräaika ei kelpaa.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// ---------------------------------------------------------- määräajat

/**
 * Onko tehtävä myöhässä?
 *
 * JOHDETTU TILA — tätä ei koskaan tallenneta eikä tehtävää muuteta vain
 * siksi, että päivämäärä vaihtui. Myöhässä oleminen on funktio ajasta, ei
 * tehtävän ominaisuus.
 *
 * Valmis tehtävä ei ole koskaan myöhässä, vaikka se olisi tehty myöhään.
 *
 * @param {object} task
 * @param {string} todayIso  Nykyinen päivä. Annetaan parametrina, jotta
 *                           funktio pysyy puhtaana ja testattavana.
 */
export function isOverdue(task, todayIso) {
  if (!task || task.completed) return false;
  if (!isIsoDate(todayIso)) return false;
  // Arkistoitu, odottava tai "ei vielä" ei ole myöhässä: käyttäjä on
  // päättänyt, ettei se ole nyt tekeillä (docs/MENTAL-LOAD-CORE.md).
  if (task.archivedAt || task.horizon === TASK_HORIZON.WAITING || task.horizon === TASK_HORIZON.NOT_YET) return false;

  // Määräaika on ensisijainen: se on lupaus ulkopuolelle.
  if (task.deadline) return task.deadline < todayIso;

  // Ilman määräaikaa aikataulutettu menneisyys on myöhässä.
  if (task.date) return task.date < todayIso;

  // Aikatauluttamaton tehtävä ilman määräaikaa ei voi olla myöhässä.
  return false;
}

/**
 * Päiviä määräaikaan. Negatiivinen = myöhässä, 0 = tänään.
 * Null jos määräaikaa ei ole.
 */
export function daysUntilDeadline(task, todayIso) {
  if (!task || !task.deadline || !isIsoDate(todayIso)) return null;
  const due = Date.parse(task.deadline + 'T00:00:00Z');
  const today = Date.parse(todayIso + 'T00:00:00Z');
  return Math.round((due - today) / 86400000);
}

/** Kiireellisyystasot. Käytetään sekä järjestykseen että käyttöliittymään. */
export const URGENCY = Object.freeze({
  OVERDUE: 'overdue',
  TODAY: 'today',
  TOMORROW: 'tomorrow',
  SOON: 'soon',
  LATER: 'later',
  NONE: 'none'
});

/** Kuinka monta päivää eteenpäin lasketaan "pian erääntyväksi". */
export const SOON_DAYS = 3;

/**
 * Tehtävän kiireellisyys määräajan perusteella.
 * Valmis tehtävä ei ole koskaan kiireellinen.
 */
export function deadlineUrgency(task, todayIso) {
  if (!task || task.completed) return URGENCY.NONE;
  const days = daysUntilDeadline(task, todayIso);
  if (days === null) return URGENCY.NONE;
  if (days < 0) return URGENCY.OVERDUE;
  if (days === 0) return URGENCY.TODAY;
  if (days === 1) return URGENCY.TOMORROW;
  if (days <= SOON_DAYS) return URGENCY.SOON;
  return URGENCY.LATER;
}

/** Kiireellisyyden paino järjestykseen. Pienempi = kiireellisempi. */
const URGENCY_WEIGHT = Object.freeze({
  [URGENCY.OVERDUE]: 0,
  [URGENCY.TODAY]: 1,
  [URGENCY.TOMORROW]: 2,
  [URGENCY.SOON]: 3,
  [URGENCY.LATER]: 4,
  [URGENCY.NONE]: 5
});

export function urgencyWeight(urgency) {
  return URGENCY_WEIGHT[urgency] ?? URGENCY_WEIGHT[URGENCY.NONE];
}

/** Vaatiiko tämä kiireellisyystaso huomiota lähipäivinä? */
export function isUrgent(urgency) {
  return urgency === URGENCY.OVERDUE
    || urgency === URGENCY.TODAY
    || urgency === URGENCY.TOMORROW
    || urgency === URGENCY.SOON;
}

/** Paino, jota käytetään kun kiireellisyys ei ole todellinen. */
const NOT_URGENT_WEIGHT = 9;

/**
 * Kiireellisyyden paino AIKATAULUTUKSESSA.
 *
 * Eroaa urgencyWeight-funktiosta tarkoituksella. Listojen järjestyksessä on
 * mielekästä, että kaukainenkin määräaika sijoittuu ennen määräajatonta.
 * Aikataulutuksessa se olisi väärin: neljän kuukauden päässä oleva määräaika
 * ei saa ohittaa tärkeää tehtävää tämän päivän vapaassa välissä.
 *
 * Siksi kaikki ei-kiireelliset tasot ovat tässä keskenään samanarvoisia —
 * jolloin ratkaisu siirtyy prioriteetille. Vertailu pysyy transitiivisena,
 * koska paino on funktio pelkästä kiireellisyystasosta.
 */
export function schedulingUrgencyWeight(urgency) {
  return isUrgent(urgency) ? urgencyWeight(urgency) : NOT_URGENT_WEIGHT;
}

const URGENCY_LABELS = Object.freeze({
  [URGENCY.OVERDUE]: 'Myöhässä',
  [URGENCY.TODAY]: 'Tänään',
  [URGENCY.TOMORROW]: 'Huomenna',
  [URGENCY.SOON]: 'Pian',
  [URGENCY.LATER]: '',
  [URGENCY.NONE]: ''
});

export function urgencyLabel(urgency) {
  return URGENCY_LABELS[urgency] ?? '';
}

/** Kaikki myöhässä olevat tehtävät. */
export function overdueTasks(tasks, todayIso) {
  return (tasks || []).filter(task => isOverdue(task, todayIso));
}

/**
 * Järjestys päivän sisällä.
 *
 * 1. Aikataulutetut ennen aikatauluttamattomia
 * 2. Aikataulutetut kellonajan mukaan
 * 3. Aikatauluttamattomat prioriteetin mukaan
 * 4. Tasatilanteessa nimen mukaan — takaa determinismin
 */
export function compareForDay(a, b) {
  const aTimed = Boolean(a.time);
  const bTimed = Boolean(b.time);
  if (aTimed !== bTimed) return aTimed ? -1 : 1;

  if (aTimed && bTimed && a.time !== b.time) return a.time < b.time ? -1 : 1;

  const byPriority = priorityWeight(a.priority) - priorityWeight(b.priority);
  if (byPriority !== 0) return byPriority;

  return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'fi');
}

/** Järjestys useamman päivän listassa: päivä ensin, sitten päivän sisäinen järjestys. */
export function compareByDateThenDay(a, b) {
  if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
  return compareForDay(a, b);
}

/** Menevätkö kahden tehtävän aikavälit päällekkäin? Ajattomat eivät koskaan. */
export function overlaps(a, b) {
  if (!a.time || !b.time) return false;
  const aStart = toMinutes(a.time);
  const bStart = toMinutes(b.time);
  const aEnd = aStart + (durationOf(a) ?? 0);
  const bEnd = bStart + (durationOf(b) ?? 0);
  if (aEnd === aStart || bEnd === bStart) return aStart === bStart;
  return aStart < bEnd && bStart < aEnd;
}

/** Päivän tehtävät jaoteltuna näkymää varten. */
export function partitionDay(tasks) {
  const scheduled = [];
  const unscheduled = [];
  const completed = [];
  for (const task of tasks) {
    if (task.completed) completed.push(task);
    else if (task.time) scheduled.push(task);
    else unscheduled.push(task);
  }
  return {
    scheduled: scheduled.sort(compareForDay),
    unscheduled: unscheduled.sort(compareForDay),
    completed: completed.sort(compareForDay)
  };
}
