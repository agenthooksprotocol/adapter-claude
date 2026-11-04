// Session lifecycle, compaction, and the classic hooks that carry one AHP
// event each (model switches, configuration, workspace, files, tasks,
// attention and elicitation).
import type { On } from "claude-code";
import { Permission, state } from "agenthooksprotocol/client";
import { type Adapter, MAIN, denial, injections, model } from "../adapter.js";
import { asText, message, textPart, texts } from "../content.js";

const COMPACT_TRIGGER = { manual: "manual", auto: "auto", plugin: "hook", precompute: "auto" } as const;
const END_OUTCOME = { clear: "completed", resume: "completed", logout: "completed", prompt_input_exit: "completed", other: "unknown" } as const;

export function installLifecycle(adapter: Adapter, on: On): void {
  // The mod's own start: load the registration and start the client. It runs
  // again on every reload of the module. Claude Code reads `$` only where a
  // hook calls it, so the host below is spelled out in both starting hooks.
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    // Every engine call the adapter makes, spelled where the engine reads it.
    const [PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, TZ, TMPDIR, TEMP, TMP, AHP_HOOKS_FILE] = await Promise.all([
      $.env.get("PATH"), $.env.get("HOME"), $.env.get("USER"), $.env.get("LOGNAME"), $.env.get("SHELL"),
      $.env.get("LANG"), $.env.get("LC_ALL"), $.env.get("TZ"), $.env.get("TMPDIR"), $.env.get("TEMP"), $.env.get("TMP"),
      $.env.get("AHP_HOOKS_FILE"),
    ]);
    await adapter.start({
      fetch: (url, init) => $.http.fetch(url, init),
      run: (argv, init) => $.process.run(argv, init),
      spawn: (request) => $.process.spawn(request),
      after: (ms, callback) => $.clock.after(ms, callback),
      log: (text, options) => $.ui.log(text, options),
      exists: (path) => $.fs.exists(path),
      read: (path) => $.fs.read(path),
      messages: async (agentId) => {
        const rows = await $.session.messages(agentId ? { agentId, as: "api" } : { as: "api" });
        return Array.isArray(rows) ? rows : [];
      },
      version: () => $.session.version(),
      sessionId: () => $.session.id(),
      environment: { PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, TZ, TMPDIR, TEMP, TMP, AHP_HOOKS_FILE },
    }, e.cwd);
    return started;
  });

  on("classic.SessionStart", async ($, e, next) => {
    // A session's classic SessionStart runs before the mod's session.start.
    // Every engine call the adapter makes, spelled where the engine reads it.
    const [PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, TZ, TMPDIR, TEMP, TMP, AHP_HOOKS_FILE] = await Promise.all([
      $.env.get("PATH"), $.env.get("HOME"), $.env.get("USER"), $.env.get("LOGNAME"), $.env.get("SHELL"),
      $.env.get("LANG"), $.env.get("LC_ALL"), $.env.get("TZ"), $.env.get("TMPDIR"), $.env.get("TEMP"), $.env.get("TMP"),
      $.env.get("AHP_HOOKS_FILE"),
    ]);
    await adapter.start({
      fetch: (url, init) => $.http.fetch(url, init),
      run: (argv, init) => $.process.run(argv, init),
      spawn: (request) => $.process.spawn(request),
      after: (ms, callback) => $.clock.after(ms, callback),
      log: (text, options) => $.ui.log(text, options),
      exists: (path) => $.fs.exists(path),
      read: (path) => $.fs.read(path),
      messages: async (agentId) => {
        const rows = await $.session.messages(agentId ? { agentId, as: "api" } : { as: "api" });
        return Array.isArray(rows) ? rows : [];
      },
      version: () => $.session.version(),
      sessionId: () => $.session.id(),
      environment: { PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, TZ, TMPDIR, TEMP, TMP, AHP_HOOKS_FILE },
    }, e.cwd);
    const ran = await next(e);
    adapter.sessionId = e.session_id;
    adapter.cwd = e.cwd;
    if (e.model) adapter.model = e.model;
    if (e.permission_mode) adapter.permissionMode = e.permission_mode;
    adapter.turns.clear();
    const hooks = await adapter.client("session.start");
    if (!hooks) return ran;
    const result = await hooks.sessionStart({
      session: adapter.session(),
      trigger: e.source,
      permissionMode: adapter.permissionMode,
      items: [],
      gaps: [{ path: "items", reason: "startup instructions reach the model with its first request (model.request.before)" }],
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    const context = injections(result);
    return context.length ? { ...ran, additionalContext: [...(ran.additionalContext ?? []), ...context] } : ran;
  });

  on("session.end", async ($, e, next) => {
    const hooks = await adapter.client("session.end");
    if (hooks) {
      const result = await hooks.sessionEnd({
        session: { ...adapter.session(), id: e.sessionId },
        reason: e.reason,
        outcome: END_OUTCOME[e.reason] ?? "unknown",
      });
      adapter.report(result);
    }
    const ended = await next(e);
    adapter.turns.clear();
    adapter.calls.clear();
    adapter.agents.clear();
    // /clear goes on under a new session id; classic SessionStart reports it.
    return ended;
  });

  on("session.compact", async ($, e, next) => {
    const loop = e.agentId ?? MAIN;
    const trigger = COMPACT_TRIGGER[e.trigger];
    const items = e.messages.map((row, index) =>
      message(row.handle ?? `compact:${index}`, row.role, row.text, row.handle ? {} : { synthesized: true }));
    const extensions = e.trigger === "precompute" ? { "com.anthropic.claude-code": { trigger: "precompute" } } : undefined;
    let instructions = e.instructions;
    const before = await adapter.client("context.compact.before");
    if (before) {
      const result = await before.contextCompactBefore({
        ...adapter.scope(loop),
        trigger,
        items,
        ...(e.instructions ? { instructions: [textPart("compact:instructions", e.instructions)] } : {}),
        ...(extensions ? { extensions } : {}),
      }, {
        initialState: { ...state.initial(Permission.None), ...(e.instructions ? { instructions: [e.instructions] } : {}) },
        signal: next.signal,
      });
      adapter.report(result);
      const refused = denial(result);
      if (refused !== undefined) return { skip: refused };
      const candidate = (result.state as { candidate?: { value: unknown } | null }).candidate;
      if (candidate) {
        const summary = typeof candidate.value === "string" ? candidate.value : texts(candidate.value as unknown[]).join("\n") || asText(candidate.value);
        return { messages: [{ role: "user", text: summary, toolUses: [] }] };
      }
      const changed = (result.state as { instructions?: string[] }).instructions;
      if (changed && changed.join("\n") !== (e.instructions ?? "")) instructions = changed.join("\n");
    }
    const compacted = await next({ ...e, ...(instructions !== undefined ? { instructions } : {}) });
    const after = await adapter.client("context.compact.after");
    if (after && !("skip" in compacted && compacted.skip !== undefined)) {
      const kept = new Set(compacted.messages.map((row) => row.handle).filter(Boolean));
      const summary = compacted.messages.find((row) => !row.handle) ?? compacted.messages[0];
      const result = await after.contextCompactAfter({
        ...adapter.scope(loop),
        summary: [textPart(`compact:summary:${crypto.randomUUID()}`, summary?.text ?? "", "summary")],
        removed: e.messages.filter((row) => row.handle && !kept.has(row.handle)).map((row) => ({ id: row.handle! })),
        execution: { status: "executed" },
        ...(compacted.tokensBefore !== undefined || compacted.tokensAfter !== undefined
          ? { tokenCounts: { ...(compacted.tokensBefore !== undefined ? { before: compacted.tokensBefore } : {}), ...(compacted.tokensAfter !== undefined ? { after: compacted.tokensAfter } : {}) } }
          : {}),
        ...(extensions ? { extensions } : {}),
      }, { capabilities: { effects: [] } as never });
      adapter.report(result);
    }
    return compacted;
  });

  on("classic.PreModelSwitch", async ($, e, next) => {
    const ran = await next(e);
    const hooks = await adapter.client("model.switch.before");
    if (!hooks || ran.permissionDecision === "deny") return ran;
    const result = await hooks.modelSwitchBefore({
      ...adapter.scope(e.agent_id ?? MAIN),
      current: model(e.from_model),
      proposed: model(e.to_model),
      reason: String((e as { source?: unknown }).source ?? "command"),
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    const refused = denial(result);
    return refused !== undefined ? { ...ran, permissionDecision: "deny", permissionDecisionReason: refused } : ran;
  });

  on("classic.PostModelSwitch", async ($, e, next) => {
    const ran = await next(e);
    adapter.model = e.to_model;
    const hooks = await adapter.client("model.switch.after");
    if (hooks) {
      const result = await hooks.modelSwitchAfter({
        ...adapter.scope(e.agent_id ?? MAIN),
        previous: model(e.from_model),
        current: model(e.to_model),
        reason: String((e as { source?: unknown }).source ?? "command"),
      });
      adapter.report(result);
    }
    return ran;
  });

  const SCOPE = { user_settings: "user", project_settings: "project", local_settings: "local", policy_settings: "managed", skills: "user" } as const;
  on("classic.ConfigChange", async ($, e, next) => {
    const ran = await next(e);
    const hooks = await adapter.client("config.change.before");
    if (!hooks || ran.block !== undefined) return ran;
    const result = await hooks.configChangeBefore({
      ...adapter.scope(),
      change: {
        source: e.source,
        scope: SCOPE[e.source],
        settings: e.file_path ? [e.file_path] : [],
        summary: `${e.source} changed${e.file_path ? ` (${e.file_path})` : ""}`,
      },
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    const refused = denial(result);
    // Claude Code does not block policy settings changes.
    return refused !== undefined && e.source !== "policy_settings" ? { ...ran, block: refused } : ran;
  });

  on("config.set", async ($, e, next) => {
    const set = await next(e);
    const hooks = await adapter.client("config.change.after");
    if (hooks && set.deny === undefined) {
      const result = await hooks.configChangeAfter({
        ...adapter.scope(),
        change: { source: "menu", scope: "user", settings: [e.key], summary: `${e.key}: ${asText(e.previous)} -> ${asText(set.value)}` },
      });
      adapter.report(result);
    }
    return set;
  });

  on("classic.CwdChanged", async ($, e, next) => {
    const ran = await next(e);
    adapter.cwd = e.new_cwd;
    const hooks = await adapter.client("workspace.change.after");
    if (hooks) {
      const result = await hooks.workspaceChangeAfter({
        ...adapter.scope(e.agent_id ?? MAIN),
        workspace: { kind: "cwd", change: { cwd: e.new_cwd }, prior: { cwd: e.old_cwd } },
      });
      adapter.report(result);
    }
    return ran;
  });

  on("classic.DirectoryAdded", async ($, e, next) => {
    const ran = await next(e);
    const hooks = await adapter.client("workspace.change.after");
    if (hooks) {
      const result = await hooks.workspaceChangeAfter({
        ...adapter.scope(e.agent_id ?? MAIN),
        workspace: { kind: "roots", change: { added: [e.directory] }, reason: e.source },
      });
      adapter.report(result);
    }
    return ran;
  });

  on("classic.FileChanged", async ($, e, next) => {
    const ran = await next(e);
    const hooks = await adapter.client("file.changed");
    if (hooks) {
      const result = await hooks.fileChanged({
        ...adapter.scope(),
        changes: [{ path: e.file_path, operation: e.event === "add" ? "create" : e.event === "unlink" ? "remove" : "update", agentCaused: false }],
      });
      adapter.report(result);
    }
    return ran;
  });

  on("classic.TaskCreated", async ($, e, next) => task(adapter, "create", e, await next(e)));
  on("classic.TaskCompleted", async ($, e, next) => task(adapter, "update", e, await next(e)));

  on("classic.Notification", async ($, e, next) => {
    const ran = await next(e);
    const hooks = await adapter.client("user.attention");
    if (hooks) {
      const result = await hooks.userAttention({
        ...adapter.scope(e.agent_id ?? MAIN),
        attention: {
          kind: e.notification_type,
          message: [textPart("attention:message", e.message)],
          title: [textPart("attention:title", e.title ?? e.notification_type)],
        },
      });
      adapter.report(result);
    }
    return ran;
  });

  on("classic.Elicitation", async ($, e, next) => {
    const ran = await next(e);
    const hooks = await adapter.client("user.elicitation.request");
    if (!hooks || ran.block !== undefined) return ran;
    const mode = e.mode ?? "form";
    const request = mode === "url"
      ? { mode, message: e.message, url: e.url, elicitationId: e.elicitation_id }
      : { mode, message: e.message, requestedSchema: e.requested_schema ?? { type: "object", properties: {} } };
    const result = await hooks.userElicitationRequest({
      ...adapter.scope(e.agent_id ?? MAIN),
      elicitation: { server: e.mcp_server_name, mode, request: textPart(`elicitation:${e.elicitation_id ?? crypto.randomUUID()}`, asText(request)) },
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    const refused = denial(result);
    return refused !== undefined ? { ...ran, block: refused } : ran;
  });

  on("classic.ElicitationResult", async ($, e, next) => {
    const ran = await next(e);
    const hooks = await adapter.client("user.elicitation.result");
    if (hooks) {
      const result = await hooks.userElicitationResult({
        ...adapter.scope(e.agent_id ?? MAIN),
        elicitation: {
          server: e.mcp_server_name,
          mode: e.mode ?? "form",
          action: e.action,
          result: textPart(`elicitation-result:${e.elicitation_id ?? crypto.randomUUID()}`, asText({ action: e.action, ...(e.content ? { content: e.content } : {}) })),
        },
      }, { capabilities: { effects: [] } as never });
      adapter.report(result);
    }
    return ran;
  });
}

type Blocked = { block?: string };

/** task.change.before at TaskCreated / TaskCompleted: a deny blocks it. */
async function task<R extends Blocked>(
  adapter: Adapter,
  operation: "create" | "update",
  e: { task_id: string; task_subject: string; task_description?: string; teammate_name?: string; agent_id?: string },
  ran: R,
): Promise<R> {
  const hooks = await adapter.client("task.change.before");
  if (!hooks || ran.block !== undefined) return ran;
  const result = await hooks.taskChangeBefore({
    ...adapter.scope(e.agent_id ?? MAIN),
    task: {
      id: e.task_id,
      operation,
      change: operation === "create"
        ? { subject: e.task_subject, ...(e.teammate_name ? { owner: e.teammate_name } : {}) }
        : { status: "completed" },
      ...(e.task_description ? { description: e.task_description } : {}),
    },
  }, { initialState: state.initial(Permission.None) });
  adapter.report(result);
  const refused = denial(result);
  return refused !== undefined ? { ...ran, block: refused } : ran;
}
