// Drop-in replacement for "@anthropic-ai/sdk" in tests:
//   vi.mock("@anthropic-ai/sdk", () => import("../helpers/anthropic-mock"));
import { anthropicState } from "./harness";

/** Split a string into a couple of chunks so streaming tests exercise deltas. */
function chunk(text: string): string[] {
  if (text.length < 2) return text ? [text] : [];
  const mid = Math.ceil(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}

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
    // Mirrors client.messages.stream(): an async-iterable of raw stream events
    // (we only emit text_delta) plus finalMessage() returning the queued message.
    stream: (req: Record<string, unknown>) => {
      anthropicState.requests.push(req);
      const next = anthropicState.queue.shift();
      if (!next) {
        throw new Error(`anthropic mock stream queue empty (request #${anthropicState.requests.length})`);
      }
      const blocks = Array.isArray(next.content) ? (next.content as Record<string, unknown>[]) : [];
      return {
        async *[Symbol.asyncIterator]() {
          let index = 0;
          for (const block of blocks) {
            if (block.type === "text" && typeof block.text === "string") {
              for (const text of chunk(block.text)) {
                yield { type: "content_block_delta", index, delta: { type: "text_delta", text } };
              }
            }
            index++;
          }
        },
        finalMessage: async () => next,
      };
    },
  };
}
