// ============================================================
// Agent Teams v1 - 花名册（name→agentId 的唯一事实）
// ~/.zcode/teams/<sessionId>/config.json。latest wins：同名（忽略大小写）
// 新成员替换旧条目；旧 agentId 仍可经 SendMessage 直达（恢复用）。
// 见 specs/agent-teams-v1.md §1.2。
// ============================================================

import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TeamConfigSchema,
  type TeamConfig,
  type TeamRosterMember,
} from "@zcode/contracts";
import { atomicWriteJson, withDirectoryLock } from "./lockfile.js";

const CONFIG_LOCK = "config.json.lock";

export interface TeamStoreOptions {
  teamsDir: string;
  teamId: string;
  leadSessionId: string;
}

export class TeamStore {
  constructor(private readonly options: TeamStoreOptions) {}

  get teamDir(): string {
    return join(this.options.teamsDir, this.options.teamId);
  }

  get configPath(): string {
    return join(this.teamDir, "config.json");
  }

  /** 幂等建队：lead 首次 spawn 成员或首次使用任务板时调用。 */
  async ensureTeam(): Promise<TeamConfig> {
    // 修复：ensureTeamUnsafe 才是临界区本体。此前这里直接在锁内再调一次
    // withDirectoryLock，而目录锁不可重入——内层只能等 5s stale 后把外层
    // 自己持有的锁窃走（每次注册固定 +5s、并发注册 15s 超时，且互斥失效）。
    return withDirectoryLock(this.lockPath(), () => this.ensureTeamUnsafe());
  }

  /** 锁内版本：调用方必须已持有 config.json.lock（upsertMember 等复合读-改-写用）。 */
  private async ensureTeamUnsafe(): Promise<TeamConfig> {
    const existing = await this.readRaw();
    if (existing) return existing;
    const config: TeamConfig = TeamConfigSchema.parse({
      teamV: 1,
      teamId: this.options.teamId,
      leadSessionId: this.options.leadSessionId,
      createdAt: new Date().toISOString(),
      members: [],
    });
    await atomicWriteJson(this.configPath, config);
    return config;
  }

  /** 登记/替换成员（latest wins），返回最终登记名（可能因重名加了 -2 后缀）。 */
  async upsertMember(member: TeamRosterMember): Promise<TeamRosterMember> {
    return withDirectoryLock(this.lockPath(), async () => {
      // 已持锁，必须走锁内版本（见 ensureTeam 的修复注释）。
      const config = await this.ensureTeamUnsafe();
      const nextMembers = config.members.filter(
        (candidate) => candidate.name.toLowerCase() !== member.name.toLowerCase(),
      );
      nextMembers.push(member);
      await atomicWriteJson(this.configPath, { ...config, members: nextMembers });
      return member;
    });
  }

  async removeMember(name: string): Promise<void> {
    await withDirectoryLock(this.lockPath(), async () => {
      const config = await this.readRaw();
      if (!config) return;
      const nextMembers = config.members.filter(
        (candidate) => candidate.name.toLowerCase() !== name.toLowerCase(),
      );
      if (nextMembers.length === config.members.length) return;
      await atomicWriteJson(this.configPath, { ...config, members: nextMembers });
    });
  }

  async resolveAgentIdByName(name: string): Promise<string | undefined> {
    const config = await this.readRaw();
    const match = config?.members.find(
      (member) => member.name.toLowerCase() === name.toLowerCase(),
    );
    return match?.agentId;
  }

  async listMembers(): Promise<TeamRosterMember[]> {
    return (await this.readRaw())?.members ?? [];
  }

  /** teardown：删除整个 team 目录（含 config 与 inboxes）。失败不抛（teardown 尽力而为）。 */
  async deleteTeam(): Promise<void> {
    await rm(dirname(this.configPath), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  private lockPath(): string {
    return join(this.teamDir, CONFIG_LOCK);
  }

  private async readRaw(): Promise<TeamConfig | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch {
      return undefined;
    }
    try {
      return TeamConfigSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
}
