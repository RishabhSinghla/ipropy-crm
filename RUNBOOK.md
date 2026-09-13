# What to do when it breaks

This is the 9pm document. It assumes you are the only person available, you are
not at a desk, and you want the shortest safe path back to working.

Written for the owner, not for an engineer. Every command here can be run from a
phone through the GitHub website (**Actions** tab → pick the workflow → **Run
workflow**) unless it says otherwise.

**The one rule:** find out what is actually broken before changing anything. Most
"the CRM is down" reports are one screen, one user, or a browser cache. Changing
production to fix a problem you have not identified is how a small incident
becomes a long one.

---

## 0. Thirty seconds: is it actually down?

Open this on your phone:

**https://crm.ipropy.com/api/health**

| What you see | What it means |
|---|---|
| `{"status":"ok","database":"connected",...}` | **The CRM is up.** The problem is one screen, one account, or their internet. Go to §4. |
| Takes 30–60s then loads | Normal if nobody has used it for a while. Not an incident. |
| Anything else, or nothing | It is genuinely down. Go to §1. |

Also check **github.com/RishabhSinghla/ipropy-crm/issues**. A health check runs
every two hours and **opens an issue by itself when the site is unreachable, and
closes it when the site comes back**. That issue list is your incident log — if
there is no open issue, the site was up at the last check.

---

## 1. It is genuinely down

### First, ask: did something just change?

Look at **Actions** → the most recent run, and Render's deploys page. If a deploy
finished in the last hour, that is your first suspect.

### If a deploy caused it — roll back

Two ways, in order of preference:

1. **Render dashboard → the service → Deploys → find the last deploy that
   worked → "Redeploy".** This is the fastest and changes nothing in the code.
2. **Undo the change in the repo.** On your laptop:
   ```bash
   git revert <the bad commit> && git push
   ```
   This goes through the normal gate — tests must pass, then it deploys. Slower
   (~15 minutes) but leaves an honest history.

**Do not** force-push, and do not delete the bad commit. Reverting keeps the
record of what happened.

### If no deploy happened

Then it is the host or the database, and neither is something you fix from the
repo.

- **Render status:** status.render.com
- **Neon status** (the database): neonstatus.com

If both are green and the site is still down, open Render's **Logs** tab and read
the newest lines. You are looking for the word `error` near the bottom.

### Prove it is actually back

Do not trust one page load. Run **Actions → "Prove the CRM answers" → Run
workflow**. It signs in, reads a list, opens a record, and times each one. Green
means the site works, not just that it responds.

---

## 2. Something is wrong with the data

**STOP — do not restore a backup to fix one broken record.** A restore replaces
*everything* and throws away every change made since last night, including all
the work the team did today. It is almost never the right answer.

| Situation | Do this |
|---|---|
| One record looks wrong | Open it, use the record's own history/timeline to see who changed what. Fix it by hand. |
| Someone deleted a record | Deleted records are hidden, not destroyed. Admin → System & Audit can restore them. |
| A field disappeared for everyone | This is a metadata change, not lost data. Admin → Fields — the field is probably switched off, not gone. |
| Genuinely lost data, many records | Only then consider a restore. Read §3 first, and do it in the morning with a clear head unless the business is stopped. |

**Who changed what** is answerable: every write is recorded in the audit trail,
including whether it came from a person, the phone app, or an AI assistant.

---

## 3. Restoring from backup — read before you do it

**What you have:** a full database backup taken every night, uploaded to
Cloudflare R2. The backup job **restores each dump into a scratch database to
prove it works** before uploading it, so these are tested backups, not hopeful
ones. Four consecutive nights succeeded as of 13 September 2026.

**What you do not have:** point-in-time restore. A restore gets you back to *last
night*, not to *ten minutes ago*. Everything the team did today would be lost.
(Neon's paid plan adds proper point-in-time restore. That is the upgrade that
makes this section much less frightening, and it is not bought yet.)

**Because of that, a restore is a business decision, not a technical one.** The
question is not "can we restore" but "is losing today's work better than the
state we are in".

If the answer is yes, this is the one job to **do from a laptop, not a phone**,
and it is worth waking someone up for. The script is `npm run db:restore`, and
`DEPLOYMENT.md` §7 has the full sequence.

---

## 4. It is up, but something specific is broken

| Symptom | Likely cause | What to do |
|---|---|---|
| One person cannot sign in | Their password, or their account was switched off | **Actions → "Set admin password"**, or Admin → Users |
| Photos are not being processed | Your Mac is off, or Docker is not running | Start Docker Desktop, then `bash scripts/automation-up.sh`. Nothing is lost — the queue waits. |
| AI features return nothing | A provider key expired or ran out | Admin → Integrations → the provider card → **Test connection**. It repeats the provider's own error message, which usually names the problem. |
| WhatsApp messages not sending | Expected — messages queue for one-tap sending | Not an incident |
| A number is not searchable | The search index for that record | Not urgent; it will reindex |
| The public website shows nothing | Properties are unpublished, or their status is not a public one | Check one property's **Show on Website** switch |

**Errors you cannot see from the outside** land in Sentry. If something is
misbehaving and nothing above explains it, Sentry has the stack trace and the
time it started.

---

## 5. A credential leaked

Move fast, in this order:

1. **Actions → "Revoke API key"** — kills the key immediately.
2. **Actions → "Rotate API key"** — issues a replacement. The new key is generated
   on the machine that will hold it; only its hash reaches GitHub.
3. If it was the n8n callback secret: **Actions → "Set n8n config"**, then
   restart both containers (`bash scripts/automation-up.sh`) and then the CRM
   (**Actions → "Deploy now"**), because the CRM caches integration settings at
   boot.

**Never** paste the real key into an issue, a commit, a chat, or a workflow log —
this repository is public, and its Actions logs are public with it. That has
happened once already.

---

## 6. What this runbook does not cover, honestly

These are real gaps. None of them is an emergency today; all of them make a bad
night worse.

- **There is one of you.** No rotation, no second pair of eyes at 2am. The health
  check opens an issue; nothing wakes anybody up.
- **No status page.** When it is down, customers find out by trying. A one-line
  page you can update by hand would remove most of the panic calls.
- **No staging environment.** Every change is proved against a laptop or against
  production, with nothing in between.
- **Restore loses a day.** See §3.
- **Parts of the system run on your laptop** — the photo pipeline. If the laptop
  is off, that pipeline is off, and nothing tells you.

---

## The numbers, in one place

| | |
|---|---|
| Site | https://crm.ipropy.com |
| Health | https://crm.ipropy.com/api/health |
| Incident log | the repo's **Issues** tab (opened and closed automatically) |
| Errors | Sentry |
| Host | Render — status.render.com |
| Database | Neon — neonstatus.com |
| Backups | Cloudflare R2, nightly, restore-tested |
| Deploy gate | tests must pass before `main` moves or anything reaches the site |
