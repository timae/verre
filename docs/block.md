# Block

Block is for when you want someone out of your Verre experience — not just hidden from your feed, but mutually invisible across most of the app.

## What it does

Outside of shared tasting sessions, you and the blocked person stop seeing each other:

- **Feed** — their check-ins and badge unlocks vanish from yours, and yours from theirs.
- **Profile** — their `/u/<id>` page shows you their name and an unblock button. Nothing else. From their side, your profile looks like it doesn't exist (404).
- **Search** — neither of you turns up in the other's search results.
- **Likes** — likes between the two of you stop counting for everyone. If you block someone who'd liked one of your check-ins, that like count drops by one (for everyone, not just for you). Unblock and it comes back.
- **Tags** — past tags between you go invisible to everyone.
- **Follower and following counts** — drop globally while the block is in place, on both of your profiles.

## Inside tasting sessions

Sessions are different. You're literally in the same room — pretending the other person isn't there would be weird. So the rules relax to "render-style only" instead of full invisibility.

In the **participants list**:

- The person you blocked shows up as **[blocked]** {name}. Tap the row to open their profile and unblock them if you want.
- From the blocked person's side, the blocker looks like a plain anonymous participant — name only, no avatar, not clickable. Any role badge they have (host, co-host) stays.
- If you've both blocked each other, the **[blocked]** marker disappears on both sides. Each of you sees the other as a plain anon participant. To unblock, go to **Settings → Blocked users** — neither profile page is reachable while a mutual block is in place.

In the **Compare** screen, everyone in the session is shown as normal. We deliberately don't filter blocked people out — if a column just went missing, you could deduce the block, and that's exactly what we're not trying to surface.

Everyone else in the session sees both of you the way they always would.

## Blocking someone

Open their profile, tap the **⋯** menu, pick **Block**, then tap again to confirm. The button flashes red briefly, then the page flips to the stripped view.

## Unblocking

Two ways:

1. **Settings → Blocked users** — the canonical path. Lists everyone you've blocked with an unblock button on each row. Always works.
2. Their profile page — if it's a one-way block (only you blocked them), opening `/u/<id>` shows their name and an **Unblock** button. If you've both blocked each other, neither profile page is reachable; Settings is the only way through.

## What block doesn't do

- It doesn't tell the other person they've been blocked.
- It doesn't kick them out of sessions you're both in. (That's a separate feature for hosts — coming as a kick/ban action.)
- It doesn't delete past follows, likes, mutes, or tags. They just go invisible. Unblock and they come back.
- It doesn't hide their existence completely — your display name and theirs are always visible somewhere. Block hides activity and connection, not identity.

## Block vs mute

| | Block | Mute |
|---|---|---|
| Their posts in your feed | Hidden | Hidden |
| Your posts in their feed | Hidden | They still see them |
| Their profile | Stripped down to name + unblock | Shows normally |
| Your profile, to them | Looks like 404 | Shows normally |
| Search results | Neither of you appears | Both appear normally |
| Past tags, likes, counts | Globally hidden | Untouched |

Mute is quiet and one-sided. Block is total and two-sided — everywhere except inside a session you both joined.
