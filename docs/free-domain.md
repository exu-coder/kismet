# Free domain options for Kismet

Kismet already ships on Cloudflare Pages at `https://kissmeet.pages.dev`.
The `.dev` and `.io` TLDs are paid, so a truly free name has to be a
subdomain of a free domain service. Three routes work well; pick one.

## Option A — `kismet.is-a.dev` (free, "good" name, Cloudflare Pages only)

- Domain: `kismet.is-a.dev`
- Hosting: stays on Cloudflare Pages (no change).
- Cost: free forever.
- Setup:
  1. Fork `https://github.com/is-a-dev/register`
  2. Copy `docs/is-a-dev/kismet.json` from this repo into the fork's
     `domains/` directory.
  3. Open a pull request using the template in that repo, include a
     screenshot and the link `https://kissmeet.pages.dev`.
  4. Wait for review (volunteers; usually days, sometimes weeks).
  5. Once merged, attach the domain to the Pages project:
     Cloudflare Dashboard -> Pages -> kismet -> Custom domains -> Add
     `kismet.is-a.dev`, or run `pages_domains_create` via the Cloudflare MCP.
  6. Run `node tools/set-domain.mjs https://kismet.is-a.dev` and redeploy.

Notes: is-a.dev is for developer / non-commercial projects. Kismet is a
consumer social product, so the PR may be rejected on those grounds. If it
is, use Option B or C.

## Option B — `kismet.rf.gd` (free, works on InfinityFree)

- Domain: `kismet.rf.gd` (or `kismet.page.gd`, `kismet.infy.click`,
  `kismet.great-site.net` — avoid `wuaze.com` and `ct.ws`, which have been
  suspended by registrars and are blocked by some carriers).
- Hosting: InfinityFree (see `docs/infinityfree.md`).
- Cost: free forever.
- Setup:
  1. Create an InfinityFree account and pick the subdomain during signup.
  2. Upload the contents of `dist/infinityfree/` to `htdocs` (or upload
     `dist/kismet-infinityfree.zip` and extract it there).
  3. In the control panel, request the free SSL certificate for the subdomain.
  4. Run `node tools/set-domain.mjs https://kismet.rf.gd` and repackage.

## Option C — `kismet.eu.org` (free, real domain, works on InfinityFree)

- Domain: `kismet.eu.org`
- Hosting: InfinityFree (or anywhere else — eu.org supports NS delegation).
- Cost: free forever, but a human reviews the request.
- Setup:
  1. Create an account at `https://nic.eu.org` and request `kismet.eu.org`.
  2. Set the nameservers to InfinityFree's:
     `ns1.byet.org`, `ns2.byet.org`, `ns3.byet.org`, `ns4.byet.org`,
     `ns5.byet.org`.
  3. Wait for approval (community reports cluster around two weeks).
  4. Once approved, add the domain in InfinityFree's control panel and upload
     the package.
  5. Run `node tools/set-domain.mjs https://kismet.eu.org` and repackage.

## Not recommended

- `kismet.dev` / `kismet.io` — paid TLDs (~$12-40/year). Not free.
- `kismet.github.io` — only if you mirror the static site on GitHub Pages
  under a repo named `exu-coder.github.io`. Cloudflare Pages is faster and
  already configured, so this is usually not worth it.
- `wuaze.com` / `ct.ws` InfinityFree subdomains — repeatedly suspended by
  their registrar and blocked by DNS filters.

## Recommendation

For the best balance of "good name", reliability and zero cost, use
Option A on Cloudflare Pages. If you specifically need InfinityFree hosting,
use Option B with `kismet.rf.gd` (fastest) or Option C with `kismet.eu.org`
(nicest, but slow).
