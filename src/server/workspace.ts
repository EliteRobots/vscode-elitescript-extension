import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { URI } from 'vscode-uri';
import { WorkspaceFolder } from 'vscode-languageserver-protocol';
import { DocumentationLanguage, generateBuiltins } from './builtins';
import { project } from './projection';

export interface AnalysisSettings {
    documentationLanguage: DocumentationLanguage;
    pythonVersion: string;
    typeCheckingMode: 'off' | 'basic' | 'standard' | 'strict';
}
export interface AdapterOptions {
    storagePath: string;
    settings: AnalysisSettings;
    folderSettings?: Record<string, AnalysisSettings>;
}
interface Root { source?: string; shadow: string; name: string; settings: AnalysisSettings }

const excludedDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.pytest_cache', '.elite-stubs', '.test-artifacts']);
const missingSourceErrors = new Set(['ENOENT', 'ENOTDIR']);
const unavailableSourceErrors = new Set(['EACCES', 'EPERM', 'EBUSY', 'ELOOP']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const pathKey = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
export function uriKey(value: string): string {
    const uri = URI.parse(value);
    return uri.scheme === 'file' ? pathKey(uri.fsPath) : uri.toString();
}
function relativeInside(root: string, file: string): string | undefined {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : undefined;
}

/** Private on-disk analysis tree: Pyright can resolve imports in unopened .script files. */
export class ShadowWorkspace {
    private readonly roots: Root[] = [];
    private readonly toShadow = new Map<string, string>();
    private readonly toSource = new Map<string, string>();
    private readonly looseSearchPaths = new Set<string>();
    private sessionPath = '';

    constructor(
        private readonly options: AdapterOptions,
        private readonly warn: (message: string) => void = message => { process.stderr.write(message + '\n'); },
    ) {}

    async initialize(folders: WorkspaceFolder[]): Promise<WorkspaceFolder[]> {
        await fs.mkdir(this.options.storagePath, { recursive: true });
        // Unique per server lifetime: multiple VS Code windows cannot overwrite each other's buffers.
        this.sessionPath = await fs.mkdtemp(path.join(this.options.storagePath, 'session-'));
        for (const folder of folders) {
            if (URI.parse(folder.uri).scheme !== 'file') { continue; }
            this.roots.push({
                source: URI.parse(folder.uri).fsPath,
                shadow: path.join(this.sessionPath, hash(folder.uri)), name: folder.name,
                settings: this.options.folderSettings?.[folder.uri] ?? this.options.settings,
            });
        }
        this.roots.sort((a, b) => b.source!.length - a.source!.length);
        this.roots.push({ shadow: path.join(this.sessionPath, 'loose'), name: 'EliteScript loose files', settings: this.options.settings });
        for (const root of this.roots) {
            await this.writeConfig(root);
            if (root.source) { await this.scan(root.source); }
        }
        return this.roots.map(root => ({ uri: URI.file(root.shadow).toString(), name: root.name }));
    }

    private async writeConfig(root: Root): Promise<void> {
        const stubPath = path.join(root.shadow, '.elite-stubs');
        await fs.mkdir(stubPath, { recursive: true });
        await fs.writeFile(path.join(stubPath, '__builtins__.pyi'), generateBuiltins(root.settings.documentationLanguage));
        await fs.writeFile(path.join(root.shadow, 'pyrightconfig.json'), JSON.stringify({
            include: ['**/*.py', '**/*.pyi'], exclude: ['.elite-stubs'],
            stubPath, pythonVersion: root.settings.pythonVersion, typeCheckingMode: root.settings.typeCheckingMode,
            extraPaths: root.source ? [root.source] : [...this.looseSearchPaths],
            reportMissingModuleSource: 'none',
        }, null, 2));
    }

    private async scan(directory: string): Promise<void> {
        if (this.excludedPath(directory)) { return; }
        let entries: Dirent[];
        try { entries = await fs.readdir(directory, { withFileTypes: true }); }
        catch (error) {
            if (!this.skipSourceError(directory, error)) { throw error; }
            return;
        }
        for (const entry of entries) {
            const file = path.join(directory, entry.name);
            // Do not follow symlinks into dependencies or back into the generated tree.
            if (entry.isDirectory()) { await this.scan(file); }
            else if (entry.isFile() && /\.(script|py|pyi)$/.test(entry.name) && entry.name !== '__builtins__.pyi') {
                await this.syncFile(URI.file(file).toString());
            }
        }
    }

    private rootFor(file?: string): Root {
        return this.roots.find(root => root.source && file && relativeInside(root.source, file) !== undefined) ?? this.roots[this.roots.length - 1];
    }

    private excludedPath(file: string): boolean {
        // Storage can be located under a workspace when using a portable/test profile.
        if (relativeInside(this.options.storagePath, file) !== undefined) { return true; }
        const root = this.rootFor(file);
        const relative = root.source ? relativeInside(root.source, file)! : path.basename(file);
        return relative.split(path.sep).some(part => excludedDirectories.has(process.platform === 'win32' ? part.toLowerCase() : part));
    }

    private allowedFile(file: string): boolean {
        return !this.excludedPath(file) &&
            /\.(script|py|pyi)$/.test(file) && path.basename(file) !== '__builtins__.pyi';
    }

    /** Source permissions and scan races must not prevent unrelated files from being analyzed. */
    private skipSourceError(file: string, error: unknown): boolean {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (missingSourceErrors.has(code)) { return true; }
        if (!unavailableSourceErrors.has(code)) { return false; }
        this.warn(`EliteScript: skipped unreadable source path (${code}): ${file}`);
        return true;
    }

    /** Called for a real buffer as well as files discovered on disk. */
    async writeDocument(sourceUri: string, text: string): Promise<string> {
        let shadowUri = this.toShadow.get(uriKey(sourceUri));
        if (!shadowUri) {
            const source = URI.parse(sourceUri);
            const root = this.rootFor(source.scheme === 'file' ? source.fsPath : undefined);
            let relative: string;
            if (root.source) {
                relative = relativeInside(root.source, source.fsPath)!;
                relative = relative.replace(/\.script$/, '.py');
            } else {
                relative = source.scheme === 'file'
                    ? path.join(hash(path.dirname(source.fsPath)), path.basename(source.fsPath).replace(/\.script$/, '.py'))
                    : `untitled-${hash(sourceUri)}.py`;
                if (source.scheme === 'file' && !this.looseSearchPaths.has(path.dirname(source.fsPath))) {
                    this.looseSearchPaths.add(path.dirname(source.fsPath));
                    await this.writeConfig(root);
                }
            }
            const target = path.resolve(root.shadow, relative);
            if (relativeInside(root.shadow, target) === undefined) { throw new Error('Analysis path escaped its workspace'); }
            shadowUri = URI.file(target).toString();
            this.toShadow.set(uriKey(sourceUri), shadowUri);
        }
        this.toSource.set(uriKey(shadowUri), sourceUri);
        const file = URI.parse(shadowUri).fsPath;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text);
        return shadowUri;
    }

    /** A .script module takes precedence over a same-named .py helper. */
    async syncFile(sourceUri: string): Promise<string | undefined> {
        const uri = URI.parse(sourceUri);
        if (uri.scheme !== 'file' || !this.allowedFile(uri.fsPath)) { return undefined; }
        if (uri.fsPath.endsWith('.py')) {
            try { await fs.access(uri.fsPath.slice(0, -3) + '.script'); return undefined; }
            catch (error) {
                if (!missingSourceErrors.has((error as NodeJS.ErrnoException).code ?? '')) {
                    if (!this.skipSourceError(uri.fsPath.slice(0, -3) + '.script', error)) { throw error; }
                    return undefined;
                }
            }
        }
        let text: string;
        try {
            const stat = await fs.lstat(uri.fsPath);
            if (!stat.isFile()) { return undefined; }
            text = await fs.readFile(uri.fsPath, 'utf8');
        } catch (error) {
            if (!this.skipSourceError(uri.fsPath, error)) { throw error; }
            if (!missingSourceErrors.has((error as NodeJS.ErrnoException).code ?? '')) { return undefined; }
            const target = await this.removeFile(sourceUri);
            if (uri.fsPath.endsWith('.script')) {
                const fallback = await this.syncFile(URI.file(uri.fsPath.slice(0, -7) + '.py').toString());
                return fallback ?? target;
            }
            return target;
        }
        // Keep cache writes outside the source-read catch: a broken cache must still report failure.
        return this.writeDocument(sourceUri, uri.fsPath.endsWith('.script') ? project(text).text : text);
    }

    async removeFile(sourceUri: string): Promise<string | undefined> {
        const target = this.toShadow.get(uriKey(sourceUri));
        if (!target || this.toSource.get(uriKey(target)) !== sourceUri) { return undefined; }
        await fs.rm(URI.parse(target).fsPath, { force: true });
        // Retain URI mappings for late diagnostics and references to a deleted file.
        return target;
    }

    serverUri(uri: string): string { return this.toShadow.get(uriKey(uri)) ?? uri; }
    clientUri(uri: string): string { return this.toSource.get(uriKey(uri)) ?? uri; }
    isShadow(uri: string): boolean {
        const parsed = URI.parse(uri);
        return parsed.scheme === 'file' && relativeInside(this.sessionPath, parsed.fsPath) !== undefined;
    }

    /** Rewrite only protocol URI fields, never arbitrary text, labels or documentation. */
    mapProtocol<T>(value: T, direction: 'server' | 'client'): T {
        const map = (uri: string) => direction === 'server' ? this.serverUri(uri) : this.clientUri(uri);
        const visit = (item: unknown): unknown => {
            if (Array.isArray(item)) { return item.map(visit); }
            if (item === null || typeof item !== 'object') { return item; }
            const result: Record<string, unknown> = {};
            for (const [key, child] of Object.entries(item)) {
                if (['uri', 'targetUri', 'scopeUri', 'oldUri', 'newUri', 'rootUri'].includes(key) && typeof child === 'string') {
                    result[key] = map(child);
                } else if (key === 'changes' && child && typeof child === 'object' && !Array.isArray(child)) {
                    result[key] = Object.fromEntries(Object.entries(child).map(([uri, edits]) => [map(uri), visit(edits)]));
                } else { result[key] = visit(child); }
            }
            return result;
        };
        return visit(value) as T;
    }

    async dispose(): Promise<void> {
        if (this.sessionPath && relativeInside(this.options.storagePath, this.sessionPath) && path.basename(this.sessionPath).startsWith('session-')) {
            await fs.rm(this.sessionPath, { recursive: true, force: true, maxRetries: 3 });
        }
    }
}
