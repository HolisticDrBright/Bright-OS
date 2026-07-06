import type { NextRequest } from "next/server";
import crypto from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

export type Actor =
  | { type: "human"; email: string }
  | { type: "agent"; agentName: string };

/**
 * The signed-in supervisor. Everything mutating goes through this or an
 * explicitly token-authenticated agent path — nothing is publicly writable.
 */
export async function getHumanActor(): Promise<Actor | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email) return null;
    if (user.email.toLowerCase() !== env.allowedEmail) return null;
    return { type: "human", email: user.email.toLowerCase() };
  } catch {
    return null;
  }
}

function timingSafeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Agent auth: `Authorization: Bearer ${AGENT_API_TOKEN}` + `x-agent-name`.
 * Used by OpenClaw/Hermes for task pulls, status updates, and claims.
 * Agents can NEVER decide decisions — that path only accepts humans.
 */
export function getAgentActor(req: NextRequest): Actor | null {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const agentName = req.headers.get("x-agent-name") ?? "";
  let expected: string;
  try {
    expected = env.agentApiToken;
  } catch {
    return null; // no token configured → no agent access
  }
  if (!token || !agentName || !timingSafeEq(token, expected)) return null;
  return { type: "agent", agentName };
}

/** Human session, or agent token as fallback. Order matters: humans first. */
export async function getActor(req: NextRequest): Promise<Actor | null> {
  const human = await getHumanActor();
  if (human) return human;
  return getAgentActor(req);
}
