# The screens a rep lives in

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
