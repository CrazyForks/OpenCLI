/**
 * Reddit post reader with threaded comment tree.
 *
 * Replaces the original flat read.yaml with recursive comment traversal:
 * - Top-K comments by score at each level
 * - Configurable depth and replies-per-level
 * - Indented output showing conversation threads
 * - Optional --expand-more to follow Reddit's "more comments" stubs via
 *   /api/morechildren.json (rdt-cli parity, PR B of #1481 follow-up)
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

const REDDIT_EXPAND_ROUNDS_MIN = 1;
const REDDIT_EXPAND_ROUNDS_MAX = 5;
const DEFAULT_EXPAND_ROUNDS = 2;

export function parseExpandRounds(raw) {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_EXPAND_ROUNDS;
    const n = Number(raw);
    if (
        !Number.isFinite(n) || !Number.isInteger(n)
        || n < REDDIT_EXPAND_ROUNDS_MIN || n > REDDIT_EXPAND_ROUNDS_MAX
    ) {
        throw new ArgumentError(
            `expand-rounds must be an integer in [${REDDIT_EXPAND_ROUNDS_MIN}, ${REDDIT_EXPAND_ROUNDS_MAX}].`,
            `Got: ${raw}`,
        );
    }
    return n;
}

cli({
    site: 'reddit',
    name: 'read',
    access: 'read',
    description: 'Read a Reddit post and its comments',
    domain: 'reddit.com',
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    args: [
        { name: 'post-id', required: true, positional: true, help: 'Post ID (e.g. 1abc123) or full URL' },
        { name: 'sort', default: 'best', help: 'Comment sort: best, top, new, controversial, old, qa' },
        { name: 'limit', type: 'int', default: 25, help: 'Number of top-level comments' },
        { name: 'depth', type: 'int', default: 2, help: 'Max reply depth (1=no replies, 2=one level of replies, etc.)' },
        { name: 'replies', type: 'int', default: 5, help: 'Max replies shown per comment at each level (sorted by score)' },
        { name: 'max-length', type: 'int', default: 2000, help: 'Max characters per comment body (min 100)' },
        {
            name: 'expand-more',
            type: 'bool',
            default: false,
            help: 'Follow Reddit "more comments" stubs by calling /api/morechildren.json',
        },
        {
            name: 'expand-rounds',
            type: 'int',
            default: DEFAULT_EXPAND_ROUNDS,
            help: `Max expansion passes when --expand-more is on (${REDDIT_EXPAND_ROUNDS_MIN}–${REDDIT_EXPAND_ROUNDS_MAX}; each round can fan out new "more" stubs)`,
        },
    ],
    columns: ['type', 'author', 'score', 'text'],
    func: async (page, kwargs) => {
        // Note: --limit / --depth / --replies / --max-length keep their original
        // Math.max-style behaviour for backward compatibility (grandfathered in
        // the typed-error-lint baseline). The new --expand-rounds argument is
        // strictly validated via parseExpandRounds — no silent clamp.
        const sort = kwargs.sort ?? 'best';
        const limit = Math.max(1, kwargs.limit ?? 25);
        const maxDepth = Math.max(1, kwargs.depth ?? 2);
        const maxReplies = Math.max(1, kwargs.replies ?? 5);
        const maxLength = Math.max(100, kwargs['max-length'] ?? 2000);
        const expandMore = Boolean(kwargs['expand-more']);
        const expandRounds = parseExpandRounds(kwargs['expand-rounds']);

        await page.goto('https://www.reddit.com');

        // The in-browser script returns a discriminated union so we can map
        // each failure mode to its proper typed error on the Node side
        // (page.evaluate boundary can't carry typed error instances). Kinds:
        //   - inaccessible: 401/403/404 on /comments/<id>.json (post-specific,
        //     not session auth — same session works for other posts)
        //   - auth:         /api/morechildren.json 401/403 (session-level on
        //     the write-like expand endpoint — see two-pronged auth detection
        //     sediment from PR #1428)
        //   - http:         5xx or other non-ok
        //   - malformed:    200 but Reddit shape is unexpected (schema drift)
        //   - parser-drift: tree non-empty but walk produced 0 rows
        //   - expand-failed: morechildren returned errors
        //   - ok:           rows array
        //
        // Intermediate keys (`rows` / `detail` / `httpStatus` / `where`)
        // deliberately avoid the declared columns (`type`/`author`/`score`/
        // `text`) to sidestep the silent-column-drop audit (PR #1329).
        const result = await page.evaluate(`
      (async function() {
        var postIdRaw = ${JSON.stringify(kwargs['post-id'])};
        var urlMatch = postIdRaw.match(/comments\\/([a-z0-9]+)/);
        var postId = urlMatch ? urlMatch[1] : postIdRaw;
        var linkFullname = 't3_' + postId;

        var sort = ${JSON.stringify(sort)};
        var limit = ${limit};
        var maxDepth = ${maxDepth};
        var maxReplies = ${maxReplies};
        var maxLength = ${maxLength};
        var expandMore = ${JSON.stringify(expandMore)};
        var expandRounds = ${expandRounds};

        // ---------------------------------------------------------------
        // Step 1: fetch the post + initial comment tree
        // ---------------------------------------------------------------
        // Request more from API than top-level limit to get inline replies.
        // depth param tells Reddit how deep to inline replies vs "more" stubs.
        var apiLimit = Math.max(limit * 3, 100);
        var res = await fetch(
          '/comments/' + postId + '.json?sort=' + sort + '&limit=' + apiLimit + '&depth=' + (maxDepth + 1) + '&raw_json=1',
          { credentials: 'include' }
        );
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          return { kind: 'inaccessible', detail: 'Reddit post ' + postId + ' is not accessible (HTTP ' + res.status + ').' };
        }
        if (!res.ok) {
          return { kind: 'http', httpStatus: res.status, where: '/comments/' + postId + '.json' };
        }
        var data;
        try { data = await res.json(); } catch (e) {
          return { kind: 'malformed', detail: 'Failed to parse Reddit /comments/' + postId + '.json response: ' + (e && e.message || e) };
        }
        if (!Array.isArray(data) || data.length < 2) {
          return { kind: 'malformed', detail: 'Reddit /comments/' + postId + '.json had unexpected envelope shape (length ' + (Array.isArray(data) ? data.length : typeof data) + ').' };
        }

        var post = data[0] && data[0].data && data[0].data.children && data[0].data.children[0] && data[0].data.children[0].data;
        if (!post) {
          return { kind: 'malformed', detail: 'Reddit /comments/' + postId + '.json had no post body.' };
        }
        var topListing = data[1] && data[1].data && Array.isArray(data[1].data.children) ? data[1].data.children : null;
        if (!topListing) {
          return { kind: 'malformed', detail: 'Reddit /comments/' + postId + '.json had no comment listing.' };
        }

        // ---------------------------------------------------------------
        // Step 2: optionally follow "more" stubs via /api/morechildren.json
        // ---------------------------------------------------------------
        // Each "more" thing has a .data.children array (t1 ids to fetch).
        // The morechildren API returns a FLAT list of things; we re-thread
        // them by parent_id (either t3_<postId> for top-level or t1_<id>
        // for nested). Each round may surface new "more" stubs (because
        // expansion is bounded by Reddit's depth param), so we iterate up
        // to expandRounds times.
        var expandMeta = { rounds: 0, fetched: 0, capped: false, errors: [] };

        if (expandMore) {
          // Index every existing t1 node so we can splice replies onto it.
          var t1Index = {};
          function indexT1(arr) {
            if (!Array.isArray(arr)) return;
            for (var i = 0; i < arr.length; i++) {
              var node = arr[i];
              if (node && node.kind === 't1' && node.data && node.data.id) {
                t1Index[node.data.name || ('t1_' + node.data.id)] = node;
                if (node.data.replies && node.data.replies.data && node.data.replies.data.children) {
                  indexT1(node.data.replies.data.children);
                }
              }
            }
          }
          indexT1(topListing);

          // Collect "more" stubs (with non-empty children) from anywhere in
          // the tree. Each stub knows its host array via a closure-bound
          // reference we attach.
          function collectMoreStubs(parentArr, parentT1) {
            var out = [];
            if (!Array.isArray(parentArr)) return out;
            for (var i = 0; i < parentArr.length; i++) {
              var n = parentArr[i];
              if (!n || !n.data) continue;
              if (n.kind === 'more' && Array.isArray(n.data.children) && n.data.children.length > 0) {
                out.push({ stub: n, hostArr: parentArr, hostT1: parentT1 });
              } else if (n.kind === 't1' && n.data.replies && n.data.replies.data && n.data.replies.data.children) {
                var nested = collectMoreStubs(n.data.replies.data.children, n);
                for (var k = 0; k < nested.length; k++) out.push(nested[k]);
              }
            }
            return out;
          }

          for (var r = 0; r < expandRounds; r++) {
            var stubs = collectMoreStubs(topListing, null);
            if (stubs.length === 0) break;

            // Build the union of t1 ids to request this round. Reddit's
            // morechildren API caps at ~100 ids per call; batch accordingly.
            var allIds = [];
            for (var s = 0; s < stubs.length; s++) {
              var st = stubs[s].stub;
              for (var c = 0; c < st.data.children.length; c++) allIds.push(st.data.children[c]);
            }
            if (allIds.length === 0) break;

            // dedupe preserving order
            var seen = {};
            var uniqIds = [];
            for (var j = 0; j < allIds.length; j++) {
              if (!seen[allIds[j]]) { seen[allIds[j]] = 1; uniqIds.push(allIds[j]); }
            }

            var fetchedThings = [];
            var batchSize = 100;
            var batchFailed = false;
            for (var b = 0; b < uniqIds.length; b += batchSize) {
              var batch = uniqIds.slice(b, b + batchSize);
              var body = 'api_type=json'
                + '&link_id=' + encodeURIComponent(linkFullname)
                + '&children=' + encodeURIComponent(batch.join(','))
                + '&sort=' + encodeURIComponent(sort)
                + '&raw_json=1';
              var mcRes;
              try {
                mcRes = await fetch('/api/morechildren', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: body,
                });
              } catch (e) {
                return { kind: 'expand-failed', detail: 'morechildren request threw: ' + (e && e.message || e), expandMeta: expandMeta };
              }
              if (mcRes.status === 401 || mcRes.status === 403) {
                return { kind: 'auth', detail: '/api/morechildren returned HTTP ' + mcRes.status + ' (write/expand likely requires login)' };
              }
              if (!mcRes.ok) {
                return { kind: 'http', httpStatus: mcRes.status, where: '/api/morechildren (round ' + (r + 1) + ', batch ' + ((b / batchSize) + 1) + ')' };
              }
              var mcData;
              try { mcData = await mcRes.json(); } catch (e) {
                return { kind: 'malformed', detail: 'Failed to parse /api/morechildren response: ' + (e && e.message || e) };
              }
              var errs = mcData && mcData.json && mcData.json.errors;
              if (Array.isArray(errs) && errs.length > 0) {
                return { kind: 'expand-failed', detail: 'Reddit /api/morechildren rejected: ' + errs.map(function(e) { return e.join(': '); }).join('; '), expandMeta: expandMeta };
              }
              var things = mcData && mcData.json && mcData.json.data && mcData.json.data.things;
              if (!Array.isArray(things)) {
                return { kind: 'malformed', detail: '/api/morechildren returned no things array.' };
              }
              for (var t = 0; t < things.length; t++) fetchedThings.push(things[t]);
            }
            expandMeta.rounds = r + 1;
            expandMeta.fetched += fetchedThings.length;

            // Re-thread fetched things by parent_id. Parents are either the
            // post (t3_<postId>) → top-level listing, or another t1 → its
            // replies.data.children. We must respect Reddit's depth/inline
            // semantics: if the parent t1 has no replies object yet (because
            // initial fetch didn't inline replies there), create the shell.
            function ensureReplies(parentNode) {
              if (!parentNode.data.replies || typeof parentNode.data.replies !== 'object') {
                parentNode.data.replies = { kind: 'Listing', data: { children: [] } };
                return parentNode.data.replies.data.children;
              }
              if (!parentNode.data.replies.data) {
                parentNode.data.replies.data = { children: [] };
                return parentNode.data.replies.data.children;
              }
              if (!Array.isArray(parentNode.data.replies.data.children)) {
                parentNode.data.replies.data.children = [];
              }
              return parentNode.data.replies.data.children;
            }

            // First: remove old stubs so we can replace with fresh content.
            // The stubs we collected may have been replaced if their children
            // overlap; do a safe filter.
            for (var s = 0; s < stubs.length; s++) {
              var rec = stubs[s];
              var idx = rec.hostArr.indexOf(rec.stub);
              if (idx >= 0) rec.hostArr.splice(idx, 1);
            }

            // Now insert fetched things.
            for (var t = 0; t < fetchedThings.length; t++) {
              var thing = fetchedThings[t];
              if (!thing || !thing.data) continue;
              var parentId = thing.data.parent_id;
              var dest;
              if (parentId === linkFullname) {
                dest = topListing;
              } else if (parentId && parentId.indexOf('t1_') === 0 && t1Index[parentId]) {
                dest = ensureReplies(t1Index[parentId]);
              } else {
                // Orphaned thing whose parent isn't in our tree (depth
                // boundary). Drop with metadata rather than silently lose.
                expandMeta.errors.push('orphan: ' + (thing.data.id || '?') + ' parent=' + (parentId || '?'));
                continue;
              }
              dest.push(thing);
              if (thing.kind === 't1' && thing.data && thing.data.id) {
                t1Index[thing.data.name || ('t1_' + thing.data.id)] = thing;
              }
            }

            if (r + 1 >= expandRounds) {
              // If after the last round there are still "more" stubs, mark capped.
              var remaining = collectMoreStubs(topListing, null);
              if (remaining.length > 0) expandMeta.capped = true;
            }
          }
        }

        // ---------------------------------------------------------------
        // Step 3: walk the (possibly augmented) tree into indented rows
        // ---------------------------------------------------------------
        var rows = [];

        // Post header row.
        var body = post.selftext || '';
        if (body.length > maxLength) body = body.slice(0, maxLength) + '\\n... [truncated]';
        rows.push({
          type: 'POST',
          author: post.author || '[deleted]',
          score: post.score || 0,
          text: post.title + (body ? '\\n\\n' + body : '') + (post.url && !post.is_self ? '\\n' + post.url : ''),
        });

        // Recursive comment walker.
        function walkComment(node, depth) {
          if (!node || node.kind !== 't1') return;
          var d = node.data;
          var cBody = d.body || '';
          if (cBody.length > maxLength) cBody = cBody.slice(0, maxLength) + '...';

          var indent = '';
          for (var i = 0; i < depth; i++) indent += '  ';
          var prefix = depth === 0 ? '' : indent + '> ';
          var indentedBody = depth === 0
            ? cBody
            : cBody.split('\\n').map(function(line) { return prefix + line; }).join('\\n');

          rows.push({
            type: depth === 0 ? 'L0' : 'L' + depth,
            author: d.author || '[deleted]',
            score: d.score || 0,
            text: indentedBody,
          });

          var t1Children = [];
          var moreCount = 0;
          if (d.replies && d.replies.data && d.replies.data.children) {
            var children = d.replies.data.children;
            for (var i = 0; i < children.length; i++) {
              if (children[i].kind === 't1') {
                t1Children.push(children[i]);
              } else if (children[i].kind === 'more') {
                moreCount += children[i].data.count || 0;
              }
            }
          }

          if (depth + 1 >= maxDepth) {
            var totalHidden = t1Children.length + moreCount;
            if (totalHidden > 0) {
              var cutoffIndent = '';
              for (var j = 0; j <= depth; j++) cutoffIndent += '  ';
              rows.push({
                type: 'L' + (depth + 1),
                author: '',
                score: '',
                text: cutoffIndent + '[+' + totalHidden + ' more replies]',
              });
            }
            return;
          }

          t1Children.sort(function(a, b) { return (b.data.score || 0) - (a.data.score || 0); });
          var toProcess = Math.min(t1Children.length, maxReplies);
          for (var i = 0; i < toProcess; i++) {
            walkComment(t1Children[i], depth + 1);
          }

          var hidden = t1Children.length - toProcess + moreCount;
          if (hidden > 0) {
            var moreIndent = '';
            for (var j = 0; j <= depth; j++) moreIndent += '  ';
            rows.push({
              type: 'L' + (depth + 1),
              author: '',
              score: '',
              text: moreIndent + '[+' + hidden + ' more replies]',
            });
          }
        }

        var t1TopLevel = [];
        for (var i = 0; i < topListing.length; i++) {
          if (topListing[i].kind === 't1') t1TopLevel.push(topListing[i]);
        }

        // Detect parser drift: tree had content but the walker produced nothing.
        // We must check this AFTER the walk because top-level may be only "more"
        // stubs (legitimate empty case for a brand-new post).
        var preWalkSize = topListing.length;
        for (var i = 0; i < Math.min(t1TopLevel.length, limit); i++) {
          walkComment(t1TopLevel[i], 0);
        }

        var moreTopLevel = topListing.filter(function(c) { return c.kind === 'more'; })
          .reduce(function(sum, c) { return sum + (c.data.count || 0); }, 0);
        var hiddenTopLevel = Math.max(0, t1TopLevel.length - limit) + moreTopLevel;
        if (hiddenTopLevel > 0) {
          rows.push({
            type: '',
            author: '',
            score: '',
            text: '[+' + hiddenTopLevel + ' more top-level comments]',
          });
        }

        // If we produced nothing beyond the POST row but the comment listing
        // wasn't empty, that's parser drift (e.g. Reddit changed t1/more
        // schema). Surface as CommandExecutionError on the Node side.
        if (rows.length <= 1 && preWalkSize > 0 && t1TopLevel.length > 0) {
          return { kind: 'parser-drift', detail: 'Reddit comment listing for post ' + postId + ' had ' + t1TopLevel.length + ' t1 entries but walker produced no rows.' };
        }

        return { kind: 'ok', rows: rows, expandMeta: expandMeta };
      })()
    `);

        if (!result || typeof result !== 'object') {
            throw new CommandExecutionError('Reddit /comments fetch returned no result envelope.');
        }
        if (result.kind === 'inaccessible') {
            throw new EmptyResultError(result.detail);
        }
        if (result.kind === 'auth') {
            throw new AuthRequiredError('reddit.com', result.detail);
        }
        if (result.kind === 'http') {
            throw new CommandExecutionError(`HTTP ${result.httpStatus} from ${result.where}`);
        }
        if (result.kind === 'malformed') {
            throw new CommandExecutionError(result.detail);
        }
        if (result.kind === 'parser-drift') {
            throw new CommandExecutionError(result.detail);
        }
        if (result.kind === 'expand-failed') {
            throw new CommandExecutionError(result.detail);
        }
        if (result.kind !== 'ok' || !Array.isArray(result.rows)) {
            throw new CommandExecutionError(`Unexpected result from reddit read: ${JSON.stringify(result)}`);
        }
        return result.rows;
    },
});
