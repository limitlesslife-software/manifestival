// Ilmoituskeskuksen Kuittaa / Torkuta 15 min / Hoidettu kohdistuvat
// MUISTUTUKSEEN, eivät sen kohteeseen.
//
// Löydös (bugijahti 2026-09-27): merkinnän targetId on muistutuksen kohde
// (tehtävä). Näkymä välitti sen muistutustoiminnoille, jotka hakevat
// muistutusta sen omalla tunnisteella -> mitään ei löytynyt, kuittaus
// "onnistui" tekemättä mitään ja seuraava porras tuli silti. Nyt muistutus
// tunnistetaan merkinnän avaimesta (reminder.occurrenceKey), ja merkintä
// jää auki, jos muistutuksen muutos epäonnistuu.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser } from '../src/data/session.js';
import { clearAllCollections, remindersRepo, noticesRepo } from '../src/data/collectionsRepo.js';
import { resetState, getState, setReminders, setNotices } from '../src/app/state.js';
import { runReminderAction } from '../src/app/views/notices.js';
import {
  normalizeNotice, NOTICE_KIND, NOTICE_ACTION, NOTICE_STATUS, actionsFor, reminderIdOfNotice
} from '../src/domain/notificationCenter.js';
import { normalizeReminder, REMINDER_STATUS } from '../src/domain/reminder.js';

const USER = { id: 'b0a0b0a0-1111-4111-8111-00000000b0a0', email: 'kuittaus@example.invalid' };

async function seed({ reminderStatus = REMINDER_STATUS.DELIVERED, key = null } = {}) {
  resetState();
  clearAllCollections();
  setUser(USER);
  const reminder = normalizeReminder({
    id: 'r1', title: 'Soita neuvolaan', targetType: 'task', targetId: 't1',
    dueDate: '2026-09-27', dueTime: '23:00', status: reminderStatus
  });
  await remindersRepo.insert(reminder);
  setReminders([reminder]);
  const notice = normalizeNotice({
    id: 'n1', key: key || 'r1|gentle|2026-09-27|1380', kind: NOTICE_KIND.REMINDER,
    title: 'Soita neuvolaan', reason: 'Muistutus', targetType: 'task', targetId: 't1', createdDate: '2026-09-27'
  });
  await noticesRepo.insert(notice);
  setNotices([notice]);
  return { reminder, notice };
}

const reminderStatus = () => getState().reminders.find(item => item.id === 'r1').status;
const noticeStatus = () => getState().notices.find(item => item.id === 'n1').status;

beforeEach(() => { resetState(); clearAllCollections(); });

test('muistutuksen tunniste tulee avaimesta, ei kohteesta; tuntematon avain ei osu', () => {
  const reminders = [{ id: 'r1' }];
  const base = { kind: NOTICE_KIND.REMINDER, targetType: 'task', targetId: 't1' };
  assert.equal(reminderIdOfNotice({ ...base, key: 'r1|gentle|2026-09-27|1380' }, reminders), 'r1');
  assert.equal(reminderIdOfNotice({ ...base, key: 't1|gentle|2026-09-27|1380' }, reminders), null);
  assert.equal(reminderIdOfNotice({ ...base, kind: NOTICE_KIND.LEAVE_NOW, key: 'r1|x' }, reminders), null);
  assert.equal(reminderIdOfNotice({ ...base, key: 'evening|2026-09-28|22:00' }, reminders), null);
});

test('ilman muistutusta ei tarjota Torkuta- eikä Hoidettu-painiketta', () => {
  const notice = { kind: NOTICE_KIND.REMINDER, status: NOTICE_STATUS.UNREAD };
  assert.deepEqual(actionsFor(notice, { hasReminder: false }),
    [NOTICE_ACTION.OPEN, NOTICE_ACTION.ACKNOWLEDGE, NOTICE_ACTION.DISMISS]);
  assert.ok(actionsFor(notice, { hasReminder: true }).includes(NOTICE_ACTION.SNOOZE));
  // Vanha kutsu ilman valintaa pysyy ennallaan.
  assert.deepEqual(actionsFor(notice), actionsFor(notice, { hasReminder: true }));
});

test('KRIITTINEN: Kuittaa kuittaa muistutuksen (seuraava porras ei tule) ja merkinnän', async () => {
  await seed();
  const result = await runReminderAction(NOTICE_ACTION.ACKNOWLEDGE, getState().notices[0]);
  assert.deepEqual(result, { ok: true, reminderId: 'r1' });
  assert.equal(reminderStatus(), REMINDER_STATUS.ACKNOWLEDGED);
  assert.equal(noticeStatus(), NOTICE_STATUS.ACTED);
});

test('Hoidettu merkitsee muistutuksen hoidetuksi', async () => {
  await seed();
  const result = await runReminderAction(NOTICE_ACTION.COMPLETE, getState().notices[0]);
  assert.equal(result.ok, true);
  assert.equal(reminderStatus(), REMINDER_STATUS.COMPLETED);
  assert.equal(noticeStatus(), NOTICE_STATUS.ACTED);
});

test('epäonnistunut muistutuksen muutos jättää merkinnän auki', async () => {
  // Jo hoidettua muistutusta ei voi kuitata: siirtymä hylätään.
  await seed({ reminderStatus: REMINDER_STATUS.COMPLETED });
  const result = await runReminderAction(NOTICE_ACTION.ACKNOWLEDGE, getState().notices[0]);
  assert.equal(result.ok, false);
  assert.equal(noticeStatus(), NOTICE_STATUS.UNREAD);
});

test('merkintä ilman muistutusta (esim. illan ennakko): Kuittaa kuittaa vain merkinnän', async () => {
  await seed({ key: 'evening|2026-09-28|22:00' });
  const result = await runReminderAction(NOTICE_ACTION.ACKNOWLEDGE, getState().notices[0]);
  assert.deepEqual(result, { ok: true, reminderId: null });
  assert.equal(noticeStatus(), NOTICE_STATUS.ACTED);
  assert.equal(reminderStatus(), REMINDER_STATUS.DELIVERED, 'muistutukseen ei kosketa');
  const snooze = await runReminderAction(NOTICE_ACTION.SNOOZE, getState().notices[0]);
  assert.equal(snooze.ok, false);
});
