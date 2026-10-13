const { test } = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('../out/server/projection');

test('optional end accepts ordinary Python and mixed explicit/implicit nesting', () => {
    for (const code of [
        'def f():\n    if True:\n        return 1\n',
        'def f():\n    if True:\n        return 1\nend\n',
        'def f():\n    if True:\n        return 1\n    end\nend\n',
        'if True:\n    pass\nelif False:\n    pass\nelse:\n    pass\nend',
        'try:\n    pass\nexcept Exception:\n    pass\nelse:\n    pass\nfinally:\n    pass\nend',
        'for x in []:\n    pass\nelse:\n    pass\nend',
        'async def f():\n    async with lock:\n        pass\n    end\nend',
    ]) {
        assert.deepEqual(project(code).diagnostics, [], code);
    }
});

test('terminators preserve every UTF-16 offset, CRLF and trailing comment', () => {
    const code = 'def f():\r\n\ttext = "中文😀"\r\nend # 结束\r\n';
    const actual = project(code);
    assert.equal(actual.text, code.replace('end #', '    #'));
    assert.equal(actual.text.length, code.length);
    assert.deepEqual(actual.endRanges, [{ start: { line: 2, character: 0 }, end: { line: 2, character: 3 } }]);
    assert.deepEqual(actual.foldingRanges, [{ startLine: 0, endLine: 2 }]);
});

test('strings, comments, attributes, prefixes and bracket continuations remain untouched', () => {
    const code = [
        'text = """', 'end', '"""', '# end', 'end_freedrive_mode()',
        'obj.end', 'end = 1', 'items = [', '    end', ']',
        'text = r"end"', 'text = f"{end}"', "text = 'escaped\\'end'",
        'text = "continued\\', 'end"', 'value = \\', '    end',
    ].join('\n');
    const actual = project(code);
    assert.equal(actual.text, code);
    assert.deepEqual(actual.endRanges, []);
    assert.deepEqual(actual.diagnostics, []);
});

test('multiline headers and tab indentation pair with end', () => {
    const code = 'def f(\n    value: str,\n):\n\tif value:\n\t\tpass\n\tend\nend\n';
    const actual = project(code);
    assert.deepEqual(actual.diagnostics, []);
    assert.equal(actual.endRanges.length, 2);
});

test('extra, misindented and prematurely closed branches get structural diagnostics', () => {
    assert.equal(project('end').diagnostics[0].code, 'unmatched-end');
    assert.equal(project('if True:\n    pass\n    end').diagnostics[0].code, 'unmatched-end');
    assert.equal(project('if True:\n    pass\nend\nelse:\n    pass').diagnostics[0].code, 'unmatched-clause');
    assert.equal(project('def f():\n    pass\nend\n    return 1').diagnostics[0].code, 'indent-after-end');
    assert.equal(project('def f():\n    pass\nx = 1\nend').diagnostics[0].code, 'unmatched-end');
    assert.equal(project('match = {"x": 1}\nend').diagnostics[0].code, 'unmatched-end');
});

test('an unfinished header or string does not consume end as a terminator', () => {
    for (const code of ['def f(\nend', 'value = """\nend']) {
        const actual = project(code);
        assert.equal(actual.text, code);
        assert.deepEqual(actual.endRanges, []);
    }
});
