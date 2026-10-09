// Owner: track (d) Meta. A minimal DOM for Node, just enough for Preact 11 to render and update a settings panel
// (no layout, no CSS, no canvas): elements, text nodes, attributes, form-control properties, bubbling events and a
// small querySelector (tag, .class, [attr="v"] and descendant chains). Used by tests/meta/settings-dom.test.ts.

class FakeNode {
  nodeType: number;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  data = '';
  constructor(nodeType: number) { this.nodeType = nodeType; }
  get ownerDocument(): unknown { return (globalThis as unknown as { document: unknown }).document; }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): FakeNode | null { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null; }
  get previousSibling(): FakeNode | null { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) - 1] ?? null : null; }
  appendChild(c: FakeNode): FakeNode { return this.insertBefore(c, null); }
  insertBefore(c: FakeNode, ref: FakeNode | null): FakeNode {
    c.parentNode?.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c);
    else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c: FakeNode): FakeNode {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  replaceChild(n: FakeNode, o: FakeNode): FakeNode { this.insertBefore(n, o); return this.removeChild(o); }
  remove(): void { this.parentNode?.removeChild(this); }
  contains(n: FakeNode | null): boolean { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  get textContent(): string { return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) {
    if (this.nodeType === 3) { this.data = String(v); return; }
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v !== '' && v != null) this.appendChild(new FakeText(String(v)));
  }
}

class FakeText extends FakeNode {
  constructor(d: string) { super(3); this.data = String(d); }
}

type Listener = (this: FakeElement, e: FakeEvent) => void;

class FakeElement extends FakeNode {
  localName: string;
  tagName: string;
  namespaceURI: string;
  style: Record<string, unknown> & { cssText: string; setProperty(k: string, v: string): void } = {
    cssText: '',
    setProperty(k: string, v: string) { (this as Record<string, unknown>)[k] = v; },
  };
  private attrs = new Map<string, string>();
  private ls: Record<string, Set<Listener>> = {};
  constructor(tag: string, ns = 'http://www.w3.org/1999/xhtml') {
    super(1);
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.namespaceURI = ns;
  }
  get attributes(): { name: string; value: string }[] { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  setAttribute(k: string, v: unknown): void { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  get className(): string { return this.getAttribute('class') ?? ''; }
  set className(v: string) { this.setAttribute('class', v); }
  get classes(): string[] { return this.className.split(/\s+/).filter(Boolean); }
  addEventListener(t: string, fn: Listener): void { (this.ls[t] ??= new Set()).add(fn); }
  removeEventListener(t: string, fn: Listener): void { this.ls[t]?.delete(fn); }
  dispatchEvent(e: FakeEvent): boolean {
    e.target = this;
    for (let n: FakeNode | null = this; n; n = n.parentNode) {
      if (!(n instanceof FakeElement)) break;
      e.currentTarget = n;
      for (const fn of n.ls[e.type] ?? []) fn.call(n, e);
      if (!e.bubbles) break;
    }
    return !e.defaultPrevented;
  }
  focus(): void {}
  blur(): void {}
  matches(sel: string): boolean { return matchOne(this, sel.trim()); }
  closest(sel: string): FakeElement | null {
    for (let n: FakeNode | null = this; n instanceof FakeElement; n = n.parentNode) if (n.matches(sel)) return n;
    return null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const parts = sel.trim().split(/\s+/);
    const out: FakeElement[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.childNodes) {
        if (c instanceof FakeElement) {
          if (matchChain(c, parts, this)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeElement | null { return this.querySelectorAll(sel)[0] ?? null; }
}

/** form controls keep value / checked / disabled as properties, so Preact sets them as properties */
class FakeControl extends FakeElement {
  value = '';
  checked = false;
  disabled = false;
  type = '';
}

/** one compound selector: tag, .class and [attr="v"] parts (e.g. span.m-small, input[data-testid="x"]) */
function matchOne(el: FakeElement, sel: string): boolean {
  const m = /^([a-z0-9-]*)((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(sel);
  if (!m) throw new Error(`selector not supported by the shim: ${sel}`);
  if (m[1] && el.localName !== m[1].toLowerCase()) return false;
  for (const p of m[2].match(/\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) ?? []) {
    if (p[0] === '.') {
      if (!el.classes.includes(p.slice(1))) return false;
      continue;
    }
    const a = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(p);
    if (!a || !el.hasAttribute(a[1]) || (a[2] !== undefined && el.getAttribute(a[1]) !== a[2])) return false;
  }
  return true;
}

/** descendant chain: the last part matches el, the earlier parts match its ancestors (inside root), in order */
function matchChain(el: FakeElement, parts: string[], root: FakeNode): boolean {
  if (!matchOne(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  for (let n = el.parentNode; n && n !== root && i >= 0; n = n.parentNode) if (n instanceof FakeElement && matchOne(n, parts[i])) i--;
  return i < 0;
}

class FakeDocument extends FakeNode {
  body: FakeElement;
  constructor() {
    super(9);
    this.body = this.createElement('body');
    this.appendChild(this.body);
  }
  createElement(tag: string): FakeElement {
    return ['input', 'select', 'textarea', 'button', 'option'].includes(tag.toLowerCase()) ? new FakeControl(tag) : new FakeElement(tag);
  }
  createElementNS(ns: string, tag: string): FakeElement { const e = this.createElement(tag); e.namespaceURI = ns; return e; }
  createTextNode(d: string): FakeText { return new FakeText(d); }
  addEventListener(): void {}
  removeEventListener(): void {}
}

export class FakeEvent {
  type: string;
  bubbles: boolean;
  defaultPrevented = false;
  target: FakeElement | null = null;
  currentTarget: FakeElement | null = null;
  constructor(type: string, init: { bubbles?: boolean } = {}) { this.type = type; this.bubbles = !!init.bubbles; }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void {}
}

export type DomElement = FakeElement;
export type DomControl = FakeControl;

/** install the shim's document, window, localStorage and timers on globalThis (idempotent); returns the document */
export function installDom(): FakeDocument {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.document instanceof FakeDocument) return g.document;
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
  const doc = new FakeDocument();
  Object.assign(g, {
    document: doc, window: globalThis, localStorage: storage, sessionStorage: storage, Event: FakeEvent,
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    addEventListener: () => {}, removeEventListener: () => {},
  });
  return doc;
}

/** let Preact's queued renders and effects run */
export async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

/** set a control's value / checked state and fire 'change' (what a click or a pick in a list does) */
export async function change(el: FakeElement | null, v: { value?: string; checked?: boolean }): Promise<void> {
  if (!(el instanceof FakeControl)) throw new Error('not a form control');
  if (v.value !== undefined) el.value = v.value;
  if (v.checked !== undefined) el.checked = v.checked;
  el.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  await flush();
}
