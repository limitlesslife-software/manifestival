// Palvelinpuolen valityspalvelin AI-komentojen luokitteluun.
//
// TARKEIN TURVALLISUUSOMINAISUUS:
// Tama koodi ajetaan Vercelin palvelimella, EI selaimessa. Siksi
// ANTHROPIC_API_KEY luetaan palvelimen ymparistomuuttujasta eika se paady
// koskaan puhelimelle, index.html:aan eika selaimen verkkoliikenteeseen.
//
// ---------------------------------------------------------------
// TAMA PAATEPISTE EI SUORITA MITAAN
// ---------------------------------------------------------------
//
// Se palauttaa RAAKAEHDOTUKSEN yhdesta lauseesta. Ehdotus muuttuu
// turvalliseksi sovelluskomennoksi vasta src/ai/intentSchema.js:n
// resolveCommand()-funktiossa (tiukka allowlist, kentta kerrallaan
// validointi, ei olioita eika prototyyppeja), sen jalkeen kohde
// tunnistetaan src/ai/entityResolver.js:lla KAYTTAJAN OMASTA already
// ladatusta tilasta, ja lopuksi kayttaja vahvistaa esikatselun ennen
// kuin mitaan tallennetaan (src/app/aiCommands.js). Tama paatepiste ei
// tunne yhtakaan naista vaiheista eika koske tietokantaan millaan
// tavalla.
//
// ---------------------------------------------------------------
// MITA TANNE EI LAHETETA
// ---------------------------------------------------------------
//
// Kayttajan tehtavalista, tavoitteet, laskut, hyvinvointimerkinnat ja
// sijainti EIVAT tule tanne. Konteksti on kolme merkkijonoa: lause,
// paivamaara ja viikonpaiva. Kohteen tunnistus ei tarvitse mallilta
// tunnisteita eika listoja -- "targetName" riittaa, ja loppu tapahtuu
// selaimessa.
//
// Suojaukset -- samat kuin /api/parse, /api/extract, /api/plan ja
// /api/capture:
//   1. vain POST
//   2. kirjautuminen vaaditaan (api/_auth.js)
//   3. kayttajakohtainen pyyntorajoitin (api/_ratelimit.js), oma avain
//   4. syote- ja kokovalidointi (api/_validateCommand.js)
//   5. aikakatkaisu ylavirran kutsulle
//   6. vastauksesta palautetaan vain tarvittava osa
//   7. virheviestit ovat yleisia eivatka paljasta palvelimen tilaa

const { validateCommandRequest } = require('./_validateCommand.js');
const { authenticate } = require('./_auth.js');
const { checkRateLimit } = require('./_ratelimit.js');
const { applyCors } = require('./_cors.js');

/** Aikakatkaisu. Luokittelu on yksi olio, ei rakenne. */
const UPSTREAM_TIMEOUT_MS = 15000;

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Komennot ovat yleisia mutta lyhyita. Oma avain rajoittimessa: komennot
 * eivat saa kuluttaa kirjauksen, suunnittelun eivatka kuvanluennan
 * kiintiota eika painvastoin.
 */
const RATE_LIMIT = 30;

/**
 * Sallitut intentit. TAMA LISTA ON KOHTELIAISUUS MALLILLE, EI
 * TURVAMALLI. Todellinen allowlist elaa src/ai/intentSchema.js:ssa
 * (INTENT/COMMANDS) ja ajetaan aina selaimessa riippumatta siita, mita
 * malli palauttaa tai kuinka tarkasti tama kehote sita kuvaa.
 * Yhdenmukaisuus on lukittu testilla (tests/api-command-validation.test.mjs),
 * koska kehote elaa palvelimella ja allowlist selaimessa -- ajautuminen
 * olisi muuten hiljainen.
 */
const ALLOWED_INTENTS = [
  'create_task', 'update_task', 'delete_task', 'complete_task', 'uncomplete_task',
  'schedule_task', 'reschedule_task',
  'create_routine', 'update_routine', 'delete_routine',
  'create_goal', 'update_goal', 'delete_goal',
  'create_project', 'update_project', 'delete_project',
  'create_bill', 'update_bill', 'mark_bill_paid',
  'set_notification_preference',
  'show_day_plan', 'show_week_plan'
];

/**
 * Esimerkkipäivä kehotteen esimerkeille: maanantai 2026-03-02.
 *
 * Esimerkit ovat KIINTEITÄ ja niiden päivämäärät on laskettu tätä päivää
 * vasten. tests/ai-command-prompt.test.mjs ajaa jokaisen esimerkin
 * tuotoksen oikean skeeman (resolveCommand) ja suomen ajanlausekkeiden
 * jäsentimen (src/domain/fiTemporal.js) läpi, joten kehote ei voi
 * ajautua sovelluksen todellisesta sopimuksesta.
 */
const EXAMPLE_TODAY = '2026-03-02';

const PROMPT_EXAMPLES = [
  { input: 'Lisää tehtävä pestä auto huomenna', output: { intent: 'create_task', title: 'Pese auto', date: '2026-03-03' } },
  { input: 'Muistuta minua huomenna kello 8 soittamaan Matille', output: { intent: 'create_task', title: 'Soita Matille', date: '2026-03-03', time: '08:00' } },
  { input: 'Muistuta perjantaina puoli yhdeksältä hakemaan paketti', output: { intent: 'create_task', title: 'Hae paketti', date: '2026-03-06', time: '08:30' } },
  { input: 'Siirrä auton pesu huomiselta sunnuntaille', output: { intent: 'reschedule_task', targetName: 'Auton pesu', date: '2026-03-08' } },
  { input: 'Siirrä palaveri kahdella tunnilla eteenpäin', output: { intent: 'reschedule_task', targetName: 'Palaveri', shiftMinutes: 120 } },
  { input: 'Merkitse auton pesu tehdyksi', output: { intent: 'complete_task', targetName: 'Auton pesu' } },
  { input: 'Poista muistutus lääkäri', output: { intent: 'delete_task', targetName: 'Lääkäri' } },
  { input: 'Merkitse sähkölasku maksetuksi', output: { intent: 'mark_bill_paid', targetName: 'Sähkölasku' } },
  { input: 'Lisää projekti autotallin remontti, määräaika kuun lopussa', output: { intent: 'create_project', name: 'Autotallin remontti', deadline: '2026-03-31' } },
  { input: 'Näytä ensi viikko', output: { intent: 'show_week_plan', date: '2026-03-09' } },
  { input: 'Etsi kaikki rengastilaukseen liittyvät tehtävät', output: { intent: 'unknown' } },
  { input: 'Mikä sää huomenna on?', output: { intent: 'unknown' } }
];

function buildPrompt({ text, today, weekday }) {
  const examples = PROMPT_EXAMPLES
    .map(example => JSON.stringify(example.input) + ' -> ' + JSON.stringify(example.output))
    .join('\n');

  return [
    'Tämän hetken päivämäärä on ' + today + (weekday ? ' (' + weekday + ')' : '') + '.',
    '',
    'Käyttäjä kirjoitti tai sanoi tämän suomenkielisen KOMENNON elämänhallintasovellukseen: ' + JSON.stringify(text),
    '',
    'Tulkitse, mitä käyttäjä haluaa tehdä. Valitse TÄSMÄLLEEN yksi näistä intent-arvoista:',
    ALLOWED_INTENTS.join(', '),
    '',
    'LUONTI vs. MUOKKAUS (tärkein ero):',
    '- Jos käyttäjä haluaa LISÄTÄ, LUODA tai saada MUISTUTUKSEN uudesta asiasta ("lisää tehtävä ...", "muistuta minua ...", "luo rutiini ...", "uusi projekti ...", "lisää lasku ..."), valitse create_*-intent. Muistutus ja tehtävä ovat molemmat create_task.',
    '- Jos käyttäjä viittaa OLEMASSA OLEVAAN asiaan ja haluaa muuttaa, siirtää, merkitä tehdyksi tai maksetuksi, palauttaa keskeneräiseksi tai poistaa sen, valitse update_*, reschedule_task, complete_task, uncomplete_task, mark_bill_paid tai delete_* ja kerro kohde kentässä "targetName".',
    '- Vastaa "unknown" VAIN kun lause ei ole mikään näistä: kysymys, keskustelu, haku ("etsi ...") tai jotain jota sovellus ei osaa. ÄLÄ vastaa "unknown" pelkästään siksi, että lause on uuden asian luomista.',
    '',
    'SÄÄNNÖT:',
    '- ÄLÄ keksi tunnistetta (id). Kohde tunnistetaan nimen perusteella selaimessa: käytä "targetName" (tai "targetTitle") sille, mihin komento kohdistuu.',
    '- Jos käyttäjä antaa kohteelle UUDEN nimen, käytä "newTitle" (tai "newName") -- ÄLÄ ylikirjoita "targetName"-kenttää sillä.',
    '- Anna VAIN ne kentät, jotka käyttäjä oikeasti mainitsi. Älä täytä kenttiä, joita ei mainittu.',
    '- Suhteellinen ajansiirto ("kahdella tunnilla eteenpäin/taaksepäin") menee kenttään "shiftMinutes" (negatiivinen = taaksepäin).',
    '- Rahasumma menee kenttään "amount" euroina (esim. 49.90), ei sentteinä.',
    '- Päivämäärät muodossa YYYY-MM-DD, kellonajat muodossa HH:MM.',
    '- Kategoria (jos mainittu): yksi näistä: tyo, perhe, hyvinvointi, harrastus, koti, kehitys, talous, muu.',
    '- Prioriteetti (jos mainittu): yksi näistä: korkea, normaali, matala.',
    '',
    'PÄIVÄT JA KELLONAJAT SUOMEKSI:',
    '- "tänään" = tämän päivän päivämäärä; "huomenna" = seuraava päivä; "ylihuomenna" = kaksi päivää eteenpäin.',
    '- Viikonpäivä ("perjantaina", "maanantaiksi", "sunnuntaille") = seuraava kyseinen päivä TÄMÄN PÄIVÄN JÄLKEEN. "Ensi maanantaina" = seuraava maanantai.',
    '- "Kuun lopussa" = kuukauden viimeinen päivä. "Ensi viikolla" ilman päivää: älä keksi päivää (näyttökomennossa käytä ensi viikon maanantaita).',
    '- "klo 8" = 08:00. "Puoli yhdeksältä" = 08:30 (suomessa "puoli yhdeksän" on kahdeksan ja puoli). "Varttia vaille yhdeksän" = 08:45. "Varttia yli kahdeksan" = 08:15.',
    '- Jos kellonaikaa ei sanota ("aamulla", "illalla"), ÄLÄ keksi sitä: jätä "time" pois.',
    '',
    'ESIMERKKEJÄ (esimerkeissä tänään on ' + EXAMPLE_TODAY + ', maanantai):',
    examples,
    '',
    'Vastaa VAIN JSON-objektilla, ei muuta tekstiä eikä koodilohkomerkintöjä. Sisällytä vain oleelliset kentät:',
    '{"intent":"<yksi sallituista tai \\"unknown\\">","targetName":"tai null","newTitle":"tai null","title":"tai null","name":"tai null","date":"tai null","time":"tai null","endTime":"tai null","deadline":"tai null","dueDate":"tai null","targetDate":"tai null","durationMinutes":"tai null","shiftMinutes":"tai null","amount":"tai null","category":"tai null","priority":"tai null","note":"tai null","recurrence":"tai null","weekdays":"tai null","active":"tai null","status":"tai null","enabled":"tai null"}'
  ].join('\n');
}

module.exports = async (req, res) => {
  // 0. CORS: natiivikuoren esikysely ennen metoditarkistusta (api/_cors.js).
  if (applyCors(req, res)) return;

  // 1. Metodivalidointi
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 2. Todennus. Anonyymi kutsuja ei saa kuluttaa Anthropic-kiintiota.
  const auth = await authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  // 3. Pyyntorajoitin omalla avaimellaan ja omalla rajallaan.
  const rate = checkRateLimit(`command:${auth.userId || 'anonymous'}`, { limit: RATE_LIMIT });
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({ error: 'Liian monta pyyntöä. Odota hetki.' });
    return;
  }

  // 4. Syotevalidointi (kokorajat, tyypit, sallitut arvot)
  const validation = validateCommandRequest(req.body);
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  // 5. Palvelimen konfiguraation tarkistus.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('command: ANTHROPIC_API_KEY puuttuu palvelimen ymparistosta');
    res.status(500).json({ error: 'Palvelu ei ole juuri nyt käytettävissä' });
    return;
  }

  // 6. Kutsu Anthropicille aikakatkaisulla
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: buildPrompt(validation.value) }]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      // Lokitetaan vain tilakoodi. Anthropicin virhevastaus voi sisaltaa
      // osan syotteesta, ja syote on tassa kayttajan oma komento.
      console.error('command: Anthropic vastasi', response.status);
      res.status(502).json({ error: 'Komennon tulkinta epäonnistui' });
      return;
    }

    const data = await response.json();

    // 7. Palautetaan VAIN se osa vastauksesta, jota client tarvitsee.
    //    Ei kayttotilastoja, ei pyyntotunnisteita, ei mallin metatietoja.
    res.status(200).json({ content: Array.isArray(data.content) ? data.content : [] });
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    console.error('command: kutsu epaonnistui', isTimeout ? 'timeout' : String(e && e.message));
    res.status(isTimeout ? 504 : 500).json({
      error: isTimeout ? 'Komennon tulkinta kesti liian kauan' : 'Komennon tulkinta epäonnistui'
    });
  } finally {
    clearTimeout(timer);
  }
};

// Vientejä testejä varten. Vercel käyttää vain yllä olevaa funktiota.
module.exports.buildPrompt = buildPrompt;
module.exports.ALLOWED_INTENTS = ALLOWED_INTENTS;
module.exports.PROMPT_EXAMPLES = PROMPT_EXAMPLES;
module.exports.EXAMPLE_TODAY = EXAMPLE_TODAY;
module.exports.RATE_LIMIT = RATE_LIMIT;
