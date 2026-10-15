/**
 * Download manager (Bilibili-Evolved: video/download + wasm-output muxer).
 * Downloads run as background jobs so long videos don't hit MCP client timeouts.
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { BiliClient, BiliError } from '../http.js'
import { Codec, ResolvedVideo, getPlayUrl } from './video.js'
import { buildFFMetadata, fetchDanmaku, fetchSubtitle, listSubtitles, pickSubtitle } from './media.js'
import { toAss as danmakuToAss, toXml } from '../danmaku/converter.js'
import { toSrt } from '../subtitle.js'

export const sanitizeFilename = (name: string) =>
  name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'bilibili'

export const baseName = (video: ResolvedVideo) =>
  sanitizeFilename(
    [video.title, video.pageCount > 1 && video.pageTitle ? `P${video.page} ${video.pageTitle}` : video.pageTitle]
      .filter(Boolean)
      .join(' - ') + ` [${video.bvid}]`,
  )

export type JobStatus = 'queued' | 'running' | 'merging' | 'done' | 'error'
export interface DownloadJob {
  id: string
  title: string
  status: JobStatus
  step: string
  bytesDone: number
  bytesTotal: number
  files: string[]
  warnings: string[]
  error?: string
  startedAt: string
  finishedAt?: string
  promise?: Promise<void>
}

const jobs = new Map<string, DownloadJob>()

export const getJob = (id: string) => jobs.get(id)
export const listJobs = () => [...jobs.values()]
export const publicJob = (job: DownloadJob) => {
  const { promise, ...rest } = job
  void promise
  return {
    ...rest,
    progress: job.bytesTotal ? `${((job.bytesDone / job.bytesTotal) * 100).toFixed(1)}%` : undefined,
    mbDone: +(job.bytesDone / 1048576).toFixed(1),
    mbTotal: job.bytesTotal ? +(job.bytesTotal / 1048576).toFixed(1) : undefined,
  }
}

const downloadFile = async (
  client: BiliClient,
  urls: string[],
  dest: string,
  onBytes: (n: number) => void,
) => {
  let lastError: unknown
  for (const url of urls.filter(Boolean)) {
    try {
      const res = await client.raw(url)
      if (!res.body) throw new BiliError('空响应')
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          onBytes(chunk.length)
          cb(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(dest))
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new BiliError('没有可用的下载地址')
}

export const runFfmpeg = (ffmpeg: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => (stderr += d))
    proc.on('error', reject)
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(-500)}`))))
  })

export const hasFfmpeg = async (ffmpeg: string) => {
  try {
    await runFfmpeg(ffmpeg, ['-version'])
    return true
  } catch {
    return false
  }
}

export type Extra = 'cover' | 'danmaku_ass' | 'danmaku_xml' | 'subtitle_srt' | 'metadata'

export interface DownloadOptions {
  mode: 'video' | 'audio' | 'none'
  quality?: number
  codec?: Codec
  merge?: boolean
  extras?: Extra[]
  dir?: string
}

export const startDownload = (client: BiliClient, video: ResolvedVideo, options: DownloadOptions) => {
  const job: DownloadJob = {
    id: randomUUID().slice(0, 8),
    title: baseName(video),
    status: 'queued',
    step: '排队中',
    bytesDone: 0,
    bytesTotal: 0,
    files: [],
    warnings: [],
    startedAt: new Date().toISOString(),
  }
  jobs.set(job.id, job)
  job.promise = runJob(client, video, options, job).catch(error => {
    job.status = 'error'
    job.error = (error as Error).message
    job.finishedAt = new Date().toISOString()
  })
  return job
}

const runJob = async (client: BiliClient, video: ResolvedVideo, options: DownloadOptions, job: DownloadJob) => {
  const dir = options.dir ?? client.config.downloadDir
  await mkdir(dir, { recursive: true })
  const base = join(dir, job.title)
  job.status = 'running'
  const onBytes = (n: number) => (job.bytesDone += n)

  if (options.mode !== 'none') {
    job.step = '获取播放地址'
    const play = await getPlayUrl(client, video, { quality: options.quality, codec: options.codec })
    if (play.format === 'dash') {
      if (play.codecFallback) job.warnings.push(play.codecFallback)
      if (options.quality && play.quality && play.quality < options.quality) {
        job.warnings.push(`请求的清晰度不可用（可能需要登录/大会员），实际下载：${play.qualityName}`)
      }
      const parts: { stream: NonNullable<typeof play.audio>; path: string }[] = []
      if (options.mode === 'video' && play.video) parts.push({ stream: play.video, path: `${base}.video.m4s` })
      if (play.audio) parts.push({ stream: play.audio, path: `${base}.audio.m4s` })
      if (!parts.length) throw new BiliError('没有可下载的音视频流')
      job.bytesTotal = parts.reduce((s, p) => s + p.stream.size, 0)
      job.step = `下载中（${play.qualityName ?? ''} ${play.codec ?? ''}）`.trim()
      await Promise.all(parts.map(p => downloadFile(client, [p.stream.url, ...p.stream.backupUrls], p.path, onBytes)))

      const canMerge = options.merge !== false && (await hasFfmpeg(client.config.ffmpeg))
      if (options.mode === 'audio') {
        const ext = play.audio?.label === 'flac' ? 'flac' : 'm4a'
        const out = `${base}.${ext}`
        if (canMerge) {
          job.status = 'merging'
          job.step = '封装音频'
          await runFfmpeg(client.config.ffmpeg, ['-i', parts[0].path, '-c', 'copy', out])
          await rm(parts[0].path)
          job.files.push(out)
        } else {
          job.files.push(parts[0].path)
        }
      } else if (canMerge && parts.length === 2) {
        job.status = 'merging'
        job.step = '合并音视频'
        const out = `${base}.mp4`
        const meta = await buildFFMetadata(client, video).catch(() => undefined)
        const args = ['-i', parts[0].path, '-i', parts[1].path]
        if (meta) {
          const metaPath = `${base}.ffmetadata.txt`
          await writeFile(metaPath, meta.text)
          args.push('-i', metaPath, '-map_metadata', '2', '-map_chapters', '2')
        }
        args.push('-map', '0:v', '-map', '1:a', '-c', 'copy', out)
        await runFfmpeg(client.config.ffmpeg, args)
        await Promise.all([rm(parts[0].path), rm(parts[1].path), rm(`${base}.ffmetadata.txt`, { force: true })])
        job.files.push(out)
      } else {
        job.files.push(...parts.map(p => p.path))
        if (options.merge !== false) {
          job.warnings.push(`未找到 ffmpeg（${client.config.ffmpeg}），音视频保持分离。安装 ffmpeg 或设置 BILIBILI_FFMPEG 后可自动合并`)
        }
      }
    } else {
      // durl (flv/mp4 segments)
      job.bytesTotal = play.streams.reduce((s, x) => s + (x.size ?? 0), 0)
      job.step = '下载中（flv/mp4）'
      const ext = play.streams[0]?.url.includes('.mp4') ? 'mp4' : 'flv'
      const paths = play.streams.map((_, i) => (play.streams.length > 1 ? `${base}.part${i + 1}.${ext}` : `${base}.${ext}`))
      for (const [i, s] of play.streams.entries()) {
        await downloadFile(client, [s.url, ...s.backupUrls], paths[i], onBytes)
      }
      job.files.push(...paths)
    }
  }

  const extras = new Set(options.extras ?? [])
  if (extras.size) job.step = '下载附加内容'
  if (extras.has('cover') && video.cover) {
    const ext = video.cover.split('.').pop()?.split('?')[0] || 'jpg'
    const path = `${base}.cover.${ext}`
    await downloadFile(client, [video.cover.replace(/^http:/, 'https:')], path, () => {})
    job.files.push(path)
  }
  if (extras.has('danmaku_ass') || extras.has('danmaku_xml')) {
    const list = await fetchDanmaku(client, video)
    if (extras.has('danmaku_ass')) {
      const path = `${base}.danmaku.ass`
      await writeFile(path, danmakuToAss(list, { title: job.title }))
      job.files.push(path)
    }
    if (extras.has('danmaku_xml')) {
      const path = `${base}.danmaku.xml`
      await writeFile(path, toXml(video.cid, list))
      job.files.push(path)
    }
  }
  if (extras.has('subtitle_srt')) {
    const tracks = await listSubtitles(client, video)
    const track = pickSubtitle(tracks)
    if (track) {
      const path = `${base}.${track.lang}.srt`
      await writeFile(path, toSrt(await fetchSubtitle(client, track)))
      job.files.push(path)
    } else {
      job.warnings.push(client.loggedIn ? '该视频没有字幕' : '未找到字幕（AI 字幕通常需要登录 Cookie）')
    }
  }
  if (extras.has('metadata')) {
    const meta = await buildFFMetadata(client, video)
    const path = `${base}.ffmetadata.txt`
    await writeFile(path, meta.text)
    job.files.push(path)
  }

  // report real sizes
  let total = 0
  for (const f of job.files) total += (await stat(f).catch(() => ({ size: 0 }))).size
  job.bytesDone = Math.max(job.bytesDone, total)
  job.bytesTotal = Math.max(job.bytesTotal, job.bytesDone)
  job.status = 'done'
  job.step = '完成'
  job.finishedAt = new Date().toISOString()
}

/** Wait for a job up to `ms` milliseconds. */
export const waitJob = async (job: DownloadJob, ms: number) => {
  if (!job.promise || ms <= 0) return job
  await Promise.race([job.promise, new Promise(r => setTimeout(r, ms))])
  return job
}
