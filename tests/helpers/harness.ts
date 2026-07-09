import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth";

/**
 * Test harness: a chainable, thenable Supabase mock + mutable auth state.
 * Route files vi.mock "@/lib/supabase/admin" and "@/lib/auth" to point here.
 */

export interface Op {
  table: string;
  method: "select" | "insert" | "update" | "upsert" | "delete";
  columns?: string;
  selectOptions?: { count?: string; head?: boolean };
  upsertOptions?: unknown;
  payload?: unknown;
  filters: { op: string; column?: string; value?: unknown }[];
  modifiers: {
    order?: { column: string; ascending?: boolean };
    limit?: number;
    single?: boolean;
    maybeSingle?: boolean;
  };
}

export interface OpResult {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  count?: number | null;
}

export type Responder = (op: Op) => OpResult | undefined;

export const authState: { actor: Actor | null } = { actor: null };

export const dbHolder: { db: MockDb | null } = { db: null };

/** Scripted Claude API responses: shift one per messages.create call. */
export const anthropicState: {
  queue: Record<string, unknown>[];
  requests: Record<string, unknown>[];
} = { queue: [], requests: [] };

export interface MockDb {
  from: (table: string) => Record<string, unknown>;
  rpc: (fn: string, args?: unknown) => Record<string, unknown>;
  storage: { from: (bucket: string) => { upload: (path: string, body: unknown, opts?: unknown) => Promise<{ error: { message: string } | null }> } };
  __ops: Op[];
  __uploads: { bucket: string; path: string; bytes: number }[];
}

export function createMockDb(
  responder: Responder = () => undefined,
  opts?: { uploadError?: string },
): MockDb {
  const ops: Op[] = [];
  const makeBuilder = (table: string, rpcArgs?: unknown) => {
    const op: Op = { table, method: "select", filters: [], modifiers: {}, payload: rpcArgs };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    const chain = (fn: () => void) => {
      fn();
      return b;
    };
    b.select = (columns = "*", options?: Op["selectOptions"]) =>
      chain(() => {
        if (op.method === "select") {
          op.columns = columns;
          op.selectOptions = options;
        }
      });
    b.insert = (payload: unknown) => chain(() => Object.assign(op, { method: "insert", payload }));
    b.update = (payload: unknown) => chain(() => Object.assign(op, { method: "update", payload }));
    b.upsert = (payload: unknown, upsertOptions?: unknown) =>
      chain(() => Object.assign(op, { method: "upsert", payload, upsertOptions }));
    b.delete = () => chain(() => Object.assign(op, { method: "delete" }));
    for (const f of ["eq", "neq", "in", "gte", "lte", "gt", "lt", "ilike", "like", "is", "contains"]) {
      b[f] = (column: string, value: unknown) => chain(() => op.filters.push({ op: f, column, value }));
    }
    b.order = (column: string, opts?: { ascending?: boolean }) =>
      chain(() => (op.modifiers.order = { column, ...opts }));
    b.limit = (n: number) => chain(() => (op.modifiers.limit = n));
    b.single = () => chain(() => (op.modifiers.single = true));
    b.maybeSingle = () => chain(() => (op.modifiers.maybeSingle = true));
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      ops.push(op);
      const raw = responder(op) ?? {};
      let data = raw.data;
      if (data === undefined) {
        data = op.modifiers.single || op.modifiers.maybeSingle ? null : [];
      }
      const result = { data, error: raw.error ?? null, count: raw.count ?? null };
      if (op.modifiers.single && !result.error && result.data === null) {
        result.error = { message: `no rows returned for single() on ${op.table}`, code: "PGRST116" };
      }
      return Promise.resolve(result).then(resolve, reject);
    };
    return b;
  };
  const uploads: MockDb["__uploads"] = [];
  return {
    from: (table: string) => makeBuilder(table),
    // Supabase RPCs surface as ops with table `rpc:<fn>` and the args as payload.
    rpc: (fn: string, args?: unknown) => makeBuilder(`rpc:${fn}`, args),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: unknown) => {
          uploads.push({ bucket, path, bytes: body instanceof Buffer ? body.length : 0 });
          return { error: opts?.uploadError ? { message: opts.uploadError } : null };
        },
      }),
    },
    __ops: ops,
    __uploads: uploads,
  };
}

/** Routes ops by table name; falls back to defaults for unhandled tables. */
export function byTable(handlers: Record<string, Responder>): Responder {
  return (op) => handlers[op.table]?.(op);
}

export function makeReq(
  url: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string },
): NextRequest {
  const headers = new Headers(init?.headers);
  let body: string | undefined;
  if (init?.rawBody !== undefined) {
    body = init.rawBody;
  } else if (init?.body !== undefined) {
    body = JSON.stringify(init.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new NextRequest(url, { method: init?.method ?? "GET", headers, body });
}

export const HUMAN: Actor = { type: "human", email: "brandonbright@gmail.com" };
export const AGENT = (name = "openclaw"): Actor => ({ type: "agent", agentName: name });

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
