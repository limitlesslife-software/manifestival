// TESTIKÄYTTÖÖN: valereittipalvelu.
//
// Tämä EI ole tuotantototeutus eikä sitä saa tuoda src/-koodiin: reittipalvelua
// ei ole valittu (omistajan päätös). Se täyttää src/domain/travel.js:n
// TRAVEL_PROVIDER_CONTRACT-sopimuksen, jotta lähtömoottorin ja tulostarkistuksen
// jokainen haara voidaan ajaa ilman verkkoa ja ilman keksittyjä kestoja.

/**
 * @param {object} options
 * @param {object} [options.table]  { 'origin>destination': sekunnit }
 * @param {string} [options.mode]   'ok' | 'unknown' | 'error' | 'throw' | 'garbage' | 'stale' | 'zero'
 * @param {() => number} [options.now]
 */
export function createTestRouteProvider({ table = {}, mode = 'ok', now = () => Date.now(), freshMinutes = 20 } = {}) {
  const calls = [];
  return {
    calls,
    async estimate(input) {
      calls.push(input);
      if (mode === 'throw') throw new Error('palvelu kaatui');
      if (mode === 'unknown') return { status: 'UNKNOWN' };
      if (mode === 'error') return { status: 'ERROR', message: 'sisäinen virhe' };
      if (mode === 'garbage') return 'ei olio';

      const key = `${typeof input.origin === 'string' ? input.origin : 'position'}>${input.destination}`;
      const seconds = mode === 'zero' ? 0 : table[key];
      if (seconds === undefined) return { status: 'UNKNOWN' };

      const calculatedAt = new Date(mode === 'stale' ? now() - 3 * 3600 * 1000 : now()).toISOString();
      return {
        status: 'OK',
        durationSeconds: seconds,
        distanceMeters: 12345,
        provider: 'testiprovider',
        calculatedAt,
        freshUntil: new Date(Date.parse(calculatedAt) + freshMinutes * 60 * 1000).toISOString(),
        confidence: 'medium'
      };
    }
  };
}
