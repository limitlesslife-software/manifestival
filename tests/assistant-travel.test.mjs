// Matka, lähtöaika ja sijaintisäännöt — domain.
//
// =====================================================================
// YKSI RIVI, JOTA TÄMÄ TIEDOSTO VARTIOI YLI KAIKEN MUUN
// =====================================================================
//
//   TUNTEMATTOMASTA MATKA-AJASTA EI LASKETA LÄHTÖAIKAA.
//
// Laskettu lähtöaika näyttää täsmälleen yhtä varmalta kuin oikea.
// Käyttäjä luottaisi siihen ja myöhästyisi. `Number(null)` on nolla,
// ja nolla tarkoittaisi "ollaan jo perillä" — se on juuri se vale,
// jonka koko moduuli on olemassa estämään.
//
// =====================================================================
// KOORDINAATTEJA EI OLE
// =====================================================================
//
// `origin`, `destination` ja `place` ovat NIMIÄ. Testit tarkistavat,
// ettei normalisointi tuota koordinaattikenttiä edes silloin kun
// syötteessä on niitä.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRAVEL_SOURCE, TRAVEL_SOURCES, TRAVEL_MODE, TRAVEL_MODES, DEFAULT_BUFFERS,
  STALE_AFTER_MINUTES, MAX_TRAVEL_MINUTES,
  normalizeTravelPlan, validateTravelPlan, computeLeaveBy, isEstimateStale,
  leaveStatus, shouldAlertDeparture, describeDeparture,
  TRAVEL_PROVIDER_CONTRACT, hasTravelProvider, manualEstimate, applyEstimate,
  LOCATION_TRIGGER, LOCATION_TRIGGERS, normalizeLocationRule,
  locationRuleMatches, travelModeLabel
} from '../src/domain/travel.js';

/** Suunnitelma, jonka kesto TIEDETÄÄN. */
function plan(overrides = {}) {
  return normalizeTravelPlan({
    id: 'p1',
    title: 'Hammaslääkäri',
    origin: 'Koti',
    destination: 'Keskusta',
    arrivalDate: '2026-09-11',
    arrivalTime: '10:00',
    mode: TRAVEL_MODE.DRIVING,
    travelMinutes: 25,
    travelSource: TRAVEL_SOURCE.MANUAL,
    preparationMinutes: 10,
    arrivalBufferMinutes: 5,
    ...overrides
  });
}

const TODAY = '2026-09-11';

// =====================================================================
// TUNTEMATON PYSYY TUNTEMATTOMANA
// =====================================================================

test('KRIITTINEN: tuntematon matka-aika on null eikä nolla', () => {
  for (const value of [null, undefined, '']) {
    assert.equal(normalizeTravelPlan({ travelMinutes: value }).travelMinutes,
      null, `arvo ${JSON.stringify(value)} muuttui nollaksi`);
  }
});

test('KRIITTINEN: tuntemattomasta kestosta ei lasketa lähtöaikaa', () => {
  const result = computeLeaveBy(plan({ travelMinutes: null }));

  assert.equal(result.known, false);
  assert.equal(result.leaveByTime, null);
  assert.equal(result.leaveByDate, null);
  assert.equal(result.totalMinutes, null);
  assert.ok(result.reason.length > 20, 'tuntemattomuudelle ei annettu syytä');
});

test('KRIITTINEN: tuntematon kesto pakottaa lähteen tuntemattomaksi', () => {
  // Ilman tätä käyttöliittymä näyttäisi puuttuvan arvion kirjattuna.
  // Kannassa sama sääntö on `travel_plans_unknown_source_check`.
  const p = normalizeTravelPlan({
    travelMinutes: null, travelSource: TRAVEL_SOURCE.PROVIDER
  });
  assert.equal(p.travelSource, TRAVEL_SOURCE.UNKNOWN);
});

test('ilman saapumisaikaa lähtöaikaa ei voi laskea', () => {
  assert.equal(computeLeaveBy(plan({ arrivalTime: null })).known, false);
  assert.equal(computeLeaveBy(null).known, false);
});

test('tuntematon kesto ei tuota lähtöhälytystä', () => {
  // Hälytys ilman lukua olisi pelkkä huoli.
  assert.equal(shouldAlertDeparture(plan({ travelMinutes: null }),
    { todayIso: TODAY, nowMinutes: 540 }), false);
});

test('tuntematon kesto ei tuota myöhästymisväitettä', () => {
  const status = leaveStatus(plan({ travelMinutes: null }),
    { todayIso: TODAY, nowMinutes: 1400 });
  assert.equal(status.late, false);
  assert.equal(status.minutesUntilLeave, null);
});

// =====================================================================
// LÄHTÖAIKA
// =====================================================================

test('lähtöaika on saapuminen miinus matka, valmistautuminen ja puskuri', () => {
  const result = computeLeaveBy(plan());

  // 10:00 - 25 - 10 - 5 = 09:20
  assert.equal(result.known, true);
  assert.equal(result.leaveByTime, '09:20');
  assert.equal(result.totalMinutes, 40);
  assert.deepEqual(result.parts, { travel: 25, preparation: 10, arrivalBuffer: 5 });
});

test('jokainen osa näkyy perustelussa erikseen', () => {
  // Käyttäjä säätää puskureita erikseen, eikä hän voi korjata lukua
  // jonka osia hän ei näe.
  const { reason } = computeLeaveBy(plan());
  assert.ok(reason.includes('25 min'), reason);
  assert.ok(reason.includes('10 min'), reason);
  assert.ok(reason.includes('5 min'), reason);
  assert.ok(reason.includes('10:00'), reason);
});

test('käsin kirjattu arvio sanotaan käsin kirjatuksi', () => {
  const { reason } = computeLeaveBy(plan({ travelSource: TRAVEL_SOURCE.MANUAL }));
  assert.ok(/itse kirjaamasi/i.test(reason), reason);
});

test('KRIITTINEN: keskiyön yli menevä lähtö siirtää päivää taaksepäin', () => {
  // Saapuminen klo 08:00 ja kymmenen tunnin matka on EDELLISEN päivän
  // ilta — ei saman päivän aika, joka olisi saapumisen jälkeen.
  const result = computeLeaveBy(plan({
    arrivalTime: '08:00', travelMinutes: 600,
    preparationMinutes: 10, arrivalBufferMinutes: 5
  }));

  assert.equal(result.known, true);
  assert.equal(result.leaveByDate, '2026-09-10');
  assert.equal(result.leaveByTime, '21:45');
});

test('ilman päivää lähtöaika lasketaan mutta päivä jää tuntemattomaksi', () => {
  const result = computeLeaveBy(plan({ arrivalDate: null }));
  assert.equal(result.known, true);
  assert.equal(result.leaveByTime, '09:20');
  assert.equal(result.leaveByDate, null);
});

// =====================================================================
// MYÖHÄSSÄ
// =====================================================================

test('myöhässä sanotaan suoraan eikä kehoteta lähtemään nyt', () => {
  const status = leaveStatus(plan(), { todayIso: TODAY, nowMinutes: 580 });
  assert.equal(status.late, true);
  assert.equal(status.minutesLate, 20);

  const text = describeDeparture(plan(), { todayIso: TODAY, nowMinutes: 580 });
  assert.ok(/myöhässä/i.test(text), text);
});

test('täsmälleen lähtöhetkellä kehotetaan lähtemään nyt', () => {
  const text = describeDeparture(plan(), { todayIso: TODAY, nowMinutes: 560 });
  assert.ok(/lähde nyt/i.test(text), text);
});

test('ennen lähtöä kerrotaan kellonaika ja jäljellä olevat minuutit', () => {
  const text = describeDeparture(plan(), { todayIso: TODAY, nowMinutes: 550 });
  assert.ok(text.includes('09:20'), text);
  assert.ok(text.includes('10 min'), text);
});

test('eilinen lähtö on myöhässä, huominen ei', () => {
  assert.equal(leaveStatus(plan(), { todayIso: '2026-09-12', nowMinutes: 0 }).late,
    true);
  assert.equal(leaveStatus(plan(), { todayIso: '2026-09-10', nowMinutes: 1439 }).late,
    false);
});

test('hälytys tulee vartti ennen lähtöä ja myöhässä ollessa', () => {
  const now = n => ({ todayIso: TODAY, nowMinutes: n });

  assert.equal(shouldAlertDeparture(plan(), now(544)), false);  // 16 min ennen
  assert.equal(shouldAlertDeparture(plan(), now(545)), true);   // 15 min ennen
  assert.equal(shouldAlertDeparture(plan(), now(600)), true);   // myöhässä
});

// =====================================================================
// ARVION VANHENEMINEN
// =====================================================================

test('palvelun arvio vanhenee', () => {
  const p = plan({
    travelSource: TRAVEL_SOURCE.PROVIDER,
    estimatedAt: '2026-09-11T08:00:00.000Z'
  });

  assert.equal(isEstimateStale(p, '2026-09-11T08:20:00.000Z'), false);
  assert.equal(isEstimateStale(p, '2026-09-11T08:31:00.000Z'), true);
});

test('KRIITTINEN: käsin kirjattu arvio ei vanhene', () => {
  // Käyttäjä tietää oman matkansa, eikä sitä pidä merkitä
  // epäluotettavaksi ajan kulumisen takia.
  const p = plan({
    travelSource: TRAVEL_SOURCE.MANUAL,
    estimatedAt: '2020-01-01T00:00:00.000Z'
  });
  assert.equal(isEstimateStale(p, '2026-09-11T08:00:00.000Z'), false);
});

test('vanhenemista ei väitetä ilman aikaleimaa', () => {
  const p = plan({ travelSource: TRAVEL_SOURCE.PROVIDER, estimatedAt: null });
  assert.equal(isEstimateStale(p, '2026-09-11T08:00:00.000Z'), false);
});

test('vanhenemisraja on puoli tuntia', () => {
  assert.equal(STALE_AFTER_MINUTES, 30);
});

// =====================================================================
// PALVELUNTARJOAJAA EI OLE
// =====================================================================

test('KRIITTINEN: matka-aikapalvelua ei ole', () => {
  // Tämä ei ole muistutus vaan invariantti. Jos joku toteuttaa
  // palvelun, tämä kaatuu — ja se on oikea hetki tarkistaa, että
  // sopimuksen jokainen kohta on täytetty.
  assert.equal(hasTravelProvider(), false);
});

test('sopimus vaatii näkyvän epäonnistumisen eikä arvausta', () => {
  const contract = JSON.stringify(TRAVEL_PROVIDER_CONTRACT);
  assert.ok(contract.length > 0);
  assert.equal(Object.isFrozen(TRAVEL_PROVIDER_CONTRACT), true);
  assert.equal(typeof TRAVEL_PROVIDER_CONTRACT.estimate, 'undefined',
    'sopimuksessa on toteutus — sitä ei pitäisi olla');
});

test('käsin annettu arvio merkitään käsin annetuksi', () => {
  const estimate = manualEstimate(25, { estimatedAt: '2026-09-11T08:00:00.000Z' });
  assert.equal(estimate.minutes, 25);
  assert.equal(estimate.source, TRAVEL_SOURCE.MANUAL);
  assert.equal(estimate.trafficIncluded, false);
});

test('kelvoton tai nollan arvio ei kelpaa', () => {
  assert.equal(manualEstimate(0), null);
  assert.equal(manualEstimate(-5), null);
  assert.equal(manualEstimate(null), null);
  assert.equal(manualEstimate('vartti'), null);
});

test('arvio katkaistaan vuorokauteen', () => {
  assert.equal(manualEstimate(99999).minutes, MAX_TRAVEL_MINUTES);
});

test('KRIITTINEN: tyhjä arvio nollaa keston kokonaan', () => {
  // Puolittain päivitetty suunnitelma näyttäisi tuoreelta vaikka luku
  // olisi vanha.
  const cleared = applyEstimate(plan(), null);
  assert.equal(cleared.travelMinutes, null);
  assert.equal(cleared.travelSource, TRAVEL_SOURCE.UNKNOWN);
  assert.equal(cleared.estimatedAt, null);
});

test('arvion liittäminen ei mutatoi alkuperäistä', () => {
  const original = plan({ travelMinutes: 25 });
  const updated = applyEstimate(original, manualEstimate(40));
  assert.equal(original.travelMinutes, 25);
  assert.equal(updated.travelMinutes, 40);
});

// =====================================================================
// KOORDINAATTEJA EI OLE
// =====================================================================

test('KRIITTINEN: suunnitelmassa ei ole koordinaattikenttiä', () => {
  const p = normalizeTravelPlan({
    id: 'p1', title: 'x', destination: 'Keskusta', arrivalTime: '10:00',
    lat: 62.89, lon: 27.68, latitude: 62.89, longitude: 27.68,
    coordinates: [62.89, 27.68], geo: 'point(62,27)', gps: '62,27'
  });

  for (const key of Object.keys(p)) {
    assert.equal(/lat|lon|coord|geo|gps|point/i.test(key), false,
      `matkasuunnitelmassa on koordinaattikenttä ${key}`);
  }
  assert.equal(JSON.stringify(p).includes('62.89'), false,
    'koordinaatti selvisi suunnitelmaan jonkin kentän kautta');
});

test('KRIITTINEN: sijaintisäännössä ei ole koordinaattikenttiä', () => {
  const rule = normalizeLocationRule({
    id: 'r1', place: 'Kauppa', lat: 62.89, lon: 27.68, radius: 200
  });

  for (const key of Object.keys(rule)) {
    assert.equal(/lat|lon|coord|geo|gps|radius/i.test(key), false,
      `sijaintisäännössä on koordinaattikenttä ${key}`);
  }
});

test('paikka on nimi eikä sitä geokoodata', () => {
  assert.equal(normalizeTravelPlan({ destination: '  Keskusta  ' }).destination,
    'Keskusta');
  assert.equal(normalizeLocationRule({ place: '  Kauppa  ' }).place, 'Kauppa');
});

// =====================================================================
// SIJAINTISÄÄNNÖT
// =====================================================================

test('KRIITTINEN: uusi sääntö on oletuksena pois päältä', () => {
  // Sijainti vaatii luvan, eikä lupaa oleteta.
  assert.equal(normalizeLocationRule({ place: 'Kauppa' }).active, false);
  assert.equal(normalizeLocationRule({ place: 'Kauppa', active: 'kyllä' }).active,
    false);
  assert.equal(normalizeLocationRule({ place: 'Kauppa', active: 1 }).active, false);
  assert.equal(normalizeLocationRule({ place: 'Kauppa', active: true }).active, true);
});

test('KRIITTINEN: pois päältä oleva sääntö ei täyty koskaan', () => {
  const rule = normalizeLocationRule({
    place: 'Kauppa', trigger: LOCATION_TRIGGER.ARRIVING, active: false
  });
  assert.equal(locationRuleMatches(rule, {
    currentPlace: 'Kauppa', previousPlace: 'Koti'
  }), false);
});

test('saapumissääntö täyttyy vain saavuttaessa', () => {
  const rule = normalizeLocationRule({
    place: 'Kauppa', trigger: LOCATION_TRIGGER.ARRIVING, active: true
  });

  assert.equal(locationRuleMatches(rule,
    { currentPlace: 'Kauppa', previousPlace: 'Koti' }), true);
  // Jo perillä oleminen ei ole saapumista — muuten sääntö laukeaisi
  // joka tarkistuksella niin kauan kuin käyttäjä on paikalla.
  assert.equal(locationRuleMatches(rule,
    { currentPlace: 'Kauppa', previousPlace: 'Kauppa' }), false);
});

test('lähtösääntö täyttyy vain lähdettäessä', () => {
  const rule = normalizeLocationRule({
    place: 'Toimisto', trigger: LOCATION_TRIGGER.LEAVING, active: true
  });

  assert.equal(locationRuleMatches(rule,
    { currentPlace: 'Koti', previousPlace: 'Toimisto' }), true);
  assert.equal(locationRuleMatches(rule,
    { currentPlace: 'Toimisto', previousPlace: 'Koti' }), false);
});

test('lähisääntö täyttyy lähellä olevien listasta', () => {
  const rule = normalizeLocationRule({
    place: 'Apteekki', trigger: LOCATION_TRIGGER.NEARBY, active: true
  });

  assert.equal(locationRuleMatches(rule, { nearbyPlaces: ['Apteekki', 'Kirjasto'] }),
    true);
  assert.equal(locationRuleMatches(rule, { nearbyPlaces: [] }), false);
  assert.equal(locationRuleMatches(rule, {}), false);
});

test('nimetön sääntö ei täyty', () => {
  const rule = normalizeLocationRule({ place: '   ', active: true });
  assert.equal(rule.place, null);
  assert.equal(locationRuleMatches(rule, { currentPlace: null }), false);
});

test('tuntematon laukaisin putoaa saapumiseen', () => {
  assert.equal(normalizeLocationRule({ place: 'x', trigger: 'teleportti' }).trigger,
    LOCATION_TRIGGER.ARRIVING);
});

test('laukaisimia on tasan kolme', () => {
  assert.equal(LOCATION_TRIGGERS.length, 3);
});

// =====================================================================
// VALIDOINTI JA PUSKURIT
// =====================================================================

test('matka ilman määränpäätä tai saapumisaikaa ei kelpaa', () => {
  const { valid, errors } = validateTravelPlan(normalizeTravelPlan({
    id: 'p1', title: 'x'
  }));
  assert.equal(valid, false);
  assert.ok(errors.destination);
  assert.ok(errors.arrivalTime);
});

test('nimetön matka ei kelpaa', () => {
  const { valid, errors } = validateTravelPlan(plan({ title: '  ' }));
  assert.equal(valid, false);
  assert.ok(errors.title);
});

test('tuntematon kesto EI ole validointivirhe', () => {
  // Suunnitelma ilman arviota on kelvollinen: se on juuri se tila,
  // jossa käyttäjä kirjaa matkan ennen kuin tietää kestoa.
  assert.equal(validateTravelPlan(plan({ travelMinutes: null })).valid, true);
});

test('jokaisella kulkutavalla on oletuspuskurit', () => {
  for (const mode of TRAVEL_MODES) {
    const buffers = DEFAULT_BUFFERS[mode];
    assert.ok(buffers, `kulkutavalta ${mode} puuttuvat puskurit`);
    assert.equal(typeof buffers.preparation, 'number');
    assert.equal(typeof buffers.arrival, 'number');
  }
});

test('autolla on suurempi perillepuskuri kuin kävellen', () => {
  // Pysäköinti vie aikaa; kävellen sitä ei ole.
  assert.ok(DEFAULT_BUFFERS[TRAVEL_MODE.DRIVING].arrival
    > DEFAULT_BUFFERS[TRAVEL_MODE.WALKING].arrival);
});

test('puskurit otetaan kulkutavan oletuksista kun niitä ei anneta', () => {
  const p = normalizeTravelPlan({
    id: 'p1', title: 'x', destination: 'y', arrivalTime: '10:00',
    mode: TRAVEL_MODE.WALKING
  });
  assert.equal(p.preparationMinutes, DEFAULT_BUFFERS[TRAVEL_MODE.WALKING].preparation);
  assert.equal(p.arrivalBufferMinutes, DEFAULT_BUFFERS[TRAVEL_MODE.WALKING].arrival);
});

test('nollapuskuri on eri asia kuin puuttuva puskuri', () => {
  const p = normalizeTravelPlan({
    id: 'p1', title: 'x', destination: 'y', arrivalTime: '10:00',
    preparationMinutes: 0
  });
  assert.equal(p.preparationMinutes, 0);
});

test('tuntematon kulkutapa putoaa autoiluun', () => {
  assert.equal(normalizeTravelPlan({ mode: 'raketti' }).mode, TRAVEL_MODE.DRIVING);
});

test('jokaisella kulkutavalla on suomenkielinen nimi', () => {
  for (const mode of TRAVEL_MODES) {
    const label = travelModeLabel(mode);
    assert.ok(label && label.length > 0, `kulkutavalta ${mode} puuttuu nimi`);
    assert.notEqual(label, mode, `kulkutavan ${mode} nimi on tunniste`);
  }
});

test('lähdelajeja on kolme ja tuntematon on yksi niistä', () => {
  assert.equal(TRAVEL_SOURCES.length, 3);
  assert.ok(TRAVEL_SOURCES.includes(TRAVEL_SOURCE.UNKNOWN));
});
