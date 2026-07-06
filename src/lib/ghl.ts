import { env } from "@/lib/env";

/**
 * GoHighLevel (LeadConnector) minimal client — waitlist/contact counts.
 * We only need totals; the heartbeat computes deltas between beats.
 */
export function ghlConfigured(): boolean {
  return Boolean(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID);
}

export async function getContactCount(opts?: {
  tag?: string;
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const f = opts?.fetchImpl ?? fetch;
  const url = new URL(`${env.ghlBaseUrl}/contacts/`);
  url.searchParams.set("locationId", env.ghlLocationId);
  url.searchParams.set("limit", "1");
  if (opts?.tag) url.searchParams.set("query", opts.tag);
  const res = await f(url.toString(), {
    headers: {
      Authorization: `Bearer ${env.ghlApiKey}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`GHL contacts query failed: ${res.status}`);
  const body = (await res.json()) as { meta?: { total?: number } };
  return Number(body.meta?.total ?? 0);
}
