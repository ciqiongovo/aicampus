/** Main-process external-link opener registry: the window layer registers its confirmed opener once; IPC handlers reuse it. */

let opener: ((raw: string) => Promise<boolean>) | null = null

/** Called exactly once by main/index.ts after createConfirmedExternalOpener is built. */
export function registerExternalOpener(fn: (raw: string) => Promise<boolean>): void {
  opener = fn
}

/** IPC entry: routes through the confirmed opener; fails closed when not registered yet. */
export function openExternalSafely(raw: string): Promise<boolean> {
  return opener ? opener(raw) : Promise.resolve(false)
}
