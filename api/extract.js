// Palvelinpuolen välityspalvelin kuitin ja laskun kuvan lukemiseen.
//
// TÄRKEIN TURVALLISUUSOMINAISUUS:
// Tämä koodi ajetaan Vercelin palvelimella, EI selaimessa. Siksi
// ANTHROPIC_API_KEY luetaan palvelimen ympäristömuuttujasta eikä se päädy
// koskaan puhelimelle, index.html:ään eikä selaimen verkkoliikenteeseen.
//
// ---------------------------------------------------------------
// KUVA KULKEE LÄPI, EI TALTEEN
// ---------------------------------------------------------------
//
// Kuva vastaanotetaan, lähetetään Anthropicille ja unohdetaan. Sitä EI
// kirjoiteta levylle, EI tallenneta Supabaseen, EI lokiteta eikä palauteta
// vastauksessa. Se elää yhden pyynnön keston.
//
// Kuitin kuva on koko sovelluksen henkilökohtaisin tieto: se kertoo missä
// olit, milloin ja mitä ostit. Ainoa turvallinen tapa käsitellä sitä on
// olla säilyttämättä sitä. Ks. docs/FINANCE-2.0.md.
//
// Yksikään lokirivi tässä tiedostossa ei sisällä kuvadataa. Base64-pätkä
// lokissa olisi juuri se kuitti, jota ei ollut tarkoitus säilyttää.
//
// ---------------------------------------------------------------
// VASTAUS ON EHDOTUS
// ---------------------------------------------------------------
//
// Tämä päätepiste ei kirjoita mitään mihinkään. Se palauttaa luennan,
// jonka käyttäjä tarkistaa ja hyväksyy selaimessa. Hyväksyntä on
// domain-sääntö (src/domain/receipts.js), ei tämän päätepisteen asia.
//
// Suojaukset — samat kuin /api/parse:
//   1. vain POST
//   2. kirjautuminen vaaditaan (api/_auth.js)
//   3. käyttäjäkohtainen pyyntörajoitin (api/_ratelimit.js)
//   4. syöte- ja kokovalidointi (api/_validateExtract.js)
//   5. aikakatkaisu ylävirran kutsulle
//   6. vastauksesta palautetaan vain tarvittava osa
//   7. virheviestit ovat yleisiä eivätkä paljasta palvelimen tilaa

const { validateExtractRequest } = require('./_validateExtract.js');
const { authenticate } = require('./_auth.js');
const { checkRateLimit } = require('./_ratelimit.js');
const { applyCors } = require('./_cors.js');

/**
 * Aikakatkaisu. Pidempi kuin /api/parse:ssa, koska kuvan lukeminen
 * kestää tekstin tulkintaa kauemmin.
 */
const UPSTREAM_TIMEOUT_MS = 30000;

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Kuvan lukeminen on harvinaisempaa ja kalliimpaa kuin puhekomennon
 * tulkinta, joten oma tiukempi rajansa.
 */
const RATE_LIMIT = 10;

// Sallitut kululuokat. Nämä vastaavat src/domain/financeCategories.js
// -moduulin avaimia. Yhdenmukaisuus on lukittu testillä, koska prompt
// elää palvelimella ja enum selaimessa — ajautuminen olisi hiljainen.
const EXPENSE_CATEGORY_KEYS = [
  'asuminen', 'ruoka', 'liikkuminen', 'auto', 'terveys', 'vakuutukset',
  'laskut', 'harrastukset', 'viihde', 'lapset', 'ostokset', 'tyo',
  'saastaminen', 'sijoittaminen', 'muu'
];

/**
 * Kehote kuitille.
 *
 * KOLME SÄÄNTÖÄ, JOTKA OVAT KEHOTTEESSA EIVÄTKÄ VAIN KOODISSA:
 *
 *   1. Summa senttien tarkkuudella kokonaislukuna. Malli, joka
 *      palauttaisi "24.90", tuottaisi liukuluvun heti ensimmäisessä
 *      muunnoksessa.
 *   2. Tuntematon kenttä on null, EI arvaus. Arvattu summa näyttää
 *      täsmälleen yhtä varmalta kuin luettu.
 *   3. Varmuus kentittäin. Käyttöliittymä korostaa epävarmat kentät,
 *      ja ilman tätä se ei tietäisi mitä korostaa.
 */
function buildReceiptPrompt({ today }) {
  return `Tämän hetken päivämäärä on ${today}.

Kuvassa on kassakuitti. Lue siitä ostotapahtuman tiedot.

SÄÄNNÖT:
- Summat KOKONAISLUKUINA SENTTEINÄ. 24,90 euroa on 2490. Älä palauta desimaalilukuja.
- Jos jotain ei voi lukea varmasti, palauta sille null. ÄLÄ ARVAA.
- Merkitse jokaiselle kentälle varmuus: "high", "medium" tai "low".
- Päivämäärä muodossa YYYY-MM-DD. Jos kuitissa ei ole päivää, palauta null.
- Valuutta kolmikirjaimisena koodina, oletus EUR.

Vastaa VAIN JSON-objektilla, ei muuta tekstiä eikä koodilohkomerkintöjä:
{"subject":"receipt","merchant":"kaupan nimi tai null","totalMinor":"loppusumma sentteinä kokonaislukuna tai null","currency":"EUR","date":"YYYY-MM-DD tai null","category":"yksi: ${EXPENSE_CATEGORY_KEYS.join(', ')}","lineItems":[{"description":"rivin teksti","totalMinor":"sentteinä kokonaislukuna"}],"fieldConfidence":{"merchant":"high|medium|low","totalMinor":"high|medium|low","date":"high|medium|low","category":"high|medium|low"}}`;
}

/**
 * Kehote laskulle.
 *
 * LASKU EI OLE MAKSETTU. Kehote ei kysy maksutilaa lainkaan, eikä
 * mallin vastaus voi asettaa sitä: `toBill()` pakottaa tilan avoimeksi
 * riippumatta siitä, mitä luennassa lukee.
 *
 * IBAN ja viite luetaan, koska käyttäjä kopioi ne omaan pankkiinsa.
 * Manifestival ei maksa laskua eikä sillä ole valtuutta siirtää rahaa.
 */
function buildBillPrompt({ today }) {
  return `Tämän hetken päivämäärä on ${today}.

Kuvassa on lasku. Lue siitä maksun tiedot.

SÄÄNNÖT:
- Summat KOKONAISLUKUINA SENTTEINÄ. 45,50 euroa on 4550. Älä palauta desimaalilukuja.
- Jos jotain ei voi lukea varmasti, palauta sille null. ÄLÄ ARVAA.
- Merkitse jokaiselle kentälle varmuus: "high", "medium" tai "low".
- Päivämäärät muodossa YYYY-MM-DD.
- IBAN isoin kirjaimin, välit saa jättää.
- ÄLÄ päättele, onko lasku maksettu. Sitä ei kysytä.

KENTTIEN NIMET OVAT SAMAT KUIN KUITILLA. "merchant" on laskuttaja ja
"date" on eräpäivä. Sama nimistö molemmille pitää jäsennyksen yhtenä
polkuna; kaksi eri nimistöä tarkoittaisi kahta tapaa lukea sama
vastaus, ja toinen niistä ajautuisi ennen pitkää erilleen.

Vastaa VAIN JSON-objektilla, ei muuta tekstiä eikä koodilohkomerkintöjä:
{"subject":"bill","merchant":"saajan nimi tai null","totalMinor":"summa sentteinä kokonaislukuna tai null","currency":"EUR","date":"eräpäivä YYYY-MM-DD tai null","iban":"tilinumero tai null","reference":"viitenumero tai null","fieldConfidence":{"merchant":"high|medium|low","totalMinor":"high|medium|low","date":"high|medium|low","iban":"high|medium|low","reference":"high|medium|low"}}`;
}

function buildPrompt({ subject, today }) {
  return subject === 'bill' ? buildBillPrompt({ today }) : buildReceiptPrompt({ today });
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

  // 3. Pyyntörajoitin käyttäjäkohtaisesti, omalla tiukemmalla rajalla.
  //    Avain on eri kuin /api/parse:lla, jottei kuvan lukeminen kuluta
  //    puhekomentojen kiintiötä eikä päinvastoin.
  const rate = checkRateLimit(`extract:${auth.userId || 'anonymous'}`, { limit: RATE_LIMIT });
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({ error: 'Liian monta pyyntöä. Odota hetki.' });
    return;
  }

  // 4. Syötevalidointi (kokorajat, tyypit, sallitut arvot)
  const validation = validateExtractRequest(req.body);
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  // 5. Palvelimen konfiguraation tarkistus.
  //    Huom: virheviesti ei paljasta, mikä muuttuja puuttuu.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('extract: ANTHROPIC_API_KEY puuttuu palvelimen ymparistosta');
    res.status(500).json({ error: 'Palvelu ei ole juuri nyt käytettävissä' });
    return;
  }

  const { image, mediaType, subject, today } = validation.value;

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
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: image }
            },
            { type: 'text', text: buildPrompt({ subject, today }) }
          ]
        }]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      // Anthropicin virhevastaus voi sisältää yksityiskohtia, joita ei
      // haluta välittää clientille — mahdollisesti myös osan syötteestä.
      // Lokitetaan vain tilakoodi, EI vastauksen runkoa: se voisi
      // sisältää kuvadataa.
      console.error('extract: Anthropic vastasi', response.status);
      res.status(502).json({ error: 'Kuvan lukeminen epäonnistui' });
      return;
    }

    const data = await response.json();

    // 7. Palautetaan VAIN se osa vastauksesta, jota client tarvitsee.
    //    Ei käyttötilastoja, ei pyyntötunnisteita, ei mallin metatietoja
    //    — eikä kuvaa, jota ei edes ole vastauksessa.
    res.status(200).json({ content: Array.isArray(data.content) ? data.content : [] });
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    // VIRHEVIESTIÄ EI LOKITETA SELLAISENAAN.
    //
    // fetchin virhe voi sisältää osan pyyntörungosta, ja pyyntörunko on
    // tässä kuva. Lokitetaan vain se, kaatuiko kutsu aikakatkaisuun.
    console.error('extract: kutsu epaonnistui', isTimeout ? 'timeout' : 'virhe');
    res.status(isTimeout ? 504 : 500).json({
      error: isTimeout ? 'Kuvan lukeminen kesti liian kauan' : 'Kuvan lukeminen epäonnistui'
    });
  } finally {
    clearTimeout(timer);
  }
};

// Vientejä testejä varten. Vercel käyttää vain yllä olevaa funktiota.
module.exports.buildPrompt = buildPrompt;
module.exports.buildReceiptPrompt = buildReceiptPrompt;
module.exports.buildBillPrompt = buildBillPrompt;
module.exports.EXPENSE_CATEGORY_KEYS = EXPENSE_CATEGORY_KEYS;
module.exports.RATE_LIMIT = RATE_LIMIT;
