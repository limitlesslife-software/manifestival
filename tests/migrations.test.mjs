// Migraatioiden ja domain-mallin yhdenmukaisuus.
//
// Migraatioita ei ole ajettu mihinkään ympäristöön, joten niitä ei voi
// testata ajamalla. Sen sijaan tarkistetaan se, mikä oikeasti menee rikki
// hiljaisesti: kannan CHECK-rajoitteet ja domainin sallitut arvot erkanevat
// toisistaan.
//
// Konkreettinen vaara: joku lisää domainiin uuden toistotyypin tai
// tavoitteen tilan, mutta unohtaa migraation. Koodi toimii paikallisesti
// (muistivarasto ei rajoita mitään) ja kaatuu vasta production-kannassa
// rajoiterikkomukseen — pahimmillaan kuukausia myöhemmin.
//
// Nämä testit eivät ota yhteyttä mihinkään tietokantaan. Ne lukevat
// SQL-tiedostot tekstinä.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read, browserModules } from './helpers/sources.mjs';
import { MARKER_PREFIX } from '../tools/rls-acceptance/acceptance.js';

import { RECURRENCE, ROUTINE_SCHEDULING, EXCEPTION } from '../src/domain/routine.js';
import { GOAL_STATUS, PROGRESS_MODE } from '../src/domain/goal.js';
import { PROJECT_STATUS } from '../src/domain/project.js';
import { PRIORITIES } from '../src/domain/priority.js';
import { SCALE_MIN, SCALE_MAX } from '../src/domain/wellbeing.js';
import { DEFAULT_PREFERENCES } from '../src/domain/notification.js';
import {
  TABLES, TASK_EXTENDED_FIELDS, BILL_PAYMENT_FIELDS,
  GOAL_PLANNING_FIELDS, GOAL_MAINTENANCE_MODE
} from '../src/data/schema.js';
import { parseStatusDoc } from '../tools/release/state.mjs';
import { routineExceptionsRepo } from '../src/data/collectionsRepo.js';
import { normalizeException } from '../src/domain/routine.js';
import { normalizeTask } from '../src/domain/task.js';
import { toRow, fromRow, TASK_COLUMNS_EXTENDED } from '../src/lib/rows.js';
import { BILL_STATUS, CADENCE } from '../src/domain/finance.js';
import { AUDIT_RESULTS, MAX_INPUT_SUMMARY } from '../src/domain/audit.js';
import { RISK_LEVELS } from '../src/ai/intentSchema.js';

const MIGRATION_DIR = 'supabase/migrations';
const NEWLINE = String.fromCharCode(10);

/** Kaikki migraatiotiedostot numerojärjestyksessä. */
function migrationFiles() {
  return fs.readdirSync(path.join(ROOT, MIGRATION_DIR))
    .filter(name => name.endsWith('.sql'))
    .sort();
}

/** Migraation sisältö pienaakkosin — SQL ei ole kirjainkokoherkkää. */
function sql(name) {
  return read(`${MIGRATION_DIR}/${name}`).toLowerCase();
}

/**
 * Yhden CHECK-rajoitteen sallitut arvot.
 *
 * Etsii `add constraint <nimi> check (<sarake> in ('a', 'b'))` -muodon ja
 * palauttaa listan arvoja.
 */
function allowedValues(source, constraintName) {
  const pattern = new RegExp(
    `add constraint ${constraintName}\\s+check \\(\\s*\\w+ in \\(([^)]*)\\)`, 'i');
  const match = pattern.exec(source);
  assert.ok(match, `rajoitetta ${constraintName} ei löytynyt`);
  return [...match[1].matchAll(/'([^']*)'/g)].map(m => m[1]).sort();
}

const PRIORITY_KEYS = PRIORITIES.map(p => p.key).sort();

// ------------------------------------------------------ perusmuotoilu

test('jokaisen migraation tilamerkintä kertoo totuuden', () => {
  // Aiemmin jokainen migraatio väitti samaa: "LUONNOS, ei ajettu
  // mihinkään ympäristöön". Se oli tosi siihen asti, kun 0001 ajettiin
  // tuotantoon — ja sen jälkeen tiedosto valehteli lukijalleen.
  //
  // Vakio, joka ei voi muuttua, ei ole tilamerkintä vaan koriste.
  // Tilamerkinnän on seurattava todellisuutta, ja tämä testi on paikka,
  // joka pakottaa päivittämään sen samalla kun migraatio ajetaan.
  const AJETUT = new Set([
    '0001_auth_user_scoping.sql',
    '0002_task_domain_fields.sql'
  ]);

  for (const name of migrationFiles()) {
    const source = read(`${MIGRATION_DIR}/${name}`);
    if (AJETUT.has(name)) {
      assert.match(source, /TILA: AJETTU JA HYVÄKSYTTY TUOTANNOSSA/,
        `${name} on ajettu tuotantoon, mutta tiedosto ei kerro sitä`);
      assert.equal(/TILA: EI AJETTU/.test(source), false,
        `${name}: kaksi ristiriitaista tilamerkintää`);
    } else {
      assert.match(source, /TILA: EI AJETTU TUOTANTOON\./,
        `${name}: tilamerkintä puuttuu tai on väärä`);
    }
  }

  // Lipun arvoa ei tarkisteta täällä. Portin ja migraation välinen side
  // kuuluu testille "yksikään portti ei ole auki ilman ajettua
  // migraatiota", joka lukee saman tilamerkinnän. Kahdessa paikassa
  // tarkistettu sääntö ajautuu ennen pitkää erilleen itsestään.
});

test('jokainen migraatio ajetaan yhtenä transaktiona', () => {
  for (const name of migrationFiles()) {
    const source = sql(name);
    assert.equal((source.match(/^begin;$/gm) || []).length, 1,
      `${name}: begin puuttuu tai niitä on useita`);
    assert.equal((source.match(/^commit;$/gm) || []).length, 1,
      `${name}: commit puuttuu tai niitä on useita`);
    assert.ok(source.indexOf('\nbegin;') < source.indexOf('\ncommit;'),
      `${name}: commit ennen beginia`);
  }
});

test('jokaisessa migraatiossa on rollback-ohje', () => {
  for (const name of migrationFiles()) {
    assert.match(read(`${MIGRATION_DIR}/${name}`), /ROLLBACK/,
      `${name}: rollback-osio puuttuu`);
  }
});

test('migraatiot 0002-0006 tarkistavat että 0001 on ajettu', () => {
  for (const name of migrationFiles()) {
    if (name.startsWith('0001')) continue;
    assert.match(sql(name), /raise exception 'migraatio 0001 pitaa ajaa ensin/,
      `${name}: esiehtotarkistus puuttuu`);
  }
});

// ------------------------------------------------------------ turvamalli

test('yksikään migraatio ei luo politiikkaa anon-roolille', () => {
  for (const name of migrationFiles()) {
    const source = sql(name);
    assert.equal(/create policy[\s\S]*?\bto anon\b/.test(source), false,
      `${name}: anon-roolille luodaan politiikka`);
    assert.equal(/create policy[\s\S]*?\bto public\b/.test(source), false,
      `${name}: public-roolille luodaan politiikka`);
  }
});

test('jokainen uusi taulu saa RLS:n ja neljä politiikkaa', () => {
  // Taulu, joka luodaan mutta jää ilman RLS:ää, olisi kaikkien luettavissa.
  for (const name of migrationFiles()) {
    const source = sql(name);
    const created = [...source.matchAll(/create table public\.(\w+)/g)]
      .map(match => match[1]);

    for (const table of created) {
      assert.match(source,
        new RegExp(`alter table public\\.${table}\\s+enable row level security`),
        `${name}: taulu ${table} ilman RLS:ää`);

      for (const action of ['select', 'insert', 'update', 'delete']) {
        assert.match(source, new RegExp(`create policy ${table}_${action}_own`),
          `${name}: taululta ${table} puuttuu ${action}-politiikka`);
      }

      assert.match(source, new RegExp(`revoke all on public\\.${table}\\s+from anon`),
        `${name}: taululta ${table} ei revokoida anon-oikeuksia`);
    }
  }
});

test('uusien taulujen omistajuuden asettaa tietokanta', () => {
  // Jos client saisi valita user_id:n, RLS ei suojaisi mitään.
  for (const name of migrationFiles()) {
    const source = sql(name);
    for (const match of source.matchAll(/create table public\.(\w+) \(([\s\S]*?)\n\);/g)) {
      const [, table, body] = match;
      const ownerColumn = /user_id\s+uuid not null default auth\.uid\(\)/.test(body)
        || /id\s+uuid primary key default auth\.uid\(\)/.test(body);
      assert.ok(ownerColumn,
        `${name}: taulussa ${table} ei ole omistajasaraketta oletuksella auth.uid()`);
    }
  }
});

test('uudet taulut viittaavat auth.users-tauluun poistoketjulla', () => {
  // Käyttäjän poisto ei saa jättää orpoja rivejä henkilökohtaista dataa.
  for (const name of migrationFiles()) {
    const source = sql(name);
    for (const match of source.matchAll(/create table public\.(\w+) \(([\s\S]*?)\n\);/g)) {
      const [, table, body] = match;
      assert.match(body, /references auth\.users\(id\) on delete cascade/,
        `${name}: taulusta ${table} puuttuu auth.users-viite`);
    }
  }
});


// =====================================================================
// FAIL-CLOSED -SÄÄNNÖT JA OMISTAJUUSINVARIANTTI (0003–0008)
// =====================================================================
//
// LÖYTYNYT VIKA, JOTA NÄMÄ VARTIOIVAT
//
// Kaksi erillistä vikaa, jotka molemmat olivat näkymättömiä:
//
// 1. Migraatiot 0004–0007 liittivät rivin toiseen riviin tavallisella
//    yhden sarakkeen vierasavaimella. Vierasavaimen tarkistus EI kulje
//    RLS:n läpi, joten käyttäjä B pystyi luomaan oman rivinsä, joka
//    viittasi käyttäjän A riviin. 0004 jopa dokumentoi tämän
//    "hyväksytyksi riskiksi".
//
// 2. Migraatiot 0005–0007 sisälsivät `create or replace function
//    public.touch_updated_at()` ILMAN määreitä `security invoker` ja
//    `set search_path`. Ne olisivat hiljaa korvanneet migraation 0002
//    kovennetun funktion kovettamattomalla — funktion, joka on
//    liipaisimena myös tauluissa tasks, routines, goals ja projects.
//
// Kumpikaan ei olisi näkynyt virheenä missään. Molemmat olisivat
// näkyneet vain siinä, mitä ei enää ollut.
//
// Lisäksi: kun migraatiot muutettiin fail-closed -muotoon, neljä
// olemassa olevaa testiä muuttui TYHJÄKSI. Ne etsivät muotoa
// `create table if not exists`, jota ei enää esiinny missään, joten ne
// kävivät läpi nolla taulua ja menivät läpi. Siksi ensimmäinen testi
// alla laskee, montako taulua säännöt oikeasti kattavat.

/** Migraatiot, joita fail-closed -säännöt koskevat. */
const KOVENNETUT = [
  '0003_routines.sql', '0004_goals_projects.sql',
  '0005_notification_preferences.sql', '0006_wellbeing.sql',
  '0007_finance.sql', '0008_ai_audit.sql', '0009_finance_2.sql',
  '0010_goal_to_action.sql'
];

/** Migraation suorittava osa: kommenttirivit pois. */
function code(name) {
  return sql(name).split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE);
}

/** Kaikkien migraatioiden suorittava osa yhtenä merkkijonona. */
function allCode() {
  return migrationFiles().map(code).join(NEWLINE);
}

test('KRIITTINEN: taulusäännöt eivät ole tyhjiä — ne kattavat 13 taulua', () => {
  // Tämä testi on olemassa yhtä vikaa varten: yllä olevat säännöt
  // etsivät tauluja hahmolla `create table public.X`. Jos hahmo ei
  // vastaa migraatioiden muotoa, jokainen sääntö käy läpi nolla taulua
  // ja menee läpi. Juuri niin kävi, kun `if not exists` poistettiin.
  //
  // Luku on käsin laskettu ja tarkoituksella: uuden taulun lisääminen
  // kaataa tämän, ja se on oikea hetki tarkistaa, että taulu on myös
  // hyväksyntätestissä, varmistuksessa ja porttien takana.
  const taulut = [...allCode().matchAll(/create table public\.(\w+)/g)]
    .map(m => m[1]).sort();

  assert.deepEqual(taulut, [
    'ai_action_audit', 'bills', 'goals', 'investments', 'milestones',
    'notification_preferences', 'projects', 'recurring_expenses',
    'routine_exceptions', 'routines', 'savings_goals', 'transactions',
    'wellbeing_entries'
  ], 'migraatioiden luomat taulut eivät vastaa odotusta');
});

test('KRIITTINEN: migraatiot ovat fail-closed — ei idempotenttia DDL:ää', () => {
  // `if not exists` tekee kolmesta eri tilasta saman näköisen: tuore
  // ajo, toinen ajo ja kesken jäänyt ajo näyttävät kaikki
  // onnistuneelta. Tila, jota ei voi erottaa, on tila jota ei voi
  // korjata.
  //
  // Huom: `if not exists (select 1 ...)` plpgsql-esiehdoissa on eri asia
  // ja sallittu. Siksi tämä osuu vain DDL-muotoihin.
  const kielletyt = [
    'create table if not exists', 'create index if not exists',
    'create unique index if not exists', 'add column if not exists',
    'drop constraint if exists', 'drop policy if exists',
    'drop trigger if exists', 'drop table if exists'
  ];

  for (const name of KOVENNETUT) {
    const source = code(name);
    for (const kielletty of kielletyt) {
      assert.equal(source.includes(kielletty), false,
        `${name}: idempotentti DDL "${kielletty}" — migraatio ei enää havaitse kesken jäänyttä ajoa`);
    }
  }
});

test('KRIITTINEN: jokainen kovennettu migraatio havaitsee aiemman ajon', () => {
  for (const name of KOVENNETUT) {
    const source = code(name);

    assert.ok(source.includes('lock_timeout'),
      `${name}: ei aseta lock_timeoutia — pitkä transaktio jumittaisi kirjautumiset`);

    assert.ok(source.includes('2cc00622-f927-4604-a518-361a4328481b'),
      `${name}: ei tarkista, ollaanko oikeassa tietokannassa`);

    assert.ok(/on jo ajettu/.test(source),
      `${name}: ei tunnista jo ajettua migraatiota`);

    assert.ok(/on kesken/.test(source),
      `${name}: ei tunnista kesken jäänyttä ajoa`);
  }
});

test('KRIITTINEN: touch_updated_at ei taannu kovettamattomaksi', () => {
  // Funktio luodaan kerran migraatiossa 0002. Sen jälkeen migraatio joko
  // määrittelee sen TÄSMÄLLEEN yhtä kovennettuna tai — mieluummin — vain
  // tarkistaa sen. Kovettamaton `create or replace` olisi hiljainen
  // taantuma, joka koskisi myös tasks-taulua.
  for (const name of migrationFiles()) {
    const source = code(name);

    const maarittely = /create or replace function public\.touch_updated_at\(\)([\s\S]*?)as \$\$/
      .exec(source);

    if (maarittely) {
      assert.ok(maarittely[1].includes('security invoker'),
        `${name}: touch_updated_at ilman security invoker -määrettä`);
      assert.ok(/set search_path *=/.test(maarittely[1]),
        `${name}: touch_updated_at ilman kiinnitettyä search_pathia`);
      continue;
    }

    // Ei määrittelyä. Jos migraatio silti käyttää funktiota
    // liipaisimessa, sen on tarkistettava että funktio on kovennettu.
    if (source.includes('execute function public.touch_updated_at')) {
      assert.ok(source.includes('prosecdef'),
        `${name}: käyttää touch_updated_at-funktiota mutta ei tarkista sen kovennusta`);
      assert.ok(source.includes('proconfig'),
        `${name}: ei tarkista touch_updated_at-funktion search_pathia`);
    }
  }
});

test('KRIITTINEN: jokainen viittaus sovellustauluun on yhdistelmävierasavain', () => {
  // TÄMÄ ON KOKO PAKETIN TÄRKEIN TESTI.
  //
  // Tavallinen `references public.goals(id)` sallii ristiinkiinnityksen:
  // B voi luoda oman rivinsä, joka viittaa A:n riviin. RLS ei estä sitä,
  // koska B:n rivin omistaja on B — aivan kuten pitääkin. Vierasavaimen
  // tarkistus ei kulje RLS:n läpi.
  //
  // Ainoa este on yhdistelmävierasavain (user_id, viite) -> (user_id, id).
  const yhdistelma =
    /foreign key \(user_id,\s*\w+\)\s*references public\.\w+\s*\(user_id,\s*id\)/g;

  for (const name of migrationFiles()) {
    const source = code(name);

    const kaikki = (source.match(/references public\./g) || []).length;
    const oikeat = (source.match(yhdistelma) || []).length;

    assert.equal(kaikki, oikeat,
      `${name}: ${kaikki - oikeat} viittausta sovellustauluun ei ole yhdistelmävierasavain`
      + ' — ne sallisivat ristiinkiinnityksen toisen käyttäjän riviin');
  }
});

test('KRIITTINEN: yhdistelmävierasavaimen kohteella on omistajan rivin avain', () => {
  // PostgreSQL vaatii viitatuille sarakkeille yksikäsitteisyysrajoitteen.
  // Jos se puuttuu, viitettä ei voi luoda lainkaan — ja migraatio
  // kaatuisi vasta tuotannossa.
  const kaikki = allCode();

  const kohteet = new Set(
    [...kaikki.matchAll(/references public\.(\w+)\s*\(user_id,\s*id\)/g)].map(m => m[1]));

  assert.ok(kohteet.size >= 5,
    `yhdistelmävierasavaimen kohteita löytyi vain ${kohteet.size} — hahmo ei osu`);

  for (const taulu of kohteet) {
    // Avain voidaan lisätä joko omana lauseenaan tai taulun sisällä.
    // Migraatio 0003 tekee sen taulun sisällä, 0004 ja 0007 erikseen.
    // Molemmat kelpaavat; puuttuminen ei.
    const omanaLauseena = `add constraint ${taulu}_owner_row_key unique (user_id, id)`;
    const taulunSisalla = `constraint ${taulu}_owner_row_key unique (user_id, id)`;

    assert.ok(kaikki.includes(omanaLauseena) || kaikki.includes(taulunSisalla),
      `taulu ${taulu} on viittauksen kohde mutta siltä puuttuu ${taulu}_owner_row_key`);
  }
});

test('KRIITTINEN: yhdistelmävierasavain ei nollaa omistajaa poistossa', () => {
  // `on delete set null` nollaa OLETUKSENA kaikki vierasavaimen
  // sarakkeet — myös user_id:n, joka on NOT NULL. Silloin kohteen
  // poistaminen kaatuisi joka kerta. Sarakelista suluissa rajaa
  // nollauksen oikeaan sarakkeeseen, ja se vaatii PostgreSQL 15:n.
  for (const name of KOVENNETUT) {
    const source = code(name);

    const viitteet = [...source.matchAll(
      /foreign key \(user_id,\s*(\w+)\)\s*references public\.\w+\s*\(user_id,\s*id\)\s*([^;]*);/g)];

    for (const [, sarake, jatko] of viitteet) {
      // Sääntö koskee vain nollaavia viitteitä. `on delete cascade` on
      // eri asia: se poistaa lapsirivin kokonaan eikä kirjoita
      // yhteenkään sarakkeeseen, joten user_id ei ole vaarassa.
      // Migraatio 0003 käyttää cascadea, koska poikkeus ilman rutiinia
      // ei tarkoita mitään.
      if (!jatko.includes('on delete set null')) continue;

      assert.ok(jatko.includes(`set null (${sarake})`),
        `${name}: viite ${sarake} nollaisi poistossa myös user_id:n — kohteen poisto kaatuisi aina`);
    }

    // Versiotarkistus vaaditaan vain migraatioilta, jotka oikeasti
    // käyttävät PostgreSQL 15:n sarakelistaa. 0003 ei käytä.
    if (/on delete set null \(/.test(source)) {
      assert.ok(source.includes('server_version_num'),
        `${name}: käyttää PostgreSQL 15:n sarakelistaa mutta ei tarkista palvelimen versiota`);
    }
  }
});

test('KRIITTINEN: oikeudet nollataan ennen myöntämistä — PUBLIC mukaan lukien', () => {
  // PostgreSQL-rooli PUBLIC tarkoittaa "kaikki roolit", ja sille
  // myönnetyn oikeuden perii jokainen rooli — myös anon. Perittyä
  // oikeutta ei näy roolikohtaisissa listauksissa lainkaan, joten
  // `revoke ... from anon` ei poista sitä eikä sen puuttumista huomaisi
  // mistään.
  for (const name of KOVENNETUT) {
    const source = code(name);

    const taulut = [...source.matchAll(/create table public\.(\w+)/g)].map(m => m[1]);

    for (const taulu of taulut) {
      for (const rooli of ['public', 'anon', 'authenticated']) {
        assert.match(source,
          new RegExp(`revoke all on public\\.${taulu}\\s+from ${rooli}`),
          `${name}: taululta ${taulu} ei revokoida roolia ${rooli} ennen myöntämistä`);
      }
    }
  }
});

test('KRIITTINEN: loppuvarmistus ajetaan ennen committia', () => {
  // Viimeinen hetki, jolloin virheellinen tulos voidaan perua ilman
  // jälkiä. Jos varmistus olisi commitin jälkeen, se raportoisi
  // ongelman jota ei enää voi perua.
  for (const name of KOVENNETUT) {
    const source = code(name);
    const commitKohta = source.lastIndexOf('commit;');

    assert.ok(commitKohta > 0, `${name}: ei löydy committia`);

    const ennen = source.slice(0, commitKohta);

    // aclexplode on se tarkistus, joka näkee PUBLIC-roolille myönnetyn
    // oikeuden. has_table_privilege yksin ei kerro, mistä oikeus tulee.
    assert.ok(ennen.includes('aclexplode'),
      `${name}: ei tarkista PUBLIC-roolin oikeuksia ennen committia`);
    assert.ok(ennen.includes('has_table_privilege'),
      `${name}: ei tarkista tehollisia oikeuksia ennen committia`);
    assert.ok(ennen.includes('relrowsecurity'),
      `${name}: ei varmista RLS:n tilaa ennen committia`);
  }
});

// ------------------------------------- domainin arvot vastaavat rajoitteita

test('rutiinin toistotyypit vastaavat migraatiota 0003', () => {
  const source = sql('0003_routines.sql');
  assert.deepEqual(
    allowedValues(source, 'routines_recurrence_type_check'),
    Object.values(RECURRENCE).sort());
});

test('rutiinin aikataulutustavat vastaavat migraatiota 0003', () => {
  const source = sql('0003_routines.sql');
  assert.deepEqual(
    allowedValues(source, 'routines_scheduling_check'),
    Object.values(ROUTINE_SCHEDULING).sort());
});

test('poikkeustyypit vastaavat migraatiota 0003', () => {
  const source = sql('0003_routines.sql');
  assert.deepEqual(
    allowedValues(source, 'routine_exceptions_type_check'),
    Object.values(EXCEPTION).sort());
});

test('KRIITTINEN: tavoitteen tilat vastaavat VIIMEISINTÄ migraatiota', () => {
  // RAJOITE ON KORVATTU, JOTEN 0004 EI OLE ENÄÄ TOTUUS.
  //
  // Migraatio 0010 pudottaa `goals_status_check` -rajoitteen ja luo sen
  // uudelleen kuudella arvolla. Vanhan migraation lukeminen kertoisi
  // sen, mitä kannassa oli ennen — ja se on eri asia kuin se, mitä
  // siellä on.
  //
  // Luetaan siksi VIIMEISIN määrittely: käydään migraatiot läpi
  // järjestyksessä ja otetaan viimeinen, joka määrittelee rajoitteen.
  // Näin uusi korvaus löytyy automaattisesti eikä testi jää kertomaan
  // vanhentunutta totuutta.
  let viimeisin = null;
  let lahde = null;

  for (const nimi of migrationFiles()) {
    const source = sql(nimi);
    if (!source.includes('add constraint goals_status_check')) continue;
    viimeisin = allowedValues(source, 'goals_status_check');
    lahde = nimi;
  }

  assert.ok(viimeisin, 'goals_status_check ei löydy yhdestäkään migraatiosta');
  assert.deepEqual(viimeisin, Object.values(GOAL_STATUS).sort(),
    `${lahde}: tilarajoite ja domain ovat erkaantuneet`);

  // JA MIGRAATIO 0004:N ALKUPERÄINEN JOUKKO ON YHÄ VIISI ARVOA.
  //
  // Se on tuotannossa juuri nyt. Jos joku muokkaisi ajettua
  // migraatiota jälkikäteen, repositorio kertoisi eri tarinan kuin
  // kanta — ja tämä kaatuu siitä.
  assert.deepEqual(
    allowedValues(sql('0004_goals_projects.sql'), 'goals_status_check'),
    ['abandoned', 'active', 'archived', 'completed', 'paused'],
    'ajettua migraatiota 0004 on muokattu jälkikäteen');
});

test('tavoitteen edistymistavat vastaavat migraatiota 0004', () => {
  const source = sql('0004_goals_projects.sql');
  assert.deepEqual(
    allowedValues(source, 'goals_progress_mode_check'),
    Object.values(PROGRESS_MODE).sort());
});

test('projektin tilat vastaavat migraatiota 0004', () => {
  const source = sql('0004_goals_projects.sql');
  assert.deepEqual(
    allowedValues(source, 'projects_status_check'),
    Object.values(PROJECT_STATUS).sort());
});

test('prioriteetit ovat samat kaikissa migraatioissa', () => {
  assert.deepEqual(
    allowedValues(sql('0003_routines.sql'), 'routines_priority_check'),
    PRIORITY_KEYS);
  assert.deepEqual(
    allowedValues(sql('0004_goals_projects.sql'), 'goals_priority_check'),
    PRIORITY_KEYS);
  assert.deepEqual(
    allowedValues(sql('0002_task_domain_fields.sql'), 'tasks_priority_check'),
    PRIORITY_KEYS);
});

test('hyvinvoinnin asteikko vastaa migraatiota 0006', () => {
  const source = sql('0006_wellbeing.sql');
  for (const metric of ['energy', 'mood', 'stress']) {
    assert.match(source,
      new RegExp(`${metric}\\s+is null or ${metric}\\s+between ${SCALE_MIN} and ${SCALE_MAX}`),
      `${metric}: asteikko ei vastaa domainia`);
  }
});

test('muistutusten oletusarvot vastaavat migraatiota 0005', () => {
  const source = sql('0005_notification_preferences.sql');

  // Tärkein yksittäinen oletus: mitään ei lähetetä ilman lupaa.
  assert.equal(DEFAULT_PREFERENCES.enabled, false);
  assert.match(source, /enabled\s+boolean not null default false/);

  const pairs = [
    ['task_lead_minutes', DEFAULT_PREFERENCES.taskLeadMinutes],
    ['routine_lead_minutes', DEFAULT_PREFERENCES.routineLeadMinutes],
    ['max_per_day', DEFAULT_PREFERENCES.maxPerDay]
  ];
  for (const [column, value] of pairs) {
    assert.match(source, new RegExp(`${column}\\s+integer not null default ${value}\\b`),
      `${column}: oletus ei vastaa domainia`);
  }

  const times = [
    ['daily_plan_time', DEFAULT_PREFERENCES.dailyPlanTime],
    ['evening_review_time', DEFAULT_PREFERENCES.eveningReviewTime],
    ['quiet_hours_from', DEFAULT_PREFERENCES.quietHours.from],
    ['quiet_hours_to', DEFAULT_PREFERENCES.quietHours.to]
  ];
  for (const [column, value] of times) {
    assert.match(source, new RegExp(`${column}\\s+text\\s+not null default '${value}'`),
      `${column}: oletus ei vastaa domainia`);
  }
});

// ------------------------------------------ sarakenimet vastaavat repoja

test('collectionsRepo kirjoittaa vain sarakkeisiin jotka migraatio luo', () => {
  // Yksi kirjoitusvirhe sarakenimessä riittää rikkomaan tallennuksen
  // production-kannassa. Muistivarasto ei paljastaisi sitä koskaan.
  const repo = read('src/data/collectionsRepo.js');

  const tableToMigration = {
    routines: '0003_routines.sql',
    routine_exceptions: '0003_routines.sql',
    goals: '0004_goals_projects.sql',
    projects: '0004_goals_projects.sql',
    wellbeing_entries: '0006_wellbeing.sql'
  };

  for (const [table, migration] of Object.entries(tableToMigration)) {
    // `if not exists` on valinnainen: fail-closed-migraatio jättää sen
    // pois, koska esiehdot ovat jo todistaneet ettei taulua ole. Sarakkeiden
    // poiminnalle muodolla ei ole merkitystä — idempotenssia vartioi eri testi.
    const createMatch = new RegExp(
      `create table (?:if not exists )?public\\.${table} \\(([\\s\\S]*?)\\n\\);`)
      .exec(sql(migration));
    assert.ok(createMatch, `${table}: create table ei löytynyt`);

    const columns = new Set(
      createMatch[1].split('\n')
        .map(line => /^\s{2}(\w+)\s+\S/.exec(line))
        .filter(Boolean)
        .map(match => match[1]));

    // toRow-lohko juuri tälle taululle.
    const repoBlock = new RegExp(
      `table: '${table}',([\\s\\S]*?)\\n\\}\\);`).exec(repo);
    assert.ok(repoBlock, `${table}: repositoriota ei löytynyt`);

    const toRow = /toRow: [^{]*\{([\s\S]*?)\n {2}\}\)/.exec(repoBlock[1]);
    assert.ok(toRow, `${table}: toRow-muunnosta ei löytynyt`);

    // Varmistus siitä, että jäsennys todella löysi jotain. Ilman tätä
    // testi menisi läpi myös silloin kun regexit lakkaavat osumasta.
    assert.ok(columns.size >= 6, `${table}: sarakkeita löytyi vain ${columns.size}`);

    const written = [...toRow[1].matchAll(/^\s{4}(\w+):/gm)].map(match => match[1]);
    assert.ok(written.length >= 5,
      `${table}: toRow-kenttiä löytyi vain ${written.length}`);

    for (const column of written) {
      assert.ok(columns.has(column),
        `${table}: toRow kirjoittaa sarakkeeseen ${column}, jota migraatio ei luo`);
    }
  }
});

// ------------------------------------------------ liput ovat yhä pois päältä

test('taululiput vastaavat suunniteltua aaltoa', async () => {
  // Tama testi oli tarkoituksella hauras: se kaatui kun lippu
  // kaannettiin, jotta joku joutuisi toteamaan aaneen etta migraatio
  // on oikeasti ajettu.
  //
  // Aktivointijuna tekee lipun kaantamisesta suunniteltua tyota, joten
  // haurauden kohde siirtyy: enaa ei vaadita etta kaikki ovat kiinni,
  // vaan etta matriisi vastaa TASMALLEEN yhta suunniteltua aaltoa.
  // Suunnittelematon yhdistelma kaataa taman yha -- ja niita on 1018
  // kappaletta kuutta sallittua vastaan.
  const { resolveWave, describeMatrix } = await import('../tools/release/waves.mjs');

  const aalto = resolveWave(TABLES);
  assert.ok(aalto !== null,
    `porttimatriisi ei vastaa yhtakaan suunniteltua aaltoa: ${describeMatrix(TABLES)}.`
    + ' Jos lippu kaannettiin tarkoituksella, se kuuluu aaltocommittiin.');
});

// ------------------------------------ WP13-WP20: raha ja kirjausketju

test('KRIITTINEN: rahasarakkeet ovat kokonaislukuja eivätkä liukulukuja', () => {
  // numeric olisi tarkka kannassa, mutta se palautuu JavaScriptiin
  // merkkijonona tai liukulukuna ajurin mukaan — ja juuri se muunnos on
  // se kohta, jossa sentit katoavat.
  const source = sql('0007_finance.sql');

  for (const column of ['amount_minor', 'target_minor', 'current_minor']) {
    const pattern = new RegExp(column + '\\s+(\\w+)');
    const match = pattern.exec(source);
    assert.ok(match, `saraketta ${column} ei löytynyt`);
    assert.equal(match[1], 'bigint',
      `${column} on tyyppiä ${match[1]} — pitää olla bigint`);
  }

  // Kommentit pois ennen tarkistusta: migraatio SELITTÄÄ miksi numericia
  // ei käytetä, ja selitys osuisi muuten omaan kieltoonsa.
  const code = source.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');

  for (const forbidden of ['numeric', 'decimal', 'real', 'double precision', 'float']) {
    assert.equal(code.includes(forbidden), false,
      `0007 käyttää liukulukutyyppiä: ${forbidden}`);
  }
});

test('rahasarakkeilla on valuutta ja se on validoitu', () => {
  const source = sql('0007_finance.sql');
  for (const table of ['bills', 'recurring_expenses', 'savings_goals']) {
    assert.match(source,
      new RegExp('create table public\\.' + table + '[\\s\\S]*?currency'),
      `${table}: valuutta puuttuu`);
  }
  assert.equal((source.match(/currency ~ '\^\[a-z\]\{3\}\$'/g) || []).length, 3,
    'jokaisella taululla pitää olla valuuttamuodon tarkistus');
});

test('laskun tilat vastaavat domainia', () => {
  assert.deepEqual(
    allowedValues(sql('0007_finance.sql'), 'bills_status_check'),
    Object.values(BILL_STATUS).sort());
});

test('toistuvan kulun jaksot vastaavat domainia', () => {
  assert.deepEqual(
    allowedValues(sql('0007_finance.sql'), 'recurring_expenses_cadence_check'),
    Object.values(CADENCE).sort());
});

test('maksettu lasku vaatii maksupäivän myös kannassa', () => {
  const source = sql('0007_finance.sql');
  assert.match(source, /status <> 'paid' or paid_date is not null/,
    'puolivalmis kirjaus pääsisi kantaan');
});

test('toistuvan kulun kuukauden päivä on rajattu kannassa', () => {
  const source = sql('0007_finance.sql');
  assert.match(source, /day_of_month >= 1 and day_of_month <= 31/);
});

test('kirjausketjun lopputulokset vastaavat domainia', () => {
  assert.deepEqual(
    allowedValues(sql('0008_ai_audit.sql'), 'ai_action_audit_result_check'),
    [...AUDIT_RESULTS].sort());
});

test('kirjausketjun riskitasot vastaavat AI-mallia', () => {
  assert.deepEqual(
    allowedValues(sql('0008_ai_audit.sql'), 'ai_action_audit_risk_check'),
    [...RISK_LEVELS].sort());
});

test('KRIITTINEN: kanta ei hyväksy suoritettua komentoa ilman vahvistusta', () => {
  // Sellainen rivi olisi merkki turvamallin rikkoutumisesta. Kirjaus ei
  // saa väittää sitä tapahtuneen edes silloin kun sovelluksessa on vika.
  const source = sql('0008_ai_audit.sql');
  assert.match(source, /executed = false or confirmed = true/,
    'invariantti puuttuu kannasta');
});

test('kirjausketju rajoittaa tiivistelmän pituuden kannassa asti', () => {
  // Sovellusvirhe ei saa johtaa siihen, että koko päiväkirjamerkintä
  // päätyy tietokantaan.
  const source = sql('0008_ai_audit.sql');
  assert.match(source, /length\(input_summary\) <= \d+/);
  assert.ok(MAX_INPUT_SUMMARY <= 200,
    'domainin raja on löysempi kuin kannan — kanta hylkäisi kelvollisen rivin');
});

test('kirjausketjun kohde ei ole vierasavain', () => {
  // Kohde on voitu poistaa, ja kirjaus siitä on nimenomaan se, mitä
  // halutaan säilyttää. Vierasavain poistaisi historian kohteen mukana.
  const source = sql('0008_ai_audit.sql');
  const createBlock = /create table public\.ai_action_audit \(([\s\S]*?)\n\);/
    .exec(source);
  assert.ok(createBlock);
  assert.equal(/target_id\s+text references/.test(createBlock[1]), false,
    'target_id on vierasavain — historia katoaisi kohteen mukana');
});


// =====================================================================
// VARMISTUSTEN SARAKELISTAT LASKETAAN MIGRAATIOSTA
// =====================================================================
//
// LÖYTYNYT VIKA, JOTA NÄMÄ VARTIOIVAT
//
// verify_0003.sql odotti taululta routine_exceptions kymmentä saraketta.
// Migraatio luo yksitoista. Odotusarvo oli laskettu käsin ja `updated_at`
// unohtui. Tuotannon varmistus pysähtyi siihen, vaikka kanta oli
// täsmälleen migraation mukainen — ja pysähtynyt varmistus tarkoittaa,
// ettei lippua saa kääntää.
//
// Käsin laskettu odotusarvo vanhenee aina. Nämä testit laskevat sen
// migraatiosta, joten sarakkeen lisääminen tai poistaminen kaataa
// varmistuksen samassa commitissa jossa muutos tehdään — eikä
// tuotannossa.

/** Taulu -> migraatio ja varmistus, joissa se esiintyy. */
const TAULUKARTTA = [
  ['goals',                    '0004_goals_projects.sql',           'verify_0004.sql'],
  ['projects',                 '0004_goals_projects.sql',           'verify_0004.sql'],
  ['notification_preferences', '0005_notification_preferences.sql', 'verify_0005.sql'],
  ['wellbeing_entries',        '0006_wellbeing.sql',                'verify_0006.sql'],
  ['recurring_expenses',       '0007_finance.sql',                  'verify_0007.sql'],
  ['bills',                    '0007_finance.sql',                  'verify_0007.sql'],
  ['savings_goals',            '0007_finance.sql',                  'verify_0007.sql'],
  ['ai_action_audit',          '0008_ai_audit.sql',                 'verify_0008.sql']
];

/** Yhden taulun sarakkeet migraation create table -lauseesta. */
function luodutSarakkeet(migraatio, taulu) {
  const luonti = new RegExp(`create table public\\.${taulu} \\(([\\s\\S]*?)\\n\\);`)
    .exec(read(`${MIGRATION_DIR}/${migraatio}`));
  assert.ok(luonti, `${taulu}: create table ei löytynyt tiedostosta ${migraatio}`);

  return luonti[1].split(NEWLINE)
    .map(line => /^ {2}(\w+)\s+\S/.exec(line))
    .filter(Boolean)
    .map(m => m[1])
    .filter(nimi => nimi !== 'constraint' && nimi !== 'foreign');
}

/** Varmistuksen nimetty sarakelista tälle taululle. */
function varmistuksenSarakkeet(varmistus, taulu) {
  const lohko = new RegExp(
    `table_name = '${taulu}'\\s*\\n\\s*and column_name in \\(([^)]*)\\)`)
    .exec(read(`supabase/verify/${varmistus}`));
  assert.ok(lohko, `${varmistus}: taululle ${taulu} ei ole nimettyä sarakelistaa`);
  return [...lohko[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
}

test('KRIITTINEN: varmistusten sarakelistat vastaavat migraatioita', () => {
  for (const [taulu, migraatio, varmistus] of TAULUKARTTA) {
    const kannassa = luodutSarakkeet(migraatio, taulu);
    const odotetut = varmistuksenSarakkeet(varmistus, taulu);

    const puuttuu = kannassa.filter(s => !odotetut.includes(s));
    const yli = odotetut.filter(s => !kannassa.includes(s));

    assert.deepEqual(puuttuu, [],
      `${varmistus}: taulun ${taulu} sarakkeita ei ole nimetty: ${puuttuu.join(', ')}`);
    assert.deepEqual(yli, [],
      `${varmistus}: taululle ${taulu} nimetään sarakkeita joita migraatio ei luo: ${yli.join(', ')}`);
  }
});

test('KRIITTINEN: varmistusten sarakemäärät vastaavat migraatioita', () => {
  // Nimilista voi olla oikein ja odotusarvo silti väärä: luku on eri
  // paikassa tiedostoa kuin lista. Juuri niin kävi 0003:ssa.
  for (const [taulu, migraatio, varmistus] of TAULUKARTTA) {
    const maara = luodutSarakkeet(migraatio, taulu).length;
    const lahde = read(`supabase/verify/${varmistus}`);

    const rivi = lahde.split('union all')
      .find(osa => new RegExp(`table_name = '${taulu}'$`, 'm').test(osa)
                && osa.includes('column_name in ('));
    assert.ok(rivi, `${varmistus}: taulun ${taulu} tarkistusta ei löytynyt`);

    const odotus = /',\s*'(\d+)',/.exec(rivi);
    assert.ok(odotus, `${varmistus}: taulun ${taulu} odotusarvoa ei löytynyt`);

    assert.equal(Number(odotus[1]), maara,
      `${varmistus}: taululle ${taulu} odotetaan ${odotus[1]} saraketta,`
      + ` migraatio luo ${maara}`);
  }
});

test('KRIITTINEN: varmistus laskee myös nimeämättömät sarakkeet', () => {
  // Kokonaismäärä yksin ei todista mitään: se voisi täsmätä, vaikka
  // odotettu sarake puuttuisi ja tilalla olisi tuntematon. Kolmen luvun
  // — nimetyt, nimeämättömät, yhteensä — on oltava keskenään
  // johdonmukaiset, ja jokainen niistä lukittu.
  for (const [taulu, , varmistus] of TAULUKARTTA) {
    const lahde = read(`supabase/verify/${varmistus}`);

    assert.ok(new RegExp(`table_name = '${taulu}'\\s*\\n\\s*and column_name not in`)
      .test(lahde),
      `${varmistus}: taululle ${taulu} ei lasketa nimeämättömiä sarakkeita`);
  }
});

test('KRIITTINEN: jokainen 0004–0008 -varmistus todistaa omistajuusmallinsa', () => {
  // Jokaisen taulun kohdalla on tehty valinta: joko viittaukset ovat
  // yhdistelmävierasavaimia, tai taulussa ei ole viittauksia lainkaan.
  // Kumpikin valinta on väite, joka voi vanhentua. Varmistuksen on
  // testattava se väite, ei vain sen seurauksia.
  const vaatimukset = [
    // Viittaavat taulut: rakenne luetaan katalogista.
    ['verify_0004.sql', ['confdelsetcols', 'conkey', 'owner_row_key']],
    ['verify_0007.sql', ['confdelsetcols', 'conkey', 'owner_row_key']],
    // Viittaamattomat taulut: väite on "viitteitä ei ole".
    ['verify_0005.sql', ['confrelid', 'auth.uid()=id']],
    ['verify_0006.sql', ['confrelid', 'wellbeing_entries_unique_day']],
    ['verify_0008.sql', ['confrelid', 'ai_action_audit_confirmed_check']]
  ];

  for (const [varmistus, tarvittavat] of vaatimukset) {
    // KOODISTA, EI KOMMENTEISTA.
    //
    // Nama tarkistukset olivat aluksi pelkkia sisaltyvyystestejae koko
    // tiedostoon, ja mutaatiotesti paljasti ne tyhjiksi: kun
    // `aclexplode` poistettiin SQL:sta, sana jai kommenttiin joka
    // selittaa miksi se on siella — ja testi meni lapi. Kommentti ei
    // tarkista mitaan.
    const lahde = koodi(varmistus);
    for (const needle of tarvittavat) {
      assert.ok(lahde.includes(needle),
        `${varmistus}: omistajuusmallia ei todisteta — puuttuu ${needle}`);
    }
  }
});

/** Varmistuksen suorittava osa: kommenttirivit pois. */
function koodi(varmistus) {
  return read(`supabase/verify/${varmistus}`).split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE);
}

test('KRIITTINEN: rakennetarkistuksia on oikea maara, ei vain yksi nayte', () => {
  // Sisaltyvyystesti ei riita: varmistuksessa voi olla kaksi
  // omistajuustarkistusta, joista toinen menettaa rakenne-ehtonsa.
  // Silloin sana esiintyy yha, mutta toinen tarkistus ei enaa todista
  // mitaan. Mutaatiotesti paljasti tasmalleen taman.
  //
  // Luvut vastaavat migraatioiden yhdistelmavierasavainryhmia:
  //   0004  kaksi tarkistusta — viisi ehdotonta viitetta (12) ja
  //         rutiinin ehdollinen viite (13)
  //   0007  yksi tarkistus — laskun kaksi viitetta samassa (12)
  // Jos ryhmien maara muuttuu, tama kaatuu, ja se on oikea hetki
  // tarkistaa etta jokainen ryhma yha luetaan katalogista.
  const odotukset = [
    // [tiedosto, conkey-ehtoja, confdelsetcols-pituusehtoja]
    ['verify_0004.sql', 2, 2],
    ['verify_0007.sql', 1, 1]
  ];

  for (const [varmistus, conkeyja, setcolseja] of odotukset) {
    const lahde = koodi(varmistus);

    assert.equal(
      lahde.split('array_length(con.conkey, 1) = 2').length - 1, conkeyja,
      `${varmistus}: yhdistelmavierasavaimen sarakemaaraa ei tarkisteta joka kohdassa`);

    assert.equal(
      lahde.split('array_length(con.confdelsetcols, 1) = 1').length - 1, setcolseja,
      `${varmistus}: poistossa nollattavia sarakkeita ei rajata joka kohdassa`);
  }

  // Ja jokaisessa varmistuksessa on tasan yksi PUBLIC-oikeuslistan
  // tarkistus. Nolla tarkoittaisi, ettei perittya oikeutta nahda
  // lainkaan.
  for (const numero of ['0004', '0005', '0006', '0007', '0008']) {
    const lahde = koodi(`verify_${numero}.sql`);
    assert.equal(lahde.split('aclexplode').length - 1, 1,
      `verify_${numero}.sql: PUBLIC-oikeuslistan tarkistuksia ei ole tasan yhta`);
  }
});

test('KRIITTINEN: varmistukset tarkistavat molemmat politiikan puolet', () => {
  // USING ratkaisee mitä riviä saa muokata, WITH CHECK mihin sen saa
  // muuttaa. Jos vain USING tarkistettaisiin, käyttäjä voisi ottaa oman
  // rivinsä ja kirjoittaa sen toisen nimiin — eikä varmistus huomaisi.
  for (const numero of ['0004', '0005', '0006', '0007', '0008']) {
    const lahde = koodi(`verify_${numero}.sql`);

    assert.ok(lahde.includes('p.qual') && lahde.includes('p.with_check'),
      `verify_${numero}.sql: ei vertaa politiikan molempia puolia`);
    assert.ok(lahde.includes("roles = '{authenticated}'::name[]"),
      `verify_${numero}.sql: ei tarkista, mille roolille politiikka on`);
  }
});

test('KRIITTINEN: varmistukset todistavat PUBLIC-roolin kahdella menetelmällä', () => {
  // has_table_privilege kertoo ONKO oikeus (perintä mukaan lukien),
  // aclexplode kertoo MISTÄ se tulee. PUBLICille myönnetty oikeus ei näy
  // roolikohtaisissa listauksissa lainkaan, joten pelkkä
  // has_table_privilege('anon', ...) ei riitä.
  for (const numero of ['0004', '0005', '0006', '0007', '0008']) {
    const lahde = koodi(`verify_${numero}.sql`);

    assert.ok(lahde.includes('aclexplode'),
      `verify_${numero}.sql: ei katso taulun oikeuslistaa`);
    assert.ok(lahde.includes('acl.grantee = 0'),
      `verify_${numero}.sql: ei etsi PUBLIC-roolia oikeuslistasta`);
    assert.ok(lahde.includes("has_table_privilege('anon'"),
      `verify_${numero}.sql: ei tarkista anon-roolin tehollisia oikeuksia`);
  }
});


// =====================================================================
// PREFLIGHTIEN OBJEKTILISTAT VASTAAVAT MIGRAATIOITA
// =====================================================================
//
// Preflight vastaa kysymykseen "onko tämä migraatio jo ajettu tai jäänyt
// kesken" laskemalla sen objektit. Jos lista on vajaa, preflight
// raportoi PASSin puolittain ajetusta migraatiosta — ja se on pahempi
// kuin ei preflightia lainkaan, koska se antaa väärän varmuuden.
//
// Sama vika oli jo kerran: kahdeksan tiedostoa tarkisti nimillä
// `ai_audit` ja `wellbeing`, kun oikeat nimet ovat `ai_action_audit` ja
// `wellbeing_entries`. Tarkistukset olisivat menneet läpi vaikka
// migraatio olisi ajettu.
//
// Nämä testit lukevat odotetut nimet migraatiosta, joten objektin
// lisääminen tai uudelleennimeäminen kaataa preflightin samassa
// commitissa jossa muutos tehdään.

/** Yhden migraation luomat objektit ryhmiteltyinä. */
function migraationObjektit(tiedosto) {
  const koodi = sql(tiedosto).split(`${NEWLINE}commit;`)[0]
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE);

  const kaikki = hahmo => [...koodi.matchAll(hahmo)].map(m => m[1]);

  return {
    tablename:  kaikki(/create table public\.(\w+)/g),
    column_name: kaikki(/add column (\w+)/g),
    conname: [...kaikki(/add constraint (\w+)/g),
              ...kaikki(/^\s+constraint (\w+)/gm)],
    indexname:  kaikki(/create index (\w+)/g),
    tgname:     kaikki(/create trigger (\w+)/g),
    policyname: kaikki(/create policy (\w+)/g)
  };
}

/**
 * Preflightin nimilista annetulle katalogisarakkeelle.
 *
 * Haku ANKKUROIDAAN migraation omaan tarkistukseen. Ilman ankkuria haku
 * osui ensimmäiseen `tablename in (...)` -kohtaan, joka on migraation
 * 0001 politiikkatarkistus ('tasks', 'profile') — ja testi väitti
 * preflightin listan olevan väärä, vaikka se luki eri tarkistusta.
 *
 * Ankkuri on se, mitä tarkistus VÄITTÄÄ, ei se mitä sarakenimeä se
 * sattuu käyttämään.
 */
function preflightinLista(preflight, sarake) {
  const rivit = read(`supabase/preflight/${preflight}`).split(NEWLINE);

  for (let i = 0; i < rivit.length; i += 1) {
    if (!/Migraation \w+ ei ole viela/.test(rivit[i])) continue;

    // Tarkistus jatkuu seuraavaan tyhjään riviin asti.
    let lohko = '';
    for (let j = i + 1; j < rivit.length && rivit[j].trim() !== ''; j += 1) {
      lohko += rivit[j] + NEWLINE;
    }
    if (!lohko.includes(`${sarake} in (`)) continue;

    // Vain listan sisältö, ei sitä edeltävä `schemaname = 'public'`.
    const listasta = lohko.slice(lohko.indexOf(`${sarake} in (`));
    return [...listasta.matchAll(/'(\w+)'/g)].map(m => m[1]);
  }
  return null;
}

test('KRIITTINEN: preflightien objektilistat vastaavat migraatioita', () => {
  const parit = [
    ['0004_goals_projects.sql',           'preflight_0004.sql'],
    ['0005_notification_preferences.sql', 'preflight_0005.sql'],
    ['0006_wellbeing.sql',                'preflight_0006.sql'],
    ['0007_finance.sql',                  'preflight_0007.sql'],
    ['0008_ai_audit.sql',                 'preflight_0008.sql']
  ];

  for (const [migraatio, preflight] of parit) {
    const objektit = migraationObjektit(migraatio);

    for (const [sarake, odotetut] of Object.entries(objektit)) {
      if (odotetut.length === 0) continue;

      const listassa = preflightinLista(preflight, sarake);
      assert.ok(listassa,
        `${preflight}: sarakkeelle ${sarake} ei ole nimilistaa,`
        + ` vaikka migraatio luo ${odotetut.length} objektia`);

      const puuttuu = odotetut.filter(n => !listassa.includes(n));
      assert.deepEqual(puuttuu, [],
        `${preflight}: ${sarake}-listasta puuttuu ${puuttuu.join(', ')}`
        + ' — preflight raportoisi PASSin puolittain ajetusta migraatiosta');

      const yli = listassa.filter(n => !odotetut.includes(n));
      assert.deepEqual(yli, [],
        `${preflight}: ${sarake}-lista sisältää nimiä joita migraatio ei luo:`
        + ` ${yli.join(', ')}`);
    }
  }
});

test('KRIITTINEN: eräpreflight kattaa kaikkien viiden migraation objektit', () => {
  // Eräpreflight ajetaan kerran ennen koko erää. Sen on nähtävä jokainen
  // objekti, jonka erä luo — muuten se ilmoittaisi puhtaan lähtötilan
  // vaikka jokin migraatio olisi jo ajettu.
  const batch = read('supabase/preflight/preflight_0004_0008_batch.sql');

  const kaikki = { conname: [], indexname: [], tgname: [] };
  for (const name of migrationFiles().filter(n => /^000[4-8]/.test(n))) {
    const objektit = migraationObjektit(name);
    kaikki.conname.push(...objektit.conname);
    kaikki.indexname.push(...objektit.indexname);
    kaikki.tgname.push(...objektit.tgname);
  }

  // Erä luo 46 rajoitetta, 10 indeksiä ja 7 liipaisinta. Luvut ovat
  // tässä siksi, että lista voisi olla oikea ja silti tyhjä, jos hahmo
  // ei osuisi mihinkään.
  assert.equal(kaikki.conname.length, 46, 'rajoitteiden määrä muuttui');
  assert.equal(kaikki.indexname.length, 10, 'indeksien määrä muuttui');
  assert.equal(kaikki.tgname.length, 7, 'liipaisinten määrä muuttui');

  for (const [sarake, nimet] of Object.entries(kaikki)) {
    for (const nimi of nimet) {
      assert.ok(batch.includes(`'${nimi}'`),
        `eräpreflightista puuttuu ${sarake} ${nimi}`);
    }
  }
});

test('KRIITTINEN: preflightit tarkistavat sen mitä migraatio vaatii', () => {
  // Migraatiot 0004 ja 0007 käyttävät PostgreSQL 15:n sarakekohtaista
  // ON DELETE SET NULL -muotoa ja koskevat tuotannon tasks-tauluun.
  // Preflightin pitää kertoa se ENNEN ajoa, ei migraation kesken ajon.
  for (const numero of ['0004', '0007']) {
    const lahde = read(`supabase/preflight/preflight_${numero}.sql`);

    assert.ok(lahde.includes('server_version_num'),
      `preflight_${numero}.sql: ei tarkista palvelimen versiota,`
      + ' vaikka migraatio vaatii PostgreSQL 15:n');
    assert.ok(lahde.includes("column_name = 'user_id' and is_nullable = 'NO'"),
      `preflight_${numero}.sql: ei tarkista, että tasks.user_id on NOT NULL`
      + ' — MATCH SIMPLE ohittaisi yhdistelmävierasavaimen tarkistuksen');
  }

  // 0007 lisää rajoitteen unique (user_id, id) tuotannon tasks-tauluun.
  // Se ei voi kaatua dataan, mutta oletus on todistettava eikä uskottava.
  assert.ok(read('supabase/preflight/preflight_0007.sql')
    .includes('group by user_id, id having count(*) > 1'),
    'preflight_0007.sql: ei todista, että tasks_owner_row_key voi syntyä');

  // Jokaisen preflightin on nähtävä lukkoesteet: migraatiot ottavat
  // lukkoja tauluihin, joita jokainen kirjautuminen koskee.
  for (const numero of ['0004', '0005', '0006', '0007', '0008']) {
    const lahde = read(`supabase/preflight/preflight_${numero}.sql`);
    assert.ok(lahde.includes('idle in transaction'),
      `preflight_${numero}.sql: ei havaitse avointa transaktiota`);
    assert.ok(lahde.includes('pg_locks'),
      `preflight_${numero}.sql: ei havaitse odottavia lukkoja`);
  }
});


// =====================================================================
// SOVELLUKSEN JA KANNAN SARAKESOPIMUS (kaikki kahdeksan porttia)
// =====================================================================
//
// MITÄ TÄMÄ VARTIOI
//
// Repositorion `toRow` päättää, mitä sarakkeita selain lähettää. Kanta
// päättää, mitä sarakkeita on olemassa. Näiden kahden välissä ei ole
// mitään, joka huomaisi eron ennen ajoa:
//
//   * Sarake, jota migraatio luo mutta repositorio ei kirjoita, jää
//     hiljaa oletusarvoonsa. Käyttäjä täyttää kentän, kenttä katoaa.
//   * Sarake, jota repositorio kirjoittaa mutta migraatio ei luo,
//     kaataa jokaisen tallennuksen virheeseen PGRST204 — mutta vasta
//     kun lippu on käännetty tuotannossa.
//
// Kolmas ja pahin: palvelimen omistama sarake, jonka selain lähettää.
// `user_id` asiakkaan valitsemana tekisi RLS:stä koristeen. Sitä vastaan
// on ajonaikainen vahti (assertClientSafe), mutta se on halvempi huomata
// tässä.
//
// Nämä testit eivät ota yhteyttä tietokantaan. Ne lukevat migraation
// tekstinä ja kutsuvat repositorion muunnosta.

/** Palvelimen omistamat sarakkeet: kanta asettaa, selain ei koskaan. */
const PALVELIMEN_OMAT = ['user_id', 'created_at', 'updated_at'];

/**
 * Portti -> repositorio, migraatio, taulu ja kelvollinen esimerkkirivi.
 *
 * Esimerkki on domain-muotoinen ja se ajetaan repositorion oman
 * normalisoinnin läpi. Se ei siis testaa sitä, mitä minä luulen
 * kentiksi, vaan sitä mitä sovellus oikeasti kirjoittaa.
 */
const SOPIMUKSET = [
  ['routines', 'routines', '0003_routines.sql', {
    id: 'r1', title: 'Aamulenkki', recurrence: { type: 'daily', weekdays: [] }
  }],
  ['routineExceptions', 'routine_exceptions', '0003_routines.sql', {
    id: 'e1', routineId: 'r1', date: '2026-09-07', type: 'skip'
  }],
  ['goals', 'goals', '0004_goals_projects.sql', {
    id: 'g1', title: 'Opettele kitaransoittoa'
  }],
  ['projects', 'projects', '0004_goals_projects.sql', {
    id: 'p1', name: 'Kotisivut'
  }],
  ['wellbeing', 'wellbeing_entries', '0006_wellbeing.sql', {
    id: 'w1', date: '2026-09-07', energy: 3, mood: 4
  }],
  ['bills', 'bills', '0007_finance.sql', {
    id: 'b1', name: 'Vuokra', amountMinor: 95000, dueDate: '2026-10-01'
  }],
  ['recurringExpenses', 'recurring_expenses', '0007_finance.sql', {
    id: 'x1', name: 'Netti', amountMinor: 3990, nextDueDate: '2026-10-01'
  }],
  ['savingsGoals', 'savings_goals', '0007_finance.sql', {
    id: 's1', name: 'Puskuri', targetMinor: 300000
  }],
  ['aiAudit', 'ai_action_audit', '0008_ai_audit.sql', {
    id: 'a1', intent: 'create_task', risk: 'medium'
  }]
];

/**
 * Taydet esimerkit kattavuustestia varten.
 *
 * SOPIMUKSET-taulukon esimerkit ovat MINIMEJA: vain pakolliset kentat.
 * Ne sopivat sen todistamiseen, ettei tyhja kentta paady kantaan
 * nullina.
 *
 * Kattavuutta ("kirjoittaako joku jokaista saraketta") ei voi mitata
 * minimilla: valinnainen kentta jaa pois, ja sarake nayttaisi
 * kytkemattomalta vaikka se on kytketty. Siksi naissa on jokainen
 * kentta taytettyna.
 *
 * Portit, joita ei mainita, kayttavat minimiaan sellaisenaan.
 */
const TAYDET = {
  aiAudit: {
    id: 'a1', timestamp: '2026-09-07T12:00:00.000Z', intent: 'create_task',
    risk: 'medium', inputSummary: 'tiivistelma', targetType: 'task',
    targetId: 't1', proposal: 'ehdotus', confirmed: true, executed: true,
    result: 'executed', errorCode: null
  }
};

/** Portin taysi esimerkki, tai minimi jos taytta ei ole maaritelty. */
function taysiEsimerkki(portti, minimi) {
  return TAYDET[portti] ?? minimi;
}

/** Repositorio portin nimellä. */
async function repositorio(portti) {
  const moduuli = await import('../src/data/collectionsRepo.js');
  const nimet = {
    routines: 'routinesRepo', routineExceptions: 'routineExceptionsRepo',
    goals: 'goalsRepo', projects: 'projectsRepo', wellbeing: 'wellbeingRepo',
    bills: 'billsRepo', recurringExpenses: 'recurringExpensesRepo',
    savingsGoals: 'savingsGoalsRepo', aiAudit: 'aiAuditRepo'
  };
  const repo = moduuli[nimet[portti]];
  assert.ok(repo, `repositoriota ${nimet[portti]} ei ole`);
  return repo;
}

/** Migraation luoman taulun sarakkeet. */
function taulunSarakkeet(migraatio, taulu) {
  const luonti = new RegExp(`create table public\\.${taulu} \\(([\\s\\S]*?)\\n\\);`)
    .exec(read(`${MIGRATION_DIR}/${migraatio}`));
  assert.ok(luonti, `${taulu}: create table ei löytynyt tiedostosta ${migraatio}`);

  const luodut = luonti[1].split(NEWLINE)
    .map(line => /^ {2}(\w+)\s+\S/.exec(line))
    .filter(Boolean)
    .map(m => m[1])
    .filter(nimi => nimi !== 'constraint' && nimi !== 'foreign');

  // Myöhemmät migraatiot lisäävät sarakkeita olemassa oleviin tauluihin
  // (0009: bills.payee/iban/reference). Ne kuuluvat tauluun yhtä lailla;
  // sarakeportti ja migraation ajotila vartioidaan omissa testeissään.
  const lisatyt = migrationFiles()
    .flatMap(tiedosto => [...read(`${MIGRATION_DIR}/${tiedosto}`)
      .matchAll(new RegExp(`alter table public\\.${taulu} add column (\\w+)`, 'g'))]
      .map(m => m[1]));
  return [...luodut, ...lisatyt];
}

test('KRIITTINEN: repositorio ei kirjoita saraketta jota kanta ei luo', async () => {
  // Tämä olisi PGRST204 jokaisessa tallennuksessa — mutta vasta kun
  // lippu on käännetty tuotannossa, eli juuri silloin kun sitä ei enää
  // haluta huomata.
  for (const [portti, taulu, migraatio, esimerkki] of SOPIMUKSET) {
    const repo = await repositorio(portti);
    const kirjoitetut = Object.keys(repo.mapping.toRow(repo.mapping.normalize(esimerkki)));
    const kannassa = taulunSarakkeet(migraatio, taulu);

    for (const sarake of kirjoitetut) {
      assert.ok(kannassa.includes(sarake),
        `${portti}: repositorio kirjoittaa sarakkeeseen ${sarake},`
        + ` jota ${migraatio} ei luo tauluun ${taulu}`);
    }
  }
});

test('KRIITTINEN: repositorio ei lähetä palvelimen omistamia sarakkeita', async () => {
  // user_id asiakkaan valitsemana tekisi RLS:stä koristeen: rivin
  // omistajan päättäisi se, joka rivin lähettää.
  for (const [portti, , , esimerkki] of SOPIMUKSET) {
    const repo = await repositorio(portti);
    const kirjoitetut = Object.keys(repo.mapping.toRow(repo.mapping.normalize(esimerkki)));

    for (const kielletty of PALVELIMEN_OMAT) {
      assert.equal(kirjoitetut.includes(kielletty), false,
        `${portti}: repositorio lähettää palvelimen omistaman sarakkeen ${kielletty}`);
    }
  }
});

test('KRIITTINEN: kannan sarakkeet = kirjoitetut + palvelimen omat', async () => {
  // Riippumaton tapa laskea sama luku. Jos migraatio saisi uuden
  // sarakkeen jota sovellus ei kirjoita eikä palvelin omista, tämä
  // kaatuu — ja se on oikea hetki huomata, ettei kenttää ole kytketty
  // mihinkään. Sarake, jota kukaan ei kirjoita, on kenttä jonka käyttäjä
  // täyttää turhaan.
  //
  // notification_preferences ei ole listassa: sen omistaja on pääavain
  // itse, joten sillä ei ole user_id-saraketta eikä sama laskenta päde.
  // Se testataan erikseen alla.
  for (const [portti, taulu, migraatio, minimi] of SOPIMUKSET) {
    const repo = await repositorio(portti);
    const esimerkki = taysiEsimerkki(portti, minimi);
    const kirjoitetut = Object.keys(repo.mapping.toRow(repo.mapping.normalize(esimerkki)));
    const kannassa = taulunSarakkeet(migraatio, taulu);

    const kytkematta = kannassa
      .filter(s => !kirjoitetut.includes(s) && !PALVELIMEN_OMAT.includes(s));

    assert.deepEqual(kytkematta, [],
      `${portti}: taulussa ${taulu} on sarakkeita joita kukaan ei kirjoita:`
      + ` ${kytkematta.join(', ')}`);
  }
});

/** Taulun NOT NULL -sarakkeet migraation create table -lauseesta. */
function pakollisetSarakkeet(migraatio, taulu) {
  const luonti = new RegExp(`create table public\\.${taulu} \\(([\\s\\S]*?)\\n\\);`)
    .exec(read(`${MIGRATION_DIR}/${migraatio}`));
  assert.ok(luonti, `${taulu}: create table ei löytynyt tiedostosta ${migraatio}`);

  return luonti[1].split(NEWLINE)
    .map(line => /^ {2}(\w+)\s+.*not null/.exec(line))
    .filter(Boolean)
    .map(m => m[1]);
}

test('KRIITTINEN: repositorio ei lähetä nullia NOT NULL -sarakkeeseen', async () => {
  // LÖYTYNYT VIKA, JOTA TÄMÄ VARTIOI
  //
  // aiAuditRepo lähetti `occurred_at: null`, kun domainin timestamp oli
  // tyhjä. Sarake on `not null default now()`.
  //
  // Oletusarvo EI pelasta tätä. PostgreSQL käyttää oletusta vain kun
  // sarake JÄTETÄÄN POIS lauseesta; nimenomainen NULL on arvo, ja se
  // hylätään koodilla 23502. Jokainen kirjaus olisi siis kaatunut heti
  // kun aiAudit-portti avataan — eikä sitä olisi huomannut ennen sitä,
  // koska muistivarasto ei välitä NOT NULLista.
  //
  // Sama vika voi syntyä uudelleen missä tahansa taulussa, jossa on
  // NOT NULL -sarake ja oletus. Siksi sääntö on yleinen: jos kenttä on
  // tyhjä, se jätetään pois — ei lähetetä nullina.
  for (const [portti, taulu, migraatio, esimerkki] of SOPIMUKSET) {
    const repo = await repositorio(portti);
    const rivi = repo.mapping.toRow(repo.mapping.normalize(esimerkki));
    const pakolliset = pakollisetSarakkeet(migraatio, taulu);

    for (const [sarake, arvo] of Object.entries(rivi)) {
      if (arvo !== null) continue;
      assert.equal(pakolliset.includes(sarake), false,
        `${portti}: lähettää nullin NOT NULL -sarakkeeseen ${sarake}`
        + ' — kanta hylkäisi rivin koodilla 23502, eikä oletusarvo pelasta');
    }
  }
});

test('KRIITTINEN: paluumuunnos lukee jokaisen kirjoitetun sarakkeen', async () => {
  // Kirjoitettu mutta lukematon sarake on hiljainen tiedonhukka:
  // tallennus onnistuu, lataus palauttaa tyhjän, eikä mikään kaadu.
  // Käyttäjälle se näyttää siltä että kenttä ei tallennu.
  for (const [portti, , , minimi] of SOPIMUKSET) {
    const repo = await repositorio(portti);
    const kirjoitetut = Object.keys(
      repo.mapping.toRow(repo.mapping.normalize(taysiEsimerkki(portti, minimi))));

    // Rakennetaan kannan rivi ja katsotaan, mitkä kentät fromRow lukee.
    const luetut = new Set();
    const vakoiltuRivi = new Proxy({}, {
      get(_, avain) {
        if (typeof avain === 'string') luetut.add(avain);
        return undefined;
      },
      has: () => true
    });
    repo.mapping.fromRow(vakoiltuRivi);

    for (const sarake of kirjoitetut) {
      assert.ok(luetut.has(sarake),
        `${portti}: sarake ${sarake} kirjoitetaan mutta fromRow ei lue sitä`
        + ' — tallennus onnistuisi ja lataus palauttaisi tyhjän');
    }
  }
});

test('KRIITTINEN: muistivarasto ja kanta normalisoivat saman tavalla', async () => {
  // Portin takana data on muistissa. Kun portti avataan, sama data
  // kulkee kannan kautta. Jos normalisointi eroaa, käyttäjän rivit
  // muuttuvat sinä hetkenä kun lippu käännetään — eikä siitä jää
  // jälkeä mihinkään.
  for (const [portti, , , esimerkki] of SOPIMUKSET) {
    const repo = await repositorio(portti);
    const suora = repo.mapping.normalize(esimerkki);
    const kannanKautta = repo.mapping.fromRow(repo.mapping.toRow(suora));

    // Palvelimen omistamat kentät eivät kulje mukana, joten niitä ei
    // verrata: kanta täyttää ne.
    for (const avain of Object.keys(suora)) {
      if (['createdAt', 'updatedAt', 'userId'].includes(avain)) continue;
      assert.deepEqual(kannanKautta[avain], suora[avain],
        `${portti}: kenttä ${avain} muuttuu kannan kautta kulkiessaan`);
    }
  }
});

test('KRIITTINEN: muistutusasetusten sopimus (paaavain on omistaja)', async () => {
  // notification_preferences on ainoa taulu, jonka omistaja on paaavain
  // itse. Siksi sen sopimus on ERI kuin muiden, ja tama testi kirjoitti
  // sen aluksi vaarin: se vaati, ettei `id` kulje selaimesta.
  //
  // Se vaatimus oli vaara. Muissa tauluissa omistajan asettaa kanta
  // (`user_id ... default auth.uid()`), koska rivilla on erillinen
  // paaavain johon upsert kohdistuu. Tassa taulussa niita ei ole kahta:
  // upsert TARVITSEE kohteen, ja kohde on omistaja.
  //
  // Se ei ole aukko. Politiikka `with check (auth.uid() = id)` hylkaa
  // jokaisen rivin, jonka id ei ole kirjoittaja itse — eli selain saa
  // kertoa kuka se on, muttei valehdella siita. Tama testi todistaa,
  // etta ainoa selaimesta tuleva omistajuuskentta on juuri se ja etta
  // se tulee istunnosta, ei syotteesta.
  const { preferencesToRow, preferencesFromRow } =
    await import('../src/data/notificationPrefsRepo.js');
  const { DEFAULT_PREFERENCES } = await import('../src/domain/notification.js');

  const istunnonKayttaja = '2cc00622-f927-4604-a518-361a4328481b';
  const rivi = preferencesToRow(DEFAULT_PREFERENCES, istunnonKayttaja);
  const kirjoitetut = Object.keys(rivi);
  const kannassa = taulunSarakkeet('0005_notification_preferences.sql',
                                   'notification_preferences');

  // 1. Jokainen kirjoitettu sarake on olemassa kannassa.
  for (const sarake of kirjoitetut) {
    assert.ok(kannassa.includes(sarake),
      `muistutusasetukset: kirjoitetaan saraketta ${sarake}, jota migraatio ei luo`);
  }

  // 2. Palvelimen aikaleimoja ei laheteta koskaan.
  for (const kielletty of ['created_at', 'updated_at']) {
    assert.equal(kirjoitetut.includes(kielletty), false,
      `muistutusasetukset: lahetetaan palvelimen omistama sarake ${kielletty}`);
  }

  // 3. Omistajuuskenttia on TASAN YKSI ja se on istunnon kayttaja.
  //    Jos taulussa olisi myos user_id, kannassa olisi kaksi
  //    omistajakasitetta ja politiikat rajaisivat vain toista.
  assert.equal(rivi.id, istunnonKayttaja,
    'muistutusasetukset: id ei tule istunnosta');
  assert.equal(kirjoitetut.includes('user_id'), false,
    'muistutusasetukset: lahetetaan user_id, jota taulussa ei ole');

  // 4. Omistajuus ei tule syotteesta. Jos kayttaja lahettaisi oman
  //    id:n asetusoliossa, sen ei saa paatya riville.
  const vaarennos = preferencesToRow(
    { ...DEFAULT_PREFERENCES, id: 'toisen-kayttajan-id' }, istunnonKayttaja);
  assert.equal(vaarennos.id, istunnonKayttaja,
    'muistutusasetukset: syotteen id ohittaa istunnon — omistajuuden voisi vaarentaa');

  // 5. Yhtaan saraketta ei jaa kytkematta.
  const kytkematta = kannassa.filter(
    s => !kirjoitetut.includes(s) && !['created_at', 'updated_at'].includes(s));
  assert.deepEqual(kytkematta, [],
    `muistutusasetukset: kytkemattomia sarakkeita: ${kytkematta.join(', ')}`);

  // 6. Paluumuunnos lukee jokaisen kirjoitetun sarakkeen. Kirjoitettu
  //    mutta lukematon sarake on hiljainen tiedonhukka: tallennus
  //    onnistuu, lataus palauttaa oletuksen.
  const luetut = new Set();
  preferencesFromRow(new Proxy({}, {
    get(_, avain) { if (typeof avain === 'string') luetut.add(avain); return undefined; },
    has: () => true
  }));
  for (const sarake of kirjoitetut) {
    if (sarake === 'id') continue;  // id on kohde, ei ladattava arvo
    assert.ok(luetut.has(sarake),
      `muistutusasetukset: sarake ${sarake} kirjoitetaan mutta fromRow ei lue sita`);
  }
});

test('KRIITTINEN: yksikaan portti ei ole auki ilman aaltoa', async () => {
  // Portti avataan vasta kun migraatio on ajettu, varmistus on vihrea
  // ja hyvaksyntatesti on ajettu oikealla kayttajalla B. Aallon
  // ulkopuolella avattu portti tarkoittaa, ettei mikaan noista ehdoista
  // ole todennettu tuon portin osalta.
  const { TABLES } = await import('../src/data/schema.js');
  const { resolveWave, cumulativeGates, ALL_GATES } =
    await import('../tools/release/waves.mjs');

  const aalto = resolveWave(TABLES);
  assert.ok(aalto !== null, 'porttimatriisi ei vastaa yhtakaan aaltoa');

  const sallitut = new Set(aalto === 'BASE' ? [] : cumulativeGates(aalto));
  for (const portti of ALL_GATES) {
    if (TABLES[portti] === true) {
      assert.ok(sallitut.has(portti),
        `portti ${portti} on auki, mutta se ei kuulu aaltoon ${aalto}`);
    }
  }
});


// =====================================================================
// ERÄN LOPPUVARMISTUS JA HYVÄKSYNNÄN JÄLKEINEN VARMISTUS
// =====================================================================
//
// Loppuvarmistuksen luvut ovat kokonaislukuja koko skeemasta: kymmenen
// taulua, 40 politiikkaa, yhdeksän viitettä. Käsin laskettuina ne
// vanhenevat ensimmäisessä muutoksessa, ja vanhentunut odotusarvo
// pysäyttää tuotannon varmistuksen vaikka kanta olisi oikein — juuri
// niin kävi migraation 0003 varmistuksessa.
//
// Siksi nämä testit laskevat samat luvut migraatioista ja vertaavat
// niitä varmistustiedoston odotusarvoihin.

/** Migraatioiden 0003–0008 luomat objektit koko erästä. */
function eranObjektit() {
  const kaikki = {
    taulut: [], politiikat: [], liipaisimet: [],
    viitteet: [], omistajaAvaimet: [], uidOletukset: [], userIdNotNull: []
  };

  // VAIN 0003-0008. Migraatiot 0001 ja 0002 loivat tasks- ja
  // profile-taulujen politiikat ja tasks-taulun liipaisimen; ne ovat
  // tuotannon hyvaksytty lahtotila eivatka taman eran objekteja.
  //
  // Ilman rajausta politiikkoja loytyi 48 (40 + 8), ja luku olisi
  // nayttanyt siltae kuin loppuvarmistus odottaisi liian vahan.
  for (const name of migrationFiles().filter(nimi => /^000[3-8]/.test(nimi))) {
    const lahde = sql(name).split(`${NEWLINE}commit;`)[0]
      .split(NEWLINE)
      .filter(line => !line.trim().startsWith('--'))
      .join(NEWLINE);

    for (const m of lahde.matchAll(/create table public\.(\w+)/g)) {
      kaikki.taulut.push(m[1]);
    }
    for (const m of lahde.matchAll(/create policy (\w+)/g)) {
      kaikki.politiikat.push(m[1]);
    }
    for (const m of lahde.matchAll(/create trigger (\w+)/g)) {
      kaikki.liipaisimet.push(m[1]);
    }
    for (const m of lahde.matchAll(
      /foreign key \(user_id,\s*(\w+)\)\s*references public\.(\w+)\s*\(user_id,\s*id\)\s*([^;]*);/g)) {
      kaikki.viitteet.push({ column: m[1], parent: m[2], toiminto: m[3] });
    }
    for (const m of lahde.matchAll(/constraint (\w+_owner_row_key) unique \(user_id, id\)/g)) {
      kaikki.omistajaAvaimet.push(m[1]);
    }
    for (const m of lahde.matchAll(/create table public\.(\w+) \(([\s\S]*?)\n\);/g)) {
      const [, taulu, runko] = m;
      if (/auth\.uid\(\)/.test(runko)) kaikki.uidOletukset.push(taulu);
      if (/user_id\s+uuid not null/.test(runko)) kaikki.userIdNotNull.push(taulu);
    }
  }
  return kaikki;
}

/** Varmistuksen odotusarvo annetulle tarkistuksen nimelle. */
function loppuOdotus(osuma) {
  const lahde = read('supabase/verify/verify_0004_0008_final.sql');
  const osa = lahde.split('union all').find(pala => pala.includes(osuma));
  assert.ok(osa, `loppuvarmistuksesta ei löydy tarkistusta: ${osuma}`);
  const m = /',\s*'(\d+)',/.exec(osa);
  assert.ok(m, `odotusarvoa ei löytynyt: ${osuma}`);
  return Number(m[1]);
}

test('KRIITTINEN: loppuvarmistuksen luvut lasketaan migraatioista', () => {
  const objektit = eranObjektit();

  // Kymmenen porttitaulua: kaksi 0003:sta ja kahdeksan 0004-0008:sta.
  assert.equal(objektit.taulut.length, 10,
    `migraatiot luovat ${objektit.taulut.length} taulua, odotettiin 10`);
  assert.equal(loppuOdotus('RLS on paalla kaikissa kymmenessa taulussa'), 10);
  assert.equal(loppuOdotus('Kaikilla kymmenella taululla on nelja politiikkaa'),
    objektit.politiikat.length);

  // Neljä politiikkaa per taulu, ei enempää eikä vähempää.
  assert.equal(objektit.politiikat.length, objektit.taulut.length * 4,
    'jokaisella taululla ei ole neljää politiikkaa');

  // Yhdeksän omistajuusviitettä kolmessa migraatiossa.
  assert.equal(objektit.viitteet.length, 9,
    `migraatiot luovat ${objektit.viitteet.length} yhdistelmävierasavainta`);
  assert.equal(loppuOdotus('Yhdeksan omistajuuden yhdistelmavierasavainta'), 9);

  // Kahdeksan niistä on SET NULL, yksi CASCADE.
  const nollaavat = objektit.viitteet.filter(v => /on delete set null \(/.test(v.toiminto));
  const kaskadi = objektit.viitteet.filter(v => /on delete cascade/.test(v.toiminto));
  assert.equal(nollaavat.length, 8, 'nollaavien viitteiden määrä muuttui');
  assert.equal(kaskadi.length, 1, 'kaskadoivien viitteiden määrä muuttui');
  assert.equal(loppuOdotus('nollaavaa viitetta rajaa nollauksen sarakkeeseen'), 8);

  // Viisi omistajan rivin avainta ERÄSSÄ 0003-0008. Osa on omana
  // lauseenaan, osa taulun sisällä, joten molemmat muodot lasketaan.
  //
  // Rajaus on pakollinen: loppuvarmistus verify_0004_0008_final.sql
  // kattaa nimenomaan tämän erän, ja myöhempi migraatio voi tuoda
  // lisää avaimia rikkomatta mitään erässä.
  const avaimet = new Set(objektit.omistajaAvaimet);
  for (const name of migrationFiles().filter(nimi => /^000[3-8]/.test(nimi))) {
    for (const m of sql(name).matchAll(/add constraint (\w+_owner_row_key)/g)) {
      avaimet.add(m[1]);
    }
  }
  assert.equal(avaimet.size, 5,
    `omistajan rivin avaimia on ${avaimet.size}, odotettiin 5: ${[...avaimet].join(', ')}`);
  assert.equal(loppuOdotus('Viisi omistajan rivin avainta'), 5);

  // ERÄN ULKOPUOLISET AVAIMET LUETELLAAN NIMELTÄ.
  //
  // Rajaus yllä poistaisi muuten kanarialinnun: uusi omistajan rivin
  // avain missä tahansa migraatiossa menisi läpi huomaamatta. Tämä
  // pitää hälytyksen voimassa — uusi avain kaataa tämän, ja se on
  // oikea hetki tarkistaa, että myös sen oma varmistus kattaa sen.
  const eranUlkopuoliset = new Set();
  for (const name of migrationFiles().filter(nimi => !/^000[3-8]/.test(nimi))) {
    for (const m of sql(name).matchAll(/add constraint (\w+_owner_row_key)/g)) {
      eranUlkopuoliset.add(m[1]);
    }
  }
  assert.deepEqual([...eranUlkopuoliset].sort(),
    ['investments_owner_row_key', 'milestones_owner_row_key',
     'transactions_owner_row_key'],
    'erän ulkopuolisten omistajan rivin avainten joukko muuttui');

  // Yhdeksän liipaisinta erässä: jokaiselle taululle jolla on
  // updated_at. Pois jää ai_action_audit — kirjaus ei muutu
  // jälkikäteen. Kymmenes on tasks, jonka liipaisin syntyi jo
  // migraatiossa 0002 ja on tuotannossa.
  assert.equal(objektit.liipaisimet.length, 9,
    `erän liipaisimia on ${objektit.liipaisimet.length}, odotettiin 9`);
  assert.ok(sql('0002_task_domain_fields.sql').includes('create trigger tasks_touch_updated_at'),
    'tasks-taulun liipaisin ei ole enää migraatiossa 0002 — loppuvarmistuksen luku 10 vanhentui');
  assert.equal(loppuOdotus('updated_at-liipaisinta ajetaan ennen muutosta'), 10);

  // Kymmenen taulua, joissa omistajan asettaa kanta.
  assert.equal(objektit.uidOletukset.length, 10,
    `auth.uid()-oletuksia on ${objektit.uidOletukset.length}, odotettiin 10`);
  assert.equal(loppuOdotus('Omistajan asettaa kanta jokaisessa uudessa taulussa'), 10);

  // user_id NOT NULL yhdeksässä uudessa taulussa plus tasks = 10.
  assert.equal(objektit.userIdNotNull.length + 1, 10,
    'user_id NOT NULL -taulujen määrä muuttui');
  assert.equal(loppuOdotus('user_id on NOT NULL kaikissa kymmenessa taulussa'), 10);
});

test('KRIITTINEN: loppuvarmistus katsoo koko skeemaa, ei vain erän tauluja', () => {
  // Erän tauluihin rajattu tarkistus ei näkisi taulua, joka lisätään
  // myöhemmin ilman RLS:ää tai yhden sarakkeen viitteellä. Juuri
  // sellainen olisi hiljaisin tapa avata aukko: mikään olemassa oleva
  // tarkistus ei kohdistuisi siihen.
  const lahde = read('supabase/verify/verify_0004_0008_final.sql');

  const koodi = lahde.split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE);

  assert.ok(koodi.includes("relkind = 'r' and not relrowsecurity"),
    'loppuvarmistus ei etsi RLS:ttä tauluja koko skeemasta');
  assert.ok(koodi.includes("cl.relnamespace = 'public'::regnamespace")
    && koodi.includes('acl.grantee = 0'),
    'loppuvarmistus ei etsi PUBLIC-oikeuksia koko skeemasta');
  // KAKSI ERI TARKISTUSTA, KAKSI ERI VAITETTA.
  //
  //   1. touch_updated_at on SECURITY INVOKER  (prosecdef = false)
  //   2. public-skeemassa ei ole yhtaan SECURITY DEFINER -funktiota
  //
  // Pelkka sisaltyvyystesti meni lapi, kun jalkimmainen neutraloitiin:
  // sana jai ensimmaiseen. Siksi esiintymat lasketaan.
  assert.equal(koodi.split('prosecdef').length - 1, 2,
    'loppuvarmistuksesta puuttuu toinen SECURITY DEFINER -tarkistus');
});

test('KRIITTINEN: hyväksynnän jälkeinen varmistus kattaa jokaisen viitteen', () => {
  // Selaimessa ajettu testi katsoo kantaa RLS:n läpi eikä voi nähdä,
  // jäikö toisen tilin rivi kantaan. Tämä tiedosto on ainoa paikka
  // josta ristiinkiinnityksen jäännöksen voi nähdä — ja siksi sen on
  // katettava jokainen viite, ei otos.
  const lahde = read('supabase/acceptance/verify_0003_0008_acceptance.sql');
  const viitteet = eranObjektit().viitteet;

  assert.equal(viitteet.length, 9, 'viitteiden määrä muuttui');

  // Sisältyvyystesti ei riitä: jos yhden tarkistuksen ehto
  // neutraloidaan, sarakkeen nimi jää silti liitosehtoon ja testi
  // menisi läpi. Mutaatiotesti paljasti tämän.
  //
  // Siksi jokainen eheystarkistus luetaan omana lohkonaan, ja siltä
  // vaaditaan molemmat osat: liitos omistajalla (user_id) ja orvon
  // etsintä (is null). Kumpikaan yksin ei todista mitään — liitos ilman
  // orpoehtoa ei löydä mitään, ja orpoehto ilman omistajaliitosta
  // löytäisi vain puuttuvat rivit, ei väärälle omistajalle kuuluvia.
  const eheysLohkot = lahde.split('union all')
    .filter(lohko => lohko.includes("'eheys'") && lohko.includes('kiinnitetty'));

  assert.equal(eheysLohkot.length, viitteet.length,
    `eheystarkistuksia on ${eheysLohkot.length}, viitteitä ${viitteet.length}`);

  for (const lohko of eheysLohkot) {
    const nimi = /'(Yhtaan[^']*)'/.exec(lohko);
    assert.ok(lohko.includes('user_id'),
      `eheystarkistus ei rajaa omistajalla: ${nimi ? nimi[1] : lohko.slice(0, 60)}`);
    assert.ok(lohko.includes('is null'),
      `eheystarkistus ei etsi orpoa: ${nimi ? nimi[1] : lohko.slice(0, 60)}`);
  }

  for (const { column } of viitteet) {
    assert.ok(eheysLohkot.some(lohko => lohko.includes(column)),
      `hyväksynnän varmistus ei tarkista viitettä ${column}`);
  }

  // Ja jokainen porttitaulu on mukana jäännöstarkistuksessa.
  for (const taulu of eranObjektit().taulut) {
    assert.ok(lahde.includes(`public.${taulu}`),
      `hyväksynnän varmistus ei tarkista taulua ${taulu}`);
  }
});

test('KRIITTINEN: hyväksynnän varmistus etsii jäännöstä kahdella tavalla', () => {
  // Rivimäärä ja etuliite ovat eri väitteitä. Rivimäärä kertoo, onko
  // taulussa mitään; etuliite kertoo, onko se nimenomaan tämän testin
  // jäännös. Kumpikin tarvitaan: pelkkä rivimäärä ei erottaisi
  // jäännöstä oikeasta datasta, ja pelkkä etuliite ei löytäisi
  // muistutusasetuksia, joiden tunniste on käyttäjän uuid.
  const lahde = read('supabase/acceptance/verify_0003_0008_acceptance.sql');

  assert.ok(lahde.includes("like 'manifestival_rls_acceptance_%'"),
    'etuliitteellä ei etsitä jäännöstä');
  // KUUSI TAULUA, KUUSI HAKUA.
  //
  // Hyökkäyksiä kohdistui kuuteen tauluun. Yhden haun neutralointi
  // jätti sanan tiedostoon, joten sisältyvyystesti meni läpi —
  // mutaatiotesti paljasti sen. Siksi esiintymät lasketaan.
  assert.equal(
    lahde.split("like 'manifestival_rls_acceptance_%_attack_%'").length - 1, 6,
    'hyökkäysrivejä ei etsitä jokaisesta kohdetaulusta');
  assert.ok(/Muistutusasetusrivejä ei ole/.test(lahde),
    'muistutusasetuksia ei tarkisteta tunnisteella');
  assert.ok(lahde.includes('auth.users'),
    'ei tarkisteta, että tili B on poistettu');
});


// =====================================================================
// SECURITY DEFINER -FUNKTIOIDEN SALLITTAVUUS
// =====================================================================
//
// LÖYTYNYT VIKA, JOTA NÄMÄ VARTIOIVAT
//
// verify_0004_0008_final.sql vaati, ettei public-skeemassa ole
// YHTÄKÄÄN SECURITY DEFINER -funktiota. Tuotannossa se tuotti yhden
// FAILin, joka ei tarkoittanut vikaa:
//
//   public.rls_auto_enable() -> event_trigger
//
// Se on ympäristön oma infrastruktuurifunktio, joka kytkee RLS:n päälle
// jokaiseen uuteen public-skeeman tauluun. Yksikään Manifestivalin
// migraatio ei luo sitä, eikä sen nimi esiinny repositoriossa —
// migraatiot luovat tasan yhden funktion, `touch_updated_at`.
//
// Väärä invariantti on huonompi kuin puuttuva: se opettaa ohittamaan
// FAILin. Seuraavan kerran ohitettu FAIL voi olla oikea.
//
// MITÄ NÄMÄ TESTIT TODISTAVAT — JA MITÄ EIVÄT
//
// Nämä lukevat SQL:n tekstinä. Ne todistavat, että varmistus KYSYY
// oikeat kysymykset: että jokainen tunnistusehto on paikallaan ja että
// sallittavuus ei nojaa nimeen. Ne EIVÄT todista, että PostgreSQL
// vastaa niihin oikein — sen näkee vasta ajamalla varmistuksen kantaa
// vasten.

const LOPPUVARMISTUS = 'supabase/verify/verify_0004_0008_final.sql';

/** Loppuvarmistuksen suorittava osa: kommenttirivit pois. */
function loppuKoodi() {
  return read(LOPPUVARMISTUS).split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE);
}

/**
 * Sallittavuuden tunnistusehdot.
 *
 * Jokainen rivi on yksi ehto, jonka on oltava varmistuksessa, ja se
 * skenaario jonka kyseinen ehto torjuu. Taulukko on testin
 * päätöstaulu: jos ehto katoaa, skenaario menisi läpi.
 */
const TUNNISTUSEHDOT = [
  ["proname = 'rls_auto_enable'",
   'väärän niminen SECURITY DEFINER -funktio'],
  ["prokind = 'f'",
   'proseduuri tai aggregaatti samalla nimellä'],
  ['pronargs = 0',
   'samanniminen funktio, joka ottaa argumentteja'],
  ["prorettype = 'pg_catalog.event_trigger'::regtype",
   'samanniminen funktio, jota voi kutsua suoraan (väärä paluutyyppi)'],
  ["pg_get_userbyid(f.proowner) = 'postgres'",
   'samanniminen funktio, jonka omistaja on joku muu'],
  ['proconfig is not null',
   'samanniminen funktio ilman search_path-asetusta'],
  ['array_length(f.proconfig, 1) = 1',
   'samanniminen funktio, jolla on ylimääräisiä asetuksia'],
  ["= 'pg_catalog'",
   'samanniminen funktio, jonka search_path ei ole rajattu pg_catalogiin'],
  ["lanname = 'plpgsql'",
   'samanniminen funktio jollain muulla kielellä (esim. C)'],
  ['pg_event_trigger_ddl_commands',
   'samanniminen funktio, joka ei käsittele DDL-tapahtumia'],
  ['enable[[:space:]]+row[[:space:]]+level[[:space:]]+security',
   'samanniminen funktio, joka ei kytke RLS:ää päälle'],
  ['pg_read_file',
   'runko, joka lukee palvelimen tiedostoja'],
  ['(grant|revoke)',
   'runko, joka myöntää tai peruu oikeuksia'],
  // Kenoviivat pois hakusanasta. SQL:ssa ehto on kirjoitettu
  // sanarajoilla, mutta niiden kirjoittaminen JS-merkkijonoon on
  // turha ansa: tama katkelma esiintyy vain siina ehdossa.
  ['(create|alter|drop|set)',
   'runko, joka kasittelee rooleja']
];

test('KRIITTINEN: loppuvarmistus ei enää vaadi nollaa SECURITY DEFINER -funktiota', () => {
  // Vanha muoto oli yksi laskuri ilman poikkeuksia:
  //
  //   where n.nspname = 'public' and p.prosecdef      -> odotus '0'
  //
  // Jos se palaa, tuotannon varmistus alkaa taas antaa FAILin joka ei
  // tarkoita vikaa.
  const koodi = loppuKoodi();

  assert.equal(
    /where n\.nspname = 'public' and p\.prosecdef\)/.test(koodi), false,
    'loppuvarmistus vaatii taas nollaa SECURITY DEFINER -funktiota'
    + ' — se antaa FAILin ympäristön omasta infrastruktuurifunktiosta');

  // Uusi muoto laskee TUNTEMATTOMAT, ei kaikkia.
  assert.ok(koodi.includes('Tuntemattomia SECURITY DEFINER -funktioita ei ole'),
    'loppuvarmistuksesta puuttuu tuntemattomien funktioiden tarkistus');
});

test('KRIITTINEN: sallittavuus ei nojaa nimeen', () => {
  // Nimi ei ole tunniste: kuka tahansa voi luoda funktion millä tahansa
  // nimellä. Jos sallittavuus olisi pelkkä nimivertailu, hyökkääjä
  // nimeäisi funktionsa rls_auto_enableksi ja saisi SECURITY
  // DEFINER -funktion ohittamaan koko tarkistuksen.
  const koodi = loppuKoodi();

  for (const [ehto, skenaario] of TUNNISTUSEHDOT) {
    assert.ok(koodi.includes(ehto),
      `loppuvarmistuksesta puuttuu ehto "${ehto}"`
      + ` — läpi menisi: ${skenaario}`);
  }

  // Ja tunnistus on YKSI konjunktio, ei joukko vaihtoehtoja. `or`
  // tunnistuslohkossa tarkoittaisi, että yksi täsmäävä ehto riittää.
  const lohko = koodi.slice(koodi.indexOf('tunniste as ('),
                            koodi.indexOf('select c.check_no'));
  assert.ok(lohko.length > 200, 'tunnistuslohkoa ei löytynyt');
  assert.equal(/\bor\b/i.test(lohko), false,
    'tunnistuslohko sisältää or-ehdon — yksi täsmäävä ehto riittäisi');
});

test('KRIITTINEN: tuntematon funktio kaataa varmistuksen, ei jää INFOksi', () => {
  // INFO-rivi ei kasvata poikkeavia_yhteensa-lukua eikä pysäytä
  // ketään. SECURITY DEFINER ohittaa RLS:n; se on tarkalleen se
  // rakenne, jolla koko paketin omistajuussuoja kierretään.
  const koodi = loppuKoodi();

  const lohko = koodi.split('union all')
    .find(osa => osa.includes('Tuntemattomia SECURITY DEFINER'));
  assert.ok(lohko, 'tarkistusta 23a ei löytynyt');

  assert.equal(lohko.includes("'INFO'"), false,
    'tuntemattomien funktioiden tarkistus on INFO — se ei pysäytä mitään');
  assert.ok(/'0',/.test(lohko),
    'tuntemattomien funktioiden odotusarvo ei ole 0');

  // Ja se laskee nimenomaan ne, jotka EIVÄT täytä molempia ehtoja.
  assert.ok(lohko.includes('not (identiteetti_ok and runko_ok)'),
    'tarkistus ei laske tunnistamattomia funktioita');
});

test('KRIITTINEN: tunnistus ja runko tarkistetaan myös erikseen', () => {
  // 23a kertoo että jokin on pielessä. 23b ja 23c kertovat MIKÄ.
  // Ilman niitä operaattori näkisi vain luvun eikä tietäisi, onko
  // kannassa tuntematon funktio vai muuttunut tunnettu.
  const koodi = loppuKoodi();

  for (const [tunnus, kentta] of [['23b', 'identiteetti_ok'], ['23c', 'runko_ok']]) {
    const lohko = koodi.split('union all').find(osa => osa.includes(`'${tunnus}'`));
    assert.ok(lohko, `tarkistus ${tunnus} puuttuu`);

    // Odotus lasketaan kannan tilasta: jos funktiota ei ole, odotus on
    // 0 eikä tarkistus vaadi sen olemassaoloa.
    assert.ok(lohko.includes("where proname = 'rls_auto_enable'"),
      `${tunnus}: odotusta ei lasketa kannan tilasta`);
    assert.ok(lohko.includes(kentta),
      `${tunnus}: ei vertaa kenttää ${kentta}`);
  }
});

test('KRIITTINEN: SECURITY INVOKER -funktiot eivät osu tarkistukseen', () => {
  // touch_updated_at on SECURITY INVOKER. Se ajetaan kutsujan
  // oikeuksilla eikä ohita RLS:ää, joten sen ei pidä päätyä
  // tuntemattomien joukkoon — muuten varmistus antaisi FAILin
  // sovelluksen omasta, oikein kovennetusta funktiosta.
  const koodi = loppuKoodi();

  const cte = koodi.slice(koodi.indexOf('definer_funktiot as ('),
                          koodi.indexOf('tunniste as ('));
  assert.ok(cte.length > 100, 'definer_funktiot-lohkoa ei löytynyt');
  assert.ok(/and p\.prosecdef\b/.test(cte),
    'lohko ei rajaa SECURITY DEFINER -funktioihin');
  assert.equal(/prosecdef = false/.test(cte), false,
    'lohko poimii myös SECURITY INVOKER -funktioita');

  // Ja touch_updated_at tarkistetaan yhä erikseen INVOKERiksi.
  assert.ok(koodi.includes("p.proname = 'touch_updated_at'")
    && koodi.includes('p.prosecdef = false'),
    'touch_updated_at -tarkistus katosi');
});

test('KRIITTINEN: sormenjälki tekee rungon muutoksen näkyväksi', () => {
  // Rakenteelliset ehdot eivät voi kattaa jokaista mahdollista muutosta
  // rungossa. Tiiviste kattaa: jos runko muuttuu millään tavalla, rivi
  // muuttuu ja ero näkyy ajolokissa.
  const koodi = loppuKoodi();
  const lohko = koodi.split('union all').find(osa => osa.includes("'23d'"));

  assert.ok(lohko, 'sormenjälkiriviä ei löytynyt');
  assert.ok(lohko.includes('md5(f.prosrc)'), 'sormenjälki ei kata funktion runkoa');
  assert.ok(lohko.includes('proowner'), 'sormenjälki ei kata omistajaa');
  assert.ok(lohko.includes('proconfig'), 'sormenjälki ei kata asetuksia');
  assert.ok(lohko.includes("'INFO'"),
    'sormenjälki ei ole INFO — muuttunut ympäristö ei saa kaataa varmistusta');
});

test('KRIITTINEN: sallittavuus on kirjoitettu havaitun funktion mukaan', () => {
  // SKENAARIO A: tunnettu rls_auto_enable menee läpi.
  //
  // Tätä ei voi todistaa mutaatiolla — mutaatio poistaa ehtoja ja
  // näyttää mikä hylätään, ei mikä hyväksytään. Positiivinen tapaus
  // todistetaan toisin: kirjataan se, mitä tuotannosta oikeasti
  // havaittiin, ja vaaditaan että jokainen sallittavuusehto on
  // kirjoitettu VASTAAMAAN sitä.
  //
  // Jos joku myöhemmin kiristää ehtoa niin, ettei havaittu funktio enää
  // kelpaa, tämä kaatuu — ja se on oikea hetki huomata, ettei
  // varmistus mene enää tuotannossa läpi.
  //
  // Havainto on tuotannon vain lukevasta diagnostiikasta:
  //
  //   public.rls_auto_enable()
  //   owner: postgres,  returns: event_trigger,  SECURITY DEFINER
  //   volatility: volatile,  SET search_path TO 'pg_catalog'
  //   runko iteroi pg_event_trigger_ddl_commands() ja kytkee RLS:n
  //   uusiin public-skeeman tauluihin
  const HAVAITTU = {
    skeema: 'public',
    nimi: 'rls_auto_enable',
    omistaja: 'postgres',
    paluutyyppi: 'event_trigger',
    securityDefiner: true,
    argumentteja: 0,
    searchPath: 'pg_catalog',
    kieli: 'plpgsql'
  };

  const koodi = read('supabase/verify/verify_0004_0008_final.sql')
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE);

  // Jokainen havaittu ominaisuus on kirjoitettu sallittavuusehtoon
  // TÄSMÄLLEEN siinä muodossa, jossa se kannasta luetaan.
  const vastaavuudet = [
    [`n.nspname = '${HAVAITTU.skeema}'`, 'skeema'],
    [`f.proname = '${HAVAITTU.nimi}'`, 'nimi'],
    [`pg_get_userbyid(f.proowner) = '${HAVAITTU.omistaja}'`, 'omistaja'],
    [`f.prorettype = 'pg_catalog.${HAVAITTU.paluutyyppi}'::regtype`, 'paluutyyppi'],
    [`f.pronargs = ${HAVAITTU.argumentteja}`, 'argumenttien määrä'],
    [`= '${HAVAITTU.searchPath}'`, 'search_path'],
    [`lanname = '${HAVAITTU.kieli}'`, 'kieli']
  ];

  for (const [ehto, mika] of vastaavuudet) {
    assert.ok(koodi.includes(ehto),
      `sallittavuusehto ei vastaa havaittua funktiota kohdassa ${mika}:`
      + ` odotettiin katkelmaa "${ehto}"`);
  }

  // Ja funktio on nimenomaan SECURITY DEFINER — sitä varten koko
  // sallittavuuslohko on olemassa.
  assert.equal(HAVAITTU.securityDefiner, true);
  assert.ok(/and p\.prosecdef\b/.test(koodi),
    'sallittavuuslohko ei rajaa SECURITY DEFINER -funktioihin');

  // SKENAARIO F: tavalliset SECURITY INVOKER -funktiot eivät osu
  // tarkistukseen lainkaan. Sovelluksen oma touch_updated_at on
  // INVOKER, ja sen on jäätävä kokonaan tämän lohkon ulkopuolelle —
  // muuten varmistus antaisi FAILin oikein kovennetusta funktiosta.
  const migraationFunktio = sql('0002_task_domain_fields.sql');
  assert.ok(migraationFunktio.includes('security invoker'),
    'touch_updated_at ei ole enää SECURITY INVOKER');
  assert.equal(migraationFunktio.includes('security definer'), false,
    'jokin migraatio luo SECURITY DEFINER -funktion');
});

test('KRIITTINEN: yksikään muu varmistus ei vaadi nollaa SECURITY DEFINER -funktiota', () => {
  // Sama väärä oletus voi elää muissa tiedostoissa. Jokainen
  // prosecdef-viittaus on rajattava NIMETTYYN funktioon tai
  // sallittavuuslohkoon — koko skeeman kattava laskuri ilman
  // poikkeuksia on se muoto, joka antoi väärän FAILin.
  const hakemistot = ['supabase/verify', 'supabase/preflight', 'supabase/acceptance'];

  let tarkastettuja = 0;
  for (const hakemisto of hakemistot) {
    for (const nimi of fs.readdirSync(path.join(ROOT, hakemisto))
                        .filter(n => n.endsWith('.sql'))) {
      const koodi = fs.readFileSync(path.join(ROOT, hakemisto, nimi), 'utf8')
        .split(NEWLINE)
        .filter(line => !line.trim().startsWith('--'))
        .join(NEWLINE);

      if (!koodi.includes('prosecdef')) continue;

      // Jokainen esiintymä omassa lohkossaan: `union all` erottaa
      // tarkistukset, `with` ja alkukohta rajaavat ensimmäisen.
      for (const lohko of koodi.split('union all')) {
        if (!lohko.includes('prosecdef')) continue;
        tarkastettuja += 1;

        const rajattu = lohko.includes('proname')
          || lohko.includes('identiteetti_ok')
          || lohko.includes('definer_funktiot');

        assert.ok(rajattu,
          `${nimi}: prosecdef-tarkistus ei rajaa nimettyyn funktioon`
          + ' — koko skeeman kattava laskuri antaa FAILin ympäristön'
          + ' omasta infrastruktuurifunktiosta');
      }
    }
  }

  assert.ok(tarkastettuja >= 10,
    `prosecdef-tarkistuksia löytyi vain ${tarkastettuja} — hahmo ei osu`);
});

test('KRIITTINEN: rls_auto_enable ei ole Manifestivalin funktio', () => {
  // Tämä on se havainto, jonka nojalla funktio sallitaan. Jos jokin
  // migraatio joskus luo sen, väite vanhenee: silloin se on
  // sovelluksen funktio, ja sen pitäisi olla SECURITY INVOKER tai
  // erikseen perusteltu.
  for (const name of migrationFiles()) {
    assert.equal(sql(name).includes('rls_auto_enable'), false,
      `${name} luo funktion rls_auto_enable — sallittavuuden peruste vanhentui`);
  }

  // Ja migraatiot luovat yhä tasan yhden funktion.
  const funktiot = new Set();
  for (const name of migrationFiles()) {
    for (const m of sql(name).matchAll(/create (?:or replace )?function public\.(\w+)/g)) {
      funktiot.add(m[1]);
    }
  }
  assert.deepEqual([...funktiot], ['touch_updated_at'],
    'migraatiot luovat muitakin funktioita kuin touch_updated_at');
});



// =====================================================================
// LOPULLINEN HYVÄKSYNNÄN JÄLKEINEN VARMISTUS
// =====================================================================
//
// TAUSTA: "Success. No rows returned"
//
// Tuotannossa ajettiin verify_0003_0008_acceptance.sql ja SQL Editor
// ilmoitti "Success. No rows returned". Ensimmäinen epäilys kohdistui
// kommenttiteksteissä oleviin puolipisteisiin — ajatuksena, että
// editori pilkkoisi liitetyn tekstin lauseiksi asiakaspäässä.
//
// SE OSOITTAUTUI VÄÄRÄKSI. verify_0004_0008_final.sql sisältää yhdeksän
// puolipistettä kommenteissa, ja se ajettiin samassa editorissa
// kokonaan läpi: 38 riviä, yksi FAIL. Editori siis käsittelee
// kommentit oikein.
//
// Vanha tiedosto on myös rakenteellisesti moitteeton: yksi lause,
// 28 tarkistusta, jokainen `select <vakio>` ilman from-lausetta. Sen
// suorittaminen EI VOI tuottaa nollaa riviä.
//
// Jäljelle jää yksi selitys: ajettu syöte ei ollut koko tiedosto.
// Supabasen SQL Editor ajaa VALINNAN, jos editorissa on tekstiä
// valittuna. Pelkistä kommenteista koostuva syöte ei tuota
// tulosjoukkoa lainkaan, ja editori näyttää siitä juuri tuon
// ilmoituksen.
//
// Se on vaarallisin mahdollinen lopputulos, koska se ei näytä
// virheeltä. Operaattori voisi lukea sen niin, että tarkistukset
// menivät läpi — vaikka yhtäkään ei ajettu.
//
// NÄMÄ TESTIT eivät siis vahdi puolipisteitä. Ne varmistavat, että
// verifierin RAKENNE takaa rivejä aina kun se suoritetaan, ja että
// tiedosto on yksi yksiselitteinen lause.

const LOPULLINEN = 'supabase/acceptance/verify_0003_0008_post_acceptance_final.sql';

/** Tiedoston koodi ilman kommentteja JA ilman merkkijonovakioita. */
function pelkkaKoodi(polku) {
  return read(polku)
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE)
    // Merkkijonovakiot pois. Ilman tätä oikeuslista
    // array['select', 'insert', 'update', 'delete'] näyttäisi
    // muuttavilta lauseilta, ja SECURITY DEFINER -rungon kieltolista
    // '\m(grant|revoke)\M' samoin. Kumpikaan ei ole suoritettava lause.
    .replace(/'[^']*'/g, "''");
}

test('KRIITTINEN: lopullinen varmistus on tasan yksi lause', () => {
  // Yksi puolipiste, aivan viimeisenä merkkinä.
  //
  // Tämä ei ole korjaus editorin lausejakoon — se toimii oikein. Tämä
  // poistaa epäselvyyden siitä, MINKÄ lauseen tulos näytetään: kun
  // lauseita on yksi, näytetty tulos on aina tarkistustaulukko.
  const lahde = read(LOPULLINEN);

  assert.equal((lahde.match(/;/g) || []).length, 1,
    'lopullisessa varmistuksessa on muitakin puolipisteitä kuin viimeinen');
  assert.match(lahde.trimEnd(), /;$/,
    'lopullinen varmistus ei pääty puolipisteeseen');
});

test('KRIITTINEN: lopullinen varmistus on vain lukeva', () => {
  // Tämä ajetaan tuotantokantaa vasten käsin, postgres-roolilla.
  // Yksikään muuttava lause ei saa päätyä tänne.
  //
  // Tarkistus tehdään koodista, josta kommentit JA merkkijonovakiot on
  // riisuttu. Kumpikin tuottaisi muuten vääriä hälytyksiä: kommentit
  // selittävät muuttavia lauseita, ja SECURITY DEFINER -tarkistuksen
  // kieltolista sisältää sanat grant ja revoke merkkijonona.
  const koodi = pelkkaKoodi(LOPULLINEN);

  for (const kielletty of ['insert', 'update', 'delete', 'alter', 'drop',
                           'create', 'grant', 'revoke', 'truncate',
                           'merge', 'commit', 'rollback', 'vacuum']) {
    assert.equal(new RegExp(`\\b${kielletty}\\b`, 'i').test(koodi), false,
      `lopullinen varmistus sisältää sanan "${kielletty}" suoritettavassa koodissa`);
  }

  // SET ROLE erikseen: se vaihtaisi istunnon roolin, ja koko
  // varmistuksen edellytys on postgres-rooli.
  assert.equal(/\bset\s+role\b/i.test(koodi), false,
    'lopullinen varmistus vaihtaa istunnon roolia');

  // Ja se alkaa with-lauseella, jonka jokainen CTE on select.
  assert.match(koodi.trimStart(), /^with\b/i,
    'lopullinen varmistus ei ala with-lauseella');

  // `values` on sallittu selectin rinnalla: se on rivien muodostin,
  // ei lause joka koskee tauluun. Luettelot (portit, crud_taulut,
  // oikeudet) ovat rivijoukkoja juuri siksi, ettei jasenyystestissa
  // olisi tulkinnanvaraa.
  const rungot = [...koodi.matchAll(/\bas\s*\(\s*(\w+)/gi)].map(m => m[1].toLowerCase());
  assert.ok(rungot.length >= 4, `CTE-runkoja löytyi vain ${rungot.length}`);
  for (const runko of rungot) {
    assert.ok(['select', 'values'].includes(runko),
      `CTE alkaa sanalla "${runko}" — vain select ja values ovat sallittuja`);
  }
});

test('KRIITTINEN: staattinen turvatesti erottaa lauseet merkkijonoista', () => {
  // Tämän testin oma mutaatiotesti. Jos riisunta lakkaisi toimimasta,
  // edellinen testi menisi läpi väärästä syystä — tai kaatuisi
  // väärästä syystä.
  //
  // 1. Merkkijonossa oleva avainsana EI ole lause.
  const merkkijonossa = "select '' as x, array['insert', 'update'] as y";
  assert.equal(/\binsert\b/i.test(merkkijonossa.replace(/'[^']*'/g, "''")), false,
    'riisunta ei poista merkkijonovakioita');

  // 2. Kommentissa oleva avainsana EI ole lause.
  const kommentissa = `-- taalla puhutaan insert-lauseesta${NEWLINE}select 1`;
  const riisuttu = kommentissa.split(NEWLINE)
    .filter(line => !line.trim().startsWith('--')).join(NEWLINE);
  assert.equal(/\binsert\b/i.test(riisuttu), false,
    'riisunta ei poista kommentteja');

  // 3. Oikea lause LÖYTYY yhä.
  const oikeasti = "select 1;\ninsert into public.tasks values ('x')";
  const riisuttu3 = oikeasti.split(NEWLINE)
    .filter(line => !line.trim().startsWith('--')).join(NEWLINE)
    .replace(/'[^']*'/g, "''");
  assert.ok(/\binsert\b/i.test(riisuttu3),
    'riisunta piilottaa oikeankin insert-lauseen');
});

test('KRIITTINEN: lopullinen varmistus palauttaa aina rivejä', () => {
  // TÄMÄ ON KOKO TIEDOSTON TÄRKEIN OMINAISUUS.
  //
  // "Success. No rows returned" ei saa olla mahdollinen tulos
  // suoritetusta lauseesta. Rakenne takaa sen: jokainen tarkistus on
  // `select <vakio>` ilman from-lausetta, joten se tuottaa
  // väistämättä tasan yhden rivin riippumatta siitä, mitä kannassa on.
  //
  // Jos tarkistukset olisi kirjoitettu taulusta suodattaen, tyhjä
  // taulu tuottaisi tyhjän tuloksen — ja tyhjä tulos näyttäisi siltä
  // kuin mitään ei olisi vialla.
  const koodi = pelkkaKoodi(LOPULLINEN);

  // 40, ei enaa 41. Kaksi tarkistusta poistui auth.users-riippuvuuden
  // mukana (kayttajamaara ja orpojen LEFT JOIN) ja yksi lisattiin
  // (profiilin omistaja). Kayttajamaara on nyt precheckissa.
  const tarkistuksia = (koodi.match(/union all/gi) || []).length + 1;
  assert.equal(tarkistuksia, 40,
    `tarkistuksia on ${tarkistuksia}, odotettiin 40`);

  // Jokainen tarkistus alkaa vakiolla, ei taulukyselyllä.
  // Ensimmainen tarkistus on `tarkistukset as ( select ...`, muut
  // `union all select ...`. Molemmat muodot kelpaavat.
  // Lasketaan VAIN tarkistukset-CTE:n sisalta. Muut CTE:t (vakiot)
  // alkavat myos vakiolla, ja koko tiedostoon kohdistuva laskenta
  // antoi siksi 42/41 -- luku joka ei tarkoita mitaan.
  const tarkistusLohko = koodi.slice(koodi.indexOf('tarkistukset as ('));
  const vakiolla = [...tarkistusLohko.matchAll(/(?:union all|as \()\s*select\s+''/gi)].length;
  assert.equal(vakiolla, tarkistuksia,
    `vain ${vakiolla}/${tarkistuksia} tarkistusta alkaa vakiolla`
    + ' — loput voisivat tuottaa nolla riviä');

  // Uloin select lukee CTE:stä eikä suodata mitään pois.
  const uloin = koodi.slice(koodi.lastIndexOf('select t.check_no'));
  assert.ok(uloin.includes('from tarkistukset t'),
    'uloin select ei lue tarkistukset-CTE:stä');

  // Rivejä suodattava where. `filter (where ...)` on eri asia: se
  // rajaa ikkunafunktion laskentaa, ei tulosjoukkoa. Se riisutaan
  // ennen tarkistusta.
  const ilmanFilteria = uloin.replace(/filter\s*\([^)]*\)/gi, '');
  assert.equal(/\bwhere\b/i.test(ilmanFilteria), false,
    'uloimmassa selectissä on where-ehto — se voisi suodattaa rivejä pois');
});

test('KRIITTINEN: lopullinen varmistus tuottaa vaaditut sarakkeet', () => {
  const koodi = pelkkaKoodi(LOPULLINEN);

  // Sarakkeet luetaan ULOIMMAN SELECTIN PROJEKTIOLISTASTA, ei koko
  // tiedostosta. Koko tiedostoon kohdistuva haku meni lapi
  // mutaatiosta, jossa sarake t.expected poistettiin projektiosta:
  // nimi jai yha filter-lausekkeeseen, joten sisaltyvyystesti ei
  // huomannut mitaan.
  const projektio = koodi
    .slice(koodi.lastIndexOf('select t.check_no'),
           koodi.lastIndexOf('from tarkistukset'))
    // filter-lausekkeen sisalla oleva viittaus ei ole projektiossa.
    .replace(/filter\s*\([^)]*\)/gi, '');

  assert.ok(projektio.length > 50, 'uloimman selectin projektiota ei loytynyt');

  for (const sarake of ['check_no', 'section', 'check_name',
                        'expected', 'actual', 'status', 'failures_total']) {
    assert.ok(new RegExp(`\\bas ${sarake}\\b|\\bt\\.${sarake}\\s*[,\\n]`)
      .test(projektio),
      `uloimman selectin projektiosta puuttuu sarake ${sarake}`);
  }

  // status on PASS tai FAIL, ei mitään muuta. INFO-rivi ei kasvattaisi
  // failures_total-lukua eikä pysäyttäisi ketään.
  assert.ok(read(LOPULLINEN).includes("then 'PASS' else 'FAIL' end as status"),
    'status ei ole yksinomaan PASS tai FAIL');

  // failures_total lasketaan KOKO tulosjoukon FAIL-riveistä ja on sama
  // jokaisella rivillä. Operaattorin ei tarvitse laskea rivejä itse.
  assert.ok(/count\(\*\)\s*filter\s*\(where[^)]*\)\s*over\s*\(\)\s*as failures_total/i
    .test(koodi),
    'failures_total ei ole koko joukon yli laskettu ikkunafunktio');
});

test('KRIITTINEN: lopullisen varmistuksen odotusarvot vastaavat migraatioita', () => {
  // Odotusarvot eivät ole arvattuja. Käsin laskettu odotus vanhenee
  // ensimmäisessä muutoksessa, ja vanhentunut odotus pysäyttää
  // tuotannon varmistuksen vaikka kanta olisi oikein.
  const lahde = read(LOPULLINEN);

  /** Yhden tarkistuksen odotusarvo. */
  const odotus = osuma => {
    const lohko = lahde.split('union all').find(osa => osa.includes(osuma));
    assert.ok(lohko, `tarkistusta ei löytynyt: ${osuma}`);
    const m = /',\s*'(\d+)',/.exec(lohko);
    assert.ok(m, `odotusarvoa ei löytynyt: ${osuma}`);
    return Number(m[1]);
  };

  // Johda luvut migraatioista 0003-0008.
  const era = migrationFiles().filter(n => /^000[3-8]/.test(n));
  const laske = hahmo => era.reduce((summa, nimi) => {
    const koodi = sql(nimi).split(`${NEWLINE}commit;`)[0]
      .split(NEWLINE).filter(l => !l.trim().startsWith('--')).join(NEWLINE);
    return summa + [...koodi.matchAll(hahmo)].length;
  }, 0);

  const taulut = laske(/create table public\.(\w+)/g);
  const politiikat = laske(/create policy (\w+)/g);
  const viitteet = laske(/foreign key \(user_id,\s*\w+\)\s*references public\./g);

  assert.equal(taulut, 10, `migraatiot luovat ${taulut} porttitaulua`);
  assert.equal(politiikat, 40, `migraatiot luovat ${politiikat} politiikkaa`);
  assert.equal(viitteet, 9, `migraatiot luovat ${viitteet} omistajuusviitettä`);

  assert.equal(odotus('Kaikki kymmenen porttitaulua ovat olemassa'), taulut);
  assert.equal(odotus('RLS on paalla kaikissa kymmenessa taulussa'), taulut);
  assert.equal(odotus('omistajuuspolitiikkaa on tallella'), politiikat);
  assert.equal(odotus('Jokainen politiikka on vain authenticated-roolille'), politiikat);
  assert.equal(odotus('Jokainen politiikka rajaa omistajuuden molemmilta puolilta'), politiikat);
  assert.equal(odotus('omistajuuden yhdistelmavierasavainta'), viitteet);

  // Nollaavat viitteet ja kaskadoiva viite yhteensä = kaikki viitteet.
  const nollaavat = odotus('nollaavaa viitetta rajaa nollauksen sarakkeeseen');
  const kaskadi = odotus('Poikkeuksen viite rutiiniin on CASCADE');
  assert.equal(nollaavat + kaskadi, viitteet,
    `${nollaavat} nollaavaa + ${kaskadi} kaskadoivaa <> ${viitteet} viitettä`);

  // authenticated: yksitoista taulua kertaa CRUD.
  assert.equal(odotus('authenticated-roolilla on tasan CRUD yhdessatoista taulussa'),
    11 * 4);

  // Omistajan rivin avaimet: viisi ERÄSSÄ, ja ne johdetaan
  // migraatioista. Rajaus on sama kuin muillakin luvuilla tässä
  // testissä -- loppuvarmistus kattaa erän 0004-0008, ei myöhempiä
  // migraatioita. Erän ulkopuoliset avaimet on lueteltu nimeltä
  // testissä "loppuvarmistuksen luvut lasketaan migraatioista".
  const avaimet = new Set();
  for (const nimi of era) {
    for (const m of sql(nimi).matchAll(/constraint (\w+_owner_row_key) unique/g)) {
      avaimet.add(m[1]);
    }
    for (const m of sql(nimi).matchAll(/add constraint (\w+_owner_row_key) unique/g)) {
      avaimet.add(m[1]);
    }
  }
  assert.equal(avaimet.size, 5, `omistajan rivin avaimia on ${avaimet.size}`);
  assert.equal(odotus('omistajan rivin avainta'), avaimet.size);

  // Liipaisimet: yhdeksän erässä plus tasks migraatiosta 0002.
  const liipaisimet = laske(/create trigger (\w+)/g);
  assert.equal(liipaisimet, 9, `erässä on ${liipaisimet} liipaisinta`);
  assert.equal(odotus('updated_at-liipaisinta on tallella'), liipaisimet + 1);
});

test('KRIITTINEN: lopullinen varmistus todistaa vaaditut osa-alueet', () => {
  const lahde = read(LOPULLINEN);

  // Puuttuva osa-alue ei näy mitenkään: varmistus antaisi PASSin sille
  // mitä se sattuu katsomaan.
  const vaatimukset = [
    ['1acdb7371be22cfa457b4dae0d0aa800', 'tehtävien tunnisteiden tiiviste'],
    ['_attack_', 'ristiinkiinnitysyritysten jäännös'],
    ['notification_preferences', 'muistutusasetusten jäännös'],
    ['confdelsetcols', 'nollattavien sarakkeiden rajaus'],
    ['confdeltype', 'poistosäännöt'],
    ['owner_row_key', 'omistajan rivin avaimet'],
    ['aclexplode', 'PUBLIC-roolin oikeuslista'],
    ['has_table_privilege', 'tehollisten oikeuksien tarkistus'],
    ['prosecdef', 'SECURITY DEFINER -tilanne'],
    ['rls_auto_enable', 'ympäristön infrastruktuurifunktio'],
    ['touch_updated_at', 'liipaisinfunktion kovennus'],
    ['relrowsecurity', 'RLS:n tila'],
    ['is_nullable', 'user_id NOT NULL'],
    ['auth.uid()', 'omistajan oletusarvo'],
    ['2cc00622-f927-4604-a518-361a4328481b', 'hyväksytty omistaja']
  ];

  for (const [needle, mika] of vaatimukset) {
    assert.ok(lahde.includes(needle),
      `lopullinen varmistus ei todista: ${mika} (puuttuu "${needle}")`);
  }

  // HYOKKAYSJAANNOS: KUUSI KOHDETAULUA, EI YKSI.
  //
  // Sisaltyvyystesti meni lapi mutaatiosta, jossa yksi kuudesta
  // alikyselysta poistettiin -- sana `_attack_` jai yha jaljelle.
  // Hyokkayksia kohdistui kuuteen tauluun, ja jokainen on
  // tarkistettava.
  assert.equal((lahde.match(/_attack_/g) || []).length, 6,
    'ristiinkiinnitysyrityksia ei etsita jokaisesta kuudesta kohdetaulusta');

  // SECURITY DEFINER -lohko ei saa olla tyhja.
  //
  // Mutaatiotesti paljasti taman: kun definer_funktiot-CTE:n ehto
  // `and p.prosecdef` vaihdettiin muotoon `and false`, lohko jai
  // tyhjaksi ja tarkistukset 37-39 menivat lapi ilman etta yhtaan
  // funktiota katsottiin. Sana prosecdef esiintyi yha muualla
  // tiedostossa, joten sisaltyvyystesti ei huomannut mitaan.
  const definerLohko = lahde.slice(lahde.indexOf('definer_funktiot as ('),
                                   lahde.indexOf('tunniste as ('));
  assert.ok(definerLohko.length > 100, 'definer_funktiot-lohkoa ei loytynyt');
  assert.match(definerLohko, /and p\.prosecdef\s*$/m,
    'definer_funktiot ei rajaa SECURITY DEFINER -funktioihin');
  assert.equal(/and\s+false/i.test(definerLohko), false,
    'definer_funktiot on neutraloitu aina tyhjaksi');

  // Ja se ei lue käyttäjän sisältöä. Tiiviste lasketaan tunnisteista,
  // ei otsikoista.
  const koodi = pelkkaKoodi(LOPULLINEN);
  for (const sarake of ['title', 'note', 'proposal', 'input_summary']) {
    assert.equal(new RegExp(`\\b${sarake}\\b`).test(koodi), false,
      `lopullinen varmistus lukee sisältösaraketta ${sarake}`);
  }
});

test('KRIITTINEN: lopullinen varmistus neuvoo tyhjän tuloksen varalta', () => {
  // Jos operaattori näkee "Success. No rows returned", syy ei ole
  // kannassa vaan siinä, ettei koko tiedosto tullut ajetuksi. Sen on
  // luettavissa tiedostosta itsestään — muuten sama tunti kuluu
  // uudelleen.
  const lahde = read(LOPULLINEN);

  assert.ok(lahde.includes('No rows returned'),
    'lopullinen varmistus ei kerro, mitä tyhjä tulos tarkoittaa');
  assert.ok(/valitse/i.test(lahde) || /valinta/i.test(lahde),
    'lopullinen varmistus ei kerro, että editori ajaa valinnan');
  assert.match(lahde, /40 rivia/,
    'lopullinen varmistus ei kerro montako riviä odotetaan');
});


// =====================================================================
// SKALAARI vs. TAULUKKO: `= ANY (SELECT ...)` -ANSA
// =====================================================================
//
// LÖYTYNYT VIKA, JOTA NÄMÄ VARTIOIVAT
//
// Tuotannossa verify_0003_0008_post_acceptance_final.sql kaatui:
//
//   ERROR 42883: operator does not exist: name = text[]
//   LINE 267: and tablename = any (select portit from odotukset)
//
// PostgreSQL tuntee ANYlle KAKSI eri muotoa, ja ne kirjoitetaan lähes
// samannäköisesti:
//
//   expr = ANY (array_expression)   -- TAULUKKOMUOTO
//                                      oikea puoli on taulukko, ja
//                                      expr verrataan sen ALKIOIHIN
//
//   expr = ANY (subquery)           -- ALIKYSELYMUOTO
//                                      alikysely palauttaa RIVEJÄ, ja
//                                      expr verrataan jokaisen rivin
//                                      arvoon
//
// `(select portit from odotukset)` on alikysely. Se palautti yhden
// rivin, jonka ainoa sarake oli `text[]`. PostgreSQL yritti siis
// operaatiota `name = text[]`, jollaista ei ole.
//
// Vika ei näy lukemalla, koska sama kirjoitusasu on täysin oikein
// silloin kun oikea puoli on taulukkoLAUSEKE:
//
//   cl.oid = any (array['public.goals'::regclass, ...])   -- oikein
//
// Sitä muotoa käytetään tässä repossa kuudessa muussa varmistuksessa,
// eikä sitä saa kieltää.
//
// TÄMÄN TESTIN RAJOITE, REHELLISESTI
//
// Repossa ei ole PostgreSQL-jäsentäjää eikä tietokantaa, eikä sellaista
// asenneta tämän takia. Nämä testit eivät siis suorita SQL:ää. Ne
// rakentavat CTE:istä pienen tyyppimallin ja hylkäävät rakenteet,
// joissa alikyselymuotoa käytetään taulukkosarakkeeseen — eli
// täsmälleen sen virheen, joka tuotannossa nähtiin.
//
// Ne eivät todista, että SQL on kokonaisuudessaan tyyppioikeaa. Ne
// todistavat, ettei tämä nimenomainen ansa ole tiedostossa.

/** SQL-tiedoston koodi ilman kommentteja. */
function sqlKoodi(polku) {
  return read(polku).split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE);
}

/**
 * CTE:iden tuottamat sarakkeet ja tieto siitä, ovatko ne taulukoita.
 *
 * Tunnistaa kaksi muotoa:
 *   nimi as ( select array[...]::text[] as sarake, ... )  -> taulukko
 *   nimi(sarake) as ( values ... )                        -> skalaari
 *   nimi as ( select <muu> as sarake, ... )               -> skalaari
 */
function cteSarakkeet(koodi) {
  const kartta = new Map();

  // nimi(sarake) as ( values ... )
  for (const m of koodi.matchAll(/(\w+)\s*\(\s*(\w+)\s*\)\s+as\s*\(\s*values/gi)) {
    kartta.set(`${m[1]}.${m[2]}`, 'skalaari');
  }

  // nimi as ( select ... )
  for (const m of koodi.matchAll(/(\w+)\s+as\s*\(\s*select([\s\S]*?)\n\)/gi)) {
    const [, cte, runko] = m;
    for (const sarake of runko.matchAll(/(\S[^,]*?)\s+as\s+(\w+)\s*(?:,|$)/gm)) {
      const [, lauseke, nimi] = sarake;
      const taulukko = /\barray\s*\[/i.test(lauseke) || /::\s*\w+\s*\[\s*\]/.test(lauseke);
      kartta.set(`${cte}.${nimi}`, taulukko ? 'taulukko' : 'skalaari');
    }
  }
  return kartta;
}

test('KRIITTINEN: ANY-alikyselymuotoa ei käytetä taulukkosarakkeeseen', () => {
  // Tämä on se vika. `x = any (select <taulukkosarake> from cte)`
  // vertaa skalaaria taulukkoARVOON, ei sen alkioihin.
  const hakemistot = ['supabase/acceptance', 'supabase/verify', 'supabase/preflight'];

  let tarkastettuja = 0;
  for (const hakemisto of hakemistot) {
    for (const nimi of fs.readdirSync(path.join(ROOT, hakemisto))
                        .filter(n => n.endsWith('.sql'))) {
      const polku = `${hakemisto}/${nimi}`;
      const koodi = sqlKoodi(polku);
      const tyypit = cteSarakkeet(koodi);

      for (const m of koodi.matchAll(
        /(?:=\s*any|<>\s*all)\s*\(\s*select\s+(\w+)\s+from\s+(\w+)\s*\)/gi)) {
        tarkastettuja += 1;
        const [, sarake, cte] = m;
        const tyyppi = tyypit.get(`${cte}.${sarake}`);

        assert.notEqual(tyyppi, 'taulukko',
          `${nimi}: "any (select ${sarake} from ${cte})" on ALIKYSELYMUOTO,`
          + ` mutta ${cte}.${sarake} on taulukko`
          + ' — PostgreSQL vertaisi skalaaria taulukkoarvoon (42883).'
          + ' Käytä muotoa `in (select ... )` rivijoukkoon.');
      }
    }
  }

  // Tyhjentymissuoja: jos hahmo lakkaisi osumasta, silmukka kävisi läpi
  // nolla rakennetta ja menisi läpi. Tässä on tarkoituksella nolla
  // osumaa, joten suoja on erillinen — ks. seuraava testi.
  assert.equal(tarkastettuja, 0,
    `ANY-alikyselymuotoja löytyi ${tarkastettuja} kappaletta`
    + ' — jokainen niistä on tarkistettava käsin');
});

test('KRIITTINEN: tyyppimalli tunnistaa taulukkosarakkeen', () => {
  // Edellinen testi on tyhjentymisaltis: se käy läpi nolla rakennetta,
  // koska niitä ei enää ole. Tämä todistaa, että malli OSAA tunnistaa
  // vian, jos se palaa.
  const rikkinainen = [
    'odotukset as (',
    "  select array['a', 'b']::text[] as portit,",
    "         'x'::text as etuliite",
    '),',
    'muu as (',
    '  select 1',
    ')'
  ].join(NEWLINE);

  const tyypit = cteSarakkeet(rikkinainen);
  assert.equal(tyypit.get('odotukset.portit'), 'taulukko',
    'malli ei tunnista array[...]::text[] -saraketta taulukoksi');
  assert.equal(tyypit.get('odotukset.etuliite'), 'skalaari',
    'malli pitää tekstivakiota taulukkona');

  // Ja rivijoukkomuoto tunnistetaan skalaariksi.
  const korjattu = "portit(taulu) as (\n  values ('a'::text), ('b')\n)";
  assert.equal(cteSarakkeet(korjattu).get('portit.taulu'), 'skalaari',
    'malli ei tunnista values-CTE:n saraketta skalaariksi');
});

test('KRIITTINEN: taulukkomuotoinen ANY on yhä sallittu', () => {
  // `= any (array[...])` on oikea ja käytössä kuudessa varmistuksessa.
  // Jos sääntö kieltäisi sen, se rikkoisi toimivaa SQL:ää.
  let taulukkomuotoja = 0;
  for (const hakemisto of ['supabase/acceptance', 'supabase/verify']) {
    for (const nimi of fs.readdirSync(path.join(ROOT, hakemisto))
                        .filter(n => n.endsWith('.sql'))) {
      taulukkomuotoja += (sqlKoodi(`${hakemisto}/${nimi}`)
        .match(/=\s*any\s*\(\s*array\s*\[/gi) || []).length;
    }
  }
  assert.ok(taulukkomuotoja >= 5,
    `taulukkomuotoisia ANY-rakenteita löytyi vain ${taulukkomuotoja}`);
});

test('KRIITTINEN: jäsenyystestit lukevat rivijoukkoa, eivät taulukkoa', () => {
  // Lopullisessa varmistuksessa jäsenyys kirjoitetaan muotoon
  // `in (select taulu from portit)`. Se on yksiselitteinen: molemmat
  // puolet ovat skalaareja, eikä ANYn kahta muotoa voi sekoittaa.
  const koodi = sqlKoodi('supabase/acceptance/verify_0003_0008_post_acceptance_final.sql');

  const jasenyydet = (koodi.match(/in \(select taulu from portit\)/g) || []).length;
  assert.equal(jasenyydet, 7,
    `jäsenyystestejä on ${jasenyydet}, odotettiin 7`);

  // Ja luettelo-CTE:t ovat rivijoukkoja.
  for (const cte of ['portit(taulu)', 'crud_taulut(taulu)', 'oikeudet(oikeus)']) {
    assert.ok(new RegExp(`${cte.replace('(', '\\(').replace(')', '\\)')}\\s+as\\s*\\(\\s*values`)
      .test(koodi),
      `${cte} ei ole values-rivijoukko`);
  }

  // Eikä tiedostossa ole enää yhtään text[]-taulukkoa CTE:ssä.
  assert.equal(/::text\[\]\s+as\s+\w+/.test(koodi), false,
    'CTE palauttaa yhä text[]-sarakkeen — jäsenyystesti voi mennä väärin');

  // Nimityyppinen sarake castataan tekstiksi ennen vertailua. Se ei ole
  // pakollista (name -> text on implisiittinen), mutta se tekee
  // vertailun tyypin näkyväksi lukijalle.
  const castatut = (koodi.match(/(?:tablename|relname)::text in \(select/g) || []).length;
  assert.equal(castatut, jasenyydet,
    `vain ${castatut}/${jasenyydet} jäsenyystestiä castaa nimen tekstiksi`);
});


// =====================================================================
// AUTH-RIIPPUVUUDEN EROTTAMINEN PÄÄVERIFIERISTÄ
// =====================================================================
//
// LÖYTYNYT VIKA, JOTA NÄMÄ VARTIOIVAT
//
// Lopullinen varmistus luki auth.users-taulua kahdessa kohdassa:
// käyttäjämäärän tarkistuksessa ja kymmenessä orpojen rivien
// LEFT JOINissa. Taulu ei ole authenticated-roolin luettavissa, joten
// koko varmistus kaatui tuotannossa koodiin 42501 — eikä yksikään
// tarkistus kertonut mitään.
//
// Se oli huono jako. Varmistuksen SISÄLTÖ ei riipu istunnon roolista,
// vain sen ajettavuus. Rooliriippuvat tarkistukset ovat nyt omassa
// precheckissään, ja pääverifieri lukee pelkkää public-skeemaa ja
// järjestelmäkatalogeja.
//
// Orpojen rivien invariantti EI heikentynyt: se todistetaan nyt
// rakenteesta (validoitu ON DELETE CASCADE -vierasavain tekee orvosta
// rivistä mahdottoman) yhdessä tyhjien taulujen ja tunnetun omistajan
// kanssa. Ainoa osa, joka siirtyi privileged-ajoon, on väite
// "tunnettu omistaja on kannan ainoa käyttäjä".

const PRECHECK = 'supabase/acceptance/precheck_0003_0008_auth_final.sql';

test('KRIITTINEN: pääverifieri ei lue auth-skeemaa lainkaan', () => {
  // Tämä on koko muutoksen ydin. Yksikin auth.*-luku palauttaisi
  // rooliriippuvuuden, ja varmistus kaatuisi taas kokonaan sen sijaan
  // että kertoisi mitä kannassa on.
  const koodi = pelkkaKoodi(LOPULLINEN);

  assert.equal(/(?:from|join)\s+auth\./i.test(koodi), false,
    'pääverifieri lukee auth-skeeman taulua — se kaatuu 42501:een'
    + ' väärässä istunnon roolissa');

  assert.equal(/\bauth\.users\b/i.test(koodi), false,
    'pääverifieri viittaa auth.users-tauluun suoritettavassa koodissa');

  // `auth.uid()` merkkijonovakiona on eri asia: sitä verrataan
  // pg_policies.qual- ja column_default-teksteihin, eikä se lue
  // mitään. Ne saavat jäädä, ja niiden pitääkin jäädä — muuten
  // omistajuusrajauksen tarkistus katoaisi.
  const lahde = read(LOPULLINEN);
  assert.ok(lahde.includes("'auth.uid()=user_id'"),
    'omistajuusrajauksen tarkistus katosi');
  assert.ok(lahde.includes("column_default like '%auth.uid()%'"),
    'omistajan oletusarvon tarkistus katosi');
});

test('KRIITTINEN: orpojen rivien invariantti todistetaan rakenteesta', () => {
  // Kun auth.users-liitokset poistettiin, sama takuu on todistettava
  // toisin. Se ei saa olla heikompi.
  //
  // Validoitu vierasavain tekee orvosta rivistä MAHDOTTOMAN: kanta
  // valvoo sitä jokaisessa kirjoituksessa, ja `convalidated` tarkoittaa
  // että myös olemassa olleet rivit tarkistettiin rajoitetta lisättäessä.
  // NOT VALID -rajoite koskisi vain uusia rivejä, ja silloin vanhat
  // orvot jäisivät näkymättä.
  const lahde = read(LOPULLINEN);

  const cascadeLohko = lahde.split('union all')
    .find(osa => osa.includes('cascade on olemassa ja validoitu'));
  assert.ok(cascadeLohko, 'validoidun cascade-viitteen tarkistusta ei löytynyt');

  assert.ok(cascadeLohko.includes('con.convalidated'),
    'cascade-tarkistus ei vaadi rajoitteen validointia'
    + ' — NOT VALID -rajoite päästäisi vanhat orvot läpi');
  assert.ok(cascadeLohko.includes("fn.nspname = 'auth'")
    && cascadeLohko.includes("ft.relname = 'users'"),
    'cascade-tarkistus ei kohdistu auth.users-tauluun');
  assert.ok(cascadeLohko.includes("confdeltype = 'c'"),
    'cascade-tarkistus ei vaadi ON DELETE CASCADEa');

  // Ja todistuksen muut osat ovat tallella.
  for (const [osuma, mika] of [
    ['Kaikki kymmenen porttitaulua ovat tyhjia', 'tyhjät porttitaulut'],
    ['Yhtaan tehtavaa ei omista odottamaton kayttaja', 'tehtävien omistaja'],
    ['Profiilirivi kuuluu tunnetulle omistajalle', 'profiilin omistaja'],
    ['Omistajattomia tehtavia ei ole', 'omistajattomat tehtävät'],
    ['Omistajattomia riveja ei ole yhdessakaan porttitaulussa', 'omistajattomat rivit']
  ]) {
    assert.ok(lahde.includes(osuma),
      `orpojen todistuksesta puuttuu osa: ${mika}`);
  }
});

test('KRIITTINEN: precheck lukee auth.users ja on siihen tarkoitettu', () => {
  // Rooliriippuvuus ei katosi, se siirtyi. Precheckin PITÄÄ lukea
  // auth.users — se on sen koko tehtävä.
  const lahde = read(PRECHECK);
  const koodi = pelkkaKoodi(PRECHECK);

  // KOLME LUKUA, EI YKSI.
  //
  // Sisaltyvyystesti meni lapi mutaatiosta, jossa kayttajamaaran
  // laskenta korvattiin vakiolla: kaksi muuta lukua jai jaljelle ja
  // sana `from auth.users` esiintyi yha. Precheck lukee taulun
  // kolmesti -- maara, tunnettu omistaja, tuntemattomat -- ja
  // jokainen niista on oma vaitteensa.
  assert.equal((koodi.match(/from auth\.users/gi) || []).length, 3,
    'precheck ei lue auth.users-taulua kolmesti'
    + ' — jokainen kolmesta väitteestä tarvitsee oman lukunsa');

  // Ja se sanoo lukijalle, että postgres-rooli vaaditaan.
  assert.match(lahde, /POSTGRES-ROOLILLA/,
    'precheck ei kerro, että se vaatii postgres-roolin');

  // Istunnon rooli tarkistetaan ENNEN auth-lukua, jotta väärä rooli
  // näkyy selkeänä FAILina eikä pelkkänä 42501-kaatumisena.
  // RAAKALAHTEESTA, ei riisutusta koodista: pelkkaKoodi poistaa
  // merkkijonovakiot, jolloin current_setting('role', true) muuttuu
  // muotoon current_setting('', true) eika osu.
  for (const funktio of ['current_user', 'session_user', "current_setting('role', true)"]) {
    assert.ok(lahde.includes(funktio),
      `precheck ei tarkista istunnon tilaa: ${funktio}`);
  }
});

test('KRIITTINEN: precheck todistaa omistajan, ei vain käyttäjämäärää', () => {
  // Pelkkä lukumäärä ei riitä: yksi käyttäjä voisi olla väärä
  // käyttäjä. Pääverifieri luottaa siihen, että jäljellä oleva
  // käyttäjä on juuri se, jonka se olettaa omistavan kaiken datan.
  const lahde = read(PRECHECK);

  assert.ok(lahde.includes('2cc00622-f927-4604-a518-361a4328481b'),
    'precheck ei tunne odotettua omistajaa');
  assert.ok(lahde.includes('Jaljella oleva kayttaja on tunnettu omistaja'),
    'precheck ei tarkista, että jäljellä oleva käyttäjä on oikea');
  assert.ok(lahde.includes('Yhtaan tuntematonta kayttajaa ei ole'),
    'precheck ei sulje pois tuntemattomia käyttäjiä');
});

test('KRIITTINEN: precheck on read-only eikä muuta oikeuksia', () => {
  // Tuotannon virheilmoitus ehdotti ratkaisuksi
  //   GRANT SELECT ON auth.users TO authenticated
  // Sitä ei saa tehdä: se avaisi jokaiselle kirjautuneelle käyttäjälle
  // pääsyn kaikkien tilien sähköpostiosoitteisiin. Kumpikaan tiedosto
  // ei saa sisältää sellaista.
  for (const polku of [PRECHECK, LOPULLINEN]) {
    const koodi = pelkkaKoodi(polku);
    const nimi = polku.split('/').pop();

    for (const kielletty of ['insert', 'update', 'delete', 'alter', 'drop',
                             'create', 'grant', 'revoke', 'truncate',
                             'merge', 'commit', 'rollback']) {
      assert.equal(new RegExp(`\\b${kielletty}\\b`, 'i').test(koodi), false,
        `${nimi}: sisältää sanan "${kielletty}" suoritettavassa koodissa`);
    }
    assert.equal(/\bset\s+role\b/i.test(koodi), false,
      `${nimi}: vaihtaa istunnon roolia`);
  }
});

test('KRIITTINEN: precheck on yksi lause ja palauttaa aina rivejä', () => {
  const lahde = read(PRECHECK);
  const koodi = pelkkaKoodi(PRECHECK);

  assert.equal((lahde.match(/;/g) || []).length, 1,
    'precheckissä on muitakin puolipisteitä kuin viimeinen');
  assert.match(lahde.trimEnd(), /;$/, 'precheck ei pääty puolipisteeseen');

  const tarkistuksia = (koodi.match(/union all/gi) || []).length + 1;
  assert.equal(tarkistuksia, 6, `precheckissä on ${tarkistuksia} tarkistusta, odotettiin 6`);

  // Jokainen tarkistus alkaa vakiolla, joten tulos ei voi olla tyhjä.
  const tarkistusLohko = koodi.slice(koodi.indexOf('tarkistukset as ('));
  const vakiolla = [...tarkistusLohko.matchAll(/(?:union all|as \()\s*select\s+''/gi)].length;
  assert.equal(vakiolla, tarkistuksia,
    `vain ${vakiolla}/${tarkistuksia} precheck-tarkistusta alkaa vakiolla`);
});

test('KRIITTINEN: precheck tuottaa saman tulostaulukon kuin pääverifieri', () => {
  // Sama muoto molemmissa: operaattorin ei tarvitse opetella kahta
  // tapaa lukea tulosta.
  const koodi = pelkkaKoodi(PRECHECK);

  const projektio = koodi
    .slice(koodi.lastIndexOf('select t.check_no'), koodi.lastIndexOf('from tarkistukset'))
    .replace(/filter\s*\([^)]*\)/gi, '');

  for (const sarake of ['check_no', 'section', 'check_name',
                        'expected', 'actual', 'status', 'failures_total']) {
    assert.ok(new RegExp(`\\bas ${sarake}\\b|\\bt\\.${sarake}\\s*[,\\n]`).test(projektio),
      `precheckin projektiosta puuttuu sarake ${sarake}`);
  }

  assert.ok(read(PRECHECK).includes("then 'PASS' else 'FAIL' end as status"),
    'precheckin status ei ole yksinomaan PASS tai FAIL');
  assert.ok(koodi.includes('over () as failures_total'),
    'precheckin failures_total ei ole ikkunafunktio');
});

test('KRIITTINEN: tiedostot ohjaavat toisiinsa oikeassa järjestyksessä', () => {
  // Operaattorin on tiedettävä, kumpi ajetaan ensin — ja miksi
  // pääverifieri ei enää vaadi postgres-roolia.
  const paa = read(LOPULLINEN);
  const pre = read(PRECHECK);

  assert.ok(paa.includes('precheck_0003_0008_auth_final.sql'),
    'pääverifieri ei ohjaa precheckiin');
  assert.ok(pre.includes('verify_0003_0008_post_acceptance_final.sql'),
    'precheck ei ohjaa pääverifieriin');

  // Ja kumpikaan ei ehdota GRANTia ratkaisuksi.
  // KOODISTA, ei kommenteista. Precheckin otsikko mainitsee GRANTin
  // nimenomaan kertoakseen, ettei sita saa tehda -- se on ohje, ei
  // ehdotus. Kommenttien lukeminen tekisi varoituksesta virheen.
  for (const [nimi, polku] of [['pääverifieri', LOPULLINEN], ['precheck', PRECHECK]]) {
    assert.equal(/grant/i.test(pelkkaKoodi(polku)), false,
      `${nimi} sisältää GRANTin suoritettavassa koodissa`);
  }
});

// ------------------------------------------ FREEZE: varmistuskyselyt

test('varmistuskyselyt ovat vain lukevia', () => {
  // Nämä tiedostot on tarkoitettu ajettaviksi tuotantokantaa vasten
  // käsin. Yksikään ei saa koskaan muuttaa mitään. Jos joku joskus
  // lisää tänne korjaavan lauseen, tämä testi kaatuu ensin.
  const dir = path.join(ROOT, 'supabase/verify');
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.sql'));

  // Migraatiokohtaisia varmistuksia on tasan yksi per migraatio. Muut
  // varmistukset samassa hakemistossa (esim. lipun aktivoinnin jälkeen
  // ajettava) eivät kuulu tähän lukuun — ne eivät varmista migraatiota
  // vaan sovelluksen käyttöönottoa. Aiemmin ehto oli pelkkä
  // tiedostomäärä, jolloin uusi varmistus näytti puuttuvalta
  // migraatiolta.
  const migraatiokohtaiset = files.filter(name => /^verify_\d{4}\.sql$/.test(name));
  assert.equal(migraatiokohtaiset.length, 10, 'yksi varmistustiedosto migraatiota kohti');

  // supabase/acceptance elaa saman saannon alla. Se ei ole
  // migraatiokohtainen varmistus, joten se on eri hakemistossa, mutta se
  // ajetaan tuotantoa vasten kasin samalla tavalla — ja siksi sen on
  // oltava yhta ehdottomasti vain lukeva.
  const kaikki = [
    ...files.map(name => ['supabase/verify', name]),
    ...['supabase/acceptance', 'supabase/preflight'].flatMap(hakemisto =>
      fs.readdirSync(path.join(ROOT, hakemisto))
        .filter(name => name.endsWith('.sql'))
        .map(name => [hakemisto, name]))
  ];

  // Tarkistus tehdään LAUSEEN ALKUSANASTA, ei sisältyvyydestä. Kielletty
  // sana esiintyy laillisesti tunnisteiden sisällä: role_table_grants
  // sisältää sanan "grant" ja odotettu "on delete set null" sanan "delete".
  // Sisältyvyystarkistus antaisi vääriä hälytyksiä lisäämättä kattavuutta:
  // muuttava lause voi olla vain lauseen alussa.
  for (const [hakemisto, name] of kaikki) {
    // Kommentit pois: selitysteksti saa puhua migraatioista vapaasti.
    const sql = fs.readFileSync(path.join(ROOT, hakemisto, name), 'utf8')
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');

    const statements = sql.split(';')
      .map(part => part.trim())
      .filter(part => part.length > 0);

    assert.ok(statements.length > 0, `${name} on tyhjä`);

    for (const statement of statements) {
      const first = statement.split(/\s+/)[0].toLowerCase();

      // `with` on sallittu, MUTTA VAIN LUKEVANA.
      //
      // PostgreSQL tuntee dataa muuttavat CTE:t:
      //
      //   with poistetut as (delete from t returning *) select * from poistetut
      //
      // Sellainen lause alkaa sanalla `with` ja muuttaa kantaa. Pelkkä
      // alkusanan salliminen olisi siis reikä, ei laajennus. Siksi
      // `with`-lauseelle on kaksi lisäehtoa, jotka `select`-lause
      // täyttää väistämättä.
      assert.ok(first === 'select' || first === 'with',
        `${name}: lause alkaa sanalla "${first}" — vain select ja with ovat sallittuja`);

      if (first !== 'with') continue;

      // 1. Jokainen CTE-runko alkaa sanalla select. Juuri tähän
      //    dataa muuttava CTE kirjoitettaisiin.
      const rungot = [...statement.matchAll(/\bas\s*\(\s*(\w+)/gi)].map(m => m[1].toLowerCase());
      assert.ok(rungot.length > 0, `${name}: with-lauseessa ei ole yhtään CTE:tä`);
      // `values` on sallittu selectin rinnalla. Se on rivien
      // muodostin, ei lause joka koskee tauluun: `values ('a'), ('b')`
      // ei lue eika kirjoita mitaan. Vaara jota tama vahtii on dataa
      // muuttava CTE (insert/update/delete/merge), eika `values` ole
      // sellainen.
      for (const runko of rungot) {
        assert.ok(['select', 'values'].includes(runko),
          `${name}: CTE alkaa sanalla "${runko}" — vain select ja values ovat sallittuja`);
      }

      // 2. Uloimmalla tasolla ei ole yhtään muuttavaa avainsanaa.
      //    Sulkeiden sisältö riisutaan pois, koska siellä sanat
      //    esiintyvät laillisesti merkkijonoina — esimerkiksi
      //    oikeuslistassa array['select', 'insert', 'update', 'delete'].
      let syvyys = 0;
      let ulkotaso = '';
      for (const merkki of statement) {
        if (merkki === '(') syvyys += 1;
        else if (merkki === ')') syvyys -= 1;
        else if (syvyys === 0) ulkotaso += merkki;
      }

      // KAKSOISKENOVIIVA ON PAKOLLINEN. Template literalissa `\b`
      // on askelpalautin, ei sanaraja: RegExp saisi ohjausmerkin ja
      // ehto ei osuisi koskaan mihinkaan. Regex-literaalissa
      // (/\bselect\b/) sama merkinta tarkoittaa sanarajaa.
      for (const kielletty of ['insert', 'update', 'delete', 'merge', 'truncate',
                               'create', 'drop', 'alter', 'grant', 'revoke']) {
        assert.ok(!new RegExp(`\\b${kielletty}\\b`, 'i').test(ulkotaso),
          `${name}: with-lauseen uloin taso sisältää sanan "${kielletty}"`);
      }

      assert.match(ulkotaso, /\bselect\b/i,
        `${name}: with-lause ei pääty select-kyselyyn`);
    }
  }
});

test('KRIITTINEN: jokainen vierasavain on varmistuskyselyn ulottuvilla', () => {
  // Vierasavaimen poistosääntö on domain-päätös, joka elää vain
  // kannassa. Jos SET NULL vaihtuisi CASCADEksi, tavoitteen poisto
  // veisi tehtävät — eikä mikään sovelluskoodissa huomaisi sitä.
  // Varmistuskysely on ainoa paikka, jossa se voitaisiin nähdä.
  //
  // Tämä testi löysi verify_0004:stä oikean aukon: se listasi
  // vierasavaimet NIMELTÄ ja kaksi kuudesta puuttui listasta. Molemmat
  // syntyvät create table -lauseen sisällä, joten ne on helppo unohtaa.
  //
  // Kaksi hyväksyttyä tapaa kattaa vierasavain:
  //   1. rajoite mainitaan nimeltä
  //   2. kysely rajataan taulun conrelid-arvolla, jolloin kaikki sen
  //      taulun vierasavaimet tulevat mukaan nimistä riippumatta
  for (const name of migrationFiles()) {
    const number = name.slice(0, 4);
    const source = sql(name);
    const verify = read(`supabase/verify/verify_${number}.sql`).toLowerCase();

    /** taulu -> vierasavaimen nimi, sekä nimetyt että create tablen sisäiset. */
    const foreignKeys = new Map();
    const add = (table, constraint) => {
      if (!foreignKeys.has(table)) foreignKeys.set(table, new Set());
      foreignKeys.get(table).add(constraint);
    };

    for (const match of source.matchAll(
      /alter table public\.(\w+)[\s\S]{0,120}?add constraint (\w+)\s+foreign key/g)) {
      add(match[1], match[2]);
    }

    for (const table of source.matchAll(
      /create table public\.(\w+) \(([\s\S]*?)\n\);/g)) {
      for (const column of table[2].matchAll(
        /^\s+(\w+)\s+\w+[^\n]*?references\s+public\./gm)) {
        add(table[1], `${table[1]}_${column[1]}_fkey`);
      }
    }

    for (const [table, constraints] of foreignKeys) {
      // Taulukohtainen rajaus kattaa kaikki taulun vierasavaimet.
      const scopedByTable = verify.includes(`'public.${table}'::regclass`);
      if (scopedByTable) continue;

      for (const constraint of constraints) {
        assert.ok(verify.includes(constraint),
          `verify_${number}.sql ei kata vierasavainta ${constraint}`
          + ` — ei nimeltä eikä taulun ${table} kautta.`
          + ' Väärä poistosääntö jäisi huomaamatta.');
      }
    }
  }
});

test('jokaiselle migraatiolle on varmistuskysely', () => {
  const verify = fs.readdirSync(path.join(ROOT, 'supabase/verify'))
    .filter(name => name.endsWith('.sql'));

  for (const migration of migrationFiles()) {
    const number = migration.slice(0, 4);
    assert.ok(verify.includes(`verify_${number}.sql`),
      `migraatiolta ${number} puuttuu varmistuskysely`);
  }
});

test('varmistuskyselyt eivät lue käyttäjän sisältöä', () => {
  // Varmistus katsoo rakennetta ja rivimääriä. Se ei saa tulostaa
  // tehtävien otsikoita, hyvinvointimerkintöjä eikä rahasummia — eikä
  // koskaan avaimia.
  const tiedostot = ['supabase/verify', 'supabase/acceptance',
                     'supabase/preflight'].flatMap(hakemisto =>
    fs.readdirSync(path.join(ROOT, hakemisto))
      .filter(f => f.endsWith('.sql'))
      .map(f => [hakemisto, f]));

  for (const [hakemisto, name] of tiedostot) {
    const sql = fs.readFileSync(path.join(ROOT, hakemisto, name), 'utf8')
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n')
      .toLowerCase();

    assert.equal(/select\s+\*/.test(sql), false,
      `${name}: select * voi paljastaa käyttäjän sisältöä`);

    // ITSENAINEN TUNNISTE, EI OSAJONO.
    //
    // Sisaltyvyystarkistus antoi vaaria halytyksia: rajoitteen nimi
    // routines_title_check sisaltaa sanan "title", vaikka se ei lue
    // yhtaan riviarvoa. Varmistus olisi pitanyt heikentaa lopettamalla
    // rajoitteen tarkistaminen — eli oikea tarkistus olisi purettu
    // valheellisen halytyksen takia.
    //
    // Nyt sana lasketaan vain kun se esiintyy omana tunnisteenaan.
    // Alaviivalla ymparoity osajono (routines_title_check,
    // routine_exceptions_type_check) ei ole sarakkeen luku.
    //
    // TOINEN VAARA HALYTYS, SAMA PERIAATE.
    //
    // Varmistus nimeaa odotetut sarakkeet luettelona:
    //   and column_name in ('id', 'user_id', 'title', ...)
    // Nama ovat merkkijonovakioita, joita verrataan
    // information_schema.columns-taulun sisaltoon. Ne eivat lue
    // yhtaan riviarvoa — `where column_name = 'title'` on
    // rakennekysely, `select title from goals` on sisallon luku.
    //
    // Ero on siina, onko sana lainausmerkeissa. Merkkijonovakio ei voi
    // lukea saraketta, joten vakiot poistetaan ennen tarkistusta.
    // Paljas tunniste kaataa testin yha.
    const ilmanVakioita = sql.replace(/'[^']*'/g, "''");

    for (const column of ['title', 'note', 'anon_key', 'service_role', 'password']) {
      const itsenaisena = new RegExp(`(^|[^a-z0-9_])${column}([^a-z0-9_]|$)`);
      assert.equal(itsenaisena.test(ilmanVakioita), false,
        `${name} lukee saraketta ${column}`);
    }
  }
});


// =====================================================================
// AJO-OHJE JA PALAUTUSDOKUMENTIT PITÄVÄT PAIKKANSA
// =====================================================================
//
// Dokumentti, joka kertoo väärän objektimäärän tai puuttuvan tiedoston,
// ohjaa operaattoria väärin juuri silloin kun tilanne on jo huono.
// Nämä testit vertaavat dokumenttien luvut ja viittaukset siihen, mitä
// repositoriossa oikeasti on.

const RUNBOOK = 'docs/MIGRATIONS-0004-0008-PRODUCTION-RUNBOOK.md';

test('KRIITTINEN: jokaisella erän migraatiolla on palautusdokumentti', () => {
  // Migraation virheilmoitus ohjaa dokumenttiin nimeltä. Jos sitä ei
  // ole, ohje päättyy umpikujaan kesken ajon.
  for (const numero of ['0004', '0005', '0006', '0007', '0008']) {
    const doc = `docs/MIGRATION-${numero}-RECOVERY.md`;
    assert.ok(fs.existsSync(path.join(ROOT, doc)),
      `palautusdokumentti puuttuu: ${doc}`);

    // Ja migraatio viittaa siihen.
    const migraatio = migrationFiles().find(n => n.startsWith(numero));
    assert.ok(sql(migraatio).includes(`docs/migration-${numero}-recovery.md`),
      `migraatio ${numero} ei ohjaa palautusdokumenttiin`);
  }
});

test('KRIITTINEN: palautusdokumenttien objektimäärät vastaavat migraatioita', () => {
  // Objektimäärä on se luku, jonka operaattori näkee virheilmoituksessa
  // ("N objektia M:sta on jo olemassa"). Jos dokumentti kertoo eri M:n,
  // operaattori ei tiedä onko tilanne odotettu.
  for (const numero of ['0004', '0005', '0006', '0007', '0008']) {
    const migraatio = migrationFiles().find(n => n.startsWith(numero));
    const lahde = sql(migraatio).split(`${NEWLINE}commit;`)[0]
      .split(NEWLINE)
      .filter(line => !line.trim().startsWith('--'))
      .join(NEWLINE);

    const laske = hahmo => [...lahde.matchAll(hahmo)].length;
    const maara = laske(/create table public\.\w+/g)
      + laske(/add column \w+/g)
      + laske(/add constraint \w+/g)
      + laske(/^\s+constraint \w+/gm)
      + laske(/create index \w+/g)
      + laske(/create trigger \w+/g)
      + laske(/create policy \w+/g);

    const doc = read(`docs/MIGRATION-${numero}-RECOVERY.md`);
    const ehdollinen = lahde.includes('routines_goal_id_fkey');
    const odotettu = ehdollinen ? `${maara - 1} tai ${maara}` : String(maara);

    assert.ok(doc.includes(`**${odotettu} objektia**`),
      `MIGRATION-${numero}-RECOVERY.md ei kerro oikeaa objektimäärää`
      + ` (migraatio luo ${odotettu})`);
  }
});

test('KRIITTINEN: palautusdokumenttien rollback vastaa migraatiota', () => {
  // Rollback-lauseet on kopioitu migraatiosta. Jos migraation
  // rollbackia muutetaan eikä dokumenttia, dokumentti neuvoo ajamaan
  // vanhentuneita lauseita.
  for (const numero of ['0004', '0005', '0006', '0007', '0008']) {
    const migraatio = migrationFiles().find(n => n.startsWith(numero));
    const lahde = read(`${MIGRATION_DIR}/${migraatio}`);
    const doc = read(`docs/MIGRATION-${numero}-RECOVERY.md`);

    // Jokainen migraation rollback-lohkon drop-lause on dokumentissa.
    const rollbackKohta = lahde.lastIndexOf('-- ROLLBACK');
    assert.ok(rollbackKohta > 0, `${migraatio}: rollback-lohkoa ei ole`);

    const lauseet = [...lahde.slice(rollbackKohta)
      .matchAll(/--\s+(drop (?:table|index) if exists [^;]+;)/g)].map(m => m[1]);

    assert.ok(lauseet.length > 0, `${migraatio}: rollbackissa ei ole drop-lauseita`);

    for (const lause of lauseet) {
      assert.ok(doc.includes(lause),
        `MIGRATION-${numero}-RECOVERY.md ei sisällä lausetta: ${lause}`);
    }
  }
});

test('KRIITTINEN: ajo-ohje viittaa jokaiseen tiedostoon jonka se nimeää', () => {
  // Ajo-ohje on operaattorin ainoa dokumentti ajon aikana. Jokaisen
  // siinä nimetyn tiedoston on oltava olemassa — puuttuva tiedosto
  // huomataan vasta kun sitä yritetään ajaa.
  const runbook = read(RUNBOOK);

  const polut = [...runbook.matchAll(
    /`((?:supabase|docs|tools|src)\/[\w./-]+)`/g)].map(m => m[1]);

  // Kynnys on olemassa vain tyhjentymisen varalta: jos hahmo lakkaisi
  // osumasta, testi kävisi läpi nolla polkua ja menisi läpi. Luku ei
  // ole tavoite vaan alaraja — ajo-ohje nimeää tiedostoja myös
  // taulukoissa ja koodilohkoissa ilman polkua, ja ne tarkistetaan
  // erikseen seuraavassa testissä.
  assert.ok(polut.length >= 10,
    `ajo-ohjeesta löytyi vain ${polut.length} tiedostoviittausta`);

  for (const polku of new Set(polut)) {
    assert.ok(fs.existsSync(path.join(ROOT, polku)),
      `ajo-ohje viittaa tiedostoon jota ei ole: ${polku}`);
  }
});

test('KRIITTINEN: ajo-ohje nimeää jokaisen erän migraation ja varmistuksen', () => {
  const runbook = read(RUNBOOK);

  for (const numero of ['0004', '0005', '0006', '0007', '0008']) {
    const migraatio = migrationFiles().find(n => n.startsWith(numero));
    assert.ok(runbook.includes(migraatio),
      `ajo-ohje ei nimeä migraatiota ${migraatio}`);
    assert.ok(runbook.includes(`preflight_${numero}.sql`),
      `ajo-ohje ei nimeä preflightia ${numero}`);
    assert.ok(runbook.includes(`verify_${numero}.sql`),
      `ajo-ohje ei nimeä varmistusta ${numero}`);
  }

  for (const tiedosto of ['preflight_0004_0008_batch.sql',
                          'recovery_snapshot_pre_0004_0008.sql',
                          'verify_0004_0008_final.sql',
                          'verify_0003_0008_acceptance.sql']) {
    assert.ok(runbook.includes(tiedosto),
      `ajo-ohje ei nimeä tiedostoa ${tiedosto}`);
  }
});

test('KRIITTINEN: ajo-ohjeen viiteluettelo vastaa migraatioita', () => {
  // Ajo-ohje luettelee yhdeksän omistajuusviitettä taulukkona. Jos
  // migraatio saa uuden viitteen eikä taulukko päivity, operaattori
  // tarkistaisi vääriä asioita.
  const runbook = read(RUNBOOK);

  const kannassa = [];
  for (const name of migrationFiles().filter(n => /^000[3-8]/.test(n))) {
    const lahde = sql(name).split(NEWLINE)
      .filter(line => !line.trim().startsWith('--'))
      .join(NEWLINE);
    for (const m of lahde.matchAll(
      /foreign key \(user_id,\s*(\w+)\)\s*references public\.(\w+)/g)) {
      kannassa.push(m[1]);
    }
  }

  assert.equal(kannassa.length, 9, 'viitteiden määrä muuttui');

  for (const sarake of kannassa) {
    assert.ok(runbook.toLowerCase().includes(sarake),
      `ajo-ohje ei mainitse viitettä ${sarake}`);
  }
});

test('KRIITTINEN: ajo-ohje sanoo, ettei porttia avata ennen hyväksyntätestiä', () => {
  // Tämä on koko ohjeen tärkein sääntö. Varmistus todistaa rakenteen;
  // se ei todista, että RLS toimii oikeiden käyttäjien välillä.
  const runbook = read(RUNBOOK);

  assert.match(runbook, /hyväksyntätesti/i,
    'ajo-ohje ei mainitse hyväksyntätestiä');
  assert.match(runbook, /tili B/i,
    'ajo-ohje ei kerro väliaikaisesta tilistä B');
  assert.match(runbook, /23503/,
    'ajo-ohje ei kerro odotettua virhekoodia ristiinkiinnitykselle');
  assert.match(runbook, /yksi kerrallaan/i,
    'ajo-ohje ei kehota kääntämään portteja yksi kerrallaan');
  assert.match(runbook, /CACHE_VERSION/,
    'ajo-ohje ei muistuta välimuistiversion nostosta');
});

test('KRIITTINEN: dokumentit eivät lupaa enempää kuin paketti todistaa', () => {
  // Dokumentti, joka väittää migraatioiden olevan testattuja, on
  // väärässä tavalla joka huomataan vasta tuotannossa. Niitä ei ole
  // ajettu missään.
  const runbook = read(RUNBOOK);

  assert.match(runbook, /EI AJETTU/,
    'ajo-ohje ei kerro, ettei migraatioita ole ajettu');
  assert.match(runbook, /Mitä tämä paketti EI todista/,
    'ajo-ohjeesta puuttuu rajaukset-osuus');

  for (const numero of ['0004', '0005', '0006', '0007', '0008']) {
    const doc = read(`docs/MIGRATION-${numero}-RECOVERY.md`);
    assert.match(doc, /EI AJETTU/,
      `MIGRATION-${numero}-RECOVERY.md ei kerro, ettei migraatiota ole ajettu`);
  }
});

// -------------------------------- FREEZE: dokumentaation totuudellisuus

test('portin takainen ominaisuusdokumentti kertoo, ettei tieto vielä säily', () => {
  // Dokumentti, joka kuvaa ominaisuuden toimivaksi mainitsematta ettei se
  // säily, on väärässä tavalla joka huomataan vasta kun käyttäjä menettää
  // työnsä. Jokaisen portin takaisen ominaisuuden dokumentin pitää sanoa
  // se ääneen.
  const gated = [
    ['docs/ROUTINES.md', ['routines', 'routineExceptions']],
    ['docs/GOALS.md', ['goals', 'projects']],
    ['docs/NOTIFICATIONS.md', ['notificationPreferences']]
  ];

  for (const [file, gates] of gated) {
    const stillGated = gates.some(name => TABLES[name] !== true);
    if (!stillGated) continue;

    const doc = read(file);
    assert.ok(/eiv?[aä]?t? viel[aä] s[aä]ily|eiv?[aä]?t? s[aä]ily|ei tallennu|vain istunnon/i.test(doc),
      `${file} kuvaa portin takaista ominaisuutta kertomatta, ettei tieto vielä säily`);
  }
});

test('dokumentaatio ei viittaa poistettuihin moduuleihin', () => {
  // Rakennekuvaus, joka listaa tiedostoja joita ei ole, opettaa lukijaa
  // olemaan luottamatta siihen.
  const structureDoc = read('docs/MODULARIZATION.md');

  for (const match of structureDoc.matchAll(/^\s{2,}([a-zA-Z][\w-]*\.js)\s{2,}/gm)) {
    const name = match[1];
    const found = browserModules().some(file => file.endsWith('/' + name));
    assert.ok(found, `MODULARIZATION.md listaa moduulin jota ei ole: ${name}`);
  }
});

// ================================================================
// 0001 on sovitettu TODELLISEEN tuotantoskeemaan
// ================================================================
//
// Nämä testit eivät tarkista SQL:n syntaksia — sitä ei voi tarkistaa
// ilman kantaa. Ne vartioivat niitä KOHTIA, joissa yleisluonteinen
// migraatio meni tuotantoa vasten rikki, ja joissa tulevaisuuden
// muokkaaja voisi rikkoa sen uudelleen tietämättä miksi.
//
// Tuotannon todennettu lähtötila:
//   profile  1 rivi, id = 'me', tyyppi text
//   tasks   36 riviä, ei user_id-saraketta

const MIGRATION_0001 = '0001_auth_user_scoping.sql';
const OWNER_UUID = '2cc00622-f927-4604-a518-361a4328481b';

/** 0001 ilman kommentteja. Selitysteksti saa puhua vapaasti. */
function code0001() {
  return read(`${MIGRATION_DIR}/${MIGRATION_0001}`)
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .toLowerCase();
}

test('KRIITTINEN: 0001 ei yritä muuntaa profile.id:tä uuid-tyypiksi', () => {
  // Tuotannon ainoan profiilirivin id on 'me'. Se EI ole uuid.
  //   alter column id type uuid using id::uuid
  // kaatuu heti ensimmäiseen riviin ja keskeyttää migraation.
  //
  // Tämä on se yksi virhe, jonka takia 0001 kirjoitettiin uusiksi.
  // Jos joku palauttaa sen, tämä testi kaatuu ensin.
  const code = code0001();

  assert.equal(/id\s*::\s*uuid/.test(code), false,
    'profile.id:tä muunnetaan uuid:ksi — tuotannon arvo on "me" ja muunnos kaatuu');
  assert.equal(/alter\s+column\s+id\s+type\s+uuid/.test(code), false,
    'profile.id:n tyyppiä muutetaan — tuotannon arvo ei ole uuid');
});

test('KRIITTINEN: 0001 säilyttää alkuperäisen tunnisteen', () => {
  // Vanha arvo 'me' on ainoa asia, joka tekee migraatiosta peruttavan
  // ilman varmuuskopion palautusta. Sen pudottaminen tekisi
  // rollback-osion valheeksi.
  const code = code0001();

  assert.match(code, /rename\s+column\s+id\s+to\s+legacy_id/,
    'vanhaa tunnistetta ei siirretä talteen');
  assert.equal(/alter\s+table\s+public\.profile\s+drop\s+column/.test(code), false,
    '0001 pudottaa sarakkeen profile-taulusta — alkuperäinen arvo katoaisi');
});

test('KRIITTINEN: 0001 nimeää omistajan vakiona eikä valitse sitä ajossa', () => {
  // Dynaaminen valinta antaisi väärän vastauksen sillä hetkellä, kun
  // kantaan on ehtinyt syntyä toinen tili — ja 36 tehtävää siirtyisi
  // väärälle ihmiselle peruuttamattomasti.
  const code = code0001();

  assert.ok(code.includes(OWNER_UUID),
    'omistajan tunnistetta ei ole kirjoitettu migraatioon');

  assert.equal(/\blimit\s+1\b/.test(code), false,
    'migraatio käyttää LIMIT 1 -valintaa');
  assert.equal(/order\s+by\s+created_at/.test(code), false,
    'migraatio valitsee omistajan rivijärjestyksen perusteella');
  assert.equal(/\bemail\s*=/.test(code), false,
    'migraatio arvaa omistajan sähköpostin perusteella');

  // Paikanpitäjä oli aiemman luonnoksen tapa. Sitä ei saa palata.
  assert.equal(code.includes('00000000-0000-0000-0000-000000000000'), false,
    'paikanpitäjä-uuid on palannut migraatioon');
});

test('KRIITTINEN: 0001 lukitsee taulut ennen kuin luottaa niiden tilaan', () => {
  // begin; ei jäädytä mitään. Postgresin oletuseristystaso on
  // READ COMMITTED, ja pelkkä select ottaa vain ACCESS SHARE -lukon,
  // joka ei estä toisen istunnon kirjoituksia.
  //
  // Ilman lukkoa aukko on todellinen: sovellus on pystyssä koko ajon
  // ajan, ja taustalle jäänyt välilehti voisi lisätä tehtävän SEN
  // JÄLKEEN kun rivimäärä on todettu 36:ksi mutta ENNEN kuin migraatio
  // saa oman DDL-lukkonsa. Migraatio tekisi päätöksensä tilasta, jota
  // ei enää ole — juuri se vika, jonka esiehdot oli tarkoitettu
  // estämään.
  const code = code0001();

  const lock = code.indexOf('lock table public.tasks, public.profile');
  assert.ok(lock !== -1,
    'tauluja ei lukita lainkaan — esiehdot voivat vanhentua kesken ajon');
  assert.match(code.slice(lock, lock + 120), /in access exclusive mode/,
    'lukko ei ole ACCESS EXCLUSIVE — heikompi ei estä kaikkia kirjoituksia');

  // Molemmat samassa lauseessa. Kaksi peräkkäistä lukkoa eri
  // järjestyksessä eri istunnoissa on klassinen lukkiutuma.
  assert.equal((code.match(/^lock table /gm) || []).length, 1,
    'lukkoja on useampi lause — lukkiutumisen riski');

  // Olemassaolotarkistus ENNEN lukkoa: LOCK TABLE olemattomaan tauluun
  // antaisi epäselvemmän virheen kuin oma tarkistus.
  const existence = code.indexOf('to_regclass');
  assert.ok(existence !== -1 && existence < lock,
    'lukitaan ennen kuin on varmistettu että taulut ovat olemassa');

  // Tuotannon tauluja ei LUETA ennen lukkoa. Tämä on se varsinainen
  // sääntö: mikä tahansa rivimäärä tai sisältö, joka luetaan lukitse-
  // mattomasta taulusta, voi olla vanhentunut jo seuraavalla rivillä.
  //
  // Vakioiden esittely vaiheessa 0 ei ole tuotannon lukemista, joten
  // tarkistus kohdistuu nimenomaan taulusta lukemiseen.
  for (const read of ['from public.tasks', 'from public.profile']) {
    const first = code.indexOf(read);
    assert.ok(first !== -1, `migraatio ei lue taulua lainkaan: ${read}`);
    assert.ok(first > lock,
      `taulusta luetaan ennen lukkoa (${read}) — tila voi muuttua sen jälkeen`);
  }

  // Osittaisen ajon tunnistus kuuluu myös lukon taakse: toinen istunto
  // voisi muuten ehtiä lisätä saman sarakkeen.
  for (const guard of ["column_name = 'user_id'", "column_name = 'legacy_id'"]) {
    const at = code.indexOf(guard.toLowerCase());
    assert.ok(at !== -1, `esiehto puuttuu: ${guard}`);
    assert.ok(at > lock, `esiehto "${guard}" tarkistetaan ennen lukkoa`);
  }

  // Ja lukko on ennen ensimmäistä muutosta.
  const firstChange = Math.min(
    ...['alter table public.tasks', 'alter table public.profile', 'update public.']
      .map(needle => {
        const at = code.indexOf(needle);
        return at === -1 ? Number.MAX_SAFE_INTEGER : at;
      }));
  assert.ok(lock < firstChange, 'ensimmäinen muutos tapahtuu ennen lukkoa');

  // Jonossa odottava ACCESS EXCLUSIVE estää jo itsessään kaikki uudet
  // lukijat. Ilman aikakatkaisua roikkuva istunto veisi sovelluksen alas.
  assert.match(code, /set local lock_timeout/,
    'lukon odotukselle ei ole aikakatkaisua');
  assert.ok(code.indexOf('set local lock_timeout') < lock,
    'aikakatkaisu asetetaan vasta lukon jälkeen');
});

test('0001 tarkistaa esiehdot ennen kuin se muuttaa mitään', () => {
  // Migraatio ei saa luottaa siihen, että inventaario on yhä voimassa.
  // Kanta on voinut muuttua inventoinnin ja ajon välissä.
  const code = code0001();

  const firstChange = Math.min(
    ...['alter table public.tasks', 'alter table public.profile', 'update public.']
      .map(needle => {
        const at = code.indexOf(needle);
        return at === -1 ? Number.MAX_SAFE_INTEGER : at;
      }));

  const firstGuard = code.indexOf('raise exception');
  assert.ok(firstGuard !== -1, 'esiehtotarkistuksia ei ole lainkaan');
  assert.ok(firstGuard < firstChange,
    'ensimmäinen muutos tapahtuu ennen ensimmäistä esiehtoa');

  // Jokainen tarkistus vastaa yhtä tapaa tehdä vahinkoa.
  for (const guard of [
    'expected_task_rows',        // rivimäärä on yhä sama
    'expected_profile_rows',
    'legacy_profile_id',         // ainoa rivi on tunnettu
    'auth.users',                // omistaja on olemassa
    "column_name = 'user_id'",   // ei osittain ajettu
    "column_name = 'legacy_id'"
  ]) {
    assert.ok(code.includes(guard.toLowerCase()),
      `esiehto puuttuu: ${guard}`);
  }
});

test('KRIITTINEN: user_id lukitaan pakolliseksi vasta backfillin jälkeen', () => {
  // Väärä järjestys kaataisi migraation 36 olemassa olevaan riviin.
  const code = code0001();

  const backfill = code.indexOf('update public.tasks');
  const notNull  = code.indexOf('alter column user_id set not null');
  const check    = code.indexOf('user_id is null');

  assert.ok(backfill !== -1 && notNull !== -1, 'backfill tai lukitus puuttuu');
  assert.ok(backfill < notNull,
    'user_id lukitaan pakolliseksi ennen kuin data on täytetty');
  assert.ok(check !== -1 && check > backfill && check < notNull,
    'täyttöä ei tarkisteta backfillin ja lukituksen välissä');
});

test('KRIITTINEN: profile.id lukitaan vasta täytön jälkeen', () => {
  const code = code0001();

  const backfill = code.indexOf('update public.profile');
  const notNull  = code.indexOf('alter column id set not null');

  assert.ok(backfill !== -1 && notNull !== -1, 'backfill tai lukitus puuttuu');
  assert.ok(backfill < notNull,
    'profile.id lukitaan pakolliseksi ennen kuin arvo on asetettu');
});

test('KRIITTINEN: 0001 poistaa vanhat salli-kaikki-politiikat', () => {
  // Politiikat ovat OR-ehtoja keskenään. Yksi jäljelle jäänyt salliva
  // politiikka kumoaa kaikki kahdeksan uutta.
  const code = code0001();

  assert.match(code, /drop policy/,
    'vanhoja politiikkoja ei poisteta');
  assert.match(code, /from pg_policies/,
    'poisto nojaa politiikan nimeen — nimi on voitu antaa käsin');

  assert.ok(code.indexOf('drop policy') < code.indexOf('create policy'),
    'vanhat politiikat poistetaan vasta uusien luonnin jälkeen');
});

test('0001 luo kahdeksan omistajuuspolitiikkaa authenticated-roolille', () => {
  const code = code0001();

  for (const table of ['tasks', 'profile']) {
    const column = table === 'tasks' ? 'user_id' : 'id';
    for (const action of ['select', 'insert', 'update', 'delete']) {
      assert.match(code,
        new RegExp(`create policy ${table}_${action}_own on public\\.${table}`),
        `${table}: ${action}-politiikka puuttuu`);
    }
    assert.match(code, new RegExp(`auth\\.uid\\(\\) = ${column}`),
      `${table}: omistajuusehto ei osoita sarakkeeseen ${column}`);
  }

  assert.equal((code.match(/create policy/g) || []).length, 8,
    'politiikkoja ei ole tasan kahdeksaa');
  assert.equal((code.match(/for \w+ to authenticated/g) || []).length, 8,
    'jokaisen politiikan pitää kohdistua rooliin authenticated');
});

test('KRIITTINEN: 0001 poistaa anonin oikeudet molemmista tauluista', () => {
  // Julkinen avain on selaimessa. Jos anon säilyttää oikeudet, RLS on
  // ainoa este ja yksi väärin kirjoitettu politiikka avaa kaiken.
  const code = code0001();

  for (const table of ['tasks', 'profile']) {
    assert.match(code, new RegExp(`revoke all on table public\\.${table}\\s+from anon`),
      `${table}: anonin oikeuksia ei revokoida`);
  }

  // authenticated saa takaisin vain rivioperaatiot — ei TRUNCATE,
  // REFERENCES eikä TRIGGER.
  assert.equal((code.match(/grant select, insert, update, delete/g) || []).length, 2,
    'authenticated-roolin oikeuksia ei rajata neljään operaatioon');
});

test('KRIITTINEN: 0001 sulkee myös PUBLIC-roolin perintäpolun', () => {
  // PostgreSQL-rooli PUBLIC tarkoittaa "kaikki roolit". Sille myönnetyn
  // oikeuden perii jokainen rooli, myös anon — eikä
  //   revoke all on public.tasks from anon
  // poista sitä, koska anonilla ei ole sitä suoraan. Se on peritty.
  //
  // Pelkkä anon-revoke on siis todiste vain siitä, ettei anonilla ole
  // SUORAA oikeutta. Se ei ole todiste siitä, ettei anon pääse tauluun.
  const code = code0001();

  for (const table of ['tasks', 'profile']) {
    assert.match(code, new RegExp(`revoke all on table public\\.${table}\\s+from public`),
      `${table}: PUBLIC-roolin oikeuksia ei revokoida — anon perisi ne`);
  }

  // Järjestys: revoke ennen grantia. Toisin päin authenticated
  // menettäisi juuri saamansa oikeudet.
  const lastRevoke = code.lastIndexOf('revoke all on table');
  const firstGrant = code.indexOf('grant select, insert, update, delete');
  assert.ok(lastRevoke !== -1 && firstGrant !== -1);
  assert.ok(lastRevoke < firstGrant,
    'oikeuksia myönnetään ennen kuin vanhat on poistettu');
});

test('KRIITTINEN: 0001 todentaa TEHOLLISET oikeudet, ei vain myönnettyjä', () => {
  // Suora grant-luettelo ei näe perintää. Kaksi eri tarkistusta
  // todistavat eri asian, ja kumpikin yksin jättäisi aukon:
  //   aclexplode           -> mitä on nimenomaisesti myönnetty (PUBLIC näkyy)
  //   has_table_privilege  -> mitä rooli todella saa tehdä (perintä mukana)
  const code = code0001();

  assert.match(code, /aclexplode/,
    'PUBLIC-myöntöjä ei tarkisteta — role_table_grants ei näytä niitä');
  assert.match(code, /a\.grantee = 0/,
    'PUBLIC-myöntöä ei tunnisteta (grantee 0)');
  assert.match(code, /has_table_privilege\('anon'/,
    'anonin tehollista oikeutta ei tarkisteta');
  assert.match(code, /has_table_privilege\('authenticated'/,
    'authenticated-roolin tehollista oikeutta ei tarkisteta');

  // Tarkistuksen pitää kattaa myös ne kolme oikeutta, joita kumpikaan
  // rooli ei tarvitse. Pelkkä CRUD-tarkistus päästäisi TRUNCATEn läpi.
  for (const privilege of ['truncate', 'references', 'trigger']) {
    assert.ok(code.includes(`'${privilege}'`),
      `tehollisten oikeuksien tarkistus ei kata oikeutta ${privilege}`);
  }
});

test('KRIITTINEN: legacy_id menettää vanhan oletusarvon', () => {
  // Tuotannon profile.id:llä on `default 'me'`, ja Postgresissa
  // oletusarvo SEURAA saraketta uudelleennimeämisessä.
  //
  // Ilman nimenomaista drop defaultia jokainen migraation jälkeen
  // syntyvä profiilirivi saisi automaattisesti legacy_id = 'me'.
  // Sarake, jonka nimi lupaa historiatietoa, täyttyisi uudella datalla,
  // ja rollback-osion oletus "legacy_id kertoo mikä rivi oli
  // alkuperäinen" lakkaisi pitämästä paikkaansa.
  const code = code0001();

  const rename    = code.indexOf('rename column id to legacy_id');
  const dropDeflt = code.indexOf('alter column legacy_id drop default');

  assert.ok(rename !== -1, 'uudelleennimeämistä ei löytynyt');
  assert.ok(dropDeflt !== -1,
    'legacy_id ei menetä vanhaa oletusarvoa — uudet rivit perisivät arvon "me"');
  assert.ok(rename < dropDeflt,
    'oletusarvo pudotetaan ennen uudelleennimeämistä — sarakenimi ei vielä osu');

  // Oletuksen katoaminen myös tarkistetaan ajossa, ei vain kirjoiteta.
  assert.match(code, /column_default into v_default/,
    'oletusarvon katoamista ei varmisteta ajon aikana');
});

test('KRIITTINEN: alkuperäinen legacy-arvo säilyy koskemattomana', () => {
  // legacy_id on ainoa asia, joka tekee migraatiosta purettavaksi ilman
  // varmuuskopiota. Sen tyhjentäminen tai pudottaminen tekisi
  // rollback-osiosta valheen.
  const code = code0001();

  assert.equal(/update public\.profile[\s\S]{0,200}?set\s+legacy_id/.test(code), false,
    '0001 kirjoittaa legacy_id-sarakkeen päälle');
  assert.equal(/drop column\s+(if exists\s+)?legacy_id/.test(code), false,
    '0001 pudottaa legacy_id-sarakkeen');

  // Ja säilyminen tarkistetaan ajossa.
  assert.match(code, /legacy_id = \(select legacy_profile_id from _migration_params\)/,
    'legacy-arvon säilymistä ei tarkisteta ajon aikana');
});

test('KRIITTINEN: sovelluskoodi ei riipu legacy_id-sarakkeesta', () => {
  // legacy_id on migraation historiatietoa. Jos ajonaikainen koodi
  // alkaisi lukea tai kirjoittaa sitä, sarakkeen pudottaminen myöhemmin
  // rikkoisi sovelluksen — ja juuri se pudottaminen on dokumentoitu
  // sallituksi myöhemmäksi päätökseksi.
  for (const file of browserModules()) {
    assert.equal(read(file).includes('legacy_id'), false,
      `${file} viittaa sarakkeeseen legacy_id`);
  }
});

test('varmistuskysely 0001 todentaa PUBLIC-perinnän ja tehollisen oikeuden', () => {
  const verify = read('supabase/verify/verify_0001.sql')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .toLowerCase();

  assert.ok(verify.includes('aclexplode'),
    'varmistus ei näe PUBLIC-roolille myönnettyjä oikeuksia');
  assert.ok(verify.includes('a.grantee = 0'),
    'varmistus ei tunnista PUBLIC-myöntöä');
  assert.ok(verify.includes("has_table_privilege('anon'"),
    'varmistus ei tarkista anonin tehollista oikeutta');
  assert.ok(verify.includes("has_table_privilege('authenticated'"),
    'varmistus ei tarkista authenticated-roolin tehollista oikeutta');
  assert.ok(verify.includes('legacy_id'),
    'varmistus ei katso legacy_id-saraketta');
});

test('0001 sitoo molemmat taulut auth.users-tauluun', () => {
  const code = code0001();

  assert.match(code,
    /add constraint tasks_user_id_fkey[\s\S]*?references auth\.users\(id\) on delete cascade/,
    'tasks.user_id ilman viitettä auth.users-tauluun');
  assert.match(code,
    /add constraint profile_id_fkey[\s\S]*?references auth\.users\(id\) on delete cascade/,
    'profile.id ilman viitettä auth.users-tauluun');
});

test('0001 antaa omistajuuden tietokannalle, ei selaimelle', () => {
  // Jos client saisi valita user_id:n, RLS ei suojaisi mitään.
  // Sama päätös kuin src/lib/rows.js: SERVER_OWNED_FIELDS.
  const code = code0001();

  assert.match(code, /alter column user_id set default auth\.uid\(\)/);
  assert.match(code, /alter column id set default auth\.uid\(\)/);
});

test('varmistuskysely 0001 tarkistaa saman omistajan kuin migraatio', () => {
  // Kaksi tiedostoa, yksi totuus. Jos migraation omistaja vaihtuu mutta
  // varmistus jää vanhaan, varmistus näyttäisi vihreää väärästä syystä.
  const verify = read('supabase/verify/verify_0001.sql');

  assert.ok(verify.includes(OWNER_UUID),
    'varmistuskysely ei tarkista omistajaa lainkaan');
  assert.ok(code0001().includes(OWNER_UUID),
    'migraatio ja varmistus eivät käytä samaa omistajaa');
});

/** verify_0001.sql ilman kommentteja. Selitysteksti saa puhua vapaasti. */
function verify0001() {
  return read('supabase/verify/verify_0001.sql')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .toLowerCase();
}

test('varmistuskysely 0001 tarkistaa juuri ne asiat jotka voivat mennä pieleen', () => {
  const verify = verify0001();

  const required = [
    ['relrowsecurity',             'RLS-tila'],
    ['pg_policies',                'politiikat'],
    ["grantee = 'anon'",           'anonin oikeudet'],
    ['user_id is null',            'omistajattomat rivit'],
    ['count(distinct user_id)',    'omistajien lukumäärä'],
    ['confdeltype',                'vierasavaimen poistosääntö'],
    ['legacy_id',                  'säilytetty alkuperäinen tunniste'],
    ['indkey[0]',                  'indeksin ensimmäinen sarake'],
    ['tasks_user_id_fkey',         'tehtävän vierasavain nimeltä'],
    ['profile_id_fkey',            'profiilin vierasavain nimeltä'],
    ['column_default',             'sarakkeiden oletusarvot']
  ];

  for (const [needle, what] of required) {
    assert.ok(verify.includes(needle), `varmistuksesta puuttuu: ${what}`);
  }
});

test('KRIITTINEN: varmistus lukee politiikkojen EHDOT, ei vain nimiä', () => {
  // Politiikan olemassaolo ei todista mitään. Väärä ehto näyttää
  // ulospäin tasan samalta kuin oikea: sama nimi, sama operaatio, sama
  // rooli. Ero on vain USING- ja WITH CHECK -lausekkeissa, ja juuri ne
  // ratkaisevat näkeekö käyttäjä toisen rivit.
  const verify = verify0001();

  assert.ok(verify.includes('qual'),
    'varmistus ei lue USING-lauseketta — väärä ehto menisi läpi');
  assert.ok(verify.includes('with_check'),
    'varmistus ei lue WITH CHECK -lauseketta — toisen nimiin kirjoittaminen menisi läpi');

  // Jokainen kahdeksasta nimeltä, jotta yksikään ei voi kadota
  // huomaamatta.
  for (const table of ['tasks', 'profile']) {
    for (const action of ['select', 'insert', 'update', 'delete']) {
      assert.ok(verify.includes(`${table}_${action}_own`),
        `varmistus ei tunne politiikkaa ${table}_${action}_own`);
    }
  }

  // Odotetut lausekkeet on kirjoitettu auki, ei vain luettu kannasta.
  // Ilman odotusarvoa vertailua ei ole, vain tuloste.
  assert.ok(verify.includes('auth.uid()=user_id'),
    'tasks-politiikoille ei ole odotettua lauseketta');
  assert.ok(verify.includes('auth.uid()=id'),
    'profile-politiikoille ei ole odotettua lauseketta');

  // Objektiivinen yhteenveto: kahdeksan riviä lausekkeita on juuri
  // sopivan pituinen lista siihen, että yksi väärä merkki jää
  // huomaamatta silmämääräisessä luvussa.
  assert.match(verify, /count\(\*\) filter \(where x\.tulos <> 'ok'\) over \(\)/,
    'poikkeamille ei ole koontilukua — virhe voisi piiloutua riveihin');

  // Normalisointi saa koskea vain muotoilua.
  assert.match(verify, /btrim\(replace\(coalesce\(p\.qual/,
    'lausekevertailu ei normalisoi muotoilua — se olisi hauras');
});

test('KRIITTINEN: varmistus todentaa vierasavaimen PÄÄT, ei vain nimeä', () => {
  // Rajoitteen nimi ei kerro mihin se osoittaa. Oikean niminen
  // vierasavain väärään sarakkeeseen tai väärään tauluun näyttäisi
  // nimilistassa täysin oikealta.
  const verify = verify0001();

  for (const [needle, what] of [
    ['con.conkey',   'lähdesarake'],
    ['con.confkey',  'kohdesarake'],
    ['con.confrelid', 'kohdetaulu'],
    ['nspname',      'skeema']
  ]) {
    assert.ok(verify.includes(needle),
      `vierasavaimen ${what} jää todentamatta`);
  }

  assert.ok(verify.includes("<> 'auth'") || verify.includes("'auth'"),
    'kohdeskeemaa auth ei tarkisteta');
  assert.ok(verify.includes("'users'"),
    'kohdetaulua auth.users ei tarkisteta');

  // Ja ettei odotettujen lisäksi ole muita.
  assert.match(verify, /conname not in \('tasks_user_id_fkey', 'profile_id_fkey'\)/,
    'ylimääräisiä vierasavaimia ei havaita');
});

test('KRIITTINEN: indeksitarkistus katsoo rakennetta eikä nimeä', () => {
  // LÖYTYNYT VIKA, JOTA TÄMÄ VARTIOI
  //
  // Tuotannon indeksi on yhdistelmä (user_id, date). Nimeen tai
  // täsmälliseen sarakelistaan (user_id) sidottu tarkistus raportoi
  // siitä FAILin, vaikka kanta oli kunnossa — ja väärä hälytys keskellä
  // tuotannon aktivointia on kallis: se pysäyttää oikean työn ja
  // opettaa ohittamaan varmistuksen.
  //
  // Sama sidonta pettää myös toisin päin. Indeksi nimeltä
  // tasks_user_id_date_idx voi olla sarakkeella (date), ja nimeen
  // luottava tarkistus hyväksyisi sen.
  //
  // Vaatimus on rakenteellinen: jonkin indeksin ENSIMMÄISEN sarakkeen on
  // oltava user_id. btree-indeksiä voi käyttää etuliitteellään, joten
  // (user_id, date) täyttää sen.
  const verify = verify0001();

  assert.ok(verify.includes('indkey[0]'),
    'indeksin ensimmäistä saraketta ei katsota lainkaan');
  assert.ok(verify.includes("a.attname = 'user_id'"),
    'ensimmäistä saraketta ei verrata user_id:hen');

  // Nimi saa esiintyä tuloksessa, mutta se ei saa olla ehto.
  const indexCheck = verify0001()
    .split(';')
    .map(part => part.trim())
    .find(part => part.includes('pg_index'));

  assert.ok(indexCheck, 'indeksitarkistusta ei löytynyt lainkaan');
  assert.equal(indexCheck.includes('tasks_user_id_date_idx'), false,
    'indeksitarkistus on yhä sidottu indeksin nimeen');
  assert.equal(/indexname\s*=/.test(indexCheck), false,
    'indeksitarkistus vertaa yhä indeksin nimeä');

  // Ja migraatio luo yhä sen indeksin, jota tarkistus edellyttää.
  assert.ok(code0001().includes('create index if not exists tasks_user_id_date_idx'),
    'migraatio ei enää luo user_id-alkuista indeksiä');
  assert.ok(code0001().includes('on public.tasks (user_id, date)'),
    'migraatio ei enää luo (user_id, date) -indeksiä');
});

/**
 * Poimii indeksitarkistuksen SÄÄNNÖN suoraan SQL:stä.
 *
 * Tämä ei ole SQL:n uudelleentoteutus vaan sen lukemista. Sääntö on
 * kokonaan kahdessa kohdassa: mihin indeksin sarakkeeseen katsotaan
 * (`indkey[n]`) ja mihin nimeen sitä verrataan (`attname = '...'`).
 * Molemmat luetaan tiedostosta, joten jos joku vaihtaisi tarkistuksen
 * takaisin nimipohjaiseksi, poiminta ei löytäisi sääntöä lainkaan — ja
 * jos joku vaihtaisi alaindeksin ykköseksi, alla olevat tapaukset
 * kääntyisivät toisin päin.
 *
 * @returns {(index: {columns: string[]}) => boolean}
 */
function indexRuleFrom(sqlSource, tiedosto) {
  const subscript = /indkey\[(\d+)\]/.exec(sqlSource);
  const column = /attname = '([a-z_]+)'/.exec(sqlSource);

  assert.ok(subscript, `${tiedosto}: indeksitarkistus ei katso indkey-alkiota`);
  assert.ok(column, `${tiedosto}: indeksitarkistus ei vertaa sarakkeen nimeä`);

  const position = Number(subscript[1]);
  const expected = column[1];
  return index => index.columns[position] === expected;
}

test('KRIITTINEN: indeksisääntö hyväksyy etuliitteen ja hylkää väärän järjestyksen', () => {
  // TÄMÄ ON SE VIKA, JOKA OIKEASTI SATTUI
  //
  // Kertaluontoinen varmistin vaati täsmälleen sarakelistan (user_id).
  // Tuotannossa on (user_id, date), joten varmistin raportoi FAILin
  // kannasta joka oli kunnossa. Väärä hälytys keskellä tuotannon
  // aktivointia on kallis: se pysäyttää oikean työn ja opettaa
  // ohittamaan varmistuksen.
  //
  // Sidonta pettää myös toisin päin: (date, user_id) on eri indeksi.
  // btree-indeksiä voi käyttää etuliitteellään, joten (user_id, date)
  // kelpaa omistajahakuun mutta (date, user_id) ei — jälkimmäisessä
  // omistajalla suodattava kysely joutuu lukemaan koko indeksin.
  //
  // Sääntö luetaan molemmista tiedostoista erikseen: ne ovat eri
  // tiedostoja, ja toinen voi ajautua erilleen huomaamatta.
  const lahteet = [
    ['verify_0001.sql', verify0001()
      .split(';').map(part => part.trim()).find(part => part.includes('pg_index'))],
    ['verify_acceptance.sql', read('supabase/acceptance/verify_acceptance.sql')
      .split(NEWLINE)
      .filter(line => !line.trim().startsWith('--'))
      .join(NEWLINE)
      .toLowerCase()]
  ];

  const tapaukset = [
    ['(user_id)',            ['user_id'],         true,  'pelkkä omistajaindeksi kelpaa'],
    ['(user_id, date)',      ['user_id', 'date'], true,  'yhdistelmä, jonka etuliite on user_id, kelpaa'],
    ['(date, user_id)',      ['date', 'user_id'], false, 'väärä järjestys ei kelpaa'],
    ['(id)',                 ['id'],              false, 'pääavain ei kelpaa omistajaindeksiksi'],
    ['(date)',               ['date'],            false, 'liittymätön indeksi ei kelpaa'],
    ['(completed, user_id)', ['completed', 'user_id'], false, 'user_id muualla kuin ensimmäisenä ei kelpaa']
  ];

  for (const [tiedosto, sqlSource] of lahteet) {
    assert.ok(sqlSource, `${tiedosto}: indeksitarkistusta ei löytynyt lainkaan`);
    const kelpaa = indexRuleFrom(sqlSource, tiedosto);

    for (const [nimi, columns, odotus, miksi] of tapaukset) {
      assert.equal(kelpaa({ columns }), odotus,
        `${tiedosto}: indeksi ${nimi} — ${miksi}`);
    }
  }
});

test('KRIITTINEN: varmistus todentaa perumisen merkkipaalun', () => {
  // legacy_id on ainoa asia, joka tekee läpimenneestä migraatiosta
  // purettavan ilman varmuuskopiota. Jos arvo on kadonnut, migraation
  // ROLLBACK-osio ei enää pidä paikkaansa — ja se huomattaisiin vasta
  // silloin kun perumista oikeasti tarvitaan.
  const verify = verify0001();

  assert.match(verify, /filter \(where legacy_id = 'me'\)/,
    'alkuperäisen arvon säilymistä ei tarkisteta');
  assert.match(verify, /filter \(where legacy_id is not null\)/,
    'ei-tyhjien legacy-arvojen määrää ei tarkisteta');
  assert.match(verify, /legacy_id <> 'me'/,
    'muita legacy-arvoja ei havaita — jäänyt oletusarvo jäisi huomaamatta');
});

test('hyväksyntätestin jälkivarmistus kattaa jokaisen vaaditun kohdan', () => {
  // Selaimessa ajettu hyväksyntätesti katsoo kantaa RLS:n läpi. Se ei
  // siis voi nähdä, jäikö toisen tilin rivi kantaan — RLS piilottaisi
  // juuri sen rivin, jota etsitään. Tämä tiedosto on ainoa paikka,
  // josta jäännöksen voi nähdä, ja siksi sen kattavuus lukitaan tässä.
  const sql = read('supabase/acceptance/verify_acceptance.sql')
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE)
    .toLowerCase();

  // Yhtenainen tuloste: check_no / section / check_name / status / details.
  for (const sarake of ['check_no', 'section', 'check_name', 'status', 'details']) {
    assert.ok(sql.includes(sarake), `jälkivarmistuksesta puuttuu sarake ${sarake}`);
  }

  const vaaditut = [
    ['relrowsecurity',            'RLS on yhä päällä'],
    ['indkey[0]',                 'indeksin ensimmäinen sarake'],
    ['pg_policies',               'politiikat ovat yhä tallella'],
    ['with_check',                'politiikkojen kirjoitusehdot'],
    [OWNER_UUID.toLowerCase(),    'omistajan tunniste'],
    ['user_id is null',           'omistajattomat rivit'],
    // Vahvempi kuin omistajien lukumäärä: count(distinct user_id) = 1
    // olisi tosi myös silloin, kun se yksi omistaja on joku muu kuin A.
    // is distinct from nimeää omistajan ja näkee myös NULL-omistajan,
    // jonka tavallinen <>-vertailu jättäisi huomaamatta.
    ['user_id is distinct from', 'omistajan nimenomainen vertailu'],
    ['left join auth.users',      'orvot viittaukset'],
    ["legacy_id = 'me'",          'perumisen merkkipaalu'],
    [`${MARKER_PREFIX}%`,         'hyväksyntätestin jäännösrivit'],
    ['from auth.users',           'väliaikaisen tilin poisto'],
    ['confdeltype',               'vierasavaimen poistosääntö'],
    ["has_table_privilege('anon'", 'anonin teholliset oikeudet'],
    ['aclexplode',                'PUBLIC-roolin oikeudet']
  ];

  for (const [needle, mita] of vaaditut) {
    assert.ok(sql.includes(needle), `jälkivarmistuksesta puuttuu: ${mita}`);
  }

  // Odotettu rivimäärä on kirjoitettu auki, ei pääteltävissä.
  assert.ok(sql.includes("'36'"), 'tehtävien odotettua määrää ei tarkisteta');
});

test('KRIITTINEN: hyväksyntätestin tunniste on sama JS:ssä ja SQL:ssä', () => {
  // Kaksi eri kieltä, yksi sopimus. Jos ajuri vaihtaisi etuliitteen ja
  // jälkivarmistus etsisi vanhaa, siivouksen aukko jäisi näkymättömäksi:
  // SQL raportoisi tyytyväisenä nolla jäännösriviä, koska se etsii
  // etuliitettä, jota kukaan ei enää käytä.
  const sql = read('supabase/acceptance/verify_acceptance.sql');
  assert.ok(sql.includes(`${MARKER_PREFIX}%`),
    `jälkivarmistus ei etsi etuliitettä ${MARKER_PREFIX}`);

  const runner = read('tools/rls-acceptance/acceptance.js');
  assert.ok(runner.includes(`'${MARKER_PREFIX}'`),
    'ajurin etuliite ei ole enää vakio');
});

test('KRIITTINEN: varmistus 0001 ei muuta mitään', () => {
  // Sama sääntö kuin kaikilla varmistustiedostoilla, mutta erikseen
  // tälle: tämä on ainoa tiedosto, jota ajetaan tuotantoa vasten heti
  // migraation jälkeen, ja se ajetaan käsin liittämällä.
  const statements = read('supabase/verify/verify_0001.sql')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(part => part.trim())
    .filter(part => part.length > 0);

  assert.ok(statements.length >= 20,
    `varmistuksessa on vain ${statements.length} lausetta — onko jotain kadonnut?`);

  for (const statement of statements) {
    assert.equal(statement.split(/\s+/)[0].toLowerCase(), 'select',
      `lause alkaa väärin: ${statement.slice(0, 60)}`);
  }
});

// ================================================================
// 0002 on sovitettu 0001:n HYVÄKSYTTYYN tuotantotilaan
// ================================================================
//
// 0001 on ajettu ja hyväksytty tuotannossa. 0002 on seuraava, eikä sitä
// ole ajettu. Nämä testit vartioivat niitä kohtia, joissa additiivinen
// migraatio voi silti tehdä vahinkoa: lukitsematta jättäminen, hiljainen
// uudelleenajo ja odotusarvo joka on toive eikä rajoite.
//
// Nämä ovat staattisia tarkistuksia: ne lukevat SQL:ää tekstinä eivätkä
// aja sitä. Ne eivät siis todista, että migraatio toimii — ne todistavat,
// ettei se sisällä niitä rakenteita, jotka aiemmin menivät pieleen.

const MIGRATION_0002 = '0002_task_domain_fields.sql';

/** 0002 ilman kommentteja. */
function code0002() {
  return read(`${MIGRATION_DIR}/${MIGRATION_0002}`)
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE)
    .toLowerCase();
}

/** verify_0002 ilman kommentteja. */
function verify0002() {
  return read('supabase/verify/verify_0002.sql')
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE)
    .toLowerCase();
}

test('KRIITTINEN: 0002 lukitsee taulun ennen kuin luottaa sen tilaan', () => {
  // Sama vika kuin 0001:ssä oli. `begin` ei jäädytä taulua: READ
  // COMMITTED -tasolla jokainen lause näkee oman tuoreen tilannekuvansa,
  // joten esiehto voi olla tosi luettaessa ja epätosi toimittaessa.
  //
  // lock_timeout on erillinen vaatimus ja päinvastaisesta syystä. Ilman
  // sitä ACCESS EXCLUSIVE -pyyntö jää jonoon pitkän kyselyn taakse, ja
  // koska lukkojono on FIFO, sen taakse jonoutuu kaikki muu. Migraatio,
  // joka odottaa hiljaa, kaataa sovelluksen odottaessaan.
  const code = code0002();

  const lukitus = code.indexOf('lock table public.tasks in access exclusive mode');
  assert.ok(lukitus > 0, '0002 ei lukitse taulua lainkaan');
  assert.ok(code.includes('set local lock_timeout'), '0002:lta puuttuu lock_timeout');
  assert.ok(code.indexOf('set local lock_timeout') < lukitus,
    'lock_timeout on asetettava ENNEN lukitusta, muuten se ei koske siihen');

  // Jokainen tuotantotaulun luku on lukituksen jälkeen.
  for (const luku of ['from public.tasks', 'update public.tasks']) {
    const ensimmainen = code.indexOf(luku);
    assert.ok(ensimmainen === -1 || ensimmainen > lukitus,
      `"${luku}" tapahtuu ennen lukitusta`);
  }
});

test('KRIITTINEN: 0002 tunnistaa aiemman ja kesken jääneen ajon', () => {
  // Aiempi versio käytti `if not exists` -muotoa joka kohdassa. Silloin
  // toinen ajo, kesken jäänyt ajo ja tuore ajo näyttivät kaikki
  // samalta: onnistuneelta. Tila, jota ei voi erottaa, on tila jota ei
  // voi korjata.
  const code = code0002();

  assert.match(code, /raise exception 'migraatio 0002 on jo ajettu/,
    'toinen ajo menisi hiljaa läpi');
  assert.match(code, /raise exception 'migraatio 0002 on kesken/,
    'kesken jäänyttä ajoa ei tunnisteta');

  // Tunnistus laskee objektit — kaikki kaksitoista, ei vain sarakkeita.
  for (const objekti of ['tasks_priority_check', 'touch_updated_at',
                         'tasks_touch_updated_at', 'tasks_user_date_priority_idx']) {
    assert.ok(code.includes(objekti),
      `osittaisen ajon tunnistus ei kata objektia ${objekti}`);
  }
});

test('KRIITTINEN: 0002 ei piilota tuntematonta tilaa if not exists -muodon taakse', () => {
  // Fail-closed on tässä oikea valinta, koska VAIHE 1C on juuri
  // todistanut, ettei yhtäkään objektia ole. `if not exists` sen
  // jälkeen ei suojaisi miltään — se vain hiljentäisi yllätyksen.
  const code = code0002();

  const ddl = code.split(NEWLINE).filter(line =>
    /^\s*(alter table|create index|create trigger)/.test(line));

  assert.ok(ddl.length >= 8, `DDL-lauseita löytyi vain ${ddl.length}`);
  for (const line of ddl) {
    assert.equal(/if not exists/.test(line), false,
      `fail-closed rikki: ${line.trim()}`);
  }
});

test('KRIITTINEN: 0002 ei poista eikä muuta olemassa olevaa saraketta', () => {
  // Additiivisuus on koko migraation turvallisuusväite. Jos se rikkoutuu,
  // tuotannossa oleva data on vaarassa eikä peruminen enää auta.
  const code = code0002();

  for (const kielletty of ['drop column', 'drop table', 'rename column',
                           'rename to', 'truncate', 'delete from', 'alter column date',
                           'using id::', 'type uuid']) {
    assert.equal(code.includes(kielletty), false,
      `0002 sisältää tuhoavan lauseen: ${kielletty}`);
  }

  // Ainoa kirjoitus olemassa oleviin riveihin on scheduling_state.
  const updatet = [...code.matchAll(/update public\.tasks\s+set (\w+)/g)].map(m => m[1]);
  assert.deepEqual(updatet, ['scheduling_state'],
    `0002 kirjoittaa myös sarakkeisiin: ${updatet.join(', ')}`);
});

test('KRIITTINEN: scheduling_state täytetään ennen kuin siitä tehdään pakollinen', () => {
  // Järjestys on koko vaiheen turvallisuus. NOT NULL ennen täyttöä
  // kaataisi migraation jokaisella olemassa olevalla rivillä. Oletusarvo
  // ennen täyttöä taas kirjoittaisi kellonajattomille riveille arvon
  // 'manual', jolloin automaatti ei koskaan enää koskisi niihin.
  const code = code0002();

  const lisays  = code.indexOf('add column scheduling_state');
  const taytto  = code.indexOf("set scheduling_state = case");
  const oletus  = code.indexOf('alter column scheduling_state set default');
  const notNull = code.indexOf('alter column scheduling_state set not null');

  assert.ok(lisays > 0 && taytto > 0 && oletus > 0 && notNull > 0,
    'jokin scheduling_state-vaihe puuttuu kokonaan');
  assert.ok(lisays < taytto, 'saraketta täytetään ennen kuin se on olemassa');
  assert.ok(taytto < oletus, 'oletusarvo asetetaan ennen täyttöä');
  assert.ok(taytto < notNull, 'NOT NULL asetetaan ennen täyttöä');
});

test('KRIITTINEN: NOT NULL -sarakkeet ovat rajoitteita, eivät odotusarvoja', () => {
  // `check (x in ('a','b'))` EI hylkää nullia: null ei ole epätosi vaan
  // tuntematon. Ilman NOT NULLia sarake jäisi tyhjäksi aina kun asiakas
  // lähettää siihen nimenomaisen nullin — ja varmistus, joka odottaa
  // nollaa tyhjää, olisi toive eikä tae.
  const code = code0002();

  assert.match(code, /alter column scheduling_state set not null/,
    'scheduling_state voi jäädä tyhjäksi');
  assert.match(code, /add column priority text not null/,
    'priority voi jäädä tyhjäksi');
  for (const sarake of ['created_at', 'updated_at']) {
    assert.ok(new RegExp(`add column ${sarake} timestamptz not null`).test(code),
      `${sarake} voi jäädä tyhjäksi`);
  }
});

test('KRIITTINEN: sovellus ei koskaan lähetä nullia pakolliseen sarakkeeseen', () => {
  // Tämä on ketjun toinen pää. Kanta hylkää nimenomaisen nullin
  // NOT NULL -sarakkeeseen: oletusarvo ei pelasta, koska oletus koskee
  // vain pois jätettyä saraketta. Jos toRow lähettäisi priority: null,
  // JOKAINEN tehtävän tallennus epäonnistuisi lipun kääntämisen jälkeen.
  //
  // Suojaus on siinä, että jokainen kirjoituspolku kulkee
  // normalizeTaskin läpi. Tämä testi lukitsee sen.
  const tyhjin = normalizeTask({});
  const rivi = toRow(tyhjin, TASK_COLUMNS_EXTENDED);

  for (const sarake of ['priority', 'scheduling_state']) {
    assert.notEqual(rivi[sarake], null,
      `toRow lähettää ${sarake}: null — kanta hylkäisi rivin`);
    assert.notEqual(rivi[sarake], undefined, `${sarake} puuttuu payloadista`);
  }

  // Ja arvot ovat niitä, jotka migraation tarkiste sallii.
  assert.ok(allowedValues(sql(MIGRATION_0002), 'tasks_priority_check')
    .includes(rivi.priority), `prioriteetti ${rivi.priority} ei läpäise tarkistetta`);
  assert.ok(allowedValues(sql(MIGRATION_0002), 'tasks_scheduling_state_check')
    .includes(rivi.scheduling_state),
    `aikataulutustila ${rivi.scheduling_state} ei läpäise tarkistetta`);

  // Sama myös kannasta luetulle riville: fromRow palauttaa
  // määrittelemättömän prioriteetin ennen 0002:ta, ja juuri se kiertäisi
  // oletusarvon jos se päätyisi takaisin kantaan sellaisenaan.
  const kannasta = normalizeTask(fromRow({
    id: 'x', date: '2026-09-05', title: 'y', completed: false, is_wake: false
  }));
  assert.notEqual(toRow(kannasta, TASK_COLUMNS_EXTENDED).priority, null,
    'kannasta luettu rivi palaisi nullilla');
});

test('KRIITTINEN: 0002 tarkistaa 0001:n perustan ennen yhtäkään muutosta', () => {
  const code = code0002();
  const ensimmainenMuutos = code.indexOf('alter table public.tasks add column');
  assert.ok(ensimmainenMuutos > 0, 'DDL:ää ei löytynyt');

  for (const [ehto, mita] of [
    ['user_id',        'omistajasarakkeen olemassaolo'],
    ['relrowsecurity', 'RLS:n tila'],
    ['pg_policies',    'politiikkojen määrä'],
    ['auth.users',     'omistajan olemassaolo'],
    ['user_id is null', 'omistajattomat rivit']
  ]) {
    const kohta = code.indexOf(ehto);
    assert.ok(kohta > 0 && kohta < ensimmainenMuutos,
      `esiehto puuttuu tai on liian myöhässä: ${mita}`);
  }

  assert.ok(code.includes(OWNER_UUID.toLowerCase()),
    '0002 ei tarkista olevansa oikeassa tietokannassa');
});

test('KRIITTINEN: jaettu liipaisinfunktio on identtinen kaikissa migraatioissa', () => {
  // touch_updated_at luodaan `create or replace` -lauseella kolmessa
  // migraatiossa. Korvaus vaihtaa KOKO funktion, joten poikkeava versio
  // myöhemmässä migraatiossa purkaisi hiljaa aiemman kovennuksen — ja
  // verify_0002 olisi ajettu jo aiemmin, joten mikään ei huomaisi sitä.
  const versiot = ['0002_task_domain_fields.sql', '0003_routines.sql',
                   '0004_goals_projects.sql'].map(name => {
    const match = /create or replace function public\.touch_updated_at\(\)[\s\S]*?end \$\$;/
      .exec(read(`${MIGRATION_DIR}/${name}`));
    assert.ok(match, `${name}: funktiomäärittelyä ei löytynyt`);
    return [name, match[0].replace(/\s+/g, ' ').trim()];
  });

  for (const [name, teksti] of versiot) {
    assert.equal(teksti, versiot[0][1],
      `${name} määrittelee touch_updated_at eri tavalla kuin 0002`);
    assert.ok(teksti.includes('security invoker'),
      `${name}: funktio ei ole nimenomaisesti SECURITY INVOKER`);
    assert.ok(teksti.includes('set search_path'),
      `${name}: funktion search_path ei ole kiinnitetty`);
  }
});

test('0002:n perumisohje ei pudota jaettua funktiota sokeasti', () => {
  // drop function public.touch_updated_at() rikkoisi 0003:n ja 0004:n
  // liipaisimet, jos ne on ajettu. Ohjeen on sanottava se.
  const rollback = read(`${MIGRATION_DIR}/${MIGRATION_0002}`)
    .split('ROLLBACK — PERUMINEN')[1];
  assert.ok(rollback, 'perumisosiota ei löytynyt');

  const aktiiviset = rollback.split(NEWLINE)
    .filter(line => line.trim().startsWith('--   '))
    .join(NEWLINE);
  assert.equal(aktiiviset.includes('drop function'), false,
    'perumisohje pudottaa jaetun funktion ehdoitta');
  assert.ok(rollback.includes('0003') && rollback.includes('0004'),
    'perumisohje ei varoita myöhempien migraatioiden liipaisimista');
  assert.ok(/lipun kääntämisen jälkeen/i.test(rollback),
    'perumisohje ei erottele lipun kääntämistä edeltävää ja seuraavaa tilaa');
});

// ---------------------------------------------------------------- verify_0002

test('varmistus 0002 on ALL-IN-ONE: yksi lause, yksi taulukko', () => {
  const raw = read('supabase/verify/verify_0002.sql');
  const lauseet = raw.split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE)
    .split(';')
    .map(part => part.trim())
    .filter(Boolean);

  assert.equal(lauseet.length, 1, 'varmistus ei ole yksi lause');
  assert.equal(lauseet[0].split(/\s+/)[0].toLowerCase(), 'select');

  for (const sarake of ['check_no', 'section', 'check_name', 'status',
                        'details', 'poikkeavia_yhteensa']) {
    assert.ok(raw.includes(sarake), `tulosteesta puuttuu sarake ${sarake}`);
  }
});

test('KRIITTINEN: varmistus 0002 kattaa jokaisen 0002:n luoman invariantin', () => {
  const verify = verify0002();

  const vaaditut = [
    ['information_schema.columns', 'sarakkeiden olemassaolo'],
    ['is_nullable',                'nullius'],
    ['column_default',             'oletusarvot'],
    ['pg_get_constraintdef',       'tarkisteiden ehdot'],
    ['scheduling_state is null',   'tyhjät aikataulutustilat'],
    ['priority is null',           'tyhjät prioriteetit'],
    ['user_id is null',            'omistajattomat rivit'],
    ['left join auth.users',       'orvot viittaukset'],
    ['user_id is distinct from',   'vieras omistaja'],
    ['indkey',                     'indeksin rakenne'],
    ['pg_trigger',                 'liipaisin'],
    ['tgtype',                     'liipaisimen tyyppi'],
    ['prosecdef',                  'funktion turvakonteksti'],
    ['proconfig',                  'funktion search_path'],
    ['relrowsecurity',             'RLS'],
    ['with_check',                 'politiikkojen kirjoitusehdot'],
    ["has_table_privilege('anon'", 'anonin oikeudet'],
    ['has_column_privilege',       'sarakekohtaiset oikeudet'],
    ['aclexplode',                 'PUBLIC-roolin oikeudet']
  ];

  for (const [needle, mita] of vaaditut) {
    assert.ok(verify.includes(needle), `varmistuksesta 0002 puuttuu: ${mita}`);
  }
});

test('KRIITTINEN: varmistuksen 0002 odotusarvot kuvaavat turvallista tilaa', () => {
  // Varmistus, joka läpäisee vain oikean skeeman, ei riitä. Sen on
  // HYLÄTTÄVÄ väärä. Tässä luetaan varmistuksen omat odotustaulukot ja
  // tarkistetaan, että ne kuvaavat juuri sen tilan, jonka pitää olla
  // ainoa hyväksytty — eivät jotain löysempää.
  const verify = verify0002();

  // 1. Nullius: neljä saraketta EI saa sallia nullia.
  for (const sarake of ['priority', 'scheduling_state', 'created_at', 'updated_at']) {
    assert.ok(new RegExp(`\\('${sarake}',\\s*'no'\\)`).test(verify),
      `varmistus sallisi nullin sarakkeessa ${sarake}`);
  }

  // 2. Tyypit: aikaleimat aikavyöhykkeen kanssa, kesto kokonaisluku.
  assert.ok(verify.includes("'timestamp with time zone'"),
    'varmistus hyväksyisi aikavyöhykkeettömän aikaleiman');
  assert.ok(/\('duration_minutes',\s*'integer'\)/.test(verify),
    'varmistus ei lukitse keston tyyppiä');

  // 3. Politiikat: yksikään odotettu ehto ei saa olla `true`.
  const politiikat = [...verify.matchAll(/'(auth\.uid\(\)=[a-z_]+)'/g)].map(m => m[1]);
  assert.ok(politiikat.length >= 8, 'politiikkojen ehtoja odotetaan liian vähän');
  assert.equal(verify.includes("'true'"), false,
    'varmistus hyväksyisi politiikan ehdon true');

  // 4. Oikeudet: anonille nolla, PUBLICille nolla, authenticatedille CRUD.
  assert.match(verify, /'anon-roolilla ei ole yhtaan tehollista oikeutta[^']*',\s*'0'/,
    'anonin odotusarvo ei ole nolla');
  assert.match(verify, /'public-roolilla ei ole oikeuksia[^']*',\s*'0'/,
    'PUBLIC-roolin odotusarvo ei ole nolla');
  assert.match(verify, /'authenticated-roolilla on tasan crud[^']*',\s*'4'/,
    'authenticated-roolin odotusarvo ei ole tasan CRUD');

  // 5. Indeksi: täsmälleen odotetut sarakkeet odotetussa järjestyksessä.
  assert.ok(verify.includes("array['user_id', 'date', 'priority']"),
    'indeksin sarakejärjestystä ei lukita');

  // 6. Liipaisin: rivikohtainen BEFORE UPDATE, ei mikä tahansa.
  for (const bitti of ['(tgtype & 1) = 1', '(tgtype & 2) = 2', '(tgtype & 16) = 16']) {
    assert.ok(verify.includes(bitti), `liipaisimen tyyppiä ei lukita: ${bitti}`);
  }

  // 7. Funktio: ei SECURITY DEFINER, search_path kiinnitetty.
  assert.ok(verify.includes('p.prosecdef = false'),
    'varmistus hyväksyisi SECURITY DEFINER -funktion');
});

test('KRIITTINEN: varmistuksen 0002 indeksisääntö tunnistaa etuliitteen', () => {
  const indeksitarkistus = verify0002()
    .split('union all')
    .find(part => part.includes('indkey[0]'));
  assert.ok(indeksitarkistus, 'omistajahaun indeksitarkistusta ei löytynyt');

  const kelpaa = indexRuleFrom(indeksitarkistus, 'verify_0002.sql');
  assert.equal(kelpaa({ columns: ['user_id'] }), true);
  assert.equal(kelpaa({ columns: ['user_id', 'date'] }), true);
  assert.equal(kelpaa({ columns: ['user_id', 'date', 'priority'] }), true);
  assert.equal(kelpaa({ columns: ['date', 'user_id'] }), false);
  assert.equal(kelpaa({ columns: ['priority'] }), false);
});

test('preflight 0002 on vain lukeva ja verrattavissa varmistukseen', () => {
  const raw = read('supabase/preflight/preflight_0002.sql');
  const lauseet = raw.split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE)
    .split(';')
    .map(part => part.trim())
    .filter(Boolean);

  assert.equal(lauseet.length, 1, 'preflight ei ole yksi lause');
  assert.equal(lauseet[0].split(/\s+/)[0].toLowerCase(), 'select');

  const preflight = raw.toLowerCase();

  // Preflightin tehtävä on todeta, ettei 0002 ole vielä ajettu.
  assert.ok(preflight.includes('tasks_user_date_priority_idx'),
    'preflight ei tarkista, onko 0002 jo ajettu');
  assert.ok(preflight.includes('idle in transaction'),
    'preflight ei näe avointa transaktiota, joka estäisi lukituksen');

  // INFO-rivit ovat kirjattavia lukuja, eivät keksittyjä PASSeja.
  assert.ok(preflight.includes("'info'"), 'preflight ei erottele INFO-rivejä');
  assert.match(preflight, /when c\.odotus = 'info'\s+then 'info'/,
    'INFO-rivi voisi näyttää PASSilta');
});

test('KRIITTINEN: preflight ja varmistus kysyvät samat luvut', () => {
  // INFO-rivien arvo on siinä, että ne verrataan toisiinsa. Jos toinen
  // tiedosto lakkaisi kysymästä jotain, vertailu jäisi hiljaa tekemättä.
  const preflight = read('supabase/preflight/preflight_0002.sql').toLowerCase();
  const verify = verify0002();

  for (const luku of ['count(*)::text from public.tasks',
                      "scheduling_state = 'unscheduled'",
                      'from pg_constraint',
                      'from pg_indexes']) {
    const molemmissa = preflight.includes(luku.split(' where')[0]) || preflight.includes(luku);
    assert.ok(molemmissa || verify.includes(luku),
      `lukua ei kysytä kummassakaan: ${luku}`);
  }

  // Molemmat lukevat tehtävien kokonaismäärän, jotta ne voi verrata.
  assert.ok(preflight.includes('count(*)::text from public.tasks'));
  assert.ok(verify.includes('count(*)::text from public.tasks'));
});

// ================================================================
// TASK_EXTENDED_FIELDS — aktivoinnin SQL-varmistukset
// ================================================================

/** Aktivoinnin SQL-tiedostot: ennen ja jälkeen. */
const AKTIVOINNIN_SQL = [
  ['supabase/preflight/predeploy_task_extended_fields.sql', 'ennen aktivointia'],
  ['supabase/verify/verify_task_extended_activation.sql', 'aktivoinnin jälkeen']
];

test('aktivoinnin varmistukset ovat ALL-IN-ONE: yksi lause, yksi taulukko', () => {
  for (const [tiedosto, milloin] of AKTIVOINNIN_SQL) {
    const raw = read(tiedosto);
    const lauseet = raw.split(NEWLINE)
      .filter(line => !line.trim().startsWith('--'))
      .join(NEWLINE)
      .split(';')
      .map(part => part.trim())
      .filter(Boolean);

    assert.equal(lauseet.length, 1, `${milloin}: ei ole yksi lause`);
    assert.equal(lauseet[0].split(/\s+/)[0].toLowerCase(), 'select');

    for (const sarake of ['check_no', 'section', 'check_name', 'status',
                          'details', 'poikkeavia_yhteensa']) {
      assert.ok(raw.includes(sarake), `${milloin}: tulosteesta puuttuu sarake ${sarake}`);
    }

    // INFO ei saa näyttää PASSilta.
    assert.match(raw.toLowerCase(), /when c\.odotus = 'info'\s+then 'info'/,
      `${milloin}: INFO-rivi voisi näyttää PASSilta`);
  }
});

test('KRIITTINEN: aktivoinnin varmistukset kattavat jokaisen kelvottoman tilan', () => {
  // Aktivointi on hetki, jolloin sovellus alkaa kirjoittaa kahteen
  // NOT NULL -sarakkeeseen. Jos jokin kirjoituspolku ohittaa
  // normalisoinnin, se näkyy kannassa juuri näinä arvoina — eikä
  // missään muualla.
  const jalkeen = read('supabase/verify/verify_task_extended_activation.sql').toLowerCase();

  const vaaditut = [
    ['priority is null',              'tyhjä prioriteetti'],
    ['scheduling_state is null',      'tyhjä aikataulutustila'],
    ["priority not in",               'kelvoton prioriteetti'],
    ["scheduling_state not in",       'kelvoton aikataulutustila'],
    ['duration_minutes',              'kelvoton kesto'],
    ["description = ''",              'tyhjä merkkijono kuvauksena'],
    ['updated_at < created_at',       'taaksepäin vieritetty aikaleima'],
    ['user_id is null',               'omistajaton rivi'],
    ['left join auth.users',          'orpo viittaus'],
    ['relrowsecurity',                'RLS'],
    ['with_check',                    'politiikkojen kirjoitusehdot'],
    ["has_table_privilege('anon'",    'anonin oikeudet'],
    ['has_column_privilege',          'sarakekohtaiset oikeudet'],
    ['aclexplode',                    'PUBLIC-roolin oikeudet'],
    ['routine_exceptions',            'myöhempien migraatioiden taulut']
  ];

  for (const [needle, mita] of vaaditut) {
    assert.ok(jalkeen.includes(needle),
      `aktivoinnin varmistuksesta puuttuu: ${mita}`);
  }
});

test('KRIITTINEN: aktivoinnin varmistus tuntee lipun näkyvyyden rajan', () => {
  // Lipun arvo on sovelluksen koodissa, ei kannassa. Varmistus, joka
  // väittäisi näkevänsä sen, valehtelisi. Rehellinen vaihtoehto on
  // sanoa raja ääneen ja tarjota lähin mahdollinen todiste:
  // onko sovellus oikeasti kirjoittanut uusiin sarakkeisiin.
  for (const [tiedosto, milloin] of AKTIVOINNIN_SQL) {
    const raw = read(tiedosto);
    assert.match(raw, /MITA TAMA EI VOI NAHDA|MITA TAMA EI VOI/,
      `${milloin}: näkyvyyden rajaa ei kerrota`);
    assert.ok(raw.includes('src/data/schema.js'),
      `${milloin}: ei kerro missä lipun arvo oikeasti on`);
  }

  const jalkeen = read('supabase/verify/verify_task_extended_activation.sql');
  assert.ok(jalkeen.includes('description is not null'),
    'aktivoinnin varmistus ei näe, kirjoittiko sovellus uusiin sarakkeisiin');
});

test('aktivoinnin varmistukset käyttävät samoja arvoja kuin domain', () => {
  // Sama ajautumisen vaara kuin migraatiossa: jos domain saa uuden
  // prioriteettitason, varmistus merkitsisi sen kelvottomaksi.
  const jalkeen = read('supabase/verify/verify_task_extended_activation.sql');

  for (const arvo of PRIORITY_KEYS) {
    assert.ok(jalkeen.includes(`'${arvo}'`),
      `aktivoinnin varmistus ei tunne prioriteettia ${arvo}`);
  }
  for (const arvo of ['manual', 'auto', 'unscheduled']) {
    assert.ok(jalkeen.includes(`'${arvo}'`),
      `aktivoinnin varmistus ei tunne aikataulutustilaa ${arvo}`);
  }
});

test('KRIITTINEN: yksikään portti ei ole auki ilman ajettua migraatiota', () => {
  // Ensimmäinen tuotantojulkaisu vie kerralla 59 committia. Jos yksikin
  // skeemaportti olisi vahingossa `true`, sovellus alkaisi kirjoittaa
  // tauluun, jota tuotannossa EI OLE — ja jokainen tallennus
  // epäonnistuisi heti julkaisun jälkeen.
  //
  // Portin ja migraation side luetaan migraatiotiedoston omasta
  // tilamerkinnästä, ei käsin kirjoitetusta listasta. Näin nämä kaksi
  // eivät voi ajautua erilleen: portin saa avata vasta kun migraation
  // tilamerkintä kertoo sen olevan ajettu.
  const PORTIN_MIGRAATIO = {
    TASK_EXTENDED_FIELDS: '0002',
    routines: '0003', routineExceptions: '0003',
    goals: '0004', projects: '0004',
    notificationPreferences: '0005',
    wellbeing: '0006',
    bills: '0007', recurringExpenses: '0007', savingsGoals: '0007',
    aiAudit: '0008',
    // Migraatio 0009 tuo kaksi taulua JA kolme saraketta bills-tauluun.
    // Sarakeportti on erillinen, koska bills-taulu on olemassa jo
    // 0007:sta: taulun portin avaaminen ei kerro mitään sarakkeista.
    transactions: '0009', investments: '0009',
    BILL_PAYMENT_FIELDS: '0009',
    // Migraatio 0010 tuo yhden taulun JA sarakkeita kolmeen tauluun,
    // joiden portit ovat auki tuotannossa. Sarakeportti ja tilaportti
    // ovat erillisiä: sarakkeen puuttuminen (42703) ja arvon
    // kieltäminen (23514) ovat eri vikoja eri oireella.
    milestones: '0010',
    GOAL_PLANNING_FIELDS: '0010',
    GOAL_MAINTENANCE_MODE: '0010'
  };

  // KAKSI HYVAKSYTTYA LAHDETTA SILLE, ETTA MIGRAATIO ON AJETTU.
  //
  // Migraatio 0002 kertoo sen omassa otsikkorivissaan. Migraatiot
  // 0003-0008 EIVAT: niissa lukee yha "TILA: EI AJETTU TUOTANTOON",
  // ja rivi on jatetty tahallaan koskematta. Perustelu on
  // docs/PRODUCTION-STATUS.md: ajettu migraatio on tietue siita mita
  // tuotannossa ajettiin, ja jalkikateen muokattuna repositorio
  // kertoisi mita joku myohemmin ajatteli ajetun.
  //
  // Ajantasainen tieto on siksi PRODUCTION-STATUS.md:ssa, joka on
  // julistettu auktoritatiiviseksi ja jonka ajantasaisuutta vartioi
  // oma testinsa. Ilman tata haaraa aalto C kaatuisi tahan: portti
  // routines olisi auki, mutta 0003:n otsikkorivi vaittaisi yha
  // etta migraatiota ei ole ajettu.
  //
  // Vaite ei loysty: portin saa yha avata vain jos JOKIN
  // auktoritatiivinen lahde kertoo migraation olevan ajettu.
  const ajettu = numero => {
    const tiedosto = migrationFiles().find(name => name.startsWith(numero));
    assert.ok(tiedosto, `migraatiota ${numero} ei löytynyt`);

    const otsikossa =
      /TILA: AJETTU JA HYVÄKSYTTY TUOTANNOSSA/.test(read(`${MIGRATION_DIR}/${tiedosto}`));

    const tilarivi = read('docs/PRODUCTION-STATUS.md')
      .split(String.fromCharCode(10))
      .find(rivi => rivi.includes('|') && rivi.includes(tiedosto));
    const dokumentissa = Boolean(tilarivi && /\*\*AJETTU\*\*/.test(tilarivi));

    return otsikossa || dokumentissa;
  };

  const portit = {
    TASK_EXTENDED_FIELDS, BILL_PAYMENT_FIELDS,
    GOAL_PLANNING_FIELDS, GOAL_MAINTENANCE_MODE, ...TABLES
  };

  // Jokaisella portilla on migraatio, ja jokaisella migraatiolla 0002-0008
  // on vähintään yksi portti. Kumpikaan suunta ei saa jäädä auki.
  assert.deepEqual(Object.keys(portit).sort(), Object.keys(PORTIN_MIGRAATIO).sort(),
    'porttien ja niiden migraatiokartan välillä on ero');

  for (const [portti, arvo] of Object.entries(portit)) {
    if (arvo !== true) continue;
    assert.ok(ajettu(PORTIN_MIGRAATIO[portti]),
      `portti ${portti} on auki, mutta migraatiota ${PORTIN_MIGRAATIO[portti]} ei ole merkitty ajetuksi`);
  }

  // AUKI OLEVAT PORTIT TODENNETAAN RIIPPUMATTOMASTA LAHTEESTA.
  //
  // Aiemmin tassa oli kasin kirjoitettu lista ['TASK_EXTENDED_FIELDS'],
  // jotta muutos nakyisi diffissa eika vain testin lapimenossa. Sama
  // tarkoitus sailyy, mutta lista luetaan nyt
  // docs/PRODUCTION-STATUS.md:sta -- eli operaattorin on yha
  // kirjoitettava tila auki jonnekin, ja se jokin on dokumentti jota
  // han oikeasti lukee aktivoinnin hetkella.
  //
  // Tama EI ole keha: vertailun toinen puoli on schema.js ja toinen
  // markdown-taulukko. Vaarennos vaatisi molempien muuttamista
  // johdonmukaisesti -- eli tasmalleen sen mita kelvollinen
  // aaltocommitti tekee.
  const auki = Object.entries(portit).filter(([, v]) => v === true).map(([k]) => k);

  const dokumentinPortit = parseStatusDoc(read('docs/PRODUCTION-STATUS.md'));
  assert.ok(dokumentinPortit, 'PRODUCTION-STATUS.md:n porttitaulukkoa ei voitu lukea');

  // Sarakeportit (BILL_PAYMENT_FIELDS, aalto F) eivät ole tauluportteja,
  // joten parseStatusDoc ei lue niitä: ne luetaan omilta riveiltään.
  const statusRivit = read('docs/PRODUCTION-STATUS.md').split(NEWLINE);
  const sarakeportitAuki = ['BILL_PAYMENT_FIELDS'].filter(portti =>
    statusRivit.some(r => r.includes('|') && r.includes('`' + portti + '`') && /AKTIVOITU/.test(r)));
  const dokumentinAuki = ['TASK_EXTENDED_FIELDS', ...sarakeportitAuki,
    ...Object.entries(dokumentinPortit).filter(([, v]) => v).map(([k]) => k)];

  assert.deepEqual(auki.sort(), dokumentinAuki.sort(),
    `schema.js sanoo auki: ${auki.join(', ') || 'ei yhtaan'};`
    + ` PRODUCTION-STATUS.md sanoo: ${dokumentinAuki.join(', ')}`);
  // Kaksitoista taulua + kaksi sarakeporttia (TASK_EXTENDED_FIELDS ja
  // BILL_PAYMENT_FIELDS). Luku on käsin laskettu ja tarkoituksella:
  // uuden portin lisääminen kaataa tämän, ja se on oikea hetki
  // tarkistaa, että portti on myös tilannedokumentissa ja
  // migraatiokartassa.
  // Kolmetoista taulua + neljä sarake-/arvoporttia.
  assert.equal(Object.keys(portit).length, 17);

  // Ja avatun portin migraatio on todella ajettu — sama sääntö kuin yllä,
  // mutta nimenomaisesti sille portille joka on auki.
  assert.ok(ajettu('0002'), 'TASK_EXTENDED_FIELDS on auki, mutta 0002 ei ole ajettu');
});

test('KRIITTINEN: aktivointia edeltava varmistus on vain lukeva ALL-IN-ONE', () => {
  // Tämä tiedosto ajetaan tuotantoa vasten käsin liittämällä, ja se on
  // viimeinen portti ennen lipun kääntämistä. Jos siihen livahtaisi
  // muuttava lause, se ajettaisiin juuri siinä hetkessä, jossa kannan
  // pitää olla koskematon.
  //
  // Yleinen "varmistuskyselyt ovat vain lukevia" -testi kattaa tämän
  // hakemistona. Tässä sama todetaan erikseen ja tiukemmin: myös
  // lauseiden lukumäärä ja tulosteen muoto.
  const tiedosto = 'supabase/verify/verify_pre_task_extended_activation.sql';
  const raw = read(tiedosto);

  const lauseet = raw.split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE)
    .split(';')
    .map(part => part.trim())
    .filter(Boolean);

  assert.equal(lauseet.length, 1, `${tiedosto}: ei ole yksi lause`);
  assert.equal(lauseet[0].split(/\s+/)[0].toLowerCase(), 'select',
    'lause ei ala sanalla select');

  const koodi = lauseet[0].toLowerCase();
  for (const kielletty of ['insert ', 'update ', 'delete ', 'drop ', 'alter ',
                           'create ', 'grant ', 'revoke ', 'truncate ']) {
    assert.equal(new RegExp(`(^|[\s(])${kielletty}`).test(koodi), false,
      `${tiedosto} sisältää muuttavan lauseen: ${kielletty.trim()}`);
  }

  for (const sarake of ['check_no', 'section', 'check_name', 'status',
                        'details', 'poikkeavia_yhteensa']) {
    assert.ok(raw.includes(sarake), `tulosteesta puuttuu sarake ${sarake}`);
  }
});

test('KRIITTINEN: aktivointia edeltava varmistus todistaa kirjoituskokeen jäljettömyyden', () => {
  // Kertakäyttöinen tehtävä luotiin ja poistettiin tuotannossa. Pelkkä
  // rivimäärä ei riitä todisteeksi: 36 voisi tarkoittaa myös "yksi
  // alkuperäinen poistettiin ja yksi uusi jäi".
  //
  // Migraatio 0002 antoi kaikille riveille SAMAN created_at-arvon,
  // koska vakio-oletus talletetaan kerran metatietoon eikä rivejä
  // kirjoiteta uudelleen. Jokainen sovelluksen luoma rivi saa siis oman
  // myöhemmän arvonsa — ja siksi erillisten luontiaikojen lukumäärä on
  // tarkempi jäännösmittari kuin rivimäärä.
  const sql = read('supabase/verify/verify_pre_task_extended_activation.sql').toLowerCase();

  assert.ok(sql.includes('count(distinct created_at)'),
    'jäännöstä ei havaita luontiaikojen perusteella');
  assert.ok(sql.includes('created_at > (select min(created_at)'),
    'migraation jälkeen luotuja rivejä ei etsitä');

  // Ja kolme riippumatonta mittaria samasta asiasta.
  assert.ok(sql.includes("'36'"), 'odotettua rivimäärää ei tarkisteta');
  assert.ok(sql.includes('md5(string_agg(id'), 'tunnisteiden sormenjälki puuttuu');

  // Laajennettujen kenttien lähtötila on nolla niin kauan kuin lippu on
  // false. Tämä on lähin kannasta näkyvä todiste lipun tilasta.
  for (const [needle, mita] of [
    ['description is not null', 'kuvauksellisten rivien määrä'],
    ['duration_minutes is not null', 'kestollisten rivien määrä'],
    ["priority <> 'normaali'", 'ei-oletusprioriteetit']
  ]) {
    assert.ok(sql.includes(needle), `lipun lähtötilaa ei todeta: ${mita}`);
  }
});

test('aktivointia edeltava varmistus on verrattavissa tilannekuvaan', () => {
  // Sormenjälki on hyödytön, jos sitä ei voi verrata mihinkään. Molempien
  // tiedostojen on laskettava se samalla tavalla, muuten vertailu
  // näyttäisi erolta joka ei ole ero.
  const ennen = read('supabase/verify/verify_pre_task_extended_activation.sql');
  const tilannekuva = read('supabase/preflight/recovery_snapshot_post_0002.sql');

  for (const kaava of [
    "md5(string_agg(id, '|' order by id))",
    "'#' order by id)), 'tyhja')"
  ]) {
    assert.ok(ennen.includes(kaava) && tilannekuva.includes(kaava),
      `sormenjäljen kaava eroaa tiedostojen välillä: ${kaava}`);
  }
});

// ================================================================
// 0003 on valmisteltu tuotantoon — samat vaatimukset kuin 0002:lla
// ================================================================

/** Migraatio ilman kommentteja, pienaakkosin. */
function migraationKoodi(name) {
  return read(`${MIGRATION_DIR}/${name}`)
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE)
    .toLowerCase();
}

test('KRIITTINEN: valmistellut migraatiot asettavat lock_timeoutin', () => {
  // Jokainen migraatio viittaa auth.users-tauluun vierasavaimella, ja
  // vierasavaimen luonti ottaa viitattuun tauluun lukon. auth.users on
  // taulu, jota jokainen kirjautuminen koskee.
  //
  // Ilman aikakatkaisua pitkä transaktio siellä jättäisi migraation
  // jonoon — ja koska lukkojono on FIFO, sen taakse jonoutuisi jokainen
  // kirjautuminen. Migraatio, joka odottaa hiljaa, kaataa sovelluksen
  // odottaessaan.
  //
  // Lista kasvaa sitä mukaa kuin migraatioita valmistellaan
  // tuotantoon. 0004–0008 liittyvät tähän omissa paketeissaan; niitä ei
  // ole vielä auditoitu eikä niitä saa ajaa.
  const VALMISTELLUT = ['0001_auth_user_scoping.sql',
                        '0002_task_domain_fields.sql',
                        '0003_routines.sql'];

  for (const name of VALMISTELLUT) {
    const code = migraationKoodi(name);
    assert.ok(code.includes('set local lock_timeout'),
      `${name}: lock_timeout puuttuu`);

    // Ja se on asetettava ennen ensimmäistä lukkoa ottavaa lausetta.
    const timeout = code.indexOf('set local lock_timeout');
    for (const lause of ['lock table', 'create table', 'alter table']) {
      const kohta = code.indexOf(lause);
      if (kohta === -1) continue;
      assert.ok(timeout < kohta,
        `${name}: "${lause}" tapahtuu ennen lock_timeoutin asettamista`);
    }
  }
});

test('KRIITTINEN: 0003 tunnistaa aiemman ja kesken jääneen ajon', () => {
  // Aiempi versio käytti `if not exists` -muotoa joka kohdassa. Silloin
  // toinen ajo, kesken jäänyt ajo ja tuore ajo näyttivät kaikki samalta:
  // onnistuneelta. Tila, jota ei voi erottaa, on tila jota ei voi
  // korjata.
  const code = migraationKoodi('0003_routines.sql');

  assert.match(code, /raise exception 'migraatio 0003 on jo ajettu/,
    'toinen ajo menisi hiljaa läpi');
  assert.match(code, /raise exception 'migraatio 0003 on kesken/,
    'kesken jäänyttä ajoa ei tunnisteta');

  // Tunnistus kattaa kaikki objektiluokat, ei vain tauluja.
  for (const objekti of ['routines_owner_row_key', 'routine_exceptions_unique_day',
                         'routines_user_active_idx', 'routines_touch_updated_at',
                         'pg_policies']) {
    assert.ok(code.includes(objekti),
      `osittaisen ajon tunnistus ei kata objektia ${objekti}`);
  }
});

test('KRIITTINEN: 0003 ei piilota tuntematonta tilaa if not exists -muodon taakse', () => {
  const code = migraationKoodi('0003_routines.sql');

  const ddl = code.split(NEWLINE).filter(line =>
    /^\s*(create table|create index|create trigger)/.test(line));

  assert.ok(ddl.length >= 6, `DDL-lauseita löytyi vain ${ddl.length}`);
  for (const line of ddl) {
    assert.equal(/if not exists/.test(line), false,
      `fail-closed rikki: ${line.trim()}`);
  }

  // Funktio on poikkeus ja se on perusteltu: sen luo jo 0002, joka on
  // ajettu. Siksi se on yhä create or replace.
  assert.ok(code.includes('create or replace function public.touch_updated_at'),
    'jaettu funktio ei ole enää create or replace');
});

test('KRIITTINEN: 0003 tarkistaa 0001:n ja 0002:n perustan ennen muutoksia', () => {
  const code = migraationKoodi('0003_routines.sql');
  const ensimmainenDDL = code.indexOf('create table public.routines');
  assert.ok(ensimmainenDDL > 0, 'taulun luontia ei löytynyt');

  for (const [ehto, mita] of [
    ['tasks', 'tasks-taulun tila'],
    ['relrowsecurity', 'RLS:n tila'],
    ['pg_policies', 'politiikkojen määrä'],
    ['auth.users', 'omistajan olemassaolo'],
    ['scheduling_state', '0002:n sarakkeet']
  ]) {
    const kohta = code.indexOf(ehto);
    assert.ok(kohta > 0 && kohta < ensimmainenDDL,
      `esiehto puuttuu tai on liian myöhässä: ${mita}`);
  }

  assert.ok(code.includes(OWNER_UUID.toLowerCase()),
    '0003 ei tarkista olevansa oikeassa tietokannassa');
});

test('KRIITTINEN: 0003 sulkee PUBLIC-roolin perintäpolun', () => {
  // Sama vika, jonka 0001 joutui korjaamaan jälkikäteen. PostgreSQL-rooli
  // PUBLIC tarkoittaa "kaikki roolit", ja sille myönnetyn oikeuden perii
  // myös anon. Perittyä oikeutta ei näy roolikohtaisissa listauksissa
  // lainkaan, joten `revoke ... from anon` ei poista sitä.
  const code = migraationKoodi('0003_routines.sql');

  for (const taulu of ['routines', 'routine_exceptions']) {
    for (const rooli of ['public', 'anon', 'authenticated']) {
      assert.match(code,
        new RegExp(`revoke all on public\\.${taulu}\\s+from ${rooli};`),
        `${taulu}: oikeuksia ei peruta roolilta ${rooli} ennen myöntöä`);
    }
  }

  // Ja peruminen tapahtuu ennen myöntöä, muuten se pyyhkisi myönnön.
  const revoke = code.lastIndexOf('revoke all on');
  const grant = code.indexOf('grant select, insert, update, delete');
  assert.ok(revoke < grant, 'peruminen tapahtuu myönnön jälkeen');
});

test('KRIITTINEN: poikkeus ei voi viitata toisen käyttäjän rutiiniin', () => {
  // LÖYTYNYT AUKKO, JOTA TÄMÄ VARTIOI
  //
  // Vierasavaimen tarkistus ei kulje RLS:n läpi. Pelkällä
  // routine_id-viittauksella käyttäjä B olisi voinut luoda poikkeuksen,
  // joka osoittaa käyttäjän A rutiiniin: B ei näkisi A:n rutiinia, mutta
  // rivi olisi silti olemassa ja viittaisi toisen ihmisen dataan.
  // RLS estää lukemisen, ei viittaamista.
  //
  // Yhdistelmävierasavain (user_id, routine_id) sitoo omistajat yhteen.
  const code = migraationKoodi('0003_routines.sql');

  assert.match(code, /foreign key \(user_id, routine_id\)\s+references public\.routines \(user_id, id\)/,
    'poikkeuksen vierasavain ei sido omistajaa rutiinin omistajaan');
  assert.ok(code.includes('constraint routines_owner_row_key unique (user_id, id)'),
    'routines-taulusta puuttuu yhdistelmäavaimen kohde');

  // Eikä vanhaa yhden sarakkeen viittausta saa jäädä.
  assert.equal(/routine_id\s+text not null references public\.routines\(id\)/.test(code), false,
    'yhden sarakkeen vierasavain on yhä paikallaan');

  // Ja varmistus todentaa saman kannasta.
  const verify = read('supabase/verify/verify_0003.sql').toLowerCase();
  assert.ok(verify.includes("array['routine_id', 'user_id']"),
    'varmistus ei tarkista yhdistelmävierasavainta');
});

test('KRIITTINEN: 0003:n varmistus kattaa jokaisen luodun invariantin', () => {
  const verify = read('supabase/verify/verify_0003.sql').toLowerCase();

  const vaaditut = [
    ['information_schema.columns', 'sarakkeet'],
    ["data_type = 'uuid'",         'omistajasarakkeen tyyppi'],
    ['auth.uid()',                 'omistajan oletusarvo'],
    ['pg_get_constraintdef',       'tarkisteiden ehdot'],
    ['confdeltype',                'vierasavaimen poistosääntö'],
    ['conkey',                     'vierasavaimen sarakkeet'],
    ['indkey',                     'indeksin sarakkeet'],
    ['tgtype',                     'liipaisimen ajoitus'],
    ['prosecdef',                  'funktion turvakonteksti'],
    ['proconfig',                  'funktion search_path'],
    ['relrowsecurity',             'RLS'],
    ['with_check',                 'politiikkojen kirjoitusehdot'],
    ["has_table_privilege('anon'", 'anonin oikeudet'],
    ['aclexplode',                 'PUBLIC-roolin oikeudet'],
    ['left join public.routines',  'orvot poikkeukset']
  ];

  for (const [needle, mita] of vaaditut) {
    assert.ok(verify.includes(needle), `verify_0003:sta puuttuu: ${mita}`);
  }

  // Myöhempien migraatioiden puuttuminen on osa 0003:n hyväksyntää.
  assert.ok(verify.includes("'savings_goals'"),
    'verify_0003 ei tarkista, että 0004-0008 ovat yhä ajamatta');
});

test('0003:n preflight ja tilannekuva ovat vain lukevia ALL-IN-ONE-kyselyitä', () => {
  for (const tiedosto of ['supabase/preflight/preflight_0003.sql',
                          'supabase/preflight/recovery_snapshot_pre_0003.sql',
                          'supabase/verify/verify_0003.sql']) {
    const raw = read(tiedosto);
    const lauseet = raw.split(NEWLINE)
      .filter(line => !line.trim().startsWith('--'))
      .join(NEWLINE)
      .split(';')
      .map(part => part.trim())
      .filter(Boolean);

    assert.equal(lauseet.length, 1, `${tiedosto}: ei ole yksi lause`);
    assert.equal(lauseet[0].split(/\s+/)[0].toLowerCase(), 'select',
      `${tiedosto}: lause ei ala sanalla select`);

    for (const sarake of ['check_no', 'section', 'check_name', 'status',
                          'details', 'poikkeavia_yhteensa']) {
      assert.ok(raw.includes(sarake), `${tiedosto}: puuttuu sarake ${sarake}`);
    }
  }
});

// ================================================================
// OLETUSOIKEUDET (pg_default_acl) — 0003:n turvallisuuden ehto
// ================================================================
//
// Supabase myöntää vakiona oletusoikeudet tuleville objekteille
// rooleille anon ja authenticated. Uusi taulu voi siis SYNTYÄ avoimena.
// Se ei ole vika ympäristössä eikä este migraatiolle — mutta se tekee
// migraation omasta perumisesta pakollisen, ei valinnaisen.
//
// Nämä testit vartioivat sitä ketjua: peruminen on olemassa, se on
// oikeassa kohdassa, ja lopputulos vahvistetaan ennen committia.

test('KRIITTINEN: oletusoikeus ei voi ohittaa 0003:n perumista', () => {
  // Ketju on kolmiosainen, ja jokainen osa on välttämätön:
  //   1. peruminen kaikilta kolmelta roolilta
  //   2. peruminen ENNEN myöntöä ja ennen committia
  //   3. lopputuloksen vahvistus samassa transaktiossa
  //
  // Jos yksikin puuttuu, oletusoikeus jäisi voimaan uusiin tauluihin.
  const code = migraationKoodi('0003_routines.sql');

  const revoke = code.indexOf('revoke all on');
  const viimeinenRevoke = code.lastIndexOf('revoke all on');
  const grant = code.indexOf('grant select, insert, update, delete');
  const vahvistus = code.lastIndexOf('has_table_privilege');
  const commit = code.lastIndexOf(NEWLINE + 'commit;');

  assert.ok(revoke > 0, 'perumista ei ole lainkaan');
  assert.ok(viimeinenRevoke < grant, 'peruminen tapahtuu myönnön jälkeen');
  assert.ok(grant < vahvistus, 'vahvistus tapahtuu ennen myöntöä');
  assert.ok(vahvistus < commit, 'vahvistus tapahtuu vasta committin jälkeen');

  // Ja peruminen kattaa nimenomaan sen roolin, jolle Supabase myöntää
  // oletusoikeudet — sekä PUBLICin, jonka kautta anon perii.
  for (const rooli of ['public', 'anon', 'authenticated']) {
    assert.ok(new RegExp(`revoke all on public\\.routines\\s+from ${rooli};`).test(code),
      `routines: oikeuksia ei peruta roolilta ${rooli}`);
  }
});

test('KRIITTINEN: 0003 vahvistaa lopulliset oikeudet kahdella menetelmällä', () => {
  // has_table_privilege kertoo ONKO oikeus, perintä mukaan lukien.
  // aclexplode kertoo MISTÄ se tulee. Kumpikaan ei riitä yksin:
  // PUBLICille myönnetty oikeus ei näy roolikohtaisissa listauksissa
  // lainkaan, ja pelkkä ACL-listaus ei näe roolijäsenyyksien kautta
  // perittyä oikeutta.
  const code = migraationKoodi('0003_routines.sql');

  assert.ok(code.includes("has_table_privilege('anon'"),
    'anonin tehollisia oikeuksia ei vahvisteta');
  assert.ok(code.includes("has_table_privilege('authenticated'"),
    'authenticated-roolin oikeuksia ei vahvisteta');
  assert.ok(code.includes('aclexplode') && code.includes('acl.grantee = 0'),
    'PUBLIC-roolin oikeuksia ei vahvisteta taulun oikeuslistasta');

  // Vahvistukset ovat transaktion sisällä, eivät kommentissa.
  const commit = code.lastIndexOf(NEWLINE + 'commit;');
  assert.ok(code.indexOf('aclexplode') < commit,
    'PUBLIC-vahvistus on committin jälkeen');

  // Ja jokainen niistä johtaa poikkeukseen, ei pelkkään ilmoitukseen.
  assert.ok(code.includes('raise exception \'anon-roolilla on'),
    'anonin poikkeama ei keskeytä migraatiota');
  assert.ok(code.includes('raise exception \'public-roolilla on'),
    'PUBLICin poikkeama ei keskeytä migraatiota');
});

test('KRIITTINEN: preflight ei pysäytä ympäristön normaaliin tilaan', () => {
  // LÖYTYNYT VÄÄRÄ HÄLYTYS
  //
  // Kohta 19 vaati, ettei oletusoikeuksissa ole anon-myöntöjä, ja
  // pysäytti tuotannossa lukemaan 60. Vaatimus oli väärä: Supabase
  // myöntää ne vakiona, ja luku on rivien ja yksittäisten oikeuksien
  // tulo — ei 60 taulua.
  //
  // Väärä hälytys keskellä valmistelua on kallis kahdesti: se pysäyttää
  // oikean työn, ja se houkuttelee "korjaamaan" globaalit
  // oletusoikeudet, mikä vaikuttaisi kaikkiin tuleviin Supabase-
  // objekteihin.
  const preflight = read('supabase/preflight/preflight_0003.sql');

  // Oletusoikeuksien määrä on INFO, ei PASS/FAIL.
  const anonRivi = preflight.split('union all')
    .find(osa => osa.includes('Oletusoikeusmerkintoja roolille anon'));
  assert.ok(anonRivi, 'oletusoikeuksien määrää ei raportoida lainkaan');
  assert.match(anonRivi, /'INFO'/,
    'oletusoikeuksien määrä on yhä PASS/FAIL-tarkistus');

  // Ja tilalle on tullut se, mikä oikeasti ratkaisee: neutralointi
  // toimii tässä kannassa, koska se toimi jo tauluille tasks ja profile.
  assert.ok(preflight.includes('Oletusoikeudet on jo neutraloitu'),
    'neutraloinnin todistetta ei tarkisteta');
  assert.match(preflight, /neutraloitu: anon ei paase tauluihin tasks\/profile', '0'/,
    'anonin neutralointia ei tarkisteta nollaa vasten');
  assert.match(preflight, /neutraloitu: PUBLIC ei paase tauluihin tasks\/profile', '0'/,
    'PUBLICin neutralointia ei tarkisteta nollaa vasten');

  // Diagnostiikkaan viitataan, jotta luvun voi purkaa osiin.
  assert.ok(preflight.includes('diagnose_default_acl_0003.sql'),
    'preflight ei kerro, mistä luvun purku löytyy');
});

test('oletusoikeuksien diagnostiikka on vain lukeva ja purkaa luvun osiin', () => {
  const tiedosto = 'supabase/preflight/diagnose_default_acl_0003.sql';
  const raw = read(tiedosto);

  const lauseet = raw.split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE)
    .split(';')
    .map(part => part.trim())
    .filter(Boolean);

  assert.equal(lauseet.length, 1, 'diagnostiikka ei ole yksi lause');
  assert.equal(lauseet[0].split(/\s+/)[0].toLowerCase(), 'select');

  for (const sarake of ['check_no', 'section', 'check_name', 'status',
                        'details', 'poikkeavia_yhteensa']) {
    assert.ok(raw.includes(sarake), `puuttuu sarake ${sarake}`);
  }

  // Purku erittelee omistajan, skeeman, objektityypin ja saajan —
  // muuten luvusta 60 ei voi paatella mitaan.
  for (const [needle, mita] of [
    ['defaclrole', 'oletusoikeuden omistajarooli'],
    ['defaclnamespace', 'skeema'],
    ['defaclobjtype', 'objektityyppi'],
    ['privilege_type', 'yksittäinen oikeus'],
    ["'r'", 'taulut erotettuna muista objektityypeistä'],
    ["'S'", 'jonot'],
    ["'f'", 'funktiot'],
    ['has_schema_privilege', 'skeeman käyttöoikeus']
  ]) {
    assert.ok(raw.includes(needle), `diagnostiikasta puuttuu: ${mita}`);
  }

  // Ja se sisältää todisteen siitä, että neutralointi toimii jo.
  assert.ok(raw.includes("has_table_privilege('anon'"),
    'diagnostiikka ei todista neutralointia olemassa olevilla tauluilla');
});

// ================================================================
// 0003:n sarakemäärät — varmistus lasketaan migraatiosta
// ================================================================
//
// LÖYTYNYT VIKA, JOTA NÄMÄ VARTIOIVAT
//
// verify_0003.sql odotti taululta routine_exceptions kymmentä
// saraketta. Migraatio luo yksitoista. Odotusarvo oli laskettu käsin
// ("yhdeksän nimettyä + kaksi sisältökenttää"), ja `updated_at` unohtui
// kummastakin listasta. Tuotannon varmistus pysähtyi siihen, vaikka
// kanta oli täsmälleen migraation mukainen.
//
// Käsin laskettu odotusarvo vanhenee aina. Nämä testit laskevat sen
// migraatiosta, joten sarakkeen lisääminen tai poistaminen kaataa
// varmistuksen samassa commitissa jossa muutos tehdään.

/** Yhden taulun sarakkeet migraation create table -lauseesta. */
function migraationSarakkeet(migraatio, taulu) {
  const luonti = new RegExp(`create table public\\.${taulu} \\(([\\s\\S]*?)\\n\\);`)
    .exec(read(`${MIGRATION_DIR}/${migraatio}`));
  assert.ok(luonti, `${taulu}: create table ei löytynyt`);

  return luonti[1].split(NEWLINE)
    .map(line => /^ {2}(\w+)\s+\S/.exec(line))
    .filter(Boolean)
    .map(m => m[1])
    .filter(nimi => nimi !== 'constraint' && nimi !== 'foreign');
}

/** Varmistuksen odotusarvo annetulle tarkistuksen nimelle. */
function odotusarvo(sql, osuma) {
  const rivi = sql.split('union all').find(osa => osa.includes(osuma));
  assert.ok(rivi, `tarkistusta ei löytynyt: ${osuma}`);
  const m = /',\s*'(\d+)',/.exec(rivi);
  assert.ok(m, `odotusarvoa ei löytynyt: ${osuma}`);
  return Number(m[1]);
}

test('KRIITTINEN: varmistuksen sarakemäärät vastaavat migraatiota', () => {
  const verify = read('supabase/verify/verify_0003.sql');

  for (const [taulu, osuma] of [
    ['routines', 'routines-taulussa on tasan 17 saraketta'],
    ['routine_exceptions', 'routine_exceptions-taulussa on tasan 11 saraketta']
  ]) {
    const kannassa = migraationSarakkeet('0003_routines.sql', taulu);
    const odotettu = odotusarvo(verify, osuma);

    assert.equal(odotettu, kannassa.length,
      `${taulu}: varmistus odottaa ${odotettu} saraketta, migraatio luo ${kannassa.length}`
      + ` (${kannassa.join(', ')})`);
  }
});

test('KRIITTINEN: nimetyt + nimeämättömät = kokonaismäärä', () => {
  // Kokonaismäärä yksin ei todista mitään: se voisi täsmätä, vaikka
  // odotettu sarake puuttuisi ja tilalla olisi tuntematon. Kolmen luvun
  // on oltava keskenään johdonmukaiset, ja jokainen niistä lukittu.
  const verify = read('supabase/verify/verify_0003.sql');

  const tapaukset = [
    ['routines', 'routines-taulun rakenteelliset sarakkeet ovat olemassa',
     'routines-taulussa on tasan yksi nimeamaton sarake',
     'routines-taulussa on tasan 17 saraketta'],
    ['routine_exceptions', 'routine_exceptions-taulun rakenteelliset sarakkeet ovat olemassa',
     'routine_exceptions-taulussa on tasan kaksi nimeamatonta saraketta',
     'routine_exceptions-taulussa on tasan 11 saraketta']
  ];

  for (const [taulu, nimetyt, nimeamattomat, yhteensa] of tapaukset) {
    const a = odotusarvo(verify, nimetyt);
    const b = odotusarvo(verify, nimeamattomat);
    const c = odotusarvo(verify, yhteensa);

    assert.equal(a + b, c,
      `${taulu}: ${a} nimettyä + ${b} nimeämätöntä <> ${c} yhteensä`);
    assert.ok(b >= 1, `${taulu}: nimeämättömien määrää ei lukita lainkaan`);
  }
});

test('KRIITTINEN: nimettyjen sarakkeiden lista ja sen odotusarvo eivät voi ajautua erilleen', () => {
  // Odotusarvo (esim. '9') ja `column_name in (...)` -lista ovat kaksi
  // eri paikkaa, jotka kuvaavat samaa asiaa. Jos listasta poistetaan
  // nimi mutta luku jää ennalleen, varmistus kaatuu tuotannossa — ja
  // kaatuu VÄÄRÄSTÄ syystä, aivan kuten sarakemäärän kanssa kävi.
  //
  // Tämä testi lukee molemmat ja vertaa ne toisiinsa.
  const verify = read('supabase/verify/verify_0003.sql');

  const lohkot = verify.split('union all')
    .filter(osa => osa.includes('rakenteelliset sarakkeet ovat olemassa'));
  assert.equal(lohkot.length, 2, `nimettyjen sarakkeiden tarkistuksia löytyi ${lohkot.length}`);

  for (const lohko of lohkot) {
    const odotettu = Number(/',\s*'(\d+)',/.exec(lohko)[1]);
    const lista = /column_name in \(([\s\S]*?)\)\)/.exec(lohko);
    assert.ok(lista, 'sarakelistaa ei löytynyt');

    const nimet = [...lista[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
    assert.equal(nimet.length, odotettu,
      `lista sisältää ${nimet.length} nimeä mutta odotusarvo on ${odotettu}: ${nimet.join(', ')}`);

    // Ja jokainen nimetty sarake on oikeasti migraation luoma.
    const taulu = lohko.includes('routine_exceptions') ? 'routine_exceptions' : 'routines';
    const kannassa = migraationSarakkeet('0003_routines.sql', taulu);
    for (const nimi of nimet) {
      assert.ok(kannassa.includes(nimi),
        `${taulu}: varmistus odottaa saraketta ${nimi}, jota migraatio ei luo`);
    }
  }
});

test('KRIITTINEN: nimeämättömien laskenta käyttää samaa listaa kuin nimettyjen', () => {
  // `in (...)` ja `not in (...)` on oltava sama joukko. Jos ne
  // eroaisivat, "nimetyt + nimeämättömät = kokonaismäärä" olisi
  // mielivaltainen yhtälö eikä todistaisi mitään.
  const verify = read('supabase/verify/verify_0003.sql');

  for (const taulu of ['routines', 'routine_exceptions']) {
    const nimetty = verify.split('union all')
      .find(osa => osa.includes(`${taulu}-taulun rakenteelliset sarakkeet`));
    const nimeamaton = verify.split('union all')
      .find(osa => osa.includes(`${taulu}-taulussa on tasan`) && osa.includes('nimeam'));

    assert.ok(nimetty && nimeamaton, `${taulu}: molempia tarkistuksia ei löytynyt`);

    // Ilman dynaamista RegExpiä: sulkujen ja kenoviivojen pakeneminen
    // mallinelausekkeen sisällä on juuri se paikka, jossa tarkistus
    // rikkoutuu hiljaa. Merkkijonohaku on tylsempi ja luotettavampi.
    const poimi = (teksti, avainsana) => {
      const alku = teksti.indexOf('column_name ' + avainsana + ' (');
      assert.ok(alku >= 0, `${taulu}: ${avainsana}-listaa ei löytynyt`);
      const loppu = teksti.indexOf('))', alku);
      const lista = teksti.slice(alku, loppu);
      return [...lista.matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort();
    };

    assert.deepEqual(poimi(nimetty, 'in'), poimi(nimeamaton, 'not in'),
      `${taulu}: nimettyjen ja nimeämättömien listat eroavat`);
  }
});

test('KRIITTINEN: varmistus ei nojaa pelkkään kokonaismäärään', () => {
  // Jos nimeämättömien lukumäärä poistettaisiin, ylimääräinen sarake
  // jäisi huomaamatta silloin kun jokin odotettu puuttuu samaan aikaan.
  const verify = read('supabase/verify/verify_0003.sql');

  for (const osuma of ['tasan yksi nimeamaton sarake',
                       'tasan kaksi nimeamatonta saraketta']) {
    assert.ok(verify.includes(osuma), `puuttuu tarkistus: ${osuma}`);
  }
  assert.ok(verify.includes('column_name not in'),
    'nimeämättömiä sarakkeita ei lasketa lainkaan');
});

test('KRIITTINEN: sovelluksen kirjoittamat + palvelimen omistamat = kaikki sarakkeet', () => {
  // Tämä on riippumaton tapa laskea sama luku. Repositorio kirjoittaa
  // kahdeksan saraketta; user_id, created_at ja updated_at ovat kannan
  // omaisuutta. 8 + 3 = 11.
  //
  // Jos migraatio saisi uuden sarakkeen jota sovellus ei kirjoita eikä
  // palvelin omista, tämä kaatuisi — ja se on oikea hetki huomata,
  // ettei kenttää ole kytketty mihinkään.
  const kannassa = migraationSarakkeet('0003_routines.sql', 'routine_exceptions');
  const kirjoitetut = Object.keys(routineExceptionsRepo.mapping.toRow(
    normalizeException({ id: 'x', routineId: 'r', date: '2026-09-07', type: 'skip' })));

  const palvelimenOmat = ['user_id', 'created_at', 'updated_at'];

  assert.equal(kirjoitetut.length + palvelimenOmat.length, kannassa.length,
    `${kirjoitetut.length} kirjoitettua + ${palvelimenOmat.length} palvelimen `
    + `<> ${kannassa.length} saraketta`);

  // Eikä sovellus kirjoita yhtäkään palvelimen omistamaa saraketta.
  for (const kielletty of palvelimenOmat) {
    assert.equal(kirjoitetut.includes(kielletty), false,
      `sovellus kirjoittaa palvelimen omistaman sarakkeen ${kielletty}`);
  }

  // Ja jokainen kirjoitettu sarake on olemassa kannassa.
  for (const sarake of kirjoitetut) {
    assert.ok(kannassa.includes(sarake),
      `sovellus kirjoittaa sarakkeeseen ${sarake}, jota migraatio ei luo`);
  }
});

test('sarakediagnostiikka on vain lukeva ja listaa sarakkeet nimeltä', () => {
  const tiedosto = 'supabase/verify/diagnose_0003_routine_exception_columns.sql';
  const raw = read(tiedosto);

  const lauseet = raw.split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE)
    .split(';')
    .map(part => part.trim())
    .filter(Boolean);

  assert.equal(lauseet.length, 1, 'diagnostiikka ei ole yksi lause');
  assert.equal(lauseet[0].split(/\s+/)[0].toLowerCase(), 'select');

  for (const needle of ['ordinal_position', 'column_name', 'udt_name',
                        'is_nullable', 'column_default', 'is_identity', 'is_generated']) {
    assert.ok(raw.includes(needle), `diagnostiikasta puuttuu ${needle}`);
  }

  // Yhteenvetorivi vertaa odotettua ja todellista.
  assert.ok(raw.includes('Sarakkeita on tasan 11'),
    'diagnostiikka ei kerro odotettua sarakemäärää');
});

test('KRIITTINEN: rajaustarkistukset käyttävät migraatioiden todellisia taulunimiä', () => {
  // LÖYTYNYT VIKA, JOTA TÄMÄ VARTIOI
  //
  // Kahdeksan varmistus- ja preflight-tiedostoa tarkisti, ettei
  // migraatioiden 0004–0008 tauluja ole olemassa. Lista oli kirjoitettu
  // käsin, ja kahdessa nimessä oli virhe: `ai_audit` (oikea nimi on
  // `ai_action_audit`) ja `wellbeing` (oikea on `wellbeing_entries`).
  //
  // Tarkistukset olisivat siis raportoineet PASSin vaikka 0008 olisi
  // ajettu. Rajaustarkistus, joka ei näe rajan ylitystä, on pahempi kuin
  // ei tarkistusta: se antaa väärän varmuuden.
  //
  // Nyt odotettu lista luetaan migraatioista, joten uusi taulu tai
  // uudelleennimeäminen kaataa tämän samassa commitissa.
  const myohemmat = migrationFiles().filter(name => /^000[4-8]/.test(name));
  assert.equal(myohemmat.length, 5, `myöhempiä migraatioita löytyi ${myohemmat.length}`);

  const taulut = new Set();
  for (const name of myohemmat) {
    for (const m of read(`${MIGRATION_DIR}/${name}`)
      .matchAll(/create table (?:if not exists )?public\.(\w+)/g)) {
      taulut.add(m[1]);
    }
  }
  assert.ok(taulut.size >= 8, `tauluja löytyi vain ${taulut.size}`);

  // Rajaustarkistus tunnistetaan siitä VÄITTEESTÄ jonka se esittää, ei
  // siitä että jokin taulunimi sattuu esiintymään tiedostossa.
  // verify_0007 mainitsee savings_goals-taulun koska se VARMISTAA sen —
  // se ei väitä mitään myöhempien migraatioiden puuttumisesta.
  const kaikkiSql = ['supabase/verify', 'supabase/preflight', 'supabase/acceptance']
    .flatMap(hakemisto => fs.readdirSync(path.join(ROOT, hakemisto))
      .filter(n => n.endsWith('.sql'))
      .map(n => `${hakemisto}/${n}`));

  const rajaavat = kaikkiSql.filter(n => /tauluja ei ole olemassa/.test(read(n)));
  assert.ok(rajaavat.length >= 5,
    `rajaustarkistuksia löytyi vain ${rajaavat.length}: ${rajaavat.join(', ')}`);

  for (const tiedosto of rajaavat) {
    const sisalto = read(tiedosto);
    for (const taulu of taulut) {
      assert.ok(sisalto.includes(`'${taulu}'`),
        `${tiedosto}: rajaustarkistuksesta puuttuu taulu ${taulu}`);
    }
  }
});
