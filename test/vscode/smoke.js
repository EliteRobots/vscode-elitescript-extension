const assert = require('node:assert/strict');
const vscode = require('vscode');
const hoverText = values => (values ?? []).flatMap(hover => hover.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n');

async function waitFor(action, predicate) {
    const deadline = Date.now() + 20000;
    let value;
    while (Date.now() < deadline) {
        value = await action();
        if (predicate(value)) { return value; }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('VS Code provider did not become ready: ' + JSON.stringify(value));
}

exports.run = async function () {
    const extension = vscode.extensions.getExtension('elite-robots.elitescript');
    assert.ok(extension);
    await extension.activate();
    // Open the real example from the full repository, including generated test profiles.
    const example = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(extension.extensionUri, 'examples/demo.script'));
    await vscode.window.showTextDocument(example);
    const exampleMovej = example.positionAt(example.getText().indexOf('movej(') + 2);
    await waitFor(() => vscode.commands.executeCommand('vscode.executeHoverProvider', example.uri, exampleMovej),
        value => /movej/.test(hoverText(value)));
    const document = await vscode.workspace.openTextDocument({
        language: 'elitescript',
        content: 'def task():\n    movej([], a=0.5)\nend\ntask()\n',
    });
    const hover = () => vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(1, 7));
    await waitFor(hover, value => /movej/.test(hoverText(value)));
    const signatures = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', document.uri, new vscode.Position(1, 16));
    assert.ok(signatures.signatures.length);
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, new vscode.Position(3, 2));
    assert.equal((definitions[0].targetUri ?? definitions[0].uri).toString(), document.uri.toString());
    const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, new vscode.Position(3, 2), 'renamed_task');
    assert.equal(rename.get(document.uri).length, 2);
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
    assert.ok(symbols.some(symbol => symbol.name === 'task'));

    const invalid = await vscode.workspace.openTextDocument({ language: 'elitescript', content: 'end\nmovej([], a="fast")\n' });
    await waitFor(() => vscode.languages.getDiagnostics(invalid.uri), values =>
        values.some(d => d.source === 'EliteScript') && values.some(d => /float/.test(d.message)));
    await vscode.commands.executeCommand('extension.switchLanguageToChinese');
    await waitFor(hover, values => /[\u4e00-\u9fff]/.test(hoverText(values)));
    await vscode.commands.executeCommand('elitescript.restartLanguageServer');
    await waitFor(hover, value => /movej/.test(hoverText(value)));
    console.log('EliteScript VS Code smoke tests passed.');
};
