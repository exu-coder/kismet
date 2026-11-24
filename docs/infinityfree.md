# Deploy Kismet on InfinityFree

InfinityFree is free Apache/PHP hosting with no Node build step. Kismet is a
static site, so it uploads as-is. The backend (Supabase) is unaffected.

## 1. Build the upload package

    node tools/package-infinityfree.mjs
    # or, if you already know the final domain:
    node tools/package-infinityfree.mjs --site-url https://kismet.rf.gd

This creates `dist/infinityfree/` (upload its *contents*) and
`dist/kismet-infinityfree.zip`.

## 2. Create the hosting account

1. Sign up at https://www.infinityfree.com (email only, no card).
2. Create a hosting account and choose a free subdomain such as
   `kismet.rf.gd`, `kismet.page.gd` or `kismet.infy.click`.
   Avoid `wuaze.com` and `ct.ws` (registrar suspensions in 2024-2026).
3. Open the control panel.

## 3. Upload

- File Manager: delete the default files in `htdocs`, then upload the
  contents of `dist/infinityfree/`, OR upload `dist/kismet-infinityfree.zip`
  and extract it inside `htdocs`.
- FTP: connect to the FTP credentials shown in the panel and upload to
  `htdocs`.

## 4. Enable HTTPS

Control Panel -> SSL Certificates -> request the free certificate for the
subdomain. Cloudflare integration (Control Panel -> Cloudflare) is optional
but recommended for TLS and caching.

## 5. Set the final domain in the source

    node tools/set-domain.mjs https://kismet.rf.gd
    node tools/package-infinityfree.mjs --site-url https://kismet.rf.gd
    # then re-upload

## Notes and limits

- InfinityFree has a daily hits cap and a file-size limit; the Kismet package
  is ~2.7 MB, well within it.
- Some free subdomains are blocked by DNS filters and carriers. If your
  subdomain does not resolve on mobile networks, switch to `rf.gd`,
  `page.gd` or `infy.click`, or use a free `eu.org` domain with NS
  delegation to `ns1.byet.org` .. `ns5.byet.org`.
- Cloudflare Pages remains the recommended host: faster, no hits cap, and the
  same static files. InfinityFree is provided for users who specifically need
  it.
- `.htaccess` in the package sets security headers, compression, caching and
  a custom 404 page.
