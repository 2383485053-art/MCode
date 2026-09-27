// ============================================================
// Agent Teams v1 - TeamManager（lead 进程内的唯一编排者）
// 职责：具名成员注册（latest wins）、SendMessage 按名路由、成员自驱循环
// （turn 终态 → idle 通知 → 邮箱/任务板驱动 resume）、任务板端口
// （含 TaskCreated/TaskCompleted/TeammateIdle hooks）、teardown。
// 文件层状态的所有者分别是三个 store；本类只编排，不复制状态。
// 见 specs/agent-teams-v1.md §2/§3。
// ============================================================

import {
  CollaborationMode,
  HookEventName,
  resolveDuplicateTeamAgentName,
  TEAM_AGENT_NAME_PATTERN,
  TEAM_LEAD_NAME,
  isReservedTeamAgentName,
  type AgentOutput,
  type SessionId,
  type SubagentLaunchRequest,
  type SubagentLaunchOptions,
  type SubagentPort,
  type SubagentSendMessageRequest,
  type SubagentSendMessageResult,
  type TeamMailboxMessageFrame,
  type TeamRosterMember,
  type TeamTask,
  type TraceContext,
  type TraceId,
} from "@zcode/contracts";
import type { HookRunner } from "../../hooks/types.js";
import { isTerminalRuntimeTask, type RuntimeTaskRegistry } from "../../runtime-task/registry.js";
import { LeadInboxPoller } from "./lead-inbox.js";
import {
  buildSelfDrivePrompt,
  buildTeammateIdentityPrompt,
  escapeEnvelopeTags,
  TEAMMATE_COMMUNICATION_PROMPT,
  TEAMMATE_MESSAGE_UNTRUSTED_NOTICE,
  TEAMMATE_WORKFLOW_PROMPT,
} from "./prompts.js";
import { TeamMailboxStore } from "./mailbox-store.js";
import { TeamTaskBoardStore, type CreateTaskInput, type UpdateTaskInput } from "./task-board-store.js";
import { TeamStore } from "./team-store.js";
import { emitTasksChanged, onTasksChanged } from "./teams-events.js";

/** 自驱认领重试上限（防意外活锁；正常路径每轮 findNext 都会排除致拒任务，远达不到上限）。 */
const SELF_DRIVE_MAX_CLAIM_ATTEMPTS = 8;

/** TeammateIdle hook block 的单成员续跑上限（防恒 block 死循环）。 */
const IDLE_BLOCK_MAX_RESUMES = 3;

export interface TeamManagerOptions {
  /**
   * lead：主对话侧（全量编排：具名注册/自驱循环/轮询/teardown）。
   * member：teammate 子运行时侧（只挂任务板工具 + mailbox 消息路由，
   * 与 CC 一致——成员互发消息走文件，不依赖 lead 进程的 registry）。
   */
  role: "lead" | "member";
  /** team 目录键：lead 用自己的 sessionId，member 用 parentSessionId。 */
  leadSessionId: SessionId;
  /** member 角色的登记名（handleSend 的 from / 任务板 actor）。 */
  memberAgentName?: string;
  /** member 角色的 agentId（resume 后 config 通道可能缺失，用 roster 文件反查兜底）。 */
  memberAgentId?: string;
  storageDir: string;
  registry: RuntimeTaskRegistry;
  subagentPort: SubagentPort;
  injectIntoLead: (text: string, traceContext?: TraceContext) => void;
  cwd: string;
  mode: CollaborationMode;
  getTraceId: () => TraceId;
  getHookRunner?: () => HookRunner | undefined;
  logger?: {
    debug?: (message: string, context?: Record<string, unknown>) => void;
    info?: (message: string, context?: Record<string, unknown>) => void;
    warn?: (message: string, context?: Record<string, unknown>) => void;
  };
}

interface WatchedMember {
  name: string;
  agentId: string;
  spawnRequest: SubagentLaunchRequest;
}

export class TeamManager {
  private readonly mailbox: TeamMailboxStore;
  private readonly board: TeamTaskBoardStore;
  private readonly store: TeamStore;
  private readonly poller: LeadInboxPoller;
  private readonly watched = new Map<string, WatchedMember>();
  /** watch 循环代数：terminal 唤醒后只允许最新代处理，防止双循环双投递。 */
  private readonly watchGeneration = new Map<string, number>();
  /** TeammateIdle hook block 的已用续跑次数（按 agentId；认领成功即清零）。 */
  private readonly idleBlockCounts = new Map<string, number>();
  private pollerStarted = false;
  private disposed = false;
  /**
   * tasks_changed 订阅退订句柄（仅 lead 角色）：member 侧实例建任务时
   * 经模块级事件广播到 lead 侧唤醒 idle 成员；dispose 退订防泄漏。
   */
  private readonly unsubscribeTasksChanged: (() => void) | undefined;

  constructor(private readonly options: TeamManagerOptions) {
    const teamId = options.leadSessionId;
    this.store = new TeamStore({ teamsDir: `${options.storageDir}/teams`, teamId, leadSessionId: teamId });
    this.mailbox = new TeamMailboxStore({ teamsDir: `${options.storageDir}/teams`, teamId });
    this.board = new TeamTaskBoardStore({ tasksRootDir: `${options.storageDir}/tasks`, teamId });
    this.poller = new LeadInboxPoller({
      mailbox: this.mailbox,
      injectIntoLead: (text) => options.injectIntoLead(text),
      logger: options.logger,
    });
    if (options.role === "lead") {
      this.unsubscribeTasksChanged = onTasksChanged(() => this.wakeIdleMembers());
    }
  }

  /** poller 延迟到首个成员注册后启动：无 team 的会话不产生轮询开销。 */
  private ensurePollerStarted(): void {
    if (this.pollerStarted) return;
    this.pollerStarted = true;
    this.poller.start();
  }

  // ------------------------------------------------------------
  // launch 装饰：具名成员注册 + 身份提示词 + 自驱 watch
  // ------------------------------------------------------------

  async handleLaunch(
    request: SubagentLaunchRequest,
    options: SubagentLaunchOptions | undefined,
    inner: (request: SubagentLaunchRequest, options?: SubagentLaunchOptions) => Promise<AgentOutput>,
  ): Promise<AgentOutput> {
    if (this.options.role === "member") {
      if (request.agentName !== undefined) {
        throw new Error("Only the team lead can spawn teammates.");
      }
      return inner(request, options);
    }
    if (this.disposed) {
      throw new Error("Agent teams manager is disposed; cannot spawn teammate.");
    }
    if (request.agentName === undefined) {
      return inner(request, options);
    }
    const requestedName = request.agentName;
    if (!TEAM_AGENT_NAME_PATTERN.test(requestedName) || isReservedTeamAgentName(requestedName)) {
      throw new Error(
        `Invalid teammate name '${requestedName}': use ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ and avoid 'team-lead'/'main'/'user'/'system'/agent_ ids and Windows device names (con/nul/com1...).`,
      );
    }
    await this.store.ensureTeam();
    const members = await this.store.listMembers();
    const finalName = resolveDuplicateTeamAgentName(requestedName, members.map((m) => m.name));

    const identityPrompt = buildTeammateIdentityPrompt({
      agentName: finalName,
      teamConfigPath: this.store.configPath,
      tasksDir: `${this.options.storageDir}/tasks/${this.options.leadSessionId}`,
    });
    const decorated: SubagentLaunchRequest = {
      ...request,
      description: `[teammate:${finalName}] ${request.description}`,
      prompt: [identityPrompt, TEAMMATE_COMMUNICATION_PROMPT, TEAMMATE_WORKFLOW_PROMPT, request.prompt]
        .filter((part) => part.trim().length > 0)
        .join("\n\n"),
    };
    const output = await inner(decorated, options);
    if (typeof output?.agentId !== "string") {
      throw new Error(`Teammate launch returned no agentId for '${finalName}'.`);
    }
    // launch 返回后注册（agentId 由 runner 内部生成）。前台 launch 此时已 terminal，
    // watch 循环会立即进入终态处理 → 自驱。
    await this.registerMember(finalName, output.agentId, request);
    await this.mailbox.sendMessage(
      TEAM_LEAD_NAME,
      finalName,
      decorated.prompt,
      "initial prompt (audit copy)",
    );
    this.options.logger?.info?.("Teammate registered", {
      event: "agentTeams.teammate_registered",
      teammate: finalName,
      agentId: output.agentId,
    });
    return { ...output, agentName: finalName };
  }

  private async registerMember(
    name: string,
    agentId: string,
    spawnRequest: SubagentLaunchRequest,
  ): Promise<void> {
    const member: TeamRosterMember = {
      name,
      agentId,
      agentType: spawnRequest.agentType,
      description: spawnRequest.description,
      joinedAt: new Date().toISOString(),
    };
    await this.store.upsertMember(member);
    this.watched.set(agentId, { name, agentId, spawnRequest });
    this.ensurePollerStarted();
    void this.runWatchLoop(agentId).catch((error) => {
      this.options.logger?.warn?.("Teammate watch loop crashed", {
        event: "agentTeams.watch_loop.crashed",
        teammate: name,
        agentId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // ------------------------------------------------------------
  // 成员自驱循环（CC in-process runner 语义）
  // ------------------------------------------------------------

  private async runWatchLoop(agentId: string): Promise<void> {
    const generation = (this.watchGeneration.get(agentId) ?? 0) + 1;
    this.watchGeneration.set(agentId, generation);
    for (;;) {
      if (this.disposed) return;
      const member = this.watched.get(agentId);
      if (!member) return;
      if (this.watchGeneration.get(agentId) !== generation) return;
      let task = this.options.registry.get(agentId);
      if (!task) return;
      if (!isTerminalRuntimeTask(task)) {
        await this.options.registry.waitForTerminal(agentId);
        if (this.disposed) return;
        if (this.watchGeneration.get(agentId) !== generation) return;
        task = this.options.registry.get(agentId);
        if (!task || !isTerminalRuntimeTask(task)) continue;
      }
      const resumed = await this.onMemberTerminal(member, task.status, task.output as unknown);
      if (!resumed) return; // idle：watch 结束，外部 SendMessage 唤醒后开新代循环
    }
  }

  private async onMemberTerminal(
    member: WatchedMember,
    status: string,
    output: unknown,
  ): Promise<boolean> {
    this.pendingTerminalWork += 1;
    try {
      return await this.onMemberTerminalInner(member, status, output);
    } finally {
      this.pendingTerminalWork -= 1;
    }
  }

  private async onMemberTerminalInner(
    member: WatchedMember,
    status: string,
    output: unknown,
  ): Promise<boolean> {
    const idleReason =
      status === "failed"
        ? ("failed" as const)
        : status === "cancelled" || status === "stopped" || status === "killed"
          ? ("interrupted" as const)
          : ("available" as const);
    const resultText = extractOutputText(output);
    await this.mailbox.sendIdleNotification(member.name, {
      idleReason,
      ...(resultText ? { result: resultText.slice(0, 500) } : {}),
      text: `Teammate '${member.name}' finished a turn (${status}).`,
    });

    // 1) 邮箱有未读消息 → 消息作为续跑 prompt。
    const unread = await this.mailbox.readUnread(member.name);
    const messageFrames = unread.filter(
      (frame): frame is TeamMailboxMessageFrame => frame.type === "message",
    );
    if (messageFrames.length > 0) {
      // CC 1097：成员收消息同样带防洗白声明——兄弟成员是半信任主体，
      // 注入文本可能携带嵌入指令，与 lead 侧 renderLeadFrame 同构。
      // 正文做信封定界符转义（specs/agent-teams-v1.md §1.3）：不转义则
      // 发送方可在正文里闭合信封再伪造 teammate_id 假信封冒充他人。
      const prompt = messageFrames
        .map((frame) =>
          [
            `<teammate_message teammate_id="${frame.from}">`,
            escapeEnvelopeTags(frame.text),
            "</teammate_message>",
            TEAMMATE_MESSAGE_UNTRUSTED_NOTICE,
          ].join("\n"),
        )
        .join("\n\n");
      const resumed = await this.resumeMember(member, "mailbox delivery", prompt);
      if (resumed) {
        await this.mailbox.markDelivered(member.name, unread);
        return true;
      }
      // resume 失败：帧保留在邮箱（未 markDelivered），下次唤醒重投。
      return false;
    }

    // 2) 无消息 → 任务板找活（最低 ID 优先），认领后自驱。
    // 修复：claim 被竞争性拒绝（他人抢先/任务已完成/被阻塞）时不能直接 idle——
    // 若这是唯一醒着的成员，settle 会放行并 teardown 掉仍有 pending 任务的板
    //（CC 语义：claim 被拒就找下一个）。每轮重试 findNext 都会排除致拒任务
    //（already_claimed ⇒ owner 有值、already_resolved ⇒ completed、blocked ⇒
    // 依赖不满足），所以循环必然收敛；上限只是防意外活锁的保险。
    // agent_busy 与具体任务无关（自己名下已有未完成任务），重试无意义，直接 idle。
    for (let attempt = 0; attempt < SELF_DRIVE_MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const next = await this.board.findNextClaimableTask();
      if (!next) break;
      const claim = await this.board.claimTask(next.id, member.name);
      if (claim.result === "agent_busy") break;
      if (claim.result !== "claimed") continue;
      // 认领成功说明成员做了实事：重置 idle-block 额度，CC 3911 的 block
      // 本意是拦「该干活的闲置」，不是罚连续干活的成员。
      this.idleBlockCounts.delete(member.agentId);
      const resumed = await this.resumeMember(
        member,
        `self-drive task #${next.id}`,
        buildSelfDrivePrompt(next.id),
      );
      if (resumed) return true;
      // resume 失败：释放认领，任务回池。
      await this.board.releaseTasksOwnedBy(member.name);
      return false;
    }
    // 无可做 → TeammateIdle hook 是最后一道闸（CC 3911：block → 拒绝闲置，
    // 反馈注入成员续跑）。hook 位置必须在「即将 idle 终态」处——mailbox 有
    // 未读或刚认领成功时成员并非 idle，触发 hook 属误报。
    const idleHook = await this.emitTeammateIdleHook(member.name, idleReason);
    if (idleHook?.blockRequested && this.consumeIdleBlockAllowance(member)) {
      const feedback = idleHook.reason ? ` Hook feedback: ${idleHook.reason}` : "";
      const prompt = `A TeammateIdle hook blocked your idle transition — keep working.${feedback} Call TaskList to check for available tasks and read your mailbox for pending messages.`;
      if (await this.resumeMember(member, "idle blocked by hook", prompt)) {
        return true;
      }
    }
    return false; // 无可做：idle 终态
  }

  private async resumeMember(
    member: WatchedMember,
    reason: string,
    prompt: string,
  ): Promise<boolean> {
    if (!this.options.subagentPort.sendMessage) {
      this.options.logger?.warn?.("Teammate resume unavailable: subagent port has no sendMessage", {
        event: "agentTeams.resume_unavailable",
        teammate: member.name,
        agentId: member.agentId,
      });
      return false;
    }
    const base = member.spawnRequest;
    const result = await this.options.subagentPort.sendMessage({
      sessionId: this.options.leadSessionId,
      parentToolCallId: `team_loop_${member.agentId}`,
      to: member.agentId,
      summary: reason,
      message: prompt,
      workingDirectory: base.workingDirectory,
      workspaceRoot: base.workspaceRoot,
      trace: base.trace,
    });
    if (result.status !== "success") {
      this.options.logger?.warn?.("Teammate resume failed", {
        event: "agentTeams.resume_failed",
        teammate: member.name,
        agentId: member.agentId,
        reason,
        errorMessage: result.error ?? result.message,
      });
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------
  // sendMessage 装饰：按名路由
  // ------------------------------------------------------------

  async handleSend(
    request: SubagentSendMessageRequest,
    inner: (request: SubagentSendMessageRequest) => Promise<SubagentSendMessageResult>,
  ): Promise<SubagentSendMessageResult> {
    const from = await this.resolveSenderName(request.sessionId);
    const to = request.to;

    if (to === TEAM_LEAD_NAME) {
      if (from === TEAM_LEAD_NAME) {
        return sendFailure(request, "Cannot send to 'team-lead': you are the team lead.");
      }
      await this.mailbox.sendMessage(from, TEAM_LEAD_NAME, request.message, request.summary);
      return {
        status: "success",
        messageId: `teammsg_${crypto.randomUUID()}`,
        delivery: "queued",
        message: "Message queued for team-lead; it will be injected into their next turn.",
      };
    }

    // member 角色：兄弟成员不在本进程 registry，一律走 mailbox 文件
    // （与 CC 一致；收件方 idle 时由其 watch 循环 drain，busy 时 turn 结束后投递）。
    if (this.options.role === "member") {
      const known = await this.store.resolveAgentIdByName(to);
      if (known === undefined && !to.startsWith("agent_")) {
        return sendFailure(request, `Unknown teammate '${to}'.`);
      }
      if (known === undefined) {
        // agentId 直达（孙代理）走原端口。
        return inner({ ...request, to });
      }
      await this.mailbox.sendMessage(from, to, request.message, request.summary);
      return {
        status: "success",
        messageId: `teammsg_${crypto.randomUUID()}`,
        delivery: "queued",
        message: `Message queued for '${to}'; it will be delivered when they finish their current turn.`,
      };
    }

    const targetAgentId = (await this.store.resolveAgentIdByName(to)) ?? to;
    const known = this.options.registry.get(targetAgentId);
    if (!known) {
      return sendFailure(request, `Unknown teammate '${to}'. Spawn them with Agent agent_name first.`);
    }
    const result = await inner({ ...request, to: targetAgentId, sessionId: this.options.leadSessionId });
    if (result.status === "success") {
      if (result.delivery === "resumed_background") {
        // idle 成员被唤醒：重启其 watch 循环接管新的终态。
        void this.runWatchLoop(targetAgentId).catch(() => undefined);
      }
      return result;
    }
    // 投递失败降级：写收件人 mailbox 留痕，复活后由循环补投（文件总线兜底）。
    await this.mailbox.sendMessage(from, to, request.message, request.summary);
    return {
      ...result,
      message: `${result.message ?? result.error ?? "Delivery failed."} The message was kept in '${to}' mailbox and will be redelivered when they are revived.`,
    };
  }

  private memberNameCache: string | undefined;
  /** 终态处理进行中的成员数（idle 通知/邮箱投递/认领自驱）；>0 视为团队仍在工作。 */
  private pendingTerminalWork = 0;

  /**
   * settle 谓词（hasRunningBackgroundTasks 并集）：任一成员非 terminal，或任一
   * 成员的终态处理仍在进行（即将 resume 的窗口期），或任务板仍有未完成任务。
   * 任务板查询是异步文件读，这里用同步近似——自驱循环保证「有任务 ⇒ 成员终会
   * 被唤醒为 running」，所以只要成员全 idle 且无 pending 处理即可放行。
   */
  hasActiveTeammates(): boolean {
    if (this.disposed || this.options.role === "member") return false;
    if (this.pendingTerminalWork > 0) return true;
    for (const agentId of this.watched.keys()) {
      const task = this.options.registry.get(agentId);
      if (task && !isTerminalRuntimeTask(task)) return true;
    }
    return false;
  }

  /**
   * 任务板有新可做工作（新建/完成解锁/释放回池）时唤醒 idle 成员：对
   * watched 中已 terminal 的成员重启 watch 循环（循环体的终态处理会走
   * 认领分支）。缺这一步，全员 idle 时新建的任务无人认领，settle 放行
   * 会把仍有 pending 任务的板 teardown 掉——任务被静默扔掉
   * （specs/agent-teams-v1.md §1.5.e）。runWatchLoop 的换代机制保证
   * 重复唤醒不会产生双循环；running 成员跳过（其 watch 循环在，终态时
   * 自然认领）。
   */
  private wakeIdleMembers(): void {
    if (this.disposed || this.options.role === "member") return;
    for (const member of this.watched.values()) {
      const task = this.options.registry.get(member.agentId);
      if (!task || !isTerminalRuntimeTask(task)) continue;
      void this.runWatchLoop(member.agentId).catch(() => undefined);
    }
  }

  /**
   * member 名解析：优先 config 透传（spawn 路径），缺失时用 roster 文件反查
   * （resume 路径：sendMessage 构造的 resumeRequest 不携带 agentName，
   * 文件里的 name→agentId 是唯一事实源）。
   */
  private async resolveMemberName(): Promise<string | undefined> {
    if (this.memberNameCache) return this.memberNameCache;
    if (this.options.memberAgentName) {
      this.memberNameCache = this.options.memberAgentName;
      return this.memberNameCache;
    }
    if (!this.options.memberAgentId) return undefined;
    const roster = await this.store.listMembers();
    const match = roster.find((member) => member.agentId === this.options.memberAgentId);
    if (match) this.memberNameCache = match.name;
    return this.memberNameCache;
  }

  private async resolveSenderName(sessionId: string): Promise<string> {
    if (this.options.role === "member") {
      return (await this.resolveMemberName()) ?? sessionId;
    }
    if (sessionId === this.options.leadSessionId) return TEAM_LEAD_NAME;
    if (sessionId.startsWith("subagent_")) {
      const agentId = sessionId.slice("subagent_".length);
      const member = this.watched.get(agentId);
      if (member) return member.name;
      const roster = await this.store.listMembers();
      const match = roster.find((candidate) => candidate.agentId === agentId);
      if (match) return match.name;
    }
    return sessionId;
  }

  // ------------------------------------------------------------
  // 任务板端口（工具层入口；hooks 内聚在此）
  // ------------------------------------------------------------

  async createTask(input: CreateTaskInput, actor: string): Promise<TeamTask> {
    const task = await this.board.createTask({ ...input, createdBy: actor });
    const hook = await this.runHook({
      ...this.baseHookInput(),
      hookEventName: HookEventName.TaskCreated,
      taskDescription: task.description,
      taskId: task.id,
      taskSubject: task.subject,
      teammateName: actor,
    });
    if (hook?.blockRequested) {
      // CC 语义：blocking error 回滚删除任务。
      await this.board.updateTask(task.id, { status: "deleted" });
      throw new Error(
        `TaskCreated hook blocked creation of task #${task.id}; the task was rolled back.`,
      );
    }
    // 广播任务变更：唤醒 idle 成员认领（specs/agent-teams-v1.md §1.5.e）。
    // member 侧实例同样走到这里——emit 是模块级的，lead 侧监听收得到。
    emitTasksChanged("created");
    return task;
  }

  async updateTask(
    id: string,
    patch: UpdateTaskInput,
    actor: string,
  ): Promise<{
    result:
      | "updated"
      | "not_found"
      | "blocked_by_hook"
      | "already_claimed"
      | "already_resolved"
      | "blocked"
      | "delete_forbidden"
      | "dependency_cycle";
    /** deleted 路径不返回 task（文件已删，无真实快照可给）。 */
    task?: TeamTask;
    /** dependency_cycle 的环路径（起点在末尾重复出现，供展示）。 */
    cycle?: string[];
  }> {
    const current = await this.board.getTask(id);
    if (!current) return { result: "not_found" };
    if (patch.status === "completed" && current.status !== "completed") {
      const hook = await this.runHook({
        ...this.baseHookInput(),
        hookEventName: HookEventName.TaskCompleted,
        taskDescription: current.description,
        taskId: current.id,
        taskSubject: current.subject,
        teammateName: actor,
      });
      if (hook?.blockRequested) {
        return { result: "blocked_by_hook", task: current };
      }
    }
    const result = await this.board.updateTask(id, patch, actor);
    // 完成可能解锁下游任务（blockedBy 依赖此任务的）：广播唤醒 idle 成员。
    if (result.result === "updated" && patch.status === "completed") {
      emitTasksChanged("completed");
    }
    return result;
  }

  getTask(id: string): Promise<TeamTask | undefined> {
    return this.board.getTask(id);
  }

  listTasks(): Promise<TeamTask[]> {
    return this.board.listTasks();
  }

  /** 工具层用：把调用方 sessionId 解析成 team 身份名。 */
  resolveActorName(sessionId: string): Promise<string> {
    return this.resolveSenderName(sessionId);
  }

  // ------------------------------------------------------------
  // hooks
  // ------------------------------------------------------------

  private async emitTeammateIdleHook(
    teammateName: string,
    idleReason: "available" | "interrupted" | "failed",
  ): Promise<{ blockRequested?: boolean; reason?: string } | undefined> {
    const result = await this.runHook({
      ...this.baseHookInput(),
      hookEventName: HookEventName.TeammateIdle,
      idleReason,
      teammateName,
    });
    // runHook 已兜住 hook 执行异常（返回 undefined）；这里只透传 block 决定与反馈。
    if (!result) return undefined;
    return { blockRequested: result.blockRequested, reason: result.stopReason };
  }

  /**
   * TeammateIdle block 的续跑额度（每成员 IDLE_BLOCK_MAX_RESUMES 次）。
   * CC 3911 允许 hook 拒绝闲置让成员继续工作，但没有防恒 block 的上限——
   * hook 配置成永远 exit 2 会让成员永不停止地空转续跑。认领任务成功即重置。
   */
  private consumeIdleBlockAllowance(member: WatchedMember): boolean {
    const used = this.idleBlockCounts.get(member.agentId) ?? 0;
    if (used >= IDLE_BLOCK_MAX_RESUMES) {
      this.options.logger?.warn?.("TeammateIdle hook block ignored: resume limit reached", {
        event: "agentTeams.teammate_idle.block_limit",
        teammate: member.name,
        agentId: member.agentId,
      });
      return false;
    }
    this.idleBlockCounts.set(member.agentId, used + 1);
    return true;
  }

  private baseHookInput() {
    return {
      cwd: this.options.cwd,
      mode: this.options.mode,
      sessionId: this.options.leadSessionId,
      timestamp: new Date().toISOString(),
      traceId: this.options.getTraceId(),
    };
  }

  private async runHook(input: Parameters<HookRunner["run"]>[0]): Promise<
    { blockRequested?: boolean; stopReason?: string } | undefined
  > {
    const runner = this.options.getHookRunner?.();
    if (!runner) return undefined;
    try {
      const result = await runner.run(input);
      return { blockRequested: result.blockRequested, stopReason: result.stopReason };
    } catch (error) {
      this.options.logger?.warn?.("Agent teams hook failed", {
        event: "agentTeams.hook.failed",
        hookEventName: input.hookEventName,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // ------------------------------------------------------------
  // TaskStop 入口：停单个 teammate（CC 0175 KillTask 语义）
  // ------------------------------------------------------------

  /**
   * 按成员名或 agentId 停止单个 teammate：停进程、watch 循环退出、名下任务
   * 回池、idle 通知告知 lead。未命中返回 undefined（工具层回落到 background
   * task 路径）。只匹配 watched（本进程活成员）——roster 里不在 watched 的
   * 条目是陈旧残留，无可停止。
   */
  async stopTeammate(nameOrAgentId: string): Promise<{ name: string; agentId: string } | undefined> {
    if (this.options.role === "member" || this.disposed) return undefined;
    const member = [...this.watched.values()].find(
      (candidate) => candidate.agentId === nameOrAgentId || candidate.name === nameOrAgentId,
    );
    if (!member) return undefined;
    // 先摘除 watched 并换代：watch 循环醒来时查 watched 会直接退出，
    // 不会把刚停掉的成员经 onMemberTerminal 自驱复活。
    this.watched.delete(member.agentId);
    this.watchGeneration.set(member.agentId, (this.watchGeneration.get(member.agentId) ?? 0) + 1);
    await this.options.subagentPort.stopTask?.(member.agentId).catch(() => undefined);
    const released = await this.board.releaseTasksOwnedBy(member.name);
    if (released.length > 0) {
      // 被停成员的任务回池了：广播唤醒其余 idle 成员接手。
      emitTasksChanged("released");
    }
    await this.mailbox.sendIdleNotification(member.name, {
      idleReason: "interrupted",
      text: `Teammate '${member.name}' was stopped via TaskStop.`,
    });
    this.options.logger?.info?.("Teammate stopped via TaskStop", {
      event: "agentTeams.teammate_stopped",
      teammate: member.name,
      agentId: member.agentId,
    });
    return { name: member.name, agentId: member.agentId };
  }

  // ------------------------------------------------------------
  // teardown
  // ------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeTasksChanged?.();
    this.poller.dispose();
    if (this.options.role === "member") return; // member 无 teardown（team 归 lead 所有）
    void this.teardown().catch((error) => {
      this.options.logger?.warn?.("Agent teams teardown failed", {
        event: "agentTeams.teardown.failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async teardown(): Promise<void> {
    const members = await this.store.listMembers();
    for (const member of members) {
      await this.options.subagentPort.stopTask?.(member.agentId).catch(() => undefined);
      await this.board.releaseTasksOwnedBy(member.name);
    }
    await this.board.deleteBoard();
    await this.store.deleteTeam();
    this.watched.clear();
  }
}

function sendFailure(
  request: SubagentSendMessageRequest,
  error: string,
): SubagentSendMessageResult {
  return { status: "failed", messageId: `teammsg_${crypto.randomUUID()}`, error, message: error };
}

function extractOutputText(output: unknown): string {
  if (!output || typeof output !== "object") return "";
  const content = (output as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("\n")
    .trim();
}

/**
 * 端口装饰器：launch 拦截 agentName（具名注册 + 身份提示词 + 自驱 watch），
 * sendMessage 拦截按名/team-lead 寻址；其余方法原样透传。
 */
export function createTeamSubagentPort(port: SubagentPort, manager: TeamManager): SubagentPort {
  return {
    ...port,
    launch: (request, options) =>
      manager.handleLaunch(request, options, (innerRequest, innerOptions) =>
        port.launch(innerRequest, innerOptions),
      ),
    ...(port.sendMessage
      ? {
          sendMessage: (request, options) =>
            manager.handleSend(request, (innerRequest) => port.sendMessage!(innerRequest, options)),
        }
      : {}),
  };
}
