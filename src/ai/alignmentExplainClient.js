// Suunnan havainnon selitys tekoälyltä — VALINNAINEN, varapolku aina.
//
// Selain EI kutsu Anthropicia suoraan eikä näe API-avainta (ks.
// api/explain.js). Konteksti on minimoitu (src/ai/alignmentContext.js):
// alueet tunnuksina, ajat tunteina, ei otsikoita eikä pohdintoja.
//
// YDIN EI RIIPU TEKOÄLYSTÄ. Jos kutsu epäonnistuu millään tavalla
// (ei verkkoa, aikakatkaisu, palvelin, tyhjä tai epäilyttävä vastaus),
// palautetaan deterministinen suomenkielinen selitys (explainSignal).
//
// VASTAUKSEN SUODATUS: mallin teksti on dataa, ei käsky. Se näytetään
// tekstinä (textContent/escape), sen pituus rajataan, ja vastaus
// hylätään jos se väittää tehneensä muutoksen tai tarjoaa linkkejä.
// Aluenimet palautetaan tunnuksista vasta täällä, paikallisesti.

import { API } from '../data/config.js';
import { apiUrl } from '../platform/index.js';
import { buildAlignmentAssistantContext, restoreAreaNames } from './alignmentContext.js';
import { explainSignal } from '../domain/alignmentReview.js';

export const EXPLAIN_TIMEOUT_MS = 20000;
export const MAX_EXPLANATION_LENGTH = 1200;

/** Vastaus, joka väittää toimineen käyttäjän puolesta tai ohjaa ulos, hylätään. */
const REJECT_PATTERNS = Object.freeze([
  /https?:\/\//i,
  /\b(muutin|päivitin|asetin|poistin|siirsin|tallensin|keskeytin)\b/i,
  /<\s*script/i
]);

function deterministic(signal, areas) {
  const text = explainSignal(signal, areas);
  return { source: 'deterministic', title: text.title, text: `${text.text} ${text.why}`.trim() };
}

/** Vain valittu havainto ja sen alue: pienin mahdollinen konteksti. */
export function explanationContext(analysis, signal) {
  const narrowed = {
    ...analysis,
    signals: [signal],
    areas: (analysis.areas || []).filter(area => !signal.areaId || area.id === signal.areaId)
  };
  return buildAlignmentAssistantContext(narrowed);
}

export function acceptableExplanation(text) {
  const clean = String(text ?? '').trim();
  if (clean.length < 20 || clean.length > MAX_EXPLANATION_LENGTH * 2) return false;
  return !REJECT_PATTERNS.some(pattern => pattern.test(clean));
}

/**
 * Selitä yksi havainto. Palauttaa AINA selityksen: tekoälyn, jos se
 * onnistui ja kelpasi, muuten deterministisen.
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
    const text = restoreAreaNames(raw.trim().slice(0, MAX_EXPLANATION_LENGTH), aliases);
    return { source: 'ai', title: fallback.title, text };
  } catch {
    return { ...fallback, failure: 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
