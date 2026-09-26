// Suunta oikeassa (jäsennetyssä) index.html-DOMissa saavutettavuustesteille.
//
// Sama kytkentä kuin tools/e2e/harness.mjs:ssä: Suunta-näkymä auki,
// initDirection + initTimeLog, ja jokainen tilamuutos piirtää ajastin-
// palkin, päivän kortin ja Suunnan (kuten main.js:n renderAll).

import { read } from './sources.mjs';
import { createDocument, installDocument } from './a11yDom.mjs';
import { setUser, clearUser } from '../../src/data/session.js';
import { setClient } from '../../src/data/client.js';
import { resetState, subscribe } from '../../src/app/state.js';
import { clearLocalUserData } from '../../src/app/actions.js';
import { resetAppliedAdjustments, setTimeEntryWriterForTests } from '../../src/app/alignment.js';
import { setTimerRepoForTests, currentTimer, cancelTracking } from '../../src/app/timeTracking.js';
import { resetTimerStoreForTests } from '../../src/data/timerStore.js';
import {
  renderDirection, renderTodayDirection, initDirection, resetDirectionView
} from '../../src/app/views/direction.js';
import {
  renderTimerBar, initTimeLog, closeTimeLogDialog, stopTimeLogTicker
} from '../../src/app/views/timeLog.js';
import { closeConfirmDialogs } from '../../src/ui/confirm.js';

export const INDEX_HTML = read('index.html');
export const USER = { id: 'a11a11a1-1111-4111-8111-00000000a11a', email: 'a11y@example.invalid' };

/**
 * Supabase-korvike, joka kuittaa kirjoitukset rivinä (päivitys ei ole
 * "nolla riviä") ja palauttaa haulle tyhjän listan. `hold` = lupaus, jota
 * kirjoitukset odottavat (tallennus kesken -tila).
 */
export function echoClient({ hold = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const start = (operation, payload) => {
        const entry = { table, operation, payload, filters: [], single: false };
        calls.push(entry);
        const rows = () => {
          if (operation === 'select') return [];
          const base = Object.fromEntries(entry.filters);
          if (operation === 'delete') return [base];
          return (Array.isArray(payload) ? payload : [payload]).map(row => ({ ...base, ...row }));
        };
        const chain = new Proxy({}, {
          get(_, prop) {
            if (prop === 'then') {
              return (resolve, reject) => Promise.resolve(operation === 'select' ? null : hold)
                .then(() => {
                  const data = rows();
                  return { data: entry.single ? data[0] ?? null : data, error: null, count: data.length };
                })
                .then(resolve, reject);
            }
            if (prop === 'eq' || prop === 'match') {
              return (column, value) => {
                if (typeof column === 'string') entry.filters.push([column, value]);
                return chain;
              };
            }
            if (prop === 'single' || prop === 'maybeSingle') return () => { entry.single = true; return chain; };
            return () => chain;
          }
        });
        return chain;
      };
      return {
        select: payload => start('select', payload),
        insert: payload => start('insert', payload),
        update: payload => start('update', payload),
        upsert: payload => start('upsert', payload),
        delete: () => start('delete', null)
      };
    }
  };
}

export const flush = async (rounds = 25) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
};

/** CSS:n piilotukset, joita DOM ei tulkitse (tarkistettu styles.css:stä testissä). */
export const CSS_HIDDEN = Object.freeze([
  '.dir-setup-active .dir-section:not(.dir-setup)',
  '.dir-setup-active #dirQuickActions',
  '.voice-overlay:not(.open)'
]);

function showScreen(doc, id) {
  for (const screen of doc.querySelectorAll('.screen')) {
    const on = screen.id === id;
    screen.classList.toggle('active', on);
    screen.toggleAttribute('inert', !on);
    screen.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
}

/**
 * Asenna Suunta. Palauttaa { doc, render, client, unmount }.
 * @param {object} [options]
 * @param {object} [options.client] Supabase-korvike (oletus echoClient())
 */
export function mountSuunta({ client = echoClient(), screen = 'screen-direction' } = {}) {
  clearUser();
  clearLocalUserData();
  resetState();
  resetAppliedAdjustments();
  resetDirectionView();
  resetTimerStoreForTests();
  setTimerRepoForTests(null);
  setTimeEntryWriterForTests(null);
  const doc = createDocument(INDEX_HTML);
  const uninstall = installDocument(doc);
  setUser(USER);
  setClient(client);
  doc.getElementById('app').classList.remove('app-hidden');
  showScreen(doc, screen);
  initDirection();
  initTimeLog();
  const render = () => {
    renderTimerBar();
    renderTodayDirection();
    renderDirection();
  };
  const unsubscribe = subscribe(render);
  render();
  return {
    doc, client, render,
    show: id => showScreen(doc, id),
    async unmount() {
      unsubscribe();
      if (currentTimer()) await cancelTracking({ confirmFn: async () => true }).catch(() => {});
      closeTimeLogDialog();
      closeConfirmDialogs();
      stopTimeLogTicker();
      await flush(5);
      resetDirectionView();
      uninstall();
    }
  };
}
