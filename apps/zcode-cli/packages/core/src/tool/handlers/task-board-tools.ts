// ============================================================
// Agent Teams v1 - 任务板四件套工具（TaskCreate/TaskGet/TaskList/TaskUpdate）
// handler 只做解析与格式化；状态与 hooks 内聚在 TeamManager（one owner）。
// 见 specs/agent-teams-v1.md §4。
// ============================================================

import {
  CoreErrorType,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TaskCreateInputJsonSchema,
  TaskCreateInputSchema,
  TaskGetInputJsonSchema,
  TaskGetInputSchema,
  TaskListInputJsonSchema,
  TaskListInputSchema,
  TaskToolOutputSchema,
  TaskUpdateInputJsonSchema,
  TaskUpdateInputSchema,
  createCoreError,
  type TaskCreateInput,
  type TaskGetInput,
  type TaskListInput,
  type TaskUpdateInput,
  type TeamTask,
  type ToolPermissionPatternSource,
} from "@zcode/contracts";
import {
  TASK_CREATE_PROVIDER_DESCRIPTION,
  TASK_GET_PROVIDER_DESCRIPTION,
  TASK_LIST_PROVIDER_DESCRIPTION,
  TASK_UPDATE_PROVIDER_DESCRIPTION,
} from "../../agent/teams/prompts.js";
import type { TeamManager } from "../../agent/teams/team-manager.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TASK_TOOL_MODEL_BYTES = 16_384;

function requireTeamManager(
  context: Parameters<ToolHandler>[1],
  toolName: string,
): TeamManager {
  if (!context.teamManager) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Agent teams are not enabled for this session (features.agentTeams)",
      { context: { toolCallId: context.toolCallId, toolName }, recoverable: false },
    );
  }
  return context.teamManager;
}

const taskCreateHandler: ToolHandler = async (input, context) => {
  const parsed = TaskCreateInputSchema.parse(input) as TaskCreateInput;
  const manager = requireTeamManager(context, TASK_CREATE_TOOL_NAME);
  const actor = await manager.resolveActorName(context.sessionId);
  const task = await manager.createTask(parsed, actor);
  return {
    success: true,
    message: `Created task #${task.id}: ${task.subject}`,
    taskId: task.id,
    task: taskToPlain(task),
  };
};

const taskGetHandler: ToolHandler = async (input, context) => {
  const parsed = TaskGetInputSchema.parse(input) as TaskGetInput;
  const manager = requireTeamManager(context, TASK_GET_TOOL_NAME);
  const task = await manager.getTask(parsed.taskId);
  if (!task) {
    return { success: false, message: `Task #${parsed.taskId} not found.` };
  }
  return { success: true, message: `Task #${task.id}`, taskId: task.id, task: taskToPlain(task) };
};

const taskListHandler: ToolHandler = async (input, context) => {
  const parsed = TaskListInputSchema.parse(input) as TaskListInput;
  const manager = requireTeamManager(context, TASK_LIST_TOOL_NAME);
  const tasks = await manager.listTasks();
  const filtered = parsed.status ? tasks.filter((task) => task.status === parsed.status) : tasks;
  if (filtered.length === 0) {
    return { success: true, message: "No tasks on the board." };
  }
  return {
    success: true,
    message: filtered.map(formatTaskLine).join("\n"),
    tasks: filtered.map(taskToPlain),
  };
};

const taskUpdateHandler: ToolHandler = async (input, context) => {
  const parsed = TaskUpdateInputSchema.parse(input) as TaskUpdateInput;
  const manager = requireTeamManager(context, TASK_UPDATE_TOOL_NAME);
  const actor = await manager.resolveActorName(context.sessionId);
  const { status, subject, description, activeForm, owner, metadata, addBlocks, addBlockedBy } =
    parsed;
  const result = await manager.updateTask(
    parsed.taskId,
    {
      ...(status !== undefined ? { status } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(activeForm !== undefined ? { activeForm } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(addBlocks !== undefined ? { addBlocks } : {}),
      ...(addBlockedBy !== undefined ? { addBlockedBy } : {}),
    },
    actor,
  );
  if (result.result === "not_found") {
    return { success: false, message: `Task #${parsed.taskId} not found.` };
  }
  // 手动认领三拒（与自驱 claim 同构）：给出可恢复的下一步引导，模型据此
  // TaskList 换下一个任务，而不是反复重试同一认领。三个拒绝分支的 task 必在
  // （store 拒绝时返回读到的当前状态）。
  if (result.result === "already_claimed") {
    return {
      success: false,
      message: `Task #${parsed.taskId} is already claimed by ${result.task!.owner}. Call TaskList and pick a different task.`,
    };
  }
  if (result.result === "already_resolved") {
    return {
      success: false,
      message: `Task #${parsed.taskId} is already completed; there is nothing to claim. Call TaskList and pick a different task.`,
    };
  }
  if (result.result === "blocked") {
    return {
      success: false,
      message: `Task #${parsed.taskId} cannot start yet: it is blocked by incomplete tasks ${result.task!.blockedBy.join(", ")}.`,
    };
  }
  if (result.result === "blocked_by_hook") {
    return {
      success: false,
      message: `TaskCompleted hook blocked marking task #${parsed.taskId} as completed; it stays ${result.task?.status ?? "in_progress"}.`,
    };
  }
  if (status === "deleted") {
    return { success: true, message: `Deleted task #${parsed.taskId}.` };
  }
  return {
    success: true,
    // deleted 已提前返回；not_found / 三拒 / blocked_by_hook 也已提前返回，
    // 到这里的 updated 分支（非 deleted）task 必在。
    message: `Updated task #${parsed.taskId}: ${formatTaskLine(result.task!)}`,
    taskId: parsed.taskId,
    task: taskToPlain(result.task!),
  };
};

function taskToPlain(task: TeamTask): Record<string, unknown> {
  return { ...task };
}

function formatTaskLine(task: TeamTask): string {
  const deps =
    task.blockedBy.length > 0 ? ` blockedBy: ${task.blockedBy.join(",")}` : "";
  const blocks = task.blocks.length > 0 ? ` blocks: ${task.blocks.join(",")}` : "";
  const ownerText = task.owner ? ` owner=${task.owner}` : " unowned";
  return `#${task.id} [${task.status}]${ownerText}${deps}${blocks} ${task.subject}`;
}

const TASK_TOOL_BASE = {
  readOnly: false,
  destructive: false,
  concurrentSafe: true,
  sideEffectScope: "session" as const,
  riskLevel: "low" as const,
  needsApproval: false,
};

const TASK_TOOL_COMMON = {
  metadata: { ...TASK_TOOL_BASE, timeoutMs: 10_000, maxOutputBytes: MAX_TASK_TOOL_MODEL_BYTES },
  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      success: { type: "boolean" },
      message: { type: "string" },
      taskId: { type: "string" },
      task: { type: "object" },
      tasks: { type: "array", items: { type: "object" } },
    },
    required: ["success", "message"],
    additionalProperties: false,
  },
  runtimeOutputSchema: TaskToolOutputSchema,
  permission: {
    permission: "team.task",
    reason: "Task board tools mutate the shared team task files",
    riskLevel: "low" as const,
    sideEffectScope: "session" as const,
    needsApproval: false,
    patternSources: ["toolName"] as ToolPermissionPatternSource[],
    alwaysAllowPatternSources: ["toolName"] as ToolPermissionPatternSource[],
    denyPriority: "beforeAsk" as const,
  },
  resultBudget: {
    maxInlineBytes: MAX_TASK_TOOL_MODEL_BYTES,
    maxModelBytes: MAX_TASK_TOOL_MODEL_BYTES,
    strategy: "truncate" as const,
    preview: { maxBytes: MAX_TASK_TOOL_MODEL_BYTES, direction: "head" as const },
  },
  timeout: { defaultMs: 10_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: { supported: true, cleanup: "none" as const },
  trace: {
    required: true as const,
    propagateToAdapters: true,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
  },
};

export const taskCreateToolEntry: ToolEntry = {
  ...TASK_TOOL_COMMON,
  capability: "Create a task on the shared team task board",
  metadata: {
    ...TASK_TOOL_COMMON.metadata,
    name: TASK_CREATE_TOOL_NAME,
    description: TASK_CREATE_PROVIDER_DESCRIPTION,
  },
  handler: taskCreateHandler,
  formatModelContent: (output: unknown) => String((output as { message?: string }).message ?? ""),
  inputSchema: TaskCreateInputJsonSchema,
  runtimeInputSchema: TaskCreateInputSchema,
  cancellation: {
    ...TASK_TOOL_COMMON.cancellation,
    userVisibleMessage: "TaskCreate was cancelled before the task was written",
  },
};

export const taskGetToolEntry: ToolEntry = {
  ...TASK_TOOL_COMMON,
  capability: "Get one task from the shared team task board",
  metadata: {
    ...TASK_TOOL_COMMON.metadata,
    name: TASK_GET_TOOL_NAME,
    description: TASK_GET_PROVIDER_DESCRIPTION,
  },
  handler: taskGetHandler,
  formatModelContent: (output: unknown) => String((output as { message?: string }).message ?? ""),
  inputSchema: TaskGetInputJsonSchema,
  runtimeInputSchema: TaskGetInputSchema,
  cancellation: {
    ...TASK_TOOL_COMMON.cancellation,
    userVisibleMessage: "TaskGet was cancelled before the task was read",
  },
};

export const taskListToolEntry: ToolEntry = {
  ...TASK_TOOL_COMMON,
  capability: "List tasks on the shared team task board",
  metadata: {
    ...TASK_TOOL_COMMON.metadata,
    name: TASK_LIST_TOOL_NAME,
    description: TASK_LIST_PROVIDER_DESCRIPTION,
  },
  handler: taskListHandler,
  formatModelContent: (output: unknown) => String((output as { message?: string }).message ?? ""),
  inputSchema: TaskListInputJsonSchema,
  runtimeInputSchema: TaskListInputSchema,
  cancellation: {
    ...TASK_TOOL_COMMON.cancellation,
    userVisibleMessage: "TaskList was cancelled before the board was read",
  },
};

export const taskUpdateToolEntry: ToolEntry = {
  ...TASK_TOOL_COMMON,
  capability: "Update or claim a task on the shared team task board",
  metadata: {
    ...TASK_TOOL_COMMON.metadata,
    name: TASK_UPDATE_TOOL_NAME,
    description: TASK_UPDATE_PROVIDER_DESCRIPTION,
  },
  handler: taskUpdateHandler,
  formatModelContent: (output: unknown) => String((output as { message?: string }).message ?? ""),
  inputSchema: TaskUpdateInputJsonSchema,
  runtimeInputSchema: TaskUpdateInputSchema,
  cancellation: {
    ...TASK_TOOL_COMMON.cancellation,
    userVisibleMessage: "TaskUpdate was cancelled before the task was updated",
  },
};
