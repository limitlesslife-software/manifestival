// Palvelinpuolen välityspalvelin tavoitteen suunnitteluun.
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
// Se palauttaa EHDOTUKSEN. Ehdotuksesta tulee tallennettavaa työtä vasta
// kun käyttäjä hyväksyy sen selaimessa, ja hyväksyntä on domain-sääntö
// (src/domain/plan.js `toCommittable`) — ei tämän päätepisteen asia.
//
// ---------------------------------------------------------------
// MITÄ TÄNNE EI LÄHETETÄ
// ---------------------------------------------------------------
//
// Käyttäjän tehtävälista, muistiinpanot, hyvinvointimerkinnät ja
// taloustiedot EIVÄT tule tänne. Konteksti on lukuja: montako
// aktiivista tavoitetta on, paljonko vapaata aikaa viikossa on, kuinka
// monen päivän päässä lähin määräpäivä on.
//
// Numero ei voi sisältää ohjetta, eikä siitä voi lukea mitä käyttäjä
// tekee tai ajattelee.
//
// Suojaukset — samat kuin /api/parse ja /api/extract:
//   1. vain POST
//   2. kirjautuminen vaaditaan (api/_auth.js)
//   3. käyttäjäkohtainen pyyntörajoitin (api/_ratelimit.js)
//   4. syöte- ja kokovalidointi (api/_validatePlan.js)
//   5. aikakatkaisu ylävirran kutsulle
//   6. vastauksesta palautetaan vain tarvittava osa
//   7. virheviestit ovat yleisiä eivätkä paljasta palvelimen tilaa

const { validatePlanRequest } = require('./_validatePlan.js');
const { authenticate } = require('./_auth.js');
const { checkRateLimit } = require('./_ratelimit.js');

/**
 * Aikakatkaisu. Suunnittelu on pisin kolmesta tehtävästä: se tuottaa
 * rakenteen eikä yhtä oliota.
 */
const UPSTREAM_TIMEOUT_MS = 45000;

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Suunnittelu on kallista ja harvinaista. Oma tiukka rajansa, ja oma
 * avaimensa rajoittimessa — suunnittelu ei saa kuluttaa puhekomentojen
 * eikä kuvanluennan kiintiötä eikä päinvastoin.
 */
const RATE_LIMIT = 8;

// Sallitut arvot. Nämä vastaavat src/domain/categories.js- ja
// src/domain/priority.js-moduulien avaimia. Yhdenmukaisuus on lukittu
// testillä, koska prompt elää palvelimella ja enum selaimessa.
const CATEGORY_KEYS = ['tyo', 'perhe', 'hyvinvointi', 'harrastus', 'koti', 'kehitys',
  'talous', 'muu'];
const PRIORITY_KEYS = ['korkea', 'normaali', 'matala'];

/**
 * Kehote.
 *
 * NELJÄ SÄÄNTÖÄ, JOTKA OVAT KEHOTTEESSA MUTTA JOITA EI USKOTA:
 *
 *   1. Ei tunnisteita. `ref` on paikallinen avain.
 *   2. Ei kellonaikoja. Aika tulee aikatauluttajalta.
 *   3. Ei tiloja. Ehdotettu on aina avoin ja kesken.
 *   4. Määrä suhteessa vaikeuteen. Yksinkertainen tavoite ei tarvitse
 *      kahtatoista tehtävää.
 *
 * Kehote pyytää nämä, mutta `src/ai/planSchema.js` PAKOTTAA ne. Jos
 * malli palauttaa tunnisteen tai kellonajan, se pudotetaan siellä.
 * Kehote on kohteliaisuus; validointi on sopimus.
 */
function buildPrompt({ goalText, today, mode, context }) {
  const tilanne = [];
  if (context.activeGoalCount !== null) {
    tilanne.push(`Käyttäjällä on ${context.activeGoalCount} aktiivista tavoitetta.`);
  }
  if (context.weeklyFreeHours !== null) {
    tilanne.push(`Vapaata suunniteltavaa aikaa on noin ${context.weeklyFreeHours} h viikossa.`);
  }
  if (context.nearestDeadlineDays !== null) {
    tilanne.push(`Lähin määräpäivä on ${context.nearestDeadlineDays} päivän päässä.`);
  }
  // SUUNNAN RAJAT. Käyttäjän omat, deterministisesti lasketut. Malli
  // suunnittelee niiden sisällä eikä voi muuttaa niitä.
  const rajat = [];
  if (context.remainingWeeklyHours !== null && context.remainingWeeklyHours !== undefined) {
    rajat.push(`Tämän viikon kapasiteettia on jäljellä noin ${context.remainingWeeklyHours} h.`);
  }
  if (context.protectedHours) {
    rajat.push(`Käyttäjälle tärkeille elämänalueille (${context.neglectedImportantAreaCount || 0} kpl) on varattava `
      + `noin ${context.protectedHours} h viikossa; älä suunnittele tätä aikaa muuhun.`);
  }
  if (context.heavyRemainingHours !== null && context.heavyRemainingHours !== undefined) {
    rajat.push(`Kuormittavaa tekemistä mahtuu viikkoon enää noin ${context.heavyRemainingHours} h.`);
  }
  if (context.unestimatedCount) {
    rajat.push(`Viikolla on jo ${context.unestimatedCount} arvioimatonta asiaa, joten jätä väljyyttä.`);
  }
  if (rajat.length > 0) tilanne.push('RAJAT: ' + rajat.join(' ') + ' Et voi muuttaa käyttäjän tärkeyksiä, tavoitteita etkä kapasiteettia.');

  return `Tämän hetken päivämäärä on ${today}.

Käyttäjä kuvaili tavoitteen suomeksi: ${JSON.stringify(goalText)}

${tilanne.length > 0 ? 'Tilanne: ' + tilanne.join(' ') + '\n' : ''}
Tee tästä toteutuskelpoinen suunnitelma.

SÄÄNNÖT:
- ÄLÄ anna yhdellekään kohteelle tunnistetta ("id"). Käytä paikallista avainta "ref", esim. "m1", "p1", "t1".
- ÄLÄ anna kellonaikoja. Aikataulutus tehdään erikseen. Anna vain päivämääriä.
- ÄLÄ merkitse mitään tehdyksi tai saavutetuksi.
- Anna tehtäville kestoarvio minuutteina ("durationMinutes"). Jos et osaa arvioida, jätä pois.
- MÄÄRÄ SUHTEESSA VAIKEUTEEN. Yksinkertainen tavoite ei tarvitse kahtatoista tehtävää. Älä pilko liikaa.
- Jos jokin olennainen tieto puuttuu, kirjaa se "questions"-listaan. ÄLÄ KEKSI määräpäivää tai tavoitearvoa, jota käyttäjä ei antanut.
- Kirjaa "assumptions"-listaan jokainen oletus, jonka teit ilman että käyttäjä sanoi sitä.
- Ehdota rutiini vain jos toistuva tekeminen on tavoitteen kannalta olennaista.
- Jos tavoite on mitattava (paino, säästöt, kilometrit), täytä "metric", "unit", "baselineValue" ja "targetValue". Jätä "baselineValue" pois jos käyttäjä ei kertonut lähtöarvoa.
- Kategoria: yksi näistä: ${CATEGORY_KEYS.join(', ')}.
- Prioriteetti: yksi näistä: ${PRIORITY_KEYS.join(', ')}.
- Päivämäärät muodossa YYYY-MM-DD.
${mode === 'replan' ? '- Tämä on olemassa olevan tavoitteen uudelleensuunnittelu. Ehdota vain muutokset, älä koko suunnitelmaa alusta.\n' : ''}
Vastaa VAIN JSON-objektilla, ei muuta tekstiä eikä koodilohkomerkintöjä:
{"goal":{"title":"lyhyt selkeä nimi","description":"tarkennus tai null","targetDate":"YYYY-MM-DD tai null","category":"yksi sallituista","priority":"yksi sallituista","metric":"mitä mitataan tai null","unit":"yksikkö tai null","baselineValue":"lähtöarvo numerona tai null","targetValue":"tavoitearvo numerona tai null","confidence":"high|medium|low"},"milestones":[{"ref":"m1","title":"...","description":"tai null","targetDate":"YYYY-MM-DD tai null"}],"projects":[{"ref":"p1","name":"...","description":"tai null","milestoneRef":"m1 tai null","deadline":"YYYY-MM-DD tai null","priority":"...","category":"..."}],"tasks":[{"ref":"t1","title":"...","description":"tai null","projectRef":"p1 tai null","milestoneRef":"m1 tai null","date":"YYYY-MM-DD tai null","durationMinutes":60,"priority":"...","category":"...","dependsOnRefs":["t0"]}],"routines":[{"ref":"r1","title":"...","recurrenceType":"daily|weekly","weekdays":[1],"durationMinutes":30,"priority":"...","category":"..."}],"assumptions":["oletus"],"questions":["kysymys"]}`;
}

module.exports = async (req, res) => {
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
  const rate = checkRateLimit(`plan:${auth.userId || 'anonymous'}`, { limit: RATE_LIMIT });
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({ error: 'Liian monta pyyntöä. Odota hetki.' });
    return;
  }

  // 4. Syötevalidointi
  const validation = validatePlanRequest(req.body);
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  // 5. Palvelimen konfiguraation tarkistus.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('plan: ANTHROPIC_API_KEY puuttuu palvelimen ymparistosta');
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
        max_tokens: 4000,
        messages: [{ role: 'user', content: buildPrompt(validation.value) }]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      // Lokitetaan vain tilakoodi. Anthropicin virhevastaus voi sisältää
      // osan syötteestä, ja syöte on tässä käyttäjän oma tavoite.
      console.error('plan: Anthropic vastasi', response.status);
      res.status(502).json({ error: 'Suunnittelu epaonnistui' });
      return;
    }

    const data = await response.json();

    // 7. Palautetaan VAIN se osa vastauksesta, jota client tarvitsee.
    res.status(200).json({ content: Array.isArray(data.content) ? data.content : [] });
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    // VIRHEVIESTIÄ EI LOKITETA SELLAISENAAN: fetchin virhe voi sisältää
    // pyyntörungon, ja pyyntörunko sisältää käyttäjän tavoitteen.
    console.error('plan: kutsu epaonnistui', isTimeout ? 'timeout' : 'virhe');
    res.status(isTimeout ? 504 : 500).json({
      error: isTimeout ? 'Suunnittelu kesti liian kauan' : 'Suunnittelu epaonnistui'
    });
  } finally {
    clearTimeout(timer);
  }
};

// Vientejä testejä varten. Vercel käyttää vain yllä olevaa funktiota.
module.exports.buildPrompt = buildPrompt;
module.exports.CATEGORY_KEYS = CATEGORY_KEYS;
module.exports.PRIORITY_KEYS = PRIORITY_KEYS;
module.exports.RATE_LIMIT = RATE_LIMIT;
