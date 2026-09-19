// AI-komentojen suoritustoiminnot: intentti -> app-kerroksen funktio.
//
// EI DYNAAMISTA KUTSUA, EI EVALIA, EI MALLIN NIMEÄMÄÄ FUNKTIOTA.
// Jokainen rivi tässä tiedostossa on kiinteä, käsin kirjoitettu
// viittaus olemassa olevaan app/actions.js- tai app/notifications.js-
// funktioon. Malli valitsee VAIN intentin sallitusta listasta
// (src/ai/intentSchema.js `COMMANDS`) — se ei koskaan valitse eikä
// nimeä sitä, MITÄ koodia ajetaan. `executeProposal()` (aiCommands.js)
// hylkää suoraan jokaisen intentin, jolle tästä kartasta ei löydy
// funktiota.
//
// KAKSINKERTAINEN VAHVISTUS ON TARKOITUKSELLINEN. Poisto-toiminnot
// (deleteTask, deleteRoutine, deleteGoal, deleteProject) kysyvät OMAN
// vahvistuksensa (ui/confirm.js) riippumatta siitä, että käyttäjä on
// juuri hyväksynyt AI:n ehdotuksen (aiCommands.js confirmProposal).
// Kumpikin polku — käsin klikattu poisto ja AI:n ehdottama poisto —
// kulkee siis SAMAN, jo testatun vahvistusdialogin läpi. Tätä ei
// poisteta kosmetiikan vuoksi: ylimääräinen kysymys on turvallisempi
// kuin sen poistaminen olisi.
//
// TÄHÄN KARTTAAN EI TULE mark_bill_paid-KALTAISTA MITEN-TAHANSA-
// LOGIIKKAA. Jokainen käsittelijä kutsuu OLEMASSA OLEVAA, muualla
// testattua toimintoa muuttamattomana — tämä tiedosto ei sisällä omaa
// validointia eikä omaa tallennuslogiikkaa.

import {
  createTask, editTask, deleteTask,
  createRoutine, editRoutine, deleteRoutine,
  createGoal, editGoal, deleteGoal,
  createProject, editProject, deleteProject,
  createBill, editBill, setBillPaid
} from './actions.js';
import { updatePreferences } from './notifications.js';
import { switchTab } from './navigation.js';
import { setViewDate, setWeekStart } from './state.js';
import { INTENT } from '../ai/intentSchema.js';
import { applyShift } from './aiCommands.js';
import { parseISO, startOfWeek } from '../lib/datetime.js';

/**
 * Muunna { ok:boolean } -tulos muotoon jota executeProposal() odottaa.
 * Legacy-poistofunktiot (deleteTask ym.) palauttavat pelkän boolean-arvon.
 */
function fromBoolean(result, reason) {
  return result ? { ok: true } : { ok: false, reason };
}

/**
 * Muutos-komennot (update_*) kohdistuvat resolveTarget()-funktion
 * löytämään TÄSMÄLLEEN yhteen riviin — `target.id` on siis aina se
 * kohde, jonka käyttäjä juuri näki ja hyväksyi esikatselussa. Ei
 * koskaan `payload.targetId`, jota malli on saattanut ehdottaa: se
 * kulki vain resolverin SYÖTTEENÄ, ei suoritettavana tunnisteena.
 */
export const handlers = Object.freeze({
  // ------------------------------------------------------------- tehtävät

  [INTENT.CREATE_TASK]: async ({ payload }) => createTask(payload),

  [INTENT.UPDATE_TASK]: async ({ payload, target }) =>
    editTask(target.id, payload.changes),

  [INTENT.DELETE_TASK]: async ({ target }) =>
    fromBoolean(await deleteTask(target.id), 'Poisto peruttiin tai epäonnistui.'),

  [INTENT.COMPLETE_TASK]: async ({ target }) =>
    editTask(target.id, { completed: true }),

  [INTENT.UNCOMPLETE_TASK]: async ({ target }) =>
    editTask(target.id, { completed: false }),

  [INTENT.SCHEDULE_TASK]: async ({ payload, target }) =>
    editTask(target.id, payload.changes),

  [INTENT.RESCHEDULE_TASK]: async ({ payload, target, entity }) => {
    if (payload.shiftMinutes != null) {
      const shifted = applyShift(entity, payload.shiftMinutes);
      if (!shifted) {
        return { ok: false, reason: 'Tehtävällä ei ole kellonaikaa, jota siirtää.' };
      }
      return editTask(target.id, shifted);
    }
    const changes = {};
    if (payload.date) changes.date = payload.date;
    if (payload.time) changes.time = payload.time;
    return editTask(target.id, changes);
  },

  // ------------------------------------------------------------- rutiinit

  [INTENT.CREATE_ROUTINE]: async ({ payload }) => createRoutine({
    ...payload,
    // AI-komennon payload on LITTEÄ (recurrence merkkijonona, weekdays
    // omana kenttänään) -- src/domain/routine.js normalizeRoutine() ja
    // käsin täytetty lomake (views/routines.js readForm()) käyttävät
    // SISÄKKÄISTÄ muotoa. Ilman tätä muunnosta toistotyyppi ja
    // viikonpäivät katoaisivat hiljaa ja rutiini tallentuisi päivittäisenä.
    recurrence: { type: payload.recurrence, weekdays: payload.weekdays }
  }),

  [INTENT.UPDATE_ROUTINE]: async ({ payload, target }) => {
    const changes = { ...payload.changes };
    if (changes.recurrence !== undefined || changes.weekdays !== undefined) {
      // Osittainen muutos ("vaihda maanantaiksi" ilman toistotyyppiä)
      // täydennetään TUOREESTA kohteesta (target.entity, ks. aiCommands.js
      // refreshTarget) -- ei ehdotushetken jäädytetystä kopiosta.
      const current = (target.entity && target.entity.recurrence) || {};
      changes.recurrence = {
        type: changes.recurrence !== undefined ? changes.recurrence : current.type,
        weekdays: changes.weekdays !== undefined ? changes.weekdays : current.weekdays
      };
      delete changes.weekdays;
    }
    return editRoutine(target.id, changes);
  },

  [INTENT.DELETE_ROUTINE]: async ({ target }) =>
    fromBoolean(await deleteRoutine(target.id), 'Poisto peruttiin tai epäonnistui.'),

  // ----------------------------------------------------------- tavoitteet

  [INTENT.CREATE_GOAL]: async ({ payload }) => createGoal(payload),

  [INTENT.UPDATE_GOAL]: async ({ payload, target }) =>
    editGoal(target.id, payload.changes),

  [INTENT.DELETE_GOAL]: async ({ target }) =>
    fromBoolean(await deleteGoal(target.id), 'Poisto peruttiin tai epäonnistui.'),

  // ------------------------------------------------------------ projektit

  [INTENT.CREATE_PROJECT]: async ({ payload }) => createProject(payload),

  [INTENT.UPDATE_PROJECT]: async ({ payload, target }) =>
    editProject(target.id, payload.changes),

  [INTENT.DELETE_PROJECT]: async ({ target }) =>
    fromBoolean(await deleteProject(target.id), 'Poisto peruttiin tai epäonnistui.'),

  // --------------------------------------------------------------- talous

  [INTENT.CREATE_BILL]: async ({ payload }) => createBill(payload),

  [INTENT.UPDATE_BILL]: async ({ payload, target }) =>
    editBill(target.id, payload.changes),

  [INTENT.MARK_BILL_PAID]: async ({ payload, target }) =>
    setBillPaid(target.id, true, payload.paidDate),

  // ------------------------------------------------------------ asetukset

  [INTENT.SET_NOTIFICATION_PREFERENCE]: async ({ payload }) =>
    updatePreferences(payload.changes),

  // ------------------------------------------------------------ vain luku

  [INTENT.SHOW_DAY_PLAN]: async ({ payload }) => {
    setViewDate(parseISO(payload.date));
    switchTab('screen-today');
    return { ok: true };
  },

  [INTENT.SHOW_WEEK_PLAN]: async ({ payload }) => {
    setWeekStart(startOfWeek(parseISO(payload.date)));
    switchTab('screen-week');
    return { ok: true };
  }
});
