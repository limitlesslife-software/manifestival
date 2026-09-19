// TESTIKÄYTTÖÖN: muistinvarainen Supabase-tyylinen palvelin tasks-taululle.
//
// Toteuttaa vain ne kyselyt, joita tasksRepo käyttää (select/eq/is/
// maybeSingle, insert, update + select), ja mallintaa oikean palvelimen
// käyttäytymisen: uniikki id (23505), omistajasarake user_id (DEFAULT
// auth.uid()), istunnon vanheneminen ja verkon katkeaminen. Virheitä voi
// injektoida, myös "kirjoitus onnistui mutta vastaus katosi".

export function createMemoryServer() {
  const server = {
    rows: new Map(),
    online: true,
    authUser: null,
    authExpired: false,
    failures: [],
    writes: [],
    reads: 0,
    beforeUpdate: null
  };

  /** Seuraava `op`-kutsu epäonnistuu. applyFirst: kirjoitus tapahtuu, vastaus katoaa. */
  server.failNext = (op, error, { applyFirst = false, times = 1 } = {}) => {
    server.failures.push({ op, error, applyFirst, times });
  };
  server.reset = () => {
    server.rows.clear(); server.online = true; server.authExpired = false;
    server.failures.length = 0; server.writes.length = 0; server.reads = 0; server.beforeUpdate = null;
  };
  server.rowsFor = userId => [...server.rows.values()].filter(row => row.user_id === userId);

  function takeFailure(op) {
    const at = server.failures.findIndex(entry => entry.op === op);
    if (at === -1) return null;
    const entry = server.failures[at];
    entry.times -= 1;
    if (entry.times <= 0) server.failures.splice(at, 1);
    return entry;
  }

  function matches(row, filters) {
    return filters.every(([kind, column, value]) => (kind === 'eq' ? row[column] === value : row[column] == null));
  }

  function execute(spec) {
    if (!server.online) return { data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' } };
    if (server.authExpired) return { data: null, error: { message: 'JWT expired', code: 'PGRST301', status: 401 } };

    const failure = takeFailure(spec.op);
    const fail = () => ({ data: null, error: failure.error });

    if (spec.op === 'select') {
      server.reads += 1;
      if (failure) return fail();
      const found = [...server.rows.values()].filter(row => matches(row, spec.filters)).map(row => ({ ...row }));
      return { data: spec.single ? (found[0] || null) : found, error: null };
    }

    if (spec.op === 'insert') {
      const apply = () => {
        if (server.rows.has(spec.payload.id)) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint "tasks_pkey"', code: '23505' } };
        }
        server.rows.set(spec.payload.id, { ...spec.payload, user_id: server.authUser });
        server.writes.push({ op: 'insert', id: spec.payload.id });
        return { data: null, error: null };
      };
      if (failure && !failure.applyFirst) return fail();
      const result = apply();
      return failure ? fail() : result;
    }

    if (spec.op === 'update') {
      if (typeof server.beforeUpdate === 'function') server.beforeUpdate(spec);
      if (failure && !failure.applyFirst) return fail();
      const matched = [...server.rows.values()].filter(row => matches(row, spec.filters));
      for (const row of matched) Object.assign(row, spec.payload);
      if (matched.length > 0) server.writes.push({ op: 'update', id: matched[0].id, columns: Object.keys(spec.payload) });
      if (failure) return fail();
      return { data: spec.returning ? matched.map(row => ({ id: row.id })) : null, error: null };
    }

    return { data: null, error: { message: 'tukematon operaatio', code: 'XX000' } };
  }

  function builder(spec) {
    const query = {
      spec: { ...spec, filters: [], single: false, returning: false },
      eq(column, value) { query.spec.filters.push(['eq', column, value]); return query; },
      is(column, value) { query.spec.filters.push(['is', column, value]); return query; },
      maybeSingle() { query.spec.single = true; return query; },
      select() { query.spec.returning = true; return query; },
      then(resolve, reject) { return Promise.resolve(execute(query.spec)).then(resolve, reject); }
    };
    return query;
  }

  server.client = {
    from(table) {
      if (table !== 'tasks') throw new Error('muistipalvelin tukee vain tasks-taulua: ' + table);
      return {
        select: () => builder({ op: 'select' }),
        insert: payload => builder({ op: 'insert', payload }),
        update: payload => builder({ op: 'update', payload })
      };
    }
  };

  return server;
}
