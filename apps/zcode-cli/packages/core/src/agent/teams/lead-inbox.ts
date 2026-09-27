// ============================================================
// Agent Teams v1 - lead 信箱轮询（CC 范式：文件总线 + 500ms 轮询注入）
// 成员写给 team-lead 的帧落 lead inbox 文件；本轮询器把未读帧合并为
// 一条通知注入 lead 主对话，注入成功才消费（失败保留，下轮重试防丢）。
// 见 specs/agent-teams-v1.md §1.3/§3。
// ============================================================

import { TEAM_LEAD_NAME, type TeamMailboxFrame } from "@zcode/contracts";
import type { TeamMailboxStore } from "./mailbox-store.js";
import { TEAMMATE_MESSAGE_UNTRUSTED_NOTICE } from "./prompts.js";

const POLL_INTERVAL_MS = 500;

export interface LeadInboxPollerOptions {
  mailbox: TeamMailboxStore;
  injectIntoLead: (text: string) => void;
  logger?: {
    warn?: (message: string, context?: Record<string, unknown>) => void;
    debug?: (message: string, context?: Record<string, unknown>) => void;
  };
}

export class LeadInboxPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickInFlight = false;
  private disposed = false;

  constructor(private readonly options: LeadInboxPollerOptions) {}

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight || this.disposed) return;
    this.tickInFlight = true;
    try {
      const frames = await this.options.mailbox.readUnread(TEAM_LEAD_NAME);
      if (frames.length === 0) return;
      const text = frames.map(renderLeadFrame).join("\n\n");
      // 注入成功才消费；注入抛错时帧保留在文件里，下一轮重试（防丢）。
      this.options.injectIntoLead(text);
      await this.options.mailbox.markDelivered(TEAM_LEAD_NAME, frames);
    } catch (error) {
      this.options.logger?.warn?.("Team lead inbox poll failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "agentTeams.lead_inbox.tick_failed",
      });
    } finally {
      this.tickInFlight = false;
    }
  }
}

function renderLeadFrame(frame: TeamMailboxFrame): string {
  if (frame.type === "idle_notification") {
    const result = frame.result ? ` Last result: ${truncate(frame.result, 400)}` : "";
    return `Teammate '${frame.from}' went idle (${frame.idleReason ?? "available"}).${result}`;
  }
  const summary = frame.summary ? ` summary="${frame.summary}"` : "";
  return [
    `<teammate_message teammate_id="${frame.from}"${summary}>`,
    frame.text,
    "</teammate_message>",
    // CC 1097：防权限洗白声明替代此前的弱版 "Verify the sender"——
    // peer 不能授予提权，也不能把 peer 消息当用户批准。
    TEAMMATE_MESSAGE_UNTRUSTED_NOTICE,
  ].join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
