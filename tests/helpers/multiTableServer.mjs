// TESTIKÄYTTÖÖN: muistinvarainen Supabase-tyylinen palvelin KAIKILLE tauluille.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Tuotehaaroilla kaikki portit ovat kiinni, joten repositoriot kirjoittavat
// muistivarastoon ja testit saattoivat siementää suoraan `repo.memory`:yn.
// Julkaisulinjassa (aallot A–J) portit ovat auki: sama testi ajaa silloin
// kantapolun, ja ilman kantaa jokainen haku epäonnistuu. Testi ei silloin
// enää todistaisi mitään latauslogiikasta, vain puuttuvasta kannasta.
//
// Tämä palvelin toteuttaa ne kyselyt, joita src/data/ käyttää (select, eq,
// neq, maybeSingle, insert, update, upsert, delete) ja jäljittelee
// omistajuutta: rivi saa user_id:n (tai id:n, jos taulu on id-omisteinen)
// kirjautuneelta käyttäjältä kuten DEFAULT auth.uid() tekisi.
//
// Käytä yhdessä `repo.insert`-kutsujen kanssa: portin ollessa kiinni ne
// menevät muistivarastoon, auki ollessa tänne. Testi on sama molemmissa.

const ID_OWNED = new Set(['profile', 'notification_preferences']);

export function createMultiTableServer(currentUserId) {
  const tables = new Map();
  const table = name => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };
  const owner = name => (ID_OWNED.has(name) ? 'id' : 'user_id');

  function builder(name) {
    const filters = [];
    let op = 'select';
    let payload = null;
    let single = false;

    const matches = row => filters.every(([kind, column, value]) =>
      (kind === 'eq' ? String(row[column]) === String(value) : String(row[column]) !== String(value)));

    function run() {
      const rows = table(name);
      const uid = currentUserId();
      if (op === 'select') {
        const found = rows.filter(matches).map(row => ({ ...row }));
        return { data: single ? (found[0] || null) : found, error: null };
      }
      if (op === 'insert' || op === 'upsert') {
        const list = Array.isArray(payload) ? payload : [payload];
        for (const item of list) {
          const row = { ...item };
          if (row[owner(name)] == null) row[owner(name)] = uid;
          const at = rows.findIndex(r => String(r.id) === String(row.id));
          if (at !== -1 && op === 'insert') {
            return { data: null, error: { code: '23505', message: 'duplicate key value' } };
          }
          if (at !== -1) rows[at] = { ...rows[at], ...row };
          else rows.push(row);
        }
        return { data: list, error: null };
      }
      if (op === 'update') {
        const hit = rows.filter(matches);
        for (const row of hit) Object.assign(row, payload);
        return { data: hit.map(row => ({ id: row.id })), error: null };
      }
      if (op === 'delete') {
        const keep = rows.filter(row => !matches(row));
        const removed = rows.length - keep.length;
        tables.set(name, keep);
        return { data: null, error: null, count: removed };
      }
      return { data: null, error: { message: `tuntematon operaatio ${op}` } };
    }

    const q = {
      select() { return q; },
      eq(column, value) { filters.push(['eq', column, value]); return q; },
      neq(column, value) { filters.push(['neq', column, value]); return q; },
      order() { return q; },
      maybeSingle() { single = true; return q; },
      single() { single = true; return q; },
      insert(value) { op = 'insert'; payload = value; return q; },
      upsert(value) { op = 'upsert'; payload = value; return q; },
      update(value) { op = 'update'; payload = value; return q; },
      delete() { op = 'delete'; return q; },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
    };
    return q;
  }

  return {
    from: name => builder(name),
    rows: name => table(name),
    reset: () => tables.clear()
  };
}
