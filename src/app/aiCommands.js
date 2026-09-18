// AI-komentojen orkestrointi.
//
// TÄMÄ ON AINOA PAIKKA, JOSSA AI:N EHDOTUS MUUTTUU TOIMINNOKSI.
//
//   ai/intentSchema.js    MITÄ voidaan tehdä   (allowlist, skeema, riski)
//   ai/entityResolver.js  MIHIN se kohdistuu   (EXACT / AMBIGUOUS / NOT_FOUND)
//   tämä moduuli          MILLOIN se tapahtuu  (vahvistus, suoritus, kirjaus)
//   app/actions.js        MITEN se tallennetaan
//
// Putki kokonaisuudessaan:
//
//   raaka syöte
//     -> intent-jäsennys        (palvelin, api/parse.js)
//     -> tiukka skeema          (resolveCommand)
//     -> allowlist ja riski
//     -> kohteen tunnistus      (resolveTarget)
//     -> ehdotus + esikatselu   (buildProposal)
//     -> KÄYTTÄJÄN VAHVISTUS
//     -> sovelluskomento        (executeProposal)
//     -> repositorio
//     -> tulos
//     -> kirjaus                (audit)
//
// KOLME SÄÄNTÖÄ, JOTKA EIVÄT JOUSTA
//
//   1. Mitään ei suoriteta ilman vahvistusta paitsi vain lukevat komennot.
//   2. Epäselvä kohde EI koskaan etene. Käyttäjä valitsee, ei sovellus.
//   3. Korkean riskin komennon vahvistusta ei voi ohittaa asetuksella.

import { fmtISO, todayMidnight, parseISO, addDays } from '../lib/datetime.js';
import { toMinutes, fromMinutes } from '../domain/task.js';
import {
  RISK, TARGET, resolveCommand, needsConfirmation, isDestructive
} from '../ai/intentSchema.js';
import {
  RESOLUTION, resolveTarget, openTasksOnly, unpaidBillsOnly, describeResolution
} from '../ai/entityResolver.js';
import {
  AUDIT_RESULT, summarizeInput, appendAuditEntry, completeAuditEntry
} from '../domain/audit.js';
import { formatMoney } from '../domain/money.js';
import { getState, setAiAudit } from './state.js';
import { aiAuditRepo } from '../data/collectionsRepo.js';
import { logError } from '../lib/result.js';
import { newTaskId } from '../lib/rows.js';
import { logWarn } from '../lib/logger.js';

/** Mitä ehdotukselle voi tapahtua. */
export const PROPOSAL_STATUS = Object.freeze({
  /** Valmis vahvistettavaksi. */
  READY: 'ready',
  /** Kohde oli epäselvä — käyttäjä valitsee vaihtoehdoista. */
  NEEDS_CHOICE: 'needs_choice',
  /** Komentoa ei voitu muodostaa. */
  REJECTED: 'rejected'
});

/** Kohdetyypin luettava nimi. */
const TARGET_LABELS = Object.freeze({
  [TARGET.TASK]: 'Tehtävä',
  [TARGET.ROUTINE]: 'Rutiini',
  [TARGET.GOAL]: 'Tavoite',
  [TARGET.PROJECT]: 'Projekti',
  [TARGET.BILL]: 'Lasku',
  [TARGET.SETTINGS]: 'Asetukset',
  [TARGET.VIEW]: 'Näkymä'
});

export function targetLabel(type) {
  return TARGET_LABELS[type] || type;
}

/** Mistä tilan kokoelmasta kukin kohdetyyppi haetaan. */
function collectionFor(type, state) {
  switch (type) {
    case TARGET.TASK: return state.tasks;
    case TARGET.ROUTINE: return state.routines;
    case TARGET.GOAL: return state.goals;
    case TARGET.PROJECT: return state.projects;
    case TARGET.BILL: return state.bills;
    default: return [];
  }
}

/** Suodatin, joka rajaa kohteet mielekkäisiin komennon kannalta. */
function filterFor(intent, type) {
  if (type === TARGET.BILL && intent === 'mark_bill_paid') return unpaidBillsOnly;
  // `uncomplete_task` kohdistuu nimenomaan VALMIISIIN tehtäviin, joten
  // avoimiin rajaaminen tekisi siitä käyttökelvottoman.
  if (type === TARGET.TASK && intent !== 'uncomplete_task') return openTasksOnly;
  return null;
}

/** Tarvitseeko komento kohteen olemassa olevasta datasta? */
function needsTarget(command) {
  const payload = command.payload || {};
  return 'targetId' in payload || 'targetName' in payload;
}

// ------------------------------------------------------------ esikatselu

function fieldLabel(field) {
  const labels = {
    title: 'Otsikko', name: 'Nimi', date: 'Päivä', time: 'Kellonaika',
    endTime: 'Päättyy', deadline: 'Määräaika', durationMinutes: 'Kesto',
    category: 'Elämänalue', priority: 'Prioriteetti', note: 'Muistiinpano',
    status: 'Tila', targetDate: 'Tavoitepäivä', preferredTime: 'Kellonaika',
    recurrence: 'Toisto', weekdays: 'Viikonpäivät', active: 'Käytössä',
    progressMode: 'Edistyminen', manualProgress: 'Edistyminen %',
    amountMinor: 'Summa', dueDate: 'Eräpäivä', completed: 'Tehty'
  };
  return labels[field] || field;
}

function formatValue(field, value, entity) {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'amountMinor') return formatMoney(value, (entity && entity.currency) || 'EUR');
  if (field === 'completed' || field === 'active') return value ? 'kyllä' : 'ei';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/**
 * Rakenna rivit "nykyinen -> uusi" vahvistusnäkymää varten.
 *
 * Käyttäjän on nähtävä MITÄ muuttuu, ei vain että jotain muuttuu.
 * Pelkkä "Muuta tehtävää: Hammaslääkäri" ei riitä päätöksen pohjaksi.
 */
export function buildChangeRows(command, entity) {
  const changes = (command.payload && command.payload.changes) || null;
  if (!changes) return [];

  return Object.entries(changes).map(([field, next]) => ({
    field,
    label: fieldLabel(field),
    before: entity ? formatValue(field, entity[field], entity) : '—',
    after: formatValue(field, next, entity)
  }));
}

/**
 * Muodosta ehdotus AI:n raakavastauksesta.
 *
 * EI SUORITA MITÄÄN. Palauttaa esikatselun, jonka käyttäjä hyväksyy.
 *
 * @param {object} raw       AI:n tuottama objekti
 * @param {object} [options] { inputText, now }
 */
/**
 * Ratkaise kohde ja rakenna READY- tai NEEDS_CHOICE-ehdotus jo
 * validoidusta komennosta.
 *
 * EROTETTU buildProposal():sta, jotta epäselvän kohteen jälkeinen
 * uudelleenyritys (buildProposalForChosenTarget) voi käyttää TÄSMÄLLEEN
 * saman esikatselun rakennuslogiikan kuin ensimmäinen ehdotus, sen
 * sijaan että se kopioisi sen.
 */
function resolveAndPreview(command, { now, inputSummary, forcedTargetId } = {}) {
  const state = getState();

  let target = null;
  if (needsTarget(command)) {
    // KÄYTTÄJÄ ON JO VALINNUT: forcedTargetId tulee vain
    // ui/confirm.js:n chooseTarget()-valitsimesta, jonka vaihtoehdot
    // olivat juuri tämän saman resolveTarget()-kutsun tuottamia
    // candidateOf()-olioita. Tunnisteperustainen haku ei enää tarvitse
    // eikä käytä suodatinta (ks. entityResolver.js `id` voittaa aina).
    const resolution = forcedTargetId
      ? resolveTarget({
        entities: collectionFor(command.targetType, state),
        id: forcedTargetId,
        entityType: command.targetType
      })
      : resolveTarget({
        entities: collectionFor(command.targetType, state),
        id: command.payload.targetId,
        name: command.payload.targetName,
        entityType: command.targetType,
        filter: filterFor(command.intent, command.targetType)
      });

    if (resolution.status !== RESOLUTION.EXACT) {
      // EPÄSELVÄ TAI PUUTTUVA KOHDE EI KOSKAAN ETENE. Tämä on koko
      // resolverin olemassaolon syy: arvaus mutaatiossa muuttaisi väärää
      // tietoa, eikä käyttäjä huomaisi sitä ennen kuin on myöhäistä.
      //
      // (forcedTargetId-polulla NOT_FOUND on mahdollinen jos kohde
      // ehti kadota valinnan ja vahvistuksen välissä -- silloinkin
      // vastaus on rehellinen "ei löydy", ei arvaus.)
      return {
        status: PROPOSAL_STATUS.NEEDS_CHOICE,
        command,
        resolution,
        reason: describeResolution(resolution, targetLabel(command.targetType)),
        candidates: resolution.candidates,
        audit: {
          id: newTaskId(),
          timestamp: now.toISOString(),
          inputSummary,
          intent: command.intent,
          risk: command.risk,
          targetType: command.targetType,
          result: AUDIT_RESULT.AMBIGUOUS,
          proposal: command.description
        }
      };
    }

    target = resolution.match;
  }

  return {
    status: PROPOSAL_STATUS.READY,
    command,
    target,
    /** Ihmisluettava esikatselu: mitä, mihin, mistä mihin. */
    preview: {
      action: command.label,
      description: command.description,
      targetType: command.targetType,
      /** Kohdetyypin luettava nimi, jotta ui-kerroksen ei tarvitse tuntea
       *  app-kerrosta. Kerrosjärjestys ei jousta edes yhden merkkijonon
       *  vuoksi. */
      targetTypeLabel: targetLabel(command.targetType),
      targetLabel: target ? target.label : null,
      changes: buildChangeRows(command, target ? target.entity : null),
      destructive: isDestructive(command),
      rejectedFields: command.rejectedFields
    },
    requiresConfirmation: needsConfirmation(command),
    audit: {
      id: newTaskId(),
      timestamp: now.toISOString(),
      inputSummary,
      intent: command.intent,
      risk: command.risk,
      targetType: command.targetType,
      targetId: target ? target.id : null,
      result: AUDIT_RESULT.PROPOSED,
      proposal: command.description
    }
  };
}

export function buildProposal(raw, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const todayIso = fmtISO(todayMidnight());
  const inputSummary = summarizeInput(options.inputText);

  const resolved = resolveCommand(raw, { today: todayIso });

  if (!resolved.ok) {
    return {
      status: PROPOSAL_STATUS.REJECTED,
      reason: resolved.reason,
      audit: {
        id: newTaskId(),
        timestamp: now.toISOString(),
        inputSummary,
        intent: resolved.intent || 'unknown',
        risk: RISK.LOW,
        result: AUDIT_RESULT.REJECTED,
        proposal: resolved.reason
      }
    };
  }

  return resolveAndPreview(resolved.command, { now, inputSummary });
}

/**
 * Rakenna ehdotus uudelleen, kun käyttäjä on JO valinnut kohteen
 * epäselvästä joukosta (NEEDS_CHOICE-tilan `candidates`, ks.
 * ui/confirm.js `chooseTarget`).
 *
 * EI PALAA raw-tekstiin eikä resolveCommand():iin. `proposal.command`
 * on jo validoitu kertaalleen -- vain kohde puuttui. Uudelleenajo
 * `resolveCommand`:n läpi hylkäisi UPDATE_*-komennot, joiden payload
 * sisältää jo koostetun `changes`-olion (ei enää mallin raakakenttiä).
 *
 * @param {object} proposal NEEDS_CHOICE-tilainen buildProposal()-tulos
 * @param {string} candidateId valitun ehdokkaan id (candidates[i].id)
 * @param {object} [options] { inputText, now }
 */
export function buildProposalForChosenTarget(proposal, candidateId, options = {}) {
  if (!proposal || proposal.status !== PROPOSAL_STATUS.NEEDS_CHOICE) {
    return { status: PROPOSAL_STATUS.REJECTED, reason: 'Ei ratkaistavaa valintaa.' };
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const inputSummary = summarizeInput(options.inputText);
  return resolveAndPreview(proposal.command, { now, inputSummary, forcedTargetId: candidateId });
}

// -------------------------------------------------------------- kirjaus

/**
 * Kirjaa kirjausketju myös kantaan -- taustalla, tulosta odottamatta.
 *
 * KIRJAUKSEN EPÄONNISTUMINEN EI SAA MUUTTAA PÄÄTOIMINNON LOPPUTULOSTA.
 *
 * Kirjausketju kertoo mitä AI teki. Se on tärkeä, mutta se on
 * SIVUVAIKUTUS: jos sen tallennus epäonnistuu, käyttäjän komento on
 * silti joko onnistunut tai epäonnistunut omilla ehdoillaan. Jos
 * kirjaus saisi kaataa komennon, verkkokatko kirjausta tallennettaessa
 * peruisi käyttäjältä toiminnon joka jo tehtiin -- ja jos se saisi
 * muuttaa onnistumisen epäonnistumiseksi, käyttöliittymä valehtelisi
 * toiseen suuntaan.
 *
 * Siksi tämä ei heitä, ei palauta mitään eikä odota. Virhe menee
 * lokiin, jossa se on nähtävissä, eikä mihinkään muualle.
 *
 * Portin ollessa kiinni repositorio kirjoittaa muistivarastoon, joten
 * tämä on turvallinen jo ennen aallon E aktivointia.
 */
function persistAudit(operation) {
  let pending;
  try {
    pending = operation();
  } catch (cause) {
    logError(cause);
    return;
  }
  if (!pending || typeof pending.then !== 'function') return;

  pending.then(
    result => { if (result && result.ok === false) logError(result.error); },
    cause => logError(cause));
}

/** Lisää kirjaus tilaan. Kirjaus tehdään ENNEN käyttäjän vastausta. */
export function recordProposal(proposal) {
  if (!proposal || !proposal.audit) return null;
  setAiAudit(appendAuditEntry(getState().aiAudit, proposal.audit));
  persistAudit(() => aiAuditRepo.insert(proposal.audit));
  return proposal.audit.id;
}

/** Täydennä kirjaus lopputuloksella. Ei luo uutta riviä. */
export function completeAudit(auditId, changes) {
  if (!auditId) return;

  const entries = completeAuditEntry(getState().aiAudit, auditId, changes);
  setAiAudit(entries);

  // Päivitetään SE rivi joka tilaan jäi, ei annettuja muutoksia:
  // completeAuditEntry normalisoi tuloksen, ja kantaan kuuluu mennä
  // sama rivi jonka käyttöliittymä näyttää.
  const updated = entries.find(entry => String(entry.id) === String(auditId));
  if (updated) persistAudit(() => aiAuditRepo.update(updated));
}

// ------------------------------------------------------------ suoritus

/**
 * Laske uusi aika suhteellisesta siirrosta.
 *
 * "Siirrä kahdella tunnilla" tarkoittaa tehtävän omaa aikaa, ei
 * nykyhetkeä. Jos tehtävällä ei ole aikaa, siirtoa ei voi tehdä — ja se
 * kerrotaan, ei arvata.
 */
export function applyShift(entity, shiftMinutes) {
  if (!entity || !entity.time) return null;

  const total = toMinutes(entity.time) + shiftMinutes;
  const dayShift = Math.floor(total / 1440);
  const minutesInDay = ((total % 1440) + 1440) % 1440;

  return {
    time: fromMinutes(minutesInDay),
    // Siirto voi vaihtaa päivää. Ilman tätä "siirrä kaksi tuntia" klo
    // 23:00 asettaisi ajaksi 01:00 SAMANA päivänä eli menneisyyteen.
    date: dayShift === 0
      ? entity.date
      : fmtISO(addDays(parseISO(entity.date), dayShift))
  };
}

/**
 * Suorita vahvistettu ehdotus.
 *
 * @param {object} proposal buildProposal-tulos
 * @param {object} handlers Toiminnot intenttiä kohti (app/actions.js)
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function executeProposal(proposal, handlers = {}) {
  if (!proposal || proposal.status !== PROPOSAL_STATUS.READY) {
    return { ok: false, reason: 'Ehdotus ei ole suoritettavissa.' };
  }

  const { command, target } = proposal;
  const handler = handlers[command.intent];

  if (typeof handler !== 'function') {
    // Komento on skeemassa mutta sitä ei ole kytketty. Rehellinen
    // epäonnistuminen on parempi kuin hiljainen ei-mitään.
    logWarn('AI-komentoa ei ole kytketty sovellukseen', { intent: command.intent });
    return { ok: false, reason: 'Tätä komentoa ei ole vielä kytketty käyttöön.' };
  }

  try {
    const result = await handler({
      payload: command.payload,
      target,
      entity: target ? target.entity : null
    });
    return result && typeof result === 'object' ? result : { ok: true };
  } catch (error) {
    logWarn('AI-komennon suoritus epäonnistui', { intent: command.intent });
    return { ok: false, reason: 'Komennon suoritus epäonnistui.', cause: error };
  }
}

/**
 * Koko putki yhdessä kutsussa.
 *
 * `confirm` on funktio, joka näyttää esikatselun ja palauttaa `true` vain
 * jos käyttäjä hyväksyi. Sitä EI kutsuta vain lukeville komennoille.
 */
export async function runAiCommand(raw, { inputText, confirm, handlers, now } = {}) {
  const proposal = buildProposal(raw, { inputText, now });
  const auditId = recordProposal(proposal);

  if (proposal.status === PROPOSAL_STATUS.REJECTED) {
    return { ok: false, status: proposal.status, reason: proposal.reason };
  }

  if (proposal.status === PROPOSAL_STATUS.NEEDS_CHOICE) {
    return {
      ok: false,
      status: proposal.status,
      reason: proposal.reason,
      candidates: proposal.candidates
    };
  }

  if (proposal.requiresConfirmation) {
    const accepted = typeof confirm === 'function' ? await confirm(proposal) : false;
    if (!accepted) {
      completeAudit(auditId, { confirmed: false, executed: false, result: AUDIT_RESULT.CANCELLED });
      return { ok: false, status: 'cancelled', reason: 'Peruttu.' };
    }
  }

  const result = await executeProposal(proposal, handlers);

  completeAudit(auditId, {
    confirmed: true,
    executed: Boolean(result.ok),
    result: result.ok ? AUDIT_RESULT.EXECUTED : AUDIT_RESULT.FAILED,
    errorCode: result.ok ? null : (result.reason || 'unknown')
  });

  return { ok: Boolean(result.ok), status: 'executed', reason: result.reason, proposal };
}
