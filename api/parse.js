// Palvelinpuolen välityspalvelin (proxy) Anthropicin Messages API:lle.
//
// TÄRKEIN TURVALLISUUSOMINAISUUS:
// Tämä koodi ajetaan Vercelin palvelimella, EI selaimessa. Siksi
// ANTHROPIC_API_KEY luetaan palvelimen ympäristömuuttujasta eikä se päädy
// koskaan puhelimelle, index.html:ään eikä selaimen verkkoliikenteeseen.
//
// Selain kutsuu vain: POST /api/parse { transcript, today, weekday }
// eikä koskaan näe API-avainta.
//
// Suojaukset (WP1 + WP2):
//   1. vain POST
//   2. kirjautuminen vaaditaan (api/_auth.js) — estää kiintiön kulutuksen
//   3. käyttäjäkohtainen pyyntörajoitin (api/_ratelimit.js)
//   4. syöte- ja kokovalidointi (api/_validate.js)
//   5. aikakatkaisu ylävirran kutsulle
//   6. vastauksesta palautetaan vain tarvittava osa
//   7. virheviestit ovat yleisiä eivätkä paljasta palvelimen tilaa

const { validateParseRequest } = require('./_validate.js');
const { authenticate } = require('./_auth.js');
const { checkRateLimit } = require('./_ratelimit.js');
const { applyCors } = require('./_cors.js');

/** Anthropic-kutsun aikakatkaisu. Ilman tätä pyyntö voi jäädä roikkumaan. */
const UPSTREAM_TIMEOUT_MS = 15000;

const MODEL = 'claude-haiku-4-5-20251001';

// Sallitut arvot. Nämä vastaavat src/domain/categories.js- ja
// src/domain/priority.js-moduulien avaimia. Yhdenmukaisuus on lukittu
// testillä (tests/ai-proposal.test.mjs), koska prompt elää palvelimella ja
// enum selaimessa — ajautuminen olisi muuten hiljainen.
const CATEGORY_KEYS = ['tyo', 'perhe', 'hyvinvointi', 'harrastus', 'koti', 'kehitys', 'talous', 'muu'];
const PRIORITY_KEYS = ['korkea', 'normaali', 'matala'];

function buildPrompt({ transcript, today, weekday }) {
  return `Tämän hetken päivämäärä on ${today} (${weekday}).

Käyttäjä sanoi ääneen tämän suomenkielisen komennon elämänhallintasovellukseen: ${JSON.stringify(transcript)}

Tulkitse tämä tehtäväksi tai kalenterimerkinnäksi. Jos käyttäjä mainitsee sekä alku- että loppuajan (esim. "kello 7.30–15.30" tai "seitsemästä puoli neljään"), täytä molemmat. Jos käyttäjä kertoo keston ("puoli tuntia", "kaksi tuntia"), täytä durationMinutes. Jos käyttäjä ilmaisee kiireellisyyttä ("tärkeä", "ehdottomasti", "kiireellinen"), aseta priority. Vastaa VAIN JSON-objektilla, ei muuta tekstiä eikä koodilohkomerkintöjä:
{"title":"lyhyt selkeä nimi, max n. 6 sanaa","date":"YYYY-MM-DD paras arvaus, tämä päivä jos ei mainintaa","time":"HH:MM 24h muodossa tai null","endTime":"HH:MM 24h muodossa jos loppuaika mainittu, muuten null","durationMinutes":"kesto minuutteina numerona tai null","category":"yksi: ${CATEGORY_KEYS.join(', ')}","priority":"yksi: ${PRIORITY_KEYS.join(', ')}","note":"lyhyt lisähuomio tai null"}`;
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

  // 3. Pyyntörajoitin käyttäjäkohtaisesti.
  const rate = checkRateLimit(auth.userId || 'anonymous');
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({ error: 'Liian monta pyyntöä. Odota hetki.' });
    return;
  }

  // 4. Syötevalidointi (kokorajat, tyypit, sallitut arvot)
  const validation = validateParseRequest(req.body);
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  // 5. Palvelimen konfiguraation tarkistus.
  //    Huom: virheviesti ei paljasta, mikä muuttuja puuttuu.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('parse: ANTHROPIC_API_KEY puuttuu palvelimen ymparistosta');
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
      // Anthropicin virhevastaus voi sisältää yksityiskohtia, joita ei
      // haluta välittää clientille. Lokitetaan palvelimelle, palautetaan geneerinen.
      let upstream = '';
      try { upstream = JSON.stringify(await response.json()); } catch { /* ohita */ }
      console.error('parse: Anthropic vastasi', response.status, upstream.slice(0, 500));
      res.status(502).json({ error: 'Tulkinta epäonnistui' });
      return;
    }

    const data = await response.json();

    // 7. Palautetaan VAIN se osa vastauksesta, jota client tarvitsee.
    //    Ei käyttötilastoja, ei pyyntötunnisteita, ei mallin metatietoja.
    res.status(200).json({ content: Array.isArray(data.content) ? data.content : [] });
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    console.error('parse: kutsu epaonnistui', isTimeout ? 'timeout' : String(e && e.message));
    res.status(isTimeout ? 504 : 500).json({
      error: isTimeout ? 'Tulkinta kesti liian kauan' : 'Tulkinta epäonnistui'
    });
  } finally {
    clearTimeout(timer);
  }
};

// Vientejä testejä varten. Vercel käyttää vain yllä olevaa funktiota.
module.exports.buildPrompt = buildPrompt;
module.exports.CATEGORY_KEYS = CATEGORY_KEYS;
module.exports.PRIORITY_KEYS = PRIORITY_KEYS;
