# Kick and ban

If you're hosting a tasting and need to remove someone, you have two tools.

## Kick

A soft removal. The person is dropped from the session — they won't see the live tasting anymore — but they can rejoin if they have the code. Use kick for accidental joiners or when you just want someone out for now.

## Ban

A hard removal. The person is dropped AND can't rejoin. Their ratings, hall-of-fame entries, and bookmarks from this session are deleted on the spot. Use ban for spam or anyone you don't want back.

## What happens to their wines

Both kick and ban surface the same choice: if the person added any wines to the tasting, you decide whether to keep those wines in the lineup or remove them. Removing them doesn't delete the wine itself — other people who bookmarked it still find it under their **/me/saved** — it just disappears from the live tasting and from anyone's compare view.

The wines list shows up in the confirmation modal before you commit.

## What happens to their ratings

Different for kick vs ban.

- **Kick**: their ratings stay in the session until they decide otherwise. On their next visit to the session URL they get a "you were removed" screen with two options — keep the ratings in their personal history, or delete them entirely. If they never come back, the default is keep.
- **Ban**: their ratings, hall-of-fame entries, and bookmarks from this session are deleted immediately. They don't get a choice — you decided. The wine records themselves stay so other tasters' bookmarks survive.

## Who can do it

- **Hosts** can kick or ban anyone except themselves.
- **Co-hosts** can kick or ban regular tasters. They can't kick or ban another co-host.
- **Only the original host** can remove a co-host (kick or ban).

## How to do it

In the participants list inside the session overview, every row except your own and the host has a **⋯** menu. Tap it, pick **Kick** or **Ban**. The modal shows what they've added — wines, rating count — and lets you toggle "remove their wines" before confirming.

## Unbanning

Below the participants list there's a **Banned users** section (collapsed by default; expand to see who's banned). Each row has an **unban** button. Unbanning only lifts the ban — it doesn't restore any data that was deleted. The person can then rejoin with the session code.

## What banned users see

If they were logged in, the next time they open the session URL they get a screen explaining they were banned. They can't rejoin while logged in.

Bans are best-effort against determined re-join attempts. A logged-in user who's been banned can log out and rejoin as a fresh anonymous person; an anonymous user can clear their browser storage and rejoin with a fresh identity. Both create a brand new participant from the server's point of view — the same display name, but otherwise unattached to the previous one. There's no perfect fix here without forcing everyone to log in, which we don't.

## What this doesn't do

- It doesn't delete the person's account or affect anything outside this session.
- It doesn't notify them through email or any external channel — they only see it when they try to access the session.
- It doesn't interact with [Block](./block.md). Blocking someone hides their content from your feed and profile; banning them removes them from your tasting. Two different tools for two different jobs.
