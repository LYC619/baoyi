import { ref } from 'vue'
import type { DiscoverySelection } from '@/types/video-discovery'
export const pendingDiscoveryDownload = ref<DiscoverySelection | null>(null)
export const pendingWebAddress = ref<string | null>(null)
