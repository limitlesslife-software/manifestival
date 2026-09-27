// Arjen taulujen (0014) lataus ei saa katketa hiljaa PostgRESTin
// max-rows-rajaan (Supabasessa oletus 1000 riviä vastausta kohti).
//
// TAUSTA. createRepository.list() haki `select('*').eq('user_id')` ilman
// järjestystä ja sivutusta. Palvelin palautti pitkäikäisestä taulusta
// (unikirjaukset, menot, tapakirjaukset) vain tuhat riviä, ja sovellus piti
// niitä koko listana: uusimmat kirjaukset katosivat jokaisella latauksella.
//
// Portit ovat tällä haaralla kiinni, joten kantapolkua ei voi ajaa
// repositorion kautta. Sivuttava haku (selectOwnedRows) on siksi oma
// funktionsa, ja testi ajaa sen palvelinkorvikkeella, joka katkaisee
// vastaukset kuten oikea PostgREST.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import {
  selectOwnedRows, LIST_PAGE_ROWS, ALL_REPOSITORIES
} from '../src/data/collectionsRepo.js';
import { readCode } from './helpers/sources.mjs';

const USER_A = { id: 'aaaaaaaa-2222-0000-0000-00000000000a', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-2222-0000-0000-00000000000b', email: 'b@example.com' };

/**
 * PostgREST-tyylinen palvelin, joka katkaisee vastauksen `maxRows`-rajaan.
 * Ilman order-kutsua rivit tulevat "suunnitelman" järjestyksessä
 * (lisäysjärjestys), kuten indeksiskannauksessa.
 */
function cappedServer(rows, { maxRows = 1000, supportsCount = true, honorsRange = true } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const query = { table, filters: [], order: null, range: null, count: null };
      const api = {
        select(columns = '*', options = {}) { query.count = options && options.count; return api; },
        eq(column, value) { query.filters.push([column, value]); return api; },
        order(column, { ascending = true } = {}) { query.order = { column, ascending }; return api; },
        range(from, to) { query.range = [from, to]; return api; },
        then(resolve, reject) {
          calls.push({ ...query });
          let found = rows.filter(row => row.table === table
            && query.filters.every(([column, value]) => String(row.data[column]) === String(value)))
            .map(row => ({ ...row.data }));
          if (query.order) {
            const { column, ascending } = query.order;
            found.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
          }
          const total = found.length;
          if (query.range && honorsRange) found = found.slice(query.range[0], query.range[1] + 1);
          found = found.slice(0, maxRows);
          const count = supportsCount && query.count === 'exact' ? total : null;
          return Promise.resolve({ data: found, error: null, count }).then(resolve, reject);
        }
      };
      return api;
    }
  };
}

/** n unikirjausta käyttäjälle; tunnisteet sekoitettuun järjestykseen. */
function sleepRows(userId, n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const id = `log-${String((i * 7919) % n).padStart(5, '0')}`;
    rows.push({ table: 'sleep_logs', data: { id, user_id: userId, wake_date: `d${i}` } });
  }
  return rows;
}

beforeEach(() => {
  clearUser();
  setUser(USER_A);
});

test('KRIITTINEN: yli max-rows-rajan kaikki rivit ladataan, järjestyksessä ja kerran', async () => {
  const server = cappedServer([...sleepRows(USER_A.id, 2500), ...sleepRows(USER_B.id, 300)]);
  setClient(server);

  const { data, error } = await selectOwnedRows('sleep_logs', 'id');
  assert.equal(error, null);
  assert.equal(data.length, 2500, 'tuhannen rivin jälkeiset katosivat');
  assert.equal(new Set(data.map(row => row.id)).size, 2500, 'sivut menivät päällekkäin');
  assert.ok(data.every(row => row.user_id === USER_A.id), 'toisen käyttäjän rivi mukana');
  const ids = data.map(row => row.id);
  assert.deepEqual(ids, [...ids].sort(), 'sivutus vaatii vakaan järjestyksen');
  assert.ok(server.calls.every(call => call.order && call.order.column === 'id' && call.range),
    'jokainen sivu on järjestetty ja rajattu');
  assert.deepEqual(server.calls.map(call => call.filters), server.calls.map(() => [['user_id', USER_A.id]]));
});

test('palvelimen raja sivua pienempi: kokonaismäärä ratkaisee, lataus jatkuu loppuun', async () => {
  const server = cappedServer(sleepRows(USER_A.id, 1300), { maxRows: 400 });
  setClient(server);
  const { data } = await selectOwnedRows('sleep_logs', 'id');
  assert.equal(data.length, 1300);
  assert.equal(new Set(data.map(row => row.id)).size, 1300);
});

test('ilman kokonaismäärää vajaa sivu on viimeinen; pieni taulu on yksi pyyntö', async () => {
  const server = cappedServer(sleepRows(USER_A.id, LIST_PAGE_ROWS + 5), { supportsCount: false });
  setClient(server);
  const { data } = await selectOwnedRows('sleep_logs', 'id');
  assert.equal(data.length, LIST_PAGE_ROWS + 5);

  const small = cappedServer(sleepRows(USER_A.id, 12));
  setClient(small);
  assert.equal((await selectOwnedRows('sleep_logs', 'id')).data.length, 12);
  assert.equal(small.calls.length, 1, 'pieni taulu ei maksa ylimääräistä pyyntöä');
});

test('karkaamisraja: sivutusta noudattamaton palvelin on näkyvä virhe, ei loputon silmukka', async () => {
  const server = cappedServer(sleepRows(USER_A.id, 50), { supportsCount: false, honorsRange: false });
  setClient(server);
  const result = await selectOwnedRows('sleep_logs', 'id', { pageRows: 50, maxRows: 200 });
  assert.equal(result.overflow, true);
  assert.equal(result.data, null, 'katkaistua listaa ei palauteta kokonaisena');
  assert.ok(server.calls.length <= 4);
});

test('kaikki kymmenen arjen taulua (0014) ladataan sivuittain', () => {
  const daily = ['saved_places', 'place_aliases', 'calendar_events', 'commute_observations', 'life_settings',
    'sleep_logs', 'habit_plans', 'habit_events', 'exercise_sessions', 'wellbeing_checkins'];
  for (const table of daily) {
    const repo = ALL_REPOSITORIES.find(candidate => candidate.table === table);
    assert.ok(repo, table);
    assert.equal(repo.listOrder, 'id', `${table} ladataan yhdellä rajaamattomalla haulla`);
  }
  const code = readCode('src/data/collectionsRepo.js');
  const list = code.slice(code.indexOf('async list()'), code.indexOf('async insert('));
  assert.match(list, /if \(listOrder\)[\s\S]*selectOwnedRows\(table, listOrder\)/,
    'repositorion lataus ei käytä sivuttavaa hakua');
  assert.match(list, /overflow[\s\S]*return failWith\(/, 'karkaamisrajan ylitys ei ole virhe');
});
