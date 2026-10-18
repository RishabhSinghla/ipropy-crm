---
name: loop-review
description: After a feature-loop build, read .claude/loop/results.md, find mistakes that repeat across rounds or features, and rewrite only the "How to work" section of .claude/loop/program.md. Never edits checks.
---

# Learn from the results log

1. Read `.claude/loop/results.md` and `.claude/loop/program.md`.
2. Look for **repeats**: the same check failing in several rounds, the same kind of change
   being undone, wiring forgotten, prove-it finding what checks missed. One-offs are not habits.
3. Rewrite **only** the `## How to work` section of `program.md`: add a short line for each
   repeat ("Before touching X, do Y — undone 3 times on <date>"), drop lines that no longer
   earn their place. Keep it under ~15 lines.
4. Never edit any other section of `program.md`, any check (anything under `draft/` or
   `locked/`), or app code. If the fix a pattern needs is a better check, say so to
   Rishabh — he decides, through `build-feature`.
5. Check: `git diff -- .claude/loop/program.md` touches only lines under `## How to work`.
6. Tell Rishabh in two or three plain sentences what habit changed and why.
