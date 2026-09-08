// Projektien käyttöliittymä ja toiminnot.
//
// MITÄ TÄMÄ VARTIOI
//
// Projekteilla oli kanta, RLS, repositorio ja koko domain-logiikka —
// mutta ei yhtään näkymää. Rivit ladattiin tilaan eikä niitä
// renderöity missään, eikä käyttäjä voinut luoda projektia.
//
// Nämä testit lukitsevat sen, että käyttöliittymä on olemassa, että se
// kulkee samaa polkua kuin tavoitteet (optimistinen tila + peruutus),
// ja että epäonnistunut tallennus EI jätä riviä näkyviin.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { fakeClient, isGateOpen } from './helpers/gates.mjs';
import { setClient } from '../src/data/client.js';
import { setUser, clearUser } from '../src/data/session.js';
import { projectsRepo, clearAllCollections } from '../src/data/collectionsRepo.js';
import {
  getState, resetState, setProjects, setGoals, setTasks,
  findProject, addProjectToState, removeProjectFromState
} from '../src/app/state.js';
import { createProject, editProject } from '../src/app/actions.js';
import { normalizeProject, PROJECT_STATUS } from '../src/domain/project.js';

const NEWLINE = String.fromCharCode(10);
const USER_A = { id: 'aaaaaaaa-0000-0000-0000-00000000000a', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-0000-0000-0000-00000000000b', email: 'b@example.com' };

/**
 * Portti ratkaisee, MIHIN kirjoitus menee -- ei sitä, toimiiko se.
 *
 * Portin ollessa kiinni repositorio kirjoittaa muistivarastoon, auki
 * ollessaan kantaan. Nämä testit koskevat toimintoja eivätkä
 * tallennuspaikkaa, joten avoimessa tilassa annetaan valeasiakas, joka
 * onnistuu. Ilman sitä testit olisivat vihreitä perustilassa ja
 * punaisia aallossa B -- eli juuri siinä aallossa jota ne koskevat.
 */
function installClientIfGateOpen() {
  if (isGateOpen('projects')) setClient(fakeClient({ data: [], error: null }));
  else setClient(null);
}

beforeEach(() => {
  resetState();
  clearAllCollections();
  clearUser();
  installClientIfGateOpen();
});

// =====================================================================
// KÄYTTÖLIITTYMÄ ON OLEMASSA JA LÖYDETTÄVISSÄ
// =====================================================================

test('KRIITTINEN: projektinäkymä on olemassa ja kytketty navigaatioon', () => {
  const html = read('index.html');

  assert.ok(html.includes('id="segmentProjects"'), 'projektisegmenttiä ei ole');
  assert.ok(html.includes('id="projectsSection"'), 'projektiosiota ei ole');
  assert.ok(html.includes('id="projectsListContainer"'), 'projektilistaa ei ole');
  assert.ok(html.includes('id="projectForm"'), 'projektilomaketta ei ole');
  assert.ok(html.includes('>Projektit<'), 'näkyvää nimeä "Projektit" ei ole');

  // Ja segmentti on tavoitenäkymän sisällä, ei irrallaan.
  const goalsScreen = html.slice(html.indexOf('id="screen-goals"'),
                                 html.indexOf('id="screen-finance"'));
  assert.ok(goalsScreen.includes('id="projectsSection"'),
    'projektiosio ei ole tavoitenäkymässä');
  assert.ok(goalsScreen.includes('id="goalsSection"'),
    'tavoiteosiota ei erotettu omakseen');
});

test('KRIITTINEN: näkymä renderöidään ja lomake kytketään käynnistyksessä', () => {
  const main = read('src/app/main.js');

  assert.ok(main.includes('renderProjects()'), 'projekteja ei renderöidä');
  assert.ok(main.includes('initProjectForm()'), 'projektilomaketta ei kytketä');
  assert.ok(main.includes('closeProjectForm()'),
    'projektilomaketta ei suljeta uloskirjautumisessa');

  // Kytkentä tehdään kerran käynnistyksessä, ei renderöinnissä.
  const view = read('src/app/views/projects.js');
  const render = view.slice(view.indexOf('export function renderProjects'),
                            view.indexOf('function syncSegment'));
  assert.equal(/addEventListener/.test(render), false,
    'renderProjects lisää kuuntelijoita — ne kertyisivät joka renderöinnissä');
});

test('KRIITTINEN: service worker esilataa projektinäkymän', () => {
  // Ilman tätä offline-käyttäjä saisi kuoren, josta puuttuu moduuli.
  assert.ok(read('sw.js').includes("'/src/app/views/projects.js'"),
    'projects.js puuttuu SHELL-listalta');
});

// =====================================================================
// CRUD
// =====================================================================

test('KRIITTINEN: projektin luonti tallentuu ja näkyy tilassa', async () => {
  setUser(USER_A);
  const result = await createProject({ name: 'Keittiöremontti' });

  assert.equal(result.ok, true, 'luonti epäonnistui');
  assert.equal(getState().projects.length, 1);
  assert.equal(getState().projects[0].name, 'Keittiöremontti');
  assert.equal(getState().projects[0].status, PROJECT_STATUS.ACTIVE);
});

test('KRIITTINEN: nimetön projekti hylätään eikä päädy tilaan', async () => {
  setUser(USER_A);
  const result = await createProject({ name: '   ' });

  assert.equal(result.ok, false);
  assert.ok(result.errors && result.errors.name, 'nimivirhettä ei raportoitu');
  assert.equal(getState().projects.length, 0, 'kelvoton projekti päätyi tilaan');
});

test('KRIITTINEN: muokkaus säilyttää tunnisteen ja päivittää kentät', async () => {
  setUser(USER_A);
  await createProject({ name: 'Alkuperäinen' });
  const id = getState().projects[0].id;

  const result = await editProject(id, { name: 'Muutettu', deadline: '2026-12-01' });

  assert.equal(result.ok, true);
  assert.equal(getState().projects.length, 1, 'muokkaus loi uuden rivin');
  assert.equal(findProject(id).name, 'Muutettu');
  assert.equal(findProject(id).deadline, '2026-12-01');
});

// =====================================================================
// EPÄONNISTUNUT TALLENNUS EI SAA JÄÄDÄ NÄKYVIIN
// =====================================================================

test('KRIITTINEN: epäonnistunut luonti perutaan tilasta', async () => {
  // TÄMÄ ON KOKO FAIL-CLOSED-SOPIMUS. Jos rivi jäisi tilaan, käyttäjä
  // näkisi projektin joka ei ole missään — ja huomaisi sen vasta
  // seuraavassa latauksessa.
  setUser(USER_A);
  const original = projectsRepo.insert;
  projectsRepo.insert = async () => ({ ok: false, error: { message: 'RLS' } });

  try {
    const result = await createProject({ name: 'Ei tallennu' });
    assert.equal(result.ok, false, 'epäonnistunut tallennus raportoitiin onnistuneena');
    assert.equal(getState().projects.length, 0,
      'peruuttamaton rivi jäi tilaan epäonnistuneen tallennuksen jälkeen');
  } finally {
    projectsRepo.insert = original;
  }
});

test('KRIITTINEN: epäonnistunut muokkaus palauttaa edellisen arvon', async () => {
  setUser(USER_A);
  await createProject({ name: 'Alkuperäinen' });
  const id = getState().projects[0].id;

  const original = projectsRepo.update;
  projectsRepo.update = async () => ({ ok: false, error: { message: 'verkko' } });

  try {
    const result = await editProject(id, { name: 'Ei tallennu' });
    assert.equal(result.ok, false);
    assert.equal(findProject(id).name, 'Alkuperäinen',
      'tila jäi näyttämään muutosta jota ei tallennettu');
  } finally {
    projectsRepo.update = original;
  }
});

// =====================================================================
// TAVOITEYHTEYS
// =====================================================================

test('KRIITTINEN: projekti voi olla itsenäinen tai liitetty tavoitteeseen', async () => {
  setUser(USER_A);
  setGoals([{ id: 'g-1', title: 'Koti kuntoon' }]);

  await createProject({ name: 'Itsenäinen' });
  await createProject({ name: 'Liitetty', goalId: 'g-1' });

  const [itsenainen, liitetty] = getState().projects;
  assert.equal(itsenainen.goalId, null, 'itsenäiselle projektille tuli tavoite');
  assert.equal(liitetty.goalId, 'g-1', 'liitos ei tallentunut');
});

test('KRIITTINEN: liitoksen purku onnistuu eikä poista kumpaakaan', async () => {
  setUser(USER_A);
  setGoals([{ id: 'g-1', title: 'Koti kuntoon' }]);
  await createProject({ name: 'Projekti', goalId: 'g-1' });
  const id = getState().projects[0].id;

  const result = await editProject(id, { goalId: null });

  assert.equal(result.ok, true);
  assert.equal(findProject(id).goalId, null, 'liitos ei purkautunut');
  assert.equal(getState().projects.length, 1, 'projekti katosi');
  assert.equal(getState().goals.length, 1, 'tavoite katosi');
});

test('KRIITTINEN: projektin poisto ei poista siihen liitettyjä tehtäviä', () => {
  // Sama sääntö kuin kannassa: `on delete set null (project_id)`.
  // Tehty työ ei katoa siksi, että sen kehys poistuu.
  setProjects([{ id: 'p-1', name: 'Projekti' }]);
  setTasks([
    { id: 't-1', title: 'Kuuluu projektiin', date: '2026-09-10', projectId: 'p-1' },
    { id: 't-2', title: 'Ei kuulu', date: '2026-09-10', projectId: null }
  ]);

  removeProjectFromState('p-1');

  assert.equal(getState().projects.length, 0, 'projekti ei poistunut');
  assert.equal(getState().tasks.length, 2, 'tehtäviä poistettiin projektin mukana');
  assert.equal(getState().tasks[0].projectId, null, 'tehtävän liitos ei katkennut');
});

test('KRIITTINEN: tavoitteen liitos projektiin katkeaa projektin poistuessa', () => {
  setGoals([{ id: 'g-1', title: 'Tavoite', projectId: 'p-1' }]);
  setProjects([{ id: 'p-1', name: 'Projekti' }]);

  removeProjectFromState('p-1');

  assert.equal(getState().goals.length, 1, 'tavoite poistui projektin mukana');
  assert.equal(getState().goals[0].projectId, null, 'tavoitteen liitos jäi orvoksi');
});

// =====================================================================
// TIETOKANTAPOLKU
// =====================================================================

test('KRIITTINEN: kirjoitus ei lähetä omistajuutta', async () => {
  // Omistajuuden asettaa kanta (`default auth.uid()`), ei selain.
  const rivi = projectsRepo.mapping.toRow(
    projectsRepo.mapping.normalize({ id: 'p-1', name: 'Projekti', goalId: 'g-1' }));

  for (const kielletty of ['user_id', 'created_at', 'updated_at']) {
    assert.equal(Object.prototype.hasOwnProperty.call(rivi, kielletty), false,
      `projektikirjoitus lähettää kentän ${kielletty}`);
  }
  assert.equal(rivi.goal_id, 'g-1', 'tavoiteliitos ei mene kantaan');
});

test('KRIITTINEN: portin auettua kirjoitus menee oikeaan tauluun', async () => {
  if (!isGateOpen('projects')) return;

  setUser(USER_A);
  const client = fakeClient({ data: [], error: null });
  setClient(client);

  await createProject({ name: 'Kantaan' });

  const kirjoitukset = client.calls.filter(call => call.operation === 'insert');
  assert.equal(kirjoitukset.length, 1);
  assert.equal(kirjoitukset[0].table, 'projects');
});

// =====================================================================
// ISTUNTO JA PASSIIVINEN LATAUS
// =====================================================================

test('KRIITTINEN: projektien luku ei kirjoita mitään', async () => {
  setUser(USER_A);
  const client = fakeClient({ data: [], error: null });
  setClient(client);

  await projectsRepo.list();

  assert.equal(client.calls.some(call => call.operation !== 'select'), false,
    'projektien luku kirjoitti kantaan');
});

test('KRIITTINEN: tilinvaihto ei vuoda projekteja seuraavalle käyttäjälle', async () => {
  setUser(USER_A);
  await createProject({ name: 'A:n salainen projekti' });
  assert.equal(getState().projects.length, 1);

  // Uloskirjautuminen tyhjentää tilan ja muistivarastot.
  clearAllCollections();
  resetState();
  clearUser();
  setUser(USER_B);

  assert.deepEqual(getState().projects, [],
    'B näkisi A:n projektit');

  // Muistivarasto on se paikka, johon portti-kiinni-polku kirjoittaa.
  // Sen on tyhjennyttävä myös -- se elää moduulitasolla koko sivun
  // elinajan, eikä resetState() koske siihen.
  const muistista = await projectsRepo.memory.list();
  assert.deepEqual(muistista.value, [], 'muistivarastoon jäi A:n projekteja');
});

test('KRIITTINEN: lomakkeen sulkeminen tyhjentää kentät', () => {
  // Uloskirjautuminen kutsuu closeProjectForm. Jos se vain piilottaisi
  // lomakkeen, seuraava käyttäjä löytäisi edellisen kirjoittaman
  // tekstin avatessaan sen.
  const view = read('src/app/views/projects.js');
  const close = view.slice(view.indexOf('export function closeProjectForm'),
                           view.indexOf('async function submitForm'));
  assert.ok(close.includes('fillForm(null)'),
    'closeProjectForm ei tyhjennä kenttiä');
});

// =====================================================================
// RIKKINÄINEN RIVI JA TURVA
// =====================================================================

test('rikkinäinen projektirivi ei kaada normalisointia', () => {
  for (const rikki of [{}, { id: null }, { name: null }, { name: 123 },
                       { goalId: {} }, { deadline: 'ei-päivä' }]) {
    const project = normalizeProject(rikki);
    assert.equal(typeof project.name, 'string');
    assert.ok(project.deadline === null || /^\d{4}-\d{2}-\d{2}$/.test(project.deadline));
  }
});

test('KRIITTINEN: käyttäjän teksti escapetaan näkymässä', () => {
  // Projektin nimi ja kuvaus ovat käyttäjän tuottamaa tekstiä ja ne
  // renderöidään innerHTML:n kautta. Ilman escapeHtml-kutsua nimi
  // "<img onerror=...>" olisi suoritettavaa koodia.
  const view = read('src/app/views/projects.js');

  const listaus = view.slice(view.indexOf('container.innerHTML = projects.map'),
                             view.indexOf('container.querySelectorAll'));

  for (const kentta of ['project.name', 'project.id', 'project.description']) {
    const kohdat = [...listaus.matchAll(new RegExp('\\$\\{[^}]*' + kentta.replace('.', '\\.') + '[^}]*\\}', 'g'))];
    for (const kohta of kohdat) {
      assert.ok(kohta[0].includes('escapeHtml'),
        `${kentta} renderöidään escapettamatta: ${kohta[0]}`);
    }
  }
});

test('näkymä ei tuota tunnisteita eikä lue kelloa suoraan', () => {
  const view = read('src/app/views/projects.js');
  assert.equal(view.includes('crypto.randomUUID'), false,
    'näkymä luo tunnisteita — se kuuluu sovelluskerrokselle');
  assert.equal(/new Date\(\)/.test(view), false,
    'näkymä lukee kelloa suoraan; käytä todayMidnight-apuria');
  void NEWLINE;
});
