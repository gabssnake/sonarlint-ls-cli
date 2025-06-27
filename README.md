# Lightweight and standalone SonarQube CLI analysis

/!\ This is not a SonarSource project, use at your own risk /!\

A minimal CLI tool that brings SonarQube's JavaScript analysis to the command line.
It works locally and mostly without dependencies besides Node.js.

## Why

SonarQube has 600+ professional-grade rules for JavaScript and TypeScript used by millions of developers, but it's typically only available in IDEs or requires a SonarQube instance or SaaS.

This tool makes SonarQube's powerful analysis available as a lightweight, offline command-line tool.

## How it works

Downloads the platform-specific SonarQube VSCode extension on first use, which includes a bundled JVM, then extracts the Language Server Protocol (LSP) component, and communicates with it via JSON-RPC using a lightweight LSP client written in Node.js using only built-in modules, no npm dependencies.

No Java installation is required on macOS and Linux, since it uses the bundled JVM when possible.

That's it. No configuration files, no complex setup, no network required.

## Requirements

- Node.js for the LSP client
- Make, curl, unzip for setup

## Limitations

This tool uses SonarQube's internal LSP, which is equivalent to what you'd see in your IDE. However, it doesn't include SonarQube's full analysis features like cross-file analysis and advanced rules that require full project context. For complete coverage, use this alongside your regular SonarQube setup.

## Usage

```bash
# Auto-setup and analyze files. Globs are fine but not folders.
make analyze file.js
make analyze src/*.js

# List all 600+ available rules for JS/TS
make rules

# Debug mode for troubleshooting
make debug file.js
```

## Example Output

```bash
$ make analyze test.js
test.js:3:1 - Unexpected var, use let or const instead. (javascript:S3504)
test.js:8:5 - Empty block statement. (javascript:S108)
```

## Credits

This started as a fork of [@vincentfenet](https://github.com/vincentfenet)'s project [sonarlint-ls-cli](https://github.com/vincentfenet/sonarlint-ls-cli/).

I ended up rewriting to avoid the dependencies on Python and Java.
