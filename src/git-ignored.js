/**
 * Which session directories a repository ignores. A conversation started in an
 * ignored folder of the project (eval runs, build output) is scratch work, not
 * a conversation about the project, so Dream leaves it out.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * @param {string} root repository root
 * @param {string[]} dirs absolute directories inside it
 * @returns {Promise<Set<string>>} the given directories git ignores; empty when git is unavailable
 */
export function ignoredDirs(root, dirs) {
  const relative = [...new Set(dirs)]
    .map((dir) => [dir, path.relative(root, dir)])
    .filter(([, rel]) => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel));
  if (relative.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('git', ['-C', root, 'check-ignore', '--stdin'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(new Set());
      return;
    }
    const timer = setTimeout(() => child.kill(), 5_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(new Set());
    });
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => {
      clearTimeout(timer);
      const ignored = new Set(out.split(/\r?\n/u).filter(Boolean).map((rel) => path.resolve(root, rel)));
      resolve(new Set(relative.filter(([dir]) => ignored.has(path.resolve(dir))).map(([dir]) => dir)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(relative.map(([, rel]) => rel.split(path.sep).join('/')).join('\n') + '\n');
  });
}
