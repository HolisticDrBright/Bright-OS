import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { apiError, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/dev-login — LOCAL-ONLY passwordless login for the operator.
 *
 * Supabase's built-in mailer locks the email templates (they can't carry the
 * OTP code without custom SMTP), which makes the email flow painful for local
 * testing. This mints a session for ALLOWED_EMAIL directly using the
 * service-role key — no email, no SMTP. It is HARD-DISABLED in production
 * (NODE_ENV === "production"), so it can never ship as a backdoor.
 */
export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return apiError(403, "dev login is disabled in production — use the email OTP flow");
  }

  const email = env.allowedEmail;
  const admin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Generate a one-time magic-link token for the operator. If the user doesn't
  // exist yet, create them (confirmed) and retry.
  let gen = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (gen.error) {
    await admin.auth.admin.createUser({ email, email_confirm: true }).catch(() => {});
    gen = await admin.auth.admin.generateLink({ type: "magiclink", email });
  }
  const tokenHash = gen.data?.properties?.hashed_token;
  if (gen.error || !tokenHash) {
    return apiError(500, gen.error?.message ?? "dev login: could not generate a token");
  }

  // Exchange the token for a cookie-bound session on this response.
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (error) return apiError(401, `dev login verify failed: ${error.message}`);

  return json({ ok: true, email });
}
