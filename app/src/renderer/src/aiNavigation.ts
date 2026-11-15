import type { ResourceReference } from '@shared/workspace'
import { PREF, AI_HANDOFF_EVENT, LEGACY_AI_HANDOFF_EVENT } from './prefs'

let pending: ResourceReference | null = null
let returnHash = '#/jarvis'
/** Keep a stable reference, not an untraceable copy of the article/email body. */
export function handoffToAi(reference: ResourceReference): void {
  pending = reference
  if (!window.location.hash.startsWith('#/jarvis')) returnHash = window.location.hash || '#/daily'
  sessionStorage.setItem(PREF.aiReturn, returnHash)
  window.location.hash = '/jarvis'
  window.dispatchEvent(new Event(AI_HANDOFF_EVENT))
  window.dispatchEvent(new Event(LEGACY_AI_HANDOFF_EVENT))
}
export function takeAiHandoff(): ResourceReference | null { const ref = pending; pending = null; return ref }
export function returnFromAi(): void { window.location.hash = sessionStorage.getItem(PREF.aiReturn) || returnHash }
export function goToAiSettings(): void { window.location.hash = '/jarvis/settings' }
