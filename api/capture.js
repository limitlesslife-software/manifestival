// Palvelinpuolen välityspalvelin universaalille kirjaukselle.
//
// TÄRKEIN TURVALLISUUSOMINAISUUS:
// Tämä koodi ajetaan Vercelin palvelimella, EI selaimessa. Siksi
// ANTHROPIC_API_KEY luetaan palvelimen ympäristömuuttujasta eikä se päädy
// koskaan puhelimelle, index.html:ään eikä selaimen verkkoliikenteeseen.
//
// ---------------------------------------------------------------
// TÄMÄ PÄÄTEPISTE EI KIRJOITA MITÄÄN
// ---------------------------------------------------------------
//
// Se palauttaa TULKINNAN: mikä kohde tämä luultavasti on ja kuinka
// varma siitä ollaan. Tulkinnasta tulee domain-rivi vasta kun käyttäjä
// hyväksyy sen selaimessa, ja hyväksyntä on domain-sääntö
// (src/domain/capture.js `routeOf`) — ei tämän päätepisteen asia.
//
// ---------------------------------------------------------------
// MITÄ TÄNNE EI LÄHETETÄ
// ---------------------------------------------------------------
//
// Käyttäjän tehtävälista, muistiinpanot, hyvinvointimerkinnät,
// taloustiedot ja sijainti EIVÄT tule tänne. Konteksti on kolme
// boolean-lippua ja päivämäärä.
//
// Ominaisuuslippu on tarpeen, jottei malli ehdota kohdetta, jota tässä
// asennuksessa ei ole — se olisi ehdotus, jota ei voi hyväksyä.
//
// Suojaukset — samat kuin /api/parse, /api/extract ja /api/plan:
//   1. vain POST
//   2. kirjautuminen vaaditaan (api/_auth.js)
//   3. käyttäjäkohtainen pyyntörajoitin (api/_ratelimit.js)
//   4. syöte- ja kokovalidointi (api/_validateCapture.js)
//   5. aikakatkaisu ylävirran kutsulle
//   6. vastauksesta palautetaan vain tarvittava osa
//   7. virheviestit ovat yleisiä eivätkä paljasta palvelimen tilaa

const { validateCaptureRequest } = require('./_validateCapture.js');
const { authenticate } = require('./_auth.js');
const { checkRateLimit } = require('./_ratelimit.js');
const { applyCors } = require('./_cors.js');

/**
 * Aikakatkaisu. Lyhyempi kuin suunnittelussa: luokittelu on yksi olio,
 * ei rakenne, ja kirjaus on ele jonka pitää tuntua nopealta.
 */
const UPSTREAM_TIMEOUT_MS = 15000;

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Kirjaus on yleisin tekoälytoiminto sovelluksessa, joten raja on
 * väljin. Oma avain rajoittimessa: kirjaus ei saa kuluttaa
 * suunnittelun eikä kuvanluennan kiintiötä eikä päinvastoin.
 */
const RATE_LIMIT = 30;

// Sallitut arvot. Nämä vastaavat domainin avaimia, ja yhdenmukaisuus on
// lukittu testillä — prompt elää palvelimella ja enum selaimessa, joten
// ajautuminen olisi hiljainen.
const CAPTURE_KINDS = [
  'task', 'reminder', 'goal', 'project', 'routine',
  'transaction', 'bill', 'savings', 'travel', 'note', 'ambiguous'
];
const CATEGORY_KEYS = ['tyo', 'perhe', 'hyvinvointi', 'harrastus', 'koti',
  'kehitys', 'talous', 'muu'];
const PRIORITY_KEYS = ['korkea', 'normaali', 'matala'];
const EXPENSE_CATEGORY_KEYS = ['asuminen', 'ruoka', 'liikkuminen', 'auto',
  'terveys', 'vakuutukset', 'laskut', 'harrastukset', 'viihde', 'lapset',
  'ostokset', 'tyo', 'saastaminen', 'sijoittaminen', 'muu'];

/**
 * Kehote.
 *
 * NELJÄ SÄÄNTÖÄ, JOITA EI USKOTA VAAN PAKOTETAAN:
 *
 *   1. Ei tunnisteita, ei SQL:ää, ei HTML:ää.
 *   2. Epävarma tulkinta on "note" tai "ambiguous", EI arvaus.
 *   3. Summat kokonaislukuina sentteinä.
 *   4. Vain sallitut kohteet.
 *
 * Kehote pyytää nämä; `src/ai/captureSchema.js` pakottaa ne. Kehote on
 * kohteliaisuus, validointi on sopimus.
 */
function buildPrompt({ text, today, weekday, context }) {
  const kaytossa = [];
  if (!context.financeEnabled) kaytossa.push('talousominaisuudet EIVÄT ole käytössä');
  if (!context.goalsEnabled) kaytossa.push('tavoiteominaisuudet EIVÄT ole käytössä');
  if (!context.travelEnabled) {
    kaytossa.push('matka-arviota EI ole käytettävissä, joten älä ehdota kohdetta "travel"');
  }

  return `Tämän hetken päivämäärä on ${today}${weekday ? ` (${weekday})` : ''}.

Käyttäjä kirjoitti suomeksi elämänhallintasovellukseen: ${JSON.stringify(text)}

Päättele MIHIN tämä kuuluu.
${kaytossa.length > 0 ? '\nHuomioi: ' + kaytossa.join('; ') + '.\n' : ''}
SALLITUT KOHTEET:
- "task"        tehtävä, joka pitää tehdä
- "reminder"    asia, joka pitää muistaa tiettyyn aikaan
- "goal"        pidemmän aikavälin tavoite
- "project"     laajempi kokonaisuus, jossa on useita tehtäviä
- "routine"     toistuva tekeminen
- "transaction" toteutunut meno tai tulo
- "bill"        lasku, jolla on eräpäivä
- "savings"     säästötavoite
- "travel"      pitää olla jossain tiettyyn aikaan
- "note"        muistiinpano, joka ei ole mikään yllä olevista
- "ambiguous"   et osaa päätellä

SÄÄNNÖT:
- ÄLÄ ARVAA. Jos et ole varma, käytä kohdetta "note" tai "ambiguous" ja aseta confidence "low".
- ÄLÄ anna tunnistetta ("id"), SQL:ää, HTML:ää tai koodia.
- ÄLÄ merkitse mitään tehdyksi.
- Summat KOKONAISLUKUINA SENTTEINÄ. 120 euroa on 12000.
- Suunta tulee kentästä "transactionKind" ("expense" tai "income"), EI etumerkistä. Summa on aina positiivinen.
- Päivämäärät muodossa YYYY-MM-DD, kellonajat HH:MM.
- Suhteelliset ajat ("huomenna", "ensi viikolla") lasketaan yllä olevasta päivämäärästä.
- Jos et tiedä päivää, jätä se null. ÄLÄ KEKSI päivämäärää.
- Kirjaa "assumptions"-listaan jokainen oletus, jonka teit ilman että käyttäjä sanoi sitä.
- Jos jokin olennainen puuttuu, kirjoita se kenttään "question".
- Kategoria: yksi näistä: ${CATEGORY_KEYS.join(', ')}.
- Prioriteetti: yksi näistä: ${PRIORITY_KEYS.join(', ')}.
- Kululuokka ("financeCategory"): yksi näistä: ${EXPENSE_CATEGORY_KEYS.join(', ')}.

Vastaa VAIN JSON-objektilla, ei muuta tekstiä eikä koodilohkomerkintöjä:
{"kind":"yksi: ${CAPTURE_KINDS.join(', ')}","confidence":"high|medium|low","title":"lyhyt selkeä nimi","date":"YYYY-MM-DD tai null","time":"HH:MM tai null","endTime":"HH:MM tai null","durationMinutes":"kesto minuutteina tai null","category":"yksi sallituista tai null","priority":"yksi sallituista tai null","reminderLeadMinutes":"muistutuksen etuaika minuutteina tai null","amountMinor":"summa sentteinä kokonaislukuna tai null","transactionKind":"expense|income tai null","financeCategory":"yksi sallituista tai null","metric":"mitä mitataan tai null","unit":"yksikkö tai null","baselineValue":"lähtöarvo numerona tai null","targetValue":"tavoitearvo numerona tai null","recurrenceType":"daily|weekly tai null","weekdays":[1],"destination":"paikan nimi tai null","arrivalTime":"HH:MM tai null","arrivalDate":"YYYY-MM-DD tai null","assumptions":["oletus"],"question":"kysymys tai null"}`;
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

  // 2. Todennus. Anonyymi kutsuja ei saa kuluttaa Anthropic-kiintiötä.
  const auth = await authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  // 3. Pyyntörajoitin omalla avaimellaan ja omalla rajallaan.
  const rate = checkRateLimit(`capture:${auth.userId || 'anonymous'}`,
    { limit: RATE_LIMIT });
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({ error: 'Liian monta pyyntöä. Odota hetki.' });
    return;
  }

  // 4. Syötevalidointi
  const validation = validateCaptureRequest(req.body);
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  // 5. Palvelimen konfiguraation tarkistus.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('capture: ANTHROPIC_API_KEY puuttuu palvelimen ymparistosta');
    res.status(500).json({ error: 'Palvelu ei ole juuri nyt kaytettavissa' });
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
        max_tokens: 800,
        messages: [{ role: 'user', content: buildPrompt(validation.value) }]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      // Lokitetaan vain tilakoodi. Anthropicin virhevastaus voi sisältää
      // osan syötteestä, ja syöte on tässä käyttäjän oma muistiinpano.
      console.error('capture: Anthropic vastasi', response.status);
      res.status(502).json({ error: 'Tulkinta epaonnistui' });
      return;
    }

    const data = await response.json();

    // 7. Palautetaan VAIN se osa vastauksesta, jota client tarvitsee.
    res.status(200).json({ content: Array.isArray(data.content) ? data.content : [] });
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    // VIRHEVIESTIÄ EI LOKITETA SELLAISENAAN: fetchin virhe voi sisältää
    // pyyntörungon, ja pyyntörunko sisältää käyttäjän muistiinpanon.
    console.error('capture: kutsu epaonnistui', isTimeout ? 'timeout' : 'virhe');
    res.status(isTimeout ? 504 : 500).json({
      error: isTimeout ? 'Tulkinta kesti liian kauan' : 'Tulkinta epaonnistui'
    });
  } finally {
    clearTimeout(timer);
  }
};

// Vientejä testejä varten. Vercel käyttää vain yllä olevaa funktiota.
module.exports.buildPrompt = buildPrompt;
module.exports.CAPTURE_KINDS = CAPTURE_KINDS;
module.exports.CATEGORY_KEYS = CATEGORY_KEYS;
module.exports.PRIORITY_KEYS = PRIORITY_KEYS;
module.exports.EXPENSE_CATEGORY_KEYS = EXPENSE_CATEGORY_KEYS;
module.exports.RATE_LIMIT = RATE_LIMIT;
