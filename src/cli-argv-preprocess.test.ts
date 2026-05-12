import { describe, expect, it } from 'vitest';
import { getBrowserSubcommandNames, rewriteBrowserArgv } from './cli-argv-preprocess.js';

describe('rewriteBrowserArgv', () => {
  it('rewrites `browser <sessionname> <subcommand>` into `browser --session <name> <subcommand>`', () => {
    expect(rewriteBrowserArgv(['browser', 'work', 'state'])).toEqual([
      'browser',
      '--session',
      'work',
      'state',
    ]);
  });

  it('rewrites with subcommand arguments preserved', () => {
    expect(rewriteBrowserArgv(['browser', 'mercury', 'open', 'https://x.com'])).toEqual([
      'browser',
      '--session',
      'mercury',
      'open',
      'https://x.com',
    ]);
  });

  it('rewrites `browser <sessionname> bind`', () => {
    expect(rewriteBrowserArgv(['browser', 'mercury', 'bind'])).toEqual([
      'browser',
      '--session',
      'mercury',
      'bind',
    ]);
  });

  it('leaves argv alone when sessionname omitted and a subcommand follows', () => {
    // Commander surfaces the required-flag error itself.
    expect(rewriteBrowserArgv(['browser', 'state'])).toEqual(['browser', 'state']);
    expect(rewriteBrowserArgv(['browser', 'bind'])).toEqual(['browser', 'bind']);
  });

  it('leaves argv alone when the token after `browser` is a flag', () => {
    expect(rewriteBrowserArgv(['browser', '--help'])).toEqual(['browser', '--help']);
    expect(rewriteBrowserArgv(['browser', '-h'])).toEqual(['browser', '-h']);
  });

  it('leaves argv alone when the caller already used the internal --session flag', () => {
    expect(rewriteBrowserArgv(['browser', '--session', 'foo', 'state'])).toEqual([
      'browser',
      '--session',
      'foo',
      'state',
    ]);
  });

  it('leaves argv alone when `browser` is not present', () => {
    expect(rewriteBrowserArgv(['twitter', 'tweets', '@elonmusk'])).toEqual([
      'twitter',
      'tweets',
      '@elonmusk',
    ]);
    expect(rewriteBrowserArgv(['doctor'])).toEqual(['doctor']);
  });

  it('returns argv unchanged when `browser` is the last token', () => {
    expect(rewriteBrowserArgv(['browser'])).toEqual(['browser']);
  });

  it('does not rewrite occurrences of `browser` after the first match', () => {
    // The first browser keyword wins so a later string value (e.g. an open URL)
    // can't collide with the rewrite.
    expect(rewriteBrowserArgv(['browser', 'work', 'open', 'browser', 'state'])).toEqual([
      'browser',
      '--session',
      'work',
      'open',
      'browser',
      'state',
    ]);
  });

  it('reserved subcommand list covers every known browser subcommand registered in cli.ts', () => {
    const names = getBrowserSubcommandNames();
    const required = [
      'analyze', 'back', 'bind', 'check', 'click', 'close', 'console', 'dblclick',
      'dialog', 'drag', 'eval', 'extract', 'fill', 'find', 'focus', 'frames',
      'get', 'hover', 'init', 'keys', 'network', 'open', 'screenshot', 'scroll',
      'select', 'state', 'tab', 'type', 'unbind', 'uncheck', 'upload', 'verify',
      'wait',
    ];
    for (const name of required) {
      expect(names.has(name)).toBe(true);
    }
  });
});
