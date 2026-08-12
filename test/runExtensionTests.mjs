import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode('stable');

try {
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, 'dist-test/test/integration/suite/index.js'),
    launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes']
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
