// Captures console errors, uncaught errors and rejections (+ anything reported via ctx.reportError).
// Exposed to tests through __game.errors().
export interface ErrorLog {
  list: string[];
  report(msg: string): void;
}

export function createErrorLog(): ErrorLog {
  const list: string[] = [];
  const report = (msg: string) => {
    if (list.length < 200) list.push(msg.slice(0, 2000));
  };
  const origError = console.error.bind(console);
  console.error = (...a: unknown[]) => {
    report(a.map((x) => (x instanceof Error ? (x.stack ?? x.message) : typeof x === 'string' ? x : safeJson(x))).join(' '));
    origError(...a);
  };
  addEventListener('error', (e) => report(`uncaught: ${e.message} @ ${e.filename}:${e.lineno}`));
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason as unknown;
    report(`unhandled rejection: ${r instanceof Error ? (r.stack ?? r.message) : String(r)}`);
  });
  return { list, report: (msg) => { origError(msg); report(msg); } };
}

function safeJson(x: unknown): string {
  try { return JSON.stringify(x); } catch { return String(x); }
}
