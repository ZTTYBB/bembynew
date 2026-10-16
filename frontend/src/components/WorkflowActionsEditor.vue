<template>
  <div class="workflow-editor">
    <div v-for="(action, index) in actions" :key="index" :class="single ? '' : 'workflow-row'">
      <div v-if="!single" class="workflow-header">
        <span class="workflow-index">{{ index + 1 }}</span>
        <select class="form-select" :value="action.type" @change="changeType(index, $event)">
          <option v-for="option in options" :key="option.type" :value="option.type">{{ option.label }}</option>
        </select>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" title="上移" :disabled="index === 0" @click="move(index, -1)"><i class="fa-solid fa-arrow-up"></i></button>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" title="下移" :disabled="index === actions.length - 1" @click="move(index, 1)"><i class="fa-solid fa-arrow-down"></i></button>
        <button type="button" class="btn btn-danger btn-sm btn-icon" :title="t('common.delete')" @click="actions.splice(index, 1)"><i class="fa-solid fa-trash"></i></button>
      </div>

      <template v-if="action.type === 'set_variables'">
        <div v-for="(assignment, assignmentIndex) in action.variables" :key="assignmentIndex" class="variable-row">
          <div class="workflow-line">
            <input v-model.trim="assignment.name" class="form-input" aria-label="变量名" placeholder="variable_name" maxlength="64" />
            <select :value="assignment.source ?? 'value'" class="form-select" aria-label="值来源" @change="assignment.source = inputValue($event) as 'value' | 'reply'">
              <option value="value">指定值</option><option value="reply">最近回复</option>
            </select>
            <button type="button" class="btn btn-danger btn-sm btn-icon" title="删除变量" @click="action.variables.splice(assignmentIndex, 1)"><i class="fa-solid fa-trash"></i></button>
          </div>
          <input v-if="assignment.source === 'reply'" v-model="assignment.regex" class="form-input" aria-label="提取正则" placeholder="正则表达式（留空保存完整回复）" />
          <template v-else>
            <select class="form-select" :value="valueMode(assignment)" aria-label="值类型" @change="changeValueMode(assignment, $event)">
              <option value="text">文本</option><option value="number">数值</option><option value="boolean">布尔值</option><option value="json">JSON 数据</option>
            </select>
            <textarea v-if="valueMode(assignment) === 'json'" class="form-input" rows="3" aria-label="JSON 数据" :value="assignment.valueDraft ?? JSON.stringify(assignment.value, null, 2)" @input="assignment.valueDraft = inputValue($event)" />
            <label v-else-if="valueMode(assignment) === 'boolean'" class="form-check"><input v-model="assignment.value" type="checkbox" />true</label>
            <input v-else v-model="assignment.value" class="form-input" :type="valueMode(assignment) === 'number' ? 'number' : 'text'" aria-label="变量值" placeholder="{item.code}" />
          </template>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" @click="action.variables.push({ name: '', value: '', source: 'value' })"><i class="fa-solid fa-plus"></i> 添加变量</button>
      </template>

      <template v-else-if="action.type === 'if_check'">
        <div class="workflow-line">
          <input v-model="action.condition.left" class="form-input" aria-label="条件左值" placeholder="{points}" />
          <select v-model="action.condition.operator" class="form-select" aria-label="比较">
            <option value="eq">等于</option><option value="ne">不等于</option><option value="contains">包含</option><option value="not_contains">不包含</option>
            <option value="gt">&gt;</option><option value="gte">&gt;=</option><option value="lt">&lt;</option><option value="lte">&lt;=</option>
            <option value="exists">存在</option><option value="empty">为空</option>
          </select>
          <input v-if="!['exists', 'empty'].includes(action.condition.operator)" v-model="action.condition.right" class="form-input" aria-label="条件右值" />
        </div>
        <details open class="workflow-branch"><summary>满足条件</summary><WorkflowActionsEditor :actions="action.thenActions" :depth="depth + 1" :folders="resolvedFolders" /></details>
        <details class="workflow-branch"><summary>不满足条件</summary><WorkflowActionsEditor :actions="action.elseActions || (action.elseActions = [])" :depth="depth + 1" :folders="resolvedFolders" /></details>
      </template>

      <template v-else-if="action.type === 'repeat'">
        <div class="workflow-line">
          <label class="form-group"><span class="form-label">次数</span><input v-model.number="action.count" class="form-input" type="number" min="0" max="500" /></label>
          <label class="form-group"><span class="form-label">序号变量</span><input v-model.trim="action.indexVariable" class="form-input" placeholder="loop_index" /></label>
        </div>
        <WorkflowActionsEditor :actions="action.actions" :depth="depth + 1" :folders="resolvedFolders" />
      </template>

      <template v-else-if="action.type === 'for_each'">
        <div class="workflow-line">
          <label class="form-group"><span class="form-label">来源</span><select v-model="action.source" class="form-select"><option value="variable">数组变量</option><option value="warehouse">数据仓库</option></select></label>
          <label class="form-group"><span class="form-label">{{ action.source === 'warehouse' ? '文件夹' : '数组变量名' }}</span>
            <select v-if="action.source === 'warehouse'" v-model.number="action.folderId" class="form-select"><option :value="undefined" disabled>选择文件夹</option><option v-for="folder in resolvedFolders" :key="folder.id" :value="folder.id">{{ folder.name }} (#{{ folder.id }})</option></select>
            <input v-else v-model.trim="action.variable" class="form-input" placeholder="items" />
          </label>
        </div>
        <div class="workflow-line">
          <label class="form-group"><span class="form-label">数据变量</span><input v-model.trim="action.itemVariable" class="form-input" placeholder="item" /></label>
          <label class="form-group"><span class="form-label">序号变量</span><input v-model.trim="action.indexVariable" class="form-input" placeholder="loop_index" /></label>
          <label class="form-group"><span class="form-label">迭代上限</span><input v-model.number="action.maxIterations" class="form-input" type="number" min="0" max="500" /></label>
          <label class="form-group"><span class="form-label">条目间隔 (ms)</span><input v-model.number="action.delayMs" class="form-input" type="number" min="0" max="3600000" /></label>
          <label class="form-group"><span class="form-label">失败策略</span><select v-model="action.onError" class="form-select"><option value="stop">失败即停止</option><option value="continue">跳过失败继续</option></select></label>
        </div>
        <div v-if="action.source === 'warehouse'" class="workflow-line">
          <label class="form-check"><input v-model="action.onlyUnprocessed" type="checkbox" />仅未处理</label>
          <label class="form-check"><input v-model="action.markProcessed" type="checkbox" />每条成功后标记已处理</label>
        </div>
        <WorkflowActionsEditor :actions="action.actions" :depth="depth + 1" :folders="resolvedFolders" />
      </template>

      <div v-else-if="action.type === 'finish'" class="workflow-line">
        <select v-model="action.status" class="form-select" aria-label="结束状态"><option value="success">成功</option><option value="failed">失败</option></select>
        <input v-model="action.message" class="form-input" aria-label="结束消息" placeholder="结束消息" />
      </div>
      <label v-else-if="action.type === 'save_message_link'" class="form-group"><span class="form-label">目标变量</span><input v-model.trim="action.variable" class="form-input" placeholder="message_link" /></label>
      <template v-else-if="action.type === 'save_data'">
        <div class="workflow-line">
          <label class="form-group"><span class="form-label">文件夹</span>
            <select v-model.number="action.folderId" class="form-select">
              <option :value="undefined" disabled>选择文件夹</option>
              <option v-for="folder in resolvedFolders" :key="folder.id" :value="folder.id">{{ folder.name }} (#{{ folder.id }})</option>
            </select>
          </label>
          <label class="form-group"><span class="form-label">匹配正则</span><input v-model="action.regex" class="form-input" placeholder="code=(?<code>[^&]+)" maxlength="500" /></label>
        </div>
        <div class="workflow-line">
          <label class="form-group"><span class="form-label">记录名模板</span><input v-model="action.key" class="form-input" placeholder="{code}" maxlength="256" /></label>
          <label class="form-group"><span class="form-label">记录值模板</span><input v-model="action.value" class="form-input" placeholder='{"code":"{code}"}' maxlength="32768" /></label>
        </div>
        <div style="font-size:11px;color:#888;margin-bottom:8px">支持 {match}、{accountName}、{accountPhone} 及命名捕获组；同文件夹同名记录会跳过。</div>
      </template>

      <template v-else-if="action.type === 'send_command' || action.type === 'send_contact_message'">
        <label v-if="action.type === 'send_contact_message'" class="form-group"><span class="form-label">联系人</span><input v-model.trim="action.contact" class="form-input" placeholder="@username" /></label>
        <label class="form-group"><span class="form-label">消息</span><textarea v-model="action.content" class="form-input" rows="2" /></label>
      </template>
      <template v-else-if="action.type === 'wait_reply'">
        <label class="form-group"><span class="form-label">超时 (ms)</span><input v-model.number="action.maxWaitMs" class="form-input" type="number" min="100" /></label>
        <div class="workflow-line">
          <label class="form-group"><span class="form-label">成功包含</span><input v-model="action.successContains" class="form-input" /></label>
          <label class="form-group"><span class="form-label">失败包含</span><input v-model="action.failContains" class="form-input" /></label>
        </div>
      </template>
      <label v-else-if="action.type === 'delay'" class="form-group"><span class="form-label">等待 (ms)</span><input v-model.number="action.waitMs" class="form-input" type="number" min="0" /></label>
      <template v-else-if="action.type === 'save_tag'">
        <div class="workflow-line"><input v-model.trim="action.name" class="form-input" aria-label="标签名" /><input v-model="action.value" class="form-input" aria-label="标签值" /></div>
        <input v-model="action.regex" class="form-input" aria-label="提取正则" placeholder="正则表达式（可选）" />
      </template>
      <template v-else-if="action.type === 'click_button' || action.type === 'click_message_button'">
        <input v-if="action.type === 'click_message_button'" v-model.trim="action.contact" class="form-input" aria-label="联系人" placeholder="@username" />
        <input v-model="action.button" class="form-input" aria-label="按钮文本" placeholder="按钮文本" />
        <label class="form-group"><span class="form-label">超时 (ms)</span><input v-model.number="action.maxWaitMs" class="form-input" type="number" min="100" /></label>
      </template>
      <template v-else-if="action.type === 'watch_buttons'">
        <div class="workflow-line">
          <input v-model.trim="action.groupId" class="form-input" aria-label="监视群组" placeholder="@group / t.me/..." />
          <input v-model.trim="action.button" class="form-input" aria-label="按钮文本" placeholder="领取红包" />
        </div>
        <div class="workflow-line">
          <input :value="action.alsoWatchButtons?.join(',') ?? ''" @input="action.alsoWatchButtons = inputValue($event).split(/[,，]/).map((v) => v.trim()).filter(Boolean)" class="form-input" aria-label="同时监视按钮" placeholder="按钮2,按钮3（可选）" />
          <label class="form-group"><span class="form-label">监听时长 (ms)</span><input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" /></label>
          <label class="form-group"><span class="form-label">每份最低</span><input v-model.number="action.minShare" class="form-input" type="number" min="0" /></label>
        </div>
        <div class="workflow-line">
          <input :value="action.thankYou?.join(',') ?? ''" @input="action.thankYou = inputValue($event).split(/[,，]/).map((v) => v.trim()).filter(Boolean)" class="form-input" aria-label="感谢语" placeholder="感谢语（逗号分隔，可选）" />
          <label class="form-check"><input v-model="action.thankAsReply" type="checkbox" />回复红包感谢</label>
        </div>
        <div class="workflow-line">
          <input v-model.trim="action.thankAiHint" class="form-input" aria-label="AI 感谢提示" placeholder="AI 感谢提示（可选）" />
          <input v-model.trim="action.thankWhenContains" class="form-input" aria-label="感谢条件" placeholder="回调结果包含（可选）" />
        </div>
        <div class="workflow-line">
          <label class="form-group"><span class="form-label">感谢延迟最小(ms)</span><input v-model.number="action.thankDelayMinMs" class="form-input" type="number" min="0" /></label>
          <label class="form-group"><span class="form-label">感谢延迟最大(ms)</span><input v-model.number="action.thankDelayMaxMs" class="form-input" type="number" min="0" /></label>
        </div>
        <div class="workflow-line">
          <input v-model.trim="action.forwardPrivateTo" class="form-input" aria-label="私聊转发目标" placeholder="私聊遮码转发到群/频道（可选）" />
          <input v-model.trim="action.forwardTemplate" class="form-input" aria-label="转发模板" placeholder="转发模板：{message} / {code} / {gift}" />
          <label class="form-group"><span class="form-label">转发等待(ms)</span><input v-model.number="action.forwardWaitMs" class="form-input" type="number" min="100" max="120000" /></label>
        </div>
      </template>
      <template v-else-if="action.type === 'watch_codes'">
        <div class="workflow-line">
          <input v-model.trim="action.groupId" class="form-input" aria-label="抢码群组" placeholder="@group / t.me/..." />
          <input v-model.trim="action.bot" class="form-input" aria-label="抢码机器人" placeholder="目标机器人（留空使用任务机器人）" />
        </div>
        <div class="workflow-line">
          <input v-model="action.regex" class="form-input" aria-label="注册码正则" placeholder="/CODE-[A-Z0-9]+/i 或 (?<code>...)" maxlength="500" />
          <input v-model="action.command" class="form-input" aria-label="发送命令" placeholder="/start {code}" maxlength="1024" />
        </div>
        <div class="workflow-line">
          <label class="form-group"><span class="form-label">监听时长 (ms)</span><input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" /></label>
          <label class="form-group"><span class="form-label">旧码宽限 (ms)</span><input v-model.number="action.maxCodeAgeMs" class="form-input" type="number" min="0" /></label>
          <label class="form-group"><span class="form-label">回复等待 (ms)</span><input v-model.number="action.replyWaitMs" class="form-input" type="number" min="100" /></label>
        </div>
        <div class="workflow-line">
          <input v-model.trim="action.successContains" class="form-input" aria-label="成功文字" placeholder="成功文字（可选，多个用 |）" />
          <input v-model.trim="action.failContains" class="form-input" aria-label="失败文字" placeholder="失败文字（可选，多个用 |）" />
        </div>
        <div style="font-size:11px;color:#888;margin-bottom:8px">首个捕获组作为注册码；若没有捕获组则使用完整匹配。成功后注册码写入 {code}，后续动作继续处理机器人的回复。</div>
      </template>
      <template v-else-if="action.type === 'mini_app_http'">
        <div class="workflow-line">
          <input v-model.trim="action.bot" class="form-input" aria-label="机器人" placeholder="@bot（可选，默认任务机器人）" />
          <input v-model.trim="action.url" class="form-input" aria-label="小程序接口地址" placeholder="https://app.example/api/status 或 /api/status" />
        </div>
        <div class="workflow-line">
          <select v-model="action.method" class="form-select" aria-label="请求方法"><option value="GET">GET</option><option value="POST">POST</option></select>
          <select v-model="action.contentType" class="form-select" aria-label="内容类型"><option value="application/json">application/json</option><option value="application/x-www-form-urlencoded">application/x-www-form-urlencoded</option><option value="text/plain">text/plain</option></select>
          <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="100" max="300000" aria-label="超时" placeholder="超时(ms)" />
        </div>
        <textarea v-if="action.method === 'POST'" v-model="action.body" class="form-input" rows="3" aria-label="请求体" placeholder="请求体（最多 64 KiB）" />
        <div class="workflow-line">
          <input v-model.trim="action.responseVariable" class="form-input" aria-label="响应变量" placeholder="响应变量（可选）" />
          <input v-model.trim="action.statusVariable" class="form-input" aria-label="状态变量" placeholder="状态变量（可选）" />
        </div>
        <div class="workflow-line">
          <input v-model.trim="action.successContains" class="form-input" aria-label="成功文字" placeholder="成功包含（可选）" />
          <input v-model.trim="action.failContains" class="form-input" aria-label="失败文字" placeholder="失败包含（可选）" />
        </div>
        <label class="form-check"><input v-model="action.sendInitData" type="checkbox" />显式发送 Telegram initData</label>
        <div style="font-size:11px;color:#888;margin-bottom:8px">仅访问 Telegram 签名地址的同源接口；不会执行网页脚本，也不会跟随到其他域名。</div>
      </template>
      <template v-else-if="action.type === 'join_group'">
        <input v-model="action.groupId" class="form-input" aria-label="群组" placeholder="@group / t.me/..." />
        <label class="form-check"><input v-model="action.checkMembership" type="checkbox" />已加入时跳过</label>
        <label class="form-check"><input v-model="action.alreadyMemberEndsTask" type="checkbox" />已是成员时结束任务</label>
      </template>
      <template v-else-if="action.type === 'subscribe_channel'"><input v-model="action.channelId" class="form-input" aria-label="频道" placeholder="@channel" /><label class="form-check"><input v-model="action.checkMembership" type="checkbox" />已加入时跳过</label></template>
      <template v-else-if="action.type === 'leave_group'"><input v-model="action.groupId" class="form-input" aria-label="群组" placeholder="@group / t.me/..." /></template>
      <template v-else-if="action.type === 'unsubscribe_channel'"><input v-model="action.channelId" class="form-input" aria-label="频道" placeholder="@channel / t.me/..." /></template>
      <template v-else-if="action.type === 'open_url'"><input v-model="action.url" class="form-input" aria-label="网址" placeholder="https://" /><label class="form-group"><span class="form-label">浏览器预算 (ms)</span><input v-model.number="action.maxWaitMs" class="form-input" type="number" min="0" /></label></template>
      <template v-else-if="action.type === 'open_mini_app' || action.type === 'open_mini_app_url' || action.type === 'open_bot_menu_app'">
        <input v-model="action.contact" class="form-input" aria-label="机器人" placeholder="@bot（可选）" />
        <input v-if="action.type === 'open_mini_app_url'" v-model="action.url" class="form-input" aria-label="小程序网址" placeholder="https://" />
        <input v-if="action.type === 'open_mini_app'" v-model="action.button" class="form-input" aria-label="小程序按钮" />
      </template>
      <label v-else-if="action.type === 'enter_captcha'" class="form-group"><span class="form-label">验证码长度</span><input v-model.number="action.captchaLength" class="form-input" type="number" min="1" max="20" /></label>
      <label v-else-if="action.type === 'ai_multiple_btn'" class="form-group"><span class="form-label">AI 按钮提示</span><input v-model="action.hint" class="form-input" /></label>
    </div>
    <button v-if="!single && depth <= 8" type="button" class="btn btn-ghost btn-sm" @click="actions.push(defaultWorkflowAction())"><i class="fa-solid fa-plus"></i> 添加动作</button>
    <div v-if="loadError" class="error-msg">{{ loadError }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { advancedActionOptions, defaultWorkflowAction, type CustomAction, type VariableAssignment } from "../api/automation";
import { warehouseApi, type WarehouseFolder } from "../api/warehouse";
import { t } from "../i18n";
defineOptions({ name: "WorkflowActionsEditor" });
const props = withDefaults(defineProps<{ actions: CustomAction[]; single?: boolean; depth?: number; folders?: WarehouseFolder[] }>(), { single: false, depth: 0 });
const localFolders = ref<WarehouseFolder[]>([]);
const loadError = ref("");
const resolvedFolders = computed(() => props.folders ?? localFolders.value);
const options: { type: CustomAction["type"]; label: string }[] = [
  { type: "send_command", label: "发送命令" }, { type: "send_contact_message", label: "发送给联系人" },
  { type: "wait_reply", label: "等待回复" }, { type: "delay", label: "等待" }, { type: "save_tag", label: "保存标签" },
  { type: "click_button", label: "点击按钮" }, { type: "click_message_button", label: "点击联系人按钮" },
  { type: "watch_buttons", label: "持续监视并点击按钮" },
  { type: "watch_codes", label: "持续监视并抢码" },
  { type: "mini_app_http", label: "小程序 HTTP 请求" },
  { type: "join_group", label: "加入群组" }, { type: "subscribe_channel", label: "订阅频道" },
  { type: "leave_group", label: "退出群组" }, { type: "unsubscribe_channel", label: "取消订阅频道" },
  { type: "open_url", label: "打开网页" }, { type: "open_mini_app", label: "打开小程序按钮" },
  { type: "open_mini_app_url", label: "打开小程序网址" }, { type: "open_bot_menu_app", label: "打开菜单小程序" },
  { type: "enter_captcha", label: "AI 验证码" }, { type: "ai_multiple_btn", label: "AI 多按钮" },
  ...advancedActionOptions,
];
function inputValue(event: Event) { return (event.target as HTMLInputElement).value; }
function changeType(index: number, event: Event) { props.actions.splice(index, 1, defaultWorkflowAction(inputValue(event) as CustomAction["type"])); }
function move(index: number, offset: number) { const [action] = props.actions.splice(index, 1); props.actions.splice(index + offset, 0, action); }
function valueMode(assignment: VariableAssignment) {
  return assignment.valueMode ?? (typeof assignment.value === "string" ? "text" : typeof assignment.value === "number" ? "number" : typeof assignment.value === "boolean" ? "boolean" : "json");
}
function changeValueMode(assignment: VariableAssignment, event: Event) {
  const mode = inputValue(event) as NonNullable<VariableAssignment["valueMode"]>;
  assignment.valueMode = mode;
  delete assignment.valueDraft;
  assignment.value = mode === "number" ? 0 : mode === "boolean" ? false : mode === "json" ? [] : "";
}
onMounted(async () => {
  if (props.folders !== undefined) return;
  try { localFolders.value = await warehouseApi.folders(); } catch { loadError.value = "无法读取数据仓库文件夹"; }
});
</script>

<style scoped>
.workflow-editor { min-width: 0; }
.workflow-row { border-left: 2px solid #b8c9d3; padding: 8px 0 8px 10px; margin-top: 8px; }
.workflow-header { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
.workflow-header .form-select { flex: 1; min-width: 0; }
.workflow-index { width: 18px; flex: 0 0 18px; color: #777; font-size: 12px; }
.workflow-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
.workflow-line > .form-input, .workflow-line > .form-select, .workflow-line > .form-group { flex: 1; min-width: 100px; margin-bottom: 0; }
.workflow-editor > div > .form-input { margin-bottom: 8px; }
.variable-row { display: grid; gap: 6px; margin-bottom: 12px; }
.workflow-branch { margin: 8px 0; }
.workflow-branch summary { cursor: pointer; font-size: 13px; font-weight: 600; padding: 6px 0; }
@media (max-width: 600px) { .workflow-row { padding-left: 6px; } .workflow-header { flex-wrap: wrap; } .workflow-header .form-select { min-width: 110px; } }
</style>
