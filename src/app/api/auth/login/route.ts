import type { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { apiError, json, readJson } from "@/lib/http";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().min(3) });

/**
 * POST /api/auth/login {email} — sends a Supabase email OTP.
 * Single-user system: any email other than ALLOWED_EMAIL is refused before
 * anything is sent.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const rl = rateLimit(`login:${ip}`, { limit: 5, windowMs: 60_000 });
  if (!rl.allowed) return apiError(429, "rate limited");

  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body");
  const email = parsed.data.email.trim().toLowerCase();
  if (email !== env.allowedEmail) return apiError(403, "this OS has exactly one operator");

  const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false },
  });
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (error) return apiError(500, error.message);
  return json({ sent: true });
}
