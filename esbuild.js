const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const configs = [
  {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    outfile: 'dist/extension.js'
  },
  {
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: 'dist/webview.js'
  }
];

async function run() {
  const contexts = await Promise.all(configs.map((config) => esbuild.context({
    ...config,
    sourcemap: !production,
    minify: production,
    logLevel: 'info'
  })));
  if (watch) {
    await Promise.all(contexts.map((context) => context.watch()));
    return;
  }
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}

run().catch(() => process.exit(1));
