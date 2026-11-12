/** Coalesce drag work to one React update per frame; caller owns lifecycle cleanup. */
export function beginSiderResize(host: Window, body: HTMLElement, left: number, onWidth: (width: number) => void): () => void {
  const cursor = body.style.cursor
  const userSelect = body.style.userSelect
  let frame = 0
  let width = 200
  let disposed = false
  body.style.cursor = 'col-resize'
  body.style.userSelect = 'none'
  const flush = (): void => { frame = 0; if (!disposed) onWidth(width) }
  const move = (event: MouseEvent): void => {
    width = Math.min(320, Math.max(140, event.clientX - left))
    if (!frame) frame = host.requestAnimationFrame(flush)
  }
  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    if (frame) host.cancelAnimationFrame(frame)
    frame = 0
    body.style.cursor = cursor
    body.style.userSelect = userSelect
    host.removeEventListener('mousemove', move)
    host.removeEventListener('mouseup', finish)
    host.removeEventListener('blur', cleanup)
  }
  const finish = (): void => {
    if (frame) { host.cancelAnimationFrame(frame); flush() }
    cleanup()
  }
  host.addEventListener('mousemove', move)
  host.addEventListener('mouseup', finish)
  host.addEventListener('blur', cleanup)
  return cleanup
}
