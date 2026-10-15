[中文](README_CN.md)

# EliteScript

Language support for Elite Robots CS-series scripts in Visual Studio Code. EliteScript uses Python indentation and adds robot built-in functions and an optional `end` block terminator.

## Features

- Python syntax highlighting from VS Code's built-in grammar, plus EliteScript `end` highlighting.
- Context-aware completion for local variables, user functions and 186 robot built-in functions.
- Hover documentation in English or Chinese, parameter signature help and Pyright type diagnostics.
- Go to definition, find references, symbol rename, document symbols and block folding.
- Structural diagnostics for unmatched/misindented `end`, branches after a closed block, and statements still indented after `end`.
- Snippets for functions, conditionals, loops and exception handlers.

`end` is optional. When used, align it with the opening `def`, `class`, `if`, `for`, `while`, `try` or `with`. Branches such as `elif`, `else`, `except` and `finally` share the compound statement's terminator:

```python
def task():
    target = [0.0, -1.57, 1.57, 0.0, 1.57, 0.0]
    if target:
        movej(target, a=0.5, v=0.2)
    else:
        pass
    end
end
```

The same program without either `end` is valid. Strings, comments and continued expressions containing the word `end` are left unchanged.

## Installation and settings

Install the VSIX through **Extensions: Install from VSIX...**, then open a `.script` file. VS Code 1.95 or newer is required. Python and Pylance extensions are not required; Pyright is included in the package. Keep VS Code's built-in **Python Language Basics** extension enabled for syntax highlighting.

| Setting | Default | Meaning |
| --- | --- | --- |
| `elitescript.documentationLanguage` | `auto` | `en`, `cn`, or the VS Code display language |
| `elitescript.pythonVersion` | `3.8` | Analysis target; set this to the version supported by your controller |
| `elitescript.typeCheckingMode` | `basic` | `off`, `basic`, `standard` or `strict` |

Settings changes restart the language server. Each workspace folder can have its own settings. The command palette also offers **Elite Script: Switch to Chinese**, **Elite Script: Switch to English** and **Elite Script: Restart Language Server**.

## Architecture

The VS Code client starts an EliteScript LSP adapter, which starts the pinned Pyright language server. The adapter:

1. Copies workspace `.script`, `.py` and `.pyi` files into a private, per-session analysis directory in the extension's global storage. A `helper.script` becomes `helper.py`, allowing imports to resolve before a file is opened.
2. Replaces standalone `end` tokens with equal-length spaces. Line numbers, UTF-16 positions, comments and newline styles are preserved.
3. Generates `__builtins__.pyi` from the existing bilingual API JSON. English data is the signature source; localized text supplies documentation.
4. Maps diagnostics, navigation and symbol edits back to the original files. Unsaved EliteScript buffers take precedence over saved text; closing a buffer restores the saved version.
5. Removes its analysis directory on normal shutdown.

Analysis does not modify source files or ordinary Python/Pylance configuration. It uses its own Pyright configuration, rather than the workspace's `pyrightconfig.json`. Common dependency/VCS directories (`node_modules`, `.git`, `.venv`, `venv`, `__pycache__`, `.tox`, `.pytest_cache`) and symlinks are skipped during the initial scan. Generated `.test-artifacts` and the adapter's analysis storage are also excluded. Scanning and file synchronization skip inaccessible or busy source paths with a warning in the **EliteScript** output channel. Paths that disappear during scanning are ignored without interrupting analysis of other scripts.

## Current boundaries

- No script execution, robot connection, debugger, formatter or general code actions. Runtime behavior still needs controller/simulator validation.
- Diagnostics reflect the existing API catalog; list lengths, units, robot limits and firmware-specific API availability are not checked.
- Open a workspace folder for cross-file `.script` imports. Loose/untitled files support single-file intelligence. Relative imports should follow normal Python package layout.
- Python helper files are mirrored from disk; unsaved synchronization is provided for EliteScript buffers. If both `helper.script` and `helper.py` exist, the script is preferred for analysis. Avoid ambiguous same-name modules.
- Workspace roots have separate analysis environments; arbitrary cross-root script imports and custom controller module-loading conventions are not modeled.
- Desktop/remote workspace extension hosts are supported. Browser-only VS Code, virtual workspaces and untrusted workspaces are not supported.

## Development

Use Node.js 22 or newer:

```sh
npm ci
npm test
npm run package
```

The package command produces `elitescript-1.0.0.vsix`. Runtime dependencies, including Pyright and its bundled typeshed, are included. Do not exclude `node_modules` wholesale from the VSIX.

`npm test` compiles the extension and runs lexer/stub tests and real-Pyright LSP integration tests. A TextMate composition test uses the installed VS Code Python grammar when available; set `VSCODE_PYTHON_GRAMMAR` to its `MagicPython.tmLanguage.json` path if automatic discovery fails.

To test the actual extension host, set `VSCODE_EXECUTABLE` to the VS Code application executable and run `npm run test:vscode`. It opens the full repository, checks `examples/demo.script`, and uses an isolated profile under `.test-artifacts` to test providers, diagnostics, documentation-language switching and restart. It does not use your normal VS Code profile.

For manual testing, launch the extension development host and open `examples/demo.script`. Source files are in `src/server`; robot documentation remains in `src/EliteFunctions/en` and `src/EliteFunctions/cn`. The small grammar in `syntaxes` includes VS Code's built-in `source.python`; there is no vendored MagicPython source or grammar-generation build step.
