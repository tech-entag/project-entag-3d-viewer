<!-- ai-toolchain-version: v1.5.0 -->
<!-- last-verified: 2026-05-07 -->

# AI Toolchain Version

Synced from user-level config on 2026-05-07.
Source manifest: `~/.copilot/VERSION.md`.

## Workspace Status

- Current workspace toolchain version: **v1.5.0**
- Sync mode: full deploy/update
- Copilot and Codex surfaces are maintained together; Codex assets are additive.

## Mandatory Sync Instructions

When `~/.copilot/VERSION.md` is newer than this marker, run all steps below.

1. Sync Copilot and Codex assets in one pass:
	- `AGENTS.md`
	- `.github/copilot-instructions.md`
	- `.github/instructions/*.instructions.md`
	- `.continue/checks/*.md`
	- `.codex/config.toml`, `.codex/rules/*`, `.agents/skills/*`
2. Resolve workspace `.codex/config.toml` runtime placeholders:
	- `<PENCIL_MCP_BINARY_PATH>`
	- `<OBSIDIAN_VAULT_PATH>`
3. Verify MCP parity against VS Code user config (`%APPDATA%/Code/User/mcp.json`):
	- same required server set on workspace Codex surfaces
	- no unresolved placeholders in `.codex/config.toml`
4. Run post-sync documentation updates:
	- update `docs/ai/context.md`
	- append `docs/ai/experience-log.md`
	- add one run log in `docs/ai/run-logs/`
	- update any relevant `memories/repo/` canonical references
5. Ensure session continuity policy is active:
	- SessionStart hook provides latest-3-run-log bootstrap context when available
	- fallback rule documented for manual latest-3-run-log recovery when hook context is unavailable
6. Refresh structural references where available:
	- Repomix snapshot/index refresh
	- GitNexus index/query refresh
7. Run Experience Memory Curator and promote durable lessons:
	- project-level: `memories/repo/*`
	- cross-project: `/memories/*`

Sync is incomplete until every step above is either completed or explicitly blocked with reason.
