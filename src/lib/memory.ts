import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

const TEMPLATE = `# MEMORY.md — BRIGHT OS curated memory

# OPERATING RULES
· Never publish medical content without the MD-review block.
· All $-decisions >$100 route to Decision Queue, no exceptions.
· CODEX verifies every "done" claim before board moves to Shipped.

# FOCUS (Q3 2026)
· Two engines only: Clinic cash flow + AI Longevity Pro beta→paid.
· Everything else runs cron-only; weekly digest max.

# LEARNED

# PEOPLE
`;

export async function readMemoryMd(filePath = env.memoryMdPath): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return TEMPLATE;
  }
}

export async function ensureMemoryMd(filePath = env.memoryMdPath): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    await fs.writeFile(filePath, TEMPLATE, "utf8");
  }
}

/**
 * Appends a promoted line under a `# SECTION` heading (default LEARNED).
 * Creates the file/section when missing. Pure string surgery so the vault
 * file stays human-editable.
 */
export function promoteLineInContent(content: string, line: string, section = "LEARNED"): string {
  const cleaned = line.trim().replace(/^[-·•]\s*/, "");
  const entry = `· ${cleaned}`;
  if (content.includes(entry)) return content; // idempotent
  const headingRe = new RegExp(`^#\\s*${section}\\b.*$`, "mi");
  const match = content.match(headingRe);
  if (!match || match.index === undefined) {
    return `${content.trimEnd()}\n\n# ${section}\n${entry}\n`;
  }
  const headingEnd = match.index + match[0].length;
  const rest = content.slice(headingEnd);
  const nextHeading = rest.search(/^#\s/m);
  const insertAt = nextHeading === -1 ? content.length : headingEnd + nextHeading;
  const before = content.slice(0, insertAt).trimEnd();
  const after = content.slice(insertAt);
  return `${before}\n${entry}\n${after.startsWith("\n") || after === "" ? after : `\n${after}`}`;
}

export async function promoteLineToFile(
  line: string,
  section = "LEARNED",
  filePath = env.memoryMdPath,
): Promise<void> {
  await ensureMemoryMd(filePath);
  const content = await fs.readFile(filePath, "utf8");
  await fs.writeFile(filePath, promoteLineInContent(content, line, section), "utf8");
}
