// Testit sille, että PUHUTTU ja KIRJOITETTU komento kulkevat TÄSMÄLLEEN
// saman putken läpi (src/app/voice.js runVoiceCommand ->
// src/app/commandBar.js runTypedCommand), ja että ehdotus ja sen
// suoritus eivät koskaan käytä vanhentunutta kohdetta.
//
// EI DOM:IA. voice.js:n oma DOM-sovitus (mikrofoni, tilasiirtymät) ei ole
// yksikkötestattavissa ilman selainta -- se on tarkoituksella niin ohut,
// ettei siinä ole mitään testattavaa logiikkaa: kaikki päätökset tehdään
// tässä testatussa runVoiceCommand()/runTypedCommand()-parissa.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { clearLocalUserData, createBill } from '../src/app/actions.js';
import { resetState, getState, setTasks } from '../src/app/state.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { normalizeTask } from '../src/domain/task.js';

import { runTypedCommand } from '../src/app/commandBar.js';
import { runVoiceCommand } from '../src/app/voice.js';

const USER = { id: 'aaaaaaaa-7777-0000-0000-000000000007', email: 'v@example.com' };

function fetchReturning(text) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] })
  });
}

/** Sama kutsu kuin fetchReturning, mutta tallentaa nähdyn pyyntörungon. */
function fetchCapturing(text, seen) {
  return async (url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }) };
  };
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

// =====================================================================
// YKSI PUTKI: puhe ja teksti suorittavat saman komennon samalla tavalla
// =====================================================================

test('KRIITTINEN: puheen source-kenttä kulkee palvelinpyyntöön asti', async () => {
  const seen = [];
  await runVoiceCommand('näytä ensi viikko', {
    fetchImpl: fetchCapturing('{"intent":"show_week_plan","date":"2026-09-25"}', seen),
    confirmFn: async () => true,
    chooseFn: async () => null
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, 'voice');
});

test('KRIITTINEN: tekstin source-kenttä pysyy tekstinä', async () => {
  const seen = [];
  await runTypedCommand('näytä ensi viikko', {
    fetchImpl: fetchCapturing('{"intent":"show_week_plan","date":"2026-09-25"}', seen),
    confirmFn: async () => true,
    chooseFn: async () => null
  });
  assert.equal(seen[0].source, 'text');
});

test('KRIITTINEN: puhuttu ja kirjoitettu luontikomento tuottavat identtisen rivin', async () => {
  const json = '{"intent":"create_task","title":"Osta maitoa","date":"2026-09-19"}';

  await runVoiceCommand('luo tehtävä ostaa maitoa', {
    fetchImpl: fetchReturning(json),
    confirmFn: async () => true,
    chooseFn: async () => null
  });
  const viaVoice = getState().tasks[0];

  resetState();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));

  await runTypedCommand('luo tehtävä ostaa maitoa', {
    fetchImpl: fetchReturning(json),
    confirmFn: async () => true,
    chooseFn: async () => null
  });
  const viaText = getState().tasks[0];

  assert.equal(viaVoice.title, viaText.title);
  assert.equal(viaVoice.date, viaText.date);
});

test('KRIITTINEN: puheella tehty KORKEAN riskin poisto vaatii saman vahvistuksen kuin tekstillä', async () => {
  setTasks([normalizeTask({ id: 't1', title: 'Lääkärimuistutus', date: '2026-09-25' })]);

  let confirmSeenPreview = null;
  const result = await runVoiceCommand('poista ensi viikon lääkärimuistutus', {
    fetchImpl: fetchReturning('{"intent":"delete_task","targetName":"Lääkärimuistutus"}'),
    confirmFn: async proposal => { confirmSeenPreview = proposal.preview; return false; },
    chooseFn: async () => null
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'cancelled', 'peruttu vahvistus ei saa suorittaa poistoa');
  assert.equal(getState().tasks.length, 1, 'tehtävä säilyy kun vahvistus peruutetaan');
  assert.ok(confirmSeenPreview, 'käyttäjän piti nähdä esikatselu ennen päätöstä');
  assert.equal(confirmSeenPreview.destructive, true,
    'peruuttamaton vaikutus pitää merkitä näkyvästi');
  assert.equal(confirmSeenPreview.targetLabel, 'Lääkärimuistutus',
    'ratkaistu kohde pitää näyttää, ei vain raakatekstiä');
});

// HUOM. Hyväksytyn poiston TOTEUTUS ei ole tässä testattavissa: deleteTask()
// kysyy OMAN vahvistuksensa ui/confirm.js:stä, joka vaatii oikean DOM:in
// (ks. tests/ai-command-handlers.test.mjs, kommentti tiedoston alussa;
// wiring todistetaan lähdetekstistä tests/security-invariants.test.mjs:ssä).

test('puheella epäselvä kohde näyttää saman valitsimen kuin tekstillä', async () => {
  setTasks([
    normalizeTask({ id: 'a', title: 'Lääkäriaika', date: '2026-09-20' }),
    normalizeTask({ id: 'b', title: 'Lääkäriaika', date: '2026-09-27' })
  ]);

  let seenCandidates = null;
  const result = await runVoiceCommand('siirrä lääkäriaika perjantaille', {
    fetchImpl: fetchReturning('{"intent":"reschedule_task","targetName":"Lääkäriaika","date":"2026-09-25"}'),
    confirmFn: async () => true,
    chooseFn: async candidates => { seenCandidates = candidates; return candidates.find(c => c.id === 'b'); }
  });

  assert.equal(result.ok, true);
  assert.equal(seenCandidates.length, 2);
  assert.equal(getState().tasks.find(t => t.id === 'b').date, '2026-09-25');
  assert.equal(getState().tasks.find(t => t.id === 'a').date, '2026-09-20', 'ei-valittu rivi koskematon');
});

// =====================================================================
// KOMENNON SAMANAIKAISUUS: kohde ei saa olla vanhentunut suoritushetkellä
// =====================================================================

test('KRIITTINEN: kohde joka poistettiin ehdotuksen JÄLKEEN ei suorita vanhentunutta mutaatiota', async () => {
  setTasks([normalizeTask({ id: 't1', title: 'Hammaslääkäri', date: '2026-09-20', time: '10:00' })]);

  const result = await runTypedCommand('siirrä hammaslääkäri kahdella tunnilla', {
    fetchImpl: fetchReturning('{"intent":"reschedule_task","targetName":"Hammaslääkäri","shiftMinutes":120}'),
    // Vahvistuksen AIKANA (simuloitu tässä confirmFn:n sisällä) toinen
    // toiminto -- käyttäjä itse, toinen välilehti tai resync -- poistaa
    // rivin ennen kuin käyttäjä ehtii hyväksyä.
    confirmFn: async () => { setTasks([]); return true; },
    chooseFn: async () => null
  });

  assert.equal(result.ok, false, 'kadonneelle kohteelle ei saa suorittaa mutaatiota');
  assert.equal(getState().tasks.length, 0);
});

test('KRIITTINEN: siirto lasketaan TUOREESTA ajasta, ei ehdotushetken jäädytetystä kopiosta', async () => {
  setTasks([normalizeTask({ id: 't1', title: 'Hammaslääkäri', date: '2026-09-20', time: '10:00' })]);

  const result = await runTypedCommand('siirrä hammaslääkäri kahdella tunnilla', {
    fetchImpl: fetchReturning('{"intent":"reschedule_task","targetName":"Hammaslääkäri","shiftMinutes":120}'),
    // Vahvistuksen aikana joku muu jo siirsi tehtävän klo 14:een.
    // "Siirrä kahdella tunnilla" pitää nyt laskea 14:00:sta, ei
    // ehdotushetken 10:00:sta -- muuten tulos olisi 12:00, väärä.
    confirmFn: async () => {
      setTasks([normalizeTask({ id: 't1', title: 'Hammaslääkäri', date: '2026-09-20', time: '14:00' })]);
      return true;
    },
    chooseFn: async () => null
  });

  assert.equal(result.ok, true);
  assert.equal(getState().tasks[0].time, '16:00',
    'siirto piti laskea tuoreesta 14:00:sta (odotettu 16:00), ei vanhentuneesta 10:00:sta');
});

test('kohde jonka nimi ei enää täsmää (uudelleennimetty) EI kaada suoritusta, koska tunniste on tallessa', async () => {
  setTasks([normalizeTask({ id: 't1', title: 'Hammaslääkäri', date: '2026-09-20', time: '10:00' })]);

  const result = await runTypedCommand('merkitse hammaslääkäri tehdyksi', {
    fetchImpl: fetchReturning('{"intent":"complete_task","targetName":"Hammaslääkäri"}'),
    // Nimi vaihtuu vahvistuksen aikana, mutta tunniste (id) pysyy samana --
    // suoritus seuraa TUNNISTETTA, ei jäädytettyä nimeä.
    confirmFn: async () => {
      setTasks([normalizeTask({ id: 't1', title: 'Hammaslääkäri (siirretty)', date: '2026-09-20', time: '10:00' })]);
      return true;
    },
    chooseFn: async () => null
  });

  assert.equal(result.ok, true);
  assert.equal(getState().tasks[0].completed, true);
});

test('lasku merkitään maksetuksi tunnisteella, ja kirjaus näkyy tilassa', async () => {
  await createBill({ name: 'Sähkölasku', amountMinor: 1000, dueDate: '2026-09-20', currency: 'EUR' });

  const result = await runTypedCommand('merkitse sähkölasku maksetuksi', {
    fetchImpl: fetchReturning('{"intent":"mark_bill_paid","targetName":"Sähkölasku"}'),
    confirmFn: async () => true,
    chooseFn: async () => null
  });

  assert.equal(result.ok, true);
  assert.equal(getState().bills[0].status, 'paid');
});

test('REGRESSIO: rutiinin viikonpäivien osittainen muutos säilyttää toistotyypin', async () => {
  await runTypedCommand('luo rutiini', {
    fetchImpl: fetchReturning('{"intent":"create_routine","title":"Kuntosali","recurrence":"custom_weekdays","weekdays":[1,3,5]}'),
    confirmFn: async () => true,
    chooseFn: async () => null
  });

  const result = await runTypedCommand('vaihda kuntosali tiistaille ja torstaille', {
    fetchImpl: fetchReturning('{"intent":"update_routine","targetName":"Kuntosali","weekdays":[2,4]}'),
    confirmFn: async () => true,
    chooseFn: async () => null
  });

  assert.equal(result.ok, true);
  const routine = getState().routines[0];
  assert.equal(routine.recurrence.type, 'custom_weekdays', 'toistotyyppi ei saa palautua päivittäiseksi');
  assert.deepEqual(routine.recurrence.weekdays, [2, 4]);
});

// =====================================================================
// SUOMENKIELINEN KOMENTOKORPUS
//
// Jokainen rivi dokumentoi MITÄ palvelimen luokittelijan ODOTETAAN
// palauttavan tälle lauseelle (sopimus api/command.js:n ja tämän
// sovelluskerroksen välillä), ja todistaa että sovellus käsittelee
// tuloksen oikein alusta loppuun. Itse luokittelun (malli ymmärtää
// suomea oikein) voi todistaa vain oikealla mallilla -- sitä ei kutsuta
// täältä (ks. AI-komentojen turvarajat, docs/VOICE-COMMANDS.md).
// =====================================================================

const CORPUS = [
  {
    phrase: 'Muistuta minua huomenna kello 8 soittamaan Matille',
    json: '{"intent":"create_task","title":"Soita Matille","date":"2026-09-20","time":"08:00"}',
    check: () => {
      const task = getState().tasks[0];
      assert.equal(task.date, '2026-09-20');
      assert.equal(task.time, '08:00');
    }
  },
  {
    phrase: 'Siirrä huomisen Motonet-tehtävä perjantaille',
    setup: () => setTasks([normalizeTask({ id: 't1', title: 'Motonet', date: '2026-09-20' })]),
    json: '{"intent":"reschedule_task","targetName":"Motonet","date":"2026-09-25"}',
    check: () => assert.equal(getState().tasks[0].date, '2026-09-25')
  },
  {
    phrase: 'Merkitse sähkölasku maksetuksi',
    setup: () => createBill({ name: 'Sähkölasku', amountMinor: 5000, dueDate: '2026-09-30', currency: 'EUR' }),
    json: '{"intent":"mark_bill_paid","targetName":"Sähkölasku"}',
    check: () => assert.equal(getState().bills[0].status, 'paid')
  },
  {
    // ISO-viikonpäivät: 1=maanantai, 3=keskiviikko, 5=perjantai
    // (src/domain/routine.js isIsoWeekday).
    phrase: 'Luo rutiini kuntosalille joka maanantai, keskiviikko ja perjantai',
    json: '{"intent":"create_routine","title":"Kuntosali","recurrence":"custom_weekdays","weekdays":[1,3,5]}',
    check: () => {
      const routine = getState().routines[0];
      assert.equal(routine.recurrence.type, 'custom_weekdays');
      assert.deepEqual(routine.recurrence.weekdays, [1, 3, 5]);
    }
  },
  {
    phrase: 'Lisää projekti autotallin remontti, deadline kuun lopussa',
    json: '{"intent":"create_project","name":"Autotallin remontti","deadline":"2026-09-30"}',
    check: () => assert.equal(getState().projects[0].deadline, '2026-09-30')
  },
  {
    phrase: 'Haluan tavoitteeksi Manifestivalin julkaisun marraskuussa',
    json: '{"intent":"create_goal","title":"Manifestivalin julkaisu","targetDate":"2026-11-30"}',
    check: () => assert.equal(getState().goals[0].targetDate, '2026-11-30')
  },
  {
    phrase: 'Palauta hammaslääkäri keskeneräiseksi',
    setup: () => setTasks([normalizeTask({ id: 't1', title: 'Hammaslääkäri', date: '2026-09-20', completed: true })]),
    json: '{"intent":"uncomplete_task","targetName":"Hammaslääkäri"}',
    check: () => assert.equal(getState().tasks[0].completed, false)
  },
  {
    phrase: 'Vaihda muistutusten ennakkoaika 30 minuuttiin',
    json: '{"intent":"set_notification_preference","taskLeadMinutes":30}',
    check: () => assert.equal(getState().notificationPreferences.taskLeadMinutes, 30)
  },
  {
    phrase: 'Näytä tämän viikon suunnitelma',
    json: '{"intent":"show_week_plan","date":"2026-09-21"}',
    check: () => assert.equal(getState().screen, 'screen-week')
  },
  {
    phrase: 'Näytä ensi maanantain päivä',
    json: '{"intent":"show_day_plan","date":"2026-09-28"}',
    check: () => assert.equal(getState().screen, 'screen-today')
  },
  {
    phrase: 'Mitä huomenna on viikonloppuna tekemättä',
    json: '{"intent":"mitä_sää_on"}',
    check: (result) => { assert.equal(result.ok, false); assert.equal(result.status, 'rejected'); }
  }
];

for (const entry of CORPUS) {
  test(`KORPUS (${entry.phrase === CORPUS[0].phrase ? 'puhe' : 'teksti'}): "${entry.phrase}"`, async () => {
    if (entry.setup) await entry.setup();
    const runner = entry === CORPUS[0] ? runVoiceCommand : runTypedCommand;
    const result = await runner(entry.phrase, {
      fetchImpl: fetchReturning(entry.json),
      confirmFn: async () => true,
      chooseFn: async candidates => candidates[0] || null
    });
    entry.check(result);
  });
}
