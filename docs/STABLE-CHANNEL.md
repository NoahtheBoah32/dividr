# DiviDr Stable Channel

Two channels, one repo:

| Channel | Branch | Who | What it is |
|---|---|---|---|
| Dev | the active dev branch | Joaquin | Daily work. May break at any time. |
| Stable | `stable` | Testers (Leo & co.) | Only commits that passed the release gate. Run from the repo — no installer. |

The `stable` branch only ever moves forward to a commit that passed the gate.
(The pre-existing `staging` remote branch is untouched by this process.)

## Promoting a release (maintainer, on the dev machine)

1. Commit all work on the dev branch. Working tree must be clean.
2. **Secret scan** — before anything ships: no `.env`, no API keys, no credentials in
   the diff. `git diff stable..HEAD` and search for `key`, `token`, `secret`, `password`.
3. Start the app with CDP and run the automated gate:
   ```powershell
   $env:DIVIDR_CDP='9222'; npm start
   # in another terminal, from the repo root:
   node tests/release/run-gate.mjs        # add --deep for the live-EDITH tests
   ```
   Gate must print `GATE GREEN`.
4. Run `tests/release/SMOKE-CHECKLIST.md` by hand (~10 min). Any ✗ blocks promotion.
5. Move `stable` to the gated commit and tag it:
   ```bash
   git branch -f stable HEAD
   git tag stable-$(date +%Y%m%d)
   git push origin stable --tags
   ```
6. Tell testers to update (below). Note in the message whether the release touched
   `src/main.ts` or `src/backend/**` — it almost always does, so the default advice
   is: fully quit and relaunch.

## Tester setup (one-time)

Prerequisites beyond the main README (Node 18+, Python 3.13 + `requirements.txt`):

- **Claude Code CLI** — EDITH runs on it. Install and log in:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude   # complete the login once
  ```
  Without a logged-in `claude` CLI, the EDITH panel will not respond.
- **`.env` in the repo root** (ask the maintainer for values — never committed):
  - `PIXABAY_API_KEY` — stock footage search
  - `ANTHROPIC_API_KEY` — b-roll quality verification (optional but recommended)
  - `SFX_LIBRARY_PATH` — folder of SFX files for the Audio Tools panel (optional)

Then:
```bash
git clone <repo-url>
cd dividr-mycelium
git checkout stable
npm install
npm start
```

**One instance at a time.** Never run two copies of DiviDr — they share the same
profile (projects database, recordings, settings) and will silently fight over
project state. If the app behaves strangely, first check Task Manager for a
second DiviDr/Electron instance left over from an earlier session.

## Tester update flow (every release)

```bash
git pull
npm install       # dependencies may have changed
```
Then **fully quit the app and relaunch** — main-process changes never hot-reload.

## Reporting an issue

Include the commit you're on (`git rev-parse --short HEAD`), what you did,
and what happened. That hash is the whole point of the stable channel — every
tester report maps to an exact gated commit.
