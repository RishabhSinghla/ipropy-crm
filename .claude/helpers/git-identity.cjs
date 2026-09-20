#!/usr/bin/env node
/**
 * Make a commit say which developer's Claude made it.
 *
 * Two people work on this repo, each from their own Claude Code account, and
 * every session committed as `Claude <noreply@anthropic.com>` — so GitHub's
 * commit list, the deployments page and `git log` all read `claude` for both
 * of them. Nobody could tell whose change went to production, which is the
 * question you actually ask when something breaks.
 *
 * Claude Code hands every session the signed-in account's address in
 * `CLAUDE_CODE_USER_EMAIL`. That is the one thing that genuinely differs
 * between the two of them, so it is what this reads.
 *
 * It sets the identity **repo-locally** (`.git/config`, which is not
 * committed) rather than globally: this is the only repo two accounts share,
 * and a global change would follow a session into somebody else's work.
 *
 * Two things decided on purpose:
 *
 *  * **The GitHub "Verified" tick is given up, knowingly.** That badge checks
 *    the *committer* against the key that signed the commit, and these are
 *    SSH-signed by the Claude account's key. Measured both ways on
 *    20 September 2026: changing the author alone keeps `verified: true` and
 *    still links the commit to the developer's own account — but git has no
 *    `committer.name` config key, so splitting author from committer needs
 *    `GIT_COMMITTER_*` in the environment, and the shells this tool runs are
 *    non-interactive and source no profile. There is nowhere to put it that
 *    every commit would read. A name that is always right beat a tick that
 *    appears only when somebody remembers a prefix, and `main` does not
 *    require signed commits, so nothing breaks. Both, on one commit:
 *    `GIT_COMMITTER_NAME=Claude GIT_COMMITTER_EMAIL=noreply@anthropic.com git commit …`
 *  * **Nothing is guessed.** An account not in the table below still gets a
 *    distinct name, derived from its address, rather than a wrong one. A
 *    commit attributed to the wrong person is worse than one attributed to an
 *    email.
 */
const { execFileSync } = require('node:child_process');

/**
 * Who each account is, in the words a person would use.
 *
 * Add a line when somebody joins. The address is whatever their Claude account
 * signs in with, which is not necessarily their GitHub one — GitHub links the
 * avatar only when the two match, and the name reads correctly either way.
 */
const PEOPLE = {
  'rishabhsinghla2112@gmail.com': 'Rishabh Singhla',
};

/** A usable name from an address, for an account nobody has added yet. */
function nameFromEmail(email) {
  const local = String(email).split('@')[0] ?? '';
  const words = local
    .replace(/[0-9]+$/, '')
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ') || local || 'Unknown';
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

try {
  const email = process.env.CLAUDE_CODE_USER_EMAIL;
  // No account address means nothing to tell the two sessions apart, so change
  // nothing rather than stamping a commit with a name that is not anybody's.
  if (!email) process.exit(0);

  // A git repo, or there is nothing to configure.
  git(['rev-parse', '--git-dir']);

  const person = PEOPLE[email.toLowerCase()] ?? nameFromEmail(email);
  /*
    "(via Claude)" stays in the name on purpose. These commits are written by
    Claude on somebody's behalf, and a log that reads as if a person typed
    every line misleads whoever reads it next. The point is to say *whose*
    Claude, not to hide that it was one.
  */
  const authorName = `${person} (via Claude)`;

  git(['config', 'user.name', authorName]);
  git(['config', 'user.email', email]);

  console.log(
    `[identity] commits from this session are by ${authorName} <${email}>. `
    + 'Add a teammate in .claude/helpers/git-identity.cjs.',
  );
} catch (err) {
  /*
    Never block a session over a name — and never fail quietly either.
    An earlier version of this file swallowed a `ReferenceError` and exited 0,
    so it looked like it had run while every commit still said `Claude`. That
    is the exact failure this repo keeps meeting, and a hook is the easiest
    place in the world for it to hide.
  */
  console.log(`[identity] could not set the commit author (${err.message}); commits will say Claude.`);
  process.exit(0);
}
