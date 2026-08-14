# Talking to iPropy from Claude or ChatGPT

This turns the CRM into something an assistant can use. Instead of opening
iPropy, finding a list and applying a filter, you ask:

> Who was looking for a 3 BHK in Powai under two crore?
>
> A walk-in just came in — Rahul Verma, 9876543210, wants a 3 BHK around 1.8
> crore in Powai. Add him.
>
> We just listed Greenfield B-110 at 2.15 crore. Who should I call?

## Set it up (5 minutes)

**1. Make a key.** In the CRM: **Settings → Security → Connected apps**. Give it
a name you will recognise later ("Claude on my laptop"), press **Create key**,
and copy it. It is shown once and never again — if you lose it, revoke it and
make another.

**2. Point the assistant at it.**

In **Claude Code**, from anywhere:

```bash
claude mcp add ipropy --env IPROPY_URL=https://ipropy-crm.onrender.com --env IPROPY_API_KEY=ipy_your_key_here -- node /absolute/path/to/iPropy-crm/packages/mcp/dist/index.js
```

In **Claude Desktop**, edit `claude_desktop_config.json`
(Settings → Developer → Edit Config) and add:

```json
{
  "mcpServers": {
    "ipropy": {
      "command": "node",
      "args": ["/absolute/path/to/iPropy-crm/packages/mcp/dist/index.js"],
      "env": {
        "IPROPY_URL": "https://ipropy-crm.onrender.com",
        "IPROPY_API_KEY": "ipy_your_key_here"
      }
    }
  }
}
```

Build it once first, with `npm run build -w @ipropy/mcp`.

### Or connect over the network, with nothing installed

The CRM serves the same tools at `/api/mcp`, so a client that can set a header
needs no local install at all:

```bash
claude mcp add --transport http ipropy https://ipropy-crm.onrender.com/api/mcp --header "x-api-key: ipy_your_key_here"
```

Add `--header "x-ipropy-write: allow"` when you want it to be able to change
things. Same tools, same limits, same key.

One-click connectors inside the Claude and ChatGPT **apps** need OAuth sign-in,
which this endpoint does not do yet — that is the remaining piece, and it only
matters once the team has paid accounts on one of them.

**3. Check it worked.** Ask the assistant "what can you do with iPropy?" — it
should list the tools below. If something is wrong it says so in plain English
on startup, naming the problem.

## It starts read-only

By default nothing can be changed. That is deliberate: the first time you point
an assistant at real customer records, it should not be able to write to them
while you are still finding out how it behaves.

When you are ready, add `"IPROPY_READ_ONLY": "false"` to the `env` block. The
three writing tools then appear.

## What it can do

**Reading** — `find_leads`, `get_lead`, `find_properties`, `get_property`,
`match_buyers_for_property`, `match_properties_for_lead`, `todays_follow_ups`.

**Writing**, once enabled — `create_lead`, `update_lead`, `add_note`.

## What it cannot do

- **See anything you cannot see.** It signs in as you. A junior's key shows a
  junior's leads. This is not re-implemented here — every call goes through the
  CRM's own API, so it is the same permission check the web app uses.
- **Delete anything.** No tool offers it, and the server refuses deletes from an
  API key regardless of who owns it.
- **Administer the CRM.** No users, no permissions, no changing fields.

Everything it writes is recorded in the audit trail as coming from `api_key`,
so "who changed this?" can tell a person clicking in the CRM apart from an
assistant acting with their key.

## When something goes wrong

The server reports problems in words rather than status codes, and the
assistant will relay them. "The CRM rejected the API key" means make a new one.
"Your CRM account is not allowed to do that" means exactly what it says — the
connection has your permissions, so ask an administrator rather than debugging
the connection.

If the CRM is on Render's free plan it sleeps when idle, and the first call
after a quiet spell can take twenty seconds. The server waits up to 20s before
giving up.
