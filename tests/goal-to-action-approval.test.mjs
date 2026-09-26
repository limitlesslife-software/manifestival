// Tavoitteesta tekemiseksi — hyväksyntäraja, portit ja käyttöliittymä.
//
// =====================================================================
// TÄMÄ TIEDOSTO VARTIOI YHTÄ ASIAA YLI MUIDEN
// =====================================================================
//
// EHDOTUS EI SAA LUODA MITÄÄN PYSYVÄÄ ENNEN HYVÄKSYNTÄÄ, eikä
// hyväksyntään saa olla toista polkua kuin `toCommittable`.
//
// Domain-testit (goal-to-action-domain.test.mjs) todistavat, että
// portti toimii. Tämä tiedosto todistaa, ettei sen ohi ole tietä:
// se lukee toimintokerroksen lähdekoodin ja tarkistaa, ettei
// ehdotuksen sisältöä kirjoiteta muualta.
//
// Testi lähdekoodia lukemalla on karkea. Se on myös ainoa tapa
// havaita polku, jota kukaan ei ole vielä kirjoittanut.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import {
  TABLES, GOAL_PLANNING_FIELDS, GOAL_MAINTENANCE_MODE, volatileGoalFields,
  volatileTaskPlanningFields, pendingTables, taskColumns
} from '../src/data/schema.js';
import { milestonesRepo, goalsRepo, projectsRepo, ALL_REPOSITORIES }
  from '../src/data/collectionsRepo.js';
import { TASK_COLUMNS_PLANNING, toRow } from '../src/lib/rows.js';
import { DEVICE_DEFAULTS, ACCOUNT_DEFAULTS } from '../src/data/preferences.js';
import { GOAL_STATUS } from '../src/domain/goal.js';
import { AUTOMATION_LEVEL } from '../src/domain/automation.js';

const NEWLINE = String.fromCharCode(10);

// =====================================================================
// HYVÄKSYNTÄRAJA
// =====================================================================

test('KRIITTINEN: toCommittable on ainoa polku ehdotuksesta tallennukseen', () => {
  const planning = read('src/app/planning.js');

  assert.ok(planning.includes('toCommittable'),
    'suunnittelukerros ei kutsu hyväksyntäporttia');

  // Kirjoitukset tapahtuvat VAIN commitPlan-funktion sisällä.
  const commitStart = planning.indexOf('export async function commitPlan');
  assert.ok(commitStart !== -1, 'commitPlan-funktiota ei löydy');

  const commitEnd = planning.indexOf(NEWLINE + '}', commitStart);
  const commitBody = planning.slice(commitStart, commitEnd);

  // Repositoriokutsut ovat sallittuja vain commitPlanin sisällä ja
  // peruutusaskeleissa. Muualla tiedostossa niitä ei saa olla.
  const ulkopuoli = planning.slice(0, commitStart) + planning.slice(commitEnd);

  for (const kutsu of ['goalsRepo.insert', 'milestonesRepo.insert',
    'projectsRepo.insert', 'routinesRepo.insert', 'insertTask']) {
    assert.equal(ulkopuoli.includes(kutsu), false,
      `kirjoitus ${kutsu} commitPlanin ulkopuolella — hyväksyntäportti ohitetaan`);
    assert.ok(commitBody.includes(kutsu), `${kutsu} puuttuu commitPlanista`);
  }
});

test('KRIITTINEN: commitPlan tarkistaa hyväksynnän ennen kirjoitusta', () => {
  const planning = read('src/app/planning.js');
  const start = planning.indexOf('export async function commitPlan');
  const body = planning.slice(start, planning.indexOf(NEWLINE + '}', start));

  const porttiKohta = body.indexOf('toCommittable');
  const ekaKirjoitus = Math.min(
    ...['goalsRepo.insert', 'milestonesRepo.insert', 'projectsRepo.insert',
      'insertTask', 'routinesRepo.insert']
      .map(kutsu => body.indexOf(kutsu))
      .filter(index => index !== -1));

  assert.ok(porttiKohta !== -1, 'hyväksyntäporttia ei kutsuta');
  assert.ok(porttiKohta < ekaKirjoitus,
    'kirjoitus tapahtuu ennen hyväksyntäportin tarkistusta');
});

test('KRIITTINEN: tila muuttuu tallennetuksi vasta kirjoitusten jälkeen', () => {
  const planning = read('src/app/planning.js');
  const start = planning.indexOf('export async function commitPlan');
  const body = planning.slice(start, planning.indexOf(NEWLINE + '}', start));

  const merkintä = body.indexOf('markCommitted');
  const viimeinenKirjoitus = Math.max(
    ...['goalsRepo.insert', 'milestonesRepo.insert', 'projectsRepo.insert',
      'insertTask', 'routinesRepo.insert'].map(kutsu => body.lastIndexOf(kutsu)));

  assert.ok(merkintä > viimeinenKirjoitus,
    'suunnitelma merkittiin tallennetuksi ennen kuin kirjoitukset olivat valmiit');
});

test('KRIITTINEN: epäonnistunut tallennus peruutetaan ja kerrotaan', () => {
  const planning = read('src/app/planning.js');

  assert.ok(planning.includes('rollback'), 'peruutusta ei ole');
  assert.ok(planning.includes('orphans'),
    'peruutuksen epäonnistumista ei raportoida');
  assert.ok(planning.includes('partial'),
    'osittaista tallennusta ei merkitä');

  // Ja käyttöliittymä näyttää sen.
  const view = read('src/app/views/planning.js');
  assert.ok(view.includes('result.partial'),
    'käyttöliittymä ei kerro osittaisesta tallennuksesta');
  assert.ok(view.includes('orphans'),
    'käyttöliittymä ei kerro mitkä rivit jäivät kantaan');
});

test('KRIITTINEN: idempotenssi estää kaksoistallennuksen', () => {
  const planning = read('src/app/planning.js');
  const start = planning.indexOf('export async function commitPlan');
  const body = planning.slice(start, planning.indexOf(NEWLINE + '}', start));

  assert.ok(body.includes('isAlreadyCommitted'),
    'idempotenssia ei tarkisteta');

  const tarkistus = body.indexOf('isAlreadyCommitted');
  const ekaKirjoitus = Math.min(
    ...['goalsRepo.insert', 'insertTask']
      .map(kutsu => body.indexOf(kutsu))
      .filter(index => index !== -1));

  assert.ok(tarkistus < ekaKirjoitus,
    'idempotenssi tarkistetaan vasta kirjoituksen jälkeen');
});

test('KRIITTINEN: suunnittelukerros ei kirjoita ilman ehdotusta', () => {
  const planning = read('src/app/planning.js');
  const start = planning.indexOf('export async function commitPlan');
  const body = planning.slice(start, planning.indexOf(NEWLINE + '}', start));

  // Ensimmäinen asia on ehdotuksen olemassaolo.
  assert.match(body.slice(0, 300), /pendingPlan/,
    'commitPlan ei tarkista ehdotuksen olemassaoloa ensin');
});

test('KRIITTINEN: ehdotusta ei tallenneta mihinkään pysyvään', () => {
  // Ehdotus elää istunnon muistissa. Hylätty ehdotus on roskaa, joka ei
  // koskaan katoaisi itsestään — ja se päätyisi vientiin.
  for (const tiedosto of ['src/app/planning.js', 'src/app/state.js',
    'src/app/views/planning.js']) {
    const koodi = read(tiedosto)
      .split(NEWLINE)
      .filter(rivi => !rivi.trim().startsWith('//') && !rivi.trim().startsWith('*'))
      .join(NEWLINE);

    assert.equal(/localStorage\.setItem\(\s*['"`][^'"`]*plan/i.test(koodi), false,
      `${tiedosto}: ehdotus kirjoitetaan localStorageen`);
    assert.equal(/indexedDB/i.test(koodi), false,
      `${tiedosto}: ehdotus kirjoitetaan IndexedDB:hen`);
  }

  // Eikä ehdotuksille ole taulua.
  assert.equal(TABLES.plans, undefined, 'suunnitelmaehdotuksille on portti');
  // `travel_plans` sisaltaa sanan "plan" mutta EI OLE ehdotus: se on
  // kayttajan itse kirjaama matka, jolla on oma porttinsa, oma
  // nakymansa ja oma taulunsa. Se luetellaan NIMELTA -- laveampi
  // hahmo pysyy voimassa, ja mika tahansa muu plan-niminen taulu
  // kaataa taman yha.
  const SALLITUT_PLAN_TAULUT = ['travel_plans'];
  const ehdotusRepot = ALL_REPOSITORIES
    .filter(repo => /plan/i.test(repo.table))
    .map(repo => repo.table)
    .filter(table => !SALLITUT_PLAN_TAULUT.includes(table));
  assert.deepEqual(ehdotusRepot, [],
    'suunnitelmaehdotuksille on repositorio');

  for (const tiedosto of ['supabase/migrations/0010_goal_to_action.sql',
    'supabase/migrations/0011_personal_assistant.sql']) {
    const migraatio = read(tiedosto)
      .split(NEWLINE)
      .filter(rivi => !rivi.trim().startsWith('--'))
      .join(NEWLINE);

    assert.equal(/create table public\.plans/i.test(migraatio), false,
      `${tiedosto}: migraatio luo taulun suunnitelmaehdotuksille`);
    assert.equal(/create table public\.\w*proposals?/i.test(migraatio), false,
      `${tiedosto}: migraatio luo taulun ehdotuksille`);
  }
});

test('KRIITTINEN: ehdotus ei päädy vientiin', () => {
  const exported = read('src/domain/dataExport.js');
  const lista = exported.slice(
    exported.indexOf('EXPORTED_COLLECTIONS'),
    exported.indexOf(']);', exported.indexOf('EXPORTED_COLLECTIONS')));

  assert.equal(/pendingPlan|'plans'|pendingReplan/.test(lista), false,
    'väliaikainen ehdotus on viennissä');

  // Välitavoitteet SEN SIJAAN kuuluvat vientiin: ne ovat käyttäjän omaa
  // pysyvää dataa.
  assert.ok(lista.includes("'milestones'"),
    'välitavoitteet puuttuvat viennistä');
});

// =====================================================================
// PORTIT
// =====================================================================

test('KRIITTINEN: Tavoitesuunnittelun portit ovat kiinni', () => {
  assert.equal(TABLES.milestones, false);
  assert.equal(GOAL_PLANNING_FIELDS, false);
  assert.equal(GOAL_MAINTENANCE_MODE, false);
  assert.ok(pendingTables().includes('milestones'));
});

test('KRIITTINEN: mittarikenttiä EI lähetetä portin ollessa kiinni', () => {
  // `goals` on TUOTANNOSSA AUKI ja siinä on käyttäjän dataa. Näiden
  // lähettäminen — NULLINAKIN — kaataisi jokaisen tavoitteen
  // tallennuksen koodilla 42703, myös niiden jotka toimivat tänään.
  assert.equal(GOAL_PLANNING_FIELDS, false, 'testi olettaa portin olevan kiinni');

  const row = goalsRepo.mapping.toRow(goalsRepo.mapping.normalize({
    id: 'g1', title: 'X', metric: 'paino', unit: 'kg',
    baselineValue: 90, currentValue: 82, targetValue: 75,
    measuredOn: '2026-09-10', savingsGoalId: 's1'
  }));

  for (const kentta of ['metric', 'unit', 'baseline_value', 'current_value',
    'target_value', 'measured_on', 'savings_goal_id']) {
    assert.equal(kentta in row, false,
      `mittarikenttä ${kentta} lähetettiin vaikka saraketta ei ole`);
  }
});

test('KRIITTINEN: tehtävän suunnittelukenttiä EI lähetetä portin ollessa kiinni', () => {
  const columns = taskColumns();
  assert.equal(columns.includes('milestone_id'), false,
    'milestone_id lähetettiin vaikka saraketta ei ole');
  assert.equal(columns.includes('depends_on'), false);

  const row = toRow({
    id: 't1', title: 'X', milestoneId: 'm1', dependsOn: ['a']
  }, columns);
  assert.equal('milestone_id' in row, false);
  assert.equal('depends_on' in row, false);

  // Ja portin auettua ne olisivat mukana.
  assert.ok(TASK_COLUMNS_PLANNING.includes('milestone_id'));
  assert.ok(TASK_COLUMNS_PLANNING.includes('depends_on'));
});

test('KRIITTINEN: projektin välitavoiteliitosta EI lähetetä portin ollessa kiinni', () => {
  const row = projectsRepo.mapping.toRow(projectsRepo.mapping.normalize({
    id: 'p1', name: 'X', milestoneId: 'm1'
  }));
  assert.equal('milestone_id' in row, false);
});

test('domain säilyttää suunnittelukentät vaikkei niitä lähetetä', () => {
  // Portin ollessa kiinni tieto elää istunnon muistissa. Se ei saa
  // kadota mallista — vain kantaan lähettämisestä.
  const goal = goalsRepo.mapping.normalize({
    id: 'g1', title: 'X', metric: 'paino', targetValue: 75
  });
  assert.equal(goal.metric, 'paino');
  assert.equal(goal.targetValue, 75);

  const project = projectsRepo.mapping.normalize({
    id: 'p1', name: 'X', milestoneId: 'm1'
  });
  assert.equal(project.milestoneId, 'm1');
});

test('käyttöliittymä kertoo mitkä kentät eivät säily', () => {
  assert.deepEqual(volatileGoalFields(), [
    'metric', 'unit', 'baselineValue', 'currentValue', 'targetValue',
    'measuredOn', 'savingsGoalId'
  ]);
  assert.deepEqual(volatileTaskPlanningFields(), ['milestoneId', 'dependsOn']);

  const view = read('src/app/views/goals.js');
  assert.ok(view.includes('volatileGoalFields'),
    'tavoitelomake ei kerro säilyvyydestä');
});

test('KRIITTINEN: välitavoitteen rivimuunnos vastaa migraatiota 0010', () => {
  const migraatio = read('supabase/migrations/0010_goal_to_action.sql');
  const lohko = /create table public\.milestones \(([\s\S]*?)\n\);/.exec(migraatio);
  assert.ok(lohko, 'migraatiosta ei löydy milestones-taulua');

  const sarakkeet = new Set(lohko[1].split(NEWLINE)
    .map(rivi => rivi.trim())
    .filter(rivi => rivi && !rivi.startsWith('--'))
    .map(rivi => rivi.split(/\s+/)[0])
    .filter(nimi => /^[a-z_]+$/.test(nimi)));

  const row = milestonesRepo.mapping.toRow(milestonesRepo.mapping.normalize({
    id: 'm1', goalId: 'g1', title: 'X', description: 'Y',
    targetDate: '2026-10-01', orderIndex: 2, rule: 'manual'
  }));

  for (const kentta of Object.keys(row)) {
    assert.ok(sarakkeet.has(kentta),
      `rivimuunnos lähettää saraketta jota ei ole: ${kentta}`);
  }

  for (const kielletty of ['user_id', 'created_at', 'updated_at']) {
    assert.equal(kielletty in row, false,
      `client lähettää palvelimen kenttää: ${kielletty}`);
  }
});

test('KRIITTINEN: kiinni oleva portti käyttää muistivarastoa', async () => {
  // Ei tietokantayhteyttä: getClient() heittäisi. Jos tämä menee läpi,
  // tietokantapolkua ei ajettu.
  const result = await milestonesRepo.insert({
    id: 'ap-m-1', goalId: 'g1', title: 'X', orderIndex: 0
  });
  assert.equal(result.ok, true);
  assert.equal(milestonesRepo.isPersistent(), false);

  const list = await milestonesRepo.list();
  assert.ok(list.value.some(row => row.id === 'ap-m-1'));
  milestonesRepo.clear();
});

test('välitavoitteet ladataan käynnistyksessä', () => {
  const actions = read('src/app/actions.js');
  assert.ok(actions.includes('milestonesRepo.list()'),
    'välitavoitteita ei ladata — portin avaaminen ei näyttäisi mitään');
});

// =====================================================================
// AUTOMAATIOTASO
// =====================================================================

test('KRIITTINEN: automaatiotason oletus on varovaisin', () => {
  assert.equal(DEVICE_DEFAULTS.automationLevel, AUTOMATION_LEVEL.SUGGEST_ONLY);
  assert.equal(ACCOUNT_DEFAULTS.planning.automationLevel,
    AUTOMATION_LEVEL.SUGGEST_ONLY);
});

test('automaatiotaso epäonnistuu turvallisesti', () => {
  const state = read('src/app/state.js');
  assert.ok(state.includes('normalizeAutomationLevel(getDevicePreference'),
    'tallennettua tasoa ei normalisoida — rikkinäinen asetus avaisi automaation');
});

test('taso 4 sanotaan ääneen käyttöliittymässä', () => {
  const view = read('src/app/views/planning.js');
  assert.ok(view.includes('requiresExplicitOptIn'),
    'taso 4 ei erotu muista käyttöliittymässä');
  assert.match(view, /ennen kuin näet/i,
    'taso 4:n luonnetta ei kerrota');
});

// =====================================================================
// YLLÄPITOTILA
// =====================================================================

test('KRIITTINEN: ylläpito on olemassa mutta portti on kiinni', () => {
  assert.ok(Object.values(GOAL_STATUS).includes('maintenance'));
  assert.equal(GOAL_MAINTENANCE_MODE, false,
    'ylläpitotila avattiin ennen migraatiota — tallennus kaatuisi koodilla 23514');
});

test('ylläpito ei kilpaile kalenteriajasta', async () => {
  const { SCHEDULING_STATUSES } = await import('../src/domain/goal.js');
  assert.equal(SCHEDULING_STATUSES.includes('maintenance'), false);
  assert.equal(SCHEDULING_STATUSES.includes('paused'), false);
});

// =====================================================================
// KÄYTTÖLIITTYMÄ
// =====================================================================

test('KRIITTINEN: käyttöliittymä kertoo ettei ehdotus tallennu', () => {
  const html = read('index.html');
  const view = read('src/app/views/planning.js');

  assert.match(html, /mitään ei tallenneta ennen kuin\s*hyväksyt sen/i,
    'suunnittelunäkymä ei kerro hyväksyntärajasta');
  assert.match(view, /Mitään ei ole tallennettu/,
    'ehdotusnäkymä ei kerro ettei mitään ole tallennettu');
});

test('KRIITTINEN: käyttöliittymä ei väitä 24 tunnin vuorokautta', () => {
  const view = read('src/app/views/planning.js');
  assert.match(view, /ei ole 24 suunniteltavaa tuntia/i,
    'kapasiteetin luonnetta ei selitetä');
});

test('KRIITTINEN: tuntematon edistyminen sanotaan ääneen', () => {
  const view = read('src/app/views/goalDetail.js');
  assert.match(view, /Ei tiedossa/, 'tuntematon edistyminen näytetään lukuna');
  assert.match(view, /tuntematon\s*ei ole nolla/i,
    'tuntemattoman ja nollan eroa ei selitetä');
});

test('KRIITTINEN: näkymät eivät kutsu kantaa eivätkä luo tunnisteita', () => {
  for (const tiedosto of ['src/app/views/planning.js', 'src/app/views/goalDetail.js']) {
    const koodi = read(tiedosto);
    assert.equal(/getClient\(/.test(koodi), false, `${tiedosto} kutsuu kantaa`);
    assert.equal(/crypto\.randomUUID/.test(koodi), false,
      `${tiedosto} luo tunnisteita`);
    assert.equal(/Math\.random/.test(koodi), false, `${tiedosto} arpoo lukuja`);
  }
});

test('vain suunnittelukerros tekee verkkopyynnön, ja se menee omaan palvelimeen', () => {
  const planning = read('src/app/planning.js');
  // Kutsu kulkee `doFetch`-muuttujan kautta, jotta testi voi antaa
  // oman toteutuksensa. Osoite on silti vakio.
  const pyynnot = [...planning.matchAll(/[^a-zA-Z.]doFetch\(([^,]+),/g)]
    .map(m => m[1].trim());

  assert.deepEqual(pyynnot, ['apiUrl(API.plan)'],
    'suunnittelu ottaa yhteyttä muualle kuin omaan palvelimeen');

  // Eikä muita verkkokutsuja ole.
  assert.equal(/[^a-zA-Z.]fetch\(/.test(planning), false,
    'suunnittelukerroksessa on ohitettavissa oleva suora verkkokutsu');

  assert.equal(/x-api-key|sk-ant-|ANTHROPIC_API_KEY/.test(planning), false,
    'selainkoodissa on API-avain tai sen otsake');

  // Näkymä ei tee omia pyyntöjä lainkaan.
  assert.equal(/[^a-zA-Z.]fetch\(/.test(read('src/app/views/planning.js')), false,
    'näkymä tekee oman verkkopyynnön');
});

test('osioiden näyttäminen on yhdessä paikassa', () => {
  // Kaksi toteutusta ajautuisi erilleen: aiemmin projects.js näytti
  // tavoitelistan aina kun osio ei ollut "projects" — myös silloin kun
  // se oli "plan".
  const projects = read('src/app/views/projects.js');
  assert.equal(projects.includes("toggle('goalsSection'"), false,
    'projects.js ohjaa yhä osioiden näkyvyyttä');

  const goals = read('src/app/views/goals.js');
  assert.ok(goals.includes('syncGoalsSegment'),
    'goals.js ei omista osioiden näkyvyyttä');
});

// =====================================================================
// TILINVAIHTO
// =====================================================================

test('KRIITTINEN: uloskirjautuminen nollaa suunnitteluehdotukset', () => {
  const main = read('src/app/main.js');

  assert.ok(main.includes('resetPlanning()'),
    'uloskirjautuminen ei nollaa suunnittelunäkymää');
  assert.ok(main.includes('clearIdempotencyKeys()'),
    'idempotenssiavaimet jäisivät seuraavalle käyttäjälle');
  assert.ok(main.includes('closeMilestoneForm()'),
    'välitavoitelomake jäisi auki');
  assert.ok(main.includes('resetState()'),
    'tilaa ei nollata — ehdotus jäisi seuraavalle käyttäjälle');
});

test('KRIITTINEN: tilan nollaus vie ehdotukset ja välitavoitteet', async () => {
  const state = await import('../src/app/state.js');

  state.setMilestones([{ id: 'm1', goalId: 'g1', title: 'X' }]);
  state.setPendingPlan({ status: 'generated', goal: { title: 'X' } });
  state.setPendingReplan({ trigger: 'manual', changes: [] });
  state.setOpenGoalId('g1');

  assert.equal(state.getState().milestones.length, 1);
  assert.ok(state.getState().pendingPlan);

  state.resetState();

  const after = state.getState();
  assert.equal(after.milestones.length, 0, 'välitavoitteet jäivät tilaan');
  assert.equal(after.pendingPlan, null, 'ehdotus jäi tilaan');
  assert.equal(after.pendingReplan, null, 'muutosehdotus jäi tilaan');
  assert.equal(after.openGoalId, null, 'avattu tavoite jäi tilaan');
});

test('idempotenssiavaimet elävät vain istunnon ajan', () => {
  const planning = read('src/app/planning.js');
  assert.match(planning, /const committedKeys = new Set\(\)/,
    'avaimet eivät ole istunnon muistissa');
  assert.equal(/localStorage[\s\S]{0,80}committedKeys/.test(planning), false,
    'avaimet kirjoitetaan pysyvään tallennukseen');
});

// =====================================================================
// MIGRAATIO
// =====================================================================

test('KRIITTINEN: migraatio 0010 varoittaa muuttavansa elävää dataa', () => {
  const migraatio = read('supabase/migrations/0010_goal_to_action.sql');

  assert.match(migraatio, /VAARALLISEMPI KUIN/,
    'migraatio ei erotu aiemmista vaarallisuudeltaan');
  assert.match(migraatio, /goals_status_check/,
    'tilarajoitteen korvaamista ei mainita');
  assert.match(migraatio, /Varmuuskopio/,
    'varmuuskopiota ei vaadita');
});

test('KRIITTINEN: migraatio tarkistaa olemassa olevan datan ennen rajoitteita', () => {
  const migraatio = read('supabase/migrations/0010_goal_to_action.sql');

  const tarkistus = migraatio.indexOf('OLEMASSA OLEVA DATA KESTÄÄ UUDET RAJOITTEET');
  const ekaAlter = migraatio.indexOf('alter table public.goals add column');

  assert.ok(tarkistus !== -1, 'olemassa olevaa dataa ei tarkisteta');
  assert.ok(tarkistus < ekaAlter,
    'taulua muutetaan ennen kuin olemassa oleva data on tarkistettu');
});

test('KRIITTINEN: migraatio todistaa tilarajoitteen ennen committia', () => {
  const migraatio = read('supabase/migrations/0010_goal_to_action.sql');
  const commitKohta = migraatio.lastIndexOf(NEWLINE + 'commit;');
  const ennen = migraatio.slice(0, commitKohta);

  assert.ok(ennen.includes("conname = 'goals_status_check'"),
    'tilarajoitteen olemassaoloa ei todisteta ennen committia');
  assert.ok(ennen.includes('maintenance'),
    'uuden arvon sallimista ei todisteta ennen committia');
});

test('KRIITTINEN: peruutus ei hylkää käyttäjän valintaa hiljaa', () => {
  const migraatio = read('supabase/migrations/0010_goal_to_action.sql');
  const rollback = migraatio.slice(migraatio.indexOf('-- ROLLBACK'));

  assert.match(rollback, /EPAONNISTUU/,
    'peruutus ei varoita ylläpitotilassa olevista riveistä');
});

test('verify_0010 tarkistaa tilarajoitteen kolmella tavalla', () => {
  const verify = read('supabase/verify/verify_0010.sql');

  assert.ok(verify.includes("conname = 'goals_status_check'"),
    'rajoitteen olemassaoloa ei tarkisteta');
  assert.ok(verify.includes('maintenance'),
    'uuden arvon sallimista ei tarkisteta');
  assert.match(verify, /luettelee tasan kuusi arvoa/,
    'rajoite voisi sallia kaiken ilman että kukaan huomaa');
});

test('verify_0010 on vain lukeva', () => {
  const verify = read('supabase/verify/verify_0010.sql')
    .split(NEWLINE)
    .filter(rivi => !rivi.trim().startsWith('--'))
    .join(NEWLINE);

  for (const lause of verify.split(';').map(s => s.trim()).filter(Boolean)) {
    const eka = lause.split(/\s+/)[0].toLowerCase();
    assert.ok(eka === 'select' || eka === 'with',
      `varmistus sisältää lauseen joka alkaa sanalla "${eka}"`);
  }
});
