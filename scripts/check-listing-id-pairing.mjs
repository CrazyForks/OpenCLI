#!/usr/bin/env node
/**
 * check-listing-id-pairing.mjs — verify listing↔detail id round-tripping.
 *
 * Agent-native rule: when a site exposes both a listing-class command
 * (search / hot / recent / trending / top / feed / popular / new / list)
 * AND a detail-class command (read / article / paper / post / detail /
 * view / job / page / book / movie / show / chapter / question / answer /
 * tweet / video / track), every listing row must include an id-shaped
 * column whose value can be fed into the detail command's positional
 * argument. Without that, the agent has to re-search by title, scrape
 * a URL, or guess — all of which break the agent-native contract.
 *
 * What this script does:
 *  1. Group cli-manifest.json entries by site.
 *  2. For each site that has both classes, walk every listing entry and
 *     check `columns` for at least one id-shaped name.
 *  3. Fail (exit 1 in --strict) on any listing missing an id column.
 *
 * Heuristic, not perfect: the script only checks for the *presence* of an
 * id-shaped column on listings; it doesn't verify the id format actually
 * matches the detail command's positional arg. That stays a manual review
 * concern — the column shape gate alone catches the silent-loss class
 * (listings that emit only title/author/url and force the agent to scrape
 * the URL for an id).
 *
 * Usage:
 *   node scripts/check-listing-id-pairing.mjs           # report only
 *   node scripts/check-listing-id-pairing.mjs --strict  # exit 1 on violations
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(__dirname, '..', 'cli-manifest.json');

/**
 * Listing-class commands. Each row represents a single fetchable entity
 * (post / paper / job / ...). The id of that entity must round-trip into
 * the site's detail command.
 */
const LISTING_NAMES = new Set([
    'search', 'hot', 'recent', 'trending', 'top', 'feed', 'popular',
    'list', 'best', 'newest', 'latest', 'rising', 'controversial',
    'home', 'timeline', 'browse', 'discover', 'jobs',
    'unanswered', 'bounties', 'tag', 'user', 'venue',
    'category', 'subreddit', 'question',
]);

/**
 * Listing-class commands whose rows are sub-resources within a parent
 * thread/session, NOT independently fetchable. Excluded from the rule:
 *
 * - `comments` / `replies` / `reviews` / `answer-list` / `thread-list`
 *   — rows are comments under a parent post; the detail command fetches
 *   the parent, not the comment
 * - `ask` / `new` / `show` for AI-chat / agent-session sites — rows are
 *   conversation turns within one session, not separately addressable
 *
 * These are intentionally NOT in `LISTING_NAMES` so the rule doesn't
 * fire on them.
 */


const DETAIL_NAMES = new Set([
    'read', 'article', 'paper', 'post', 'detail', 'view', 'job',
    'page', 'book', 'movie', 'show-detail', 'chapter', 'tweet',
    'video', 'track', 'note', 'review', 'item', 'product', 'episode',
    'thread', 'comment-detail', 'profile-detail',
]);

/**
 * Listing/site pairs that are intentionally exempt because the listing
 * rows are a different entity type from what the detail command fetches.
 * Each exemption records WHY so future maintainers know what to verify
 * before removing the entry.
 */
const EXEMPT = new Map([
    ['nowcoder/hot', 'hot rows are search queries / topics, not posts; nowcoder/detail fetches a post by id'],
    ['bluesky/trending', 'trending rows are topic strings, not threads; bluesky/thread fetches a single thread by url'],
    ['twitter/trending', 'trending rows are topic strings, not tweets; twitter/post|thread|article fetch by tweet id or username/id'],
    ['lesswrong/user', 'rows are profile-attribute key/value pairs; lesswrong/read fetches a post, addressed by post id'],
    ['reddit/user', 'rows are profile-attribute key/value pairs; reddit/read fetches a post, addressed by post id'],
    ['discord-app/search', 'desktop UI session — message ids are not extractable from the rendered DOM'],
    ['notion/search', 'Strategy.UI Quick Find — page ids are not exposed in the rendered DOM; agents navigate via Notion UI (Cmd+P), not by id round-trip'],
    ['tieba/hot', 'hot rows are topic landing pages, not thread rows; tieba/read fetches a thread by numeric id'],
]);

/** Columns whose name implies "this is an id you can pass to detail". */
const ID_COLUMN_PATTERNS = [
    /^id$/i,
    /_id$/i,
    /Id$/,
    /^short_id$/i,
    /^jk$/i,             // indeed
    /^tid$/i,            // hupu / thread id
    /^bvid$/i,           // bilibili
    /^aid$/i,            // anime / bilibili av
    /^asin$/i,           // amazon
    /^sku$/i,            // jd / retail product SKU
    /^isbn$/i,           // book sites
    /^doi$/i,            // arxiv / openreview
    /^slug$/i,           // dev.to / lobsters short slug
    /^hn_id$/i,
    /^username$/i,       // user-keyed detail (profile commands)
    /^handle$/i,
    /^uri$/i,            // bluesky AT URI (at://did:.../...)
];

function isUrlDetailCommand(entry) {
    const args = Array.isArray(entry.args) ? entry.args : [];
    const primaryArg = args.find((arg) => arg?.positional || arg?.required) ?? args[0];
    if (!primaryArg) return false;
    const name = String(primaryArg.name ?? '').toLowerCase();
    const help = String(primaryArg.help ?? '').toLowerCase();
    return name === 'url' || name === 'url-or-id' || help.includes('url');
}

function isIdColumn(col, detailCommands) {
    if (ID_COLUMN_PATTERNS.some((re) => re.test(col))) return true;
    if (/^url$/i.test(col)) {
        return detailCommands.some(isUrlDetailCommand);
    }
    return false;
}

function classify(name) {
    if (LISTING_NAMES.has(name)) return 'listing';
    if (DETAIL_NAMES.has(name)) return 'detail';
    return 'other';
}

function main() {
    const strict = process.argv.includes('--strict');
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

    const bySite = new Map();
    for (const entry of manifest) {
        if (!entry?.site || !entry?.name) continue;
        if (!bySite.has(entry.site)) bySite.set(entry.site, []);
        bySite.get(entry.site).push(entry);
    }

    const violations = [];
    const exempted = [];
    let scannedSites = 0;
    let scannedListings = 0;

    for (const [site, entries] of bySite) {
        // Only `access: 'read'` detail commands count — write commands like
        // `instagram/post` or `instagram/note` create remote state, they don't
        // fetch by id, so the listing→detail pairing rule doesn't apply.
        const readDetail = entries.filter(
            (e) => classify(e.name) === 'detail' && e.access === 'read',
        );
        const hasListing = entries.some((e) => classify(e.name) === 'listing');
        if (!hasListing || readDetail.length === 0) continue;
        scannedSites++;

        for (const entry of entries) {
            if (classify(entry.name) !== 'listing') continue;
            scannedListings++;
            const key = `${site}/${entry.name}`;
            if (EXEMPT.has(key)) {
                exempted.push({ key, reason: EXEMPT.get(key) });
                continue;
            }
            const columns = Array.isArray(entry.columns) ? entry.columns : [];
            if (!columns.some((col) => isIdColumn(col, readDetail))) {
                violations.push({
                    site,
                    name: entry.name,
                    columns,
                    detail: readDetail.map((e) => e.name),
                });
            }
        }
    }

    console.log(`Scanned ${scannedSites} site(s) with both listing and read-detail commands.`);
    console.log(`Checked ${scannedListings} listing command(s); ${exempted.length} exempted.`);

    if (violations.length === 0) {
        console.log('OK — every listing carries an id-shaped column.');
        process.exit(0);
    }

    console.log('');
    console.log(`Found ${violations.length} listing(s) missing a round-trippable id column:`);
    for (const v of violations) {
        console.log(`  • ${v.site}/${v.name}`);
        console.log(`      columns: [${v.columns.join(', ')}]`);
        console.log(`      detail commands on this site: ${v.detail.join(', ')}`);
    }
    console.log('');
    console.log('Add an id-shaped column (id / short_id / jk / bvid / asin / etc.)');
    console.log('to each listing so its rows round-trip into the detail command.');
    console.log('See docs/conventions/listing-detail-id-pairing.md for the full rule.');

    if (strict) process.exit(1);
}

main();
