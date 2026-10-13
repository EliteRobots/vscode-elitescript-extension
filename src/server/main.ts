import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import {
    createMessageConnection, StreamMessageReader, StreamMessageWriter,
    ErrorCodes, ResponseError, MessageConnection,
} from 'vscode-jsonrpc/node';
import {
    InitializeParams, InitializeResult, DidOpenTextDocumentParams, DidChangeTextDocumentParams,
    DidCloseTextDocumentParams, DidSaveTextDocumentParams, DidChangeWatchedFilesParams,
    PublishDiagnosticsParams, TextDocumentSyncKind, ConfigurationParams, Position,
} from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { AdapterOptions, ShadowWorkspace, uriKey } from './workspace';
import { project, Projection } from './projection';

interface OpenDocument { document: TextDocument; projection: Projection }
const client = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
let backend: MessageConnection | undefined;
let child: ChildProcessWithoutNullStreams | undefined;
let shadow: ShadowWorkspace | undefined;
let mutations: Promise<void> = Promise.resolve();
let stopping = false;
let closing = false;
const documents = new Map<string, OpenDocument>();

function publish(state: OpenDocument, extra: PublishDiagnosticsParams['diagnostics'] = []): void {
    void client.sendNotification('textDocument/publishDiagnostics', {
        uri: state.document.uri, version: state.document.version,
        diagnostics: [...state.projection.diagnostics, ...extra],
    });
}

function queue(action: () => Promise<void>): void {
    mutations = mutations.then(action).catch(error => {
        void client.sendNotification('window/showMessage', { type: 1, message: 'EliteScript analysis failed: ' + String(error) });
    });
}

async function finish(code: number): Promise<void> {
    if (closing) { return; }
    closing = true;
    stopping = true;
    if (child && child.exitCode === null) {
        await new Promise<void>(resolve => {
            child!.once('exit', () => resolve());
            child!.kill();
            setTimeout(resolve, 1500).unref();
        });
    }
    backend?.dispose();
    try { await shadow?.dispose(); }
    catch (error) { process.stderr.write('Cannot remove EliteScript analysis cache: ' + String(error) + '\n'); }
    process.exit(code);
}

async function initialize(params: InitializeParams): Promise<InitializeResult> {
    if (shadow) { throw new ResponseError(ErrorCodes.InvalidRequest, 'Already initialized'); }
    const options = params.initializationOptions as AdapterOptions;
    if (!options?.storagePath || !options.settings) { throw new Error('Missing EliteScript adapter configuration'); }
    shadow = new ShadowWorkspace(options, message => {
        void client.sendNotification('window/logMessage', { type: 2, message });
    });
    const folders = await shadow.initialize(params.workspaceFolders ?? (params.rootUri ? [{ uri: params.rootUri, name: 'Workspace' }] : []));
    child = spawn(process.execPath, [require.resolve('pyright/langserver.index.js'), '--stdio'], {
        stdio: 'pipe', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.stderr.on('data', data => process.stderr.write(data));
    child.on('error', error => {
        void client.sendNotification('window/showMessage', { type: 1, message: 'Cannot start Pyright: ' + error.message });
        void finish(1);
    });
    child.on('exit', code => {
        if (!stopping) {
            void client.sendNotification('window/showMessage', { type: 1, message: 'Pyright stopped unexpectedly (' + code + '). Restart the EliteScript language server.' });
            void finish(1);
        }
    });
    backend = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    backend.onRequest('workspace/configuration', (request: ConfigurationParams) => request.items.map(item => {
        if (item.section === 'python') {
            return { analysis: { diagnosticMode: 'openFilesOnly', autoImportCompletions: false, autoSearchPaths: false } };
        }
        if (item.section === 'pyright') { return { disableOrganizeImports: true }; }
        return null;
    }));
    backend.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'Only mapped symbol edits are supported.' }));
    backend.onRequest((method, params, token) => client.sendRequest(method, shadow!.mapProtocol(params, 'client'), token));
    backend.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
        const mapped = shadow!.mapProtocol(params, 'client');
        const state = documents.get(uriKey(mapped.uri));
        if (!state || (mapped.version !== undefined && mapped.version !== state.document.version)) { return; }
        publish(state, mapped.diagnostics);
    });
    backend.onNotification((method, params) => client.sendNotification(method, shadow!.mapProtocol(params, 'client')));
    backend.listen();

    const capabilities = JSON.parse(JSON.stringify(params.capabilities));
    // Push diagnostics let the adapter merge structural and Pyright diagnostics.
    if (capabilities.textDocument) { delete capabilities.textDocument.diagnostic; }
    capabilities.workspace = {
        ...capabilities.workspace, configuration: true,
        didChangeWatchedFiles: { dynamicRegistration: false },
    };
    delete capabilities.workspace.diagnostics;
    const result = await backend.sendRequest<InitializeResult>('initialize', {
        ...params, processId: process.pid, capabilities, initializationOptions: {},
        workspaceFolders: folders, rootUri: folders[0].uri, rootPath: URI.parse(folders[0].uri).fsPath,
    });
    const upstream = result.capabilities;
    return {
        serverInfo: { name: 'EliteScript (Pyright)', version: '0.1.1' },
        capabilities: {
            textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Full, save: { includeText: false } },
            completionProvider: upstream.completionProvider,
            hoverProvider: upstream.hoverProvider,
            signatureHelpProvider: upstream.signatureHelpProvider,
            definitionProvider: upstream.definitionProvider,
            declarationProvider: upstream.declarationProvider,
            typeDefinitionProvider: upstream.typeDefinitionProvider,
            referencesProvider: upstream.referencesProvider,
            documentHighlightProvider: upstream.documentHighlightProvider,
            documentSymbolProvider: upstream.documentSymbolProvider,
            workspaceSymbolProvider: upstream.workspaceSymbolProvider,
            renameProvider: upstream.renameProvider,
            foldingRangeProvider: true,
            // General code actions and formatting can destroy masked end lines.
            // Advertise only features whose edits preserve EliteScript source.
        },
    };
}

client.onRequest('initialize', initialize);
client.onRequest('shutdown', async () => {
    stopping = true;
    await mutations;
    if (backend) { await backend.sendRequest('shutdown'); }
    return null;
});
client.onNotification('exit', () => { void finish(stopping ? 0 : 1); });
client.onNotification('initialized', params => { queue(async () => { await backend!.sendNotification('initialized', params); }); });

client.onNotification('textDocument/didOpen', (params: DidOpenTextDocumentParams) => queue(async () => {
    const item = params.textDocument;
    const state = { document: TextDocument.create(item.uri, item.languageId, item.version, item.text), projection: project(item.text) };
    const uri = await shadow!.writeDocument(item.uri, state.projection.text);
    documents.set(uriKey(item.uri), state);
    publish(state);
    await backend!.sendNotification('textDocument/didOpen', { textDocument: { ...item, uri, version: item.version - 1, languageId: 'python', text: state.projection.text } });
    // A restored dirty buffer may already have been analyzed as an unopened import.
    // Explicitly invalidate its importers through Pyright's content-update path.
    await backend!.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: item.version }, contentChanges: [{ text: state.projection.text }],
    });
}));

client.onNotification('textDocument/didChange', (params: DidChangeTextDocumentParams) => queue(async () => {
    const state = documents.get(uriKey(params.textDocument.uri));
    if (!state) { return; }
    state.document = TextDocument.update(state.document, params.contentChanges, params.textDocument.version);
    state.projection = project(state.document.getText());
    await shadow!.writeDocument(state.document.uri, state.projection.text);
    publish(state);
    await backend!.sendNotification('textDocument/didChange', {
        textDocument: { uri: shadow!.serverUri(state.document.uri), version: state.document.version },
        contentChanges: [{ text: state.projection.text }],
    });
}));

client.onNotification('textDocument/didSave', (params: DidSaveTextDocumentParams) => queue(async () => {
    await backend!.sendNotification('textDocument/didSave', { textDocument: { uri: shadow!.serverUri(params.textDocument.uri) } });
}));

client.onNotification('textDocument/didClose', (params: DidCloseTextDocumentParams) => queue(async () => {
    const uri = params.textDocument.uri;
    documents.delete(uriKey(uri));
    const target = URI.parse(uri).scheme === 'file' ? await shadow!.syncFile(uri) : await shadow!.removeFile(uri);
    // Restore saved text before closing, so Pyright observes discarded unsaved edits.
    await backend!.sendNotification('textDocument/didClose', shadow!.mapProtocol(params, 'server'));
    if (target) { await backend!.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: target, type: 2 }] }); }
    await client.sendNotification('textDocument/publishDiagnostics', { uri, diagnostics: [] });
}));

client.onNotification('workspace/didChangeWatchedFiles', (params: DidChangeWatchedFilesParams) => queue(async () => {
    const changes = [];
    for (const change of params.changes) {
        if (documents.has(uriKey(change.uri))) { continue; } // The unsaved buffer is authoritative.
        const target = await shadow!.syncFile(change.uri);
        if (target) { changes.push({ ...change, uri: target }); }
    }
    if (changes.length) { await backend!.sendNotification('workspace/didChangeWatchedFiles', { changes }); }
}));

const supportedRequests = new Set([
    'textDocument/completion', 'completionItem/resolve', 'textDocument/hover', 'textDocument/signatureHelp',
    'textDocument/definition', 'textDocument/declaration', 'textDocument/typeDefinition', 'textDocument/references',
    'textDocument/documentHighlight', 'textDocument/documentSymbol', 'workspace/symbol',
    'textDocument/prepareRename', 'textDocument/rename',
]);
client.onRequest(async (method, params, token) => {
    await mutations;
    if (!backend || !shadow) { throw new ResponseError(ErrorCodes.InvalidRequest, 'Server is not initialized'); }
    const request = params as { textDocument?: { uri: string }; position?: Position };
    const state = request?.textDocument ? documents.get(uriKey(request.textDocument.uri)) : undefined;
    if (method === 'textDocument/foldingRange') { return state?.projection.foldingRanges ?? []; }
    if (!supportedRequests.has(method)) { throw new ResponseError(ErrorCodes.MethodNotFound, 'Unsupported method: ' + method); }
    if (state && request.position && state.projection.endRanges.some(range =>
        range.start.line === request.position!.line && range.start.character <= request.position!.character && range.end.character >= request.position!.character)) {
        return null;
    }
    const result = await backend.sendRequest(method, shadow.mapProtocol(params, 'server'), token);
    return shadow.mapProtocol(result, 'client');
});

process.stdin.on('end', () => { void finish(0); });
process.on('SIGTERM', () => { void finish(0); });
process.on('SIGINT', () => { void finish(0); });
client.listen();
