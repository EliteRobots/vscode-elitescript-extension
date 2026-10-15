# Change Log

All notable changes to the "elitescript" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [1.0.0] - 2026-10-15

- Release the Pyright-based EliteScript extension as version 1.0.0, including the workspace scanning fixes from 0.1.1.
- Update package metadata, language-server version and VSIX documentation to 1.0.0.

## [0.1.1]

- Fix language-server initialization failures when workspace scans encounter inaccessible or disappearing source paths, including Windows IPC endpoints.
- Exclude generated test profiles and the adapter's own analysis storage from scanning and file-watcher synchronization; log skipped permission failures in the EliteScript output channel.
- Cover source access failures and open the full repository's demo in the VS Code extension-host smoke test.

## [0.1.0]

- Replace fixed completion/hover providers with a Pyright-backed EliteScript LSP adapter.
- Add signature help, diagnostics, navigation, references, symbol rename, document symbols and folding.
- Support optional end terminators with offset-preserving projection and structural checks.
- Generate bilingual built-in declarations from the 186-function API catalog.
- Add isolated workspace mirrors for imports and unsaved EliteScript document synchronization.
- Replace the vendored MagicPython grammar and build toolchain with a small grammar that includes VS Code's built-in Python grammar.
- Add language configuration, snippets, restart/settings commands, integration tests and VSIX packaging.

## [0.0.2]

- Syntax highlighting, built-in completion and bilingual hover documentation.
