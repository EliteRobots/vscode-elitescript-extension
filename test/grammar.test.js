const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Registry, parseRawGrammar, INITIAL } = require('vscode-textmate');
const { loadWASM, OnigScanner, OnigString } = require('vscode-oniguruma');

function findPythonGrammar() {
    if (process.env.VSCODE_PYTHON_GRAMMAR) { return process.env.VSCODE_PYTHON_GRAMMAR; }
    const locations = [
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code'),
        path.join(process.env.ProgramFiles ?? '', 'Microsoft VS Code'),
        '/usr/share/code', '/Applications/Visual Studio Code.app/Contents',
    ];
    for (const location of locations) {
        if (!fs.existsSync(location)) { continue; }
        const roots = [location, ...fs.readdirSync(location, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(location, e.name))];
        for (const root of roots) {
            const file = path.join(root, 'resources/app/extensions/python/syntaxes/MagicPython.tmLanguage.json');
            if (fs.existsSync(file)) { return file; }
        }
    }
}

test('EliteScript grammar composes with VS Code MagicPython without coloring strings as end', async t => {
    const python = findPythonGrammar();
    if (!python) { t.skip('Set VSCODE_PYTHON_GRAMMAR to the built-in MagicPython.tmLanguage.json'); return; }
    await loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);
    const registry = new Registry({
        onigLib: Promise.resolve({ createOnigScanner: patterns => new OnigScanner(patterns), createOnigString: text => new OnigString(text) }),
        loadGrammar: async scope => {
            const file = scope === 'source.elitescript' ? path.resolve('syntaxes/elitescript.tmLanguage.json')
                : scope === 'source.python' ? python
                : scope === 'source.regexp.python' ? path.join(path.dirname(python), 'MagicRegExp.tmLanguage.json') : undefined;
            return file ? parseRawGrammar(fs.readFileSync(file, 'utf8'), file) : null;
        },
    });
    t.after(() => registry.dispose());
    const grammar = await registry.loadGrammar('source.elitescript');
    const lines = ['def task():', '    text = """', 'end', '"""', '    end_freedrive_mode()', 'end # close', '# end', 'text = "end"'];
    let stack = INITIAL;
    const tokens = lines.map(line => {
        const result = grammar.tokenizeLine(line, stack);
        stack = result.ruleStack;
        return result.tokens;
    });
    const isEnd = token => token.scopes.includes('keyword.control.flow.elitescript');
    assert.ok(tokens[0].some(token => token.scopes.some(scope => scope.startsWith('storage.type.function'))));
    assert.ok(tokens[5].some(isEnd));
    for (const index of [1, 2, 3, 4, 6, 7]) { assert.ok(!tokens[index].some(isEnd), lines[index]); }
});
