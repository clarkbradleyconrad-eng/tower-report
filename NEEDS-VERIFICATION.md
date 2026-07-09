# NEEDS-VERIFICATION

Items pulled from the live site (or blocked from publication) because they could not be verified. Nothing here renders publicly. When you confirm an item, move it into `data/facts.json` or `data/recruiting.json` and delete it from this file.

_Last updated: 2026-07-09_

---

## 1. Defensive coordinator — CONFLICT (blocks AI stories from naming a DC)

Live AI stories name **two different people** as Texas's defensive coordinator:

- `data/roster.json` (hand-maintained field): **Pete Kwiatkowski**
- Most live AI stories (Walter Camp, Montre Jackson, Tu'upo, portal-ranking stories, and others): **Will Muschamp**, several explicitly framing it as "Muschamp's return as DC"
- One story references special teams coordinator **Jeff Banks** (uncontested, but also unverified)

**Action needed from you:** confirm the actual 2026 DC and set `defensiveCoordinator` in `data/facts.json`.
**Until then:** `facts.json` holds `null`, and the accuracy gate rejects any new story that names anyone as DC (or mentions either candidate). `recruiting.html`'s "Muschamp's defense" AI-chat prompt was reworded to "the Texas defense".

## 2. Offensive coordinator — UNKNOWN

`data/roster.json` has `offensiveCoordinator: null` and no story asserts one. Set it in `data/facts.json` when confirmed.

## 3. Recruiting page — outgoing transfers table (REMOVED from page)

The "Outgoing (8)" portal table listed departures that are **not 2026 transfer-portal moves** (wrong years / NFL departures presented as current portal activity):

| Player | Was listed as | Problem |
|---|---|---|
| Quinn Ewers | NFL — San Francisco 49ers (Rd. 1) | Pre-2026 departure listed under "2026 Transfer Portal" |
| Johntay Cook II | Entered NFL Draft | Unverified year/status |
| Isaiah Bond | Entered NFL Draft | Pre-2026 departure |
| Adonai Mitchell | NFL — Indianapolis Colts | Departed after 2023 season — clearly wrong cycle |
| Anthony Hill Jr. | NFL Draft — 1st Round | Unverified year/status |
| T'Vondre Sweat | NFL — Tennessee Titans | Departed after 2023 season — clearly wrong cycle |
| Jahleel Billingsley | Departed | Unverified |
| Kelvin Banks Jr. | NFL Draft — 1st Round | Unverified year/status |

**Action needed:** compile the real 2026 outgoing list and add it to `data/recruiting.json → portalOut`. The page shows a clean empty state meanwhile. Related claims scrubbed from position-needs blurbs ("Lost Bond, Mitchell, Cook II…", "Banks departed", "Sweat graduated", "Hill departed early") — restore wording once verified.

## 4. Recruiting page — portal Watch List (DELETED from page)

The 6-player watch list included players who are **no longer in college football** (e.g. Quinshon Judkins, Jaxson Dart, Malaki Starks — all drafted/departed) presented as live Texas portal targets. Deleted entirely: TJ Moore, Deondre Jackson, Quinshon Judkins, Jaxson Dart, Kaytron Allen, Malaki Starks. References to them inside position-needs blurbs were scrubbed too. Add only verified, current watch entries back to `data/recruiting.json → portalWatch`.

## 5. Portal summary numbers derived from the removed table

"8 Outgoing / +3 Net Roster Change" came from the quarantined outgoing table, so `data/recruiting.json → meta.portalOutgoing` and `meta.portalNet` are now `null` (page renders "—"). "4 Immediate Impact" was kept (derived from the verified incoming list). Verify and fill in.

## 6. Hand-verified recruiting data is far behind the live numbers

`data/recruiting.json` (your June 3 snapshot) says **#15 On3 / #26 247Sports / 8 commits**. The first Grok live checks (July 9, sources: On3 + 247Sports) report **#5 On3 / #4 247Sports / 22 commits**, plus commits not in your hand-verified list: **Montre Jackson (CB, ~Jul 1)**, **Kasi Currie (OG, ~Jul 4)**, and **Ismael Camara (5★ OT)** per multiple sourced stories. The page shows the live numbers clearly labeled "Live · via Grok" with "differs from hand-verified" deltas — but the verified table itself needs a refresh pass from you.

## 7. Live stories already in the archive (published before the accuracy gate)

These stay live (removing them is your call) but contain claims the new gate would reject:

- **"Five Texas Longhorns Named to 2026 Walter Camp Preseason All-America Teams"** — players array is the placeholder *"Multiple defensive starters"*; no player is named anywhere in the story. Also asserts Muschamp as DC.
- **"Texas Lands Jermaine Bishop Jr. and Jamarion Carlton in 2026 Class Surge"** — describes an active "2026 class surge" dated July 7, 2026, but the 2026 class is signed/closed (both players appear in the signed-2026 list); also asserts Muschamp.
- Single-source stories: "Texas Trending for Five-Star RB Landen Williams-Callis…" (Sports Illustrated only), "Orangebloods Updates 2026 Offensive Depth Chart…" (Orangebloods only).
- Every story naming a DC (see item 1).
- Two stories generated 2026-07-09 ~14:58 UTC by a stale deployment during the cutover (no impact breakdown / season model; one names Muschamp): "Texas Adds Portal WR Cam Coleman and RB Hollywood Smothers to 2026 Roster" and "Colin Simmons Positioned for SEC History as Edge Depth Improves".

## 8. data/facts.json values I could not set

- `offensiveCoordinator` — null (item 2)
- `defensiveCoordinator` — null (item 1)

Everything else in facts.json (Sarkisian, SEC, DKR–Texas Memorial Stadium, 2026 signed / 2027 active cycle, Arch Manning QB1) matches the hand-maintained repo data (`roster.json`, `db.json`, depth chart) — sanity-check it once.
