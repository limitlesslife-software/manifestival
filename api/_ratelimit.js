// Kevyt käyttökohtainen pyyntörajoitin.
//
// TARKOITUKSELLISET RAJOITUKSET — lue nämä ennen kuin luotat tähän:
//
// Rajoitin elää serverless-instanssin muistissa. Vercel käynnistää useita
// rinnakkaisia instansseja ja sammuttaa ne, joten laskuri ei ole jaettu
// eikä pysyvä. Tämä on siis PARAS YRITYS, ei tae.
//
// Se riittää siihen mihin se on tarkoitettu: estämään vahingossa tapahtuva
// tulva (jumiin jäänyt uudelleenyritys, tuplaklikkaus, rikkinäinen silmukka)
// ja nostamaan rimaa satunnaiselle väärinkäytölle. Se EI kestä hajautettua
// tahallista hyökkäystä.
//
// Oikea hajautettu rajoitin vaatisi ulkoisen tilan (Upstash Redis, Vercel KV
// tms.). Se on maksullinen palvelu, jota ei lisätä ilman erillistä päätöstä.
// Rajapinta alla on kuitenkin sellainen, että toteutuksen voi vaihtaa
// koskematta kutsupaikkaan. Ks. docs/SECURITY.md.

/** Aikaikkuna, jonka sisällä pyyntöjä lasketaan. */
const WINDOW_MS = 60 * 1000;

/** Sallitut pyynnöt ikkunassa yhtä käyttäjää kohti. */
const MAX_REQUESTS_PER_WINDOW = 20;

/** Muistin yläraja, jottei kartta kasva rajatta pitkäikäisessä instanssissa. */
const MAX_TRACKED_KEYS = 5000;

/** @type {Map<string, number[]>} avain -> aikaleimat */
const hits = new Map();

/**
 * Kirjaa pyyntö ja kerro, saako se edetä.
 *
 * @param {string} key  Käyttäjän tunniste. Anonyymille käytä jotain vakiota.
 * @param {object} [options]
 * @param {number} [options.now]     Nykyhetki ms. Annettavissa testeille.
 * @param {number} [options.limit]
 * @param {number} [options.windowMs]
 * @returns {{allowed:boolean, remaining:number, retryAfterSeconds:number}}
 */
function checkRateLimit(key, options = {}) {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? MAX_REQUESTS_PER_WINDOW;
  const windowMs = options.windowMs ?? WINDOW_MS;
  const cutoff = now - windowMs;

  // Yksinkertainen siivous: jos kartta kasvaa liikaa, tyhjennetään se
  // kokonaan. Rajoitin on paras yritys, joten tämä on hyväksyttävää.
  if (hits.size > MAX_TRACKED_KEYS) hits.clear();

  const previous = hits.get(key) || [];
  const recent = previous.filter(t => t > cutoff);

  if (recent.length >= limit) {
    const oldest = recent[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    hits.set(key, recent);
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  recent.push(now);
  hits.set(key, recent);
  return { allowed: true, remaining: limit - recent.length, retryAfterSeconds: 0 };
}

/** Tyhjennä laskurit. Vain testejä varten. */
function resetRateLimit() {
  hits.clear();
}

module.exports = {
  checkRateLimit,
  resetRateLimit,
  WINDOW_MS,
  MAX_REQUESTS_PER_WINDOW
};
