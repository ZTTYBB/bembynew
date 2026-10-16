# Bemby 功能对照与独立实现清单

核对日期：2026-10-16。

## 范围与证据

- 对照对象是 `liveinaus/BembyPro` 的**公开发布说明**，不是其闭源实现。公开说明可以描述目标行为，但不能证明内部算法、数据结构、错误处理或实际效果。
- GitHub Releases API 当前返回 22 个版本：`v1.1.0` 至 `v1.5.5`，包括两个 `patch-1`。最新发布为 `v1.5.5`，发布时间 `2026-10-15T14:54:25Z`；当前公开 `main` 为 `3d9a0e4a0b6d4e68f788cac54ee928ed94235058`。没有把尚未发布的版本当成需求。
- 版本说明固定引用：[CHANGELOG.md](https://github.com/liveinaus/BembyPro/blob/90228e8c05422cf5f216469283cec1a8c27fc863/CHANGELOG.md)。版本小节链接指向对应公开 Release。
- 本地基线提交为 `7869ea9d695eec06cc370dbb2061d33859c815c8`，但存在大量未提交修改。下表针对**当前工作区**，不能据此声称 GitHub 上的 fork 或已部署服务已经具备这些能力。
- 本表以类型定义、路由、数据库、运行器和前端入口核对；列出的测试文件是可复核入口，不代表所有测试或真实 Telegram / Emby / 浏览器场景都已通过。本轮定向测试与模拟 API 的 UI 验证范围见文末。本次没有登录账户、运行真实业务任务或修改线上服务。
- `v1.0.0` 及更早属于本地继承基线，没有再次逐条宣称对齐。`v1.1.0` 中合并记载的旧开发版功能仍逐项检查。
- 用户已明确排除**网页播放器**。其他公开业务功能仍在目标范围，但下面标记为“部分”或“缺失”的项目尚未追平，不据条目数量计算完成百分比。

状态含义：

| 状态 | 含义 |
| --- | --- |
| 已实现 | 当前源码中有对应行为和可用入口；仍不等于与 Pro 内部实现一致或已经完成真实环境验收。 |
| 部分 | 有相近基础，但缺少公开说明中的关键条件、UI、持久化或验证证据；备注写明差异。 |
| 缺失 | 在相关类型、入口和执行路径中未找到实现；已有相似名称不算完成。 |
| 用户排除 | 用户明确不要求实现，不计作待做功能。 |
| 不适用（授权） | Pro 的授权、分级、发布渠道或受限制资源，不作为本 fork 的绕过或复制目标。 |

## 本批集成

本批已由分任务实现、主目录审查后集成，未提交、推送或部署：

- 独立账户标签栏、值编辑与 AND 条件筛选；账户侧按多个模板创建或运行已有任务，运行成功后合并标签，Passkey 状态立即刷新。
- 持久化任务批次，提供并行数、启动间隔、暂停/继续、取消及失败重试；计划、手动、批次共用执行槽位和去重。
- 持久化具体计划、详情、IANA 时区手动编辑、pin、skip 与按当地日期 Shuffle，编辑冲突返回 409；备份恢复计划并重映射任务 ID。
- 数据仓库文件夹与 JSON 记录、排序、处理状态、敏感数据加密、导入导出；自定义动作支持变量、条件、固定次数重复、数据循环、提前结束和群消息链接。
- 备份同步覆盖新增业务字段/仓库/计划，敏感记录强制加密导出，不能解密的账户凭据拒绝导出；失败通知截断、View 懒加载与失效 chunk 恢复。
- 一次性任务及模板：成功后停用、首次零至多天（含两端）随机日期、失败次日重试、Shuffle 重抽未尝试任务；尝试时间持久化，清日志不重置首次日期语义。
- 手动更正最近结果或补今天的手动记录，联动一次性启停和排期；409 后旧确认失效，可在弹窗内刷新再确认。更正保留原日志时间/详情/来源，审计随日志清理，不是永久历史。
- 模板分类（自动推断或手动指定）、候选账户即时筛选、完整模板成功记录筛选、模板页账户数量上限；账户侧初始显示可建数量与账户名，零可建模板保留为禁用项。
- Emby 有效时长范围在任务、模板、默认设置及备份导入后统一校验；失败日志记录安全的出口名称，并遮蔽凭据。
- 浏览器每日空闲升级，默认面板时区 05:00，忙时每分钟重试、三小时截止；设置可关闭或调整时间，保存上次检查结果。
- 自定义任务/模板的“重启后重跑”显式开关，默认关闭；恢复记录区分手动、计划和批次，批次保留暂停、尝试次数与冷却，取消会解除恢复阻塞。
- 自定义动作“保存数据”：正则全局匹配机器人回复，按命名捕获组、`{match}`、账户名/手机号生成记录名和值，同文件夹同名记录跳过；模板选项定义、每任务取值、默认值回退、启动迁移和任务运行时变量注入。
- 数据仓库 `for_each` 支持启动快照、仅未处理、最大轮数、每项间隔和失败后继续/停止；失败继续不会错误标记当前记录，仍不提供跨任务原子领取。
- 长监听结果、回调 Promise、正则输入、媒体票据和 Mini App 日志均有边界保护：监听结果限量保留，正则拒绝常见嵌套量词，聊天票据绑定账户、日志票据绑定日志且作用域分离，签名片段不写入运行日志。

重要边界：持久批次目前仅覆盖任务运行，不是全部账户批量操作；只有明确勾选的中断任务才自动重放，不能保证外部操作恰好一次。仓库循环采用启动快照，未提供跨任务独占领取；复杂旧动作的嵌套高级编辑仍不完整。浏览器维护锁是单进程锁，不支持多个后端共用同一浏览器缓存并发升级。详细条目和验收限制见下文。

## 许可边界

“作者支持二创”目前不能当作已核实的公开许可事实。

1. 本地 [LICENSE](../LICENSE) 明确允许使用、复制、修改、合并、发布和分发旧版软件，但要求保留版权与许可声明，并清晰标注原始来源。不要删去这些声明。
2. 新仓库当前 [LICENSE](https://github.com/liveinaus/BembyPro/blob/90228e8c05422cf5f216469283cec1a8c27fc863/LICENSE) 写明：未经书面许可，不得复制、修改、重新分发或出售其软件和镜像，也不得基于它们制作衍生作品；`v1.0.0` 及更早继续适用原许可。
3. 当前 [README 的许可段落](https://github.com/liveinaus/BembyPro/blob/90228e8c05422cf5f216469283cec1a8c27fc863/README.md#licence) 重复了上述限制。README 同时说明从 `v1.4.3` 起需要实例绑定激活码；“镜像免费提供”和“无需激活”不是一回事。
4. 本项目的技术路线是：保留获许可的旧版代码，依据公开功能描述自行设计、编写与测试新代码。不下载或提取 Pro 镜像内的代码，不逆向激活协议，不伪造授权，也不自动取得或复制受限制的模板商店内容。
5. 对功能的独立重实现不等于对 Pro 代码、图片、品牌资产或模板内容取得许可。若要复制这些资源或对外分发存在疑问的内容，应取得权利人的明确书面许可。这里是技术范围说明，不是法律意见。

## 代码证据索引

为避免把“搜到关键词”当成完成，表格使用以下证据入口，并给出具体符号或差异：

| 代号 | 本地入口 |
| --- | --- |
| 动作 | [types.ts](../backend/src/types.ts)、[custom.ts](../backend/src/jobs/custom.ts)、[checkin.ts](../backend/src/jobs/checkin.ts) |
| 网页 | [cloudflare.ts](../backend/src/jobs/cloudflare.ts)、[WebStepsEditor.vue](../frontend/src/components/WebStepsEditor.vue)、[webSteps.ts](../frontend/src/composables/webSteps.ts) |
| 浏览器 | [cfBrowser.ts](../backend/src/jobs/cfBrowser.ts)、[cfLicense.ts](../backend/src/jobs/cfLicense.ts)、[cfFonts.ts](../backend/src/jobs/cfFonts.ts)、[settings.ts](../backend/src/routes/settings.ts) |
| 调度 | [scheduler.ts](../backend/src/scheduler.ts)、[scheduler-utils.ts](../backend/src/scheduler-utils.ts)、[status.ts](../backend/src/routes/status.ts)、[ScheduleBody.vue](../frontend/src/components/ScheduleBody.vue) |
| 持久计划 | [jobSchedules.ts](../backend/src/db/jobSchedules.ts)、[ScheduleList.vue](../frontend/src/components/ScheduleList.vue)、[scheduleTime.ts](../frontend/src/utils/scheduleTime.ts) |
| 执行队列 | [execution.ts](../backend/src/jobs/execution.ts)、[taskQueue.ts](../backend/src/jobs/taskQueue.ts)、[taskQueueRuntime.ts](../backend/src/jobs/taskQueueRuntime.ts)、[TaskQueuePanel.vue](../frontend/src/components/TaskQueuePanel.vue) |
| 任务生命周期 | [jobOptions.ts](../backend/src/jobs/jobOptions.ts)、[jobRecovery.ts](../backend/src/db/jobRecovery.ts)、[outcome.ts](../backend/src/jobs/outcome.ts) |
| 浏览器升级 | [cfBrowserAutoUpdate.ts](../backend/src/jobs/cfBrowserAutoUpdate.ts)、[cfBrowserMaintenance.ts](../backend/src/jobs/cfBrowserMaintenance.ts)、[cfBrowserUpdate.ts](../backend/src/jobs/cfBrowserUpdate.ts) |
| 流程 | [automation.ts](../backend/src/jobs/automation.ts)、[custom.ts](../backend/src/jobs/custom.ts)、[WorkflowActionsEditor.vue](../frontend/src/components/WorkflowActionsEditor.vue) |
| 仓库 | [warehouse.ts](../backend/src/db/warehouse.ts)、[warehouse 路由](../backend/src/routes/warehouse.ts)、[DataWarehouseView.vue](../frontend/src/views/DataWarehouseView.vue) |
| 数据库 | [database.ts](../backend/src/db/database.ts)、[accountAttributes.ts](../backend/src/db/accountAttributes.ts) |
| 账户 | [accounts.ts](../backend/src/routes/accounts.ts)、[AccountsView.vue](../frontend/src/views/AccountsView.vue)、[tgAuth.ts](../backend/src/auth/tgAuth.ts) |
| 批量 | [bulkAdd.ts](../backend/src/jobs/bulkAdd.ts)、[bulkProfile.ts](../backend/src/jobs/bulkProfile.ts)、[bulkLoginEmail.ts](../backend/src/jobs/bulkLoginEmail.ts) |
| 任务 | [jobs.ts](../backend/src/routes/jobs.ts)、[runner.ts](../backend/src/jobs/runner.ts)、[JobsView.vue](../frontend/src/views/JobsView.vue) |
| 模板 | [templates.ts](../backend/src/routes/templates.ts)、[TemplatesView.vue](../frontend/src/views/TemplatesView.vue) |
| Emby | [embywatch.ts](../backend/src/jobs/embywatch.ts)、[embyTemplate.ts](../backend/src/jobs/embyTemplate.ts) |
| 消息 | [liveClient.ts](../backend/src/tg/liveClient.ts)、[tgClient.ts](../backend/src/routes/tgClient.ts)、[MessengerView.vue](../frontend/src/views/MessengerView.vue) |
| 小程序 | [miniApp.ts](../backend/src/tg/miniApp.ts)、[webviewTickets.ts](../backend/src/tg/webviewTickets.ts)、[webviewProxy.ts](../backend/src/routes/webviewProxy.ts) |
| 列表 | [list-query.ts](../backend/src/routes/list-query.ts)、[PaginationBar.vue](../frontend/src/components/PaginationBar.vue)、各列表 View |
| 备份 | [data.ts](../backend/src/routes/data.ts)、[exportCrypto.ts](../backend/src/db/exportCrypto.ts) |
| 通知 | [notify.ts](../backend/src/jobs/notify.ts) |
| 外壳 | [App.vue](../frontend/src/App.vue)、[router/index.ts](../frontend/src/router/index.ts)、[style.css](../frontend/src/style.css) |

特别注意：`routes/data.ts` 是业务备份导入/导出；独立数据仓库在 `routes/warehouse.ts`。该备份不是物理整库快照，不包含任务日志、队列历史及所有缓存。Telegram 自身的置顶消息也不是“Bemby 本地置顶并跨账户跳转”。

## 当前网页动作协议

这是本工作区针对 `open_url` 的独立、受限实现，不是任意 JavaScript 执行器，也不声称与 BembyPro 的内部协议相同。

| 节点 | 当前行为 |
| --- | --- |
| `web_eval` | 读取匹配元素的 `text`/`textContent`/`innerText`/`value`/`attribute`/`property`/`exists`/`visible`/`count`，或读取页面 `url`/`title`；支持有界单值/数组结果并写入运行时变量。 |
| `web_set` | 按 CSS 选择器设置表单值、文本、属性或受限 DOM 属性，或点击元素；后端接受 JSON 值，可选把写入结果回传变量；前端提供文本/数字/布尔/JSON 值类型编辑。 |
| `web_if` | 支持共享变量条件，也支持页面选择器的存在、可见、文本包含/不包含/相等和值相等条件；分支可继续嵌套网页动作。 |
| `web_repeat` / `web_for_each` | 支持固定次数和匹配元素循环，带深度、步骤、返回值和元素数量上限；`for_each` 可按文本过滤、读取一个属性，并通过临时 DOM marker 让嵌套选择器作用于当前元素。尚无去重策略，列表在页面变更时的稳定性仍需真实站点验收。 |
| `web_finish` / 日志 | 可提前标记成功或失败；每步记录路径、结果、截图和限量 console 行，并尝试遮蔽运行时变量中的顶层字符串。console 仍是日志字段，不是可供流程读取的变量；嵌套 JSON 中的敏感字符串不应当依赖这层遮蔽。 |

变量只在当前任务运行期间存在，按单遍占位符展开；没有任意脚本、跨任务持久变量、完整 iframe/键盘/拖放/导航动作或上游模板商店内容。网页动作仍需真实目标站点和浏览器环境验收。

## v1.5.4

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.5.4)，2026-10-14 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 基于 Bemplayer 的网页播放器、任务身份一致、独立播放入口、全局关闭开关 | 用户排除 | 按用户要求不实现网页播放器；保留已有 Emby 任务播放功能。 |
| 名称/可选值账户标签，编辑、批量、显示、搜索与备份 | 已实现 | `AccountTagEditor`、独立可选标签栏、批量编辑、标签 API 与备份；原有 null/false/0/空字符串类型可保留。见 `account-tags.test.ts` 及账户 mock UI 验收。 |
| 标签值条件：有/无、比较、包含、全部条件同时满足，数值忽略千位逗号 | 已实现 | `AccountTagFilters` 与 `parseTagFilters` / `tagFilterSql` 接通，多个条件 AND；数值和精确文本条件分开验证，筛选可持久保留。 |
| 批量账户任务成功后自动打标签 | 已实现 | 账户模板运行提交 `successTags`，持久队列仅在业务成功后合并标签；失败不写，后处理失败不会把已完成业务变成可自动重试的失败。见 `queue-managed-integration.test.ts`。 |
| 自定义步骤“保存标签”，直接值或回复正则 | 已实现 | `CustomAction.save_tag`、custom 执行路径及任务/模板动作编辑器；回复来源、捕获组与覆盖策略属于本 fork 自己定义的语义，并非上游公开了内部实现。 |
| 从账户列表选择模板，在后台运行已有任务（含停用任务），运行/排队去重 | 已实现 | `AccountTemplateTasksDialog` 提交单个持久批次，不由前端循环调用手动运行；包括停用任务，排除失效/停用账户及 retired 任务，跨手动/调度/批次去重。 |
| 小程序 HTTP 调用、QuickJS 沙盒、同站限制、任务出口、重新签名、实时日志 | 部分 | `mini_app_http` 已提供同源、SSRF、超时、请求/响应大小限制、显式 initData、重定向检查、状态/响应变量和受限实时步骤日志；当前 HTTP 请求走后端直连，尚未接入任务 SOCKS/浏览器出口，也没有任意 QuickJS 脚本执行，不声称复刻 Pro 的完整沙盒。 |
| 守护机器人小程序审核入群：申请、等待、I accept、确认成员 | 缺失 | `join_group` 有普通验证和待审批检测，但无专门机器人小程序审核动作及消息页联动。 |
| Emby 日志记录代理名称/直连，失败末尾附出口 | 已实现 | `EmbywatchError`、运行器和日志类型保留失败详情与安全的出口名称，错误末尾附出口；覆盖认证/播放失败、直连、缺失代理和凭据遮蔽。协作取消保持取消语义，不伪装为播放失败；见 `embywatch.test.ts` / `runner.test.ts`。 |
| 新增 Bemby 通行密钥后标记立即变绿 | 已实现 | 密钥 POST/list 返回权威 `hasBembyPasskey`，账户页立即同步标记；mock UI 已验证，不代表真实 Telegram 注册验收。 |
| 后端启动时授权读取自动重试 | 不适用（授权） | 本 fork 没有 Pro 功能分级授权加载器，不复制该授权机制。 |

## v1.5.5

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.5.5)，2026-10-15 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 群组按钮重新开放后继续点击、批次倒计时、丢失推送重读、同时监视多个按钮 | 已实现 | `watch_buttons` 监听新消息和编辑，按倒计时等待重新开放，定期重读仍开放的消息以弥补丢失推送，并支持多个按钮文本和顺序点击；跨任务共享监听、15 小时专用租约及完整批次状态协议仍未实现，见 v1.5.1 的边界条目。 |
| 私聊遮码转发到群/频道，跨账户去重、同码去重、仅运行期间的新掉落 | 已实现 | 点击后按来源机器人、时间窗口严格筛选私聊新消息，解析带标签或原文遮码，使用 SQLite 原子指纹领取实现跨账户/跨进程和同码去重，按 `{gift}`/`{code}`/`{message}` 模板转发；不持久化私聊原文，复杂机器人格式仍需真实样本验收。 |
| 按红包总额/份数过滤最低份额 | 部分 | `watch_buttons` 支持常见中英文总额/份数解析与最低份额跳过；复杂格式仍需真实机器人样本验收。 |
| 默认群内直接道谢，可切换回复红包道谢 | 已实现 | 支持随机感谢语、群内直接发送或回复、随机延迟、回调结果条件和 AI 感谢；AI 供应商失败时回退到提示文本，感谢/转发异步执行而不阻塞群按钮监听。弹窗 UI 的上游内部契约无法从公开说明核实。 |
| 自定义步骤“保存数据” | 已实现 | `CustomAction.save_data`、`WarehouseStore.saveData`、任务/模板编辑器和模板选项变量均已接通；全局正则匹配、命名组/账户占位符、同名跳过、容量与 JSON 校验有运行器/仓库测试。 |

## v1.5.3

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.5.3)，2026-10-12 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 播放时长单值或范围、范围含两端、单值增加 0-10%、保存校验最低 30 秒 | 已实现 | `validateEffectiveEmbyDurations` 将仅上限配置与模板/系统下限合并校验；任务保存、模板下发、系统默认值变化及备份导入均拒绝矛盾区间，运行器也不再静默忽略上限。见 `embywatch-duration`、`emby-template`、`job-options-routes`、`templates-emby-routes` 与 `backup-workflows-route` 测试。本地使用上下限字段，不声称复刻上游单文本框交互。 |
| 关联模板任务独立时长，空值跟随模板，显示模板占位值 | 已实现 | `embyTemplateOverrides` / `withEmbyTemplateMeta` 与任务编辑器；已用模拟 API 验证继承回填与独立值保存，不代表真实 Emby 验收。[runner-null-emby-template.test.ts](../backend/src/__tests__/runner-null-emby-template.test.ts) 验证空模板配置下仍应用独立时长。 |
| 保存任务或模板都保留独立时长，旧继承值继续跟随 | 已实现 | 模板 `syncLinkedJobs` 比较旧配置并保留明确覆盖；[templates-emby-routes.test.ts](../backend/src/__tests__/templates-emby-routes.test.ts) 使用真实路由验证批量创建、双编码配置与清空覆盖；另见 [emby-template.test.ts](../backend/src/__tests__/emby-template.test.ts)。 |

## v1.5.2

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.5.2)，2026-10-09 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 浏览器每日自动升级、默认 05:00、无人使用时执行、三小时内重试 | 已实现 | 默认开启、05:00 面板时区，可编辑；启动预约与手动安装/卸载/清理共用维护锁，忙时每分钟重试至三小时截止，终态落库防重启重复。仅更新已安装的 keyed/free，先验证下载再替换，失败保旧；固定路径/版本/下载镜像时跳过。设置显示上次结果；见五个 `cf-browser-*` 新测试。尚未进行真实下载验收。 |
| 计划任务详情与手动指定时间、图钉、跨重启/备份、Shuffle 不移动 | 已实现 | `job_schedules`、status 编辑/pin/shuffle API 与详情 UI；计划跨 SQLite 重开/备份恢复，pin 不被 Shuffle 移动，IANA/DST 及修订冲突有测试。执行中的旧计划恢复为 interrupted，不盲目重放。 |
| watch_buttons 成功后随机/AI 致谢、弹窗条件、随机延迟且不阻塞监听 | 已实现 | `custom.ts` 在点击回调中异步派发感谢和私聊转发，支持随机/AI 文本、回调结果条件、随机延迟、群内直发或回复；AI 调用失败回退到提示文本，不阻塞长时监听。上游弹窗的具体交互契约未公开，未声称复刻其内部 UI。 |
| 编辑 UA 预设并迁移任务和模板引用 | 已实现 | settings 的 `migrateUaPresetReferences` 与设置编辑入口；[settings-ua-preset.test.ts](../backend/src/__tests__/settings-ua-preset.test.ts)。 |
| 每页 200 / 500 / 1000 / 2000 条 | 已实现 | `PaginationBar.vue` 选项与 `MAX_PAGE_SIZE = 2000` 同步；[list-endpoints.test.ts](../backend/src/__tests__/list-endpoints.test.ts)。大页负载仍需真实规模测量。 |
| 监听点击/致谢显示原消息时间，失败标错误 | 缺失 | 全天监听动作尚缺，现有普通步骤耗时不算该功能。 |
| 全天监听持有连接并在账户重连后切换新连接 | 缺失 | 无对应监听动作；现有任务通常自己创建客户端，不能把 Messenger 自动重连当成等价。 |
| Watchtower 无更新时说明原因，不长时间等待 | 缺失 | 无 Watchtower 一键更新链路。 |
| 长开页面头像恢复、失败重试、后台页面媒体票据续期 | 部分 | `MessengerView` 每 5 分钟续期媒体票据，头像失败最多退避重试 3 次，失败状态下点击头像可清除并重载；真实浏览器后台节流与 Telegram 失败样本仍需现场验收。 |
| 批量建任务的“成功过的模板”下拉包含全部模板 | 已实现 | 两个创建入口独立加载完整模板列表，不受当前分页影响；成功史包含停用/退役任务，以持久成功时间或成功日志判定。分页外的停用模板有专项 UI 和路由回归。 |

## v1.5.1

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.5.1)，2026-10-09 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| Watchtower 一键升级、只更新自身、启动后刷新 | 缺失 | compose、settings 路由和设置 UI 未见完整集成；不应直接套用 Pro 的镜像更新目标。 |
| 自定义任务/模板选择仅 Pro / 仅免费浏览器，任务开始前预占授权，不足等待十分钟 | 缺失 | 有 CloakBrowser 合法密钥与 build 管理，但 `CustomConfig` 无任务级 build 策略和整任务预占。 |
| watch_buttons 全天共用监听、逐次日志、15 小时、豁免运行名额 | 部分 | 有长时监听预算和逐次点击结果，但仍使用普通执行槽位，未实现跨任务共享监听/豁免名额。 |
| watch_codes 正则抢码、跨账户去重、旧码过滤、继续后续步骤 | 已实现 | `watch_codes` 已接入自定义动作、任务/模板编辑器、正则捕获、启动前旧消息过滤、跨账户 SQLite 原子领取、回复成功/失败判断和后续步骤；Telegram 真实机器人格式仍需现场样本验收。 |
| 批量运行并行数与启动间隔 | 已实现 | Jobs 和账户模板运行均进入持久队列；批次并行 1-20、启动间隔 0-3600 秒，并受全部入口共用上限约束。真实启动计时，不在完成后才开始计时。 |
| Bemby 本地置顶消息、显示会话/消息 ID、跨账户跳转、共享群历史缓存 | 缺失 | 消息页有 Telegram 自身 pinned banner 与会话置顶；无本地消息锚点和跨账户自动跳转。 |
| 浏览器启动长输出默认折叠 | 部分 | 日志有详情与 trace，但未见与该行为对应的统一“只显示第一行”浏览器启动日志组件。 |
| 关闭超时后强杀再释放授权、保存密钥不释放占用、退出时关浏览器、环境密钥计入并发 | 已实现 | `LaunchedBrowser.close` 在优雅关闭超时后调用强杀通道并有二次超时上限，再幂等释放维护槽、profile、代理和授权租约；保存设置不清空仍运行中的旧租约，环境变量 key 也按单席位计入并发。真实 CloakBrowser 进程级验收仍需在部署环境执行。 |
| 只有 keyed 构建且授权被拒时下载免费版后备 | 部分 | 浏览器有 keyed/free 路径；需按“拒绝、仅 keyed 在磁盘、首次下载失败”逐场景测试，不据文件名断言完整。 |
| VLESS REALITY/flow/encryption 默认 TCP、保留 ENC | 缺失 | 代理订阅目前是通用 HTTP/SOCKS 列表，不是 VLESS/Xray 节点执行器。 |
| 模板任务选项占位提示 | 已实现 | `TemplateOptionsEditor.vue` 展示模板定义并让每个关联任务选择合法值；后端校验选择值、默认值回退、模板更新保留和启动迁移均已接通。 |

## v1.5.0

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.5.0)，2026-10-06 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 通用批量任务落库与重启续跑，暂停/重试/冷却保留，敏感参数加密 | 部分 | `task_batches` / `task_queue_items` 已持久化任务运行批次及暂停、重试、启动冷却；待执行项可续跑，success_tags 复用 `BEMBY_DATA_KEY` 列加密。bulkAdd/bulkProfile 等其他账户操作尚未迁移到统一队列。 |
| 中断任务自动重跑，定时/手动/批量归属区分且不重复 | 已实现 | `job_run_recoveries` 持久记录归属，与新执行日志同事务领取；默认不重跑，仅显式选择后恢复。批次恢复对应 item、保留暂停/尝试次数/启动冷却，取消清理恢复阻塞；已成功的批次项只补标签，不重执行业务。新运行可跨入口去重，但重放前未知外部副作用无法提供恰好一次保证。见 `job-recovery` / `restart-managed-integration` / `task-queue` / `queue-managed-integration` 测试。 |
| 自定义任务/模板的“重启后重新运行”开关 | 已实现 | `rerunOnRestart` 独立业务字段、任务和模板表单、模板关联继承、备份均接通，默认关闭并显示重复外部操作风险；编辑和分享导入保留值。UI 仅自定义类型显示，导入/旧数据上的其他类型值不主动删除。 |
| 加宽全部对话框并修复手机超宽 | 部分 | 现有页面有各自 modal 样式；未作所有账户/任务/模板弹窗桌面与手机矩阵验证，不能据几个宽度认定整体完成。 |

## v1.4.12

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.12)，2026-10-06 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 设置读取不反复执行 Xray / x11vnc 版本查询 | 部分 | 本地没有这两个子系统；`chromiumVersion` 仍有同步进程调用，需要单独评估缓存。不能把“缺子系统”当作已修性能。 |
| 列表取消旧请求，旧结果不覆盖新结果，离页取消 | 已实现 | 账户、任务、模板、日志和数据仓库列表通过 `createLatestRequest` 把 signal 传到 API，同时用 commit 保护忽略取消的旧响应；筛选变化立即取消、卸载 dispose。日志详情/停止轮询也有独立请求归属；有纯逻辑及跨页竞态 mock UI 回归，不扩张为所有 Messenger 请求均已验收。 |
| 面板内确认/提示，主题一致，Enter/Esc | 部分 | 部分确认有 modal，但 Accounts、Jobs、Templates、Logs 中仍调用浏览器 `confirm` / `alert`。 |
| 批量添加/改资料共用后台队列、单项超时、终止剩余项 | 部分 | 两者各自有后台模块，状态在内存中，未形成统一超时与终止契约。 |
| 失败通知过长时截断并说明省略字符数 | 已实现 | 发送前统一截断到 Telegram 4096 UTF-16 单位预算，保留省略数量，避免截断代理对；见 `notify.test.ts`。 |
| 删除被任务引用的账户时显示原因和任务列表 | 部分 | 后端删除保护与 [accounts-delete-guard.test.ts](../backend/src/__tests__/accounts-delete-guard.test.ts) 已有；`AccountsView.remove` 现在捕获并显示 API 返回的原因，尚无独立浏览器点击回归。 |

## v1.4.11

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.11)，2026-10-06 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| join_group 已是成员时直接结束整个任务为成功 | 已实现 | `alreadyMemberEndsTask` 开关已接入类型、运行器、任务/模板编辑器；命中已在群内时抛出成功终止标记，跳过后续动作，并有 custom automation 回归测试。 |
| 批量清理逐步骤选择，删除历史/当前头像可选 | 部分 | Messenger 有整体 `cleanAccount`；无账户侧完整步骤勾选与头像两项。 |
| 更换头像后删旧头像、回读确认/重试并报告 | 缺失 | bulkProfile 只改名字/姓氏/简介；没有完整头像变更与历史清理执行器。 |

## v1.4.10

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.10)，2026-10-05 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 账户侧多账户批量按模板创建、模板分类/搜索/上限、去重、跳过失效账户 | 部分 | 多选、分类/名称/类型搜索、服务端分页、每模板上限、失效账户过滤与事务去重已实现；UI 默认新建停用（API 省略 enabled 仍默认开启）。只读预览初始显示 n/m 及悬停账户名，创建后刷新；零可建模板保留禁用而非隐藏。n 为未关联可创建数，m 为所选启用且类型可用账户数，不扣可选过滤/上限/Emby 凭据校验，此口径和分类推断是独立设计。Emby 不要求 TG 登录；当前只接受同日 HHMM 窗口。 |
| web_eval / web_set 的变量回传到任务供 if_check 使用 | 部分 | 当前 `WebStep` 已实现受限白名单 `web_eval`/`web_set`：可读取文本、值、属性、可见性、数量、URL/标题，设置表单/文本/属性或点击，并把有界 JSON 写回 `open_url` 运行时变量；网页 `web_if` 可读取这些变量，后续任务也能看到回传值。它不是任意 JavaScript，前端已提供文本/数字/布尔/JSON 值类型编辑，但复杂对象和旧配置迁移仍需 UI 回归，网页流程变量与自定义任务完整变量系统的持久化/全部占位符语义也未完全统一。见 `cloudflare.ts`、`types.ts`、`WebStepsEditor.vue` 与 `webSteps.test.*`。 |
| 日志覆盖索引、按需任务列表、会话检查限流、局部刷新、限制一次绘制 | 部分 | 服务端分页、索引与会话检查基础存在；调度刷新仍遍历合格任务，未做完整大规模性能验证。 |

## v1.4.9-patch-1

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.9-patch-1)，2026-10-04 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 一次性任务不受 check_daily_run 影响，按零至多天范围抽运行日 | 已实现 | `runOnce` / `firstRunMinDays` / `firstRunMaxDays` 与重复周期分离，允许 0-3650 天，含两端；不受每日去重开关影响。成功状态、成功时间和停用同事务保存；失败次日重试，不重新抽首次范围，取消不记成功。见 `one-time-jobs.test.ts`。 |
| Shuffle 为未运行的一次性任务重新抽日期 | 已实现 | 全局 Shuffle 为未尝试的一次性任务重抽日期，已尝试失败任务保留重试日期；pin 与即将执行项受保护。首次具体日期/分钟和尝试状态跨 SQLite 重开保持，清理失败日志不重置首次语义。见 `one-time-jobs.test.ts`。 |

## v1.4.9

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.9)，2026-10-04 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 模板商店多选安装/更新、跳过原因、可见筛选范围、进度及单项失败隔离 | 缺失 | 没有商店模块。可独立设计自己的模板目录，但不能假定有权读取 Pro 限制内容。 |

## v1.4.8

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.8)，2026-10-04 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 单账户侧按模板创建任务、分类/名称/类型/数量、共享时间窗、可先停用、Emby 逐项验证 | 已实现 | `AccountTemplateTasksDialog` 支持一个或多个账户，八分类/名称/类型/分页/数量/共享时间窗/启用选择及 Emby 逐项凭据校验；分类支持持久化手动覆盖和本地规则推断，不声称等同上游推断算法。窗口目前仅同日。 |
| 同模板任务在计划中尽量隔开 | 部分 | `pickNextRun` 有全局分钟错峰；没有按模板分组最大间距算法。 |
| Shuffle 在原日期重排、临近一分钟不动、跨重启保持 | 已实现 | status Shuffle API 按计划自身时区的当地日期重排，保护 pin/执行中/临近一分钟的计划，SQLite 保存结果并跨重启保留。见 `scheduler-persistence.test.ts`。 |
| 账户群组/频道/私聊计数，复用检查连接 | 缺失 | 账户列表结构未见这组统计字段与采集逻辑。 |
| 模板侧建任务限制最多 N 个账户 | 已实现 | 模板页与账户侧均有数量控件；API 严格校验 1-2000，按实际创建数截断，跳过失效候选不消耗限额。见 `templates-emby-routes.test.ts` 与模板 mock UI。 |
| 无 Bemby 邮箱、无通行密钥、无限制加轻度限制筛选 | 部分 | 有附加属性/限制状态与过滤基础；需补三项明确筛选及语义。 |
| 表格与 Messenger 可输入搜索的筛选下拉、词序无关、键盘操作 | 缺失 | 没有共用可搜索选择器，各页原生选择框不能视为相同交互。 |
| Emby 内置 UA 新版本与已知旧值迁移、保留未知/自定义/更高版、合并重复 | 部分 | 有 UA 预设与编辑迁移；未见 changelog 所列应用新版本的完整内置映射和一次性升级迁移。 |

## v1.4.7

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.7)，2026-10-04 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 任务创建/修改日期可选列、仅实际配置变化刷新、日期首次倒序 | 部分 | jobs 有 `updated_at`、API 排序和日期列；普通保存/模板下发/仅启用变更是否严格遵守该契约还需补齐。 |
| 入群先做算术、点名按钮、唯一验证按钮、欢迎判断，其他再 AI | 缺失 | `{aiBtn}` 有 AI 选择器，但未见覆盖这些规则、群聊/私聊/投票的确定性分类层。公开“119/114”是作者样本，不能转用作本 fork 的效果数据。 |

## v1.4.6

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.6)，2026-10-04 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 模板真实修改时间、列表展示/排序、未改动与启用变更不刷新 | 缺失 | JobTemplate / job_templates 路由模型缺 `updatedAt`，不能拿任务 updated_at 代替。 |
| 入群提示要求等待时等够秒数后重读再答 | 缺失 | 可手工插 delay，但没有验证提示解析与重读的自动流程。 |

## v1.4.5

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.5)，2026-10-04 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 按每日随机时段循环、灵活标点解析 | 缺失 | 已有固定次数 repeat，但无每日随机执行窗口解释器及标点解析契约。 |
| 无截止时间持续循环，跨午夜重新抽时段 | 缺失 | 无长循环生命周期。 |
| 独占账户运行、定时最多等待三十分钟、手动拒绝 | 已实现 | 任务与模板提供默认关闭的 `exclusiveAccount`；独占任务运行时同账户普通计划跳过并记录原因，独占计划最多等待 30 分钟，手动触发返回 409；普通任务之间仍可并行。 |
| 已在运行不再启动、无限循环豁免运行名额 | 部分 | 已具备跨手动/调度/持久批次的运行及排队去重；尚无无限循环及其名额豁免模型。 |
| 入群先订阅要求频道再验证，诱饵按钮更换后重读 | 缺失 | 有手动 subscribe_channel 和 join_group，但不自动解析整段验证指令。 |
| 群内回复只认对本次发言的回复 | 部分 | checkin 的 peer/anchor 过滤已有定向测试；custom 的等待与按钮路径仍需逐处核对 replyTo，而不是只过滤发送者/消息 ID。 |

## v1.4.4

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.4)，2026-10-03 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| rateBtn 带权赔率区间、只在存在按钮的区间抽取、零权不抽 | 缺失 | 动作运行器没有 rateBtn 解释器。 |
| chance / chanceMin、单位换算、相对权重、参数嵌套 | 缺失 | 无相应选择器与模板任务选项。涉及有资金/积分副作用的流程需额外确认，不能凭示例自动执行。 |

## v1.4.3-patch-1

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.3-patch-1)，2026-10-03 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 任务保存保留模板选项定义、运行时补回、迁移已损坏任务 | 已实现 | `templateOptions.ts` 定义校验、任务选择值、默认值回退和运行时变量注入；数据库一次性迁移只修复缺少定义的旧 custom 任务，并保留合法选择值。 |
| 补丁版本排在正式版之后，更新/商店版本比较正确 | 缺失 | 尚无发布更新与商店的共享版本比较模块。 |

## v1.4.3

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.3)，2026-10-03 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 实例 ID、Basic/Pro 激活分级、未激活限制、商店授权 | 不适用（授权） | 不复刻或绕过上游授权系统；本 fork 继承旧版合法功能不需要伪造 Pro 激活码。CloakBrowser 的第三方合法授权仍须遵守。 |
| 长任务实时步骤日志、每分钟落库、多步骤五秒刷新 | 部分 | 有运行状态轮询；custom 的完整步骤主要经返回/错误写回，尚未见统一的周期增量落库。 |
| 条件判断可读 callback 弹窗 | 已实现 | 点击步骤的 callbackAnswer 纳入受限长度的 `reply_text`，后续 `if_check` 可比较；不是在沙盒内任意读取历史弹窗。见 `custom-automation.test.ts`。 |
| 条件判断任务选项值 | 缺失 | 无任务选项与条件动作。 |
| wait_reply 只接受本步骤开始后的新消息并限定随后点击 | 部分 | 有发送 anchor/scope；不能保证未发送新消息的两轮之间以“本步骤开始”隔离。 |
| 看到按钮后延迟再点：小数、范围、任务变量 | 缺失 | 动作类型无对应 pre-click delay 字段；单独 delay 的语义不同。 |
| 小程序 openTelegramLink 自动带 start 参数回机器人，每链接一次 | 部分 | 消息页有桥接，任务侧小程序签名与返回机制已有基础；需按带 start 的回链验证，不能视为已对齐。 |
| AI 被去掉压缩头时解 gzip/brotli/deflate | 缺失 | AI 调用没有该完整兼容层及测试。正常 fetch 自动解压不是该异常条件。 |
| 批量操作完整等短 FloodWait，超过十五分钟结束并说明可再试时间 | 部分 | bulkProfile / bulkAdd 有固定重试冷却，但不是以 Telegram 返回的 FloodWait 统一调度。 |
| 更新检查读取全部 git tags | 缺失 | 无对应版本检查模块。 |
| 自定义任务允许不填默认机器人 | 部分 | 某些动作可指定 contact；仍需按“全部步骤均指定 contact/只打开网页”验证表单与 runner，不只看字段可为空。 |

## v1.4.0

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.4.0)，2026-10-02 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 重复固定轮数/直到时间、round 变量、失败继续/停止 | 部分 | `repeat` 支持固定 0-500 次和自定义序号变量，嵌套动作共用执行状态；默认失败停止。尚无直到时间、独立失败继续、每日时段及跨午夜长循环策略。 |
| 退出群/取消订阅，支持变量与已退出成功 | 缺失 | 自定义任务已有变量，消息工具可离开会话，但自动化尚无退出群/取消订阅动作及已退出成功契约。 |
| 模板任务选项定义、每任务值、模板更新保留 | 已实现 | JobTemplate/CustomConfig 配置保存、关联任务选择与模板更新合并均已实现；非法旧值回退默认值，部分更新不会清空选择。 |
| rateBtn 简单赔率范围 | 缺失 | 无解析与按钮选择逻辑。 |
| 批量用户名 firstName/lastName/initials/word/num/rand/letters/year | 缺失 | 批量资料后端仅 firstName / lastName / about，未包含用户名生成/设置。 |
| 手动 Shadowsocks / ss://、Xray、添加前测试 | 缺失 | 通用代理列表不提供该协议内核。 |
| 入群字段变量、消息链接串联、机器人私聊题、待审批不当已入群 | 部分 | 变量与频道/超级群消息链接串联已加入，待审批检测与普通入群已有；机器人私聊题/小程序签名链接及全验证路由仍未完整实现。 |
| 任务/模板关闭网页截图 | 缺失 | CustomConfig 无截图策略开关。 |
| Telegram 同时保持连接可设到 200 | 部分 | `LIVE_CLIENT_MAX` 有环境变量上限控制，但无设置页动态调整到 200 的完整管理；提高连接数的内存成本须实测。 |
| 任务显示时区、从模板创建提示时区 | 部分 | Job / JobTemplate 有 timezone 和调度解析；前端所有相关位置显示/提示仍需验收。 |
| 机器人群消息不冒充私聊回复 | 已实现 | checkin peer 过滤及 [checkin-reply-peer.test.ts](../backend/src/__tests__/checkin-reply-peer.test.ts)；custom 的群回复仍另见 v1.4.5。 |
| 小程序内子步骤失败导致整个动作失败 | 部分 | `cloudflare.ts`、小程序 verdict 与错误路径有测试；每类子步骤失败传播需端到端验收。 |
| aiInput 没有可读图片时给明确错误 | 部分 | 自定义验证码/AI 输入有前置检查；不同发送动作的提示一致性仍需补测试。 |
| “验证通过后……”不误判已经验证成功 | 部分 | 普通验证路径已有，未见覆盖该语义反例的定向测试。 |
| 商店一次性模板保持 0 天 | 缺失 | 本地一次性任务/模板和备份已保留零天首次范围；尚无模板商店导入链路，不能据此称商店行为完成。 |
| Cloudflare R2 请求签名/查询超时/关机释放锁修复 | 缺失 | 无云备份子系统。 |
| 更新响应异常压缩兼容 | 缺失 | 无版本检查模块。 |

## v1.3.0

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.3.0)，2026-09-30 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 自检选择出口、多站点/真实 CF、0-100 分、细分报告/进度、WebRTC 与 CPU 检查 | 部分 | 有浏览器 test API、内部指纹/截图结果；无公开列出的多站点组合与评分器。作者的分数不能作为本项目验证结果。 |
| Windows/macOS/Linux persona，切换系统清旧 profile | 缺失 | 无完整 persona 配置与 profile 迁移策略。 |
| 上传 Windows/Mac 字体、八文件检查、仅暴露对应字体、Windows 字体度量 | 部分 | `cfFonts.ts` 提供可分发 CJK/emoji 字体安装；无用户版权字体上传与按 persona 隔离。 |
| IP 城市时区数据库、WebRTC 出口 IP、存储配额/无痕修补 | 部分 | 有国家到时区/语言的基础映射；没有城市位置数据库管理和全部指纹契约。 |
| 手动标记任务成功/失败、补手动运行记录、一次性启停联动 | 已实现 | `GET/POST /jobs/:id/outcome` 先预览 revision 再事务更正，拒绝运行/排队/退役任务与过时提交；无记录才新增今天手动记录。撤销唯一成功会恢复一次性任务，仍有更早成功则保持停用；跨时区/SQL 时间比较不倒退。409 可同窗刷新再确认；重排失败用成功响应附待刷新标记，UI 单独警告已保存结果。审计随日志保留期清理。见 `job-outcome.test.ts` 和 `phase4-jobs-ui.cjs`。 |
| 新任务 13:00-22:00 与 Emby 默认值调整 | 部分 | 本地各创建路径默认值不完全一致，Emby 部分仍继承旧值；应统一表单/API/导入默认，不改已有任务。 |
| CloakBrowser 0.5.11 与授权丢失错误 | 部分 | backend 依赖声明为 `^0.5.3`，实际安装版本与下载构建须独立核实，不能把范围声明读成固定 0.5.11。 |
| 文件点击才签票据、流式下载、突破 25MB 并原名保存 | 部分 | 有媒体票据；`liveClient` 媒体仍有 `TG_MEDIA_MAX_MB` 与整块 buffer，未达到大文件流式下载。 |
| WebGL2/字体自检误报修复 | 部分 | 内部自检存在；需检查独立 canvas 的 WebGL2 与实际字体探针测试，不据有字段认定结果正确。 |
| SpamBot 四按钮封禁优先识别，跨语言以文字为准 | 部分 | 有 spam 分类与账户附加状态；未见完整多语言四按钮反例测试。 |
| 冻结账户搜索给明确原因、本地聊天仍显示 | 部分 | auth/session 错误处理与本地搜索基础存在；冻结专属错误分支和保留本地结果仍需复现测试。 |

## v1.2.0

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.2.0)，2026-09-27 UTC。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 版本写镜像文件而非旧容器环境，避免升级显示旧版本 | 部分 | 前端从 package.json 取版本，但缺完整镜像构建版本/更新检查联动，不能验证容器升级路径。 |
| `(//button)[2]` 与 `xpath=` / iframe XPath | 部分 | 网页选择器由 Playwright 驱动，Mini App 部分路径直接查询；括号 XPath/iframe 的统一解析需测试。 |
| 小程序 css: 支持 :has-text/:text-is/:text-matches/:visible | 部分 | 浏览器步骤可用 Playwright 选择器，但 Mini App css 的每条路径尚未统一验收。 |
| 查看运行浏览器每五秒刷新 profile/proxy、大窗口 | 缺失 | 没有 VNC 实时查看模块。 |
| 数据库 8MB cache、无 mmap、VACUUM 后释放 | 部分 | 本地未引入上游 64MB/256MB 那套设置，不等于复现其“439MB→54MB”效果；需独立测量实际 SQLite/进程占用。 |
| 模板商店浏览/分类/过期/前置条件/版本/安装/回滚/更新/自动更新/安全导出 | 缺失 | 模板页仅本地 CRUD、导入导出和建任务。上游商店内容另受授权限制。 |
| Emby 多备用地址、连接/5xx 切换、401 不切、连接测试一致 | 部分 | `backupUrl` 仅一个且只在 `isUnreachable` 时切；有 HTTP 响应的 5xx 不切，缺多地址序列与测试一致性。 |
| 提取消息按钮内容 copy/button/buttons，含 layer229 rich 页面 | 缺失 | 无批量提取消息模块，且 Telegram 新层支持未完成。 |
| 日志直接打开相关聊天，按机器人/动作联系人尝试 | 部分 | 有从日志切消息页/账户的基础入口；未见完整目标候选解析、依次尝试与提示。 |
| 实例配色八种，深浅色、首屏无闪、Mini App 主题同步 | 缺失 | 外壳与 CSS 没有实例配色/主题存储和应用流程；Mini App 固定主题参数不等价。 |
| S3/R2 云备份、启动恢复、十秒增量、文件夹、部署锁、退出上传 | 缺失 | 只有手动加密完整备份，没有 S3 客户端/同步器/实例锁。公开免费额度和恢复损失数字不是本地保证。 |

## v1.1.0

[发布说明](https://github.com/liveinaus/BembyPro/releases/tag/v1.1.0)，2026-09-26 UTC。此版集中记录了 v1.0.0 之后的多项开发，不应把“本地已有部分浏览器步骤”扩张为全版完成。

| 公开条目 | 状态 | 本地证据与剩余工作 |
| --- | --- | --- |
| 转闭源、发布仓库与镜像通道变更 | 不适用（授权） | 本地 fork 应使用自己的构建/发布来源，不冒充 Pro 镜像或加入其更新渠道。 |
| Telegram layer229、rich 页面消息、统一新按钮、社区 | 缺失 | telegram 依赖仍为 `^2.26.22`；payload 无 rich 页面模型。旧 passkeys 自定义类型注释说明基于较旧层，不能靠改一个 layer 数字完成协议升级。 |
| 计划具体时间落到任务，重启继续、过期计划补跑、跳过保留 | 已实现 | `job_schedules` 持久化具体时间、skip 与 revision；SQLite 重开保持同一时刻，未领取的过期 pending 计划补跑一次，已领取的中断计划不自动重放。见 `scheduler-persistence.test.ts`。 |
| 看门狗收回卡死名额、取消宽限、排队告警、slots 接口 | 部分 | 统一执行器覆盖计划/手动/批次，`/status/executions` 可看槽位并取消；`JOB_WATCHDOG_MS` 默认一小时。超时请求协作停止，原运行器真正结束前不释放槽位。无法强杀不响应取消的运行器；缺任务级 max_run_minutes、二十秒宽限与完整排队告警。见 `managed-execution.test.ts` 与 `scheduler-watchdog.test.ts`。 |
| 当天错过的计划当天超窗口补跑且错峰 | 部分 | 已持久化未领取计划并按原时刻补跑一次，也有 catch-up/错峰测试；没有持久计划且从未成功的新任务，窗口结束后仍排下一日，未声称所有冷启动场景均补跑。 |
| Messenger 请求整体超时、切账户避免永远 loading | 部分 | 有 withTimeout/连接超时；不能据此确认所有路由和界面竞态已覆盖。 |
| 自动重连仍未连上时销毁并重建客户端 | 部分 | `getLiveClient` 有相关恢复路径与测试；旧订阅转移、失效会话和首次请求时限仍需场景验证。 |
| 任务租约计时、超时加一小时回收 | 缺失 | 任务执行路径仍常自建 TelegramClient，没有说明中的统一任务租约表。 |
| 最近成功时间落到任务，日志清理不重置节奏 | 已实现 | `last_success_at`、成功时更新与调度读取；[scheduler-last-success.test.ts](../backend/src/__tests__/scheduler-last-success.test.ts)、[purge-old-logs.test.ts](../backend/src/__tests__/purge-old-logs.test.ts)。 |
| 失败次日重试而非完整成功间隔 | 已实现 | 调度有按成功时间计算间隔及失败后排期路径；[scheduler-run-every-days.test.ts](../backend/src/__tests__/scheduler-run-every-days.test.ts)。 |
| 最老数据库补 job_logs.message 并比对新旧全表结构 | 部分 | 有迁移与完整性测试；需用最早结构跑全字段对比，不能仅验证新建库。 |
| web_eval 直接收集 console 输出 | 部分 | `open_url` 执行期间会捕获并限量保存页面 console 行到每步 `WebStepLog.console`，并仅尝试遮蔽运行时变量中的顶层字符串；这不是 `web_eval` 的独立 `console` 读取模式，也不会把 console 内容作为 `consoleVariable` 写入任务变量。 |
| session 导入覆盖已存在但未登录账户并固定指纹 | 部分 | 普通账户 JSON 导入存在，但账户 `/import` 按手机号匹配后仍跳过；无完整卡密转换/接管流程。 |
| 8月5日至9月10日其他修复集合 | 部分 | 涉及贴纸、邮箱限流、Emby 并发、成员、profiles、数据、代理、剪贴板、passkeys、字段、UI、后台清理等，需逐个回归样例；不能将一行集合声明视为已验证。 |
| 截图搬到 run-shots、运行预算、长循环按失败保图、历史迁出 | 部分 | 新运行会按预算压缩并把 JPEG/PNG/WebP/GIF 截图外置到 `data/run-shots/<logId>`，详情通过绑定日志资源的短期媒体票据引用；启动后批量迁移旧合法 data URI。日志列表已有截图文件数/字节数和筛选总计，精简删除 API/UI 及 `log_screenshot_max_count` 设置已实现；SVG、全部历史异常数据迁移和完整长循环策略仍需真实样本验收。 |
| 日志删除连截图、无主目录清理、VACUUM/checkpoint、默认三十天 | 部分 | 结束日志才能删除截图，删除使用详情 CAS 防止并发误删新截图；会清理对应目录、扫描无主目录并尝试 checkpoint/VACUUM。保留期仍由设置控制（默认值沿用本项目），完整 UI 生命周期和异常文件处理仍需验收。 |
| 视图懒加载、vendor 分包、失效 chunk 自动刷新 | 部分 | App.vue 各 View 已按需分块，失效 chunk 每分钟最多自动刷新一次并保留手动刷新入口；构建已无 >500 kB 提醒。尚无独立 vendor/manualChunks 策略，不把路由分块等同全部包优化。 |
| SQLite NORMAL/cache/mmap、整批查询优化 | 部分 | 有 WAL 和索引基础；不直接照搬后续被 v1.2.0 撤回的大 cache/mmap 配置。 |
| ADMIN_PASSWORD_RESET 一次性复位、全会话注销、登录帮助 | 已实现 | 启动前读取 `ADMIN_USERNAME`/`ADMIN_PASSWORD`，Argon2 写入凭据并推进 token epoch 注销旧会话；`ADMIN_PASSWORD_RESET=1` 用 settings 标记避免同一环境重复执行，移除变量并重启后可再次触发。 |
| Telegram 连接列表/占用者/租约时长/动态上限 | 部分 | 有连接池及环境上限；无设置页完整连接管理与任务租约。 |
| 最大同时运行数设置与立即生效 | 已实现 | `max_concurrent_jobs` 及设置控件统一约束计划、手动与批次，保存后唤醒等待项；降低上限不强杀正在执行的任务。见 `scheduler-concurrency-setting.test.ts`、`managed-execution.test.ts` 与 `queue-managed-integration.test.ts`。 |
| SpamBot 轻度限制与明确无限制徽章 | 部分 | 有账户 restriction 与 spam 检查；分类及所有展示分支需验证，不能把 boolean limited 完全等同新状态。 |
| 批量建任务：排除已关联/受限、关键词、成功过其他模板 | 已实现 | `includeLinked=1` 可取完整启用账户候选，两弹窗本地即时筛选，不随筛选反复请求；默认排已关联、默认不排受限，轻度限制不算受限。关键词匹配 Bemby/TG 显示名，包含条件 OR、排除优先，兼容中英文逗号；停用/退役任务成功史可用于筛选。已关联账户可展示但不可选。 |
| 日志大小列/合计/精简截图/设置保留张数 | 部分 | 日志 API/UI 提供截图文件数、字节数和筛选后总计；结束日志可精简截图，`log_screenshot_max_count` 支持 `0-10000`（0 为不限制）。仍未实现完整历史重压缩/云端备份。 |
| 按数据文件夹逐条循环、跳已处理字段、轮数/间隔/失败策略、数据导入 | 部分 | 仓库导入及 `for_each` 支持文件夹启动快照、`onlyUnprocessed`、成功后 `markProcessed`、迭代上限、每项 `delayMs` 和失败 `stop/continue`；失败继续会跳过当前项并保留未处理状态。不是跨任务原子消费队列，尚无完整自定义处理字段筛选。 |
| 保存消息链接为变量，含小程序签名/登录按钮 | 部分 | `save_message_link` 保存最近收/发的频道或超级群消息到变量，并拒绝私聊；已补旧回复不覆盖新群消息测试。尚无小程序签名/登录按钮链接保存。 |
| 优先点击置顶消息中的按钮，找不到回退 | 部分 | checkin 先查本轮回复，找不到匹配按钮才回退到置顶消息，并非“置顶优先”；置顶候选只扫描最近 50 条消息。[checkin-pinned-button.test.ts](../backend/src/__tests__/checkin-pinned-button.test.ts) 只覆盖匹配/查找辅助函数，未验证主路径优先级。不同自定义点击入口仍需一致性验收。 |
| 回复键盘小程序、多语言按钮、sendData 转发 | 部分 | 小程序签名与回复键盘基础已有；sendData 在任务和消息页的全部转发/结束条件需验收。 |
| 账户列表头像、Telegram ID、复用状态连接 | 已实现 | 账户页设置开关默认关闭；开启后状态检查/刷新 TG 名称时复用现有连接读取并缓存头像与 Telegram ID，列表按设置展示，失败保留旧缓存且限制缓存大小。 |
| 头像图库上传 zip/单图、去重/限额、持久化 | 缺失 | 无图库存储与账户随机头像工作流。 |
| 每账户记住消息文件夹 | 已实现 | Messenger 按账户持久化 `activeFolder`，账户切换恢复对应选择；Telegram 文件夹接口临时失败时不会覆盖本地选择，接口不存在时回退到 `all`。 |
| 网页键盘/按键/长按/拖动/下拉/跳转/后退/滚到元素/取文本/列表/脚本/iframe | 部分 | 已补 `web_eval`（文本、值、属性、可见性、数量、URL、标题）和 `web_set`（值/文本/属性/DOM 属性/点击），并保留 input/button/delay/scroll/wait_element/AI/Turnstile；键盘、长按、拖动、下拉、导航后退、iframe 专用动作和任意脚本仍未实现，选择器只按当前 Playwright 页面路径处理。 |
| 网页 if/else、循环、for-each 筛选去重、提前成功/失败 | 部分 | 网页动作树已支持递归 `web_if`、`web_repeat`、`web_for_each`、`web_finish`，有嵌套深度/步骤/元素预算和条件分支日志；`for_each` 已支持文本过滤、属性摘要、临时 marker 当前元素作用域及嵌套选择器/点击/输入，但尚无去重策略，动态页面列表和真实站点行为仍需验收。 |
| 一次设置多个变量、互相引用、范围随机数、姓名/日期 | 部分 | 单任务运行态 JSON 变量、逐项引用、回复正则提取与单遍插值已加入，旧 word/WORD/num/alpha/uuid 可用；不二次展开变量值内占位符。尚无完整范围随机数/姓名/日期生成器或跨运行变量持久化。 |
| 中途通知、AI 生成并写入指定输入框 | 部分 | 有 AI 识图输入，但缺独立“AI 撰写内容”和运行中通知动作。 |
| 邮箱验证码/验证链接、msOauth2api 邮箱池、网页邮箱登录 | 部分 | bulkLoginEmail 有 Gmail IMAP，但没有网页邮箱动作和 msOauth2api 集成；账户邮箱验证不能替代网页自动化。 |
| 抓取 OTP 密钥并计算 TOTP | 缺失 | 无对应网页动作与 TOTP 实现。 |
| 网站虚拟安全密钥注册/保存/登录 | 缺失 | Telegram Passkey 模块只服务 Telegram，不能视为网站 WebAuthn 虚拟验证器。 |
| 网页等 Telegram 登录码、发消息、保存 API ID/Hash、my.telegram.org 流程 | 缺失 | 无这些网页子步骤。 |
| 成功后任务移交给其他模板并保留 jobId | 缺失 | 模板 CRUD 与绑定不是执行时移交动作。 |
| 数据仓库文件夹/键值 JSON/占位符/步骤/排序/导出 | 部分 | 独立 warehouse 表/API/View 已有层级、键值 JSON、记录/文件夹排序、处理状态与导入导出，`for_each` 可将记录写入动作变量并按间隔/失败策略迭代；敏感记录要求 BEMBY_DATA_KEY，普通导出排除敏感内容。尚无完整数据读写动作组和上游全部占位符语法。 |
| 图片网格验证码、多位置 AI 点击、关键词限定、自定义提示 | 部分 | 有 ai_multiple_btn 与坐标 AI 点击基础；图片验证码分格、多坐标与关键字范围的完整契约未验证。 |
| VNC 实时浏览器、手动操作、剪贴板、强制停止 | 部分 | 有停止浏览器接口；无 VNC 服务器/查看页和安全会话接入。 |
| 浏览器 profile 查看/改名/清理/保留/导入覆盖/每次全新 | 部分 | 有 profile 复用与整体清理；无完整管理 UI 和导入/导出策略。 |
| 小程序 Turnstile | 已实现 | 网页和小程序有 Turnstile 处理及 [turnstileVerdict.test.ts](../backend/src/__tests__/turnstileVerdict.test.ts)；仍需实际站点验收。 |
| 卡密 session 转换、存活检查、固定指纹、批量接管所有权 | 缺失 | 普通 JSON 会话导入与 2FA/会话工具不等价于完整卡密接管流程。 |
| 批量最严隐私、批量提取消息并输出/写数据 | 缺失 | 无对应后台批量执行器及 UI。 |
| 批量资料包含随机头像与用户名 | 部分 | 姓名/简介批量修改已有，头像和用户名缺失。 |
| 账户搜索/筛选、手机号校验、分享手机号、表单记忆、设备重复错误 | 部分 | 搜索/筛选/校验已有基础；剩余功能与状态保留需分别回归。 |
| 消息 Channel DM、投票/测验、无用户名提及、成员搜索、服务消息、回复跳转、新层 | 部分 | 已有回复预览/跳转等旧功能；缺新层模型、Channel DM 与投票等完整能力。 |
| 入群 AI 题目、测验投票验证 | 部分 | 有 AI 按钮和普通验证；投票形式验证与确定性规则层缺失。 |
| 签到文字按钮、多关键词、更多可配置流程 | 部分 | 文字/AI 按钮和自定义动作已有；“更多可配置”缺具体契约，只按公开具体例子补测试，不宣称完全一致。 |
| 一次成功停用、首次零至多天日期、各任务间隔与秒单位 | 部分 | 一次成功停用、首次零至多天随机范围、各类型重复间隔与模板继承已接通；仍未逐项核对所有旧动作的秒输入/展示契约，不能据此前几项完成宣称整行完全一致。 |
| 任务图标、实际代理、直接编辑模板、日志快捷入口 | 部分 | 一些筛选、模板和日志入口已有；任务图标与完整实际代理可见性需补齐。 |
| 单任务覆盖代理，Emby 代理 | 部分 | Emby 和配置 proxyId 已有；模板关联非 Emby 任务的独立覆盖仍需明确保存/合并规则。 |
| 通用后台批量任务、进度/暂停/跳过/间隔/超时/多任务并发 | 部分 | 任务运行已迁入持久批次，具进度/暂停/取消/失败重试/启动间隔/并行与统一看门狗；单项跳过与其他账户批量操作尚未统一。 |
| VLESS/节点订阅/Xray、全局代理、随机池/健康测试/自动刷新 | 部分 | proxyProviders 有 HTTP/SOCKS 订阅、随机候选与测试；无 VLESS/Xray 和替代直连的全局代理。 |
| Emby 播放会话网关、忽略无效 SSL、自定义 UA | 部分 | 有 PlaySessionId、UA 与真实拉流；配置无 ignoreSSL 契约，异常证书和网关兼容仍需真实样例。 |
| aiInputWithCustomHint 随机语气/结构/采样且可关闭 | 缺失 | 无完整占位符与可控随机化策略。 |
| 深浅主题、版本检查、系统日志、重启、话题通知、环境开关 | 部分 | 有部分环境开关与普通通知；无完整主题/更新/系统日志/重启管理；notify 未传 message_thread_id。 |
| FloodWait 等待期不反复重连，放弃剩余重试 | 部分 | 多处有重试/连接管理，但未统一记录共享出口冷却和执行器等待策略；需带 RPC 等待错误测试。 |

## 后续实施顺序

以下仍在用户目标范围内，不表示已安排后台持续开发或已完成：

1. **统一验证环境，再补现有功能边界。** 在同一 Node 22 运行时重新构建 SQLite 原生模块、跑全量回归；补剩余确认框、模板真实修改时间、全部弹窗矩阵和真实 Telegram/Emby/浏览器升级验收。
2. **扩展任务模型和队列覆盖。** 模板自定义选项、所有账户批量操作迁入持久队列；账户独占开关已接入任务、模板、执行器和备份，但仍需真实长任务场景验收。一次性/结果更正/显式重启重跑已有；重放仍需按具体动作分析幂等性，不默认开启。
3. **完善数据与网页流程。** 仓库数据读写动作、循环处理字段/间隔/失败策略、完整嵌套动作编辑、网页 `for_each` 当前元素作用域与筛选去重、更多高级浏览器动作（键盘/拖放/iframe 等）、浏览器 profile/VNC 与第三方合法租约管理。当前白名单网页变量回传已实现，但仍需真实站点验收。每日自动更新已有，未做真实下载验收。
4. **独立验收大模块。** MiniApp HTTP/QuickJS 沙盒、watch_buttons/watch_codes 全天监听、Telegram 新协议层/消息能力、S3/R2 云备份、自己的模板目录与版本更新。网页播放器已排除，上游授权和受限制模板资源不复制。

需要额外验收的风险：

- 持久队列的取消/超时是协作停止，不证明 Telegram、浏览器或媒体连接已立即停止；未清理完的执行不能释放槽位。启用“重启自动重跑”前，必须按动作分析幂等性和未知外部副作用。
- 仓库“仅未处理”是单任务快照筛选，不提供多个任务间的独占领取；并发任务可能使用同一条记录。敏感记录依赖原始 BEMBY_DATA_KEY，丢失后不能靠导出功能解密找回。
- HTTP 脚本沙盒需要 CPU/内存/时限、同站 allowlist、SSRF 防护、重定向复验、受控网络 API、凭据遮蔽和代理一致性。禁止把 Node.js `eval` 当成安全沙盒。
- 监听任务需要跨账户码去重、连接租约/重建、停止清理、日志上限；不占普通槽位也不能无限消耗连接与内存。
- 云备份需要一致性快照、恢复前校验、部署锁、加密密钥管理与恢复演练；“十秒一次”不是零数据丢失保证。
- 浏览器、字体、第三方内核及模板内容分别有各自许可，旧版 Bemby 的许可不会自动覆盖它们。
- 为保证只有持有维护锁的流程升级，旧 `CLOAKBROWSER_AUTO_UPDATE=true` 不再开启 SDK 自带的隐式后台升级；每日升级改由面板开关/时间控制。下载适配依赖当前 `cloakbrowser 0.5.3` 的相邻模块接口，未来接口变化时保旧并报错，不绕过 SDK 验签/第三方许可。

## 验收口径

一项功能只有在 API/持久化、任务执行、前端可操作、错误/取消/重启路径和必要测试都吻合时，才升级为完整完成。不得用改版本号、复制 README、增加同名字段、搜到相似功能或单个成功请求来代替验收。

## 本轮验证

以下记录针对 2026-10-16 的本地未提交工作区，不代表线上或 GitHub fork 已更新。后端测试使用临时 `DB_PATH` 或内存数据库；业务客户端使用测试替身，不会登录真实账户或播放真实媒体。

| 验证 | 环境与范围 | 结果 |
| --- | --- | --- |
| 后端兼容测试集 | Node `20.19.5`；排除下一行的 8 个网络文件及 webviewSite，其余测试全部收集执行 | 98 文件中 97 含通过用例，webStepsBrowser 的 6 项跳过；1517 项通过、6 项跳过，退出码 0。报告：`D:\d\_bemby_patches\phase4-node20-compatible-final.json`。不是单一运行时的完整全量通过。 |
| 新版 Node 网络补测 | Node `22.23.3`；auth-security、bulk-add-utils、safeFetch、settings-log-retention、settings、notify-settings-route、webviewProxy、proxy | 8 文件、138 项通过，退出码 0。报告：`D:\d\_bemby_patches\phase4-node22-network-final.json`。 |
| 本批关键集成契约 | 已包含在 Node 20 兼容测试集中，不重复相加 | 真实备份 HTTP 路由 26 项、结果更正 26 项、计划持久化 28 项、一次性任务 23 项、恢复存储及联动 30 项、队列/手动/执行器集成 6 项通过。恢复覆盖二次中断、成功已落库但计划未写入、取消批次解除阻塞；最后结果更正/计划/恢复四文件定向复测 84/84。 |
| 浏览器升级 | Node `20.19.5`；维护锁、每日调度、更新器、设置路由、环境开关五文件 | 69/69 通过，下载/SDK/浏览器用替身；不证明真实第三方下载和验签服务可用。 |
| 模板工作流 | Node `20.19.5`；list-endpoints、templates-bulk、templates-emby-routes、templates-workflow-route、templates | 151/151 通过；其中 50 项是历史 SQL 镜像，Emby 27 项与 workflow 42 项调用当前真实路由 handler，列表测试含 HTTP 和搜索。不能将 151 项全称为真实 HTTP 测试。 |
| 后端构建 | Node `20.19.5`；执行构建脚本对应的 TypeScript 编译器 | 通过。编译通过不等于 Node 20 能运行全部生产依赖。 |
| 前端构建 | Node `22.23.3`；执行构建脚本对应的 `vite build` | 通过，175 modules，无 >500 kB chunk 提醒。 |
| 最终单线程全量回归 | Node `22.23.3`；独立测试夹同步当前源码，保留匹配 ABI 的依赖与临时数据 | `121 test files passed、1 skipped；1788 passed、7 skipped`，退出码 0。覆盖调度持久化、队列/恢复、媒体票据资源边界、日志截图清理、Mini App 重定向、长监听结果上限与正则安全检查。 |
| 前端辅助逻辑 | Node `22.23.3`；chatSession、latestRequest、messengerFolder、scheduleTime、templateWorkflow | 30/30 通过：聊天会话 2 项、请求归属/取消 9 项、消息文件夹 3 项、时区/DST 8 项、模板候选 8 项。 |
| 主目录 UI 回归 | Playwright + Chrome/Edge，桌面 1440px、手机 375px/390px；全部 `/api/**` 被 mock 拦截 | 账户标签/AND 筛选/模板创建/成功标签/队列控制/Passkey、Jobs 队列、Schedule 时区/DST/pin/skip/shuffle/409、仓库/工作流保存和确认键盘均通过。无页面异常或 document 横向溢出。 |
| 本轮追加 UI | 相同 mock 边界；本轮重新执行 Jobs、模板和列表竞态脚本，浏览器设置由分任务验证 | Jobs 编辑/Shuffle 5 组、结果更正 10 组、模板 9 组、列表/详情/离页竞态 13 组、浏览器设置 7 组通过。更正含一次性成功停用/撤销恢复、409 禁止旧确认、刷新失败后同窗重试、聚焦取消按 Enter 不写入、已保存但重排失败单独警告。均不操作真实业务。 |
| 补丁格式 | `git diff --check` | 通过，仅有已有文件的 LF/CRLF 提醒。 |

本批模板/任务更正测试包含直接调用真实 Express handler，备份及部分列表测试经过本地 HTTP 服务，均使用临时 SQLite；历史 SQL 镜像测试另列，不能混作当前 HTTP 路由覆盖。调度并发/看门狗/队列/恢复集成测试替换 `runJob`，用于验证去重、槽位、取消、重启及后处理生命周期，不能证明真实 Telegram/浏览器 await 可以被强制终止。空模板专项调用真实 `runJob`，但替换 Emby 执行器，仅核对传入执行配置。

`data-export-import.test.ts` 的 67 项是历史 SQL 辅助函数和导出谓词测试，已明确隔离不使用的数据库单例、调度、执行器和密码模块；不能据此宣称当前路由或真实密码运行时已被覆盖。新增 `backup-workflows-route.test.ts` 才是本批当前备份路由的 HTTP 验收。临时 HTTP 服务请求使用 `Connection: close`，避免关闭后重用旧 keep-alive 连接导致假失败。

主工作区的 Windows 依赖目录仍可能因 Node 版本切换产生 ABI 差异；最终回归已在匹配 Node 22 的独立测试夹完成：

- `undici@8.5.0` 声明 Node `>=22.19.0`；主目录原生模块若由 Node 20 安装后切换到 Node 22，仍需重新安装。最终 Node 22 测试夹使用匹配 ABI 的依赖，不覆盖主目录 `node_modules` 或数据文件。
- 本仓库 Dockerfile 各阶段使用 Node 22，后端构建阶段包含原生编译工具；本轮完成了源码构建和匹配 Node 22 的全量测试，但没有构建、启动或部署生产镜像。
- 未覆盖真实 Telegram/Emby/浏览器下载、全部页面/弹窗、生产规模负载及完整重启/恢复矩阵。新增脚本/截图位于 `D:\d\_bemby_patches\phase3-*`、`phase4-*`、`phase2-list-races` 和 `browser-daily`；此前账户/流程/计划证据保留在对应 phase2 目录。仅保留主目录前端预览 `http://127.0.0.1:5173`；临时候选服务已停止，没有启动真实后端。

本表是当前工作区的差距清单，不是“已追平 BembyPro v1.5.5”的发布声明。
