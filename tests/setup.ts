import { afterEach } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";
import { authState, dbHolder } from "./helpers/harness";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test-project.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-test-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-test-key";
process.env.ALLOWED_EMAIL ||= "brandonbright@gmail.com";
process.env.HEARTBEAT_HMAC_SECRET ||= "hb-test-secret";
process.env.AGENT_API_TOKEN ||= "agent-test-token";
process.env.DAILY_COST_CAP_USD ||= "60";
process.env.APP_BASE_URL ||= "http://localhost:3100";

afterEach(() => {
  resetRateLimits();
  authState.actor = null;
  dbHolder.db = null;
});
