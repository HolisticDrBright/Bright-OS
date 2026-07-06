// Drop-in replacement for "@/lib/supabase/admin" in tests:
//   vi.mock("@/lib/supabase/admin", () => import("../helpers/admin-mock"));
import { dbHolder } from "./harness";

export function createAdminClient() {
  if (!dbHolder.db) throw new Error("test forgot to set dbHolder.db");
  return dbHolder.db;
}

export function __resetAdminClient() {}
