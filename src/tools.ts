import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { BiliClient, BiliError } from './http.js'
import { getPlayUrl, resolveInput, resolveVideo, videoInfo } from './api/video.js'
import {
  buildFFMetadata,
  buildOgmChapters,
  danmakuLines,
  danmakuStats,
  fetchDanmaku,
  fetchSubtitle,
  getChapters,
  listSubtitles,
  pickSubtitle,
} from './api/media.js'
import {
  RANKING_REGIONS,
  favorites,
  feed,
  getComments,
  history,
  hot,
  liveRoom,
  me,
  search,
  userInfo,
  watchLater,
  watchLaterEdit,
} from './api/social.js'
import { baseName, getJob, listJobs, publicJob, startDownload, waitJob } from './api/download.js'
import { toAss as danmakuToAss, toXml } from './danmaku/converter.js'
import { toAss as subtitleToAss, toSrt, toText } from './subtitle.js'

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
})
const fail = (error: unknown) => ({
  isError: true,
  content: [
    {
      type: 'text' as const,
      text: error instanceof BiliError ? error.message : `出错了：${(error as Error)?.message ?? String(error)}`,
    },
  ],
})
const run =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return ok(await fn(args))
    } catch (error) {
      return fail(error)
    }
  }

const VIDEO_INPUT = z
  .string()
  .min(1)
  .describe('视频标识：B站视频/番剧链接、BV号、av号、ep号、ss号或 b23.tv 短链')
const PAGE = z.number().int().min(1).optional().describe('分P序号（从1开始）；番剧季为第几集。默认取链接里的 ?p= 或第1P')

const READ = { readOnlyHint: true, openWorldHint: true } as const

export interface ToolContext {
  /** In HTTP mode: turns a local file path into a download link for the remote user. */
  fileUrl?: (path: string) => string | undefined
}

export const registerTools = (server: McpServer, client: BiliClient, context: ToolContext = {}) => {
  const saveText = async (name: string, text: string) => {
    await mkdir(client.config.downloadDir, { recursive: true })
    const path = join(client.config.downloadDir, name)
    await writeFile(path, text)
    return path
  }
  const linkOf = (path: string) => context.fileUrl?.(path)
  const saved = (path: string) => ({ savedTo: path, downloadUrl: linkOf(path) })
  const jobView = (job: Parameters<typeof publicJob>[0]) => {
    const view = publicJob(job)
    if (!context.fileUrl || job.status !== 'done') return view
    return { ...view, downloads: job.files.map(f => ({ file: f.split(/[\\/]/).pop(), url: linkOf(f) })) }
  }

  // ---------------------------------------------------------------- resolve
  server.registerTool(
    'bili_resolve',
    {
      title: '解析 B 站链接 / 编号',
      description:
        '把任意 B 站链接或编号解析成结构化 ID（视频 aid/bvid、番剧 ep/ss、用户 mid、直播间号、专栏 cv），支持 b23.tv 短链，并做 av⇄BV 互转。对应 Bilibili-Evolved 的「BV号转换」「av号链接」。',
      inputSchema: { input: z.string().min(1).describe('链接或编号，如 BV1xx411c7mD、av170001、https://b23.tv/xxxx') },
      annotations: READ,
    },
    run(async ({ input }) => {
      const t = await resolveInput(client, input)
      if (t.kind === 'video') {
        return { ...t, url: `https://www.bilibili.com/video/${t.bvid}${t.page ? `?p=${t.page}` : ''}` }
      }
      return t
    }),
  )

  // ---------------------------------------------------------------- info
  server.registerTool(
    'bili_video_info',
    {
      title: '视频 / 番剧详情',
      description:
        '获取视频的标题、完整简介、封面、UP主、发布时间、时长、播放/点赞/投币/收藏等数据、标签、分P列表与合集信息；番剧链接返回剧集列表与评分。对应 Bilibili-Evolved 的「展开完整简介」「查看封面」「元数据」等功能。',
      inputSchema: { input: VIDEO_INPUT },
      annotations: READ,
    },
    run(async ({ input }) => videoInfo(client, input)),
  )

  // ---------------------------------------------------------------- streams
  server.registerTool(
    'bili_video_streams',
    {
      title: '获取视频流地址',
      description:
        '列出视频可用清晰度、编码，并返回选中的 DASH 视频流/音频流直链（含体积估算）。直链必须带 Referer: https://www.bilibili.com/ 请求头才能下载，有效期约 2 小时。想直接存到本地请用 bili_download。',
      inputSchema: {
        input: VIDEO_INPUT,
        page: PAGE,
        quality: z
          .number()
          .int()
          .optional()
          .describe('期望清晰度代码：127=8K 120=4K 116=1080P60 112=1080P+ 80=1080P 64=720P 32=480P 16=360P；默认取最高可用'),
        codec: z.enum(['avc', 'hevc', 'av1']).optional().describe('偏好编码，默认 avc（兼容性最好）'),
        include_all: z.boolean().optional().describe('是否返回全部清晰度/编码的流（默认 false，仅返回选中的一组）'),
      },
      annotations: READ,
    },
    run(async ({ input, page, quality, codec, include_all }) => {
      const video = await resolveVideo(client, input, { page })
      const play = await getPlayUrl(client, video, { quality, codec })
      const brief = (s?: any) =>
        s && {
          quality: s.qualityName,
          codec: s.codec ?? s.codecs,
          resolution: s.width ? `${s.width}x${s.height}` : undefined,
          frameRate: s.frameRate,
          label: s.label,
          sizeMB: s.size ? +(s.size / 1048576).toFixed(1) : undefined,
          url: s.url,
          backupUrls: s.backupUrls,
        }
      return {
        target: { title: video.title, page: video.page, pageTitle: video.pageTitle, bvid: video.bvid, cid: video.cid },
        loggedIn: client.loggedIn,
        note: client.loggedIn ? undefined : '未登录时最高通常只有 480P/720P；配置 Cookie 后可获取 1080P 及以上（部分需大会员）',
        requiredHeaders: { Referer: 'https://www.bilibili.com/', 'User-Agent': client.config.userAgent },
        format: play.format,
        available: play.available,
        ...(play.format === 'dash'
          ? {
              selected: { quality: play.qualityName, codec: play.codec, fallback: play.codecFallback },
              video: brief(play.video),
              audio: brief(play.audio),
              ...(include_all
                ? { allVideo: play.allVideo.map(brief), allAudio: play.allAudio.map(brief) }
                : {}),
            }
          : { quality: play.qualityName, segments: play.streams.map(brief) }),
      }
    }),
  )

  // ---------------------------------------------------------------- download
  server.registerTool(
    'bili_download',
    {
      title: '下载视频 / 音频 / 弹幕 / 字幕 / 封面',
      description:
        '把视频下载到本机（默认 ~/Downloads/bilibili，可用 BILIBILI_DOWNLOAD_DIR 修改）。DASH 音视频会用 ffmpeg 自动合并为 mp4 并写入章节元数据；没有 ffmpeg 时保留分离文件。可附带下载封面、ASS/XML 弹幕、SRT 字幕。任务在后台运行，超过 wait_seconds 未完成会先返回任务 ID，之后用 bili_download_status 查询。对应 Bilibili-Evolved 的「下载视频」「下载音频」「下载弹幕」「下载字幕」「查看封面」。',
      inputSchema: {
        input: VIDEO_INPUT,
        pages: z
          .array(z.number().int().min(1))
          .optional()
          .describe('要下载的分P序号列表（批量下载）；不填则只下载链接对应的那一P'),
        mode: z.enum(['video', 'audio', 'none']).default('video').describe('video=音视频；audio=仅音频；none=只下附加内容'),
        quality: z.number().int().optional().describe('清晰度代码，同 bili_video_streams；默认最高可用'),
        codec: z.enum(['avc', 'hevc', 'av1']).optional().describe('偏好编码，默认 avc'),
        extras: z
          .array(z.enum(['cover', 'danmaku_ass', 'danmaku_xml', 'subtitle_srt', 'metadata']))
          .optional()
          .describe('附带下载：封面、ASS 弹幕、XML 弹幕、SRT 字幕、ffmetadata 元数据'),
        merge: z.boolean().optional().describe('是否用 ffmpeg 合并音视频，默认 true'),
        wait_seconds: z.number().int().min(0).max(90).default(45).describe('最多等待多少秒再返回（上限 90，远程模式下避免网关超时）；0 表示立即返回任务 ID'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ input, pages, mode, quality, codec, extras, merge, wait_seconds }) => {
      const targets = pages?.length ? pages : [undefined]
      const started = []
      for (const page of targets) {
        const video = await resolveVideo(client, input, { page })
        started.push(startDownload(client, video, { mode, quality, codec, extras, merge }))
      }
      const deadline = Date.now() + wait_seconds * 1000
      for (const job of started) await waitJob(job, Math.max(0, deadline - Date.now()))
      const result = started.map(jobView)
      const pending = result.filter(j => j.status !== 'done' && j.status !== 'error')
      return {
        downloadDir: client.config.downloadDir,
        jobs: result,
        remoteNote: context.fileUrl
          ? '文件保存在运行本服务的电脑上；任务完成后 jobs[].downloads 里有可直接下载的链接'
          : undefined,
        hint: pending.length ? `仍有 ${pending.length} 个任务在后台进行，请稍后用 bili_download_status 查询` : undefined,
      }
    }),
  )

  server.registerTool(
    'bili_download_status',
    {
      title: '查询下载任务',
      description: '查询下载任务进度与结果文件路径。不传 job_id 时列出本次会话的全部任务。',
      inputSchema: {
        job_id: z.string().optional(),
        wait_seconds: z.number().int().min(0).max(90).default(0).describe('若任务未完成，最多等待多少秒（上限 90）'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(async ({ job_id, wait_seconds }) => {
      if (!job_id) return listJobs().map(jobView)
      const job = getJob(job_id)
      if (!job) throw new BiliError(`找不到任务 ${job_id}（服务重启后任务列表会清空）`)
      await waitJob(job, wait_seconds * 1000)
      return jobView(job)
    }),
  )

  // ---------------------------------------------------------------- danmaku
  server.registerTool(
    'bili_danmaku',
    {
      title: '弹幕获取与分析',
      description:
        '获取视频全部弹幕。mode=stats 返回总数、高频弹幕、弹幕密度与高能时间点（适合分析观众反应）；mode=lines 返回带时间戳的弹幕文本（可按时间段过滤，过多时均匀抽样）；mode=ass/xml/json 把完整弹幕保存为文件并返回路径（ASS 可直接被播放器加载）。对应 Bilibili-Evolved 的「下载弹幕」与弹幕转换器。',
      inputSchema: {
        input: VIDEO_INPUT,
        page: PAGE,
        mode: z.enum(['stats', 'lines', 'ass', 'xml', 'json']).default('stats'),
        from_seconds: z.number().min(0).optional().describe('lines 模式：起始时间（秒）'),
        to_seconds: z.number().min(0).optional().describe('lines 模式：结束时间（秒）'),
        limit: z.number().int().min(1).max(5000).default(300).describe('lines 模式最多返回条数'),
        block_keywords: z.array(z.string()).optional().describe('ass 模式：屏蔽包含这些词的弹幕'),
      },
      annotations: READ,
    },
    run(async ({ input, page, mode, from_seconds, to_seconds, limit, block_keywords }) => {
      const video = await resolveVideo(client, input, { page })
      const list = await fetchDanmaku(client, video)
      const head = { title: video.title, pageTitle: video.pageTitle, bvid: video.bvid, cid: video.cid }
      if (mode === 'stats') return { ...head, ...danmakuStats(list, video.duration) }
      if (mode === 'lines') return { ...head, ...danmakuLines(list, { from: from_seconds, to: to_seconds, limit }) }
      const name = baseName(video)
      const text =
        mode === 'ass'
          ? danmakuToAss(list, { title: name, blockKeywords: block_keywords })
          : mode === 'xml'
            ? toXml(video.cid, list)
            : JSON.stringify(list, null, 1)
      const path = await saveText(`${name}.danmaku.${mode}`, text)
      return { ...head, count: list.length, ...saved(path) }
    }),
  )

  // ---------------------------------------------------------------- subtitles
  server.registerTool(
    'bili_subtitles',
    {
      title: '字幕 / 文字稿',
      description:
        '获取视频字幕（含 AI 生成字幕）。format=text 返回「[mm:ss] 台词」形式的文字稿，最适合让 AI 总结、翻译、提炼要点；srt/ass/json 可选择保存为文件。只传 input 不传 lang 时会同时列出全部可用字幕语言。注意：AI 字幕通常需要登录 Cookie。对应 Bilibili-Evolved 的「下载字幕」。',
      inputSchema: {
        input: VIDEO_INPUT,
        page: PAGE,
        lang: z.string().optional().describe('语言代码或名称，如 zh-CN、ai-zh、en-US、中文；默认优先人工中文字幕'),
        format: z.enum(['text', 'srt', 'ass', 'json']).default('text'),
        timestamps: z.boolean().default(true).describe('text 格式是否带时间戳'),
        save: z.boolean().default(false).describe('是否保存为文件（srt/ass/json 推荐保存）'),
      },
      annotations: READ,
    },
    run(async ({ input, page, lang, format, timestamps, save }) => {
      const video = await resolveVideo(client, input, { page })
      const tracks = await listSubtitles(client, video)
      const available = tracks.map(t => ({ lang: t.lang, name: t.name, ai: t.ai }))
      if (!tracks.length) {
        return {
          title: video.title,
          available,
          message: client.loggedIn
            ? '该视频没有字幕。可改用 bili_danmaku 分析弹幕，或 bili_download mode=audio 下载音频后自行转写。'
            : '未获取到字幕。B站的 AI 字幕通常需要登录才能获取，请配置 BILIBILI_COOKIE 后重试。',
        }
      }
      const track = pickSubtitle(tracks, lang)!
      const items = await fetchSubtitle(client, track)
      const text =
        format === 'text'
          ? toText(items, timestamps)
          : format === 'srt'
            ? toSrt(items)
            : format === 'ass'
              ? subtitleToAss(items, { title: video.title })
              : JSON.stringify(items, null, 1)
      const head = { title: video.title, pageTitle: video.pageTitle, bvid: video.bvid, language: track.name, lang: track.lang, ai: track.ai, available, lines: items.length }
      if (save) {
        const path = await saveText(`${baseName(video)}.${track.lang}.${format === 'text' ? 'txt' : format}`, text)
        return { ...head, ...saved(path) }
      }
      return `${JSON.stringify(head)}\n\n${text}`
    }),
  )

  // ---------------------------------------------------------------- chapters / metadata
  server.registerTool(
    'bili_chapters',
    {
      title: '章节与元数据',
      description:
        '获取视频的分段章节（UP主设置的看点 / 番剧 OP、ED 时间），可输出为 ffmetadata（ffmpeg 写入章节）或 OGM 章节格式。对应 Bilibili-Evolved 的「保存视频元数据」。',
      inputSchema: {
        input: VIDEO_INPUT,
        page: PAGE,
        format: z.enum(['list', 'ffmetadata', 'ogm']).default('list'),
      },
      annotations: READ,
    },
    run(async ({ input, page, format }) => {
      const video = await resolveVideo(client, input, { page })
      if (format === 'ffmetadata') return (await buildFFMetadata(client, video)).text
      const chapters = await getChapters(client, video)
      if (format === 'ogm') return chapters.length ? buildOgmChapters(chapters) : '该视频没有章节'
      return { title: video.title, chapters }
    }),
  )

  // ---------------------------------------------------------------- comments
  server.registerTool(
    'bili_comments',
    {
      title: '视频评论',
      description:
        '获取视频评论（热门或最新），包括置顶评论、点赞数、IP 属地与热门楼中楼。用 next_offset 翻页。对应 Bilibili-Evolved 的评论区相关功能。',
      inputSchema: {
        input: VIDEO_INPUT,
        sort: z.enum(['hot', 'time']).default('hot'),
        limit: z.number().int().min(1).max(20).default(20),
        offset: z.string().optional().describe('上一次返回的 nextOffset，用于翻页'),
      },
      annotations: READ,
    },
    run(async ({ input, sort, limit, offset }) => {
      const t = await resolveInput(client, input)
      let aid: number
      if (t.kind === 'video') aid = t.aid
      else aid = (await resolveVideo(client, input)).aid
      return getComments(client, aid, { sort, limit, offset })
    }),
  )

  // ---------------------------------------------------------------- search
  server.registerTool(
    'bili_search',
    {
      title: '搜索',
      description: '在 B 站搜索视频、用户、番剧、影视、直播间或专栏。对应 Bilibili-Evolved 的「搜索栏 / Launch Bar」。',
      inputSchema: {
        keyword: z.string().min(1),
        type: z
          .enum(['video', 'bili_user', 'media_bangumi', 'media_ft', 'live_room', 'article'])
          .default('video')
          .describe('video=视频 bili_user=用户 media_bangumi=番剧 media_ft=影视 live_room=直播间 article=专栏'),
        order: z
          .string()
          .optional()
          .describe('视频排序：totalrank(综合) click(播放) pubdate(最新) dm(弹幕) stow(收藏)；用户排序：fans level'),
        page: z.number().int().min(1).default(1),
      },
      annotations: READ,
    },
    run(async ({ keyword, type, order, page }) => search(client, keyword, { type, order, page })),
  )

  // ---------------------------------------------------------------- hot
  server.registerTool(
    'bili_hot',
    {
      title: '热搜 / 热门 / 排行榜',
      description:
        'search_words=当前热搜词；popular=综合热门视频；ranking=分区排行榜（可指定 region）；weekly=每周必看。对应 Bilibili-Evolved 的「热搜」与排行入口。',
      inputSchema: {
        kind: z.enum(['search_words', 'popular', 'ranking', 'weekly']).default('popular'),
        region: z
          .enum(Object.keys(RANKING_REGIONS) as [string, ...string[]])
          .optional()
          .describe('ranking 的分区，默认 all'),
        limit: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).optional(),
      },
      annotations: READ,
    },
    run(async ({ kind, region, limit, page }) => hot(client, kind, { region, limit, page })),
  )

  // ---------------------------------------------------------------- user
  server.registerTool(
    'bili_user',
    {
      title: 'UP 主 / 用户信息',
      description: '获取用户资料：昵称、签名、等级、粉丝数、获赞、认证，并可附带最近投稿。参数可以是 UID、空间链接或视频链接（取 UP 主）。',
      inputSchema: {
        input: z.string().min(1).describe('UID、space.bilibili.com 链接，或视频链接/BV号（自动取 UP 主）'),
        recent_videos: z.number().int().min(0).max(50).default(0).describe('附带最近投稿数量'),
      },
      annotations: READ,
    },
    run(async ({ input, recent_videos }) => {
      let mid: number | undefined
      if (/^\d+$/.test(input.trim())) mid = Number(input.trim())
      else {
        const t = await resolveInput(client, input)
        if (t.kind === 'user') mid = t.mid
        else if (t.kind === 'video') mid = (await videoInfo(client, input) as any).owner?.mid
      }
      if (!mid) throw new BiliError('无法从输入中识别用户')
      return userInfo(client, mid, { videos: recent_videos })
    }),
  )

  // ---------------------------------------------------------------- live
  server.registerTool(
    'bili_live_room',
    {
      title: '直播间信息',
      description: '查询直播间标题、开播状态、人气、分区、开播时间。',
      inputSchema: { input: z.string().min(1).describe('直播间号或 live.bilibili.com 链接') },
      annotations: READ,
    },
    run(async ({ input }) => {
      const id = /^\d+$/.test(input.trim()) ? Number(input.trim()) : undefined
      if (id) return liveRoom(client, id)
      const t = await resolveInput(client, input)
      if (t.kind !== 'live') throw new BiliError('不是直播间链接')
      return liveRoom(client, t.roomId)
    }),
  )

  // ---------------------------------------------------------------- account
  server.registerTool(
    'bili_account',
    {
      title: '我的账号 / 稍后再看 / 收藏 / 历史 / 动态',
      description:
        '读取已登录账号的数据（需配置 BILIBILI_COOKIE）：me=账号信息；watch_later=稍后再看列表；favorites=收藏夹（不传 folder_id 列出收藏夹，传了则列出内容）；history=观看历史；feed=关注动态（默认只看视频）。对应 Bilibili-Evolved 的「稍后再看」「收藏」「历史」「动态过滤」等功能。',
      inputSchema: {
        what: z.enum(['me', 'watch_later', 'favorites', 'history', 'feed']),
        folder_id: z.number().int().optional().describe('favorites：收藏夹 ID'),
        keyword: z.string().optional().describe('favorites：在收藏夹内搜索'),
        page: z.number().int().min(1).optional(),
        feed_type: z.enum(['video', 'all']).optional().describe('feed：只看视频动态或全部'),
        cursor: z.string().optional().describe('history/feed 翻页游标（上次返回的 next / nextOffset）'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ what, folder_id, keyword, page, feed_type, cursor }) => {
      switch (what) {
        case 'me':
          return me(client)
        case 'watch_later':
          return watchLater(client)
        case 'favorites':
          return favorites(client, { folderId: folder_id, page, keyword })
        case 'history': {
          const c = cursor ? (JSON.parse(cursor) as { max: number; viewAt: number }) : undefined
          const r = await history(client, { cursor: c })
          return { ...r, next: r.next ? JSON.stringify(r.next) : undefined }
        }
        case 'feed':
          return feed(client, { type: feed_type, offset: cursor })
      }
    }),
  )

  server.registerTool(
    'bili_watch_later_edit',
    {
      title: '添加 / 移除稍后再看',
      description:
        '把视频加入或移出「稍后再看」。会修改账号数据：需要 Cookie（含 bili_jct）且设置 BILIBILI_ALLOW_WRITE=true 才可用。',
      inputSchema: {
        input: VIDEO_INPUT,
        action: z.enum(['add', 'remove']),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ input, action }) => {
      const t = await resolveInput(client, input)
      const aid = t.kind === 'video' ? t.aid : (await resolveVideo(client, input)).aid
      return watchLaterEdit(client, action, aid)
    }),
  )

  // ---------------------------------------------------------------- prompt
  server.registerPrompt(
    'summarize_bilibili_video',
    {
      title: '总结 B 站视频',
      description: '读取视频信息、字幕和弹幕，生成结构化总结',
      argsSchema: { url: z.string().describe('视频链接或 BV 号') },
    },
    ({ url }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `请总结这个 B 站视频：${url}\n\n步骤：\n1. 用 bili_video_info 获取标题、简介、时长和数据；\n2. 用 bili_subtitles（format=text）获取文字稿；如无字幕，说明并改用简介 + 热门评论；\n3. 用 bili_chapters 获取章节（如有）；\n4. 用 bili_danmaku（mode=stats）了解观众反应和高能时间点；\n5. 输出：一句话概要、分章节要点（带时间戳）、观众反应、值得看的片段。区分视频内容事实与你的推断。`,
          },
        },
      ],
    }),
  )
}
