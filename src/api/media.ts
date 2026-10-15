import { BiliClient, BiliError } from '../http.js'
import { decodeSegment, decodeView } from '../danmaku/proto.js'
import { Danmaku, fromElem } from '../danmaku/converter.js'
import { ResolvedVideo, getView, getSeason } from './video.js'
import { SubtitleItem } from '../subtitle.js'

// ---------------- danmaku (Bilibili-Evolved: danmaku/download) ----------------

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) => {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export const fetchDanmaku = async (client: BiliClient, video: ResolvedVideo): Promise<Danmaku[]> => {
  let total = 0
  try {
    const view = decodeView(
      await client.buffer('https://api.bilibili.com/x/v2/dm/web/view', {
        query: { type: 1, oid: video.cid, pid: video.aid },
      }),
    )
    total = Number(view.dmSge?.total ?? 0)
  } catch {
    /* fall back to duration based segment count */
  }
  if (!total) total = Math.max(1, Math.ceil((video.duration || 360) / 360))
  const segments = await mapLimit(
    Array.from({ length: total }, (_, i) => i + 1),
    4,
    async index => {
      const buf = await client.buffer('https://api.bilibili.com/x/v2/dm/web/seg.so', {
        query: { type: 1, oid: video.cid, pid: video.aid, segment_index: index },
      })
      return decodeSegment(buf).elems ?? []
    },
  )
  return segments
    .flat()
    .map(e => fromElem({ ...e, ctime: Number(e.ctime ?? 0) }))
    .sort((a, b) => a.startTime - b.startTime)
}

const clock = (seconds: number) => {
  const t = Math.floor(seconds)
  const mm = String(Math.floor(t / 60)).padStart(2, '0')
  const ss = String(t % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/** Statistics an AI can reason about without reading every comment. */
export const danmakuStats = (list: Danmaku[], duration: number, bucketSeconds = 60, top = 30) => {
  const counts = new Map<string, number>()
  for (const d of list) {
    const key = d.content.trim()
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const topPhrases = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([text, count]) => ({ text, count }))
  const bucketCount = Math.max(1, Math.ceil(Math.max(duration, list.at(-1)?.startTime ?? 0) / bucketSeconds))
  const buckets = new Array(bucketCount).fill(0)
  for (const d of list) buckets[Math.min(bucketCount - 1, Math.floor(d.startTime / bucketSeconds))]++
  const density = buckets.map((count, i) => ({ from: clock(i * bucketSeconds), count }))
  const peaks = [...density].sort((a, b) => b.count - a.count).slice(0, 5)
  return { total: list.length, uniqueTexts: counts.size, topPhrases, peaks, density }
}

export const danmakuLines = (list: Danmaku[], opts: { from?: number; to?: number; limit?: number }) => {
  const filtered = list.filter(
    d => (opts.from === undefined || d.startTime >= opts.from) && (opts.to === undefined || d.startTime <= opts.to),
  )
  const limit = opts.limit ?? 500
  // sample evenly if there are too many
  const step = filtered.length > limit ? filtered.length / limit : 1
  const lines: string[] = []
  for (let i = 0; i < filtered.length && lines.length < limit; i += step) {
    const d = filtered[Math.floor(i)]
    lines.push(`[${clock(d.startTime)}] ${d.content}`)
  }
  return { matched: filtered.length, returned: lines.length, sampled: step > 1, lines }
}

// ---------------- player info: subtitles + chapters ----------------

export const getPlayerInfo = (client: BiliClient, video: ResolvedVideo) =>
  client.json<any>('https://api.bilibili.com/x/player/wbi/v2', {
    query: { aid: video.aid, cid: video.cid },
    wbi: true,
  })

export interface SubtitleTrack {
  lang: string
  name: string
  ai: boolean
  url: string
}

export const listSubtitles = async (client: BiliClient, video: ResolvedVideo): Promise<SubtitleTrack[]> => {
  const info = await getPlayerInfo(client, video)
  const subs: any[] = info?.subtitle?.subtitles ?? []
  return subs.map(s => ({
    lang: s.lan,
    name: s.lan_doc,
    ai: s.lan?.startsWith('ai-') || Boolean(s.ai_type),
    url: s.subtitle_url?.startsWith('//') ? `https:${s.subtitle_url}` : s.subtitle_url,
  }))
}

export const fetchSubtitle = async (client: BiliClient, track: SubtitleTrack): Promise<SubtitleItem[]> => {
  if (!track.url) throw new BiliError(`字幕「${track.name}」没有下载地址（可能需要登录）`)
  const res = await client.raw(track.url)
  const json: any = await res.json()
  return (json.body ?? []).map((b: any) => ({
    from: b.from,
    to: b.to,
    location: b.location,
    content: b.content,
  }))
}

/** Pick by language code or display name; prefer human subtitles, then zh, then first. */
export const pickSubtitle = (tracks: SubtitleTrack[], lang?: string) => {
  if (lang) {
    const l = lang.toLowerCase()
    const hit =
      tracks.find(t => t.lang.toLowerCase() === l) ??
      tracks.find(t => t.lang.toLowerCase().includes(l) || t.name.includes(lang))
    if (hit) return hit
  }
  return (
    tracks.find(t => !t.ai && t.lang.startsWith('zh')) ??
    tracks.find(t => t.lang.includes('zh')) ??
    tracks.find(t => !t.ai) ??
    tracks[0]
  )
}

// ---------------- metadata (Bilibili-Evolved: video/metadata) ----------------

export interface Chapter {
  from: number
  to: number
  title: string
}

export const getChapters = async (client: BiliClient, video: ResolvedVideo): Promise<Chapter[]> => {
  const info = await getPlayerInfo(client, video)
  const points: any[] = info?.view_points ?? []
  if (points.length) return points.map(p => ({ from: p.from, to: p.to, title: p.content }))
  // bangumi: convert op/ed skip markers like Bilibili-Evolved's convertBangumiSkips
  if (video.epid) {
    const season = await getSeason(client, { epid: video.epid })
    const ep = (season.episodes ?? []).find((e: any) => (e.ep_id ?? e.id) === video.epid)
    const skip = ep?.skip
    const chapters: Chapter[] = []
    if (skip?.op?.end > 0) chapters.push({ from: skip.op.start, to: skip.op.end, title: 'OP' })
    if (skip?.ed?.end > 0) chapters.push({ from: skip.ed.start, to: skip.ed.end, title: 'ED' })
    return chapters
  }
  return []
}

const ffEscape = (value: unknown) => String(value ?? '').replace(/[=;#\\\n]/g, m => `\\${m}`)

export const buildFFMetadata = async (client: BiliClient, video: ResolvedVideo) => {
  const view = await getView(client, video.aid)
  const chapters = await getChapters(client, video)
  const ff = (k: string, v: unknown, prefix = true) => `${prefix ? 'bilibili_' : ''}${k}=${ffEscape(v)}`
  const lines = [
    ';FFMETADATA1',
    ';generated by bilibili-agent-mcp',
    ff('title', video.pageTitle ? `${view.title} - ${video.pageTitle}` : view.title, false),
    ff('description', view.desc, false),
    ff('artist', view.owner?.name, false),
    ff('aid', view.aid),
    ff('bvid', view.bvid),
    ff('cid', video.cid),
    ff('up_name', view.owner?.name),
    ff('up_uid', view.owner?.mid),
    ff('publish_date', new Date(view.pubdate * 1000).toISOString()),
    ff('category_name', view.tname),
  ]
  for (const c of chapters) {
    lines.push('[CHAPTER]', 'TIMEBASE=1/1', `START=${c.from}`, `END=${c.to}`, `title=${ffEscape(c.title)}`)
  }
  return { text: `${lines.join('\n')}\n`, chapters }
}

export const buildOgmChapters = (chapters: Chapter[]) =>
  chapters
    .flatMap((c, i) => {
      const n = String(i + 1).padStart(3, '0')
      return [`CHAPTER${n}=${new Date(c.from * 1000).toISOString().slice(11, -1)}`, `CHAPTER${n}NAME=${c.title}`]
    })
    .join('\n')
