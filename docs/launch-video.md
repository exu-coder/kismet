# Kismet — launch video storyboard

I couldn't render an MP4 directly (no video-generation credentials and no ffmpeg
on this machine), so I shipped an **animated, auto-playing launch page** instead:
https://kissmeet.pages.dev/launch — open it fullscreen for the launch experience.

If you want a real `.mp4` (for ads, Product Hunt, social), here is a ready-to-shoot
storyboard. Drop the assets in `logo.png`, `og.png`, `favicon.svg` into any editor
(CapCut, Canva, Premiere) and follow the beats.

## Specs
- Aspect: 16:9 (1920×1080) for YouTube/web; also export 9:16 (1080×1920) for TikTok/Reels/Shorts.
- Length: 12–15 s.
- Music: ambient synth, low, building; no vocals.
- Palette: background #070a14, accent #f59e0b, text #efe8d6.

## Beats

| Time | Visual | Text overlay | Audio |
|---|---|---|---|
| 0.0–1.5 | Black → deep space fade; faint stars twinkle in. | — | ambient swell |
| 1.5–3.0 | Kismet golden pixel star logo scales in with glow pulse. | Kismet | soft chime |
| 3.0–4.5 | Wordmark "Kismet" fades in (amber serif). | Someone new in seconds. | — |
| 4.5–6.0 | Finger presses glowing "Start" button (screen recording). | Free random video chat | click SFX |
| 6.0–8.0 | Two faces appear side-by-side in video frames; a subtle amber beam connects them. | Face to face, instantly | — |
| 8.0–9.5 | "Next" tap → smooth transition to a new face. | Next replaces them instantly | swipe SFX |
| 9.5–11.0 | Shield badge with checkmark. | Actively moderated · 18+ | — |
| 11.0–12.5 | Logo + URL. | No account. No downloads. Free. | — |
| 12.5–14.0 | CTA button pulse. | kissmeet.pages.dev — Jump in | button pulse |

## Assets to use
- Logo: `favicon.svg` / `logo.png`
- Preview image: `og.png` (1200×630)
- Screen recordings: capture `/chat` on desktop + mobile (camera permission flow, matching, Next, report flag).
- Brand colors: #070a14 (bg), #f59e0b (accent), #efe8d6 (text), #d97706 (deep gold).

## Tips
- Keep text on screen ≥ 2 s for readability.
- Show real faces (with consent) — stock footage looks fake for this category.
- End card should stay up ≥ 3 s so the URL is readable.
- Export with burned-in captions for silent autoplay on social feeds.
