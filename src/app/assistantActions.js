// Avustajan toiminnot: muistutukset, ilmoitukset, matka ja sijaintisäännöt.
//
// =====================================================================
// MIKSI OMANA MODUULINAAN
// =====================================================================
//
// `actions.js` on jo 1500 riviä. Uusi kerros samaan tiedostoon tekisi
// siitä paikan, josta ei löydä mitään — ja `planning.js` on jo
// osoittanut, että sovelluskerroksen jakaminen aihepiireittäin toimii.
//
// Sama kaava kuin `actions.js`:ssä ja samasta syystä:
//   1. talleta nykytila
//   2. päivitä käyttöliittymä heti
//   3. kirjoita kantaan
//   4. jos kirjoitus epäonnistuu: PALAUTA aiempi tila ja kerro
//
// =====================================================================
// KAKSI SÄÄNTÖÄ, JOTKA TÄMÄ KERROS OMISTAA
// =====================================================================
//
// 1. ORPO MUISTUTUS PERUTAAN NÄKYVÄSTI.
//
//    `target_id` ei ole vierasavain, joten kanta ei tee tälle mitään.
//    Kohde voidaan poistaa, ja muistutus jää. Hiljainen poisto olisi
//    väärin kahdesta syystä: käyttäjä ei saisi tietää, että hänen
//    muistutuksensa katosi, eikä tietue siitä että muistuttaminen oli
//    tarkoitus ole roskaa.
//
//    Peruttu muistutus on siis päätetilassa ja näkyvissä, ei poissa.
//
// 2. TORKUTUS EI KOSKE KOHTEESEEN.
//
//    Domain takaa tämän rakenteellisesti: `snooze()` ottaa vastaan
//    muistutuksen eikä kohdetta, eikä se voi palauttaa muutosta
//    tehtävään. Tämä kerros ei saa kiertää sitä kirjoittamalla
//    kohteeseen erikseen — eikä se kirjoita.

import {
  remindersRepo, noticesRepo, travelPlansRepo, locationRulesRepo
} from '../data/collectionsRepo.js';
import { newTaskId } from '../lib/rows.js';
import { fmtISO, todayMidnight } from '../lib/datetime.js';
import {
  normalizeReminder, validateReminder, REMINDER_STATUS, REMINDER_TARGET,
  acknowledge, snooze as snoozeReminder, markCompleted, cancel as cancelReminder,
  expire as expireReminder, evaluateReminders, resolveTriggerTime,
  reminderForTask, markDelivered, transition
} from '../domain/reminder.js';
import {
  normalizeNotice, validateNotice, noticeFromAlert, noticeFromDeparture,
  markRead, markActed, markDismissed, pruneNotices, NOTICE_STATUS
} from '../domain/notificationCenter.js';
import {
  normalizeTravelPlan, validateTravelPlan, normalizeLocationRule,
  applyEstimate, manualEstimate, shouldAlertDeparture, describeDeparture,
  leaveStatus
} from '../domain/travel.js';
import {
  getState, findTask,
  addReminderToState, replaceReminderInState, removeReminderFromState,
  findReminder, replaceRemindersInState,
  addNoticeToState, replaceNoticeInState, removeNoticeFromState, findNotice,
  replaceNoticesInState,
  addTravelPlanToState, replaceTravelPlanInState, removeTravelPlanFromState,
  findTravelPlan,
  addLocationRuleToState, replaceLocationRuleInState, removeLocationRuleFromState,
  findLocationRule
} from './state.js';
import { showError, success, notify } from '../ui/toast.js';
import { confirmDelete, confirmAction } from '../ui/confirm.js';

/** Tämän päivän ISO-päivä. Kello luetaan TÄSSÄ, ei domainissa. */
function todayIso() {
  return fmtISO(todayMidnight());
}

/** Minuutteja keskiyöstä juuri nyt. */
function nowMinutes(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes();
}

// =====================================================================
// MUISTUTUKSET
// =====================================================================

/**
 * Luo muistutus.
 *
 * Laukaisuaika RATKAISTAAN kohteesta, jos muistutus on suhteessa
 * siihen. Ilman tätä "30 min ennen" olisi pelkkä luku ilman hetkeä.
 */
export async function createReminder(input = {}) {
  const target = resolveTarget(input.targetType, input.targetId);

  // Kohdelaji ja tunniste kulkevat parina. Tämä on kannassa rajoite
  // `reminders_target_pair_check`; täällä se on virheilmoitus, jonka
  // käyttäjä ymmärtää.
  if (input.targetType && input.targetType !== REMINDER_TARGET.STANDALONE
      && !target) {
    return { ok: false, errors: { targetId: 'Kohdetta ei löytynyt.' } };
  }

  const base = normalizeReminder({ ...input, id: newTaskId() });

  // `resolveTriggerTime` palauttaa `{ dateIso, time }` TAI NULLIN.
  // Null tarkoittaa, ettei hetkeä voi laskea — silloin kentät jäävät
  // siihen mitä käyttäjä antoi, ja validointi kertoo jos ne puuttuvat.
  const resolved = resolveTriggerTime(base, target);

  const reminder = normalizeReminder({
    ...base,
    dueDate: (resolved && resolved.dateIso) || base.dueDate,
    dueTime: (resolved && resolved.time) || base.dueTime
  });

  const { valid, errors } = validateReminder(reminder);
  if (!valid) return { ok: false, errors };

  addReminderToState(reminder);

  const result = await remindersRepo.insert(reminder);
  if (!result.ok) {
    removeReminderFromState(reminder.id);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, reminder };
}

/** Muistutus tehtävälle. Oikotie, joka käyttää samaa polkua. */
export async function createReminderForTask(taskId, options = {}) {
  const task = findTask(taskId);
  if (!task) return { ok: false, errors: { targetId: 'Tehtävää ei löytynyt.' } };

  const draft = reminderForTask(task, { id: newTaskId(), ...options });
  if (!draft) return { ok: false };

  return createReminder({ ...draft, id: undefined });
}

/** Muokkaa muistutusta. */
export async function editReminder(id, changes = {}) {
  const previous = findReminder(id);
  if (!previous) return { ok: false };

  const updated = normalizeReminder({ ...previous, ...changes, id });
  const { valid, errors } = validateReminder(updated);
  if (!valid) return { ok: false, errors };

  replaceReminderInState(id, updated);

  const result = await remindersRepo.update(updated);
  if (!result.ok) {
    replaceReminderInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, reminder: updated };
}

/**
 * Torkuta muistutusta.
 *
 * TÄMÄ EI KOSKE KOHTEESEEN. Domain palauttaa vain muistutuksen, eikä
 * tämä funktio kirjoita muualle kuin muistutukseen — tehtävän
 * määräaika pysyy ennallaan.
 */
export async function snoozeReminderBy(id, minutes) {
  const previous = findReminder(id);
  if (!previous) return { ok: false };

  const updated = snoozeReminder(previous, minutes, {
    todayIso: todayIso(), nowMinutes: nowMinutes()
  });
  if (!updated) {
    notify('Torkutusta ei voi enää jatkaa.', 4000);
    return { ok: false };
  }

  return persistReminderTransition(previous, updated);
}

/** Kuittaa muistutus nähdyksi. Ei merkitse kohdetta tehdyksi. */
export async function acknowledgeReminder(id) {
  const previous = findReminder(id);
  if (!previous) return { ok: false };
  const updated = acknowledge(previous);
  if (!updated) return { ok: false };
  return persistReminderTransition(previous, updated);
}

/** Merkitse muistutus hoidetuksi. */
export async function completeReminder(id) {
  const previous = findReminder(id);
  if (!previous) return { ok: false };
  const updated = markCompleted(previous);
  if (!updated) return { ok: false };
  return persistReminderTransition(previous, updated);
}

/** Peru muistutus. Rivi jää näkyviin päätetilassa. */
export async function cancelReminderById(id) {
  const previous = findReminder(id);
  if (!previous) return { ok: false };
  const updated = cancelReminder(previous);
  if (!updated) return { ok: false };
  return persistReminderTransition(previous, updated);
}

/**
 * Poista muistutus kokonaan.
 *
 * Eri asia kuin peruminen: peruttu muistutus on tietue, poistettu ei
 * ole mitään. Siksi tämä kysyy vahvistuksen ja peruminen ei.
 */
export async function deleteReminder(id) {
  const reminder = findReminder(id);
  if (!reminder) return false;

  const confirmed = await confirmDelete(reminder.title);
  if (!confirmed) return false;

  removeReminderFromState(id);

  const result = await remindersRepo.remove(id);
  if (!result.ok) {
    addReminderToState(reminder);
    showError(result.error);
    return false;
  }
  success('Muistutus poistettu.');
  return true;
}

/** Yhteinen kirjoitus tilasiirtymälle. */
async function persistReminderTransition(previous, updated) {
  replaceReminderInState(previous.id, updated);

  const result = await remindersRepo.update(updated);
  if (!result.ok) {
    replaceReminderInState(previous.id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, reminder: updated };
}

/** Kohde tunnisteella. Vain tehtävä on toistaiseksi ratkaistavissa. */
function resolveTarget(targetType, targetId) {
  if (!targetType || !targetId) return null;
  const state = getState();
  switch (targetType) {
    case REMINDER_TARGET.TASK: return findTask(targetId);
    case REMINDER_TARGET.ROUTINE:
      return state.routines.find(r => r.id === targetId) || null;
    case REMINDER_TARGET.BILL:
      return state.bills.find(b => b.id === targetId) || null;
    case REMINDER_TARGET.MILESTONE:
      return state.milestones.find(m => m.id === targetId) || null;
    case REMINDER_TARGET.GOAL:
      return state.goals.find(g => g.id === targetId) || null;
    case REMINDER_TARGET.TRAVEL:
      return state.travelPlans.find(p => p.id === targetId) || null;
    default: return null;
  }
}

/** Kohdekokoelmat orpoustarkistusta varten. */
function targetLookup(state = getState()) {
  return {
    [REMINDER_TARGET.TASK]: state.tasks,
    [REMINDER_TARGET.ROUTINE]: state.routines,
    [REMINDER_TARGET.BILL]: state.bills,
    [REMINDER_TARGET.MILESTONE]: state.milestones,
    [REMINDER_TARGET.GOAL]: state.goals,
    [REMINDER_TARGET.TRAVEL]: state.travelPlans
  };
}

// =====================================================================
// HÄLYTYSKIERROS
// =====================================================================

/**
 * Käy muistutukset läpi ja tuota ilmoitukset.
 *
 * =================================================================
 * TÄMÄ EI OLE AJASTIN.
 * =================================================================
 *
 * Tätä kutsutaan kun sovellus on auki: käynnistyksessä, näkymän
 * vaihtuessa ja taustasovittimen herättäessä. Oikeaa taustaherätystä
 * ei ole eikä sitä voi luvata ilman laitehyväksyntää — ja lupaus,
 * jota ei voi pitää, on pahempi kuin puuttuva ominaisuus.
 *
 * Kaksoiskappaleiden esto on kolminkertainen:
 *   1. `deliveredKeys` — mitä tässä istunnossa on jo näytetty
 *   2. `addNoticeToState` — sama avain ei mene tilaan kahdesti
 *   3. `notices_key_unique` — kanta hylkää rivin
 *
 * @returns {{alerts: number, expired: number, orphaned: number}}
 */
export async function runReminderSweep({ now = new Date() } = {}) {
  const state = getState();
  const today = todayIso();
  const minutes = nowMinutes(now);

  const deliveredKeys = new Set(state.notices.map(n => n.key).filter(Boolean));

  const { alerts, expired, orphaned } = evaluateReminders({
    reminders: state.reminders,
    todayIso: today,
    nowMinutes: minutes,
    deliveredKeys,
    lookup: targetLookup(state)
  });

  const created = [];
  for (const alert of alerts) {
    const notice = noticeFromAlert(alert, { id: newTaskId(), createdDate: today });
    if (!notice) continue;
    if (!validateNotice(notice).valid) continue;
    if (!addNoticeToState(notice)) continue;   // sama avain jo tilassa
    created.push(notice);
  }

  // Hälytetyt muistutukset siirtyvät toimitetuiksi ja hälytyslaskuri
  // kasvaa. Ilman laskuria sama muistutus hälyttäisi joka kierroksella.
  //
  // TILAKONETTA EI KIERRETÄ. Ajastetusta ei pääse suoraan toimitettuun,
  // vaan väli on `due` — ja se on oikein: erääntynyt mutta näyttämätön
  // on oma tilansa. `markDelivered` palauttaa nullin kielletystä
  // siirtymästä, eikä sitä saa ohittaa kirjoittamalla tila suoraan.
  const touched = [];
  for (const alert of alerts) {
    const reminder = state.reminders.find(r => r.id === alert.reminderId);
    if (!reminder) continue;

    const due = reminder.status === REMINDER_STATUS.SCHEDULED
      ? transition(reminder, REMINDER_STATUS.DUE)
      : reminder;
    if (!due) continue;

    const updated = markDelivered(due);
    if (updated) touched.push(updated);
  }

  for (const reminder of expired) {
    const updated = expireReminder(reminder);
    if (updated) touched.push(updated);
  }

  // ORPO PERUTAAN NÄKYVÄSTI, ei poisteta hiljaa.
  const cancelled = [];
  for (const reminder of orphaned) {
    const updated = cancelReminder(reminder);
    if (!updated) continue;
    touched.push(updated);
    cancelled.push(updated);
  }

  if (touched.length > 0) {
    replaceRemindersInState(touched);
    await Promise.all(touched.map(r => remindersRepo.update(r)));
  }

  await Promise.all(created.map(n => noticesRepo.insert(n)));

  if (cancelled.length === 1) {
    notify(`Muistutus "${cancelled[0].title}" peruttiin: kohdetta ei enää ole.`, 6000);
  } else if (cancelled.length > 1) {
    notify(`${cancelled.length} muistutusta peruttiin: kohdetta ei enää ole.`, 6000);
  }

  return {
    alerts: created.length,
    expired: expired.length,
    orphaned: cancelled.length
  };
}

/**
 * Peru kohteen muistutukset, kun kohde poistetaan.
 *
 * Kutsutaan poiston YHTEYDESSÄ eikä vasta seuraavalla kierroksella:
 * käyttäjä saa tietää heti, mitä hänen poistonsa aiheutti.
 */
export async function cancelRemindersForTarget(targetType, targetId) {
  const matching = getState().reminders.filter(
    r => r.targetType === targetType && r.targetId === targetId
         && r.status !== REMINDER_STATUS.CANCELLED);

  if (matching.length === 0) return 0;

  const cancelled = matching.map(cancelReminder).filter(Boolean);
  if (cancelled.length === 0) return 0;

  replaceRemindersInState(cancelled);
  await Promise.all(cancelled.map(r => remindersRepo.update(r)));

  notify(cancelled.length === 1
    ? 'Kohteen muistutus peruttiin.'
    : `${cancelled.length} muistutusta peruttiin.`, 5000);

  return cancelled.length;
}

// =====================================================================
// ILMOITUKSET
// =====================================================================

/** Merkitse ilmoitus luetuksi. */
export async function readNotice(id) {
  return persistNoticeTransition(id, markRead);
}

/** Merkitse ilmoitus toimenpiteen aiheuttaneeksi. */
export async function actOnNotice(id) {
  return persistNoticeTransition(id, markActed);
}

/** Hylkää ilmoitus. */
export async function dismissNotice(id) {
  return persistNoticeTransition(id, markDismissed);
}

async function persistNoticeTransition(id, change) {
  const previous = findNotice(id);
  if (!previous) return { ok: false };

  const updated = change(previous);
  if (!updated) return { ok: false };

  replaceNoticeInState(id, updated);

  const result = await noticesRepo.update(updated);
  if (!result.ok) {
    replaceNoticeInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, notice: updated };
}

/**
 * Karsi vanhat ilmoitukset.
 *
 * LUKEMATON SÄILYY KAKSI KERTAA PIDEMPÄÄN. Ilmoitus, jota ei ole
 * luettu, on se jota käyttäjä ei ehtinyt nähdä — sen poistaminen ensin
 * olisi juuri väärin päin.
 */
export async function pruneNoticeHistory() {
  const before = getState().notices;
  const after = pruneNotices(before, { todayIso: todayIso() });

  if (after.length === before.length) return 0;

  const kept = new Set(after.map(n => n.id));
  const removed = before.filter(n => !kept.has(n.id));

  replaceNoticesInState(after);
  await Promise.all(removed.map(n => noticesRepo.remove(n.id)));

  return removed.length;
}

/** Poista yksi ilmoitus. */
export async function deleteNotice(id) {
  const notice = findNotice(id);
  if (!notice) return false;

  removeNoticeFromState(id);

  const result = await noticesRepo.remove(id);
  if (!result.ok) {
    addNoticeToState(notice);
    showError(result.error);
    return false;
  }
  return true;
}

// =====================================================================
// MATKASUUNNITELMAT
// =====================================================================

/**
 * Luo matkasuunnitelma.
 *
 * KOORDINAATTEJA EI OTETA VASTAAN. `origin` ja `destination` ovat
 * nimiä; normalisointi ei tunne muuta, eikä kannassa ole saraketta
 * johon koordinaatti mahtuisi.
 */
export async function createTravelPlan(input = {}) {
  const plan = normalizeTravelPlan({ ...input, id: newTaskId() });

  if (plan.taskId && !findTask(plan.taskId)) {
    return { ok: false, errors: { taskId: 'Tehtävää ei löytynyt.' } };
  }

  const { valid, errors } = validateTravelPlan(plan);
  if (!valid) return { ok: false, errors };

  addTravelPlanToState(plan);

  const result = await travelPlansRepo.insert(plan);
  if (!result.ok) {
    removeTravelPlanFromState(plan.id);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, plan };
}

/** Muokkaa matkasuunnitelmaa. */
export async function editTravelPlan(id, changes = {}) {
  const previous = findTravelPlan(id);
  if (!previous) return { ok: false };

  const updated = normalizeTravelPlan({ ...previous, ...changes, id });

  if (updated.taskId && !findTask(updated.taskId)) {
    return { ok: false, errors: { taskId: 'Tehtävää ei löytynyt.' } };
  }

  const { valid, errors } = validateTravelPlan(updated);
  if (!valid) return { ok: false, errors };

  replaceTravelPlanInState(id, updated);

  const result = await travelPlansRepo.update(updated);
  if (!result.ok) {
    replaceTravelPlanInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, plan: updated };
}

/**
 * Kirjaa matka-arvio käsin.
 *
 * Tämä on toistaiseksi AINOA tapa saada kesto: palvelua ei ole, ja
 * `hasTravelProvider()` palauttaa epätoden. Käsin kirjattu arvio
 * merkitään lähteellä `manual`, jotta käyttöliittymä voi sanoa mistä
 * luku tuli.
 */
export async function setTravelEstimate(id, minutes) {
  const previous = findTravelPlan(id);
  if (!previous) return { ok: false };

  const estimate = manualEstimate(minutes, {
    estimatedAt: new Date().toISOString()
  });
  if (!estimate) {
    return { ok: false, errors: { travelMinutes: 'Kesto ei kelpaa.' } };
  }

  const updated = applyEstimate(previous, estimate);
  if (!updated) return { ok: false };

  replaceTravelPlanInState(id, updated);

  const result = await travelPlansRepo.update(updated);
  if (!result.ok) {
    replaceTravelPlanInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, plan: updated };
}

/** Poista matkasuunnitelma. */
export async function deleteTravelPlan(id) {
  const plan = findTravelPlan(id);
  if (!plan) return false;

  const confirmed = await confirmDelete(plan.title);
  if (!confirmed) return false;

  removeTravelPlanFromState(id);
  await cancelRemindersForTarget(REMINDER_TARGET.TRAVEL, id);

  const result = await travelPlansRepo.remove(id);
  if (!result.ok) {
    addTravelPlanToState(plan);
    showError(result.error);
    return false;
  }
  success('Matkasuunnitelma poistettu.');
  return true;
}

/**
 * Tuota lähtöilmoitukset niistä matkoista, joiden aika on käsillä.
 *
 * TUNTEMATON KESTO EI TUOTA ILMOITUSTA. `shouldAlertDeparture`
 * palauttaa epätoden, kun lähtöaikaa ei voi laskea — ilmoitus
 * kellonajalla, jota ei tiedetä, olisi vale.
 */
export async function runDepartureSweep({ now = new Date() } = {}) {
  const state = getState();
  const today = todayIso();
  const minutes = nowMinutes(now);

  const created = [];
  for (const plan of state.travelPlans) {
    if (!shouldAlertDeparture(plan, { todayIso: today, nowMinutes: minutes })) {
      continue;
    }

    // `describeDeparture` palauttaa MERKKIJONON, ja myöhässäolo
    // luetaan `leaveStatus`-tilasta. Ne ovat eri funktioita, koska
    // toinen on tekstiä ihmiselle ja toinen lukuja koneelle.
    const status = leaveStatus(plan, { todayIso: today, nowMinutes: minutes });
    const notice = noticeFromDeparture(plan, {
      id: newTaskId(),
      todayIso: today,
      reason: describeDeparture(plan, { todayIso: today, nowMinutes: minutes }),
      late: status.late
    });
    if (!notice) continue;
    if (!validateNotice(notice).valid) continue;
    if (!addNoticeToState(notice)) continue;
    created.push(notice);
  }

  await Promise.all(created.map(n => noticesRepo.insert(n)));
  return created.length;
}

// =====================================================================
// SIJAINTISÄÄNNÖT
// =====================================================================
//
// SÄÄNTÖ EI OLE TOTEUTUS. Geoaitaa ei ole eikä sitä voi luvata ilman
// laitehyväksyntää. Sääntö on dataa, jota voidaan mallintaa ja testata
// simuloiduilla sijainneilla — ja kytkeä myöhemmin oikeaan sovittimeen.

/** Luo sijaintisääntö. Oletuksena POIS PÄÄLTÄ. */
export async function createLocationRule(input = {}) {
  const rule = normalizeLocationRule({ ...input, id: newTaskId() });

  if (!rule.place) {
    return { ok: false, errors: { place: 'Paikan nimi puuttuu.' } };
  }
  if (rule.taskId && !findTask(rule.taskId)) {
    return { ok: false, errors: { taskId: 'Tehtävää ei löytynyt.' } };
  }

  addLocationRuleToState(rule);

  const result = await locationRulesRepo.insert(rule);
  if (!result.ok) {
    removeLocationRuleFromState(rule.id);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, rule };
}

/** Muokkaa sijaintisääntöä. */
export async function editLocationRule(id, changes = {}) {
  const previous = findLocationRule(id);
  if (!previous) return { ok: false };

  const updated = normalizeLocationRule({ ...previous, ...changes, id });
  if (!updated.place) {
    return { ok: false, errors: { place: 'Paikan nimi puuttuu.' } };
  }

  replaceLocationRuleInState(id, updated);

  const result = await locationRulesRepo.update(updated);
  if (!result.ok) {
    replaceLocationRuleInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, rule: updated };
}

/**
 * Kytke sääntö päälle tai pois.
 *
 * PÄÄLLE KYTKEMINEN KYSYY VAHVISTUKSEN. Sijainti on eri asia kuin
 * muu tieto: se kertoo missä ihminen asuu, työskentelee ja käy.
 * Lupaa ei oleteta, ja kytkin on se hetki jossa käyttäjä sen antaa.
 *
 * Pois kytkeminen ei kysy mitään — turvallisempaan suuntaan
 * siirtyminen ei tarvitse kitkaa.
 */
export async function toggleLocationRule(id, active) {
  const previous = findLocationRule(id);
  if (!previous) return { ok: false };

  if (active && !previous.active) {
    const confirmed = await confirmAction({
      title: 'Kytketäänkö sijaintisääntö päälle?',
      message: 'Sääntö tarvitsee tiedon siitä, missä olet. Sijaintiasi '
        + 'ei tallenneta, ei viedä mukaan viennissä eikä lähetetä '
        + 'mihinkään.',
      confirmLabel: 'Kytke päälle'
    });
    if (!confirmed) return { ok: false };
  }

  return editLocationRule(id, { active: Boolean(active) });
}

/** Poista sijaintisääntö. */
export async function deleteLocationRule(id) {
  const rule = findLocationRule(id);
  if (!rule) return false;

  const confirmed = await confirmDelete(rule.place);
  if (!confirmed) return false;

  removeLocationRuleFromState(id);

  const result = await locationRulesRepo.remove(id);
  if (!result.ok) {
    addLocationRuleToState(rule);
    showError(result.error);
    return false;
  }
  success('Sijaintisääntö poistettu.');
  return true;
}
