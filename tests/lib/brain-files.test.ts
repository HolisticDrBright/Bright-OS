import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __resetBrainFileCache, loadBrainFile } from "@/lib/command/brain-files";

/** The brain's editable files: hot reload on save + Obsidian vault mirror. */

async function tempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

afterEach(() => {
  delete process.env.BRAIN_DIR;
  delete process.env.OBSIDIAN_VAULT_PATH;
  __resetBrainFileCache();
});

describe("brain files", () => {
  it("hot-reloads the personality the moment the file changes — no restart", async () => {
    const dir = await tempDir("brain-");
    process.env.BRAIN_DIR = dir;
    const file = path.join(dir, "PERSONALITY.md");

    await fs.writeFile(file, "v1: HUD-terse operator", "utf8");
    await fs.utimes(file, new Date(), new Date(Date.now() - 5000));
    expect(await loadBrainFile("PERSONALITY.md")).toContain("v1");

    await fs.writeFile(file, "v2: full JARVIS, dry wit", "utf8");
    await fs.utimes(file, new Date(), new Date()); // mtime moves forward → cache busts
    expect(await loadBrainFile("PERSONALITY.md")).toContain("v2");
  });

  it("returns empty string (not a crash) when a file is missing", async () => {
    process.env.BRAIN_DIR = await tempDir("brain-empty-");
    expect(await loadBrainFile("KNOWLEDGE.md")).toBe("");
  });

  it("prefers the vault copy, seeding it from the repo copy on first touch", async () => {
    const repo = await tempDir("brain-repo-");
    const vault = await tempDir("brain-vault-");
    process.env.BRAIN_DIR = repo;
    process.env.OBSIDIAN_VAULT_PATH = vault;
    await fs.writeFile(path.join(repo, "SELF.md"), "repo self-knowledge", "utf8");

    // First load: vault copy doesn't exist → seeded from repo, then used.
    expect(await loadBrainFile("SELF.md")).toBe("repo self-knowledge");
    const vaultCopy = path.join(vault, "BrightOS", "SELF.md");
    expect(await fs.readFile(vaultCopy, "utf8")).toBe("repo self-knowledge");

    // Operator edits the vault copy in Obsidian → the brain picks it up.
    await fs.writeFile(vaultCopy, "edited from Obsidian", "utf8");
    await fs.utimes(vaultCopy, new Date(), new Date(Date.now() + 2000));
    expect(await loadBrainFile("SELF.md")).toBe("edited from Obsidian");
  });
});
