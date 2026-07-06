import crypto from "node:crypto";
import { env } from "@/lib/env";

/**
 * Google Search Console minimal client (service-account JWT, no SDK).
 * GSC_TRACKED format:  Brand|siteUrl|query1;query2, Brand2|siteUrl2|query3
 */
export interface TrackedSite {
  brand: string;
  siteUrl: string;
  queries: string[];
}

export function parseTracked(raw = env.gscTracked): TrackedSite[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [brand, siteUrl, queries = ""] = entry.split("|").map((p) => p.trim());
      return { brand, siteUrl, queries: queries.split(";").map((q) => q.trim()).filter(Boolean) };
    })
    .filter((t) => t.brand && t.siteUrl);
}

export function gscConfigured(): boolean {
  return Boolean(process.env.GSC_CLIENT_EMAIL && process.env.GSC_PRIVATE_KEY && process.env.GSC_TRACKED);
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export async function getAccessToken(fetchImpl: typeof fetch = fetch, now = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: env.gscClientEmail,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  );
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(env.gscPrivateKey)
    .toString("base64url");
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) throw new Error(`GSC token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("GSC token exchange returned no access_token");
  return body.access_token;
}

export interface QueryDayRow {
  date: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}

/** Per-day rows for tracked queries over the last `days` days (GSC lags ~2d). */
export async function queryDaily(
  site: TrackedSite,
  opts: { token: string; days?: number; fetchImpl?: typeof fetch; now?: Date },
): Promise<QueryDayRow[]> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const days = opts.days ?? 5;
  const end = new Date(now.getTime() - 2 * 864e5); // GSC freshness lag
  const start = new Date(end.getTime() - days * 864e5);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const body: Record<string, unknown> = {
    startDate: fmt(start),
    endDate: fmt(end),
    dimensions: ["date", "query"],
    rowLimit: 500,
  };
  if (site.queries.length > 0) {
    body.dimensionFilterGroups = [
      {
        filters: site.queries.map((q) => ({ dimension: "query", operator: "contains", expression: q })),
      },
    ];
  }

  const res = await f(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site.siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`GSC query failed for ${site.siteUrl}: ${res.status}`);
  const data = (await res.json()) as {
    rows?: { keys: [string, string]; clicks: number; impressions: number; position: number }[];
  };
  return (data.rows ?? []).map((r) => ({
    date: r.keys[0],
    query: r.keys[1],
    clicks: r.clicks,
    impressions: r.impressions,
    position: r.position,
  }));
}

export interface GscDelta {
  brand: string;
  query: string;
  clicksLatest: number;
  clicksPrev: number;
  clicksPctChange: number | null;
  positionLatest: number;
  positionPrev: number;
  positionChange: number;
}

/** Latest-day vs previous-day deltas per query. Pure — unit tested. */
export function computeDeltas(brand: string, rows: QueryDayRow[]): GscDelta[] {
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  if (dates.length < 2) return [];
  const latest = dates[dates.length - 1];
  const prev = dates[dates.length - 2];
  const byQuery = new Map<string, { latest?: QueryDayRow; prev?: QueryDayRow }>();
  for (const r of rows) {
    if (r.date !== latest && r.date !== prev) continue;
    const slot = byQuery.get(r.query) ?? {};
    if (r.date === latest) slot.latest = r;
    else slot.prev = r;
    byQuery.set(r.query, slot);
  }
  const out: GscDelta[] = [];
  for (const [query, { latest: l, prev: p }] of byQuery) {
    if (!l && !p) continue;
    const clicksLatest = l?.clicks ?? 0;
    const clicksPrev = p?.clicks ?? 0;
    out.push({
      brand,
      query,
      clicksLatest,
      clicksPrev,
      clicksPctChange: clicksPrev > 0 ? ((clicksLatest - clicksPrev) / clicksPrev) * 100 : null,
      positionLatest: l?.position ?? 0,
      positionPrev: p?.position ?? 0,
      positionChange: (p?.position ?? 0) && (l?.position ?? 0) ? (p!.position - l!.position) : 0,
    });
  }
  return out;
}
