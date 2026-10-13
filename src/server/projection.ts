import { Diagnostic, DiagnosticSeverity, FoldingRange, Range } from 'vscode-languageserver-protocol';

export interface Projection {
    text: string;
    diagnostics: Diagnostic[];
    foldingRanges: FoldingRange[];
    endRanges: Range[];
}

interface Block { kind: string; indent: number; line: number }

/** Python indentation uses tab stops of eight, independently of the editor's tab size. */
function indentation(line: string): number {
    let column = 0;
    for (const char of line) {
        if (char === ' ') { column++; }
        else if (char === '\t') { column += 8 - column % 8; }
        else if (char === '\f') { column = 0; }
        else { break; }
    }
    return column;
}

/**
 * Mask only standalone terminators. Never add/remove lines or UTF-16 code units:
 * LSP positions and ordinary symbol edits then remain identical to the source.
 * This lexer tracks strings, comments and logical lines, not Python expressions;
 * expression/suite syntax and types remain Pyright's responsibility.
 */
export function project(source: string): Projection {
    const lines = source.split('\n');
    const result: Projection = { text: '', diagnostics: [], foldingRanges: [], endRanges: [] };
    const blocks: Block[] = [];
    let quote: string | undefined;
    let triple = false;
    let depth = 0;
    let logical = '';
    let logicalLine = 0;
    let logicalIndent = 0;
    let lastStatementLine = 0;
    let continuing = false;
    let closedIndent: number | undefined;

    const finish = (endLine: number) => {
        const block = blocks.pop()!;
        if (endLine > block.line) {
            result.foldingRanges.push({ startLine: block.line, endLine });
        }
    };
    const error = (line: number, start: number, length: number, code: string, message: string) => {
        result.diagnostics.push({
            range: { start: { line, character: start }, end: { line, character: start + length } },
            severity: DiagnosticSeverity.Error, source: 'EliteScript', code, message,
        });
    };

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const canTerminate = !quote && depth === 0 && !continuing && !logical.trim();
        const masked = line.split('');
        let escapedNewline = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (quote) {
                masked[i] = ' ';
                if (char === '\\') {
                    if (i + 1 < line.length && line[i + 1] !== '\r') { masked[++i] = ' '; }
                    else { escapedNewline = true; }
                } else if (char === quote) {
                    if (!triple) { quote = undefined; }
                    else if (line.slice(i, i + 3) === quote.repeat(3)) {
                        masked[i + 1] = masked[i + 2] = ' ';
                        i += 2;
                        quote = undefined;
                    }
                }
            } else if (char === '#') {
                masked.fill(' ', i);
                break;
            } else if (char === '"' || char === "'") {
                quote = char;
                triple = line.slice(i, i + 3) === char.repeat(3);
                masked[i] = 'x'; // A string is still a statement, even if its contents are empty.
                if (triple) { masked[i + 1] = masked[i + 2] = ' '; i += 2; }
            } else if ('([{'.includes(char)) { depth++; }
            else if (')]}'.includes(char)) { depth = Math.max(0, depth - 1); }
        }
        if (quote && !triple && !escapedNewline) { quote = undefined; }
        const code = masked.join('').trim();

        if (canTerminate && code === 'end' && /^[\t \f]*end[\t ]*(?:#.*)?\r?$/.test(line)) {
            const column = line.indexOf('end');
            const indent = indentation(line);
            while (blocks.length && blocks[blocks.length - 1].indent > indent) { finish(lastStatementLine); }
            if (blocks.length && blocks[blocks.length - 1].indent === indent) {
                finish(lineIndex);
                closedIndent = indent;
            } else {
                error(lineIndex, column, 3, 'unmatched-end',
                    'This end has no matching block at the same indentation. end is optional; when present, align it with the block header.');
            }
            lines[lineIndex] = line.slice(0, column) + '   ' + line.slice(column + 3);
            result.endRanges.push({ start: { line: lineIndex, character: column }, end: { line: lineIndex, character: column + 3 } });
            lastStatementLine = lineIndex;
            continue;
        }

        if (!logical.trim() && code) { logicalLine = lineIndex; logicalIndent = indentation(line); }
        logical += ' ' + code;
        continuing = /\\\s*$/.test(code) || escapedNewline;
        if (depth || quote || continuing) { continue; }

        const statement = logical.trim();
        logical = '';
        if (!statement) { continue; }
        if (closedIndent !== undefined && logicalIndent > closedIndent) {
            error(logicalLine, Math.max(0, lines[logicalLine].search(/\S/)), 1, 'indent-after-end',
                'This statement is still indented inside a block that was explicitly closed by end.');
        }
        closedIndent = undefined;
        const clause = /^(elif|else|except|finally)\b/.exec(statement)?.[1];
        if (clause) {
            while (blocks.length && blocks[blocks.length - 1].indent > logicalIndent) { finish(lastStatementLine); }
            const block = blocks[blocks.length - 1];
            const allowed = clause === 'elif' ? ['if'] : clause === 'else' ? ['if', 'for', 'while', 'try'] : ['try'];
            if (!block || block.indent !== logicalIndent || !allowed.includes(block.kind)) {
                const column = lines[logicalLine].search(/\S/);
                error(logicalLine, Math.max(0, column), clause.length, 'unmatched-clause',
                    `${clause} has no matching open block. Put end after the complete compound statement, including its branches.`);
            }
        } else {
            while (blocks.length && blocks[blocks.length - 1].indent >= logicalIndent) { finish(lastStatementLine); }
            const header = /^(?:async\s+)?(def|class|if|for|while|try|with|match)\b/.exec(statement);
            let brackets = 0;
            let suiteColon = false;
            for (const char of statement) {
                if ('([{'.includes(char)) { brackets++; }
                else if (')]}'.includes(char)) { brackets--; }
                else if (char === ':' && brackets === 0) { suiteColon = true; break; }
            }
            if (header && suiteColon && !(header[1] === 'match' && /^match\s*[:=]/.test(statement))) {
                blocks.push({ kind: header[1], indent: logicalIndent, line: logicalLine });
            }
        }
        lastStatementLine = lineIndex;
    }
    // Unclosed blocks are ordinary Python: end is explicitly optional in EliteScript.
    while (blocks.length) { finish(lastStatementLine); }
    result.text = lines.join('\n');
    return result;
}
