/**
 * Locate the installed DSH desktop executable and CLI without hardcoding a
 * developer's home directory. Override with DSH_EXE / DSH_CLI when installed
 * somewhere unusual.
 */
import path from 'node:path';

function localAppDataPrograms() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || '';
  return base ? path.join(base, 'Programs', 'DeepSeek Harness') : '';
}

export function resolveDshPaths() {
  const installRoot = localAppDataPrograms();
  const dshExe = process.env.DSH_EXE
    || (installRoot ? path.join(installRoot, 'DeepSeek Harness.exe') : '');
  const dshCli = process.env.DSH_CLI
    || (installRoot
      ? path.join(installRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
      : '');
  return { DSH_EXE: dshExe, DSH_CLI: dshCli };
}
