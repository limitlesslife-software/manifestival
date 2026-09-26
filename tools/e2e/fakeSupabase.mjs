// Paikallinen Supabase-korvike E2E-valjaalle ja testeille. EI VERKKOA.
//
// Ajetaan sekä selaimessa (tools/e2e/harness.mjs) että Nodessa
// (tests/life-alignment-e2e-harness.test.mjs), joten tämä ei importoi
// mitään eikä käytä selaimen tai Noden omia rajapintoja.
//
// MITÄ TÄMÄ MALLINTAA (sen verran kuin sovellus nojaa niihin)
//
//   - rivit tauluittain: insert, update, upsert, delete ja select, ja
//     `.select()` kirjoituksen perässä palauttaa kirjoitetut rivit
//     (sovellus tunnistaa sillä nollaan riviin osuneen päivityksen)
//   - RLS: jokainen kysely näkee vain kirjautuneen käyttäjän rivit
//     (user_id = auth.uid(); profile ja notification_preferences:
//     id = auth.uid()). Lisäys asettaa user_id:n kuten sarakkeen oletus
//     auth.uid(); toisen käyttäjän user_id hylätään (42501).
//   - uniikki- ja viiteavaimet migraatioista 0004–0013 (23505, 23503),
//     ja poiston `on delete set null / cascade`
//   - created_at ja updated_at kannan omaisuutena
//   - offline: jokainen kysely palauttaa supabase-js:n verkkovirheen
//     muodon (status 0, "TypeError: Failed to fetch"), eikä mitään kirjoiteta
//
// MITÄ EI MALLINNETA: sarakkeiden olemassaoloa (skeematarkistus saa aina
// "kunnossa"), CHECK-rajoitteita, liipaisimia, realtimea eikä rpc:tä.
// Tuntematon kyselymetodi ei hiljaa onnistu: se palauttaa virheen ja
// kirjautuu `unsupported`-listaan, jonka valjas raportoi.

/** Taulut, joissa omistaja on rivin id eikä user_id. */
export const OWNER_BY_ID = Object.freeze(['profile', 'notification_preferences']);

/** Uniikkirajoitteet (NULL ei törmää, kuten PostgreSQL:ssä). */
export const UNIQUE_CONSTRAINTS = Object.freeze({
  life_areas: [['life_areas_name_unique', ['user_id', 'name']],
    ['life_areas_category_unique', ['user_id', 'category_key']]],
  weekly_capacities: [['weekly_capacities_week_unique', ['user_id', 'week_start']]],
  alignment_reviews: [['alignment_reviews_week_unique', ['user_id', 'week_start']]],
  time_entries: [['time_entries_operation_unique', ['user_id', 'operation_id']]],
  running_timers: [['running_timers_one_per_user', ['user_id']]],
  alignment_item_settings: [['alignment_item_settings_item_unique', ['user_id', 'item_kind', 'item_id']]],
  notices: [['notices_key_unique', ['user_id', 'notice_key']]]
});

const SET_NULL = 'set null';
const CASCADE = 'cascade';
const TIME_TARGETS = Object.freeze({
  life_area_id: ['life_areas', SET_NULL], goal_id: ['goals', SET_NULL], task_id: ['tasks', SET_NULL],
  project_id: ['projects', SET_NULL], routine_id: ['routines', SET_NULL]
});

/** Viiteavaimet (user_id, sarake) -> (user_id, id). Ks. supabase/migrations/. */
export const FOREIGN_KEYS = Object.freeze({
  tasks: { goal_id: ['goals', SET_NULL], project_id: ['projects', SET_NULL], milestone_id: ['milestones', SET_NULL] },
  goals: { parent_goal_id: ['goals', SET_NULL], project_id: ['projects', SET_NULL], life_area_id: ['life_areas', SET_NULL] },
  projects: { goal_id: ['goals', SET_NULL], milestone_id: ['milestones', SET_NULL] },
  routines: { goal_id: ['goals', SET_NULL] },
  milestones: { goal_id: ['goals', CASCADE] },
  time_entries: TIME_TARGETS,
  running_timers: TIME_TARGETS
});

const NETWORK_ERROR = Object.freeze({
  message: 'TypeError: Failed to fetch', details: '', hint: '', code: ''
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pgError(code, message, details = '') {
  return { code, message, details, hint: null };
}

/** PostgreSQL-taulukkoliteraali, kuten src/lib/rows.js pgArrayLiteral. */
function arrayLiteral(list) {
  return '{' + list.map(item => '"' + String(item).replace(/(["\\])/g, '\\$1') + '"').join(',') + '}';
}

function sameValue(stored, arg) {
  if (stored === null || stored === undefined) return false;
  if (Array.isArray(stored)) {
    return Array.isArray(arg) ? JSON.stringify(stored) === JSON.stringify(arg) : arrayLiteral(stored) === String(arg);
  }
  return String(stored) === String(arg);
}

function compare(stored, arg) {
  if (typeof stored === 'number' && Number.isFinite(Number(arg))) return stored - Number(arg);
  return String(stored) < String(arg) ? -1 : String(stored) > String(arg) ? 1 : 0;
}

function likeToRegExp(pattern, flags) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp('^' + escaped + '$', flags);
}

const OPERATORS = Object.freeze({
  eq: (value, arg) => sameValue(value, arg),
  // SQL: NULL <> x ei ole tosi, joten NULL-rivi ei tule mukaan.
  neq: (value, arg) => value !== null && value !== undefined && !sameValue(value, arg),
  is: (value, arg) => (arg === null ? value === null || value === undefined : value === arg),
  in: (value, arg) => (Array.isArray(arg) ? arg : []).some(item => sameValue(value, item)),
  gt: (value, arg) => value != null && compare(value, arg) > 0,
  gte: (value, arg) => value != null && compare(value, arg) >= 0,
  lt: (value, arg) => value != null && compare(value, arg) < 0,
  lte: (value, arg) => value != null && compare(value, arg) <= 0,
  like: (value, arg) => value != null && likeToRegExp(arg, '').test(String(value)),
  ilike: (value, arg) => value != null && likeToRegExp(arg, 'i').test(String(value))
});

/**
 * Tietokanta muistissa. `tables` on { taulu: [rivi, ...] } (kannan
 * sarakenimet); annettu olio kopioidaan.
 */
export function createFakeDatabase({ tables = {}, now = () => new Date().toISOString() } = {}) {
  const data = {};
  for (const [table, rows] of Object.entries(tables || {})) data[table] = clone(rows || []);
  const writes = [];
  let seq = 0;

  const rowsOf = table => (data[table] ||= []);
  const ownerColumn = table => (OWNER_BY_ID.includes(table) ? 'id' : 'user_id');
  const visible = (table, uid) => rowsOf(table).filter(row => uid && String(row[ownerColumn(table)]) === String(uid));

  function uniqueViolation(table, candidate, ignore = new Set()) {
    const clash = rowsOf(table).find(row => !ignore.has(row) && row.id === candidate.id);
    if (clash) {
      return pgError('23505', `duplicate key value violates unique constraint "${table}_pkey"`,
        `Key (id)=(${candidate.id}) already exists.`);
    }
    for (const [name, columns] of UNIQUE_CONSTRAINTS[table] || []) {
      if (columns.some(column => candidate[column] === null || candidate[column] === undefined)) continue;
      const other = rowsOf(table).find(row => !ignore.has(row)
        && columns.every(column => String(row[column]) === String(candidate[column])));
      if (other) {
        return pgError('23505', `duplicate key value violates unique constraint "${name}"`,
          `Key (${columns.join(', ')}) already exists.`);
      }
    }
    return null;
  }

  function foreignKeyViolation(table, row) {
    for (const [column, [target]] of Object.entries(FOREIGN_KEYS[table] || {})) {
      const value = row[column];
      if (value === null || value === undefined) continue;
      const found = rowsOf(target).some(other => String(other.id) === String(value)
        && String(other.user_id) === String(row.user_id));
      if (!found) {
        return pgError('23503', `insert or update on table "${table}" violates foreign key constraint "${table}_${column}_fkey"`,
          `Key (user_id, ${column}) is not present in table "${target}".`);
      }
    }
    return null;
  }

  /** on delete set null / cascade tauluille, jotka viittaavat poistettuun. */
  function applyDeleteRules(table, removed) {
    for (const [source, columns] of Object.entries(FOREIGN_KEYS)) {
      for (const [column, [target, rule]] of Object.entries(columns)) {
        if (target !== table) continue;
        for (const gone of removed) {
          const referencing = rowsOf(source).filter(row => String(row[column]) === String(gone.id)
            && String(row.user_id) === String(gone.user_id));
          if (referencing.length === 0) continue;
          if (rule === CASCADE) {
            data[source] = rowsOf(source).filter(row => !referencing.includes(row));
            applyDeleteRules(source, referencing);
          } else {
            for (const row of referencing) row[column] = null;
          }
        }
      }
    }
  }

  function log(entry) {
    seq += 1;
    writes.push({ seq, ...entry });
  }

  function insertRows(table, uid, payload, { upsert = false, onConflict = 'id', ignoreDuplicates = false } = {}) {
    const input = (Array.isArray(payload) ? payload : [payload]).map(clone);
    const owner = ownerColumn(table);
    const staged = [];
    const replaced = [];
    for (const raw of input) {
      if (owner === 'user_id') {
        if (raw.user_id !== undefined && raw.user_id !== null && String(raw.user_id) !== String(uid)) {
          return { error: pgError('42501', `new row violates row-level security policy for table "${table}"`), status: 403 };
        }
        raw.user_id = uid;
      } else if (String(raw.id) !== String(uid)) {
        return { error: pgError('42501', `new row violates row-level security policy for table "${table}"`), status: 403 };
      }
      const stamp = now();
      if (upsert) {
        const keys = String(onConflict || 'id').split(',').map(key => key.trim());
        const existing = rowsOf(table).find(row => keys.every(key => String(row[key]) === String(raw[key])));
        if (existing) {
          if (String(existing[owner]) !== String(uid)) {
            return { error: pgError('42501', `new row violates row-level security policy for table "${table}"`), status: 403 };
          }
          if (ignoreDuplicates) continue;
          replaced.push([existing, { ...existing, ...raw, created_at: existing.created_at, updated_at: stamp }]);
          continue;
        }
      }
      staged.push({ created_at: stamp, ...raw, updated_at: stamp });
    }
    const ignore = new Set(replaced.map(([old]) => old));
    for (const row of [...staged, ...replaced.map(([, next]) => next)]) {
      const error = uniqueViolation(table, row, ignore) || foreignKeyViolation(table, row);
      if (error) return { error, status: 409 };
      ignore.add(row);
    }
    for (const [old, next] of replaced) Object.assign(old, next);
    rowsOf(table).push(...staged);
    const touched = [...staged, ...replaced.map(([old]) => old)];
    log({ table, op: upsert ? 'upsert' : 'insert', ids: touched.map(row => row.id) });
    return { rows: touched, status: 201 };
  }

  function matches(row, filters) {
    return filters.every(filter => {
      const result = OPERATORS[filter.op](row[filter.column], filter.arg);
      return filter.negate ? !result : result;
    });
  }

  function updateRows(table, uid, patch, filters) {
    const targets = visible(table, uid).filter(row => matches(row, filters));
    const clean = clone(patch) || {};
    delete clean.user_id;
    const stamp = now();
    const next = targets.map(row => ({ ...row, ...clean, updated_at: stamp }));
    const ignore = new Set(targets);
    for (const row of next) {
      const error = uniqueViolation(table, row, ignore) || foreignKeyViolation(table, row);
      if (error) return { error, status: 409 };
    }
    targets.forEach((row, i) => Object.assign(row, next[i]));
    log({ table, op: 'update', ids: targets.map(row => row.id) });
    return { rows: targets, status: 200 };
  }

  function deleteRows(table, uid, filters) {
    const targets = visible(table, uid).filter(row => matches(row, filters));
    data[table] = rowsOf(table).filter(row => !targets.includes(row));
    applyDeleteRules(table, targets);
    log({ table, op: 'delete', ids: targets.map(row => row.id) });
    return { rows: targets, status: 200 };
  }

  function selectRows(table, uid, filters) {
    return { rows: visible(table, uid).filter(row => matches(row, filters)), status: 200 };
  }

  return {
    insertRows, updateRows, deleteRows, selectRows,
    /** Kaikki taulun rivit (kaikki käyttäjät), kopiona. */
    rows: table => clone(rowsOf(table)),
    /** Koko kanta kopiona (tallennus sessionStorageen). */
    snapshot: () => clone(data),
    /** Kirjoitusloki: { seq, table, op, ids }. */
    writes: () => clone(writes),
    /** Suora lisäys ohi RLS:n (siemen ja valjaan apufunktiot). */
    seed(table, rows) {
      rowsOf(table).push(...clone(rows));
    },
    /** Korvaa taulun rivit ohi RLS:n (skenaarion lähtötilanne). */
    setRows(table, rows) {
      data[table] = clone(rows || []);
    }
  };
}

function project(rows, columns) {
  if (!columns || columns === '*') return rows.map(clone);
  const names = String(columns).split(',').map(name => name.trim()).filter(Boolean);
  return rows.map(row => {
    const out = {};
    for (const name of names) if (Object.prototype.hasOwnProperty.call(row, name)) out[name] = clone(row[name]);
    return out;
  });
}

/**
 * Supabase-asiakkaan korvike.
 *
 * @param {object} options
 * @param {object} options.database  createFakeDatabase()
 * @param {object|null} options.session  { user: { id, email } } tai null
 * @param {() => boolean} [options.isOffline]
 * @param {number} [options.latencyMs]  vastausviive (järjestys kuten verkossa)
 * @param {(event: object) => void} [options.onWrite]  onnistuneen kirjoituksen jälkeen
 * @param {(session: object|null) => void} [options.onSessionChange]
 */
export function createFakeSupabase({
  database, session = null, isOffline = () => false, latencyMs = 2,
  onWrite = () => {}, onSessionChange = () => {}
} = {}) {
  let current = session ? clone(session) : null;
  const listeners = new Set();
  const unsupported = [];
  const uid = () => (current && current.user && current.user.id ? String(current.user.id) : null);
  const delay = () => new Promise(resolve => setTimeout(resolve, latencyMs));

  function builder(table) {
    const query = {
      table, op: null, payload: null, options: {}, filters: [], columns: '*', returning: null,
      single: null, order: [], limit: null, range: null, count: null, head: false
    };
    let pending = null;

    const self = {
      select(columns = '*', { count = null, head = false } = {}) {
        if (query.op === null) {
          query.op = 'select';
          query.columns = columns;
          query.count = count;
          query.head = head;
        } else {
          query.returning = columns;
        }
        return self;
      },
      // `{ count: 'exact' }` kirjoituksessa: vastaus kertoo osuneiden rivien määrän.
      insert(payload, options = {}) { return write('insert', payload, options); },
      upsert(payload, options = {}) { return write('upsert', payload, options); },
      update(payload, options = {}) { return write('update', payload, options); },
      delete(options = {}) { return write('delete', null, options); },
      match(object) {
        for (const [column, arg] of Object.entries(object || {})) query.filters.push({ op: 'eq', column, arg });
        return self;
      },
      filter(column, op, arg) {
        if (!OPERATORS[op]) return unsupportedCall(`filter:${op}`);
        query.filters.push({ op, column, arg });
        return self;
      },
      not(column, op, arg) {
        if (!OPERATORS[op]) return unsupportedCall(`not:${op}`);
        query.filters.push({ op, column, arg, negate: true });
        return self;
      },
      order(column, { ascending = true } = {}) { query.order.push({ column, ascending }); return self; },
      limit(count) { query.limit = count; return self; },
      range(from, to) { query.range = [from, to]; return self; },
      single() { query.single = 'single'; return self; },
      maybeSingle() { query.single = 'maybe'; return self; },
      abortSignal() { return self; },
      throwOnError() { return unsupportedCall('throwOnError'); },
      then(resolve, reject) {
        pending ||= execute();
        return pending.then(resolve, reject);
      },
      catch(reject) { return self.then(undefined, reject); },
      finally(callback) { return self.then(value => { callback(); return value; }, error => { callback(); throw error; }); }
    };
    for (const op of Object.keys(OPERATORS)) {
      self[op] = (column, arg) => { query.filters.push({ op, column, arg }); return self; };
    }

    function write(op, payload, options) {
      query.op = op;
      query.payload = payload;
      query.options = options || {};
      query.count = query.options.count || null;
      return self;
    }

    function unsupportedCall(name) {
      unsupported.push(`${table}.${name}`);
      query.unsupported = name;
      return self;
    }

    async function execute() {
      await delay();
      if (query.unsupported) {
        return { data: null, error: pgError('E2E00', `fake: tukematon kyselymetodi ${query.unsupported}`), status: 400 };
      }
      if (isOffline()) return { data: null, error: { ...NETWORK_ERROR }, count: null, status: 0, statusText: '' };
      const user = uid();
      if (!user && query.op !== 'select') {
        return { data: null, error: pgError('42501', 'permission denied'), status: 401 };
      }
      let outcome;
      if (query.op === 'select') outcome = database.selectRows(table, user, query.filters);
      else if (query.op === 'insert') outcome = database.insertRows(table, user, query.payload);
      else if (query.op === 'upsert') {
        outcome = database.insertRows(table, user, query.payload, {
          upsert: true, onConflict: query.options.onConflict, ignoreDuplicates: query.options.ignoreDuplicates
        });
      } else if (query.op === 'update') outcome = database.updateRows(table, user, query.payload, query.filters);
      else if (query.op === 'delete') outcome = database.deleteRows(table, user, query.filters);
      else return { data: null, error: pgError('E2E00', 'fake: kysely ilman toimintoa'), status: 400 };

      if (outcome.error) return { data: null, error: outcome.error, count: null, status: outcome.status };
      if (query.op !== 'select') onWrite({ table, op: query.op, ids: outcome.rows.map(row => row.id) });

      let rows = outcome.rows;
      if (query.op === 'select') {
        rows = [...rows];
        for (const { column, ascending } of [...query.order].reverse()) {
          rows.sort((a, b) => {
            if (a[column] == null && b[column] == null) return 0;
            if (a[column] == null) return 1;
            if (b[column] == null) return -1;
            return ascending ? compare(a[column], b[column]) : -compare(a[column], b[column]);
          });
        }
        if (query.range) rows = rows.slice(query.range[0], query.range[1] + 1);
        if (Number.isInteger(query.limit)) rows = rows.slice(0, query.limit);
      }
      const count = query.count ? rows.length : null;
      const columns = query.op === 'select' ? query.columns : query.returning;
      if (query.op !== 'select' && columns === null) {
        return { data: null, error: null, count, status: outcome.status === 201 ? 201 : 204, statusText: '' };
      }
      if (query.head) return { data: null, error: null, count, status: 200, statusText: '' };
      const projected = project(rows, columns);
      if (query.single) {
        if (projected.length === 1) return { data: projected[0], error: null, count, status: 200 };
        if (projected.length === 0 && query.single === 'maybe') return { data: null, error: null, count, status: 200 };
        return {
          data: null, count, status: 406,
          error: pgError('PGRST116', 'JSON object requested, multiple (or no) rows returned',
            `The result contains ${projected.length} rows`)
        };
      }
      return { data: projected, error: null, count, status: 200, statusText: '' };
    }

    return self;
  }

  function emit(event) {
    for (const listener of listeners) setTimeout(() => listener(event, current ? clone(current) : null), 0);
  }

  return {
    from: table => builder(table),
    rpc: name => {
      unsupported.push(`rpc:${name}`);
      return Promise.resolve({ data: null, error: pgError('PGRST202', `fake: rpc ${name} puuttuu`), status: 404 });
    },
    auth: {
      getSession: async () => ({ data: { session: current ? clone(current) : null }, error: null }),
      onAuthStateChange(listener) {
        listeners.add(listener);
        // supabase-js v2: tilaaja saa nykyisen istunnon heti (INITIAL_SESSION).
        setTimeout(() => listener('INITIAL_SESSION', current ? clone(current) : null), 0);
        return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
      },
      async signOut() {
        current = null;
        onSessionChange(null);
        emit('SIGNED_OUT');
        return { error: null };
      },
      // E2E ei kirjaudu oikeasti: salasanakirjautuminen ei ole mahdollista.
      signInWithPassword: async () => ({ data: { user: null, session: null }, error: { message: 'Invalid login credentials' } }),
      signUp: async () => ({ data: { user: null, session: null }, error: { message: 'Signups not allowed for this instance' } })
    },
    /** Valjaan oma: kirjaudu takaisin samalla (tekaistulla) istunnolla. */
    signInForTests(next) {
      current = clone(next);
      onSessionChange(current);
      emit('SIGNED_IN');
    },
    unsupported: () => [...unsupported]
  };
}
