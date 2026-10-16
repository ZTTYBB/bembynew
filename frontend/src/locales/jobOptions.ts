export const jobOptionsZh = {
  runOnce: "成功一次后停用",
  firstRunMinDays: "首次运行最早（天）",
  firstRunMaxDays: "首次运行最晚（天）",
  invalidRange: "首次运行天数须为 0 至 3650 的整数，且最晚不得早于最早",
  rerunOnRestart: "服务器重启后重新运行",
  rerunRisk: "可能重复已发送的消息、购买或其他外部操作",
  exclusiveAccount: "独占账号运行",
  exclusiveAccountHint: "运行期间阻止同一账号的其他任务；定时任务最多等待 30 分钟，立即运行会拒绝。",
};

export const jobOptionsEn: typeof jobOptionsZh = {
  runOnce: "Disable after one success",
  firstRunMinDays: "First run, earliest (days)",
  firstRunMaxDays: "First run, latest (days)",
  invalidRange: "First-run days must be integers from 0 to 3650, with latest at least earliest",
  rerunOnRestart: "Rerun after a server restart",
  rerunRisk: "May repeat messages, purchases, or other external actions",
  exclusiveAccount: "Exclusive account run",
  exclusiveAccountHint: "Blocks other jobs for this account while running; scheduled runs wait up to 30 minutes, manual runs are refused.",
};
