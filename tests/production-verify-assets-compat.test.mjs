// Deployn jälkeinen todennus toimii myös, kun työkalu on tuotantoa uudempi.
//
// Löydös yön julkaisujunan valmistelussa: tuotehaaralta ajettu
// `npm run production:verify-assets -- --wave=C` kaatui "porttilohkoa ei
// voitu jäsentää", koska jäsennin vaati jokaisen 24 portin olevan
// tuotannon schema.js:ssä — ja tuotannon commit (aalto C) tuntee niistä
// vain osan. Junan jokainen deploy todennetaan tällä komennolla, joten
// sen on toimittava uusimmalta haaralta vanhempaa tuotantoa vastaan.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { parseGates } from '../tools/release/state.mjs';
import { expectedMatrix, ALL_GATES } from '../tools/release/waves.mjs';

/** Aallon C:n aikainen porttilohko: vain 10 porttia, kuusi auki. */
const WAVE_C_SCHEMA = `export const TABLES = Object.freeze({
  routines: true,
  routineExceptions: true,
  goals: true,
  projects: true,
  notificationPreferences: true,
  wellbeing: true,
  bills: false,
  recurringExpenses: false,
  savingsGoals: false,
  aiAudit: false
});
export function hasTable(name) {}`;

test('KRIITTINEN: todennus jäsentää vanhemman tuotannon porttilohkon (puuttuva = kiinni)', () => {
  assert.match(read('scripts/production-verify-assets.mjs'),
    /parseGates\(schema\.text, \{ allowMissing: true \}\)/);
  const gates = parseGates(WAVE_C_SCHEMA, { allowMissing: true });
  assert.ok(gates, 'aallon C lohko ei jäsenny');
  const expected = expectedMatrix('C');
  for (const gate of ALL_GATES) assert.equal(gates[gate], expected[gate], gate);
});

test('tuntematon ylimääräinen portti kaatuu yhä', () => {
  const tampered = WAVE_C_SCHEMA.replace('aiAudit: false', 'aiAudit: false,\n  salainenPortti: true');
  assert.equal(parseGates(tampered, { allowMissing: true }), null);
});
