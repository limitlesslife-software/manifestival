// Ilmoituskeskuksen "Avaa"/"Tarkista": arjen huomautukset vievät oikeaan
// paikkaan (src/app/views/notices.js openTarget).
//
//   calendar_event -> Kalenteri (screen-week), päivänäkymä esiintymän päivälle
//   settings       -> Profiili, osio daily | places | wellbeing (tuntematon -> daily)
//
// Siirtymä on navigointi, ei toimenpide: mitään ei muuteta.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resetState, getState, setCalendarEvents, setProfileSegment } from '../src/app/state.js';
import { openTarget, calendarDateOf } from '../src/app/views/notices.js';
import { normalizeNotice, NOTICE_KIND } from '../src/domain/notificationCenter.js';

/** Minimi-DOM: ei elementtejä, jolloin navigointi päivittää vain tilan. */
function installDocument() {
  globalThis.document = { getElementById: () => null, querySelectorAll: () => [], activeElement: null };
}

beforeEach(() => {
  resetState();
  installDocument();
});

afterEach(() => {
  delete globalThis.document;
  resetState();
});

function notice(fields) {
  return normalizeNotice({ id: 'n1', title: 'Huomautus', reason: 'Syy', createdDate: '2026-09-29', ...fields });
}

test('menon lähtöhuomautus avaa Kalenterin esiintymän päivälle', () => {
  setCalendarEvents([{ id: 'e1', title: 'Treeni', date: '2026-09-01', startTime: '18:00', recurrenceWeekdays: [2, 4] }]);
  openTarget(notice({
    kind: NOTICE_KIND.LEAVE_NOW, key: 'departure|event:e1:2026-10-01|2026-10-01|due',
    targetType: 'calendar_event', targetId: 'e1', createdDate: '2026-10-01'
  }));
  const state = getState();
  assert.equal(state.screen, 'screen-week');
  assert.equal(state.calendarView, 'day');
  assert.equal(state.calendarDate, '2026-10-01');
});

test('lähtöajan muutoshuomautus (eri avainmuoto) löytää saman päivän', () => {
  const date = calendarDateOf(notice({
    kind: NOTICE_KIND.LEAVE_NOW, key: 'departure-change|event:e1:2026-10-02|17:10',
    targetType: 'calendar_event', targetId: 'e1'
  }));
  assert.equal(date, '2026-10-02');
});

test('avaimeton menohuomautus: kertaluonteisen menon päivä, toistuvalle luontipäivä', () => {
  setCalendarEvents([
    { id: 'once', title: 'Parturi', date: '2026-10-05', startTime: '16:00' },
    { id: 'weekly', title: 'Treeni', date: '2026-09-01', startTime: '18:00', recurrenceWeekdays: [2] }
  ]);
  assert.equal(calendarDateOf(notice({ targetType: 'calendar_event', targetId: 'once' })), '2026-10-05');
  assert.equal(calendarDateOf(notice({ targetType: 'calendar_event', targetId: 'weekly' })), '2026-09-29');
  assert.equal(calendarDateOf(notice({ targetType: 'calendar_event', targetId: 'poistettu' })), '2026-09-29');
});

for (const [targetId, expected] of [['daily', 'daily'], ['places', 'places'], ['wellbeing', 'wellbeing'],
  ['settings', 'daily'], ['tuntematon', 'daily'], [null, 'daily']]) {
  test(`asetushuomautus (${targetId}) avaa Profiilin osion ${expected}`, () => {
    setProfileSegment('settings');
    openTarget(notice({
      kind: NOTICE_KIND.REPLAN, key: `rhythm|2026-09-26|${targetId}`, targetType: 'settings', targetId
    }));
    const state = getState();
    assert.equal(state.screen, 'screen-profile');
    assert.equal(state.profileSegment, expected);
    assert.equal(state.pendingReplan ?? null, null, 'arjen ehdotus ei rakenna tehtävien siirtoehdotusta');
  });
}

test('vanhat kohteet toimivat ennallaan (tehtävä, matka)', () => {
  openTarget(notice({ kind: NOTICE_KIND.REMINDER, key: 'task|t1', targetType: 'task', targetId: 't1' }));
  assert.equal(getState().screen, 'screen-tasks');
  assert.equal(getState().tasksSegment, 'tasks');
  openTarget(notice({ kind: NOTICE_KIND.REMINDER, key: 'travel|x', targetType: 'travel', targetId: 'x' }));
  assert.equal(getState().tasksSegment, 'travel');
});
