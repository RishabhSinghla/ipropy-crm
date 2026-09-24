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
* Stored in `ui.list_views` (migration `168`), which needed a row seeded under
  the `ui` category up front for the reason migration `160` already records: a
  new key inserted by `PUT /api/admin/settings` lands in `general`, the admin
  screen asks for `ui`, and the symptom is a page that saves and reads back
  empty. **Any new `ui.*` setting needs that line.**
