// Palvelinpuolen valityspalvelin (proxy) Anthropicin Messages API:lle.
//
// TARKEIN TURVALLISUUSOMINAISUUS:
// Tama koodi ajetaan Vercelin palvelimella, EI selaimessa. Siksi
// ANTHROPIC_API_KEY luetaan palvelimen ymparistomuuttujasta eika se paady
// koskaan puhelimelle, index.html:aan eika selaimen verkkoliikenteeseen.
//
// Selain kutsuu vain: POST /api/parse { transcript, today, weekday }
// eika koskaan nae API-avainta.
//
// WP1: lisatty method- ja syotevalidointi, kokorajat, aikakatkaisu seka
// turvallinen virheenkasittely, joka ei paljasta palvelimen sisaista tilaa.

const { validateParseRequest } = require('./_validate.js');

/** Anthropic-kutsun aikakatkaisu. Ilman tata pyynto voi jaada roikkumaan. */
const UPSTREAM_TIMEOUT_MS = 15000;

const MODEL = 'claude-haiku-4-5-20251001';

function buildPrompt({ transcript, today, weekday }) {
  return `Tämän hetken päivämäärä on ${today} (${weekday}).

Käyttäjä sanoi ääneen tämän suomenkielisen komennon elämänhallintasovellukseen: ${JSON.stringify(transcript)}

Tulkitse tämä tehtäväksi tai kalenterimerkinnäksi. Jos käyttäjä mainitsee sekä alku- että loppuajan (esim. "kello 7.30–15.30" tai "seitsemästä puoli neljään"), täytä molemmat. Vastaa VAIN JSON-objektilla, ei muuta tekstiä eikä koodilohkomerkintöjä:
{"title":"lyhyt selkeä nimi, max n. 6 sanaa","date":"YYYY-MM-DD paras arvaus, tämä päivä jos ei mainintaa","time":"HH:MM 24h muodossa tai null","endTime":"HH:MM 24h muodossa jos loppuaika mainittu, muuten null","category":"yksi: tyo, perhe, hyvinvointi, harrastus, koti, kehitys, talous, muu","note":"lyhyt lisähuomio tai null"}`;
}

module.exports = async (req, res) => {
  // 1. Metodivalidointi
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 2. Syotevalidointi (kokorajat, tyypit, sallitut arvot)
  const validation = validateParseRequest(req.body);
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  // 3. Palvelimen konfiguraation tarkistus.
  //    Huom: virheviesti ei paljasta, mika muuttuja puuttuu.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('parse: ANTHROPIC_API_KEY puuttuu palvelimen ymparistosta');
    res.status(500).json({ error: 'Palvelu ei ole juuri nyt kaytettavissa' });
    return;
  }

  // 4. Kutsu Anthropicille aikakatkaisulla
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
        max_tokens: 300,
        messages: [{ role: 'user', content: buildPrompt(validation.value) }]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      // Anthropicin virhevastaus voi sisaltaa yksityiskohtia, joita ei
      // haluta valittaa clientille. Lokitetaan palvelimelle, palautetaan geneerinen.
      let upstream = '';
      try { upstream = JSON.stringify(await response.json()); } catch { /* ohita */ }
      console.error('parse: Anthropic vastasi', response.status, upstream.slice(0, 500));
      res.status(502).json({ error: 'Tulkinta epaonnistui' });
      return;
    }

    const data = await response.json();

    // 5. Palautetaan VAIN se osa vastauksesta, jota client tarvitsee.
    //    Ei kayttotilastoja, ei pyyntotunnisteita, ei mallin metatietoja.
    res.status(200).json({ content: Array.isArray(data.content) ? data.content : [] });
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    console.error('parse: kutsu epaonnistui', isTimeout ? 'timeout' : String(e && e.message));
    res.status(isTimeout ? 504 : 500).json({
      error: isTimeout ? 'Tulkinta kesti liian kauan' : 'Tulkinta epaonnistui'
    });
  } finally {
    clearTimeout(timer);
  }
};
