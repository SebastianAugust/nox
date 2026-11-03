# Nox — Redesign: "Night Lair" (v2: mint + electric blue, natural lightning)

> Recommended: **Opus, effort high** (visual quality, a procedural lightning effect and consistency across 7 pages + the pet window need judgment, not just code moves).

## Context
Nox is a personal Tauri v2 + React + TypeScript desktop pet (`D:\nox`). Phases 0, 1 and 1.5 are done: token layer (`src/styles/tokens.css`), shared style fragments (`src/styles/shared.ts`), dashboard split into `src/dashboard/{Dashboard.tsx,pages/*,widgets/*}`, i18n (`src/lib/i18n.ts`), tests via `npm test`, migrations in Rust. Read `README.md`, `docs/ARCHITECTURE.md`, `docs/TOKENS.md` first, then re-scan the tree (trust the code over the docs).

Bas picked a visual direction called **Night Lair**: a playful night-sky look built around his own pixel-art pet sprite. Reference mockups (Bas copies them into `docs/design/` before you start):
- `docs/design/night-lair-dashboard.html` — dashboard Home
- `docs/design/night-lair-pet.html` — pet window

They use a custom mockup format (`<x-dc>`, `<sc-if>`, `{{accent}}`). **Read them for layout, sizes, spacing, radii, fonts, copy and the animation keyframes. Do not copy the mockup markup or format into the app**; rebuild as React components on the token layer. Ignore every `showProgress` block in them (energy, level, embers, `+50`, `LV 3`).

**Where this prompt and the mockups disagree, this prompt wins.** In particular, the mockups do not yet show the second accent (electric blue) or the lightning; both are specified below.

## Hard rules
1. Windows PowerShell only (`cd D:\nox`). Never run npm/tauri from WSL.
2. **Visual and copy changes only.** Do not change data logic, DB schema (except new settings keys via a new migration, R10), schedulers, delivery queue, pomodoro engine or Rust, except the pet window size work in R3.
3. Every color, radius, spacing, font size, shadow and duration goes through tokens. No hardcoded hex in components.
4. **Plain language.** No game words in UI text: no "boss", "quest", "flight", "hatch", "wild", "lair". Use Home, Habits, Focus, Todos, Recap, Integrations, Settings; "Overdue", "Personal", "Start focus", "Later", "Add a todo". All strings through i18n (`en` + `id`).
5. **No new character art.** The only character is Bas's existing sprite (`src/assets/toothless.png`) via the existing `<Pet>` component, unchanged. Decorative motifs (stars, moon, clouds, embers, lightning, scale pattern, claw marks, footprints, egg, wings) are generic SVG/CSS shapes. Do **not** add glowing markings, stripes or patterns onto or around the sprite's body; a soft round halo behind it is the most allowed (R3).
6. One git commit per task. `npx tsc --noEmit`, `npm run build`, `npm test` green before each commit.
7. Accessibility: real buttons/inputs, visible `:focus-visible` rings, text contrast >= 4.5:1, `aria-label` on icon-only buttons, decorative SVG `aria-hidden`. Lightning must respect photosensitivity limits (R2).
8. Fonts bundled locally (CSP is `'self'`), no runtime Google Fonts.

---

## Task R1 — Theme tokens + fonts
- Install `@fontsource/fredoka` (500/600/700), `@fontsource/nunito` (600/700/800), `@fontsource/pixelify-sans` (500/600/700); import once in both window entries.
- Roles: **Fredoka** headings; **Nunito** body/UI; **Pixelify Sans** numbers, timer, small uppercase tags, the `NOX` name tag.
- Palette (keep existing token names where possible, add new ones):
  - backgrounds: `--bg #0A0E1C`, `--sky #0E1530`, `--surface #141B33`, `--surface-2 #1A2342`, `--line #263055`, `--line-strong #3A4675`, `--dialog #070A14`
  - text: `--text #EEF2FF`, `--text-dim #AEB8D6`
  - **primary accent (fixed): Mint** `--accent #3EF0A0`, `--accent-ink #06261A`, `--accent-shadow #1C8A5B`
  - **second accent (user-selectable): Electric blue** `--bolt` + `--bolt-glow` (= bolt at ~40% alpha). Four presets, default **Electric**:
    | id | name | `--bolt` |
    |---|---|---|
    | `electric` | Electric | `#5AC8FF` |
    | `cyan` | Cyan | `#3FE6FF` |
    | `cobalt` | Cobalt | `#5B8CFF` |
    | `ice` | Ice | `#8FD3FF` |
  - status: `--danger #FF8A8A`, `--danger-text #FF9E9E`, `--danger-bg #2A1820`, `--danger-line #6A2C3C`, `--danger-ink #3A0D12`, `--warn #FFA94D`, `--warn-text #FFC27A`, `--moon #F6EBC8`
  - radii: cards 26px, rows 18px, pills 999px, dialog 0 (pixel frame)
- `--bolt`/`--bolt-glow` are set at runtime on `:root` from the setting (R10), in **both** windows, and update live on `settings:changed`.
- Update `docs/TOKENS.md`.

**How the two accents are used (apply consistently):**
- **Mint = action and done.** Primary buttons, the sprite-slot/logo eyes, `NOX` name tag, checkmarks and done states, selected nav pill, text-input focus border.
- **Blue = energy and "active".** Dialog box inner edge + soft outer glow, the running focus timer ring and its "Focusing" label, the halo behind the pet while it is talking/thinking/in focus, a few twinkling stars, lightning, keyboard focus rings (`:focus-visible`). Never use blue for primary buttons, and never put mint and blue on the same small element.

## Task R2 — Decorative + UI components
In `src/components/deco/` and `src/components/ui/`, all token-driven:
- `NightSky` — header background, clipped to its box, behind all content: twinkling stars (a few in `--bolt`), crescent moon with slow glow pulse, 2–3 drifting clouds, an occasional shooting star, rising embers near the horizon, the scale-pattern horizon edge, and **`Lightning`** (below). Props: `animated`, `lightning`. `aria-hidden`.
- **`Lightning` — must look natural, not a static icon.** Requirements:
  - **Rare and random:** next strike after a random 15–45 s; only one at a time; only when `animated && lightning` and the window is visible.
  - **Procedural shape, new each time:** build the bolt with midpoint displacement: start at a random point in the upper sky (often partly behind a cloud), end at a random point lower down (near the horizon or fading out mid-air). Recursively split each segment 5–6 times, offsetting the midpoint perpendicular to the segment by a random amount proportional to its length (decaying each level). Add 1–3 branches that split off at random points, go a shorter distance at a shallower angle, and are thinner.
  - **Rendering:** SVG paths. Main channel: 1.5–2.5px stroke in a near-white tint of `--bolt`; branches 0.75–1.25px. Under it a wider (6–10px), blurred stroke in `--bolt-glow`. Round joins/caps. Branches fade toward their tips (gradient or opacity).
  - **Timing like real lightning:** flash on (opacity ~0.9) → quick dim (~60 ms, ~0.25) → second flash (~100 ms, ~0.8) → fade out over ~400–600 ms. Sometimes a single flash, sometimes a double; total under 1 s.
  - **Sky flash:** at the same time, briefly brighten the sky with a soft radial glow tinted `--bolt` around the strike (max ~0.12 opacity), and slightly lighten nearby clouds.
  - **Variety:** about half of the events are **sheet lightning** (only a soft glow inside/behind a cloud, no visible bolt).
  - **Safety:** never more than 3 flashes in any 1-second window; low-contrast flash (no full-screen white); disabled entirely under `prefers-reduced-motion` and when the `ui_lightning` setting is off. Clean up all timers on unmount; pause while the window is hidden or unfocused.
  - Put the bolt generator in a pure function (`generateBolt(seed/rng, bounds) → paths`) with a unit test (path stays inside bounds, has the expected number of segments, deterministic for a fixed seed).
- `DialogBox` — Nox's message frame: dark fill, 3px light border, inner inset line in `--bolt` plus a soft outer `--bolt-glow`, pixel `NOX` name tag (mint) top-left, small ▼ indicator.
- `ChunkyButton` (primary: mint fill + 4–5px solid bottom shadow, presses down 3px on active; secondary: outline), `Pill`, `Tag` (Pixelify uppercase; overdue/personal/neutral), `Card`, `StatCard`.
- `SlitEyes` (logo mark only; mint pills with a dark vertical pupil, occasional blink), `ClawMarks` (overdue cards, low opacity), `Footprint` (done = mint fill, today pending = mint outline, missed = dim), `StreakEgg` (purely visual), `Wings` (flanking the focus timer).
- All keyframes (`nox-twinkle`, `nox-moon`, `nox-drift`, `nox-shoot`, `nox-rise`, `nox-bob`, `nox-blink`) in one CSS file with a `prefers-reduced-motion: reduce` override.

## Task R3 — Pet window
Match `night-lair-pet.html` (ignore its toast and mini HUD):
- Bubble becomes a `DialogBox` (~300px wide) with actions when the message has them (reminder → "Start focus" / "Later"); plain chat replies have none. Streaming, stop button and scroll stay as they are.
- Chat input: rounded pill, mint border, round mint send button.
- Sprite: gentle idle bob (`nox-bob`), off under reduced motion and while dragging. Existing eyelid/expression system untouched. A soft round `--bolt-glow` halo **behind** the sprite while Nox is talking, thinking or during focus; no halo when idle.
- Check-in prompt and other pet popups use `DialogBox`.
- **Window size:** grow the pet window to fit the ~300px dialog. Update the Rust size constants and `tauri.conf.json` together, keep bottom-right anchoring, the clamp logic and position persistence, and update hit-region reporting so the larger transparent area stays click-through. Verify Phase 1 window behavior does not regress.

## Task R4 — Dashboard shell
- Replace the sidebar with the **top pill nav** from the mockup (logo `SlitEyes` + "nox", centered pill nav, round minimize/close). Order and shortcuts unchanged: 1 Home, 2 Habits, 3 Focus, 4 Todos, 5 Recap, 6 Integrations, 7 Settings, Esc closes.
- Home gets the full `NightSky` header; other pages a compact version (shorter, same sky and lightning, no hero).
- Nav wraps cleanly at narrow widths; window may grow to ~1000×760 if needed (update config).

## Task R5 — Home
- Header: real `<Pet>` at ~1.4× (`image-rendering: pixelated`) on the scale-patterned rock, time-aware greeting with the user's name, and a `DialogBox` with Nox's message.
- **Message is rule-based, not LLM.** Priority: (1) oldest overdue todo → "<title> is N days overdue. Want to work on it for 25 minutes now? I'll keep everything else quiet." with Start focus / Later; (2) something due today; (3) habits not done today; (4) friendly idle line. "Start focus" calls the existing pomodoro engine; "Later" snoozes that suggestion for 1 hour (in memory). All strings i18n.
- Summary row: todos open (+ overdue count in danger color), focus sessions today (x/4), habits done (x/y). No weather card until a weather integration exists.
- "Today" card: open todos for today/overdue; overdue rows danger-styled + `ClawMarks` + `OVERDUE` tag; inline add input using the existing `/todo` parser.
- Focus card: `Wings` + round timer (Pixelify); ring and "Focusing" label in `--bolt` while running; Start button wired to the engine.
- Habits card: `StreakEgg`, "Streak N days · best M", toggle rows, 7-day `Footprint` row.
- "Next 7 days": dashed line with day nodes; overdue node uses an `OVERDUE` tag; data from the existing upcoming query.

## Task R6 — Habits page
Card per habit: toggle, streak, best, 7-day footprints; `StreakEgg` at the top; add/rename/delete behavior unchanged, restyled (delete confirm stays).

## Task R7 — Focus page
Large centered timer (Pixelify ~64px) in a ring with `Wings`; progress ring in `--bolt` with a soft glow while running, `--line` when idle; session dots; focus/break durations; Start / Stop / Skip as chunky buttons. Behavior unchanged.

## Task R8 — Todos page
Pill filters (Active / Done / All); rows like the Home "Today" card; due dates in Pixelify; reminders section restyled; add input at top; empty states with a small moon/stars illustration and plain copy.

## Task R9 — Recap, Integrations
- Recap: one card per day, date in Pixelify, summary, stat chips. Empty state: "No recaps yet. The first one arrives at <recap time>."
- Integrations: card per service with a generic icon (no brand logos), honest status ("Not connected", "Connected", "Planned"); unbuilt ones disabled with "Planned". No "Coming soon".

## Task R10 — Settings + appearance options
- Cards: General, Features, Appearance. Editable fields look editable (bordered inputs).
- **Appearance** (new keys added via a **new numbered migration** with `INSERT OR IGNORE`; never edit an old migration):
  - `ui_bolt_color` — "Lightning blue": 4 swatch buttons (Electric, Cyan, Cobalt, Ice), default `electric`. Changing it updates `--bolt`/`--bolt-glow` live in both windows.
  - `ui_animations` — "Background animations" (default on). Off → `NightSky` static (no clouds, shooting star, embers, lightning; static stars).
  - `ui_lightning` — "Lightning" (default on, disabled/greyed when animations are off).
- OS reduced-motion always wins. All decorative animation pauses when the dashboard is hidden/unfocused (`document.visibilityState`).

## Task R11 — Polish pass
- Hover/active/focus states everywhere; focus rings in `--bolt`.
- Check every page in English and Indonesian; long strings must not break layouts.
- Remove unused styles, the old blob SVG, dead components. Update `docs/ARCHITECTURE.md` and `docs/TOKENS.md`.

---

## Out of scope (do NOT build)
- Energy, level, XP, points/embers, rewards, "+10" toasts (gamification undecided; no stub UI).
- Weather and Notion data (Phase 2).
- Any new character art, any change to the sprite image, markings or patterns on/around the sprite.
- A user-selectable primary color (mint is fixed).

## Definition of done
- 11 tasks committed separately; `tsc`, `build`, `test` green (including the `generateBolt` test).
- No hardcoded colors outside `tokens.css`; no runtime font fetches.
- Final reply (short): commits, deviations from mockups and why, UNVERIFIED items, and a list of screenshots Bas should take.

## Manual verification checklist (Bas)
1. Home matches the mockup layout with mint actions and blue glow on the dialog box edge.
2. Wait a minute on Home: stars twinkle, clouds drift, embers rise, a shooting star passes, and **lightning** appears now and then. Each bolt has a different jagged shape with small branches and flickers (not a fixed icon); sometimes only a cloud glows.
3. Settings → Appearance: switch Lightning blue between Electric / Cyan / Cobalt / Ice; the dashboard and pet window change instantly.
4. Turn Lightning off → no more strikes; turn Background animations off → everything static; minimize the dashboard → CPU drops (Task Manager).
5. Windows Settings → Accessibility → Visual effects → Animation effects off → everything static, no lightning.
6. Start a focus session: the timer ring and "Focusing" turn blue; the pet gets a soft blue halo; when stopped, both go away.
7. Pet window: dialog-box bubble, mint chat input, gentle bob; empty transparent space still click-through; dragging works.
8. All 7 pages restyled, shortcuts 1–7 and Esc work, Tab shows blue focus rings.
9. Indonesian: nothing overflows or is untranslated. No "boss / quest / flight" wording anywhere.
