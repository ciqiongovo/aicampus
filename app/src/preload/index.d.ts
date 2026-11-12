import type { RendererApi } from '../shared/types'
import type { ImApi } from '../shared/im'
import type { BenchApi } from '../shared/benchmark'

declare global {
  interface Window {
    api: RendererApi & ImApi & BenchApi
  }
}

export {}
