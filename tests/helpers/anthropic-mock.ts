// Drop-in replacement for "@anthropic-ai/sdk" in tests:
//   vi.mock("@anthropic-ai/sdk", () => import("../helpers/anthropic-mock"));
import { anthropicState } from "./harness";

export default class MockAnthropic {
  messages = {
    create: async (req: Record<string, unknown>) => {
      anthropicState.requests.push(req);
      const next = anthropicState.queue.shift();
      if (!next) {
        throw new Error(`anthropic mock queue empty (request #${anthropicState.requests.length})`);
      }
      return next;
    },
  };
}
