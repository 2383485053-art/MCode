// ============================================================
// Agent Teams v1 - mailbox 文件层（Claude Code 范式）
// ~/.zcode/teams/<sessionId>/inboxes/<name>.json 是数组式信箱：
// 写入 = 锁内读-合并-原子写；消费 = 锁内重写只留未投递条目（消费即删）。
// 投递失败不删（readUnread/markDelivered 两步制），下轮重试防丢。
// 见 specs/agent-teams-v1.md §1.3。
// ============================================================

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  TEAM_LEAD_NAME,
  TeamMailboxFrameSchema,
  type TeamMailboxFrame,
  type TeamMailboxIdleFrame,
  type TeamMailboxMessageFrame,
} from "@zcode/contracts";
import { atomicWriteJson, withDirectoryLock } from "./lockfile.js";

export interface MailboxStoreOptions {
  teamsDir: string;
  teamId: string;
}

export class TeamMailboxStore {
  constructor(private readonly options: MailboxStoreOptions) {}

  private inboxPath(name: string): string {
    return join(this.options.teamsDir, this.options.teamId, "inboxes", `${name}.json`);
  }

  private lockPath(name: string): string {
    return `${this.inboxPath(name)}.lock`;
  }

  /** 追加一帧（message / idle_notification）。文件或目录不存在则幂等创建。 */
  async append(name: string, frame: TeamMailboxFrame): Promise<void> {
    await withDirectoryLock(this.lockPath(name), async () => {
      const existing = await this.readRaw(name);
      await atomicWriteJson(this.inboxPath(name), [...existing, frame]);
    });
  }

  /** 便捷构造：普通消息帧。 */
  async sendMessage(from: string, to: string, text: string, summary?: string): Promise<void> {
    const frame: TeamMailboxMessageFrame = {
      msgV: 1,
      msg_id: `teammsg_${crypto.randomUUID()}`,
      type: "message",
      from,
      text,
      timestamp: new Date().toISOString(),
      summary,
    };
    await this.append(to, frame);
  }

  /** 便捷构造：idle 通知帧（成员 turn 终态 → lead 信箱）。 */
  async sendIdleNotification(
    from: string,
    idle: Omit<TeamMailboxIdleFrame, "msgV" | "msg_id" | "type" | "from" | "timestamp">,
  ): Promise<void> {
    const frame: TeamMailboxIdleFrame = {
      msgV: 1,
      msg_id: `teammsg_${crypto.randomUUID()}`,
      type: "idle_notification",
      from,
      text: idle.text ?? "",
      timestamp: new Date().toISOString(),
      ...(idle.idleReason !== undefined ? { idleReason: idle.idleReason } : {}),
      ...(idle.completedTaskId !== undefined ? { completedTaskId: idle.completedTaskId } : {}),
      ...(idle.failureReason !== undefined ? { failureReason: idle.failureReason } : {}),
      ...(idle.result !== undefined ? { result: idle.result } : {}),
    };
    await this.append(TEAM_LEAD_NAME, frame);
  }

  /** 读未投递帧（不改文件）。schema 非法的条目就地忽略（CC pruneInvalid 的读侧等价物）。 */
  async readUnread(name: string): Promise<TeamMailboxFrame[]> {
    const frames = await this.readRaw(name);
    return frames.filter((frame) => frame.read !== true);
  }

  /** 投递成功后消费：从文件删除这些帧（消费即删）。 */
  async markDelivered(name: string, delivered: readonly TeamMailboxFrame[]): Promise<void> {
    if (delivered.length === 0) return;
    // 修复：用唯一的 msg_id 定位（readRaw 已过滤 schema，msg_id 必在且唯一）。
    // 此前用 from|timestamp|text 组合键，同一发送者同毫秒同文本的两帧会被一并误删。
    const deliveredIds = new Set(delivered.map((frame) => frame.msg_id));
    await withDirectoryLock(this.lockPath(name), async () => {
      const frames = await this.readRaw(name);
      const remaining = frames.filter((frame) => !deliveredIds.has(frame.msg_id));
      if (remaining.length === frames.length) return;
      await atomicWriteJson(this.inboxPath(name), remaining);
    });
  }

  async removeInbox(name: string): Promise<void> {
    await rm(this.inboxPath(name), { force: true }).catch(() => undefined);
  }

  private async readRaw(name: string): Promise<TeamMailboxFrame[]> {
    let raw: string;
    try {
      raw = await readFile(this.inboxPath(name), "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const result = TeamMailboxFrameSchema.safeParse(entry);
      return result.success ? [result.data] : [];
    });
  }
}
