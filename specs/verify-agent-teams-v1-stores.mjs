// Agent Teams v1 文件层验证：mailbox / 任务板 / 花名册
// 运行：node_modules/.bin/tsx specs/verify-agent-teams-v1-stores.mjs（仓库根）
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distUrl = (rel) =>
  pathToFileURL(join(repoRoot, "apps/zcode-cli/packages/core/dist/agent/teams", rel)).href;

const root = join(tmpdir(), `zcode-teams-verify-${Date.now()}`);
const teamsDir = join(root, "teams");
const tasksDir = join(root, "tasks");
const TEAM = "session-verify";

const { TeamMailboxStore } = await import(distUrl("mailbox-store.js"));
const { TeamTaskBoardStore } = await import(distUrl("task-board-store.js"));
const { TeamStore } = await import(distUrl("team-store.js"));

let passed = 0;
let failed = 0;
const assert = (cond, label) => {
  if (cond) {
    passed++;
    console.log(`  ok: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
};

await mkdir(root, { recursive: true });
const mailbox = new TeamMailboxStore({ teamsDir, teamId: TEAM });
const board = new TeamTaskBoardStore({ tasksRootDir: tasksDir, teamId: TEAM });
const store = new TeamStore({ teamsDir, teamId: TEAM, leadSessionId: TEAM });

// ---------- mailbox ----------
console.log("== mailbox ==");
await mailbox.sendMessage("alice", "team-lead", "hello lead", "greeting");
await mailbox.sendMessage("bob", "team-lead", "second", "greeting2");
await mailbox.sendIdleNotification("alice", { idleReason: "available", result: "done #1" });
let unread = await mailbox.readUnread("team-lead");
assert(unread.length === 3, `readUnread 3 帧（实际 ${unread.length}）`);
assert(
  unread.some((f) => f.type === "idle_notification" && f.result === "done #1"),
  "idle 帧可读",
);

// 注入失败不删：read 后不 mark，再读仍在
const stillUnread = await mailbox.readUnread("team-lead");
assert(stillUnread.length === 3, "未 mark 前帧保留");

// 消费即删
await mailbox.markDelivered("team-lead", unread.slice(0, 2));
const afterMark = await mailbox.readUnread("team-lead");
assert(
  afterMark.length === 1 && afterMark[0].type === "idle_notification",
  "消费即删，剩余 idle 帧",
);

// 并发 append 不丢帧
const concurrent = Array.from({ length: 20 }, (_, i) =>
  mailbox.sendMessage("lead", "alice", `msg-${i}`, `s${i}`),
);
await Promise.all(concurrent);
const aliceUnread = await mailbox.readUnread("alice");
assert(aliceUnread.length === 20, `并发 20 帧全部落盘（实际 ${aliceUnread.length}）`);

// ---------- task board ----------
console.log("== task board ==");
const t1 = await board.createTask({ subject: "first", description: "d1" });
const t2 = await board.createTask({ subject: "second", description: "d2" });
const t3 = await board.createTask({ subject: "third", description: "d3" });
assert(
  t1.id === "1" && t2.id === "2" && t3.id === "3",
  `id 自增 1/2/3（${t1.id}/${t2.id}/${t3.id}）`,
);

// 依赖：#2 blockedBy #1
await board.updateTask("2", { addBlockedBy: ["1"] });
const next1 = await board.findNextClaimableTask();
assert(next1?.id === "1", "最低 ID 优先且 #1 可认领");

// 认领 #1（alice）
const c1 = await board.claimTask("1", "alice");
assert(
  c1.result === "claimed" && c1.task.owner === "alice" && c1.task.status === "in_progress",
  "alice 认领 #1 → in_progress",
);

// 四拒
const c1b = await board.claimTask("1", "bob");
assert(c1b.result === "already_claimed", "他人已认领 → already_claimed");
const cbusy = await board.claimTask("3", "alice");
assert(cbusy.result === "agent_busy", "alice 已持有未完成任务 → agent_busy");
const cblocked = await board.claimTask("2", "bob");
assert(cblocked.result === "blocked", "#2 blockedBy #1 未完 → blocked");

// #1 完成 → #2 解锁
await board.updateTask("1", { status: "completed" });
const c2 = await board.claimTask("2", "bob");
assert(c2.result === "claimed", "#1 完成后 #2 解锁，bob 认领成功");

// already_resolved
const cdone = await board.claimTask("1", "bob");
assert(cdone.result === "already_resolved", "已完成任务 → already_resolved");

// 手动 TaskUpdate 认领原子性：与 claimTask 同构三拒（specs §1.4）
const m1 = await board.createTask({ subject: "manual-1", description: "dm1" });
const m2 = await board.createTask({ subject: "manual-2", description: "dm2" });
const m3 = await board.createTask({ subject: "manual-3", description: "dm3" });
await board.updateTask(m2.id, { addBlockedBy: [m1.id] });

const mu1 = await board.updateTask(m1.id, { owner: "carol" });
assert(
  mu1.result === "updated" && mu1.task.owner === "carol",
  "手动设 owner 认领无主任务成功",
);
const mu2 = await board.updateTask(m1.id, { owner: "dave" });
assert(
  mu2.result === "already_claimed" && mu2.task.owner === "carol",
  "手动抢他人已认领 → already_claimed 且 owner 不变",
);
const mu3 = await board.updateTask(m3.id, { status: "in_progress", owner: "carol" });
assert(
  mu3.result === "updated" && mu3.task.status === "in_progress",
  "本人 owner+in_progress 开工成功",
);
const mu4 = await board.updateTask(m2.id, { status: "in_progress" });
assert(mu4.result === "blocked", "仅 status=in_progress 开工 blockedBy 未完任务 → blocked");
const mu5 = await board.updateTask(m2.id, { owner: "erin" });
assert(
  mu5.result === "updated" && mu5.task.owner === "erin",
  "lead 预分配（只设 owner 不开工）不受 blocked 门",
);
await board.updateTask(m1.id, { status: "completed" });
const mu6 = await board.updateTask(m1.id, { owner: "frank" });
assert(mu6.result === "already_resolved", "认领已完成任务 → already_resolved");
const mu7 = await board.updateTask(m3.id, { status: "in_progress" });
assert(
  mu7.result === "already_claimed",
  "仅 status=in_progress 开工他人任务 → already_claimed",
);

// 删除任务
const t4 = await board.createTask({ subject: "toss", description: "d4" });
await board.updateTask(t4.id, { status: "deleted" });
assert((await board.getTask(t4.id)) === undefined, "status=deleted 永久删除文件");

// 回收：bob 退出 → #2 回 pending 无主
const released = await board.releaseTasksOwnedBy("bob");
assert(released.includes("2"), "bob 退出回收 #2");
const t2After = await board.getTask("2");
assert(t2After.status === "pending" && t2After.owner === undefined, "#2 重置 pending 无主");

// highwatermark：删除后的 id 不复用
const t5 = await board.createTask({ subject: "five", description: "d5" });
assert(Number(t5.id) > Number(t4.id), `highwatermark 防 id 复用（新 ${t5.id} > 已删 ${t4.id}）`);

// ---------- roster ----------
console.log("== roster ==");
const cfg = await store.ensureTeam();
const cfg2 = await store.ensureTeam();
assert(cfg.createdAt === cfg2.createdAt, "ensureTeam 幂等");
await store.upsertMember({
  name: "alice",
  agentId: "agent_aaa",
  agentType: "general-purpose",
  description: "x",
  joinedAt: new Date().toISOString(),
});
const beforeSwap = await store.resolveAgentIdByName("ALICE");
assert(beforeSwap === "agent_aaa", "名字解析忽略大小写");
await store.upsertMember({
  name: "alice",
  agentId: "agent_bbb",
  agentType: "general-purpose",
  description: "x",
  joinedAt: new Date().toISOString(),
});
const afterSwap = await store.resolveAgentIdByName("alice");
assert(afterSwap === "agent_bbb", "latest wins：新 agentId 接管名字");
assert((await store.listMembers()).length === 1, "同名替换不重复");
await store.removeMember("alice");
assert((await store.listMembers()).length === 0, "移除成员");

// ---------- 回归：upsertMember 锁重入（P1-1） ----------
// 此前 upsertMember 在锁内调 ensureTeam（同一把锁不可重入），每次注册固定等
// 5s stale 自窃、并发注册 15s 超时。现在必须毫秒级完成且并发安全。
console.log("== roster 回归（锁重入）==");
const upsertStart = Date.now();
await store.upsertMember({
  name: "solo",
  agentId: "agent_solo",
  agentType: "general-purpose",
  description: "x",
  joinedAt: new Date().toISOString(),
});
const upsertMs = Date.now() - upsertStart;
assert(upsertMs < 1000, `upsertMember 毫秒级完成（${upsertMs}ms < 1000ms）`);
let concurrentUpsertOk = true;
try {
  await Promise.all(
    ["c1", "c2", "c3", "c4"].map((name, i) =>
      store.upsertMember({
        name,
        agentId: `agent_c${i}`,
        agentType: "general-purpose",
        description: "x",
        joinedAt: new Date().toISOString(),
      }),
    ),
  );
} catch {
  concurrentUpsertOk = false;
}
const rosterAfter = await store.listMembers();
assert(
  concurrentUpsertOk &&
    rosterAfter.length === 5 &&
    ["solo", "c1", "c2", "c3", "c4"].every((n) => rosterAfter.some((m) => m.name === n)),
  `并发 4 个 upsert 无超时且全部落盘（${rosterAfter.length} 成员）`,
);

// ---------- 回归：markDelivered 以 msg_id 定位（P2-3） ----------
// 同一发送者、同一毫秒、同一文本的两帧只删指定那帧（此前组合键会一并误删）。
console.log("== mailbox 回归（msg_id 定位）==");
const twinTs = new Date().toISOString();
await mailbox.append("twin", {
  msgV: 1,
  msg_id: "teammsg_twin-1",
  type: "message",
  from: "same-sender",
  text: "identical body",
  timestamp: twinTs,
});
await mailbox.append("twin", {
  msgV: 1,
  msg_id: "teammsg_twin-2",
  type: "message",
  from: "same-sender",
  text: "identical body",
  timestamp: twinTs,
});
const twinUnread = await mailbox.readUnread("twin");
assert(twinUnread.length === 2, "同键双帧均在");
await mailbox.markDelivered("twin", [twinUnread[0]]);
const twinRemain = await mailbox.readUnread("twin");
assert(
  twinRemain.length === 1 && twinRemain[0].msg_id === "teammsg_twin-2",
  "只删除指定 msg_id 的帧",
);

// ---------- 回归：claim 被拒后 findNext 排除致拒任务（P2-1 收敛前提） ----------
console.log("== board 回归（claim 重试收敛）==");
const r1 = await board.createTask({ subject: "race-1", description: "d" });
await board.claimTask(r1.id, "racer-a");
const raceNext = await board.findNextClaimableTask();
assert(
  raceNext !== undefined && raceNext.id !== r1.id,
  `已被认领的任务不再出现在 findNext（返回 #${raceNext?.id}，排除 #${r1.id}）`,
);

// ---------- 回归：SendMessage 描述与端口同门（P1-2） ----------
console.log("== SendMessage 描述回归 ==");
const { createSendMessageToolEntry } = await import(
  pathToFileURL(join(repoRoot, "apps/zcode-cli/packages/core/dist/tool/handlers/send-message.js"))
    .href
);
const defaultEntry = createSendMessageToolEntry();
const teamEntry = createSendMessageToolEntry({ teamAddressing: true });
assert(
  !defaultEntry.metadata.description.includes("team-lead") &&
    defaultEntry.metadata.description.includes("agent_<uuid>"),
  "默认描述保持 agentId 寻址原版",
);
assert(
  teamEntry.metadata.description.includes("team-lead") &&
    teamEntry.metadata.description.includes("researcher"),
  "teamAddressing 切换为 team 按名寻址版",
);

// ---------- CC 对齐补丁（本轮 5 项） ----------
console.log("== CC 对齐（保留名/信封/TaskStop/描述）==");
const contractsUrl = (rel) =>
  pathToFileURL(join(repoRoot, "apps/zcode-cli/packages/contracts/dist/agent-teams", rel)).href;
const { isReservedTeamAgentName } = await import(contractsUrl("types.js"));
assert(
  isReservedTeamAgentName("user") && isReservedTeamAgentName("System") && isReservedTeamAgentName("SYSTEM"),
  "保留名含 user/system（任意大小写，CC 4548）",
);
assert(
  isReservedTeamAgentName("team-lead") && isReservedTeamAgentName("MAIN") && isReservedTeamAgentName("agent_x1"),
  "team-lead/main/agent_ 前缀仍保留",
);
assert(
  !isReservedTeamAgentName("alice") && !isReservedTeamAgentName("username"),
  "普通名与含保留词的名不受影响",
);

const promptsDist = await import(distUrl("prompts.js"));
assert(
  promptsDist.TEAMMATE_MESSAGE_UNTRUSTED_NOTICE.includes("permission laundering") &&
    promptsDist.TEAMMATE_MESSAGE_UNTRUSTED_NOTICE.includes("AGENTS.md"),
  "防洗白声明存在（CC 1097：peer 不能授予提权）",
);
assert(
  promptsDist.TASK_CREATE_PROVIDER_DESCRIPTION.includes("enough detail"),
  "TaskCreate 描述含任务描述质量句（CC 4156）",
);

const { taskStopToolEntry } = await import(
  pathToFileURL(join(repoRoot, "apps/zcode-cli/packages/core/dist/tool/handlers/task-stop.js")).href
);
assert(
  taskStopToolEntry.metadata.description.includes("teammate"),
  "TaskStop 描述教 teammate 停法（CC 0175）",
);

await rm(root, { recursive: true, force: true });
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
