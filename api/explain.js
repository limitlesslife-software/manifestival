// Palvelinpuolen valityspalvelin Suunnan havaintojen selitykselle.
//
// TAMA ON VALINNAINEN. Suunta toimii kokonaan ilman tata: jokaisella
// havainnolla on deterministinen suomenkielinen selitys
// (src/domain/alignmentReview.js explainSignal). Jos tama paatepiste
// ei vastaa, selain nayttaa sen.
//
// ---------------------------------------------------------------
// TEKOALY SELITTAA, SE EI PAATA
// ---------------------------------------------------------------
//
// Havainnot on jo laskettu deterministisesti. Malli saa ne valmiina ja
// saa vain selittaa ja kysya. Se EI saa:
//   - asettaa tarkeytta, muuttaa tavoitteita tai kapasiteettia
//   - toteuttaa muutoksia (paatepiste ei kirjoita mitaan)
//   - diagnosoida terveytta tai arvostella elamantapaa
//
// ---------------------------------------------------------------
// MITA TANNE EI LAHETETA
// ---------------------------------------------------------------
//
// Aluenimet (vain tunnukset A1..), tehtavien ja tavoitteiden otsikot,
// muistiinpanot, pohdinnat ja hyvinvointimerkinnat EIVAT tule tanne.
// Syote rakennetaan uudelleen nimetyista lukukentista
// (api/_validateExplain.js).
//
// Suojaukset — samat kuin muilla AI-paatepisteilla:
//   1. vain POST
//   2. kirjautuminen vaaditaan (api/_auth.js)
//   3. kayttajakohtainen pyyntorajoitin (api/_ratelimit.js)
//   4. syote- ja kokovalidointi (api/_validateExplain.js)
//   5. aikakatkaisu ylavirran kutsulle
//   6. vastauksesta palautetaan vain tekstiosa
//   7. virheviestit ovat yleisia eivatka paljasta palvelimen tilaa

const { validateExplainRequest } = require('./_validateExplain.js');
const { authenticate } = require('./_auth.js');
const { checkRateLimit } = require('./_ratelimit.js');
const { applyCors } = require('./_cors.js');

const UPSTREAM_TIMEOUT_MS = 20000;
const MODEL = 'claude-haiku-4-5-20251001';
const RATE_LIMIT = 20;
const MAX_TOKENS = 600;

const RULES = [
  'Selita annetut havainnot suomeksi, lyhyesti ja toteavasti (enintaan 120 sanaa).',
  'Ala lisaa, poista tai muuta havaintoja; ne on laskettu jo.',
  'Ala keksi tarkeytta, kapasiteettia, arvoja tai tavoitteita. Kayttaja on maaritellyt ne itse.',
  'Ala kehota muuttamaan tarkeytta. Voit esittaa kysymyksen tai vaihtoehdot: keventaa, muuttaa tavoitetta tai jatkaa ennallaan.',
  'Ala diagnosoi terveytta, ala arvostele elamantapaa alaka moralisoi.',
  'Alueet ovat tunnuksia (A1, A2...). Kayta tunnuksia sellaisinaan; ala arvaa niiden nimia.',
  'Ala vaita tehneesi mitaan muutosta. Sina et voi muuttaa mitaan.'
];

function buildPrompt(value) {
  return `Olet Manifestival-sovelluksen Suunta-osion selittaja.

SAANNOT:
${RULES.map(rule => '- ' + rule).join('\n')}

Viikon tilanne (tunteina, laskettu valmiiksi):
${JSON.stringify(value)}

Vastaa pelkalla selitystekstilla, ilman otsikoita, listoja tai koodilohkoja.`;
}

module.exports = async (req, res) => {
  // 0. CORS: natiivikuoren esikysely ennen metoditarkistusta (api/_cors.js).
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const rate = checkRateLimit(`explain:${auth.userId || 'anonymous'}`, { limit: RATE_LIMIT });
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({ error: 'Liian monta pyyntoa. Odota hetki.' });
    return;
  }

  const validation = validateExplainRequest(req.body);
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('explain: ANTHROPIC_API_KEY puuttuu palvelimen ymparistosta');
    res.status(500).json({ error: 'Palvelu ei ole juuri nyt kaytettavissa' });
    return;
  }

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
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: buildPrompt(validation.value) }]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      // Vain tilakoodi lokiin: virhevastaus voi sisaltaa osan syotteesta.
      console.error('explain: Anthropic vastasi', response.status);
      res.status(502).json({ error: 'Selitys epaonnistui' });
      return;
    }

    const data = await response.json();
    const text = (Array.isArray(data.content) ? data.content : [])
      .filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text).join('\n').slice(0, 2000);
    res.status(200).json({ text });
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    console.error('explain: kutsu epaonnistui', isTimeout ? 'timeout' : 'virhe');
    res.status(isTimeout ? 504 : 500).json({ error: 'Selitys epaonnistui' });
  } finally {
    clearTimeout(timer);
  }
};

module.exports.buildPrompt = buildPrompt;
module.exports.RULES = RULES;
module.exports.RATE_LIMIT = RATE_LIMIT;
