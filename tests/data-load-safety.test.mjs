// Latauksen tilaturvallisuus: transientti verkkovirhe ei saa näyttää
// jo ladattua tietoa poistettuna.
//
// TAUSTA. loadUserData() korvasi aiemmin epäonnistuneen kokoelmahaun
// tuloksena tyhjän listan olemassa olevan tilan päälle. Ensimmäisellä
// latauksella tämä ei näkynyt, koska tilassa ei ollut mitään
// menetettävää — mutta heti kun loadUserData() ajetaan uudelleen
// (esim. verkon palautuessa), hetkellinen virhe hävittäisi käyttäjän
// jo näkemän tiedon ruudulta, vaikka se olisi edelleen tallessa
// kannassa. Tämä tiedosto lukitsee korjatun käyttäytymisen.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { clearLocalUserData, loadUserData } from '../src/app/actions.js';
import { routinesRepo, goalsRepo, projectsRepo, wellbeingRepo } from '../src/data/collectionsRepo.js';
import { savePreferences } from '../src/data/notificationPrefsRepo.js';
import { resetState, getState } from '../src/app/state.js';

const USER_A = { id: 'aaaaaaaa-1111-0000-0000-000000000001', email: 'a@example.com' };

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
});

async function seed() {
  await routinesRepo.memory.insert({
    id: 'r-1', title: 'Aamulenkki', active: true,
    recurrence: { type: 'daily', weekdays: [] }
  });
  await goalsRepo.memory.insert({ id: 'g-1', title: 'Tavoite 1' });
  await projectsRepo.memory.insert({ id: 'p-1', name: 'Projekti 1' });
  await wellbeingRepo.memory.insert({ id: 'w-1', date: '2026-09-02', energy: 3 });
  await savePreferences({ enabled: true, maxPerDay: 5 });
}

test('1. onnistunut haku nollarivisenä on legitiimi tyhjä lista', async () => {
  setUser(USER_A);
  // Ei siemennystä: kaikki kokoelmat ovat oikeasti tyhjiä.
  const result = await loadUserData();

  assert.equal(result.discarded, false);
  assert.deepEqual(getState().routines, []);
  assert.equal(getState().dataLoadStatus.routines.ok, true,
    'tyhjä onnistunut haku ei saa näyttää virheeltä');
});

test('2. transientti haku-virhe säilyttää jo ladatun kokoelman', async () => {
  setUser(USER_A);
  await seed();

  // Ensimmäinen lataus onnistuu normaalisti.
  await loadUserData();
  assert.equal(getState().routines.length, 1);
  assert.equal(getState().goals.length, 1);

  // Simuloi transientti verkkovirhe VAIN rutiineille toisella
  // latauksella (esim. verkon palautuessa).
  const original = routinesRepo.list.bind(routinesRepo);
  routinesRepo.list = async () => ({ ok: false, error: new Error('verkko poikki') });

  try {
    const result = await loadUserData();
    assert.equal(result.discarded, false);
    assert.equal(getState().routines.length, 1,
      'aiemmin ladatut rutiinit katosivat transientissa virheessä');
    assert.equal(getState().dataLoadStatus.routines.ok, false);
  } finally {
    routinesRepo.list = original;
  }
});

test('3. ensimmäisen latauksen virhe ei keksi rivejä', async () => {
  setUser(USER_A);

  const original = goalsRepo.list.bind(goalsRepo);
  goalsRepo.list = async () => ({ ok: false, error: new Error('verkko poikki') });

  try {
    const result = await loadUserData();
    assert.equal(result.discarded, false);
    assert.deepEqual(getState().goals, [],
      'ensimmäisen latauksen virhe ei saa tuottaa rivejä tyhjästä');
    assert.equal(getState().dataLoadStatus.goals.ok, false);
  } finally {
    goalsRepo.list = original;
  }
});

test('4. yhden kokoelman virhe ei pyyhi toista onnistunutta kokoelmaa', async () => {
  setUser(USER_A);
  await seed();

  const original = wellbeingRepo.list.bind(wellbeingRepo);
  wellbeingRepo.list = async () => ({ ok: false, error: new Error('verkko poikki') });

  try {
    const result = await loadUserData();
    assert.equal(result.discarded, false);
    assert.equal(getState().routines.length, 1, 'rutiinit latautuivat onnistuneesti');
    assert.equal(getState().goals.length, 1, 'tavoitteet latautuivat onnistuneesti');
    assert.equal(getState().dataLoadStatus.wellbeing.ok, false);
    assert.equal(getState().dataLoadStatus.routines.ok, true);
  } finally {
    wellbeingRepo.list = original;
  }
});

test('5. uloskirjautuminen tyhjentää tilan', async () => {
  setUser(USER_A);
  await seed();
  await loadUserData();
  assert.equal(getState().routines.length, 1);

  clearUser();
  resetState();

  assert.deepEqual(getState().routines, []);
  assert.deepEqual(getState().dataLoadStatus, {});
});

test('6. tilinvaihto ei voi vuotaa edellisen käyttäjän dataa', async () => {
  setUser(USER_A);
  await seed();
  await loadUserData();
  assert.equal(getState().routines.length, 1);

  // Tilinvaihto kulkee aina onSignedOut/resetState-polun kautta ennen
  // seuraavaa loadUserData-kutsua (ks. auth-lifecycle.test.mjs); tässä
  // varmistetaan, että resetState() todella katkaisee näkyvyyden.
  clearUser();
  clearLocalUserData();
  resetState();

  const USER_B = { id: 'bbbbbbbb-2222-0000-0000-000000000002', email: 'b@example.com' };
  setUser(USER_B);
  const result = await loadUserData();

  assert.equal(result.discarded, false);
  assert.deepEqual(getState().routines, [], 'B näki A:n rutiinit tilinvaihdon jälkeen');
});

test('7. onnistunut uudelleenlataus korvaa vanhentuneen tilan uudella', async () => {
  setUser(USER_A);
  await seed();
  await loadUserData();
  assert.equal(getState().routines.length, 1);

  const original = routinesRepo.list.bind(routinesRepo);
  routinesRepo.list = async () => ({ ok: false, error: new Error('verkko poikki') });
  await loadUserData();
  assert.equal(getState().routines.length, 1, 'vanha tila säilyy virheen ajan');
  assert.equal(getState().dataLoadStatus.routines.ok, false);

  routinesRepo.list = original;
  await routinesRepo.memory.insert({
    id: 'r-2', title: 'Uusi rutiini', active: true,
    recurrence: { type: 'daily', weekdays: [] }
  });

  const result = await loadUserData();
  assert.equal(result.discarded, false);
  assert.equal(getState().routines.length, 2, 'onnistunut uusintahaku ei korvannut vanhentunutta tilaa');
  assert.equal(getState().dataLoadStatus.routines.ok, true);
});

test('epäonnistunut kokoelma näyttää yhden kootun ilmoituksen, ei tusinaa toastia', async () => {
  setUser(USER_A);
  await seed();
  await loadUserData();

  const original = wellbeingRepo.list.bind(wellbeingRepo);
  wellbeingRepo.list = async () => ({ ok: false, error: new Error('verkko poikki') });

  try {
    const result = await loadUserData();
    // Ei kaadu, ei hylkää vastausta -- vain kirjaa epäonnistumisen.
    assert.equal(result.discarded, false);
    assert.equal(getState().dataLoadStatus.wellbeing.ok, false);
  } finally {
    wellbeingRepo.list = original;
  }
});
