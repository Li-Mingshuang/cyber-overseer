# Cyber Overseer

> While its human master sleeps, the cyber overseer cracks the whip on the master's glorious cyber labourer.

**The problem**: you hand an AI agent a task and go to sleep. Halfway through, the agent stops and waits
for you to say something. It sits there for hours — even though there is still work to do.

**Cyber Overseer** is an unattended supervisor. It reads your **plan document**, reads the agent's
**last answer**, adds the **real result of your verification commands**, decides whether the job is
actually finished, and if not, **injects the next instruction back into the agent** — over and over,
until the plan is done or one of your guardrails trips.

## 60-second start

```bash
git clone <this-repo> cyber-overseer && cd cyber-overseer
# zero runtime dependencies: no npm install, no build step
node /path/to/cyber-overseer/bin/cw.mjs init      # scaffold cw.config.mjs + PLAN.md + .cyber/
node /path/to/cyber-overseer/bin/cw.mjs doctor    # what can this machine do?
node /path/to/cyber-overseer/bin/cw.mjs watch     # dry run: judge + print the whip, inject nothing
node /path/to/cyber-overseer/bin/cw.mjs run       # crack the whip for real
```

Offline end-to-end demo (no network, no API key, no real agent):

```bash
node bin/cw.mjs run --config examples/lazy-agent/cw.config.mjs
```

It whips a deliberately lazy worker until `verify.mjs` goes green, then stops and writes a report.

## Three design decisions

**1. Verdicts are built on evidence, never on the agent's self-report.**
Three hard signals: plan checkboxes (re-read every round), real exit codes of your verification
commands, and workspace changes (`git diff --stat`, fingerprints). Default order:
failing verification → continue; unchecked todos → continue; all checked *and* verification green → done;
anything genuinely undecidable → `needs-human` (never guess "done").
Two extra guards: the report plots each verification command **round by round** ("red → green"), and the
plan's "contract" (acceptance criteria + forbidden list + task texts) is fingerprinted on the first round —
any removal or rewrite counts as *weakening* and the rule judge refuses to call it done
(`evidence.planGuard`; opt out with `allowPlanWeakening`).

**2. Every agent gets its own whip channel — and they all close the loop.**

| Agent | Read | Whip |
|---|---|---|
| **DSH** | `$DSH_HOME/sessions/**/session.jsonl.zstd` (multi-frame zstd) | `dsh --profile headless "…"`, or `POST /api/session.prompt` into a live session, or the **SDK stdio JSON-RPC** channel (`adapter: 'dsh-jsonrpc'`, one `cw dsh-profile --install`), or human-sim, or a custom command |
| **Codex CLI** | `state_5.sqlite/threads` + `sessions/**/rollout-*.jsonl` | `codex exec resume <id> -C <dir> -s workspace-write -c approval_policy=never "…"` |
| **opencode** | `opencode.db` (`message`/`part` projections) | `opencode run -s <sessionID> --dir <dir> --format json "…"` |
| **Cursor** | `state.vscdb` (`cursorDiskKV`) | official `stop` hook returning `{"followup_message":"…"}` — Cursor drives the loop itself |
| **Any ACP agent** | the Agent Client Protocol (DSH, opencode, the Zed ecosystem) | standard `session/prompt` on one long-lived connection — like a human talking to the same agent repeatedly |
| **Any GUI agent** | human-sim: clipboard/UIA read of the dialog | human-sim: focus → paste → verify → Enter (three safety interlocks) |
| **Any CLI agent** | command stdout / log file | `command: ['my-agent', '{text}']`, one fresh process per whip |
| **Any MCP agent** | `.cyber/agent-reports.jsonl` | built-in MCP server: the agent calls `overseer_check` each turn |

**Parallel supervision**: list several agents under `agents: [...]` and one process watches them all —
independent verdicts and whips per entry, one shared budget (rounds / wall clock / cost) so N agents do not
mean an N-times bill, per-agent reports plus a merged `CW-REPORT.md`. Watch it live with `cw status --watch`,
and get a native Windows toast when everything stops.

**3. The human-sim channel is fenced by three interlocks.**
(1) it only acts when system-wide keyboard/mouse idle exceeds a threshold — "whip only while the master
rests" is a hard precondition, not a metaphor; (2) after stealing focus it *reads back* the foreground
window and refuses to type if it did not win; (3) before pressing Enter it re-reads the input box
(`Ctrl+A`/`Ctrl+C`) and compares with the intended text — mismatch means it aborts, so a wrong message
can never be sent. Verified live on Windows against a Chromium page (same engine as Cursor/Codex desktop):
focus+readback, typing, clipboard paste, CJK/emoji, idle fuse — all green.
UIA `TextPattern` is not supported by Chromium, so the reader uses the clipboard instead.

All three platforms have a driver behind the same interface (`src/ui/`): Windows (built-in PowerShell 5.1 +
UIA + SendInput, incl. screenshot/OCR), macOS (`osascript` / System Events — needs Accessibility permission,
Ctrl chords are translated to Command), Linux (`xdotool` + `xclip`/`xsel`/`wl-clipboard` — Wayland needs
XWayland, and without `xprintidle` the channel refuses to act). `cw doctor` / `cw windows` tell you what is
missing on your box. The macOS/Linux drivers are unit-tested against a fake runner but **not yet verified on
real machines** (this project's dev box is Windows).

Reading back is the fragile part, so it now tries a list of transcript-area click candidates
(`readerClickPoints`) before copying, offers an optional `blurComposer: 'esc'`, and — importantly —
**never destroys a draft in your composer**: the focus probe used to clean up with `Ctrl+A` + `Delete`,
which wiped whatever the master was typing; it now does a read-only pre-check and undoes with `Ctrl+Z`,
aborting the whip whenever the composer already holds someone's text.

## Guardrails (defaults are deliberately conservative)

`maxRounds` 24 · `maxWallClockMs` 10h · `maxStallRounds` 3 (same answer + same evidence ⇒ stalled) ·
`quietHours`/`workWindow` · `requireHumanIdleMs` 120s (human-sim) · `autoApprove` **false** (the overseer
never clicks "approve" for you) · `.cyber/PAUSE` sentinel (`cw pause` / `cw resume`) · `maxCostUsd`.

Outcome handling: terminal summary + bell, optional webhook, a human-readable `CW-REPORT.md`
(what happened, why it stopped, what is left, every whip verbatim), machine-readable
`.cyber/journal.jsonl`, and resumable `.cyber/state.json` (Ctrl+C or power loss ⇒ `cw run` continues).

## Commands

`init` · `doctor` · `adapters` · `sessions` · `windows` · `run` · `watch` · `judge` · `whip` ·
`status` (`--watch` = live panel) · `report` · `pause`/`resume` · `toast` · `dsh-profile` ·
`hooks install cursor` · `hook cursor-stop` · `mcp --serve`

Exit codes: `0` done, `10` max rounds, `11` max wall clock, `12` max cost, `13` stalled, `14` blocked,
`15` needs human, `16` paused, `17` agent gone, `1` error, `130` interrupted.

## Plan document

The plan is the contract; write it so a machine can check it:

```markdown
# Add voice narration to the weather plugin

## Goal
Narrate daily weather through the existing TTS; `weather say` must work.

## Acceptance criteria
- `npm test` is green
- `node verify.mjs` exits 0
- README documents the new command

## Tasks
- [ ] Wire up the TTS dependency
- [ ] Implement the `weather say` subcommand
- [ ] Add tests
- [ ] Update README

## Out of scope
- Do not touch CI config
```

Make acceptance criteria **command-verifiable**, keep tasks small enough for one round, and tell the
agent (via `AGENTS.md` or a system prompt) to tick a checkbox whenever it finishes an item — those
checkboxes are the progress signal the overseer reads.

## Judges

`rule` (zero-cost, deterministic: checkboxes + verification + stall detection — works offline),
`llm` (any OpenAI-compatible endpoint; strict JSON out; unparseable output degrades to `needs-human`,
never to `done`), and `chain` (default: rule first, escalate to the model only when the rule judge
cannot decide or has low confidence).

## Requirements

Node ≥ 22.15 (recommended 24) for `node:sqlite` and `node:zlib` zstd. Zero runtime dependencies.
The human-sim channel has drivers for all three platforms (Windows / macOS / Linux) behind one interface;
macOS and Linux are unit-tested but not yet exercised on real machines (the dev box is Windows).

## Documentation

- [`README.md`](README.md) — full Chinese documentation (primary)
- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture and design decisions
- [`docs/ADAPTERS.md`](docs/ADAPTERS.md) — per-agent integration guide
- [`docs/SAFETY.md`](docs/SAFETY.md) — safety model and threat notes
- [`docs/recon/`](docs/recon/) — reverse-engineering reports for DSH, Codex, opencode, Cursor

## Why this exists

An agent stopping is not a model-capability problem; it is a *nobody-is-watching* problem.
The reliable fix is not a longer context window — it is someone who kicks the agent when it stops,
and who can tell whether the work is actually done. Otherwise you have two blind men nodding at
each other. So the emphasis here was never "send a message automatically"; it is
**grounding "is it done?" in verifiable evidence**.
