#!/usr/bin/env node
/**
 * Point the whole site at a new hostname.
 *
 *   node tools/set-domain.mjs https://kismet.rf.gd
 *
 * Rewrites canonical links, Open Graph URLs, hreflang alternates and the
 * sitemap/robots files. Run this once when the final domain is known, then
 * deploy (and re-run the InfinityFree package if you use it).
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const target = (process.argv[2] || "").replace(/\/+$/, "");
if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(target)) {
  console.error("Usage: node tools/set-domain.mjs https://example.com");
  process.exit(1);
}

const SKIP_DIRS = new Set([".git", "node_modules", "_app", "dist", "supabase", "tools"]);
const TEXT_EXT = /\.(html|xml|txt|webmanifest|json)$/i;

// Hosts the site has been published under so far.
const OLD_HOSTS = [
  "https://kissmeet.pages.dev",
  "https://kismet-k2f.pages.dev",
  "https://warpmeet.com",
  "https://www.warpmeet.com",
];

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(join(dir, entry.name));
    } else if (TEXT_EXT.test(entry.name)) files.push(join(dir, entry.name));
  }
};
walk(root);

let changed = 0;
for (const file of files) {
  let text = readFileSync(file, "utf8");
  const before = text;
  for (const host of OLD_HOSTS) {
    text = text.split(host).join(target);
  }
  if (text !== before) {
    writeFileSync(file, text);
    changed++;
    console.log("updated", relative(root, file));
  }
}

// The sitemap generator also owns robots.txt and the hreflang groups.
execFileSync(process.execPath, [join(root, "tools", "generate-sitemap.mjs"), "--site-url", target], {
  stdio: "inherit",
});
console.log(`${changed} file(s) rewritten to ${target}`);
