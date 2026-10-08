// Owner: fieldguide (v1.2) client. Our toasts never cover the booklet or the bulletin reader (gate R: four NEW ENTRY /
// PAGE FILED toasts stacked over the open booklet's HEARD/SEEN/DEATHS/ESCAPES row). While a fieldguide sheet is open,
// announcements are held and shown when it closes; the ones already up when a sheet opens are taken down (they pointed
// at [J], and the player is now looking at the guide); the reader's own page needs no toast (its FILED stamp says it).
// Only our own toasts are touched, never other packages'. No DOM, no CSS: unit-tested under Node (tests/fieldguide).
import { effect, untracked } from '@preact/signals';
import type { ReadonlySignal, Signal } from '@preact/signals';
import type { Toast } from '../core/ui/api.ts';

/** the part of ctx.ui this needs */
export interface ToastUi {
  toast(text: string, kind?: Toast['kind'], ms?: number): void;
  readonly toasts: Signal<Toast[]>;
  readonly screen: ReadonlySignal<{ name: string; props: Record<string, unknown> }>;
}
export interface FgToastOpts {
  /** screens that cover the view (the booklet, the reader) */
  sheets: readonly string[];
  /** the reader screen: its props.pageId is the page it shows */
  reader: string;
  ms: number;
  /** at most this many held announcements are shown when a sheet closes; more become one summary toast */
  flushMax: number;
  /** false drops the held ones on close (the van left: the drive / results screens own the view) */
  canFlush(): boolean;
}
export interface FgToasts {
  /** show now, or hold while a sheet is open. key: 'page:<id>' | '<kind>:<title>' (one held entry per key) */
  announce(key: string, text: string): void;
  /** test hook: texts held, and ours on screen */
  peek(): { held: string[]; up: string[] };
  dispose(): void;
}

export function fgToasts(ui: ToastUi, o: FgToastOpts): FgToasts {
  const isSheet = (name: string): boolean => o.sheets.includes(name);
  /** our toasts currently up -> what each announces */
  const up = new Map<Toast, string>();
  let held: { key: string; text: string }[] = [];

  const prune = (): Toast[] => {
    const all = ui.toasts.peek();
    for (const t of [...up.keys()]) if (!all.includes(t)) up.delete(t); // expired on their own
    return all;
  };
  const takeDown = (which: (key: string) => boolean): void => {
    const all = prune();
    const drop = new Set([...up].filter(([, k]) => which(k)).map(([t]) => t));
    if (!drop.size) return;
    for (const t of drop) up.delete(t);
    ui.toasts.value = all.filter((t) => !drop.has(t));
  };
  const announce = (key: string, text: string): void => {
    if (isSheet(ui.screen.peek().name)) {
      held = [...held.filter((h) => h.key !== key), { key, text }];
      return;
    }
    ui.toast(text, 'info', o.ms);
    const all = ui.toasts.peek();
    const t = all[all.length - 1];
    if (t && t.text === text) up.set(t, key);
  };

  let last = ui.screen.peek().name;
  const dispose = effect(() => {
    const s = ui.screen.value;
    untracked(() => {
      const was = last;
      last = s.name;
      if (isSheet(s.name)) {
        const own = s.name === o.reader && typeof s.props.pageId === 'string' ? `page:${s.props.pageId}` : null;
        if (own) held = held.filter((h) => h.key !== own);
        if (!isSheet(was)) takeDown(() => true);
        else if (own) takeDown((k) => k === own);
        return;
      }
      if (!isSheet(was) || !held.length) return;
      const out = held;
      held = [];
      if (!o.canFlush()) return;
      const shown = out.length > o.flushMax ? out.slice(-(o.flushMax - 1)) : out;
      if (out.length > shown.length) announce('more', `FIELD GUIDE · ${out.length - shown.length} MORE NEW ENTRIES  [J]`);
      for (const h of shown) announce(h.key, h.text);
    });
  });

  return {
    announce,
    peek: () => {
      prune();
      return { held: held.map((h) => h.text), up: [...up.keys()].map((t) => t.text) };
    },
    dispose,
  };
}
