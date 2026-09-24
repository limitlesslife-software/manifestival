// Sijaintisovitin: kertaluonteinen etualan sijainti.
//
// =====================================================================
// TÄMÄ EI OLE SEURANTA
// =====================================================================
//
// Ei taustasijaintia, ei jatkuvaa seurantaa (`watchPosition`), ei
// geoaitoja, ei sijaintihistoriaa. Sovellus pyytää yhden sijainnin
// silloin kun käyttäjä itse pyytää jotain, joka sitä tarvitsee, ja
// unohtaa sen.
//
// KOORDINAATIT OVAT TRANSIENTTEJA:
//   - vain muistissa, ei localStorageen, ei IndexedDB:hen, ei kantaan
//   - ei lokiin (tämä moduuli ei kirjoita lokia lainkaan)
//   - ei vientiin, ei tekoälylle, ei tilin inventaarioon
//   - palautettu positio kantaa koordinaatit NÄKYMÄTTÖMINÄ ominaisuuksina
//     (ei-enumeroitavia, `toJSON` jättää ne pois), joten vahinko —
//     JSON.stringify, spread, console.log — ei vuoda niitä
//
// LUPAA EI KOSKAAN PYYDETÄ ITSESTÄÄN:
//   - getCurrentLocation() ei avaa lupadialogia, ellei kutsuja anna
//     `allowPrompt: true` (vain käyttäjän omasta eleestä)
//   - mitään ei pyydetä käynnistyksessä
//   - kaksi samanaikaista pyyntöä jakaa yhden laitekutsun
//
// Adapteri on vaihdettavissa (`adapter`-parametri), jotta kaikki
// tilasiirtymät ovat testattavissa ilman laitetta.

import {
  isNativeShell, setLocationPermissionState
} from './capabilities.js';

/** Sijaintiluvan tilat. Rikkaampi kuin yleinen PERMISSION: erottaa "ei kysytty" ja "estetty". */
export const LOCATION_PERMISSION = Object.freeze({
  /** Alusta ei tue sijaintia. */
  UNSUPPORTED: 'unsupported',
  /** Emme ole vielä edes lukeneet tilaa. */
  NOT_REQUESTED: 'not_requested',
  /** Alusta kysyisi luvan, jos pyydettäisiin. */
  PROMPT: 'prompt',
  GRANTED: 'granted',
  /** Käyttäjä kieltäytyi. Uusi pyyntö voi vielä kysyä. */
  DENIED: 'denied',
  /** Kielto, jonka sovellus ei voi enää kumota: vain järjestelmäasetukset auttavat. */
  BLOCKED: 'blocked',
  /** Tilan lukeminen tai pyyntö epäonnistui odottamattomasti. */
  ERROR: 'error'
});

export const LOCATION_ERROR = Object.freeze({
  UNSUPPORTED: 'unsupported',
  PERMISSION_REQUIRED: 'permission_required',
  PERMISSION_DENIED: 'permission_denied',
  POSITION_UNAVAILABLE: 'position_unavailable',
  TIMEOUT: 'timeout',
  INVALID_POSITION: 'invalid_position',
  UNKNOWN: 'unknown'
});

export const DEFAULT_TIMEOUT_MS = 10000;
/** Välimuistissa oleva sijainti vanhenee tässä ajassa, vaikka kutsuja hyväksyisi vanhempaa. */
export const MAX_CACHE_MS = 5 * 60 * 1000;

const STATE_TEXT = Object.freeze({
  [LOCATION_PERMISSION.UNSUPPORTED]: 'Tämä laite tai selain ei tue sijaintia.',
  [LOCATION_PERMISSION.NOT_REQUESTED]: 'Sijaintia ei ole vielä pyydetty.',
  [LOCATION_PERMISSION.PROMPT]: 'Lupaa ei ole vielä annettu. Sovellus kysyy sen vasta kun tarvitset sijaintia.',
  [LOCATION_PERMISSION.GRANTED]: 'Sijainti on sallittu. Sitä haetaan vain kun pyydät, eikä sitä tallenneta.',
  [LOCATION_PERMISSION.DENIED]: 'Sijainti on estetty. Voit sallia sen, kun seuraavan kerran tarvitset sitä.',
  [LOCATION_PERMISSION.BLOCKED]: 'Sijainti on estetty laitteen asetuksista. Salli se järjestelmän asetuksissa.',
  [LOCATION_PERMISSION.ERROR]: 'Sijainnin tilaa ei voitu lukea.'
});

/** Käyttäjälle näytettävä selitys lupatilalle. */
export function describeLocationState(state) {
  return Object.prototype.hasOwnProperty.call(STATE_TEXT, state)
    ? STATE_TEXT[state]
    : STATE_TEXT[LOCATION_PERMISSION.ERROR];
}

const ERROR_TEXT = Object.freeze({
  [LOCATION_ERROR.UNSUPPORTED]: 'Sijainti ei ole käytettävissä tällä laitteella.',
  [LOCATION_ERROR.PERMISSION_REQUIRED]: 'Sijaintilupaa ei ole vielä annettu.',
  [LOCATION_ERROR.PERMISSION_DENIED]: 'Sijaintilupa on estetty.',
  [LOCATION_ERROR.POSITION_UNAVAILABLE]: 'Sijaintia ei saatu. Tarkista, että laitteen sijaintipalvelu on päällä.',
  [LOCATION_ERROR.TIMEOUT]: 'Sijainnin haku kesti liian kauan.',
  [LOCATION_ERROR.INVALID_POSITION]: 'Laite palautti virheellisen sijainnin.',
  [LOCATION_ERROR.UNKNOWN]: 'Sijainnin haku epäonnistui.'
});

function failure(code) {
  const known = Object.prototype.hasOwnProperty.call(ERROR_TEXT, code) ? code : LOCATION_ERROR.UNKNOWN;
  return { ok: false, code: known, reason: ERROR_TEXT[known] };
}

// -------------------------------------------------------------- adapterit

/** Natiivin Geolocation-liitännäinen Capacitorin rekisteristä. */
function nativePlugin() {
  const capacitor = globalThis.Capacitor;
  if (!capacitor || typeof capacitor.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) return null;
  const plugins = capacitor.Plugins;
  return (plugins && plugins.Geolocation) || null;
}

function normalizePermission(value) {
  if (value === 'granted') return 'granted';
  if (value === 'denied') return 'denied';
  return 'prompt'; // prompt, prompt-with-rationale, tuntematon
}

function nativeAdapter(plugin) {
  return {
    name: 'native',
    async checkPermission() {
      const result = await plugin.checkPermissions();
      // Likimääräinen sijainti riittää: tarkkuus raportoidaan positiossa.
      if (result && (result.location === 'granted' || result.coarseLocation === 'granted')) return 'granted';
      return normalizePermission(result && result.location);
    },
    async requestPermission() {
      const result = await plugin.requestPermissions({ permissions: ['location'] });
      if (result && (result.location === 'granted' || result.coarseLocation === 'granted')) return 'granted';
      return normalizePermission(result && result.location);
    },
    async getPosition({ highAccuracy, timeoutMs, maximumAgeMs }) {
      try {
        const position = await plugin.getCurrentPosition({
          enableHighAccuracy: highAccuracy, timeout: timeoutMs, maximumAge: maximumAgeMs
        });
        const coords = (position && position.coords) || {};
        return {
          latitude: coords.latitude, longitude: coords.longitude,
          accuracy: coords.accuracy, timestamp: position && position.timestamp
        };
      } catch (error) {
        throw mapNativeError(error);
      }
    }
  };
}

function mapNativeError(error) {
  const text = String((error && (error.message || error.code)) || '').toLowerCase();
  if (text.includes('denied') || text.includes('permission')) return { code: LOCATION_ERROR.PERMISSION_DENIED };
  if (text.includes('timeout') || text.includes('timed out')) return { code: LOCATION_ERROR.TIMEOUT };
  if (text.includes('unavailable') || text.includes('disabled') || text.includes('location services')) {
    return { code: LOCATION_ERROR.POSITION_UNAVAILABLE };
  }
  return { code: LOCATION_ERROR.UNKNOWN };
}

function webAdapter(geolocation) {
  return {
    name: 'web',
    async checkPermission() {
      const permissions = globalThis.navigator && globalThis.navigator.permissions;
      if (!permissions || typeof permissions.query !== 'function') return 'prompt';
      try {
        const status = await permissions.query({ name: 'geolocation' });
        return normalizePermission(status && status.state);
      } catch {
        return 'prompt';
      }
    },
    async requestPermission() {
      // Selaimessa ei ole erillistä lupapyyntöä: dialogi aukeaa
      // paikannuskutsusta. Tulos hylätään heti -- vain lupatila jää.
      try {
        await this.getPosition({ highAccuracy: false, timeoutMs: DEFAULT_TIMEOUT_MS, maximumAgeMs: 0 });
        return 'granted';
      } catch (error) {
        if (error && error.code === LOCATION_ERROR.PERMISSION_DENIED) return 'denied';
        return this.checkPermission();
      }
    },
    getPosition({ highAccuracy, timeoutMs, maximumAgeMs }) {
      return new Promise((resolve, reject) => {
        geolocation.getCurrentPosition(
          position => {
            const coords = (position && position.coords) || {};
            resolve({
              latitude: coords.latitude, longitude: coords.longitude,
              accuracy: coords.accuracy, timestamp: position && position.timestamp
            });
          },
          error => {
            const code = error && error.code;
            reject({
              code: code === 1 ? LOCATION_ERROR.PERMISSION_DENIED
                : code === 2 ? LOCATION_ERROR.POSITION_UNAVAILABLE
                  : code === 3 ? LOCATION_ERROR.TIMEOUT
                    : LOCATION_ERROR.UNKNOWN
            });
          },
          { enableHighAccuracy: highAccuracy, timeout: timeoutMs, maximumAge: maximumAgeMs }
        );
      });
    }
  };
}

/** Valitse alustan sovitin. Palauttaa null, jos sijaintia ei tueta. */
export function selectAdapter() {
  if (isNativeShell()) {
    const plugin = nativePlugin();
    return plugin ? nativeAdapter(plugin) : null;
  }
  const geolocation = globalThis.navigator && globalThis.navigator.geolocation;
  return geolocation && typeof geolocation.getCurrentPosition === 'function' ? webAdapter(geolocation) : null;
}

// --------------------------------------------------------------- lupatila

let permissionState = LOCATION_PERMISSION.NOT_REQUESTED;

function remember(state) {
  permissionState = state;
  setLocationPermissionState(state);
  return state;
}

/** Viimeksi luettu lupatila (synkroninen). EI lue laitteelta eikä pyydä lupaa. */
export function locationPermissionState() {
  return permissionState;
}

/**
 * Lue lupatila laitteelta. EI KOSKAAN kysy lupaa.
 * @returns {Promise<{state:string, reason:string}>}
 */
export async function checkLocationPermission({ adapter = selectAdapter() } = {}) {
  if (!adapter) {
    remember(LOCATION_PERMISSION.UNSUPPORTED);
    return { state: LOCATION_PERMISSION.UNSUPPORTED, reason: describeLocationState(LOCATION_PERMISSION.UNSUPPORTED) };
  }
  try {
    const raw = await adapter.checkPermission();
    const state = raw === 'granted' ? LOCATION_PERMISSION.GRANTED
      : raw === 'denied'
        // Aiempi estotila säilyy estona, jos pyyntö on jo kerran epäonnistunut.
        ? (permissionState === LOCATION_PERMISSION.BLOCKED ? LOCATION_PERMISSION.BLOCKED : LOCATION_PERMISSION.DENIED)
        : LOCATION_PERMISSION.PROMPT;
    remember(state);
    return { state, reason: describeLocationState(state) };
  } catch {
    remember(LOCATION_PERMISSION.ERROR);
    return { state: LOCATION_PERMISSION.ERROR, reason: describeLocationState(LOCATION_PERMISSION.ERROR) };
  }
}

/**
 * Pyydä lupa. KUTSU VAIN KÄYTTÄJÄN OMASTA ELEESTÄ (painikkeen käsittelijästä).
 *
 * Jos lupa oli jo estetty ennen pyyntöä eikä alusta kysy uudestaan,
 * tulos on BLOCKED: sovellus ei voi enää auttaa, järjestelmäasetukset voivat.
 */
export async function requestLocationPermission({ adapter = selectAdapter() } = {}) {
  if (!adapter) return checkLocationPermission({ adapter: null });

  try {
    const before = await adapter.checkPermission();
    if (before === 'granted') {
      remember(LOCATION_PERMISSION.GRANTED);
      return { state: LOCATION_PERMISSION.GRANTED, reason: describeLocationState(LOCATION_PERMISSION.GRANTED) };
    }

    const after = await adapter.requestPermission();
    const state = after === 'granted' ? LOCATION_PERMISSION.GRANTED
      : after === 'denied'
        ? (before === 'denied' ? LOCATION_PERMISSION.BLOCKED : LOCATION_PERMISSION.DENIED)
        : LOCATION_PERMISSION.PROMPT;
    remember(state);
    return { state, reason: describeLocationState(state) };
  } catch {
    remember(LOCATION_PERMISSION.ERROR);
    return { state: LOCATION_PERMISSION.ERROR, reason: describeLocationState(LOCATION_PERMISSION.ERROR) };
  }
}

// ------------------------------------------------------------- sijainti

/** Kelvollinen koordinaatti? NaN, Infinity ja alueen ulkopuoliset hylätään. */
function validPosition(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const { latitude, longitude, accuracy } = raw;
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180
    && (accuracy === undefined || accuracy === null || (Number.isFinite(accuracy) && accuracy >= 0));
}

/**
 * Rakenna positio, jonka koordinaatit eivät vuoda vahingossa.
 *
 * `latitude`/`longitude` ovat ei-enumeroitavia: spread, Object.keys,
 * JSON.stringify ja console.log eivät näytä niitä. Suora luku
 * (`position.latitude`) toimii, joten tarkoituksellinen käyttö
 * (reittipalvelulle) on mahdollista mutta vahinko ei.
 */
function buildPosition(raw, now) {
  const position = {
    accuracyMeters: Number.isFinite(raw.accuracy) ? Math.round(raw.accuracy) : null,
    obtainedAt: now
  };
  Object.defineProperties(position, {
    latitude: { value: raw.latitude, enumerable: false },
    longitude: { value: raw.longitude, enumerable: false },
    toJSON: { value: () => ({ accuracyMeters: position.accuracyMeters, obtainedAt: now, coordinates: 'redacted' }), enumerable: false }
  });
  return Object.freeze(position);
}

/** Yksi muistissa oleva sijainti. Ei koskaan levylle. */
let cached = null;
let inFlight = null;

/** Tuore välimuistissa oleva sijainti tai null. Ei kutsu laitetta. */
export function getCachedLocation(maxAgeMs = 60000, now = Date.now()) {
  if (!cached) return null;
  const age = now - cached.obtainedAt;
  const limit = Math.min(Math.max(0, maxAgeMs), MAX_CACHE_MS);
  if (age < 0 || age > limit) return null;
  return cached;
}

/** Unohda sijainti. Kutsu uloskirjautumisessa ja tilinvaihdossa. */
export function clearLocationCache() {
  cached = null;
}

/**
 * Hae sijainti kerran.
 *
 * @param {object} [options]
 * @param {boolean} [options.allowPrompt=false] saako lupa kysyä; VAIN käyttäjän eleestä
 * @param {number}  [options.maxAgeMs=0]        hyväksyttävä välimuistin ikä; 0 = aina tuore
 * @param {number}  [options.timeoutMs]
 * @param {boolean} [options.highAccuracy=false]
 * @param {object}  [options.adapter]           testejä varten
 * @param {() => number} [options.now]
 * @returns {Promise<{ok:true, position:object}|{ok:false, code:string, reason:string}>}
 */
export async function getCurrentLocation({
  allowPrompt = false, maxAgeMs = 0, timeoutMs = DEFAULT_TIMEOUT_MS,
  highAccuracy = false, adapter = selectAdapter(), now = Date.now
} = {}) {
  const fresh = maxAgeMs > 0 ? getCachedLocation(maxAgeMs, now()) : null;
  if (fresh) return { ok: true, position: fresh };

  if (!adapter) return failure(LOCATION_ERROR.UNSUPPORTED);

  // Kaksi samanaikaista kutsua jakavat yhden laitekutsun.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      let permission = (await checkLocationPermission({ adapter })).state;

      if (permission !== LOCATION_PERMISSION.GRANTED) {
        if (permission === LOCATION_PERMISSION.DENIED || permission === LOCATION_PERMISSION.BLOCKED) {
          return failure(LOCATION_ERROR.PERMISSION_DENIED);
        }
        if (permission === LOCATION_PERMISSION.ERROR) return failure(LOCATION_ERROR.UNKNOWN);
        if (!allowPrompt) return failure(LOCATION_ERROR.PERMISSION_REQUIRED);

        permission = (await requestLocationPermission({ adapter })).state;
        if (permission !== LOCATION_PERMISSION.GRANTED) {
          return failure(permission === LOCATION_PERMISSION.PROMPT
            ? LOCATION_ERROR.PERMISSION_REQUIRED : LOCATION_ERROR.PERMISSION_DENIED);
        }
      }

      const raw = await adapter.getPosition({
        highAccuracy, timeoutMs, maximumAgeMs: Math.max(0, Math.min(maxAgeMs, MAX_CACHE_MS))
      });
      if (!validPosition(raw)) return failure(LOCATION_ERROR.INVALID_POSITION);

      const position = buildPosition(raw, now());
      cached = position;
      return { ok: true, position };
    } catch (error) {
      if (error && error.code === LOCATION_ERROR.PERMISSION_DENIED) {
        remember(LOCATION_PERMISSION.DENIED);
      }
      return failure(error && error.code);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Testejä varten: nollaa moduulin tila. */
export function resetGeolocationForTests() {
  cached = null;
  inFlight = null;
  permissionState = LOCATION_PERMISSION.NOT_REQUESTED;
  setLocationPermissionState(LOCATION_PERMISSION.NOT_REQUESTED);
}
