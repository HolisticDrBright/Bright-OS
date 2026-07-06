import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, json, readJson } from "@/lib/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().min(3), token: z.string().min(4) });

/**
 * POST /api/auth/verify {email, token} — verifies the OTP and sets the
 * session cookies. Supabase refresh tokens keep the session long-lived.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const rl = rateLimit(`verify:${ip}`, { limit: 10, windowMs: 60_000 });
  if (!rl.allowed) return apiError(429, "rate limited");

  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body");
  const email = parsed.data.email.trim().toLowerCase();
  if (email !== env.allowedEmail) return apiError(403, "this OS has exactly one operator");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token: parsed.data.token.trim(),
    type: "email",
  });
  if (error || !data.session) return apiError(401, error?.message ?? "invalid code");
  return json({ ok: true });
}
