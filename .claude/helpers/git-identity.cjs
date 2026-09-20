#!/usr/bin/env node
/**
 * Make a commit say which developer's Claude made it.
 *
 * Two people work on this repo, each from their own Claude Code account, and
 * every session commits as `Claude <noreply@anthropic.com>` — so GitHub's
 * commit list, the deployments page and `git log` all read `claude` for both
 * of them. Nobody can tell whose change went to production, which is the
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
 * Deliberately NOT done here:
 *
 *  * **The committer is left alone.** Git records an author and a committer
 *    separately, and GitHub's "Verified" badge is about the committer matching
 *    whatever key signed the commit. These commits are SSH-signed by the
 *    Claude account's key, so rewriting the committer would trade a readable
 *    name for an unverified commit. The author is what GitHub's list shows,
 *    which is the half that had to change. Git config cannot set the two
 *    apart, so `GIT_COMMITTER_*` is exported for the shell the session runs
 *    its commits in.
 *  * **Nothing is guessed.** An account not in the table below still gets a
 *    distinct name — derived from its address — rather than a wrong one. A
 *    commit attributed to the wrong person is worse than one attributed to an
 *    email.
 */
const { execFileSync } = require('node:child_process');

/**
 * Who each account is, in the words a person would use.
 *
 * Add a line when somebody joins. The email is whatever their Claude account
 * signs in with, which is not necessarily their GitHub address — GitHub links
 * the avatar only when the two match, and the name is readable either way.
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
  // No account address means nothing to distinguish, so change nothing rather
  // than stamping a commit with a name that is not anybody's.
  if (!email) process.exit(0);

  // A git repo, or there is nothing to configure.
  git(['rev-parse', '--git-dir']);

  const person = PEOPLE[email.toLowerCase()] ?? nameFromEmail(email);
  /*
    "(via Claude)" stays in the name on purpose. These commits are written by
    Claude on somebody's behalf, and a log that reads as if a person typed
    every line is a log that misleads the next person to read it. The point is
    to say *whose* Claude, not to hide that it was one.
  */
  const authorName = `${person} (via Claude)`;

  git(['config', 'user.name', authorName]);
  git(['config', 'user.email', email]);

  console.log(
    `[identity] commits from this session are authored by ${authorName} <${email}>. `
    + 'Edit .claude/helpers/git-identity.cjs to add a teammate.',
  );
} catch {
  // Never block a session over a name. A commit that says `Claude` is the
  // state this repo was already in, and it is not worth a failed start.
  process.exit(0);
}

