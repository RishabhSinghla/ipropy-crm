## What changed, and why

<!-- One or two sentences. The why matters more than the what — the diff already
     says what. If this fixes something that was broken in production, say what
     the symptom looked like from the outside. -->

## How it was verified

<!-- Tick what you actually ran. A green CI run is not the same as having checked
     the thing you changed — see CLAUDE.md on why a passing build has shipped
     broken deploys here before. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:integration`
- [ ] `docker build --platform linux/amd64 .` (what Render actually runs)
- [ ] Checked in the running app, not only in tests

## Risk

<!-- Delete the lines that do not apply. -->

- [ ] Adds a migration (forward-only, numbered, no number already taken on `main`)
- [ ] Changes the seed (remember: seeding is create-only for anything an admin can edit)
- [ ] Touches a field by **name** rather than by `column_name`/uitype — renames break these
- [ ] Changes something a customer sees (share links, the public site, the app)
- [ ] None of the above
