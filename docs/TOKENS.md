# Tokens — Night Lair

All visual values live in `src/styles/tokens.css` as CSS custom properties on
`:root`. Components and stylesheets reference them with `var(--…)`; no hex or
rgba is written anywhere else, and font sizes, radii, spacing and durations
come from the scales below.

| File | Holds |
|---|---|
| `src/styles/tokens.css` | the tokens |
| `src/styles/motion.css` | decorative keyframes and their off switches |
| `src/styles/ui.css` | shared components (`components/ui`, `components/deco`) and the night sky |
| `src/styles/pet.css` | the pet window |
| `src/styles/dashboard.css` | the dashboard shell and pages |
| `src/index.css` | base reset and the sprite's expression keyframes |

## Two accents

| Accent | Tokens | Means | Used for |
|---|---|---|---|
| **Mint** (fixed) | `--accent`, `--accent-ink`, `--accent-shadow`, `--accent-hover` | action, done | primary buttons, checkmarks and done states, selected nav pill, logo eyes, the `NOX` name tag, text-input focus border |
| **Lightning blue** (user-selectable) | `--bolt`, `--bolt-glow`, `--bolt-core`, `--bolt-faint` | energy, "active" | dialog-box inner edge and outer glow, running focus ring and its "Focusing" label, the halo behind the pet while it talks/thinks/focuses, a few stars, lightning, `:focus-visible` rings |

Never use blue for a primary button, and never put mint and blue on the same
small element.

### Lightning blue presets

| id | name | token |
|---|---|---|
| `electric` (default) | Electric | `--bolt-electric` `#5AC8FF` |
| `cyan` | Cyan | `--bolt-cyan` `#3FE6FF` |
| `cobalt` | Cobalt | `--bolt-cobalt` `#5B8CFF` |
| `ice` | Ice | `--bolt-ice` `#8FD3FF` |

`src/lib/theme.ts` reads the `ui_bolt_color` setting and sets
`--bolt: var(--bolt-<id>)` inline on `<html>`. `--bolt-glow` (40% alpha),
`--bolt-core` (near-white bolt channel) and `--bolt-faint` are derived from
`--bolt` with `color-mix`, so they follow automatically. It also sets
`data-animations="on|off"` on `<html>` from `ui_animations`. Both windows call
`useAppearance()` at their root and re-apply on `settings:changed`.

## Palette

| Group | Tokens |
|---|---|
| Backgrounds | `--bg` page, `--sky` header sky, `--surface` cards, `--surface-2` rows, `--line`, `--line-strong`, `--dialog` dialog fill, `--dialog-inset`, `--void`, `--overlay`, `--overlay-soft` |
| Text | `--text` (main), `--text-dim` (secondary, 8:1 on `--surface`), `--tag-text` |
| Status | `--danger`, `--danger-text`, `--danger-bg`, `--danger-line`, `--danger-ink`, `--warn`, `--warn-text` |
| Sky | `--moon`, `--moon-glow-lo/hi`, `--cloud-1/2`, `--scale-line`, `--scale-tint` |
| Misc | `--drop` (hard pixel shadow), `--eyelid` (matches the sprite's face) |

## Type

| Token | Font | Role |
|---|---|---|
| `--font-head` | Fredoka 500/600/700 | headings |
| `--font-body` | Nunito 600/700/800 | body and UI |
| `--font-pixel` | Pixelify Sans 500/600/700 | numbers, timer, small uppercase tags, the `NOX` tag |

Fonts are bundled from `@fontsource/*` (latin subset) and imported once in
`src/main.tsx`, which both windows load. The CSP allows no remote fonts.

Sizes: `--fs-3xs` 10 · `--fs-2xs` 11 · `--fs-xs` 12 · `--fs-sm` 13 · `--fs-md` 14 ·
`--fs-base` 15 · `--fs-lg` 16 · `--fs-xl` 19 · `--fs-2xl` 21 · `--fs-3xl` 26 ·
`--fs-4xl` 32 · `--fs-timer` 64. Weights: `--fw-body` 700, `--fw-strong` 800,
`--fw-head` 600.

## Spacing, radii, sizes

- Spacing `--sp-1` … `--sp-16`: 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 36 px.
- Radii: `--r-card` 26 (cards), `--r-tile` 20 (stat tiles), `--r-row` 18 (rows),
  `--r-control` 16, `--r-small` 8, `--r-pill` 999, `--r-dialog` 0 (pixel frame),
  `--r-perch` 42.
- Controls: `--control-sm` 34, `--control-md` 38, `--control-lg` 44, `--check` 22.

## Shadows and focus

- `--shadow-chunky` / `--shadow-chunky-sm`: the solid mint bottom edge of a
  primary button; it shrinks by `--press-depth` when pressed.
- `--shadow-dialog`: dialog frame — dark gap, `--bolt` inner line, soft
  `--bolt-glow`, hard drop shadow.
- `--focus-ring`: every `:focus-visible` (2px `--bg` gap + 2px `--bolt`).

## Motion

`--dur-fast` 120ms, `--dur-base` 200ms, `--dur-slow` 300ms, `--ease-out`,
`--press-depth` (how far a chunky button sinks).
Decorative keyframes (`nox-twinkle`, `nox-moon`, `nox-drift`, `nox-shoot`,
`nox-rise`, `nox-bob`, `nox-blink`) live in `src/styles/motion.css`, which
turns all of them off under `prefers-reduced-motion: reduce`.

Off switches, strongest first: the OS reduced-motion setting, then
`html[data-animations="off"]` (the sky only), then `[data-paused]` (window
hidden or unfocused). The pet's bob and halo follow reduced motion only.

## Color scheme

`.dash` sets `color-scheme: dark` so native checkboxes and time fields render
dark. It is deliberately not on `:root`: in the transparent pet window that
would give the page an opaque dark canvas.
