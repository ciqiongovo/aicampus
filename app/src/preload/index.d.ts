import type { RendererApi } from '../shared/types'
import type { ImApi } from '../shared/im'

declare global {
  interface Window {
    api: RendererApi & ImApi
  }
}

export {}
