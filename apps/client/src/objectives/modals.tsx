// Owner: track (a) Objectives. Modal screens: the vault keypad (0-9, CLR, ENT; keyboard too) and the clue-note reader
// (paper sheet with typewriter text). Opened via ctx.ui.setScreen('obj-keypad' | 'obj-note', { id }); the players
// track pauses movement and releases pointer lock while a screen is up.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ScreenProps } from '../core/ui/api.ts';
import { objState } from './state.ts';

function sfx(ctx: ScreenProps['ctx'], key: string, volume = 0.8): void {
  try { ctx.services.use('sfx')?.play(key, undefined, { ui: true, volume }); } catch { /* audio optional */ }
}

function close(ctx: ScreenProps['ctx']): void {
  ctx.ui.setScreen('none');
}

export function KeypadScreen(props: ScreenProps) {
  const { ctx } = props;
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<{ text: string; tone: 'idle' | 'ok' | 'bad' | 'busy' }>({ text: 'ENTER CODE', tone: 'idle' });
  const [shake, setShake] = useState(0);
  const busy = useRef(false);
  const st = objState.value;
  const kp = st?.keypad ?? null;
  const powered = !!kp?.enabled;
  const open = !!st?.vaultOpen;

  const press = (k: string) => {
    if (busy.current) return;
    if (!powered) {
      sfx(ctx, 'sfx.keypad_deny', 0.5);
      setStatus({ text: 'NO POWER', tone: 'bad' });
      return;
    }
    sfx(ctx, 'sfx.keypad_press', 0.7);
    void ctx.net.req('objectives.key', { key: k }).catch(() => undefined);
    if (k === 'C') { setCode(''); setStatus({ text: 'ENTER CODE', tone: 'idle' }); return; }
    if (k === 'E') { void submit(); return; }
    if (status.tone === 'bad') setStatus({ text: 'ENTER CODE', tone: 'idle' });
    setCode((c) => (c.length >= 4 ? c : c + k));
  };

  const submit = async () => {
    if (busy.current) return;
    const c = code;
    if (c.length < 4) { setStatus({ text: '4 DIGITS', tone: 'bad' }); sfx(ctx, 'sfx.keypad_deny', 0.6); return; }
    busy.current = true;
    setStatus({ text: 'CHECKING', tone: 'busy' });
    try {
      const r = await ctx.net.req('objectives.keypad', { code: c, id: kp?.id });
      if (r.ok) {
        setStatus({ text: 'ACCESS GRANTED', tone: 'ok' });
        sfx(ctx, 'sfx.keypad_accept', 0.9);
        setTimeout(() => close(ctx), 900);
      } else {
        setStatus({ text: (r.msg ?? 'DENIED').toUpperCase().slice(0, 22), tone: 'bad' });
        sfx(ctx, 'sfx.keypad_deny', 0.9);
        setShake((s) => s + 1);
        setCode('');
        busy.current = false;
      }
    } catch (e) {
      setStatus({ text: 'NO SIGNAL', tone: 'bad' });
      busy.current = false;
      void e;
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (/^Digit\d$|^Numpad\d$/.test(e.code)) press(e.code.slice(-1));
      else if (e.code === 'Backspace') setCode((c) => c.slice(0, -1));
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') void submit();
      else if (e.code === 'Escape' || e.code === 'KeyE' || e.code === 'Tab') close(ctx);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'E'];
  const disp = open ? 'OPEN' : !powered ? '' : code.padEnd(4, '·').split('').join(' ');
  return (
    <div class="obj-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) close(ctx); }}>
      <div class={`obj-keypad${shake % 2 ? ' shake' : ''}${shake && shake % 2 === 0 ? ' shake2' : ''}`}>
        <div class="obj-kp-brand">VAULT ACCESS · MODEL 4</div>
        <div class={`obj-kp-screen ${powered ? status.tone : 'dead'}`}>
          <div class="obj-kp-code">{disp}</div>
          <div class="obj-kp-status">{open ? 'UNLOCKED' : powered ? status.text : 'NO POWER'}</div>
        </div>
        <div class="obj-kp-keys">
          {keys.map((k) => (
            <button key={k} class={`obj-kp-key${k === 'E' ? ' ent' : k === 'C' ? ' clr' : ''}`} onClick={() => press(k)} disabled={open}>
              {k === 'E' ? 'ENT' : k === 'C' ? 'CLR' : k}
            </button>
          ))}
        </div>
        <div class={`obj-kp-led ${open ? 'ok' : powered ? 'on' : 'off'}`} />
        <div class="obj-kp-hint">0-9 · ENTER · ESC</div>
      </div>
    </div>
  );
}

export function NoteScreen(props: ScreenProps) {
  const { ctx } = props;
  const id = String(props.id ?? '');
  const note = objState.value?.notes.find((n) => n.id === id) ?? null;
  const full = note ? note.body : '';
  const [n, setN] = useState(0);
  useEffect(() => {
    sfx(ctx, 'sfx.cloth', 0.6);
    let i = 0;
    const h = setInterval(() => {
      i = Math.min(full.length, i + 3);
      setN(i);
      if (i >= full.length) clearInterval(h);
    }, 16);
    return () => clearInterval(h);
  }, [id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' || e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (n < full.length) setN(full.length);
        else close(ctx);
      }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });
  if (!note) {
    return <div class="obj-modal-bg" onClick={() => close(ctx)}><div class="obj-paper"><div class="obj-paper-body">(the page is blank)</div></div></div>;
  }
  const done = n >= full.length;
  return (
    <div class="obj-modal-bg" onClick={() => (done ? close(ctx) : setN(full.length))}>
      <div class="obj-paper" style={{ transform: `rotate(${(id.length % 3) - 1}deg)` }}>
        <div class="obj-paper-tape" />
        <div class="obj-paper-title">{note.title}</div>
        <div class="obj-paper-body">
          {full.slice(0, n)}
          {!done && <span class="obj-caret">▍</span>}
        </div>
        <div class="obj-paper-foot">{done ? 'E / ESC · put it back' : 'click to skip'}</div>
      </div>
    </div>
  );
}
