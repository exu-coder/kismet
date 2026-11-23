#!/usr/bin/env python3
"""Rebrand WarpMeet -> Kismet and inject the redesign layer into every page.
Keeps deployment URLs (warpmeet.com canonical/og/hreflang), the GA domain gate,
the Google OAuth client id, and internal debug hooks untouched.
"""
import re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRAND = "Kismet"
SLUG = "kismet"
INK = "#070a14"

# order matters: specific markup/copy first, then the broad brand swaps
REPLACEMENTS = [
    # two-part wordmark (HTML + the Svelte template in BUIWkcWf.js)
    ('warp<em class="svelte-1wpm3vt">meet</em>',
     'Kis<em class="svelte-1wpm3vt">met</em>'),
    # hero headline (JS markdown form + prerendered HTML form)
    ('Random video chat, at *warp speed*.',
     'Random video chat, *written in the stars*.'),
    ('Random video chat, at ', 'Random video chat, '),
    ('>warp speed</em>', '>written in the stars</em>'),
    # document titles / og titles
    ('video chat at warp speed', 'video chat, written in the stars'),
    ('videochat a velocidad warp', 'videochat escrito en las estrellas'),
    ('bate-papo em velocidade warp', 'bate-papo escrito nas estrelas'),
    # feature headline (en; es/pt already use saltar/pular)
    ('Talk — or warp to the next one', 'Talk — or skip to the next one'),
    # brand, all casings of the display name
    ('WarpMeet', BRAND),
]

# lowercase slug, but never touch the deployment domain warpmeet.com
SLUG_RE = re.compile(r'warpmeet(?!(?:\\)?\.com)')

PRELOAD_OLD = re.compile(
    r'<link\s+rel="preload"\s+href="/fonts/rationale-latin\.woff2"\s+as="font"\s+type="font/woff2"\s+crossorigin\s*/?>',
    re.S)
PRELOAD_NEW = (
    '<link rel="preload" href="/fonts/tinos-latin-400.woff2" as="font" type="font/woff2" crossorigin>\n'
    '\t\t<link rel="preload" href="/fonts/tinos-latin-700.woff2" as="font" type="font/woff2" crossorigin>'
)
INJECT = (
    '\t\t<link rel="stylesheet" href="/redesign/theme.css">\n'
    '\t\t<script src="/redesign/pixels.js" defer></script>\n'
    '\t</head>'
)

changed = []
for p in sorted(ROOT.rglob('*')):
    if not p.is_file():
        continue
    rel = p.relative_to(ROOT).as_posix()
    if rel.startswith(('redesign/', 'fonts/', 'flags/', 'icons/')):
        continue
    if p.suffix not in ('.html', '.js', '.webmanifest', '.svg'):
        continue
    try:
        text = p.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        continue
    orig = text
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)
    text = SLUG_RE.sub(SLUG, text)
    if p.suffix == '.html':
        text = text.replace('content="#07060d"', f'content="{INK}"')
        text = PRELOAD_OLD.sub(PRELOAD_NEW, text)
        if '/redesign/theme.css' not in text:
            text = text.replace('</head>', INJECT, 1)
    if p.name == 'manifest.webmanifest':
        text = text.replace('"#07060d"', f'"{INK}"')
    if text != orig:
        p.write_text(text, encoding='utf-8')
        changed.append(rel)

print(f'changed {len(changed)} files')
for c in changed:
    print(' ', c)