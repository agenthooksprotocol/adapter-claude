# Agent Hooks Protocol adapter for Claude Code

A Claude Code mod that delivers Claude Code's events to
[Agent Hooks Protocol](https://github.com/agenthooksprotocol/agent-hooks-protocol)
backends and applies their effects natively. It is built on the
[AHP TypeScript SDK](https://github.com/agenthooksprotocol/typescript-sdk), bundled
to run inside Claude Code's hooks-module sandbox.

## Install

At the prompt of a Claude Code session:

```
/plugin install agent-hooks-protocol --marketplace agenthooksprotocol/adapter-claude
```

While developing, load it from this checkout instead:

```sh
npm install && npm run build
claude --plugin-dir ./plugin
```

## Register backends

The adapter reads AHP registrations (the spec's `hooks.json`) from four places
and merges them into one document:

| File | Scope |
| --- | --- |
| `~/.agents/hooks.json` | user |
| `~/.claude/hooks.json` | user |
| `<cwd>/.agents/hooks.json` | project |
| `<cwd>/.claude/hooks.json` | project |

Later rows win: a backend in a later file replaces the backend with the same
`id` from an earlier one, so the project beats the user and `.claude` beats
`.agents`. A file that is not a `"protocolVersion": "draft"` registration is
skipped with a diagnostic (`claude --debug`).

```json
{
  "protocolVersion": "draft",
  "hooks": [
    {
      "id": "com.example.policy",
      "transport": { "type": "http", "url": "https://hooks.example/ahp" },
      "subscriptions": [
        {
          "mode": "intercept",
          "events": ["tool.before", "turn.start"],
          "timeoutMs": 2000,
          "failurePolicy": "fail-closed",
          "content": { "default": "body" }
        }
      ]
    }
  ]
}
```

Omit `subscriptions` to let the backend choose them (server-driven
configuration). A discovered `upload` is admitted, unless its `auth` names a
local secret (`tokenEnv`, `tokenRef`, `clientSecretRef`), which skips the backend
(AHP-REG-005).

Set `AHP_HOOKS_FILE` to one registration's absolute path to use that file
alone, with no discovery (tests, CI, a pinned deployment).

## What reaches a backend

| AHP event | Claude Code source | Effects applied |
| --- | --- | --- |
| `session.start` | classic `SessionStart` | inject, message |
| `session.end` | `session.end` | observe |
| `turn.start` | `prompt.submit`; `turn.start` for turns no prompt began | deny, modify(prompt), inject, message |
| `turn.finish.before` | classic `Stop`, `SubagentStop` | flow continue/stop, message |
| `turn.end` | `turn.complete` | observe |
| `model.request.before`, `model.response.after`, `model.error` | `turn.step`, classic `StopFailure` | observe |
| `model.switch.before`, `model.switch.after` | classic `PreModelSwitch`, `PostModelSwitch` | deny, message |
| `tool.before` | `tool.call`, `tool.check` | deny, allow, ask, modify(input), return, inject, message |
| `tool.after` | classic `PostToolUse`, `PostToolUseFailure`, `tool.call` | modify(output), inject, message |
| `tool.permission.request` | classic `PermissionRequest` | allow, deny, modify(input), flow stop, message |
| `tool.permission.resolved` | `tool.check` and the call's outcome | observe |
| `tool.batch.after` | classic `PostToolBatch` | inject, flow stop, message |
| `context.compact.before`, `context.compact.after` | `session.compact` | deny, modify(instructions), return; observe |
| `config.change.before`, `config.change.after` | classic `ConfigChange`, `config.set` | deny, message; observe |
| `task.change.before` | classic `TaskCreated`, `TaskCompleted` | deny, message |
| `workspace.change.after` | classic `CwdChanged`, `DirectoryAdded` | observe |
| `file.changed` | classic `FileChanged` | observe |
| `user.attention` | classic `Notification` | observe |
| `user.elicitation.request`, `user.elicitation.result` | classic `Elicitation`, `ElicitationResult` | deny, message; observe |
| `user.message.inbound`, `user.message.outbound` | `session.receive` and prompts folded into a running turn; `session.send` | deny, modify, message |

Subagents are not separate sessions: their events carry `session.agent`
(`id`, `type`), and their first turn hangs off the Agent call's `tool.before`
through `parentEventId`. Skill bodies, which Claude Code's own Skill result
leaves out, ride on the Skill call's `tool.after` as a `skill` part. The system
prompt as composed rides on `model.request.before` as a `system` message.

Everything the adapter cannot enforce is left unadvertised and listed in the
manifest's `gaps` ([`src/capabilities.ts`](src/capabilities.ts)): request
rewrites at `model.request.before`, `tool.progress`,
`workspace.change.before`, elicitation answers, persistent stdio backends.

## Content uploads

Media leaves as attachment parts, uploaded only for a subscription that selects
the body and configures `upload`; the bytes never travel in event text.

| Media | Reaches a backend on |
| --- | --- |
| Images and PDFs the `Read` tool returns, media in MCP results | `tool.after` |
| Images and documents in the conversation | `model.request.before` |
| Media pasted into a prompt | `turn.start`, only for a managed-settings install of the mod; elsewhere a gap there, then `model.request.before` |

One upload holds at most 32 MiB. An upload runs through `sh`, `base64` and `curl`,
as `$.http.fetch` carries text only: the URL and headers ride the child's
environment, never its argv, and an abort kills it. On a machine without them,
such as Windows without WSL, each attachment carries a gap and the manifest
declares `content.upload`.

## How it runs

A hooks module has no Node, no `fetch` and no code generation. The adapter:

- sends HTTP through `$.http.fetch` (text bodies only, no streaming), and content
  uploads through curl,
- runs `per_event` stdio backends through `$.process.spawn`,
- reads `tokenEnv` / `valueEnv` names through `printenv`, since `$.env.get`
  takes only names spelled in the source,
- uses the SDK's precompiled validators, shipped as files under 1 MiB each
  (Claude Code's per-file limit).

`scripts/build.mjs` bundles `src/` and the SDK into `plugin/hooks/`, and fails
the build on a dynamic import, an external import or an oversized file.

## Develop

```sh
npm run build        # bundle into plugin/hooks
npm run typecheck    # tsc against vendor/claude-code (Claude Code 2.1.314)
npm test             # build, claude plugin validate, claude plugin test
```

`vendor/claude-code/index.d.ts` is the mod API declaration Claude Code 2.1.314
writes; replace it when targeting another build.
