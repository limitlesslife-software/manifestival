// AI-komentojen syöttöputki: käyttäjän lause -> luokittelu -> ehdotus ->
// vahvistus -> suoritus.
//
// TÄMÄ ON AINOA PAIKKA, JOKA KUTSUU /api/command:ia. Kirjoitettu ja
// puhuttu komento kulkevat molemmat tämän saman putken läpi
// (runTypedCommand), jotta niillä on TÄSMÄLLEEN samat turvatakuut:
// sama allowlist, sama kohteentunnistus, sama vahvistusdialogi, sama
// kirjausketju. Ks. src/app/aiCommands.js (putken keskiosa) ja
// src/app/aiCommandHandlers.js (suoritus).
//
// EPÄSELVÄN KOHTEEN RATKAISU ON REKURSIIVINEN MUTTA PÄÄTTYVÄ:
// buildProposalForChosenTarget() voi palauttaa vain READY:n tai
// NEEDS_CHOICE:n nollalla ehdokkaalla (kohde katosi valinnan aikana) —
// jälkimmäinen ei koskaan näytä valitsinta uudelleen, vaan kertoo
// rehellisesti että kohdetta ei löydy.

import { requestCommand, weekdayName } from '../ai/commandClient.js';
import {
  buildProposal, buildProposalForChosenTarget, recordProposal, completeAudit,
  executeProposal, PROPOSAL_STATUS
} from './aiCommands.js';
import { handlers } from './aiCommandHandlers.js';
import { currentAccessToken } from './auth.js';
import { confirmProposal, chooseTarget } from '../ui/confirm.js';
import { showError, notify } from '../ui/toast.js';
import { fmtISO, todayMidnight } from '../lib/datetime.js';
import { AUDIT_RESULT } from '../domain/audit.js';
import { logEvent } from '../lib/logger.js';
import { reconcileTemporal } from '../ai/temporalReconcile.js';

/** Vaiheraportti (onPhase) on valinnainen: ilman sitä vaiheista ei kerrota kenellekään. */
const NO_PHASE = () => {};

function finish(auditId, changes) {
  completeAudit(auditId, changes);
}

/**
 * Vahvista (jos vaaditaan) ja suorita valmis ehdotus.
 *
 * KAKSI TAPAA EPÄONNISTUA REHELLISESTI: käyttäjä peruu vahvistuksen, tai
 * suoritus itse epäonnistuu (esim. kohde ehti muuttua). Molemmat
 * kirjataan kirjausketjuun, eikä kumpikaan näytä onnistumiselta.
 *
 * `confirmFn` on injektoitavissa (oletus: ui/confirm.js `confirmProposal`),
 * samalla periaatteella kuin aiCommands.js:n `runAiCommand({confirm})` —
 * jotta vahvistuksen läpäisy/esto on yksikkötestattavissa ilman DOM:ia.
 */
async function confirmAndExecute(proposal, auditId, confirmFn, phase) {
  if (proposal.requiresConfirmation) {
    phase('confirmation');
    const accepted = await confirmFn(proposal);
    if (!accepted) {
      finish(auditId, { confirmed: false, executed: false, result: AUDIT_RESULT.CANCELLED });
      return { ok: false, status: 'cancelled', reason: 'Peruttu.' };
    }
  }

  phase('executing');
  const result = await executeProposal(proposal, handlers);
  logEvent('command.executed', {
    intent: proposal.command.intent, risk: proposal.command.risk, ok: Boolean(result.ok),
    duplicate: Boolean(result.duplicate)
  });

  // Sama ehdotus oli jo suoritettu tai kesken: ensimmäisen suorituksen
  // kirjaus ja tulos ovat totuus, eikä toinen kutsu saa ylikirjoittaa
  // niitä epäonnistumisella tai näyttää virhettä onnistuneesta komennosta.
  if (result.duplicate) return { ok: false, status: 'duplicate', reason: result.reason };

  finish(auditId, {
    confirmed: true,
    executed: Boolean(result.ok),
    result: result.ok ? AUDIT_RESULT.EXECUTED : AUDIT_RESULT.FAILED,
    errorCode: result.ok ? null : (result.reason || 'unknown')
  });

  if (!result.ok) {
    showError(result.reason || 'Komento epäonnistui.', 'Komento epäonnistui.');
  }

  return { ok: Boolean(result.ok), status: 'executed', reason: result.reason, proposal };
}

/**
 * Käsittele ehdotus loppuun: hylkäys, epäselvyys tai valmis suoritus.
 *
 * @param {object} proposal buildProposal()- tai buildProposalForChosenTarget()-tulos
 * @param {string} inputText alkuperäinen käyttäjän teksti (kirjausta varten)
 * @param {object} ui { confirmFn, chooseFn } — injektoitavissa testeissä
 */
async function handleProposal(proposal, inputText, ui) {
  const phase = ui.phase || NO_PHASE;
  const auditId = recordProposal(proposal);

  if (proposal.status === PROPOSAL_STATUS.REJECTED) {
    notify(proposal.reason || 'Komentoa ei ymmärretty.');
    return { ok: false, status: proposal.status, reason: proposal.reason };
  }

  if (proposal.status === PROPOSAL_STATUS.NEEDS_CHOICE) {
    if (!Array.isArray(proposal.candidates) || proposal.candidates.length === 0) {
      finish(auditId, { confirmed: false, executed: false, result: AUDIT_RESULT.CANCELLED });
      notify(proposal.reason || 'Kohdetta ei löytynyt.');
      return { ok: false, status: proposal.status, reason: proposal.reason };
    }

    phase('target_selection');
    const chosen = await ui.chooseFn(proposal.candidates, proposal.reason);
    if (!chosen) {
      finish(auditId, { confirmed: false, executed: false, result: AUDIT_RESULT.CANCELLED });
      return { ok: false, status: 'cancelled', reason: 'Ei valintaa.' };
    }

    // Alkuperäinen (epäselvä) kirjaus jää AMBIGUOUS-tulokseen sellaisenaan
    // — se on totuudenmukainen kuvaus siitä hetkestä. Ratkaistu suoritus
    // saa OMAN riivinsä, koska se on eri, myöhempi tapahtuma.
    const resolved = buildProposalForChosenTarget(proposal, chosen.id, { inputText });
    return handleProposal(resolved, inputText, ui);
  }

  phase('review');
  return confirmAndExecute(proposal, auditId, ui.confirmFn, phase);
}

/**
 * Suorita kirjoitettu tai puhuttu komento alusta loppuun.
 *
 * EI KOSKAAN HEITÄ. Palauttaa aina { ok, status, reason? } — verkkovirhe,
 * hylätty komento ja peruttu vahvistus näyttäytyvät kaikki samalla
 * tavalla kutsujalle, eroteltuna `status`-kentällä.
 *
 * @param {string} text käyttäjän kirjoittama tai puhuma komento
 * @param {object} [options]
 * @param {'text'|'voice'} [options.source]
 * @param {Function} [options.confirmFn] testejä varten; oletus ui/confirm.js confirmProposal
 * @param {Function} [options.chooseFn] testejä varten; oletus ui/confirm.js chooseTarget
 * @param {Function} [options.fetchImpl] testejä varten
 * @param {(phase:string) => void} [options.onPhase] vaiheraportti: 'classifying' | 'review' |
 *   'target_selection' | 'confirmation' | 'executing' (puheen tilakone käyttää; ei muuta käyttäytymistä)
 */
export async function runTypedCommand(text, {
  source = 'text', confirmFn = confirmProposal, chooseFn = chooseTarget, fetchImpl, onPhase
} = {}) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { ok: false, status: 'empty' };

  const phase = typeof onPhase === 'function' ? onPhase : NO_PHASE;
  phase('classifying');

  const today = fmtISO(todayMidnight());
  const weekday = weekdayName(new Date());
  const accessToken = await currentAccessToken();

  const classified = await requestCommand({
    text: trimmed, today, weekday, source, accessToken, fetchImpl
  });
  logEvent('command.classified', {
    source, ok: classified.ok, code: classified.ok ? null : classified.error.code, chars: trimmed.length
  });
  if (!classified.ok) {
    showError(classified.error);
    return { ok: false, status: 'error', reason: classified.error.userMessage };
  }

  // Mallin päivä ja kellonaika vs. käyttäjän oma lause: korjataan vain kun
  // jäsennin on yksiselitteinen (ks. ai/temporalReconcile.js).
  const reconciled = reconcileTemporal(classified.value.raw, trimmed, today);
  if (reconciled.corrections.length > 0) {
    logEvent('command.reconciled', { fields: reconciled.corrections.join(',') });
  }
  const proposal = buildProposal(reconciled.raw, { inputText: trimmed });
  logEvent('command.proposal', {
    status: proposal.status,
    intent: proposal.command ? proposal.command.intent : null,
    risk: proposal.command ? proposal.command.risk : null
  });
  return handleProposal(proposal, trimmed, { confirmFn, chooseFn, phase });
}
