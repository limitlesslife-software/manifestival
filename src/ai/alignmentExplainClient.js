// Suunnan havainnon selitys tekoälyltä — VALINNAINEN, varapolku aina.
//
// Selain EI kutsu Anthropicia suoraan eikä näe API-avainta (ks.
// api/explain.js). Konteksti on minimoitu (src/ai/alignmentContext.js):
// alueet tunnuksina, ajat tunteina, ei otsikoita eikä pohdintoja.
//
// YDIN EI RIIPU TEKOÄLYSTÄ. Jos kutsu epäonnistuu millään tavalla
// (katkaisin pois, ei verkkoa, aikakatkaisu, palvelin, tyhjä tai
// epäilyttävä vastaus), palautetaan deterministinen suomenkielinen
// selitys (explainSignal).
//
// VASTAUKSEN SUODATUS: mallin teksti on dataa, ei käsky. Se näytetään
// tekstinä (textContent/escape), liian pitkä vastaus hylätään (ei
// katkaista kesken lauseen), ja vastaus hylätään myös, jos se väittää
// tehneensä muutoksen tai tarjoaa linkkejä. Aluenimet palautetaan
// tunnuksista vasta täällä, paikallisesti.

import { API } from '../data/config.js';
import { apiUrl } from '../platform/index.js';
import { buildAlignmentAssistantContext, restoreAreaNames } from './alignmentContext.js';
import { explainSignal } from '../domain/alignmentReview.js';
import { SIGNAL } from '../domain/alignment.js';

/**
 * PRODUCTION GATE: tekoälyselitys.
 *
 * false = "Selitä tekoälyllä" -painiketta ei näytetä eikä selain kutsu
 *         /api/explain-päätepistettä koskaan. Jokaisella havainnolla on
 *         silti deterministinen selitys ("Miksi tämä näkyy?").
 * true  = painike näkyy ja selitys haetaan palvelimelta varapolulla.
 *
 * Käyttöönotto on OMISTAJAN PÄÄTÖS, ja se vaatii kaksi kytkintä yhdessä:
 * tämä lippu JA palvelimen ympäristömuuttuja EXPLAIN_ENABLED=true
 * (api/explain.js). Kumpikin yksin pitää selityksen poissa: palvelin
 * vastaa 503 ja selain näyttää deterministisen selityksen.
 * Ks. docs/SUUNTA-ACTIVATION-GO-NOGO.md.
 */
export const AI_EXPLAIN_ENABLED = false;

/** Asiakkaan odotus. Palvelin: todennus 5 s + ylävirta 8 s; tämä on vähintään 2 s pidempi. */
export const EXPLAIN_TIMEOUT_MS = 16000;
/** Pisin kelpaava selitys. Sama raja kuin palvelimella (api/explain.js MAX_TEXT_LENGTH). */
export const MAX_EXPLANATION_LENGTH = 1200;

/** null = käännösaikainen lippu. Vain testit asettavat tämän. */
let enabledOverride = null;

/** Onko tekoälyselitys käytössä? */
export function aiExplainEnabled() {
  return enabledOverride === null ? AI_EXPLAIN_ENABLED : enabledOverride;
}

/** Vain testeille: pakota lipun arvo. null palauttaa käännösaikaisen arvon. */
export function setAiExplainEnabledForTests(value) {
  enabledOverride = value === null || value === undefined ? null : value === true;
}

/** Vastaus, joka väittää toimineen käyttäjän puolesta tai ohjaa ulos, hylätään. */
const REJECT_PATTERNS = Object.freeze([
  // Linkit: osoite, www-alku tai markdown-linkki.
  /https?:\/\//i,
  /\bwww\./i,
  /\]\(/,
  /<\s*script/i,
  // "Muutin tavoitettasi" — väite tehdystä muutoksesta, imperfekti.
  /\b(muutin|päivitin|asetin|poistin|siirsin|tallensin|keskeytin|lisäsin|loin|kevensin|pienensin|vaihdoin|merkitsin|peruin|varasin)\b/i,
  // "Olen muuttanut", "olemme lisänneet" — perfekti.
  /\b(olen|olemme)\s+(muutt|päivitt|poist|lisänn|siirt|kevent|pienent|vaihtan|merkinn|asettan|tallentan)\w*/i,
  // "Tavoite on muutettu" — passiivi.
  /\b(muutettu|päivitetty|poistettu|siirretty)\b/i
]);

/**
 * Ääkköset kadottanut suomi ("Ala" = "Älä", "mita" = "mitä") on merkki
 * rikkinäisestä vastauksesta, eikä sitä näytetä tekoälyn nimissä.
 * Tunnistus nojaa tiettyihin sanoihin, ei pelkkään ääkkösten puuttumiseen:
 * lyhyt, numeroita täynnä oleva suomi voi olla kokonaan ilman ääkkösiä
 * ("A1 on saanut 2 tuntia, tavoite on 10 tuntia viikossa.").
 * Sanat valittu niin, ettei oikea suomi osu niihin ("tarkemmin" ei osu).
 * "Ala" on myös alkaa-verbin käskymuoto, mutta näissä selityksissä se on
 * lähes aina kadonnut "Älä"; varapolku on silloin turvallinen valinta.
 */
const DEACCENTED_FINNISH = /\b(ala|alaka|mita|mitaan|etta|tama|taman|tassa|talla|enintaan|vahemman|enemman|lisaa|paiva\w*|nayt\w*|kayt\w*|tarkea\w*|tarkey\w*|tyo\w*)\b/i;

/**
 * Näin pitkä vastaus ilman yhtään ä:tä tai ö:tä on käytännössä muuta
 * kieltä (tai ääkköset ovat kadonneet), eikä sitä näytetä.
 */
const PLAIN_ASCII_LIMIT = 200;

function deterministic(signal, areas) {
  const text = explainSignal(signal, areas);
  return { source: 'deterministic', title: text.title, text: `${text.text} ${text.why}`.trim() };
}

/** Selitykseen tarvittavat alueet: vähemmän on parempi. */
function areasFor(analysis, signal) {
  const areas = analysis.areas || [];
  // Aluekohtainen havainto: vain sen oma alue.
  if (signal.areaId) return areas.filter(area => area.id === signal.areaId);
  // Tavoitejännite: käytössä olevat alueet, joilla on tavoite.
  if (signal.kind === SIGNAL.TARGET_TENSION) return areas.filter(area => area.active && area.targetMinutes > 0);
  // Muut viikkotason havainnot (kuormitus, energiakuormitus) eivät koske
  // yksittäistä aluetta: alueita ei lähetetä lainkaan.
  return [];
}

/** Vain valittu havainto ja sen tarvitsemat alueet: pienin mahdollinen konteksti. */
export function explanationContext(analysis, signal) {
  const { context, aliases } = buildAlignmentAssistantContext({
    ...analysis, signals: [signal], areas: areasFor(analysis, signal)
  });
  if (signal.kind === SIGNAL.TARGET_TENSION) {
    // Jännite koskee tavoitteiden summaa: suunniteltu ja toteutunut aika
    // alueittain eivät kuulu selitykseen.
    context.areas = context.areas.map(({ area, importance, targetHours }) => ({ area, importance, targetHours }));
  }
  return { context, aliases };
}

export function acceptableExplanation(text) {
  const clean = String(text ?? '').trim();
  if (clean.length < 20 || clean.length > MAX_EXPLANATION_LENGTH) return false;
  if (DEACCENTED_FINNISH.test(clean)) return false;
  if (clean.length >= PLAIN_ASCII_LIMIT && !/[äöÄÖ]/.test(clean)) return false;
  return !REJECT_PATTERNS.some(pattern => pattern.test(clean));
}

/**
 * Selitä yksi havainto. Palauttaa AINA selityksen: tekoälyn, jos se
 * oli käytössä, onnistui ja kelpasi, muuten deterministisen.
 *
 * @param {object} args
 * @param {object} args.analysis  analyzeWeek()-tulos
 * @param {object} args.signal    selitettävä havainto
 * @param {Array}  args.areas     käyttäjän alueet (paikallinen nimien palautus)
 * @param {string|null} args.accessToken
 * @param {Function} [args.fetchImpl]
 * @returns {Promise<{source: 'ai'|'deterministic', title: string, text: string, failure?: string}>}
 */
export async function explainWithFallback({ analysis, signal, areas = [], accessToken = null, fetchImpl = null }) {
  const fallback = deterministic(signal, areas);
  // Katkaisin pois: ei verkkokutsua lainkaan.
  if (!aiExplainEnabled()) return { ...fallback, failure: 'disabled' };
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch || !accessToken) return { ...fallback, failure: 'unavailable' };

  const { context, aliases } = explanationContext(analysis, signal);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), EXPLAIN_TIMEOUT_MS) : null;
  try {
    const response = await doFetch(apiUrl(API.explain), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ context }),
      signal: controller ? controller.signal : undefined
    });
    if (!response || !response.ok) return { ...fallback, failure: 'http' };
    const data = await response.json();
    const raw = data && typeof data.text === 'string' ? data.text : '';
    if (!acceptableExplanation(raw)) return { ...fallback, failure: 'rejected' };
    const text = restoreAreaNames(raw.trim(), aliases);
    return { source: 'ai', title: fallback.title, text };
  } catch {
    return { ...fallback, failure: 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
