import type { ResourceReference } from '@shared/workspace'
let pending: ResourceReference | null = null
let returnHash = '#/jarvis'
/** Keep a stable reference, not an untraceable copy of the article/email body. */
export function handoffToAi(reference: ResourceReference): void {
  pending = reference
  if (!window.location.hash.startsWith('#/jarvis')) returnHash = window.location.hash || '#/daily'
  sessionStorage.setItem('infoagent.aiReturn', returnHash)
  window.location.hash = '/jarvis'
  window.dispatchEvent(new Event('infoagent:ai-handoff'))
}
export function takeAiHandoff(): ResourceReference | null { const ref = pending; pending = null; return ref }
export function returnFromAi(): void { window.location.hash = sessionStorage.getItem('infoagent.aiReturn') || returnHash }
export function goToAiSettings(): void { window.location.hash = '/jarvis/settings' }
