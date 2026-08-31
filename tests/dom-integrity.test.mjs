// Staattiset eheys- ja turvallisuustestit index.html-monoliitille.
//
// Sovellus on yhä yksi iso tiedosto ilman käännösvaihetta, joten mikään
// työkalu ei huomauta rikkinäisestä element-viittauksesta ennen kuin
// käyttäjä törmää siihen. Nämä testit korvaavat sen puuttuvan turvaverkon,
// ja lukitsevat WP1:n turvallisuusinvariantit paikalleen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/**
 * index.html ilman kokonaan kommentoituja rivejä.
 * Käytetään invarianteille, jotka koskevat suoritettavaa koodia — muuten
 * muutosta kuvaava kommentti voisi laukaista virheen turhaan.
 */
function executableHtml() {
  return html
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

/** Kaikki lähdekooditiedostot, joissa salaisuuksia ei saa esiintyä. */
function sourceFiles() {
  const files = [
    path.join(ROOT, 'index.html'),
    path.join(ROOT, 'api', 'parse.js'),
    path.join(ROOT, 'api', '_validate.js')
  ];
  const libDir = path.join(ROOT, 'src', 'lib');
  for (const name of fs.readdirSync(libDir)) {
    if (name.endsWith('.js')) files.push(path.join(libDir, name));
  }
  return files;
}

// ---------------------------------------------------------------- eheys

test('index.html ei sisällä kaksoiskappaleina esiintyviä id-attribuutteja', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const duplicates = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  assert.deepEqual(duplicates, [], 'kaksoiskappaleet: ' + duplicates.join(', '));
  assert.ok(ids.length > 50, 'odotettiin runsaasti id-attribuutteja, löytyi ' + ids.length);
});

test('jokainen getElementById-kohde on olemassa dokumentissa', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const referenced = [...new Set([...html.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
  const missing = referenced.filter(id => !ids.has(id));
  assert.deepEqual(missing, [], 'puuttuvat elementit: ' + missing.join(', '));
  assert.ok(referenced.length > 40, 'odotettiin runsaasti viittauksia, löytyi ' + referenced.length);
});

test('jokainen SVG-symboliviittaus osoittaa olemassa olevaan symboliin', () => {
  const defined = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]));
  const referenced = [...new Set([...html.matchAll(/href="#(i-[^"]+)"/g)].map(m => m[1]))];
  const missing = referenced.filter(s => !defined.has(s));
  assert.deepEqual(missing, [], 'puuttuvat symbolit: ' + missing.join(', '));
  assert.ok(defined.size >= 10, 'odotettiin vähintään 10 symbolia, löytyi ' + defined.size);
});

test('index.html sisältää täsmälleen yhden moduuliskriptin', () => {
  const moduleScripts = html.match(/<script type="module">/g) || [];
  assert.equal(moduleScripts.length, 1, 'moduuliskriptejä pitää olla täsmälleen 1');
  const inlineScripts = html.match(/<script>/g) || [];
  assert.equal(inlineScripts.length, 0, 'inline-skriptejä ei saa jäädä (importit eivät toimi niissä)');
});

// ------------------------------------------------------- salaisuudet

test('TURVA: lähdekoodissa ei esiinny Anthropic-avainta', () => {
  for (const file of sourceFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(/sk-ant-[A-Za-z0-9_-]{10}/.test(content), false,
      'mahdollinen Anthropic-avain tiedostossa ' + path.relative(ROOT, file));
  }
});

test('TURVA: lähdekoodissa ei esiinny service_role-avainta', () => {
  for (const file of sourceFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content.includes('service_role'), false,
      'service_role mainittu tiedostossa ' + path.relative(ROOT, file));
    assert.equal(content.includes('SUPABASE_SERVICE'), false,
      'SUPABASE_SERVICE mainittu tiedostossa ' + path.relative(ROOT, file));
  }
});

test('TURVA: selainkoodi ei viittaa ANTHROPIC_API_KEY-muuttujaan', () => {
  // Avain saa esiintyä vain palvelinpuolen api/parse.js:ssä.
  assert.equal(html.includes('ANTHROPIC_API_KEY'), false,
    'ANTHROPIC_API_KEY ei kuulu selaimeen ladattavaan tiedostoon');
});

test('TURVA: selain kutsuu omaa /api/parse-välipalvelinta, ei Anthropicia suoraan', () => {
  assert.ok(html.includes("fetch('/api/parse'"), 'selaimen pitää kutsua omaa päätepistettä');
  assert.equal(html.includes('api.anthropic.com'), false,
    'selain ei saa kutsua Anthropicia suoraan');
});

// ------------------------------------------------- käyttäjäscoping

test('TURVA: jokainen tasks-taulun kutsu on rajattu käyttäjään', () => {
  const calls = [...html.matchAll(/sb\.from\('tasks'\)/g)];
  assert.ok(calls.length >= 5, 'odotettiin useita tasks-kutsuja, löytyi ' + calls.length);
  for (const match of calls) {
    const chain = html.slice(match.index, match.index + 240);
    const scoped = chain.includes(".eq('user_id'") || chain.includes('assertClientSafe');
    assert.ok(scoped,
      'rajaamaton tasks-kutsu:\n' + chain.split('\n').slice(0, 3).join('\n'));
  }
});

test('TURVA: jokainen profile-taulun kutsu on rajattu käyttäjään', () => {
  const calls = [...html.matchAll(/sb\.from\('profile'\)/g)];
  assert.ok(calls.length >= 2, 'odotettiin profile-kutsuja, löytyi ' + calls.length);
  for (const match of calls) {
    const chain = html.slice(match.index, match.index + 240);
    assert.ok(chain.includes('requireUserId()'),
      'rajaamaton profile-kutsu:\n' + chain.split('\n').slice(0, 3).join('\n'));
  }
});

test('TURVA: kiinteää id=me-profiilia ei enää käytetä kyselyissä', () => {
  assert.equal(/\.eq\(\s*'id'\s*,\s*'me'\s*\)/.test(executableHtml()), false,
    'jaettu kiinteä profiili on korvattava auth.uid()-pohjaisella');
});

test('TURVA: sovellus ei kirjoita esimerkkidataa tietokantaan', () => {
  assert.equal(html.includes('seedIntoSupabase'), false,
    'automaattinen seed-kirjoitus on poistettava tuotantopolusta');
  assert.equal(html.includes('function seedTasks'), false,
    'seed-logiikka kuuluu src/lib/seed.js:ään, ei sovelluspolkuun');
});

test('seed-moduuli on olemassa mutta sitä ei ole kytketty sovellukseen', () => {
  const seedPath = path.join(ROOT, 'src', 'lib', 'seed.js');
  assert.ok(fs.existsSync(seedPath), 'seed-logiikka pitää säilyttää myöhempää onboardingia varten');
  assert.equal(html.includes('seed.js'), false, 'index.html ei saa importoida seed-moduulia');
});

// ------------------------------------------------------ autentikointi

test('kirjautumisvirran kaikki tilat ovat olemassa', () => {
  for (const id of ['authSplash', 'authGate', 'authForm', 'authEmail', 'authPassword',
                    'authError', 'authNote', 'authSubmit', 'signoutBtn']) {
    assert.ok(html.includes('id="' + id + '"'), 'puuttuva kirjautumiselementti: ' + id);
  }
});

test('sovellus käyttää Supabasen omaa autentikointia eikä omaa salasanalogiikkaa', () => {
  for (const call of ['sb.auth.signInWithPassword', 'sb.auth.signUp',
                      'sb.auth.signOut', 'sb.auth.getSession', 'sb.auth.onAuthStateChange']) {
    assert.ok(html.includes(call), 'puuttuva auth-kutsu: ' + call);
  }
  // Sovellus ei saa tiivistää, suolata tai tallentaa salasanoja itse.
  for (const forbidden of ['bcrypt', 'sha256(', 'md5(', 'localStorage.setItem(\'password']) {
    assert.equal(html.includes(forbidden), false, 'oma salasanakäsittely kielletty: ' + forbidden);
  }
});

test('sovellusnäkymä on piilotettu ennen kirjautumista', () => {
  assert.ok(/<div id="app" class="app-hidden">/.test(html),
    'sovelluksen pitää olla piilotettu kunnes istunto on todennettu');
});

// -------------------------------------------------------- moduulit

test('siirretyt apufunktiot eivät ole enää monoliitissa kaksoiskappaleina', () => {
  for (const fn of ['function fmtISO', 'function parseISO', 'function addDays',
                    'function startOfWeek', 'function sameDay', 'function todayMidnight',
                    'function sortByTime', 'function loadClass',
                    'function subtractMinutes', 'function addMinutes',
                    'function toRow', 'function fromRow']) {
    assert.equal(html.includes(fn), false,
      fn + ' on siirretty src/lib/-moduuliin, poista kaksoiskappale index.html:stä');
  }
});

test('index.html importoi apufunktiot moduuleista', () => {
  assert.ok(html.includes("from './src/lib/datetime.js'"), 'datetime-moduulin import puuttuu');
  assert.ok(html.includes("from './src/lib/rows.js'"), 'rows-moduulin import puuttuu');
});
