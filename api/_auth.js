// Kutsujan todennus /api/parse-päätepisteelle.
//
// ONGELMA (auditoinnin avoin riski):
// Päätepiste oli täysin avoin. Kuka tahansa internetin käyttäjä pystyi
// kutsumaan sitä ja kuluttamaan Manifestivalin maksullista Anthropic-kiintiötä.
//
// RATKAISU ILMAN UUSIA SALAISUUKSIA:
// Supabasen access token on JWT, jonka allekirjoituksen voisi tarkistaa
// projektin JWT-salaisuudella. Sitä salaisuutta EI kuitenkaan haluta lisätä
// palvelimelle vain tätä varten. Sen sijaan token annetaan Supabasen omalle
// /auth/v1/user -päätepisteelle, joka kertoo onko se voimassa. Tarkistus
// tehdään siis siellä, missä tieto oikeasti on.
//
// Hinta: yksi ylimääräinen verkkokutsu. Se on hyväksyttävä, koska vaihtoehto
// on avoin päätepiste tai uusi salaisuus.

const SUPABASE_URL = 'https://twpyubcymdnbvelsjidg.supabase.co';

// Julkinen anon-avain. Sama arvo on selaimessa; se ei ole salaisuus.
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3cHl1YmN5bWRuYnZlbHNqaWRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNTg1MTEsImV4cCI6MjEwMDgzNDUxMX0.ych4lT7elajj3H12smhi2wjP-CP1dYrqtKhoK1RoSYQ';

/** Todennuksen aikakatkaisu. Selityksen aikarajat (api/explain.js, vercel.json) mitoitetaan tämän päälle. */
const VERIFY_TIMEOUT_MS = 5000;

/**
 * PRODUCTION GATE.
 *
 * true  = päätepiste vaatii kirjautuneen käyttäjän. Tämä on turvallinen
 *         oletus ja vastaa uutta selainkoodia, joka lähettää tokenin aina.
 * false = vanha avoin käytös. Vain hätävara, jos jokin menee julkaisussa
 *         pieleen. Asetetaan ympäristömuuttujalla PARSE_REQUIRE_AUTH=false.
 *
 * HUOM: api/ ja selainkoodi pitää julkaista YHDESSÄ. Vanha tuotantoselain ei
 * lähetä tokenia, joten se lakkaisi jäsentämästä puhetta, jos tämä otetaan
 * käyttöön yksinään. Ks. docs/DEPLOYMENT.md.
 */
function authRequired() {
  return process.env.PARSE_REQUIRE_AUTH !== 'false';
}

/** Poimii Bearer-tokenin Authorization-otsakkeesta. */
function bearerToken(req) {
  const header = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : null;
}

/**
 * Tarkista kutsujan token Supabasen kautta.
 *
 * @returns {Promise<{ok:true, userId:string|null, anonymous?:boolean}
 *                  |{ok:false, status:number, error:string}>}
 */
async function authenticate(req, { fetchImpl } = {}) {
  if (!authRequired()) {
    return { ok: true, userId: null, anonymous: true };
  }

  const token = bearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: 'Kirjautuminen vaaditaan' };
  }

  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const response = await doFetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return { ok: false, status: 401, error: 'Istunto ei ole voimassa' };
    }

    const user = await response.json();
    if (!user || !user.id) {
      return { ok: false, status: 401, error: 'Istunto ei ole voimassa' };
    }
    return { ok: true, userId: String(user.id) };
  } catch (cause) {
    // Todennuksen epäonnistuminen ei saa avata päätepistettä.
    console.error('parse/auth: todennus epaonnistui', cause && cause.name);
    return { ok: false, status: 503, error: 'Todennus ei ole juuri nyt käytettävissä' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { authenticate, bearerToken, authRequired, VERIFY_TIMEOUT_MS };
