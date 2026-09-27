// ============================================================
// Agent Teams v1 - 共享类型与常量（Claude Code 范式，仅 in-process）
// 见 specs/agent-teams-v1.md
// ============================================================

import { z } from "zod";

/** lead 是主对话本身，收件名固定；team 目录名 = lead sessionId。 */
export const TEAM_LEAD_NAME = "team-lead";

/** 成员名字规则：照 CC。禁 agentId 形状（agent_ 前缀）在运行时另行校验。 */
export const TEAM_AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const TEAM_AGENT_ID_PREFIX = "agent_";

/**
 * Windows 保留设备名（con/prn/aux/nul/com1-9/lpt1-9，任意大小写）：
 * 这些名字做不了文件名——inbox 是 inboxes/<name>.json，设备名文件在
 * Windows 上创建即失败，成员会以「信箱写不进」的形式静默失联，必须在
 * 名字校验处直接拒绝。`(?:\.|$)` 锚定：con 和 con.txt 都是设备名，
 * console、con-x 是普通名字不误伤。
 */
export const WINDOWS_DEVICE_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export const isReservedTeamAgentName = (name: string): boolean =>
  name.toLowerCase() === TEAM_LEAD_NAME ||
  // CC 4548 保留名集合：main/team-lead/user/system 任意拼写 + agentId 形状。
  // user/system 用于身份信封，成员冒充这两个名字等于伪造注入来源。
  ["main", "user", "system"].includes(name.toLowerCase()) ||
  name.startsWith(TEAM_AGENT_ID_PREFIX) ||
  // Windows 设备名不能做 inbox 文件名（见上方常量注释）。
  WINDOWS_DEVICE_NAME_PATTERN.test(name);

// ------------------------------------------------------------
// Mailbox 帧（~/.zcode/teams/<sessionId>/inboxes/<name>.json，数组式）
// ------------------------------------------------------------

const mailboxFrameBase = {
  msgV: z.literal(1),
  msg_id: z.string().min(1),
  from: z.string().min(1),
  text: z.string(),
  timestamp: z.string().min(1),
  read: z.boolean().optional(),
};

export const TeamMailboxMessageFrameSchema = z.object({
  ...mailboxFrameBase,
  type: z.literal("message"),
  summary: z.string().optional(),
});

export const TeamMailboxIdleFrameSchema = z.object({
  ...mailboxFrameBase,
  type: z.literal("idle_notification"),
  idleReason: z.enum(["available", "interrupted", "failed"]).optional(),
  completedTaskId: z.string().optional(),
  failureReason: z.string().optional(),
  result: z.string().optional(),
});

export const TeamMailboxFrameSchema = z.union([
  TeamMailboxMessageFrameSchema,
  TeamMailboxIdleFrameSchema,
]);

export type TeamMailboxMessageFrame = z.infer<typeof TeamMailboxMessageFrameSchema>;
export type TeamMailboxIdleFrame = z.infer<typeof TeamMailboxIdleFrameSchema>;
export type TeamMailboxFrame = z.infer<typeof TeamMailboxFrameSchema>;

// ------------------------------------------------------------
// 任务板（~/.zcode/tasks/<sessionId>/<id>.json）
// ------------------------------------------------------------

export const TeamTaskStatus = {
  Pending: "pending",
  InProgress: "in_progress",
  Completed: "completed",
} as const;
export type TeamTaskStatus = (typeof TeamTaskStatus)[keyof typeof TeamTaskStatus];

export const TeamTaskSchema = z.object({
  id: z.string().regex(/^\d+$/),
  subject: z.string().min(1),
  description: z.string(),
  activeForm: z.string().optional(),
  owner: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]),
  blocks: z.array(z.string().regex(/^\d+$/)),
  blockedBy: z.array(z.string().regex(/^\d+$/)),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type TeamTask = z.infer<typeof TeamTaskSchema>;

/** 认领/续跑结论，工具与成员循环共用。 */
export const TeamTaskClaimResult = {
  Claimed: "claimed",
  AlreadyClaimed: "already_claimed",
  AlreadyResolved: "already_resolved",
  Blocked: "blocked",
  AgentBusy: "agent_busy",
  NotFound: "not_found",
} as const;
export type TeamTaskClaimResult = (typeof TeamTaskClaimResult)[keyof typeof TeamTaskClaimResult];

// ------------------------------------------------------------
// 花名册（~/.zcode/teams/<sessionId>/config.json）
// ------------------------------------------------------------

export const TeamRosterMemberSchema = z.object({
  name: z.string().min(1),
  agentId: z.string().min(1),
  agentType: z.string(),
  description: z.string(),
  joinedAt: z.string().min(1),
});
export type TeamRosterMember = z.infer<typeof TeamRosterMemberSchema>;

export const TeamConfigSchema = z.object({
  teamV: z.literal(1),
  teamId: z.string().min(1),
  leadSessionId: z.string().min(1),
  createdAt: z.string().min(1),
  members: z.array(TeamRosterMemberSchema),
});
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

/** 成员名字规范化结论：最终名（可能带 -2/-3 后缀）。 */
export function resolveDuplicateTeamAgentName(
  requested: string,
  existingNames: readonly string[],
): string {
  const taken = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!taken.has(requested.toLowerCase())) return requested;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${requested}-${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
