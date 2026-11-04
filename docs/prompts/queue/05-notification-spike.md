# PARKED — do not run this step

Bas postponed this (undecided about what he wants from notification reading).
00-run-queue.md skips it. Kept for later.

# Queue 05 — Spike: can Nox read Windows notifications?

Recommended: Opus, effort high. This is a SPIKE: build a throwaway test and write
a report. Do not ship any user-facing feature.

Context: Bas would like a digest of WhatsApp, Telegram and Discord notifications
in Nox without unofficial WhatsApp libraries (they break the terms of service
and risk a ban). Windows has `UserNotificationListener` (WinRT). It is unverified
whether it works for an unpackaged Tauri app (no package identity).

## Rules
1. Read docs/ARCHITECTURE.md and src-tauri/Cargo.toml first.
2. Keep the spike out of the production build: an example binary
   (`src-tauri/examples/notif_spike.rs`) and, if needed, dev-only Cargo
   settings. The main app's dependencies, features and bundle must not change.
3. Do not git commit or push. Do not print notification BODIES in logs or in
   the report: only counts, app display names and whether text was available.
4. tsc, build, test, cargo check must stay green for the main app.
5. You cannot run this interactively (it needs Windows consent and a real
   desktop). Write it, make it compile, document exactly how Bas runs it from
   PowerShell, and mark the result "needs Bas to run".

## Tasks
1. Using the `windows` crate, the example should: get
   `UserNotificationListener::Current()`, call `RequestAccessAsync()` and print
   the access status, then (if allowed) call `GetNotificationsAsync(Toast)` and
   print per notification only: app display name, whether a text payload was
   readable, and the creation time. Handle every failure path with a clear
   message (access denied, API unavailable, no package identity).
2. Document in `docs/reports/notification-spike.md`:
   - how to run it (`cd src-tauri; cargo run --example notif_spike` in
     PowerShell) and what each outcome means;
   - what Windows requires for this API from an unpackaged desktop app
     (package identity, sparse package / MSIX, capability declarations),
     citing sources you found, and how confident you are;
   - what data is exposed (app name, title, body) and the privacy risks;
   - two or three viable designs (for example: local-only digest of selected
     apps, with an allow-list of apps, never stored beyond N hours) and a
     recommendation with an effort estimate;
   - the alternative that avoids all of this: a Telegram bot as the
     phone-to-PC channel (already built) and what it does and does not cover.
3. Leave a short "next steps" list that Bas can approve or reject.

## Out of scope
Any shipped UI, storing notifications, reading message bodies in logs,
unofficial WhatsApp libraries, anything that runs without Bas's explicit
action.

## Manual checklist for Bas (put it in the report)
1. Run the example from PowerShell and paste the output (no message text
   should be in it) back to Claude in chat.
2. Say whether Windows showed a consent prompt.
