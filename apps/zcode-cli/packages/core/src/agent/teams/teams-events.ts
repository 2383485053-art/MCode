// ============================================================
// Agent Teams v1 - tasks_changed 进程内事件（模块级单例）
// lead 侧与 member 侧的 TeamManager 是同进程不同实例：member 建任务/
// 完成任务时 lead 侧无法经实例引用感知，此模块是唯一的进程内广播点。
// 任务变更 emit → lead 侧订阅回调唤醒 idle 成员进入认领分支。
// 见 specs/agent-teams-v1.md §1.5.e。
// ============================================================

/** 变更来源：created（新建可做）/ completed（可能解锁下游）/ released（成员退出回池）。 */
export type TasksChangedReason = "created" | "completed" | "released";

type TasksChangedListener = (reason: TasksChangedReason) => void;

const listeners = new Set<TasksChangedListener>();

/** 订阅；返回退订函数（lead 侧 TeamManager dispose 时调用，防泄漏）。 */
export function onTasksChanged(listener: TasksChangedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 广播；单个监听者异常不阻断其他成员被唤醒（事件是尽力而为的唤醒提示）。 */
export function emitTasksChanged(reason: TasksChangedReason): void {
  for (const listener of listeners) {
    try {
      listener(reason);
    } catch {
      // 吞掉监听者异常：唤醒失败的最坏结果是该成员保持 idle，
      // 下一次任务变更或 SendMessage 唤醒仍可恢复。
    }
  }
}
