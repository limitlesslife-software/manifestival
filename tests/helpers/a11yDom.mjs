// Pieni jäsentävä DOM saavutettavuustesteille (ei riippuvuuksia).
//
// Muiden testien tynkä-DOM tallentaa innerHTML:n merkkijonona. Sillä ei voi
// testata sitä, mitä näppäimistön ja ruudunlukijan käyttäjä kokee: onko
// fokusoitu painike yhä SAMA elementti uudelleenpiirron jälkeen, putoaako
// fokus <body>:yyn, kirjoitetaanko role="alert" uudelleen, onko jokainen
// ohjain sarkaimella saavutettavissa ja nimetty. Tämä DOM jäsentää
// merkinnän solmuiksi ja mallintaa selaimesta vain sen, mitä testit
// tarvitsevat:
//
//   - poistettu fokusoitu elementti -> document.activeElement = body;
//     fokus ei siirry estettyyn, piilotettuun, inert- tai suljetun
//     <details>-osion sisällä olevaan elementtiin
//   - <dialog>.showModal()/close(): returnValue, 'close'-tapahtuma, fokus
//     palaa avaajaan; modaalin ollessa auki sarkain kiertää vain siinä
//   - <form method="dialog">: submit-painike sulkee dialogin, required/min/
//     max/step estävät lähetyksen (paitsi formnovalidate); Enter
//     tekstikentässä = lomakkeen ENSIMMÄINEN submit-painike
//   - sarkainjärjestys: piilotetut (hidden, inert, display:none, suljettu
//     <details>, testin antamat CSS-piilotukset) ja estetyt ohitetaan;
//     radioryhmästä vain valittu (tai ensimmäinen)
//   - saavutettava nimi (yksinkertaistettu accname): aria-labelledby,
//     aria-label, <label for>/ympäröivä label, sisältöteksti; aria-hidden
//     -sisältö ei kuulu nimeen, visuaalisesti piilotettu kuuluu
//
// CSS:ää ei tulkita. Testi kertoo CSS:n piilotukset valitsimina
// (hiddenBy), ja testi tarkistaa, että sääntö on yhä styles.css:ssä.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const AUTO_CLOSE = {
  p: ['p'], li: ['li'], option: ['option'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr'], td: ['td', 'th'], th: ['td', 'th']
};
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const CONTROLS = new Set(['button', 'input', 'select', 'textarea']);

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : all;
    }
    return NAMED[code.toLowerCase()] ?? all;
  });
}

/**
 * Solmujen identiteetti. ÄLÄ anna DOM-solmuja assert.equal:lle: epäonnistunut
 * vertailu kävisi AssertionErrorissa läpi koko dokumenttigraafin (node
 * ohittaa oman inspect-muodon), ja testi jumittuisi minuuteiksi.
 */
export function assertSameNode(actual, expected, message = 'eri solmu') {
  if (actual === expected) return;
  const error = new Error(`${message}: odotettiin ${describeNode(expected)}, saatiin ${describeNode(actual)}`);
  error.name = 'AssertionError';
  error.code = 'ERR_ASSERTION';
  throw error;
}

/** Vastakohta: solmu vaihtui (esim. uusi ajastin = uusi rakenne). */
export function assertDifferentNode(actual, other, message = 'sama solmu') {
  if (actual !== other) return;
  const error = new Error(`${message}: ${describeNode(actual)}`);
  error.name = 'AssertionError';
  error.code = 'ERR_ASSERTION';
  throw error;
}

/** Solmu lyhyesti: <button#id.luokka data-x="1"> "teksti" (irrallinen). */
export function describeNode(node) {
  if (!node) return String(node);
  if (node.nodeType === 9) return '#document';
  if (node.nodeType === 3) return `#text "${node.data.slice(0, 40)}"`;
  if (node.nodeType !== 1) return '#fragment';
  const id = node.getAttribute('id') ? '#' + node.getAttribute('id') : '';
  const cls = node.getAttribute('class') ? '.' + node.getAttribute('class').trim().split(/\s+/).join('.') : '';
  const data = [...node.attrs].filter(([key]) => key.startsWith('data-')).map(([key, value]) => ` ${key}="${value}"`).join('');
  const text = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
  return `<${node.localName}${id}${cls}${data}>${text ? ` "${text}"` : ''}${node.isConnected ? '' : ' (irrallinen)'}`;
}

const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escapeAttr = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
const kebab = key => key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// ------------------------------------------------------------ tapahtumat

export function makeEvent(type, init = {}) {
  return {
    bubbles: true, cancelable: true, key: undefined, shiftKey: false, ...init,
    type, target: null, currentTarget: null, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() { this.stopped = true; }
  };
}

// ------------------------------------------------------------ solmut

class Node {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = new Map();
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  /** Lyhyt kuvaus: assertin virheilmoitus ei käy läpi koko dokumenttia. */
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return describeNode(this);
  }

  get isConnected() {
    for (let node = this; node; node = node.parentNode) if (node === this.ownerDocument) return true;
    return false;
  }

  get firstChild() { return this.childNodes[0] || null; }

  appendChild(child) {
    if (child.nodeType === 11) {
      for (const node of [...child.childNodes]) this.appendChild(node);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node);
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index < 0) return child;
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    this.ownerDocument.detached(child);
    return child;
  }

  replaceChildren(...nodes) {
    for (const node of [...this.childNodes]) this.removeChild(node);
    this.append(...nodes);
  }

  /** Korvaa tämä solmu samalle paikalle (kuten selaimen Element.replaceWith). */
  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    parent.removeChild(this);
    const fresh = nodes.map(node => (typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node));
    for (const node of fresh) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = parent;
    }
    parent.childNodes.splice(index, 0, ...fresh);
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  get textContent() {
    return this.childNodes.map(node => node.textContent).join('');
  }

  set textContent(value) {
    for (const node of [...this.childNodes]) this.removeChild(node);
    const text = String(value ?? '');
    if (text) this.appendChild(this.ownerDocument.createTextNode(text));
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter(other => other !== fn));
  }

  dispatchEvent(event) {
    event.target = this;
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    for (const node of event.bubbles ? path : [this]) {
      event.currentTarget = node;
      for (const fn of [...(node.listeners.get(event.type) || [])]) fn.call(node, event);
      if (event.stopped) break;
    }
    return !event.defaultPrevented;
  }

  /** Testien lyhenne: laukaise tapahtuma (kuplii). */
  dispatch(type, init = {}) {
    const event = makeEvent(type, init);
    this.dispatchEvent(event);
    return event;
  }

  get elements() {
    const out = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelectorAll(selector) {
    const list = parseSelector(selector);
    return this.elements.filter(element => matchesList(element, list));
  }

  querySelector(selector) {
    const list = parseSelector(selector);
    return this.elements.find(element => matchesList(element, list)) || null;
  }
}

class Text extends Node {
  constructor(doc, data) {
    super(doc);
    this.data = String(data);
  }

  get nodeType() { return 3; }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value ?? ''); }
  cloneNode() { return new Text(this.ownerDocument, this.data); }
}

class Fragment extends Node {
  get nodeType() { return 11; }
}

const BOOLEAN_ATTRS = ['hidden', 'disabled', 'open', 'inert', 'required', 'multiple', 'readOnly'];

class Element extends Node {
  constructor(doc, name) {
    super(doc);
    this.localName = name.toLowerCase();
    this.attrs = new Map();
    this.props = {};
    this.styleProps = null;
  }

  get nodeType() { return 1; }
  get tagName() { return this.localName.toUpperCase(); }
  get nodeName() { return this.tagName; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }

  /** Attribuutit (ja syvänä lapset), ei ohjaimen ajonaikaista tilaa: kuten selaimessa. */
  cloneNode(deep = false) {
    const copy = new Element(this.ownerDocument, this.localName);
    for (const [key, value] of this.attrs) copy.attrs.set(key, value);
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }

  getAttribute(name) {
    const key = name.toLowerCase();
    return this.attrs.has(key) ? this.attrs.get(key) : null;
  }

  setAttribute(name, value) {
    const key = name.toLowerCase();
    this.attrs.set(key, String(value));
    if (key === 'style') this.styleProps = null;
  }

  hasAttribute(name) { return this.attrs.has(name.toLowerCase()); }

  removeAttribute(name) {
    const key = name.toLowerCase();
    this.attrs.delete(key);
    if (key === 'style') this.styleProps = null;
  }

  toggleAttribute(name, force) {
    const on = force === undefined ? !this.hasAttribute(name) : Boolean(force);
    if (on) this.setAttribute(name, this.getAttribute(name) ?? '');
    else this.removeAttribute(name);
    return on;
  }

  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }

  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }

  get classList() {
    const element = this;
    const list = () => element.className.split(/\s+/).filter(Boolean);
    const write = values => element.setAttribute('class', values.join(' '));
    return {
      contains: name => list().includes(name),
      add: (...names) => write([...new Set([...list(), ...names])]),
      remove: (...names) => write(list().filter(name => !names.includes(name))),
      toggle(name, force) {
        const has = list().includes(name);
        const on = force === undefined ? !has : Boolean(force);
        if (on && !has) write([...list(), name]);
        if (!on && has) write(list().filter(other => other !== name));
        return on;
      }
    };
  }

  get dataset() {
    const element = this;
    return new Proxy({}, {
      get: (_, key) => (typeof key === 'string' ? element.getAttribute('data-' + kebab(key)) ?? undefined : undefined),
      set: (_, key, value) => { element.setAttribute('data-' + kebab(String(key)), value); return true; },
      deleteProperty: (_, key) => { element.removeAttribute('data-' + kebab(String(key))); return true; },
      has: (_, key) => element.hasAttribute('data-' + kebab(String(key))),
      ownKeys: () => [...element.attrs.keys()].filter(name => name.startsWith('data-')).map(name => camel(name.slice(5))),
      getOwnPropertyDescriptor: (_, key) => (element.hasAttribute('data-' + kebab(String(key)))
        ? { value: element.getAttribute('data-' + kebab(String(key))), enumerable: true, configurable: true, writable: true }
        : undefined)
    });
  }

  get style() {
    if (!this.styleProps) {
      this.styleProps = {};
      for (const part of (this.getAttribute('style') || '').split(';')) {
        const [name, ...rest] = part.split(':');
        if (name && rest.length) this.styleProps[camel(name.trim())] = rest.join(':').trim();
      }
    }
    const element = this;
    return new Proxy(this.styleProps, {
      set(target, key, value) {
        target[key] = String(value ?? '');
        const text = Object.entries(target).filter(([, v]) => v !== '')
          .map(([name, v]) => `${kebab(name)}:${v}`).join('; ');
        const props = element.styleProps;
        element.attrs.set('style', text);
        element.styleProps = props;
        return true;
      }
    });
  }

  get type() {
    const type = (this.getAttribute('type') || '').toLowerCase();
    if (this.localName === 'button') return type === 'button' || type === 'reset' ? type : 'submit';
    if (this.localName === 'input') return type || 'text';
    if (this.localName === 'select') return 'select-one';
    return type;
  }

  set type(value) { this.setAttribute('type', value); }
  get name() { return this.getAttribute('name') ?? ''; }

  get value() {
    switch (this.localName) {
      case 'input':
        if ('value' in this.props) return this.props.value;
        return this.getAttribute('value') ?? (this.type === 'checkbox' || this.type === 'radio' ? 'on' : '');
      case 'textarea': return 'value' in this.props ? this.props.value : this.textContent;
      case 'select': {
        const option = this.selectedOption();
        return option ? option.value : '';
      }
      case 'option': return this.getAttribute('value') ?? this.textContent.replace(/\s+/g, ' ').trim();
      default: return this.getAttribute('value') ?? '';
    }
  }

  set value(value) {
    const text = String(value ?? '');
    if (this.localName === 'input' || this.localName === 'textarea') {
      this.props.value = text;
    } else if (this.localName === 'select') {
      let found = false;
      for (const option of this.querySelectorAll('option')) {
        option.props.selected = !found && option.value === text;
        if (option.props.selected) found = true;
      }
    } else {
      this.setAttribute('value', text);
    }
  }

  selectedOption() {
    const options = this.querySelectorAll('option');
    const selected = options.filter(option => option.selected);
    return selected.length ? selected[selected.length - 1] : options.find(option => !option.disabled) || null;
  }

  get selected() { return 'selected' in this.props ? this.props.selected : this.hasAttribute('selected'); }
  set selected(value) { this.props.selected = Boolean(value); }

  get checked() { return 'checked' in this.props ? this.props.checked : this.hasAttribute('checked'); }

  set checked(value) {
    this.props.checked = Boolean(value);
    if (value && this.type === 'radio' && this.name) {
      for (const other of radioGroup(this)) if (other !== this) other.props.checked = false;
    }
  }

  get tabIndex() {
    const raw = this.getAttribute('tabindex');
    if (raw !== null && /^\s*-?\d+\s*$/.test(raw)) return Number(raw);
    return isNativelyFocusable(this) ? 0 : -1;
  }

  set tabIndex(value) { this.setAttribute('tabindex', value); }

  get returnValue() { return this.props.returnValue ?? ''; }
  set returnValue(value) { this.props.returnValue = String(value ?? ''); }

  get innerHTML() { return this.childNodes.map(serialize).join(''); }

  set innerHTML(html) {
    for (const node of [...this.childNodes]) this.removeChild(node);
    parseInto(this, String(html ?? ''));
  }

  get outerHTML() { return serialize(this); }

  insertAdjacentHTML(position, html) {
    const holder = this.ownerDocument.createElement('div');
    parseInto(holder, html);
    const nodes = [...holder.childNodes];
    if (position === 'beforeend') for (const node of nodes) this.appendChild(node);
    else if (position === 'afterbegin') {
      for (const node of nodes.reverse()) {
        node.parentNode = this;
        this.childNodes.unshift(node);
      }
    } else throw new Error('insertAdjacentHTML: ' + position);
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  matches(selector) { return matchesList(this, parseSelector(selector)); }

  closest(selector) {
    const list = parseSelector(selector);
    for (let node = this; node && node.nodeType === 1; node = node.parentNode) if (matchesList(node, list)) return node;
    return null;
  }

  focus() {
    if (!canReceiveFocus(this)) return;
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }

  scrollIntoView() {}
  getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }

  /** Aktivointi kuten selaimessa: valintaruutu, summary, label, submit. */
  click() {
    if (this.disabled && CONTROLS.has(this.localName)) return;
    const toggles = this.localName === 'input' && (this.type === 'checkbox' || this.type === 'radio');
    const before = toggles ? this.checked : null;
    if (toggles) this.checked = this.type === 'checkbox' ? !before : true;
    const event = makeEvent('click');
    this.dispatchEvent(event);
    if (event.defaultPrevented) {
      if (toggles) this.checked = before;
      return;
    }
    if (toggles) {
      if (this.checked !== before) {
        this.dispatch('input');
        this.dispatch('change');
      }
      return;
    }
    if (this.localName === 'summary') {
      const details = this.parentNode;
      if (details && details.localName === 'details' && details.children.find(child => child.localName === 'summary') === this) {
        details.open = !details.open;
      }
      return;
    }
    if (this.localName === 'label') {
      const control = labelledControl(this);
      if (control) {
        control.focus();
        control.click();
      }
      return;
    }
    if (this.localName === 'button' && this.type === 'submit') submitForm(this.closest('form'), this);
  }

  showModal() {
    if (this.open) throw new Error('InvalidStateError: dialogi on jo auki');
    this.previousFocus = this.ownerDocument.activeElement;
    this.open = true;
    this.ownerDocument.modal = this;
    const first = tabOrder(this.ownerDocument)[0];
    if (first) first.focus();
  }

  show() { this.open = true; }

  close(value) {
    if (!this.open) return;
    if (value !== undefined) this.returnValue = value;
    this.open = false;
    if (this.ownerDocument.modal === this) this.ownerDocument.modal = null;
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous && previous.isConnected) previous.focus();
    else if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    queueMicrotask(() => this.dispatchEvent(makeEvent('close', { bubbles: false })));
  }
}

for (const name of BOOLEAN_ATTRS) {
  Object.defineProperty(Element.prototype, name, {
    get() { return this.hasAttribute(name); },
    set(value) { this.toggleAttribute(name, Boolean(value)); }
  });
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.activeElement = null;
    this.modal = null;
  }

  get nodeType() { return 9; }
  createElement(name) { return new Element(this, name); }
  createTextNode(text) { return new Text(this, text); }
  createDocumentFragment() { return new Fragment(this); }
  getElementById(id) { return this.elements.find(element => element.getAttribute('id') === id) || null; }

  /** Poistettu alipuu vei fokuksen mukanaan: selain siirtää sen bodyyn. */
  detached(node) {
    if (this.activeElement && node.contains(this.activeElement)) this.activeElement = this.body;
  }
}

// ------------------------------------------------------------ jäsennys

const TAG_NAME = /<([a-zA-Z][\w:-]*)/y;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
const END_TAG = /<\/([a-zA-Z][\w:-]*)\s*>/y;

function parseStartTag(html, start) {
  TAG_NAME.lastIndex = start;
  const name = TAG_NAME.exec(html)[1].toLowerCase();
  let index = TAG_NAME.lastIndex;
  const attrs = [];
  while (index < html.length) {
    while (/\s/.test(html[index])) index += 1;
    if (html[index] === '>') return { name, attrs, selfClosing: false, end: index + 1 };
    if (html.startsWith('/>', index)) return { name, attrs, selfClosing: true, end: index + 2 };
    if (html[index] === '/') { index += 1; continue; }
    ATTRIBUTE.lastIndex = index;
    const match = ATTRIBUTE.exec(html);
    if (!match || ATTRIBUTE.lastIndex === index) { index += 1; continue; }
    const key = match[1].toLowerCase();
    if (!attrs.some(([other]) => other === key)) attrs.push([key, decode(match[2] ?? match[3] ?? match[4] ?? '')]);
    index = ATTRIBUTE.lastIndex;
  }
  return { name, attrs, selfClosing: false, end: html.length };
}

function parseInto(parent, html) {
  const doc = parent.ownerDocument;
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  const close = name => {
    for (let depth = stack.length - 1; depth > 0; depth -= 1) {
      if (stack[depth].localName === name) { stack.length = depth; return; }
    }
  };
  let index = 0;
  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', index) || html.startsWith('<?', index)) {
      const end = html.indexOf('>', index);
      index = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', index)) {
      END_TAG.lastIndex = index;
      const match = END_TAG.exec(html);
      if (match) {
        close(match[1].toLowerCase());
        index = END_TAG.lastIndex;
        continue;
      }
    }
    if (html[index] === '<' && /[a-zA-Z]/.test(html[index + 1] || '')) {
      const tag = parseStartTag(html, index);
      index = tag.end;
      const element = doc.createElement(tag.name);
      for (const [key, value] of tag.attrs) element.attrs.set(key, value);
      const closes = AUTO_CLOSE[tag.name];
      if (closes && stack.length > 1 && closes.includes(top().localName)) stack.pop();
      top().appendChild(element);
      if (RAW.has(tag.name)) {
        const end = html.toLowerCase().indexOf('</' + tag.name, index);
        const text = html.slice(index, end < 0 ? html.length : end);
        const content = tag.name === 'textarea' || tag.name === 'title' ? decode(text.replace(/^\r?\n/, '')) : text;
        if (content) element.appendChild(doc.createTextNode(content));
        index = end < 0 ? html.length : html.indexOf('>', end) + 1;
        continue;
      }
      if (!VOID.has(tag.name) && !tag.selfClosing) stack.push(element);
      continue;
    }
    let next = html.indexOf('<', index + 1);
    if (next < 0) next = html.length;
    top().appendChild(doc.createTextNode(decode(html.slice(index, next))));
    index = next;
  }
}

function serialize(node) {
  if (node.nodeType === 3) {
    const parent = node.parentNode;
    return parent && parent.nodeType === 1 && (parent.localName === 'script' || parent.localName === 'style')
      ? node.data : escapeText(node.data);
  }
  if (node.nodeType !== 1) return node.childNodes.map(serialize).join('');
  const attrs = [...node.attrs].map(([key, value]) => ` ${key}="${escapeAttr(value)}"`).join('');
  if (VOID.has(node.localName)) return `<${node.localName}${attrs}>`;
  return `<${node.localName}${attrs}>${node.childNodes.map(serialize).join('')}</${node.localName}>`;
}

/**
 * Jäsennä koko dokumentti. Ilman <html>-juurta merkintä menee <body>:yn.
 * @returns {Document}
 */
export function createDocument(markup = '') {
  const doc = new Document();
  const holder = doc.createElement('div');
  parseInto(holder, String(markup));
  let html = holder.children.find(child => child.localName === 'html');
  if (!html) {
    html = doc.createElement('html');
    html.appendChild(doc.createElement('head'));
    const body = doc.createElement('body');
    for (const node of [...holder.childNodes]) body.appendChild(node);
    html.appendChild(body);
  }
  doc.appendChild(html);
  doc.documentElement = html;
  doc.head = html.children.find(child => child.localName === 'head') || null;
  doc.body = html.children.find(child => child.localName === 'body');
  if (!doc.body) {
    doc.body = doc.createElement('body');
    html.appendChild(doc.body);
  }
  doc.activeElement = doc.body;
  return doc;
}

/** CSS.escape (tunnisteet ja attribuuttiarvot valitsimissa). */
export function cssEscape(value) {
  return String(value).replace(/[\0-\x1f\x7f]|^-?\d|[^\w -￿-]/g, char => {
    if (/\d/.test(char[char.length - 1]) && char.length <= 2) {
      return (char.length === 2 ? '-' : '') + '\\' + char.charCodeAt(char.length - 1).toString(16) + ' ';
    }
    return '\\' + char;
  });
}

// ------------------------------------------------------------ valitsimet

const selectorCache = new Map();

function readIdentifier(text, start) {
  let index = start;
  let out = '';
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(text.slice(index + 1));
      if (hex) {
        out += String.fromCodePoint(parseInt(hex[0].trim(), 16));
        index += 1 + hex[0].length;
      } else {
        out += text[index + 1] ?? '';
        index += 2;
      }
      continue;
    }
    if (/[\w -￿-]/.test(char)) { out += char; index += 1; continue; }
    break;
  }
  return { value: out, end: index };
}

function readUntilBalanced(text, start, open, closeChar) {
  let depth = 1;
  let index = start;
  let quote = null;
  while (index < text.length) {
    const char = text[index];
    if (quote) {
      if (char === '\\') { index += 2; continue; }
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === open) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return { value: text.slice(start, index), end: index + 1 };
    }
    index += 1;
  }
  throw new Error('Valitsin: sulku puuttuu: ' + text);
}

function parseAttributeSelector(body) {
  const match = /^\s*([^\s~|^$*!=]+)\s*(?:([~|^$*]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]]+)))?\s*$/.exec(body);
  if (!match) throw new Error('Valitsin: attribuutti: ' + body);
  const raw = match[3] ?? match[4] ?? match[5];
  const value = raw === undefined ? undefined : readIdentifierValue(raw);
  return { name: match[1].toLowerCase(), op: match[2] || null, value };
}

function readIdentifierValue(raw) {
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '\\') { out += raw[index]; continue; }
    const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(raw.slice(index + 1));
    if (hex) {
      out += String.fromCodePoint(parseInt(hex[0].trim(), 16));
      index += hex[0].length;
    } else {
      out += raw[index + 1] ?? '';
      index += 1;
    }
  }
  return out;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}

function parseComplex(text) {
  const parts = [];
  let compound = null;
  let combinator = null;
  let index = 0;
  const fresh = () => ({ tag: null, ids: [], classes: [], attrs: [], pseudos: [] });
  const ensure = () => {
    if (!compound) {
      compound = fresh();
      parts.push({ combinator, compound });
      combinator = null;
    }
    return compound;
  };
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      if (compound) { compound = null; combinator = combinator || ' '; }
      index += 1;
      continue;
    }
    if (char === '>' || char === '+' || char === '~') {
      compound = null;
      combinator = char;
      index += 1;
      continue;
    }
    if (char === '*') { ensure().tag = '*'; index += 1; continue; }
    if (char === '#') {
      const id = readIdentifier(text, index + 1);
      ensure().ids.push(id.value);
      index = id.end;
      continue;
    }
    if (char === '.') {
      const cls = readIdentifier(text, index + 1);
      ensure().classes.push(cls.value);
      index = cls.end;
      continue;
    }
    if (char === '[') {
      const body = readUntilBalanced(text, index + 1, '[', ']');
      ensure().attrs.push(parseAttributeSelector(body.value));
      index = body.end;
      continue;
    }
    if (char === ':') {
      const name = readIdentifier(text, index + 1);
      let arg = null;
      index = name.end;
      if (text[index] === '(') {
        const body = readUntilBalanced(text, index + 1, '(', ')');
        arg = body.value;
        index = body.end;
      }
      ensure().pseudos.push({ name: name.value.toLowerCase(), arg });
      continue;
    }
    const tag = readIdentifier(text, index);
    if (!tag.value) throw new Error('Valitsin: tuntematon merkki: ' + text);
    ensure().tag = tag.value.toLowerCase();
    index = tag.end;
  }
  return parts;
}

function parseSelector(selector) {
  if (!selectorCache.has(selector)) selectorCache.set(selector, splitTopLevel(String(selector)).map(parseComplex));
  return selectorCache.get(selector);
}

function attributeMatches(element, { name, op, value }) {
  if (!element.hasAttribute(name)) return false;
  if (!op) return true;
  const actual = element.getAttribute(name);
  switch (op) {
    case '=': return actual === value;
    case '^=': return value !== '' && actual.startsWith(value);
    case '$=': return value !== '' && actual.endsWith(value);
    case '*=': return value !== '' && actual.includes(value);
    case '~=': return actual.split(/\s+/).includes(value);
    case '|=': return actual === value || actual.startsWith(value + '-');
    default: return false;
  }
}

function pseudoMatches(element, { name, arg }) {
  switch (name) {
    case 'not': return !matchesList(element, parseSelector(arg));
    case 'is': case 'where': return matchesList(element, parseSelector(arg));
    case 'has': return element.querySelector(arg) !== null;
    case 'checked': return element.localName === 'option' ? element.selected : Boolean(element.checked);
    case 'disabled': return CONTROLS.has(element.localName) && element.disabled;
    case 'enabled': return CONTROLS.has(element.localName) && !element.disabled;
    case 'focus': case 'focus-visible': return element.ownerDocument.activeElement === element;
    case 'focus-within': return element.contains(element.ownerDocument.activeElement);
    case 'first-child': return element.parentNode && element.parentNode.children[0] === element;
    case 'last-child': return element.parentNode && element.parentNode.children.at(-1) === element;
    case 'empty': return element.childNodes.every(node => node.nodeType !== 1 && !node.textContent);
    default: throw new Error('Valitsin: tukematon pseudoluokka :' + name);
  }
}

function matchesCompound(element, compound) {
  if (compound.tag && compound.tag !== '*' && element.localName !== compound.tag) return false;
  for (const id of compound.ids) if (element.getAttribute('id') !== id) return false;
  if (compound.classes.length) {
    const classes = element.className.split(/\s+/);
    for (const cls of compound.classes) if (!classes.includes(cls)) return false;
  }
  for (const attr of compound.attrs) if (!attributeMatches(element, attr)) return false;
  for (const pseudo of compound.pseudos) if (!pseudoMatches(element, pseudo)) return false;
  return true;
}

function matchesComplex(element, parts, index = parts.length - 1) {
  if (!matchesCompound(element, parts[index].compound)) return false;
  if (index === 0) return true;
  const combinator = parts[index].combinator;
  if (combinator === '>') {
    const parent = element.parentElement;
    return Boolean(parent) && matchesComplex(parent, parts, index - 1);
  }
  if (combinator === '+' || combinator === '~') {
    const siblings = element.parentNode ? element.parentNode.children : [];
    const before = siblings.slice(0, siblings.indexOf(element));
    const candidates = combinator === '+' ? before.slice(-1) : before;
    return candidates.some(sibling => matchesComplex(sibling, parts, index - 1));
  }
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (matchesComplex(parent, parts, index - 1)) return true;
  }
  return false;
}

function matchesList(element, list) {
  return element.nodeType === 1 && list.some(parts => matchesComplex(element, parts));
}

// ------------------------------------------------------------ lomake

function radioGroup(radio) {
  if (!radio.name) return [radio];
  const root = radio.closest('form') || radio.ownerDocument;
  return root.querySelectorAll('input').filter(input => input.type === 'radio' && input.name === radio.name);
}

function labelledControl(label) {
  const target = label.getAttribute('for');
  if (target) return label.ownerDocument.getElementById(target);
  return label.querySelector('input, select, textarea, button');
}

function fieldValid(field) {
  if (field.disabled) return true;
  const value = String(field.value ?? '');
  if (field.required) {
    if (field.type === 'checkbox' || field.type === 'radio') { if (!field.checked) return false; }
    else if (value.trim() === '') return false;
  }
  if (field.localName === 'input' && field.type === 'number' && value !== '') {
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    const min = field.getAttribute('min');
    const max = field.getAttribute('max');
    const step = field.getAttribute('step');
    if (min !== null && number < Number(min)) return false;
    if (max !== null && number > Number(max)) return false;
    if (step !== 'any') {
      const size = step === null ? 1 : Number(step);
      const base = min !== null ? Number(min) : 0;
      const ratio = (number - base) / size;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) return false;
    }
  }
  return true;
}

function submitForm(form, submitter) {
  if (!form) return;
  const novalidate = form.hasAttribute('novalidate') || (submitter && submitter.hasAttribute('formnovalidate'));
  if (!novalidate && !form.querySelectorAll('input, select, textarea').every(fieldValid)) return;
  const event = makeEvent('submit');
  form.dispatchEvent(event);
  if (event.defaultPrevented) return;
  if ((form.getAttribute('method') || '').toLowerCase() !== 'dialog') return;
  const dialog = form.closest('dialog');
  if (dialog && dialog.open) dialog.close(submitter && submitter.hasAttribute('value') ? submitter.getAttribute('value') : undefined);
}

// ------------------------------------------------------------ fokus

function isNativelyFocusable(element) {
  if (CONTROLS.has(element.localName)) return !(element.localName === 'input' && element.type === 'hidden');
  if (element.localName === 'a') return element.hasAttribute('href');
  if (element.localName === 'summary') {
    const details = element.parentNode;
    return Boolean(details) && details.localName === 'details'
      && details.children.find(child => child.localName === 'summary') === element;
  }
  return false;
}

function focusableCandidate(element) {
  if (CONTROLS.has(element.localName) && element.disabled) return false;
  if (element.closest('fieldset[disabled]')) return false;
  return isNativelyFocusable(element) || element.hasAttribute('tabindex');
}

/**
 * Näkyykö elementti (ja voiko se saada fokuksen)? hiddenBy = testin
 * kertomat CSS-piilotukset valitsimina.
 */
export function isRendered(element, { hiddenBy = [] } = {}) {
  if (!element || !element.isConnected) return false;
  for (let node = element; node && node.nodeType === 1; node = node.parentNode) {
    if (node.hidden || node.hasAttribute('inert')) return false;
    if (node.style.display === 'none') return false;
    if (node.localName === 'dialog' && !node.open) return false;
    const parent = node.parentNode;
    if (parent && parent.nodeType === 1 && parent.localName === 'details' && !parent.open
      && parent.children.find(child => child.localName === 'summary') !== node) return false;
    if (hiddenBy.some(selector => node.matches(selector))) return false;
  }
  return true;
}

function canReceiveFocus(element) {
  return element.isConnected && focusableCandidate(element) && isRendered(element);
}

/**
 * Sarkainjärjestys: modaalin ollessa auki vain sen sisältä.
 * @returns {Element[]}
 */
export function tabOrder(doc, { root = null, hiddenBy = [] } = {}) {
  const scope = doc.modal || root || doc.body;
  const candidates = scope.elements.filter(element => focusableCandidate(element)
    && element.tabIndex >= 0 && isRendered(element, { hiddenBy }));
  const seenGroups = new Set();
  return candidates.filter(element => {
    if (element.localName !== 'input' || element.type !== 'radio' || !element.name) return true;
    const group = radioGroup(element).filter(radio => candidates.includes(radio));
    const key = group[0];
    if (seenGroups.has(key)) return false;
    const chosen = group.find(radio => radio.checked) || group[0];
    if (chosen !== element) return false;
    seenGroups.add(key);
    return true;
  });
}

/** Sarkain: seuraava (tai edellinen) ohjain dokumenttijärjestyksessä. */
export function tab(doc, { shift = false, root = null, hiddenBy = [] } = {}) {
  const order = tabOrder(doc, { root, hiddenBy });
  if (order.length === 0) return null;
  const active = doc.activeElement;
  let next;
  const index = order.indexOf(active);
  if (index >= 0) {
    next = order[(index + (shift ? -1 : 1) + order.length) % order.length];
  } else {
    // Fokus ei-sarkainjärjestyksessä olevassa (esim. otsikko tabindex=-1):
    // jatketaan sen kohdalta dokumentissa.
    const all = doc.elements;
    const position = all.indexOf(active);
    const after = order.filter(element => all.indexOf(element) > position);
    const before = order.filter(element => all.indexOf(element) < position);
    next = shift ? (before.at(-1) || order.at(-1)) : (after[0] || order[0]);
  }
  next.focus();
  return next;
}

/**
 * Näppäinpainallus fokusoidussa elementissä: keydown, sitten selaimen
 * oletustoiminto, ellei sitä estetty.
 */
export function press(doc, key, { shiftKey = false, root = null, hiddenBy = [] } = {}) {
  const target = doc.activeElement || doc.body;
  const event = makeEvent('keydown', { key, shiftKey });
  target.dispatchEvent(event);
  if (!event.defaultPrevented) defaultKeyAction(doc, target, key, { shiftKey, root, hiddenBy });
  target.dispatchEvent(makeEvent('keyup', { key, shiftKey }));
  return event;
}

function defaultKeyAction(doc, target, key, { shiftKey, root, hiddenBy }) {
  const tag = target.localName;
  if (key === 'Tab') { tab(doc, { shift: shiftKey, root, hiddenBy }); return; }
  if (key === 'Escape') {
    const modal = doc.modal;
    if (!modal) return;
    const cancel = makeEvent('cancel', { bubbles: false });
    modal.dispatchEvent(cancel);
    if (!cancel.defaultPrevented) modal.close();
    return;
  }
  if (key === 'Enter') {
    if (tag === 'button' || tag === 'summary' || (tag === 'a' && target.hasAttribute('href'))) { target.click(); return; }
    if (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(target.type)) {
      const form = target.closest('form');
      // Implisiittinen lähetys: lomakkeen ENSIMMÄINEN submit-painike.
      const submit = form && form.querySelectorAll('button, input').find(button => button.type === 'submit');
      if (submit && !submit.disabled) submit.click();
    }
    return;
  }
  if (key === ' ') {
    if (tag === 'button' || tag === 'summary' || (tag === 'input' && (target.type === 'checkbox' || target.type === 'radio'))) target.click();
    return;
  }
  if (tag === 'input' && target.type === 'radio' && /^Arrow(Up|Down|Left|Right)$/.test(key)) {
    const group = radioGroup(target).filter(radio => !radio.disabled);
    const step = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1;
    const next = group[(group.indexOf(target) + step + group.length) % group.length];
    next.focus();
    next.click();
  }
}

/** Kirjoita kenttään (input-tapahtuma, kuten näppäily). */
export function type(field, text) {
  field.value = text;
  field.dispatch('input');
}

/** Valitse <select>-arvo näppäimistöllä (input + change). */
export function choose(select, value) {
  if (!select.querySelectorAll('option').some(option => option.value === value)) {
    throw new Error(`valinnassa ${select.id} ei ole arvoa ${value}`);
  }
  select.value = value;
  select.dispatch('input');
  select.dispatch('change');
}

// ------------------------------------------------------------ nimet

function nameText(node, skip) {
  if (node.nodeType === 3) return node.data;
  if (node.nodeType !== 1) return '';
  if (node === skip) return '';
  if (node.getAttribute('aria-hidden') === 'true') return '';
  if (node.localName === 'script' || node.localName === 'style') return '';
  if (node.hasAttribute('aria-label') && node !== skip) return ' ' + node.getAttribute('aria-label') + ' ';
  const inner = node.childNodes.map(child => nameText(child, skip)).join('');
  return /^(div|p|li|br|h\d|dt|dd|fieldset|legend|label|section|ul|ol|table|tr|td|th)$/.test(node.localName) ? ` ${inner} ` : inner;
}

const collapse = text => text.replace(/\s+/g, ' ').trim();

/** Saavutettava nimi (yksinkertaistettu accname-algoritmi). */
export function accessibleName(element) {
  const doc = element.ownerDocument;
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map(id => doc.getElementById(id)).filter(Boolean)
      .map(node => nameText(node, null)).join(' ');
    if (collapse(text)) return collapse(text);
  }
  const label = element.getAttribute('aria-label');
  if (label && label.trim()) return collapse(label);
  if (['input', 'select', 'textarea'].includes(element.localName)) {
    const parts = [];
    if (element.id) {
      for (const node of doc.querySelectorAll('label')) {
        if (node.getAttribute('for') === element.id) parts.push(nameText(node, element));
      }
    }
    const wrapping = element.closest('label');
    if (wrapping && !parts.length) parts.push(nameText(wrapping, element));
    if (collapse(parts.join(' '))) return collapse(parts.join(' '));
    return collapse(element.getAttribute('title') || '');
  }
  if (element.localName === 'fieldset') {
    const legend = element.children.find(child => child.localName === 'legend');
    return legend ? collapse(nameText(legend, null)) : '';
  }
  if (['button', 'summary', 'a', 'h1', 'h2', 'h3', 'h4', 'option'].includes(element.localName)
    || ['button', 'link', 'tab', 'heading', 'switch', 'radio'].includes(element.getAttribute('role'))) {
    return collapse(nameText(element, null)) || collapse(element.getAttribute('title') || '');
  }
  return collapse(element.getAttribute('title') || '');
}

/** Näkyvä teksti (aria-hidden mukana; ilman piilotettuja). */
export function visibleText(element) {
  return collapse(element.textContent);
}

/**
 * Asenna dokumentti globaaliksi (document, CSS, localStorage) ja palauta
 * siivous. Näkymämoduulit käyttävät globaalia `document`ia.
 */
export function installDocument(doc) {
  const saved = { document: globalThis.document, CSS: globalThis.CSS, localStorage: globalThis.localStorage };
  const data = new Map();
  globalThis.document = doc;
  globalThis.CSS = { escape: cssEscape };
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    clear: () => data.clear(),
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
}
