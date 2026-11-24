#!/usr/bin/env node
/**
 * Generate sitemap.xml and robots.txt from the on-disk pages.
 *
 *   node tools/generate-sitemap.mjs                      # uses SITE_URL / default
 *   node tools/generate-sitemap.mjs --site-url https://example.com
 *
 * Private app routes (chat, inbox, requests, profile) are intentionally left
 * out and blocked in robots.txt. Run this again whenever a page is added or the
 * site moves to a new domain.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const args = process.argv.slice(2);
const flagIndex = args.indexOf("--site-url");
const SITE_URL = (
  flagIndex !== -1 ? args[flagIndex + 1] : process.env.SITE_URL || "https://kismet-k2f.pages.dev"
).replace(/\/+$/, "");

// Directories that never contain public pages.
const SKIP_DIRS = new Set([
  ".git", "node_modules", "_app", "redesign", "supabase", "tools", "dist",
  "fonts", "flags", "icons", "sounds", "scripts",
]);

// Routes that exist but must not be indexed (per-user app views).
const PRIVATE_ROUTES = new Set(["chat", "inbox", "requests", "profile"]);

// Lower value sorts later in the sitemap (home page first).
const PRIORITY = { "": 1.0, "random-video-chat": 0.9, "talk-to-strangers": 0.9 };
const ES_PRIORITY = { "": 0.8, "chat": 0.7, "chat-aleatorio": 0.7, "hablar-con-desconocidos": 0.7 };
const PT_PRIORITY = { "": 0.8, "chat": 0.7, "bate-papo-aleatorio": 0.7, "conversar-com-estranhos": 0.7 };

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.name === "index.html") {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

const routeOf = (file) => {
  const dir = relative(root, join(file, "..")).split(sep).filter(Boolean);
  return dir.join("/");
};

const priorityOf = (route) => {
  const [lang, ...rest] = route.split("/");
  const leaf = rest.join("/");
  if (lang === "es") return ES_PRIORITY[leaf] ?? 0.5;
  if (lang === "pt") return PT_PRIORITY[leaf] ?? 0.5;
  return PRIORITY[route] ?? (["terms", "privacy"].includes(route) ? 0.3 : 0.6);
};

const urlOf = (route) => (route ? `${SITE_URL}/${route}` : `${SITE_URL}/`);

// Group translated landing pages so each entry gets hreflang alternates.
const ALTERNATES = [
  { en: "random-video-chat", es: "es/hablar-con-desconocidos", pt: "pt/conversar-com-estranhos" },
  { en: "talk-to-strangers", es: "es/chat-aleatorio", pt: "pt/bate-papo-aleatorio" },
  { en: "terms", es: "es/terms", pt: "pt/terms" },
  { en: "privacy", es: "es/privacy", pt: "pt/privacy" },
];

const entries = walk(root)
  .map((file) => ({ route: routeOf(file), file }))
  .filter(({ route }) => route === "" || !PRIVATE_ROUTES.has(route.split("/")[0]))
  .sort((a, b) => a.route.localeCompare(b.route));

const lastmodOf = (file) => statSync(file).mtime.toISOString().slice(0, 10);

// Map every route to its translation group (if it belongs to one).
const groupOf = new Map();
for (const group of ALTERNATES) {
  const members = Object.values(group);
  for (const route of members) groupOf.set(route, group);
}

const escapeXml = (value) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const body = entries.map(({ route, file }) => {
  const group = groupOf.get(route);
  const links = group
    ? Object.entries(group)
        .map(([lang, altRoute]) =>
          `    <xhtml:link rel="alternate" hreflang="${lang}" href="${escapeXml(urlOf(altRoute))}" />`)
        .join("\n") +
      `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(urlOf(group.en))}" />`
    : "";
  return [
    "  <url>",
    `    <loc>${escapeXml(urlOf(route))}</loc>`,
    `    <lastmod>${lastmodOf(file)}</lastmod>`,
    `    <priority>${priorityOf(route).toFixed(1)}</priority>`,
    ...(links ? [links] : []),
    "  </url>",
  ].join("\n");
}).join("\n");

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${body}
</urlset>
`;

const robots = `# Kismet
User-agent: *
Allow: /
Disallow: /chat
Disallow: /inbox
Disallow: /requests
Disallow: /profile
Disallow: /supabase/
Disallow: /redesign/
Disallow: /_app/

Sitemap: ${SITE_URL}/sitemap.xml
`;

writeFileSync(join(root, "sitemap.xml"), sitemap);
writeFileSync(join(root, "robots.txt"), robots);
console.log(`sitemap.xml: ${entries.length} URLs for ${SITE_URL}`);
console.log("robots.txt: written");
