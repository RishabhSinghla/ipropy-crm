# The Report-a-Problem Pipeline — Owner's Runbook

This is the system that lets Papa report a problem in his own words (Hinglish,
screenshot, voice) from inside the CRM, and have it investigated, fixed, tested,
merged and deployed without anyone acting as the translator.

It is live when these five things are true:

1. The CRM is deployed with the `feedback` routes (migration `110` applied).
2. The `github_agent` integration card (Admin → Integrations) holds a GitHub
   PAT with `repo` scope, `config.repo` = `RishabhSinghla/ipropy-crm`,
   `autoMerge` = `true`.
3. The repo secrets `TOKENROUTER_API_KEY` and `AGENT_GITHUB_TOKEN` are set
   (both done 7 Sep 2026).
4. The `ai-fix` label exists on the repo (done 7 Sep 2026).
5. The scheduler runs (`ENABLE_SCHEDULER=true` — already true on Render).

## How it flows

```
Papa (any page) → 🐞 Report → text + optional screenshots + optional voice
   → POST /api/feedback          (screenshots stored, vision model describes them)
   → GitHub issue with label ai-fix
   → AI Engineer workflow (scripts/agent/run-agent.mjs)
        investigates repo → edits → typecheck + unit tests → PR (ai/<issue>-<rand>)
   → CI runs on the PR (3 jobs: verify, docker, e2e)
   → scheduler polls the issue timeline (every minute)
        PR found → status "reviewing"
        all checks green + safe diff → MERGE (squash)
   → Render auto-deploys main (checksPass)
   → Papa gets a notification: "Aapki report ka fix ready hai"
   → Papa opens /feedback: "Ho gaya, shaandaar!" or "Abhi theek nahi hai" (+ why)
        theek nahi → issue reopens + agent re-runs with the follow-up
```

## What Papa sees (all Hinglish, zero jargon)

- `🐞 Report` button in the top bar on every page.
- Three buttons: "Kuch galat hai" / "Naya chahiye" / "Samajh nahi aaya".
- Voice: the mic button uses the browser's speech recognition (Hindi). Works in
  Chrome/Edge on desktop and Android Chrome. Hidden where unsupported.
- Screenshot: paste with Ctrl/Cmd+V, or "Photo chunein".
- "Meri Reports" page (also in the mobile drawer under Tools) shows each report
  with its story: submitted → AI samajh raha hai → AI kaam kar raha hai →
  tests → ho gaya, check karein! → done.

## When something breaks

- **No issue appears on GitHub after a report:** check Admin → Integrations →
  GitHub card is active, and `Render logs` for `feedback pipeline failed`.
- **The agent run fails or gives up:** the workflow comments on the issue with
  the error and a ⚠️. Type `ai: go` as a new comment on the issue to retry.
- **PR stays open forever:** check the PR's checks on GitHub. A red check is a
  real failure — the agent will not be auto-merged. Comment `ai: go` after
  fixing, or look yourself.
- **Everything merged but the fix is not live:** check the Render deploy of the
  merge commit (`gh api repos/RishabhSinghla/ipropy-crm/deployments`).
- **Turn off auto-merge:** set `autoMerge` = `false` on the GitHub card. Every
  PR then waits for a manual merge; nothing else changes.

## Switching the AI engineer's model — Admin panel, no redeploys

Admin → Integrations → **GitHub (AI engineering)** card:

- **AI Base URL** — any OpenAI-compatible provider:
  - `https://api.tokenrouter.com/v1` (GLM, free)
  - `https://openrouter.ai/api/v1` (Claude, Gemini, Qwen, DeepSeek — one key,
    hundreds of models; recommended)
  - `https://api.groq.com/openai/v1` (fastest cheap lane)
  - `https://api.deepseek.com/v1` · `https://api.anthropic.com/v1` needs the
    Anthropic shape, so prefer it through OpenRouter.
- **AI Model** — the provider's model id, e.g. `anthropic/claude-sonnet-4.5`
  (OpenRouter), `z-ai/glm-5.3` (TokenRouter paid), `deepseek/deepseek-v4-pro`.
- **AI API Key** (secret) — stored sealed in the CRM; also paste the same key
  once as the repo secret `AGENT_AI_API_KEY` (Settings → Secrets → Actions),
  which is what the workflow actually runs with.

Saving the card pushes Base URL + Model to GitHub repo *variables*
automatically. The key is the one manual step (repo secrets need GitHub's
encryption; the card keeps its own sealed copy as the record of what's set).

**About subscriptions:** Claude Pro/Max, Codex and z.ai subscriptions do not
expose API keys — they work inside their own apps only. To use those models
here, buy pay-as-you-go API credit from any provider (OpenRouter gives every
major model behind one key) and put that key on the card. The model changes
anytime; the pipeline code never does.

## Costs

- TokenRouter GLM: free tier, 8 req/min. The agent throttles itself to 7/min
  and backs off 65s on a 429. One ticket ≈ 15-40 model calls ≈ ₹0.
- GitHub Actions: the AI Engineer run costs roughly 10-15 min per ticket on
  the free 2,000 min/month. Watch `gh run list` if Papa gets enthusiastic.
- Vision (screenshot descriptions): uses the CRM's configured OpenRouter key —
  the same models that read documents. Fractions of a rupee per screenshot.

## The model is the ceiling — measured 8 Sep 2026

Everything around the model is proven live: reports file issues, the agent
triggers, investigates for 45 turns, the transport survives 429s, 503s,
length-truncations and 8-minute-long responses. But **`z-ai/glm-5.3-free` at
depth is ~8 minutes per turn** on long investigations, so a real ticket needs
200+ minutes — far past the workflow's 90-minute job ceiling. Seven live runs
all investigated well and never committed an edit.

**The one-click fix:** set the repo variable `TOKENROUTER_MODEL` to any paid
model the account can reach (`z-ai/glm-5.3` is the same brain, paid lane):

```bash
gh variable set TOKENROUTER_MODEL --repo RishabhSinghla/ipropy-crm --body "z-ai/glm-5.3"
```

The account had $0.00 credit on 7 Sep (measured — every non-`:free` model
answers `insufficient_user_quota`), so it needs a top-up first. No code
changes; the pipeline picks the variable up on the next ticket automatically.

Until then, Papa's reports still: file themselves, get triaged, appear on
GitHub with full context, and stay queued. `ai: go` on an issue retries the
agent any time. And you can always fix a ticket yourself — the report row
links straight to its issue and PR.

## The safety rails (why this cannot burn the house down)

- The agent never pushes to `main`. It works on its own branch.
- The CRM only auto-merges when **every** CI check is green **and** the diff
  touches nothing on: `.env*`, `.github/workflows/*`, `render.yaml`,
  `Dockerfile`, `docker-compose.yml`, anything matching `secrets?.`.
  (`packages/server/tests/feedbackMergeGate.test.ts` pins this list.)
- Issue text is fenced as untrusted data in the agent's prompt, the same way
  the CRM fences customer text in its own AI features.
- Papa's GitHub never happens: he only sees the CRM. The PAT lives sealed in
  the CRM's integration row; the repo secret lives in GitHub's vault.
- `SEED_DEMO_DATA=false`, `JWT_SECRET` and every production guard from
  `config.ts` still apply to deploys as always.
