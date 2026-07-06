// Drop-in replacement for "@/lib/auth" in tests:
//   vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));
import { authState } from "./harness";

export async function getActor() {
  return authState.actor;
}

export async function getHumanActor() {
  return authState.actor?.type === "human" ? authState.actor : null;
}

export function getAgentActor() {
  return authState.actor?.type === "agent" ? authState.actor : null;
}
