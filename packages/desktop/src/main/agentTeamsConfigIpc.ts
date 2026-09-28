import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ipcMain } from "electron";
import { PlatformChannels } from "@zcode/shared";

// Agent Teams GUI 开关的单一存储：CLI 运行时配置 features.agentTeams（~/.mcode/cli/config.json，
// 遵循 ZCODE_HOME 覆盖，与 services 侧 rebrand 后的 home 解析一致）。
// 读写均由 desktop main 执行（renderer 无文件系统权限）；写为读-合并-原子写，
// 不触碰 config.json 的其他字段（plugins/mcp/hooks 等仍归各自写入方所有）。
const CLI_CONFIG_DIR = join(process.env.ZCODE_HOME?.trim() || join(homedir(), ".mcode"), "cli");
const CLI_CONFIG_FILE = join(CLI_CONFIG_DIR, "config.json");

interface CliUserConfig {
  features?: { agentTeams?: boolean };
  [key: string]: unknown;
}

async function readCliUserConfig(): Promise<CliUserConfig> {
  try {
    return JSON.parse(await readFile(CLI_CONFIG_FILE, "utf-8")) as CliUserConfig;
  } catch {
    // 文件不存在或半截 JSON（另一写者正在覆盖）：Agent Teams 默认关，不放大读取异常。
    return {};
  }
}

async function writeCliUserConfigAtomically(config: CliUserConfig): Promise<void> {
  await mkdir(CLI_CONFIG_DIR, { recursive: true });
  const tempFile = `${CLI_CONFIG_FILE}.agent-teams-${process.pid}.tmp`;
  await writeFile(tempFile, JSON.stringify(config, null, 2), "utf-8");
  try {
    await rename(tempFile, CLI_CONFIG_FILE);
  } catch (error) {
    // Windows rename 在目标被短暂占用时会失败（EBUSY/EPERM）；小步重试即可，不引入锁。
    await new Promise((resolve) => setTimeout(resolve, 120));
    try {
      await rename(tempFile, CLI_CONFIG_FILE);
    } catch {
      await writeFile(tempFile, "utf-8").catch(() => {});
      throw error;
    }
  }
}

export function registerAgentTeamsConfigIpcHandlers(logger: {
  warn: (...args: unknown[]) => void;
}): void {
  ipcMain.handle(PlatformChannels.ReadAgentTeamsEnabled, async () => {
    const config = await readCliUserConfig();
    return config.features?.agentTeams === true;
  });

  ipcMain.handle(PlatformChannels.WriteAgentTeamsEnabled, async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      logger.warn("[agent-teams] invalid agentTeamsEnabled payload:", enabled);
      throw new Error("invalid agentTeamsEnabled payload");
    }
    const config = await readCliUserConfig();
    await writeCliUserConfigAtomically({
      ...config,
      features: { ...config.features, agentTeams: enabled },
    });
  });
}
