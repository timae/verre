# Session roles

Every participant in a tasting has exactly one role: **host**, **co-host**, **provider**, or **taster**. The role decides what they can do — adding wines, changing settings, moderating, and so on.

## The roles at a glance

- **Host** — the person who created the session. Full powers. There's exactly one host per session.
- **Co-host** — a trusted helper. Can do almost everything the host can, except assign co-host roles or delete the session.
- **Provider** — someone bringing wines to the tasting. Can add wines and edit their own, but nothing else.
- **Taster** — the default role anyone gets when they join. Rates wines, joins the discussion, doesn't manage anything.

## What each role can do

|  | Host | Co-host | Provider | Taster |
|---|---|---|---|---|
| Rate wines | ✓ | ✓ | ✓ | ✓ |
| Add wines | ✓ | ✓ | ✓ | — |
| Edit / delete any wine | ✓ | ✓ | — | — |
| Edit / delete own wines | ✓ | ✓ | ✓ | — |
| Reorder the lineup | ✓ | ✓ | — | — |
| Reveal / hide blind wines | ✓ | ✓ | — | — |
| Change session settings, rename, edit dates | ✓ | ✓ | — | — |
| Kick or ban participants | ✓ | ✓ | — | — |
| Assign Provider or Taster roles | ✓ | ✓ | — | — |
| Assign Co-host role | ✓ | — | — | — |
| Delete the session | ✓ | — | — | — |

A participant is exactly one of these at a time. Picking a new role replaces the old one.

## Who can assign which role

In the participants list, tap **Set role** (or **Change role**) on a row. You'll see a picker with the roles you're allowed to set.

- **Hosts** can assign all three: Co-host, Provider, or Taster.
- **Co-hosts** can only assign Provider or Taster — promoting someone to co-host requires the original host. The same applies in reverse: demoting a co-host back to taster or provider also requires the host.

## Blind tasting

In a blind tasting, everyone except the host sees wines as anonymous bottles ("Wine 1", "Wine 2", etc.) until the host taps **reveal**.

- **Host** sees everything un-redacted from the start (they're running the tasting).
- **Co-hosts** see the same blind view as tasters — they help run the session, but the blind is still a blind for them.
- **Providers** are a small exception: the wines _they_ added show up un-redacted in their own view, because they brought them and obviously already know what's in the bottle. Other people's wines stay hidden until reveal.
- **Tasters** see the full blind view until the host reveals each wine.

## Kicking and banning

Hosts can remove anyone. Co-hosts can remove tasters and providers, but not other co-hosts — banning a co-host requires the original host (it's effectively demoting them, so the same "only the host touches co-host" rule applies). Providers themselves can't kick or ban — moderation stays with host and co-host.

When you remove someone who added wines, the moderation modal offers a "keep or remove" choice for their wines. The "added by" record stays on each wine either way, so even after a removal you can still tell who brought what.

For the full details on kick vs. ban, what gets deleted, and what stays, see [Kick and ban](./kick-ban.md).
