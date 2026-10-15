import { BiliClient, BiliError } from '../http.js'
import { av2bv, parseTarget, ParsedTarget, SHORT_LINK_RE } from '../ids.js'

/** Expand b23.tv / bili2233.cn short links by following the redirect once. */
export const expandShortLink = async (client: BiliClient, input: string) => {
  const match = input.match(SHORT_LINK_RE)
  if (!match) return input
  const url = match[0].startsWith('http') ? match[0] : `https://${match[0]}`
  const res = await client.raw(url, { redirect: 'manual' }).catch(() => undefined)
  const location = res?.headers.get('location')
  if (!location) throw new BiliError(`短链接解析失败：${url}`)
  return location
}

export const resolveInput = async (client: BiliClient, input: string): Promise<ParsedTarget> => {
  const expanded = await expandShortLink(client, input)
  const target = parseTarget(expanded)
  if (!target) {
    throw new BiliError(
      `无法识别「${input}」。支持：视频链接 / BV号 / av号 / ep号 / ss号 / md号 / b23.tv 短链 / 空间链接 / 直播间链接`,
    )
  }
  return target
}

const fmtDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return [h, m, s]
    .filter((v, i) => v > 0 || i > 0)
    .map((v, i) => (i === 0 ? String(v) : String(v).padStart(2, '0')))
    .join(':')
}
const fmtTime = (ts: number) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z')

export interface ResolvedVideo {
  aid: number
  bvid: string
  cid: number
  title: string
  pageTitle?: string
  page: number
  pageCount: number
  duration: number
  cover?: string
  owner?: string
  /** set for bangumi / pgc episodes */
  epid?: number
  seasonId?: number
}

/**
 * Raw video view data. Bilibili now answers the unsigned /x/web-interface/view with
 * HTTP 412 for many clients (verified 2026-10), so the WBI-signed variant is used first.
 */
export const getView = async (client: BiliClient, aid: number) => {
  try {
    return await client.json<any>('https://api.bilibili.com/x/web-interface/wbi/view', { query: { aid }, wbi: true })
  } catch (error) {
    // content errors (deleted / private video) are final; fall back only on transport / risk-control errors
    const code = error instanceof BiliError ? error.code : undefined
    const retryable = code === undefined || [-412, -352, -403].includes(code) || (code >= 400 && code < 600)
    if (!retryable) throw error
    return client.json<any>('https://api.bilibili.com/x/web-interface/view', { query: { aid } })
  }
}

export const getSeason = (client: BiliClient, q: { epid?: number; seasonId?: number }) =>
  client.json<any>('https://api.bilibili.com/pgc/view/web/season', {
    query: { ep_id: q.epid, season_id: q.seasonId },
  })

/**
 * Resolve anything playable (BV/av/ep/ss + optional page / cid) to aid+cid.
 * `page` is 1-based; for seasons it selects the n-th episode.
 */
export const resolveVideo = async (
  client: BiliClient,
  input: string,
  opts: { page?: number; cid?: number } = {},
): Promise<ResolvedVideo> => {
  const target = await resolveInput(client, input)
  if (target.kind === 'video') {
    const view = await getView(client, target.aid)
    const pages: any[] = view.pages ?? []
    const pageNumber = opts.page ?? target.page ?? 1
    const page = opts.cid
      ? pages.find(p => p.cid === opts.cid)
      : (pages.find(p => p.page === pageNumber) ?? pages[0])
    if (!page) throw new BiliError(`视频没有第 ${pageNumber} P`)
    const epid = view.redirect_url ? parseInt(view.redirect_url.match(/ep(\d+)/)?.[1] ?? '') : NaN
    return {
      aid: view.aid,
      bvid: view.bvid,
      cid: page.cid,
      title: view.title,
      pageTitle: pages.length > 1 ? page.part : undefined,
      page: page.page,
      pageCount: pages.length,
      duration: page.duration ?? view.duration,
      cover: view.pic,
      owner: view.owner?.name,
      epid: Number.isNaN(epid) ? undefined : epid,
    }
  }
  if (target.kind === 'episode' || target.kind === 'season') {
    const season = await getSeason(client, {
      epid: target.kind === 'episode' ? target.epid : undefined,
      seasonId: target.kind === 'season' ? target.seasonId : undefined,
    })
    const episodes: any[] = season.episodes ?? []
    let episode: any
    if (target.kind === 'episode') episode = episodes.find(e => e.ep_id === target.epid || e.id === target.epid)
    if (!episode && opts.cid) episode = episodes.find(e => e.cid === opts.cid)
    if (!episode) episode = episodes[(opts.page ?? 1) - 1] ?? episodes[0]
    if (!episode) throw new BiliError('该番剧/影视没有可用的剧集')
    return {
      aid: episode.aid,
      bvid: episode.bvid ?? av2bv(episode.aid),
      cid: episode.cid,
      title: season.season_title ?? season.title,
      pageTitle: [episode.title && `第${episode.title}话`, episode.long_title].filter(Boolean).join(' '),
      page: episodes.indexOf(episode) + 1,
      pageCount: episodes.length,
      duration: Math.round((episode.duration ?? 0) / 1000),
      cover: episode.cover ?? season.cover,
      epid: episode.ep_id ?? episode.id,
      seasonId: season.season_id,
    }
  }
  throw new BiliError(`「${input}」不是视频或番剧链接（识别为 ${target.kind}）`)
}

/** Full video information (Bilibili-Evolved: video-info / full-description / metadata / view-cover) */
export const videoInfo = async (client: BiliClient, input: string) => {
  const target = await resolveInput(client, input)
  if (target.kind === 'episode' || target.kind === 'season') {
    return { type: 'bangumi', ...(await bangumiInfo(client, input)) }
  }
  if (target.kind !== 'video') throw new BiliError(`「${input}」不是视频链接（识别为 ${target.kind}）`)
  const view = await getView(client, target.aid)
  let tags: string[] = []
  try {
    const tagData = await client.json<any[]>('https://api.bilibili.com/x/web-interface/view/detail/tag', {
      query: { aid: view.aid, cid: view.cid },
    })
    tags = (tagData ?? []).map(t => t.tag_name).filter(Boolean)
  } catch {
    /* tags are optional */
  }
  const s = view.stat ?? {}
  return {
    type: 'video',
    bvid: view.bvid,
    aid: view.aid,
    url: `https://www.bilibili.com/video/${view.bvid}`,
    title: view.title,
    description: view.desc_v2?.map((d: any) => d.raw_text).join('') || view.desc,
    cover: view.pic,
    category: view.tname_v2 || view.tname,
    tags,
    owner: { mid: view.owner?.mid, name: view.owner?.name, face: view.owner?.face },
    staff: view.staff?.map((x: any) => ({ mid: x.mid, name: x.name, title: x.title })),
    publishedAt: fmtTime(view.pubdate),
    duration: fmtDuration(view.duration),
    durationSeconds: view.duration,
    stat: {
      view: s.view,
      danmaku: s.danmaku,
      reply: s.reply,
      like: s.like,
      coin: s.coin,
      favorite: s.favorite,
      share: s.share,
      highestRank: s.his_rank || undefined,
    },
    copyright: view.copyright === 1 ? 'original' : 'repost',
    pages: (view.pages ?? []).map((p: any) => ({
      page: p.page,
      cid: p.cid,
      title: p.part,
      duration: fmtDuration(p.duration),
    })),
    collection: view.ugc_season
      ? {
          id: view.ugc_season.id,
          title: view.ugc_season.title,
          episodeCount: view.ugc_season.ep_count,
        }
      : undefined,
    bangumiRedirect: view.redirect_url,
  }
}

export const bangumiInfo = async (client: BiliClient, input: string) => {
  const target = await resolveInput(client, input)
  let query: { epid?: number; seasonId?: number }
  if (target.kind === 'episode') query = { epid: target.epid }
  else if (target.kind === 'season') query = { seasonId: target.seasonId }
  else if (target.kind === 'media') {
    const media = await client.json<any>('https://api.bilibili.com/pgc/review/user', {
      query: { media_id: target.mediaId },
    })
    query = { seasonId: media.media?.season_id }
  } else throw new BiliError(`「${input}」不是番剧/影视链接`)
  const season = await getSeason(client, query)
  return {
    seasonId: season.season_id,
    mediaId: season.media_id,
    title: season.season_title || season.title,
    url: season.link,
    cover: season.cover,
    evaluate: season.evaluate,
    areas: season.areas?.map((a: any) => a.name),
    rating: season.rating ? { score: season.rating.score, count: season.rating.count } : undefined,
    stat: season.stat
      ? { views: season.stat.views, favorites: season.stat.favorites, danmakus: season.stat.danmakus }
      : undefined,
    publish: season.publish?.pub_time,
    newEp: season.new_ep?.desc,
    episodes: (season.episodes ?? []).map((e: any, i: number) => ({
      index: i + 1,
      epid: e.ep_id ?? e.id,
      title: e.title,
      longTitle: e.long_title,
      bvid: e.bvid,
      aid: e.aid,
      cid: e.cid,
      badge: e.badge || undefined,
    })),
  }
}

// ---------------- play url ----------------

export const QUALITIES: Record<number, string> = {
  127: '8K 超高清',
  126: '杜比视界',
  125: 'HDR 真彩',
  120: '4K 超清',
  116: '1080P 60帧',
  112: '1080P 高码率',
  100: '智能修复',
  80: '1080P 高清',
  74: '720P 60帧',
  64: '720P 高清',
  32: '480P 清晰',
  16: '360P 流畅',
  6: '240P 极速',
}

export type Codec = 'avc' | 'hevc' | 'av1'
const codecName = (id: number) => (id === 12 ? 'hevc' : id === 13 ? 'av1' : 'avc')

export interface Stream {
  type: 'video' | 'audio'
  url: string
  backupUrls: string[]
  bandwidth: number
  codecs: string
  codec?: Codec
  quality?: number
  qualityName?: string
  width?: number
  height?: number
  frameRate?: string
  /** estimated, bytes */
  size: number
  label?: string
}

const https = (u?: string) => (u ?? '').replace(/^http:/, 'https:')

/** Bilibili-Evolved: download/apis/dash.ts — DASH stream selection */
export const getPlayUrl = async (
  client: BiliClient,
  video: ResolvedVideo,
  opts: { quality?: number; codec?: Codec } = {},
) => {
  const codec = opts.codec ?? 'avc'
  const base = {
    qn: opts.quality ?? 127,
    fnval: 4048,
    fnver: 0,
    fourk: 1,
    otype: 'json',
  }
  const data = video.epid
    ? await client.json<any>('https://api.bilibili.com/pgc/player/web/playurl', {
        query: { ...base, ep_id: video.epid, cid: video.cid, avid: video.aid },
      })
    : await client.json<any>('https://api.bilibili.com/x/player/wbi/playurl', {
        query: { ...base, avid: video.aid, cid: video.cid },
        wbi: true,
      })

  const accept: number[] = data.accept_quality ?? []
  const available = accept.map(q => ({ quality: q, name: QUALITIES[q] ?? String(q) }))
  if (!data.dash) {
    // old flv/mp4 only content
    const durl: any[] = data.durl ?? []
    return {
      format: 'durl' as const,
      quality: data.quality as number,
      qualityName: QUALITIES[data.quality],
      available,
      streams: durl.map(
        (d): Stream => ({
          type: 'video',
          url: https(d.url),
          backupUrls: (d.backup_url ?? []).map(https),
          bandwidth: 0,
          codecs: '',
          size: d.size,
          quality: data.quality,
        }),
      ),
      duration: Math.round((data.timelength ?? 0) / 1000),
    }
  }
  const { duration, video: videos = [], audio = [], dolby, flac } = data.dash
  const videoStreams: Stream[] = (videos as any[]).map(d => ({
    type: 'video',
    url: https(d.baseUrl || d.base_url),
    backupUrls: (d.backupUrl || d.backup_url || []).map(https),
    bandwidth: d.bandwidth,
    codecs: d.codecs,
    codec: codecName(d.codecid),
    quality: d.id,
    qualityName: QUALITIES[d.id],
    width: d.width,
    height: d.height,
    frameRate: d.frameRate || d.frame_rate,
    size: Math.trunc((d.bandwidth * duration) / 8),
  }))
  const mapAudio = (d: any, label: string): Stream => ({
    type: 'audio',
    url: https(d.baseUrl || d.base_url),
    backupUrls: (d.backupUrl || d.backup_url || []).map(https),
    bandwidth: d.bandwidth,
    codecs: d.codecs,
    size: Math.trunc((d.bandwidth * duration) / 8),
    label,
  })
  const audioStreams: Stream[] = [
    ...(audio as any[]).map(d => mapAudio(d, 'standard')),
    ...((dolby?.audio as any[]) ?? []).map(d => mapAudio(d, 'dolby')),
    ...(flac?.audio ? [mapAudio(flac.audio, 'flac')] : []),
  ]

  // pick: highest quality ≤ requested, preferring the requested codec, smallest bandwidth among ties (as BE does)
  const target = opts.quality ?? 127
  const qualitiesPresent = [...new Set(videoStreams.map(v => v.quality!))].sort((a, b) => b - a)
  const chosenQuality = qualitiesPresent.find(q => q <= target) ?? qualitiesPresent.at(-1)
  const sameQuality = videoStreams.filter(v => v.quality === chosenQuality)
  const preferred = sameQuality.filter(v => v.codec === codec)
  const pool = preferred.length ? preferred : sameQuality
  const chosenVideo = [...pool].sort((a, b) => a.bandwidth - b.bandwidth)[0]
  const chosenAudio = [...audioStreams].sort((a, b) => b.bandwidth - a.bandwidth)[0]

  return {
    format: 'dash' as const,
    quality: chosenQuality,
    qualityName: chosenQuality ? QUALITIES[chosenQuality] : undefined,
    codec: chosenVideo?.codec,
    codecFallback: chosenVideo && chosenVideo.codec !== codec ? `${codec} 不可用，已回退到 ${chosenVideo.codec}` : undefined,
    available,
    duration,
    video: chosenVideo,
    audio: chosenAudio,
    allVideo: videoStreams,
    allAudio: audioStreams,
  }
}

export const formatDuration = fmtDuration
