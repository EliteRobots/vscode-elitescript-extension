const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateBuiltins } = require('../out/server/builtins');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('all 186 API signatures are identical across documentation languages', () => {
    const en = generateBuiltins('en');
    const cn = generateBuiltins('cn');
    const signatures = text => text.split('\n').filter(line => line.startsWith('def '));
    assert.equal(signatures(en).length, 186);
    assert.deepEqual(signatures(cn), signatures(en));
    assert.match(en, /def movej\(q: _List\[_Any\], a: float = \.\.\./);
    assert.match(en, /def start_thread\(fundef: _Any/);
    assert.match(cn, /[\u4e00-\u9fff]/);
});

test('Pyright accepts every generated API declaration in both languages', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elite-stubs-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
    for (const language of ['en', 'cn']) {
        const file = path.join(root, language + '.pyi');
        await fs.writeFile(file, generateBuiltins(language));
        const result = spawnSync(process.execPath, [require.resolve('pyright/index.js'), '--outputjson', '--pythonversion', '3.8', file], { encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(JSON.parse(result.stdout).summary.errorCount, 0);
    }
});
