// Suunta E2E -valjas selaimessa. Ks. suunta-harness.html.
//
// Siirrettävä kello: Date.now() ja `new Date()` palauttavat oikean ajan
// plus siirtymän. Muut Date-muodot (päivämäärä argumenttina) ovat
// ennallaan.

const RealDate = Date;
let offset = 0;
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...args);
  }
  static now() { return RealDate.now() + offset; }
}
globalThis.Date = ShiftedDate;

/** Supabase-korvike: jokainen ketju onnistuu tyhjällä vastauksella. Ei verkkoa. */
function fakeClient() {
  const result = { data: [], error: null };
  const chain = () => new Proxy(function () {}, {
    get(target, prop) {
      if (prop === 'then') return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
      return chain;
    },
    apply() { return chain(); }
  });
  return {
    from: () => chain(),
    rpc: () => chain(),
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
    }
  };
}

async function mountMarkup() {
  const response = await fetch('/index.html', { cache: 'no-store' });
  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const defs = doc.querySelector('svg[aria-hidden="true"]');
  if (defs) document.body.appendChild(document.importNode(defs, true));
  const app = doc.getElementById('app');
  const node = document.importNode(app, true);
  node.classList.remove('app-hidden');
  document.body.appendChild(node);
  // Näytetään Suunta-näkymä ilman navigaatiomoduulia.
  for (const screen of document.querySelectorAll('.screen')) {
    const on = screen.id === 'screen-direction';
    screen.classList.toggle('active', on);
    screen.toggleAttribute('inert', !on);
    screen.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
}

async function boot() {
  await mountMarkup();
  const session = await import('/src/data/session.js');
  const client = await import('/src/data/client.js');
  client.setClient(fakeClient());
  session.setUser({ id: 'e2e00000-0000-4000-8000-000000000001', email: 'e2e@example.invalid' });

  const state = await import('/src/app/state.js');
  const direction = await import('/src/app/views/direction.js');
  const timeLog = await import('/src/app/views/timeLog.js');
  const alignment = await import('/src/app/alignment.js');
  const tracking = await import('/src/app/timeTracking.js');
  const datetime = await import('/src/lib/datetime.js');
  const task = await import('/src/domain/task.js');

  direction.initDirection();
  timeLog.initTimeLog();
  const render = () => {
    timeLog.renderTimerBar();
    direction.renderTodayDirection();
    direction.renderDirection();
  };
  state.subscribe(render);
  render();

  window.__e2e = {
    ready: true,
    advance: ms => { offset += ms; render(); },
    todayIso: () => datetime.fmtISO(new Date()),
    state: () => state.getState(),
    setTasks: tasks => state.setTasks(tasks.map(t => task.normalizeTask(t))),
    alignment, tracking, timeLog, render,
    errors: []
  };
}

window.addEventListener('error', event => { (window.__e2eErrors ||= []).push(String(event.message)); });
window.addEventListener('unhandledrejection', event => { (window.__e2eErrors ||= []).push(String(event.reason)); });
boot().catch(error => { (window.__e2eErrors ||= []).push('boot: ' + error.message); });
