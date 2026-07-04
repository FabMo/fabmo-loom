# Quickstart — from clone to a verified toolpath, then to your own app

Loom is built to be driven two ways: by you, and by an AI coding agent
working for you. This guide does both — first you run a verified job by
hand so you know what the foundation guarantees, then you point an agent
at the repo and have it build a bespoke CAM app on top.

## 1. Prove the foundation on your machine (~2 minutes)

You need Node.js 20+.

```bash
git clone https://github.com/FabMo/fabmo-loom.git
cd fabmo-loom
npm install
npm test
```

`npm test` runs the gauntlets: every strategy proven in both directions —
clean work accepted, sabotaged work rejected with measured numbers.

## 2. Run your first job

```bash
node examples/first-job.mjs
```

This pockets a rounded rectangle with a circular island on a 1/4" endmill
and prints something like:

```
verifier says: OK
  gouge samples: 0/5251
  coverage residual: 0.316%
  moves: 2481, cut length: 297.96", est 2.98 min

wrote examples/out/first-job.sbp and .nc

sabotage (stray cut outside the declared region): REJECTED
  error: "sabotaged pocket" gouges outside its declared region: 14/5274 samples, first at (5.500, 4.500, -0.025)
```

Read [`examples/first-job.mjs`](examples/first-job.mjs) top to bottom —
it is the whole model in ~130 lines:

1. **Strategy**: `generatePocket(region, tool, params)` returns `moves`
   (motion on the canonical rail) *and* `target` (a declaration of what
   the op claims to machine).
2. **Job**: operations + stock + tools. The composer owns all
   program-level motion; an op's moves are mid-program.
3. **Verify**: `verifyJob` measures the motion against the declaration
   with independent geometry — gouges and depth violations are errors
   with coordinates, coverage shortfall is a warning.
4. **Post**: `.sbp` and `.nc` are written **only if the verifier says OK**.
   The sabotage at the end shows the gate slamming shut.

That fourth step is the rule of the whole platform: **nothing reaches a
spindle that didn't pass the verifier.**

## 3. Build your first app with an AI agent

This repo is written to be read by coding agents as much as by people —
[`AGENTS.md`](AGENTS.md) hands your agent the contract (module map,
operation rules, how to add a strategy, what it must never do). Claude
Code, Cursor, Copilot Workspace, etc. pick it up automatically or with
one instruction.

From the repo root, start your agent and describe the tool you actually
need in your shop. For a fully worked example — the exact prompt that
produces the [Engrave Anything](examples/engraver/) app, and why it's
only ~110 words — see
[examples/engraver/README.md](examples/engraver/README.md). More examples
of the right *shape*:

> Build me a single-page app: I pick a drawer-pull profile from three
> presets, set width and bit diameter, and it exports a verified SBP
> pocket + profile job for 3/4" hardwood.

> Build a CLI that takes a folder of DXF files and batch-generates
> verified pocket jobs with a 1/4" endmill, writing one .sbp per file
> and a summary of any that failed verification.

Two rules to hold your agent to (AGENTS.md already tells it, but you're
the shop foreman):

- **Every export goes through `verifyJob`.** If the verifier rejects the
  job, the fix is in the strategy or the parameters — never in the
  verifier.
- **Cut air first.** Loom verifies motion against declared intent; it
  does not know your machine, your fixturing, or your material. First run
  of any new program: Z zeroed high, hands on the stop.

The modules are plain ES modules with no build step — they run in Node
and in the browser unchanged, so "an app" can be one HTML file that
imports `ir/` and `strategies/` directly.

## 4. When you hit the edge

Loom won't do everything — steep-flank finishing, ramp pocket entry, and
plenty more are known gaps. When your agent (or your part) runs into one:

- **File it**: [open an issue](https://github.com/FabMo/fabmo-loom/issues)
  describing the part and the gap. Declined and unmet requests are the
  roadmap — that's how the foundation grows.
- **Or build it**: a new strategy is one file with the signature
  `(form, tool, params) → { moves, target, warnings, stats }` plus a
  gauntlet test proving it accepts clean work and rejects sabotage with
  measured numbers. See AGENTS.md for the checklist. The verifier is what
  makes a stranger's strategy — or your agent's — safe to admit.

---

*FabMo Loom — from the makers of [ShopBot](https://www.shopbottools.com).*
