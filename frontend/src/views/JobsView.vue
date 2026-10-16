<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t('jobs.title') }}</h2>
      <button class="btn btn-primary" @click="openAdd"><i class="fa-solid fa-plus"></i> {{ t('jobs.addBtn') }}</button>
    </div>

    <!-- Scheduler status; hidden when the operator moved it to its own menu entry -->
    <ScheduleList v-if="!scheduleSeparatePage" ref="scheduleListRef" collapsible @changed="loadJobs" />
    <TaskQueuePanel ref="taskQueueRef" @changed="loadJobs" />
    <div v-if="listError" class="error-msg" role="alert">{{ listError }}</div>
    <div v-if="outcomeWarning" class="error-msg" role="alert" style="display:flex;align-items:center;gap:8px">
      <span style="min-width:0;overflow-wrap:anywhere">{{ outcomeWarning }}</span>
      <button class="btn btn-ghost btn-icon" style="margin-left:auto;flex-shrink:0" :title="t('common.close')" :aria-label="t('common.close')" @click="outcomeWarning = ''"><i class="fa-solid fa-xmark"></i></button>
    </div>

    <div class="card">
      <!-- Filters -->
      <div style="padding:12px 16px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button
          v-for="opt in filterOptions" :key="opt.value"
          class="btn btn-sm"
          :class="filterType === opt.value ? 'btn-primary' : 'btn-ghost'"
          @click="filterType = opt.value"
        >{{ opt.label }}</button>
        <select v-if="accounts.length > 1" v-model="filterAccountId" class="form-select" style="width:160px;height:30px;font-size:13px;padding:0 8px">
          <option value="">{{ t('jobs.allAccounts') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
        </select>
        <select v-if="botUrlTplOptions.length > 1" v-model="filterBotUrlTpl" class="form-select" style="width:180px;height:30px;font-size:13px;padding:0 8px">
          <option value="">{{ t('jobs.allBotUrlTpl') }}</option>
          <option v-for="opt in botUrlTplOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <input v-model="filterName" class="form-input" style="width:160px;height:30px;font-size:13px;padding:0 8px" :placeholder="t('jobs.filterPlaceholder')" />
        <button
          class="btn btn-sm"
          :class="showLastSuccess ? 'btn-primary' : 'btn-ghost'"
          :title="t('jobs.toggleLastSuccessHint')"
          @click="showLastSuccess = !showLastSuccess"
        >
          <i class="fa-solid fa-clock-rotate-left"></i> {{ t('jobs.colLastSuccess') }}
        </button>
        <button v-if="jobs.length" class="btn btn-sm btn-secondary" style="margin-left:auto" @click="toggleAllJobs">
          {{ allJobsSelected ? t('common.deselectAll') : t('common.selectAll') }}
        </button>
      </div>
      <!-- Bulk action bar -->
      <div v-if="selectedJobIds.length" class="bulk-bar">
        <span class="bulk-count">{{ t('jobs.selectedCount').replace('{n}', String(selectedJobIds.length)) }}</span>
        <button class="btn btn-sm btn-success" @click="showBulkRunModal = true"><i class="fa-solid fa-play"></i> {{ t('jobs.bulkRun').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-secondary" @click="bulkEnableJobs"><i class="fa-solid fa-circle-check"></i> {{ t('jobs.bulkEnable').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-secondary" @click="confirmBulkDisableJobs = true"><i class="fa-solid fa-ban"></i> {{ t('jobs.bulkDisable').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-danger" @click="confirmBulkRetireJobs = true"><i class="fa-solid fa-box-archive"></i> {{ t('jobs.bulkRetire').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-secondary" @click="showBulkWindowModal = true"><i class="fa-solid fa-clock"></i> {{ t('jobs.bulkWindow').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-ghost" style="margin-left:auto" @click="selectedJobIds = []"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <PaginationBar
        :page="page" :page-size="pageSize" :total="total"
        @update:page="onPageChange" @update:page-size="onPageSizeChange"
      />
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="th-sort" :class="sortKey === 'name' ? 'sort-active' : ''" @click="setSort('name')">{{ t('common.name') }} <span class="sort-icon">{{ sortIcon('name') }}</span></th>
              <th class="th-sort" :class="sortKey === 'account' ? 'sort-active' : ''" @click="setSort('account')">{{ t('jobs.colAccount') }} <span class="sort-icon">{{ sortIcon('account') }}</span></th>
              <th class="th-sort" :class="sortKey === 'type' ? 'sort-active' : ''" @click="setSort('type')">{{ t('jobs.colType') }} <span class="sort-icon">{{ sortIcon('type') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'botUrl' ? 'sort-active' : ''" @click="setSort('botUrl')">{{ t('jobs.colBotUrlTpl') }} <span class="sort-icon">{{ sortIcon('botUrl') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'window' ? 'sort-active' : ''" @click="setSort('window')">{{ t('jobs.colWindow') }} <span class="sort-icon">{{ sortIcon('window') }}</span></th>
              <th v-if="showLastSuccess" class="th-sort" :class="sortKey === 'lastSuccess' ? 'sort-active' : ''" @click="setSort('lastSuccess')">{{ t('jobs.colLastSuccess') }} <span class="sort-icon">{{ sortIcon('lastSuccess') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'updated' ? 'sort-active' : ''" @click="setSort('updated')">{{ t('jobs.colUpdated') }} <span class="sort-icon">{{ sortIcon('updated') }}</span></th>
              <th class="th-sort" :class="sortKey === 'enabled' ? 'sort-active' : ''" @click="setSort('enabled')">{{ t('jobs.colEnabled') }} <span class="sort-icon">{{ sortIcon('enabled') }}</span></th>
              <th>{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!jobs.length">
              <td :colspan="showLastSuccess ? 8 : 7" class="empty">{{ t('jobs.noJobs') }}</td>
            </tr>
            <tr
              v-for="(j, idx) in jobs" :key="j.id"
              style="cursor:pointer"
              :class="selectedJobIds.includes(j.id) ? 'row-selected' : ''"
              @click="toggleJobSelect(j.id, idx, $event)"
            >
              <td>{{ j.name }}</td>
              <td>{{ jobAccountLabel(j) }}</td>
              <td><span :class="jobTypeBadge(j.jobType)">{{ t(`logs.jobType.${j.jobType}`) }}</span></td>
              <td class="col-hide-mobile">
                <template v-if="j.templateId">
                  <span class="badge badge-tpl" style="margin-left:0;margin-right:4px">T</span>{{ templates.find(t => t.id === j.templateId)?.name ?? '' }}
                </template>
                <template v-else>{{ j.jobType === 'embywatch' ? j.botUsername : '@' + j.botUsername }}</template>
              </td>
              <td class="col-hide-mobile">{{ fmtWindow(j.scheduleWindowStart, j.scheduleWindowEnd) }}</td>
              <td v-if="showLastSuccess">
                <span v-if="j.lastSuccessAt" class="last-success" :title="fmtDateTimeFull(j.lastSuccessAt)">{{ fmtSince(j.lastSuccessAt) }}</span>
                <span v-else class="last-success-never">{{ t('jobs.neverSucceeded') }}</span>
              </td>
              <td class="col-hide-mobile">
                <span
                  :title="`${t('jobs.updatedAt')}: ${fmtDateTimeFull(j.updatedAt || j.createdAt)}&#10;${t('jobs.createdAt')}: ${fmtDateTimeFull(j.createdAt)}`"
                >{{ fmtSince(j.updatedAt || j.createdAt) }}</span>
              </td>
              <td>
                <span
                  :class="j.enabled ? 'badge badge-green' : 'badge badge-grey'"
                  style="cursor:pointer;user-select:none"
                  @click.stop="toggleEnabled(j)"
                >
                  {{ j.enabled ? t('common.yes') : t('common.no') }}
                </span>
              </td>
              <td @click.stop>
                <!-- desktop: icon buttons -->
                <div class="actions hide-mobile">
                  <button class="btn btn-sm btn-success btn-icon" :disabled="running.has(j.id)" :title="t('common.run')" @click="runNow(j.id)">
                    <i class="fa-solid fa-play"></i>
                  </button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="t('common.edit')" @click="openEdit(j)"><i class="fa-solid fa-pen"></i></button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="t('common.duplicate')" @click="openDuplicate(j)"><i class="fa-solid fa-copy"></i></button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="t('jobs.markSuccess')" @click="openOutcome(j, 'success')"><i class="fa-solid fa-check"></i></button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="t('jobs.markFailed')" @click="openOutcome(j, 'failed')"><i class="fa-solid fa-xmark"></i></button>
                  <button class="btn btn-sm btn-danger btn-icon" :title="t('common.retire')" @click="retire(j.id)"><i class="fa-solid fa-box-archive"></i></button>
                </div>
                <!-- mobile: single button opens action sheet -->
                <button class="btn btn-sm btn-ghost btn-icon show-mobile" @click="actionMenuJob = j">
                  <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Add / Edit modal -->
    <div v-if="showForm" class="modal-backdrop">
      <div class="modal" style="width:560px">
        <h3 class="modal-title">{{ t(editTarget ? 'jobs.editTitle' : 'jobs.addTitle') }}</h3>
        <div class="modal-body">
        <div v-if="formError" class="error-msg">{{ formError }}</div>

        <!-- Template selector + Enabled inline -->
        <div v-if="templates.length" style="display:flex;gap:12px;align-items:flex-end;margin-bottom:14px">
          <div style="flex:1">
            <label class="form-label">{{ t('templates.labelTemplate') }}</label>
            <select v-model="form.templateId" class="form-select" @change="onTemplateChange">
              <option :value="null">{{ t('templates.noTemplate') }}</option>
              <option v-for="tpl in templates.filter(t => t.enabled || t.id === form.templateId)" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
            </select>
          </div>
          <div style="padding-bottom:9px;white-space:nowrap">
            <label class="form-check">
              <input v-model="form.enabled" type="checkbox" />
              <span>{{ t('jobs.labelEnabled') }}</span>
            </label>
          </div>
        </div>

        <!-- Enabled standalone (no templates configured) -->
        <div v-else style="margin-bottom:14px">
          <label class="form-check">
            <input v-model="form.enabled" type="checkbox" />
            <span>{{ t('jobs.labelEnabled') }}</span>
          </label>
        </div>

        <!-- Template summary -->
        <div v-if="form.templateId && linkedTemplate" class="template-summary-card">
          <div class="template-summary-row">
            <span :class="jobTypeBadge(linkedTemplate.jobType)">{{ t(`logs.jobType.${linkedTemplate.jobType}`) }}</span>
            <span class="template-summary-detail">{{ linkedTemplate.jobType === 'embywatch' ? linkedTemplate.botUsername : '@' + linkedTemplate.botUsername }}</span>
          </div>
        </div>

        <!-- Name + Type (no template) | Name + Account (template, checkin/custom) -->
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelName') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="form.name" class="form-input" placeholder="Xxemby" />
          </div>
          <div v-if="!form.templateId" class="form-group">
            <label class="form-label">{{ t('jobs.labelType') }}</label>
            <select v-model="form.jobType" class="form-select" @change="onJobTypeChange">
              <option value="checkin">Check-in (签到)</option>
              <option value="embywatch">Emby Watch (观看)</option>
              <option value="custom">Custom (自定义)</option>
              <option value="autoreg">Auto Registration (抢注)</option>
            </select>
          </div>
          <div v-if="form.templateId && (form.jobType === 'checkin' || form.jobType === 'custom' || form.jobType === 'autoreg')" class="form-group">
            <label class="form-label">{{ t('jobs.labelAccount') }} <span style="color:#e63946">*</span></label>
            <select v-model="form.accountId" class="form-select">
              <option :value="null" disabled>{{ t('jobs.selectAccount') }}</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
            </select>
          </div>
        </div>

        <!-- Check-in: Account + Bot (no template only — when template, account is in the row above) -->
        <div v-if="form.jobType === 'checkin' && !form.templateId" class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelAccount') }} <span style="color:#e63946">*</span></label>
            <select v-model="form.accountId" class="form-select">
              <option :value="null" disabled>{{ t('jobs.selectAccount') }}</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelBot') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="form.botUsername" class="form-input" placeholder="SomeBotUsername" />
          </div>
        </div>

        <!-- Emby Watch: Server URL (hidden when template controls it) -->
        <div v-if="form.jobType === 'embywatch' && !form.templateId" class="form-group">
          <label class="form-label">{{ t('jobs.labelServerUrl') }} <span style="color:#e63946">*</span></label>
          <div style="display:flex;align-items:center;gap:6px">
            <select v-model="embyServer.protocol" class="form-select" style="width:88px;flex-shrink:0">
              <option value="https">https</option>
              <option value="http">http</option>
            </select>
            <span style="color:#aaa;font-size:13px;flex-shrink:0">://</span>
            <input v-model.trim="embyServer.host" class="form-input" placeholder="emby.xxxx.com" @paste="handleEmbyHostPaste" />
            <span style="color:#aaa;font-size:13px;flex-shrink:0">:</span>
            <input v-model.number="embyServer.port" class="form-input" type="number" min="1" max="65535" style="width:72px;flex-shrink:0" placeholder="443" />
          </div>
        </div>

        <!-- Emby credentials (always job-specific, shown even for template-linked jobs) -->
        <template v-if="form.jobType === 'embywatch'">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelEmbyUser') }} <span style="color:#e63946">*</span></label>
              <input v-model.trim="embyCfg.username" class="form-input" placeholder="Username" autocomplete="off" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelEmbyPass') }}</label>
              <input v-model="embyCfg.password" class="form-input" type="password" placeholder="Password" autocomplete="new-password" />
            </div>
          </div>
        </template>

        <!-- Linked Emby jobs may override only their playback duration. Blank follows
             the template; all other playback settings remain template-controlled. -->
        <template v-if="form.jobType === 'embywatch' && form.templateId">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">
                {{ t('jobs.labelPlayDuration') }}
              </label>
              <input
                v-model.number="embyCfg.playDuration"
                class="form-input"
                type="number"
                min="30"
                :placeholder="linkedTemplateDuration.playDuration || '300'"
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelPlayDurationMax') }}</label>
              <input
                v-model.number="embyCfg.playDurationMax"
                class="form-input"
                type="number"
                min="30"
                :placeholder="linkedTemplateDuration.playDurationMax || '600'"
              />
              <div style="font-size:11px;color:#aaa;margin-top:4px">{{ t('jobs.playDurationMaxHint') }}</div>
            </div>
          </div>
          <div class="template-duration-hint">
            {{ t('jobs.linkedDurationHint') }}
          </div>
        </template>

        <!-- embywatch-specific fields (hidden when template controls them) -->
        <template v-if="form.jobType === 'embywatch' && !form.templateId">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">
                {{ t('jobs.labelPlayDuration') }}
                <span style="color:#aaa;font-weight:400"> — {{ t('common.blankForDefault') }}</span>
              </label>
              <input v-model.number="embyCfg.playDuration" class="form-input" type="number" min="30" placeholder="300" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelPlayDurationMax') }}</label>
              <input v-model.number="embyCfg.playDurationMax" class="form-input" type="number" min="30" placeholder="600" />
              <div style="font-size:11px;color:#aaa;margin-top:4px">{{ t('jobs.playDurationMaxHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelUserAgent') }}</label>
            <select v-model="embyUaDropdown" class="form-select" @change="onUaDropdownChange">
              <option value="">{{ t('jobs.uaDefault') }}</option>
              <option v-for="p in uaPresets" :key="p.name" :value="p.name">{{ p.name }}</option>
              <option value="__custom__">{{ t('jobs.uaCustom') }}</option>
            </select>
            <textarea
              v-if="embyUaDropdown === '__custom__'"
              v-model.trim="embyCfg.userAgent"
              class="form-input"
              rows="2"
              style="margin-top:6px;resize:vertical"
              placeholder="Mozilla/5.0 ..."
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelLibrary') }}</label>
            <input v-model.trim="embyCfg.library" class="form-input" type="text" :placeholder="t('jobs.libraryPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:4px">{{ t('jobs.libraryHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelBackupUrl') }}</label>
            <input v-model.trim="embyCfg.backupUrl" class="form-input" type="text" placeholder="https://emby.backup.com" />
            <div style="font-size:11px;color:#aaa;margin-top:4px">{{ t('jobs.backupUrlHint') }}</div>
          </div>
          <div class="emby-rules-hint">{{ t('jobs.playbackRulesHint') }}</div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.markWatched" type="checkbox" />
              <span>{{ t('jobs.labelMarkWatched') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.markWatchedHint') }}</div>
          </div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.verifyPlayable" type="checkbox" />
              <span>{{ t('jobs.labelVerifyPlayable') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.verifyPlayableHint') }}</div>
          </div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.realWatch" type="checkbox" />
              <span>{{ t('jobs.labelRealWatch') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.realWatchHint') }}</div>
          </div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.sequencePlay" type="checkbox" />
              <span>{{ t('jobs.labelSequencePlay') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.sequencePlayHint') }}</div>
          </div>
        </template>
        <!-- embywatch optional account (always shown, job-specific) -->
        <div v-if="form.jobType === 'embywatch' && accounts.length > 0" class="form-group" style="margin-top:8px">
          <label class="form-label">
            {{ t('jobs.labelAccount') }}
            <span style="color:#aaa;font-weight:400"> — {{ t('jobs.accountOptionalHint') }}</span>
          </label>
          <select v-model="form.accountId" class="form-select">
            <option :value="null">{{ t('jobs.noAccount') }}</option>
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
          </select>
        </div>

        <!-- Custom: Account + Bot (no template — when template, account is in the Name row above) -->
        <template v-if="form.jobType === 'custom'">
          <TemplateOptionsEditor
            v-if="form.templateId"
            :options="customOptions"
            :values="customOptionValues"
          />
          <div v-if="!form.templateId" class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelAccount') }} <span style="color:#e63946">*</span></label>
              <select v-model="form.accountId" class="form-select">
                <option :value="null" disabled>{{ t('jobs.selectAccount') }}</option>
                <option v-for="a in accounts" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.custom.labelTarget') }}</label>
              <input v-model.trim="form.botUsername" class="form-input" placeholder="BotUsername" />
            </div>
          </div>

          <div v-if="!form.templateId" class="form-group">
            <label class="form-label">{{ t('jobs.custom.labelJobMaxRetries') }}</label>
            <input v-model.number="customJobMaxRetries" class="form-input" type="number" min="1" max="20" style="max-width:120px" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.jobMaxRetriesHint') }}</div>
          </div>

          <!-- Action chain builder (hidden when template controls it) -->
          <div v-if="!form.templateId" class="form-group">
            <label class="form-label">{{ t('jobs.custom.actions') }}</label>

            <div v-if="customActions.length === 0" style="font-size:13px;color:#aaa;padding:10px 0">
              {{ t('jobs.custom.noActions') }}
            </div>

            <div v-for="(action, i) in customActions" :key="i" class="custom-action-card">
              <!-- Row: step number + type selector + move/delete buttons -->
              <div class="custom-action-header">
                <span class="custom-action-num">{{ i + 1 }}</span>
                <select v-model="action.type" class="form-select custom-action-type-select" @change="onActionTypeChange(action)">
                  <option value="send_command">{{ t('jobs.custom.actionSendCommand') }}</option>
                  <option value="send_contact_message">{{ t('jobs.custom.actionSendContactMessage') }}</option>
                  <option value="wait_reply">{{ t('jobs.custom.actionWaitReply') }}</option>
                  <option value="delay">{{ t('jobs.custom.actionDelay') }}</option>
                  <option value="save_tag">{{ t('jobs.custom.actionSaveTag') }}</option>
                  <option v-for="option in advancedActionOptions" :key="option.type" :value="option.type">{{ option.label }}</option>
                  <option value="click_button">{{ t('jobs.custom.actionClickButton') }}</option>
                  <option value="click_message_button">{{ t('jobs.custom.actionClickMessageButton') }}</option>
                  <option value="watch_buttons">持续监视并点击按钮</option>
                  <option value="watch_codes">持续监视并抢码</option>
                  <option value="enter_captcha" :disabled="aiKeyMissing">{{ t('jobs.custom.actionEnterCaptcha') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                  <option value="join_group">{{ t('jobs.custom.actionJoinGroup') }}</option>
                  <option value="subscribe_channel">{{ t('jobs.custom.actionSubscribeChannel') }}</option>
                  <option value="leave_group">{{ t('jobs.custom.actionLeaveGroup') }}</option>
                  <option value="unsubscribe_channel">{{ t('jobs.custom.actionUnsubscribeChannel') }}</option>
                  <option value="open_mini_app" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenMiniApp') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                  <option value="open_mini_app_url" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenMiniAppUrl') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                  <option value="open_bot_menu_app" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenBotMenuApp') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                  <option value="mini_app_http">{{ t('jobs.custom.actionMiniAppHttp') }}</option>
                  <option value="open_url" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenUrl') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                </select>
                <button type="button" class="btn btn-ghost btn-sm btn-icon" :disabled="i === 0" @click="moveUp(i)"><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" class="btn btn-ghost btn-sm btn-icon" :disabled="i === customActions.length - 1" @click="moveDown(i)"><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" class="btn btn-danger btn-sm btn-icon" @click="removeAction(i)"><i class="fa-solid fa-xmark"></i></button>
              </div>

              <WorkflowActionsEditor v-if="isAdvancedAction(action.type)" :actions="[action.workflow]" single />
              <!-- send_command -->
              <div v-if="action.type === 'send_command'" class="custom-action-params">
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelContent') }}</label>
                    <select v-model="action.contentDropdown" class="form-select">
                      <option value="/start">/start</option>
                      <option value="/checkin">/checkin</option>
                      <option value="{aiInput}" :disabled="aiKeyMissing">{{ t('jobs.aiInputOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                      <option value="custom">{{ t('common.custom') }}...</option>
                    </select>
                    <input v-if="action.contentDropdown === 'custom'" v-model="action.contentCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
                    <template v-if="action.contentDropdown === '{aiInput}'">
                      <input v-model.trim="action.contentAiInputLength" class="form-input" style="margin-top:6px" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
                      <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
                      <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                    </template>
                    <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contentHint') }}</div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
              </div>
              <div v-if="action.type === 'watch_buttons'" class="custom-action-params">
                <input v-model.trim="action.groupId" class="form-input" placeholder="@group / t.me/..." />
                <input v-model.trim="action.button" class="form-input" placeholder="按钮文本" />
                <input v-model.trim="action.alsoWatchButtonsText" class="form-input" placeholder="同时监视按钮（逗号分隔，可选）" />
                <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" placeholder="监听时长(ms)" />
                <input v-model.number="action.minShare" class="form-input" type="number" min="0" placeholder="每份最低（可选）" />
                <input v-model.trim="action.thankYouText" class="form-input" placeholder="感谢语（逗号分隔，可选）" />
                <input v-model.trim="action.thankAiHint" class="form-input" placeholder="AI 感谢提示（可选）" />
                <input v-model.trim="action.thankWhenContains" class="form-input" placeholder="回调结果包含（可选）" />
                <input v-model.number="action.thankDelayMinMs" class="form-input" type="number" min="0" placeholder="感谢最小延迟(ms)" />
                <input v-model.number="action.thankDelayMaxMs" class="form-input" type="number" min="0" placeholder="感谢最大延迟(ms)" />
                <label class="form-check"><input v-model="action.thankAsReply" type="checkbox" />回复红包感谢</label>
                <input v-model.trim="action.forwardPrivateTo" class="form-input" placeholder="私聊遮码转发到群/频道（可选）" />
                <input v-model.trim="action.forwardTemplate" class="form-input" placeholder="转发模板：{message} / {code} / {gift}" />
                <input v-model.number="action.forwardWaitMs" class="form-input" type="number" min="100" max="120000" placeholder="转发等待(ms)" />
              </div>
              <div v-if="action.type === 'watch_codes'" class="custom-action-params">
                <input v-model.trim="action.groupId" class="form-input" placeholder="@group / t.me/..." />
                <input v-model.trim="action.watchCodeBot" class="form-input" placeholder="目标机器人（留空使用任务机器人）" />
                <input v-model="action.watchCodeRegex" class="form-input" placeholder="/CODE-[A-Z0-9]+/i 或 (?<code>...)" maxlength="500" />
                <input v-model="action.watchCodeCommand" class="form-input" placeholder="/start {code}" maxlength="1024" />
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group"><label class="form-label">监听时长 (ms)</label><input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" max="86400000" /></div>
                  <div class="form-group"><label class="form-label">旧码宽限 (ms)</label><input v-model.number="action.watchCodeMaxCodeAgeMs" class="form-input" type="number" min="0" max="86400000" /></div>
                  <div class="form-group"><label class="form-label">回复等待 (ms)</label><input v-model.number="action.watchCodeReplyWaitMs" class="form-input" type="number" min="100" max="600000" /></div>
                </div>
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group"><label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label><input v-model.trim="action.successContains" class="form-input" /></div>
                  <div class="form-group"><label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label><input v-model.trim="action.failContains" class="form-input" /></div>
                </div>
                <div style="font-size:11px;color:#aaa;margin-top:3px">首个捕获组作为注册码；没有捕获组时使用完整匹配。成功后注册码写入 {code}。</div>
              </div>

              <!-- send_contact_message -->
              <div v-if="action.type === 'send_contact_message'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelContact') }}</label>
                  <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contactHint') }}</div>
                </div>
                <div class="form-row" style="margin-bottom:0;margin-top:8px">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelContent') }}</label>
                    <select v-model="action.contentDropdown" class="form-select">
                      <option value="/start">/start</option>
                      <option value="/checkin">/checkin</option>
                      <option value="{aiInput}" :disabled="aiKeyMissing">{{ t('jobs.aiInputOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                      <option value="custom">{{ t('common.custom') }}...</option>
                    </select>
                    <input v-if="action.contentDropdown === 'custom'" v-model="action.contentCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
                    <template v-if="action.contentDropdown === '{aiInput}'">
                      <input v-model.trim="action.contentAiInputLength" class="form-input" style="margin-top:6px" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
                      <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
                      <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                    </template>
                    <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contentHint') }}</div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
              </div>

              <!-- wait_reply -->
              <div v-if="action.type === 'wait_reply'" class="custom-action-params">
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                    <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
                  <input v-model.number="action.scope" class="form-input" type="number" max="0" step="1" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
              </div>

              <!-- delay -->
              <div v-if="action.type === 'delay'" class="custom-action-params">
                <label class="form-label">{{ t('jobs.custom.labelWaitMs') }}</label>
                <input v-model.number="action.waitMs" class="form-input" type="number" min="100" step="500" />
              </div>

              <div v-if="action.type === 'save_tag'" class="custom-action-params">
                <div class="form-group">
                  <label class="form-label">{{ t('jobs.custom.labelTagName') }}</label>
                  <input v-model.trim="action.tagName" class="form-input" maxlength="96" />
                </div>
                <div class="form-group">
                  <label class="form-label">{{ t('jobs.custom.labelTagValue') }}</label>
                  <input v-model.trim="action.tagValue" class="form-input" maxlength="512" :disabled="!!action.tagRegex.trim()" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelTagRegex') }}</label>
                  <input v-model.trim="action.tagRegex" class="form-input" maxlength="500" :placeholder="t('jobs.custom.tagRegexPlaceholder')" />
                </div>
              </div>

              <!-- click_button -->
              <div v-if="action.type === 'click_button'" class="custom-action-params">
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelButton') }}</label>
                    <select v-model="action.buttonDropdown" class="form-select">
                      <option value="签到">签到</option>
                      <option value="{aiBtn}" :disabled="aiKeyMissing">{{ t('jobs.aiBtnOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                      <option value="{anyBtn}">{{ t('jobs.anyBtnOption') }}</option>
                      <option value="custom">{{ t('common.custom') }}...</option>
                    </select>
                    <input v-if="action.buttonDropdown === 'custom'" v-model="action.buttonCustom" class="form-input" style="margin-top:6px" placeholder="Custom button text" />
                    <template v-if="action.buttonDropdown === '{aiBtn}'">
                      <input v-model.trim="action.buttonAiHint" class="form-input" style="margin-top:6px" :placeholder="t('jobs.aiHintPlaceholder')" />
                      <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                      <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                    </template>
                    <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.buttonHint') }}</div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                  <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
                  <input v-model.number="action.scope" class="form-input" type="number" max="0" step="1" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.cfChallenge" :disabled="cfBrowserMissing" />
                    {{ t('jobs.custom.labelCfChallenge') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.cfChallengeHint') }}</div>
                  <div v-if="cfBrowserMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.cfBrowserWarning') }}</div>
                </div>
              </div>

              <!-- click_message_button -->
              <div v-if="action.type === 'click_message_button'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelContact') }}</label>
                  <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contactHint') }}</div>
                </div>
                <div class="form-row" style="margin-bottom:0;margin-top:8px">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelButton') }}</label>
                    <select v-model="action.buttonDropdown" class="form-select">
                      <option value="签到">签到</option>
                      <option value="{aiBtn}" :disabled="aiKeyMissing">{{ t('jobs.aiBtnOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                      <option value="{anyBtn}">{{ t('jobs.anyBtnOption') }}</option>
                      <option value="custom">{{ t('common.custom') }}...</option>
                    </select>
                    <input v-if="action.buttonDropdown === 'custom'" v-model="action.buttonCustom" class="form-input" style="margin-top:6px" placeholder="Custom button text" />
                    <template v-if="action.buttonDropdown === '{aiBtn}'">
                      <input v-model.trim="action.buttonAiHint" class="form-input" style="margin-top:6px" :placeholder="t('jobs.aiHintPlaceholder')" />
                      <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                      <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                    </template>
                    <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.buttonHint') }}</div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                  <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
                  <input v-model.number="action.scope" class="form-input" type="number" max="0" step="1" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.cfChallenge" :disabled="cfBrowserMissing" />
                    {{ t('jobs.custom.labelCfChallenge') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.cfChallengeHint') }}</div>
                  <div v-if="cfBrowserMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.cfBrowserWarning') }}</div>
                </div>
              </div>

              <!-- enter_captcha -->
              <div v-if="action.type === 'enter_captcha'" class="custom-action-params">
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                    <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelCaptchaLength') }}</label>
                    <input v-model.trim="action.captchaLength" class="form-input" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
                <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
              </div>

              <!-- join_group -->
              <div v-if="action.type === 'join_group'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelGroupId') }}</label>
                  <input v-model.trim="action.groupId" class="form-input" :placeholder="t('jobs.custom.groupIdPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.groupIdHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.checkMembership" />
                    {{ t('jobs.custom.labelCheckMembership') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.checkMembershipHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.alreadyMemberEndsTask" />
                    {{ t('jobs.custom.labelAlreadyMemberEndsTask') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.alreadyMemberEndsTaskHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelVerifyButton') }}</label>
                  <input v-model.trim="action.verifyButton" class="form-input" :placeholder="t('jobs.custom.verifyButtonPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.verifyButtonHint') }}</div>
                </div>
                <div v-if="action.verifyButton" class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelVerifyWaitMs') }}</label>
                  <input v-model.number="action.verifyWaitMs" type="number" min="1000" step="1000" class="form-input" />
                </div>
              </div>

              <!-- subscribe_channel -->
              <div v-if="action.type === 'subscribe_channel'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelChannelId') }}</label>
                  <input v-model.trim="action.channelId" class="form-input" :placeholder="t('jobs.custom.channelIdPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.channelIdHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.checkMembership" />
                    {{ t('jobs.custom.labelCheckSubscription') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.checkSubscriptionHint') }}</div>
                </div>
              </div>

              <div v-if="action.type === 'leave_group'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelGroupId') }}</label>
                  <input v-model.trim="action.groupId" class="form-input" :placeholder="t('jobs.custom.groupIdPlaceholder')" />
                </div>
              </div>

              <div v-if="action.type === 'unsubscribe_channel'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelChannelId') }}</label>
                  <input v-model.trim="action.channelId" class="form-input" :placeholder="t('jobs.custom.channelIdPlaceholder')" />
                </div>
              </div>

              <!-- open_mini_app / open_mini_app_url / open_bot_menu_app -->
              <div v-if="action.type === 'open_mini_app' || action.type === 'open_mini_app_url' || action.type === 'open_bot_menu_app'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ action.type === 'open_mini_app' ? t('jobs.custom.labelContactOptional') : action.type === 'open_mini_app_url' ? t('jobs.custom.labelMiniAppOwner') : t('jobs.custom.labelMenuAppOwner') }}</label>
                  <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactOptionalPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ action.type === 'open_mini_app' ? t('jobs.custom.contactOptionalHint') : action.type === 'open_mini_app_url' ? t('jobs.custom.miniAppOwnerHint') : t('jobs.custom.menuAppOwnerHint') }}</div>
                </div>
                <div v-if="action.type === 'open_mini_app_url'" class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelMiniAppUrl') }}</label>
                  <input v-model.trim="action.url" class="form-input" :placeholder="t('jobs.custom.miniAppUrlPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppUrlHint') }}</div>
                </div>
                <div v-if="action.type === 'open_mini_app'" class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelMiniAppButton') }}</label>
                  <input v-model.trim="action.button" class="form-input" :placeholder="t('jobs.custom.miniAppButtonPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppButtonHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelInAppButton') }}</label>
                  <input v-model.trim="action.appButton" class="form-input" :placeholder="t('jobs.custom.inAppButtonPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.inAppButtonHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
                <div class="form-row" style="margin-bottom:0;margin-top:8px">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMiniAppMaxWait') }}</label>
                    <input v-model.number="action.miniAppMaxWaitMs" class="form-input" type="number" min="0" step="10000" placeholder="300000" />
                  </div>
                </div>
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppMaxWaitHint') }}</div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelMiniAppProxy') }}</label>
                  <select v-model="action.miniAppProxyId" class="form-select">
                    <option value="">{{ t('jobs.custom.miniAppProxyJob') }}</option>
                    <option value="direct">{{ t('jobs.custom.miniAppProxyDirect') }}</option>
                    <option v-for="p in proxiesList" :key="p.id" :value="p.id">{{ p.name }}</option>
                  </select>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppProxyHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.miniAppTryAllProxies" />
                    {{ t('jobs.custom.labelMiniAppTryAll') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppTryAllHint') }}</div>
                </div>
              </div>

              <!-- mini_app_http -->
              <div v-if="action.type === 'mini_app_http'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">小程序接口地址</label>
                  <input v-model.trim="action.url" class="form-input" placeholder="https://app.example/api/status 或 /api/status" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">只允许访问 Telegram 签名页面的同源地址。</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">机器人（可选，默认任务机器人）</label>
                  <input v-model.trim="action.contact" class="form-input" placeholder="@bot" />
                </div>
                <div class="form-row" style="margin-bottom:0;margin-top:8px">
                  <div class="form-group">
                    <label class="form-label">请求方法</label>
                    <select v-model="action.method" class="form-select"><option value="GET">GET</option><option value="POST">POST</option></select>
                  </div>
                  <div class="form-group">
                    <label class="form-label">内容类型</label>
                    <select v-model="action.contentType" class="form-select"><option value="application/json">application/json</option><option value="application/x-www-form-urlencoded">application/x-www-form-urlencoded</option><option value="text/plain">text/plain</option></select>
                  </div>
                  <div class="form-group">
                    <label class="form-label">超时 (ms)</label>
                    <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="100" max="300000" />
                  </div>
                </div>
                <div v-if="action.method === 'POST'" class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">请求体（最多 64 KiB）</label>
                  <textarea v-model="action.body" class="form-input" rows="3" maxlength="65536" />
                </div>
                <div class="form-row" style="margin-bottom:0;margin-top:8px">
                  <div class="form-group"><label class="form-label">响应变量（可选）</label><input v-model.trim="action.responseVariable" class="form-input" placeholder="response_text" /></div>
                  <div class="form-group"><label class="form-label">状态变量（可选）</label><input v-model.trim="action.statusVariable" class="form-input" placeholder="http_status" /></div>
                </div>
                <div class="form-row" style="margin-bottom:0;margin-top:8px">
                  <div class="form-group"><label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label><input v-model.trim="action.successContains" class="form-input" /></div>
                  <div class="form-group"><label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label><input v-model.trim="action.failContains" class="form-input" /></div>
                </div>
                <label class="form-checkbox-label" style="margin-top:8px"><input type="checkbox" v-model="action.sendInitData" />显式发送 Telegram initData</label>
              </div>

              <!-- open_url -->
              <div v-if="action.type === 'open_url'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.web.labelUrl') }}</label>
                  <input v-model.trim="action.url" class="form-input" :placeholder="t('jobs.web.urlPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.web.urlHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:10px">
                  <WebStepsEditor :steps="action.webSteps" :ai-key-missing="aiKeyMissing" />
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
                <div class="form-row" style="margin-bottom:0;margin-top:8px">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMiniAppMaxWait') }}</label>
                    <input v-model.number="action.miniAppMaxWaitMs" class="form-input" type="number" min="0" step="10000" placeholder="300000" />
                  </div>
                </div>
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppMaxWaitHint') }}</div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelMiniAppProxy') }}</label>
                  <select v-model="action.miniAppProxyId" class="form-select">
                    <option value="">{{ t('jobs.custom.miniAppProxyJob') }}</option>
                    <option value="direct">{{ t('jobs.custom.miniAppProxyDirect') }}</option>
                    <option v-for="p in proxiesList" :key="p.id" :value="p.id">{{ p.name }}</option>
                  </select>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppProxyHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.miniAppTryAllProxies" />
                    {{ t('jobs.custom.labelMiniAppTryAll') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppTryAllHint') }}</div>
                </div>
              </div>
            </div>

            <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" @click="addAction">
              <i class="fa-solid fa-plus"></i> {{ t('jobs.custom.addAction') }}
            </button>
          </div>
        </template>

        <!-- Auto registration (hidden when template controls it) -->
        <template v-if="form.jobType === 'autoreg' && !form.templateId">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelAccount') }} <span style="color:#e63946">*</span></label>
              <select v-model="form.accountId" class="form-select">
                <option :value="null" disabled>{{ t('jobs.selectAccount') }}</option>
                <option v-for="a in accounts" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelBot') }} <span style="color:#e63946">*</span></label>
              <input v-model.trim="form.botUsername" class="form-input" placeholder="SomeBotUsername" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelGroup') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="autoregCfg.groupId" class="form-input" placeholder="@groupname" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.groupHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelCodePrefix') }} <span v-if="!autoregCfg.codeRegex" style="color:#e63946">*</span></label>
            <input v-model.trim="autoregCfg.codePrefix" class="form-input" placeholder="ABC-*-XYZ_" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.codePrefixHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelCodeRegex') }} <span v-if="!autoregCfg.codePrefix" style="color:#e63946">*</span></label>
            <input v-model.trim="autoregCfg.codeRegex" class="form-input" :placeholder="t('jobs.autoreg.codeRegexPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.codeRegexHint') }}</div>
            <div style="font-size:11px;color:#777;margin-top:3px">{{ t('jobs.autoreg.eitherPrefixOrRegex') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-check">
                <input v-model="autoregCfg.stripChinese" type="checkbox" />
                <span>{{ t('jobs.autoreg.labelStripChinese') }}</span>
              </label>
              <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.stripChineseHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelStripChars') }}</label>
              <input v-model.trim="autoregCfg.stripChars" class="form-input" :placeholder="t('jobs.autoreg.stripCharsPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.stripCharsHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-check">
              <input v-model="autoregCfg.aiModifyCode" type="checkbox" />
              <span>{{ t('jobs.autoreg.labelAiModifyCode') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.aiModifyCodeHint') }}</div>
          </div>
          <div v-if="autoregCfg.aiModifyCode" class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelAiModifyCodeHint') }}</label>
              <input v-model.trim="autoregCfg.aiModifyCodeHint" class="form-input" :placeholder="t('jobs.autoreg.aiModifyCodeHintPlaceholder')" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelAiContextCount') }}</label>
              <input v-model.number="autoregCfg.aiContextCount" class="form-input" type="number" min="0" max="50" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.aiContextCountHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelEntryMode') }}</label>
            <select v-model="autoregCfg.entryMode" class="form-select">
              <option value="button">{{ t('jobs.autoreg.entryModeButton') }}</option>
              <option value="command">{{ t('jobs.autoreg.entryModeCommand') }}</option>
            </select>
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.entryModeHint') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelStartCommand') }}</label>
              <select v-model="cmdDropdown" class="form-select">
                <option value="">({{ t('common.default') }}: /start)</option>
                <option value="/start">/start</option>
                <option value="custom">{{ t('common.custom') }}...</option>
              </select>
              <input v-if="cmdDropdown === 'custom'" v-model.trim="cmdCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
            </div>
            <div v-if="autoregCfg.entryMode === 'button'" class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelRegisterButton') }}</label>
              <input v-model.trim="autoregCfg.registerButton" class="form-input" :placeholder="t('jobs.autoreg.registerButtonPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.registerButtonHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelCodeReady') }}</label>
            <input v-model.trim="autoregCfg.codeReadyContains" class="form-input" :placeholder="t('jobs.autoreg.codeReadyPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.codeReadyHint') }}</div>
          </div>
          <!-- Some bots vet the code first, then offer a button/link that opens registration -->
          <div class="form-group">
            <label class="form-check">
              <input v-model="autoregCfg.clickAfterCode" type="checkbox" />
              <span>{{ t('jobs.autoreg.labelClickAfterCode') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.clickAfterCodeHint') }}</div>
          </div>
          <div v-if="autoregCfg.clickAfterCode" class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelAfterCodeButton') }}</label>
              <input v-model.trim="autoregCfg.afterCodeButton" class="form-input" :placeholder="t('jobs.autoreg.afterCodeButtonPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.afterCodeButtonHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-check">
                <input v-model="autoregCfg.afterCodeRequired" type="checkbox" />
                <span>{{ t('jobs.autoreg.labelAfterCodeRequired') }}</span>
              </label>
              <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.afterCodeRequiredHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelSignupUsername') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="autoregCfg.signupUsername" class="form-input" placeholder="myname{num:3}" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.signupUsernameHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelUsernameReady') }}</label>
            <input v-model.trim="autoregCfg.usernameReadyContains" class="form-input" :placeholder="t('jobs.autoreg.usernameReadyPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.usernameReadyHint') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelListenMinutes') }}</label>
              <input v-model.number="autoregCfg.listenMinutes" class="form-input" type="number" min="1" max="1440" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.listenMinutesHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelScanHistory') }}</label>
              <input v-model.number="autoregCfg.scanHistoryCount" class="form-input" type="number" min="0" max="100" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.scanHistoryHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelSuccessContains') }}</label>
            <input v-model.trim="autoregCfg.successContains" class="form-input" :placeholder="t('jobs.autoreg.successContainsPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.successContainsHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelFailContains') }}</label>
            <input v-model.trim="autoregCfg.failContains" class="form-input" :placeholder="t('jobs.autoreg.failContainsPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.failContainsHint') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelReplyTimeout') }}</label>
              <input v-model.number="form.replyTimeoutMs" class="form-input" type="number" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
              <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" />
            </div>
          </div>
        </template>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelWindowStart') }}</label>
            <input v-model.number="form.scheduleWindowStart" class="form-input" type="number" placeholder="1400" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelWindowEnd') }}</label>
            <input v-model.number="form.scheduleWindowEnd" class="form-input" type="number" placeholder="1600" />
          </div>
        </div>

        <!-- checkin-specific fields (hidden when template controls them) -->
        <template v-if="form.jobType === 'checkin' && !form.templateId">
          <div class="form-row" style="align-items:start">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelStartCommand') }}</label>
              <select v-model="cmdDropdown" class="form-select">
                <option value="">({{ t('common.default') }}: /start)</option>
                <option value="/start">/start</option>
                <option value="/checkin">/checkin</option>
                <option value="custom">{{ t('common.custom') }}...</option>
              </select>
              <input v-if="cmdDropdown === 'custom'" v-model.trim="cmdCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
              <div style="font-size:11px;color:#aaa;margin-top:4px">{{ t('jobs.startCommandHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelCheckinButton') }}</label>
              <select v-model="btnDropdown" class="form-select">
                <option value="">({{ t('common.default') }}: 签到)</option>
                <option value="签到">签到</option>
                <option value="{aiBtn}" :disabled="aiKeyMissing">{{ t('jobs.aiBtnOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                <option value="{anyBtn}">{{ t('jobs.anyBtnOption') }}</option>
                <option value="custom">{{ t('common.custom') }}...</option>
              </select>
              <input v-if="btnDropdown === 'custom'" v-model.trim="btnCustom" class="form-input" style="margin-top:6px" placeholder="Custom button text" />
              <template v-if="btnDropdown === '{aiBtn}'">
                <input v-model.trim="btnAiHint" class="form-input" style="margin-top:6px" :placeholder="t('jobs.aiHintPlaceholder')" />
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
              </template>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelReplyTimeout') }}</label>
              <input v-model.number="form.replyTimeoutMs" class="form-input" type="number" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
              <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" :disabled="!!form.templateId" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelSuccessContains') }}</label>
            <input v-model.trim="checkinSuccessContains" class="form-input" :placeholder="t('jobs.successContainsPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.successContainsHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelFailContains') }}</label>
            <input v-model.trim="checkinFailContains" class="form-input" :placeholder="t('jobs.failContainsPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.failContainsHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-checkbox-label">
              <input type="checkbox" v-model="checkinCfChallenge" :disabled="!!form.templateId || cfBrowserMissing" />
              {{ t('jobs.custom.labelCfChallenge') }}
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.cfChallengeHint') }}</div>
            <div v-if="cfBrowserMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.cfBrowserWarning') }}</div>
          </div>
        </template>

        <div v-if="form.jobType === 'custom'" class="form-group">
          <label class="form-checkbox-label">
            <input v-model="form.rerunOnRestart" type="checkbox" :disabled="!!form.templateId" />
            {{ t('jobOptions.rerunOnRestart') }}
          </label>
          <p style="font-size:12px;color:#a65d0a;margin:4px 0">{{ t('jobOptions.rerunRisk') }}</p>
        </div>
        <div class="form-group">
          <label class="form-checkbox-label">
            <input v-model="form.runOnce" type="checkbox" :disabled="!!form.templateId" />
            {{ t('jobOptions.runOnce') }}
          </label>
        </div>
        <div class="form-group">
          <label class="form-checkbox-label">
            <input v-model="form.exclusiveAccount" type="checkbox" :disabled="!!form.templateId || !form.accountId" />
            {{ t('jobOptions.exclusiveAccount') }}
          </label>
          <p style="font-size:12px;color:#777;margin:4px 0">{{ t('jobOptions.exclusiveAccountHint') }}</p>
        </div>
        <div v-if="form.runOnce" class="form-row">
          <div class="form-group">
            <label class="form-label" for="job-first-min">{{ t('jobOptions.firstRunMinDays') }}</label>
            <input id="job-first-min" v-model.number="form.firstRunMinDays" class="form-input" type="number" min="0" max="3650" step="1" :disabled="!!form.templateId" />
          </div>
          <div class="form-group">
            <label class="form-label" for="job-first-max">{{ t('jobOptions.firstRunMaxDays') }}</label>
            <input id="job-first-max" v-model.number="form.firstRunMaxDays" class="form-input" type="number" :min="form.firstRunMinDays" max="3650" step="1" :disabled="!!form.templateId" />
          </div>
        </div>
        <div v-else class="form-group">
          <label class="form-label">{{ t('jobs.labelRunEveryDays') }}</label>
          <input v-model.trim="runEveryDaysText" class="form-input" type="text" :placeholder="t('jobs.runEveryDaysPlaceholder')" :disabled="!!form.templateId" style="max-width:160px" />
        </div>
        <div v-if="form.jobType === 'embywatch' && !form.templateId" class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
            <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" />
          </div>
        </div>

        </div><!-- end modal-body -->
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showForm = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button v-if="editTarget && !editTarget.templateId" class="btn btn-ghost" @click="openExtract(editTarget)">
            <i class="fa-solid fa-file-export"></i> {{ t('jobs.extractToTemplate') }}
          </button>
          <button class="btn btn-primary" :disabled="saving" @click="saveJob">
            <i class="fa-solid fa-floppy-disk"></i> {{ saving ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Extract to Template modal -->
    <div v-if="extractSource" class="modal-backdrop">
      <div class="modal" style="width:400px">
        <h3 class="modal-title">{{ t('jobs.extractModalTitle') }}</h3>
        <div class="modal-body">
          <div v-if="extractError" class="error-msg">{{ extractError }}</div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.extractTemplateName') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="extractName" class="form-input" :placeholder="extractSource.name" @keyup.enter="confirmExtract" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="extractSource = null"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="extractSaving" @click="confirmExtract">
            <i class="fa-solid fa-file-export"></i> {{ extractSaving ? t('common.saving') : t('jobs.extractConfirm') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Disable confirmation modal -->
    <div v-if="confirmDisableJob" class="modal-backdrop">
      <div class="modal" style="width:360px">
        <h3 class="modal-title">{{ t('common.disable') }}</h3>
        <div class="modal-body">
          <p>{{ t('jobs.confirmDisable') }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmDisableJob = null"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeDisable"><i class="fa-solid fa-ban"></i> {{ t('common.disable') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk run modal -->
    <div v-if="showBulkRunModal" class="modal-backdrop" @keydown.esc="!bulkRunSubmitting && (showBulkRunModal = false)">
      <div class="modal" style="width:min(380px,calc(100vw - 24px))" role="dialog" aria-modal="true" :aria-label="t('jobs.bulkRunTitle')">
        <h3 class="modal-title">{{ t('jobs.bulkRunTitle') }}</h3>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">{{ t('accountWorkflow.concurrency') }}</label>
            <input v-model.number="bulkRunConcurrency" type="number" min="1" max="20" step="1" class="form-input" style="width:120px" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('accountWorkflow.startInterval') }}</label>
            <input v-model.number="bulkRunDelay" type="number" min="0" max="3600" class="form-input" style="width:120px" @keyup.enter="enqueueSelectedJobs" />
          </div>
          <div v-if="bulkRunError" class="error-msg" role="alert">{{ bulkRunError }}</div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" :disabled="bulkRunSubmitting" @click="showBulkRunModal = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-success" :disabled="bulkRunSubmitting" @click="enqueueSelectedJobs"><i class="fa-solid" :class="bulkRunSubmitting ? 'fa-spinner fa-spin' : 'fa-play'"></i> {{ t('accountWorkflow.submitQueue') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk change window modal -->
    <div v-if="showBulkWindowModal" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('jobs.bulkWindowTitle') }}</h3>
        <div class="modal-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelWindowStart') }}</label>
              <input v-model.number="bulkWindowStart" type="number" class="form-input" placeholder="1400" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelWindowEnd') }}</label>
              <input v-model.number="bulkWindowEnd" type="number" class="form-input" placeholder="1600" />
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showBulkWindowModal = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="executeBulkChangeWindow"><i class="fa-solid fa-clock"></i> {{ t('jobs.bulkWindowApply') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk disable confirmation -->
    <div v-if="confirmBulkDisableJobs" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.disable') }}</h3>
        <div class="modal-body">
          <p>{{ t('jobs.confirmBulkDisable').replace('{n}', String(selectedJobIds.length)) }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmBulkDisableJobs = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeBulkDisableJobs"><i class="fa-solid fa-ban"></i> {{ t('common.disable') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk retire confirmation -->
    <div v-if="confirmBulkRetireJobs" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.retire') }}</h3>
        <div class="modal-body">
          <p>{{ t('jobs.confirmBulkRetire').replace('{n}', String(selectedJobIds.length)) }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmBulkRetireJobs = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeBulkRetireJobs"><i class="fa-solid fa-box-archive"></i> {{ t('common.retire') }}</button>
        </div>
      </div>
    </div>

    <!-- Mobile action sheet -->
    <div v-if="actionMenuJob" class="action-sheet-backdrop" @click="actionMenuJob = null">
      <div class="action-sheet" @click.stop>
        <div class="action-sheet-header">{{ actionMenuJob.name }}</div>
        <button class="action-sheet-btn" :disabled="running.has(actionMenuJob.id)" @click="runNow(actionMenuJob.id); actionMenuJob = null">
          <i class="fa-solid fa-play"></i> {{ t('common.run') }}
        </button>
        <button class="action-sheet-btn" @click="openEdit(actionMenuJob); actionMenuJob = null">
          <i class="fa-solid fa-pen"></i> {{ t('common.edit') }}
        </button>
        <button class="action-sheet-btn" @click="openDuplicate(actionMenuJob); actionMenuJob = null">
          <i class="fa-solid fa-copy"></i> {{ t('common.duplicate') }}
        </button>
        <button class="action-sheet-btn" @click="openOutcome(actionMenuJob, 'success'); actionMenuJob = null">
          <i class="fa-solid fa-check"></i> {{ t('jobs.markSuccess') }}
        </button>
        <button class="action-sheet-btn" @click="openOutcome(actionMenuJob, 'failed'); actionMenuJob = null">
          <i class="fa-solid fa-xmark"></i> {{ t('jobs.markFailed') }}
        </button>
        <button class="action-sheet-btn" @click="toggleEnabled(actionMenuJob); actionMenuJob = null">
          <i :class="actionMenuJob.enabled ? 'fa-solid fa-ban' : 'fa-solid fa-circle-check'"></i>
          {{ actionMenuJob.enabled ? t('common.disable') : t('common.enable') }}
        </button>
        <button class="action-sheet-btn danger" @click="retire(actionMenuJob.id); actionMenuJob = null">
          <i class="fa-solid fa-box-archive"></i> {{ t('common.retire') }}
        </button>
        <div class="action-sheet-divider"></div>
        <button class="action-sheet-btn action-sheet-cancel" @click="actionMenuJob = null">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
    <!-- Manual outcome correction -->
    <div v-if="outcomeJob" class="modal-backdrop" @keydown.esc="closeOutcome">
      <div ref="outcomeDialog" class="modal" style="width:min(520px,calc(100vw - 24px))" role="dialog" aria-modal="true" tabindex="-1" :aria-label="outcomeStatus === 'success' ? t('jobs.markSuccess') : t('jobs.markFailed')" @keydown.enter.prevent="confirmOutcome">
        <h3 class="modal-title">{{ outcomeStatus === 'success' ? t('jobs.markSuccess') : t('jobs.markFailed') }}</h3>
        <div class="modal-body">
          <p>{{ t('jobs.outcomePrompt').replace('{job}', outcomeJob.name) }}</p>
          <p style="font-size:12px;color:#888;margin:0" v-if="outcomeLoading">{{ t('common.loading') }}</p>
          <p style="font-size:12px;color:#888;margin:0" v-else-if="outcomeLatest">
            {{ t('jobs.outcomeLatest').replace('{status}', t(`logs.status.${outcomeLatest.status}`)).replace('{time}', fmtDateTimeFull(outcomeLatest.ranAt)) }}
          </p>
          <p style="font-size:12px;color:#888;margin:0" v-else-if="outcomeRevision">{{ t('jobs.outcomeNoRun') }}</p>
          <div v-if="outcomeError" class="error-msg" role="alert">{{ outcomeError }}</div>
        </div>
        <div class="modal-footer">
          <button v-if="outcomeError" class="btn btn-ghost" :disabled="outcomeSaving || outcomeLoading" :title="t('common.refresh')" :aria-label="t('common.refresh')" @keydown.enter.stop @click="refreshOutcome"><i class="fa-solid fa-rotate-right"></i></button>
          <button class="btn btn-ghost" :disabled="outcomeSaving" @keydown.enter.stop @click="closeOutcome"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="outcomeSaving || outcomeLoading || !outcomeRevision" @click="confirmOutcome">
            <i class="fa-solid" :class="outcomeSaving ? 'fa-spinner fa-spin' : 'fa-check'"></i>
            {{ outcomeSaving ? t('common.saving') : outcomeStatus === 'success' ? t('jobs.markSuccess') : t('jobs.markFailed') }}
          </button>
        </div>
      </div>
    </div>
    <!-- Bulk run error toast -->
    <div v-if="bulkRunToast" class="job-toast">{{ bulkRunToast }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { jobsApi, accountsApi, settingsApi, logsApi, templatesApi, type Job, type JobFacets, type JobTemplate, type Account, type Settings, type UAPreset, type EmbywatchConfig, type AutoregConfig, type CheckinConfig } from '../api/client';
import { advancedActionOptions, defaultWorkflowAction, isAdvancedAction, workflowToConfig, type AdvancedActionType, type CustomAction, type CustomConfig } from '../api/automation';
import WorkflowActionsEditor from '../components/WorkflowActionsEditor.vue';
import TemplateOptionsEditor, { type TemplateOptionDraft } from '../components/TemplateOptionsEditor.vue';
import { t, locale } from '../i18n';
import { regexValid } from '../utils/regexCheck';
import { usePersistedRef } from '../composables/usePersistedRef';
import { formatAccountLabel, loadAccountDisplaySetting } from '../composables/accountDisplay';
import { loadSchedulePageSetting, scheduleSeparatePage } from '../composables/schedulePage';
import ScheduleList from '../components/ScheduleList.vue';
import { debounce } from '../composables/useDebounce';
import PaginationBar from '../components/PaginationBar.vue';
import WebStepsEditor from '../components/WebStepsEditor.vue';
import { webStepsFromConfig, webStepsToConfig, type WebStepForm } from '../composables/webSteps';
import { executionsApi } from '../api/executions';
import { taskQueueApi } from '../api/taskQueue';
import TaskQueuePanel from '../components/TaskQueuePanel.vue';
import { createLatestRequest } from '../utils/latestRequest';
import { outcomesApi, type JobOutcomePreview } from '../api/outcomes';

type CustomActionForm = {
  type: AdvancedActionType | 'send_command' | 'send_contact_message' | 'wait_reply' | 'delay' | 'save_tag' | 'click_button' | 'click_message_button' | 'watch_buttons' | 'enter_captcha' | 'join_group' | 'subscribe_channel' | 'leave_group' | 'unsubscribe_channel' | 'open_mini_app' | 'open_mini_app_url' | 'open_bot_menu_app' | 'mini_app_http' | 'open_url';
  workflow: CustomAction;
  content: string;
  contentDropdown: string;
  contentCustom: string;
  contentAiInputLength: string;
  maxWaitMs: number;
  waitMs: number;
  tagName: string;
  tagValue: string;
  tagRegex: string;
  button: string;
  buttonDropdown: string;
  buttonCustom: string;
  buttonAiHint: string;
  alsoWatchButtonsText: string;
  minShare: number;
  thankYouText: string;
  thankAiHint: string;
  thankWhenContains: string;
  thankDelayMinMs: number;
  thankDelayMaxMs: number;
  thankAsReply: boolean;
  forwardPrivateTo: string;
  forwardTemplate: string;
  forwardWaitMs: number;
  maxRetries: number;
  scope: number;
  captchaLength: string;
  successContains: string;
  failContains: string;
  cfChallenge: boolean;
  contact: string;
  groupId: string;
  checkMembership: boolean;
  alreadyMemberEndsTask: boolean;
  verifyButton: string;
  verifyWaitMs: number;
  channelId: string;
  appButton: string;
  /** open_mini_app: browser budget, 0 = default */
  miniAppMaxWaitMs: number;
  /** open_mini_app: pinned browser proxy id, 'direct', or '' for the job proxy */
  miniAppProxyId: string;
  miniAppTryAllProxies: boolean;
  watchCodeBot: string;
  watchCodeRegex: string;
  watchCodeCommand: string;
  watchCodeMaxCodeAgeMs: number;
  watchCodeReplyWaitMs: number;
  method: 'GET' | 'POST';
  body: string;
  contentType: 'application/json' | 'application/x-www-form-urlencoded' | 'text/plain';
  responseVariable: string;
  statusVariable: string;
  sendInitData: boolean;
  /** open_url: the page to open */
  url: string;
  /** open_url: sub-steps run on the page once it is up */
  webSteps: WebStepForm[];
};

const jobs = ref<Job[]>([]);
const accounts = ref<Account[]>([]);
const templates = ref<JobTemplate[]>([]);
const settings = ref<Settings | null>(null);
const uaPresets = computed<UAPreset[]>(() => {
  try { return JSON.parse(settings.value?.ua_presets ?? '[]'); } catch { return []; }
});
const proxiesList = computed<Array<{ id: string; name: string }>>(() => {
  try { return JSON.parse(settings.value?.proxies ?? '[]'); } catch { return []; }
});
const running = ref(new Set<number>());

const page = ref(1);
const total = ref(0);
const pageSize = usePersistedRef<number>('bemby:jobs:pageSize', 25);
const facets = ref<JobFacets>({ botUsernames: [], templates: [] });

const filterType = usePersistedRef<string>('bemby:jobs:filterType', '');
const filterAccountId = usePersistedRef<number | ''>('bemby:jobs:filterAccountId', '');
const filterBotUrlTpl = usePersistedRef<string>('bemby:jobs:filterBotUrlTpl', '');
const filterName = usePersistedRef<string>('bemby:jobs:filterName', '');
const filterOptions = computed(() => [
  { value: '', label: t('common.all') },
  { value: 'checkin', label: t('logs.jobType.checkin') },
  { value: 'embywatch', label: t('logs.jobType.embywatch') },
  { value: 'custom', label: t('logs.jobType.custom') },
  { value: 'autoreg', label: t('logs.jobType.autoreg') },
]);
// Options come from server facets so the dropdown covers the whole dataset, not just the loaded page
const botUrlTplOptions = computed(() => {
  const botVals = facets.value.botUsernames.map(v => ({ value: `bot:${v}`, label: v }));
  const tplVals = facets.value.templates.map(t => ({ value: `tpl:${t.id}`, label: `[T] ${t.name}` }));
  return [...botVals, ...tplVals];
});

const showLastSuccess = usePersistedRef<boolean>('bemby:jobs:showLastSuccess', false);
const sortKey = usePersistedRef<string>('bemby:jobs:sortKey', '');
const sortDir = usePersistedRef<'asc' | 'desc'>('bemby:jobs:sortDir', 'asc');
const actionMenuJob = ref<Job | null>(null);
const outcomeJob = ref<Job | null>(null);
const outcomeStatus = ref<'success' | 'failed'>('success');
const outcomeRevision = ref('');
const outcomeLatest = ref<JobOutcomePreview['latestLog']>(null);
const outcomeError = ref('');
const outcomeWarning = ref('');
const outcomeSaving = ref(false);
const outcomeLoading = ref(false);
const outcomeDialog = ref<HTMLElement | null>(null);
const outcomeRequest = createLatestRequest({
  onStart: () => { outcomeLoading.value = true; },
  onFinish: () => { outcomeLoading.value = false; },
  onError: (err: any) => { outcomeError.value = err.response?.data?.error ?? t('common.loadFailed'); },
});
const confirmDisableJob = ref<Job | null>(null);
const selectedJobIds = ref<number[]>([]);
const allJobsSelected = computed(() => jobs.value.length > 0 && jobs.value.every(j => selectedJobIds.value.includes(j.id)));
const confirmBulkDisableJobs = ref(false);
const confirmBulkRetireJobs = ref(false);
const showBulkRunModal = ref(false);
const bulkRunDelay = ref(70);
const bulkRunConcurrency = ref(1);
const bulkRunSubmitting = ref(false);
const bulkRunError = ref('');
const taskQueueRef = ref<InstanceType<typeof TaskQueuePanel> | null>(null);
let disposed = false;
const showBulkWindowModal = ref(false);
const bulkWindowStart = ref(1400);
const bulkWindowEnd = ref(1600);

function setSort(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'asc';
  }
  page.value = 1;
  loadJobs();
}

function sortIcon(key: string): string {
  if (sortKey.value !== key) return '↕';
  return sortDir.value === 'asc' ? '↑' : '↓';
}

// Filtering and sorting happen server-side; filter changes restart from page 1
watch([filterType, filterAccountId, filterBotUrlTpl], () => {
  page.value = 1;
  loadJobs();
});
const debouncedNameFilter = debounce(() => {
  page.value = 1;
  loadJobs();
}, 300);
watch(filterName, () => { jobsRequest.cancel(); debouncedNameFilter(); });

function onPageChange(p: number) {
  if (p === page.value) return;
  page.value = p;
  loadJobs();
}

function onPageSizeChange(size: number) {
  pageSize.value = size;
  page.value = 1;
  loadJobs();
}

function jobTypeBadge(type: string) {
  const map: Record<string, string> = {
    checkin: 'badge badge-blue',
    embywatch: 'badge badge-purple',
    custom: 'badge badge-amber',
    autoreg: 'badge badge-red',
  };
  return map[type] ?? 'badge badge-grey';
}
const pollTimers = new Map<number, ReturnType<typeof setTimeout>>();
const listError = ref('');
const jobsRequest = createLatestRequest({
  onStart: () => { listError.value = ''; },
  onError: (error: any) => { listError.value = error.response?.data?.error ?? t('common.loadFailed'); },
});
const accountRequest = createLatestRequest();
const templateRequest = createLatestRequest();
const settingsRequest = createLatestRequest();

const showForm = ref(false);
const editTarget = ref<Job | null>(null);
const customActions = ref<CustomActionForm[]>([]);
const customJobMaxRetries = ref(1);
const customVariables = ref<CustomConfig['variables']>({});
const customOptions = ref<TemplateOptionDraft[]>([]);
const customOptionValues = reactive<Record<string, string | number | boolean>>({});

const form = reactive({
  name: '',
  accountId: null as number | null,
  jobType: 'checkin' as 'checkin' | 'embywatch' | 'custom' | 'autoreg',
  botUsername: '',
  scheduleWindowStart: 1000,
  scheduleWindowEnd: 2200,
  // Empty means follow the default_timezone setting
  timezone: '',
  replyTimeoutMs: 40000,
  retryMax: 5,
  enabled: true,
  templateId: null as number | null,
  runEveryDays: 1,
  runEveryDaysMax: null as number | null,
  runOnce: false,
  firstRunMinDays: 0,
  firstRunMaxDays: 0,
  rerunOnRestart: false,
  exclusiveAccount: false,
});

const linkedTemplate = computed(() => templates.value.find(t => t.id === form.templateId) ?? null);
const linkedTemplateDuration = computed(() => {
  const fallback = { playDuration: '', playDurationMax: '' };
  const raw = linkedTemplate.value?.config;
  if (!raw) return fallback;
  try {
    let cfg = JSON.parse(raw) as EmbywatchConfig | string;
    if (typeof cfg === 'string') cfg = JSON.parse(cfg) as EmbywatchConfig;
    return {
      playDuration: cfg.playDuration != null ? String(cfg.playDuration) : '',
      playDurationMax: cfg.playDurationMax != null ? String(cfg.playDurationMax) : '',
    };
  } catch {
    return fallback;
  }
});

const EMBY_TEMPLATE_META_KEY = '__bembyTemplate';
type LinkedDurationKey = 'playDuration' | 'playDurationMax';

function linkedDurationOverride(
  jobConfig: EmbywatchConfig,
  templateConfig: EmbywatchConfig | null,
  key: LinkedDurationKey,
): number | string {
  const metadata = (jobConfig as EmbywatchConfig & {
    __bembyTemplate?: { overrides?: Partial<Record<LinkedDurationKey, number | string>> };
  })[EMBY_TEMPLATE_META_KEY];
  if (Object.prototype.hasOwnProperty.call(jobConfig, EMBY_TEMPLATE_META_KEY)) {
    const marked = metadata?.overrides?.[key];
    return marked != null && Number.isFinite(Number(marked)) ? marked : '';
  }
  // Configs saved before the marker existed were merged with the template. Only
  // expose a legacy value when it differs from the current template default.
  const jobValue = jobConfig[key];
  const templateValue = templateConfig?.[key];
  return jobValue != null && jobValue !== templateValue ? jobValue : '';
}

// "Run every days" accepts a single number (7) or a range (7-15). The range is
// stored as runEveryDays (min) + runEveryDaysMax; the scheduler picks a random
// value in the range each cycle.
const runEveryDaysText = ref('1');
function parseRunEvery(text: string): { min: number; max: number | null } {
  const m = String(text).trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!m) return { min: 1, max: null };
  const min = Math.max(1, parseInt(m[1], 10) || 1);
  const hi = m[2] != null ? parseInt(m[2], 10) : NaN;
  return { min, max: Number.isFinite(hi) && hi > min ? hi : null };
}
function formatRunEvery(min: number, max: number | null | undefined): string {
  return max != null && max > min ? `${min}-${max}` : String(min ?? 1);
}
const runEveryDaysValid = computed(() => /^\s*\d+\s*(-\s*\d+\s*)?$/.test(runEveryDaysText.value));

const extractSource = ref<Job | null>(null);
const extractName = ref('');
const extractError = ref('');
const extractSaving = ref(false);
const embyCfg = reactive<{ username: string; password: string; playDuration: number | string; playDurationMax: number | string; backupUrl: string; userAgent: string; markWatched: boolean; verifyPlayable: boolean; realWatch: boolean; sequencePlay: boolean; library: string }>({
  username: '',
  password: '',
  playDuration: '', playDurationMax: '', backupUrl: '',
  userAgent: '',
  markWatched: true,
  verifyPlayable: true,
  realWatch: false,
  sequencePlay: false,
  library: '',
});
const embyUaDropdown = ref('');
const embyServer = reactive<{ protocol: 'https' | 'http'; host: string; port: number | '' }>({
  protocol: 'https',
  host: '',
  port: 443,
});
type AutoregCfgForm = {
  groupId: string;
  codePrefix: string;
  codeRegex: string;
  stripChinese: boolean;
  stripChars: string;
  aiModifyCode: boolean;
  aiModifyCodeHint: string;
  aiContextCount: number;
  codeReadyContains: string;
  usernameReadyContains: string;
  entryMode: 'button' | 'command';
  registerButton: string;
  clickAfterCode: boolean;
  afterCodeButton: string;
  afterCodeRequired: boolean;
  signupUsername: string;
  listenMinutes: number;
  scanHistoryCount: number;
  successContains: string;
  failContains: string;
};
function defaultAutoregCfg(): AutoregCfgForm {
  return {
    groupId: '',
    codePrefix: '',
    codeRegex: '',
    stripChinese: false,
    stripChars: '',
    aiModifyCode: false,
    aiModifyCodeHint: '',
    aiContextCount: 6,
    codeReadyContains: '',
    usernameReadyContains: '',
    entryMode: 'button',
    registerButton: '',
    clickAfterCode: false,
    afterCodeButton: '',
    afterCodeRequired: false,
    signupUsername: '',
    listenMinutes: 30,
    scanHistoryCount: 0,
    successContains: '',
    failContains: '',
  };
}
const autoregCfg = reactive<AutoregCfgForm>(defaultAutoregCfg());
const formError = ref('');
const saving = ref(false);
const aiKeyMissing = computed(() => settings.value?.ai_key_configured !== 'true');
// Anything that opens a page needs the solver's browser and its fonts in the data dir;
// neither ships in the image, so those options stay off until both are downloaded.
// Only ever true once the settings have actually arrived. Null means they have not (the
// load is fire-and-forget and swallows its errors), and reading that as "no browser" greys
// the actions out with a label saying something untrue about the machine.
const cfBrowserMissing = computed(
  () =>
    !!settings.value &&
    (settings.value.cf_chromium_installed !== 'true' ||
      settings.value.cf_fonts_installed !== 'true'),
);

const CMD_PRESETS = new Set(['', '/start', '/checkin'])
const ACTION_CMD_PRESETS = new Set(['/start', '/checkin'])
const ACTION_BTN_PRESETS = new Set(['签到', '{anyBtn}'])
const BTN_PRESETS = new Set(['', '签到', '{aiBtn}', '{anyBtn}'])
const cmdDropdown = ref('')
const cmdCustom = ref('')
const btnDropdown = ref('')
const btnCustom = ref('')
const btnAiHint = ref('')
const checkinSuccessContains = ref('')
const checkinFailContains = ref('')
const checkinCfChallenge = ref(false)

function setCmdState(val: string) {
  if (CMD_PRESETS.has(val)) { cmdDropdown.value = val; cmdCustom.value = ''; }
  else { cmdDropdown.value = 'custom'; cmdCustom.value = val; }
}
function setBtnState(val: string) {
  const aiMatch = val.match(/^\{aiBtn:(.+)\}$/);
  if (aiMatch) {
    btnDropdown.value = '{aiBtn}'; btnAiHint.value = aiMatch[1].trim(); btnCustom.value = '';
  } else if (BTN_PRESETS.has(val)) {
    btnDropdown.value = val; btnCustom.value = ''; btnAiHint.value = '';
  } else {
    btnDropdown.value = 'custom'; btnCustom.value = val; btnAiHint.value = '';
  }
}

function setUaState(ua: string) {
  if (!ua) { embyUaDropdown.value = ''; return; }
  const match = uaPresets.value.find(p => p.value === ua);
  embyUaDropdown.value = match ? match.name : '__custom__';
}

function onUaDropdownChange() {
  if (embyUaDropdown.value === '' ) { embyCfg.userAgent = ''; return; }
  if (embyUaDropdown.value === '__custom__') return;
  const preset = uaPresets.value.find(p => p.name === embyUaDropdown.value);
  if (preset) embyCfg.userAgent = preset.value;
}

function onJobTypeChange() {
  customVariables.value = {};
  customOptions.value = [];
  for (const key of Object.keys(customOptionValues)) delete customOptionValues[key];
  Object.assign(embyCfg, { username: '', password: '', playDuration: '', playDurationMax: '', backupUrl: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
  Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
  embyUaDropdown.value = '';
  form.accountId = (form.jobType === 'checkin' || form.jobType === 'custom' || form.jobType === 'autoreg')
    ? (accounts.value[0]?.id ?? null)
    : null;
  form.runEveryDays = 1;
  form.runEveryDaysMax = null;
  form.runOnce = false;
  form.firstRunMinDays = 0;
  form.firstRunMaxDays = 0;
  form.rerunOnRestart = false;
  form.exclusiveAccount = false;
  runEveryDaysText.value = '1';
  customActions.value = [];
  Object.assign(autoregCfg, defaultAutoregCfg());
  customJobMaxRetries.value = 1;
  btnAiHint.value = '';
  checkinSuccessContains.value = '';
  checkinFailContains.value = '';
  checkinCfChallenge.value = false;
  setCmdState(''); setBtnState('');
}

function defaultAction(): CustomActionForm {
  return { type: 'send_command', workflow: defaultWorkflowAction('set_variables'), content: '/start', contentDropdown: '/start', contentCustom: '', contentAiInputLength: '', maxWaitMs: 30000, waitMs: 2000, tagName: '', tagValue: '', tagRegex: '', button: '签到', buttonDropdown: '签到', buttonCustom: '', buttonAiHint: '', alsoWatchButtonsText: '', minShare: 0, thankYouText: '', thankAiHint: '', thankWhenContains: '', thankDelayMinMs: 0, thankDelayMaxMs: 0, thankAsReply: false, forwardPrivateTo: '', forwardTemplate: '{message}', forwardWaitMs: 20000, maxRetries: 3, scope: 0, captchaLength: '', successContains: '', failContains: '', cfChallenge: false, contact: '', groupId: '', watchCodeBot: '', watchCodeRegex: '', watchCodeCommand: '/start {code}', watchCodeMaxCodeAgeMs: 10 * 60 * 1000, watchCodeReplyWaitMs: 40000, checkMembership: false, alreadyMemberEndsTask: false, verifyButton: '', verifyWaitMs: 30000, channelId: '', appButton: '', miniAppMaxWaitMs: 300000, miniAppProxyId: '', miniAppTryAllProxies: true, method: 'GET', body: '', contentType: 'application/json', responseVariable: '', statusVariable: '', sendInitData: false, url: '', webSteps: [] };
}

function onActionTypeChange(action: CustomActionForm) {
  if (isAdvancedAction(action.type)) action.workflow = defaultWorkflowAction(action.type);
}

function addAction() {
  customActions.value.push(defaultAction());
}

function removeAction(i: number) {
  customActions.value.splice(i, 1);
}

function moveUp(i: number) {
  if (i === 0) return;
  const arr = customActions.value;
  [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
}

function moveDown(i: number) {
  const arr = customActions.value;
  if (i >= arr.length - 1) return;
  [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
}

onMounted(async () => {
  loadAccountDisplaySetting();
  loadSchedulePageSetting();
  await Promise.all([loadJobs(), loadAccounts(), loadStatus(), loadSettings(), loadTemplates()]);
});

// Label for a job's account, honouring the "{Bemby name} - {TG name}" display setting.
function jobAccountLabel(j: Job): string {
  const acc = accounts.value.find((a) => a.id === j.accountId);
  const fallback = j.accountName ?? (j.accountId != null ? String(j.accountId) : "");
  return formatAccountLabel(acc, fallback);
}

async function loadSettings() {
  try { await settingsRequest.run(async ({ signal, commit }) => {
    const value = await settingsApi.get(signal);
    commit(() => { settings.value = value; });
  }); } catch { /* keep the last known settings */ }
}

async function loadTemplates() {
  try { await templateRequest.run(async ({ signal, commit }) => {
    const value = await templatesApi.list(signal);
    commit(() => { templates.value = value; });
  }); } catch { /* keep the last known templates */ }
}

function applyTemplate(tpl: JobTemplate) {
  customVariables.value = {};
  customOptions.value = [];
  for (const key of Object.keys(customOptionValues)) delete customOptionValues[key];
  form.jobType = tpl.jobType;
  form.botUsername = tpl.botUsername;
  form.timezone = tpl.timezone;
  form.replyTimeoutMs = tpl.replyTimeoutMs;
  form.retryMax = tpl.retryMax;
  form.runEveryDays = tpl.runEveryDays ?? 1;
  form.runEveryDaysMax = tpl.runEveryDaysMax ?? null;
  runEveryDaysText.value = formatRunEvery(form.runEveryDays, form.runEveryDaysMax);
  form.runOnce = tpl.runOnce ?? false;
  form.firstRunMinDays = tpl.firstRunMinDays ?? 0;
  form.firstRunMaxDays = tpl.firstRunMaxDays ?? 0;
  form.rerunOnRestart = tpl.rerunOnRestart ?? false;
  form.exclusiveAccount = tpl.exclusiveAccount ?? false;
  setCmdState(tpl.startCommand === '/start' ? '' : (tpl.startCommand ?? ''));
  setBtnState(tpl.checkinButton === '签到' ? '' : (tpl.checkinButton ?? ''));
  if (tpl.jobType === 'embywatch') {
    Object.assign(embyCfg, { playDuration: '', playDurationMax: '', backupUrl: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
    setUaState('');
    const m = tpl.botUsername.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/);
    Object.assign(embyServer, { protocol: (m?.[1] ?? 'https') as 'https' | 'http', host: m?.[2] ?? '', port: m?.[3] ? Number(m[3]) : 443 });
    if (tpl.config) {
      try {
        let c = JSON.parse(tpl.config) as EmbywatchConfig | string;
        if (typeof c === 'string') c = JSON.parse(c) as EmbywatchConfig;
      } catch { /* ignore */ }
    }
  } else if (tpl.jobType === 'custom') {
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    if (tpl.config) {
      try {
        const cfg = JSON.parse(tpl.config) as CustomConfig;
        customVariables.value = cfg.variables ?? {};
        customOptions.value = Array.isArray(cfg.jobOptions)
          ? cfg.jobOptions.map((option) => ({
              name: option.name,
              label: option.label,
              options: option.options,
              default: option.default,
            }))
          : [];
        for (const key of Object.keys(customOptionValues)) delete customOptionValues[key];
        Object.assign(customOptionValues, cfg.jobOptionValues ?? {});
        customJobMaxRetries.value = cfg.maxRetries ?? 1;
        customActions.value = cfg.actions.map(a => {
          const base = defaultAction();
          if (isAdvancedAction(a.type)) return { ...base, type: a.type, workflow: a };
          if (a.type === 'send_command') {
            const aiInputMatch = a.content.match(/^\{aiInput(?::(\d+))?\}$/);
            if (aiInputMatch) return { ...base, type: 'send_command' as const, content: a.content, contentDropdown: '{aiInput}', contentCustom: '', contentAiInputLength: aiInputMatch[1] ?? '', maxRetries: a.maxRetries ?? 0 };
            const contentDropdown = ACTION_CMD_PRESETS.has(a.content) ? a.content : 'custom';
            return { ...base, type: 'send_command' as const, content: a.content, contentDropdown, contentCustom: contentDropdown === 'custom' ? a.content : '', contentAiInputLength: '', maxRetries: a.maxRetries ?? 0 };
          }
          if (a.type === 'send_contact_message') {
            const aiInputMatch = a.content.match(/^\{aiInput(?::(\d+))?\}$/);
            if (aiInputMatch) return { ...base, type: 'send_contact_message' as const, contact: a.contact, content: a.content, contentDropdown: '{aiInput}', contentCustom: '', contentAiInputLength: aiInputMatch[1] ?? '', maxRetries: a.maxRetries ?? 0 };
            const contentDropdown = ACTION_CMD_PRESETS.has(a.content) ? a.content : 'custom';
            return { ...base, type: 'send_contact_message' as const, contact: a.contact, content: a.content, contentDropdown, contentCustom: contentDropdown === 'custom' ? a.content : '', contentAiInputLength: '', maxRetries: a.maxRetries ?? 0 };
          }
          if (a.type === 'wait_reply') return { ...base, type: 'wait_reply' as const, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, scope: a.scope ?? 0 };
          if (a.type === 'delay') return { ...base, type: 'delay' as const, waitMs: a.waitMs };
          if (a.type === 'save_tag') return { ...base, type: 'save_tag' as const, tagName: a.name, tagValue: a.value ?? '', tagRegex: a.regex ?? '' };
          if (a.type === 'enter_captcha') return { ...base, type: 'enter_captcha' as const, maxWaitMs: a.maxWaitMs, captchaLength: String(a.captchaLength ?? ''), maxRetries: a.maxRetries ?? 0 };
          if (a.type === 'join_group') return { ...base, type: 'join_group' as const, groupId: a.groupId, checkMembership: a.checkMembership ?? false, alreadyMemberEndsTask: a.alreadyMemberEndsTask ?? false, verifyButton: a.verifyButton ?? '', verifyWaitMs: a.verifyWaitMs ?? 30000 };
          if (a.type === 'subscribe_channel') return { ...base, type: 'subscribe_channel' as const, channelId: a.channelId, checkMembership: a.checkMembership ?? false };
          if (a.type === 'leave_group') return { ...base, type: 'leave_group' as const, groupId: a.groupId };
          if (a.type === 'unsubscribe_channel') return { ...base, type: 'unsubscribe_channel' as const, channelId: a.channelId };
          if (a.type === 'open_mini_app') return { ...base, type: 'open_mini_app' as const, contact: a.contact ?? '', button: a.button ?? '', appButton: (a.appButtons ?? []).join(' > '), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'mini_app_http') return { ...base, type: 'mini_app_http' as const, contact: a.bot ?? '', url: a.url ?? '', method: a.method ?? 'GET', body: a.body ?? '', contentType: a.contentType ?? 'application/json', responseVariable: a.responseVariable ?? '', statusVariable: a.statusVariable ?? '', successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxWaitMs: a.maxWaitMs ?? 30000, sendInitData: a.sendInitData ?? false };
          if (a.type === 'open_mini_app_url') return { ...base, type: 'open_mini_app_url' as const, url: a.url ?? '', contact: a.contact ?? '', appButton: (a.appButtons ?? []).join(' > '), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'open_bot_menu_app') return { ...base, type: 'open_bot_menu_app' as const, contact: a.contact ?? '', appButton: (a.appButtons ?? []).join(' > '), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'open_url') return { ...base, type: 'open_url' as const, url: a.url ?? '', webSteps: webStepsFromConfig(a.steps), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'click_button') {
            const aiMatch = a.button.match(/^\{aiBtn(?::(.+))?\}$/);
            let buttonDropdown: string, buttonCustom = '', buttonAiHint = '';
            if (aiMatch) { buttonDropdown = '{aiBtn}'; buttonAiHint = aiMatch[1]?.trim() ?? ''; }
            else if (ACTION_BTN_PRESETS.has(a.button)) { buttonDropdown = a.button; }
            else { buttonDropdown = 'custom'; buttonCustom = a.button; }
            return { ...base, type: 'click_button' as const, button: a.button, buttonDropdown, buttonCustom, buttonAiHint, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', scope: a.scope ?? 0, cfChallenge: a.cfChallenge ?? false };
          }
          if (a.type === 'click_message_button') {
            const aiMatch = a.button.match(/^\{aiBtn(?::(.+))?\}$/);
            let buttonDropdown: string, buttonCustom = '', buttonAiHint = '';
            if (aiMatch) { buttonDropdown = '{aiBtn}'; buttonAiHint = aiMatch[1]?.trim() ?? ''; }
            else if (ACTION_BTN_PRESETS.has(a.button)) { buttonDropdown = a.button; }
            else { buttonDropdown = 'custom'; buttonCustom = a.button; }
            return { ...base, type: 'click_message_button' as const, contact: a.contact, button: a.button, buttonDropdown, buttonCustom, buttonAiHint, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', scope: a.scope ?? 0, cfChallenge: a.cfChallenge ?? false };
          }
          if (a.type === 'watch_buttons') return { ...base, type: 'watch_buttons' as const, groupId: a.groupId, button: a.button, alsoWatchButtonsText: (a.alsoWatchButtons ?? []).join(','), maxWaitMs: a.maxWaitMs ?? 15 * 60 * 60 * 1000, minShare: a.minShare ?? 0, thankYouText: (a.thankYou ?? []).join(','), thankAiHint: a.thankAiHint ?? '', thankWhenContains: a.thankWhenContains ?? '', thankDelayMinMs: a.thankDelayMinMs ?? 0, thankDelayMaxMs: a.thankDelayMaxMs ?? 0, thankAsReply: a.thankAsReply ?? false, forwardPrivateTo: a.forwardPrivateTo ?? '', forwardTemplate: a.forwardTemplate ?? '{message}', forwardWaitMs: a.forwardWaitMs ?? 20000 };
          if (a.type === 'watch_codes') return { ...base, type: 'watch_codes' as const, groupId: a.groupId, watchCodeBot: a.bot ?? '', watchCodeRegex: a.regex, watchCodeCommand: a.command ?? '/start {code}', maxWaitMs: a.maxWaitMs ?? 15 * 60 * 60 * 1000, watchCodeMaxCodeAgeMs: a.maxCodeAgeMs ?? 10 * 60 * 1000, watchCodeReplyWaitMs: a.replyWaitMs ?? 40000, successContains: a.successContains ?? '', failContains: a.failContains ?? '' };
          return base;
        });
      } catch { customActions.value = []; customJobMaxRetries.value = 1; }
    }
  } else if (tpl.jobType === 'autoreg') {
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', playDurationMax: '', backupUrl: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
    customActions.value = [];
    Object.assign(autoregCfg, defaultAutoregCfg());
    if (tpl.config) {
      try {
        let c = JSON.parse(tpl.config) as AutoregConfig | string;
        if (typeof c === 'string') c = JSON.parse(c) as AutoregConfig;
        Object.assign(autoregCfg, {
          groupId: c.groupId ?? '',
          codePrefix: c.codePrefix ?? '',
          codeRegex: c.codeRegex ?? '',
          stripChinese: c.stripChinese === true,
          stripChars: c.stripChars ?? '',
          aiModifyCode: c.aiModifyCode === true,
          aiModifyCodeHint: c.aiModifyCodeHint ?? '',
          aiContextCount: c.aiContextCount ?? 6,
          codeReadyContains: c.codeReadyContains ?? '',
          usernameReadyContains: c.usernameReadyContains ?? '',
          registerButton: c.registerButton ?? '',
          clickAfterCode: c.clickAfterCode === true,
          afterCodeButton: c.afterCodeButton ?? '',
          afterCodeRequired: c.afterCodeRequired === true,
          signupUsername: c.signupUsername ?? '',
          listenMinutes: c.listenMinutes ?? 30,
          scanHistoryCount: c.scanHistoryCount ?? 0,
          entryMode: c.entryMode === 'command' ? 'command' : 'button',
          successContains: c.successContains ?? '',
          failContains: c.failContains ?? '',
        });
      } catch { /* ignore */ }
    }
  } else {
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', playDurationMax: '', backupUrl: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
    customActions.value = [];
  }
}

function onTemplateChange() {
  const tpl = linkedTemplate.value;
  if (!tpl) return;
  applyTemplate(tpl);
  // accountId is job-specific — never reset it when a template is assigned
}

async function loadJobs() {
  const params: Parameters<typeof jobsApi.listPaged>[0] = {
    page: page.value,
    pageSize: pageSize.value,
    search: filterName.value.trim() || undefined,
    sortKey: sortKey.value || undefined,
    sortDir: sortKey.value ? sortDir.value : undefined,
    jobType: filterType.value || undefined,
    accountId: filterAccountId.value,
  };
  if (filterBotUrlTpl.value.startsWith('bot:')) params.botUsername = filterBotUrlTpl.value.slice(4);
  else if (filterBotUrlTpl.value.startsWith('tpl:')) params.templateId = Number(filterBotUrlTpl.value.slice(4));
  await jobsRequest.run(async ({ signal, isCurrent, commit }) => {
    const res = await jobsApi.listPaged(params, signal);
    if (!isCurrent()) return;
    // Step back only for the response that still owns the displayed query.
    if (!res.items.length && page.value > 1) {
      page.value -= 1;
      await loadJobs();
      return;
    }
    commit(() => {
      jobs.value = res.items;
      total.value = res.total;
      facets.value = res.facets;
      selectedJobIds.value = selectedJobIds.value.filter(id => res.items.some(j => j.id === id));
    });
  });
}

async function loadAccounts() {
  await accountRequest.run(async ({ signal, commit }) => {
    const value = await accountsApi.list(signal);
    commit(() => { accounts.value = value; });
  }).catch(() => {});
}

const scheduleListRef = ref<{ reload: () => Promise<void> } | null>(null);

// The panel owns its own data; job changes here just ask it to look again
async function loadStatus() {
  await scheduleListRef.value?.reload();
}

function fmtWindow(start: number, end: number) {
  const fmt = (n: number) => `${String(Math.floor(n / 100)).padStart(2, '0')}:${String(n % 100).padStart(2, '0')}`;
  return `${fmt(start)} – ${fmt(end)}`;
}

// Absolute timestamp including the year, for the last-success tooltip where the
// relative label alone can be years old.
function fmtDateTimeFull(iso: string) {
  const localeMap: Record<string, string> = { en: 'en-AU', zh: 'zh-CN' };
  return new Date(iso).toLocaleString(localeMap[locale.value] ?? 'en-AU', {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// Elapsed time as at most two units: "3 days ago", "2 weeks 3 days ago",
// "1 month 5 days ago". Months and years are calendar-aware, not 30/365-day
// approximations, so "1 month ago" lands on the same day of the month.
function fmtSince(iso: string) {
  const then = new Date(iso);
  const now = new Date();
  const secs = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (!Number.isFinite(secs) || secs < 60) return t('jobs.since.justNow');

  const unit = (n: number, key: string) =>
    t(`jobs.since.${key}${n === 1 ? '' : 's'}`).replace('{n}', String(n));
  const ago = (...parts: string[]) => t('jobs.since.ago').replace('{v}', parts.join(' '));

  const mins = Math.floor(secs / 60);
  if (mins < 60) return ago(unit(mins, 'minute'));
  const hours = Math.floor(mins / 60);
  if (hours < 24) return ago(unit(hours, 'hour'));
  const days = Math.floor(hours / 24);
  if (days < 7) return ago(unit(days, 'day'));

  // Calendar months elapsed, clamped so the anchor never overshoots now
  let months = (now.getFullYear() - then.getFullYear()) * 12 + now.getMonth() - then.getMonth();
  const anchor = new Date(then);
  anchor.setMonth(anchor.getMonth() + months);
  if (anchor.getTime() > now.getTime()) {
    months -= 1;
    anchor.setMonth(anchor.getMonth() - 1);
  }

  if (months < 1) {
    const weeks = Math.floor(days / 7);
    const remDays = days % 7;
    return remDays ? ago(unit(weeks, 'week'), unit(remDays, 'day')) : ago(unit(weeks, 'week'));
  }

  const remDays = Math.floor((now.getTime() - anchor.getTime()) / 86_400_000);
  if (months < 12) {
    return remDays ? ago(unit(months, 'month'), unit(remDays, 'day')) : ago(unit(months, 'month'));
  }
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  return remMonths ? ago(unit(years, 'year'), unit(remMonths, 'month')) : ago(unit(years, 'year'));
}

function openAdd() {
  customVariables.value = {};
  customOptions.value = [];
  for (const key of Object.keys(customOptionValues)) delete customOptionValues[key];
  // Re-read on the way in: the browser and its fonts are installed from the settings page,
  // and the copy taken when this view mounted would still say they are not there
  void loadSettings();
  editTarget.value = null;
  Object.assign(form, {
    name: '', accountId: accounts.value[0]?.id ?? null,
    jobType: 'checkin', botUsername: '',
    scheduleWindowStart: 1000, scheduleWindowEnd: 2200,
    timezone: '',
    replyTimeoutMs: 40000,
    retryMax: Number(settings.value?.default_max_retry ?? 5),
    enabled: true,
    templateId: null,
    runEveryDays: 1,
    runEveryDaysMax: null,
    runOnce: false,
    firstRunMinDays: 0,
    firstRunMaxDays: 0,
    rerunOnRestart: false,
    exclusiveAccount: false,
  });
  runEveryDaysText.value = '1';
  Object.assign(embyCfg, { username: '', password: '', playDuration: '', playDurationMax: '', backupUrl: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
  Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
  embyUaDropdown.value = '';
  customActions.value = [];
  Object.assign(autoregCfg, defaultAutoregCfg());
  checkinSuccessContains.value = '';
  checkinFailContains.value = '';
  checkinCfChallenge.value = false;
  setCmdState(''); setBtnState('');
  formError.value = '';
  showForm.value = true;
}

function openEdit(j: Job) {
  customVariables.value = {};
  customOptions.value = [];
  for (const key of Object.keys(customOptionValues)) delete customOptionValues[key];
  void loadSettings();
  editTarget.value = j;
  Object.assign(form, {
    name: j.name, accountId: j.accountId, jobType: j.jobType,
    botUsername: j.botUsername, scheduleWindowStart: j.scheduleWindowStart,
    scheduleWindowEnd: j.scheduleWindowEnd, timezone: j.timezone,
    replyTimeoutMs: j.replyTimeoutMs, retryMax: j.retryMax, enabled: j.enabled,
    templateId: j.templateId ?? null,
    runEveryDays: j.runEveryDays ?? 1,
    runEveryDaysMax: j.runEveryDaysMax ?? null,
    runOnce: j.runOnce ?? false,
    firstRunMinDays: j.firstRunMinDays ?? 0,
    firstRunMaxDays: j.firstRunMaxDays ?? 0,
    rerunOnRestart: j.rerunOnRestart ?? false,
    exclusiveAccount: j.exclusiveAccount ?? false,
  });
  runEveryDaysText.value = formatRunEvery(j.runEveryDays ?? 1, j.runEveryDaysMax);
  setCmdState(j.startCommand === '/start' ? '' : (j.startCommand ?? ''));
  setBtnState(j.checkinButton === '签到' ? '' : (j.checkinButton ?? ''));
  checkinSuccessContains.value = '';
  checkinFailContains.value = '';
  checkinCfChallenge.value = false;
  if (j.jobType === 'checkin' && j.config) {
    try {
      let cfg = JSON.parse(j.config);
      if (typeof cfg === 'string') cfg = JSON.parse(cfg);
      checkinSuccessContains.value = cfg.successContains ?? '';
      checkinFailContains.value = cfg.failContains ?? '';
      checkinCfChallenge.value = cfg.cfChallenge ?? false;
    } catch { /* ignore */ }
  }
  if (j.jobType === 'embywatch') {
    // Parse stored URL back into protocol / host / port fields
    const m = j.botUsername.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/);
    Object.assign(embyServer, {
      protocol: (m?.[1] ?? 'https') as 'https' | 'http',
      host: m?.[2] ?? j.botUsername,
      port: m?.[3] ? Number(m[3]) : 443,
    });
    if (j.config) {
      try {
        let c = JSON.parse(j.config) as EmbywatchConfig | string;
        // Migrate legacy double-encoded records
        if (typeof c === 'string') c = JSON.parse(c) as EmbywatchConfig;
        const templateCfg = linkedTemplate.value?.config
          ? (() => {
              try {
                let c = JSON.parse(linkedTemplate.value!.config!) as EmbywatchConfig | string;
                if (typeof c === 'string') c = JSON.parse(c) as EmbywatchConfig;
                return c;
              } catch { return null; }
            })()
          : null;
        Object.assign(embyCfg, {
          username: c.username ?? '',
          password: c.password ?? '',
          playDuration: j.templateId ? linkedDurationOverride(c, templateCfg, 'playDuration') : (c.playDuration ?? ''),
          playDurationMax: j.templateId ? linkedDurationOverride(c, templateCfg, 'playDurationMax') : (c.playDurationMax ?? ''),
          backupUrl: j.templateId ? '' : (c.backupUrl ?? ''),
          userAgent: j.templateId ? '' : (c.userAgent ?? ''),
          markWatched: c.markWatched !== false,
          verifyPlayable: c.verifyPlayable !== false,
          realWatch: c.realWatch === true,
          sequencePlay: c.sequencePlay === true,
          library: c.library ?? '',
        });
        setUaState(j.templateId ? '' : (c.userAgent ?? ''));
      } catch {
        Object.assign(embyCfg, { username: '', password: '', playDuration: '', playDurationMax: '', backupUrl: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
        embyUaDropdown.value = '';
      }
    } else {
      Object.assign(embyCfg, { username: '', password: '', playDuration: '', playDurationMax: '', backupUrl: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
      embyUaDropdown.value = '';
    }
  } else if (j.jobType === 'custom') {
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', playDurationMax: '', backupUrl: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    if (j.config) {
      try {
        const cfg = JSON.parse(j.config) as CustomConfig;
        customVariables.value = cfg.variables ?? {};
        customOptions.value = Array.isArray(cfg.jobOptions)
          ? cfg.jobOptions.map((option) => ({
              name: option.name,
              label: option.label,
              options: option.options,
              default: option.default,
            }))
          : [];
        Object.assign(customOptionValues, cfg.jobOptionValues ?? {});
        customJobMaxRetries.value = cfg.maxRetries ?? 1;
        customActions.value = cfg.actions.map(a => {
          const base = defaultAction();
          if (isAdvancedAction(a.type)) return { ...base, type: a.type, workflow: a };
          if (a.type === 'send_command') {
            const aiInputMatch = a.content.match(/^\{aiInput(?::(\d+))?\}$/);
            if (aiInputMatch) {
              return { ...base, type: 'send_command', content: a.content, contentDropdown: '{aiInput}', contentCustom: '', contentAiInputLength: aiInputMatch[1] ?? '', maxRetries: a.maxRetries ?? 0 };
            }
            const contentDropdown = ACTION_CMD_PRESETS.has(a.content) ? a.content : 'custom';
            return { ...base, type: 'send_command', content: a.content, contentDropdown, contentCustom: contentDropdown === 'custom' ? a.content : '', contentAiInputLength: '', maxRetries: a.maxRetries ?? 0 };
          }
          if (a.type === 'send_contact_message') {
            const aiInputMatch = a.content.match(/^\{aiInput(?::(\d+))?\}$/);
            if (aiInputMatch) {
              return { ...base, type: 'send_contact_message', contact: a.contact, content: a.content, contentDropdown: '{aiInput}', contentCustom: '', contentAiInputLength: aiInputMatch[1] ?? '', maxRetries: a.maxRetries ?? 0 };
            }
            const contentDropdown = ACTION_CMD_PRESETS.has(a.content) ? a.content : 'custom';
            return { ...base, type: 'send_contact_message', contact: a.contact, content: a.content, contentDropdown, contentCustom: contentDropdown === 'custom' ? a.content : '', contentAiInputLength: '', maxRetries: a.maxRetries ?? 0 };
          }
          if (a.type === 'wait_reply') return { ...base, type: 'wait_reply', maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, scope: a.scope ?? 0 };
          if (a.type === 'delay') return { ...base, type: 'delay', waitMs: a.waitMs };
          if (a.type === 'save_tag') return { ...base, type: 'save_tag', tagName: a.name, tagValue: a.value ?? '', tagRegex: a.regex ?? '' };
          if (a.type === 'enter_captcha') return { ...base, type: 'enter_captcha', maxWaitMs: a.maxWaitMs, captchaLength: String(a.captchaLength ?? ''), maxRetries: a.maxRetries ?? 0 };
          if (a.type === 'join_group') return { ...base, type: 'join_group', groupId: a.groupId, checkMembership: a.checkMembership ?? false, alreadyMemberEndsTask: a.alreadyMemberEndsTask ?? false, verifyButton: a.verifyButton ?? '', verifyWaitMs: a.verifyWaitMs ?? 30000 };
          if (a.type === 'subscribe_channel') return { ...base, type: 'subscribe_channel', channelId: a.channelId, checkMembership: a.checkMembership ?? false };
          if (a.type === 'leave_group') return { ...base, type: 'leave_group', groupId: a.groupId };
          if (a.type === 'unsubscribe_channel') return { ...base, type: 'unsubscribe_channel', channelId: a.channelId };
          if (a.type === 'open_mini_app') return { ...base, type: 'open_mini_app', contact: a.contact ?? '', button: a.button ?? '', appButton: (a.appButtons ?? []).join(' > '), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'open_mini_app_url') return { ...base, type: 'open_mini_app_url', url: a.url ?? '', contact: a.contact ?? '', appButton: (a.appButtons ?? []).join(' > '), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'open_bot_menu_app') return { ...base, type: 'open_bot_menu_app', contact: a.contact ?? '', appButton: (a.appButtons ?? []).join(' > '), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'open_url') return { ...base, type: 'open_url', url: a.url ?? '', webSteps: webStepsFromConfig(a.steps), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'click_button') {
            const aiMatch = a.button.match(/^\{aiBtn(?::(.+))?\}$/);
            let buttonDropdown: string, buttonCustom = '', buttonAiHint = '';
            if (aiMatch) {
              buttonDropdown = '{aiBtn}'; buttonAiHint = aiMatch[1]?.trim() ?? '';
            } else if (ACTION_BTN_PRESETS.has(a.button)) {
              buttonDropdown = a.button;
            } else {
              buttonDropdown = 'custom'; buttonCustom = a.button;
            }
            return { ...base, type: 'click_button', button: a.button, buttonDropdown, buttonCustom, buttonAiHint, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', scope: a.scope ?? 0 };
          }
          if (a.type === 'click_message_button') {
            const aiMatch = a.button.match(/^\{aiBtn(?::(.+))?\}$/);
            let buttonDropdown: string, buttonCustom = '', buttonAiHint = '';
            if (aiMatch) {
              buttonDropdown = '{aiBtn}'; buttonAiHint = aiMatch[1]?.trim() ?? '';
            } else if (ACTION_BTN_PRESETS.has(a.button)) {
              buttonDropdown = a.button;
            } else {
              buttonDropdown = 'custom'; buttonCustom = a.button;
            }
            return { ...base, type: 'click_message_button', contact: a.contact, button: a.button, buttonDropdown, buttonCustom, buttonAiHint, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', scope: a.scope ?? 0 };
          }
          if (a.type === 'watch_buttons') return { ...base, type: 'watch_buttons', groupId: a.groupId, button: a.button, alsoWatchButtonsText: (a.alsoWatchButtons ?? []).join(','), maxWaitMs: a.maxWaitMs ?? 15 * 60 * 60 * 1000, minShare: a.minShare ?? 0, thankYouText: (a.thankYou ?? []).join(','), thankAiHint: a.thankAiHint ?? '', thankWhenContains: a.thankWhenContains ?? '', thankDelayMinMs: a.thankDelayMinMs ?? 0, thankDelayMaxMs: a.thankDelayMaxMs ?? 0, thankAsReply: a.thankAsReply ?? false, forwardPrivateTo: a.forwardPrivateTo ?? '', forwardTemplate: a.forwardTemplate ?? '{message}', forwardWaitMs: a.forwardWaitMs ?? 20000 };
          return base;
        });
      } catch { customActions.value = []; customJobMaxRetries.value = 1; }
    } else {
      customActions.value = [];
      customJobMaxRetries.value = 1;
    }
  } else if (j.jobType === 'autoreg') {
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', playDurationMax: '', backupUrl: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    customActions.value = [];
    Object.assign(autoregCfg, defaultAutoregCfg());
    if (j.config) {
      try {
        let c = JSON.parse(j.config) as AutoregConfig | string;
        if (typeof c === 'string') c = JSON.parse(c) as AutoregConfig;
        Object.assign(autoregCfg, {
          groupId: c.groupId ?? '',
          codePrefix: c.codePrefix ?? '',
          codeRegex: c.codeRegex ?? '',
          stripChinese: c.stripChinese === true,
          stripChars: c.stripChars ?? '',
          aiModifyCode: c.aiModifyCode === true,
          aiModifyCodeHint: c.aiModifyCodeHint ?? '',
          aiContextCount: c.aiContextCount ?? 6,
          codeReadyContains: c.codeReadyContains ?? '',
          usernameReadyContains: c.usernameReadyContains ?? '',
          registerButton: c.registerButton ?? '',
          clickAfterCode: c.clickAfterCode === true,
          afterCodeButton: c.afterCodeButton ?? '',
          afterCodeRequired: c.afterCodeRequired === true,
          signupUsername: c.signupUsername ?? '',
          listenMinutes: c.listenMinutes ?? 30,
          scanHistoryCount: c.scanHistoryCount ?? 0,
          entryMode: c.entryMode === 'command' ? 'command' : 'button',
          successContains: c.successContains ?? '',
          failContains: c.failContains ?? '',
        });
      } catch { /* ignore */ }
    }
  } else {
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', playDurationMax: '', backupUrl: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    customActions.value = [];
  }
  formError.value = '';
  showForm.value = true;
}

function openDuplicate(j: Job) {
  openEdit(j);
  editTarget.value = null;
  form.name = `${j.name} (copy)`;
}

function handleEmbyHostPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text')?.trim();
  if (!text) return;
  // Match optional protocol, host, optional port, optional path
  const match = text.match(/^(?:(https?):\/\/)?([^:/\s]+)(?::(\d+))?(?:\/.*)?$/i);
  if (!match) return;
  const [, proto, host, portStr] = match;
  // Plain hostname with no protocol or port — nothing to split, paste normally
  if (!proto && !portStr) return;
  event.preventDefault();
  if (proto === 'https' || proto === 'http') embyServer.protocol = proto as 'https' | 'http';
  embyServer.host = host;
  if (portStr) embyServer.port = Number(portStr);
}

function buildConfig(): EmbywatchConfig | CustomConfig | AutoregConfig | CheckinConfig | null {
  if (form.jobType === 'autoreg') {
    // Template-linked jobs take their whole config from the template
    if (form.templateId) return null;
    const cfg: AutoregConfig = {
      groupId: autoregCfg.groupId,
      codePrefix: autoregCfg.codePrefix,
      signupUsername: autoregCfg.signupUsername,
    };
    if (autoregCfg.entryMode === 'command') cfg.entryMode = 'command';
    else if (autoregCfg.registerButton.trim()) cfg.registerButton = autoregCfg.registerButton.trim();
    if (autoregCfg.listenMinutes > 0 && autoregCfg.listenMinutes !== 30) cfg.listenMinutes = autoregCfg.listenMinutes;
    if (autoregCfg.scanHistoryCount > 0) cfg.scanHistoryCount = autoregCfg.scanHistoryCount;
    if (autoregCfg.codeRegex.trim()) cfg.codeRegex = autoregCfg.codeRegex.trim();
    if (autoregCfg.stripChinese) cfg.stripChinese = true;
    if (autoregCfg.stripChars.trim()) cfg.stripChars = autoregCfg.stripChars.trim();
    if (autoregCfg.aiModifyCode) {
      cfg.aiModifyCode = true;
      if (autoregCfg.aiModifyCodeHint.trim()) cfg.aiModifyCodeHint = autoregCfg.aiModifyCodeHint.trim();
      if (autoregCfg.aiContextCount >= 0 && autoregCfg.aiContextCount !== 6) cfg.aiContextCount = autoregCfg.aiContextCount;
    }
    if (autoregCfg.codeReadyContains.trim()) cfg.codeReadyContains = autoregCfg.codeReadyContains.trim();
    if (autoregCfg.clickAfterCode) {
      cfg.clickAfterCode = true;
      if (autoregCfg.afterCodeButton.trim()) cfg.afterCodeButton = autoregCfg.afterCodeButton.trim();
      if (autoregCfg.afterCodeRequired) cfg.afterCodeRequired = true;
    }
    if (autoregCfg.usernameReadyContains.trim()) cfg.usernameReadyContains = autoregCfg.usernameReadyContains.trim();
    if (autoregCfg.successContains.trim()) cfg.successContains = autoregCfg.successContains.trim();
    if (autoregCfg.failContains.trim()) cfg.failContains = autoregCfg.failContains.trim();
    return cfg;
  }
  if (form.jobType === 'embywatch') {
    if (form.templateId) {
      // Template provides all settings; persist credentials and explicit
      // duration overrides. The marker lets template updates distinguish an
      // override from a legacy copy of the template defaults.
      const overrides: Partial<Record<LinkedDurationKey, number>> = {};
      if (embyCfg.playDuration !== '') overrides.playDuration = Number(embyCfg.playDuration as string | number);
      if (embyCfg.playDurationMax !== '') overrides.playDurationMax = Number(embyCfg.playDurationMax as string | number);
      return {
        username: embyCfg.username,
        password: embyCfg.password,
        [EMBY_TEMPLATE_META_KEY]: { overrides },
      } as unknown as EmbywatchConfig;
    }
    const cfg: EmbywatchConfig = { username: embyCfg.username, password: embyCfg.password };
    if (embyCfg.playDuration !== '') cfg.playDuration = Number(embyCfg.playDuration as string | number);
    if (embyCfg.playDurationMax !== '') cfg.playDurationMax = Number(embyCfg.playDurationMax as string | number);
    if (embyCfg.backupUrl) cfg.backupUrl = embyCfg.backupUrl;
    if (embyCfg.userAgent) cfg.userAgent = embyCfg.userAgent;
    cfg.markWatched = embyCfg.markWatched;
    cfg.verifyPlayable = embyCfg.verifyPlayable;
    cfg.realWatch = embyCfg.realWatch;
    cfg.sequencePlay = embyCfg.sequencePlay;
    if (embyCfg.library) cfg.library = embyCfg.library;
    return cfg;
  }
  if (form.jobType === 'custom') {
    if (form.templateId) {
      return {
        actions: [],
        jobOptionValues: { ...customOptionValues },
      } as CustomConfig;
    }
    const cfg: CustomConfig = {
      actions: customActions.value.map(a => {
        if (isAdvancedAction(a.type)) return workflowToConfig(a.workflow);
        if (a.type === 'send_command') {
          let content: string;
          if (a.contentDropdown === '{aiInput}') {
            content = a.contentAiInputLength ? `{aiInput:${a.contentAiInputLength}}` : '{aiInput}';
          } else {
            content = a.contentDropdown === 'custom' ? a.contentCustom : a.contentDropdown;
          }
          return { type: 'send_command' as const, content, ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}) };
        }
        if (a.type === 'send_contact_message') {
          let content: string;
          if (a.contentDropdown === '{aiInput}') {
            content = a.contentAiInputLength ? `{aiInput:${a.contentAiInputLength}}` : '{aiInput}';
          } else {
            content = a.contentDropdown === 'custom' ? a.contentCustom : a.contentDropdown;
          }
          return { type: 'send_contact_message' as const, contact: a.contact, content, ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}) };
        }
        if (a.type === 'wait_reply') {
          return {
            type: 'wait_reply' as const,
            maxWaitMs: a.maxWaitMs,
            ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
            ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
            ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
            ...(a.scope ? { scope: a.scope } : {}),
          };
        }
        if (a.type === 'delay') return { type: 'delay' as const, waitMs: a.waitMs };
        if (a.type === 'save_tag') return {
          type: 'save_tag' as const,
          name: a.tagName.trim(),
          ...(a.tagRegex.trim() ? { regex: a.tagRegex.trim() } : { value: a.tagValue.trim() }),
        };
        if (a.type === 'enter_captcha') {
          const captchaLength = a.captchaLength ? parseInt(a.captchaLength) || undefined : undefined;
          return { type: 'enter_captcha' as const, maxWaitMs: a.maxWaitMs, captchaLength, ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}) };
        }
        if (a.type === 'join_group') return {
          type: 'join_group' as const,
          groupId: a.groupId,
          ...(a.checkMembership ? { checkMembership: true } : {}),
          ...(a.alreadyMemberEndsTask ? { alreadyMemberEndsTask: true } : {}),
          ...(a.verifyButton.trim() ? { verifyButton: a.verifyButton.trim(), verifyWaitMs: a.verifyWaitMs } : {}),
        };
        if (a.type === 'subscribe_channel') return { type: 'subscribe_channel' as const, channelId: a.channelId, ...(a.checkMembership ? { checkMembership: true } : {}) };
        if (a.type === 'leave_group') return { type: 'leave_group' as const, groupId: a.groupId };
        if (a.type === 'unsubscribe_channel') return { type: 'unsubscribe_channel' as const, channelId: a.channelId };
        if (a.type === 'mini_app_http') return {
          type: 'mini_app_http' as const,
          url: a.url.trim(),
          ...(a.contact.trim() ? { bot: a.contact.trim() } : {}),
          method: a.method,
          ...(a.method === 'POST' && a.body ? { body: a.body } : {}),
          ...(a.body ? { contentType: a.contentType } : {}),
          ...(a.responseVariable.trim() ? { responseVariable: a.responseVariable.trim() } : {}),
          ...(a.statusVariable.trim() ? { statusVariable: a.statusVariable.trim() } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxWaitMs > 0 ? { maxWaitMs: a.maxWaitMs } : {}),
          ...(a.sendInitData ? { sendInitData: true } : {}),
        };
        if (a.type === 'watch_codes') return {
          type: 'watch_codes' as const,
          groupId: a.groupId.trim(),
          regex: a.watchCodeRegex.trim(),
          ...(a.watchCodeCommand.trim() ? { command: a.watchCodeCommand.trim() } : {}),
          ...(a.watchCodeBot.trim() ? { bot: a.watchCodeBot.trim() } : {}),
          ...(a.maxWaitMs > 0 ? { maxWaitMs: a.maxWaitMs } : {}),
          ...(a.watchCodeMaxCodeAgeMs >= 0 ? { maxCodeAgeMs: a.watchCodeMaxCodeAgeMs } : {}),
          ...(a.watchCodeReplyWaitMs > 0 ? { replyWaitMs: a.watchCodeReplyWaitMs } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
        };
        if (a.type === 'open_mini_app') return {
          type: 'open_mini_app' as const,
          ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
          ...(a.button.trim() ? { button: a.button.trim() } : {}),
          ...(a.appButton.trim() ? { appButtons: a.appButton.split(/->|>/).map(x => x.trim()).filter(Boolean) } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...(a.miniAppProxyId ? { proxyId: a.miniAppProxyId } : {}),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
        };
        if (a.type === 'open_mini_app_url') return {
          type: 'open_mini_app_url' as const,
          url: a.url.trim(),
          ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
          ...(a.appButton.trim() ? { appButtons: a.appButton.split(/->|>/).map(x => x.trim()).filter(Boolean) } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...(a.miniAppProxyId ? { proxyId: a.miniAppProxyId } : {}),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
        };
        if (a.type === 'open_bot_menu_app') return {
          type: 'open_bot_menu_app' as const,
          ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
          ...(a.appButton.trim() ? { appButtons: a.appButton.split(/->|>/).map(x => x.trim()).filter(Boolean) } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...(a.miniAppProxyId ? { proxyId: a.miniAppProxyId } : {}),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
        };
        if (a.type === 'open_url') return {
          type: 'open_url' as const,
          url: a.url.trim(),
          ...(a.webSteps.length ? { steps: webStepsToConfig(a.webSteps) } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...(a.miniAppProxyId ? { proxyId: a.miniAppProxyId } : {}),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
        };
        let button: string;
        if (a.buttonDropdown === 'custom') button = a.buttonCustom;
        else if (a.buttonDropdown === '{aiBtn}') button = a.buttonAiHint.trim() ? `{aiBtn:${a.buttonAiHint.trim()}}` : '{aiBtn}';
        else button = a.buttonDropdown || '签到';
        if (a.type === 'click_message_button') return {
          type: 'click_message_button' as const,
          contact: a.contact,
          button,
          maxRetries: a.maxRetries,
          maxWaitMs: a.maxWaitMs,
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.scope ? { scope: a.scope } : {}),
          ...(a.cfChallenge ? { cfChallenge: true } : {}),
        };
        if (a.type === 'watch_buttons') return {
          type: 'watch_buttons' as const,
          groupId: a.groupId.trim(),
          button: a.button.trim(),
          ...(a.alsoWatchButtonsText.trim() ? { alsoWatchButtons: a.alsoWatchButtonsText.split(/[,，]/).map((x) => x.trim()).filter(Boolean) } : {}),
          ...(a.maxWaitMs > 0 ? { maxWaitMs: a.maxWaitMs } : {}),
          ...(a.minShare > 0 ? { minShare: a.minShare } : {}),
          ...(a.thankYouText.trim() ? { thankYou: a.thankYouText.split(/[,，]/).map((x) => x.trim()).filter(Boolean) } : {}),
          ...(a.thankAiHint.trim() ? { thankAiHint: a.thankAiHint.trim() } : {}),
          ...(a.thankWhenContains.trim() ? { thankWhenContains: a.thankWhenContains.trim() } : {}),
          ...(a.thankDelayMinMs > 0 ? { thankDelayMinMs: a.thankDelayMinMs } : {}),
          ...(a.thankDelayMaxMs > 0 ? { thankDelayMaxMs: a.thankDelayMaxMs } : {}),
          ...(a.thankAsReply ? { thankAsReply: true } : {}),
          ...(a.forwardPrivateTo.trim() ? { forwardPrivateTo: a.forwardPrivateTo.trim() } : {}),
          ...(a.forwardTemplate.trim() ? { forwardTemplate: a.forwardTemplate.trim() } : {}),
          ...(a.forwardWaitMs > 0 ? { forwardWaitMs: a.forwardWaitMs } : {}),
        };
        return {
          type: 'click_button' as const,
          button,
          maxRetries: a.maxRetries,
          maxWaitMs: a.maxWaitMs,
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.scope ? { scope: a.scope } : {}),
          ...(a.cfChallenge ? { cfChallenge: true } : {}),
        };
      }),
    };
    if (customJobMaxRetries.value > 1) cfg.maxRetries = customJobMaxRetries.value;
    if (customVariables.value && Object.keys(customVariables.value).length) cfg.variables = customVariables.value;
    return cfg;
  }
  if (form.jobType === 'checkin') {
    const s = checkinSuccessContains.value.trim();
    const f = checkinFailContains.value.trim();
    const cf = checkinCfChallenge.value;
    if (s || f || cf)
      return { ...(s ? { successContains: s } : {}), ...(f ? { failContains: f } : {}), ...(cf ? { cfChallenge: true } : {}) };
  }
  return null;
}

async function saveJob() {
  formError.value = '';
  if (![form.firstRunMinDays, form.firstRunMaxDays].every(value =>
    Number.isSafeInteger(value) && value >= 0 && value <= 3650) ||
    form.firstRunMaxDays < form.firstRunMinDays) {
    formError.value = t('jobOptions.invalidRange');
    return;
  }
  if (!form.runOnce && !runEveryDaysValid.value) {
    formError.value = t('jobs.runEveryDaysHint');
    return;
  }
  if (!form.name) { formError.value = t('jobs.errors.nameRequired'); return; }
  if ((form.jobType === 'checkin' || form.jobType === 'custom' || form.jobType === 'autoreg') && !form.accountId) { formError.value = t('jobs.errors.accountRequired'); return; }
  if (form.jobType === 'custom') {
    // No target bot needed: an action can name its own contact, or drive a page that
    // never touches Telegram. The ones that do need it say so when they run.
    if (customActions.value.length === 0) { formError.value = t('jobs.errors.customActionsRequired'); return; }
    if (!form.templateId) {
      for (const action of customActions.value.filter(a => a.type === 'save_tag')) {
        if (!action.tagName.trim() || ['__proto__', 'constructor', 'prototype'].includes(action.tagName.trim())) { formError.value = t('jobs.errors.tagNameRequired'); return; }
        if (!action.tagRegex.trim() && !action.tagValue.trim()) { formError.value = t('jobs.errors.tagValueRequired'); return; }
        if (action.tagRegex.trim() && !regexValid(action.tagRegex)) { formError.value = t('jobs.errors.tagRegexInvalid'); return; }
      }
      for (const action of customActions.value.filter(a => a.type === 'mini_app_http')) {
        if (!action.url.trim()) { formError.value = '小程序 HTTP 请求需要填写接口地址'; return; }
        if (action.method === 'GET' && action.body) { formError.value = 'GET 请求不能填写请求体'; return; }
        for (const name of [action.responseVariable, action.statusVariable]) {
          if (name.trim() && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name.trim())) { formError.value = '响应变量名不合法'; return; }
        }
      }
      for (const action of customActions.value.filter(a => a.type === 'watch_codes')) {
        if (!action.groupId.trim()) { formError.value = '抢码需要填写监听群组'; return; }
        if (!action.watchCodeRegex.trim() || !regexValid(action.watchCodeRegex)) { formError.value = '抢码正则表达式无效'; return; }
        if (action.watchCodeCommand.length > 1024) { formError.value = '抢码发送命令过长'; return; }
        if (!Number.isFinite(action.maxWaitMs) || action.maxWaitMs < 1000 || action.maxWaitMs > 86400000) { formError.value = '抢码监听时长超出范围'; return; }
        if (!Number.isFinite(action.watchCodeMaxCodeAgeMs) || action.watchCodeMaxCodeAgeMs < 0 || action.watchCodeMaxCodeAgeMs > 86400000) { formError.value = '抢码旧码宽限超出范围'; return; }
        if (!Number.isFinite(action.watchCodeReplyWaitMs) || action.watchCodeReplyWaitMs < 100 || action.watchCodeReplyWaitMs > 600000) { formError.value = '抢码回复等待超出范围'; return; }
      }
    }
  }
  if (form.jobType === 'autoreg' && !form.templateId) {
    if (!form.botUsername) { formError.value = t('jobs.errors.botRequired'); return; }
    if (!autoregCfg.groupId) { formError.value = t('jobs.errors.autoregGroupRequired'); return; }
    if (!autoregCfg.codePrefix && !autoregCfg.codeRegex) { formError.value = t('jobs.errors.autoregPrefixRequired'); return; }
    if (autoregCfg.codeRegex && !regexValid(autoregCfg.codeRegex)) { formError.value = t('jobs.errors.autoregRegexInvalid'); return; }
    if (!autoregCfg.signupUsername) { formError.value = t('jobs.errors.autoregUsernameRequired'); return; }
  }
  if (form.jobType === 'embywatch') {
    if (!embyServer.host) { formError.value = t('jobs.errors.hostRequired'); return; }
    const portPart = (embyServer.port as number | string) !== '' ? `:${embyServer.port}` : '';
    // Strip any accidental protocol prefix the user may have typed into the host field
    form.botUsername = `${embyServer.protocol}://${embyServer.host.replace(/^https?:\/\//, '')}${portPart}`;
  }
  if (form.jobType !== 'custom' && !form.botUsername) { formError.value = t('jobs.errors.botRequired'); return; }
  if (form.jobType === 'checkin' || form.jobType === 'autoreg') form.botUsername = form.botUsername.replace(/^@+/, '');
  if (form.jobType === 'embywatch' && !embyCfg.username) {
    formError.value = t('jobs.errors.embyCredRequired');
    return;
  }
  saving.value = true;
  try {
    // Verify server reachability and credentials before saving the job
    if (form.jobType === 'embywatch') {
      let proxyId: string | undefined;
      let userAgent: string | undefined = embyCfg.userAgent || undefined;
      if (form.templateId && linkedTemplate.value?.config) {
        try {
          const c = JSON.parse(linkedTemplate.value.config) as { proxyId?: string; userAgent?: string };
          proxyId = c.proxyId;
          userAgent = c.userAgent || undefined;
        } catch { /* ignore bad template config */ }
      }
      const test = await jobsApi.testEmby({
        serverUrl: form.botUsername,
        username: embyCfg.username,
        password: embyCfg.password,
        ...(userAgent ? { userAgent } : {}),
        ...(proxyId ? { proxyId } : {}),
      });
      if (!test.ok) {
        formError.value = `${t('jobs.errors.embyVerifyFailed')}${test.error ? `: ${test.error}` : ''}`;
        return;
      }
    }
    const rawCfg = buildConfig();
    const startCommand = (cmdDropdown.value === 'custom' ? cmdCustom.value : cmdDropdown.value) || undefined;
    const resolvedAiBtn = btnAiHint.value.trim() ? `{aiBtn:${btnAiHint.value.trim()}}` : '{aiBtn}';
    const checkinButton = btnDropdown.value === '{aiBtn}'
      ? resolvedAiBtn
      : (btnDropdown.value === 'custom' ? btnCustom.value : btnDropdown.value) || undefined;
    const re = parseRunEvery(runEveryDaysText.value);
    form.runEveryDays = re.min;
    form.runEveryDaysMax = re.max;
    const payload = {
      ...form,
      // config is serialised by the backend; pass as-is
      config: rawCfg as unknown as string | null,
      startCommand,
      checkinButton,
      templateId: form.templateId ?? null,
    };
    if (editTarget.value) {
      await jobsApi.update(editTarget.value.id, payload);
    } else {
      await jobsApi.create(payload);
    }
    showForm.value = false;
    await Promise.all([loadJobs(), loadStatus()]);
  } catch (err: any) {
    formError.value = err.response?.data?.error ?? err.message ?? t('common.saveFailed');
  } finally {
    saving.value = false;
  }
}

function openExtract(j: Job) {
  extractSource.value = j;
  extractName.value = j.name;
  extractError.value = '';
}

async function confirmExtract() {
  const job = extractSource.value;
  if (!job) return;
  if (!extractName.value) { extractError.value = t('jobs.errors.nameRequired'); return; }
  extractSaving.value = true;
  extractError.value = '';
  try {
    const tpl = await templatesApi.create({
      name: extractName.value,
      jobType: job.jobType,
      botUsername: job.botUsername,
      timezone: job.timezone,
      replyTimeoutMs: job.replyTimeoutMs,
      retryMax: job.retryMax,
      config: job.config ? JSON.parse(job.config) as unknown as string | null : null,
      startCommand: job.startCommand,
      checkinButton: job.checkinButton,
      runEveryDays: job.runEveryDays,
      runEveryDaysMax: job.runEveryDaysMax,
      runOnce: job.runOnce,
      firstRunMinDays: job.firstRunMinDays,
      firstRunMaxDays: job.firstRunMaxDays,
      rerunOnRestart: job.rerunOnRestart,
      exclusiveAccount: job.exclusiveAccount,
    });
    await jobsApi.update(job.id, { templateId: tpl.id });
    extractSource.value = null;
    showForm.value = false;
    await Promise.all([loadJobs(), loadTemplates()]);
  } catch (err: any) {
    extractError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    extractSaving.value = false;
  }
}

async function toggleEnabled(j: Job) {
  if (j.enabled) {
    confirmDisableJob.value = j;
    return;
  }
  await jobsApi.update(j.id, { enabled: true });
  await Promise.all([loadJobs(), loadStatus()]);
}

async function executeDisable() {
  if (!confirmDisableJob.value) return;
  await jobsApi.update(confirmDisableJob.value.id, { enabled: false });
  await Promise.all([loadJobs(), loadStatus()]);
  confirmDisableJob.value = null;
}

async function retire(id: number) {
  if (!confirm(t('jobs.confirmRetire'))) return;
  await jobsApi.delete(id);
  selectedJobIds.value = selectedJobIds.value.filter(i => i !== id);
  await loadJobs();
}

async function openOutcome(job: Job, status: 'success' | 'failed') {
  outcomeJob.value = job;
  outcomeStatus.value = status;
  await refreshOutcome();
}

async function refreshOutcome() {
  const job = outcomeJob.value;
  if (!job) return;
  outcomeRevision.value = '';
  outcomeLatest.value = null;
  outcomeError.value = '';
  await nextTick();
  outcomeDialog.value?.focus();
  await outcomeRequest.run(async ({ signal, commit }) => {
    const current = await outcomesApi.get(job.id, signal);
    commit(() => {
      outcomeRevision.value = current.revision;
      outcomeLatest.value = current.latestLog;
    });
  });
}

function closeOutcome() {
  if (outcomeSaving.value) return;
  outcomeRequest.cancel();
  outcomeJob.value = null;
}

async function confirmOutcome() {
  const job = outcomeJob.value;
  if (!job || !outcomeRevision.value || outcomeSaving.value || outcomeLoading.value) return;
  outcomeSaving.value = true;
  outcomeError.value = '';
  try {
    const result = await outcomesApi.mark(job.id, outcomeStatus.value, outcomeRevision.value);
    outcomeJob.value = null;
    await Promise.all([loadJobs(), loadStatus()]);
    if (result.scheduleRefreshPending) {
      outcomeWarning.value = `${job.name}: ${t('jobs.outcomeSchedulePending')}`;
    }
  } catch (err: any) {
    if (err.response?.status === 409) outcomeRevision.value = '';
    outcomeError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    outcomeSaving.value = false;
    await nextTick();
    outcomeDialog.value?.focus();
  }
}

function toggleAllJobs() {
  selectedJobIds.value = allJobsSelected.value ? [] : jobs.value.map(j => j.id);
}

// Index of the last row toggled without Shift; anchors Shift-click ranges.
let lastJobSelectedIdx: number | null = null;

function toggleJobSelect(id: number, idx: number, event?: MouseEvent) {
  // Shift-click selects the contiguous range between the anchor row and this
  // one; other clicks toggle a single row and reset the anchor.
  if (event?.shiftKey && lastJobSelectedIdx !== null) {
    // Shift-click would otherwise highlight the intervening table text.
    window.getSelection?.()?.removeAllRanges();
    const next = new Set(selectedJobIds.value);
    const [lo, hi] = [lastJobSelectedIdx, idx].sort((a, b) => a - b);
    for (let i = lo; i <= hi; i++) {
      const row = jobs.value[i];
      if (row) next.add(row.id);
    }
    selectedJobIds.value = [...next];
    return;
  }
  const arrIdx = selectedJobIds.value.indexOf(id);
  if (arrIdx === -1) selectedJobIds.value.push(id);
  else selectedJobIds.value.splice(arrIdx, 1);
  lastJobSelectedIdx = idx;
}

// The anchor indexes the current list, so clear it whenever the list is
// replaced (search, filter, reload) to avoid spanning stale rows.
watch(jobs, () => {
  lastJobSelectedIdx = null;
});

async function bulkEnableJobs() {
  await Promise.all(selectedJobIds.value.map(id => jobsApi.update(id, { enabled: true })));
  await Promise.all([loadJobs(), loadStatus()]);
  selectedJobIds.value = [];
}

async function executeBulkDisableJobs() {
  await Promise.all(selectedJobIds.value.map(id => jobsApi.update(id, { enabled: false })));
  await Promise.all([loadJobs(), loadStatus()]);
  confirmBulkDisableJobs.value = false;
  selectedJobIds.value = [];
}

async function executeBulkRetireJobs() {
  await Promise.all(selectedJobIds.value.map(id => jobsApi.delete(id)));
  await loadJobs();
  confirmBulkRetireJobs.value = false;
  selectedJobIds.value = [];
}

async function executeBulkChangeWindow() {
  await Promise.all(selectedJobIds.value.map(id => jobsApi.update(id, {
    scheduleWindowStart: bulkWindowStart.value,
    scheduleWindowEnd: bulkWindowEnd.value,
  })));
  await Promise.all([loadJobs(), loadStatus()]);
  showBulkWindowModal.value = false;
  selectedJobIds.value = [];
}

function stopRunning(jobId: number) {
  running.value.delete(jobId);
  running.value = new Set(running.value);
  const timer = pollTimers.get(jobId);
  if (timer) { clearTimeout(timer); pollTimers.delete(jobId); }
}

function schedulePoll(jobId: number) {
  if (disposed) return;
  const timer = setTimeout(async () => {
    try {
      const status = await executionsApi.list();
      if (disposed) return;
      if ([...status.running, ...status.queued].some((entry) => entry.jobId === jobId)) {
        schedulePoll(jobId);
      } else {
        stopRunning(jobId);
      }
    } catch {
      schedulePoll(jobId);
    }
  }, 3000);
  pollTimers.set(jobId, timer);
}

const bulkRunToast = ref('');
let bulkRunToastTimer: ReturnType<typeof setTimeout> | null = null;

function showBulkRunToast(msg: string) {
  if (bulkRunToastTimer) clearTimeout(bulkRunToastTimer);
  bulkRunToast.value = msg;
  bulkRunToastTimer = setTimeout(() => { bulkRunToast.value = ''; }, 3000);
}

async function enqueueSelectedJobs() {
  if (bulkRunSubmitting.value) return;
  bulkRunError.value = '';
  const ids = [...selectedJobIds.value];
  if (!ids.length) return;
  if (!Number.isInteger(bulkRunConcurrency.value) || bulkRunConcurrency.value < 1 ||
    bulkRunConcurrency.value > 20 || !Number.isFinite(bulkRunDelay.value) ||
    bulkRunDelay.value < 0 || bulkRunDelay.value > 3600) {
    bulkRunError.value = t('accountWorkflow.queueBounds');
    return;
  }
  bulkRunSubmitting.value = true;
  try {
    const result = await taskQueueApi.create({
      jobIds: ids, concurrency: bulkRunConcurrency.value, startIntervalSeconds: bulkRunDelay.value,
    });
    if (disposed) return;
    showBulkRunModal.value = false;
    selectedJobIds.value = [];
    showBulkRunToast(t('accountWorkflow.queueSubmitted')
      .replace('{queued}', String(result.queued)).replace('{skipped}', String(result.skipped)));
    await taskQueueRef.value?.focusBatch(result.batchId);
  } catch (err: any) {
    if (!disposed) bulkRunError.value = err.response?.data?.error ?? t('common.triggerFailed');
  } finally {
    bulkRunSubmitting.value = false;
  }
}

async function runNow(id: number) {
  running.value.add(id);
  running.value = new Set(running.value);
  try {
    await jobsApi.run(id);
    schedulePoll(id);
  } catch (err: any) {
    alert(err.response?.data?.error ?? 'Trigger failed');
    stopRunning(id);
  }
}

onUnmounted(() => {
  disposed = true;
  jobsRequest.dispose();
  accountRequest.dispose();
  templateRequest.dispose();
  settingsRequest.dispose();
  outcomeRequest.dispose();
  for (const timer of pollTimers.values()) clearTimeout(timer);
  if (bulkRunToastTimer) clearTimeout(bulkRunToastTimer);
});
</script>

<style scoped>
.custom-action-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: #fafafa;
}

.custom-action-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.custom-action-num {
  min-width: 20px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: #aaa;
}

.custom-action-type-select {
  flex: 1;
}

.custom-action-params {
  padding-left: 26px;
}

.th-sort {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.th-sort:hover {
  background: #f0f4ff;
}

.th-sort.sort-active {
  color: #3730a3;
}

.sort-icon {
  font-size: 10px;
  color: #ccc;
  margin-left: 2px;
}

.th-sort.sort-active .sort-icon {
  color: #6366f1;
}

tbody tr:nth-child(even):not(.row-selected) td {
  background: #f0f2f5;
}

.row-selected td {
  background: #bfdbfe;
}

.badge-tpl {
  display: inline-block;
  font-size: 9px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 3px;
  background: #e0e7ff;
  color: #4338ca;
  margin-left: 5px;
  vertical-align: middle;
  letter-spacing: 0.03em;
}

.template-summary-card {
  margin-bottom: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f0f4ff;
  border: 1px solid #c7d2fe;
}

.template-summary-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.template-summary-detail {
  font-size: 13px;
  color: #4b5563;
}

.template-duration-hint {
  font-size: 11px;
  color: #6b7280;
  margin: -4px 0 12px;
}

/* ── Mobile action sheet ──────────────────────────────────────────────────────── */

.action-sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 200;
  display: flex;
  align-items: flex-end;
}

.action-sheet {
  background: #fff;
  border-radius: 16px 16px 0 0;
  width: 100%;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12);
}

.action-sheet-header {
  padding: 14px 20px 10px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
  border-bottom: 1px solid #f0f0f0;
}

.action-sheet-btn {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 15px 20px;
  background: none;
  border: none;
  font-size: 15px;
  color: #1a1a2e;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.action-sheet-btn:not(:disabled):active {
  background: #f5f5f5;
}

.action-sheet-btn.danger {
  color: #e63946;
}

.action-sheet-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-sheet-divider {
  height: 1px;
  background: #f0f0f0;
  margin: 4px 0;
}

.action-sheet-cancel {
  color: #888;
  font-weight: 500;
}

.last-success {
  font-size: 13px;
  color: #555;
  white-space: nowrap;
}
.last-success-never {
  font-size: 13px;
  color: #aaa;
}

.bulk-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 16px;
  border-top: 1px solid #f0f0f0;
  background: #fafafa;
}

.bulk-count {
  font-size: 13px;
  color: #666;
  white-space: nowrap;
}

.job-toast {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(26, 26, 46, 0.88);
  color: #fff;
  font-size: 13px;
  padding: 8px 20px;
  border-radius: 20px;
  pointer-events: none;
  z-index: 9999;
  white-space: nowrap;
  animation: job-fade-in 0.15s ease;
}

@keyframes job-fade-in {
  from { opacity: 0; transform: translateX(-50%) translateY(6px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
</style>
