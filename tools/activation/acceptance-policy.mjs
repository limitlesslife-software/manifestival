// Aktivoinnin hyväksyntäpolitiikka (omistajan päätös 2026-09-26, sitova).
//
// MITÄ TÄMÄ ON
//
// Historiallisten aaltojen käsin tehtävä selain- ja laitehyväksyntä
// SIIRTYY OIKEAAN KÄYTTÖÖN eikä pysäytä junaa. Aalto hyväksytään junan
// kannalta tilaan AUTOMATED_TECHNICAL_ACCEPTANCE, kun jokainen
// TECHNICAL_REQUIREMENTS-ehto täyttyy ja tulos on kirjattu paikalliseen
// päiväkirjaan (.claude/activation/journal.jsonl). Käyttöliittymän ja
// laitteen käytös on LIVE_USE_VALIDATION_PENDING: sitä EI KOSKAAN kutsuta
// PASSiksi, eikä se estä junaa.
//
// Omistajan hyväksyntä vaaditaan edelleen VAIN näille:
//
//   - jokainen tuotantomigraatio 0009–0013 (0010 erikseen + varmuuskopio)
//   - jokainen tuotantodeploy D–J
//   - valinnainen T-2-varmuuskopion kuivaharjoitus tuotannossa
//   - AI-selityksen käyttöönotto
//   - Androidin versionCode-politiikka
//
// Dokumentti: docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md. Tämä
// moduuli on sen koneellinen puoli: orkestroija, dry-run ja
// production:verify-assets --record-acceptance lukevat sen.
//
// Ei I/O:ta: puhtaita funktioita ja vakioita.

import { createHash } from 'node:crypto';

import { TRAIN_FLOOR_WAVE, waveById } from '../release/waves.mjs';

export const POLICY_DOC = 'docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md';
export const FAST_ACTIVATION_DOC = 'docs/SUUNTA-FAST-ACTIVATION.md';

export const TECHNICAL_ACCEPTANCE = 'AUTOMATED_TECHNICAL_ACCEPTANCE';
export const LIVE_USE_PENDING = 'LIVE_USE_VALIDATION_PENDING';

/** Omistajan HYVÄKSYNNÄT: vain nämä kuuluvat REQUIRED_OWNER_GATE-kenttään. */
export const OWNER_APPROVAL = Object.freeze({
  DEPLOY: 'OWNER_DEPLOY_APPROVAL_REQUIRED',
  MIGRATION: 'OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED'
});

/** Omistajan SYÖTE (vain lukeva SQL ja sen tulos) — ei hyväksyntä. */
export const OWNER_INPUT = Object.freeze({ READ_ONLY_SQL: 'OWNER_READ_ONLY_SQL_REQUIRED' });

/** Koneelliset portit: Claude hoitaa, omistajaa ei tarvita. */
export const TECHNICAL_GATE = Object.freeze({
  ACCEPTANCE: 'TECHNICAL_ACCEPTANCE_REQUIRED',
  CANDIDATE_TESTS: 'CANDIDATE_TESTS_REQUIRED'
});

/** Portin laji: 'OWNER_APPROVAL' | 'OWNER_INPUT' | 'TECHNICAL'. */
export function gateKind(gateClass) {
  if (Object.values(OWNER_APPROVAL).includes(gateClass)) return 'OWNER_APPROVAL';
  if (Object.values(OWNER_INPUT).includes(gateClass)) return 'OWNER_INPUT';
  return 'TECHNICAL';
}

/**
 * Omistajan lyhyt hyväksyntäviesti, joka avaa aallon: D -> "hyväksyn D",
 * F -> "hyväksyn 0009/F". Migraatioaallon viesti kattaa migraation JA
 * deployn (deploy vasta, kun verify_00XX = 0 poikkeavaa).
 */
export function ownerMessageFor(wave) {
  const meta = waveById(wave);
  if (!meta || wave === 'BASE') return null;
  return meta.migration ? `hyväksyn ${meta.migration}/${wave}` : `hyväksyn ${wave}`;
}

/**
 * AUTOMATED_TECHNICAL_ACCEPTANCE:n ehdot. Jokainen kirjataan
 * päiväkirjariviin (`checks`), ja jokaisen on täytyttävä.
 */
export const TECHNICAL_REQUIREMENTS = Object.freeze([
  Object.freeze({ id: 'ancestry', label: 'oikea sukulinja: fast-forward tuotannosta (lukon deployTarget)' }),
  Object.freeze({ id: 'migrationPrerequisite', label: 'migraatioedellytys täyttyy (inventaario; kanta tukee aaltoa)' }),
  Object.freeze({ id: 'candidateTests', label: 'ehdokkaan oma täysi testipatteristo vihreä (kirjattu päiväkirjaan)' }),
  Object.freeze({ id: 'security', label: 'tietoturva: ei AI-avaimia, ei palvelinroolin avainta selaimen koodissa (git grep)' }),
  Object.freeze({ id: 'repoPreflight', label: 'julkaisun esitarkistus (repoChecks) PASS' }),
  Object.freeze({ id: 'migrationVerify', label: 'verify_00XX.sql = 0 poikkeavaa (migraatioaallot)' }),
  Object.freeze({ id: 'liveAssets', label: 'tuotannon staattiset tiedostot = ehdokkaan SHA:n sormenjälki' }),
  Object.freeze({ id: 'cacheAndGates', label: 'välimuisti, porttimatriisi ja sarakeportit vastaavat aaltoa' })
]);

/**
 * Aalto, jonka tekninen hyväksyntä saa perustua pelkkään live-todennukseen
 * ilman kirjattua testiajoa: C deployattiin ennen aktivointityökaluja.
 */
export const PRE_TOOLING_WAVE = TRAIN_FLOOR_WAVE;

/**
 * Käyttötodennus (LIVE_USE_VALIDATION_PENDING): aaltokohtaiset käsin
 * tehtävät tarkistukset tiivistettynä. Tiedoksi — EI estä junaa eikä ole
 * koskaan PASS. Täysi lista on `doc`-dokumentin kohdassa
 * "Selainhyväksyntä".
 */
export const LIVE_USE_VALIDATION = Object.freeze({
  C: Object.freeze({
    doc: 'docs/acceptance/WAVE-C-OWNER-ACCEPTANCE.md',
    items: Object.freeze([
      'rutiinin luonti (valitut päivät, kellonaika, kesto), muokkaus ja kytkin säilyvät F5:n yli',
      '"Ohita" tämän päivän rutiiniesiintymälle säilyy F5:n yli',
      'aallot A–B: tavoite, projekti, muistutusasetus ja hyvinvointimerkintä säilyvät',
      'selaimen konsolissa ei punaisia virheitä'
    ])
  }),
  D: Object.freeze({
    doc: 'docs/acceptance/WAVE-D.md',
    items: Object.freeze([
      'toistuva meno, lasku ja säästötavoite säilyvät F5:n yli',
      'summa senttiylleen (12,34 -> 1234), pilkku ja piste käyvät, kolme desimaalia hylätään näkyvästi',
      'toistuvan menon poisto jättää laskun (liitos tyhjenee); laskuja ei synny itsestään'
    ])
  }),
  E: Object.freeze({
    doc: 'docs/acceptance/WAVE-E.md',
    items: Object.freeze([
      'sovellus latautuu, konsolissa ei ai_action_audit-virheitä',
      'aaltojen A–D ominaisuudet toimivat yhä; ai_action_audit pysyy tyhjänä'
    ])
  }),
  F: Object.freeze({
    doc: 'docs/acceptance/WAVE-F.md',
    items: Object.freeze([
      'tapahtuma (meno, tulo) säilyy F5:n yli; muokkaus ja poisto toimivat',
      'maksettu lasku tuottaa yhden tapahtuman, eikä uusi merkintä tuota toista',
      'kuitin luenta on ehdotus, ei tallennu ennen hyväksyntää; kuva ei mene Supabaseen',
      'skannattu lasku syntyy avoimena; sijoitus ilman arvoa on tuntematon, ei nolla'
    ])
  }),
  G: Object.freeze({
    doc: 'docs/acceptance/WAVE-G.md',
    items: Object.freeze([
      'tavoitteen, projektin ja tehtävän tallennus toimii; vanhat rivit ennallaan',
      'välitavoite: luonti, järjestys, saavutus; poisto säilyttää tehtävät',
      'mittaritavoite ja Ylläpidossa-tila säilyvät F5:n yli',
      'suunnitelmaehdotus ei tallennu ennen hyväksyntää; kaksoishyväksyntä luo yhden suunnitelman'
    ])
  }),
  H: Object.freeze({
    doc: 'docs/acceptance/WAVE-H.md',
    items: Object.freeze([
      'kirjaus Saapuviin on ehdotus; hylkäys ei luo mitään; kaksoishyväksyntä luo yhden tehtävän',
      'torkku ei muuta määräaikaa; kohteen poisto peruu muistutuksen näkyvästi',
      'matka ilman kestoa näyttää tuntemattoman lähtöajan; paikkasääntö on oletuksena pois'
    ])
  }),
  I: Object.freeze({
    doc: 'docs/acceptance/WAVE-I.md',
    items: Object.freeze([
      'vanha tavoite tallentuu yhä (sarakeportti)',
      'elämänalue, viikkokapasiteetti ja Kuormitus-havainto; arvioimaton tehtävä ei ole nolla',
      'aikakirjaus säilyy alueen poistossa; viikkokatsaus tallentuu'
    ])
  }),
  J: Object.freeze({
    doc: 'docs/acceptance/WAVE-J.md',
    items: Object.freeze([
      'ajastin jatkuu F5:n yli; toinen laite ei käynnistä toista; kaksoisnapautus ei tuota kahta riviä',
      'kuormittavuus ja energiaraja säilyvät; "Selitä tekoälyllä" -painiketta ei ole',
      'Day 1 puhelimella (docs/SUUNTA-DAY1-ACCEPTANCE.md) — APK vasta kun verify_0013 = 0 ja J on tuotannossa'
    ])
  })
});

/**
 * Viimeisin päiväkirjarivi, joka hyväksyy aallon `wave` TÄSMÄLLEEN
 * commitissa `sha` (tyyppi 'technical-acceptance' tai onnistunut
 * 'deploy'). Muun commitin hyväksyntä ei kelpaa (fail closed).
 */
export function technicalAcceptanceOf(entries, { wave, sha }) {
  if (!wave || !sha) return null;
  const hits = (entries || []).filter(e => e && e.result === TECHNICAL_ACCEPTANCE
    && (e.type === 'technical-acceptance' || e.type === 'deploy')
    && e.wave === wave && e.sha === sha);
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * Ehdokkaan testiajon kirjaus: viimeisin 'candidate-tests'-rivi tälle
 * commitille. `ok` vain, jos se on vihreä (fail 0, cancelled 0, pass > 0).
 */
export function candidateTestsOf(entries, { wave, sha }) {
  const hits = (entries || []).filter(e => e && e.type === 'candidate-tests' && e.wave === wave && e.sha === sha);
  const entry = hits.length ? hits[hits.length - 1] : null;
  return { entry, ok: Boolean(entry && testSummaryGreen(entry)) };
}

/** Onko testiyhteenveto vihreä? */
export function testSummaryGreen(summary) {
  return Boolean(summary)
    && Number(summary.tests) > 0 && Number(summary.pass) > 0
    && Number(summary.fail) === 0 && Number(summary.cancelled || 0) === 0;
}

/**
 * `node --test` -ajon yhteenveto tekstistä (spec-raportoija "ℹ pass 12"
 * tai TAP "# pass 12"). Viimeinen esiintymä voittaa. null, jos
 * yhteenvetoa ei löydy (fail closed: ei arvata).
 */
export function parseTestSummary(text) {
  const summary = {};
  for (const m of String(text || '').matchAll(/^[ \t]*(?:ℹ|#)[ \t]*(tests|suites|pass|fail|cancelled|skipped|todo)[ \t]+(\d+)[ \t]*\r?$/gm)) {
    summary[m[1]] = Number(m[2]);
  }
  if (!('tests' in summary) || !('pass' in summary) || !('fail' in summary)) return null;
  return {
    tests: summary.tests, pass: summary.pass, fail: summary.fail,
    cancelled: summary.cancelled ?? 0, skipped: summary.skipped ?? 0, todo: summary.todo ?? 0,
    sha256: createHash('sha256').update(String(text)).digest('hex')
  };
}
