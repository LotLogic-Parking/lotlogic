// A small PostgREST fake for the sweep's Deno tests (not bundled: nothing
// the functions import pulls it in). Filters run in memory over the rows
// given per table; update() patches the rows the chain has narrowed to.
// Timestamps compare as strings, so tests use one ISO format throughout.
// failUpdates names tables whose update() returns an error and changes nothing;
// failReads, tables whose reads return an error. maxRows caps every read,
// as PostgREST's max-rows does (the first rows in table order).

export type Row = Record<string, unknown>;
export function fakeDb(tables: Record<string, Row[]>, opts: { failUpdates?: string[]; failReads?: string[]; maxRows?: number } = {}) {
  let seq = 0;
  return {
    from(table: string) {
      const all = tables[table] ?? (tables[table] = []);
      let rows = [...all];
      let patch: Row | null = null;
      const b: Record<string, unknown> = {};
      const self = b as Record<string, (...a: unknown[]) => unknown>;
      const finish = () => {
        if (patch && opts.failUpdates?.includes(table)) return { data: null, error: { message: `fake update failed on ${table}` } };
        if (!patch && opts.failReads?.includes(table)) return { data: null, error: { message: `fake read failed on ${table}` } };
        if (patch) for (const r of rows) Object.assign(r, patch);
        return { data: !patch && opts.maxRows != null ? rows.slice(0, opts.maxRows) : rows, error: null };
      };
      // Any point in the chain can be awaited, as with supabase-js.
      self.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(finish()).then(res, rej);
      self.select = () => Object.assign(Object.create(b), { then: (res: (v: unknown) => unknown) => Promise.resolve(finish()).then(res) });
      self.insert = (row: unknown) => { const r = { id: `v${++seq}`, ...(row as Row) }; all.push(r); rows = [r]; return b; };
      self.update = (p: unknown) => { patch = p as Row; return b; };
      self.eq = (c: unknown, v: unknown) => { rows = rows.filter(r => (c === "properties.property_type" ? (r.properties as Row)?.property_type : r[c as string]) === v); return b; };
      self.is = (c: unknown, _v: unknown) => { rows = rows.filter(r => r[c as string] == null); return b; };
      self.in = (c: unknown, v: unknown) => { rows = rows.filter(r => (v as unknown[]).includes(r[c as string])); return b; };
      self.lt = (c: unknown, v: unknown) => { rows = rows.filter(r => String(r[c as string]) < String(v)); return b; };
      self.lte = (c: unknown, v: unknown) => { rows = rows.filter(r => String(r[c as string]) <= String(v)); return b; };
      self.gte = (c: unknown, v: unknown) => { rows = rows.filter(r => String(r[c as string]) >= String(v)); return b; };
      self.gt = (c: unknown, v: unknown) => { rows = rows.filter(r => String(r[c as string]) > String(v)); return b; };
      const col = (r: Row, c: string) => (c.startsWith("properties.") ? (r.properties as Row)?.[c.slice(11)] : r[c]);
      self.neq = (c: unknown, v: unknown) => { rows = rows.filter(r => col(r, c as string) !== v); return b; };
      self.not = (c: unknown, op: unknown, v: unknown) => {
        if (op !== "in") throw new Error(`fake not(${String(op)})`);
        const list = String(v).replace(/^\(|\)$/g, "").split(",");
        rows = rows.filter(r => !list.includes(String(r[c as string]))); return b;
      };
      self.limit = (n: unknown) => { rows = rows.slice(0, Number(n)); return Promise.resolve(finish()); };
      self.maybeSingle = () => { const o = finish(); return Promise.resolve({ data: o.data?.[0] ?? null, error: o.error }); };
      self.single = () => { const o = finish(); return Promise.resolve({ data: o.data?.[0] ?? null, error: o.error }); };
      return b;
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

