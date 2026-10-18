# Feature loop — results log

Append only. One block per round, newest at the bottom. `loop-review` reads this.

<!--
## <date> · <feature> · round <n>
- tried: <one plain sentence>
- outcome: kept | undone
- locked checks: <passed>/<total>; failing: <names or "none">
- note: <anything surprising>
-->

## 2026-10-18 · matching-setup-says-why · round 1
- tried: early-return a WhatsAppAdmin-style "This page could not load" card on query error, showing error.message.
- outcome: undone
- locked checks: 1/2; failing: "a failed load says the page could not load, and why"
- note: the heading now showed, but the reason read "Request failed (500)": the shared request() helper puts a body's `error` field into ApiError.code, not .message, so the server's reason never reached the page.

## 2026-10-18 · matching-setup-says-why · round 2
- tried: the round 1 error card again, plus the ApiError code appended to the reason when it is not the generic 'error' (that is where a body of `{ error: '…' }` lands).
- outcome: kept
- locked checks: 2/2; failing: none
- note: npm test has one failure that predates this change (server tests/workflow/queueNudge.test.ts, "expected 60 to be greater than 300"); it fails the same with this change stashed.
