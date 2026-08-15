# iPropy CRM — The Complete Training Manual

**Written in plain language. No jargon. Read top to bottom once, then use it as a lookup.**

Every word here describes what is actually built in this repository as of 10 August 2026 — not
what is planned. Where something is half-built or blocked, it says so plainly.

---

## How to read this

There are 18 parts. Parts 1–4 are the *ideas*. Parts 5–13 are the *screens and features*.
Parts 14–18 are the *backstage, the honest gaps, and the cheat sheets*.

If you only ever read three parts, read **Part 2 (the Lego idea)**, **Part 4 (who sees what)**, and
**Part 17 (everyday recipes)**. Those three carry most of the understanding.

---

# PART 1 — What this thing even is

## 1.1 What is a CRM?

Imagine you sell flats. Every day people phone you, WhatsApp you, fill a form on your website, or
walk into your site office. Each one of those people is a possible buyer.

If you keep them in your head, you forget. If you keep them in a notebook, you lose it. If you keep
them in Excel, two people edit two copies and now you have two truths.

A **CRM** (Customer Relationship Management system) is a shared notebook that:

- remembers **every person** who ever contacted you,
- remembers **everything that ever happened** with them (calls, messages, notes, site visits),
- **reminds you** to call them back,
- and **tells your boss** how the whole team is doing — without anyone writing a report.

That's it. A CRM is a memory, a reminder, and a scoreboard.

## 1.2 What is *iPropy* specifically?

iPropy is a CRM built from scratch for **Indian real estate** — for builders and brokers selling
flats, builder floors and plots. It speaks the language of that business natively:

- Money in **lakhs and crores** (`₹1.45 Cr`), not millions.
- **Carpet area vs built-up vs super built-up** — three different real numbers, not one "size".
- **RERA**, **Vastu**, **PLC charges**, **floor rise**, **token → agreement → registration →
  possession**, **channel partners**.
- Phone numbers that are ten digits with a `+91`, but that also handle NRI buyers in Dubai.

The brand line is **"Builder Floor = IPROPY"**, and the business is based in Greenfield, Faridabad
(Delhi NCR).

## 1.3 What makes it unusual

Three things, and they're the whole personality of this product:

1. **You can rebuild the CRM from inside the CRM.** Add a field, add a whole new module, rename
   things, change who sees what — all from the Admin screen, while it's running. No programmer,
   no waiting. (Part 2 explains how.)

2. **The AI never breaks.** Every smart feature has a boring backup. If the AI is switched off or
   the internet is down, the lead still gets a score, the buyer still gets matched to units, the
   lead still gets assigned. You just lose the pretty English sentences. Nothing ever shows an
   error because AI wasn't available.

3. **It got smaller on purpose.** It started with 13 modules. It now has 2. Eleven were deleted
   because each of them existed only to hold one fact that the lead or the flat could hold itself
   — which meant a salesperson had to create a *second record* just to write down one thing. That
   was a tax on the busiest person in the building. (Part 3.4 tells the full story.)

## 1.4 The parts of the system, as a picture

```
                     ┌──────────────────────────────┐
   Your phone /      │   THE WEB APP (what you see) │   React
   Your laptop ─────▶│   Dashboard, Leads, Inbox…   │   runs in the browser
                     └──────────────┬───────────────┘
                                    │  asks for things
                     ┌──────────────▼───────────────┐
                     │   THE SERVER (the brain)     │   Node + Express
                     │   rules, permissions, AI,    │   runs on a computer
                     │   workflows, integrations    │   in a data centre
                     └──────────────┬───────────────┘
                                    │  reads / writes
                     ┌──────────────▼───────────────┐
                     │   THE DATABASE (the memory)  │   PostgreSQL
                     │   every lead, flat, message  │   ~91 tables
                     └──────────────────────────────┘

   Plus three satellites:
     • The public website  (Next.js, separate repo — shows your flats to the world)
     • The Android app     (syncs calls from your salespeople's own phones)
     • WhatsApp / phone / email / portals  (the outside world coming in)
```

The code lives in three folders, called **packages**:

| Folder | What lives there | Think of it as |
|---|---|---|
| `packages/shared` | Words both sides must agree on: the 32 field types, the filter language, how to print `₹1.45 Cr` | The dictionary |
| `packages/server` | Rules, database, permissions, AI, workflows, integrations | The brain |
| `packages/web` | Every screen you click | The face |

---

# PART 2 — The one big idea: the CRM is Lego, not concrete

**This is the most important part of the manual.** If you understand this, everything else follows.

## 2.1 How normal software works (concrete)

In most software, a "Lead" has a fixed shape decided by a programmer. It has a name, a phone, a
budget — because someone typed those into the code.

If you want to add "Which broker referred them?", you must:

1. Ask a programmer.
2. They change the code.
3. They change the database.
4. They test it.
5. They deploy it (the app goes down for a minute).
6. Two weeks later, you have your field.

That's concrete. Once poured, changing it means a hammer drill.

## 2.2 How iPropy works (Lego)

In iPropy, **the shape of a Lead is itself just data sitting in the database.**

There is a table called `ipy_field`. It has one row per field. One of those rows literally says:

> "There is a field called `budget_max`. Its label is **Budget (Max)**. Its type is **money**. It
> belongs to the block called **Requirement**. It shows on the quick-create form."

When you open a Lead, the app *reads those rows* and builds the form on the spot. Nothing about
"Budget (Max)" is written in the code. It's furniture, and you can move it.

So when you add a new field in Admin, all that happens is: **one new row appears in `ipy_field`**.
The next time anyone loads the screen, the field is there. For everyone. Instantly. No deploy.

## 2.3 The four Lego bricks

```
ipy_module   ──<   ipy_block   ──<   ipy_field
(a thing you       (a section          (one question
 store, e.g.        on the form,        you ask, e.g.
 "Leads")           e.g. "KYC")         "PAN number")

ipy_record  ──  ipy_e_leads / ipy_e_properties                 
(the shared        (the actual answers for each module)
 identity of
 every single
 record)
```

- **Module** = a *type* of thing. Leads, Properties.
- **Block** = a *group of fields* on a form. "Basic Information", "Requirement", "KYC".
- **Field** = *one question*. "Mobile", "Budget (Max)", "Vastu Compliant".
- **Record** = *one actual thing*. Ravi Kumar the lead. Tower A–1204 the flat.

## 2.4 `ipy_record` — the shared ID card (subtle but important)

Every record in the whole system — every lead, every flat — gets a row in **one
single table** called `ipy_record`. That row holds the things that are true of *everything*:

- who owns it,
- when it was made and by whom,
- whether it's deleted,
- its comments, its tags, its files, its search text.

Then a *second* table (`ipy_e_leads`, `ipy_e_properties`…) holds the answers that only make sense
for that type.

**Why this matters, in one sentence:** because every link in the system points at `ipy_record`
rather than at a specific table, a record can be *moved between modules without breaking a single
link*. That's how the old Contacts module was folded into Leads without losing a single call log
or file. It just changed which module its ID pointed at.

## 2.5 Two homes for a field (and why adding one is instant)

Every field lives in one of two places:

| Storage | Where it actually sits | Speed | Who gets this |
|---|---|---|---|
| `column` | A real, named column in the table | Fastest — real database index | The 160 built-in fields |
| `json` | A key inside a `custom_fields` bag on the same row | Slightly slower, still fully searchable | Every field an admin adds |

Because new fields go into the **bag**, adding one does **not** change the database's structure.
That's the trick. That's why it takes zero seconds and needs no programmer.

And here's the payoff: **a field you added yesterday behaves exactly like one built in a year ago.**
You can filter on it, sort by it, put it in a report, use it in a workflow, show it on the kanban
card. The part of the code that builds database questions knows how to reach into the bag, so
nothing downstream can tell the difference.

## 2.6 One filter language, two engines

You will build conditions in several places: saved views, workflow rules, report filters, "only
show this field when…".

They all use **the same grammar**: a group of conditions, joined by AND or OR, and groups can nest
inside groups.

```
Match ALL of:
   Pipeline Status  is one of   [Qualified, Negotiation]
   AND  Match ANY of:
          Budget (Max)      is at least   ₹1 Cr
          OR  AI Score      is at least   80
```

That exact shape is understood by two different engines:

- one turns it into a **database question** (for lists, dashboards, reports),
- one checks it **in memory, one record at a time** (for workflows and "show this field when…").

**Why you should care:** a condition you build once *means the same thing everywhere*. There is no
"but the workflow interprets it differently" surprise.

---

# PART 3 — The three things iPropy stores

## 3.1 Leads & Contacts — *the person* (the core module)

**This is the heart of the CRM. It cannot be switched off.**

The single biggest design decision: **there is no separate "Contacts" module.** In most CRMs, a
person starts as a Lead, and when they buy, you "convert" them — which secretly creates a *second*
record, a Contact. Now their story is split in half. Calls from before the sale are on one record;
calls after are on another.

iPropy refuses to do that. One person = **one record, forever**. What changes is a field on that
record called **Lifecycle Stage**:

```
   Lead  ──▶  Prospect  ──▶  Customer  ──▶  Past Customer
 (enquired)  (serious,      (bought)      (might buy
              visited)                     again)
```

Converting someone doesn't copy them anywhere. It just **moves the stage forward on the same
record**. Every call, every WhatsApp, every note, every file from day one stays on one ID for the
entire relationship. That is a genuinely big deal for a business where a happy buyer refers three
more.

### The two "status" fields — don't mix them up

This confuses everyone once, so learn it now:

| Field | Question it answers | Values |
|---|---|---|
| **Lifecycle Stage** | *How far into the relationship are we?* | Lead → Prospect → Customer → Past Customer |
| **Pipeline Status** | *What is the next step in the sale right now?* | New, Attempted Contact, Contacted, Qualified, Site Visit Scheduled, Site Visit Done, Negotiation, Converted, Junk, Lost |

Lifecycle is the **long arc**. Pipeline is **this week's job**. The kanban board on the Leads
screen groups by Pipeline Status.

### What a Lead record holds

The form is organised into ten sections (blocks). Sections marked *(collapsed)* start folded up so
the form isn't a wall of boxes.

**Basic Information** — Record # (auto, like `LD-00174`), Full Name, Country Code, Mobile, Email,
Secondary Email, Alternate Phone, WhatsApp Number, Lifecycle Stage, Pipeline Status, Type, Rating,
Assigned To, Company, Designation.

> Two deliberate choices here.
> **One name field, not first + last.** On an Indian property desk half the enquiries arrive as one
> word and half as three. Splitting it doubled the typing on the busiest form in the building for
> no payoff.
> **Country code is stored separately, but isn't its own form row.** It's the little dropdown
> welded to the left of the mobile number. It has to be stored separately, because a silent `+91`
> sends an NRI buyer's WhatsApp to a total stranger in India. The number of digits expected changes
> with the country: 10 for India, 9 for UAE, 8 for Qatar, and so on.

**Requirement** — Interested In (free text, e.g. "Greenfield Colony Phase 2"), Property Type,
Configuration (2BHK / 3BHK…, multi-select), Purpose, Budget Min, Budget Max, Budget Band,
Preferred Locations, **Area** with its unit beside it, Possession Timeline, Funding Type,
Loan Required.

> **Area used to be two fields** — Carpet Area (Min) and (Max). It's now one, with a unit dropdown
> (Sq.ft. / Sq.yd.) rendered inside the box. A buyer says "about 1200 sq.ft", not "between 1100 and
> 1300 carpet". Two fields were collecting one answer, and neither of them carried the unit.

**Source & Attribution** — Lead Source, Sub Source, Referred By, UTM Source / Medium /
Campaign / Term / Content, Landing Page, Google Click ID, Facebook Click ID, IP Address.
(This is how you eventually know which ad actually sold a flat.)

**AI Qualification** — AI Score (0–100), AI Grade (A/B/C/D, read-only), Score Drivers (the reasons,
read-only), Last Scored, Qualification Notes.

**Follow Up** — Next Follow-up **(a date, not a time)**, Last Contacted (read-only),
Contact Attempts (read-only), First Response in seconds (read-only).

> Follow-ups are *dates*, deliberately. On a property desk you plan to chase someone on *a day*.
> The clock time was noise to dismiss on every edit, and a stray "05:48 pm" read like a
> commitment nobody had made.

**Personal Details** *(collapsed)* — Date of Birth, Anniversary, Gender, Occupation, Annual Income,
Nationality, NRI, Preferred Language, Preferred Contact Method, Photo.

**KYC** *(collapsed)* — KYC Status, PAN, Aadhaar (masked — store only the last 4 digits),
Passport Number.

**Communication Preferences** *(collapsed)* — Do Not Call, Do Not WhatsApp, Email Opt Out.
These are honoured by the system, not just recorded. (See Part 10.3.)

**Relationship Value** *(collapsed)* — Engagement Score, Lifetime Value, Converted, Converted On,
Lost Reason, Junk Reason.

**More Information** *(collapsed)* — Address, Detailed Requirement (free-form, filled by the AI
assistant), Notes.

### Ready-made views on Leads

These come pre-built as tabs above the list — you don't have to make them:

All Records · Open Leads · Customers · My Open Leads · Hot Leads (score ≥ 70) ·
Today's Follow-ups · Overdue Follow-ups · Uncontacted (24h+) · **Pipeline** (the kanban board).

## 3.2 Properties — *the flat*

One record = **one sellable unit**. Not a building, not a project — one flat, one floor, one plot.

**Property Information** — Property Code (auto, `UNIT-…`), Unit Name (e.g. "Tower A — 1204"),
**Project** (plain text — see below), Status, Property Type, Configuration, Assigned To.

**Unit Details** — Tower / Block, Wing, Floor, Unit Number, Facing, View, Corner Unit,
Vastu Compliant, Bedrooms, Bathrooms, Balconies, Parking Slots, Furnishing.

**Areas** — Carpet Area, Built-up Area, Super Built-up Area, Plot Area, Balcony Area,
Terrace Area, Area Unit.

**Pricing** — Base Price, Rate per sq.ft, Floor Rise Charge, PLC Charge, Parking Charge,
Club Membership, Maintenance Deposit, Other Charges, GST %, Stamp Duty %, Registration Charge,
and **All-inclusive Price** — which is a **formula field**. You never type it. It adds up
everything above, automatically, every time anything changes.

**Rental / Lease** *(collapsed)* — Monthly Rent, Security Deposit, Monthly Maintenance.

**Availability** — Possession Status, Possession Date, **Blocked Until**, **Blocked By**,
**Blocked For** (which lead), Resale Unit, Age (years), Owner (Resale).

> The blocking mechanism is a real business rule. A salesperson can hold a unit for a buyer for a
> few days. A background job (Part 9.5) checks daily and **automatically releases units whose hold
> has expired**, then tells the rep. That's how you stop your best unit being "reserved" for a
> buyer who went quiet in March.

**Location & Media** *(collapsed)* — City, Locality, Latitude, Longitude, Amenities, **Gallery**
(photos and videos), Floor Plan, Video, Virtual Tour, Description, and **Show on Website**.

> "Show on Website" is a switch that hides a unit from the public site *without* changing its
> sales status. Useful when a unit is technically available but you don't want it advertised.

**Property statuses:** Available → Held → Blocked → Booked → Agreement Done → Registered → Sold,
plus Not For Sale.

**Ready-made views:** All Inventory · Available Units · By Status (kanban) · Blocked Units ·
Premium Units (≥ ₹2 Cr).

## 3.3 Why there are only two modules (the subtraction story)

iPropy once had thirteen modules: Leads, Contacts, Organisations, Projects, Properties, Deals,
Site Visits, Bookings, Payments, Channel Partners, Documents, Campaigns, Activities, Blog.

Eleven are gone. **Every single one died the same death:** it existed to hold a value that the lead
or the flat could hold by itself — so a salesperson had to create a *second record* just to write
down *one fact*.

| It used to be | Now it is |
|---|---|
| **Contacts** (a separate person record) | The same Lead record, with Lifecycle Stage moved to Customer |
| **Projects** (a building) | `project_name`, plain text on the flat |
| **Activities** (a to-do record) | A **date** on the lead — "Next Follow-up" — plus a note and a notification |
| **Site Visits** | Folded into Activities, and went with them. The Pipeline Status still tracks visits |
| **Campaigns** (spend, CPL, ROI) | The UTM tags on the lead itself, plus Outreach for the sending. Where an enquiry came from is answered on the enquiry |
| Deals, Bookings, Payments, Organisations, Channel Partners, Documents, Blog | Removed |

The Activities one is worth dwelling on. Its real job was *"chase this person on the 14th"*. The
lead already has a place to record that. So instead of creating an Activity record, the system now
does three things at once, from one piece of code:

1. writes the date on the lead,
2. writes a note on the lead's timeline so **the reason survives**,
3. sends a notification.

One action, one place, one truth. Every part of the system that used to create an Activity —
workflows, call analysis, WhatsApp sequences — now goes through that single door.

**Honest consequence:** the old data wasn't thrown away (it was copied to archive tables first),
but the public website has holes where Projects used to be. Fields a Project owned by itself —
RERA number, USPs, brochure, construction progress — now come back empty on those pages. The
website's project pages are stitched together by grouping units that share a `project_name`.

---

# PART 4 — Who can see what (the permission engine)

This is the part most CRMs get wrong, so read it carefully. It's four gates, checked in order.
A record has to pass **all four**.

```
   ┌─ GATE 1 ─────────────────────────────────────────────┐
   │ PROFILE:  Are you allowed to touch this module at    │
   │ all? And which fields inside it?                     │
   └────────────────────────┬─────────────────────────────┘
   ┌─ GATE 2 ───────────────▼─────────────────────────────┐
   │ ORG-WIDE DEFAULT:  For this module, is everything    │
   │ private, or readable by all, or editable by all?     │
   └────────────────────────┬─────────────────────────────┘
   ┌─ GATE 3 ───────────────▼─────────────────────────────┐
   │ ROLE HIERARCHY:  Managers automatically see          │
   │ everything their team owns, all the way down.        │
   └────────────────────────┬─────────────────────────────┘
   ┌─ GATE 4 ───────────────▼─────────────────────────────┐
   │ SHARING RULES + ONE-OFF SHARES:  Sideways grants —   │
   │ "Delhi team can also see Gurgaon leads", or "share   │
   │ just this one record with Ramesh".                   │
   └──────────────────────────────────────────────────────┘
```

## 4.1 Profiles vs Roles — the classic confusion

- A **Profile** is a *job description*. "A Tele-caller can create leads, cannot see prices,
  cannot open Bookings." It's about **what kind of thing you may do**.
- A **Role** is a *position on the org chart*. "Sales Manager (North) reports to Sales Head."
  It's about **whose records you may see**.

Two people can share a Profile (both are Sales Executives) but sit in different Roles (one in the
Delhi team, one in the Gurgaon team) — same powers, different data.

## 4.2 Field-level permissions (the sharp one)

You can hide **a single field** from **a single profile**. The Pre-Sales tele-caller can work a
lead all day and never see what it's worth.

**And here's the part that matters:** hidden fields are stripped out **on the server**, not just
hidden in the browser. If a hidden field were only removed from the screen, anyone who knows how
to open the browser's developer tools could read it straight off the network response. In iPropy
the value never leaves the server in the first place. (This was found and fixed once, during
testing. It's now guarded.)

## 4.3 The nine demo logins

You can log in as each of these and watch the *same screens show different data*. That's the best
way to feel how the engine works. Password for all: `Admin@123`.

| Login | Role | What it shows you |
|---|---|---|
| `admin@ipropy.com` | Administrator | Everything, plus the Admin panel |
| `priya.sharma@ipropy.com` | Sales Head | The whole company, via role hierarchy |
| `rahul.mehta@ipropy.com` | Sales Manager | Their team's records only |
| `aisha.khan@ipropy.com` | Sales Executive | Only their own records |
| `neha.gupta@ipropy.com` | Pre-Sales / Tele-caller | Pricing fields hidden |
| `arjun.nair@ipropy.com` | CRM / Post-Sales | Documentation side |
| `sanjay.iyer@ipropy.com` | Finance | Collections and commissions |
| `rakesh.bhandari@ipropy.com` | Channel Partner (Platinum) | Partner view |
| `sunita.menon@ipropy.com` | Channel Partner (Gold) | Partner view |

> ⚠️ These demo users exist **only in local development**. Production is deployed with demo data
> switched off, precisely because these nine accounts share a password that is published in this
> repository.

---

# PART 5 — The 32 kinds of question a field can ask

Every field has a **type** (the code calls it a `uitype`). The type decides three things at once:
how it's stored, how it's drawn on screen, and which filters make sense for it. There are 32.

### Text-ish
| Type | What it is |
|---|---|
| `string` | One line of text |
| `textarea` | A paragraph |
| `richtext` | A paragraph with bold, bullets etc. |
| `email` | Text that must look like an email — becomes a clickable link |
| `phone` | Text that must look like a phone — becomes a click-to-call link |
| `url` | A web address — becomes a clickable link |
| `password` | Text shown as dots, never sent back out |

### Numbers
| Type | What it is |
|---|---|
| `integer` | A whole number (bedrooms) |
| `decimal` | A number with a point (latitude) |
| `currency` | **Money.** Type `1.5 Cr` and it stores `15000000`. Displays as `₹1.50 Cr` |
| `percent` | A percentage (GST %) |
| `area` | A size, with a unit attached (Sq.ft. / Sq.yd.) |
| `score` | 0–100, drawn as a coloured meter |

### Choices
| Type | What it is |
|---|---|
| `picklist` | Pick **one** from a list you control (Pipeline Status) |
| `multipicklist` | Pick **several** (Configuration: 2BHK *and* 3BHK) |
| `boolean` | Yes / No — drawn as a toggle switch |
| `tags` | Free-form labels you can add on the fly |

### Time
| Type | What it is |
|---|---|
| `date` | A day |
| `datetime` | A day and a time |
| `time` | Just a time |

### Links to other things
| Type | What it is |
|---|---|
| `reference` | Points at one other record ("Referred By") |
| `multireference` | Points at several. **No module uses this today** and there is no working editor for it |
| `owner` | Who this record belongs to — a person *or* a team |
| `user` | Points at a person |

### Places and files
| Type | What it is |
|---|---|
| `address` | A compound box: line 1, line 2, city, state, pincode |
| `geolocation` | A latitude/longitude pair |
| `file` | An attached document |
| `image` | Photos and videos, shown as a thumbnail grid (this is the Gallery) |
| `json` | A free-form bag of structured data |

### Fields that fill themselves in
| Type | What it is |
|---|---|
| `autonumber` | `LD-00174`. Counts up on its own, never repeats |
| `formula` | Does maths on other fields. All-inclusive Price, Cost per Lead, ROI % |
| `rollup` | Summarises linked records ("total payments received"). Built, but nothing uses it now that the linked modules are gone |

**Why 32 types is a feature, not trivia:** adding a new type to that one dictionary file makes it
*instantly* available in the field builder, the form, the list, the filter builder and the
workflow engine. Nobody has to update five places.

---

# PART 6 — Every screen, one by one

The left sidebar, top to bottom: **Dashboard · Inbox · Calls · Leads & Contacts · Properties ·
Outreach · Site capture · Reports** — and at the bottom, **Settings** and **Admin**.

## 6.1 Login

Three ways in:

1. **Email + password** — the normal way.
2. **Mobile number + password** — because a salesperson knows their number better than the email
   the office made for them. It matches on the **last ten digits**, so `+919820011000`,
   `098200 11000` and `9820011000` all find the same person. (Real imported data contains all
   three spellings of the same number.)
3. **Passkey — Face ID or fingerprint.** No password typed at all. You don't even have to type
   your username; the device knows who you are.

> **Honesty note:** the passkey plumbing is fully built and its security checks are verified
> (including refusing a cloned credential), but the actual finger-on-sensor round trip has never
> been run on real hardware. Also, passkeys are tied to the exact web address of the site — if the
> deployment address is configured wrongly, biometric sign-in fails silently.

The sign-in screen shows your logo and the "Builder Floor = IPROPY" tagline, both editable in
Admin → Brand & Social.

## 6.2 Dashboard

Five ready-made dashboards. You can build more, and you can build your own widgets.

**Widget types:** metric tile (a big number, with "up 12% vs last month"), gauge, bar, line, area,
pie, donut, funnel, stacked bar, table, and AI insight tiles.

Three things worth knowing:

- **Everything clicks through.** Click a funnel stage, a pie slice, a bar — you land on a list of
  *exactly those records*, already filtered. Not "all leads"; the 47 leads that slice represented.
- **The funnel counts cumulatively.** Someone at "Negotiation" is also counted in "Contacted",
  because they passed through it. That's what makes the conversion percentages honest.
- **Drag to rearrange, drag corners to resize** — on a desktop screen (1024px+). Your layout is
  saved to the server, so it follows you to another computer. On a phone the widgets just stack
  in a sensible order.

## 6.3 List view (the Leads / Properties screens)

This one screen is used by every module, and it's the workhorse.

**Two shapes, one button apart:**
- **Table** — rows and columns, like a spreadsheet.
- **Kanban** — cards in columns, one column per Pipeline Status. **Drag a card to another column
  and the record's status changes.** That is the whole "move the deal along" gesture.

**Tabs across the top** are your saved views. Each can show a live count. Pre-built ones are listed
in Part 3; you can save your own from any filter.

**The filter builder** lets you nest conditions — groups inside groups, AND inside OR. Everything
in Part 2.6 applies.

**Column chooser** — pick which columns you see, drag to reorder.

**Bulk actions** — tick several rows and: edit them all at once, reassign them all to someone else,
or delete them.

**Export to CSV** — for Excel.

**"New since you last looked"** — records created since your last visit that you have *never
opened* show up highlighted. Both halves matter: without the "last visit" marker your first login
would light up every lead you own since the dawn of time; without the "never opened" check, a lead
you already worked would stay bold forever.

**Inline editing** — see 6.5. It works in the table cells and on the kanban cards too.

## 6.4 Record detail — one lead, or one flat

The most-used screen in the product.

**The header** shows a summary: the name, and a row of chips with the fields that matter most for
that module. *You choose which chips* in Admin → Layout Designer.

**Tabs:**
- **Overview** — all the fields, in their blocks. Collapsed blocks start folded.
- **Timeline** — see below.
- **Calls** — every call with this person.
- **Files** — everything attached.

*You choose which tab opens first*, per module, in the Layout Designer.

**The sidebar** holds notes and the AI panel (score, reasons, matching units, drafted messages).

**Buttons** — one click to call, one click to WhatsApp.

**Prev / next** — arrow buttons, or just press ← and → to walk through the list you came from,
without going back to it. Works on every module.

### The Timeline — the single most valuable screen in the CRM

Everything that ever happened with this person, in one merged feed, newest first:

```
  ┌ Today
  │  📞  Call, 4m 12s, answered — "wants a corner unit, budget stretched to 1.2 Cr"
  │  💬  WhatsApp sent: floor plan for Tower A-1204          ✓✓ read
  │  🤖  AI: score moved 62 → 78. Reason: answered call + asked for floor plan
  ├ Yesterday
  │  ✏️  Pipeline Status changed: Contacted → Qualified   (by Aisha Khan)
  │  📝  Note: "Prefers east facing. Wife wants ground floor."
  │  📎  File: KYC-PAN.pdf
  └ 3 Aug
     📧  Email opened: "Greenfield Phase 2 — price list"
```

Calls, WhatsApp, emails, notes, files, **every field that changed and who changed it**, and AI
insights — all on one strip. Nobody has to ask "what's the status on Ravi?" ever again.

## 6.5 Inline editing — click any value, change it, done

You almost never need the full edit form. Click a value where it sits — in a table cell, on a
kanban card, in the record header, in the Overview field list — and edit it in place.

The interaction changes based on how much commitment the value deserves:

| Field type | What happens |
|---|---|
| Yes/No | A real toggle. Click = saved. No popup at all |
| Text, number, money, date | The value turns into a box, right where it was. **Enter** saves, **Escape** cancels |
| Dropdown, Assigned To, linked record, multi-select, tags | A small panel floats open. Picking saves immediately — there's nothing to confirm. Multi-select panels stay open so you can pick several |
| Address, JSON | An explicit **Save / Cancel** — these are compound, so a stray click outside shouldn't half-save them |

**Never inline-editable:** auto-number, formula and rollup (nothing to write); Gallery (needs
room, has its own uploader); multi-reference (no editor exists anywhere).

**Links get a pencil.** For email, phone, website and linked-record fields, clicking the value
follows the link (dials the phone, opens the record). To edit, a small pencil fades in when you
hover. Both actions stay available and neither swallows the other. *(The naive version — making
the whole thing a button — puts a button inside a link, which browsers silently break. That was
found in testing: the phone column's dial link stopped working.)*

**On success**, the field flashes a quiet green ring — no toast. A toast for every single field
edit would be unbearable at this frequency. **On failure**, the old value snaps back and a toast
explains why, because that *does* need your attention.

## 6.6 Inbox — WhatsApp conversations

Threads down the left, the conversation on the right.

**The 24-hour window is enforced, visibly.** WhatsApp's rule: once a customer messages you, you
may reply freely for 24 hours. After that you may only send a **pre-approved template**. The Inbox
shows you which side of that line you're on, so you don't write a lovely paragraph that WhatsApp
refuses to deliver.

Also here: delivery receipts (sent / delivered / read), your template library, and **AI reply
suggestions** — draft replies written from what this person has actually said and what they're
actually looking at.

## 6.7 Calls

Every call, in and out. Recording player where a recording exists. Filters, stats, and a
"needs disposition" list of calls nobody has written up yet.

Per call, the AI produces: a **summary**, a **sentiment** (were they warm or cold?), **objections
raised**, **next actions**, and the **talk ratio** — how much you talked versus how much they did.
(A rep talking 80% of the time is a rep who isn't listening.)

There's a **coaching report** per salesperson built from these.

> **Honest limit:** iPropy does **not** convert audio into text. Call analysis works from a
> transcript. That transcript comes from your telephony provider, an external speech-to-text
> service, or by pasting it in by hand.

## 6.8 Outreach — messaging at scale

Four tabs.

**Queue** — messages waiting to be sent from a linked phone (see Part 10.2), with per-message
"opened / sent / skip" tracking.

**Broadcasts** — send one message to a whole saved view. Start, pause, cancel. Progress bar.

**Sequences** — a drip campaign. Step 1 today, step 2 in 2 days, step 3 in a week. Each step can
be a **WhatsApp message**, an **email**, or a **task for the owner**. Delays offered: 5 min, 1 hr,
6 hr, 1 day, 2 days, 3 days, 1 week, 2 weeks, 1 month. Enrol people; they exit automatically when
they reply or convert.

**Auto-replies** — rules that answer inbound messages by themselves:
- *A keyword appears* — "PRICE" → send the price list. Match on "contains" or "exactly".
- *The first message arrives* — a welcome.
- *Nothing else matched* — a fallback.
Rules can chain into one another, and you can test a rule against sample text before switching it
on.

## 6.9 Site capture — the screen used at the gate

This is the one screen designed to be used outdoors, one-handed, in sunlight, standing outside a
builder floor immediately before walking in to photograph it. Everything about it follows from
that.

- **It never waits for the network.** The tap writes to the phone's own storage and returns. A
  site with no signal must not cost you the visit.
- **It never waits for GPS.** Location is collected in the background and attached if it arrives.
  It is used for grouping, never to decide *which* property this is — adjacent floors are ten
  metres apart.
- **There is no Finish button.** Nobody presses one reliably after ten visits, so the next Start
  closes the previous visit and the server closes the day's last one.
- **You can speak instead of typing.** A twenty-second note at the gate is turned into fields
  later, and you confirm them that evening rather than typing them in the sun.

Which fields appear here comes from the Properties quick-create layout, so it is an Admin setting
in the Layout Designer, not something that needs a developer.

**Site capture → Shoots** is the evening half: photos that arrived with no property on them,
grouped by when they were taken, with thumbnails, waiting to be pointed at a property.

> There is no Studio. Marketing images, brochures and reels are made in a dedicated design tool —
> the CRM's job is to hold the property and its photos, watermark and resize them automatically,
> and publish them. A design editor inside the CRM was removed deliberately.

## 6.10 Reports

Build a report without a programmer. Choose a module, choose how to group it, choose what to
measure (count, sum, average), pick summary or table layout, export to CSV.

> A real bug lived here and is fixed: Reports used to open pre-set to a module, a grouping and a
> measure that had all been deleted along with the old modules — so three dropdowns just rendered
> blank. Every default is now worked out from whatever metadata actually exists.

## 6.11 Settings (your own account)

Five tabs:

- **Profile** — your name, your photo (upload / change / remove).
- **Preferences** — light or dark theme, and other personal choices.
- **Alerts** — browser push notifications, **per device**. You subscribe each device separately.
  *Nobody has subscribed a device yet* — the plumbing is verified, the wire format is verified
  encrypted, but no real phone has been registered.
- **Security** — password, and setting up your passkey.
- **Phones** — pair your Android phone for call sync. **This is where you get the pairing token.**

## 6.12 Capture — photographing a property without typing anything

This is the screen you use **standing at the gate**, not sitting at a desk. Everything about it is
shaped by where it runs: outdoors, one-handed, in sunlight, on a connection that often is not there.

**The problem it solves.** You know exactly which flat you are photographing at the moment you press
the shutter. Then that fact is thrown away. Every step afterwards — sorting the camera roll,
working out which forty photos were B-110 and which were B-112, filing them, sending them — is you
reconstructing something you already knew that morning.

**How you use it:**

1. Open **Capture**, type or say the property, tap **Start**.
2. Walk in and shoot with your **normal camera app**. Not through the CRM — your own camera.
3. That's it. Photos taken between Start and the next visit are filed against that property
   automatically.

**It never waits for the network.** The tap writes to your phone's own storage and returns
immediately; the queue uploads later when there is signal. A visit made in a basement with no bars is
not a visit whose photos are lost.

### Saying the details instead of typing them

> *"B-110 Greenfield, second floor, four BHK, 325 gaj, asking three point two five crore, two
> parking, lift, ready to move, park facing"*

Every item in that sentence is already a field in the CRM. Typing it is nine dropdowns and four
number pads while standing in the sun. Saying it is one breath. It is **optional** — the screen works
fine without it.

You are never asked to trust it blindly. What you said is turned into values, and you confirm them
later (see 6.13).

### If you forget to tap Start

**Nothing is lost.** This is the important part.

Photos that belong to no visit are grouped **by the clock alone**: a gap of about 40 minutes means
you drove somewhere, so the run of photos before it was one place and the run after it was another.
That gives you a group with no name — which is exactly the thing one tap in the evening fixes, while
sitting down and looking at the pictures, instead of having to remember anything at a gate.

Missing the tap now costs nothing. The group is still there tomorrow.

### Why the clock and not GPS

The phone records where you were, and that is useful for review. It **cannot** tell you which
property you were at. Two builder floors next door to each other are ten to twenty metres apart —
well inside the error of a phone's location fix. The clock is exact; the property comes from you.

## 6.13 Shoots and the evening review

Two screens for sitting down at the end of the day.

**Shoots** lists the visits that still have no property attached. It shows **thumbnails first**,
deliberately: nobody on earth can tell *"9:03–9:21, 12 photos"* from *"9:48–10:04, 14 photos"*, but
everybody recognises their own pictures. One box both searches existing properties and creates a new
one — because a floor you shot this morning usually is not in the CRM yet.

If a model has been configured (Admin → Integrations), each group also carries a **description of
what is actually in the photos**:

```
3 BHK builder floor — marble flooring, modular kitchen, covered parking
12 photos   2:38 pm – 2:58 pm
[false ceiling]
```

That turns naming a three-day-old shoot from a memory test into reading. Two limits worth knowing:
the description is **never written onto the property record** — a model can see a modular kitchen, it
cannot see that this is B-110 rather than B-112 — and with no model configured you simply get the
thumbnails and times, which is how the system ships.

**Capture review** is the other half of speaking at the gate: read a line, glance at the values it
pulled out, tap **Confirm**. Ten properties in about two minutes.

## 6.14 Sending one property to one person

The complaint this exists for: *"then later I have to send it to some party and everything is so
cluttered."*

On any property, **Send to a buyer** makes a share link — one property, one long unguessable web
address, no login required at the other end. The buyer opens it on their phone and sees the photos,
large, first.

**Why not just use the website?** The public site is a catalogue: it lists units that are marked
Available and published. The flat you most want to send is usually the one you photographed this
morning — still a draft. Waiting for it to be publishable before you can show it to a buyer is
backwards, so a share link is its own separate thing.

Three things to know:

- **Label each link with who you sent it to.** That is what turns an anonymous view counter into
  *"the one I sent Rajesh has been opened four times"* — which is a buying signal. The label is
  **never shown to the buyer**; it is your own note to yourself.
- **You can revoke a link** at any time. A revoked link, an expired one and a mistyped one all give
  the visitor exactly the same "not found" page — on purpose, so nobody can probe for real ones.
- **The photos come from the property's Files**, not the hand-curated gallery — which is empty on
  anything that arrived through Capture, i.e. every property this feature is for.

---

# PART 7 — The Admin panel, section by section

Thirteen screens, in four groups. This is where the Lego from Part 2 gets assembled.

## Group 1 — Structure

**1. Enable / Disable** — every module with its field count and record count, and a switch.
Switching one off hides it *everywhere*: sidebar, global search, reports, and the API (the address
stops answering). **It keeps all the data**, so switching it back on restores everything exactly.
Each module tells you which others point at it. **Leads is marked core and cannot be switched off**
— everything else reads from it.

**2. Modules & Fields** — the field builder. Create modules. Create, edit, reorder, hide and
**permanently delete** fields. Set a field's label, help text, whether it's required, whether it
appears on the quick-create form, its maximum length, its default.

> **"Hide" vs "Delete" is a real distinction here.** Hiding deactivates the field. Deleting removes
> it for good — *and drops its database column*, because several built-in fields are required with
> no default, so deleting them from the description only would break every new record. A module's
> naming field or pipeline field will refuse to be deleted, and tells you why.
>
> There's a subtlety that took real work: the seeding process rebuilds every module description on
> each run, so a deleted built-in field used to come straight back. A "tombstone" table now records
> the deletion, and the seed checks it. That's what makes a deletion stick.

**3. Layout Designer** — arrange the form. Add / rename / reorder / delete sections. Choose which
fields become the **summary chips** in the record header. Choose **which tab a record opens on**.

> Once you edit a layout, it's marked as yours and the seeding process **skips it forever after**.
> Without that flag, a re-seed would silently undo the arrangement someone spent an afternoon on.

**4. List View Tabs** — manage the saved views that appear as tabs above each list.

**5. Dropdowns** — every picklist. Create a new one, rename it, add options, reorder them (drag,
or the arrows on a phone), colour them, and star the one new records start on. You can also set up
**dependent dropdowns** (picking a City narrows the Locality list) and restrict certain values to
certain roles.

Two things are worth understanding, because they are what people get wrong:

- **The left box is the name, the right box is the stored value.** Renaming the *name* is free —
  it is only what people read. Changing the *stored value* changes what is written on every record,
  so when you do it, iPropy rewrites every record that held the old one, plus any saved view,
  dashboard filter or workflow rule that mentions it. It tells you how many it changed.
- **Inactive and Delete are different.** Switching an option **inactive** keeps it on records that
  already have it and stops anyone choosing it again — the safe choice for a status you have retired
  but whose history you want intact. **Delete** removes it for good; if records still hold it, you
  are asked what those records should say instead before anything happens. A deleted option stays
  deleted through restarts and redeploys.

## Group 2 — People

**6. Users** — create, edit, deactivate, reset passwords, assign a role and a profile.

**7. Roles & Profiles** — build the org chart (roles) and the job descriptions (profiles). This is
also where the **field-permission grid** lives: for each profile, mark a field visible, read-only,
or hidden.

**8. Data Sharing** — the org-wide default per module (private / public read / public read-write)
plus sharing rules for sideways access.

## Group 3 — Automation and data

**9. Workflows** — see Part 8. Full visual create/edit, not just a list.

**10. Import Data** — bring in a CSV. Map your spreadsheet's columns to fields, and it runs through
the same duplicate-checking and validation as manual entry.

## Group 4 — Setup

**11. Integrations** — two ways to look at the same thing.
- **Connect tab** — pick an outcome ("I want to receive Facebook leads"), follow numbered steps,
  paste one value per step. Verify tokens and webhook keys are **generated for you** rather than
  demanded. Saving runs that provider's own real connection test.
- **All settings tab** — the field-by-field view for when you know exactly what you're doing.
- **Webhook URLs tab** — the addresses to hand to each outside provider.

> Credentials are **encrypted in the database** (AES-256-GCM). Settings you save in the UI win over
> anything in the server's environment file — the file is only a fallback.

**12. Brand & Social** — logo, organisation name, the tagline, brand colour, and your social media
links (which appear as a coloured icon bar in the sidebar).

> ⚠️ The Instagram links currently in there were **found by a web search, not supplied by the
> business.** Two iPropy Instagram accounts exist. Treat both as unverified until someone confirms
> which is yours.

**13. System & Audit** — the health check, the settings store, and the **audit log**: who changed
what, when, from what to what, across the whole system.

---

# PART 8 — Automation (workflows)

A workflow is a sentence: **"When *this* happens, if *these things* are true, do *that*."**

## 8.1 The seven triggers — the "when"

| Trigger | Fires when |
|---|---|
| `on_create` | A record is created |
| `on_modify` | A record is edited |
| `on_field_change` | One *specific* field changes (status becomes "Qualified") |
| `on_delete` | A record is deleted |
| `scheduled` | On a timetable — hourly, daily |
| `on_inbound_message` | A WhatsApp message arrives |
| `on_call_end` | A call finishes |

## 8.2 The fourteen actions — the "do that"

`update_fields` · `create_record` · `send_email` · `send_whatsapp` · `send_sms` · `create_task` ·
`create_event` · `assign_owner` · `notify_user` · `webhook` · `ai_action` · `add_tag` ·
`trigger_call` · `delay`

## 8.3 The clever bit: delays relative to a field

An action can wait a fixed amount (*30 minutes after*) **or** be scheduled relative to a date
stored on the record (*2 hours **before** the value in `scheduled_at`*).

That second one is what makes "remind them two hours before their site visit" possible at all —
because the reminder time is different for every single record, and only the record knows it.

## 8.4 The seven workflows that ship ready-made

| Workflow | What it does |
|---|---|
| **Instant lead response** | A new lead arrives → score and grade it → send a welcome message → create the first-call follow-up → ping the owner. All within seconds |
| **Auto-assign inbound leads** | Applies the assignment rules (below) |
| **Escalate untouched leads** | Nobody touched it in time → notify the reporting manager → tag it as an SLA breach |
| **Nurture cold leads** | Gone quiet → AI drafts a personalised nudge → send it |
| **Re-score on engagement** | They replied or answered → recompute the score |
| **Release expired blocks** | A unit's hold has expired → release it → tell the rep |
| **Birthday greeting** | It's their birthday → send a wish |

## 8.5 Assignment rules — who gets the lead

Three rules ship, checked in order:

1. High-value leads → field sales
2. Channel-partner leads → the CP manager
3. Everything else → round-robin to inside sales

Strategies available: **round-robin** (take turns), **load-balanced** (spread evenly), and
**least-busy** (give it to whoever has fewest leads with a follow-up date that's already arrived).
Each person can have a **daily cap** so nobody gets buried.

## 8.6 SLA — the promise clock

Two policies ship:
- **Hot lead** — first response within **15 minutes**
- **Standard lead** — first response within **2 hours**

The system records when the lead arrived and when someone first responded, in seconds. Miss it and
the escalation workflow fires.

## 8.7 The one rule the engine must never break

Events are emitted **only after a change is safely saved**, never during. This isn't a preference,
it's a hard-won lesson: if a workflow fires *while* the save is still in progress, that workflow
tries to update the same record through a different connection, hits the lock the unfinished save
is holding, and **both sides wait for each other forever**. The system freezes.

The fix is a queue that only runs after a save commits. It's written down in the project's rules
file so nobody reintroduces it. (This is backstage plumbing, but it explains why the code is
shaped the way it is.)

---

# PART 9 — The AI layer

## 9.1 The golden rule

**Every AI feature is two features stacked:**

```
   ┌────────────────────────────────────────────────┐
   │  RULE ENGINE   — always runs, needs no AI      │
   │  Plain arithmetic. Deterministic. Free.        │
   └───────────────────┬────────────────────────────┘
                       │  then, only if AI is available
   ┌───────────────────▼────────────────────────────┐
   │  LLM PASS      — adds reasoning and English    │
   │  Reads notes and calls, writes the sentences.  │
   └────────────────────────────────────────────────┘
```

Turn the AI off and **the CRM does not lose a feature** — leads still get scored, buyers still get
matched to units, work still gets routed. You lose the *narrative*: the "why", the drafted
paragraph, the summary.

That's not a compromise, it's the design. AI features that throw errors when the key is missing
make a product that can't be demoed and can't be trusted.

## 9.2 The six AI features

| Feature | What the rule engine does by itself | What the AI adds |
|---|---|---|
| **Lead scoring** | Scores 0–100 from: how long they've been around, how good the source is, whether their budget matches your actual inventory, how engaged they are, how recent, how fast you responded | Reads the notes, calls and messages, nudges the score up to ±30, and writes the reasons and the recommended next actions |
| **Property matching** | Ranks units by budget fit, configuration, location, area and possession timing | Writes the actual pitch for each unit, grounded in real record data |
| **Deal risk** | Flags: stuck too long in a stage, gone silent, pushing hard on discount, never did a site visit, the unit they wanted got taken | Explains it, and picks the single highest-leverage thing to do |
| **Call analysis** | — | Summary, sentiment, objections, next actions, talk ratio. **Pulls stated budget and timeline into empty fields — and only empty ones**, so it can never overwrite what a human typed |
| **Ask your CRM** | — | Type a question in English, get real records back. See 9.3 |
| **Drafting** | — | Writes a WhatsApp message, an email or a call script from this person's real history |

> When Site Visits were deleted, they had been worth up to 28 of the 100 scoring points and no
> longer had anywhere to live. Simply removing that input would have deflated every score by a
> quarter and made Grade A **mathematically unreachable**. That weight was moved onto answered
> calls and inbound messages instead.

## 9.3 "Ask your CRM" — why you can trust the number

You type: *"Show me hot leads in Faridabad who haven't been called this week."*

Here's what actually happens, and the middle step is the one that matters:

```
   Your English question
        ↓
   The AI turns it into a structured filter (the same shape from Part 2.6)
        ↓
   ★ THE SERVER THROWS AWAY ANY FIELD THAT DOESN'T EXIST ★
        ↓
   The surviving filter runs through the normal, permission-checked query engine
        ↓
   Records — the exact same ones a saved view would show
```

Two consequences:

1. **The AI cannot invent a field.** If it hallucinates `customer_temperature`, that condition is
   silently dropped before anything runs.
2. **The AI cannot leak.** It runs through the same four permission gates as everything else. Ask
   as a Sales Executive and you get *your* leads, because the query is scoped to you — not because
   the AI was polite about it.

The numbers in an AI answer are the same numbers the list view shows. They come from the same
engine.

## 9.4 Which AI providers work

There are two ways the system talks to an AI: the official Anthropic connection, and **one
adapter that speaks the common "OpenAI-style" format** — which covers everything else:

| Provider | Notes |
|---|---|
| **Anthropic (Claude)** | Paid |
| **Google Gemini** | Most generous free tier, no card needed, huge context. **But Google may train on free-tier prompts — and these prompts contain your customers' personal data.** Weigh that |
| **Groq** | Fastest |
| **OpenRouter** | Use `openrouter/free` — the auto-router. Individual `:free` model IDs get retired without warning |
| **Any OpenAI-compatible endpoint** | Bring your own |
| **Ollama** | Runs on your own machine. Nothing leaves the building |

Configure them in **Admin → Integrations**, not in a file.

> **Check the deployment, not this document.** AI credentials live in Admin → Integrations and can
> change without a code deploy. If no provider card is active, the deterministic scoring, matching
> and routing rules still run; model-written explanations, vision and drafting do not.

## 9.5 The scheduler — the thing that works while you sleep

A background loop ticks every 60 seconds and:

- runs scheduled workflows (nurture, birthday, escalation),
- drains the queue of delayed workflow actions,
- releases expired unit blocks,
- processes uploaded photos and videos (Part 11),
- does housekeeping.

---

# PART 10 — Talking to people: WhatsApp, phone, email

## 10.1 WhatsApp — the honest situation

**Built and ready:** the whole Meta Cloud API integration — sending, receiving, templates, the
24-hour window, delivery receipts, broadcasts, sequences, auto-replies, consent enforcement.

**What's missing is not code.** To send a single WhatsApp message through the official API you
need:
- a business verified by Meta,
- a dedicated phone number registered to that business,
- usually a paid provider in between.

Until then, the system runs in **simulation**: messages are recorded in the CRM and marked as sent,
so every workflow and sequence stays fully testable. The moment real credentials are pasted in,
the same code starts sending for real.

**A warning worth repeating:** there is no legal API that mirrors your *personal* WhatsApp inbox.
The libraries that claim to do this get phone numbers **permanently banned**. This is why the CRM
does not offer it.

## 10.2 Device-send — the workaround that actually works

Because the official API is gated, there's a second path: **link a phone**, and messages queue up
on it for a human to send from their own WhatsApp. The Outreach → Queue tab tracks each one
(opened / sent / skipped). It's not automation, but it's legal, it works today, and it keeps the
record in the CRM.

## 10.3 Consent is enforced, not just recorded

**Do Not Call**, **Do Not WhatsApp** and **Email Opt Out** aren't decorative checkboxes. The
sending code checks them. Tick "Do Not WhatsApp" and no workflow, no sequence, no broadcast will
message that person.

## 10.4 Telephony

Supported: **Twilio** and **Exotel**. What it gives you:

- **Click to call** — click the number, your phone rings, then theirs.
- **Screen pop** — an inbound call opens that lead's record before you say hello.
- **Recordings** — stored against the call.
- **Virtual numbers** — a company number that routes to the right person.

Without credentials, calls are logged and click-to-call does nothing.

## 10.5 The Android companion app — calls from real phones

This is the pragmatic answer to call tracking, and it's genuinely clever.

**The problem:** cloud telephony gives you one company number with IVR and routing. But your
salespeople call buyers from their **own phones**, all day, and none of that reaches the CRM.

**What the app does:**
- Reads the phone's own call log **every 15 minutes** and posts new calls to the CRM.
- Matches each number to a lead **on the last ten digits** — so `98123 45678`, `+919812345678` and
  `09812345678` all find the same person.
- Updates the lead's Last Contacted, Contact Attempts and status.
- Optionally uploads recordings **your phone's own recorder** already made.
- Notifies you when an unknown number calls — that's a lead you don't have yet.

**Setup:** CRM → Settings → Phones → Pair a phone → copy the token → paste into the app.

**What it cannot do — and this is a hard limit, not a missing feature:** it **cannot record calls**.
Android closed that ability at Android 10 and nothing reopens it. What it *can* do is pick up
recordings made by the phone's **built-in** recorder — most Indian-market phones (Xiaomi, Realme,
Samsung, OnePlus, Vivo, Oppo) have one; switch it on in the Phone app's settings and the companion
app finds the files. No built-in recorder means the call log still syncs, just without audio.

Also: recording calls has **per-state consent laws** in India. That's a legal question, not a
technical one.

## 10.6 Email

SMTP for sending, IMAP for receiving. Templates. **Open tracking** via an invisible pixel — you
can see who opened your price list. Without credentials, emails are logged rather than sent.

---

# PART 11 — Photos and videos (the media pipeline)

Take a photo on your iPhone at a site, upload it from mobile Safari, and the CRM turns it into
web-ready files by itself. Two stages:

**Stage 1 — the upload returns immediately.** The original is stored and the screen comes back
instantly, whether the file is 2 MB or 2 GB. A multi-gigabyte 4K video is streamed straight to
disk — it never sits in the server's memory.

**Stage 2 — a background job does the work.**

**For photos:** auto-rotates using the camera's orientation data, then makes three sizes — thumb
(480px), medium (1200px), large (2400px) — in the modern WebP format. **The IPROPY watermark goes
on the medium and large only.** Thumbnails stay clean, because a watermark on a 480px tile in a
dense grid is just visual noise.

**For videos:** converts to standard MP4, caps the long side at 1920 (**never upscales**), overlays
the watermark throughout, prepends a **~3-second title card** built from the record's *live* name,
price and location, and mixes a background music track in quietly (about 16%) under any existing
audio.

Four things make this trustworthy:

1. **The original is never touched.** Never re-encoded, never overwritten. Verified by comparing
   the file's fingerprint before and after — byte-identical.
2. **The title card is pulled fresh** from the record at render time, so it can never show a stale
   price.
3. **Every optional stage skips itself rather than failing.** No music file? Skip the music. No
   video tool installed? Serve the original untouched, log it once, and never show the uploader an
   error.
4. **The public website automatically uses the right size** — medium in grids, large in the
   lightbox — and falls back to the original if a size isn't ready yet.
5. **A picture too small to carry a watermark is left unbranded rather than failing.** The badge has
   a minimum readable size; on an image smaller than that — a logo, an icon, a scanned signature —
   it simply isn't applied. Every other version is still produced.

This is also the pipeline **Capture** (6.12) feeds. Photos arriving from a site visit go through
exactly the same two stages; the only difference is that the visit's time window decides which
property they land on.

> **Two known gaps:** no music track is bundled (deliberate — someone has to drop in a file with a
> confirmed licence). And iPhone HEIC photos may or may not decode, depending on the image library
> the server was built with; that's never been tested against a real HEIC file.

> **A bug that lived here and is fixed:** the watermark badge has a 60px floor so "IPROPY" stays
> readable. On an image *narrower than that*, the badge was wider than the thing it was being
> stamped onto — the imaging library refuses that, the job threw, and the queue retried it forever
> against an image exactly as small on the tenth attempt as on the first. One icon uploaded to a
> record could occupy the media queue indefinitely. Nothing off a phone ever hit it.

---

# PART 12 — Everything that connects to the outside

## 12.1 The connection table

| Integration | What it does | Without credentials |
|---|---|---|
| **WhatsApp** (Meta Cloud API) | Send, receive, templates, receipts | Simulated — logged and marked sent |
| **Telephony** (Twilio / Exotel) | Click-to-call, screen pop, recordings | Calls logged, click-to-call does nothing |
| **Facebook Lead Ads** | Leads flow in automatically | Address is live, no traffic |
| **Google Ads** | Same | Address is live, no traffic |
| **99acres / MagicBricks / Housing / NoBroker** | Their enquiries become leads | Address is live, no traffic |
| **Email** (SMTP / IMAP) | Send, receive, open-tracking | Logged with open tracking |
| **Web forms** | Your website's enquiry form → a real lead | **Works immediately** |
| **S3 storage** | Files in the cloud | Falls back to local disk |
| **AI providers** | Part 9.4 | Rule engines only |
| **Web Push** | Browser notifications | Works; nobody has subscribed yet |

**Everything degrades gracefully.** With absolutely nothing configured, the entire product is
demoable end to end. This is not an accident; it's rule number seven in the project's rulebook.

## 12.2 How an outside lead becomes a CRM lead

```
  Facebook ad  ──┐
  99acres      ──┤
  Your website ──┼──▶  the CRM's public "letterbox" address
  MagicBricks  ──┤              ↓
  Google Ads   ──┘     Translated into standard fields
                                ↓
                       Duplicate check (mobile, email)
                                ↓
                       Created as a real Lead
                                ↓
                       Assignment rules pick an owner
                                ↓
                       "Instant lead response" workflow fires
                                ↓
                       Score · welcome message · follow-up · notify owner
```

Each source has its own small translator that knows that source's vocabulary, but from the
duplicate check onwards **every lead travels the same road**. There isn't one path for Facebook
leads and another for website leads.

> A real bug lived on this road and is fixed. Unattended captures (forms, portals, ads) are
> recorded as being created by a "system user" with a fixed ID — but no such user existed in the
> table. Every single unauthenticated capture was **silently failing** on a database constraint.
> A system user is now seeded. It can never be logged into (it has no password).

## 12.3 The public property website

A separate Next.js website that shows your inventory to the world. It lives in its own repository
at `~/Downloads/iPropy-Projects/ipropy-website`.

**How it gets data:** through a **separate, read-only public API** in the CRM. That API is
deliberately built differently from everything else: instead of going through the general engine,
**each query hand-lists exactly which columns it will return.**

That's the whole security design. It means a sensitive field — the resale owner's contact, who a
unit is blocked for, the broker commission percentage, or any custom field an admin adds next year
— **cannot leak onto the public site just because it exists on the record.** It has to be named.

**What's visible:** projects in a sellable status, properties marked Available, **and** the
"Show on Website" switch turned on. Both conditions.

**How enquiries come back:** the website's form posts to its own server, which forwards it to the
CRM's web-form address. It becomes a real Lead, source "Website", travelling the same road as
everything in 12.2.

**The website's browser never talks to the CRM directly** — only its server does, with results
cached for about 60 seconds.

**Also on the website:** structured data for Google, per-listing social preview images, city
landing pages, dark mode, amenity icons, recently-viewed, and a deep comparison tool.

**Not done:** locality-level SEO pages. The website itself is deployed at
`https://ipropy-website.vercel.app`.

## 12.4 Removed: the daily SEO audit

This feature was removed on 14 August together with the blog residue. Website SEO is owned by the
Next.js application and normal external search tooling; the CRM no longer runs or stores a daily
SEO grade.

---

# PART 13 — What is NOT built, and why (the honest list)

This section exists so nobody is surprised. Nothing here is missing through laziness.

## 13.1 Blocked on things code cannot supply

| Item | The real blocker |
|---|---|
| **WhatsApp sending** | Needs a Meta-approved business, a dedicated number, and usually a paid provider. **The code is complete and waiting.** There is no legal API that mirrors a personal WhatsApp inbox — the libraries claiming to do it get numbers permanently banned |
| **Portal syndication** (*posting* listings to 99acres / MagicBricks / Housing) | No open API exists for posting. These are **commercial contracts, one per portal**. Note: receiving *inbound* leads from all four already works |
| **Call recording on Android** | Android 10 closed the API. Nothing reopens it. The working routes are (a) cloud telephony recording server-side, already built, or (b) the companion app picking up your phone's own recorder's files. Per-state consent law applies either way |
| **A working AI key** | See 9.4. Configuration is deployment-specific; check Admin → Integrations rather than assuming from this guide |

## 13.2 Built but never exercised with real credentials

- Passkey biometrics — the plumbing and security checks are verified, the actual sensor round trip
  isn't.
- Browser push — the wire format is verified encrypted, but no device has subscribed.
- Inbound email over IMAP.
- Rollup fields — built, but nothing uses them since the linked modules were removed.
- The Channel Partner portal.
- **Speaking the details at the gate** (6.12) — the transcription path needs a real provider key.
- **Shoot descriptions** (6.13) — needs a model with vision. Without one you get thumbnails and
  times, which is the shipped default.
- **Capture itself has never been used on a real site visit.** It is verified in a browser at phone
  width and against a stand-in provider. Sunlight, one hand, no signal, and EXIF timestamps from a
  real camera are the four assumptions it rests on, and none of them have been tested where they
  actually apply. This is the single most valuable hour anyone could spend on this project.

## 13.3 Deliberate scope decisions

- **Dashboard drag-to-resize is desktop-only** (1024px+). Phones get a sensible stacked layout.
- **Automated tests cover the working system.** 374 unit tests (320 server, 46 web, 8 MCP), 274
  integration tests against real throwaway Postgres databases and 28 Playwright tests across
  desktop and mobile. Real provider accounts and a real site visit still require human checks.
- **A shoot description is never written onto the property.** A model can describe a room; it cannot
  know the unit number. Treating its guess as a fact would defeat the point of asking a person.
- **Photos are matched to a property by time, never by GPS.** Neighbouring builder floors are closer
  together than a phone's location fix is accurate.

## 13.4 Genuinely unfinished

- Locality-level SEO pages on the public website are still optional future depth; the website itself
  is deployed.
- A full real-device pilot is still required even though the browser suite covers desktop and mobile
  layouts.
- Scheduled backups must be confirmed in Neon before real data is imported. The application cannot
  see the database host's backup schedule. Use the provider's own daily backups and instant restore;
  a nightly dump job was deliberately removed rather than move every client's name, phone number
  and PAN between systems.
- The many-to-many "pick an existing record" box on related lists. The API already supports it.

> Conditional field visibility ("only show this field when…") was listed here as half-built. It
> shipped — along with cross-field date rules and format presets for PAN, GST, pincode, Aadhaar
> last-4 and IFSC. See the Rules section of the field editor in Part 7.

---

# PART 14 — Backstage: the database and deployment

You don't need this to *use* the CRM. Read it to understand why it behaves as it does.

## 14.1 Numbers

91 tables · 2 modules · 136 fields · 54 dropdown lists · 17 views · 9 layouts · 7 workflows ·
5 dashboards · 17 roles · 9 profiles · 13 users · 254 records · 50 migrations applied.

(Counts other than the migrations are from the 9 August audit and drift as records are added; the
migration count is exact.)

## 14.2 What a "migration" is

A numbered instruction file that changes the database's shape, applied once, in order, and recorded
so it never runs twice. `001` through `038` so far. They only ever go forwards — there's no undo
button, which is why they're written defensively.

The interesting ones:

| # | What it did |
|---|---|
| `001–003` | Built everything: the metadata engine, identity, the real-estate tables, automation, comms, AI |
| `004` | **Merged Contacts into Leads.** 24 contacts moved across. Every deal, booking and payment still resolved. Zero orphans. The old table was renamed, not dropped |
| `011` | Renamed the module's *label* to "Leads & Contacts" (its internal name stayed `leads`, so no link broke) |
| `012` | Added the non-Anthropic AI providers |
| `013` | The "new since you last looked" marker, and push notifications |
| `015` | Passkeys |
| `020` | WhatsApp broadcasts and sequences |
| `022` | Android call sync |
| `030` | Removed eight modules |
| `031` | Removed Projects and Activities — **copying their rows to archive tables first** |
| `032` | Field tombstones, so deleting a built-in field actually sticks |
| `033` | Stopped the seed undoing an admin's work on every cold start |
| `034` | **Shoot sessions** — a site visit: which property, and the window its photos were shot in |
| `035` | Transcription state for a visit's spoken note |
| `036` | Auto-grouped shoots, so a missed tap at the gate costs nothing |
| `037` | What the photos in a shoot are actually of |
| `038` | **Share links** — send one property to one person |

> On `031`: 207 activities and 6 projects were archived before deletion. Nothing reads those
> archive tables. They cost nothing to keep, and a wrong call would have cost a restore.

## 14.3 Deployment

Deployed on **Render**. **Every push to the main branch redeploys automatically.**

⚠️ **This is the single most dangerous thing to know about this project.** Merging a pull request
deploys, and the container runs pending database migrations as it boots. If a pending migration
deletes something, **merging deletes it from the live database.** That is exactly why the last
merge was left for a human to click deliberately.

Production differs from your laptop in three ways: it generates its own signing secret, it has
demo data switched **off** (those nine shared-password accounts must never exist in production),
and it must run behind HTTPS.

**Never point a development setup at the deployed database.**

## 14.4 Backups

`npm run db:backup` writes a dump. `npm run db:backup:verify` restores the newest dump into a
throwaway database, compares the row counts, and drops it — so you know the backup actually works
rather than hoping. `npm run db:restore <file>` replaces the live database.

Retention is 14 dumps. **Nothing runs these on a schedule yet.**

---

# PART 15 — The commands

```bash
docker compose up -d db     # start the database
npm install                 # install everything (first time)
npm run setup               # build, migrate, seed — first time only
npm run dev                 # start both servers (API :4000, web :5173)
```

Then open **http://localhost:5173** and sign in as `admin@ipropy.com` / `Admin@123`.

**Day to day:**

```bash
npm run typecheck           # must be clean before finishing any change
npm run build               # full build
npm test                    # 298 fast tests, no database needed
npm run test:integration    # makes and destroys its own throwaway database
npm run test:e2e            # drives a real browser
npm run db:migrate          # apply new migrations
npm run db:seed             # refresh the descriptions; safe to re-run
npm run db:backup           # take a backup
```

**Destructive — read twice:**

```bash
npm run db:reset            # DELETES EVERYTHING and starts over
npm run db:restore <file>   # REPLACES the live database
```

---

# PART 16 — Traps this project has already fallen into

Every one of these cost real debugging time. They're listed so they cost it only once.

1. **Stop `npm run dev` before running browser tests.** The test runner will happily reuse a dev
   server you already started — but *without* the raised request limit it needs. The suite then
   trips the rate limiter and fails in ways that look exactly like broken screens.

2. **After re-seeding from another terminal, poke a server file.** The server keeps the metadata in
   memory. Editing a file makes it restart and re-read.

3. **After `git stash`, rebuild the shared package.** Stashing leaves its compiled output stale and
   the server fails to start on a missing export.

4. **The `owner_id` shadow bug.** A few fields (owner being the important one) live on the shared
   `ipy_record` table, **not** on the module's own table. Creating a same-named column on the
   module's table doesn't produce an error — it silently *shadows* the real one, and **every record
   reads back as unassigned**. Caught by integration tests. Guarded now.

5. **Bind exactly the parameters a statement uses.** Postgres refuses a query with a bound value
   nothing references — e.g. reusing an insert's values for an update. This has bitten three times.

6. **An empty list is a value, not nothing.** Multi-select fields default to an empty list, not
   null. The conversion code special-cases this on purpose.

7. **Empty text stays empty text.** Turning `""` into null broke saving, because some columns are
   required with an empty-string default. Verified safe: both filter engines already treat empty
   and null as the same thing when you ask "is this blank?".

8. **The floating panel traps.** Three separate ones, all found the hard way:
   - Moving a panel with a CSS `transform` fights its own opening animation — every measurement
     differs, React re-renders in a loop, and it crashes with "maximum update depth exceeded".
   - The first frame used to render *invisible* so it could measure itself — but **nothing inside
     an invisible element can receive keyboard focus**, so clicking a field left no cursor. It
     renders fully transparent instead.
   - Anchor the panel to the outer wrapper, not an inner element with no box of its own — that one
     measures as all zeros and the panel lands in the top-left corner of the screen.

9. **Colours go through the helper functions, never raw.** Painting an admin-chosen colour as text
   on a tinted version of itself lands around 2–3:1 contrast — unreadable. The helpers keep the
   hue and adjust the lightness until it passes accessibility standards. There's a test that fails
   the build if this regresses.

10. **Report bugs as phone screenshots** — that's how they arrive here, and the UI should be
    checked at 390px wide as a matter of routine.

11. **A camera's timestamp doesn't say which timezone it's in.** The tag a photo carries is local
    wall-clock time with no offset attached: "09:03" means nine in the morning *wherever the
    photographer was standing*. Read as UTC in India, every photo lands 5½ hours early — across a
    day of visits that is one or two properties' worth of drift, and photos filing against the wrong
    floor. Video is the opposite: its timestamp already carries a zone and must **not** be adjusted
    again.

12. **A background worker that finds nothing configured must not spend an attempt.** The shoot
    describer retries three times before giving up. When it counted "no AI provider" as a failed
    attempt, it burned all three within three minutes of boot and marked every shoot permanently
    failed — with no error message anywhere to explain it, because nothing had actually gone wrong.
    A feature that degrades gracefully must also **wait** gracefully.

13. **Check whether a route already exists before adding one.** `POST /:module/:id/share` already
    meant "grant another user access to this record" — so new share-*link* routes at the same path
    were silently shadowed, because the first route registered wins. They answered, just not with
    the code anyone had written. Caught only by a test that got an empty list back.

14. **Clear `ANTHROPIC_API_KEY` when testing the no-AI path.** An agent session's own shell exports
    it, so a server started that way looks like it has AI configured when a normal terminal does
    not. Every "what happens with no provider" check run that way is testing the wrong thing.

---

# PART 17 — Everyday recipes

**Add a new field to Leads**
Admin → Modules & Fields → Leads → Add Field → pick a type from Part 5 → label, help text,
required?, quick-create? → Save. It's live for everyone immediately. Then Admin → Layout Designer
to decide where it sits on the form.

**Add a value to a dropdown**
Admin → Dropdowns → find the list → Add option → name it → give it a colour → drag to position → Save.

**Delete a value from a dropdown**
Admin → Dropdowns → the bin icon on that row. If nothing uses it, it goes. If records still have it,
you choose what those records should say instead first. To keep the history but stop it being picked
again, switch it to **inactive** instead of deleting.

**Create a whole new dropdown**
Admin → Dropdowns → **+** beside the search box → name it → Save. Then point a field at it in
Admin → Modules &amp; Fields.

**Stop showing the record number (LD-00003) in the header**
It is off by default. Admin → Layout Designer → the module → Record header → tick "Show the record
number beside the name" if you want it back.

**Hide prices from tele-callers**
Admin → Roles & Profiles → the Pre-Sales profile → field permissions → set the price fields to
Hidden. The values stop leaving the server, not just the screen.

**Give managers their team's leads**
Admin → Roles & Profiles → build the org chart so managers sit above their reports. Gate 3 handles
the rest automatically.

**Let the Delhi team see Gurgaon's leads too**
Admin → Data Sharing → add a sharing rule. That's Gate 4 — sideways access.

**Make a saved view**
On the list, build a filter → Save as view → name it → tick "show count". It becomes a tab.

**Turn a list into a kanban**
Switch to kanban and choose the field to group by (usually Pipeline Status). Drag cards to change
status.

**Follow up with someone on a date**
Open the lead → click Next Follow-up → pick the date. It appears in Today's Follow-ups, and it
counts toward the "least busy" assignment strategy.

**Send one message to a whole list**
Outreach → Broadcasts → choose a saved view → write the message → Start. Pause or cancel any time.

**Build a drip campaign**
Outreach → Sequences → new → add steps (WhatsApp / email / task for the owner) with delays →
enrol people. They exit automatically when they reply or convert.

**Answer common questions automatically**
Outreach → Auto-replies → new rule → *A keyword appears* → "PRICE" → your reply → test it → enable.

**Record a property while standing at it**
Site capture → say or type the details → Start. Photograph the place, then drive on.

**Ask a question in English**
Open the AI assistant, type it. Remember: it can only see what *you* are allowed to see, and it
can only use fields that actually exist.

**Import a spreadsheet**
Admin → Import Data → upload the CSV → map the columns → run. Duplicate checking and validation
apply exactly as they would for manual entry.

**Find out who changed something**
Open the record → Timeline (field changes appear inline with who and when), or
Admin → System & Audit for the system-wide log.

**Switch off a module you don't use**
Admin → Enable / Disable → toggle. It disappears everywhere but keeps all its data. Leads can't be
switched off.

**Pair your phone for call sync**
Settings → Phones → Pair a phone → copy the token → paste into the Android app.

**Connect an integration**
Admin → Integrations → **Connect** tab → pick the outcome → follow the numbered steps. Verify
tokens and webhook keys are generated for you. Saving runs a real connection test.

---

# PART 18 — Glossary, and a self-test

## 18.1 Every term, in one line

| Term | Plain meaning |
|---|---|
| **Module** | A type of thing you store. Leads, Properties |
| **Record** | One actual thing. One lead, one flat |
| **Field** | One question on a record |
| **Block** | A group of fields shown as a section on the form |
| **Layout** | How the form is arranged — sections, header chips, which tab opens first |
| **View** | A saved filter that becomes a tab above a list |
| **Picklist / Dropdown** | A list of allowed answers you control |
| **Metadata** | The description of the CRM's own shape, stored as ordinary data |
| **Lifecycle Stage** | How far into the relationship: Lead → Prospect → Customer → Past Customer |
| **Pipeline Status** | The next step in the sale right now |
| **Kanban** | The card board where each column is a status |
| **Profile** | A job description — what you may do |
| **Role** | A position on the org chart — whose records you may see |
| **Sharing rule** | Sideways access between teams |
| **Workflow** | "When this happens, if these are true, do that" |
| **Trigger** | The "when" of a workflow |
| **Task** | The "do that" of a workflow |
| **SLA** | A promise with a clock — respond within 15 minutes |
| **Assignment rule** | Who automatically gets a new lead |
| **Webhook** | An address outside services post to when something happens |
| **Timeline** | The merged feed of everything that ever happened with a record |
| **Score / Grade** | 0–100 likelihood to convert, and its A/B/C/D letter |
| **Rule engine** | The boring, always-works maths behind every AI feature |
| **LLM** | The AI model that adds reasoning and English on top |
| **Formula field** | A field that computes itself from other fields |
| **Autonumber** | A field that counts up on its own — `LD-00174` |
| **Migration** | A one-time, numbered change to the database's shape |
| **Seed** | Loading the standard modules, fields, dropdowns and demo data |
| **Tombstone** | A record that a built-in field was deleted, so re-seeding doesn't resurrect it |
| **Graceful degradation** | Losing a capability without breaking — the AI switching off, not erroring |
| **Carpet / Built-up / Super built-up** | Three real, different measurements of a flat's size |
| **PLC** | Preferred Location Charge — extra for a better-placed unit |
| **Floor rise** | Extra charge per floor as you go higher |
| **RERA** | The Indian real-estate regulator |
| **Channel partner** | An outside broker who brings you buyers |
| **Token → Agreement → Registration → Possession** | The four stages of an Indian property purchase |

## 18.2 Check yourself — twelve questions

1. Why does adding a field take zero seconds and no programmer?
2. What's the difference between Lifecycle Stage and Pipeline Status?
3. Why is there no separate Contacts module?
4. Name the four permission gates, in order.
5. What's the difference between a Profile and a Role?
6. If the AI is switched off, what stops working — and what keeps working?
7. Why can "Ask your CRM" not invent a field or leak someone else's records?
8. Why did Activities get deleted, and what replaced it?
9. What does the Android companion app do — and what can it never do?
10. Why does the public website API list its columns by hand instead of reusing the main engine?
11. What happens the moment someone merges to the main branch?
12. Why must a workflow never fire before a save has finished?

*Answers: 2.2 · 3.1 · 3.1 · Part 4 · 4.1 · 9.1 · 9.3 · 3.4 · 10.5 · 12.3 · 14.3 · 8.7*

---

## One-paragraph summary, if you remember nothing else

iPropy is a real-estate CRM whose own shape is stored as ordinary data, so an admin can rebuild it
from inside itself with no programmer and no downtime. It stores three things — the person, the
flat, the ad spend — and it deliberately stores *only* three, because the seven it deleted each
existed to hold one fact that the person or the flat could hold by itself. It knows who may see
what through four gates checked in order, enforced in the database rather than hidden in the
browser. Everything smart in it has a boring backup, so nothing ever breaks because the AI was
unavailable. And what it can't do — send WhatsApp, post to property portals, record Android calls
— it can't do because of Meta's approval process, commercial contracts, and Android 10, not
because someone ran out of time.

---

*This manual describes the state of the repository on 10 August 2026, branch `feat/field-rules`.
When the code changes, change this file too.*
