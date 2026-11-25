# Moment Defaults (proposal)

Status: **BUILT** 2026-11-25 on `feature/moment-defaults` (after Moment Visibility step 3b), live from day one (no flag: D5 superseded by Simon, "Dont know why the precaution on your side"); ships in the one release with the catalogue and Moment Visibility. § 1–3 are the rulings; § 4 is the as-built shape (the build plan `.local/moment-visibility/moment-defaults-plan.md` § 1 K1–K7 corrected the first draft's § 4; the corrections are folded in below).

> "I was thinking about having in the user settings the possibility to set defaults for those things, so you don't always have to change them in every moment that you create, but the moment just applies your default."

## 1. What is ruled (2026-11-25)

- ⚠️ **Superseded in the build (Simon, 2026-11-25): split in two** ("who can see you is a privacy setting, while who can see moments you created is a moment default"): Settings → **Moments & Check-Ins** ("Who Can See Moments You Create": the four host settings, on that page itself) and Settings → Privacy (**Hide Check-Ins from Feed** and **Hide Moment Posts from Feed** in Post Visibility, a section **Joining or Creating Moments** with Incognito); no explanatory line (the titles say when, the alert the rest); no account line in Settings. The bullet below is the first draft.
- **One page** (first draft): You → Settings → Privacy → a row **Moment Defaults**, opening a page laid out like a moment's own Moment Privacy page (the same rows, words and helper lines; saved on change). Its own words (picked by Simon, 2026-11-25): the top line "These settings apply when you create or join a moment or check in. Past choices stay as they are."; sections "Who Can See Moments You Host" / "Who Can See You" / "Check-Ins"; the check-in Hide from Feed helper "Only you can see the check-in post. Your impression still shows on your profile." (the rate stage's switch: "Only you can see the post. Your impression still shows on your profile.").
- **The defaults**:
  - As host, applied when you CREATE a moment: Visible To, Include Tasters’ Friends (Followers), Hide Location, Hide Description and Link (today's Moment Privacy words).
  - As a participant, applied when you JOIN a moment (someone else's too; your own at create): Incognito, Hide from Feed for your post of the moment.
  - Check-ins: Hide from Feed, a SEPARATE switch from the moment posts' one.
- **Not defaults**: the View-Only Link (a link is a key you hand out: never on by itself); Moment Setup (blind tasting, hidden line-up, who brought it: about the event, not privacy; maybe later, separately).
- **Copied, never live.** A default is copied into the moment (or the check-in) when it is created or joined; changing a default later changes nothing that exists. The page says so in a line.
- **"Apply to All"** is a separate, deliberate action, in BOTH directions (ruled: a hand-made choice is undone only by choosing to), and it shows first how many of your moments / posts have other settings.
- **On the create screens**: Create Moment gets ONE **Privacy** row (its value shows the actual values, D4; it opens Moment Privacy for this moment only); the check-in's post step gets ONE **Hide from Feed** switch, preset from your default. No "save as default" on a create screen, and a one-off choice never becomes the default by itself. 🔒 The app sends ALL the values it showed (ruled 2026-11-25): what the row said is what the moment gets.
- **Your own privacy caps who sees you** (ruled, the reason the host's audience is not a risk to you): someone outside a moment sees you by name only if your Account and Post Visibility let them see your posts and Show Moments is on; otherwise you are counted in "N more tasters" (`lib/momentAudience.ts`). Step 3 shows this on Moment Privacy (one row naming what your settings allow).

## 2. What others do (research, 2026-11-25; Fable + Codex, sources checked)

- **Defaults apply forward only, and say so.** Strava: changing the default "does not retroactively change the privacy controls on past activities" (support.strava.com/hc/en-us/articles/216919377); Garmin Connect the same; Venmo's default covers "future payments".
- **The past is a separate tool.** Strava "Edit Past Activities", Garmin "Update Past Activities", Facebook "Limit Past Posts" (that one only narrows, no one-click undo), Venmo (past payments only more private).
- **A prompt "apply to existing?"** is rare (Google Calendar, for one setting).
- **On a create screen**: one row or chip showing the current value, the detail one tap away (Facebook's audience pill, Instagram's Audience row with rarer switches under More Options, Strava's visibility on upload, Letterboxd's privacy selector reading "Default"). No app found that saves a default from the composer.
- **Sticky "last choice" defaults are a known failure**: Facebook's 2018 audience-suggestion bug moved 14 million people's posts toward Public (about.fb.com/news/2018/06/audience-selector-error/).
- Strava's "mute" (hide from feeds) keeps the profile and can't be a default; Verre's Hide from Feed hides the post from EVERYONE, so the defaults page must say "Only you see the post; your impressions still show.", or it reads like Post Visibility's Only Me.

## 3. Decisions

**Ruled 2026-11-25 (Simon took the reviewers' recommendations):** D1 A (the line under the date), D2 counts by direction, D4 actual values, D5 after Moment Visibility's go-live, D6 its own small budget, D7 apply everywhere (web too), D8 "Had a sip" gets the default, D9 host section = moments you host yourself. **D3 replaced by Simon's idea: no extra button; changing a default asks.** Native alerts can't hold a toggle (iOS: buttons and text fields only; React Native's `Alert` exposes buttons only on both platforms), so two buttons do it, and only when something differs:

```
Apply to Existing Moments?
7 of your moments have other settings:
5 would open wider, 2 would narrow.

   New Moments Only        All 7 Moments
```
It applies the ONE setting just changed (the Google Calendar pattern, § 2). **Ruled 2026-11-25: the two buttons** (build, Simon 2026-11-25: plus a third, **Cancel**, which undoes the change: a centred iOS alert can't be closed by a backdrop tap) (a switch inside a system alert isn't possible on iOS without undocumented API; a sheet with a switch was the alternative, declined).

The options as they were laid out (with the reviewers' recommendations; Fable and Codex agreed on each):

- **D1 The note on join.** When a default made you Incognito or hid your post, does the moment tell you, and where? Sketches:

  ```
  A  under the moment's date line        B  a banner once, on joining          C  only your avatar in the people row
  ┌──────────────────────────────┐       ┌──────────────────────────────┐      ┌──────────────────────────────┐
  │ Friday natural wines          │       │ ┌──────────────────────────┐ │      │ Friday natural wines          │
  │ Fri 14 Nov · 19:00            │       │ │ You're Incognito here.   │ │      │ Fri 14 Nov · 19:00            │
  │ 👁̸ You're Incognito · Change   │       │ │ From your defaults.  ✕   │ │      │ (Mara)(Luca)(You 👁̸) +3        │
  │ ───────────────────────────── │       │ └──────────────────────────┘ │      │ ───────────────────────────── │
  │ Line-Up   Compare             │       │ Line-Up   Compare             │      │ Line-Up   Compare             │
  └──────────────────────────────┘       └──────────────────────────────┘      └──────────────────────────────┘
  ```
  **Recommended: A**, always shown while on (Incognito and / or hidden from feeds), whatever set it: the only one that also covers a choice made by hand, by promotion or by a role change, where there is no "join" moment for a banner. It reuses step 3's struck-through eye line.
- **D2 "Apply to All" counts.** **Recommended:** a simple count of what differs, split by DIRECTION ("5 would open wider, 2 would narrow"), hand-set ones included as ruled; no mark per moment of where a value came from (that would be new columns on `moment_privacy` and `sessions`, both tombstone scrub lists, and old rows would have none).
- **D3 Where "Apply to All" sits.** **Recommended:** one per section (host settings / your choices in moments / check-ins): three scopes, three budget rules, each confirmation about one thing.
- **D4 The Create Moment row's value.** **Recommended:** always the actual values ("Host’s Friends, location hidden"), never "Default" (ambiguous between yours and the system's).
- **D5 Release.** **Recommended:** after Moment Visibility's go-live: defaults add writes on create, promotion, join, role changes and the check-in POST, the paths most likely to need a rollback right after a release.
- **D6 The budget of "Apply to All" for your own choices** (R10: hiding is never charged or refused; showing again is charged per change, 30 an hour). A bulk SHOW over 200 moments is either one charge (it bypasses the bound) or 200 (always refused). **Recommended:** a bulk action has its own small budget (a few an hour per section, charged per action); its hides are never refused (a refused show never blocks the hides of the same action); one bulk show counts as one change against `rl:post-privacy` too.
- **D7 The web.** The web has no settings page and (signed in) no way to see or undo Incognito / Hide from Feed. **Recommended:** the server applies your defaults on the web too (a protective default must never be skipped); the web gap is named, and the app shows the state (D1).
- **D8 "Had a sip"** (a check-in copied from someone's post). **Recommended:** the check-in default applies (it is a new check-in of yours).
- **D9 Cohosted moments in the host section's "Apply to All".** **Recommended:** no, only moments you host yourself (`host_user_id = you`); a cohost changes a moment by hand.

## 4. Shape (as built)

- **Storage**: `moment_defaults` (`user_id` primary key, `ON DELETE CASCADE`: purely the user's own data), one nullable column per default (`visibility` with its CHECK, `include_guest_circles`, `show_place`, `show_details`, `only_inside`, `moment_hidden_from_feed`, `checkin_hidden_from_feed`); NULL = the system default (`SYSTEM_DEFAULTS` in `lib/momentDefaults.ts`, pinned against the column defaults of `sessions` / `moment_privacy` / `feed_items` by suite § 27 d). Not columns on `users`. Migration `20261125130000_moment_defaults` (CREATE TABLE only).
- 🔒 **Copied, never live: the trigger is participation STARTING** (K1). Seeded when an ENTRY writer inserted the person's member row or `/join` cleared a kick, the person is not the strict host, they have no rating in that moment yet and no `moment_privacy` row. A legacy rating author (no member row; nothing ever backfilled them) and a legacy host are grandfathered: their first `/visit` or `/rate` writes the member row and copies nothing. A seed writes a row only when a value is ON (no row and an all-false row read the same), ONE set-based statement sourced from the people (each person's own defaults; a create override wins per field even with no defaults row). A ban deletes the member row but the privacy row survives, so a rejoin keeps a hand-set choice.
- **The writers** (K2): three ENTRY writers seed: the signed-in create (the host's own choices; the four host settings go into the same row insert), `ensureMemberRow` (`/visit`, signed-in `/join`, `/rate`), promotion (each NON-kicked inserted person, never the promoter's defaults, never host settings: a guest-hosted moment stays closed by the trigger). Set-role (its target already takes part) and kick-keep (a kicked placeholder for ANY account) do not; a placeholder seeds when `/join` re-admits it. 🔒 CI census `scripts/check-member-writes.mjs`.
- **The composer contract**: Create Moment's body carries `privacy` (a field present, `false` included, is this moment's; absent = the default at the time of the create: the web's case); the check-in POST `hiddenFromFeed` the same way (Had a sip too, D8). A retried check-in answers the stored one; photo PATCHes and edits never re-seed.
- **The defaults routes**: `GET /api/me/moment-defaults`, `PATCH` (one field → `{ defaults, existing }`, `existing` = the preview of that field: counts by direction, D2), `POST /apply` `{ field }`. 🔒 **D3 as ruled**: after ONE change, when something differs, a native alert "Apply to Existing Moments?" (check-ins: "…Check-Ins?") with **New Moments Only** / **All N Moments**; the apply applies the STORED default to what differs NOW (not bound to the preview: ruled, "we do not handle this case at all"; a change between the alert and the tap means you changed things elsewhere at the same time).
- **The apply**: host fields over moments with `host_user_id = you`, live (D9: cohosted excluded; a frozen moment is never yours by host id), each under its own session mutation contract, PG only, the lock wait bounded (`lockTimeoutMs`, a timed-out moment is left), decided under the locks (still the scanned row, still your moment by the fresh grant, the direction from the locked row), two passes so no narrowing waits behind Redis. K6: Include Tasters' Friends widens only where Visible To is Friends / Followers and narrows everywhere it is on. Your choices over every moment you took part in (memberships not kicked, kicked ones with a privacy row, hosted live moments, ratings, moment posts; deleted moments included), one statement per action, account deletion's lock order kept. Check-ins: one statement.
- **Budget** (D6, R10): narrowing never charged or refused; a widening action costs one of 10/h per section AND one change of the single-item budget, refunded together, settled by committed widenings; a refused widening answers 429 after the narrowing part applied; a request limiter of 60/min charged only on no-op applies; every Redis call with a short deadline (`app/api/rate-limits.md` § Moment Defaults).
- **The flags**: copying and narrowing ignore `MOMENT_LOOKIN_ENABLED` / `HIDE_FROM_FEED_ENABLED` (everything goes live together; a protective default must never be skipped); a WIDENING apply respects the matching write fence.
- **The app**: the page (rows shared with Create Moment's Privacy page), the Create row (line 1 the audience + circle, line 2 what people who haven't joined can see, then Incognito / hidden from feeds, whole phrases with an ellipsis), the check-in switch, and **D1**: under a moment's date, while you are Incognito or hidden from feeds there, the struck-through eye + "Incognito" / "Hidden from feeds" / "Incognito · hidden from feeds" + "Change" (opens Moment Privacy). After every apply the feeds, the Moment Privacy copies and an opened post's pinned copy are re-read.
- **Account deletion**: the table cascades; moments that survive keep their copied settings and freeze, as today.
- **No web settings page**; the web's create, join and check-in still get your defaults (D7). Named gap: a signed-in web user can't see or undo a default's effect (the app shows it, D1).
- **Residuals** (named, plan § 8): changes between the alert and the tap, and your own writes racing your own apply, are not handled (ruled); a kicked never-rater re-admitted gets today's default (a hide at most); a refund across a window rollover; a host with thousands of moments waits for the whole apply; a hide loop pays its scan; legacy rating authors never get a default in that moment.

## 5. Reviews

- The build plan's reviews (one Fable-medium reviewer r1→r5 converged; Codex xhigh r1→r5; three interview rounds): `.local/moment-visibility/moment-defaults-plan.md` § 10.
- 2026-11-25: Fable (medium) and Codex (xhigh), read-only, on the first draft. Both: the trigger must be new participation, not a missing row; five membership writers, not one; the create body must carry the composer's choices; "Apply to All" needs a scope, a preview bound to the change, the session contract per moment, and its own budget under R10. Folded into § 3 and § 4.
