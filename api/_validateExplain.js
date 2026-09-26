// Syotteen validointi /api/explain-paatepisteelle (Suunnan selitys).
//
// Erillinen moduuli, jotta validointi voidaan testata ilman verkkokutsuja
// (tests/api-explain-validation.test.cjs). Alaviiva tiedostonimen alussa
// kertoo Vercelille, etta tama EI ole oma reitti vaan apumoduuli.
//
// ---------------------------------------------------------------
// VAIN LUKUJA, TOTUUSARVOJA JA LUETELTUJA ARVOJA
// ---------------------------------------------------------------
//
// Selitys saa valmiit, deterministisesti lasketut havainnot
// (src/domain/alignment.js) minimoidussa muodossa
// (src/ai/alignmentContext.js): alueet tunnuksina A1..A40, ajat
// tunteina. Tama validointi rakentaa kontekstin UUDELLEEN nimetyista
// kentista. Yksikaan merkkijono, joka ei ole lueteltu arvo, ei paase
// promptiin: ei aluenimia, ei tehtavien otsikoita, ei pohdintoja.
//
// Tuntematon kentta pudotetaan hiljaa. Kelvoton luku muuttuu nulliksi.

/** Koko JSON-rungon enimmaiskoko tavuina. */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_AREAS = 40;
const MAX_SIGNALS = 20;

const SIGNAL_KINDS = Object.freeze(['overload', 'neglect', 'misalignment', 'energy_overload', 'target_tension']);
const SEVERITIES = Object.freeze(['info', 'attention', 'strong']);
const BASES = Object.freeze(['planned', 'actual', 'targets']);
const QUALITY_LEVELS = Object.freeze(['good', 'partial', 'weak', 'none']);
const DIRECTIONS = Object.freeze(['over', 'under']);
const AREA_ALIAS = /^A([1-9]|[1-3][0-9]|40)$/;

/**
 * Havainnon sallitut mittarit ja niiden rajat.
 *
 * Ajat ovat TUNTEJA ja kentät nimetty sen mukaan (...Hours). Domainin
 * minuuttikentät (src/domain/alignment.js) muunnetaan ja nimetään
 * uudelleen selaimessa (src/ai/alignmentContext.js). Minuuttinimellä
 * kulkenut tuntiluku johti mallin harhaan ("10 minuuttia" = 10 h).
 */
const METRIC_NUMBERS = Object.freeze({
  plannedHours: 200, availableHours: 200, overageHours: 200, percentOfCapacity: 1000,
  unknownCount: 10000, targetHours: 200, expectedByNowHours: 200, actualHours: 200,
  percentOfExpected: 1000, weekProgressPercent: 100, desiredPercent: 100, actualPercent: 100,
  deviationPoints: 100, coveragePercent: 100, targetsHours: 200, differenceHours: 200,
  heavyHours: 200, veryHeavyHours: 200, energyBudgetHours: 200, percentOfBudget: 1000,
  unratedCount: 10000, unratedHours: 200, heavySharePercent: 100, energyLevel: 5, knownHours: 200
});
const METRIC_BOOLEANS = Object.freeze(['incomplete', 'timeOverloaded']);

function number(value, max, { min = 0 } = {}) {
  const n = Number(value);
  if (value === null || value === undefined || typeof value === 'boolean' || !Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return Math.round(n * 2) / 2;
}

function oneOf(value, allowed) {
  return allowed.includes(value) ? value : null;
}

function cleanMetrics(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, max] of Object.entries(METRIC_NUMBERS)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    // Poikkeama voi olla negatiivinen (alle toiveen).
    const value = number(input[key], max, { min: key === 'deviationPoints' ? -100 : 0 });
    if (value !== null) out[key] = value;
  }
  for (const key of METRIC_BOOLEANS) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  const direction = oneOf(input.direction, DIRECTIONS);
  if (direction) out.direction = direction;
  return out;
}

/**
 * Alueen rivi. Vain annetut kentät: selain lähettää viikkotason
 * havainnolle pelkän tärkeyden ja tavoitteen, eikä puuttuva `active`
 * saa muuttua promptissa väitteeksi "alue ei ole käytössä".
 */
function cleanArea(input) {
  if (!input || typeof input !== 'object') return null;
  const area = typeof input.area === 'string' && AREA_ALIAS.test(input.area) ? input.area : null;
  if (!area) return null;
  const out = { area };
  const importance = number(input.importance, 5, { min: 1 });
  if (importance !== null) out.importance = importance;
  if (typeof input.active === 'boolean') out.active = input.active;
  for (const key of ['targetHours', 'plannedHours', 'actualHours']) {
    const value = number(input[key], 168);
    if (value !== null) out[key] = value;
  }
  return out;
}

function cleanSignal(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = oneOf(input.kind, SIGNAL_KINDS);
  const severity = oneOf(input.severity, SEVERITIES);
  if (!kind || !severity) return null;
  const area = typeof input.area === 'string' && AREA_ALIAS.test(input.area) ? input.area : null;
  return { kind, severity, area, basis: oneOf(input.basis, BASES), metrics: cleanMetrics(input.metrics) };
}

/**
 * Validoi ja normalisoi /api/explain -pyynnon runko.
 * Palauttaa joko { ok: true, value } tai { ok: false, status, error }.
 */
function validateExplainRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Virheellinen pyynto' };
  }
  let approxBytes;
  try {
    approxBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return { ok: false, status: 400, error: 'Virheellinen pyynto' };
  }
  if (approxBytes > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'Pyynto on liian suuri' };
  }
  const context = body.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return { ok: false, status: 400, error: 'Konteksti puuttuu' };
  }
  const signals = (Array.isArray(context.signals) ? context.signals : [])
    .slice(0, MAX_SIGNALS).map(cleanSignal).filter(Boolean);
  if (signals.length === 0) {
    return { ok: false, status: 400, error: 'Selitettavaa havaintoa ei ole' };
  }
  const value = {
    capacityHours: number(context.capacityHours, 168),
    plannedHours: number(context.plannedHours, 168 * 4),
    actualHours: number(context.actualHours, 168),
    unestimatedCount: number(context.unestimatedCount, 10000),
    dataQuality: oneOf(context.dataQuality, QUALITY_LEVELS),
    areas: (Array.isArray(context.areas) ? context.areas : []).slice(0, MAX_AREAS).map(cleanArea).filter(Boolean),
    signals
  };
  return { ok: true, value };
}

module.exports = {
  validateExplainRequest,
  cleanMetrics,
  MAX_BODY_BYTES,
  SIGNAL_KINDS,
  METRIC_NUMBERS
};
