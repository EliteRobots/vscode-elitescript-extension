const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { URI } = require('vscode-uri');
const { ShadowWorkspace } = require('../out/server/workspace');

test('workspace mirrors isolate roots, map URI fields, and restore same-name Python helpers', async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'elite-workspace-'));
    const first = path.join(temporary, 'root one');
    const second = path.join(temporary, 'root two');
    const storage = path.join(temporary, 'storage');
    await fs.mkdir(first); await fs.mkdir(second);
    const settings = { documentationLanguage: 'en', pythonVersion: '3.8', typeCheckingMode: 'basic' };
    const workspace = new ShadowWorkspace({ storagePath: storage, settings });
    t.after(async () => { await workspace.dispose(); await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 }); });
    await fs.writeFile(path.join(first, 'helper.script'), 'def f():\n    pass\nend\n');
    await fs.writeFile(path.join(first, 'helper.py'), 'native = True\n');
    await fs.writeFile(path.join(second, 'helper.script'), 'other = 2\n');
    const folders = await workspace.initialize([first, second].map((root, index) => ({ uri: URI.file(root).toString(), name: String(index) })));
    assert.equal(folders.length, 3);
    const source = URI.file(path.join(first, 'helper.script')).toString();
    const target = workspace.serverUri(source);
    assert.equal(await fs.readFile(URI.parse(target).fsPath, 'utf8'), 'def f():\n    pass\n   \n');
    assert.notEqual(target, workspace.serverUri(URI.file(path.join(second, 'helper.script')).toString()));

    const edit = { documentChanges: [{ textDocument: { uri: target }, edits: [] }], changes: { [target]: [] } };
    const mapped = workspace.mapProtocol(edit, 'client');
    assert.equal(mapped.documentChanges[0].textDocument.uri, source);
    assert.ok(Object.hasOwn(mapped.changes, source));
    assert.deepEqual(workspace.mapProtocol({ contents: { value: target } }, 'client'), { contents: { value: target } });

    await fs.unlink(URI.parse(source).fsPath);
    await workspace.syncFile(source);
    const native = URI.file(path.join(first, 'helper.py')).toString();
    assert.equal(await fs.readFile(URI.parse(target).fsPath, 'utf8'), 'native = True\n');
    assert.equal(workspace.clientUri(target), native);
});

test('workspace startup skips inaccessible source entries and continues analyzing readable scripts', async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'elite-unreadable-'));
    const root = path.join(temporary, 'source');
    await fs.mkdir(root);
    const warnings = [];
    const workspace = new ShadowWorkspace({
        storagePath: path.join(temporary, 'storage'),
        settings: { documentationLanguage: 'en', pythonVersion: '3.8', typeCheckingMode: 'basic' },
    }, message => warnings.push(message));
    t.after(async () => { await workspace.dispose(); await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 }); });

    const faults = [
        ['readdir', 'denied-directory', 'EPERM'],
        ['readdir', 'restricted-directory', 'EACCES'],
        ['readdir', 'deleted-directory', 'ENOENT'],
        ['readdir', 'replaced-directory', 'ENOTDIR'],
        ['readdir', 'busy-directory', 'EBUSY'],
        ['readFile', 'denied.script', 'EACCES'],
        ['readFile', 'deleted.script', 'ENOENT'],
        ['lstat', 'restricted.script', 'EPERM'],
        ['access', 'hidden.script', 'EACCES'],
    ];
    for (const [operation, name] of faults) {
        if (operation === 'readdir') { await fs.mkdir(path.join(root, name)); }
        else if (operation === 'access') { await fs.writeFile(path.join(root, 'hidden.py'), 'value = 1\n'); }
        else { await fs.writeFile(path.join(root, name), 'value = 1\n'); }
    }
    for (const operation of ['readdir', 'readFile', 'lstat', 'access']) {
        const original = fs[operation];
        t.mock.method(fs, operation, async (file, ...args) => {
            const fault = faults.find(([op, name]) => op === operation && path.resolve(file).toLowerCase() === path.join(root, name).toLowerCase());
            if (fault) { throw Object.assign(new Error('Simulated source access failure'), { code: fault[2] }); }
            return original(file, ...args);
        });
    }
    const source = URI.file(path.join(root, 'demo.script')).toString();
    await fs.writeFile(URI.parse(source).fsPath, 'def task():\n    movej([])\nend\n');
    await workspace.initialize([{ uri: URI.file(root).toString(), name: 'Workspace' }]);
    assert.equal(await fs.readFile(URI.parse(workspace.serverUri(source)).fsPath, 'utf8'), 'def task():\n    movej([])\n   \n');
    for (const [, name, code] of faults.filter(([, , code]) => code !== 'ENOENT' && code !== 'ENOTDIR')) {
        assert.ok(warnings.some(message => message.includes(name) && message.includes(code)), `Missing warning for ${name}`);
    }
    assert.ok(warnings.every(message => !message.includes('ENOENT') && !message.includes('ENOTDIR')));
    assert.equal(await workspace.syncFile(URI.file(path.join(root, 'denied.script')).toString()), undefined);
});

test('workspace skips test artifacts and its own analysis storage inside a workspace', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elite-exclusions-'));
    const storage = path.join(root, 'analysis-cache');
    const workspace = new ShadowWorkspace({
        storagePath: storage,
        settings: { documentationLanguage: 'en', pythonVersion: '3.8', typeCheckingMode: 'basic' },
    });
    t.after(async () => { await workspace.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
    const artifact = path.join(root, '.test-artifacts', 'user-data');
    await fs.mkdir(artifact, { recursive: true });
    await fs.mkdir(storage);
    const ignored = [path.join(artifact, 'ignored.script'), path.join(storage, 'cached.py')];
    for (const file of ignored) { await fs.writeFile(file, 'ignored = True\n'); }
    const original = fs.readdir;
    t.mock.method(fs, 'readdir', async (file, ...args) => {
        assert.ok(!path.relative(root, file).split(path.sep).some(part => ['.test-artifacts', 'analysis-cache'].includes(part)), 'Must not scan excluded data');
        return original(file, ...args);
    });
    await workspace.initialize([{ uri: URI.file(root).toString(), name: 'Workspace' }]);
    for (const file of ignored) {
        const uri = URI.file(file).toString();
        assert.equal(workspace.serverUri(uri), uri);
        assert.equal(await workspace.syncFile(uri), undefined, 'Watcher events must use the same exclusions');
    }
});

test('workspace does not hide analysis-cache write failures as unreadable source files', async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'elite-write-failure-'));
    const root = path.join(temporary, 'source');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'demo.script'), 'value = 1\n');
    const workspace = new ShadowWorkspace({
        storagePath: path.join(temporary, 'storage'),
        settings: { documentationLanguage: 'en', pythonVersion: '3.8', typeCheckingMode: 'basic' },
    });
    t.after(async () => { await workspace.dispose(); await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 }); });
    const original = fs.writeFile;
    t.mock.method(fs, 'writeFile', async (file, ...args) => {
        if (path.basename(file) === 'demo.py') { throw Object.assign(new Error('Cache not writable'), { code: 'EPERM' }); }
        return original(file, ...args);
    });
    await assert.rejects(workspace.initialize([{ uri: URI.file(root).toString(), name: 'Workspace' }]), { code: 'EPERM' });
});
