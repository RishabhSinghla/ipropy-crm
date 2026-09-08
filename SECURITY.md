# Security policy

## Reporting a vulnerability

This repository is private and the product is run as a private CRM for a
single broker team, so there is no public disclosure programme.

If you find something that looks like a security problem — an auth bypass, a
permission scoping hole, a data exposure, a weaknesses in how user input is
handled, or a misconfigured secret — report it privately instead of
discussing it in an issue or PR:

1. **Do not open a public issue** or send the details to a channel the
   reporter's team shares.
2. Send a note to the repository owner through the GitHub UI (Settings →
   Collaborators, or a private message), or through any private channel you
   already have with the owner.
3. Include **what** is affected, **how** it can be triggered, and (if you
   have one) a minimal reproduction. You do not need to include a patch.

## How reports are handled

- The owner triages within a few days.
- Authorisation fixes — anything that lets a user see or change a record
  they are not allowed to - get priority over everything else.
- You will be told when a fix ships. There is no embargo schedule; this is a
  single-owner private project.

## Hardening facts worth knowing

- Deployments are gated: `render.yaml` uses `autoDeployTrigger: checksPass`,
  so main only deploys after CI passes.
- AI-written pull requests are merged only when every CI check is green and
  the diff touches nothing in `.env*`, `.github/workflows/*`, `render.yaml`,
  `Dockerfile`, `docker-compose.yml` or anything matching `secrets?.`
  (`packages/server/src/core/feedback/mergeGate.ts`).
- Secrets live in GitHub's encrypted secrets and in the CRM's sealed
  integration rows; the AI engineer works on its own branch and never pushes
  to main.