// A fake bilibili backend for offline protocol tests. Response shapes follow the real web APIs.
import { readFileSync } from 'node:fs'
import { root } from '../dist/danmaku/proto.js'

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
const pb = (type, obj) => {
  const T = root.lookupType(type)
  return T.encode(T.fromObject(obj)).finish()
}

export const AID = 170001
export const BVID = 'BV17x411w7KC'
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const ok = data => json({ code: 0, message: '0', data })

export const createMock = () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const q = u.searchParams
    const cookie = init.headers?.Cookie ?? ''
    calls.push({ url, method: init.method ?? 'GET', cookie, body: init.body, referer: init.headers?.Referer })
    const path = u.hostname + u.pathname
    const needWbi = () => {
      if (!q.get('w_rid') || !q.get('wts')) return json({ code: -403, message: '访问权限不足' })
    }
    switch (path) {
      case 'api.bilibili.com/x/frontend/finger/spi':
        return ok({ b_3: 'MOCK-BUVID3infoc', b_4: 'MOCK-BUVID4' })
      case 'api.bilibili.com/x/web-interface/nav': {
        const wbi_img = {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
        }
        if (!cookie.includes('SESSDATA')) return json({ code: -101, message: '账号未登录', data: { isLogin: false, wbi_img } })
        return ok({ isLogin: true, mid: 42, uname: '测试用户', level_info: { current_level: 6 }, vipStatus: 1, vip_label: { text: '年度大会员' }, money: 10, face: 'https://i0.hdslb.com/face.jpg', wbi_img })
      }
      case 'b23.tv/abcDEF':
        return new Response(null, { status: 302, headers: { location: `https://www.bilibili.com/video/${BVID}?p=2&share_source=copy` } })
      case 'api.bilibili.com/x/web-interface/view':
        // mirrors live behaviour observed 2026-10: unsigned endpoint is risk-controlled
        return new Response('<!DOCTYPE html><html>412</html>', { status: 412, headers: { 'content-type': 'text/html' } })
      case 'api.bilibili.com/x/web-interface/wbi/view': {
        const err = needWbi()
        if (err) return err
        if (q.get('aid') !== String(AID)) return json({ code: -404, message: '啥都木有' })
        return ok({
          aid: AID,
          bvid: BVID,
          cid: 1001,
          title: '测试视频',
          desc: '简介\n第二行',
          pic: 'http://i0.hdslb.com/bfs/archive/cover.jpg',
          tname: '知识',
          tname_v2: '科学科普',
          owner: { mid: 2, name: '碧诗', face: 'https://i0.hdslb.com/u.jpg' },
          pubdate: 1700000000,
          duration: 130,
          copyright: 1,
          stat: { view: 1000, danmaku: 6, reply: 3, like: 50, coin: 5, favorite: 7, share: 1, his_rank: 0 },
          pages: [
            { cid: 1001, page: 1, part: '第一部分', duration: 70 },
            { cid: 1002, page: 2, part: '第二部分', duration: 60 },
          ],
          ugc_season: { id: 9, title: '合集', ep_count: 3 },
        })
      }
      case 'api.bilibili.com/x/web-interface/view/detail/tag':
        return ok([{ tag_name: '科普' }, { tag_name: '测试' }])
      case 'api.bilibili.com/x/player/wbi/playurl': {
        const err = needWbi()
        if (err) return err
        const loggedIn = cookie.includes('SESSDATA')
        const video = [
          { id: 80, codecid: 7, codecs: 'avc1.640032', bandwidth: 2000000, width: 1920, height: 1080, frameRate: '25', baseUrl: 'http://upos-sz-mirror.bilivideo.com/v80avc.m4s', backupUrl: ['https://upos-bak.bilivideo.com/v80avc.m4s'] },
          { id: 80, codecid: 12, codecs: 'hev1.1.6.L120', bandwidth: 1200000, width: 1920, height: 1080, frameRate: '25', baseUrl: 'https://upos-sz-mirror.bilivideo.com/v80hevc.m4s' },
          { id: 64, codecid: 7, codecs: 'avc1.640028', bandwidth: 1000000, width: 1280, height: 720, frameRate: '25', baseUrl: 'https://upos-sz-mirror.bilivideo.com/v64avc.m4s' },
          { id: 32, codecid: 7, codecs: 'avc1.64001F', bandwidth: 500000, width: 852, height: 480, frameRate: '25', baseUrl: 'https://upos-sz-mirror.bilivideo.com/v32avc.m4s' },
        ].filter(v => loggedIn || v.id <= 32)
        return ok({
          quality: loggedIn ? 80 : 32,
          accept_quality: loggedIn ? [80, 64, 32] : [32],
          dash: {
            duration: 70,
            video,
            audio: [
              { id: 30280, codecs: 'mp4a.40.2', bandwidth: 192000, baseUrl: 'https://upos-sz-mirror.bilivideo.com/a192.m4s' },
              { id: 30216, codecs: 'mp4a.40.2', bandwidth: 64000, baseUrl: 'https://upos-sz-mirror.bilivideo.com/a64.m4s' },
            ],
          },
        })
      }
      case 'upos-sz-mirror.bilivideo.com/v80avc.m4s':
        return new Response('broken', { status: 403 })
      case 'upos-bak.bilivideo.com/v80avc.m4s':
      case 'upos-sz-mirror.bilivideo.com/v80hevc.m4s':
      case 'upos-sz-mirror.bilivideo.com/v64avc.m4s':
      case 'upos-sz-mirror.bilivideo.com/v32avc.m4s':
        if (init.headers?.Referer !== 'https://www.bilibili.com/') return new Response('no referer', { status: 403 })
        return new Response(fixture('video.m4s'))
      case 'upos-sz-mirror.bilivideo.com/a192.m4s':
      case 'upos-sz-mirror.bilivideo.com/a64.m4s':
        return new Response(fixture('audio.m4s'))
      case 'i0.hdslb.com/bfs/archive/cover.jpg':
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      case 'api.bilibili.com/x/v2/dm/web/view':
        return new Response(pb('DmWebViewReply', { state: 0, dmSge: { pageSize: 360000, total: 2 } }))
      case 'api.bilibili.com/x/v2/dm/web/seg.so': {
        const idx = Number(q.get('segment_index'))
        const elems =
          idx === 1
            ? [
                { id: 1, progress: 1500, mode: 1, fontsize: 25, color: 16777215, midHash: 'a', content: '前方高能', ctime: 1700000000, idStr: '1' },
                { id: 2, progress: 61000, mode: 5, fontsize: 25, color: 16711680, midHash: 'b', content: '顶部', ctime: 1700000001, idStr: '2' },
              ]
            : [{ id: 3, progress: 400000, mode: 1, fontsize: 25, color: 16777215, midHash: 'c', content: '前方高能', ctime: 1700000002, idStr: '3' }]
        return new Response(pb('DmSegMobileReply', { elems }))
      }
      case 'api.bilibili.com/x/player/wbi/v2': {
        const err = needWbi()
        if (err) return err
        return ok({
          subtitle: {
            subtitles: [
              { lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1.json', ai_type: 1 },
              { lan: 'zh-CN', lan_doc: '中文（中国）', subtitle_url: '//i0.hdslb.com/bfs/subtitle/zh.json', ai_type: 0 },
            ],
          },
          view_points: [
            { from: 0, to: 30, content: '开场' },
            { from: 30, to: 70, content: '正题' },
          ],
        })
      }
      case 'i0.hdslb.com/bfs/subtitle/zh.json':
        return json({ body: [{ from: 0, to: 2.5, location: 2, content: '大家好' }, { from: 3, to: 5, location: 2, content: '今天讲测试' }] })
      case 'aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1.json':
        return json({ body: [{ from: 0, to: 2.5, content: '大家号（AI）' }] })
      case 'api.bilibili.com/x/v2/reply/wbi/main': {
        const err = needWbi()
        if (err) return err
        const reply = (rpid, msg, like) => ({ rpid, rpid_str: String(rpid), mid: 7, like, rcount: 1, ctime: 1700000100, member: { uname: '路人', level_info: { current_level: 5 } }, content: { message: msg }, reply_control: { location: 'IP属地：上海' }, replies: [{ member: { uname: 'B' }, content: { message: '楼中楼' }, like: 1 }] })
        return ok({ cursor: { all_count: 3, is_end: false, pagination_reply: { next_offset: 'NEXT' } }, replies: [reply(1, '好视频', 99), reply(2, '第二', 3)], top_replies: [reply(9, '置顶', 500)] })
      }
      case 'api.bilibili.com/x/web-interface/wbi/search/type': {
        const err = needWbi()
        if (err) return err
        if (!cookie.includes('buvid3')) return json({ code: -412, message: 'request was banned' })
        return ok({ page: 1, numPages: 5, numResults: 100, result: [{ bvid: BVID, title: '<em class="keyword">测试</em>视频', author: '碧诗', mid: 2, play: 1000, video_review: 6, favorites: 7, duration: '2:10', pubdate: 1700000000, description: 'desc' }] })
      }
      case 'api.bilibili.com/x/web-interface/search/square':
        return ok({ trending: { list: [{ keyword: '热词1', show_name: '热词1' }, { keyword: '热词2', show_name: '热词2' }] } })
      case 'api.bilibili.com/x/web-interface/popular':
        return ok({ list: [{ bvid: BVID, title: '热门', owner: { name: 'UP' }, stat: { view: 1, like: 2, danmaku: 3 }, duration: 75, rcmd_reason: { content: '百万播放' } }] })
      case 'api.bilibili.com/x/web-interface/ranking/v2':
        return ok({ list: [{ bvid: BVID, title: `排行 rid=${q.get('rid')}`, owner: { name: 'UP' }, stat: { view: 1 }, duration: 3700, score: 99 }] })
      case 'api.bilibili.com/x/web-interface/card':
        return ok({ card: { mid: '2', name: '碧诗', sign: 'hi', face: 'f', level_info: { current_level: 6 }, fans: 100, attention: 5, Official: { title: '站长' }, vip: { vipStatus: 1, label: { text: '大会员' } } }, archive_count: 10, article_count: 1, like_num: 999 })
      case 'api.bilibili.com/x/space/wbi/arc/search': {
        const err = needWbi()
        if (err) return err
        return ok({ list: { vlist: [{ bvid: BVID, title: '投稿1', play: 1, comment: 2, length: '02:10', created: 1700000000 }] } })
      }
      case 'api.live.bilibili.com/room/v1/Room/get_info':
        return ok({ room_id: Number(q.get('room_id')), short_id: 0, uid: 2, title: '直播标题', live_status: 1, online: 1234, parent_area_name: '娱乐', area_name: '聊天', live_time: '2026-10-15 08:00:00', user_cover: 'c', description: '<p>简介</p>', tags: 'a,b' })
      case 'api.bilibili.com/pgc/view/web/season':
        return json({ code: 0, message: 'success', result: { season_id: 33, media_id: 44, season_title: '某番剧', link: 'https://www.bilibili.com/bangumi/media/md44', evaluate: '简介', areas: [{ name: '日本' }], rating: { score: 9.8, count: 1000 }, episodes: [{ ep_id: 501, aid: AID, bvid: BVID, cid: 1002, title: '1', long_title: '开始', duration: 60000, skip: { op: { start: 0, end: 90 }, ed: { start: 0, end: 0 } } }] } })
      case 'api.bilibili.com/x/v2/history/toview':
        return ok({ count: 1, list: [{ aid: AID, bvid: BVID, title: '稍后看', owner: { name: 'UP' }, stat: { view: 1 }, duration: 100, progress: 30, add_at: 1700000000 }] })
      case 'api.bilibili.com/x/v2/history/toview/add':
        if (!String(init.body).includes('csrf=JCT')) return json({ code: -111, message: 'csrf 校验失败' })
        return json({ code: 0, message: '0' })
      default:
        return new Response(`unmocked ${url}`, { status: 404 })
    }
  }
  return { fetchImpl, calls }
}
