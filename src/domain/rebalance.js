// Ensi viikon tasapainotus: esikatselu ENNEN kuin mitään muutetaan.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// previewAdjustments() soveltaa valitut ehdotukset KOPIOIHIN
// syötteistä ja laskee ensi viikon analyysin ennen ja jälkeen:
//
//   Nyt:     suunniteltu 31 h, kapasiteetti 24 h
//   Jälkeen: suunniteltu 23 h, kapasiteetti 24 h
//   + alueiden jakauma ennen/jälkeen
//
// Mitään ei kirjoiteta. Käyttäjä vahvistaa valitun ryhmän, ja vasta
// silloin sovelluskerros (src/app/alignment.js) tekee muutokset yksi
// kerrallaan. Esikatselu kertoo myös REHELLISESTI, mitä muutos EI tee:
// tavoitteen keskeytys ei poista sen jo päivättyjä tehtäviä.

import { analyzeWeek } from './alignment.js';
import { ADJUSTMENT } from './alignmentReview.js';
import { addDaysIso } from './fiTemporal.js';
import { formatMinutes, countOf } from './lifeArea.js';

function summaryRow(analysis) {
  return {
    plannedMinutes: analysis.planned.knownMinutes,
    unknownCount: analysis.planned.unknownCount,
    capacityMinutes: analysis.capacity.availableMinutes,
    remainingMinutes: analysis.capacity.remainingMinutes,
    heavyMinutes: analysis.energy ? analysis.energy.heavyMinutes : null,
    signals: analysis.signals.filter(signal => signal.severity !== 'info').length,
    areas: analysis.areas.filter(area => area.active).map(area => ({
      id: area.id, name: area.name, targetMinutes: area.targetMinutes,
      plannedMinutes: area.plannedMinutes, plannedPercent: area.plannedPercent,
      desiredPercent: area.desiredPercent
    }))
  };
}

/**
 * Esikatsele valittujen ehdotusten vaikutus ensi viikkoon.
 *
 * @param {object} args
 * @param {object} args.inputs     analyzeWeek()-syötteet ENSI viikolle
 *                                 (weekStart, areas, goals, projects, tasks,
 *                                 routines, exceptions, timeEntries, capacity,
 *                                 itemSettings, todayIso)
 * @param {Array}  args.proposals  valitut ehdotukset
 * @param {object} [args.overrides] { [proposalId]: { to?, availableMinutes? } }
 * @returns {{before: object, after: object, effects: Array<{id, text}>, writes: number}}
 */
export function previewAdjustments({ inputs, proposals = [], overrides = {} }) {
  const before = analyzeWeek(inputs);
  let tasks = [...(inputs.tasks || [])];
  let areas = [...(inputs.areas || [])];
  let goals = [...(inputs.goals || [])];
  let capacity = inputs.capacity ? { ...inputs.capacity } : null;
  const effects = [];
  let writes = 0;

  for (const proposal of proposals) {
    const payload = { ...proposal.payload, ...(overrides[proposal.id] || {}) };
    switch (proposal.type) {
      case ADJUSTMENT.SET_CAPACITY:
        capacity = {
          ...(capacity || { id: 'preview-capacity', energyLevel: null, energyBudgetMinutes: null }),
          weekStart: before.weekStart, availableMinutes: payload.availableMinutes
        };
        effects.push({ id: proposal.id, text: `Kapasiteetiksi ${formatMinutes(payload.availableMinutes)}.` });
        writes += 1;
        break;
      case ADJUSTMENT.POSTPONE_TASKS: {
        const ids = new Set(payload.taskIds || []);
        const days = Number.isInteger(payload.days) ? payload.days : 7;
        let moved = 0;
        tasks = tasks.map(task => {
          if (!ids.has(task.id) || task.completed || !task.date) return task;
          moved += 1;
          return { ...task, date: addDaysIso(task.date, days) };
        });
        effects.push({ id: proposal.id, text: `${countOf(moved, 'tehtävä siirtyy', 'tehtävää siirtyy')} viikolla eteenpäin.` });
        writes += moved;
        break;
      }
      case ADJUSTMENT.CREATE_TASK:
        tasks = [...tasks, {
          id: `preview:${proposal.id}`, title: payload.title, date: payload.date,
          durationMinutes: payload.durationMinutes, goalId: payload.goalId || null,
          category: payload.category || 'muu', completed: false
        }];
        effects.push({ id: proposal.id, text: `Uusi ${formatMinutes(payload.durationMinutes)} varaus ensi viikolle.` });
        writes += 1;
        break;
      case ADJUSTMENT.CHANGE_TARGET:
        areas = areas.map(area => (area.id === payload.areaId ? { ...area, targetMinutesPerWeek: payload.to } : area));
        effects.push({ id: proposal.id, text: `Alueen tavoitteeksi ${formatMinutes(payload.to)} viikossa (nyt ${formatMinutes(payload.from)}).` });
        writes += 1;
        break;
      case ADJUSTMENT.PAUSE_GOAL:
        goals = goals.map(goal => (goal.id === payload.goalId ? { ...goal, status: 'paused' } : goal));
        effects.push({ id: proposal.id,
          text: 'Tavoite keskeytetään. Sen jo päivätyt tehtävät pysyvät suunnitelmassa; siirrä niitä erikseen, jos haluat.' });
        writes += 1;
        break;
      case ADJUSTMENT.REQUEST_ESTIMATES:
        effects.push({ id: proposal.id, text: 'Avaa arvioinnin. Ei muuta mitään itsestään.' });
        break;
      default:
        break;
    }
  }

  const after = analyzeWeek({ ...inputs, tasks, areas, goals, capacity });
  return { before: summaryRow(before), after: summaryRow(after), effects, writes };
}
