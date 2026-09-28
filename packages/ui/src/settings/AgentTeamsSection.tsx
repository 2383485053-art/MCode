import { useCallback, useEffect, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";

/**
 * Agent Teams 独立设置分区（Agent 能力分组，与记忆/子智能体并列）。
 * 开关单一存储在 CLI 运行时配置 ~/.zcode/cli/config.json 的 features.agentTeams，
 * 经 desktop platform 通道读写；开 = 启用、关 = 关闭，无回落语义，对新建会话生效。
 * Web/旧容器没有 platform 通道时降级为提示文案。
 */
export function AgentTeamsSection() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const supportsAgentTeamsToggle = Boolean(
    platform.readAgentTeamsEnabled && platform.writeAgentTeamsEnabled,
  );
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!supportsAgentTeamsToggle) return;
    let cancelled = false;
    void platform.readAgentTeamsEnabled!()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch((error: unknown) => {
        // 读失败保留 null（加载中样式），不把开关误显示为关。
        logger.warn("[agent-teams] 读取配置失败", { error: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [platform, supportsAgentTeamsToggle]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      try {
        await runUserActionAsync({
          input: {
            featureId: "settings.agentTeams",
            action: "toggle_agent_teams",
            trigger: "switch",
          },
          operation: () => platform.writeAgentTeamsEnabled!(next),
          completed: {
            resultSource: "platform_result",
            stateAfter: next ? "enabled" : "disabled",
          },
          failureStage: "settings_commit",
        });
      } catch (error) {
        // 写失败回弹到切换前状态，不让 UI 与磁盘不一致。
        setEnabled(previous);
        logger.warn("[agent-teams] 写入配置失败", { error: String(error) });
      }
    },
    [enabled, platform],
  );

  if (!supportsAgentTeamsToggle) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.agentTeams.desktopOnly" })}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.agentTeams.toggle.label" })}
          description={intl.formatMessage({ id: "settings.agentTeams.toggle.description" })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.agentTeams.toggle.label" })}
              checked={enabled === true}
              disabled={enabled === null}
              onCheckedChange={(checked) => {
                void handleToggle(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
