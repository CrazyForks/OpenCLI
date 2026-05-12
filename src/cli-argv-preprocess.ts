/**
 * argv preprocessing: rewrite `opencli browser <sessionname> <subcommand> ...`
 * into `opencli browser --session <sessionname> <subcommand> ...` so commander
 * (which can't combine a parent positional with subcommand dispatch) can parse it.
 *
 * The user-facing form is positional; the internal form uses --session. Help text
 * for the `browser` command is overridden to advertise the positional form.
 */

/**
 * Browser subcommand names. If `<sessionname>` would collide with one of these,
 * we treat it as a missing-positional error and leave argv alone so commander
 * reports a usable diagnostic.
 *
 * Keep in sync with the subcommands declared on the `browser` command in cli.ts.
 */
const BROWSER_SUBCOMMAND_NAMES: ReadonlySet<string> = new Set([
  'analyze',
  'back',
  'bind',
  'check',
  'click',
  'close',
  'console',
  'dblclick',
  'dialog',
  'drag',
  'eval',
  'extract',
  'fill',
  'find',
  'focus',
  'frames',
  'get',
  'help',
  'hover',
  'init',
  'keys',
  'network',
  'open',
  'screenshot',
  'scroll',
  'select',
  'state',
  'tab',
  'type',
  'unbind',
  'uncheck',
  'upload',
  'verify',
  'wait',
]);

/**
 * Returns the set of reserved subcommand names (exposed for tests so they stay
 * synced with the actual registrations in cli.ts).
 */
export function getBrowserSubcommandNames(): ReadonlySet<string> {
  return BROWSER_SUBCOMMAND_NAMES;
}

/**
 * Rewrite `argv` to convert the positional `<sessionname>` after `browser`
 * into the internal `--session <name>` flag form.
 *
 * Leaves argv unchanged when:
 *   - `browser` is not in argv
 *   - The token after `browser` is a flag (e.g. `--help`)
 *   - The token after `browser` is a known subcommand name (sessionname was
 *     omitted; commander will surface its own required-flag error)
 *   - The token after `browser` is the literal `--session` (caller is already
 *     using the internal form, possibly from agent code that hasn't migrated)
 */
export function rewriteBrowserArgv(argv: readonly string[]): string[] {
  const result = [...argv];
  for (let i = 0; i < result.length; i++) {
    if (result[i] !== 'browser') continue;
    const next = result[i + 1];
    if (next === undefined) return result;
    if (next.startsWith('-')) return result;
    if (BROWSER_SUBCOMMAND_NAMES.has(next)) return result;
    // Treat as <sessionname>: splice in --session <name> in place of the positional.
    result.splice(i + 1, 1, '--session', next);
    return result;
  }
  return result;
}
