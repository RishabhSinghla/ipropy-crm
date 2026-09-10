# Start here

This is for the person setting up iPropy CRM on a second laptop for the first time. It assumes
you are not a developer. Every technical file in this repository is written for one, so read this
one instead. The others will still be there when you need them.

The CRM is a website that runs on your own laptop while you work on it. Nothing you do here
touches the live CRM the team uses until somebody deliberately publishes it, and publishing is
Rishabh's job, not yours. So you can experiment freely.

---

## Day one, in order

### 1. Accept the GitHub invitation

Check the inbox for `ipropy@gmail.com`. There is an invitation to the `ipropy-crm` project.
Accept it. If you cannot find the mail, sign in to github.com with that account and look at
https://github.com/RishabhSinghla/ipropy-crm/invitations

### 2. Install the two apps you need

Download and install:

* Claude Code, the app you will be typing your instructions into.
* Docker Desktop, from docker.com. This runs the database. You never open it directly, it just
  needs to be installed and running.

### 3. Open the Terminal and paste one line

Press Command and Space together, type "Terminal", press Return. A window with text appears.
Paste this and press Return. It asks for your Mac password, which is normal.

```bash
xcode-select --install 2>/dev/null; /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

That installs the tools everything else needs. It takes a few minutes.

### 4. Download the project

Still in the Terminal, paste these three lines one at a time:

```bash
mkdir -p ~/Downloads/iPropy-Projects && cd ~/Downloads/iPropy-Projects
```

```bash
brew install gh && gh auth login
```

The second one asks a short set of questions. Choose GitHub.com, then HTTPS, then yes to
authenticate with your GitHub account, then "Login with a web browser". Sign in as
`ipropy@gmail.com`.

```bash
gh repo clone RishabhSinghla/ipropy-crm iPropy-crm && gh repo clone RishabhSinghla/ipropy-website ipropy-website
```

You now have both projects on your laptop. The CRM and the public website live side by side, and
the website expects to find the CRM next to it, so keep that arrangement.

### 5. Get the keys from Rishabh

The passwords and keys the CRM needs are not stored on GitHub, on purpose. Anyone who reads them
can send WhatsApp messages as the business and read the customer database, so they never go near
a place a stranger could reach.

Ask Rishabh to run this on his Mac:

```bash
bash scripts/handover-bundle.sh
```

He gets a folder called `ipropy-handover`. He AirDrops it to you. Save it on your Desktop, then
run this:

```bash
cd ~/Downloads/iPropy-Projects/iPropy-crm && bash scripts/install-handover.sh ~/Desktop/ipropy-handover
```

That folder holds live passwords. Delete it from your Desktop once the CRM is working.

### 6. Run the setup

```bash
bash scripts/setup-new-laptop.sh
```

This is the long one, ten to twenty minutes on a good connection. It installs what is missing,
starts the database, builds the app and then starts it for forty seconds to prove it works. If it
stops with a red message, read the message. It says what to do. If it still makes no sense, copy
the whole thing into Claude Code and ask what it means.

### 7. Open Claude Code on the right folder

Open Claude Code and point it at:

```
~/Downloads/iPropy-Projects
```

The outer folder, not `iPropy-crm` inside it. This matters. Claude keeps its notes about this
project in a place named after the folder you open, so opening the wrong one gives you a Claude
that knows nothing about iPropy.

To check it worked, ask it: **"what do you remember about this project?"** A correct answer
mentions specific things, the WhatsApp door, the media pipeline, the two removed property fields.
A vague answer means the notes did not install, so run `install-handover.sh` again and reopen
Claude Code.

---

## Every day after that

Two commands to start work:

```bash
cd ~/Downloads/iPropy-Projects/iPropy-crm && docker compose up -d db
```

```bash
npm run dev
```

Then open http://localhost:5173 in your browser. Log in with the email and password stored in
the `.env` file, under `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`. Ask Claude to read them out
if you cannot find them.

To stop working, press Control and C in the Terminal window. The database can be left running.

Once a day, before you start, get the latest changes:

```bash
git pull
```

---

## How to talk to Claude Code

Type what you want in ordinary words. It reads the code itself, so you do not need to know where
anything lives. These all work:

* "The phone number column is too narrow on the contacts list, make it wider."
* "Add a dropdown option called Site Visit Done to the lead stage list."
* "A lead came in from the website form and never appeared. Find out why."
* "Show me every lead assigned to nobody."
* "Run the tests and tell me if anything is broken."

Three habits worth having from the start.

**Ask it to prove things rather than describe them.** "Check it actually works" gets you a better
answer than "does it work". This project has a history of tests passing while the real thing was
broken, so the useful question is always what the running app does.

**Tell it when you do not understand.** There is a standing instruction in this project to write
in plain English with almost no technical words. If a reply is full of jargon, say so and ask
again. That is not a bother, it is the agreed way of working.

**Let it commit.** After a change works, "save this" or "commit this" writes it down properly.
Commits are the only undo in this project, so a day of unsaved work is a day you can lose.

---

## What you can do that you may not realise

Your account has the same rights on this project as Rishabh's, so a few things
that look like they need him do not.

You can run the jobs on GitHub yourself, under the Actions tab. There are 13 of
them, and they exist so that things needing production access can be done without
production access. Setting an admin password, resetting your own password, creating
an API key, checking what is live, and publishing to the live site (the one called
"Deploy now"). Ask Claude which one you want and it will tell you.

You can see and change the project's stored secrets, under Settings, then Secrets
and variables. Eight are stored. You will rarely touch them, but not being able to
would have blocked you.

Publishing to the live site is the one to be careful with rather than the one you
cannot do. See the next section.

## Optional: nightly backup of your own database

Not needed on day one. If you want the database on your laptop backed up every
night:

```bash
bash scripts/launchd/install.sh
```

It tests itself and tells you the result. On a project kept inside Downloads,
macOS blocks background jobs from reading the folder, so it will fail and explain
the two ways round it. Either way, backing up by hand always works and takes a
second:

```bash
npm run db:backup
```

This is your own laptop's copy of the data, which is demo data. The real database
is backed up separately and is not your responsibility.

## Four things not to do

**Do not publish to the live CRM.** Pushing your changes to GitHub can send them to the real site
the team is using. Ask Rishabh before you push anything. If you want to save your work without
publishing it, commit it and leave it on your laptop, or ask Claude to put it on a branch.

**Do not point this laptop at the real database.** The `.env` file describes a database on your
own machine. Changing that address to the live one means every test you run edits real customer
records. There is no undo.

**Do not share the `.env` file.** Not by email, not on WhatsApp, not into a website that offers
to check it for you. If it ever leaks, tell Rishabh the same day so the keys can be replaced.

**Do not delete things to make an error go away.** Deleting a field, a dropdown option or a
database table usually silently breaks something you will not notice for a week. That has
happened four times on this project already. Ask first.

---

## When something breaks

Almost everything is one of these four.

The page will not load, or every part of it is empty. The database is probably not running.
Run `docker compose up -d db` and try again.

It says a port is already in use. The app is already running in another Terminal window. Close
that window, or restart the Mac.

You changed something and now nothing works. `git status` shows what you changed and
`git stash` puts it all back the way it was. Ask Claude to do it if you would rather not type it.

Anything else: copy the whole error message, all of it, into Claude Code and ask what it means.
Do not summarise it first. The detail you leave out is usually the part that identifies the
problem.

---

## Where the real documentation is

You will not need these on day one, but this is what is where.

`README.md` is the overview of what the CRM does and what state it is in.

`CLAUDE.md` is the rulebook Claude reads at the start of every session. It holds the mistakes
this project has already made and must not make again. Worth skimming so you recognise the
warnings when Claude repeats one.

`PROJECT_HANDOVER.md` is the long version, every part of the system in detail.

`DEPLOYMENT.md` covers publishing to the live site. Read it before you do that, not after.

`TRAINING.md` teaches the CRM as a user rather than as a developer, screen by screen.
