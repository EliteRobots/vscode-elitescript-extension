const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out');
if (fs.existsSync(output) && fs.realpathSync(output) !== output) {
    throw new Error('Refusing to clean an output directory that resolves outside the project output path.');
}
fs.rmSync(output, { recursive: true, force: true });
const result = spawnSync(process.execPath, [require.resolve('typescript/lib/tsc.js'), '-p', root], {
    cwd: root, stdio: 'inherit', windowsHide: true,
});
if (result.error) { throw result.error; }
process.exitCode = result.status ?? 1;
