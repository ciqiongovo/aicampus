/** Main-process external link gate. No Electron dependency, so behavior is unit-testable. */
export function normalizeExternalUrl(raw: string): string | null {
  if (!/^https?:\/\//i.test(raw) || /[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069\\]/.test(raw)) return null
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    return url.href
  } catch { return null }
}

export interface ExternalLinkActions {
  /** Must present canonical URL and hostname, default to cancel, and return true only on explicit approval. */
  confirm: (url: string, hostname: string) => Promise<boolean>
  open: (url: string) => Promise<unknown>
}

/** Only one confirmation/open operation at a time; repeated clicks cannot queue dialog floods. */
export function createConfirmedExternalOpener(actions: ExternalLinkActions): (raw: string) => Promise<boolean> {
  let pending = false
  return async (raw: string): Promise<boolean> => {
    const url = normalizeExternalUrl(raw)
    if (!url || pending) return false
    pending = true
    try {
      if (await actions.confirm(url, new URL(url).hostname) !== true) return false
      await actions.open(url)
      return true
    } catch {
      // Rejected dialogs and shell failures must fail closed, not become unhandled rejections.
      return false
    } finally {
      pending = false
    }
  }
}
