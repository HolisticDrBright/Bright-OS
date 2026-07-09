import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * THE BRAIN'S EDITABLE FILES — personality, core knowledge, self-knowledge.
 *
 * Each lives as markdown the operator can edit; the loader re-reads a file the
 * moment its mtime changes (hot reload — no restart). When an Obsidian vault is
 * configured, the copy in {vault}/BrightOS/ is preferred — seeded from the repo
 * copy on first touch — so the operator can edit the brain from Obsidian.
 */

export const BRAIN_FILES = ["PERSONALITY.md", "KNOWLEDGE.md", "SELF.md"] as const;
export type BrainFile = (typeof BRAIN_FILES)[number];

/** Folder inside the vault where the brain lives (and the digest is mirrored). */
export const VAULT_BRAIN_DIR = "BrightOS";

interface CacheEntry {
  path: string;
  mtimeMs: number;
  content: string;
}
const cache = new Map<BrainFile, CacheEntry>();

/** Test hook. */
export function __resetBrainFileCache() {
  cache.clear();
}

function repoPath(name: BrainFile): string {
  return path.resolve(env.brainDir, name);
}

/** Resolve which copy to read: vault (seeding it if missing) or repo. */
async function resolveBrainPath(name: BrainFile): Promise<string> {
  if (!env.obsidianVaultPath) return repoPath(name);
  const vaultPath = path.join(env.obsidianVaultPath, VAULT_BRAIN_DIR, name);
  try {
    await fs.access(vaultPath);
    return vaultPath;
  } catch {
    // Seed the vault copy from the repo copy so the operator can start editing
    // in Obsidian immediately. If the repo copy is missing too, stay on repo.
    try {
      const repo = await fs.readFile(repoPath(name), "utf8");
      await fs.mkdir(path.dirname(vaultPath), { recursive: true });
      await fs.writeFile(vaultPath, repo, "utf8");
      return vaultPath;
    } catch {
      return repoPath(name);
    }
  }
}

/**
 * Load a brain file with mtime-based hot reload. Returns "" when the file is
 * missing/unreadable — the brain composes what exists rather than crashing.
 */
export async function loadBrainFile(name: BrainFile): Promise<string> {
  try {
    const target = await resolveBrainPath(name);
    const stat = await fs.stat(target);
    const hit = cache.get(name);
    if (hit && hit.path === target && hit.mtimeMs === stat.mtimeMs) return hit.content;
    const content = await fs.readFile(target, "utf8");
    cache.set(name, { path: target, mtimeMs: stat.mtimeMs, content });
    return content;
  } catch {
    return "";
  }
}
