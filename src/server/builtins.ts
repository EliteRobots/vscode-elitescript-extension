import busEn from '../EliteFunctions/en/busFunctions.json';
import communicationEn from '../EliteFunctions/en/communicationFunctions.json';
import forceEn from '../EliteFunctions/en/force_controlFunctions.json';
import ioEn from '../EliteFunctions/en/ioFunctions.json';
import mathEn from '../EliteFunctions/en/mathFunctions.json';
import motionEn from '../EliteFunctions/en/motionFunctions.json';
import sysEn from '../EliteFunctions/en/sysFunctions.json';
import busCn from '../EliteFunctions/cn/busFunctions.json';
import communicationCn from '../EliteFunctions/cn/communicationFunctions.json';
import forceCn from '../EliteFunctions/cn/force_controlFunctions.json';
import ioCn from '../EliteFunctions/cn/ioFunctions.json';
import mathCn from '../EliteFunctions/cn/mathFunctions.json';
import motionCn from '../EliteFunctions/cn/motionFunctions.json';
import sysCn from '../EliteFunctions/cn/sysFunctions.json';

export type DocumentationLanguage = 'en' | 'cn';
export interface RobotFunction {
    name: string;
    description: string;
    parameters: { name: string; type: string; default: string; description: string }[];
    return_type: string;
    return_description: string;
    note: string;
    tips: string;
}

const english: RobotFunction[] = [...busEn, ...communicationEn, ...forceEn, ...ioEn, ...mathEn, ...motionEn, ...sysEn];
const chinese: RobotFunction[] = [...busCn, ...communicationCn, ...forceCn, ...ioCn, ...mathCn, ...motionCn, ...sysCn];

function pythonType(type: string): string {
    const types: Record<string, string> = {
        any: '_Any', list: '_List[_Any]', tuple: '_Tuple[_Any, ...]',
        str: 'str', int: 'int', float: 'float', bool: 'bool', None: 'None',
    };
    if (!types[type]) { throw new Error(`Unknown robot API type: ${type}`); }
    return types[type];
}

/** Use a single signature source; switching documentation language must not change type checking. */
export function generateBuiltins(language: DocumentationLanguage): string {
    const translations = new Map((language === 'cn' ? chinese : english).map(fn => [fn.name, fn]));
    const declarations = english.map(fn => {
        const doc = translations.get(fn.name) ?? fn;
        const parameters = fn.parameters.map(p => `${p.name}: ${pythonType(p.type)}${p.default ? ' = ...' : ''}`);
        const parts = [doc.description.trim()];
        if (fn.parameters.length) {
            parts.push('Parameters:', ...fn.parameters.map(p => {
                const localized = doc.parameters.find(d => d.name === p.name) ?? p;
                return `    ${p.name}: ${localized.description.trim()}${p.default ? ` (default: ${p.default})` : ''}`;
            }));
        }
        if (doc.return_description) { parts.push(`Returns: ${doc.return_description}`); }
        if (doc.note) { parts.push(`Note: ${doc.note}`); }
        if (doc.tips) { parts.push(`Tips: ${doc.tips}`); }
        const text = parts.join('\n').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `def ${fn.name}(${parameters.join(', ')}) -> ${pythonType(fn.return_type)}:\n    """${text.replace(/\n/g, '\n    ')}"""\n    ...\n`;
    });
    return '# Generated from the EliteScript API catalog. Used for analysis only.\n' +
        'from typing import Any as _Any, List as _List, Tuple as _Tuple\n\n' + declarations.join('\n');
}
