# Changelog (Image Gallery)

This is a lightweight running log of notable changes while iterating.
Times are approximate; focus is on what changed.

## 2026-01-30

### UX / Playback
- Autoplay button now loads file list if needed, then opens the first image and starts autoplay.
- Close (✕) button remains visible in immersive/autoplay mode.
- Autoplay pause/resume behavior fixed:
  - Play button icon follows `autoplayEnabled` (intent), not whether a timer exists.
  - If autoplay is temporarily paused by touch/gesture, clicking play resumes rather than toggling off.
- Keyboard support: **Space** toggles autoplay while lightbox is open (prevents page scroll).

### Layout / Grid
- Default columns behavior:
  - Desktop first-open defaults to **auto layout**;
  - Mobile first-open defaults to **3 columns**;
  - Added settings option: **auto**.
- Vertical gaps tightened; aligned vertical/horizontal spacing.
- Removed/disabled “wide full-row tiles” to avoid single-image rows.
- Desktop auto layout updated to fixed column counts (uniform width) with breakpoints.
- Added more height variety via aspect-ratio classes (width stays consistent).

### Styling
- Introduced iOS-like continuous corner radius variables: `--r-sm`, `--r-md`, `--r-lg`.
- Applied unified corner radius to tiles, lightbox, thumbnails, action bar, buttons, inputs.

### Delete / Selection
- Added **Delete Mode** entry in Settings (and exit toggle).
- Action bar shows whenever selection mode is active (not only after selecting items).
- Kept multiple entry paths: desktop right-click / mobile long-press / settings button.

### Visual variety
- Added circular + ellipse tiles as deliberate accents, with logic to avoid clustering at the beginning/end and avoid consecutive decorated tiles.
- Added **Bubble layout (experimental)** toggle in Settings using Matter.js physics packing.

### Ops / Running mode
- Switched from Docker to **standalone node** for rapid iteration:
  - Log: `image_gallery/node-standalone.log`
  - PID: `image_gallery/node-standalone.pid`
  - Images directory: `image_gallery/images/`
- Noted issue where an old node process could keep port 8088; now need to ensure the actual listener is replaced.
