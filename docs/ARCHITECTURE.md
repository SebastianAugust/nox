# Architecture

Nox is a Tauri v2 app with two windows that load the same React bundle
(`src/main.tsx` picks the view by window label). Data lives in one SQLite file
reached through `tauri-plugin-sql`; Rust runs the schema migrations at startup.

## Windows

| Window | Label | Root | Size | Role |
|---|---|---|---|---|
| Pet | `main` | `src/App.tsx` | 330×350 logical, transparent, always on top | The sprite, its dialog-box bubble, chat, check-ins. Owns every scheduler and the pomodoro timer, because it is the one window that is always alive. |
| Dashboard | `dashboard` | `src/dashboard/Dashboard.tsx` | 1000×760 | Home, Habits, Focus, Todos, Recap, Integrations, Settings. A view plus remote control; hidden, not destroyed, when closed. |

### Pet window size and click-through

The pet window is bottom-right anchored: content stacks upward from the
bottom (`.pet-root`), and the window grows upward when the chat or a check-in
opens (`resize_window` keeps the bottom edge). Its collapsed height must match
in three places: `WIN_W`/`WIN_H` in `src-tauri/src/pet.rs`, the `main` window in
`tauri.conf.json`, and `HEIGHT_CLOSED` in `App.tsx`.

Most of the window is transparent. Every visible part carries `data-hit`
(the dialog box including its name tag, the chat pill, the sprite); `App.tsx`
reports their rectangles to Rust (`set_hit_regions`), and a Rust loop toggles
`set_ignore_cursor_events` as the cursor moves in and out of them. The pet's
saved position is the collapsed top-left (`pet_position`).

## Source layout

```
src/
  main.tsx                 picks the window view; imports fonts and all CSS once
  App.tsx                  pet window
  components/
    Pet.tsx                the sprite + eyelid expressions (do not restyle)
    Bubble.tsx, ChatInput.tsx, CheckinPrompt.tsx   pet window parts
    Pomodoro.tsx           usePomodoro (view of the engine), FocusRing, Focus page block
    ui/                    DialogBox, ChunkyButton, Pill, Tag, Card, StatCard, Toggle, IconButton
    deco/                  NightSky, Lightning, SlitEyes, ClawMarks, Footprint, StreakEgg, Wings, MoonStars
  dashboard/
    Dashboard.tsx          shell: floating top bar, page switch, shortcuts
    PageHeader.tsx         sky band (compact, or Home's hero)
    nav.ts                 page order = 1-7 shortcuts
    format.ts              due-date wording, rich-text template fill
    pages/                 one file per page
    widgets/               TodoItem, AddTodo, WeekFootprints, HabitItem, Reminders, SettingControls
  lib/
    db.ts, db-helpers.ts   all SQL
    i18n.ts                en + id strings, t(), useLanguage()
    theme.ts               appearance settings → :root (useAppearance)
    bolt.ts                procedural lightning bolt generator (pure, tested)
    homeMessage.ts         Home's rule-based Nox message (pure, tested)
    streaks.ts             per-habit streaks, day shifting (pure, tested)
    commands.ts            /todo and /remind parsers (pure, tested)
    pomodoroEngine.ts      the timer (pet window only)
    deliver.ts             one gate for every bubble / toast
    checkin.ts, friction.ts, recap.ts, reminders.ts   schedulers
  styles/
    tokens.css             every color, size, radius, shadow, duration
    motion.css             decorative keyframes + reduced-motion / paused / off rules
    ui.css                 shared components and the night sky
    pet.css                pet window
    dashboard.css          dashboard shell and pages
  index.css                base reset and the sprite's expression keyframes
src-tauri/
  migrations/0001_init.sql, 0002_appearance.sql
  src/lib.rs               app setup, dashboard show/hide, migrations list
  src/pet.rs               pet placement, resize, click-through
```

## Cross-window events

| Event | From → to | Payload |
|---|---|---|
| `settings:changed` | dashboard → all | `{ key }`; both windows re-read language and appearance |
| `pomodoro:cmd` | dashboard or pet bubble → engine | `{ type: "start" \| "stop" \| "skip" }` |
| `pomodoro:request` | dashboard → engine | engine answers with a snapshot |
| `pomodoro:state` | engine → all | `PomSnapshot` on every change (deadline-based, not per second) |

## Styling

Components use class names from the CSS files above; every value in those
files is a `var(--token)` from `tokens.css` (see `docs/TOKENS.md`). Inline
styles remain only for data-driven geometry (star positions, the lightning
glow position, the sprite's eye offsets). Tailwind is still imported in
`index.css` for its Preflight reset; no utility classes are used, so avoid
class names that collide with Tailwind utilities (`ring`, `shadow`, `border`,
`flex`, `grid`, `hidden`, ...).

The mint accent is fixed; the lightning blue (`--bolt`) is set at runtime from
`ui_bolt_color`. Both windows call `useAppearance()` at their root.

## Decorative motion

`NightSky` draws the header sky. Its CSS animations pause (`data-paused`) while
the dashboard is hidden or unfocused, stop under `html[data-animations="off"]`
(`ui_animations`), and are removed by the reduced-motion rule in `motion.css`.
`Lightning` is mounted only when animations and `ui_lightning` are on, motion
is not reduced, and the window is active; unmounting clears its timers.

A strike: every 15-45 s, half the time a bolt from `generateBolt()` (midpoint
displacement, 32 or 64 segments, 1-3 fading branches, blurred glow) and half
the time sheet lightning (a glow in a cloud). Opacity follows a real flash
curve (flash, ~60 ms dim, second flash, ~500 ms fade) via the Web Animations
API. At most two flashes per strike and strikes 15 s apart keep it far under
3 flashes per second; the sky glow never exceeds 0.12 opacity.

## Home's message

`pickSuggestion()` picks, in order: the oldest overdue todo, something due
today, open habits, an idle line. No model call. "Start focus" sends
`pomodoro:cmd`; "Later" snoozes that suggestion for an hour in memory.

## Tests

`npm test` runs Vitest on the pure modules in `src/lib/*.test.ts`.
