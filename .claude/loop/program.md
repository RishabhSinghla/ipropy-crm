# The feature loop — program

Checks first, then build. Rishabh approves what "done" means before any code is
written, and nobody can quietly move the goalposts afterwards.

## Rules that never change

* **The locked checks are the judge, and the judge is never touched.** Anything under a
  `locked/` folder (`packages/server/tests/locked/`, `packages/server/tests/integration/locked/`,
  `packages/web/tests/locked/`, `e2e/locked/`) is refused to Edit and Write in
  `.claude/settings.json`. After every build, `git diff <lock commit> -- '*/locked/*'` must be empty,
  or the whole build is thrown away.
* **Passing checks are not a working feature.** The builder wires the feature into the real
  app in the same round, and finishes with the `prove-it` skill: pass, fail or couldn't tell.
* **Every round is written down** in `.claude/loop/results.md` — what was tried, kept or
  undone, which checks failed.
* **Only `## How to work` below may be rewritten**, and only by the `loop-review` skill.
* Nothing is pushed or merged without Rishabh's yes.

## How to work

<!-- loop-review rewrites this section only, from patterns in results.md. -->
* Read `CLAUDE.md` and the area's own `.md` before the first round.
* One small change per round. Run the locked checks after each one.
* Keep a round only if more locked checks pass than before and nothing that passed now fails.
  Otherwise undo just the files you touched (`git restore -- <files>`).
* Wire the screen into the place a person would actually look for it before calling a round done.
