// Turvallisuusinvariantit.
//
// Nämä testit eivät tarkista yksittäisen funktion toimintaa vaan sitä, että
// koko koodikanta noudattaa turvallisuussääntöjä. Ne kaatuvat heti, jos
// joku myöhemmin lisää rajaamattoman kyselyn tai kovakoodaa salaisuuden.
//
// Korvaa aiemman tests/dom-integrity.test.mjs -tiedoston, jonka
// index.html-oletukset vanhentuivat modularisoinnissa. Varsinaiset
// invariantit siirtyivät tänne vahvempina.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  browserModules, serverModules, allSourceFiles, read, readCode, readIndexHtml
} from './helpers/sources.mjs';

// ---------------------------------------------------------- salaisuudet

test('TURVA: missään lähdetiedostossa ei ole Anthropic-avainta', () => {
  for (const file of allSourceFiles()) {
    assert.equal(/sk-ant-[A-Za-z0-9_-]{10}/.test(read(file)), false,
      'mahdollinen Anthropic-avain tiedostossa ' + file);
  }
});

test('TURVA: missään lähdetiedostossa ei ole service_role-avainta', () => {
  for (const file of allSourceFiles()) {
    const source = read(file);
    assert.equal(source.includes('service_role'), false, 'service_role tiedostossa ' + file);
    assert.equal(source.includes('SUPABASE_SERVICE'), false, 'SUPABASE_SERVICE tiedostossa ' + file);
  }
});

test('TURVA: selaimeen ladattava koodi ei viittaa ANTHROPIC_API_KEY-muuttujaan', () => {
  for (const file of [...browserModules(), 'index.html']) {
    assert.equal(readCode(file).includes('ANTHROPIC_API_KEY'), false,
      'API-avain ei kuulu selaimeen: ' + file);
  }
});

test('TURVA: selain ei kutsu Anthropicia suoraan', () => {
  for (const file of [...browserModules(), 'index.html']) {
    assert.equal(readCode(file).includes('api.anthropic.com'), false,
      'selaimen pitää käyttää omaa /api/parse-välipalvelinta: ' + file);
  }
  assert.ok(read('src/data/config.js').includes("parse: '/api/parse'"),
    'päätepisteen osoite kuuluu konfiguraatioon');
});

test('REGRESSIO: Supabase-projekti on sama selaimessa ja palvelimella', async () => {
  // Osoite esiintyy kahdessa paikassa: selaimen konfiguraatiossa ja
  // palvelimen todennuksessa. Ne eivät voi jakaa moduulia, koska toinen on
  // ESM selaimelle ja toinen CommonJS Vercelille. Jos ne ajautuvat erilleen,
  // /api/parse todentaisi tokenit väärää projektia vasten ja hylkäisi
  // jokaisen kirjautuneen käyttäjän.
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import('../src/data/config.js');

  const authSource = read('api/_auth.js');
  const urlMatch = /const SUPABASE_URL =\s*'([^']+)'/.exec(authSource);
  const keyMatch = /const SUPABASE_ANON_KEY =\s*\n?\s*'([^']+)'/.exec(authSource);

  assert.ok(urlMatch, 'api/_auth.js: SUPABASE_URL puuttuu');
  assert.ok(keyMatch, 'api/_auth.js: SUPABASE_ANON_KEY puuttuu');
  assert.equal(urlMatch[1], SUPABASE_URL, 'Supabase-osoitteet ovat ajautuneet erilleen');
  assert.equal(keyMatch[1], SUPABASE_ANON_KEY, 'anon-avaimet ovat ajautuneet erilleen');
});

test('palvelinpuoli lukee avaimen vain ympäristömuuttujasta', () => {
  const source = read('api/parse.js');
  assert.ok(source.includes('process.env.ANTHROPIC_API_KEY'));
  const assignments = source.match(/apiKey\s*=\s*[^;]+/g) || [];
  for (const assignment of assignments) {
    assert.ok(assignment.includes('process.env'),
      'avain saa tulla vain ympäristöstä: ' + assignment);
  }
});

// ------------------------------------------------------ käyttäjäscoping

test('TURVA: kaikki tietokantakutsut ovat data-kerroksessa', () => {
  // Jos kyselyt hajaantuvat, rajauksen valvonta muuttuu mahdottomaksi.
  //
  // Kuvio oli aiemmin /\.from\(\s*'/ eli se tunnisti VAIN merkkijonona
  // kirjoitetun taulun nimen. Repositorio, joka kirjoittaa `.from(table)`
  // muuttujalla, livahti tarkistuksesta kokonaan läpi — eli juuri se
  // yleistetty repositorio, jonka valvonta on tärkeintä.
  const allowed = new Set([
    'src/data/tasksRepo.js',
    'src/data/profileRepo.js',
    'src/data/collectionsRepo.js',
    'src/data/notificationPrefsRepo.js',
    'src/data/client.js'
  ]);
  for (const file of browserModules()) {
    // Array.from ei ole tietokantakutsu.
    const source = readCode(file).replace(/\bArray\.from\(/g, 'ARRAY_FROM(');
    if (!/\.from\(/.test(source)) continue;
    assert.ok(allowed.has(file), 'tietokantakutsu väärässä paikassa: ' + file);
  }
});

test('TURVA: uusien kokoelmien kutsut on rajattu käyttäjään', () => {
  // collectionsRepo palvelee rutiineja, tavoitteita, projekteja ja
  // hyvinvointia yhdellä toteutuksella. Yksi rajaamaton kysely vuotaisi
  // siis neljä tietotyyppiä kerralla.
  const source = readCode('src/data/collectionsRepo.js');
  const calls = [...source.matchAll(/\.from\(table\)/g)];
  assert.ok(calls.length >= 4, 'odotettiin useita kutsuja, löytyi ' + calls.length);

  let scopedCalls = 0;
  for (const match of calls) {
    const chain = source.slice(match.index, match.index + 400);

    // INSERT on tarkoituksella rajaamaton: uudella rivillä ei vielä ole
    // omistajaa, jonka mukaan suodattaa. Omistajuuden asettaa tietokanta
    // (DEFAULT auth.uid()) ja RLS:n WITH CHECK valvoo sen. Suodatin tässä
    // olisi merkityksetön, ja sen vaatiminen opettaisi lisäämään
    // näennäistarkistuksia oikean suojan sijaan.
    if (/\.insert\(/.test(chain)) {
      assert.ok(chain.includes('assertClientSafe'),
        'insert ilman palvelinkenttien tarkistusta:\n' + chain.split('\n').slice(0, 5).join('\n'));
      continue;
    }

    assert.ok(chain.includes('requireUserId()'),
      'rajaamaton kokoelmakutsu:\n' + chain.split('\n').slice(0, 5).join('\n'));
    scopedCalls++;
  }

  assert.ok(scopedCalls >= 3,
    'odotettiin rajattuja luku-, muutos- ja poistokutsuja, löytyi ' + scopedCalls);
});

test('TURVA: muistutusasetusten kutsut on rajattu käyttäjään', () => {
  const source = readCode('src/data/notificationPrefsRepo.js');
  const calls = [...source.matchAll(/\.from\(TABLE\)/g)];
  assert.ok(calls.length >= 2, 'odotettiin useita kutsuja, löytyi ' + calls.length);

  for (const match of calls) {
    const chain = source.slice(match.index, match.index + 400);
    assert.ok(chain.includes('requireUserId()'),
      'rajaamaton asetuskutsu:\n' + chain.split('\n').slice(0, 5).join('\n'));
  }
});

test('TURVA: client ei koskaan kirjoita omistajuussaraketta', () => {
  // Omistajuuden asettaa tietokanta (DEFAULT auth.uid()). Jos selain saisi
  // valita user_id:n, RLS ei suojaisi mitään.
  const source = readCode('src/data/collectionsRepo.js');
  assert.ok(source.includes('SERVER_OWNED'),
    'kirjoituksia ei tarkisteta palvelimen omistamien kenttien varalta');
  assert.ok(source.includes('assertClientSafe'),
    'toRow-tulosta ei tarkisteta ennen kirjoitusta');

  for (const file of ['src/data/collectionsRepo.js', 'src/data/notificationPrefsRepo.js']) {
    assert.equal(/user_id:\s*[^,\n}]/.test(readCode(file)), false,
      file + ' kirjoittaa user_id-sarakkeen — sen pitää tulla kannasta');
  }
});

test('TURVA: jokainen tasks-taulun kutsu on rajattu käyttäjään', () => {
  const source = read('src/data/tasksRepo.js');
  const calls = [...source.matchAll(/\.from\(TABLE\)/g)];
  assert.ok(calls.length >= 5, 'odotettiin useita kutsuja, löytyi ' + calls.length);

  for (const match of calls) {
    const chain = source.slice(match.index, match.index + 320);
    const scoped = chain.includes(".eq('user_id', requireUserId())") || chain.includes('payloadFor(');
    assert.ok(scoped, 'rajaamaton kutsu:\n' + chain.split('\n').slice(0, 4).join('\n'));
  }
});

test('TURVA: profile-taulun kutsut on rajattu käyttäjään', () => {
  const source = read('src/data/profileRepo.js');
  const calls = [...source.matchAll(/\.from\(TABLE\)/g)];
  assert.ok(calls.length >= 2);
  for (const match of calls) {
    const chain = source.slice(match.index, match.index + 320);
    assert.ok(chain.includes('requireUserId()'), 'rajaamaton profiilikutsu:\n' + chain);
  }
});

test('TURVA: kiinteää id=me-profiilia ei enää käytetä', () => {
  for (const file of browserModules()) {
    assert.equal(/\.eq\(\s*'id'\s*,\s*'me'\s*\)/.test(read(file)), false,
      'jaettu kiinteä profiili tiedostossa ' + file);
  }
});

test('TURVA: requireUserId heittää poikkeuksen ilman kirjautumista', async () => {
  const session = await import('../src/data/session.js');
  session.clearUser();
  assert.throws(() => session.requireUserId(), /Ei kirjautunutta/);

  session.setUser({ id: 'abc', email: 'a@b.fi' });
  assert.equal(session.requireUserId(), 'abc');

  session.clearUser();
  assert.throws(() => session.requireUserId(), /Ei kirjautunutta/);
});

test('TURVA: setUser hylkää käyttäjän ilman tunnistetta', async () => {
  const session = await import('../src/data/session.js');
  session.setUser({ email: 'a@b.fi' });
  assert.equal(session.isAuthenticated(), false, 'tunnisteeton käyttäjä ei ole kirjautunut');
  session.clearUser();
});

// ------------------------------------------------------------ seed-data

test('TURVA: sovellus ei kirjoita esimerkkidataa tietokantaan', () => {
  for (const file of [...browserModules(), 'index.html']) {
    assert.equal(readCode(file).includes('seedIntoSupabase'), false,
      'automaattinen seed-kirjoitus tiedostossa ' + file);
  }
});

test('seed-moduuli on olemassa mutta sitä ei ole kytketty sovellukseen', () => {
  const importers = browserModules().filter(file =>
    file !== 'src/lib/seed.js' && readCode(file).includes('seed.js'));
  assert.deepEqual(importers, [], 'seed-moduulia ei saa importoida: ' + importers.join(', '));
});

// -------------------------------------------------------- autentikointi

test('sovellus käyttää Supabasen omaa autentikointia', () => {
  const source = read('src/app/auth.js');
  for (const call of ['auth.signInWithPassword', 'auth.signUp', 'auth.signOut',
                      'auth.getSession', 'auth.onAuthStateChange']) {
    assert.ok(source.includes(call), 'puuttuva auth-kutsu: ' + call);
  }
});

test('TURVA: sovellus ei toteuta omaa salasanakäsittelyä', () => {
  const forbidden = ['bcrypt', 'sha256(', 'md5(', 'createHash', 'pbkdf2'];
  for (const file of browserModules()) {
    const source = read(file);
    for (const pattern of forbidden) {
      assert.equal(source.includes(pattern), false,
        `${file} näyttää käsittelevän salasanoja itse (${pattern})`);
    }
  }
});

test('TURVA: salasanaa ei tallenneta selaimen muistiin', () => {
  for (const file of browserModules()) {
    const source = read(file);
    assert.equal(/setItem\([^)]*password/i.test(source), false,
      'salasanaa ei saa tallentaa: ' + file);
  }
});

test('uloskirjautuminen tyhjentää sovelluksen tilan', () => {
  const main = read('src/app/main.js');
  assert.ok(main.includes('resetState()'), 'tila pitää nollata uloskirjautuessa');
  assert.ok(main.includes('clearDevicePreferences()'), 'laiteasetukset pitää tyhjentää');
  assert.ok(main.includes('clearToasts()'), 'ilmoitukset pitää poistaa');

  // Muistivarastossa elävät kokoelmat EIVÄT tyhjenny resetState():llä, koska
  // ne asuvat repositorion sisällä. Ilman nimenomaista tyhjennystä seuraava
  // käyttäjä näkisi edellisen käyttäjän rutiinit ja tavoitteet samalla
  // laitteella — ristiinvuoto, jota RLS ei voi estää koska mitään ei haeta.
  assert.ok(main.includes('clearLocalUserData()'),
    'paikallinen käyttäjädata pitää tyhjentää uloskirjautuessa');

  // Ja tyhjennyksen on oikeasti katettava molemmat muistivarastot.
  const actions = read('src/app/actions.js');
  const clearFn = actions.slice(actions.indexOf('export function clearLocalUserData'));
  const body = clearFn.slice(0, clearFn.indexOf('\n}'));
  assert.ok(body.includes('clearAllCollections()'), 'kokoelmat jäävät muistiin');
  assert.ok(body.includes('clearNotificationPreferences()'), 'asetukset jäävät muistiin');
});

// ------------------------------------------------------------- XSS-suojaus

/**
 * Kaikki template-literaalit, jotka päätyvät HTML:ksi.
 *
 * Luetaan KOKONAISINA literaaleina eikä riveittäin. Riveittäin lukeva
 * tarkistus ohittaa interpolaation, joka sattuu olemaan omalla rivillään
 * ilman tagia — ja juuri niin monirivinen kooste kirjoitetaan:
 *
 *     container.innerHTML = `<div class="card">
 *       ${task.title}
 *     </div>`;
 *
 * Rivi `${task.title}` ei sisällä tagia, joten riveittäin lukeva tarkistus
 * ei koskaan katsoisi sitä.
 */
function htmlTemplates(source) {
  const templates = [];
  const start = /(innerHTML\s*=\s*|insertAdjacentHTML\s*\([^,]+,\s*)`/g;
  let match;

  while ((match = start.exec(source)) !== null) {
    let i = match.index + match[0].length;
    let depth = 0;
    let body = '';

    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') { body += ch + source[i + 1]; i += 2; continue; }
      if (ch === '$' && source[i + 1] === '{') { depth++; body += '${'; i += 2; continue; }
      if (ch === '}' && depth > 0) { depth--; body += ch; i++; continue; }
      if (ch === '`' && depth === 0) break;
      body += ch;
      i++;
    }
    templates.push(body);
  }
  return templates;
}

/**
 * Kaikki interpolaatiot literaalista, sisäkkäiset mukaan lukien.
 *
 * Sisäkkäinen literaali puretaan omiksi interpolaatioikseen sen sijaan
 * että koko ehtolauseke käsiteltäisiin yhtenä merkkijonona. Muuten
 * sisäkkäisen HTML:n luokkanimi (esim. `class="field-label"`) osuisi
 * kentännimeen ja tuottaisi väärän hälytyksen — ja sen vaientaminen
 * sokeuttaisi tarkistuksen juuri siellä, missä ehdollisuutta on eniten.
 */
function interpolations(template) {
  const found = [];

  for (let i = 0; i < template.length; i++) {
    if (template[i] !== '$' || template[i + 1] !== '{') continue;

    // Luetaan lauseke sulkujen syvyyttä laskien. Säännöllinen lauseke ei
    // tähän riitä: se katkeaa ensimmäiseen parittomaan sulkeeseen ja
    // jättää sisäkkäisen literaalin puolitiehen, jolloin sitä ei voi
    // erottaa ympäröivästä HTML:stä.
    let depth = 1;
    let j = i + 2;
    let expression = '';

    while (j < template.length && depth > 0) {
      const ch = template[j];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
      expression += ch;
      j++;
    }

    // Sisäkkäisten literaalien sisällöt käsitellään omina koosteinaan, ja
    // itse lauseke tarkastetaan ilman niitä.
    for (const inner of expression.matchAll(/`([\s\S]*?)`/g)) {
      found.push(...interpolations(inner[1]));
    }
    found.push(expression.replace(/`[\s\S]*?`/g, ''));

    i = j;
  }
  return found;
}

test('TURVA: käyttäjän syöttämä teksti suojataan HTML-koosteissa', () => {
  // Kentännimiin perustuva tarkistus. Se ei ole täydellinen — se ei voi
  // olla — mutta se kattaa jokaisen tunnetun paikan, jossa käyttäjän oma
  // teksti päätyy sivulle, ja kaatuu jos uusi lisätään suojaamattomana.
  //
  // `query` ja `transcript` ovat mukana, koska haku ja puhe tuottavat
  // käyttäjän tekstiä siinä missä lomakekin. Puheen litterointi on yhtä
  // epäluotettavaa syötettä kuin näppäimistöltä kirjoitettu.
  const USER_DATA = new RegExp('\\b(' + [
    'title', 'note', 'notes', 'description', 'reason', 'email', 'label',
    'name', 'body', 'query', 'transcript', 'summary', 'message', 'inputSummary'
  ].join('|') + ')\\b', 'i');

  const risky = [];

  for (const file of browserModules()) {
    for (const template of htmlTemplates(readCode(file))) {
      for (const expression of interpolations(template)) {
        if (!USER_DATA.test(expression)) continue;
        if (expression.includes('escapeHtml')) continue;
        risky.push(`${file}: \${${expression.trim().replace(/\s+/g, ' ').slice(0, 80)}}`);
      }
    }
  }

  assert.deepEqual(risky, [], 'suojaamaton käyttäjädata HTML-koosteessa:\n' + risky.join('\n'));
});

test('HTML-koosteiden tarkistus löytää myös omalla rivillään olevan kentän', () => {
  // Tarkistus itsessään on turvallisuuden kannalta merkityksellinen: jos
  // se lakkaa löytämästä, se ei kerro siitä mitään. Siksi se testataan.
  const source = 'node.innerHTML = `<div class="card">\n  ${task.title}\n</div>`;';
  const [template] = htmlTemplates(source);

  assert.ok(template, 'template-literaalia ei löytynyt lainkaan');
  assert.ok(template.includes('${task.title}'),
    'monirivisen koosteen interpolaatio jäi löytymättä');
});

test('HTML-koosteiden tarkistus lukee sisäkkäiset literaalit', () => {
  // Sisäkkäinen literaali on tavallisin tapa rakentaa ehdollinen osa.
  // Jos lukija katkaisisi ensimmäiseen kenoaaltosulkuun, sisältö jäisi
  // tarkistamatta juuri siellä missä ehdollisuutta on eniten.
  const source = 'x.innerHTML = `<p>${a ? `<b>${goal.title}</b>` : \'\'}</p>`;';
  const [template] = htmlTemplates(source);

  assert.ok(template.includes('goal.title'),
    'sisäkkäisen literaalin sisältö jäi lukematta');

  // Ja purku erottaa sisäkkäisen kentän omaksi lausekkeekseen, jotta
  // ymparoiva HTML ei peita sita eika toisin pain.
  assert.ok(interpolations(template).includes('goal.title'),
    'sisakkaista kenttaa ei eroteltu omaksi lausekkeekseen');
});

test('escapeHtml suojaa myös lainausmerkit', async () => {
  const { escapeHtml } = await import('../src/lib/format.js');
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a"b'), 'a&quot;b');
  assert.equal(escapeHtml("a'b"), 'a&#39;b');
  assert.equal(escapeHtml('a&b'), 'a&amp;b');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

// --------------------------------------------------- virheiden käsittely

test('TURVA: Supabasen virheviesti ei päädy käyttäjälle sellaisenaan', () => {
  for (const file of ['src/data/tasksRepo.js', 'src/data/profileRepo.js']) {
    const source = read(file);
    // Virheet kääritään aina fail()-funktioon, joka ottaa oman käyttäjäviestin.
    const failCalls = [...source.matchAll(/fail\(([^,)]+)/g)].map(m => m[1].trim());
    for (const argument of failCalls) {
      assert.ok(argument.startsWith("'"),
        `käyttäjäviestin pitää olla kiinteä merkkijono, oli: ${argument} (${file})`);
    }
    assert.equal(source.includes('error.message'), false,
      'Supabasen viestiä ei saa välittää käyttäjälle: ' + file);
  }
});

test('kirjoitusvirheet eivät jää pelkkään konsoliin', () => {
  const actions = read('src/app/actions.js');
  // Jokainen epäonnistunut kirjoitus näyttää virheen JA palauttaa tilan.
  assert.ok(actions.includes('showError('), 'virheet pitää näyttää käyttäjälle');
  const rollbackMarkers = (actions.match(/\/\/ peruutus/g) || []).length;
  assert.ok(rollbackMarkers >= 4, 'optimistiset päivitykset pitää peruuttaa, löytyi ' + rollbackMarkers);
});

test('poisto vaatii vahvistuksen', () => {
  const actions = read('src/app/actions.js');
  const deleteIndex = actions.indexOf('export async function deleteTask');
  const repoCallIndex = actions.indexOf('tasksRepo.deleteTask', deleteIndex);
  const confirmIndex = actions.indexOf('confirmDelete', deleteIndex);

  assert.ok(confirmIndex > -1, 'vahvistus puuttuu');
  assert.ok(confirmIndex < repoCallIndex, 'vahvistus pitää kysyä ennen poistoa');
});

// ------------------------------------------------ tuplaklikkauksen esto

test('async-toiminnot on suojattu tuplaklikkaukselta', () => {
  const guarded = ['src/app/views/tasks.js', 'src/app/views/profile.js',
                   'src/app/views/routines.js', 'src/app/views/goals.js',
                   'src/app/views/notificationSettings.js',
                   'src/app/voice.js', 'src/app/auth.js'];
  for (const file of guarded) {
    assert.ok(read(file).includes('singleFlight'),
      file + ' ei suojaa rinnakkaisia kutsuja');
  }
});

// ------------------------------------------------------- skeemaportti

test('SKEEMAPORTTI: laajennetut kentät eivät mene kantaan ennen migraatiota', async () => {
  const schema = await import('../src/data/schema.js');
  const { TASK_COLUMNS_CORE } = await import('../src/lib/rows.js');

  if (schema.TASK_EXTENDED_FIELDS === false) {
    assert.deepEqual(schema.taskColumns(), TASK_COLUMNS_CORE);
    assert.ok(schema.volatileFields().includes('priority'));
    assert.equal(schema.isPersisted('priority'), false);
    assert.equal(schema.isPersisted('title'), true);
  } else {
    // Migraatio on ajettu — silloin kaikkien kenttien pitää tallentua.
    assert.deepEqual(schema.volatileFields(), []);
  }
});

test('index.html ei paljasta salaisuuksia', () => {
  const html = readIndexHtml();
  assert.equal(/sk-ant-/.test(html), false);
  assert.equal(html.includes('service_role'), false);
  // Supabasen anon-avain on julkinen arvo, mutta se kuuluu konfiguraatioon.
  assert.equal(html.includes('createClient'), false);
});

test('palvelinmoduulit eivät vuoda ympäristömuuttujia vastaukseen', () => {
  for (const file of serverModules()) {
    const source = read(file);
    assert.equal(/res\.[a-z]+\([^)]*process\.env/.test(source), false,
      'ympäristömuuttuja vastauksessa: ' + file);
  }
});
