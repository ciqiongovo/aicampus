export interface CloudWord {
  keyword: string
  weight: number
  x: number
  y: number
  fontSize: number
  /** Unrotated dimensions, including a small collision gutter. */
  width: number
  height: number
  rotate: 0 | 90
}

type Keyword = { keyword: string; weight: number }
type Rect = { left: number; top: number; right: number; bottom: number }

/** Deterministic centre-out packing. Coordinates describe the centre of each word. */
export function layoutKeywordCloud(
  items: Keyword[],
  width: number,
  height: number,
  measure: (text: string, fontSize: number) => number
): CloudWord[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return []
  const ranked = items.filter((item) => item.keyword && Number.isFinite(item.weight))
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || a.index - b.index)
  if (!ranked.length) return []
  const highest = Math.max(...ranked.map((item) => Math.abs(item.weight)), 0.01)
  const largest = Math.min(52, width / 10)
  const sizes = ranked.map((item) => 11 + (largest - 11) * Math.pow(Math.abs(item.weight) / highest, 0.8))
  // Estimate a sensible starting scale before doing collision work on dense profiles.
  const area = sizes.reduce((sum, size, i) => sum + (measure(ranked[i].keyword, size) + 4) * (size * 1.15 + 2), 0)
  let scale = Math.min(1, Math.sqrt(width * height * 0.48 / Math.max(area, 1)))
  const gutter = 4
  for (let attempt = 0; attempt < 24; attempt++, scale *= 0.86) {
    const placed: CloudWord[] = []
    const rects: Rect[] = []
    // Bucketed rectangles keep repeated collision checks cheap at 200 words.
    const buckets = new Map<string, number[]>()
    const cell = 32
    const cells = (r: Rect): string[] => {
      const keys: string[] = []
      for (let x = Math.floor(r.left / cell); x <= Math.floor(r.right / cell); x++) {
        for (let y = Math.floor(r.top / cell); y <= Math.floor(r.bottom / cell); y++) keys.push(`${x},${y}`)
      }
      return keys
    }
    for (let i = 0; i < ranked.length; i++) {
      const item = ranked[i]
      const fontSize = sizes[i] * scale
      const wordWidth = measure(item.keyword, fontSize) + gutter
      const wordHeight = fontSize * 1.15 + 2
      const preferredRotation: 0 | 90 = i > 2 && i % 5 === 3 ? 90 : 0
      let found = false
      // Two orientations allow unusually long words to fit narrow windows too.
      for (const rotate of [preferredRotation, preferredRotation === 90 ? 0 : 90] as const) {
        const w = rotate === 90 ? wordHeight : wordWidth
        const h = rotate === 90 ? wordWidth : wordHeight
        if (w > width || h > height) continue
        for (let step = 0; step < 6500; step++) {
          const angle = step * 0.28
          const radius = angle * 0.85
          const x = width / 2 + Math.cos(angle) * radius
          const y = height / 2 + Math.sin(angle) * radius * Math.min(1, height / width)
          const r = { left: x - w / 2, top: y - h / 2, right: x + w / 2, bottom: y + h / 2 }
          if (r.left < 1 || r.top < 1 || r.right > width - 1 || r.bottom > height - 1) continue
          const keys = cells(r)
          const blocked = keys.some((key) => buckets.get(key)?.some((index) => {
            const b = rects[index]
            return r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top
          }))
          if (blocked) continue
          const index = rects.length
          rects.push(r)
          keys.forEach((key) => buckets.set(key, [...(buckets.get(key) ?? []), index]))
          placed.push({ keyword: item.keyword, weight: item.weight, x, y, fontSize, width: wordWidth, height: wordHeight, rotate })
          found = true
          break
        }
        if (found) break
      }
      if (!found) break
    }
    if (placed.length === ranked.length) return placed
  }
  return []
}
