# Public design provenance

Feather is independently implemented, not a copy of proprietary code or prompts.
REA, comparison artifacts and target binaries are not bundled.

| Product | Fixed sample | Research boundary |
| --- | --- | --- |
| Gemini CLI Core | 0.65.0 | Four selected JS files and direct observations |
| OpenClaw | 2026.10.7 | Four selected JS files and direct observations |
| Qwen Code | 0.26.1 | JS launcher and bounded code reading |
| Claude Code | 2.1.310 | Public package metadata, ELF notes and architecture docs; no proprietary source |
| Codex | npm 0.164.0 | JS launcher; selected Rust at 970111f6cb62cc02fe36a82ea7d71b37a2889c97 |
| OpenCode | npm 2.1.4 | JS installer; selected TS at ab4d1f3ab1a05278b4d0392124b9e7f1c8131f17 |

Source commits and published versions were pinned independently, not asserted to
be matching builds. REA coverage was partial, not proof of complete runtime
behavior, product quality or security.

Public ideas used: bounded model/tool/result loops, separate tool definitions
and execution checks, permission-filtered tools, paired tool messages, atomic
session snapshots and event logs, interruption markers without automatic replay,
explicit output budgets and cancellation.

Desktop 0.2.0 is a newly assembled text/file GUI. Its own Linux/Windows unit tests
and Windows Electron smoke must pass; it does not inherit the old CLI test result.

Official projects and documentation:
- https://github.com/morluto/rea
- https://github.com/google-gemini/gemini-cli
- https://github.com/openclaw/openclaw
- https://github.com/QwenLM/qwen-code
- https://github.com/openai/codex
- https://github.com/anomalyco/opencode
- https://code.claude.com/docs/en/how-claude-code-works
