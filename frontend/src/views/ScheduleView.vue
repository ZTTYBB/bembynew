<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t('nav.schedule') }}</h2>
    </div>
    <div class="schedule-surface">
      <ScheduleList />
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n';
import ScheduleList from '../components/ScheduleList.vue';
</script>

<style scoped>
.schedule-surface {
  padding: 16px 0;
  border-top: 1px solid #e8ebf0;
}
</style>
