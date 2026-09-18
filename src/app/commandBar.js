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
async function confirmAndExecute(proposal, auditId, confirmFn) {
  if (proposal.requiresConfirmation) {
    const accepted = await confirmFn(proposal);
    if (!accepted) {
      finish(auditId, { confirmed: false, executed: false, result: AUDIT_RESULT.CANCELLED });
      return { ok: false, status: 'cancelled', reason: 'Peruttu.' };
    }
  }

  const result = await executeProposal(proposal, handlers);
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

  return confirmAndExecute(proposal, auditId, ui.confirmFn);
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
 */
export async function runTypedCommand(text, {
  source = 'text', confirmFn = confirmProposal, chooseFn = chooseTarget, fetchImpl
} = {}) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { ok: false, status: 'empty' };

  const today = fmtISO(todayMidnight());
  const weekday = weekdayName(new Date());
  const accessToken = await currentAccessToken();

  const classified = await requestCommand({
    text: trimmed, today, weekday, source, accessToken, fetchImpl
  });
  if (!classified.ok) {
    showError(classified.error);
    return { ok: false, status: 'error', reason: classified.error.userMessage };
  }

  const proposal = buildProposal(classified.value.raw, { inputText: trimmed });
  return handleProposal(proposal, trimmed, { confirmFn, chooseFn });
}
