<script setup lang="ts">
import { computed } from 'vue';
import { fileIcon } from '../../theme/fileicons';

const props = defineProps<{ name: string }>();
const icon = computed(() => fileIcon(props.name));
</script>

<template>
  <span class="file-icon" :style="{ color: icon.color }">{{ icon.char }}</span>
</template>
