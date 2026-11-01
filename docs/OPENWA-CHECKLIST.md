# Connecting an agent's WhatsApp number — the short list

Do this once per agent, with the agent's phone in your hand. About 3 minutes.

**Before you start:** open Admin → **WhatsApp numbers**. At the top, "OpenWA server room" shows how many numbers are connected
and the limit. If it says the server needs the bigger Render plan, stop: see "Upgrading the OpenWA server" in `OPENWA.md`.

1. **Name it.** Type the session name as `agentname-phone` (for example `shikha-phone`), press **Add number**.
2. **Start it.** On the new card press **Start**. Wait about 10 seconds.
3. **Show the QR.** Press **Show QR**. A square code appears.
4. **Scan it on the agent's phone:** WhatsApp → Settings → **Linked devices** → **Link a device** → point at the code.
   The card changes to **Connected** and the phone number appears (partly hidden).
5. **Choose the agent** in the "Agent" box on the card. Each agent has exactly one number.
6. **Check:** from the agent's own login, open one of their leads and send a message to **your own number (+91 98912 22206)** only.
   It must say sent, then delivered. Never test on a customer.
7. If a message from the CRM does not arrive at the CRM later, press **Connect to CRM** on the card once.

**Never:** scan one QR on two cards, link the same phone twice, or use these numbers for bulk messages.

## What to watch in the first week

* **Every morning (1 minute):** Admin → WhatsApp numbers. Every card should say **Connected**, with "Last active" today and no red
  error line. "Sent today" should match what the agent says.
* **Memory:** "OpenWA server room" and Render → ipropy-openwa → Metrics. Memory should stay below about 400 MB on the small plan.
  If it passes 450 MB, do not add numbers; upgrade first.
* **A number says disconnected:** the CRM restarts it by itself (1, 5, 15, 30, 60 minutes). If it still says disconnected after an
  hour, the agent probably logged out or unused their phone for 14 days: press **Show QR** and scan again.
* **Failed messages:** the card shows "(n failed)". Open **Who sent what, from which number** below it to see them.
* **Night:** if you want no messages at night, set the quiet hours on the OpenWA card (Admin → Integrations).
* **After 7 days:** press **Catch up messages** on one number. It should say "0 new" — that proves nothing is being lost.
