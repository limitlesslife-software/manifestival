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
  { name: 'Brain Dump: monirivinen kirjaus → monta saapuvaa riviä ilman päätöksiä; erä "Myöhemmin" → päivättömät tehtävät',
    run: ({ page }) => page(async () => {
      await H.openToday();
      const text = '- Soita Annalle\n2. Varaa hammaslääkäri; vie auto katsastukseen\n• osta maito\n\n- osta maito';
      H.fill('#captureInput', text);
      const before = H.db('inbox_items').length;
      H.click('#captureSendBtn');
      await H.waitFor(() => H.text('#captureStatus').includes('Kirjattu 4 asiaa saapuviin'), 'kirjauksen tila');
      if (H.shown('#capturePending') && H.text('#capturePending').includes('Tarkista tulkinta')) throw new Error('päätöskortti avautui kirjauksessa');
      const rows = await H.waitFor(() => { const all = H.db('inbox_items'); return all.length === before + 4 ? all : null; }, '4 riviä kantaan');
      await H.openTab('screen-tasks');
      H.click('#segmentInbox');
      await H.waitFor(() => H.el('#inboxSelectAll'), 'erä-käsittely');
      H.el('#inboxSelectAll').click();
      await H.waitFor(() => document.querySelectorAll('[data-triage-select]:checked').length === 4, 'kaikki valittu');
      document.querySelector('[data-triage="LATER"]').click();
      const tasks = await H.waitFor(() => {
        const created = H.db('tasks').filter(r => r.horizon === 'LATER' && r.date === null);
        return created.length === 4 ? created : null;
      }, '4 päivätöntä tehtävää');
      const open = H.s().inboxItems.filter(item => !['converted', 'dismissed'].includes(item.status)).length;
      return 'inbox_items +' + (rows.length - before) + ' (kaksoiskappale yhdistettiin); erä Myöhemmin → '
        + tasks.length + ' tehtävää date=null horizon=LATER; avoimia saapuvia ' + open;
    }) },

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
      document.querySelector('[data-td-action="replan-apply"]').click();
      await H.confirm(true, 'Muutetaanko päivän suunnitelmaa?');
      const moved = await H.waitFor(() => { const t = H.s().tasks.find(x => x.id === 'rest'); return t && t.date !== today ? t : null; }, 'siirto tehty');
      if (moved.date === tomorrow) throw new Error('siirtyi täydelle päivälle');
      if (moved.date === H.addDays(today, 2)) throw new Error('siirtyi lomalle');
      return 'ennen ' + target + ', siirtyi päivälle ' + moved.date + ' (ei täyttä huomista, ei lomaa); ' + text.slice(0, 80);
    }) }
];

L_SCENARIOS.push(
  { name: 'sunnuntain nollaus A–G ja kolme viikon prioriteettia: neljäs torjutaan, viikko suljetaan, loppuviesti on rauhoittava',
    run: ({ page }) => page(async () => {
      const today = H.today();
      window.__e2e.setTasks([
        { id: 'g1t', title: 'Juoksulenkki', date: H.addDays(today, 6), durationMinutes: 45 },
        { id: 'g2t', title: 'Kirjoita raportti', date: H.addDays(today, 7), durationMinutes: 90, deadline: H.addDays(today, 9) },
        { id: 'g3t', title: 'Siivoa varasto', horizon: 'THIS_WEEK', durationMinutes: 60 },
        { id: 'g4t', title: 'Soita isälle', date: H.addDays(today, 8), durationMinutes: 20 }
      ]);
      const reset = await import('/src/app/views/sundayReset.js');
      const opened = reset.openSundayReset({ fresh: true });
      if (!opened) throw new Error('nollaus ei avautunut');
      await H.waitFor(() => H.el('#sundayResetDialog').open, 'nollausikkuna auki');
      const primary = () => document.querySelector('#sundayResetCard [data-focus="primary"]');
      const step = () => reset.sundayResetSession().step;
      // A: brain dump ilman päätöksiä.
      await H.waitFor(() => H.el('#sundayResetDump'), 'vaihe A');
      H.fill('#sundayResetDump', 'Hanki lahja\nVaraa kampaaja');
      primary().click();
      await H.waitFor(() => step() !== 'dump', 'A -> B');
      // B ja C eteenpäin (saapuvat jäävät tallessa; kapasiteetti lasketaan jarrusta).
      for (const expected of ['sort', 'capacity']) {
        await H.waitFor(() => step() === expected, 'vaihe ' + expected);
        primary().click();
      }
      // D: enintään kolme prioriteettia.
      await H.waitFor(() => step() === 'priorities', 'vaihe D');
      const chips = [...document.querySelectorAll('[data-reset-priority]')];
      if (chips.length < 4) throw new Error('ehdokkaita vain ' + chips.length);
      for (const chip of chips.slice(0, 4)) { chip.click(); await H.sleep(30); }
      const chosen = reset.sundayResetSession().selected.length;
      if (chosen !== 3) throw new Error('valittu ' + chosen);
      const limit = H.squash(H.text('#sundayResetCard'));
      if (!limit.includes('Valitse enintään kolme')) throw new Error('rajan viesti puuttuu: ' + limit.slice(0, 120));
      primary().click();
      // E, F eteenpäin, G sulkee viikon.
      for (const expected of ['place', 'protect', 'close']) {
        await H.waitFor(() => step() === expected, 'vaihe ' + expected);
        primary().click();
      }
      const finalText = await H.waitFor(() => {
        const text = H.squash(H.text('#sundayResetCard'));
        return text.includes('Ensi viikko on suunniteltu.') ? text : null;
      }, 'loppuviesti');
      if (!finalText.includes('Sinun ei tarvitse miettiä sitä enää tänään.')) throw new Error('loppuviesti: ' + finalText);
      const plan = await H.waitFor(() => H.db('weekly_plans').find(r => r.closed_at), 'suljettu viikko kannassa');
      if ((plan.priorities || []).length !== 3) throw new Error('prioriteetteja kannassa ' + (plan.priorities || []).length);
      const dumped = H.db('inbox_items').filter(r => ['Hanki lahja', 'Varaa kampaaja'].includes(r.text)).length;
      document.querySelector('#sundayResetCard [data-reset="finish"]').click();
      return 'viikko ' + plan.week_start + ' suljettu (planned ' + plan.planned_minutes + ' min), 3 prioriteettia, '
        + 'neljäs torjuttu, brain dump ' + dumped + ' riviä, loppuviesti täsmälleen';
    }) }
);

L_SCENARIOS.push(
  { name: 'ajautuminen: jonon kasvu, vapaa-ajan kuluminen ja loman tunkeutuminen näkyvät säätöinä, ilman syyllistämistä',
    run: ({ page }) => page(async () => {
      const today = H.today();
      const created = new Date().toISOString();
      const monday = H.addDays(today, 1 - H.isoWeekday(today));
      const tasks = [];
      // Jonon kasvu: 18 uutta avointa asiaa viikon sisällä, ei ratkenneita.
      for (let n = 1; n <= 18; n += 1) tasks.push({ id: 'bg' + n, title: 'Uusi asia ' + n, horizon: 'LATER', createdAt: created });
      // Loman tunkeutuminen: joustava työ lomapäivälle (kiinteä meno ei ole tunkeutumista).
      const vacationDay = H.addDays(today, 3);
      tasks.push({ id: 'vi1', title: 'Joustava selvitys', date: vacationDay, durationMinutes: 60, createdAt: created });
      tasks.push({ id: 'vi2', title: 'Hammaslääkäri lomalla', date: vacationDay, time: '10:00', endTime: '10:30', createdAt: created });
      // Vapaa-ajan kuluminen: velvoite suojattuun iltaan.
      tasks.push({ id: 'fe1', title: 'Raportti illalla', date: today, time: '19:00', endTime: '20:30', deadline: today, createdAt: created });
      window.__e2e.setTasks(tasks);
      const actions = await import('/src/app/mentalLoadActions.js');
      for (const period of [...H.s().protectedPeriods]) await actions.deleteProtectedPeriod(period.id, { confirmed: true });
      await actions.saveVacation({ startDate: vacationDay, endDate: vacationDay });
      await actions.saveFreeTimeRules({ eveningWeekdays: [1, 2, 3, 4, 5, 6, 7], eveningFrom: '18:00', minimumMinutes: 600 });
      const alignment = await import('/src/app/alignment.js');
      if (alignment.resetDriftCacheForTests) alignment.resetDriftCacheForTests();
      const signals = alignment.currentDriftSignals(monday);
      const kinds = signals.map(signal => signal.kind);
      for (const kind of ['backlog_growth', 'free_time_erosion', 'vacation_intrusion']) {
        if (!kinds.includes(kind)) throw new Error('puuttuu ' + kind + ': ' + kinds.join(','));
      }
      const intrusion = signals.find(signal => signal.kind === 'vacation_intrusion');
      if ((intrusion.items || []).some(item => item.id === 'vi2')) throw new Error('kiinteä meno laskettiin tunkeutumiseksi');
      const copy = signals.map(signal => [signal.title, signal.reason, signal.adjustment && signal.adjustment.label].join(' ')).join(' ').toLowerCase();
      for (const word of ['epäonnistu', 'laiminl', 'huono', 'syy on sinun']) {
        if (copy.includes(word)) throw new Error('syyllistävä sana: ' + word);
      }
      if (signals.some(signal => !signal.adjustment || !signal.adjustment.label)) throw new Error('säätö puuttuu');
      await H.openTab('screen-direction');
      await H.sleep(200);
      const section = H.text('#screen-direction');
      const shown = section.includes('Suunnitelma ja todellisuus');
      return kinds.join(', ') + '; jokaisella säätö; kiinteä meno ei tunkeutumista; Suunnassa osio '
        + (shown ? 'näkyy' : 'ei näy (Suunnan aloitus kesken, havainnot laskettu samasta polusta)');
    }) }
);

// =====================================================================
// KUVAKAAPPAUKSET (valinnainen, E2E_SHOTS=1): visuaalinen tarkistus
// =====================================================================

const SHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tmp', 'wave-l-shots');

async function shot(cdp, name) {
  const fs = await import('node:fs');
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(SHOT_DIR, name + '.png');
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

const SHOT_SCENARIOS = [
  { name: 'kuvat: Tänään, Tallessa, Suojattu aika, Saapuvat ja sunnuntain nollaus',
    run: async ({ page, cdp }) => {
      await page(async () => {
        const today = H.today();
        window.__e2e.setTasks([
          ...[1, 2, 3, 4, 5].map(n => ({ id: 's' + n, title: 'Asia numero ' + n, date: today, durationMinutes: 25 })),
          { id: 'sf', title: 'Hammaslääkäri', date: today, time: '14:00', endTime: '15:00' },
          { id: 'sl', title: 'Maalaa aita', horizon: 'LATER' },
          { id: 'sw', title: 'Taloyhtiön vastaus', horizon: 'WAITING', waitingOn: 'Isännöitsijä' }
        ]);
        const actions = await import('/src/app/mentalLoadActions.js');
        await actions.saveProtectedPeriod({ kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [H.isoWeekday(today)],
          startTime: '18:00', endTime: '19:30', title: 'Kitara' });
        await H.openToday();
        window.scrollTo(0, 0);
        return true;
      });
      const files = [await shot(cdp, '01-tanaan')];
      await page(async () => { await H.openStored('THIS_WEEK'); window.scrollTo(0, 0); return true; });
      files.push(await shot(cdp, '02-tallessa'));
      await page(async () => { await H.profile('protected'); window.scrollTo(0, 0); return true; });
      files.push(await shot(cdp, '03-suojattu-aika'));
      await page(async () => {
        H.fill('#captureInput', 'Soita Annalle\nVaraa hammaslääkäri');
        await H.openToday();
        H.click('#captureSendBtn');
        await H.waitFor(() => H.text('#captureStatus').includes('Kirjattu'), 'kirjattu');
        await H.openTab('screen-tasks');
        H.click('#segmentInbox');
        await H.waitFor(() => H.el('#inboxSelectAll'), 'saapuvat');
        window.scrollTo(0, 0);
        return true;
      });
      files.push(await shot(cdp, '04-saapuvat'));
      await page(async () => {
        const reset = await import('/src/app/views/sundayReset.js');
        reset.openSundayReset({ fresh: true });
        await H.waitFor(() => H.el('#sundayResetDialog').open, 'nollaus');
        return true;
      });
      files.push(await shot(cdp, '05-sunnuntain-nollaus'));
      return files.map(file => path.basename(file)).join(', ');
    } }
];

export const GROUPS = Object.freeze([
  { key: 'closed', label: 'suljetut portit', query: { gates: 'closed', seed: 'empty', clock: wednesdayTen(), onboarding: 'skip' },
    scenarios: CLOSED_SCENARIOS },
  { key: 'L', label: 'aalto L', query: { gates: 'L', seed: 'empty', clock: wednesdayTen(), onboarding: 'skip' },
    scenarios: L_SCENARIOS },
  // Vain pyydettäessä (E2E_SHOTS=1 ja E2E_GROUPS=shots): kuvat tmp/wave-l-shots/.
  ...(process.env.E2E_SHOTS === '1'
    ? [{ key: 'shots', label: 'kuvat', query: { gates: 'L', seed: 'empty', clock: wednesdayTen(), onboarding: 'skip' },
      scenarios: SHOT_SCENARIOS }]
    : [])
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
