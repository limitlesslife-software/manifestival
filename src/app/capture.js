// Universaali kirjaus: kirjaa nyt, järjestä myöhemmin.
//
// =====================================================================
// KIRJAUS ON KAKSI ERILLISTÄ ASIAA
// =====================================================================
//
//   1. RIVI SYNTYY. Käyttäjän teksti tallentuu saapuviin heti, ennen
//      kuin mitään tulkitaan. Tämä ei voi epäonnistua tulkinnan takia.
//
//   2. TULKINTA EHDOTETAAN. Malli arvaa, mistä on kyse. Ehdotus
//      liitetään riviin, ja rivi jää odottamaan käyttäjää.
//
// Järjestys on tärkeä. Jos tulkinta tehtäisiin ensin ja rivi vasta
// sen onnistuessa, verkkokatko söisi käyttäjän ajatuksen — ja juuri
// sitä ajatusta varten koko kirjaus on olemassa.
//
// =====================================================================
// MIKÄÄN EI SYNNY ILMAN HYVÄKSYNTÄÄ
// =====================================================================
//
// `routeOf()` kertoo mitä tehtäisiin. Se ei kutsu mitään. Tämä moduuli
// on ainoa paikka, joka muuttaa reitin kutsuksi, ja se tekee sen vasta
// kun käyttäjä on nähnyt kuvauksen ja hyväksynyt sen.
//
// Reitin ja toteutuksen erillisyys on koko turvamallin ydin: reitti
// voidaan näyttää, tarkistaa ja hylätä ilman että mitään tapahtuu.
//
// =====================================================================
// ÄÄNTÄ EI TALLENNETA
// =====================================================================
//
// `source: 'voice'` kertoo, että rivi tuli puheesta. Äänitallennetta
// ei kirjoiteta mihinkään — ei kantaan, ei levylle, ei tilaan. Rivi
// kantaa LITTEROINNIN, koska litterointi on silloin se mitä käyttäjä
// sanoi, ei välivaihe matkalla johonkin muuhun.

import { inboxRepo } from '../data/collectionsRepo.js';
import { isTableAvailable, datelessTasksAllowed } from '../data/schema.js';
import { newTaskId } from '../lib/rows.js';
import { fmtISO, todayMidnight } from '../lib/datetime.js';
import { logError } from '../lib/result.js';
import { aiEndpointMessage } from '../lib/errorMessages.js';
import { apiUrl } from '../platform/index.js';
import { API } from '../data/config.js';
import { currentAccessToken } from './auth.js';
import {
  normalizeInboxItem, validateInboxItem, attachProposal, acceptItem,
  markConverted, dismissItem, restoreItem, atCapacity,
  INBOX_STATUS, CAPTURE_SOURCE, splitBrainDump, MAX_OPEN_ITEMS, isOpenItem
} from '../domain/inbox.js';
import {
  routeOf, describeRoute, payloadFor, normalizeInterpretation,
  CAPTURE_KIND
} from '../domain/capture.js';
import { validateCaptureResponse, buildCaptureContext } from '../ai/captureSchema.js';
import { proposeTriage, planTriageDecision, TRIAGE_DECISIONS } from '../domain/triage.js';
import { isIsoDate } from '../domain/task.js';
import {
  getState, addInboxItemToState, replaceInboxItemInState,
  removeInboxItemFromState, findInboxItem, setPendingCapture
} from './state.js';
import {
  createTask, createGoal, createProject, createRoutine,
  createTransaction, createBill, createSavingsGoal
} from './actions.js';
import { createTravelPlan } from './assistantActions.js';
import { saveCalendarEvent } from './dailyLifeActions.js';
import { showError, success, notify } from '../ui/toast.js';
import { confirmAction } from '../ui/confirm.js';

/**
 * Reitin nimestä toimintoon.
 *
 * =====================================================================
 * TÄMÄ ON NIMETTY SALLITTUJEN LUETTELO, EI HAKU.
 * =====================================================================
 *
 * Mallin palauttama kohde päätyy `routeOf`-funktion kautta
 * toiminnon NIMEKSI. Jos nimi haettaisiin moduulista dynaamisesti,
 * malli voisi nimetä minkä tahansa viedyn funktion — myös `deleteTask`.
 *
 * Luettelo on siksi kirjoitettu käsin, ja tuntematon nimi ei osu
 * mihinkään.
 */
const ROUTE_ACTIONS = Object.freeze({
  createTask,
  createGoal,
  createProject,
  createRoutine,
  createTransaction,
  createBill,
  createSavingsGoal,
  createTravelPlan
});

/** Reitin toiminnosta kirjauslaji, joka merkitään saapuvaan riviin. */
const ROUTE_KINDS = Object.freeze({
  createTask: 'task',
  createGoal: 'goal',
  createProject: 'project',
  createRoutine: 'routine',
  createTransaction: 'transaction',
  createBill: 'bill',
  createSavingsGoal: 'savings',
  createTravelPlan: 'travel'
});

/** Tämän päivän ISO-päivä. Kello luetaan TÄSSÄ, ei domainissa. */
function todayIso() {
  return fmtISO(todayMidnight());
}

/** Viikonpäivä mallille. Vain päättelyä varten, ei tallennu mihinkään. */
function weekdayName(date = new Date()) {
  return ['sunnuntai', 'maanantai', 'tiistai', 'keskiviikko', 'torstai',
          'perjantai', 'lauantai'][date.getDay()] || null;
}

// =====================================================================
// KIRJAUS
// =====================================================================

/**
 * Kirjaa teksti saapuviin.
 *
 * RIVI SYNTYY ENSIN. Tulkinta on erillinen askel, ja se saa
 * epäonnistua ilman että kirjaus menetetään.
 *
 * @param {string} text
 * @param {{source?: string}} options
 * @returns {Promise<{ok: boolean, item?: object, errors?: object}>}
 */
export async function captureText(text, { source = CAPTURE_SOURCE.TEXT } = {}) {
  const item = normalizeInboxItem({
    id: newTaskId(),
    text,
    source,
    status: INBOX_STATUS.UNPROCESSED,
    capturedAt: new Date().toISOString()
  });

  const { valid, errors } = validateInboxItem(item);
  if (!valid) return { ok: false, errors };

  // KATTO ON OLEMASSA, JOTTA SAAPUVAT PYSYVÄT KÄSITELTÄVINÄ.
  //
  // Kaksisataa avointa riviä ei ole enää lista vaan kasa, eikä kasaa
  // käsittele kukaan. Tämä estää kirjaamisen näkyvästi sen sijaan,
  // että se hiljaa kasvaisi rajatta.
  if (atCapacity(getState().inboxItems)) {
    return {
      ok: false,
      errors: { text: 'Saapuvat on täynnä. Käsittele muutama rivi ensin.' }
    };
  }

  addInboxItemToState(item);

  const result = await inboxRepo.insert(item);
  if (!result.ok) {
    removeInboxItemFromState(item.id);
    showError(result.error);
    return { ok: false };
  }

  // Ajon aikana laskettu taulu torjuu kirjoituksen jo yllä, joten tänne
  // päästään vain käännösaikaisesti kiinni olevalla portilla (muisti).
  if (!isTableAvailable('inboxItems')) {
    notify('Kirjattu. Huom: saapuvat säilyvät toistaiseksi vain tämän istunnon ajan.', 6000);
  }

  return { ok: true, item };
}

/**
 * BRAIN DUMP: kirjaa monirivinen teksti saapuviin, yksi rivi per asia.
 *
 * EI TULKINTAA KIRJAUSHETKELLÄ. Mielen tyhjentäminen ei saa vaatia
 * päätöksiä: luokittelu tehdään myöhemmin erässä (Saapuvat, sunnuntain
 * nollaus). Rivit syntyvät yksi kerrallaan samaa polkua kuin yksittäinen
 * kirjaus, joten epäonnistunut rivi ei vie muita mukanaan.
 *
 * JO SAAPUVISSA OLEVA ASIA EI TUPLAANNU. Sama lista liitettynä kahdesti
 * (tai sama asia saneltuna uudelleen) ei kasvata kasaa: avoimen rivin
 * kanssa samanlainen rivi ohitetaan ja lasketaan `duplicates`-lukuun.
 * Se on silti tallessa — juuri sitä käyttäjä halusi varmistaa.
 *
 * @param {string} text
 * @param {{source?: string}} options
 * @returns {Promise<{ok:boolean, items:object[], failed:number, skipped:number, duplicates:number,
 *   rest:string[], errors?:object}>}  `rest` = rivit, jotka EIVÄT tallentuneet (kenttään takaisin)
 */
export async function captureBrainDump(text, { source = CAPTURE_SOURCE.TEXT } = {}) {
  const parts = splitBrainDump(text);
  if (parts.length === 0) {
    return { ok: false, items: [], failed: 0, skipped: 0, duplicates: 0, rest: [], errors: { text: 'Kirjoita jotain ensin.' } };
  }
  const open = getState().inboxItems.filter(isOpenItem);
  const known = new Set(open.map(item => String(item.text || '').toLocaleLowerCase('fi')));
  const fresh = parts.filter(part => !known.has(part.toLocaleLowerCase('fi')));
  const duplicates = parts.length - fresh.length;
  if (fresh.length === 0) return { ok: true, items: [], failed: 0, skipped: 0, duplicates, rest: [] };

  const room = Math.max(0, MAX_OPEN_ITEMS - open.length);
  const accepted = fresh.slice(0, room);
  const items = [];
  const rest = [];
  let failed = 0;
  for (const part of accepted) {
    const result = await captureText(part, { source });
    if (result.ok) items.push(result.item);
    else {
      failed += 1;
      rest.push(part);
    }
  }
  const skipped = fresh.length - accepted.length;
  rest.push(...fresh.slice(accepted.length));
  if (items.length === 0) {
    return { ok: false, items, failed, skipped, duplicates, rest,
      errors: { text: skipped > 0 ? 'Saapuvat on täynnä. Käsittele muutama rivi ensin.' : 'Kirjaus ei onnistunut.' } };
  }
  return { ok: true, items, failed, skipped, duplicates, rest };
}

/**
 * Kirjauksen lopputulos yhtenä rauhallisena lauseena tilariville.
 * Ei päätöksiä, ei syyllistämistä: "Kaikki muu on tallessa."
 */
export function captureDumpMessage(result) {
  if (!result) return '';
  const saved = Array.isArray(result.items) ? result.items.length : 0;
  const parts = [];
  if (saved === 1) parts.push('Kirjattu saapuviin.');
  else if (saved > 1) parts.push(`Kirjattu ${saved} asiaa saapuviin. Järjestä ne, kun ehdit.`);
  if (result.duplicates > 0) {
    parts.push(result.duplicates === 1 ? 'Yksi asia oli jo tallessa Saapuvissa.' : `${result.duplicates} asiaa oli jo tallessa Saapuvissa.`);
  }
  if (result.skipped > 0 && saved > 0) {
    parts.push('Saapuvat tuli täyteen: loput jäivät kenttään. Käsittele muutama rivi ensin.');
  }
  if (result.failed > 0 && saved > 0) {
    parts.push(result.failed === 1 ? 'Yksi rivi ei tallentunut: se jäi kenttään.' : `${result.failed} riviä ei tallentunut: ne jäivät kenttään.`);
  }
  return parts.join(' ');
}

/**
 * Kirjaa teksti JA pyydä tulkinta.
 *
 * Tulkinnan epäonnistuminen EI kaada kirjausta: rivi jää saapuviin
 * ilman ehdotusta, ja käyttäjä voi käsitellä sen itse.
 */
export async function captureAndInterpret(text, { source = CAPTURE_SOURCE.TEXT } = {}) {
  const captured = await captureText(text, { source });
  if (!captured.ok) return captured;

  const interpreted = await interpretItem(captured.item.id);

  return {
    ok: true,
    item: interpreted.ok ? interpreted.item : captured.item,
    interpreted: interpreted.ok,
    reason: interpreted.reason || null
  };
}

// =====================================================================
// TULKINTA
// =====================================================================

/**
 * Pyydä tulkinta yhdelle saapuvalle riville.
 *
 * FAIL CLOSED. `validateCaptureResponse` hylkää kaiken mitä se ei
 * ymmärrä ja putoaa muistiinpanoon. Puolittain ymmärretty tulkinta
 * olisi pahin vaihtoehto: se näyttäisi tulkinnalta.
 */
export async function interpretItem(id) {
  const item = findInboxItem(id);
  if (!item) return { ok: false, reason: 'Riviä ei löytynyt.' };

  const response = await requestInterpretation(item);
  if (!response.ok) {
    return { ok: false, reason: response.error };
  }

  const validated = validateCaptureResponse(response.text);

  // Hylätyt kentät kirjataan konsoliin mutta EI käyttäjälle: hän ei
  // voi tehdä niille mitään, ja kehittäjä voi.
  if (validated.rejectedFields.length > 0) {
    logError(new Error(
      `Kirjauksen tulkinta sisälsi kenttiä, joita ei hyväksytä: `
      + validated.rejectedFields.join(', ')));
  }

  const updated = attachProposal(item, validated.interpretation, {
    needsReview: validated.needsReview || !validated.ok
  });
  if (!updated) return { ok: false, reason: 'Ehdotusta ei voitu liittää.' };

  replaceInboxItemInState(id, updated);

  const saved = await inboxRepo.update(updated);
  if (!saved.ok) {
    replaceInboxItemInState(id, item);
    showError(saved.error);
    // Syy on AINA käyttäjälle kelpaava merkkijono: AppError-olio näkyi
    // kirjauspalkissa muodossa "AppError: …" (ERR-10).
    return { ok: false, reason: saved.error.userMessage };
  }

  return { ok: true, item: updated, reason: validated.reason };
}

/** Verkkokutsu tulkintapäätepisteeseen. */
async function requestInterpretation(item) {
  try {
    const token = await currentAccessToken();
    if (!token) return { ok: false, error: 'Kirjaudu sisään ennen tulkintaa.' };

    const response = await fetch(apiUrl(API.capture), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        text: item.text,
        today: todayIso(),
        weekday: weekdayName(),
        source: item.source,
        // VAIN OMINAISUUSLIPUT LÄHTEVÄT MUKANA. Käyttäjän tehtävät,
        // muistiinpanot, hyvinvointimerkinnät ja taloustiedot EIVÄT.
        context: buildCaptureContext({
          todayIso: todayIso(),
          weekday: weekdayName(),
          features: {
            goals: true,
            projects: true,
            routines: true,
            finance: true,
            travel: true
          }
        })
      })
    });

    // Palvelimen body.error-tekstiä EI näytetä: kiinteä viesti HTTP-tilan
    // mukaan (src/lib/errorMessages.js aiEndpointMessage).
    if (!response.ok) return { ok: false, error: aiEndpointMessage(response.status, { subject: 'capture' }) };

    const data = await response.json();
    const text = textFrom(data);
    if (!text) return { ok: false, error: 'Tulkintaa ei saatu.' };

    return { ok: true, text };
  } catch (cause) {
    logError(cause);
    return { ok: false, error: aiEndpointMessage(0, { subject: 'capture' }) };
  }
}

/** Tekstiosat mallin vastauksesta. Sama muoto kuin muillakin. */
function textFrom(data) {
  if (!data || !Array.isArray(data.content)) return '';
  return data.content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
    .trim();
}

// =====================================================================
// TARKISTUS JA HYVÄKSYNTÄ
// =====================================================================

/**
 * Avaa rivin tulkinta tarkistettavaksi.
 *
 * Tämä EI kirjoita mihinkään pysyvään. `pendingCapture` elää tilassa
 * siihen asti että käyttäjä hyväksyy tai hylkää.
 */
export function reviewItem(id) {
  const item = findInboxItem(id);
  if (!item) return null;

  const interpretation = item.proposal
    ? normalizeInterpretation(item.proposal)
    : null;

  const route = interpretation ? routeOf(interpretation) : null;

  const pending = {
    itemId: item.id,
    text: item.text,
    interpretation,
    route,
    description: route ? describeRoute(route, interpretation) : null,
    payload: route ? payloadFor(interpretation) : null
  };

  setPendingCapture(pending);
  return pending;
}

/** Sulje tarkistus ilman että mitään tapahtuu. */
export function closeReview() {
  setPendingCapture(null);
}

/**
 * Hyväksy tulkinta ja luo rivi.
 *
 * =====================================================================
 * IDEMPOTENSSI ON TÄSSÄ, EI KÄYTTÖLIITTYMÄSSÄ.
 * =====================================================================
 *
 * Painikkeen kahdesti painaminen on tavallista, ei virhe. Jo muunnettu
 * rivi ei voi muuntua uudelleen: tila `converted` on päätetila, ja
 * tarkistus tehdään ENNEN kirjoitusta.
 *
 * `markConverted` vaatii lisäksi, että rivi on ensin HYVÄKSYTTY. Tämä
 * funktio tekee molemmat siirtymät samassa polussa, mutta järjestys on
 * domainin määräämä eikä tämän.
 *
 * @param {string} id
 * @param {object} changes  käyttäjän korjaukset ehdotukseen
 */
export async function approveItem(id, changes = {}) {
  const item = findInboxItem(id);
  if (!item) return { ok: false };

  // JO MUUNNETTU EI MUUNNU UUDELLEEN.
  if (item.status === INBOX_STATUS.CONVERTED) {
    return { ok: false, alreadyConverted: true };
  }

  const interpretation = normalizeInterpretation({
    ...(item.proposal || {}),
    ...changes
  });

  const route = routeOf(interpretation);
  if (!route) {
    return {
      ok: false,
      errors: { kind: 'Tästä ei voi luoda riviä. Täydennä tiedot ensin.' }
    };
  }

  const action = ROUTE_ACTIONS[route.action];
  if (!action) {
    // Reitti, jolle ei ole toimintoa, on ohjelmointivirhe — ei
    // käyttäjän ongelma. Se ei silti saa kaataa mitään.
    logError(new Error(`Tuntematon reitti: ${route.action}`));
    return { ok: false };
  }

  // JOKAINEN REITTI VAATII VAHVISTUKSEN.
  //
  // Ei siksi, että ne olisivat vaarallisia, vaan siksi että ne
  // syntyvät tulkinnasta: käyttäjä kirjoitti lauseen, ja joku muu
  // päätti mitä se tarkoittaa.
  if (route.requiresConfirmation) {
    const confirmed = await confirmAction({
      title: 'Luodaanko tämä?',
      message: describeRoute(route, interpretation),
      confirmLabel: 'Luo'
    });
    if (!confirmed) return { ok: false, cancelled: true };
  }

  // Vahvistus on odotus, ja rivi on voinut muuttua sen aikana.
  const current = findInboxItem(id);
  if (!current || current.status === INBOX_STATUS.CONVERTED) {
    return { ok: false, alreadyConverted: true };
  }

  const created = await action(route.payload || payloadFor(interpretation));
  if (!created || created.ok === false) {
    return { ok: false, errors: created && created.errors };
  }

  const createdId = createdIdOf(created);
  const kind = ROUTE_KINDS[route.action] || null;

  // HYVÄKSYNTÄ ENSIN, MUUNNOS SITTEN. Domain vaatii tämän
  // järjestyksen, eikä tämä kerros saa kiertää sitä.
  const accepted = acceptItem(current);
  const converted = accepted && markConverted(accepted, kind, createdId);

  if (!converted) {
    // Rivi syntyi mutta saapuvaa ei voitu merkitä. Se on
    // epäjohdonmukainen tila, ja se KERROTAAN — hiljainen ohitus
    // jättäisi käyttäjän luulemaan että rivi jäi käsittelemättä.
    notify('Rivi luotiin, mutta saapuvaa ei voitu merkitä käsitellyksi.', 7000);
    return { ok: true, created, item: current };
  }

  replaceInboxItemInState(id, converted);
  setPendingCapture(null);

  const saved = await inboxRepo.update(converted);
  if (!saved.ok) {
    // Luotua riviä EI peruta. Se on käyttäjän dataa ja se on
    // kunnossa; vain merkintä jäi tallentumatta.
    replaceInboxItemInState(id, current);
    showError(saved.error);
    return { ok: true, created, item: current, markFailed: true };
  }

  success('Luotu.');
  return { ok: true, created, item: converted };
}

/** Luodun rivin tunniste, olipa toiminto palauttanut minkä nimisen olion. */
function createdIdOf(created) {
  for (const key of ['task', 'goal', 'project', 'routine', 'transaction',
                     'bill', 'savingsGoal', 'plan']) {
    if (created[key] && created[key].id) return created[key].id;
  }
  return null;
}

// =====================================================================
// ERÄ-KÄSITTELY (BRAIN DUMP, aalto L)
// =====================================================================
//
// Saapuvien rivit luokitellaan erässä: käyttäjä valitsee rivit ja yhden
// päätöksen (Tänään, Tällä viikolla, Myöhemmin, Ei vielä, Odottaa…,
// Menoksi, Hylkää). Ehdotus (src/domain/triage.js) on deterministinen eikä
// muuta mitään; tämä funktio on ainoa paikka, jossa päätös muuttuu
// kutsuksi, ja sitä kutsutaan vain käyttäjän napautuksesta.
//
// SAMAT TAKUUT KUIN approveItem:ssä:
//   - jo muunnettu tai hylätty rivi ei muunnu uudelleen (tarkistus ENNEN
//     kirjoitusta ja uudelleen luonnin jälkeen)
//   - hyväksyntä ensin, muunnos sitten (domainin järjestys)
//   - luotua riviä EI peruta, jos vain saapuvan merkintä epäonnistuu
//   - rivi kerrallaan: epäonnistunut rivi ei vie muita mukanaan
// PÄIVÄTÖN SÄÄNTÖ: ilman migraatiota 0015 päivätön päätös jättää rivin
// Saapuviin (ei keksittyä päivää), ja lopputulos kertoo sen.

/** Rivit, joiden erä on kesken: tuplanapautus ei luo kahta riviä. */
const triageInFlight = new Set();

/**
 * Ehdotus saapuvalle riville tämän hetken alueilla, tavoitteilla ja päivällä.
 * Ei kirjoita mitään.
 */
export function triageProposalOf(item, { todayIso: today = todayIso() } = {}) {
  if (!item) return null;
  const state = getState();
  return proposeTriage(item.text, { areas: state.lifeAreas, todayIso: today, goals: state.goals });
}

/**
 * Käsittele valitut saapuvat rivit yhdellä päätöksellä.
 *
 * @param {string[]} ids
 * @param {string} decision  TRIAGE_DECISION
 * @param {object} [options]
 * @param {Object<string,string|null>} [options.areaChoices] rivikohtainen alueen valinta (id -> alue tai null)
 * @param {string|null} [options.waitingOn] "Odottaa…": kenen tai minkä varassa (tyhjä = ehdotus)
 * @param {string} [options.todayIso] testejä varten
 * @returns {Promise<{ok:boolean, decision:string, converted:Array<{id,kind,createdId,markFailed?}>,
 *   kept:Array<{id,reason}>, failed:Array<{id,errors?}>, dismissed:number, skipped:Array<{id,reason}>}>}
 */
export async function triageInboxItems(ids, decision, { areaChoices = {}, waitingOn = null, todayIso: today } = {}) {
  const outcome = { ok: true, decision, converted: [], kept: [], failed: [], dismissed: 0, skipped: [] };
  if (!TRIAGE_DECISIONS.includes(decision)) return { ...outcome, ok: false };
  const day = isIsoDate(today) ? today : todayIso();
  const allowDateless = datelessTasksAllowed();
  const choices = areaChoices && typeof areaChoices === 'object' ? areaChoices : {};

  for (const id of [...new Set((Array.isArray(ids) ? ids : []).map(String))]) {
    const item = findInboxItem(id);
    // JO MUUNNETTU TAI HYLÄTTY EI MUUNNU UUDELLEEN.
    if (!item || item.status === INBOX_STATUS.CONVERTED || !isOpenItem(item) || triageInFlight.has(id)) {
      outcome.skipped.push({ id, reason: item ? 'closed' : 'missing' });
      continue;
    }
    const state = getState();
    const proposal = proposeTriage(item.text, { areas: state.lifeAreas, todayIso: day, goals: state.goals });
    const areaId = Object.prototype.hasOwnProperty.call(choices, id) ? (choices[id] || null) : undefined;
    const plan = planTriageDecision(item.text, decision, {
      proposal, areaId, areas: state.lifeAreas, todayIso: day, allowDateless, waitingOn
    });

    if (plan.action === 'keep') {
      outcome.kept.push({ id, reason: plan.reason });
      continue;
    }
    triageInFlight.add(id);
    try {
      if (plan.action === 'dismiss') {
        const dismissed = await dismissItemById(id);
        if (dismissed.ok) outcome.dismissed += 1;
        else outcome.failed.push({ id });
        continue;
      }
      await convertOne(id, plan, outcome);
    } finally {
      triageInFlight.delete(id);
    }
  }

  outcome.ok = outcome.failed.length === 0;
  return outcome;
}

/** Luo domain-rivi ja merkitse saapuva muunnetuksi (approveItem-järjestys). */
async function convertOne(id, plan, outcome) {
  const event = plan.action === 'event';
  const created = event ? await saveCalendarEvent(plan.payload) : await createTask(plan.payload);
  if (!created || created.ok === false) {
    outcome.failed.push({ id, errors: created && created.errors });
    return;
  }
  const kind = event ? 'event' : 'task';
  const createdId = event ? (created.event && created.event.id) || null : (created.task && created.task.id) || null;

  // Luonti on odotus, ja rivi on voinut muuttua sen aikana (toinen laite,
  // yksittäinen "Käsittele"). Luotua riviä ei peruta: se on käyttäjän dataa.
  const current = findInboxItem(id);
  if (!current || current.status === INBOX_STATUS.CONVERTED || !isOpenItem(current)) {
    outcome.converted.push({ id, kind, createdId, markFailed: true });
    return;
  }

  // HYVÄKSYNTÄ ENSIN, MUUNNOS SITTEN. Jo hyväksytty rivi ei hyväksy uudelleen.
  const accepted = current.status === INBOX_STATUS.ACCEPTED ? current : acceptItem(current);
  const converted = accepted && markConverted(accepted, kind, createdId);
  if (!converted) {
    notify('Rivi luotiin, mutta saapuvaa ei voitu merkitä käsitellyksi.', 7000);
    outcome.converted.push({ id, kind, createdId, markFailed: true });
    return;
  }

  replaceInboxItemInState(id, converted);
  const pending = getState().pendingCapture;
  if (pending && pending.itemId === id) setPendingCapture(null);

  const saved = await inboxRepo.update(converted);
  if (!saved.ok) {
    replaceInboxItemInState(id, current);
    showError(saved.error);
    outcome.converted.push({ id, kind, createdId, markFailed: true });
    return;
  }
  outcome.converted.push({ id, kind, createdId });
}

// =====================================================================
// HYLKÄYS JA PALAUTUS
// =====================================================================

/**
 * Hylkää saapuva rivi.
 *
 * EHDOTUS KATOAA, RIVI EI. Hylätty rivi on yhä tietue siitä että
 * käyttäjä kirjoitti jotain — ja hylkäys on peruttavissa.
 */
export async function dismissItemById(id) {
  const item = findInboxItem(id);
  if (!item) return { ok: false };

  const updated = dismissItem(item);
  if (!updated) return { ok: false };

  replaceInboxItemInState(id, updated);
  setPendingCapture(null);

  const saved = await inboxRepo.update(updated);
  if (!saved.ok) {
    replaceInboxItemInState(id, item);
    showError(saved.error);
    return { ok: false };
  }
  return { ok: true, item: updated };
}

/**
 * Palauta hylätty rivi käsittelemättömäksi.
 *
 * MUUNNETTUA EI VOI PALAUTTAA. `converted` on päätetila, ja
 * `restoreItem` palauttaa nullin — rivin palauttaminen ei poistaisi
 * siitä syntynyttä tehtävää, joten se loisi kaksoiskappaleen.
 */
export async function restoreItemById(id) {
  const item = findInboxItem(id);
  if (!item) return { ok: false };

  const updated = restoreItem(item);
  if (!updated) {
    notify('Muunnettua riviä ei voi palauttaa.', 4000);
    return { ok: false };
  }

  replaceInboxItemInState(id, updated);

  const saved = await inboxRepo.update(updated);
  if (!saved.ok) {
    replaceInboxItemInState(id, item);
    showError(saved.error);
    return { ok: false };
  }
  return { ok: true, item: updated };
}

/** Poista saapuva rivi kokonaan. */
export async function deleteInboxItem(id) {
  const item = findInboxItem(id);
  if (!item) return false;

  removeInboxItemFromState(id);
  setPendingCapture(null);

  const result = await inboxRepo.remove(id);
  if (!result.ok) {
    addInboxItemToState(item);
    showError(result.error);
    return false;
  }
  return true;
}
