/**
 * Danmaku XML / ASS conversion.
 * Ported from Bilibili-Evolved (MIT, https://github.com/the1812/Bilibili-Evolved):
 *   registry/lib/components/video/danmaku/converter/*
 *   src/components/video/ass-utils.ts, xml-utils.ts
 * Node has no <canvas>, so text width is estimated per character instead of measured.
 */
import type { DanmakuElem } from './proto.js'

export interface Danmaku {
  content: string
  /** seconds */
  startTime: number
  type: number
  fontSize: number
  color: number
  timeStamp: number
  pool: number
  userHash: string
  rowId: string
}

export const fromElem = (e: DanmakuElem): Danmaku => ({
  content: e.content ?? '',
  startTime: e.progress ? e.progress / 1000 : 0,
  type: e.mode ?? 1,
  fontSize: e.fontsize ?? 25,
  color: e.color ?? 16777215,
  timeStamp: Number(e.ctime ?? 0),
  pool: e.pool ?? 0,
  userHash: e.midHash ?? '0',
  rowId: e.idStr ?? '0',
})

// ---------- xml ----------
const escapeXml = (s: string) =>
  s
    .replace(/&/g, '&#38;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;')

export const toXml = (cid: number | string, list: Danmaku[]) => {
  const lines = list.map(d => {
    const p = [d.startTime, d.type, d.fontSize, d.color, d.timeStamp, d.pool, d.userHash, d.rowId]
    return `  <d p="${p.join(',')}">${escapeXml(d.content)}</d>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver><chatid>${cid}</chatid><mission>0</mission><maxlimit>${list.length}</maxlimit><state>0</state><real_name>0</real_name><source>k-v</source>\n${lines.join('\n')}\n</i>`
}

// ---------- ass utils ----------
const round2 = (n: number) => {
  const [integer, decimal = '00'] = String(n).split('.')
  return `${integer.padStart(2, '0')}.${decimal.substring(0, 2).padEnd(2, '0')}`
}
export const secondsToAssTime = (total: number) => {
  let seconds = total
  let minutes = 0
  let hours = 0
  while (seconds >= 60) {
    seconds -= 60
    minutes++
  }
  while (minutes >= 60) {
    minutes -= 60
    hours++
  }
  // avoid float noise like 1.0000000002 after subtraction
  seconds = Math.round(seconds * 1000) / 1000
  return `${hours}:${String(minutes).padStart(2, '0')}:${round2(seconds)}`
}
export const normalizeAssContent = (content: string) =>
  content
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n/g, '\\N')
const hexColorForDialogue = (color: number) => {
  const hex = color.toString(16).padStart(6, '0')
  return `\\c&H${`${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase()}&`
}

/** Approximate rendered width: CJK/full-width ≈ 1em, others ≈ 0.55em */
export const estimateTextWidth = (text: string, px: number) => {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    width += code > 0x2e80 || (code >= 0xff00 && code <= 0xffef) ? px : px * 0.55
  }
  return width
}

// ---------- converter ----------
export interface AssOptions {
  title: string
  font?: string
  /** 0 = opaque, 1 = invisible (Bilibili-Evolved default 0.4) */
  alpha?: number
  bold?: boolean
  /** scroll speed level from the player, -2..2 (default 0 → 18s scroll) */
  speed?: number
  resolution?: { x: number; y: number }
  /** fraction of the screen bottom left empty (default 0.15, protects subtitles) */
  bottomMarginPercent?: number
  /** danmaku types to drop; 7/8 (advanced) are always dropped */
  blockTypes?: (number | 'color')[]
  blockKeywords?: string[]
}

const FONT_PX: Record<number, number> = { 30: 64, 25: 52, 18: 36, 45: 90, 36: 72 }
const MARGIN = 4
const NEXT_DELAY = 0.05
const WHITE = 16777215

export const toAss = (list: Danmaku[], options: AssOptions) => {
  const font = options.font ?? 'Microsoft YaHei'
  const alpha = Math.round((options.alpha ?? 0.4) * 255)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0')
  const bold = options.bold ? '1' : '0'
  const resolution = options.resolution ?? { x: 1920, y: 1080 }
  const scrollDuration = 18 - 3 * (options.speed ?? 0)
  const duration = (d: Danmaku) => (d.type === 4 || d.type === 5 ? 4 : scrollDuration)
  const blockTypes = [...(options.blockTypes ?? []), 7, 8]
  const keywords = options.blockKeywords ?? []

  const style = (name: string, size: number) =>
    `Style: ${name},${font},${size},&H${alpha}FFFFFF,&H${alpha}FFFFFF,&H${alpha}000000,&H${alpha}000000,${bold},0,0,0,100,100,0,0,1,1.2,0,5,0,0,0,0`
  const styles: Record<number, string> = {
    36: style('Larger', 72),
    30: style('Large', 64),
    25: style('Medium', 52),
    18: style('Small', 36),
    45: style('ExtraLarge', 90),
  }
  const styleName = (size: number) => (styles[size] ?? styles[25]).match(/Style:(.*?),/)![1].trim()

  // track layout (DanmakuStack)
  const danmakuHeight = 52
  const trackHeight = MARGIN * 2 + danmakuHeight
  const trackCount = Math.trunc((resolution.y * (1 - (options.bottomMarginPercent ?? 0.15))) / trackHeight)
  type Item = { start: number; end: number; trackNumber: number; width?: number; visible?: number }
  const horizontal: Item[] = []
  const vertical: Item[] = []

  const place = (
    d: Danmaku,
    track: Item[],
    init: number,
    step: number,
    willOverlay: (it: Item, n: number, width: number) => boolean,
    makeItem: (n: number, width: number, visibleTime: number) => Item,
    tag: (n: number, x: number, y: number) => string,
  ) => {
    const width = Math.round(estimateTextWidth(d.content, FONT_PX[d.fontSize] ?? 52) * 10) / 10
    const x = Math.round(width / 2 * 10) / 10
    const y = danmakuHeight / 2
    const visibleTime = (duration(d) * width) / (resolution.x + width) + NEXT_DELAY
    let n = init
    let overlay: Item | undefined
    do {
      const current = n
      overlay = track.find(it => willOverlay(it, current, width))
      n += step
    } while (overlay && n <= trackCount && n >= 0)
    if (n > trackCount || n < 0) return '\\pos(0,-999)'
    n -= step
    track.push(makeItem(n, width, visibleTime))
    return tag(n, x, y)
  }

  const tagFor = (d: Danmaku): string => {
    if ([1, 2, 3, 6].includes(d.type)) {
      return place(
        d,
        horizontal,
        0,
        1,
        (it, n, width) => {
          if (it.trackNumber !== n) return false
          if ((it.width ?? 0) < width) {
            return (duration(d) * resolution.x) / (resolution.x + width) <= it.end - d.startTime
          }
          return (it.visible ?? 0) > d.startTime
        },
        (n, width, visibleTime) => ({
          width,
          start: d.startTime,
          visible: d.startTime + visibleTime,
          end: d.startTime + duration(d),
          trackNumber: n,
        }),
        (n, x, y) => {
          const top = n * trackHeight + MARGIN + y
          return `\\move(${resolution.x + x},${top},${-x},${top},0,${duration(d) * 1000})`
        },
      )
    }
    if (d.type === 4 || d.type === 5) {
      const isTop = d.type === 5
      return place(
        d,
        vertical,
        isTop ? 0 : trackCount - 1,
        isTop ? 1 : -1,
        (it, n) => it.trackNumber === n && it.end > d.startTime,
        n => ({ start: d.startTime, end: d.startTime + duration(d), trackNumber: n }),
        (n, _x, y) =>
          isTop
            ? `\\pos(${resolution.x / 2},${n * trackHeight + MARGIN + y})`
            : `\\pos(${resolution.x / 2},${resolution.y - MARGIN - y - (trackCount - 1 - n) * trackHeight})`,
      )
    }
    return '\\pos(0,-999)'
  }

  const events: string[] = []
  for (const d of [...list].sort((a, b) => a.startTime - b.startTime)) {
    if (blockTypes.includes(d.type)) continue
    if (blockTypes.includes('color') && d.color !== WHITE) continue
    if (keywords.some(k => d.content.includes(k))) continue
    const start = secondsToAssTime(d.startTime)
    const end = secondsToAssTime(d.startTime + duration(d))
    events.push(
      `Dialogue: 0,${start},${end},${styleName(d.fontSize)},,0,0,0,,{${tagFor(d)}${hexColorForDialogue(d.color)}}${normalizeAssContent(d.content)}`,
    )
  }

  const header = `[Script Info]
; Script generated by bilibili-agent-mcp (converter ported from Bilibili Evolved)
; https://github.com/the1812/Bilibili-Evolved/
Title: ${options.title}
ScriptType: v4.00+
PlayResX: ${resolution.x}
PlayResY: ${resolution.y}
Timer: 10.0000
WrapStyle: 2
ScaledBorderAndShadow: no

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${Object.values(styles).join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`
  return `${header}\n${events.join('\n')}\n`
}
