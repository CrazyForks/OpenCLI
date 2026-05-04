# Listing↔detail ID pairing

When a site exposes both a **listing-class command** (`search` / `hot` /
`recent` / `top` / `feed` / ...) and a **detail-class command** (`read` /
`paper` / `article` / `job` / `view` / ...), the listing rows MUST include
an id-shaped column whose value can be passed directly into the detail
command.

Without that, the agent has to either re-search by title, scrape a URL out
of band, or guess — all of which break the agent-native contract.

## The rule

> If `<site>` has both a listing command and a detail command, every
> listing row MUST carry a column whose value round-trips into the detail
> command's positional argument.

That column is whatever the detail command expects:

| Site | Listing | Detail | Round-trip column |
|------|---------|--------|-------------------|
| `hackernews` | `top` / `best` / `ask` / `jobs` / `show` / `new` | `read <id>` | `id` |
| `hupu` | `hot` / `search` | `detail <tid>` | `tid` |
| `lobsters` | `hot` / `active` / `newest` / `tag` | `read <id>` | `id` (Lobsters short_id value) |
| `arxiv` | `search` / `recent` | `paper <id>` | `id` |
| `stackoverflow` | `hot` / `search` / `bounties` / `unanswered` | `read <id>` | `id` |
| `openreview` | `search` / `venue` | `paper <id>` / `reviews <forum>` | `id` |
| `devto` | `top` / `tag` / `user` | `read <id>` | `id` |
| `bilibili` | `hot` | `video <bvid>` | `bvid` |
| `reddit` | `hot` | `read <id>` | `id` |
| `bluesky` | `user` | `thread <uri>` | `uri` |
| `1688` | `search` | `item <url-or-offer-id>` | `offer_id` |
| `tieba` | `search` | `read <id>` | `id` |

## Why this matters

The agent never has eyes on a webpage. It sees the listing rows as a
plain table of strings. If the listing emits `[rank, title, author, votes]`
and the detail command needs an id, the agent has three bad options:

1. **Re-search by title** — fragile, may hit a different post for ambiguous
   titles, costs an extra round-trip plus quota.
2. **Parse the URL** — assumes URL shape stays stable and is regex-able,
   often breaks across A/B buckets or after a site redesign.
3. **Hand-craft a search** — pure guess; agents trained to do this leak
   the failure mode silently downstream.

Surfacing the id in the listing collapses all three into a single,
unambiguous column. It is the cheapest and most durable way to keep the
listing→detail call chain agent-native.

## What counts as an "id-shaped column"

The validator (`scripts/check-listing-id-pairing.mjs`) considers any of
these column names a valid round-trip handle:

- Exact `id` / `short_id`
- Anything ending in `_id` or `Id` (e.g. `offer_id`, `paperId`)
- Domain-specific ids: `jk` (indeed), `tid` (thread id), `bvid` / `aid`
  (bilibili), `sku` (retail product SKU), `asin` (amazon), `isbn`, `doi`,
  `slug`
- `username` / `handle` (only when the detail command keys off the user
  rather than a post)
- `url` — only when the detail command's positional argument explicitly
  accepts a URL (for example `read <url-or-id>` or `article <url>`). URL is
  not a valid substitute when the detail command expects a site id.
- `uri` — for sites whose canonical handle is a URI scheme (e.g.
  Bluesky's `at://did:.../app.bsky.feed.post/...`).

If the natural id for your site is a different shape, add the pattern to
`ID_COLUMN_PATTERNS` in the validator and document it here.

## What is intentionally exempt

The rule does NOT fire on:

- **Comment / review / reply listings** (`bilibili comments`,
  `youtube comments`, `taobao reviews`, `weibo comments`, ...). The rows
  are sub-resources within a parent thread; the detail command on those
  sites fetches the parent post, not the comment. Keep the parent's id in
  the *args* of the comments command, not in the rows.
- **AI-chat / agent-session listings** (`chatgpt-app ask`, `claude new`,
  `codex ask`, ...). The rows are conversation turns inside one session,
  not separately fetchable.
- **Topic / landing-page listings** (`tieba hot`). Their rows point to a
  topic landing page, not to a thread entity accepted by the detail command.
- **Single-profile field listings** (`reddit user`, `lesswrong user`).
  Their shape is `[field, value]` — every row is an attribute of the
  same profile, addressed by the username arg. There is no per-row entity
  to round-trip.

These categories are encoded by their command name being absent from
`LISTING_NAMES` in the validator.

## How to add an id column to a listing

1. **Find the source field.** Most listing endpoints already include the
   id in their raw response — they're just dropped before the row is
   shaped. Check `func`'s mapper before adding new fetch logic.
2. **Pick the column position.** Convention is `[rank, id, ...rest, url]`
   so identifiers stay near the front and the URL stays last.
3. **Update the docs.** The site's `docs/adapters/browser/<site>.md`
   should list the new column under "Listing columns" and call out that
   it round-trips into the detail command.
4. **Run the validator.**

   ```bash
   node scripts/check-listing-id-pairing.mjs --strict
   ```

## Validator usage

```bash
# Report-only (default): exit 0 even on violations
node scripts/check-listing-id-pairing.mjs

# Strict (CI): exit 1 if any listing is missing an id column
node scripts/check-listing-id-pairing.mjs --strict
```

The script reads `cli-manifest.json`, so always rebuild the manifest
(`npx tsx src/build-manifest.ts`) after touching adapter columns.

## Related principles

- [`docs/developer/ts-adapter.md`](../developer/ts-adapter.md) — adapter
  authoring conventions, including the required `access: 'read' | 'write'`
  metadata.
- "Output design" reference inside the bundled
  `opencli-adapter-author` skill — column naming, ordering, and id-first
  conventions.
