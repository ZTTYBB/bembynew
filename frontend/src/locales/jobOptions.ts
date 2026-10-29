export const jobOptionsZh = {
  runOnce: "成功一次后停用",
  firstRunMinDays: "首次运行最早（天）",
  firstRunMaxDays: "首次运行最晚（天）",
  invalidRange: "首次运行天数须为 0 至 3650 的整数，且最晚不得早于最早",
  rerunOnRestart: "服务器重启后重新运行",
  rerunRisk: "可能重复已发送的消息、购买或其他外部操作",
  retrySameDay: "失败后当天补运行",
  retrySameDayHours: "补运行间隔（小时）",
  retrySameDayHint: "运行失败后，当天每隔设定的小时数再运行一次，直到成功。下一次若会跨过午夜，则改在当天 23:00–23:59 随机补运行一次；23:00 之后失败的当天不再补运行，也不会顺延到次日。需要避开高峰的 Emby 任务会避开 20:00–23:00。手动停止的运行不会补运行。",
  invalidRetryHours: "补运行间隔须为 1 至 23 的整数",
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
  retrySameDay: "Rerun the same day if failed",
  retrySameDayHours: "Hours between reruns",
  retrySameDayHint: "After a failed run, the job runs again every set number of hours for the rest of the day until one succeeds. When the next try would land after midnight it runs once at a random minute between 23:00 and 23:59 instead; a failure after 23:00 is not rerun that day and never carries over to the next. Emby jobs set to avoid peak hours skip 20:00-23:00. A run you stopped by hand is not rerun.",
  invalidRetryHours: "Hours between reruns must be a whole number from 1 to 23",
  exclusiveAccount: "Exclusive account run",
  exclusiveAccountHint: "Blocks other jobs for this account while running; scheduled runs wait up to 30 minutes, manual runs are refused.",
};
