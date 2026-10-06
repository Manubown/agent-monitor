# Security policy

## Supported versions

Agent Monitor is in alpha. Only the latest release (currently the latest `0.1.0-alpha.x`) and the `main` branch receive security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting: open the repository's [Security tab](https://github.com/Manubown/agent-monitor/security) and choose **Report a vulnerability** ([direct link](https://github.com/Manubown/agent-monitor/security/advisories/new)). Do not open a public issue, discussion or pull request for it.

Include what is affected, steps to reproduce, and the impact you expect. Use synthetic data in any proof of concept; never attach real session logs or database files. You should get a first response within a week. Fixes are released as a new alpha and credited in the advisory unless you prefer otherwise.

## Scope

Agent Monitor is a local, single-user tool. The data it handles is sensitive: the database (`monitor.db`), the search index and the log archive (by default under `~/.local/share/agent-monitor`) hold full agent transcripts, which include prompts, tool output, contents of files the agents read, and often secrets such as API keys and tokens.

In scope, for example:

- Anything that lets another machine, another local user, or a web page open in the browser read this data or trigger actions: bypassing the `127.0.0.1` binding, the `Host` header check in `proxy.ts` (DNS rebinding protection), or cross-site requests to the API routes and server actions.
- Injection through log content: crafted session logs that lead to script execution in the dashboard (XSS), SQL injection, or path traversal when reading files, the archive or exports.
- Crashes of the native search addon triggered by crafted input, if they can be exploited beyond a denial of service.
- Tampering risks in the release process, for example the prebuilt addon download in `scripts/build-native.mjs` and its SHA256 verification.

Out of scope:

- Attackers who already run code as your user or can read your home directory: they can read the agent logs directly.
- Exposing the server to a network on purpose (changing the bind address, reverse proxies, port forwarding). That is unsupported.
- Vulnerabilities in the agent CLIs themselves, or in their log formats.
