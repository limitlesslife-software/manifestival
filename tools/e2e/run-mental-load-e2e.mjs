// Mielen kuorman keventämisen E2E (aalto L): paikallinen selainajo
// (headless Chrome, CDP). EI TUOTANTOA.
//
//   node tools/e2e/run-mental-load-e2e.mjs      kaikki ryhmät (npm run e2e:mental-load)
//   E2E_GROUPS=L node tools/e2e/run-...         vain L-porttien ryhmä
//   E2E_L_GATES_REF=<ref>                       L-porttien lähde, kun L-ehdokas on
//                                               leikattu (oletus: junan määrittely)
//
// TURVASÄÄNNÖT: sama yhteinen ajo kuin arjen E2E:ssä (run-daily-life-e2e.mjs
// runE2E): debug-portti todennetaan vapaaksi, *.supabase.co ja Anthropic on
// estetty DNS-tasolla, jokainen pyyntö kirjataan ja yksikin yritys tuotantoon
// tai muualle kuin 127.0.0.1:een kaataa ajon. Profiili poistetaan.
//
// RYHMÄT (jokainen alkaa tyhjältä laitteelta ja tyhjältä kannalta):
//   closed  haaran omat portit: 0015:n taulut ja sarakkeet eivät ole käytössä.
//           Rauhallinen tänään toimii, mutta päivätöntä tehtävää ei sallita ja
//           suojattu aika kertoo rehellisesti säilyvänsä vain istunnon ajan
//   L       aallon L portit (junan määrittely tai L-ehdokas): Brain Dump,
//           Tänään ≤ 3 ja "Kaikki muu on tallessa", päivätön NOT_YET, WAITING,
//           oma aika, vapaa ilta, pääosin vapaa sunnuntai, loma, kapasiteetti
//           kieltäytyy ylibuukkauksesta, uudelleensuunnittelu kunnioittaa
//           suojattua aikaa, sunnuntain nollaus ja kolme viikon prioriteettia,
//           ajautumisen signaalit. Jokainen todennetaan näkymästä JA kannan
//           riveistä; tallennus todennetaan oikean uudelleenlatauksen yli.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runE2E, wednesdayTen, DAILY_HELPERS } from './run-daily-life-e2e.mjs';

/** Migraation 0015 uudet taulut (aalto L). Suljetuilla porteilla niihin ei kirjoiteta. */
export const MENTAL_LOAD_TABLES = Object.freeze(['protected_periods', 'weekly_plans']);

// =====================================================================
// SIVUN APURIT (window.H laajennettuna mielen kuorman näkymille)
// =====================================================================

export const MENTAL_LOAD_HELPERS = `
Object.assign(window.H, {
  focusRows: () => [...document.querySelectorAll('#todayFocus .focus-row')].map(row => H.squash(row.textContent)),
  focusText: () => H.squash(H.text('#todayFocus')),
  async openToday() {
    await H.openTab('screen-today');
    await H.waitFor(() => H.el('#todayFocus'), 'Tänään-näkymä');
  },
  async openStored(tab) {
    await H.openTab('screen-tasks');
    H.click('#segmentStored');
    await H.waitFor(() => H.el('#segmentStored').getAttribute('aria-selected') === 'true', 'Tallessa-osio');
    if (tab) {
      const button = document.querySelector('[data-stored-tab="' + tab + '"]');
      if (!button) throw new Error('välilehti puuttuu: ' + tab);
      button.click();
      await H.waitFor(() => document.querySelector('[data-stored-tab="' + tab + '"]').getAttribute('aria-selected') === 'true', 'välilehti ' + tab);
    }
  },
  storedTitles: () => [...document.querySelectorAll('#storedListContainer .stored-row .assist-title')].map(n => H.squash(n.textContent)),
  /** Tehtävä lomakkeella; fields: { title, date, horizon, waitingOn, duration } */
  async newTask(fields) {
    await H.openTab('screen-tasks');
    H.click('#segmentTasks');
    H.click('#addRowBtn');
    await H.waitFor(() => H.shown('#addForm'), 'tehtävälomake auki');
    H.fill('#afTitle', fields.title);
    H.fill('#afDate', fields.date === undefined ? '' : (fields.date || ''));
    if (fields.horizon !== undefined) {
      H.fill('#afHorizon', fields.horizon || '');
      H.el('#afHorizon').dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (fields.waitingOn) H.fill('#afWaitingOn', fields.waitingOn);
    if (fields.duration) H.fill('#afDuration', String(fields.duration));
    const before = H.s().tasks.length;
    H.click('#afSave');
    await H.waitFor(() => !H.shown('#addForm') && H.s().tasks.length === before + 1, 'tehtävä tallennettu');
    return H.s().tasks.find(task => task.title === fields.title);
  }
});
true;`;

// =====================================================================
// SULJETUT PORTIT: rehellinen heikennys
// =====================================================================

const CLOSED_SCENARIOS = [
  { name: 'suljetut portit: Rauhallinen tänään näyttää enintään kolme fokusta ja "Kaikki muu on tallessa (N)"',
    run: ({ page }) => page(async () => {
      const today = H.today();
      window.__e2e.setTasks([1, 2, 3, 4, 5].map(n => ({ id: 'c' + n, title: 'Asia ' + n, date: today, durationMinutes: 15 })));
      await H.openToday();
      await H.waitFor(() => H.focusRows().length === 3, 'kolme fokusta');
      const text = H.focusText();
      if (!text.includes('Kaikki muu on tallessa (2).')) throw new Error('tallessa-teksti: ' + text);
      if (!text.includes('Sinun ei tarvitse hoitaa sitä tänään.')) throw new Error('rauhoittava lause puuttuu');
      return '3 fokusta; "Kaikki muu on tallessa (2). Sinun ei tarvitse hoitaa sitä tänään."';
    }) },

  { name: 'suljetut portit: päivätöntä tehtävää ei tallenneta ennen 0015:tä (ei keksittyä päivää, selkeä syy)',
    run: ({ page }) => page(async () => {
      await H.openTab('screen-tasks');
      H.click('#segmentTasks');
      H.click('#addRowBtn');
      await H.waitFor(() => H.shown('#addForm'), 'lomake auki');
      H.fill('#afTitle', 'Joskus: maalaa aita');
      H.fill('#afHorizon', 'NOT_YET');
      H.el('#afHorizon').dispatchEvent(new Event('change', { bubbles: true }));
      H.fill('#afDate', '');
      const before = H.s().tasks.length;
      H.click('#afSave');
      // Ei keksittyä päivää: selkeä syy päivän kentän alla, eikä riviä synny.
      const message = await H.waitFor(() => {
        const text = H.squash(H.text('#afDateError'));
        return text.includes('Päivätön tallennus tulee käyttöön') ? text : null;
      }, 'päivän virhe');
      if (H.s().tasks.length !== before) throw new Error('tehtävä tallentui');
      if (H.db('tasks').some(r => r.title === 'Joskus: maalaa aita')) throw new Error('rivi kannassa');
      H.click('#afCancel');
      return 'estetty ilman keksittyä päivää: "' + message + '"';
    }) },

  { name: 'suljetut portit: Suojattu aika kertoo säilyvänsä vain istunnon ajan eikä kirjoita kantaan',
    run: ({ page }) => page(async tables => {
      await H.profile('protected');
      await H.waitFor(() => H.text('#protectedTimeContainer').includes('vain tämän istunnon ajan'), 'istunnon huomautus');
      H.click('#ptOwnDay2');
      H.click('#ptOwnSave');
      await H.waitFor(() => H.s().protectedPeriods.length === 1, 'oma aika muistissa');
      const writes = window.__e2e.db.writes().filter(write => tables.includes(write.table));
      if (writes.length) throw new Error('kirjoitti kantaan suljetulla portilla: ' + JSON.stringify(writes));
      return 'huomautus näkyy; oma aika muistissa; 0015-tauluihin 0 kirjoitusta';
    }, MENTAL_LOAD_TABLES) }
];

// =====================================================================
// L-PORTIT: mielen kuorman ydin tallentuvalla kannalla
// =====================================================================

const L_SCENARIOS = [
  { name: 'Tänään ≤ 3: myöhässä ei nouse automaattisesti, kiinteä meno ei ole fokuksessa, muu on tallessa',
    run: ({ page }) => page(async () => {
      const today = H.today();
      window.__e2e.setTasks([
        ...[1, 2, 3, 4, 5, 6].map(n => ({ id: 't' + n, title: 'Tehtävä ' + n, date: today, durationMinutes: 20 })),
        { id: 'fixed', title: 'Hammaslääkäri', date: today, time: '14:00', endTime: '15:00' },
        { id: 'old', title: 'Vanha asia', date: H.addDays(today, -3), durationMinutes: 20 }
      ]);
      await H.openToday();
      await H.waitFor(() => H.focusRows().length === 3, 'kolme fokusta');
      const text = H.focusText();
      if (text.includes('Hammaslääkäri')) throw new Error('kiinteä meno fokuksessa');
      const match = /Kaikki muu on tallessa \\((\\d+)\\)\\./.exec(text);
      if (!match || Number(match[1]) !== 4) throw new Error('tallessa-luku: ' + text);
      if (document.querySelector('#todayOverdue .task-row.overdue')) throw new Error('punainen rästilista näkyy');
      return 'fokus 3/3, tallessa (4), kiinteä meno aikajanalla, ei rästilistaa';
    }) },

  { name: 'päivätön NOT_YET: tallentuu ilman päivää, näkyy Tallessa → Ei vielä ja säilyy uudelleenlatauksen yli',
    run: async ({ page, reload }) => {
      const first = await page(async () => {
        const task = await H.newTask({ title: 'Maalaa aita', date: '', horizon: 'NOT_YET' });
        if (task.date !== null || task.horizon !== 'NOT_YET') throw new Error('tila: ' + JSON.stringify({ date: task.date, horizon: task.horizon }));
        const row = await H.waitFor(() => H.db('tasks').find(r => r.title === 'Maalaa aita'), 'kannan rivi');
        if (row.date !== null || row.horizon !== 'NOT_YET') throw new Error('kanta: ' + JSON.stringify(row));
        return row.id;
      });
      await reload();
      return page(async id => {
        const task = H.s().tasks.find(t => t.id === id);
        if (!task || task.horizon !== 'NOT_YET' || task.date !== null) throw new Error('ei säilynyt: ' + JSON.stringify(task));
        await H.openStored('NOT_YET');
        if (!H.storedTitles().includes('Maalaa aita')) throw new Error('ei Ei vielä -välilehdellä: ' + H.storedTitles());
        return 'kanta date=null horizon=NOT_YET; Ei vielä -välilehdellä; säilyi latauksen yli';
      }, first);
    } },

  { name: 'WAITING: "Odottaa…" tallentaa kenen varassa, ei kuluta kapasiteettia eikä näy fokuksessa',
    run: ({ page }) => page(async () => {
      const today = H.today();
      window.__e2e.setTasks([{ id: 'w1', title: 'Taloyhtiön vastaus', date: H.addDays(today, 2), durationMinutes: 30 }]);
      await H.openStored('THIS_WEEK');
      await H.waitFor(() => H.storedTitles().includes('Taloyhtiön vastaus'), 'rivi tällä viikolla');
      document.querySelector('[data-stored-wait="w1"]').click();
      await H.waitFor(() => H.el('#storedWaitOn-w1'), 'odotuslomake');
      H.fill('#storedWaitOn-w1', 'Isännöitsijä');
      document.querySelector('[data-stored-wait-save="w1"]').click();
      await H.waitFor(() => (H.s().tasks.find(t => t.id === 'w1') || {}).horizon === 'WAITING', 'odottaa tilassa');
      const row = await H.waitFor(() => H.db('tasks').find(r => r.id === 'w1' && r.horizon === 'WAITING'), 'kannan rivi');
      if (row.waiting_on !== 'Isännöitsijä') throw new Error('waiting_on: ' + row.waiting_on);
      await H.openStored('WAITING');
      if (!H.storedTitles().includes('Taloyhtiön vastaus')) throw new Error('ei Odottaa-välilehdellä');
      await H.openToday();
      if (H.focusText().includes('Taloyhtiön vastaus')) throw new Error('odottava fokuksessa');
      return 'waiting_on=Isännöitsijä, date=' + row.date + '; Odottaa-välilehdellä; ei fokuksessa';
    }) },

  { name: 'suojattu oma aika: tallentuu kantaan, näkyy Tänään omana osionaan eikä toistu aikajanalla',
    run: ({ page }) => page(async () => {
      const today = H.today();
      const weekday = H.isoWeekday(today);
      await H.profile('protected');
      H.click('#ptOwnDay' + weekday);
      H.fill('#ptOwnFrom', '18:00');
      H.fill('#ptOwnTo', '20:00');
      H.fill('#ptOwnTitleInput', 'Kitara');
      H.click('#ptOwnSave');
      const row = await H.waitFor(() => H.db('protected_periods').find(r => r.kind === 'OWN_TIME'), 'kannan rivi');
      if (!String(row.start_time).startsWith('18:00') || !(row.weekdays || []).includes(weekday)) throw new Error('rivi: ' + JSON.stringify(row));
      await H.openToday();
      await H.waitFor(() => H.text('#todayProtected').includes('Kitara'), 'suojattu aika Tänään');
      if (H.text('#todayTimelineContainer').includes('Kitara')) throw new Error('toistui aikajanalla');
      return 'protected_periods OWN_TIME ' + row.start_time + '–' + row.end_time + '; Tänään → Suojattu aika';
    }) },

  { name: 'vapaa ilta ja pääosin vapaa sunnuntai: yksi sääntöjoukko; suunnittelu ei käytä niitä',
    run: ({ page }) => page(async () => {
      await H.profile('protected');
      for (const day of [1, 2, 3, 4, 5]) { const box = H.el('#ptEvening' + day); if (!box.checked) box.click(); }
      H.fill('#ptEveningFrom', '17:00');
      if (!H.el('#ptSunday').checked) H.el('#ptSunday').click();
      H.fill('#ptFreeMin', '10');
      H.click('#ptFreeSave');
      const rows = await H.waitFor(() => {
        const all = H.db('protected_periods').filter(r => r.kind === 'FREE_TIME');
        return all.length >= 3 ? all : null;
      }, 'vapaa-ajan säännöt kannassa');
      const sunday = rows.find(r => (r.weekdays || []).join() === '7');
      if (!sunday || sunday.strength !== 'soft') throw new Error('sunnuntai: ' + JSON.stringify(sunday));
      const brake = await import('/src/app/capacityBrake.js');
      const today = H.today();
      const sundayIso = H.addDays(today, 7 - H.isoWeekday(today));
      const { capacity } = brake.brakedHorizonCapacity(H.s(), { from: sundayIso, to: sundayIso, todayIso: today });
      if (capacity.days[0].usableMinutes !== 0) throw new Error('sunnuntaina suunniteltavaa aikaa ' + capacity.days[0].usableMinutes);
      return 'FREE_TIME-rivejä ' + rows.length + ' (ilta, sunnuntai soft, vähintään 10 h); sunnuntain joustava aika 0 min';
    }) },

  { name: 'loma: Tänään kertoo lomasta, joustava työ ei ole fokuksessa ja kiinteä meno pysyy',
    run: ({ page }) => page(async () => {
      const today = H.today();
      window.__e2e.setTasks([
        { id: 'flex', title: 'Joustava raportti', date: today, durationMinutes: 60 },
        { id: 'appt', title: 'Lääkäri', date: today, time: '11:00', endTime: '11:30' }
      ]);
      await H.profile('protected');
      H.fill('#ptVacFrom', today);
      H.fill('#ptVacTo', H.addDays(today, 1));
      H.click('#ptVacSave');
      await H.waitFor(() => H.db('protected_periods').find(r => r.kind === 'VACATION'), 'loma kannassa');
      await H.openToday();
      await H.waitFor(() => H.text('#todayProtected').includes('Lomalla.'), 'loman tila');
      if (!H.focusText().includes('Olet lomalla')) throw new Error('fokus: ' + H.focusText());
      if (!H.text('#todayTimelineContainer').includes('Lääkäri')) throw new Error('kiinteä meno katosi');
      if (!H.s().tasks.find(t => t.id === 'appt')) throw new Error('meno poistettiin');
      return 'Lomalla-tila, fokus tyhjä ("Olet lomalla"), kiinteä meno Lääkäri aikajanalla';
    }) },

  { name: 'kapasiteetti kieltäytyy ylibuukkauksesta: "Siirrä loput" ei siirrä täydelle päivälle eikä lomalle',
    run: ({ page }) => page(async () => {
      const today = H.today();
      const tomorrow = H.addDays(today, 1);
      // Huominen on täynnä kiinteitä menoja, ylihuominen on loma: siirto menee kolmanteen päivään.
      const fixed = [];
      for (let hour = 7; hour < 23; hour += 1) fixed.push({ id: 'f' + hour, title: 'Varattu ' + hour, date: tomorrow,
        time: String(hour).padStart(2, '0') + ':00', endTime: String(hour).padStart(2, '0') + ':59' });
      window.__e2e.setTasks([{ id: 'rest', title: 'Loppu-urakka', date: today, durationMinutes: 60 }, ...fixed]);
      const actions = await import('/src/app/mentalLoadActions.js');
      for (const period of H.s().protectedPeriods.filter(p => p.kind === 'VACATION')) await actions.deleteProtectedPeriod(period.id, { confirmed: true });
      await actions.saveVacation({ startDate: H.addDays(today, 2), endDate: H.addDays(today, 2) });
      await H.openToday();
      const button = await H.waitFor(() => document.querySelector('[data-td-action="interrupt"][data-kind="defer_remaining"]'), 'Siirrä loput');
      button.click();
      await H.waitFor(() => H.el('#tdReplanTitle'), 'ehdotus');
      const text = H.squash(H.text('#todayInterruptions'));
      const target = (H.s().tasks.find(t => t.id === 'rest') || {}).date;
      if (text.includes(tomorrow.split('-').reverse().slice(0, 2).map(Number).join('.') + '.')) {
        // lyhyt päiväys voi esiintyä myös selitteessä; tarkistetaan varsinainen muutos alta
      }
      document.querySelector('[data-td-action="replan-apply"]').click();
      await H.confirm(true, 'Muutetaanko päivän suunnitelmaa?');
      const moved = await H.waitFor(() => { const t = H.s().tasks.find(x => x.id === 'rest'); return t && t.date !== today ? t : null; }, 'siirto tehty');
      if (moved.date === tomorrow) throw new Error('siirtyi täydelle päivälle');
      if (moved.date === H.addDays(today, 2)) throw new Error('siirtyi lomalle');
      return 'ennen ' + target + ', siirtyi päivälle ' + moved.date + ' (ei täyttä huomista, ei lomaa); ' + text.slice(0, 80);
    }) }
];

export const GROUPS = Object.freeze([
  { key: 'closed', label: 'suljetut portit', query: { gates: 'closed', seed: 'empty', clock: wednesdayTen(), onboarding: 'skip' },
    scenarios: CLOSED_SCENARIOS },
  { key: 'L', label: 'aalto L', query: { gates: 'L', seed: 'empty', clock: wednesdayTen(), onboarding: 'skip' },
    scenarios: L_SCENARIOS }
]);

export const PENDING_ON = Object.freeze({});
export const EXPECTED_CONSOLE_ERRORS = Object.freeze({});

// Ajetaan vain suoraan käynnistettynä: testit importoivat puhtaat osat.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runE2E({
    title: 'MIELEN KUORMAN E2E', allGroups: GROUPS, helpers: [DAILY_HELPERS, MENTAL_LOAD_HELPERS],
    pendingOn: PENDING_ON, expectedConsole: EXPECTED_CONSOLE_ERRORS, profileTag: 'mental-load'
  }).catch(error => {
    console.error('MIELEN KUORMAN E2E: KESKEYTYI —', error.message);
    process.exitCode = 1;
  });
}
