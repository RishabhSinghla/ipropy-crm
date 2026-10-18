---
name: build-feature
description: Build one CRM feature "checks first". Writes the checks, explains each in plain words, STOPS for Rishabh's approval, locks them, then hands the build to the feature-builder agent. Use when Rishabh asks for a new feature or behaviour change through the loop.
---

# Build a feature, checks first

Read `.claude/loop/program.md` first. It is the rulebook; this is the procedure.

## 1 · Write the checks (no app code yet)

Pick a short kebab-case name for the feature (`<feature>`). Write the checks into a
**draft** folder next to where each runner already looks, so they run with the normal commands:

| Kind | Draft folder | Runs with |
|---|---|---|
| server logic | `packages/server/tests/draft/<feature>/*.test.ts` | `npm test` |
| API + database | `packages/server/tests/integration/draft/<feature>/*.test.ts` | `npm run test:integration` |
| web logic | `packages/web/tests/draft/<feature>/*.test.ts` | `npm test` |
| what a person clicks | `e2e/draft/<feature>/*.spec.ts` | `npm run test:e2e` |

Use only the kinds that fit. If the feature has a screen, at least one e2e check must
**reach it by clicking from the normal app** (not `page.goto` to its URL) — that is what
catches "built but never wired in". Follow the e2e rule: create your own records with unique
markers, never assert on counts already in the database.

Run them once and confirm they **fail** for the right reason (the feature is missing, not a typo).

## 2 · Explain and STOP

Show Rishabh a numbered list: one plain sentence per check saying what it proves
("A lead with no phone number can still be saved"). Then stop and ask for approval.
**Do not continue without his yes.** Changes he asks for go back to step 1.

## 3 · Lock

After the yes: `git mv` each draft folder to the sibling `locked/<feature>/` folder
(same depth, so imports still work), then
`git commit -m "Lock checks for <feature>"`. Note the commit hash — it is the lock commit.
From here the `locked/` folders are refused to Edit and Write by `.claude/settings.json`.

## 4 · Build

Launch the `feature-builder` agent with: the feature in plain words, the lock commit,
the list of locked check files, and the round limit (default 8).

## 5 · Verify the builder, not its report

* `git diff <lock commit> -- '*/locked/*'` must be empty. If not: the build is void — undo it.
* Run the locked checks yourself, plus `npm run typecheck` and `npm test`.
* Read its prove-it results (pass / fail / couldn't tell).
* Confirm `.claude/loop/results.md` has a block for every round.

Then run the `loop-review` skill and tell Rishabh, in plain words, what works, what
couldn't be told, and that nothing is pushed until he says so.
