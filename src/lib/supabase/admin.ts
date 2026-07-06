import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Service-role client — bypasses RLS. Server/workers only.
 * Never import from client components.
 */
let cached: SupabaseClient | null = null;

export function createAdminClient(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/** Test hook. */
export function __resetAdminClient() {
  cached = null;
}
