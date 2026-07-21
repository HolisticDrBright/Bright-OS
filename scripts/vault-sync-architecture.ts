/**
 * Copy the BRIGHT OS architecture snapshot into the Obsidian vault — run:
 *   npm run vault:graph
 *
 * Source: docs/architecture/  (committed Graphify snapshot: interactive graph,
 * collapsible tree, markdown report)
 * Target: {OBSIDIAN_VAULT_PATH}/BrightOS/Architecture/
 *
 * The report renders natively in Obsidian; the two .html files open in your
 * browser (right-click → open in default app from Obsidian's file pane).
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const vault = process.env.OBSIDIAN_VAULT_PATH ?? "";
const source = path.resolve("docs/architecture");

if (!vault) {
  console.error(
    "✗ OBSIDIAN_VAULT_PATH is not set in .env — add it (your vault folder),\n" +
      "  restart, and run this again.",
  );
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error(`✗ ${source} not found — pull the latest repo first (git pull).`);
  process.exit(1);
}

const target = path.join(vault, "BrightOS", "Architecture");
fs.mkdirSync(target, { recursive: true });

let copied = 0;
for (const name of fs.readdirSync(source)) {
  fs.copyFileSync(path.join(source, name), path.join(target, name));
  console.log(`✓ ${name}`);
  copied += 1;
}
console.log(`\nDone — ${copied} file(s) → ${target}`);
console.log("In Obsidian: BrightOS → Architecture. The report renders inline;");
console.log("open the Graph/Tree HTML files in your browser for the interactive views.");
