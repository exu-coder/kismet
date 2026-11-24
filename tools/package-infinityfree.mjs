#!/usr/bin/env node
/**
 * Build an upload-ready folder and zip for InfinityFree (Apache/PHP hosting).
 *
 *   node tools/package-infinityfree.mjs
 *   node tools/package-infinityfree.mjs --site-url https://kismet.rf.gd
 *
 * Output:
 *   dist/infinityfree/            -> upload the *contents* of this folder to htdocs
 *   dist/kismet-infinityfree.zip  -> or upload this and extract it there
 *
 * Before packaging it regenerates robots.txt and sitemap.xml for the given
 * domain, so the published URLs are correct.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = args.indexOf("--site-url");
const siteUrl = (flag !== -1 ? args[flag + 1] : process.env.SITE_URL || "https://kissmeet.pages.dev")
  .replace(/\/+$/, "");

const distDir = join(root, "dist", "infinityfree");
const zipPath = join(root, "dist", "kismet-infinityfree.zip");

// Never uploaded: source/docs that do not belong on a static host.
const EXCLUDE = new Set([
  ".git", ".github", ".wrangler", "node_modules", "dist", "supabase", "tools", "scripts",
  "DEPLOY.md", "AUDIT_FIXES.md", "README.md", ".gitignore", ".gitattributes",
]);

console.log(`> sitemap for ${siteUrl}`);
execFileSync(process.execPath, [join(root, "tools", "generate-sitemap.mjs"), "--site-url", siteUrl], {
  stdio: "inherit",
});

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (EXCLUDE.has(entry.name)) continue;
  cpSync(join(root, entry.name), join(distDir, entry.name), { recursive: true });
}

const htaccess = `# Kismet on Apache (InfinityFree)
DirectoryIndex index.html
Options -Indexes

ErrorDocument 404 /404.html

<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "SAMEORIGIN"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Permissions-Policy "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()"
  Header always set Cross-Origin-Opener-Policy "same-origin-allow-popups"
</IfModule>

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/plain text/xml application/javascript application/json image/svg+xml
</IfModule>

<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType text/html "access plus 0 seconds"
  ExpiresByType text/css "access plus 7 days"
  ExpiresByType application/javascript "access plus 7 days"
  ExpiresByType image/png "access plus 30 days"
  ExpiresByType image/svg+xml "access plus 30 days"
  ExpiresByType font/woff2 "access plus 30 days"
</IfModule>

# Block access to dotfiles and source maps.
<FilesMatch "^\\.">
  Require all denied
</FilesMatch>
<FilesMatch "\\.map$">
  Require all denied
</FilesMatch>
`;

writeFileSync(join(distDir, ".htaccess"), htaccess);
writeFileSync(join(distDir, "HOW-TO-UPLOAD.txt"), `Kismet — InfinityFree upload
===========================

1. Create a free account at https://infinityfree.com and add a hosting account.
2. Pick a free subdomain (for example kismet.rf.gd) when the account is created.
3. Open the account's Control Panel -> Online File Manager (or connect with FTP).
4. Delete the default files in htdocs, then upload the CONTENTS of this folder
   (or upload kismet-infinityfree.zip and extract it inside htdocs).
5. In the Control Panel -> SSL Certificates, request the free certificate for
   your subdomain so the site loads over https.
6. Optional: Control Panel -> Cloudflare, enable it for TLS and caching.

The site is static. The backend stays on Supabase; no PHP or database is used
on InfinityFree. Uploaded files: index.html, chat/, inbox/, requests/,
profile/, es/, pt/, landing pages, 404.html, robots.txt, sitemap.xml,
redesign/, _app/, fonts/, flags/, icons/, sounds/, images.

Generated for: ${siteUrl}
Remember to re-run: node tools/package-infinityfree.mjs --site-url <your-domain>
`);

if (existsSync(zipPath)) rmSync(zipPath, { force: true });
let zipped = false;
try {
  execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: distDir, stdio: "ignore" });
  zipped = true;
} catch {
  // No zip binary: fall back to Python's zipfile module.
  try {
    execFileSync("python3", ["-c", `
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            full = os.path.join(base, name)
            archive.write(full, os.path.relpath(full, root))
`, distDir, zipPath], { stdio: "ignore" });
    zipped = true;
  } catch {
    zipped = false;
  }
}
if (zipped) console.log(`> ${zipPath}`);
else console.log("! could not create a zip - upload the folder contents instead");
console.log(`> ${distDir}`);
