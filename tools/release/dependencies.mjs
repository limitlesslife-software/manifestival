// Vierasavainriippuvuudet migraatioista.
//
// MIKSI NÄMÄ LUETAAN EIKÄ KIRJOITETA KÄSIN
//
// Aktivointijärjestys on olemassa vain yhdestä syystä: portti, joka
// avataan ennen viittauskohdettaan, tuottaa vierasavainvirheen heti kun
// käyttäjä yrittää liittää rivejä. Jos järjestys kirjoitettaisiin käsin,
// se voisi olla väärä ilman että mikään huomaa — ja virhe näkyisi vasta
// tuotannossa, käyttäjän datassa.
//
// Siksi riippuvuudet luetaan siitä samasta lähteestä, joka ne kantaan
// loi: migraatiotiedostoista.
//
// KAKSI ILMOITUSMUOTOA
//
// Vierasavain voidaan ilmoittaa kahdella tavalla, ja MOLEMMAT on
// luettava:
//
//   1. create table -lohkon sisällä
//        create table public.routine_exceptions (
//          ...
//          foreign key (user_id, routine_id) references public.routines (user_id, id)
//        );
//
//   2. jälkikäteen
//        alter table public.bills
//          add constraint ... foreign key (user_id, recurring_expense_id)
//          references public.recurring_expenses (user_id, id);
//
// Pelkkä `alter table` -muodon lukeminen jättäisi huomaamatta
// routine_exceptions -> routines, joka on juuri se riippuvuus, jonka
// takia rutiinit ja poikkeukset kuuluvat samaan aaltoon.

import fs from 'node:fs';
import path from 'node:path';

import { ALL_GATES } from './waves.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MIGRATION_DIR = path.join(ROOT, 'supabase', 'migrations');
const NEWLINE = String.fromCharCode(10);

/**
 * Taulunimi -> porttinimi. `null` tarkoittaa taulua, joka on jo
 * tuotannossa käytössä eikä siis kuulu millekään aallolle.
 */
export const TABLE_TO_GATE = Object.freeze({
  routines: 'routines',
  routine_exceptions: 'routineExceptions',
  goals: 'goals',
  projects: 'projects',
  notification_preferences: 'notificationPreferences',
  wellbeing_entries: 'wellbeing',
  bills: 'bills',
  recurring_expenses: 'recurringExpenses',
  savings_goals: 'savingsGoals',
  ai_action_audit: 'aiAudit',
  tasks: null,
  profile: null
});

/** Migraatiotiedosto ilman kommenttirivejä. */
function migrationSource(name) {
  return fs.readFileSync(path.join(MIGRATION_DIR, name), 'utf8')
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE);
}

/** Kaikki migraatiotiedostot järjestyksessä. */
export function migrationFiles() {
  return fs.readdirSync(MIGRATION_DIR).filter(n => n.endsWith('.sql')).sort();
}

/**
 * Kaikki omistajuusvierasavaimet: lapsitaulu -> vanhempitaulu.
 *
 * Vain yhdistelmäavaimet `(user_id, sarake)` luetaan. Yhden sarakkeen
 * viite ei olisi omistajuusviite eikä siis kertoisi aktivointi-
 * järjestyksestä mitään — ja sellaisia ei skeemassa enää ole.
 *
 * @returns {Array<{child: string, parent: string, column: string, file: string}>}
 */
export function ownershipForeignKeys() {
  const found = [];

  for (const name of migrationFiles()) {
    const source = migrationSource(name);

    // 1. create table -lohkon sisäiset viitteet.
    for (const block of source.matchAll(/create table public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
      const child = block[1];
      for (const fk of block[2].matchAll(
        /foreign key \(user_id,\s*(\w+)\)\s*references public\.(\w+)/g)) {
        found.push({ child, parent: fk[2], column: fk[1], file: name });
      }
    }

    // 2. alter table -muodossa lisätyt viitteet.
    //
    // VÄLISSÄ EI SAA OLLA TOISTA `alter table` -LAUSETTA. Ilman tuota
    // ehtoa laiska välimatka hyppää lauserajan yli ja poimii lapseksi
    // väärän taulun: migraatiossa 0004 rivin `alter table public.goals
    // ... references public.projects` väliin osuu erillinen `alter
    // table public.projects` -lause, ja pelkkä `[\s\S]{0,300}?`
    // raportoi viitteen muodossa projects -> projects. Riippuvuus
    // katoaisi ja väärä ilmestyisi tilalle — kummankin seuraus olisi
    // väärä aktivointijärjestys.
    for (const fk of source.matchAll(
      /alter table public\.(\w+)((?:(?!alter table)[\s\S]){0,400}?)foreign key \(user_id,\s*(\w+)\)\s*references public\.(\w+)/g)) {
      found.push({ child: fk[1], parent: fk[4], column: fk[3], file: name });
    }
  }

  return found;
}

/**
 * Porttien väliset riippuvuudet: portti -> portit, joiden on oltava
 * auki ennen sitä.
 *
 * Taulut, jotka eivät ole portin takana (`tasks`, `profile`), jätetään
 * pois: ne ovat jo tuotannossa käytössä eivätkä rajoita järjestystä.
 * Itseviittaus jätetään myös pois — `goals.parent_goal_id` viittaa
 * samaan tauluun eikä siis ole aaltojen välinen riippuvuus.
 *
 * @returns {Map<string, Set<string>>}
 */
export function gateDependencies() {
  const dependencies = new Map();

  for (const { child, parent } of ownershipForeignKeys()) {
    const childGate = TABLE_TO_GATE[child];
    const parentGate = TABLE_TO_GATE[parent];
    if (!childGate || !parentGate || childGate === parentGate) continue;
    if (!dependencies.has(childGate)) dependencies.set(childGate, new Set());
    dependencies.get(childGate).add(parentGate);
  }

  return dependencies;
}

/**
 * Riippuvuudet tavallisena oliona, manifestia varten.
 * @returns {object} portti -> järjestetty lista portteja
 */
export function gateDependencyMap() {
  const map = {};
  const dependencies = gateDependencies();
  for (const gate of ALL_GATES) {
    map[gate] = [...(dependencies.get(gate) || [])].sort();
  }
  return map;
}
