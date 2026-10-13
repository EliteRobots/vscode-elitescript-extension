import * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import type { AdapterOptions, AnalysisSettings } from './server/workspace';

let client: LanguageClient | undefined;
let lifecycle: Promise<void> = Promise.resolve();
let deactivating = false;

function settings(resource?: vscode.Uri): AnalysisSettings {
    const config = vscode.workspace.getConfiguration('elitescript', resource);
    const language = config.get<string>('documentationLanguage', 'auto');
    return {
        documentationLanguage: language === 'cn' || (language === 'auto' && vscode.env.language.startsWith('zh')) ? 'cn' : 'en',
        pythonVersion: config.get<string>('pythonVersion', '3.8'),
        typeCheckingMode: config.get<AnalysisSettings['typeCheckingMode']>('typeCheckingMode', 'basic'),
    };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    deactivating = false;
    const output = vscode.window.createOutputChannel('EliteScript');
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{script,py,pyi}');
    const restart = (): Promise<void> => {
        lifecycle = lifecycle.then(async () => {
            if (client) { await client.stop(); client = undefined; }
            if (deactivating) { return; }
            const options: AdapterOptions = {
                storagePath: vscode.Uri.joinPath(context.globalStorageUri, 'analysis').fsPath,
                settings: settings(),
                folderSettings: Object.fromEntries((vscode.workspace.workspaceFolders ?? []).map(folder => [folder.uri.toString(), settings(folder.uri)])),
            };
            client = new LanguageClient('elitescript', 'EliteScript', {
                module: context.asAbsolutePath('out/server/main.js'), transport: TransportKind.stdio,
            }, {
                documentSelector: [{ language: 'elitescript', scheme: 'file' }, { language: 'elitescript', scheme: 'untitled' }],
                initializationOptions: options,
                synchronize: { fileEvents: watcher },
                outputChannel: output,
            });
            await client.start();
        }).catch(error => {
            output.appendLine(String(error));
            void vscode.window.showErrorMessage('EliteScript language server could not start: ' + String(error));
        });
        return lifecycle;
    };
    const switchLanguage = async (language: 'cn' | 'en') => {
        const configuration = vscode.workspace.getConfiguration('elitescript', vscode.window.activeTextEditor?.document.uri);
        const current = configuration.inspect('documentationLanguage');
        const target = current?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
            : current?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await configuration.update('documentationLanguage', language, target);
    };
    context.subscriptions.push(
        output, watcher,
        vscode.commands.registerCommand('extension.switchLanguageToChinese', () => switchLanguage('cn')),
        vscode.commands.registerCommand('extension.switchLanguageToEnglish', () => switchLanguage('en')),
        vscode.commands.registerCommand('elitescript.restartLanguageServer', restart),
        vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('elitescript')) { void restart(); } }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => { void restart(); }),
    );
    await restart();
}

export async function deactivate(): Promise<void> {
    deactivating = true;
    await lifecycle;
    await client?.stop();
    client = undefined;
}
