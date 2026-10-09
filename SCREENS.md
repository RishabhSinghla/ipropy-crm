# The screens a rep lives in

## Quick graphic dashboard, 7 October 2026

The main-toolbar down arrow opens a full-width overlay with content-based height
(updated 8 October 2026). Controls and charts wrap on narrower screens; the overlay
scrolls only when its content exceeds the available viewport below the toolbar,
rather than moving the record panes. The up arrow or Escape closes it. It follows the
current module, saved list, search and filters, with temporary Created Date,
Changed Date and Agent criteria (Assigned Agent or Changed By Agent).

Status, Call Log, Lost Reason and Tags dropdowns replace the four static cards
(8 October 2026). They show displayed labels with counts and filter the dashboard
together with dates and agent. Options remain available when a combination is empty;
Clear selections resets these four criteria. Saved lists and record data are unchanged.
Five compact donuts show Status, Call Log, Lost Reason, Tags and Agent; fields
missing from the module or hidden from the user are explicitly unavailable.
Tags count tag memberships and can overlap, unlike the distinct record card.
Long categorical tails are grouped as Other. Counts refresh every 20 seconds
while open and after record edits, with a manual refresh as well. These are
record counts, not a count of audit events or agent productivity scores.

## Search and completion workflow, 7 October 2026

Main-toolbar searches also match comments and notes, within the user's record
visibility. Private notes do not participate in the name-only out-of-scope
contact courtesy lookup. Search Options offers two handles and typed minimum
and maximum values for both price and size. Quick Filter dropdowns put
**Unfilled** first, with a count; selecting it filters the list to blank values.
This is a completion queue, not a new task assignment: use Bulk Edit → Assigned
To to hand the selected records to an agent, or create a follow-up normally.

Bulk Edit → **Tags** adds the chosen module tags without removing existing tags,
checks each record's edit permission, and writes change history. The live mobile
duplicate check runs for active phone fields even when a module's older duplicate
settings omit them. It matches normalized complete numbers across accessible
contact modules and shows the existing contact and owner; restricted records
remain unlinked. Leads uses a single-contact dock icon; Associates uses three.

## Duplicate mobile numbers, 6 October 2026

One mobile number now means one contact across **Leads and Inventory together**.
`mobileIdentity.ts` normalises a number to its ten national digits — `+91`,
`0091`, a leading zero and stray formatting are the same person — and
`recordService` refuses a create, an update or a restore that would give a
second live record the same number. The check locks the number before it reads,
so two people saving at the same instant cannot both pass, and it says which
module already holds it without disclosing whose record it is. Imports go
through the same door, which is why the rule is in the engine and not in a form.
Migration `190` switches the rule on; existing duplicates were left alone
deliberately, so the merge below is how they are cleaned up rather than a
deploy failing on a customer's old data.

Tools → **Merge duplicate contacts into Leads** appears above the calculators
and only for administrators. "Preview duplicate merges" groups every live record
in Leads, Inventory and Associates that shares a number (§ nothing is written).
Merging keeps an existing Lead where there is one — the most complete, then the
oldest — and otherwise creates a Lead from the group. House No. values are
joined with commas, never replaced; tags are combined and offered in Leads;
notes, calls, files, shares, favourites and history move to the surviving
record. A merged-away record is soft-deleted, never erased, and its original
values and child relationships are written to `ipy_record_merge_archive` in the
same transaction. The Lead gets a timeline note and a merge audit entry naming
the archive key.

A group previewed and then changed by a colleague is refused rather than
overwritten, a group with an active or ringing call is refused, and a group
whose relationships cannot be transferred rolls back whole — no half-merge
exists. Running it twice is safe: an already-merged group is returned untouched.
"Show CRM merge history" lists past merges with a before/after download, for
administrators only. **Ordinary record restore is not a merge undo** — restoring
a merged-away record is itself refused while the survivor holds the number, so
recovery is a supervised job from the archive.

The same operation can be run without signing in to production, through
`.github/workflows/merge-duplicate-contacts.yml`, which calls the identical two
functions; it needs the word `merge` typed into the box and prints counts only,
never a customer's name or number.

## Business calculators, 5 October 2026

The bottom of the workspace dock has one Tools icon below a horizontal divider,
in both folded and expanded modes. `/tools` offers EMI, car-loan, personal-loan,
and builder-floor additional-charge calculators. Loans use fixed-rate monthly
reducing balance, with a full schedule and final-payment rounding adjustment.
Interest is entered by the agent, not presented as a lender quote.

Property charges follow the owner's reference PDF: editable water/sewer/mutation,
electricity, stamp duty and registration-fee bases, plus custom charges. These are
reference-sheet defaults, not statutory-rate advice. The displayed area in that
sheet is rounded; its mutation total corresponds to 1,612.5 sq.ft. Use the exact
calculation area. Line charges round to rupees before subtotals.

PDF reports are generated locally and never send themselves to a client. The
offline PDF uses Latin text; Print / Save PDF supports other scripts via the
browser's renderer. Calculations do not write to CRM records or persist client
names in storage. No transactions from the owner's PDF are shipped as defaults.

## Expandable quick-filter choices, 5 October 2026

Every shared choice list offers a clickable "N more — show all" and "Show fewer"
alongside its existing search. Colour markers reserve the same space even when
an option has no colour, keeping all option labels aligned. This applies to all
fields and modules using Quick & Live Filters.

## Search and record indicators, 5 October 2026

Search Options no longer duplicates name/mobile inputs: use universal search for
those. Metadata-driven agent, location, status, contact type, call disposition,
lost reason, task/date and tag criteria use two columns, with price and size ranges
side by side at the bottom. Empty-field hints live inside their controls.
Selected tag segments are solid blue regardless of their tag's normal colour;
the header tag icon is filled blue when the record has tags. Both record avatars
are 40px. The list header highlights the active record's position on the current
page. Dock counts are totals visible to the user (favourites for the current
module, call history and WhatsApp conversations), never unread badges.
The admin audit log uses the server's readable before/after values, not raw IDs.

## Toolbar update, 4 October 2026

Universal search is a wide, rounded main-toolbar input. The current module's
Gmail-style Search Options dropdown sits inside it, independently of Quick &
Live Filters. It offers module selection, words and metadata-driven field
conditions, applied temporarily without saving a view. Quick Filters remains
available beside universal search, before Import/Export; the duplicate record-pane
and middle-header filter buttons are removed. The main header owns a higher
stacking layer so its search dropdown covers record tabs and note cards.
Import/export and list options preserve their existing permissions. The record pane no longer
duplicates those controls. Its replacement is one horizontally scrolling,
segmented strip of the current module's used tags, with vertical separators.
Tag clicks preserve the selected view and filters and reset pagination.
Tag URL hydration finishes before URL write-back, preventing a tag navigation
from oscillating. The list selector keeps its own name and does not impersonate
the selected tag. Company photo management is available from the header avatar;
only administrators can replace or remove the organisation photo. Pass the raw
photo URL to Avatar, which adds file authentication itself; adding it twice breaks
the thumbnail URL.
The former list-search browser checks now exercise universal search instead.

The split view and tags. Read it before changing how a list, a record or a tag
looks or behaves.

The rules that hold everywhere live in [`CLAUDE.md`](CLAUDE.md); this file is the detail.

---

## Tags: what they count, where they show, and which module they belong to

**19 September 2026, three reports in one message**, plus two more an hour later.
All of them are about the same thing: a tag is shared vocabulary, and every screen
has to agree about it.

* **The number beside a tag counted links, not records.** A tag whose list says
  `2 of 2 records` read **229**, because `COUNT(ipy_tag_link)` survives both
  things that take a record off a list: a delete only flags the row, and a tag
  offered on both modules carries links to the other one. The count joins
  `ipy_record` now, excludes `is_deleted`, and narrows to the module being asked
  about. Pinned in `tagsBelongToAModule.test.ts` — against the old query it read 3
  where it should read 1.
* **There is no "shared tags" split any more.** Every tag name is unique across
  the CRM and everybody can read every tag, so "mine" only ever meant who typed
  the name first. One flat **Tags** section in the picker. Lists keep their split,
  because a list somebody else built genuinely is a different thing.
* **A record's tags are chips in the header of every view, before the icons.**
  `TagChips` in `components/TagButton.tsx`, on the record page (which is what the
  table and the kanban open) and in the split view's action strip. It replaced two
  different hand-rolled chips that disagreed: the record page capped at three and
  painted a raw hex behind white text, the split view capped at two and painted
  everything brand blue. Colour goes through `Badge`, so an admin's own tag
  colour is what shows and `lib/color.ts` still guarantees AA in both themes.
* **A tag narrowed to one module must not appear on the other — and could.**
  `sale` showed on a contact although the tag is not offered on Contacts.
  Migration `154` narrowed the *picker*; it did not narrow the links already
  written, and `POST /records/:module/:id/tags` never checked. Both ends are
  closed now: the write refuses a tag this module is not offered, and both reads
  (`getRecord` and `listRecords`) filter to `cardinality(modules) = 0 OR modules @> ARRAY[module]`.
  Empty `modules` still means everywhere.

**A dialog sharing a query key with something always on screen reads a stale
list.** The tag dialog used to be the only thing asking for `['tags', module]`,
so it always fetched fresh; the chips ask for it the moment a record opens, so
by the time somebody opens the dialog the answer has been cached for a minute
and **a tag created in the meantime is not offered**, with nothing on screen to
say why. The dialog refetches on open for that reason. `splitViewHeader.spec.ts`
caught it, because it creates a tag through the API and then looks for it.

**The two dropdowns above the list read like fine print, and now do not.**
The stage breakdown (`StatusBreakdown.tsx`) and the list/tag picker
(`ListPicker.tsx`) are one size up, counts sit in chips, and the chosen row is
filled and ringed rather than half-tinted — `CHOSEN`, exported from
`StatusBreakdown.tsx` so the two cannot drift. **The per-stage percentages are
gone on the owner's instruction**: the count is the fact, and a share of an
already-filtered list is a second number to read past.

---

## The split view is the only view

**27 September 2026, the owner:** *"I am fully comfortable with split view only, so those
other views table and board completely rip it off."* Production had both switched off in
Admin → List Views already, so nobody's screen changed on the day.

What went: the table (and the phone-width card list it carried), the board, the three
view buttons, `lib/listMode.ts`, `lib/columnWidths.ts`, and three admin pages —
**List Views**, **Table View** (it only chose the table's columns; exports have their
own picker) and **Header Tabs** (production's header was on the default order, which it
keeps). The `ui.list_views` and `ui.list_columns` settings are no longer read. A saved
view still keeps its filter and sort, and now always saves `display_mode = 'ipropy'`.

* **The list request names exactly what the queue card reads** —
  `withQueueCardColumns(withQueueSubtitle(labelFields…))` in `ListView.tsx`. The open
  record's pane fetches the whole record by id, so nothing else is needed.
* **A record's own address always opens the split view** (`RecordDetail` hands over to
  `/<module>?open=<id>`). The full-width record page below it is **parked, not deleted**:
  it still holds the property photo carousel, the AI panel, the duplicate check, share
  links and the related list, which the split view does not show. Moving those in or
  deleting them is the owner's call.
* **The Layout Designer is where the split view is arranged** (Admin → Split View was
  removed on 27 September). Its **Split view** screen is the `detail` layout; its
  **New record form** drives "+ New", Capture on site and the phone app's record screen
  (quick create); **Full page form** is Inventories' full form (edit). See *The Layout
  Designer, rebuilt so every control does something* below.
* **The phone app is untouched** — it has its own screens in `src/mobile`.

The sections below that describe choosing between views are history.

## One chip, and one exception

**28 September 2026, the owner**, of the middle pane in both modules: *"contact type,
Next followup, Leads/Inventory Status, Source, Call Dissipation … All of them into Round
Chip/Box/Card In Light Colour with a Border, All chips colour will same except
Leads/Inventory Status … All chips need a line separator, And All chips also be Bolder."*

`lib/headerChip.ts` is that chip — round, `--surface-muted` behind a `var(--border)`
hairline, 13px bold — and it lives in its own file because **two components draw it**:
the key strip under the name and the call pill beside it. A second copy of one class
string is a second thing to keep in step, and the first time they disagree two chips an
inch apart stop looking like a set. Same rule, same reason, as `lib/actionCircle.ts`.

**The stage is the only chip that keeps a colour**, and that is the whole design rather
than an exemption: on that one the colour *is* the fact, which is why a queue of stages
can be scanned by hue. The source, the contact type, why it was lost, when to chase
them — each is a word, and five hues in a row leave none of them saying anything.

Three pieces made it possible without any screen naming a field:

* **`FieldValue` gained `asWords`** — a dropdown drawn as its label rather than as its
  own `Badge`. Only this strip asks for it; everywhere else a picklist still carries the
  admin's colour, which is what makes a stage readable on a list. `EditableField` passes
  it through, so the chip stays editable in place and reads back live after a save
  rather than from a snapshot.
* **`statusField` is a prop**, beside `followUpField`. `useRecordPanes` already answers
  "which field is the stage" for every screen, and a second answer is how one header
  comes to colour a different field from another.
* **The chase date keeps its words** (`FollowUpChipCell` gained `asWords`).
  Today and Tomorrow read as the ordinary chip.

**Overdue is the second exception, and the only other one.** All four tints
went with the first cut of this; he saw it and asked for one back — *"bring
the overdue red back on followup chip"* — which is the right line to draw:
the other facts on that row are states, and a chase date that has passed is a
debt. `HEADER_CHIP_OVERDUE` is the pair `FOLLOW_UP_STYLE` already used, so the
colours are not a new decision, and it is a **separate string swapped in**
rather than appended to the ordinary tone — two `bg-*` utilities in one class
list are decided by Tailwind's own stylesheet order, which this repo has been
bitten by twice.


**The separator rides on each chip's own wrapper**, as a left border, rather than
standing between them as an element of its own. The strip measures how many fields fit
by walking `box.children` and counting one per field; a divider in that list would make
it count the wrong things, and the symptom would be a header that hides a chip it has
room for.

**Two of his own earlier instructions are reversed here**, and both stay written down
rather than one quietly overwriting the other: the call pill was *"Colour Always Fix
With Dark Purple as theme button"* (26 September), and the chase date wore Today /
Tomorrow / Pending / Overdue in four tints (27 September). He has worked the screen
since; the later decision stands.

**There is no Call Disposition *field* on either module and there never has been** — an
outcome lives on `ipy_call`, one row per call. What he is naming is the **call pill**,
which reads the last call and offers the admin's own outcome list. It is on the name
line rather than in the strip for that reason, and it now wears the same chip as the
rest, which is what he was asking for.

## The photo fills the inner ring

**28 September 2026:** *"There are three lines after avatar. Please increase the avtar
size till touch inner circle first line, so that we see the picture as big as."*

It was 62% of the panel's width inside a dashed circle at 77%, so a fifth of the space
inside the rings was empty and the face was the smallest thing in its own portrait.
`DASHED_RING` in `RecordAvatar.tsx` is one number now, printed both as the dashed
circle's radius and as the photo's size, so the two cannot drift apart the next time
either is touched.

**It stops one white ring short of the dashes rather than on them**, and that is the
point of the ask rather than a detail: he counted three lines and asked the photo to
reach the first, so the first still has to be there when it arrives. Grown flush, the
photo's own `ring-2` covers the dashes and he is left with two. Measured in a browser —
the dashed circle is 86px, the photo 82px, and all three lines survive.

## Lists open on the split view

**18 September 2026, the owner's instruction:** it is the default for everybody in both
modules, and anybody may switch for themselves. `lib/listMode.ts` ranks the three sources
in one place — **this person's own choice on this module, then a saved view that
explicitly names kanban or ipropy, then the split view**. A view that says `table` is
treated as never having chosen, because every saved view predates it and says that by
default; the only way to get the table is to click it, and clicking it is remembered.

Remembered in the browser rather than on the record: it changes several times a day, it is
nobody else's business, and a per-user setting that needs a round trip to say which way you
like your list is slow at exactly the wrong moment.

**It was called the iPROPY desk until 19 September**, when the owner renamed it: *"Please
change the name of IPROPY view to split view."* The *stored* value is still `ipropy` and
must stay that way — it is the key in every saved view, in every browser that has
remembered a choice and in `e2e/auth.setup.ts`, so renaming it would make all of them read
as "never chosen" and move the whole team back to the default. Same rule as the `leads`
module still being called `leads` while the screen says Contacts.

### Everything happens in it, and nothing leaves it

**19 September 2026, the owner, at length:** *"this split view is made so that life becomes
easy and fast of the team, so no clicking of edit button, no opening of any other sort of
things, just write then and there… Never need to open any sort of page in the split view."*

So the Edit button is gone, the dialog it opened is gone, and the button beside Delete that
opened the record's own page is gone. What replaced them:

* **The whole record is fetched by id**, on the same query key the record page uses. A list
  row carries only the values the *list* asked for, so every field that is not a column
  read back blank — which is exactly why Contact Type was missing and why the card looked
  emptier than the record page. The row still stands in while the record loads, so the pane
  never blanks between two selections.
* **`surface` is `record`, not `list`.** The "editing from a list" setting exists because
  turning a value into an edit box under a cursor *on a list* is how a live mobile number
  gets changed by somebody who only meant to read it. This pane is not that: the record was
  picked out of the queue on purpose. Gating it on that setting — which ships **off** — is
  what put an Edit button there in the first place.
* **The whole cell is the click target.** `EditableField` takes the click on its own box,
  which is only as wide as the value, so on an empty field that box is a dash in the middle
  of a wide cell and a click anywhere else hits nothing. The cell forwards to the field's
  own "Change …" control, so there is still exactly one thing that opens an editor.
* **The header is the record page's header**, read from the same `layout.headerFields` an
  admin arranged, every value editable in place, plus four appended: phone, follow-up,
  status, and the module's own identifying field. The assignment field is deliberately not
  among them — it sits on the name line, between the name and when the record was last
  touched.
* **The Overview renders the layout's blocks**, so Property Information and Unit Details
  appear here exactly as they do on the record page rather than as one flat card.

**The header said "Unassigned" on every record however it was assigned**, and the cause is
worth keeping: `RecordEnvelope.ownerName` is populated by **nothing** except the phone
app's caller lookup (`assignedNumberLookup`) and global search. Neither `listRecords` nor
`getRecord` fills it in, so `active.ownerName ?? 'Unassigned'` could only ever print the
fallback. The assignment field is drawn the way the record page draws it — found by
uitype through `assignmentField`, shown by its display value, edited in place.

**The queue's second line is the module's own fact, not an id.** *"I don't need the ID
there"* — a contact's **Type**, a unit's **Unit Number** (`queueSubtitleField`). An id
identifies a row to a database and nothing to a person. `withQueueSubtitle` adds that field
to the list's requested columns while the split view is showing, because otherwise the line
is blank on any view whose columns do not happen to include it — which reads as the feature
not working rather than as a column being absent.

**Each queue row is a card, in the owner's colours** (26 September 2026, from his
mock-up). Three lines: the name with the contact-type chip beside it and a star on the
right; a blue building icon, **`H. No: <unit>`** in bold, then portion, bedrooms + category,
locality (`Single, 4 BHK Builder Floor, Greenfields Colony`), cut short with `…` rather
than wrapped; then the price in bold indigo, the size beside it, and the task chip on the
right. `lib/queueCard.ts` maps each fact to a short list of field names, first one present
wins, because Contacts and Inventories name them differently (`unit_no` / `unit_number`,
`budget` / `demand`, `portion` / `portion_type`); a fact the module lacks drops out.
`withQueueCardColumns` asks the list for all of them, and for an area's unit field too.

* **The task chip** (`lib/followUpDates.ts`): **Today** (amber), **Tomorrow** (blue),
  **Overdue (1 day / 3 months / 1 year)** (red), **Pending** (slate) for anything after
  tomorrow, nothing when no date is set. The exact date is on hover.
* **The open card** has a plum bar down its left edge, a plum name and a lifted shadow.
* **The star is a real button** that adds or removes a favourite from the list, and the
  tick box for bulk actions appears on hover or once ticked. The card, star and tick box
  are three sibling controls, never one inside another, which HTML does not allow.
* **An admin's queue line still wins.** When Admin → Split View has chosen the line under
  the name, it replaces the middle line.
* The pipeline status chip is no longer on the card; it is in the open record's header.

**A follow-up date is one tap to set, everywhere.** Any date marked as a due date, or named
Next Follow-up, shows **Today / Tomorrow / Next Week / Next Month** under its date box.
Every editor of that date is `FieldInput`, so this covers the record page, the split view,
the list's inline edit and the new-record form. In an inline edit, a tap saves at once
(`onPickNow`); in a form it fills the box and saves with the rest. Next Month keeps the day
of the month, except that 31 January becomes the last day of February, not 3 March. All of
these are local calendar days, never `toISOString()`, which in India gives yesterday's date
before 5:30 am.

**The divider drags** (`SplitHandle`), pointer events so a finger on a tablet works, with
the pointer captured so a fast drag does not let go halfway across the screen, and arrow
keys for anyone not using a mouse. The width is per browser like the view choice itself, and
clamped — a queue narrower than 240px is unreadable and one wider than 620px is a list with
a keyhole beside it. Below `xl` the panes stack and the width is ignored entirely; the
handle is `xl:block`, because a divider you cannot see is not one you can drag.

**The WhatsApp and Call buttons are icons here** (`iconOnly`), and only here. The words cost
a third of the header strip for two buttons everybody recognises by shape; the record page
keeps its labels, where there is room.

**Every spec in `e2e/` that is about the table signs in with `table` already stored**
(`auth.setup.ts`), because they are about the table. `e2e/listDefaultView.spec.ts` is the
one place the real default is proved, and it clears the key by loading, removing and
reloading — an init script clears it on the reload too, which reads exactly like the
preference failing to stick and cost a debugging round to see. It also pins the three
things above: a value typed in where it stands and read back after a reload, neither
removed button present, and the divider moving and being remembered. **The inline editor
floats in a portal on `body`**, so a locator rooted in the workspace finds nothing at all —
that cost a round too.

### Two panes, a face and a bar

**19 September 2026, the owner, against a screenshot of his own.** Ten changes, all of them
inside the split view and in both modules. What each one is, and the one thing in it worth
knowing:

* **Notes moved in beside Basic Information**, and the third pane and its divider went with
  them: *"we work only in two split panes in future"*. A note is written about what is on
  screen, so it belongs next to it rather than in a column competing for width. Beside from
  `xl` up; below that it stacks, like everything else here.
* **The header is sticky.** The name, the assignment and the tabs stay put while the fields
  scroll under them — each pane scrolls inside itself now rather than the page scrolling as
  one.
* **The white gap under the queue is gone, and the cause was a guess.** The panes were
  `calc(100vh - 13rem)`, a stand-in for whatever toolbar sits above, and it was about a
  hundred pixels out — so the queue stopped short and the page kept going. The shell now
  measures its own distance from the top of the page and takes the rest, which is exact and
  stays exact when the toolbar above grows a row.
* **The score ring became an avatar and a bar** (`StrengthBar`). The face identifies the
  person; how complete the record is is a different question and now reads as a proportion
  at a glance. **It is on the record only** — he asked for it off the queue hours later, and
  he is right about which side it belongs to: it is a fact about the *record*, and the queue
  is about the people in it.
* **The chevron at the end of every queue row is gone** — *"it been irritating"*. It pointed
  at nothing: the record opens in the pane already on screen.
* **The date and the status share one column** on the right of each queue row, the status
  under the date and ending where it ends. Two chips on two lines with two different right
  edges is what makes a queue look ragged. A row with no follow-up prints a dash in the
  date's place, so the status stays on its own line rather than jumping up one.
  **Which field that status is, is `pipelineFieldOf` and nothing else** — Lead Status on a
  contact, Property Status on a unit, found by name *or column* because production's leads
  module says `status` and has called that field `lead_status` since a rename. It briefly
  fell back to "the first field whose name contains status", and both modules carry others
  — `kyc_status` on a contact, `possession_status` on a unit, each empty on nearly every
  record. A guess that lands on one of those shows a queue of blanks, which reads as the
  feature being broken rather than as the wrong field being read. There is no fallback now:
  a module with no pipeline field has no stage to show.
  Its value is requested as a column too (`withQueueSubtitle`), for the same reason the
  subtitle is — a row carries only what the list asked for.
  **And it is a `Badge`, not a tint computed in this file.** It used to paint the admin's
  raw hex as text on a 12% wash of itself, which is the pattern the Conventions section
  names: that lands around 2–3:1, so how readable a status came out depended entirely on
  which colour somebody had picked for it. `Badge` fills the chip and `lib/color.ts`
  guarantees the pair clears AA in both themes.
  **What is not established:** the owner reported the chip missing from production on
  19 September, and it could not be reproduced here — a local database reshaped to
  production's exact field naming still drew it. So the fixes above are the two things that
  *could* produce a blank (the wrong field, or an unrequested column) rather than a
  diagnosis of what did.
* **A checkbox beside the module's name** ticks everything on the page, which is what the
  bulk-edit bar the list already carries needs in order to appear. There was no way to make
  a selection from this view at all.
* **The bare word STATUS in that header became one sorting menu** — name, the module's own
  facts, status, task soonest first. It drives `ListView`'s own `sortBy`/`sortDir`, **not a
  second ordering of its own**, or the screen and an export would disagree about what the
  list is. It briefly also chose *which* follow-ups to show and that half is gone: the
  toolbar above already has that control, and two ways to ask one question is how they come
  to disagree.
* **Assignment moved onto the name line**, between the name and *Updated …*, still edited in
  place.
* **The action icons are plain circles at the end of the name's own line** (`ACTION_CIRCLE`,
  and `round` on `WhatsAppButton` and `CallButton`). **This is the one his words and his
  screenshot disagreed about, and the screenshot won on the second pass.** They were built
  above the name, left-aligned, because that is what he wrote; he sent the screenshot back
  the same day. So: when the two disagree here, build the screenshot.
  They are one weight of grey, not one colour each — four tinted circles in a row read as
  four warnings rather than four ordinary controls.
  Two mechanical notes, both of which cost a test run. `ml-auto` inside a `flex-wrap` row
  puts them on a line of *their own* the moment that row wraps, so they are a sibling of the
  whole name block rather than the last thing in it. And `page.locator('main')` matches the
  app shell's `<main>` as well as this pane's, whose first heading is not the record's name.

* **The queue's second line is `config.listSubtitle`, and it is a *list* of fields.** It used
  to be `contact_type ?? unit_number` named in `lib/fields.ts`, which could only ever show
  one; `subtitleFieldsOf` already existed, already ordered them, and is what the table and
  the phone cards read. So a contact reads `Buyer — 304` and a unit reads its Unit Number
  without either name appearing in the code. **If a fact does not show there, the field is
  unflagged rather than the feature broken** — `probe-prod-schema.yml` prints which fields
  each module flags, and production's answer on 19 September was `contact_type` then
  `unit_no` on leads, `contact_type` then `unit_number` on properties. Only 2,476 of 22,988
  contacts hold a unit number, so most of that queue still reads `Buyer` alone: that is the
  data, not the screen.
* **The toolbar counts the page as well as the total** — `25 of 22,970 records`. The total
  alone says nothing about how much of it is on screen. It counts rows delivered, not the
  page size, so the last page says 20 rather than 25.
  **That wording is load-bearing in eleven spec files**: `/^[\d,]+ records$/` is how nine
  of them wait for a list to finish loading, so changing it turned twenty-seven passing
  tests red at once with no bug behind any of them. Anything that edits that line edits
  those specs in the same commit.

Pinned by five more tests in `e2e/listDefaultView.spec.ts`: the completeness bar **off** the
queue and still on the record, the missing chevron, the actions **measured** onto the name's
line, the select-all and the sorting menu with no follow-up section in it, and the notes
**measured** to be beside the fields rather than read off a class name — a class that is
present while the card still sits underneath is exactly the bug.

### The header is one line, and the actions beside it

**19 September 2026, the owner:** *"In the Head Tab Mobile, Budget, Next Followup, Status,
Unit Number etc. are shown in two row Please set all in one row, so that we can see narrow
header and wide Timeline etc view. If more then line should make it in dash … so that we can
choose only option from master as i need in a single line."*

* **The field strip never wraps.** It is one row, and a `…` appears at its end when
  something is out of sight — which is the cue to go and shorten the list in Admin → Split
  View rather than a silent loss. Measured with a `ResizeObserver` on the strip itself: a
  window listener is not enough, because the strip also narrows when the queue's divider is
  dragged and that moves no window.
  **It counts what fits rather than only clipping.** Clipping alone cut the last field
  through the middle of a word — "Budg…" — which reads as a broken screen rather than as a
  full line. The ones that do not fit are made **invisible rather than unmounted**: they keep
  their space, so the measurement that produced the count stays true and the count cannot
  oscillate between two answers on every frame.
  **And it sits below the whole row, not inside the name's column**, so it runs the header's
  full width and uses the space under the action icons. Nested beside them it stopped where
  they began and a third of the line was empty on every record — three fields fitting where
  six do now.
* **The name line stopped wrapping too**, which is where most of the height was going: a long
  name pushed *Updated …* onto a second row, so the header grew by a line for nothing. The
  name gives way first (`truncate`) and everything beside it holds its width.
* **The delete circle is gone.** Delete is in the three-dot menu a few pixels away, and one
  destructive action offered twice, a thumb's width from Call, is one more chance to hit it
  by accident than it is worth.
* **The favourite star saved and did not move**, which is the whole of *"favourite icon does
  not work properly in split view"*. `invalidateRecordQueries` was called without the
  record's id, so the lists refreshed and `['record', module, id]` — which is what this
  header reads — did not. The press looked like it had done nothing.
  **A mutation in this pane passes the id**, always: the header shows the fetched record, not
  the list row.
* **The action circles fill with their own colour on hover** and are grey at rest — his
  instruction, and the right way round: four tinted circles at rest read as four warnings,
  while one filling under the cursor says what it is exactly when that matters.
  `ACTION_BASE` and `ACTION_REST` are separate strings for a reason worth keeping: the
  starred state needs its own background, and `bg-amber-500` written after `bg-slate-50` in
  one class list **does not win** — Tailwind decides between two `bg-*` utilities by where
  they sit in its own stylesheet, not by the order they are typed. That is the same rule that
  made every column header in the CRM scroll away once. A state swaps the string out rather
  than trying to beat it.
* **The open record's row is marked by an element, not a border.** It was `border-l-4
  border-l-brand-600` on a row that also says `border-b border-slate-100`, and which of those
  decides the left edge's colour is the same stylesheet-order lottery as above — so the
  marker could come out slate on slate and the row looked no different from its neighbours.
  A `span` competes with nothing.
* **The header is tighter**: smaller avatar, smaller name, 8px circles, less padding above
  and below the tabs. *"Now it is comfortable, but try compact in split view."*
* **The tag icon works now** (`components/TagButton.tsx`) — *"give an operational tag icon,
  which is missing from header"*. **One component, used by the record page and the split
  view.** The cheap answer was a second copy of the record page's dialog, and two copies of
  one dialog drift: one learns about a new colour, or stops going through
  `invalidateRecordQueries`, and the same action behaves differently depending on which
  screen you were on. Moving it out of `RecordDetail.tsx` removed four pieces of state and a
  modal from the largest file in the repo.

**Two test traps this round, both of which made a spec pass while doing nothing:**

* **The token is `localStorage['ipropy.token']`, a bare string.** Two specs read
  `JSON.parse(localStorage['ipropy.auth']).token`, which is undefined, so every API call they
  made was unauthenticated — and `fetch` does not throw on a 401. `splitViewAdmin.spec.ts`'s
  `afterAll` therefore never restored the global setting it changes, and the header spec's
  tag was never created, which presented as a dialog that did not list it. `e2e/helpers.ts`
  has had the right key all along.
* **`hasText` matches a descendant's text**, so `header.locator('span', { hasText: /:$/ })`
  also caught the *name line's* "Assigned To:" — a line above by design — and the one-line
  assertion failed against correct markup. The strip carries `data-testid="header-fields"`
  and the spec measures its direct children.

### One split view for the whole team

**19 September 2026, the owner:** *"can you create a master in admin for Split view, so that
we can set key and key value for Left pane and Right pane for header and form as we had used
in table view."*

**Admin → Split View**, beside Table View and built the same way: one arrangement for
everybody, stored in `ui.split_view` as `{ module: { queue, header, form } }`, three ordered
lists of field names.

* **queue** — the line under each name in the left pane, joined with a hyphen.
* **header** — the strip beside the open record's name.
* **form** — the fields below it, in one card called Details.

**Every list left empty keeps exactly what the CRM shipped**, and that fallback is the whole
safety of the setting: the queue falls back to the fields flagged `config.listSubtitle`, and
the header and the form to the Layout Designer's arrangement. A module nobody has arranged
looks as it did before the screen existed, and clearing a list gives the fallback back
rather than a blank pane. The row is seeded `{}` for that reason — it changes nothing on the
day it lands.

Three things this cost, all worth keeping:

* **A brand-new settings key lands in the wrong category, and the symptom is a page that
  saves and reads back empty.** `PUT /api/admin/settings` inserts a key it has never seen
  with no category, so it goes to `general`; the admin screen asks for `ui` and never sees
  it again. Migration `160` creates the row under `ui` up front. **Any new `ui.*` setting
  needs the same line.**
* **A settings response that arrives after the first paint wipes what was ticked in the
  gap** — no error, nothing on screen, and it reads exactly like a checkbox that does not
  work. `SplitViewAdmin` renders nothing until the saved arrangement has loaded.
  `TableViewAdmin` has the same shape and has never been reported; it is the same bug
  waiting.
* **The queue's fields have to be asked for.** A list row carries only the columns the list
  requested, so `withQueueSubtitle` now appends the admin's own queue list when there is one
  — otherwise the line is blank on any view whose columns do not happen to include it, which
  reads as the setting not working.

Pinned by `tests/listColumns.test.ts` (`readSplitView`: an unsaved list reads as empty
rather than refusing the module, and a module with nothing chosen anywhere is dropped) and
`e2e/splitViewAdmin.spec.ts`, which does the round trip against a real browser — choose a
field, save, see it in the queue, clear it, see the shipped answer come back. That spec
writes a **global** setting, so it restores it in `afterAll` whatever happens.

---

## Which list views exist is the admin's decision

**24 September 2026, the owner:** the three views — table, board, split — are
now switched on and off for the whole team in **Admin → List Views**, beside
Table View and Split View.

* **All three ship on**, so the screen changes nothing on the day it lands.
* **The last one on cannot be switched off.** A module with no view is a blank
  page, so the screen refuses it *and* `readListViews` on the server ignores a
  row that says so anyway. Two guards, because it is the one mistake this
  screen could make that a person could not then undo from the screen itself.
* **A remembered choice that is no longer on is not a choice.** Somebody who
  picked the board last week, on a CRM where the board is now off, lands on the
  first view that *is* on rather than on a button that is not there
  (`resolveListMode` takes the allowed list; `tests/listViews.test.ts`).
* **One view left means no button strip at all** — a row of one is not a choice
  and reads as something missing.
* **It shipped broken, and the way it broke is worth more than the feature.**
  `uiSettings()` fetched a **hand-written list of key names** and handed each
  one to its reader. `ui.list_views` got a reader and was never added to that
  list, so it was read as absent every time: the screen saved successfully,
  said so, and changed nothing — which is indistinguishable from a switch that
  does not work. Nothing could see it. The reader's own unit tests passed (they
  call it directly), typecheck passed (a list of strings is a list of strings),
  and the row really was written. **Only the round trip fails**, so that is what
  `tests/integration/uiSettingsReachTheApp.test.ts` does — save it, ask the app,
  look — and it was checked both ways: it fails on the old code and passes on
  the new.
  The fix is not "remember to add the key": the query reads `WHERE key LIKE
  'ui.%'`, so it cannot fall behind a reader again. **A new `ui.` setting needs
  a reader and nothing else.**
* Stored in `ui.list_views` (migration `168`), which needed a row seeded under
  the `ui` category up front for the reason migration `160` already records: a
  new key inserted by `PUT /api/admin/settings` lands in `general`, the admin
  screen asks for `ui`, and the symptom is a page that saves and reads back
  empty. **Any new `ui.*` setting needs that line.**

---

## A record opens in the split view, wherever the link came from

**24 September 2026, the owner**, having switched the table and the board off:
*"when I use global search and open record it opens whole full record and not
like in split view … I want split view to be only opened."*

Global search, the WhatsApp screens, Save & Next and a pasted URL all point at
`/{module}/{id}`, the record page — so switching the other views off still left
half the CRM opening records full width.

* **The redirect lives on the record page, not on every link.** There is one
  address for a record and every road already uses it, so a road added next
  month is covered without anybody remembering to add it. `RecordDetail` sends
  the browser to `/{module}?open={id}` when this person's list mode resolves to
  the split view, and renders exactly as before for anybody who has chosen the
  table or the board, or where an admin has switched the split view off.
* **`?open=` may name a record the queue has never heard of.** Global search
  reaches all 22,981 contacts and the queue is one page of fifty, so the pane
  fetches by id rather than looking among the rows — and keeps that record when
  the queue refreshes under it, which is the condition that was missing when it
  snapped back to the first row.
* **A link naming a record that is gone falls back to the first row.** An empty
  pane beside a full queue reads as the screen being broken rather than as one
  link being wrong.
* **`ListView` writes the address from its own state**, so anything it does not
  name is dropped a heartbeat after arrival — which is exactly what happened to
  `open` the first time. It carries `open` and `dial` through now. **Any new
  parameter somebody else puts on a list URL needs the same line.**

---

## The number on the module switcher

The bubble on the switcher button is the count for **the screen you are on**,
the same number as that screen's row in the menu. Until 25 September it was
the total waiting on the *other* screens, so on Leads it showed Inventories'
17 while the menu said Leads 99+ — correct by its own rule, and read by
everybody as a bug. The other screens' counts stay in the menu, one per row (an amber dot beside the button was tried and removed the same day at the owner's request).

---

## The record count is a range

`51–100 of 22,981 records` on page 2 of fifty (`recordRange` in
`ListView.tsx`). It used to say "50 of 22,981" on every page. Opening a link to
page 2 also used to land on page 1: the search box's 300ms debounce ran on
arrival with nothing typed and reset the page. It only resets when the words
change now.

---

## Clicking a record keeps the list where it is

**26 September 2026, the owner:** scroll down, click a record, and the list
jumped back to the top with the chosen row out of sight. The whole split view
was wrapped in providers **keyed on the open record** — the call and the
WhatsApp composer — so every click rebuilt the view, list and all. The call now
lives in `useLiveCall` and the composer closes itself when the record changes,
so neither is keyed. The WhatsApp provider also stays mounted whether or not a
provider is connected; swapping the tree around `children` when the status
arrived rebuilt the page once more.

The open row is **unmistakable**: a solid brand fill, a 2px inset outline and a
1.5 bar down the left, the name in brand ink, `aria-current`. It is scrolled
into view with `block: 'nearest'` when it was opened from elsewhere (search, a
link, Save & Next), which does nothing to a row that was just clicked.

## The header chips: one light tone, and red when a chase date has passed

**28 September 2026, the owner**, asked twice in one day because a parallel
session reversed him in between: *"All of them into Round Chip/Box/Card In
Light Colour with a Border, All chips colour will same except Leads/Inventory
Status"*, then *"Light colour as per theme"* and *"need to update Red
overdue"*.

`lib/headerChip.ts` holds all of it, so the field strip and the call pill
cannot drift into two looks. Three tones and no more:

* **Every ordinary fact** — contact type, source, chase date — is a light
  chip with a border, in **brand steps** (`bg-brand-50`, `border-brand-200`,
  `text-brand-900`). Brand rather than slate because `applyBrandColour`
  rewrites those CSS variables at runtime, so the chips move when an admin
  changes the Brand colour; a raw hue looks identical today and stops moving
  the moment somebody picks a different theme.
* **The stage** keeps the admin's own colour from the dropdown, solid, through
  `badgeVars` — the one exception he named both times.
* **A chase date that has passed turns red** (`headerChipTone`), and that red
  is deliberately **not** a brand token: a warning that changed colour with
  the theme would stop reading as a warning the day somebody picks a red
  brand.

**Never an opacity modifier on these.** Each brand step resolves to a bare
`var(--brand-…)`, and Tailwind can only apply `/40` to a colour whose channels
it can see — so `dark:bg-brand-950/40` compiles to nothing at all, the light
rule is the only one left, and the chip stays light on a dark page. That
failure is invisible to typecheck and to every unit test;
`tests/headerChipTone.test.ts` pins that no modifier is present, which is the
closest a test can get.

**This has now been reversed once and restored once**, hours apart, by two
sessions answering the same message. The light chips and the red overdue are
the standing decision. Measured in a browser on the day: ordinary chips
`#f5f3ff` on dark violet text, overdue `#fef2f2` on `#b91c1c`, the stage
untouched. Before making them solid again, get it from him rather than from a
screenshot.

## The record hero gave a third of itself back

**28 September 2026, the owner**, with a screenshot of the middle pane:
*"Please decrease Avtar Size and Remove Buyer, Old Leads Icons … Move Overdue
(11D), Visit Scheduled & Busy in to left side from Avtar in very Light colour
as Icon colour of Call, Star, Tag … Move Name and Mobile Number at replacement
Yogesh Bindal Agent … Actually we need this space compact so that below that
much visible to my Team."*

**Measured: 253.5px before, 169px after**, on the same record in the same
window. The saving is one whole row, not padding — the chip band under the
face is gone, and what was on it moved into the column the grid already left
empty on the left.

* **The name and the number moved up** into the row that held the agent, at
  the size they already had. They are still the heading of the screen; they
  have simply stopped costing a row of their own. The agent took their place
  under the face, small, as it has read since 27 September.
* **Three chips beside the face, and only three** — the chase date, the stage,
  and the call outcome. `HeroStatusChips` takes the first two from
  `useRecordPanes` and the third is `HeaderPills`, so **no screen names a
  field** and a module without one of them simply shows two.
* **Contact type and source came off** (*"Remove Buyer, Old Leads Icons"*).
  They are still on the record's own Overview, which is where a fact nobody
  changes mid-call belongs.
* **Light, and coloured by meaning**, at `h-8` to match the action circles.
  The chase date wears `FOLLOW_UP_STYLE` — the queue's own tints, shared
  rather than copied, so the two can never disagree about who is late; the
  stage keeps the admin's colour as a wash. Nothing is solid: four solid chips
  beside a face read as four warnings, which is why the action circles are
  grey at rest.

**Two traps this cost, both the same one in different clothes.** `cn` is plain
clsx with **no** Tailwind merging, so a caller appending `px-3` to a chip that
already says `px-2.5` leaves Tailwind's own stylesheet order to choose — the
lottery that made every column header in the CRM scroll away once. So
`FollowUpBadge` gained a real `size` variant that swaps the whole string
rather than layering on it. And the stage chip first used **`.badge`**, which
is the base shape with its own padding and no colour at all; the light tint is
**`.badge-tinted`**, which sets three colours and nothing else. On screen that
read as a stage with no chip around it.

`e2e/compactHero.spec.ts` measures the promise in both modules rather than
reading a class name — the height, the name sitting above the face, and the
chips to the left of it. A class that is present while the chip still sits
underneath is exactly the bug.

### Four more the same evening, and the chip that would not shrink

**28 September 2026, the owner:** *"Can you alight vertical to horizontal of
Next followup, Lead/Inventory Status, call disposition chip in a small chip and
in a reduce font size … Move Agent name after Page Number 1/100 … decrease Font
size of Name and mobile number … move tag from left top to beside of icons of
whatsapp and call, The tag alignment should be Before whatsapp and call."*

**145px now**, against 169 after the first pass and 253.5 before either.

* **The three chips are a row**, `h-6` at 10px, sentence case. Capitals and
  wide tracking cost about a fifth of the width of every chip for no fact the
  words do not already carry, and three of them have to fit a column that is a
  third of the panel.
* **The agent sits beside the page number.** Where you are in the queue and who
  owns it are both facts about *where you are* rather than about the customer,
  so they read as one group and leave the whole right half to the name.
* **Tags lead the controls**, then the tag button, then WhatsApp and Call.
* **The grid is `minmax(0,1fr) auto auto`**, not `1fr auto 1fr`. Equal side
  columns hold the face at dead centre — and the right one holds five circles,
  so the left was pinned to their width and the third chip wrapped onto a line
  of its own. `auto` lets the controls ask for what they are and the chips keep
  the rest. Measured: 152px for the chips before, 379px after, against the
  198px they need. Below about 1100px the row still wraps, which is the
  graceful answer rather than one that leaves the panel.

**The chip that would not shrink, and it is this repo's oldest trap wearing
new clothes.** The call pill's class list said `h-6` *and* `HEADER_CHIP_SHAPE`,
which says `h-8`. `cn` is plain clsx, so Tailwind's own stylesheet order picked
between them and `h-8` won — a chip that stayed 32px tall while its classes
said 24, and an e2e failing with *"a chip is 32px tall"* against a screenshot
where it plainly was not. `HEADER_CHIP_SHAPE_SM` is a whole second string now,
and `tests/headerChipTone.test.ts` pins that neither carries the other's
height.

**And a fault of mine the specs caught:** the tag chips were first shown from
`2xl` — 1536px — which hides them from every laptop in the business. They show
from `lg`.

**Four specs measured the header this replaced.** Two that drove
`data-testid="header-fields"` in the record pane are **deleted**: that strip is
off this screen entirely now. `HeaderFieldStrip` and its count-what-fits rule
are still real and still right — the **Chats** header draws them — but that
screen needs a WhatsApp provider, and none is on a developer's database, so
**that rule is untested today.** Written down rather than quietly lost; the way
to close it is to pull the arithmetic out of the component and test it as a
function, which would prove more than either spec did. The other two were
rewritten to the new truth.

**And the face is pinned to the panel's centre** — *"Avtar shold be center
align always"*, the same evening. Two arrangements had already failed that
promise, and the third does not try to balance anything: the face is taken out
of the row and centred on the panel, so the chips on one side and the controls
on the other take exactly what they need and **neither can move it**. Measured
at 1600px and 1280px: nought pixels off centre, pinned in
`compactHero.spec.ts`.

The wrapper that centres it stops taking pointer events so the chips and
controls behind it stay clickable, and hands them back to the face — which
carries a real button, the one that replaces the photo. It is deliberately not
`aria-hidden`: that would hide the record's own name from a screen reader.

## A third module arrived and the screens were still counting to two

**28 September 2026, the owner:** *"Check the Toolbar in Associate module,
there are Followup Filter Button are missing."*

Associates carries `next_followup_at` exactly as Contacts does — it was cloned
from it by migration `175` — and still had no chase list, because the toolbar
read `moduleName === 'leads' || moduleName === 'properties'`. The field decides
now, which is the rule this repo already has for fields and had never applied
to modules.

**Eleven places name those two modules.** Two were wrong and are fixed:

* the **Follow-ups button** (`ListView.tsx`), above;
* **neighbours** (`IpropyWorkspace.tsx`), which is what *Save & dial next*
  walks — so a rep on Associates could not move through their own queue. A
  record's id is the only real condition.

**The other nine are correct and should stay.** Move-to, the Matching tab and
the server's own `targetModule` enum are genuinely about Contacts and
Inventories — a buyer matches a unit, and neither matches an associate. Two
are worth knowing rather than changing blind: `db/seed/helpers.ts` gives only
those two a **Calls tab** (seeding is create-only, so changing it reaches no
existing database), and `core/search/semantic.ts` defaults to those two, so an
associate is **not in semantic search**. Both are decisions for whoever owns
Associates.

`e2e/everyModuleGetsItsTools.spec.ts` walks every module the CRM offers rather
than naming any: a module the API says has a chase date must show the chase
list. The next module added is covered the day it exists.

### The call deck was already where it belongs

Reported in the same message — *"fix the placement of floating call deck,
before on the top of Note/Comment section in Right/Last Pane"*. Driven with a
call staged on a live record, **it docks exactly there**: top of the right
pane, above the note box and the activity stream, with no floating bar on
screen. Proved on **Contacts and on Associates** at 1600px.

So there was nothing to fix and nothing was changed. The one case where the
bar legitimately floats instead is **by design**: below `xl` the three panes
stack, so the right pane falls below the fold, and the bar is what carries the
call to wherever the rep goes. If it is seen floating on a wide window, that
is a new fault and this paragraph is the evidence it was not there on the 28th.

## A dropdown option's colour is one square and one code

**28 September 2026, the owner**, of Admin → Dropdowns: *"In the dropdown, we
don't need too much colour button, just want to easy colour picker else circle
or square box with colour code."*

Every option row carried **ten preset dots and a small picker at the end of
them** — on Call Disposition, which has 27 options, that is 270 coloured
buttons to read past before reaching the option's own name, and the dots were
only ever a shortcut to the picker beside them. The row is now one 28px square
and one code box.

* **The square *is* the picker.** A real `<input type="color">` is stretched
  invisibly over it (`absolute inset-0 opacity-0`), so the whole square is the
  click target rather than a dot that opens something. One control, not two.
* **An option with no colour is a dashed empty square, never a grey filled
  one.** Slate is itself a colour somebody may have chosen, so filling "no
  colour" with it makes the two states impossible to tell apart — and the
  placeholder code in the box beside it says what the picker would open on.
* **A half-typed code is no colour, not half a colour.** `tidyHexInput` keeps
  only hex digits and caps at six, so pasting `rgb(100,116,139)` gives
  `#B10011` rather than an error — it reads the digits out of what was pasted,
  which is the honest thing a code box can do. On blur, anything that is not a
  complete `#RGB` or `#RRGGBB` is cleared to no colour rather than saved as a
  fragment. Pinned by `tests/hexInput.test.ts` (8).
* **`SWATCHES` stayed** — it still chooses the colour a brand-new option opens
  on, cycled so two options added in a row do not arrive the same. Nobody
  clicks it any more.

**The row still wraps below about 1400px, and that is not new** — it wrapped
worse before this (the "Plain text" tick had a line of its own too). Measured
both ways at 1280px on 28 September; this change frees about 110px and the
remaining wrap comes from the preview badge, the tick, the star and the toggle,
which is a separate piece of work.

`e2e/dropdownColour.spec.ts` drives it in a real browser: one picker and one
code box per option with no preset dots left, a code typed in reaching the
server and surviving a reload, and an unfinished code clearing itself. **It
restores whatever colour it found**, and it picks a target colour that differs
from what is already stored — typing in the value an option already wears
changes nothing, so Save stays correctly disabled and the spec hangs on a dead
button. That is how it failed the first time it ran twice in a row, and it is
the same rule as the unique markers: a spec that depends on what is already in
the database reports the machine it ran on.

## Nine on the split view, and a Save & next that rebooted the CRM

**28 September 2026, the owner**, against a screenshot of the Associates split
view. Every one of them is on **all** modules — "it works on Leads" is exactly
how a module gets left behind — and `e2e/splitViewHeaderKeys.spec.ts` plus
`e2e/saveAndNextStaysInApp.spec.ts` pin the four only a browser can settle.

* **The toolbar button that is *on* is the darkest one.** It was the other way
  round: the pressed pill went lighter and took a ring. One row of purple
  pills still, so the difference is depth rather than hue — the resting ones
  are `brand-700`, the one narrowing the list is `brand-950`.
* **The open record in the queue is a step darker** (`brand-100`, `brand-900`
  in dark). It was the palest step there is, which he asked for on the 27th and
  has now worked; the later decision stands. Still a wash rather than a fill,
  so the name and the price on it keep their contrast instead of being reversed
  out to white.
* **The three toolbar buttons are Status · Task · Call Log, and none has an
  arrow.** *"so that we can See neet and clean Toolbar."* One set of words on
  every module rather than "Lead Status" here and "Associate Status" there —
  the field's own label still names it inside the panel and in the tooltip,
  which is where a module's own wording belongs.
* **The agent line says when the record was last touched** — `iPropy Admin ·
  Updated 4 hours ago`. Both are facts about the *record's* state rather than
  about the customer, so they read as one group. `hidden sm:inline`: on a
  narrow pane the name is what has to survive.
* **The name is editable where it stands.** Which field carries it is
  `module.labelFields`, never the word `full_name` — Inventories names a record
  by its unit, and an admin may rename either.
* **Every header chip is introduced by its field's own name** — `NEXT FOLLOW-UP
  Pending`, `PIPELINE STATUS New`, `CALL LOG Call Again`. Three bare words said
  nothing about which was which until you already knew the screen.
  **And the group is capped at `calc(50% - 3.25rem)`**, which is the fix the
  labels forced: the face is positioned absolutely, so nothing pushes it out of
  the way, and the third chip slid underneath it and was unreadable. The spec
  measures the two boxes rather than reading a class name.
* **An email icon sits in the icon bar when the record has an address**, and
  only then — an icon that opens a dialog which can only apologise is one a rep
  learns to ignore, and that bar already carries five. It opens the CRM's own
  composer rather than `mailto:`, so the reply threads back onto the record and
  a rep on a phone has something to write in. The field is found by uitype
  through `useRecordPanes`; no screen names a field.
* **The detail form lost a step top and bottom** — `.key-tile` is `min-h-9 py-1.5`
  and the grid `gap-y-3 py-4`. The sides are unchanged, because the value still
  has to clear the box's own hairline.
* **Double-clicking a name or a type chip in the queue opens its editor with
  the cursor already in it.** The editor **replaces the card** rather than
  sitting inside it: the card is a `<button>` with its tick box laid over the
  top precisely because a button inside a button is not allowed in HTML, and an
  inline editor is several buttons.

### Save & next was reloading the whole CRM

*"When we Click Save and Next from the Call deck, then the new window open in
same window of entire CRM instead of Next record."* It used
`window.location.assign`, so between one call and the next a rep watched the
app boot — sign-in, metadata, every chunk.

It could not simply navigate, and that is the part worth keeping. The next
record usually lives on the same `/leads` route with a **different** filter,
sort and page, and React Router keeps one `ListView` mounted across that — its
own list state then overwrites the new URL before adopting it, leaving the
selected card several pages away. The reload was the blunt way to get a clean
mount.

So the hand-off carries a stamp in the navigation's own state and `ListRoute`
in `App.tsx` keys `ListView` on it. A fresh mount hydrates the captured queue
exactly as the reload did, and nothing is downloaded again. **Only the hand-off
changes that key** — an ordinary filter, sort or page change writes no state,
so a rep working a list is never remounted under their own cursor.

**The spec had to be made to fail first, and that is how it earned its keep.**
The first version left `queueUrl` out of the staged call, so there was no next
record, Save & next saved and stayed put, and the assertion passed against the
very bug it exists to catch — the URL still changes when the workspace writes
`open=`. With the queue in place it fails on the old code with
*"Save & next reloaded the whole CRM"* and passes on the new. A mark written
into `window` is the measurement: it survives a React Router move and cannot
survive a reload.

**Two test traps met on the way**, both of which made a locator find nothing
against correct markup. `page.locator('section header').first()` catches one of
the app shell's own headers, the same trap this repo already wrote down about
`main` — the hero's parts carry `data-testid` now. And **the inline editor
floats in a portal on `body`**, so a locator rooted in the queue card finds
nothing at all; what it holds is the only honest way to find it.

**Found and not fixed:** `e2e/followUpQueue.spec.ts`'s *"a sort the person
chose is not taken away by a queue"* fails on a clean tree, so it predates all
of this — after the Task queue is opened, the sort menu's A–Z button is
`disabled`. It is a real bug and it is somebody's next job.

### The Layout Designer is named for the panes it arranges

*"Reset Layout Designer according to Split View i.e Left Pane, Middle Pane
Header, Middle Pane Form etc."* — 28 September 2026.

**Everything it arranges was already there; what it did not do was say where
each list lands.** "Summary fields" and "Left pane record fields" sat under one
heading called "Record header", so an admin had to make a change and go and
look to find out which strip they had just edited. The split view is the only
view, so its own three areas are the names now, in the order a rep meets them:

* **Left pane — the line under each name** (`queueFields`)
* **Middle pane header — main heading** (`headerTitleField`)
* **Middle pane header — key fields** (`headerFields`)
* **Middle pane — tabs**, and which one a record opens on
* **Middle pane — form** (the blocks), which had no heading at all

**No stored shape changed.** The same four lists go to the same four keys in
`ipy_layout.config`, so every arrangement an admin has already made reads back
exactly as it did — this is wording and order, not a migration.

## Five more, 29 September: arrows, two fills, a rule and a grey

**Every one is on all modules**, because every one lives in a shared component
— the toolbar helper, the queue card, the chip group, one CSS class.

* **Left and right arrows turn the page.** He first wrote *"Arrow Key doesn't
  Work for Next record or Back Record"*, then corrected himself: *"Sorry its
  arrow key from laptop for next page and back page."* So it is the pager at
  the top right — the ‹ 1 / 10 › — which until now could only be clicked.
  **Left and right, never up and down**: up and down scroll, and a rep reading
  down a long form would be thrown onto another page mid-sentence. It stands
  down for any input, textarea, select or editable box, for anything inside a
  dialog, listbox or menu, for the split view's divider (a `separator` that
  takes arrows itself), and whenever a modifier is held — ⌘← is the browser's
  own Back and must not be eaten. `e2e/arrowKeysTurnThePage.spec.ts` drives all
  of that on both modules.
  **A record-stepping version of this was built first and taken back out.**
  Two meanings for one key is how neither gets learnt.
* **The toolbar is light until something is filtering.** *"Normal Toolbar
  Button in Light Color when button not selected or inactive but if we we
  Select or active a button or filter on a Button Then Theme Dark Color … and
  text colour also change to white."* That is the third arrangement of this row
  in three days — dark throughout, then the active one darkest, now this — and
  it is the one where on and off are different *kinds* of thing rather than two
  shades of one.
* **The open record in the queue is a solid brand fill with white on it**, and
  an unopened one is an ordinary white card. Same instruction, same reasoning.
  The name and the price go white, the middle line and the area go `brand-100`
  (**not** a slate step — slate on brand is the 2–3:1 pair that `lib/color.ts`
  exists to prevent), and the type flag reverses to white, because a brand tint
  on a brand fill is invisible.
* **Vertical rules between the header's key fields.** `divide-x` on the row
  rather than a rule drawn per chip: the browser then puts a line *between*
  pairs and never before the first or after the last, so a module with no chase
  date cannot end up with a rule hanging off the end. One cost worth naming —
  a group that wraps to a second line carries its left rule with it.
* **The form's field names are grey** (`--key-label`). `--text-muted` is a dark
  plum at 7.6:1, which reads as a second heading beside the fact it labels.
* **And the header's key sits *above* its value**, added hours later with three
  samples of his own — *"Next Follow Up / Overdue (11D)"*, *"Property Status /
  New"*, *"Call Log / Busy"*. Side by side, a label and a chip on one line made
  each pair as wide as both halves, so three pairs filled the header; stacked,
  each is as wide as its widest half and the row reads as three columns. The
  row became `items-stretch` at the same time, or the rules between the pairs
  would float at the height of the shortest one. `PAIR` is one string, so the
  three cannot drift into three layouts.

**Two things the tests caught that a screenshot would not have.**

`--key-label` started as slate-500 (`#64748b`), the obvious grey. It is 4.76:1
on white and **4.31:1 on the canvas** — under AA, on the smallest text in the
CRM. `tests/color.test.ts` reads the token out of the stylesheet and checks it
against all three surfaces, so it failed immediately; `#5d6b7f` is the lightest
grey that clears all three.

And the overdue count on the Task button came out dark red on red in dark mode.
`toolbarCount` was being handed `bg-red-600 text-white` as an *extra* on top of
its own `text-brand-800`, and **`cn` is plain clsx with no tailwind-merge** — so
both colours stayed in the class list and Tailwind's own stylesheet order picked
the winner. It takes a `warning` flag now and returns one whole string per
state. Caught by the a11y contrast scan and by nothing else.

**A spec that had become a measurement of the markup, not of the promise.**
`splitViewHeader.spec.ts` found the chip group by walking `div.relative.flex >
span`, and the hero has been rearranged three times in three days — so it broke
without a single chip changing. It reads `data-testid="hero-chips"` now: an
element a spec measures carries an id, and the shape around it is free to move.

### The name card sits beside the face

**29 September 2026, the owner:** *"Move Full Name and Mobile adjoining avtar,
so that we can see Icon and Key value More Comfortable, the name and Mobile
should be in two row, first row is Name then Below/Second Row is Mobile … The
Key fileds and value should be center aligned in own seprator"*, and then, when
asked what "centre aligned" applied to: *"not whole"* — each pair inside its own
column, not the group as one block.

The name and the number used to ride the row above, sharing it with the
record's position and its agent, divided by a hairline. So the one thing a rep
says out loud when they pick up was at the far end of the header from the face
it belongs to. Beside the face and stacked, they read as a name card: who this
is, and the number you are about to dial under it. The hairline went with the
move — a rule belongs between two things on one line.

The whole operational row now reads left to right: **who this is · what you do
to them · what a call changes.**

**Each key pair is centred in its own column** (`PAIR` is `items-center
text-center`, one string for all three). The chip under a label is usually the
shorter of the two, so left-aligned it sat off to one side and the row read as
ragged.

**What a narrow pane does, and why it is the third answer tried.** With
everything on one line a 1280px window left the name about sixty pixels — it
read *"Ally C…"*, which is the one thing on this screen that has to be readable.
Letting the *chips* wrap instead stacked them three deep, made the header 180px
tall and gave each pair its own left rule down the side. So the **row** wraps:
below about 1400px the controls and the three key pairs drop onto a full-width
second line where they still read as one row, and above it nothing moves at all.
The name also holds a `min-w-[9rem]` floor.

**Four specs had to be rewritten, and every one of them was pinning a layout
rather than a promise.** `compactHero` asserted the name sits *above* the face
(it is beside it now) and that a chip row is under 34px (each pair is two lines
now); `listDefaultView` asserted the star sits below the name (they share a
row); `splitViewHeaderKeys` compared the label's and the value's *left* edges
(they share a centre). The promises underneath — the hero stays compact, the
three pairs read as one row, the controls stay on the face's row, the value sits
under its name — are all still measured, and measured on the elements' own boxes.

## The Layout Designer, rebuilt so every control does something

**29 September 2026, the owner:** *"I need a proper layout designer in admin panel
for split view … not at all properly made and usable … looks complex to use."*

**The real fault was that half of it did nothing.** Read against the code, the split
view ignored four of the controls on its own designer: the header's key fields (the
hero drew a fixed chase date and stage), the main heading field, the tabs' names,
order and hiding, and "Opens on" — the split view drew its six tabs in code. And
"Collapsed" was offered for a view that draws every section open. An admin changed
them, pressed Save, saw nothing, and reasonably concluded the screen was broken.

What it is now (`pages/admin/LayoutDesigner.tsx`, `SplitViewZones.tsx`):

* **Three screens, named for what they change** — *Split view*, *New record form*,
  *Full page form* — instead of "Detail view" and "Quick create".
* **Numbered zones in the order a rep meets them**, each with a **preview drawn from
  a real record** (*Show another record* steps through the list) and a **Default**
  button: ① the queue card's line of facts, ② the facts pinned at the top of the
  right pane (the header's chips until 30 September), ③ the tabs, ④ the field
  sections under those pinned facts (the Overview tab until 30 September), ⑤ the
  WhatsApp chat header (the one list here that is not the
  split view, so it says so).
* **Every list reorders by drag, by arrows, or from a menu.** A field on the form has a
  ⋯ menu — move up, move down, move to another section, take it off the form — because
  dragging to a section that is off screen was the original complaint.
* **The first tab is the one a record opens on.** One rule instead of an "Opens on"
  setting that could name a hidden tab.
* **Unsaved work is protected**: *Undo changes*, a confirm before switching module or
  screen, and the browser's own leave-page warning. Deleting a section asks first and
  says it goes from every screen.

**The split view reads two new keys, on purpose** (`lib/splitViewLayout.ts`):
`heroFields` and `splitTabs`. Production's layouts already carry old `headerFields`
and `tabs` values saved for the parked full record page; had the split view started
obeying *those*, every rep's screen would have changed on deploy with nobody asking.
An unsaved key means "exactly what the split view showed before", which is also what
**Default** writes — by deleting the key, not by writing today's default down, so a
later improvement to the default still reaches that module. `headerTitleField` and
`defaultTab` are no longer on the screen and are left in the database untouched.

Also on 29 September, the same message:

* **The Task button filters by agent**, like Status. `components/AgentPicker.tsx` is
  the one row of agent chips both panels draw, over the list's one agent choice, so
  picking Vijay in either narrows the list, the stage counts and the task counts
  together. It also lost a `slice(0, 9)` that made a tenth agent unpickable.
* **Agent and "Updated" sit right after the record arrows**, and the record's tags
  take the right end of that row (they used to be squeezed to 6rem beside the icons,
  and hidden below `lg`).
* **The notes box has its microphone back**, and ⌘/Ctrl+Enter now posts — the hint
  under the box had promised it with no key handler behind it. The mic is
  `useVoiceCapture`: on a laptop in Chrome, with no speech-to-text key configured, the
  browser's own recogniser types the words in as they are said; with a key, the
  recording is sent to the server and comes back as a tidied note. **Not proved:** a
  real microphone — a headless browser has none.

Driven in a browser against a fresh database: the header positions (measured), the
tag, the mic button, Ctrl+Enter posting, the task agent filter narrowing its counts
and showing the same agent in Status, and the designer round trip — add a header
fact, reorder and rename a tab, save, see both in the split view, press Default, see
them go. `callOutcome` *Save & Next*, `followUpQueue` *a sort … not taken away* and
`noteSnippets` fail on a clean main as well as with this change; they predate it.


## Four panes, like WhatsApp — 30 September 2026

**The owner's prototype** (a screenshot, a `code.html` and four written points):
*"make this UI/UX as comfortable like whatsapp UI/UX"*. A ChatGPT session started it
and ran out of credit part-way; what reached `main` from it was the flatter panes, the
face on each queue card and the **Quick & Live Filters** overlay
(`QuickFilterOverlay.tsx`). The four-pane rebuild it described had not been pushed, so
it was built here.

The split view is now four panes, left to right:

1. **The dock** (`WorkspaceDock.tsx`) — a slim column of round icons: WhatsApp in its
   own green, each module, the call log, today's tasks (the list's own Task filter,
   one tap), the dashboard and campaigns; settings and you at the foot. Every icon is a
   place that already exists — the dock moves doors closer, it copies no screen.
   `xl` and up only; below that the app's header and drawer carry the same places.
2. **The record pane** — the queue. Its header keeps the select-all, the kind filter
   and the sort menu; **the list's own chips** (All Leads, Status, Task, Call Log) sit
   under it, wrapped rather than scrolling, then an always-open search box with the
   filter and list-options buttons, then the cards, then the record range and page
   arrows at the foot. They are the same components the toolbar above used to hold —
   `ListView` builds them once as `queueTools` / `queueFooter` and hands them in.
   **The chips wrap because `Dropdown` is not portalled**: a sideways-scrolling row
   clips the panel it opens, and so does an `overflow-hidden` pane, which is why the
   queue pane is `relative z-10` without it now. With no records the workspace is not
   drawn at all, so the same chips are drawn above the empty state instead — a filter
   that empties the list must never take the way back with it.
   Each card: face, name and kind flag, *how long ago* at the top right, the number
   with WhatsApp's mark, the Layout Designer's line of facts, and the price in green
   with the size. `CardFields.phone` is found by uitype, never by name.
3. **The record** — a header of the face in its completeness ring, the name (typed
   into where it stands), *Updated …* and the tags on the left, and the queue position
   and every action on the right. Under it the tabs are **icons with counts**
   (`DeskTab`): Timeline, Matching, Files, Calls, WhatsApp — each badge reads the same
   query key as the tab it labels, so opening a tab costs nothing more. **The Timeline
   is a chat** (`ActivityFeed.tsx`): the day in a chip down the middle, the customer on
   the left, us on the right in WhatsApp's green, internal notes in amber, calls as
   cards with their recording, changes as quiet lines — oldest at the top, opening on
   the newest. Under it, fixed, the notes box (`NoteComposer`, look `dock`) with the
   quick-tag phrases above it, the mic, **Internal Note** and **Send WhatsApp** — which
   opens the WhatsApp composer with the typed words already in it
   (`compose(to, draft)`), and only where a provider is connected.
4. **The call pane** — the call deck as one slim strip at rest (*CALL DECK · Ready · No
   call in progress*), a **Quick & Live Filters** bar that opens the overlay and says
   how many are on, then **the record's fields** (`RecordInspector.tsx`), one line
   each, label left and value right, every one editable in place. Pinned first: who
   owns it, the Layout Designer's header key facts (chase date and stage unless an
   admin chose otherwise), and the call log. The number is here too when no section
   holds it, because it left the header.

**The Overview is no longer a tab** — it is the call pane. `SplitTabKey` lost
`overview`; a saved `splitTabs` list that still names it drops it, and the timeline is
the first tab. `HeroStatusChips.tsx` had no caller left and was deleted.

Two things found on the way, both fixed: the Quick & Live Filters overlay **did not
close on Escape**, so it held the whole screen until clicked; and a long word with no
spaces ran off the edge of a chat bubble.

Proved in a browser against a fresh database: the dock, the chips inside the record
pane, a note posted from the bottom box appearing in the chat, tab switching, the Task
panel opening on top of the record rather than under it, the filter bar opening the
overlay, a field edited in the call pane, and the dock navigating.

**What the full e2e run found, and fixed before this went live:** the pinned status
and chase-date boxes did not open their editor when the empty part of the box was
clicked (every other field box did) — they share one `FieldBox` now; the record
count vanished when a filter emptied the list; and the timeline's scroll region was
not reachable by keyboard. About a dozen specs were measuring the old header or the
Overview tab and were rewritten to measure the new panes — `e2e/fourPane.spec.ts` is
the one written for this layout. The Layout Designer's zones are renamed to match:
*Right pane — pinned facts* and *Right pane — field sections*.

## Twenty asks, 1 October 2026 — the filters get a master

**The owner, in one message**, after working the four panes for a day. What
changed, and the one thing worth knowing about each:

* **Quick & Live Filters is rebuilt** (`components/QuickFilterOverlay.tsx`,
  rules in `lib/quickFilters.ts`, pure and node-tested):
  * it slides in **over the right-hand pane, in its exact shape** — the pane is
    `relative` and the list hands it the panel through `filterBar.panel`. With
    no record open there is no pane, so it sits at the screen's right edge;
  * its header carries the **live record count** (`data.total` of the list's
    own query — there is no second count to disagree with it);
  * **every section folds** and opens itself when something in it is chosen;
  * a list longer than five shows its **top five, most used first, and a
    search**. Counts come from `GET /api/records/:module/facet`, which runs
    the reporting engine as the person asking and refuses a hidden field;
  * money, sizes and numbers are a **min–max slider**
    (`GET /api/records/:module/facet-range` for its ends). It asks the list
    again only when a thumb is let go, not on every pixel;
  * **Created date** and **Updated date** have Yesterday, Today, This week,
    This month and a date picker. A picked day on a timestamp is **the whole
    local day as two instants** (`localDayBounds`) — sending the bare date is
    read as UTC and shifts every day by five and a half hours in India;
  * **Task wise** is Overdue, Today, Tomorrow, **Upcoming** (new: anything
    after today) and a date. The four are the Task button's own queues, so the
    button and the panel cannot disagree.
* **Admin → Quick Filters is the master** (`pages/admin/QuickFiltersAdmin.tsx`,
  setting `ui.quick_filters`, migration `179`): show or hide each section, drag
  or arrow to reorder, rename, open unfolded, and how many values show before
  the search. **The live panel beside it is the real component.** A module
  nobody has arranged is built from its own fields (`defaultQuickSections` —
  no field is named in code), a section whose field has gone is dropped, and
  a field added later is appended.
* **The list chips are an icon and a count.** The words stay as `sr-only`
  text, so every spec and screen reader still finds "Status", "Task",
  "Call Log".
* **The Contact Type button in the queue header is gone** — filtering on any
  field is the panel's job.
* **The queue card has no phone line**, and its text is one step larger.
* **Search this record** — the magnifier before the tag icon narrows the
  timeline and the fields pane to what mentions the words, and forgets them
  when another record opens.
* **"Quick tag" reads "Quick note".**
* **The left toolbar is on every page** (`Layout.tsx`), from `lg` up, with a
  Dashboard icon and the module's "not opened yet" count on each module. Tasks
  links to `?task=today`, which the list now carries in its address both ways.
  The header's **module switcher is removed** and its **WhatsApp button shows
  only below `lg`**, where there is no toolbar.
* **Social icons are stacked**, each tucked under the next and lifting out on
  hover.
* **Ask AI is a draggable circle** (`components/AiBubble.tsx`) — a tap opens
  it, a drag moves it and does not; where it was left is this browser's.

## Fourteen more, 2 October 2026

* **Anyone may assign a record to anyone active.** The picker (`GET /api/admin/users?assignableOnly=true`)
  no longer narrows to the caller's branch, and `transferOwnership` no longer refuses a peer or a
  manager. Only the automation account is refused. Whether somebody may change a record at all is
  still `updateRecord`'s ordinary edit check. Pinned by `tests/integration/anyoneCanAssignToAnyone.test.ts`
  (it was `assignmentFollowsTheHierarchy`).
* **The record tabs say their names beside their icons**, and **Timeline is "Activity"** — on the split
  view and on the full record page. A layout saved with the old shipped word "Timeline" reads as
  "Activity" (`savedLabel` in `lib/splitViewLayout.ts`); a name somebody actually chose is kept.
* **Any activity moves "last updated".** `touchActivity` now stamps `updated_at` as well as
  `last_activity_at`, and is called for notes, files, tags and WhatsApp messages in and out; a synced
  phone call moves it too. So the queue's "2h ago", the Updated date filter and "Recently updated"
  all count a call as much as an edit (`tests/integration/anyActivityMovesLastUpdated.test.ts`).
* **The record header** shows the record's tags where "Updated …" was, and a small label saying which
  module it is (the module's own label, so a rename in Settings shows there).
* **The left list**: no contact-type chip beside the name, a soft shadow under the open record, and
  **↑ / ↓ move through the records** like WhatsApp's chat list — ignored while typing in a box, inside
  the Activity feed, or with a dialog or menu open (`isTypingOrInAPopup`).
* **Removed**: the Settings gear and the account circle at the foot of the left toolbar (Settings is
  still in the avatar menu, top right); **Share with team** from the ⋯ menus and its panel; the
  **Reassign** button on the selection bar; the **social icons** in the header and the social links in
  Admin → Brand (now just "Brand"). What stayed, on purpose: records already shared with somebody stay
  shared — no data was deleted — and the saved `social.links` row, which the public website's
  `/api/public/brand` still reads.
* **Associates wear a building icon** (migration `180`, only where the icon is still the one migration
  `175` gave it).
* **The logo is a circle** with a soft ring, and a logo the browser cannot load falls back to the first
  letter of the organisation's name instead of a broken-image box.

## Eleven more, 3 October 2026 — comments, the right pane, and counts

Eight asks in one message, then three more while they were being built. All on
Contacts and Inventories alike.

* **The notes box says *Comment*, not *Internal Note*** — the button, the feed's
  label and its filter chip. The lock icon is gone from every bubble.
* **An emoji button** beside the mic (`components/EmojiPicker.tsx`): forty
  hand-picked emoji in four rows — reactions, faces, property, work. An emoji
  lands where the cursor is. Any other emoji can still be typed from the
  keyboard; a picker of three thousand is one nobody scans.
* **Rewrite with AI** (`POST /api/ai/rewrite-note`, `ai/rewriteNote.ts`). It
  keeps the language the rep typed in — English, Hindi or Hinglish — and fixes
  the spelling and the run-on sentence, friendly rather than corporate. **The
  rewrite is shown, never swapped in**: *Use this* or *Keep mine*, and nothing
  is posted until Comment is pressed. With no AI provider (or the switch off in
  Admin → Settings → AI features, migration `181`) it still answers, with a
  plain tidy of spaces and capitals, and **says so** — "AI is not set up".
* **Comments are editable in place**, by whoever wrote them or an admin — the
  pencil on hover. Every earlier wording was already kept (`edit_history`,
  migration `107`); an edited bubble now says *Edited*, and hovering it lists
  each version and when it changed. The timeline hands the feed the comment's
  id and its history (`meta.commentId`, `meta.editHistory`).
* **Deleting a comment is admins only by default** — *"delete be allowed but to
  admins only by default"*. A new capability, `comments.delete`, under
  Roles & Profiles → Working with records, held by nobody until an admin ticks
  it. **This takes away something reps had**: until today the author could
  delete their own note. An edit keeps the old words; a delete does not.
* **The chat wallpaper** is a tile of "IPROPY" and small property doodles
  (house, key, chat bubble, star, window) drawn a few shades off the canvas,
  like WhatsApp's own — texture, not text. Its own colour in dark mode.
* **The price and size sliders take typed numbers too** — Min and Max boxes
  under the slider, committed on Enter or when the box loses focus. They read
  "50 lakh", "1.45 cr", "80k" and "12,00,000" (`parseTypedAmount`), may go past
  either end of the slider, and moving either control moves the other.
* **Call sits right after the record's name** in the middle pane's header.
* **The right pane's top rows are all the Layout Designer's now.** Who it is
  assigned to, the call log and the phone number were fixed in code, with only
  the facts between them choosable. Now every row is one entry in one ordered
  list — `rightPane` on the detail layout, with `@owner` and `@call_log` for
  the two rows that are not fields (`@` cannot begin a field name, so they
  cannot collide). Unsaved, it reads exactly as before (`rightPaneRowNames`).
  Admin → Layout Designer, zone 2, *Right pane — top rows*.
* **The right pane folds away** — a small tab on its left edge slides it to a
  thin strip marked *Details*, and a tap slides it back. The width animates and
  the content keeps its own width while it does, so nothing reflows mid-slide;
  a folded pane is `inert`. Remembered per browser. The Quick & Live Filters
  panel still opens inside it, so an open panel unfolds the pane while it shows.
* **The *Quick & Live Filters* bar left the right pane** — the filter button
  over the queue opens the same panel. That button's badge now counts every
  quick filter that is on, not only the advanced conditions, because it is the
  one place that says so now.
* **Every quick filter shows its counts** — the stage, who it is assigned to,
  how the last call went (with *Never called*), the saved lists, the chase
  queues and the date chips, as Lost Reason always did. The facet endpoint
  counts the record-level ideas too (`owner_id`, `last_call_disposition`) and
  answers `blank` — how many hold no value at all. Chips are counted with a
  one-row list query each, only when their section is open.

**Not proved:** a real model's rewrite — no AI provider is configured on the
development database, so what was driven in a browser is the fallback. On
production it depends on which provider Admin → Integrations has switched on.

**Later on 3 October 2026:** the chat wallpaper went much lighter (the IPROPY
lettering had still been drawn in the old dark tone), and the left toolbar lost
its **Tasks** and **Campaigns** icons — *"not needed here"*. Campaigns is a tab
of WhatsApp; today's follow-ups are the Task button over each list.

**1 October 2026, five more:**

* **Rewrite with AI** — *later the same day this changed again; see "The
  counter, the call deck and the rewrite" below.* It offered **Polish ·
  Shorter · More detail** and **Try again**, always rewriting the rep's own words, and says
  the true reason when no model wrote it (`reason`: `no_ai`, `no_answer`,
  `switched_off`) instead of always "AI is not set up".
* **Summarise with AI is three headings of short bullets** — *Who*, *Where it
  stands*, *Next steps to close* — on the same writing model; the default model
  was failing 25 of 30 calls and every failure cost seconds before a fallback.
  `components/SummaryText.tsx` draws it; the no-AI fallback uses the same shape.
* **The folded right pane is coloured** (a brand-tinted strip, a filled round
  arrow) and so is the tab that folds it; the field labels leave room for the
  tab. **Pressing Call on a record unfolds the pane** while that call is up,
  because the call deck lives in it.
* **Settings → Phones can delete.** Each phone has *Delete*; *Clean up old
  phones* removes revoked phones, phones that paired and never connected, and
  older pairings of a handset heard from since (`deleteStaleDevices`).
  Calls they logged stay on their records (`ipy_call.device_id` is `ON DELETE
  SET NULL`). Switched-off phones are folded away, the reachability card shows
  each person's handset once, and the install steps wait behind *How to
  install it on a phone* (their numbering read 1, 2, 3, 4, 4).
* The toast's close button has a name for screen readers.

**1 October 2026:** the **Unread Inventories** saved list is gone — *"not
needed"*. Migration `182` deletes the live row and tombstones it, so a cold
start's seed cannot bring it back; the template no longer lists it. **Unread
Leads** stays.

## The counter, the call deck and the rewrite — 1 October 2026

**The "2 / 25,458" on the first record.** The counter beside the arrows was
worked out from a cursor in a *different order* from the list (last changed,
where the list was newest added), read timestamps through JavaScript — which
drops the microseconds, so records imported in the same instant could not be
told apart — and could not compare the orderings that are not a field (agent
name, profile strength, last call) at all. Now `locateInList` in
`recordService.ts` asks the database where the record sits with a window
function over **the list's own WHERE and ORDER BY** (`prepareList`, shared with
`listRecords`), so the two cannot disagree. A record that has left the list
answers `position: null` and the header shows `—`. Every record edit refreshes
the counter (`invalidateRecordQueries`), because in a Recently updated list an
edit moves the record. Pinned by `theCounterCountsTheListOnScreen.test.ts`.

**"No sorting" is gone; the default is Recently updated** — the owner's
instruction, reversing 27 September. `UNSORTED` in `core/query/builder.ts` is
`updated_at DESC, id DESC`, and the sort button reads *Recently updated* when
nothing was chosen.

**Save & Next went missing after the first Save & Next.** The next record
rings the moment it opens, before its neighbours have loaded, so the call
froze "nobody is next". The workspace now passes `nextId: undefined` until the
answer arrives, and the deck asks for itself — from the call's own queue
(`queueContext(call.queueUrl)`), never the whole module.

**A follow-up picked on the call deck is written to the record at once**
(`chaseOn` in `LiveCallDeck.tsx`), so the right pane shows it during the call
rather than after Save. *Let the outcome decide* and *No follow-up* still
decide at Save.

**Rewrite with AI is one answer, the More detail one**, on the notes box and
now in the comment **edit** box too (with *Undo*; nothing saves until Save).
It runs on the provider's quick model (`fast: true`): measured on production,
Gemini Flash-Lite answered in about 1.4 s, the writing model in about 6 and up
to 10. `.github/workflows/ai-failures.yml` now prints each model's median and
slow answer times.

## Five more and a fold, 1 October 2026 (evening)

* **The Hot chip.** The toolbar's call-outcome chip is gone — the last-call
  filter is still in the filter panel — and in its place is a flame and a
  count: the module's own **tag** called "hot" (`hot`, `Hot Lead`, `hot
  leads`; production's is `hot`, offered on all three modules). One tap shows
  only those records, a second shows everybody. A module with no such tag
  shows no chip. `components/HotTagChip.tsx`; the count is the tag list's own.
* **Lost needs a Lost Reason, on every module.** This reverses migration
  `176` (28 September), on the owner's instruction. One rule,
  `missingLostReason` in `@ipropy/shared/lostReason.ts`, used by the server
  (`validateRequired`), the full form and the inline editor:
  - the stage field is the one stored in the `status` column, the reason
    field the one on the `lost_reason` dropdown, and "Lost" is any stage
    value containing the word (Leads stores `Lead Lost`);
  - it asks only when the stage is being **set** to Lost, or the reason
    cleared — an old Lost record can still have its number fixed;
  - picking Lost inline opens *"Why was it lost?"* with the reasons as
    buttons, and both are saved together;
  - a Lost record with no reason shows its Lost Reason box ringed red
    (`owesLostReason`).
  Migration `176`'s guard against a `requiredWhen` on Lost Reason stays: the
  rule is built in, not a per-field setting somebody can half-configure.
* **The module badge sits just left of the record counter** (`LEADS · 1 / 25,458`).
* **Call outcomes store what they show.** Four stored a different word from
  their label (`Busy` showed "Busy/Ringing"; `Call Not Picked`, "Call Back
  Request"; `Interested`, "Call Connected"; `Invalid Number`,
  "Invalid/Wrong Num"). `align-picklist-values.yml` with `only:
  call_disposition` renamed the stored words to the labels — calls, saved
  lists filtering on the last call outcome (new: `SYSTEM_FILTER_FIELDS` in
  `picklists.ts`) and tombstones included — and **no other dropdown**. The
  outcome cards know both words, and whether anybody answered is read off the
  card (`nobodyAnswered`), not a list of words.
* **"Pending" is "Upcoming".** A follow-up after tomorrow reads Upcoming;
  "Pending" read as late. The deck's auto choice with nothing booked says
  *Set by the outcome*.
* **The left toolbar folds** like the right pane: a brand tab on its inner
  edge folds it to a slim *Menu* strip, the strip brings it back, the width
  slides and the icons fade. Remembered per browser (`ipropy.dock.folded`).
  Pinned by `e2e/workspaceDock.spec.ts`.

## One pattern on a phone, a tablet and a laptop

**2 October 2026, the owner:** *"Can you resign web app and android app
according to my current UI/UX, I want to make is as simple as GMAIL/WhatsApp
App with all function and filter system … a ten year child can be use this app
and we can use Web app, Safari app, Android app in same format."*

**The CRM had two designs, and that is what he was describing.** A browser got
the split view; the installed app got a different set of screens in
`packages/web/src/mobile/`. And the split view itself **stacked** below `xl` —
queue first, record under it — so a phone browser had to scroll past fifty
records to reach the one it had just opened.

Gmail and WhatsApp are not two designs. They are **one**: a list, you tap a
row, the item fills the screen, you come back. On a wide screen the list stays
beside it, which is the same pattern with room for both. So that is what the
split view does now at every width:

* **`showing` is `'list'` or `'record'`**, and below `xl` only one pane is on
  screen. Both stay **mounted** — hidden, never unmounted — so coming back
  keeps the queue's scroll position and does not refetch the record.
* **The way back is the arrow every phone app puts in that corner**, labelled
  with the module (`‹ Leads`), and it is `xl:hidden`: on a laptop the list
  never went anywhere, so there is nothing to go back to.
* **The shell is a full-height row at every width now.** It used to be
  `min-h` and a column below `xl`; each pane scrolls inside itself on a phone
  exactly as it does on a laptop.

**Three faults came out of doing it, and each is the kind only a browser
shows.**

* **The third pane ate the screen.** The call deck and notes pane is
  `w-full shrink-0`, so once the shell became a row at every width it took all
  390px and the record was drawn underneath it. The record and that pane are
  **one column on a phone and two on a laptop** now — the record, then the
  call deck and the notes under it, scrolling together. Two panes side by side
  on a phone show neither, and two scrollers on one screen is the complaint
  already written down about the WhatsApp tab, so the record's own inner
  scroller is `xl:overflow-y-auto`.
* **Then the record collapsed to a few pixels.** Inside a scrolling column a
  child with `flex-1 min-h-0` is free to shrink to nothing, and it did. It is
  `shrink-0` with its natural height below `xl` and a filling column above it.
* **The list's phone pager stayed on screen under the open record.** It
  belongs to the list, so it stands down while the record has the screen —
  `onShowing` is the one prop the workspace hands back for it.

**And the name truncated to "Header Keys ]".** Sharing one line with the
controls on a 390px screen, the heading gave way first — the same fault the
chat header met once. The header wraps below `xl`, so the name keeps the first
line and the controls take the next. `e2e/onePatternEverywhere.spec.ts`
measures `scrollWidth - clientWidth` on the heading rather than reading a
class, and walks list → record → back on **both** modules at 390px, plus the
laptop still showing both panes with no Back control at all.

**Still two designs, and this is the honest half that is left:** the installed
app's own screens in `packages/web/src/mobile/` are untouched, so Android still
opens those rather than this. Pointing the app at the same routes is the next
step, and it is now worth doing — before today there was nothing on a phone
browser worth pointing it at.

## The left toolbar says what each icon is, and how big it is

**2 October 2026, the owner:** *"Left Toolbar Whatsapp icon Shift to Below Call
and Dashboard icon on top all icon have their names also with record counts and
the unread feature disables from all modules's toolbar, the toolbar also have
hamburg function before ipropy company name."*

* **His order:** Dashboard, then the modules a rep works, then Calls, then
  **WhatsApp at the foot** — it used to sit on top in its own green circle.
  It keeps the green, because that is how a rep finds it without reading.
* **Every row is an icon, a name and a count.** The dock was a column of round
  icons at `w-14`; it is `w-52` with a label on each row, and still folds to
  the same slim strip.
* **The count is the module's own size, not an unread badge.** "Not opened
  yet" is a number only the CRM cares about. `GET /api/record-counts`
  (`core/entity/recordCounts.ts`) answers it **through `recordScopeSql`**, so a
  rep sees how many records *they* can open — a toolbar that says 22,988 to
  somebody who may open 300 is a number that teaches people to ignore the
  toolbar. Five minutes stale on purpose: it is a sense of size, not a live
  figure, and refetching it on every edit would cost one query per module.
  A count of nothing is not drawn at all.
* **The hamburger beside the company name folds the toolbar.** It was
  `lg:hidden` — the phone drawer's button. It is on every screen now and does
  whichever navigation that screen has: the drawer on a phone, the toolbar from
  `lg` up. The fold state moved up to `Layout` so the header and the toolbar
  read one value rather than two that drift.

`e2e/workspaceDock.spec.ts` pins the order, that every row carries a name, and
that the Leads count **equals the list's own total** — read off the live page,
so it cannot pass against a number the CRM invented.

### Three more from the same message

* **The agent's name and designation sit beside the avatar** — *"in the avtar
  of Agent on main Screen please give a option of agent name and Designation of
  agent."* The corner was a face and nothing else, so on a shared machine the
  only way to find out who was signed in was to open the menu. The designation
  is the user's **role**, which is what the menu's badge has always shown.
  `hidden sm:flex` on the words: on a phone the face alone is right.
* **A filter's icon takes its own colour once that filter is on** — List blue,
  Status yellow, Task green, Tag red (`filterIcon` in `lib/toolbarButton.ts`).
  **Only the icon**: the pill keeps the look he set on 29 September, so this is
  a mark *inside* the selected button rather than a fifth arrangement of the
  row. Off, the icon inherits the pill's own colour — four tinted icons at rest
  read as four warnings, the same reason the record's action circles are grey.
  The 300 steps are chosen because each clears **3:1 on the solid fill** —
  measured 4.3, 4.9, 4.7 and 3.7 — and an icon nobody can see on the button
  they just pressed is worse than no colour at all.
  **One button carries two of the four**: the picker chooses a *list or a tag*,
  so it is red when a tag is narrowing the list and blue when a list is.
* **Enter posts the comment; the mouse sends the WhatsApp** — *"default Posting
  a comment should work from enter tab of keyword and Send whatsapp msg from
  Mouse."* The two ways out of that box are deliberately different gestures
  now: the keyboard writes to the team, the mouse writes to the customer, so
  nothing a rep types can reach a customer by accident. **Shift+Enter is still
  a new line**, which is what every chat box does and what a rep's hands
  already know; ⌘/Ctrl+Enter keeps working because the hint promised it for
  weeks.

**And the contrast scan caught the toolbar's own green.** WhatsApp's `#0B8043`
on the dock's `#f0f2f5` is **4.48:1** — under AA by two hundredths, on a row
that is now words rather than a filled circle. It is `#0a7038` there. The
filled circle elsewhere keeps the real green, because white on it is a
different pair.

* **A selection can be handed to another agent in one go again** — *"in the
  bulk edit of Inventory, please provide Assignto option from bulk adit
  feature."* The standalone Reassign button went that morning as a duplicate,
  and the bulk-edit field list was written to leave owner fields out with it.
  Handing twenty units to one agent is the job that button was doing, so it is
  back where it belongs: beside every other field a selection can be changed
  through, **on every module** rather than only Inventories.
  Nothing was needed on the server — `owner_id` is already `mass_editable` on
  all three modules and `massUpdate` writes it through `recordService`, so
  permissions, validation and the audit trail apply unchanged.

### The record's two bars became one, and the header gave up two icons

**2 October 2026, the owner**, the last two of the same seven: *"Please Make
Menu tab Drag and drop in menu bar, so that user can set menu button and they
can choose button as per their priority and if button too much, then 'More
hamburger' will be shown in ment bar … And all tab of activity move/merge in to
menu bar i.e All, Comment, Messages, Calls, Changes, Files and after selection
of a Tab please give a option to make New call/Post Comment/Add New files/Send
New whatsapp/Send New SMS under menu bar of selected tab in History Pane"*, and
*"after the Resign Middle Menu bar then the extra icon of Header also will be
remove from header like, Star, Tag icons."*

**The record had two rows of buttons and they disagreed.** The pane's own tabs
said Activity · Matching · Files · Calls · WhatsApp; the activity stream
underneath carried its own chips — All · Comments · Messages · Calls · Changes ·
Files. So **Calls and Files appeared twice, two rows apart, meaning something
different each time**: on the top row a screen of its own, on the bottom row the
stream narrowed. That is the duplication he was looking at.

One list now. An entry is either a tab that draws its own screen
(`timeline`, `matching`, `files`, `calls`, `whatsapp`) or the stream narrowed to
one kind of thing that happened (`comment`, `message`, `audit`). `ActivityFeed`
takes its filter from the bar and draws **no chip row of its own** when it is
given one — the record page's own Activity tab, which has no merged bar, still
gets the chips.

* **The order is the rep's own, and it is dragged.** `lib/recordMenu.ts` holds
  the model — pure and node-tested (11 tests), because the arithmetic of a drop
  is where this goes wrong and reading the code never finds it: a drop landing
  one place short is the classic. Saved per browser per module, the same
  reasoning as which view a list opens in and how wide the queue is: a rep who
  lives in Comments and a manager who lives in Changes are both right.
* **Five on the bar, the rest under *More*** (`ON_THE_BAR`), which is what his
  screenshot drew — *"Items 1 to 5 are pinned to middle bar / Items 6 to 10 live
  under More"*.
* **Alt and an arrow key moves an entry too.** Dragging is a mouse, and an
  arrangement a keyboard cannot reach is one half the team does not have.
  **Promoting from the *More* list is a button, not a drag**: dragging out of a
  floating panel is not something a browser does reliably — the panel closes on
  the first pointer move.
* **A saved arrangement is cleaned against what the module offers.** Anything
  stored but no longer there is dropped, anything new is appended. Same rule as
  `arrangeHeaderTabs`, applied per person rather than per organisation: a module
  that loses its Matching tab must not leave a dead button, and one that gains
  an entry must not hide it from everybody who has ever dragged anything.
* **The counts come out of the answer the bar already has.** Comments, Messages
  and Changes count the same `['timeline', …]` request the tabs do, so a badge
  and the list it labels cannot disagree and nothing is asked twice.

**What each section lets you *start*, under the bar** — and only where the
screen below does not already offer it. Comments and the stream get **Post a
comment**, which puts the cursor in the note box already at the foot of the
stream rather than opening a second one (two places to type is two drafts to
lose), plus **Send WhatsApp** when the record has a number. Calls gets the call
button. **Files and WhatsApp get nothing**, because Files opens on its own
*Upload file* button and WhatsApp on its own message box, and a second button
two centimetres above the first is how a rep learns to trust neither.

**And there is no "Send New SMS" row, which he did ask for.** This CRM cannot
send an SMS — there is no provider, no route and no queue — so a button there
could only apologise, which is the rule the dead End button on the call console
already answers to. Said plainly rather than built as decoration.

**The star and the tag icon left the header** (item 7). Neither *function*
went anywhere: both are rows in *More actions*, a few pixels to the right, and
the tag **chips** still sit under the name — what he asked to be rid of is the
icons, not the facts. `TagButton` gained a controlled `open`, because a menu
panel unmounts the moment it closes and a dialog living inside it would close
with it; the dialog sits outside the panel and the menu row opens it.

Pinned by `e2e/recordMenuBar.spec.ts` — five tests **on both modules**, since
*"All changes should be in all Modules"* is the one way a module gets left
behind: five on the bar with a *More* behind it, the stream's second chip row
gone, the action row putting the cursor in the right box, an arrangement
surviving a reload, and the star and tag reachable from the menu while absent
from the header.

## Seven more, and a record you can ask for — 3 October 2026

### The filter can find what nobody filled in

*"in the quick & Live filter we need unfilled Data of the form, which are not
filled by my agent, i want to see those dat as empty/none in the filter list
with record count."*

**The server has always counted them and nothing ever offered the choice.**
`fieldFacets` answers `blank` beside the values; the panel read it and drew
nothing. So the one question a manager actually asks of a half-filled form —
*who has not done this* — could not be asked at all.

Every dropdown section now ends in **Not filled in**, with its own count, under
a hairline. Three decisions in it:

* **It is never cut from the list and never hidden by the search.** It is last
  by definition — a field nobody filled in still ranks below five common
  values — so in the ordinary list it would sit past the *"search to find one"*
  line on every field with more than a handful of options.
* **Offered only when there is something to find.** A row reading "Not filled
  in 0" on every field is the noise that teaches people to skip the panel. It
  stays while it is ticked, or un-ticking it would mean reopening the panel.
* **Ticked with real values, it becomes an OR**: *status is New or Hot, **or**
  it was never filled in*. As two AND conditions it would ask for a field that
  is both a value and blank, which matches nothing — and reads on screen as the
  filter being broken rather than as the wrong question.

`EMPTY_PICK` is a sentinel (`__ipropy_empty__`), not a value anybody can store:
no picklist option may be blank and `coerceValue` writes `''` for cleared, so it
cannot collide with something a rep chose. **The stage breakdown goes through
the same translation**, rather than building its own `in` condition — a second
reading of one tick is how two filters come to disagree.

### One More on the record, and it measures the bar

*"the Three dot of Dropdown fields (Star, Tags, Summarise withAI, Move to,
Delete recored) Please move/merge all in to More button in the Menu bar … if
Menu bar is full otherwise all menus shown in toolbar till hidden/overlapping …
also remove the whatsapp icon and Search icon from the Middle header pane."*

There were **two** More buttons a few pixels apart — the menu bar's, and the
header's three-dot circle. There is one now, on the bar, and the record's own
actions are rows in it under a rule. Search moved in with them as a row; the box
still opens where the icon was, because that is where a rep is already looking.

**`ON_THE_BAR = 5` is now only a starting guess.** How many buttons the bar
carries is measured, so a wide screen shows eight and a narrow one shows three —
*"till hidden/overlapping"*. The widths come from a **hidden row that never
changes**, not from the buttons on screen: measuring the real ones oscillates,
because hiding a button frees the width that said to hide it, which says to show
it again, every frame. At least one always stays, since a row that is nothing
but a More button says nothing about where you are.

### The note box opens when you reach for it

*"Quick Note option in Middle pane Bottom should be auto open/close by mouse
hover."* It stood open all day with its phrases row above it, which is two or
three lines of timeline gone on every record. Folded it is one line — *Write a
note…* — and the mouse opens it.

Three things keep it from eating somebody's work, and each is the bug that would
otherwise be reported: **a draft holds it open** (half a sentence typed and a
mouse moved away is not a reason to fold the box it is in), **focus holds it
open** (or reaching it with Tab would close it), and **a tap opens it** (a phone
has no hover at all, and would otherwise have no note box).

### Both panes start closed

*"the Right Pane Detail Form Window are by the default close, when we Refresh or
Login to CRM, if we need i will open it, same are in the Left Toolbar pane."*

So neither is remembered any more — deliberately, unlike the divider's width.
Opening one is a decision about the record in front of you, not a standing
preference, and a pane that reopens itself on every sign-in is the thing he
asked to be rid of. Both stay open for as long as the tab is; a refresh starts
clean. The stored keys are left in place: nothing reads them, so bringing this
back is code rather than data recovery.

### A folded toolbar is still a toolbar

*"in the left Tolbar apne when we close the window the the Icons of Module
should be show instead of plane, But When we open the toobar Then Icons and
Module Name will be show."* It folded to a 28px strip with the word MENU down
it, so finding anything meant opening it first. Folded it is `w-14` and carries
every row as its icon, named on hover and for a screen reader, with the round
chevron at the top. **One list of rows, drawn two ways** — two lists would be two
things to keep in step, and the way that drifts is a module appearing in one and
not the other.

### The tags worth seeing, on the top bar

*"i need to quick see tags of 'For Sale, For Rent, Visit Done' in the main
screen … at the top of Main Toolbar after IPROPY Company name, The Tag Designed
will be in Card format … Click and filter/Show tags Data as per modules
accordingly."*

**No tag is named in `TagCards.tsx`.** The three he listed are his tags today,
and writing them in would mean the first tag an admin adds could never appear —
the exact mistake `useRecordPanes` exists to prevent. The bar shows the **three
most used**, which is what makes his three rise to the top of a real database on
their own and what makes a new tag arrive the moment the team starts using it.

* The count is the tag's own `usage_count`, already narrowed to live records of
  the right module since the fix of 19 September.
* A card opens **the module the tag belongs to** — the one on screen when the
  tag is offered there, so clicking from Inventories does not jump to Contacts.
* **A second click clears it.** A card that can only narrow is a dead end, which
  the queue's own type filter already taught this repo once.
* Colour is the admin's own through `badgeVars`, drawn with `.badge-tinted`
  rather than `bg-[var(--badge-bg)]` — the dark theme's values are separate
  properties selected in the stylesheet, so writing the light one into a class
  is perfect in light mode and unreadable in dark.

**The bug the browser found:** the card worked and the address did not survive
it. `ListView` rewrites its own URL from its state, and a parameter that effect
does not name is dropped a heartbeat later — so `?tag=` vanished and the card
read as doing nothing. It is named now, beside `task` and `open`, which exist
for the same reason.

## A record you can ask for

**3 October 2026, the owner:** *"When an Agent/user search any thing from the
search then he didn't see the record, bcoz he is not actual owner of this record
… i need a solution that if the agent/user search the any thing, then system
will display the record name on the screen and if agent want to access the
display record, he can ask to actual owner of record for the permission to
assigned him, Now The actual user can change the owner of record."*

A rep typing a customer's name got **"No matches"**, which is indistinguishable
from the customer not existing. So the rep creates them again, and now two
people are working one buyer.

**Half of this already existed and only for numbers.** `assignedNumberLookup`
has answered a phone-shaped search since September — *"already ours, assigned to
Priya"* — carrying a name and an owner and **no record id**, so there was
nothing to ask about. `outOfScopeMatches` does the same for words, and carries
the id for one purpose: ringing the doorbell.

What keeps it from becoming a way to browse the database:

* **A name, the module, and who owns it. Nothing else.** No field values ever
  travel on a restricted hit, so a mobile a profile masks is never re-served
  through the search box. `getRecord` still refuses the id, which the
  integration test proves rather than assumes.
* **Only what the words actually match**, through the same search clause the
  ordinary pass uses — there is no "list everything" shape of this query.
* **Two characters at least**, so one letter cannot sweep a module; **five at
  most**, however many match.
* **Modules this profile may view at all.** A module somebody is shut out of
  stays shut; this is about the *record* scope inside a module they work in.
* **Logged** — who searched and how many were revealed — so it can be audited
  rather than taken on trust.

**Worth saying plainly, because it is the trade he asked for:** a rep can now
confirm that a name or number is in the CRM, and who holds it, without being
allowed to open it. That is the point — it is what stops the duplicate — and it
is also a little more than a private module gave away yesterday.

**Granting is an ordinary reassignment, not a second kind of permission.** There
is no grant flag and no row that quietly widens somebody's scope: approving
writes the new owner through `recordService.updateRecord`, so field permissions,
validation, workflows and the audit trail apply exactly as if the owner had used
the assignment field by hand. A permission system with two doors is a permission
system with one door nobody has read.

* **One open request per person per record** (a partial unique index). Asking
  twice is the same person still waiting, and a queue full of duplicates is how
  an owner stops reading the queue — so the second ask notifies nobody.
* **The record's *current* owner decides**, not whoever it was addressed to: a
  record reassigned since the ask is the new owner's to give away.
* **The answer is on the record, not in a queue of its own**
  (`AccessRequestBanner`), because that is where the decision is made — the
  owner opens it, sees who is asking and why, and hands it over or keeps it. A
  separate approvals screen is one more place to remember to look.
* **A rep who can merely read the record is never told who else wants it.** The
  server answers an empty list to anybody but the owner and an admin.
* Both people are notified through `notify()`, so the row reaches the bell *and*
  the phone.

Migration `183`. Proved by `tests/integration/askTheOwnerForARecord.test.ts` (7)
against a real database: the record is named but refused, asking twice makes one
request, a stranger cannot answer their own, granting really moves the record,
and an answered request cannot be answered again.

## Ten on a screenshot, 3 October 2026

He worked the live screens and numbered what he saw. Four are faults, six are
decisions; all of them are on Contacts and Inventories alike.

* **The tag card counted the wrong records.** *"The for sale record count is
  display wrong, this should be actual as tagged in inventory."* `GET /api/tags`
  with no module counts every record carrying that tag **across the whole CRM**,
  so a card that opens Inventories was printing the Contacts rows in with them.
  The server narrows the count when it is told which module to count — it was
  simply never told. The cards ask per module now, and a tag offered on both
  appears once rather than twice with two different numbers.
* **The stage button left the queue header.** *"it is already in the Quick
  Filter."* Only the button: `stagePick` is still the list's state and the panel
  still sets it, so a saved link naming a stage still narrows the list.
* **The record's tags moved up beside the name**, after the call icon. The name
  still gives way first — it has a floor, because three characters of the one
  thing that has to be readable is the fault this header has already met.
* **The module's name left that header.** It arrived on 2 October and he has now
  worked the screen: the left toolbar already says which module is open.
* **Commas narrow the search.** *"we can filter any values from this filter as
  many as by given comma, i.e 2 BHK, 50L, For Sale, Neharpar."* `buildSearchClause`
  reads the box as a list of things that must **all** be true, each matched the
  way one search always was. Typed without a comma it behaves exactly as before,
  which matters: every saved view, link and spec that passes a plain phrase keeps
  its answer. Splitting inside one `to_tsquery` would not do — "2 BHK" and
  "Neharpar" live in different columns of the same row, and one tsquery over the
  lot would demand they live in the same one.
  **And the answer sits under the box it is about.** A search that finds nothing
  used to replace the whole workspace with a page-sized panel in the middle of
  the screen, a long way from the words just typed. It is a line under the search
  box now, with **Clear search**, and it names the comma trick — that is the
  moment a rep is most likely to read it.
* **"Comments" is "Notes"**, which is what the box at the foot of the record has
  always called itself; one thing with two names is one thing to learn twice.
  **And the chosen menu key is a solid brand pill** rather than a 2px underline,
  which is easy to lose along a row of eight. The count chip rides on whichever
  fill the button wears — a slate chip on a brand pill lands around 2–3:1.
* **The queue card said the house number twice** — "A-2029, A-2029". Two fields
  on that module hold it and both are flagged for the line. `oneOfEach` dedupes
  what is drawn rather than what is arranged: which fields the line shows is an
  admin's decision and this is not the place to overrule it, but **the same words
  twice in one sentence** is wrong however it is set. Compared without case or
  spacing, because "A-2029" and "a-2029 " are one fact to a person.
* **The agent's name is the third row's right edge.** `withQueueSubtitle` asks
  for the assignment field now, or the line would be blank on any view whose
  columns leave it out — the same trap the subtitle met. The name truncates
  first: the money and the size are what a rep scans that row for.
* **A note is a white card with a header line.** *"rich white background, and the
  update date also will be in new style so that we can see date, agent name and
  Note in easily and simple Manner."* It was cream on a cream canvas, which is
  the one combination that makes a card stop reading as a card. Who and when sit
  above the words for a note; a chat bubble keeps its clock in the corner, where
  every chat app puts it.
  **And the imported notes stopped showing their own HTML.** Thousands came
  across from Vtiger as `<div><strong>…`, and the stream drew them as a wall of
  tags with the sentence buried inside — his second screenshot.
  `RecordDetail` has sanitised and rendered these since the import; the activity
  stream simply never did, and now calls the same `sanitiseRichText`.
* **The strength ring is a bar under the name, and the face is the control.**
  *"Remove camera icon from Avtar but function will remain same even more
  function also appear after clicking of avatar i.e Preview, Upload, Remove,
  Replace."* Four circles and a pill around a photo is a lot of drawing for one
  number. Clicking the face opens Preview / Upload / Replace / Remove, and the
  **queue card's face does the same** — it shows the record's own photo there
  now rather than initials. It sits outside the card's `<button>`, a sibling: a
  button inside a button is invalid HTML and a screen reader cannot reach the
  inner one, which is why the tick box and the inline editor live out there too.

### Nine more, the same evening

He worked the screen again. All of it is on Contacts and Inventories alike, and
`e2e/ownerNineOctober3.spec.ts` drives every promise twice for that reason.

* **The Hot chip left the queue toolbar.** *"Now i need to remove hot tag/Icon
  from Left Record Pane after the List and Task Icons."* Tags are cards on the
  main toolbar beside the company name since this morning, so a third pill here
  was the same question asked in two places. `HotTagChip.tsx` was **deleted**
  rather than left behind unused, and the proof that a tag reaches the server as
  `record_tags` with `has_any` moved onto the cards — it was the only thing that
  spec was really guarding, and a tag sent as a field name is silently refused.
* **The two pills that stay say their own names again** — *"Also Show the name of
  all icons 'All Leads/Inventory, Followup, Tag Name (hot)' in the record left
  pane."* This reverses the icons-only row of 1 October; he has worked both and
  the later decision stands. The list button already printed the **tag's** name
  whenever one was narrowing the list, which is the third name he asked for.
* **Tags left the list picker** — *"also remove tag list from the dropdown of
  this list."* `activeTag` is still read there, because while a tag is narrowing
  the queue no saved list is the one in force.
* **Edit and Delete were always in that three-dot menu, and could not be seen.**
  *"the default List or created list … should with function of be edit/Delete in
  three dot."* The panel was positioned `absolute` inside a list that scrolls,
  and **`overflow-y-auto` clips an absolutely-placed child** — so on any row
  below the first few the menu was cut off or simply invisible, which reads
  exactly like the controls not existing. It opens in the flow now and pushes
  the rows below down; nothing can clip it. The spec measures the panel's box
  against its scroller's and deliberately opens the **last** row, because the
  first one was never the one that broke.
* **The duplicate house number is gone for the second time, and this is the half
  that was missed.** `oneOfEach` deduped the description's own pieces; the unit
  number was drawn *beside* that sentence rather than inside it, so it escaped
  the filter it was written for. One list through one filter — and still not by
  naming the house-number field, which would stop being true the first time an
  admin flags another.
* **The completeness bar is three quarters the width** and carries **three
  colours by how full it is**: red to the bar's 40% mark, amber to 70%, green
  after, so a record at 85% shows all three bands and one at 30% shows red
  alone. The boundaries belong to the **track**, not the fill — and since the
  fill is only `percent` of the track wide, a boundary at the track's 40% sits
  at `40 / percent` of the fill. That one division is `strengthFill` in
  `lib/strengthBar.ts`, pure and node-tested, because it is the only thing here
  that can be arithmetically wrong. The three colours are `--strength-low` /
  `-mid` / `-high` in `styles.css`, with their own dark-mode values: a bar is a
  shape the theme owns, and the contrast scan walks both themes.
* **The email circle left the record header for the menu bar's *More*** —
  *"Move email icons from Middle heade pane to Menu bar more tab."* That strip
  now carries nothing but where the record sits in the queue and the search box
  when it is open. The spec asserts it is **absent** from the strip as well as
  present in *More*: a control that moved while the old one stayed is the bug
  this kind of change produces.
* **Call moved under the name, on to the bar's own row** — *"middle header call
  icon move to after the full Name and bar and aligned also from name and
  Bar."* Measured rather than read off a class: below the name, level with the
  bar, after it, and starting from the same left edge the name and bar do.
* **The agent on a queue row is a face and a name.** *"if profile Picture
  available, the the profile pic will be shown on Agent/User Avtar."* Looked up
  **by user id**, never by the displayed name — the record stores the id and the
  row carries it, so the match is exact, while matching on a name silently loses
  anybody whose name is spelt two ways. It reads the directory the pane already
  fetches for the assignment control, so there is no second request, and
  `Avatar` already draws initials when somebody has no photo.
* **The company circle is a bold dark ring, and a logo is fitted rather than
  cropped.** *"current circle line is thin, and i cant see company picture/logo."*
  The ring was `brand-100` — the palest step there is — on a white header, which
  is a hairline nobody can see. And the picture was `object-cover`, which fills
  a circle by **cropping**: a wide wordmark came out as an unreadable slice of
  its middle, which is exactly what "I can't see the logo" looks like.
  `object-contain` shows the whole of it. **Unverified:** whether a logo is
  uploaded on production at all — this container cannot reach the site. With
  none, the first letter of the company name is the correct thing to see, and
  Admin → Brand is where one is added.

**Three specs were behind the screen and are caught up here**, all three left
stale by the ten earlier that day rather than by this batch: `splitViewHeaderKeys`
still asked for a Status button on the queue toolbar (removed that morning —
*"it is already in the Quick Filter"*), the accessibility suite still opened the
stage breakdown through that same button, and `listDefaultView` still looked for
the strength **ring**'s label on a record that now draws a bar. Each was failing
on `main` before any of this, which is worth writing down: a spec that names a
control the owner has just removed fails for the right reason and still has to be
pointed at where the promise went, or the next person reads a red run as a
regression.

### Six more, and unread is gone from the CRM

Still 3 October 2026, later again. Four are adjustments; one is a new control;
one removes a whole feature.

* **Call moved again** — *"Move the call icon after record number in Middle
  header pane."* It spent an hour on the completeness bar's row under the name
  and is now inside the record-position group, immediately after the `3 / 22,988`.
  **And it cost the record's name on a phone**: that group grew by one 32px
  button, which was enough to start truncating the heading at 390px — measured
  at 36px lost. The group takes its own row below `xl` now (`basis-full`), which
  is what `flex-wrap` was already there for; the name is the one thing on this
  header that has to be readable whole, so the controls yield the line rather
  than squeezing it.
* **A tag section in the Quick & Live Filters panel** — *"need Tag Filter in
  quick Filter."* The cards on the top bar show the three most-used and choose
  one; this is the whole list, as many at a time as you like. **A tag is not a
  field**, so `TAGS_KEY` is recognised by `quickPickConditions` and turned into
  the shared `record_tags has_any` condition — the same one the cards send.
  Sent as a field of that name the request is refused, or worse matches nothing,
  which on screen reads as the tick doing nothing.
  **The master was already there.** *"Create a master also in Admin Quick
  Filters"* — Admin → Quick Filters has existed since the panel did, storing
  `ui.quick_filters` per module; the tag section simply joins it, so it can be
  renamed, reordered, opened by default or switched off like every other
  section. Nothing new was built for that half.
* **The company circle is smaller again.** *"decrease the size company logo
  avtar, bcoz the circle overlap the padding."* A ring is painted **outside**
  the box, so the 36px circle with the 3px ring asked for an hour earlier
  occupied 42px of a header whose padding does not allow it. 32px with a 2px
  ring is 36px in all. The ring keeps its dark brand step; only its weight came
  back down.
* **More air between queue rows** — `py-2.5` to `py-4`. The padding is the gap:
  each card draws the hairline under *itself*, so growing the rule's margin
  would have moved the line rather than the breathing room. The inline-editor
  stand-in took the same padding, or the row jumps when somebody double-clicks
  a name.
* **Unread is gone, everywhere** — *"remove unread list from all modules list
  completely and also remove unread functionality from all records."*

**What went, and the one thing that made it dangerous.** The list (`Unread
Leads`, after `Unread Inventories` on 1 October), the badges in the drawer and
the phone's bottom bar, `GET /api/unseen-counts`, `POST /:module/unseen`,
`POST /:module/seen`, `core/entity/unseen.ts`, the amber "needs attention" dot
on a queue row, and the `unread` **system filter field** in the query builder.

That last one is why migration `184` deletes rows rather than only the seeded
view: with the field gone, *any* saved view, dashboard tile or report still
naming it would be refused the moment somebody opened it. So the migration
tombstones and deletes every `Unread %` built-in on every module, then deletes
anything hand-built whose filter JSON names the field, and the same inside
`ipy_dashboard_widget` and `ipy_report`. A chart that refuses to load is harder
for somebody to explain than one that is simply not there.

**`ipy_module_seen` is deliberately not dropped.** Nothing reads it, and a
migration here never destroys a table — if unread is ever wanted back it starts
from the watermarks the team already has.

**Three tests came out with it**, and that is the honest accounting rather than
a loss: the built-in-views suite no longer expects a fourth view, the live-list
suite no longer clears a highlight that cannot exist, and the query builder's
`isSystemField` now asserts `unread` is **false** — which is exactly the
assertion that would catch somebody reintroducing the field without the data
behind it.

**And a spec trap worth writing down, because it can only ever fail.** The new
tag choice was located as `button[aria-pressed="false"]`, then clicked, then
asserted to be pressed — so the moment it was ticked it stopped matching and
`.first()` resolved to the *next* unticked tag, false for ever. A locator must
not name the state the test is about to change.

---

## Four on 4 October: the logo, the search, a note's date, and chasing an empty record

Three of his seven that morning were already written and pushed on 3 October and
had simply **not reached production** — CI had been red since that evening on one
stale assertion (migration `184` took "Unread Leads" out and a count eleven lines
down still said four), and `render.yaml` can gate the deploy on checks. Worth the
reflex: before rebuilding something the owner reports as missing, **check whether
it shipped**. `gh api repos/.../actions/runs` answers it in one call, and a red run
looks exactly like a slow deploy.

### The company logo is not a circle

*"See the first screenshot of the Company Profile Logo, Poor Alignment & Size
adjustment."*

**A circle is the wrong frame for a company logo, and that was the whole fault.**
`BrandMark` drew a 32px round box with a ring round it, so a wide wordmark — which
is what almost every company's logo is — had to fit its entire width inside 32px
of height and came out a few pixels tall; and the ring, drawn *outside* the box,
made the mark 36px in a row whose padding allows less, so it pressed against both
edges. Three separate evenings were spent making that circle bigger, then darker,
then smaller again, which is the clue that **the shape was never the thing to
adjust**.

A real logo is now drawn as the shape it is: `h-9 w-auto`, capped at 8rem on a
phone and 11rem above, `object-contain object-left`, no ring and no crop. The
round badge stays for the **initial**, which is the one case a circle fits,
because a single letter has no width of its own. And the company name beside it is
printed **only when there is no logo** — a wordmark already *is* the name, so the
two together said it twice and took a third of the bar. The link's `aria-label`
still carries the name either way.

### The search panel

*"We need search as a more/much dynamic in the Main/top toolbar, we can search
everything, the result shown in list. by source of result and last search also
shown in below … we want word's all dynamic features in this search, means most
advance label search engine of our crm."*

**Nothing about the searching changed, and that is why this was a day.**
`GET /api/search` already reads as the person asking, already narrows a
comma-separated list, and already says when a number belongs to a colleague's
customer. What changed is the panel over it:

* **Grouped by the module the answer came from**, with a count on each heading and
  a **See all** that opens that module's own list with the same words in its box
  (`?q=`, which `ListView` has always read). `lib/searchGroups.ts` is the rule,
  pure: a group appears **where its first hit appeared** and keeps the server's
  order inside it — sorting groups by size would put the module nobody asked for
  at the top whenever it happened to match more. A record somebody cannot open is
  grouped with its own kind rather than collected into an "other" bucket: it is
  the answer to *"does anybody already have this number"*, so it belongs beside
  the ones that can be opened.
* **A sub-line that tells two people of the same name apart** — record number,
  who owns it, when it was last touched. `globalSearch` returns the owner and
  `updated_at` now, one `LEFT JOIN ipy_user`, no payload table, so a search box
  does not notice the cost.
* **↑ ↓ and ↵.** The flat list the arrows walk is **derived from the groups**
  (`flattenGroups`) and never from the server's own array — the two would disagree
  the moment grouping reordered anything, and then the arrows would highlight one
  row while ↵ opened another. It wraps both ways, because a short list is read by
  holding one key. ↵ with **nothing** highlighted opens the first group's full
  list rather than guessing the top answer: pressing it means "show me these", and
  opening a record because it happened to be first is how a rep lands on somebody
  else's customer with no idea why.
* **The last five searches** under an empty box, each with an ×
  (`lib/searchHistory.ts`). In this browser, like the split view's width: it is
  nobody else's business and a round trip to recall it is slow at exactly the
  wrong moment. The same search typed twice is one entry, matched without regard
  to case or spaces — otherwise the row fills with one word and the other four
  fall off. Remembered when a search is **acted on**, never per keystroke.

Two things only a browser could have shown, and both were found that way:
`PeekLink` does not forward arbitrary props, so `aria-selected` written on the
caller reached nothing and the arrow keys highlighted a row no test and no screen
reader could find — it takes a `selected` prop now, on the link itself, because a
wrapper saying "selected" is one a keyboard user's software cannot connect to the
link inside it. And the panel scrolls, so ↓ past the sixth row highlighted
something off screen: the highlight is scrolled into view with `block: 'nearest'`.

### A note says its own date

*"the Note date are separate from comment/note box, we want to see note/comment
date in same box of comment/note just like agent name and updated time."*

The feed put the date in a chip down the middle, one per day, so a note read
"Rahul Kumar · 4:12 pm" and the only way to learn *which* 4:12 pm was to scroll up
until a chip came into view. A note is a thing somebody comes back to on its own.

`DayChip` and `sameDay` are gone from `ActivityFeed.tsx`; `clock` carries the day
as well as the time, and `NoteEntry` in `RecordBlocks.tsx` prints it beside the
agent's name — it said "2 days ago" alone, which is enough for a glance and no use
at all for a note from last December, so it now says both. **Today shows the time
alone** (three words to say "now-ish" is noise) and **the year only when it is not
this one**.

### Chasing a record nobody has filled in

*"i am pushing my team/agents that, they are fill the form fields maximum … but
alls are slacker … can you make an option for that they are bound to filled
maximum or all the fields in leads/inventory module, or you can pushing hem time
to time from crm/system."*

He offered two roads and this takes the second, deliberately. **Making every field
mandatory would break the one thing this CRM is fastest at.** A rep on the phone
types a name and a number and saves — that is how a lead arrives at all rather
than on the back of an envelope — and a form that refuses until twenty-five fields
are answered is a form nobody uses, so the records would stop arriving rather than
arrive fuller. Worse, the automated sources carry what the customer gave and
nothing more, so a mandatory field there means the lead is **thrown away**: this
repo has lived through exactly that once, when migration `026` made two fields
stricter and every automated lead failed validation in silence for weeks.

So the pressure is applied after the record exists, where being wrong costs
nothing — `core/quality/profileStrength.ts`:

* **`profile_strength` is ordinary filter grammar now.** It could only be *sorted*
  by before, so "every contact of mine under 60%" could not be asked at all —
  which means it could not be a saved view, a quick filter, a dashboard tile, or
  the thing a nightly count reads. `strengthPercentExpr` is the sorting's own
  `strengthExpr` turned into a percentage, so the bar on the record and this
  filter can never disagree about what 60% means. It is **not** in `SYSTEM_FIELDS`
  because that table is static and this answer depends on the module's own field
  list — which is the point: adding a field moves every record's strength, with no
  deploy.
* **A target he sets** — `data.min_profile_strength`, Admin → Settings → Record
  quality, migration `185`, seeded **0** which means off. Nothing nags anybody on
  the day it ships. Clamped to 100 rather than trusted: a mistyped 400 would mark
  every record in the business thin, every day, for ever.
* **One nudge a day to whoever owns the record**, between nine and eleven, naming
  the count and linking at *their own* thin records weakest first — the link is
  `?filter=` with `owner_id is_me`, so it is one link that shows each person only
  theirs, and no new screen. **One notification per person, never one per record**:
  forty notifications is forty notifications somebody switches off, and then the
  useful ones go with them. Keyed on the calendar day, not hours elapsed, so a
  restart at 09:01 cannot send a second copy.

**Nothing here blocks a save.** That is the whole design, and the thing to get
from him rather than from this file before changing it.

`tests/integration/profileStrengthNudge.test.ts` (13) had to **set the target
itself** — the nudge does nothing until one is set, so every test would otherwise
trip over the refusal and prove nothing past it. Same rule as the WhatsApp send
that died on a line no test had ever reached.

---

## Today's tasks pop up, with a buzzer — 9 October 2026

**The owner:** *"i need to pressurised to team for the complete today task asap
… in every 15 minute … first task to last task … every lead form auto open like
popup … only once time per day / per lead if task more then 50 records, the
form will be closed after 60 seconds … if task below then 50 then remind
regular after 15 minute … with a buzzer sound also … if they want to ignore the
tasks but they cant ignore anyway."*

`components/TaskBuzzer.tsx` is mounted once in `Layout`, so it runs whichever
page somebody is on. The rules are in `lib/taskBuzzer.ts`, pure and tested
(`tests/taskBuzzer.test.ts`); the sound is `lib/buzzer.ts`, three square-wave
bursts made by the browser, so there is no audio file to load or lose.

* **A task** is a record assigned to you whose task date is today, on every
  module that has one. Which dates count is metadata: the module's Next
  Follow-up (`followUpFieldOf`) plus any date field an admin has marked
  `config.dueDate` — a planned site visit, for instance. No field is named.
  "Today" is asked of the server, in the organisation's timezone.
* **A round** walks them first to last, each popup buzzing as it opens. The
  next round starts *Minutes between rounds* after the last popup of this one.
* **Over *Once a day each, above this many tasks*** (50): each lead pops up once
  that day and every popup closes itself after *Seconds before a popup closes*
  (60), date moved or not.
* **At or under it:** every task pops up every round and waits for the rep.
  Next and Escape move on; nothing ends the round early.
* **Moving the date is what finishes a task.** The popup is the record's whole
  form (`ChatRecordPane`), editable where it stands, with the follow-up chip in
  the red header. When a task date changes the popup says *Done — date moved*
  and moves on. "Done" means *changed since the popup opened*, never "not today
  by this laptop's clock" — a laptop in another timezone would disagree with the
  server.
* **A tab nobody is looking at** buzzes once and shows a desktop notification
  (when the browser allows them); the round waits until the tab is in front.
* **Laptops and desktops only** — not in the phone app, where a popup over a
  call is worse than none.

**Settings → Today's tasks** holds the four numbers (migration `195`, keys
`ui.task_buzzer_*`, seeded on with the owner's 15 / 50 / 60). They ride on
`/api/auth/me` with the other `ui.` settings, so a change reaches somebody the
next time they open the CRM. `readTaskBuzzer` holds each inside a sane range: a
typo must not become a popup every second.

**What a browser remembers** (`ipropy.taskBuzzer.<user>.<day>`): which leads
already popped up today and when the next round is due, so a reload neither
restarts the clock nor repeats a busy day. Keyed by the day, so tomorrow starts
clean. **`e2e/auth.setup.ts` saves the test session with today's round put off**
— otherwise the popup lands on top of every spec a minute in.
`e2e/taskBuzzer.spec.ts` brings it forward to prove the popup, the buzzer, Next
and a moved date.

**Two things a browser decides, not us.** Chrome will not make a sound until the
person has clicked something on the page; anybody signed in has, so in practice
it plays, and when it cannot the popup still opens silently. And nothing on a
web page can stop somebody closing the tab — what the buzzer can do is come back
every round until the date is moved.

## Projects — a fourth module, and why it is not the one 031 removed

**8 October 2026, the owner:** *"make me a project module in the CRM wherein we can
input all details of all projects we got … DLF, BPTP, Omaxe etc. projects like some in
Faridabad and other places … complete end to end … without messing anything else."*

One record is one developer's project. Seven sections, in the order a rep is asked
about a project: **Project** (name, developer, type, status, city, sector, RERA, who
owns it), **Location** (address, landmark, map link, connectivity), **Size &
Timeline** (acres, towers, units, floors, launch, possession, construction %, OC),
**Configurations & Pricing** (BHK mix, size and price band, rate, payment plans,
booking amount, other charges), **Amenities & Highlights**, **Brochure, Photos &
Video**, and **Dealing (internal)** — brokerage, the sales contact, the sales
office, the inventory sheet, internal notes.

**The first Projects module was removed by migration `031` and this one is shaped by
why.** That one made every unit *point at* a project (`project_id`), so entering a unit
meant creating a project first, and the project existed mostly to carry its own name.
Here **nothing points at a project.** Units keep the plain `project_name` text they
already carry, and a project opens on a **Units** tab that finds them by that name —
the same Builder's Floor table (`BuilderFloorTable` with `module="properties"`), so
search, filters, sorting, editing in place and Call all come with it. Inventories and
Contacts were not touched.

* **`contains`, not `equals`** (`unitsOfProject`). The name on a unit was typed by a rep,
  and `equals` is exact — `" dlf the arbour "` would miss *DLF The Arbour* and the tab
  would read empty. The cost is that a project also finds its "Phase 2", which a rep
  would want beside it anyway.
* **The table's columns for units are the queue card's facts** (`glanceColumns`): the
  fields flagged `listSubtitle` (unit number), the stage, then bedrooms, locality,
  price and size. The record's label is left out on purpose — on Inventories that is
  the seller's name, and this table is of units.
* **The queue row's second line is `queueFields`**, a new optional key on a module
  definition that seeds the same `queueFields` the Layout Designer edits: *"Omaxe,
  Faridabad"*. Without it a project's row would have tried to say a unit's facts
  (bedrooms, price) and said nothing.
* **Unique by name inside its city** — the same name twice in Faridabad is a duplicate;
  the same name in Gurugram is another project.
* **Who may do what**, `db/seed/rbac.ts`: everybody reads (`public_read`, like the
  inventory); a Sales Manager adds and edits; a Sales Executive and a Telecaller read
  only; nobody but an admin deletes; a Telecaller never sees **Brokerage %**.
* **A brochure link never carries the Dealing section.** Brokerage, the sales contact
  and the internal notes are caught by `SENSITIVE_NAME`; `project_code`,
  `sales_office` and `inventory_sheet_url` are named in `NEVER_SHARE`.
* **Developer is a dropdown** (`developer`, Settings → Dropdowns), seeded with the
  developers this business deals in around Delhi NCR, so "DLF" and "dlf" are one
  developer in a filter.

Migration `194` creates `ipy_e_projects` with only the columns its indexes need, and
clears any field or section tombstones the first module left under the name
`projects` — otherwise the seed would have skipped a new field that happened to share
an old one's name, silently. The old public `/api/public/projects` routes are
unaffected: they never read a projects table, they group Inventories by
`project_name`.

Pinned by `tests/integration/projects.test.ts` (8 — the module, duplicates, the
views, the units match, who may do what, the brochure) and `e2e/projects.spec.ts`
(in the navigation; opens on Units and finds a unit typed in lower case).

## Builder Floors — a third module, and why it earned the exception

**5 October 2026, the owner, with his own spreadsheet** (`Builder Floors 2026 -
Single.pdf` — 130 floors across 60 buildings): *"Can you build a new module for
builder floor inventory, a builder have many properties in same 4th floor
building or multi building, and all floor, building price are not same and
different building have different size, different location, facing, floor
availability, if the unit sold then the move on separate folder and we need all
filter i.e floor wise, accommodation wise size wise, price wise … we can do task,
calls, sms, whatsapp, email from this view and we can save photo, video, youtube
for a property and we can send this property details to a client directly from
module as a brochure … we can categorised, floor plan, Elevation, ans also see
rooms size, bath size, kichen size according to floor plan."*

**What his sheet actually holds**, decoded from the PDF rather than described
from memory: Name · Mobile · Plot No. · Acco · Size · Facing · **1st · 2nd · 3rd ·
4th** · Status · Update · Remarks. Totals on page one: 130 flats in 60 buildings,
56 four-BHK and 4 three-BHK, available by floor 43/38/35/14, Start 24 / Semi 16 /
Finish 18, size bands 225–500+ Sy. The Remarks column is not prose — it carries
`60" Road`, `45" Road`, `Corner,`, `Park Facing,` and `Side Park,`, which are a
road width and two flags.

**Two codes in his floor columns are still unexplained and were deliberately not
guessed at: `T` and `M`.** `T` appears almost always in the 4th slot and `M` on
one row whose remark reads "Daught". They are his business's shorthand and
inventing a meaning would put a wrong fact in front of a buyer, so `Floor
Availability` ships with the four states the sheet plainly uses and he can add
whatever those two mean as dropdown options. **Ask him before importing the
sheet**, or every row carrying them imports wrongly.

### Rebuilt the same day: one record is one HOUSE

**The first cut made one record per floor and he corrected it within hours**,
with a screenshot of a lead's Matching Inventory and his own table:

> *"We want to see a table in Middle Pane under manu bar a Name of Builder's
> Floor … we want create multiple unit of multiple builder under in a locality …
> Mobile Number, Builder Name, House No, Facing, Size, Bedrooms, Status,
> Amenities, and price for all floor in sam table the price are like First
> Floor, Second floor, third floor, Fourth floor, Top Floor … main Speciality of
> This Module is We want to Use Locality as a Unique identity instead of Mobile
> Number."*

**He was right and the objection written below was wrong.** It said a row per
building cannot answer "every 2nd floor under 3 crore" because the filter
grammar has no way to say "any of these four columns". Two things are wrong with
that: "every 2nd floor under 3 crore" is a filter on `second_floor_price`, one
ordinary column; and "any floor under 3 crore" is an **OR of five conditions**,
which the grammar has had all along. Both are pinned in
`tests/integration/builderFloors.test.ts`. The shape he already works in answers
every question he asked.

**Keep the rest of this section**, because the reason the module exists at all is
unchanged and is the thing to re-read before anybody proposes folding it into
Inventories: a property's identity there is `mobile` and that column is
**unique**, so one builder's number owning five houses is four refusals.

### Locality and house number are the key

**5 October locality-queue correction:** the owner clarified that the left
pane lists unique localities, not individual houses. Builder Floors opts in
through `settings.queueGroupBy: 'locality'`. The shared workspace reads the
server's scoped, filtered group counts across all pages, hides empty master
options, and opens the Builder's Floor table on locality selection. The queue
shows only locality and house count; no house number or duplicate locality row.
Arrow navigation steps between localities. The table has its own house paging,
so a locality with more than 100 houses is not truncated. Underlying house
records, their labels and their locality-plus-house duplicate check remain
unchanged. Leads and Inventory do not opt into grouped queues.

The older queue-label rationale below describes the previous house-per-row
queue and is superseded for the left pane only; it still applies to house links.

### The table is where the work happens

**5 October 2026, the owner, with a screenshot of the live locality table:**
*"I want to edit, and filter and search in this table, please make it for
use … how to make a call from table mobile number."*

It was a read-only grid with paging. Five things now sit in it, and every one
of them is the CRM's own control rather than a second copy written for this
screen:

* **Search** runs on the server, over the whole locality rather than the
  hundred rows on screen. Narrowing what is already in front of somebody
  answers the wrong question the moment a locality outgrows a page.
* **A dropdown per picklist column** — Facing, Accommodation, Status — built
  from the module's own options, so an admin who adds a dropdown gets a filter
  for it with no deploy. **Not** a dropdown for a field the table is already
  pinned to: a Locality filter on a locality's own table offers a choice whose
  only useful answer is the one it already has (`fixedFields`).
* **Every column heading sorts**, and turns round on a second click.
* **Every cell is edited where it stands**, through `EditableField` — the same
  editor as the record, so the validation, the permissions, the workflows and
  the change history are identical here. **The whole cell is the target, not
  the value inside it**: an empty field's box is a dash a few pixels wide, and
  a click anywhere else in the cell would hit nothing. The same forwarding the
  record form already does, and the same bug it met first.
* **A number is something to ring.** `CallButton` and `WhatsAppButton` sit
  beside it, and `startCall` takes the row's own record id — a call placed from
  a table of twenty houses must be filed against the house in that row, not
  against whichever record the pane happens to have open. That third argument
  is the only change outside this file.

The first column stays a plain link to the house. It is how a rep gets to the
record, and it is the one thing in a row that must not turn into an edit box
under the cursor.

**And the button that sends it had never existed.** `ShareLinksPanel` has
been in the repo for months, with its own Copy and WhatsApp hand-off, and
**nothing opened it**: `RecordDetail.tsx` holds the dialog behind a `sharing`
flag that no control ever sets, and the split view — which since 27 September
is the *only* view — had no entry at all. So the one way to a brochure link
was the API. *Send to a buyer* now sits in the record menu's **More**,
gated on `canShareRecords`, opening the same panel: one component, so the
wording, the copy button and the WhatsApp hand-off cannot drift between the
two places a link is made. It is deliberately absent on Contacts — a link
renders a property to a stranger, and pointing one at a person would show a
buyer somebody's number and budget.

**A brochure can be sent from here** (migration `191`). `settings.shareable`
is the per-module switch `canShareRecords` already reads; the public page and
`loadSharedRecord` were made module-generic when this module landed, so this
turned the existing door on rather than opening a second one. What a visitor
reads is still `propertyShare.ts`'s decision — the builder's name, his mobile,
the locality and every internal price are withheld **by name**, so a brochure
carries the house and not the seller. A migration and not the seed, because
`upsertModule` writes `EXCLUDED.settings || ipy_module.settings` and a module
that already exists never learns a newly seeded setting.

*"you can set duplicate restriction for Locality only for this Module"*, and in
the same message *"we want create multiple unit of multiple builder under in a
locality"*. Locality **alone** as the key allows exactly one record per locality
and refuses the second builder, so the two sentences agree only one way:
`duplicateCheckFields: ['locality', 'house_no']` with mode `all`. B-114 and
C-3614 in one colony are different houses; B-114 twice is the same one; and
B-114 in a *different* colony is allowed, because a house number is only unique
inside its own locality. **That last one is asserted**, since it is the half a
locality-only key would have got wrong.

`labelFields` is both, for the same reason — *"We need Locality as main Value in
Left Record pane in replacement of Full Name in First Line, Assign to in Second
Line"*. Locality alone would print "Greenfields Colony" down the whole queue
with nothing telling two houses apart. **No field is flagged `listSubtitle` on
this module**: the agent's name is already the line under the name on every
module, and a subtitle would push a third line between them.

### The table, and why it is one component

`components/BuilderFloorTable.tsx` draws it, and the **columns are the module's
own fields** — the `builder_floor` and `floor_prices` blocks, in the order an
admin put them in the Field Manager. Adding a sixth floor price, or renaming
Size, moves the table with no deploy. **No column is named in that file.**

One table in two places, because they are the same question with a different
filter: on a **house** it is every house in that record's locality (*"multiple
unit of multiple builder under in a locality"*), and on a **contact** it is what
fits them — *"we can use this Builder's Inventory as a matching builder's
inventory in Lead Manager as Inventory Matching … in Menu bar same as Matching
Inventory"*. A second copy would drift the expensive way: one of them learns
about a new floor price and the other keeps showing four columns, so a rep
quoting from the lead's tab misses the top floor entirely.

**The contact match skips every condition the contact has not answered.** Most
records carry a budget and nothing else, and a matcher demanding locality,
budget and configuration answers nothing for almost everybody. The budget is
compared against **every floor price in turn, ORed** — "is any floor in this
house within reach" — with the same 10% headroom the CRM's own buyer matching
uses. Sold and withdrawn houses are never offered.

`builders` is a new `RecordTabKey` and a new `SplitTabKey`, appended by
`arrangeRecordMenu` for anybody who has already dragged their menu — a saved
order written before the tab existed cannot have meant to leave it out, which is
the rule that once made the Chats page unreachable.

### A third thing off the brochure, found the same way as the first two

**The builder's name was on it.** A broker sending a brochure is selling the
introduction; a buyer who reads which builder put the house up rings him
directly and the broker is out of his own deal. `SENSITIVE_NAME` catches owner,
contact and broker and does not catch `builder_name`, so it had to be named. It
is in `WITHHELD_BY_DEFAULT` rather than `NEVER_SHARE` — off by default, and an
admin who wants the builder named can tick it in Share settings. The **mobile**
is the harder no and stays absolute.

**And the brochure's title is the house number alone, which is correct.**
`locality` is in `WITHHELD_BY_DEFAULT` already — *"who and exactly where, the two
things a rep sells on knowing"* — so the colony does not reach a buyer and
`buildLabel` falls back to the half of `labelFields` that is shared. Asserted
rather than "fixed": a buyer with the exact address does not need the agent.

### Two things a tombstone does not do

Removing the nine fields of the first cut needed **both halves**, and the first
attempt had only one. `ipy_field_tombstone` stops `upsertModule` *re-creating* a
field; it does nothing to a row already in `ipy_field`. Checked by looking, not
assumed: after the tombstones went in, all nine were still on the module and
still on the form — so the module carried a second Mobile, a second Size and an
Asking Price beside the five floor prices. Migration `188` tombstones **and**
deletes. `tests/integration/builderFloors.test.ts` asserts both: the thirteen
columns present, the nine absent.

The **columns** stay. Nothing in this repo drops a column that might hold
somebody's data, and a column no field points at costs nothing.

---

### The first design, kept for the reasoning that still holds

### One record is one floor

This is the whole design and everything else follows from it. His sheet is one
row per *building* with four price columns, and that shape cannot answer a single
question he asked: "every 2nd floor under 3 crore" would need the filter grammar
to say "any of these four columns", which it cannot. A floor is also what a buyer
buys, what a brochure is about, what gets sold, and what a call or a task hangs
on. Four columns also cap the building at four floors — a stilt or a terrace has
nowhere to go.

**Why it is not the Properties module, which already holds units.** A property's
identity there is `mobile`, and that column is `unique`. One number in his sheet
(9910534500) owns five buildings, which is twenty floors, and nineteen of them
would be refused on insert. Loosening a live uniqueness rule to fit a new feature
is not a quiet change. `tests/integration/builderFloors.test.ts` pins four floors
on one mobile across two plots for exactly that reason.

**Why not a second Buildings module either.** The building's shared facts — plot
number, builder, plot size, facing, road, stage — sit on each floor, grouped by
`building_code`. That repeats about eight values across up to four rows, which is
a real cost and the smaller one: a parent module means every rep must create a
building before they can record a floor, on a list of sixty he already keeps in a
spreadsheet. **This is the trade to revisit first** if editing a building's road
width across four floors starts to hurt.

**It is the third module in a CRM that deliberately deleted eleven** (migrations
030, 031, 048), and `tests/seed/templates.test.ts` asserts the count rather than
letting it grow — so a twelfth is a deliberate act. The test carries the reason.

### The three halves a new module needs, and the one that fails silently

* **A migration** (`187_builder_floors.sql`) creates `ipy_e_builder_floors`. It
  declares only `record_id`, `custom_fields` and the **five columns an index
  needs**; it was written as 186 and renumbered on merge, because a parallel
  session had shipped its own 186 the same day — two migrations on one number
  both apply (the runner keys on the filename) but the folder stops reading as a
  sequence, so the later one moves; the seed's `ensureColumn` adds the other forty-odd. The first cut
  declared none of them and guarded each `CREATE INDEX` behind an `IF EXISTS` on
  its column — which on a fresh database is every guard failing and **no index
  created, silently**, because *migrations run before the seed*. Found by looking
  at `pg_indexes`, not by any test.
* **The seed template** (`realEstate.ts`) is the module: blocks, fields, views,
  layouts. Migration 175's lesson, met from the other side — a migration cannot
  create a module the seed does not know about, or it is absent on every fresh
  database, which is still true of Associates.
* **`ALL` in `seed/rbac.ts`.** `seedProfiles` inserts one grant per name in each
  profile's module map and skips what it cannot find, so **a module added to the
  template and not to that line ships invisible to every profile, the
  administrator's included** — which reads exactly like the feature not having
  been built. The integration suite asserts `permissions.view` from the describe
  for that reason. Sharing defaults to `public_read`, like Inventories: a floor is
  shared stock.

### The filters, and the sold "folder"

Every filter he named is ordinary filter grammar on a field, so each is also a
saved view, a quick filter and a dashboard tile: `floor`, `accommodation`,
`plot_size`, `demand`, `construction_stage`, `corner_plot`, `park_facing`,
`building_code`. Measured against a real database, including all four at once.

**`between` reads `value` and `value2`, never an array.** An array answers zero
rows with no error at all, which on screen reads as "no floors in that budget" —
it cost a round here and is pinned.

**"If the unit sold then the move on separate folder" is a saved view, not a
second table.** The default list is **On the Market** (`floor_status` not in Sold,
Not for Sale), with **Sold** beside it and **All Builder Floors** unfiltered as
the way back. The row never moves: a sold floor keeps its calls, its notes, its
photos and its buyer, and a record that changes table when its status changes is
one nobody can find again. The unfiltered list matters as much as the default — a
default view that drops records with no escape is reported as data loss.

### The brochure, and the leak it shipped with

A share link on a floor minted fine and the page answered **404**, because
`/share/:token` called `loadSharedProperty`, which looks the id up in
`ipy_e_properties`. Every share-link failure deliberately resolves to one message,
so the 404 said nothing about why. `loadSharedRecord` was already
module-generic; only its one-line Properties wrapper was not. `resolveShareToken`
now carries `moduleName`, read off `ipy_record` — which that query already joins,
so no column and no migration.

**And then the brochure carried `expected_price`.** That is what the builder will
actually take, and a buyer who reads it has the whole negotiation.
`defaultShareFields` shares every supported field it is **not** told to withhold,
so **a new money or status field is public from the moment it exists**, and
hiding it from a rep in Profiles does nothing here — a share link is read by
somebody with no profile at all. `sold_price`, `sold_on`, `floor_status`,
`remarks`, `price_updated_on` and `stage_updated_on` went with it into
`NEVER_SHARE`. Found by reading the live payload, which is the only place it
shows, and pinned both ways: the six are absent, and price/floor/size/facing are
still there.

**Still not on the brochure, and worth knowing before promising it:** the Floor
Plan and Elevation pictures. `isShareable` only passes a list of value types and
`image` is not among them, which is also why Inventories' own `floor_plan_url`
sits in `NEVER_SHARE`. The brochure's pictures come from the record's
**attachments**, so a plan uploaded on the Files tab does appear; the two named
image fields do not. That is the next piece of this feature, not a bug in it.

### Two spec traps, both ones this repo had already written down

* **The workspace dock renders twice** — an expanded `complementary` and a folded
  `navigation` — so `getByRole('link').first()` can resolve to the hidden copy and
  the click waits for visibility for ever. Even `:visible` was not enough: the
  rows carry a CSS transition and a moving target never satisfies the stability
  check, so the spec asserts the link and its `href` and navigates with `goto`.
  What the promise is about is the module being *in* the navigation — the Chats
  lesson — and whether a nav link navigates is covered elsewhere.
* **The queue header's count is two sibling spans**, the label and
  `({rows.length})`. `getByText(/Builder Floors \(\d+\)/)` therefore matches
  nothing, while the accessibility tree happily reads "Builder Floors (4)" — so a
  spec waiting on that text waits for something no element will ever contain, and
  it looks like a page that will not load. The select-all checkbox's label is one
  element and is built from the module's own label.

### What is proved, and what is not

**The one thing that proves a new module builds from nothing** is
`tests/integration/control.test.ts` — it provisions a real customer database from
an empty one, and its module count went from 2 to 3 on the first run. A
developer's database already has the tables, so `upsertModule` and `ensureColumn`
both no-op there and a wrong migration/seed order is completely invisible. The
count is asserted exactly rather than as "more than two", so the next module is a
deliberate act. **Associates is still not among the three**: it was created by
migration 175 and the seed template never learned about it, so on a brand-new
database it does not exist at all.

**Proved:** 16 integration tests against a real database (the module describes,
one mobile holds many plots, the duplicate guard, all five filters and them
combined, the sold view both ways, a note reaching the timeline, a tag, the
brochure rendering and the six secrets absent from it) and 5 in a real browser
(reachable from the toolbar, the split view with a floor open beside its record,
the form offering this module's own dropdowns, the three lists). Typecheck clean,
1,219 unit tests.

**Not proved, and each is the honest limit rather than a detail:** his 130 rows
have **not** been imported — the sheet's localities are Faridabad sectors that
the seeded `locality` dropdown does not carry, so an import would be refused on
every row until he adds them in Admin → Dropdowns, and `T`/`M` need his answer
first. **SMS and email from this view** have not been exercised here. And the
Floor Plan / Elevation images do not reach a brochure, as above.

---
### 4 October: compact workspace and weighted profile strength

Company avatar is removed from the main toolbar; the company name remains.
Tag segments fill the available strip with rounded first/last ends. Each entity
list has a New today chip (created date today), and the dock has Favourites
between Calls and WhatsApp. The duplicate Activity tab is removed; Changes stays.
Strength is solid red below 50%, yellow from 50% through 70%, green above 70%.
Admin → Profile Strength configures relative field weights per module, with zero
excluding a field from scoring; bars, filters and reminders use the same weights.
Currency editors allow room for both amount and unit; the price unit label is
Total, without rewriting stored values or amounts.
### 4 October: list-scoped counts and stable empty results

Quick filter option counts use the current saved view, search and filters,
not the whole module. New (created today) uses the same scope. Empty queues
keep the split workspace and controls, with a no-matches message and reset.
Call, Star and Tag are plain header icons, in that order. Star and Tag no
longer duplicate actions under More.
# 4 October evening: search and loading

Search options has a compact, metadata-driven two-column form (agent, locality,
stage, contact type, tasks, created date, tags and price range), plus the full
filter builder without its large empty-state box. Search results retain two
lines: name/mobile/agent/update on the first, price/house/accommodation/portion/
category/location on the second. Hidden fields and phone masking still apply.
Selected tag chips are solid; a tagged record's header Tag is dark blue.
Email and AI summary are plain header icons, not More actions; record-search
has left More. Dock arrows are removed; the main hamburger still folds it.
Favourites highlights from the parsed filter, including URLs with view/page
parameters. Lists wait for view hydration and retain search handoff state.
Display names are batched once per page, and view counts no longer load rows.

## 10 October 2026 — exact counts and hover controls

Tag counts honour record visibility and the selected agent; counts on tags and
the expanded dock use exact numbers. Selected tags, New and toolbar filters use
the active brand shade. The folded dock has no count badges and hover opens it
as an overlay, without moving the record panes.

New prefetches the actual first page under the same stable query key used by
the list. Planned-visit date fields are detected from metadata, displayed in the
record header, and offered as a Visits today shortcut. They never reuse the
follow-up date. Details opens on hover and closes from its top edge; closing
blocks immediate pointer-triggered reopening. Live calls keep their deck open.

Area-master defaults apply only to new records. The original missing-unit
fallback remains unchanged for old data. Search size ranges are in Sq. Yd.,
converted against configured unit factors; unknown conversions are not guessed.
House-number metadata is searchable and existing house text is indexed by
migration 199. Builder's Inventory leaves the Leads tabs, not the Builder Floors
module. Notifications use quiet type-specific backgrounds.
