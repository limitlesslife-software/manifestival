// Arjen asetukset: yksi rivi käyttäjää kohti, monta lomaketta kirjoittaa sitä.
//
// TAUSTA 1. saveLifeSettings lähetti koko rivin (19 saraketta) laitteen
// välimuistista. Vanhentunut laite (esim. auki jäänyt työpöytäselain)
// kumosi hiljaa toisella laitteella tehdyt muutokset: ohjaustyylin vaihto
// kirjoitti herätyksen takaisin pois päältä.
//
// TAUSTA 2. Epäonnistunut tallennus palautti koko rivin tilannekuvaan,
// joka oli otettu ennen omaa odotusta. Rinnakkain valmistunut toinen
// tallennus (eri lomake) katosi tilasta, vaikka se oli kannassa.
//
// Korjaus: tallennus lähettää vain muuttuneet kentät (repositorion update
// changedFrom), ja peruutus palauttaa vain omat kenttänsä -- ja vain, jos
// uudempi tallennus ei ole ehtinyt muuttaa niitä.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { resetState, getState, setLifeSettings } from '../src/app/state.js';
import { clearAllCollections, lifeSettingsRepo, changedColumns } from '../src/data/collectionsRepo.js';
import { saveLifeSettings, resetDailyLifeActions } from '../src/app/dailyLifeActions.js';
import { normalizeLifeSettings, mergeLifeSettings } from '../src/domain/lifeSettings.js';
import { readCode } from './helpers/sources.mjs';

const USER_A = { id: 'aaaaaaaa-6666-0000-0000-00000000000a', email: 'a@example.com' };
const S0 = normalizeLifeSettings({ id: 'ls1', alarm: { enabled: false, weekdayTime: '07:00' }, morningBriefEnabled: false });

beforeEach(async () => {
  clearUser();
  clearAllCollections();
  resetState();
  resetDailyLifeActions();
  setUser(USER_A);
  await lifeSettingsRepo.insert(S0);
  setLifeSettings([S0]);
});

const stored = async () => (await lifeSettingsRepo.memory.get('ls1')).value;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('KRIITTINEN: vanhentunut laite ei kumoa toisen laitteen herätystä vaihtaessaan ohjaustyyliä', async () => {
  // Puhelin kytki herätyksen päälle klo 6.00 (kannassa); tämä laite näkee yhä vanhan rivin.
  await lifeSettingsRepo.memory.update({ ...S0, alarm: { ...S0.alarm, enabled: true, weekdayTime: '06:00' } });

  const result = await saveLifeSettings({ guidanceStyle: 'napakka' });
  assert.equal(result.ok, true);
  const row = await stored();
  assert.equal(row.guidanceStyle, 'napakka');
  assert.deepEqual([row.alarm.enabled, row.alarm.weekdayTime], [true, '06:00'], 'toisen laitteen herätys kumoutui');
});

test('KRIITTINEN: kannan päivitys sisältää vain muuttuneet sarakkeet', () => {
  const toRow = lifeSettingsRepo.mapping.toRow;
  const next = mergeLifeSettings(S0, { guidanceStyle: 'napakka' });
  assert.deepEqual(changedColumns(toRow(S0), toRow(next)), { guidance_style: 'napakka' });

  const alarm = mergeLifeSettings(S0, { alarm: { enabled: true } });
  const patch = changedColumns(toRow(S0), toRow(alarm));
  assert.deepEqual(Object.keys(patch), ['alarm'], 'jsonb-sarake kulkee kokonaisena, muut eivät');
  assert.equal(patch.alarm.weekdayTime, '07:00', 'herätyksen muut kentät säilyvät sarakkeen sisällä');
  assert.deepEqual(changedColumns(toRow(S0), toRow(S0)), {}, 'muuttumaton rivi ei lähetä mitään');

  // Kantapolku rakentaa päivityksen muuttuneista sarakkeista (portit ovat
  // tällä haaralla kiinni, joten polkua ei voi ajaa).
  const code = readCode('src/data/collectionsRepo.js');
  const update = code.slice(code.indexOf('async update('), code.indexOf('/** Poisto;'));
  assert.match(update, /changedFrom \? changedColumns\(toRow\(normalize\(changedFrom\)\), fullRow\) : fullRow/);
  assert.match(update, /\.update\(stripLoweredColumns\(table, assertClientSafe\(row\)\)\)/);
});

test('KRIITTINEN: epäonnistunut tallennus ei pyyhi rinnakkain onnistunutta', async () => {
  const original = lifeSettingsRepo.update;
  let calls = 0;
  lifeSettingsRepo.update = async (...args) => {
    calls += 1;
    if (calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 30));
      return { ok: false, error: { message: 'verkko', userMessage: 'Yhteys katkesi.' } };
    }
    return original(...args);
  };
  try {
    const brief = saveLifeSettings({ morningBriefEnabled: true });
    await tick();
    const alarm = saveLifeSettings({ alarm: { enabled: true, weekdayTime: '05:45' } });
    const [a, b] = await Promise.all([brief, alarm]);
    assert.equal(a.ok, false);
    assert.equal(b.ok, true);
  } finally {
    lifeSettingsRepo.update = original;
  }

  const state = getState().lifeSettings[0];
  assert.deepEqual([state.alarm.enabled, state.alarm.weekdayTime], [true, '05:45'], 'onnistunut herätys katosi tilasta');
  assert.equal(state.morningBriefEnabled, false, 'epäonnistunut muutos jäi näkyviin');
  const row = await stored();
  assert.deepEqual([row.alarm.enabled, row.alarm.weekdayTime, row.morningBriefEnabled], [true, '05:45', false],
    'tila ja tallennettu rivi eivät saa erota');
});

test('peruutus ei kumoa samaan kenttään myöhemmin tehtyä muutosta', async () => {
  const original = lifeSettingsRepo.update;
  let calls = 0;
  lifeSettingsRepo.update = async (...args) => {
    calls += 1;
    if (calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 30));
      return { ok: false, error: { message: 'verkko' } };
    }
    return original(...args);
  };
  try {
    const first = saveLifeSettings({ windDownMinutes: 20 });
    await tick();
    const second = saveLifeSettings({ windDownMinutes: 50 });
    await Promise.all([first, second]);
  } finally {
    lifeSettingsRepo.update = original;
  }
  assert.equal(getState().lifeSettings[0].windDownMinutes, 50);
  assert.equal((await stored()).windDownMinutes, 50);
});

test('ensimmäinen tallennus luo rivin; epäonnistunut luonti poistaa sen tilasta', async () => {
  clearAllCollections();
  setLifeSettings([]);
  const original = lifeSettingsRepo.insert;
  lifeSettingsRepo.insert = async () => ({ ok: false, error: { message: 'verkko' } });
  try {
    assert.equal((await saveLifeSettings({ windDownMinutes: 15 })).ok, false);
  } finally {
    lifeSettingsRepo.insert = original;
  }
  assert.deepEqual(getState().lifeSettings, []);
  const created = await saveLifeSettings({ windDownMinutes: 15 });
  assert.equal(created.ok, true);
  assert.equal((await lifeSettingsRepo.memory.list()).value.length, 1);
});
