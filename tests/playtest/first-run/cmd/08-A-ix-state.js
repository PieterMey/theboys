const pg = P.A.page;
return await pg.evaluate(() => {
  const ix = window.__ix;
  const st = ix.state();
  const keys = Object.keys(st ?? {});
  const list = st?.interactables ?? st?.items ?? st?.ints ?? null;
  const arr = Array.isArray(list) ? list : list ? Object.values(list) : [];
  const near = arr.filter((i) => ['mirror','board','shop','console','kennel','leave_lever','deposit'].includes(i.kind)).map((i) => ({ id: i.id, kind: i.kind, p: i.p, enabled: i.enabled, label: i.label }));
  return { keys, n: arr.length, near, cam: ix.camera?.(), aim: ix.aim?.(), target: ix.target?.() };
});
