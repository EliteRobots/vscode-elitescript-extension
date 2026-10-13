const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const executable = process.env.VSCODE_EXECUTABLE;
if (!executable) { throw new Error('Set VSCODE_EXECUTABLE to the VS Code application executable.'); }
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.test-artifacts', 'vscode-' + Date.now());
const profile = path.join(artifacts, 'user-data');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({
    'elitescript.documentationLanguage': 'en',
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
}));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [
    '--user-data-dir=' + profile, '--extensions-dir=' + path.join(artifacts, 'extensions'),
    '--extensionDevelopmentPath=' + root, '--extensionTestsPath=' + path.join(root, 'test/vscode/smoke.js'),
    '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--disable-workspace-trust',
    root,
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
const log = fs.createWriteStream(path.join(artifacts, 'vscode.log'));
let tail = '';
let passed = false;
const collect = data => {
    log.write(data);
    tail = (tail + data.toString()).slice(-16000);
    passed ||= tail.includes('EliteScript VS Code smoke tests passed.');
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);
const timeout = setTimeout(() => { console.error('VS Code smoke test timed out.'); child.kill(); }, 120000);
child.on('error', error => {
    clearTimeout(timeout);
    log.end();
    console.error(error);
    process.exitCode = 1;
});
child.on('exit', code => {
    clearTimeout(timeout);
    log.end();
    process.exitCode = code === 0 && passed ? 0 : (code || 1);
    if (process.exitCode === 0) { console.log('VS Code extension-host smoke tests passed.'); }
    else { console.error(tail); }
});
