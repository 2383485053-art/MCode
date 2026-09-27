// ============================================================
// Agent Teams v1 - 文件式任务板（Claude Code 认领制范式）
// ~/.zcode/tasks/<sessionId>/<id>.json 每任务一文件；
// id = max(现存最大, .highwatermark)+1 锁内分配；
// 认领 = 锁内条件写 owner（already_claimed / already_resolved / blocked 三拒；
// 手动 TaskUpdate 的认领语义在同一把锁内同构三拒）；
// 成员退出 = 其名下任务重置 pending 无主。见 specs/agent-teams-v1.md §1.4。
// ============================================================

import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  TEAM_LEAD_NAME,
  TeamTaskSchema,
  type TeamTask,
  type TeamTaskClaimResult,
} from "@zcode/contracts";
import { atomicWriteJson, withDirectoryLock } from "./lockfile.js";

const HIGHWATERMARK_FILE = ".highwatermark";
const BOARD_LOCK = ".board.lock";

export interface TaskBoardStoreOptions {
  tasksRootDir: string;
  teamId: string;
}

export interface CreateTaskInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
}

export interface UpdateTaskInput {
  status?: "pending" | "in_progress" | "completed" | "deleted";
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  addBlocks?: string[];
  addBlockedBy?: string[];
}

export class TeamTaskBoardStore {
  constructor(private readonly options: TaskBoardStoreOptions) {}

  private boardDir(): string {
    return join(this.options.tasksRootDir, this.options.teamId);
  }

  private taskPath(id: string): string {
    return join(this.boardDir(), `${id}.json`);
  }

  private lockPath(): string {
    return join(this.boardDir(), BOARD_LOCK);
  }

  async createTask(input: CreateTaskInput): Promise<TeamTask> {
    return withDirectoryLock(this.lockPath(), async () => {
      const existing = await this.listTasksUnsafe();
      const highestExisting = existing.reduce(
        (max, task) => Math.max(max, Number(task.id)),
        0,
      );
      const highwatermark = await this.readHighwatermark();
      const nextId = Math.max(highestExisting, highwatermark) + 1;
      const now = new Date().toISOString();
      // createdBy 作为 metadata 字段落盘（CC 同款）；两个条件字段写同一目标，
      // 先合并成单值再 spread，避免后一个条件 spread 静默覆盖前一个。
      const metadata =
        input.createdBy !== undefined
          ? { ...(input.metadata ?? {}), createdBy: input.createdBy }
          : input.metadata;
      const task: TeamTask = TeamTaskSchema.parse({
        id: String(nextId),
        subject: input.subject,
        description: input.description,
        ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
        status: "pending",
        blocks: [],
        blockedBy: [],
        ...(metadata !== undefined ? { metadata } : {}),
        createdAt: now,
        updatedAt: now,
      });
      await atomicWriteJson(this.taskPath(task.id), task);
      await this.writeHighwatermark(nextId);
      return task;
    });
  }

  async getTask(id: string): Promise<TeamTask | undefined> {
    return this.readTask(id);
  }

  async listTasks(): Promise<TeamTask[]> {
    return this.listTasksUnsafe();
  }

  /**
   * 通用更新。status=deleted 永久删除任务文件；其余字段按 CC 语义合并
   * （metadata 浅合并，addBlocks/addBlockedBy 追加去重）。
   *
   * 手动认领检查：构成认领语义（owner 变更为新占据者，或 status→in_progress）
   * 时锁内做与 claimTask 同构的三拒——否则 TaskUpdate 是绕过认领协议的第二条
   * 写路径，两个成员并发抢同一任务会双写 owner（specs/agent-teams-v1.md §1.4）。
   * agent_busy 不查：lead 预分配与「做完一个再接一个」是 prompt 软约束调度，
   * 不是写入正确性问题。
   *
   * 删除守卫：actor 为成员名时，只能删自己的任务（owner=actor）或无主任务；
   * lead 可删任何任务。actor 省略 = 系统行为（TaskCreated 回滚），放行——
   * 回滚针对的是刚建的无主任务，本就到不了拒绝分支。
   *
   * 依赖环检测：addBlockedBy 生效前锁内 DFS，新增等待边使任务沿 blockedBy
   * 可达自身（含自环）即拒绝并报出环路径。addBlocks 不查环：blocks 字段
   * 不参与 blockedBySatisfied 判定（阻塞只由被阻塞方自己的 blockedBy 决定），
   * 纯加 blocks 不构成死锁路径。
   */
  async updateTask(
    id: string,
    patch: UpdateTaskInput,
    actor?: string,
  ): Promise<
    | { result: "updated"; task?: TeamTask }
    | { result: "not_found" }
    | { result: "already_claimed" | "already_resolved" | "blocked" | "delete_forbidden"; task: TeamTask }
    | { result: "dependency_cycle"; task: TeamTask; cycle: string[] }
  > {
    return withDirectoryLock(this.lockPath(), async () => {
      const task = await this.readTask(id);
      if (!task) return { result: "not_found" as const };
      if (patch.status === "deleted") {
        if (
          actor !== undefined &&
          task.owner !== undefined &&
          task.owner !== actor &&
          actor !== TEAM_LEAD_NAME
        ) {
          return { result: "delete_forbidden" as const, task };
        }
        await rm(this.taskPath(id), { force: true }).catch(() => undefined);
        // 任务文件已删：不返回任何 task 快照。此前这里伪造
        // { ...task, status: "completed" } —— deleted ≠ completed，是误导性的
        // 假状态；调用方（工具层 deleted 分支、TaskCreated 回滚）都不读该值。
        return { result: "updated" as const };
      }
      if (patch.addBlockedBy !== undefined && patch.addBlockedBy.length > 0) {
        const tasks = await this.listTasksUnsafe();
        const cycle = findDependencyCycle(id, patch.addBlockedBy, tasks);
        if (cycle) {
          return { result: "dependency_cycle" as const, task, cycle };
        }
      }
      const claimant = patch.owner;
      const willStart = patch.status === "in_progress";
      if ((claimant !== undefined && claimant !== task.owner) || willStart) {
        // completed 优先于 owner 报告，与 claimTask 保持一致的拒绝顺序。
        if (task.status === "completed") {
          return { result: "already_resolved" as const, task };
        }
        if (task.owner !== undefined && claimant !== task.owner) {
          return { result: "already_claimed" as const, task };
        }
        if (willStart) {
          const tasks = await this.listTasksUnsafe();
          if (!blockedBySatisfied(task, tasks)) {
            return { result: "blocked" as const, task };
          }
        }
      }
      const next: TeamTask = {
        ...task,
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.activeForm !== undefined ? { activeForm: patch.activeForm } : {}),
        // 到这里 patch.status 只剩 pending/in_progress/completed（deleted 已提前返回）。
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
        ...(patch.metadata !== undefined
          ? { metadata: { ...(task.metadata ?? {}), ...patch.metadata } }
          : {}),
        ...(patch.addBlocks !== undefined
          ? { blocks: dedupeIds([...task.blocks, ...patch.addBlocks]) }
          : {}),
        ...(patch.addBlockedBy !== undefined
          ? { blockedBy: dedupeIds([...task.blockedBy, ...patch.addBlockedBy]) }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      await atomicWriteJson(this.taskPath(id), TeamTaskSchema.parse(next));
      return { result: "updated" as const, task: next };
    });
  }

  /**
   * 原子认领（CC claimTaskWithBusyCheck）：
   * 他人已认领 / 已完成 / blockedBy 未全完 / 自己已持有其他未完成任务 → 四种拒绝。
   */
  async claimTask(
    id: string,
    owner: string,
  ): Promise<{ result: TeamTaskClaimResult; task?: TeamTask }> {
    return withDirectoryLock(this.lockPath(), async () => {
      const tasks = await this.listTasksUnsafe();
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) return { result: "not_found" as const };
      // completed 优先于 owner 报告：认领者关心的首先是「还有没有活」，其次才是「谁占了」。
      if (task.status === "completed") {
        return { result: "already_resolved" as const, task };
      }
      if (task.owner !== undefined && task.owner !== owner) {
        return { result: "already_claimed" as const, task };
      }
      if (!blockedBySatisfied(task, tasks)) {
        return { result: "blocked" as const, task };
      }
      const busy = tasks.some(
        (candidate) =>
          candidate.id !== id &&
          candidate.owner === owner &&
          candidate.status !== "completed",
      );
      if (busy) return { result: "agent_busy" as const, task };

      const next: TeamTask = {
        ...task,
        owner,
        status: "in_progress",
        updatedAt: new Date().toISOString(),
      };
      await atomicWriteJson(this.taskPath(id), next);
      return { result: "claimed" as const, task: next };
    });
  }

  /** 成员退出回收：名下未完成任务重置 pending 无主，返回被回收的 id 供通知。 */
  async releaseTasksOwnedBy(owner: string): Promise<string[]> {
    return withDirectoryLock(this.lockPath(), async () => {
      const tasks = await this.listTasksUnsafe();
      const released: string[] = [];
      for (const task of tasks) {
        if (task.owner !== owner || task.status === "completed") continue;
        const next: TeamTask = {
          ...task,
          owner: undefined,
          status: "pending",
          updatedAt: new Date().toISOString(),
        };
        await atomicWriteJson(this.taskPath(task.id), TeamTaskSchema.parse(next));
        released.push(task.id);
      }
      return released;
    });
  }

  /** id 升序第一个 pending + 无主 + blockedBy 全完的任务（CC 最低 ID 优先）。 */
  async findNextClaimableTask(): Promise<TeamTask | undefined> {
    const tasks = await this.listTasksUnsafe();
    return (
      tasks
        .filter(
          (task) =>
            task.status === "pending" &&
            task.owner === undefined &&
            blockedBySatisfied(task, tasks),
        )
        .sort((a, b) => Number(a.id) - Number(b.id))[0] ?? undefined
    );
  }

  async deleteBoard(): Promise<void> {
    await rm(this.boardDir(), { recursive: true, force: true }).catch(() => undefined);
  }

  private async listTasksUnsafe(): Promise<TeamTask[]> {
    let names: string[];
    try {
      names = await readdir(this.boardDir());
    } catch {
      return [];
    }
    const tasks: TeamTask[] = [];
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      const task = await this.readTask(name.slice(0, -5));
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => Number(a.id) - Number(b.id));
  }

  private async readTask(id: string): Promise<TeamTask | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.taskPath(id), "utf8");
    } catch {
      return undefined;
    }
    try {
      return TeamTaskSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  private async readHighwatermark(): Promise<number> {
    try {
      const raw = await readFile(join(this.boardDir(), HIGHWATERMARK_FILE), "utf8");
      const value = Number(raw.trim());
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch {
      return 0;
    }
  }

  private async writeHighwatermark(value: number): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(this.boardDir(), HIGHWATERMARK_FILE), String(value), "utf8");
  }
}

function blockedBySatisfied(task: TeamTask, allTasks: readonly TeamTask[]): boolean {
  if (task.blockedBy.length === 0) return true;
  const incomplete = new Set(
    allTasks.filter((candidate) => candidate.status !== "completed").map((c) => c.id),
  );
  // blockedBy 中不存在的 id 不构成阻塞（与 CC「不在未完成集合即放行」一致）。
  return task.blockedBy.every((id) => !incomplete.has(id));
}

/**
 * 新增等待边是否会构成依赖环：从本任务出发沿 blockedBy（旧边 + 本次新增边）
 * DFS，能回到本任务即环（含自环 A blockedBy A），返回环路径（起点重复出现
 * 在末尾便于展示）。环上任务的 blockedBy 永不满足——无人能认领、无任何
 * 报错、任务永久躺着；模型写错依赖必须当场拒绝而不是让任务静默卡死。
 * blockedBy 中不存在的 id 的边自然终止（blockedByMap 查不到返回空数组）。
 */
function findDependencyCycle(
  taskId: string,
  addBlockedBy: readonly string[],
  allTasks: readonly TeamTask[],
): string[] | undefined {
  const blockedByMap = new Map(allTasks.map((task) => [task.id, task.blockedBy]));
  const startEdges = dedupeIds([...(blockedByMap.get(taskId) ?? []), ...addBlockedBy]);
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): string[] | undefined => {
    if (id === taskId) return path;
    if (visited.has(id)) return undefined;
    visited.add(id);
    for (const dep of blockedByMap.get(id) ?? []) {
      const found = visit(dep, [...path, dep]);
      if (found) return found;
    }
    return undefined;
  };
  for (const dep of startEdges) {
    const found = visit(dep, [taskId, dep]);
    if (found) return found;
  }
  return undefined;
}

function dedupeIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
