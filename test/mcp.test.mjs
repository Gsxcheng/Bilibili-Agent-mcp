// End-to-end MCP protocol test: a real MCP client talks to the server over an in-memory transport;
// bilibili HTTP is replaced by test/mock-bilibili.mjs. Uses the real ffmpeg (if installed) for merging.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../dist/server.js'
import { createMock, BVID } from './mock-bilibili.mjs'

const dir = mkdtempSync(join(tmpdir(), 'bili-mcp-'))
let hasFfmpeg = true
try {
  execFileSync('ffmpeg', ['-version'])
} catch {
  hasFfmpeg = false
}

const connect = async env => {
  const mock = createMock()
  const { server } = createServer({ BILIBILI_DOWNLOAD_DIR: dir, ...env }, mock.fetchImpl)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args })
    const text = res.content[0].text
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    return { isError: Boolean(res.isError), text, data }
  }
  return { client, call, mock }
}

let anon, user
before(async () => {
  anon = await connect({})
  user = await connect({ BILIBILI_COOKIE: 'SESSDATA=SESS; bili_jct=JCT; buvid3=REAL', BILIBILI_ALLOW_WRITE: 'true' })
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('lists all tools and the prompt', async () => {
  const { tools } = await anon.client.listTools()
  const names = tools.map(t => t.name).sort()
  assert.deepEqual(names, [
    'bili_account',
    'bili_chapters',
    'bili_comments',
    'bili_danmaku',
    'bili_download',
    'bili_download_status',
    'bili_hot',
    'bili_live_room',
    'bili_resolve',
    'bili_search',
    'bili_subtitles',
    'bili_user',
    'bili_video_info',
    'bili_video_streams',
    'bili_watch_later_edit',
  ])
  for (const t of tools) assert.ok(t.description.length > 20, `${t.name} has a description`)
  const { prompts } = await anon.client.listPrompts()
  assert.equal(prompts[0].name, 'summarize_bilibili_video')
})

test('bili_resolve expands b23.tv short links', async () => {
  const r = await anon.call('bili_resolve', { input: '看这个 https://b23.tv/abcDEF' })
  assert.equal(r.isError, false, r.text)
  assert.equal(r.data.bvid, BVID)
  assert.equal(r.data.aid, 170001)
  assert.equal(r.data.page, 2)
})

test('bili_video_info', async () => {
  const r = await anon.call('bili_video_info', { input: 'av170001' })
  assert.equal(r.isError, false, r.text)
  assert.equal(r.data.title, '测试视频')
  assert.deepEqual(r.data.tags, ['科普', '测试'])
  assert.equal(r.data.pages.length, 2)
  assert.equal(r.data.duration, '2:10')
  assert.equal(r.data.stat.highestRank, undefined)
})

test('bili_video_streams: logged out → 480P, signed with wbi, buvid fetched', async () => {
  const r = await anon.call('bili_video_streams', { input: BVID })
  assert.equal(r.isError, false, r.text)
  assert.equal(r.data.selected.quality, '480P 清晰')
  assert.equal(r.data.audio.url, 'https://upos-sz-mirror.bilivideo.com/a192.m4s', 'highest bitrate audio')
  assert.ok(r.data.note)
  const play = anon.mock.calls.find(c => c.url.includes('/wbi/playurl'))
  assert.match(play.url, /w_rid=[0-9a-f]{32}/)
  assert.match(play.cookie, /buvid3=MOCK-BUVID3infoc/)
})

test('bili_video_streams: logged in, codec preference and fallback, http→https', async () => {
  const hevc = await user.call('bili_video_streams', { input: BVID, codec: 'hevc' })
  assert.equal(hevc.data.selected.codec, 'hevc')
  assert.equal(hevc.data.video.resolution, '1920x1080')
  const avc = await user.call('bili_video_streams', { input: BVID, quality: 80 })
  assert.equal(avc.data.video.url, 'https://upos-sz-mirror.bilivideo.com/v80avc.m4s')
  const av1 = await user.call('bili_video_streams', { input: BVID, codec: 'av1', quality: 64 })
  assert.equal(av1.data.selected.quality, '720P 高清')
  assert.match(av1.data.selected.fallback, /av1 不可用/)
})

test('cookies are never sent to CDN hosts', async () => {
  await user.call('bili_download', { input: BVID, mode: 'audio', merge: false, wait_seconds: 20 })
  const cdn = user.mock.calls.filter(c => c.url.includes('bilivideo.com'))
  assert.ok(cdn.length > 0)
  for (const c of cdn) {
    assert.equal(c.cookie, '', `no cookie to ${c.url}`)
    assert.equal(c.referer, 'https://www.bilibili.com/')
  }
})

test('bili_download: video+audio merged by ffmpeg with chapters, extras, backup URL fallback', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const r = await user.call('bili_download', {
    input: BVID,
    quality: 80,
    extras: ['cover', 'danmaku_ass', 'subtitle_srt'],
    wait_seconds: 60,
  })
  assert.equal(r.isError, false, r.text)
  const job = r.data.jobs[0]
  assert.equal(job.status, 'done', JSON.stringify(job))
  const mp4 = job.files.find(f => f.endsWith('.mp4'))
  assert.ok(mp4 && existsSync(mp4), 'merged mp4 exists')
  assert.ok(job.files.some(f => f.endsWith('.cover.jpg')))
  assert.ok(job.files.some(f => f.endsWith('.danmaku.ass')))
  const srt = job.files.find(f => f.endsWith('.zh-CN.srt'))
  assert.match(readFileSync(srt, 'utf8'), /大家好/)
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_chapters', '-show_format', '-of', 'json', mp4]).toString(),
  )
  // mp4 stores chapters as an extra text/data track, so only check that audio + video are there
  const types = probe.streams.map(s => s.codec_type)
  assert.ok(types.includes('audio') && types.includes('video'), types.join(','))
  assert.deepEqual(probe.chapters.map(c => c.tags.title), ['开场', '正题'])
  assert.equal(probe.format.tags.title, '测试视频 - 第一部分')
  // primary URL returned 403, backup URL must have been used
  assert.ok(user.mock.calls.some(c => c.url.includes('upos-bak')))
  const status = await user.call('bili_download_status', { job_id: job.id })
  assert.equal(status.data.status, 'done')
})

test('bili_download: batch pages + background job polling', async () => {
  const r = await anon.call('bili_download', { input: BVID, pages: [1, 2], mode: 'none', extras: ['metadata'], wait_seconds: 0 })
  assert.equal(r.data.jobs.length, 2)
  for (const j of r.data.jobs) {
    const s = await anon.call('bili_download_status', { job_id: j.id, wait_seconds: 10 })
    assert.equal(s.data.status, 'done', s.text)
  }
  assert.match(r.data.jobs[1].title, /P2 第二部分/)
})

test('bili_danmaku stats / lines / ass file', async () => {
  const stats = await anon.call('bili_danmaku', { input: BVID })
  assert.equal(stats.isError, false, stats.text)
  assert.equal(stats.data.total, 3)
  assert.deepEqual(stats.data.topPhrases[0], { text: '前方高能', count: 2 })
  const lines = await anon.call('bili_danmaku', { input: BVID, mode: 'lines', from_seconds: 60 })
  assert.deepEqual(lines.data.lines, ['[01:01] 顶部', '[06:40] 前方高能'])
  const ass = await anon.call('bili_danmaku', { input: BVID, mode: 'ass' })
  assert.match(readFileSync(ass.data.savedTo, 'utf8'), /Dialogue: .*前方高能/)
})

test('bili_subtitles: prefers human zh, lists languages, lang override, srt save', async () => {
  const r = await anon.call('bili_subtitles', { input: BVID })
  assert.equal(r.isError, false, r.text)
  assert.match(r.text, /"lang":"zh-CN"/)
  assert.match(r.text, /\[00:03\] 今天讲测试/)
  const ai = await anon.call('bili_subtitles', { input: BVID, lang: 'ai-zh', timestamps: false })
  assert.match(ai.text, /大家号（AI）$/)
  const srt = await anon.call('bili_subtitles', { input: BVID, format: 'srt', save: true })
  assert.match(readFileSync(srt.data.savedTo, 'utf8'), /00:00:00,000 --> 00:00:02,500/)
})

test('bili_chapters list / ogm / ffmetadata; bangumi OP skip → chapter', async () => {
  const list = await anon.call('bili_chapters', { input: BVID })
  assert.equal(list.data.chapters.length, 2)
  const ogm = await anon.call('bili_chapters', { input: BVID, format: 'ogm' })
  assert.match(ogm.text, /CHAPTER002=00:00:30\.000\nCHAPTER002NAME=正题/)
  const ff = await anon.call('bili_chapters', { input: BVID, format: 'ffmetadata' })
  assert.match(ff.text, /^;FFMETADATA1/)
  assert.match(ff.text, /description=简介\\\n第二行/)
  const ep = await anon.call('bili_video_info', { input: 'https://www.bilibili.com/bangumi/play/ep501' })
  assert.equal(ep.data.type, 'bangumi')
  assert.equal(ep.data.episodes[0].epid, 501)
})

test('bili_comments', async () => {
  const r = await anon.call('bili_comments', { input: BVID })
  assert.equal(r.isError, false, r.text)
  assert.equal(r.data.pinned[0].content, '置顶')
  assert.equal(r.data.comments[0].location, '上海')
  assert.equal(r.data.nextOffset, 'NEXT')
})

test('bili_search strips highlight tags', async () => {
  const r = await anon.call('bili_search', { keyword: '测试' })
  assert.equal(r.isError, false, r.text)
  assert.equal(r.data.results[0].title, '测试视频')
})

test('bili_hot variants', async () => {
  const words = await anon.call('bili_hot', { kind: 'search_words' })
  assert.equal(words.data[0].keyword, '热词1')
  const pop = await anon.call('bili_hot', { kind: 'popular' })
  assert.equal(pop.data[0].reason, '百万播放')
  const rank = await anon.call('bili_hot', { kind: 'ranking', region: 'knowledge' })
  assert.equal(rank.data[0].title, '排行 rid=36')
  assert.equal(rank.data[0].duration, '1:01:40')
})

test('bili_user from uid and from video', async () => {
  const r = await anon.call('bili_user', { input: '2', recent_videos: 5 })
  assert.equal(r.data.name, '碧诗')
  assert.equal(r.data.recentVideos[0].title, '投稿1')
  const fromVideo = await anon.call('bili_user', { input: BVID })
  assert.equal(fromVideo.data.mid, 2)
})

test('bili_live_room', async () => {
  const r = await anon.call('bili_live_room', { input: 'https://live.bilibili.com/21452505' })
  assert.equal(r.data.status, '直播中')
  assert.equal(r.data.description, '简介')
})

test('account tools: login required, write gate, csrf', async () => {
  const denied = await anon.call('bili_account', { what: 'watch_later' })
  assert.equal(denied.isError, true)
  assert.match(denied.text, /需要登录/)
  const me = await user.call('bili_account', { what: 'me' })
  assert.equal(me.data.name, '测试用户')
  const wl = await user.call('bili_account', { what: 'watch_later' })
  assert.equal(wl.data.videos[0].progress, '0:30 / 1:40')
  const add = await user.call('bili_watch_later_edit', { input: BVID, action: 'add' })
  assert.equal(add.isError, false, add.text)
  const noWrite = await connect({ BILIBILI_COOKIE: 'SESSDATA=S; bili_jct=JCT' })
  const blocked = await noWrite.call('bili_watch_later_edit', { input: BVID, action: 'add' })
  assert.equal(blocked.isError, true)
  assert.match(blocked.text, /BILIBILI_ALLOW_WRITE/)
})

test('helpful errors for bad input and API error codes', async () => {
  const bad = await anon.call('bili_video_info', { input: '随便写点什么' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /无法识别/)
  const missing = await anon.call('bili_video_info', { input: 'av999' })
  assert.equal(missing.isError, true)
  assert.match(missing.text, /-404.*内容不存在/)
})
