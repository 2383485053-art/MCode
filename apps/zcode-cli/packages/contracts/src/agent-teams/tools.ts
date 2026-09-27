// ============================================================
// Agent Teams v1 - 任务板四件套工具 schema（Claude Code 范式）
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "../tools/json-schema.js";

export const TASK_CREATE_TOOL_NAME = "TaskCreate";
export const TASK_GET_TOOL_NAME = "TaskGet";
export const TASK_LIST_TOOL_NAME = "TaskList";
export const TASK_UPDATE_TOOL_NAME = "TaskUpdate";

export const TaskCreateInputSchema = z
  .object({
    subject: z.string().min(1).max(500).describe("Brief task title"),
    description: z.string().min(1).describe("What needs to be done; context and requirements"),
    activeForm: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Present progress tense shown while in_progress (e.g. 'Running tests')"),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;
export const TaskCreateInputJsonSchema = toToolJsonSchema(TaskCreateInputSchema);

export const TaskGetInputSchema = z
  .object({
    taskId: z.string().regex(/^\d+$/).describe("Numeric task ID"),
  })
  .strict();
export type TaskGetInput = z.infer<typeof TaskGetInputSchema>;
export const TaskGetInputJsonSchema = toToolJsonSchema(TaskGetInputSchema);

export const TaskListInputSchema = z
  .object({
    status: z.enum(["pending", "in_progress", "completed"]).optional(),
  })
  .strict();
export type TaskListInput = z.infer<typeof TaskListInputSchema>;
export const TaskListInputJsonSchema = toToolJsonSchema(TaskListInputSchema);

export const TaskUpdateInputSchema = z
  .object({
    taskId: z.string().regex(/^\d+$/).describe("Numeric task ID"),
    status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
    subject: z.string().min(1).max(500).optional(),
    description: z.string().min(1).optional(),
    activeForm: z.string().min(1).max(200).optional(),
    owner: z.string().min(1).optional().describe("Task owner (agent name)"),
    metadata: z.record(z.string(), z.unknown()).optional(),
    addBlocks: z.array(z.string().regex(/^\d+$/)).optional(),
    addBlockedBy: z.array(z.string().regex(/^\d+$/)).optional(),
  })
  .strict();
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;
export const TaskUpdateInputJsonSchema = toToolJsonSchema(TaskUpdateInputSchema);

// 输出统一为宽松对象（成功 message + 任务投影），模型内容由 handler 格式化。
export const TaskToolOutputSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
    taskId: z.string().optional(),
    task: z.unknown().optional(),
    tasks: z.array(z.unknown()).optional(),
  })
  .strict();
export type TaskToolOutput = z.infer<typeof TaskToolOutputSchema>;
