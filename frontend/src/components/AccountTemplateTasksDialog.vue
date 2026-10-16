<template>
  <div class="modal-backdrop">
    <section ref="modalElement" class="modal workflow-modal" role="dialog" aria-modal="true" tabindex="-1" :aria-label="w(mode === 'create' ? 'createJobs' : 'runJobs')" @keydown="onKeydown">
      <header class="workflow-heading">
        <h3 class="modal-title">{{ w(mode === "create" ? "createJobs" : "runJobs") }}</h3>
        <button type="button" class="btn btn-ghost btn-icon" :disabled="busy" :title="w('close')" :aria-label="w('close')" @click="close"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <div class="workflow-body">
        <div class="workflow-counts">
          <span>{{ w("selectedAccounts") }} <strong>{{ accounts.length }}</strong></span>
          <span>{{ w("selectedTemplates") }} <strong>{{ selectedTemplates.length }}</strong></span>
        </div>
        <div class="template-search">
          <input v-model="search" class="form-input" :disabled="busy" :placeholder="w('searchTemplates')" :aria-label="w('searchTemplates')" />
          <select v-model="jobType" class="form-select" :disabled="busy" :aria-label="w('allTypes')">
            <option value="">{{ w("allTypes") }}</option>
            <option v-for="type in jobTypes" :key="type" :value="type">{{ t(`logs.jobType.${type}`) }}</option>
          </select>
          <select v-model="category" class="form-select" :disabled="busy" :aria-label="tw('category')">
            <option value="">{{ tw("allCategories") }}</option>
            <option v-for="key in templateCategories" :key="key" :value="key">{{ tw(key) }}</option>
          </select>
        </div>
        <div v-if="templatesError" class="error-msg" role="alert">{{ templatesError }}</div>
        <div v-if="eligibilityError" class="error-msg" role="alert">{{ eligibilityError }}</div>
        <div class="template-options" :aria-busy="templatesLoading || eligibilityLoading">
          <label v-for="template in templates" :key="template.id" class="template-option" :class="{ 'template-unavailable': templateUnavailable(template) }">
            <input type="checkbox" :checked="selected.has(template.id)" :disabled="busy || (templateUnavailable(template) && !selected.has(template.id))" @change="toggleTemplate(template)" />
            <span class="template-option-name"><strong>{{ template.name }}</strong><span>{{ template.botUsername }}</span></span>
            <span v-if="mode === 'create'" class="template-eligibility" :title="eligibilityTitle(template)">{{ eligibilityText(template) }}</span>
            <span class="badge badge-grey">{{ t(`logs.jobType.${template.jobType}`) }}</span>
          </label>
          <div v-if="!templates.length" class="workflow-empty">{{ w(templatesLoading ? "loading" : "noTemplates") }}</div>
        </div>
        <PaginationBar v-model:page="page" v-model:page-size="pageSize" :total="total" />
        <div v-if="selectedTemplates.length" class="selected-templates">
          <button v-for="template in selectedTemplates" :key="template.id" type="button" class="selected-template" :disabled="busy" :title="`${w('remove')}: ${template.name}`" @click="toggleTemplate(template)">
            {{ template.name }} <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <template v-if="mode === 'run'">
          <div class="workflow-grid">
            <label class="form-group"><span class="form-label">{{ w("concurrency") }}</span><input v-model.number="concurrency" type="number" min="1" max="20" step="1" class="form-input" :disabled="busy" /></label>
            <label class="form-group"><span class="form-label">{{ w("startInterval") }}</span><input v-model.number="startInterval" type="number" min="0" max="3600" step="1" class="form-input" :disabled="busy" /></label>
          </div>
          <label class="workflow-check"><input v-model="useSuccessTags" type="checkbox" :disabled="busy" />{{ w("useSuccessTags") }}</label>
          <AccountTagEditor v-if="useSuccessTags" v-model="successTags" :disabled="busy" />
        </template>

        <template v-else>
          <div class="workflow-grid">
            <label class="form-group"><span class="form-label">{{ w("windowStart") }}</span><input v-model="windowStart" type="time" class="form-input" :disabled="busy || allCreated" /></label>
            <label class="form-group"><span class="form-label">{{ w("windowEnd") }}</span><input v-model="windowEnd" type="time" class="form-input" :disabled="busy || allCreated" /></label>
            <label class="form-group"><span class="form-label">{{ w("maxAccounts") }}</span><input v-model.number="maxAccounts" type="number" min="1" max="2000" step="1" class="form-input" :disabled="busy || allCreated" /></label>
            <label class="form-group"><span class="form-label">{{ tw("templateLimit") }}</span><input v-model.number="maxTemplates" type="number" min="1" max="2000" step="1" class="form-input" :disabled="busy || hasCreated" /></label>
            <label class="workflow-check"><input v-model="enableCreated" type="checkbox" :disabled="busy || allCreated" />{{ w("enableCreated") }}</label>
          </div>
          <AccountCandidateFilters v-model="candidateFilters" :templates="allTemplates" :disabled="busy || allCreated" />
          <details v-for="group in groups" :key="group.template.id" class="creation-group" :open="groups.length === 1">
            <summary>
              <strong>{{ group.template.name }}</strong>
              <span>{{ w("candidateCount") }} {{ filteredRows(group).length }} / {{ group.rows.length }}</span>
              <span v-if="group.result" class="badge badge-green">{{ w("done") }}</span>
            </summary>
            <div v-if="group.loading" class="workflow-empty">{{ w("loading") }}</div>
            <div v-else-if="group.error" class="error-msg" role="alert">{{ group.error }}</div>
            <div v-else-if="!filteredRows(group).length" class="workflow-empty">{{ w("noCandidates") }}</div>
            <div v-else class="creation-rows">
              <div v-for="row in filteredRows(group)" :key="row.account.id" class="creation-row" :class="{ 'row-not-selected': !row.selected }">
                <label class="creation-account"><input v-model="row.selected" type="checkbox" :disabled="busy || !!group.result || !eligibleRow(group, row)" /><strong>{{ row.account.name }}</strong><span>{{ row.account.phoneNumber }}</span>
                  <span v-if="row.account.linked" class="badge badge-grey">{{ tw("linked") }}</span>
                  <span v-if="row.account.restriction" :class="isRestrictedAccount(row.account) ? 'badge badge-red' : 'badge badge-grey'">{{ restrictionLabel(row.account) }}</span>
                  <span v-if="candidateFilters.succeededTemplateId !== '' && row.account.successfulTemplateIds?.includes(Number(candidateFilters.succeededTemplateId))" class="badge badge-green">{{ tw("succeeded") }}</span>
                </label>
                <label><span class="form-label">{{ w("jobName") }}</span><input v-model="row.name" class="form-input" maxlength="200" :disabled="busy || !!group.result" /></label>
                <template v-if="group.template.jobType === 'embywatch'">
                  <label><span class="form-label">{{ w("embyUsername") }}</span><input v-model="row.username" class="form-input" autocomplete="off" :disabled="busy || !!group.result" /></label>
                  <label><span class="form-label">{{ w("embyPassword") }}</span><input v-model="row.password" type="password" class="form-input" autocomplete="new-password" :disabled="busy || !!group.result" /></label>
                  <button type="button" class="btn btn-sm btn-secondary" :disabled="busy || row.testing || !row.username.trim() || !!group.result" @click="validateEmby(group, row)">
                    <i class="fa-solid" :class="row.testing ? 'fa-spinner fa-spin' : 'fa-plug'"></i>{{ isVerified(group, row) ? w("valid") : w("validate") }}
                  </button>
                  <span v-if="row.error" class="creation-row-error">{{ row.error }}</span>
                </template>
              </div>
            </div>
            <div v-if="group.result" class="creation-result">{{ formatSummary(group.result.created, group.result.skipped) }}</div>
          </details>
        </template>
        <div v-if="error" class="error-msg" role="alert">{{ error }}</div>
        <div v-if="summary" class="workflow-result" role="status">{{ summary }}</div>
      </div>
      <footer class="modal-actions workflow-footer">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="close">{{ w(allCreated ? "close" : "cancel") }}</button>
        <button v-if="!allCreated" type="button" class="btn btn-primary" :disabled="busy || !selectedTemplates.length || groups.some(group => group.loading)" @click="submit">
          <i class="fa-solid" :class="busy ? 'fa-spinner fa-spin' : mode === 'run' ? 'fa-play' : 'fa-plus'"></i>
          {{ busy ? w("submitting") : mode === "run" ? w("submitQueue") : hasCreated ? w("retryCreate") : w("createJobs") }}
        </button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { templatesApi, jobsApi, type Account, type AvailableAccount, type JobTemplate, type TemplateCreationEligibility } from "../api/client";
import { taskQueueApi } from "../api/taskQueue";
import { tagsFromDraft, type TagDraft } from "../utils/accountTags";
import { t } from "../i18n";
import PaginationBar from "./PaginationBar.vue";
import AccountTagEditor from "./AccountTagEditor.vue";
import AccountCandidateFilters from "./AccountCandidateFilters.vue";
import { createLatestRequest } from "../utils/latestRequest";
import { canCreateTemplateJob, defaultCandidateFilters, isRestrictedAccount, matchesCandidateFilters, templateCategories, templateCreationAccountIds } from "../utils/templateWorkflow";

type CreateResult = { created: number; ids: number[]; skipped: number };
type CreationRow = { account: Account & AvailableAccount; selected: boolean; name: string; username: string; password: string; testedKey: string; testing: boolean; error: string };
type CreationGroup = { template: JobTemplate; rows: CreationRow[]; loading: boolean; error: string; result?: CreateResult };

const props = defineProps<{ accounts: Account[]; mode: "create" | "run" }>();
const emit = defineEmits<{ close: []; queued: [id: string, queued: number, skipped: number]; created: [] }>();
const w = (key: string) => t(`accountWorkflow.${key}`);
const tw = (key: string) => t(`templateWorkflow.${key}`);
function restrictionLabel(account: AvailableAccount) {
  return ["free", "mild", "limited", "blocked", "frozen"].includes(account.restriction ?? "")
    ? tw(account.restriction!) : account.restriction;
}
const modalElement = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;
const jobTypes = ["checkin", "custom", "embywatch", "autoreg"] as const;
const templates = ref<JobTemplate[]>([]);
const templatesLoading = ref(false);
const templatesError = ref("");
const eligibility = ref<TemplateCreationEligibility | null>(null);
const eligibilityLoading = ref(false);
const eligibilityError = ref("");
const eligibilityByTemplate = computed(() => new Map(eligibility.value?.templates.map((item) => [item.templateId, item]) ?? []));
const search = ref("");
const jobType = ref("");
const category = ref("");
const page = ref(1);
const pageSize = ref(25);
const total = ref(0);
const selected = ref(new Map<number, JobTemplate>());
const selectedTemplates = computed(() => [...selected.value.values()]);
const maxTemplates = ref(2000);
const activeTemplates = computed(() => props.mode !== "create" ? selectedTemplates.value
  : selectedTemplates.value.slice(0, Number.isInteger(maxTemplates.value) && maxTemplates.value > 0 ? maxTemplates.value : 0));
const groupCache = ref(new Map<number, CreationGroup>());
const groups = computed(() => props.mode === "create"
  ? activeTemplates.value.map((template) => groupCache.value.get(template.id)).filter((group): group is CreationGroup => Boolean(group)) : []);
const candidateFilters = ref(defaultCandidateFilters());
const allTemplates = ref<JobTemplate[]>([]);
const concurrency = ref(1);
const startInterval = ref(3);
const useSuccessTags = ref(false);
const successTags = ref<TagDraft[]>([]);
const windowStart = ref("13:00");
const windowEnd = ref("22:00");
const maxAccounts = ref(Math.max(1, Math.min(2000, props.accounts.length)));
const enableCreated = ref(false);
const busy = ref(false);
const error = ref("");
const summary = ref("");
const hasCreated = computed(() => groups.value.some((group) => group.result));
const allCreated = computed(() => props.mode === "create" && groups.value.length > 0 && groups.value.every((group) => group.result));
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const templateRequest = createLatestRequest({
  onStart: () => { templatesLoading.value = true; templatesError.value = ""; },
  onFinish: () => { templatesLoading.value = false; },
  onError: (err: any) => { templatesError.value = err.response?.data?.error ?? w("loadFailed"); },
});
const allTemplatesRequest = createLatestRequest({
  onError: (err: any) => { templatesError.value = err.response?.data?.error ?? w("loadFailed"); },
});
const eligibilityRequest = createLatestRequest({
  onStart: () => { eligibilityLoading.value = true; eligibilityError.value = ""; },
  onFinish: () => { eligibilityLoading.value = false; },
  onError: (err: any) => { eligibilityError.value = err.response?.data?.error ?? w("loadFailed"); },
});
const candidateRequests = new Map<number, ReturnType<typeof createLatestRequest>>();

async function loadEligibility() {
  if (props.mode !== "create") return;
  await eligibilityRequest.run(async ({ signal, commit }) => {
    const result = await templatesApi.creationEligibility(props.accounts.map((account) => account.id), signal);
    commit(() => { eligibility.value = result; });
  });
}
function templateUnavailable(template: JobTemplate) {
  const preview = eligibilityByTemplate.value.get(template.id);
  return props.mode === "create" && (eligibilityLoading.value
    || Boolean(eligibility.value && !preview?.eligibleCount));
}
function eligibilityText(template: JobTemplate) {
  if (!eligibility.value) return w(eligibilityError.value ? "loadFailed" : "loading");
  const preview = eligibilityByTemplate.value.get(template.id);
  const count = preview?.eligibleCount ?? 0;
  return tw("eligibleAccounts").replace("{count}", String(count)).replace("{total}", String(preview?.candidateCount ?? 0));
}
function eligibilityTitle(template: JobTemplate) {
  if (!eligibility.value) return "";
  const ids = new Set(templateCreationAccountIds(template, eligibility.value));
  const names = props.accounts.filter((account) => ids.has(account.id)).map((account) => account.name);
  return `${tw("eligibleAccountsTitle")}\n${names.join("\n") || tw("noEligibleAccounts")}`;
}
async function loadTemplates() {
  await templateRequest.run(async ({ signal, commit }) => {
    const result = await templatesApi.listPaged({
      page: page.value, pageSize: pageSize.value, search: search.value.trim() || undefined,
      jobType: jobType.value || undefined, category: category.value || undefined,
      ...(props.mode === "create" ? { enabled: "1" as const } : {}),
    }, signal);
    commit(() => { templates.value = result.items; total.value = result.total; });
  });
}
function toggleTemplate(template: JobTemplate) {
  if (busy.value) return;
  const next = new Map(selected.value);
  if (next.has(template.id)) next.delete(template.id);
  else {
    if (templateUnavailable(template)) return;
    next.set(template.id, template);
    if (props.mode === "create" && !groupCache.value.has(template.id)) {
      groupCache.value.set(template.id, { template, rows: [], loading: true, error: "" });
      void loadCandidates(template);
    }
  }
  selected.value = next;
  error.value = "";
  summary.value = "";
}
async function loadCandidates(template: JobTemplate) {
  const group = groupCache.value.get(template.id)!;
  const request = createLatestRequest({
    onFinish: () => { group.loading = false; },
    onError: (err: any) => { group.error = err.response?.data?.error ?? w("loadFailed"); },
  });
  candidateRequests.set(template.id, request);
  await request.run(async ({ signal, commit }) => {
    const available = new Map((await templatesApi.availableAccounts(template.id, { includeLinked: true }, signal)).map((account) => [account.id, account]));
    commit(() => {
      group.rows = props.accounts.filter((account) => available.has(account.id) && !account.disabled).map((account) => {
        const candidate = { ...account, ...available.get(account.id)! };
        return {
          account: candidate, selected: canCreateTemplateJob(candidate, template.jobType),
          name: `${template.name} - ${account.name}`, username: "", password: "", testedKey: "", testing: false, error: "",
        };
      });
    });
  });
}
function eligibleRow(group: CreationGroup, row: CreationRow) {
  return canCreateTemplateJob(row.account, group.template.jobType);
}
function filteredRows(group: CreationGroup) {
  return group.rows.filter((row) => matchesCandidateFilters(row.account, candidateFilters.value));
}
function activeRows(group: CreationGroup) {
  const limit = Number.isInteger(maxAccounts.value) && maxAccounts.value > 0 ? maxAccounts.value : 0;
  return filteredRows(group).filter((row) => row.selected && eligibleRow(group, row)).slice(0, limit);
}
function templateConfig(template: JobTemplate): Record<string, unknown> {
  try {
    let value = typeof template.config === "string" ? JSON.parse(template.config) : template.config;
    if (typeof value === "string") value = JSON.parse(value);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function embyTestInput(group: CreationGroup, row: CreationRow) {
  const config = templateConfig(group.template);
  return {
    serverUrl: group.template.botUsername,
    username: row.username.trim(),
    password: row.password,
    ...(typeof config.userAgent === "string" && config.userAgent ? { userAgent: config.userAgent } : {}),
    ...(typeof config.proxyId === "string" && config.proxyId ? { proxyId: config.proxyId } : {}),
  };
}
function isVerified(group: CreationGroup, row: CreationRow) {
  return Boolean(row.testedKey) && row.testedKey === JSON.stringify(embyTestInput(group, row));
}
async function validateEmby(group: CreationGroup, row: CreationRow): Promise<boolean> {
  row.error = "";
  row.testing = true;
  const input = embyTestInput(group, row);
  const key = JSON.stringify(input);
  try {
    if (!input.username) throw new Error(w("credentialsRequired"));
    const result = await jobsApi.testEmby(input);
    if (!result.ok) throw new Error(result.error || w("testFailed"));
    row.testedKey = key;
    return true;
  } catch (err: any) {
    row.testedKey = "";
    row.error = err.response?.data?.error ?? err.message ?? w("testFailed");
    return false;
  } finally {
    row.testing = false;
  }
}
function toHhmm(value: string): number | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.replace(":", ""));
}
function formatSummary(created: number, skipped: number) {
  return w("createSummary").replace("{created}", String(created)).replace("{skipped}", String(skipped));
}
function creationSummary() {
  const results = groups.value.flatMap((group) => group.result ? [group.result] : []);
  summary.value = formatSummary(results.reduce((count, result) => count + result.created, 0), results.reduce((count, result) => count + result.skipped, 0));
}
async function submit() {
  if (busy.value) return;
  error.value = "";
  summary.value = "";
  if (!props.accounts.length) { error.value = w("selectionRequired"); return; }
  if (!selectedTemplates.value.length) { error.value = w("templateRequired"); return; }
  if (props.mode === "run") {
    if (!Number.isInteger(concurrency.value) || concurrency.value < 1 || concurrency.value > 20
      || !Number.isInteger(startInterval.value) || startInterval.value < 0 || startInterval.value > 3600) {
      error.value = w("queueBounds"); return;
    }
    try {
      const tags = useSuccessTags.value ? tagsFromDraft(successTags.value) : undefined;
      busy.value = true;
      const result = await taskQueueApi.create({
        accountIds: props.accounts.map((account) => account.id),
        templateIds: selectedTemplates.value.map((template) => template.id),
        concurrency: concurrency.value,
        startIntervalSeconds: startInterval.value,
        ...(tags && Object.keys(tags).length ? { successTags: tags } : {}),
      });
      if (!disposed) emit("queued", result.batchId, result.queued, result.skipped);
    } catch (err: any) {
      if (!disposed) {
        const message = err.response?.data?.error ?? err.message ?? "";
        error.value = message.startsWith("tag") ? w(message) : message || w("queueFailed");
      }
    } finally {
      busy.value = false;
    }
    return;
  }
  const start = toHhmm(windowStart.value);
  const end = toHhmm(windowEnd.value);
  if (start === null || end === null) { error.value = w("timeRequired"); return; }
  if (end < start) { error.value = w("timeOrderRequired"); return; }
  if (!Number.isInteger(maxAccounts.value) || maxAccounts.value < 1 || maxAccounts.value > 2000) { error.value = w("maxAccountsRequired"); return; }
  if (!Number.isInteger(maxTemplates.value) || maxTemplates.value < 1 || maxTemplates.value > 2000) { error.value = tw("templateLimitInvalid"); return; }
  if (groups.value.some((group) => group.loading || group.error)) { error.value = w("loadFailed"); return; }
  busy.value = true;
  let createdAnything = false;
  try {
    for (const group of groups.value) {
      if (group.result) continue;
      const rows = activeRows(group);
      if (group.template.jobType === "embywatch") {
        for (const row of rows) {
          if (!isVerified(group, row) && !await validateEmby(group, row)) {
            error.value = `${group.template.name} / ${row.account.name}: ${row.error}`;
            creationSummary();
            return;
          }
        }
      }
      if (!rows.length) {
        group.result = { created: 0, ids: [], skipped: 0 };
        continue;
      }
      const payload = {
        jobs: rows.map((row) => ({
          accountId: row.account.id,
          name: row.name.trim() || `${group.template.name} - ${row.account.name}`,
          ...(group.template.jobType === "embywatch" ? { config: { username: row.username.trim(), password: row.password } } : {}),
        })),
        scheduleWindowStart: start,
        scheduleWindowEnd: end,
        enabled: enableCreated.value,
        maxAccounts: maxAccounts.value,
      };
      const result = await templatesApi.createJobs(group.template.id, payload);
      const skipped: unknown = result.skipped;
      group.result = {
        created: result.created,
        ids: result.ids,
        skipped: typeof skipped === "number" && Number.isInteger(skipped) && skipped >= 0
          ? skipped : Array.isArray(skipped) ? skipped.length : 0,
      };
      createdAnything ||= result.created > 0;
    }
    creationSummary();
  } catch (err: any) {
    if (!disposed) {
      error.value = err.response?.data?.error ?? w("createFailed");
      creationSummary();
    }
  } finally {
    busy.value = false;
    if (!disposed && createdAnything) {
      emit("created");
      void loadEligibility();
    }
  }
}
function close() {
  if (!busy.value) emit("close");
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = [...(modalElement.value?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex='0']") ?? [])]
    .filter((element) => element.getClientRects().length);
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) {
    event.preventDefault();
    modalElement.value?.focus();
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === modalElement.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
watch([search, jobType, category], () => {
  templateRequest.cancel();
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (page.value !== 1) page.value = 1;
    else void loadTemplates();
  }, 250);
});
watch([page, pageSize], () => void loadTemplates());
onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  void loadTemplates();
  if (props.mode === "create") {
    void loadEligibility();
    void allTemplatesRequest.run(async ({ signal, commit }) => {
      const result = await templatesApi.list(signal);
      commit(() => { allTemplates.value = result; });
    });
  }
  await nextTick();
  if (!disposed) modalElement.value?.querySelector<HTMLInputElement>("input:not([disabled])")?.focus();
});
onUnmounted(() => {
  disposed = true;
  templateRequest.dispose();
  allTemplatesRequest.dispose();
  eligibilityRequest.dispose();
  candidateRequests.forEach((request) => request.dispose());
  if (searchTimer) clearTimeout(searchTimer);
  if (previousFocus?.isConnected) previousFocus.focus();
});
</script>

<style scoped>
.workflow-modal { width: calc(100vw - 40px); max-width: 960px; max-height: calc(100dvh - 40px); display: flex; flex-direction: column; padding: 20px; }
.workflow-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0; }
.workflow-heading .modal-title { margin: 0; font-size: 18px; }
.workflow-body { display: grid; grid-auto-rows: max-content; gap: 14px; min-height: 0; overflow: auto; padding: 14px 2px; }
.workflow-counts { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: #5f6976; }
.workflow-counts strong { margin-left: 5px; color: #202a35; }
.template-search { display: grid; grid-template-columns: minmax(0, 1fr) repeat(2, minmax(120px, .35fr)); gap: 8px; }
.template-search .form-input, .template-search .form-select { min-width: 0; width: 100%; }
.template-options { max-height: 220px; overflow: auto; border-top: 1px solid #e0e5eb; border-bottom: 1px solid #e0e5eb; }
.template-option { display: flex; align-items: center; gap: 10px; padding: 9px 4px; cursor: pointer; border-bottom: 1px solid #edf0f3; }
.template-option-name { display: grid; gap: 3px; min-width: 0; flex: 1; overflow-wrap: anywhere; }
.template-option-name strong { font-size: 13px; font-weight: 500; }
.template-option-name > span { color: #6b7582; font-size: 12px; }
.template-option .badge { flex-shrink: 0; }
.template-eligibility { flex-shrink: 0; font-size: 12px; color: #5f6976; font-variant-numeric: tabular-nums; }
.template-unavailable { color: #75808c; cursor: default; }
.workflow-empty { padding: 18px 4px; color: #6b7582; font-size: 13px; }
.selected-templates { display: flex; flex-wrap: wrap; gap: 6px; }
.selected-template { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 5px 7px; border: 1px solid #cbd4df; background: #f7f9fb; border-radius: 4px; color: #3d4c5f; font-size: 12px; cursor: pointer; overflow-wrap: anywhere; text-align: left; }
.selected-template > i { flex-shrink: 0; }
.workflow-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: center; }
.workflow-grid .form-group { margin: 0; min-width: 0; }
.workflow-grid .form-input { width: 100%; min-width: 0; }
.workflow-check { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.creation-group { border-top: 1px solid #dce1e7; padding: 12px 0; min-width: 0; }
.creation-group > summary { cursor: pointer; font-size: 13px; overflow-wrap: anywhere; }
.creation-group > summary > strong { margin-right: 10px; }
.creation-group > summary > span { margin-right: 8px; font-size: 12px; color: #66717e; }
.creation-rows { display: grid; gap: 12px; padding-top: 12px; }
.creation-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: end; gap: 8px 12px; padding: 10px 0; border-bottom: 1px solid #e5e8ec; }
.creation-row > label, .creation-row .form-input { min-width: 0; width: 100%; }
.creation-account { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; grid-column: 1 / -1; font-size: 13px; overflow-wrap: anywhere; }
.creation-account span { color: #697684; font-size: 12px; }
.creation-row .form-label { font-size: 12px; }
.creation-row-error { grid-column: 1 / -1; color: #b53838; font-size: 12px; overflow-wrap: anywhere; }
.row-not-selected { opacity: .65; }
.creation-result, .workflow-result { color: #16745e; font-size: 13px; }
.creation-result { margin-top: 10px; }
.workflow-footer { margin-top: 0; padding-top: 12px; border-top: 1px solid #e2e7ec; flex-shrink: 0; }
@media (max-width: 600px) {
  .workflow-modal { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); padding: 14px; }
  .workflow-grid, .creation-row { grid-template-columns: minmax(0, 1fr); }
  .template-search { grid-template-columns: minmax(0, 1fr); }
  .template-option { flex-wrap: wrap; gap: 6px 8px; }
  .template-option-name { flex-basis: calc(100% - 30px); }
  .template-eligibility { margin-left: 24px; }
  .workflow-footer { flex-wrap: wrap; }
  .workflow-footer .btn { min-width: 0; white-space: normal; }
}
</style>
