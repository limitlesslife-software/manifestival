// Syotteen validointi /api/plan-paatepisteelle.
//
// Erillinen moduuli, jotta validointi voidaan testata ilman verkkokutsuja
// (tests/api-plan-validation.test.cjs). Alaviiva tiedostonimen alussa
// kertoo Vercelille, etta tama EI ole oma reitti vaan apumoduuli.
//
// ---------------------------------------------------------------
// KONTEKSTI MENEE PROMPTIIN, JOTEN SE VALIDOIDAAN TIUKASTI
// ---------------------------------------------------------------
//
// `goalText` on kayttajan omaa vapaata tekstia ja se menee promptiin
// sellaisenaan. Sita ei voi rajoittaa sallittuihin arvoihin, mutta sen
// PITUUS rajoitetaan ja se lahetetaan JSON-koodattuna, jolloin se ei voi
// katketa promptin rakennetta.
//
// Kaikki muu konteksti on LUKUJA. Numero ei voi sisaltaa ohjetta.
// Aiemmin harkittiin vapaan kontekstin lahettamista; se hylattiin,
// koska kayttajan tehtavien otsikot olisivat menneet ulos ilman etta
// suunnittelu tarvitsee niita.

/** Vapaan tavoitetekstin enimmaispituus. */
const MAX_GOAL_TEXT_LENGTH = 1000;

/** Koko JSON-rungon enimmaiskoko tavuina. */
const MAX_BODY_BYTES = 8 * 1024;

/** Sallitut suunnittelun lajit. */
const MODES = Object.freeze(['initial', 'replan']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Kontekstin sallitut kentat ja niiden ylarajat. */
const CONTEXT_LIMITS = Object.freeze({
  activeGoalCount: 500,
  nearestDeadlineDays: 3650,
  weeklyFreeHours: 168,
  // Suunnan rajat (src/domain/planAlignment.js buildPlanningConstraints).
  // VAIN LUKUJA: ei alueiden nimiä, ei tärkeyksiä yksitellen, ei otsikoita.
  remainingWeeklyHours: 168,
  unestimatedCount: 10000,
  heavyRemainingHours: 168,
  protectedHours: 168,
  neglectedImportantAreaCount: 40,
  // Suojattu aika (migraatio 0015): oma aika ja vapaa-aika viikossa sekä
  // lomapäivät suunnitteluhorisontissa. Vain lukuja.
  protectedPersonalHoursPerWeek: 168,
  vacationDays: 366
});

/**
 * Validoi ja normalisoi /api/plan -pyynnon runko.
 *
 * Palauttaa joko { ok: true, value } tai { ok: false, status, error }.
 */
function validatePlanRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Virheellinen pyyntö' };
  }

  let approxBytes;
  try {
    approxBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return { ok: false, status: 400, error: 'Virheellinen pyyntö' };
  }
  if (approxBytes > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'Pyyntö on liian suuri' };
  }

  const { goalText, today, mode, context } = body;

  if (typeof goalText !== 'string') {
    return { ok: false, status: 400, error: 'Tavoite puuttuu' };
  }
  const cleanGoal = goalText.trim();
  if (cleanGoal.length === 0) {
    return { ok: false, status: 400, error: 'Tavoite puuttuu' };
  }
  if (cleanGoal.length > MAX_GOAL_TEXT_LENGTH) {
    return { ok: false, status: 413, error: 'Tavoite on liian pitkä' };
  }

  if (typeof today !== 'string' || !ISO_DATE.test(today)) {
    return { ok: false, status: 400, error: 'Virheellinen päivämäärä' };
  }
  if (Number.isNaN(Date.parse(today))) {
    return { ok: false, status: 400, error: 'Virheellinen päivämäärä' };
  }

  const cleanMode = MODES.includes(mode) ? mode : 'initial';

  return {
    ok: true,
    value: {
      goalText: cleanGoal,
      today,
      mode: cleanMode,
      context: cleanContext(context)
    }
  };
}

/**
 * Siisti konteksti.
 *
 * VAIN LUKUJA JA NIIDEN RAJAT. Tuntematon kentta pudotetaan hiljaa:
 * nimenomainen sallittujen lista on ainoa tapa varmistaa, ettei
 * promptiin paady sisaltoa jota kukaan ei osannut kieltaa.
 *
 * Kelvoton luku muuttuu nulliksi eika arvaukseksi. Nolla olisi
 * vaite ("aktiivisia tavoitteita on nolla"), null on rehellinen.
 */
function cleanContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return Object.fromEntries(Object.keys(CONTEXT_LIMITS).map(key => [key, null]));
  }

  const out = {};
  for (const [key, max] of Object.entries(CONTEXT_LIMITS)) {
    const value = Number(context[key]);
    out[key] = Number.isFinite(value) && value >= 0 && value <= max
      ? Math.trunc(value)
      : null;
  }
  return out;
}

module.exports = {
  validatePlanRequest,
  cleanContext,
  MAX_GOAL_TEXT_LENGTH,
  MAX_BODY_BYTES,
  MODES,
  CONTEXT_LIMITS
};
