const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { URI } = require('vscode-uri');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');

async function eventually(action, predicate) {
    const deadline = Date.now() + 5000;
    let result;
    while (Date.now() < deadline) {
        result = await action();
        if (predicate(result)) { return result; }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Analysis did not converge: ' + JSON.stringify(result));
}

async function startServer(t, language = 'en') {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'elitescript-test-'));
    const root = path.join(temporary, 'project 中文');
    const storage = path.join(temporary, 'storage');
    await fs.mkdir(root);
    const helperText = 'def double(value: int) -> int:\n    return value * 2\nend\n';
    await fs.writeFile(path.join(root, 'helper.script'), helperText);
    await fs.writeFile(path.join(root, 'ordinary.py'), 'movej([])\n');
    const child = spawn(process.execPath, [path.resolve('out/server/main.js')], {
        stdio: 'pipe', windowsHide: true,
    });
    const errors = [];
    child.stderr.on('data', data => errors.push(data.toString()));
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    const diagnostics = [];
    connection.onNotification('textDocument/publishDiagnostics', params => diagnostics.push(params));
    connection.onNotification('window/showMessage', params => errors.push(params.message));
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onRequest('client/registerCapability', () => null);
    connection.listen();
    t.after(async () => {
        try {
            await connection.sendRequest('shutdown');
            const exited = once(child, 'exit');
            await connection.sendNotification('exit');
            await exited;
            assert.equal(child.exitCode, 0, errors.join('\n'));
            assert.deepEqual(await fs.readdir(storage), [], 'server removes its session cache');
        } finally {
            connection.dispose();
            if (child.exitCode === null) { child.kill(); }
            await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 });
        }
    });
    const result = await connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri: URI.file(root).toString(),
        workspaceFolders: [{ uri: URI.file(root).toString(), name: 'Test' }],
        capabilities: {
            workspace: { configuration: true, workspaceFolders: true },
            textDocument: {
                hover: { contentFormat: ['markdown', 'plaintext'] },
                completion: { completionItem: { documentationFormat: ['markdown'], snippetSupport: true } },
                signatureHelp: { signatureInformation: { documentationFormat: ['markdown'] } },
                definition: { linkSupport: true },
                documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                rename: { prepareSupport: true },
            },
        },
        initializationOptions: {
            storagePath: storage,
            settings: { documentationLanguage: language, pythonVersion: '3.8', typeCheckingMode: 'basic' },
        },
    });
    await connection.sendNotification('initialized', {});
    const uri = name => URI.file(path.join(root, name)).toString();
    const request = (method, name, line, character, extra = {}) => connection.sendRequest(method, {
        textDocument: { uri: name.includes(':') ? name : uri(name) },
        ...(line === undefined ? {} : { position: { line, character } }),
        ...extra,
    });
    const open = async (name, text, version = 1) => {
        const target = name.includes(':') ? name : uri(name);
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: target, languageId: 'elitescript', version, text } });
    };
    const change = async (name, text, version) => {
        await connection.sendNotification('textDocument/didChange', {
            textDocument: { uri: name.includes(':') ? name : uri(name), version }, contentChanges: [{ text }],
        });
    };
    async function waitDiagnostics(name, version, predicate) {
        const target = name.includes(':') ? name : uri(name);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const found = diagnostics.findLast(d => d.uri === target && d.version === version && predicate(d.diagnostics));
            if (found) { return found.diagnostics; }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('Timed out waiting for diagnostics: ' + JSON.stringify({ target, version, diagnostics, errors }));
    }
    return { connection, root, storage, uri, result, request, open, change, waitDiagnostics, errors };
}

test('real Pyright: builtins, completion, signatures, diagnostics and mapped navigation', { timeout: 60000 }, async t => {
    const s = await startServer(t);
    assert.equal(s.result.capabilities.textDocumentSync.change, 1);
    assert.ok(s.result.capabilities.signatureHelpProvider);
    assert.equal(s.result.capabilities.documentFormattingProvider, undefined);
    assert.equal(s.result.capabilities.codeActionProvider, undefined);

    const text = [
        'from helper import double', '',
        'def run_task():',
        '    target = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]',
        '    movej(target, a=1.0)',
        '    result = double(2)',
        '    return result',
        'end', '',
        'run_task()', '',
    ].join('\n');
    await fs.writeFile(path.join(s.root, 'main.script'), text);
    await s.open('main.script', text);

    const hover = await s.request('textDocument/hover', 'main.script', 4, 7);
    assert.match(JSON.stringify(hover), /movej/);
    assert.match(JSON.stringify(hover), /joint movement/i);
    const signature = await s.request('textDocument/signatureHelp', 'main.script', 4, 20);
    assert.match(signature.signatures[0].label, /q: List\[Any\], a: float/);
    assert.equal(signature.activeParameter, 1);
    const localHover = await s.request('textDocument/hover', 'main.script', 5, 7);
    assert.match(JSON.stringify(localHover), /int/);

    const definition = await s.request('textDocument/definition', 'main.script', 5, 16);
    const target = definition[0].targetUri ?? definition[0].uri;
    assert.equal(target, s.uri('helper.script'), 'unopened imported script resolves back to source');
    assert.equal((definition[0].targetSelectionRange ?? definition[0].range).start.line, 0);

    const refs = await s.request('textDocument/references', 'main.script', 2, 8, { context: { includeDeclaration: true } });
    assert.equal(refs.length, 2);
    assert.ok(refs.every(ref => ref.uri === s.uri('main.script')));
    const rename = await s.request('textDocument/rename', 'main.script', 2, 8, { newName: 'execute_task' });
    const edits = rename.changes?.[s.uri('main.script')] ?? rename.documentChanges?.find(e => e.textDocument.uri === s.uri('main.script'))?.edits;
    assert.equal(edits.length, 2);
    assert.ok(edits.every(edit => edit.newText === 'execute_task'));
    const symbols = await s.request('textDocument/documentSymbol', 'main.script');
    assert.ok(symbols.some(symbol => symbol.name === 'run_task'));
    const folds = await s.request('textDocument/foldingRange', 'main.script');
    assert.ok(folds.some(fold => fold.startLine === 2 && fold.endLine === 7));
    assert.equal(await s.request('textDocument/hover', 'main.script', 7, 1), null);

    await s.change('main.script', text + 'mov', 2);
    const completion = await s.request('textDocument/completion', 'main.script', 10, 3);
    const item = (completion.items ?? completion).find(item => item.label === 'movej');
    assert.ok(item, 'global builtins need no import');
    const resolved = await s.connection.sendRequest('completionItem/resolve', item);
    assert.match(JSON.stringify(resolved), /joint movement/i);

    await s.change('main.script', 'def run():\n    movej(missing, speed=1)\n    movej([], a="fast")\nend\nend\n', 3);
    const diagnostics = await s.waitDiagnostics('main.script', 3, ds =>
        ds.some(d => d.code === 'reportUndefinedVariable') && ds.some(d => d.code === 'unmatched-end') &&
        ds.some(d => d.code === 'reportArgumentType'));
    assert.ok(diagnostics.some(d => /speed/.test(d.message) && d.range.start.line === 1));
    assert.ok(diagnostics.some(d => d.code === 'unmatched-end' && d.range.start.line === 4));

    // Missing end is valid, including after an edit that previously had explicit ends.
    await s.change('main.script', 'def run():\n    movej([])\n', 4);
    const valid = await s.request('textDocument/hover', 'main.script', 1, 7);
    assert.match(JSON.stringify(valid), /movej/);
    await s.waitDiagnostics('main.script', 4, ds => ds.length === 0);
    assert.equal(await fs.readFile(path.join(s.root, 'main.script'), 'utf8'), text, 'analysis never edits user source');
    assert.equal(await fs.readFile(path.join(s.root, 'ordinary.py'), 'utf8'), 'movej([])\n');
    assert.equal(s.errors.length, 0, s.errors.join('\n'));
});

test('real Pyright: unsaved imports, close/reopen, file changes, untitled and Chinese docs', { timeout: 60000 }, async t => {
    const s = await startServer(t, 'cn');
    await s.open('main.script', 'from helper import double\nvalue = double(1)\nmovej([])\n');
    const hover = await s.request('textDocument/hover', 'main.script', 2, 3);
    assert.match(JSON.stringify(hover), /[\u4e00-\u9fff]/);

    await s.open('helper.script', 'def double(value: int) -> str:\n    return "dirty"\nend\n');
    const dirty = await eventually(() => s.request('textDocument/hover', 'main.script', 1, 10), value => /str/.test(JSON.stringify(value)));
    assert.match(JSON.stringify(dirty), /str/);
    await s.connection.sendNotification('textDocument/didClose', { textDocument: { uri: s.uri('helper.script') } });
    const restored = await eventually(() => s.request('textDocument/hover', 'main.script', 1, 10), value => /int\\n/.test(JSON.stringify(value)));
    assert.match(JSON.stringify(restored), /int/);

    await fs.writeFile(path.join(s.root, 'helper.script'), 'def double(value: int) -> float:\n    return 1.5\nend\n');
    await s.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: s.uri('helper.script'), type: 2 }] });
    const changed = await eventually(() => s.request('textDocument/hover', 'main.script', 1, 10), value => /float/.test(JSON.stringify(value)));
    assert.match(JSON.stringify(changed), /float/);

    await s.open('untitled:Untitled-1', 'movej([])\n');
    const untitled = await s.request('textDocument/hover', 'untitled:Untitled-1', 0, 3);
    assert.match(JSON.stringify(untitled), /movej/);
    await s.connection.sendNotification('textDocument/didClose', { textDocument: { uri: 'untitled:Untitled-1' } });

    await fs.unlink(path.join(s.root, 'helper.script'));
    await s.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: s.uri('helper.script'), type: 3 }] });
    await s.change('main.script', 'from helper import double\nvalue = double(1)\n', 2);
    await s.waitDiagnostics('main.script', 2, ds => ds.some(d => d.code === 'reportMissingImports'));
    assert.equal(s.errors.length, 0, s.errors.join('\n'));
});
