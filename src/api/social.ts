import { BiliClient, BiliError } from '../http.js'
import { av2bv } from '../ids.js'
import { formatDuration } from './video.js'

const stripTags = (s?: string) =>
  (s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
const isoTime = (ts?: number) => (ts ? new Date(ts * 1000).toISOString().replace('.000Z', 'Z') : undefined)
const durationText = (d: unknown) => (typeof d === 'number' ? formatDuration(d) : (d as string | undefined))

// ---------------- comments (Bilibili-Evolved: utils/comments) ----------------

const mapReply = (r: any) => ({
  rpid: r.rpid_str ?? String(r.rpid),
  user: r.member?.uname,
  mid: r.mid,
  level: r.member?.level_info?.current_level,
  content: r.content?.message,
  likes: r.like,
  replyCount: r.rcount,
  time: isoTime(r.ctime),
  location: r.reply_control?.location?.replace('IP属地：', ''),
  upLiked: r.up_action?.like || undefined,
  replies: (r.replies ?? []).slice(0, 3).map((x: any) => ({
    user: x.member?.uname,
    content: x.content?.message,
    likes: x.like,
  })),
})

export const getComments = async (
  client: BiliClient,
  aid: number,
  opts: { sort?: 'hot' | 'time'; offset?: string; limit?: number } = {},
) => {
  const mode = opts.sort === 'time' ? 2 : 3
  const data = await client.json<any>('https://api.bilibili.com/x/v2/reply/wbi/main', {
    query: {
      oid: aid,
      type: 1,
      mode,
      plat: 1,
      web_location: 1315875,
      pagination_str: JSON.stringify({ offset: opts.offset ?? '' }),
    },
    wbi: true,
  })
  const replies: any[] = data.replies ?? []
  const pinned = data.top_replies?.length ? data.top_replies : data.upper?.top ? [data.upper.top] : []
  return {
    total: data.cursor?.all_count,
    pinned: pinned.map(mapReply),
    comments: replies.slice(0, opts.limit ?? 20).map(mapReply),
    nextOffset: data.cursor?.is_end ? undefined : data.cursor?.pagination_reply?.next_offset,
  }
}

// ---------------- search (Bilibili-Evolved: launch-bar search providers) ----------------

export type SearchType = 'video' | 'bili_user' | 'media_bangumi' | 'media_ft' | 'live_room' | 'article'

export const search = async (
  client: BiliClient,
  keyword: string,
  opts: { type?: SearchType; page?: number; order?: string } = {},
) => {
  const type = opts.type ?? 'video'
  const data = await client.json<any>('https://api.bilibili.com/x/web-interface/wbi/search/type', {
    query: { search_type: type, keyword, page: opts.page ?? 1, order: opts.order },
    wbi: true,
  })
  const items: any[] = data.result ?? []
  const mapped = items.map(it => {
    switch (type) {
      case 'video':
        return {
          bvid: it.bvid,
          title: stripTags(it.title),
          author: it.author,
          mid: it.mid,
          play: it.play,
          danmaku: it.danmaku ?? it.video_review,
          favorites: it.favorites,
          duration: it.duration,
          published: isoTime(it.pubdate),
          description: stripTags(it.description).slice(0, 200),
          url: `https://www.bilibili.com/video/${it.bvid}`,
        }
      case 'bili_user':
        return {
          mid: it.mid,
          name: it.uname,
          sign: it.usign,
          fans: it.fans,
          videos: it.videos,
          level: it.level,
          official: it.official_verify?.desc || undefined,
          url: `https://space.bilibili.com/${it.mid}`,
        }
      case 'media_bangumi':
      case 'media_ft':
        return {
          seasonId: it.season_id,
          mediaId: it.media_id,
          title: stripTags(it.title),
          type: it.season_type_name,
          areas: it.areas,
          score: it.media_score?.score,
          episodes: it.ep_size,
          description: stripTags(it.desc).slice(0, 200),
          url: it.url,
        }
      case 'live_room':
        return {
          roomId: it.roomid,
          title: stripTags(it.title),
          uname: it.uname,
          online: it.online,
          area: it.cate_name,
          url: `https://live.bilibili.com/${it.roomid}`,
        }
      case 'article':
        return {
          cvid: it.id,
          title: stripTags(it.title),
          author: it.author_name ?? it.mid,
          views: it.view,
          likes: it.like,
          description: stripTags(it.desc).slice(0, 200),
          url: `https://www.bilibili.com/read/cv${it.id}`,
        }
      default:
        return it
    }
  })
  return { page: data.page, totalPages: data.numPages, totalResults: data.numResults, results: mapped }
}

// ---------------- hot / ranking (Bilibili-Evolved: trending-search, popular) ----------------

const mapArchive = (v: any) => ({
  bvid: v.bvid ?? (v.aid ? av2bv(v.aid) : undefined),
  title: v.title,
  author: v.owner?.name ?? v.author,
  play: v.stat?.view ?? v.play,
  like: v.stat?.like,
  danmaku: v.stat?.danmaku,
  duration: durationText(v.duration),
  reason: v.rcmd_reason?.content || undefined,
  url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : undefined,
})

export const RANKING_REGIONS: Record<string, number> = {
  all: 0,
  anime: 1,
  guochuang: 168,
  music: 3,
  dance: 129,
  game: 4,
  knowledge: 36,
  tech: 188,
  sports: 234,
  car: 223,
  life: 160,
  food: 211,
  animal: 217,
  kichiku: 119,
  fashion: 155,
  ent: 5,
  cinephile: 181,
}

export const hot = async (
  client: BiliClient,
  kind: 'search_words' | 'popular' | 'ranking' | 'weekly',
  opts: { region?: string; limit?: number; page?: number } = {},
) => {
  const limit = opts.limit ?? 20
  if (kind === 'search_words') {
    const data = await client.json<any>('https://api.bilibili.com/x/web-interface/search/square', {
      query: { limit: Math.min(limit, 50) },
    })
    return (data.trending?.list ?? []).map((w: any, i: number) => ({
      rank: i + 1,
      keyword: w.keyword,
      display: w.show_name,
    }))
  }
  if (kind === 'popular') {
    const data = await client.json<any>('https://api.bilibili.com/x/web-interface/popular', {
      query: { pn: opts.page ?? 1, ps: Math.min(limit, 50) },
    })
    return (data.list ?? []).map(mapArchive)
  }
  if (kind === 'weekly') {
    const series = await client.json<any>('https://api.bilibili.com/x/web-interface/popular/series/list')
    const latest = series.list?.[0]
    const data = await client.json<any>('https://api.bilibili.com/x/web-interface/popular/series/one', {
      query: { number: latest?.number },
    })
    return {
      issue: latest?.number,
      subject: latest?.subject,
      videos: (data.list ?? []).slice(0, limit).map(mapArchive),
    }
  }
  const rid = RANKING_REGIONS[opts.region ?? 'all'] ?? 0
  const data = await client.json<any>('https://api.bilibili.com/x/web-interface/ranking/v2', {
    query: { rid, type: 'all' },
  })
  return (data.list ?? []).slice(0, limit).map((v: any, i: number) => ({ rank: i + 1, ...mapArchive(v), score: v.score }))
}

// ---------------- user (Bilibili-Evolved: uid-search / view-avatar) ----------------

export const userInfo = async (client: BiliClient, mid: number, opts: { videos?: number } = {}) => {
  const card = await client.json<any>('https://api.bilibili.com/x/web-interface/card', {
    query: { mid, photo: false },
  })
  const c = card.card ?? {}
  let recentVideos: unknown
  if (opts.videos) {
    try {
      const arc = await client.json<any>('https://api.bilibili.com/x/space/wbi/arc/search', {
        query: { mid, ps: Math.min(opts.videos, 50), pn: 1, order: 'pubdate' },
        wbi: true,
      })
      recentVideos = (arc.list?.vlist ?? []).map((v: any) => ({
        bvid: v.bvid,
        title: v.title,
        play: v.play,
        comments: v.comment,
        length: v.length,
        published: isoTime(v.created),
        url: `https://www.bilibili.com/video/${v.bvid}`,
      }))
    } catch (error) {
      recentVideos = `获取投稿列表失败：${(error as Error).message}`
    }
  }
  return {
    mid: Number(c.mid ?? mid),
    name: c.name,
    sign: c.sign,
    sex: c.sex,
    avatar: c.face,
    level: c.level_info?.current_level,
    fans: c.fans,
    following: c.attention,
    archiveCount: card.archive_count,
    articleCount: card.article_count,
    likes: card.like_num,
    official: c.Official?.title || undefined,
    vip: c.vip?.vipStatus ? c.vip?.label?.text || '大会员' : undefined,
    url: `https://space.bilibili.com/${mid}`,
    recentVideos,
  }
}

// ---------------- live (Bilibili-Evolved: live/*) ----------------

export const liveRoom = async (client: BiliClient, roomId: number) => {
  const room = await client.json<any>('https://api.live.bilibili.com/room/v1/Room/get_info', {
    query: { room_id: roomId },
  })
  return {
    roomId: room.room_id,
    shortId: room.short_id || undefined,
    uid: room.uid,
    title: room.title,
    status: ['未开播', '直播中', '轮播中'][room.live_status] ?? String(room.live_status),
    online: room.online,
    area: [room.parent_area_name, room.area_name].filter(Boolean).join(' / '),
    liveSince: room.live_time && room.live_time !== '0000-00-00 00:00:00' ? room.live_time : undefined,
    cover: room.user_cover,
    description: stripTags(room.description).slice(0, 300),
    tags: room.tags,
    url: `https://live.bilibili.com/${room.room_id}`,
  }
}

// ---------------- account (login required) ----------------

export const me = async (client: BiliClient) => {
  client.requireLogin('查看当前账号')
  const nav = await client.json<any>('https://api.bilibili.com/x/web-interface/nav')
  return {
    mid: nav.mid,
    name: nav.uname,
    level: nav.level_info?.current_level,
    vip: nav.vipStatus ? nav.vip_label?.text || '大会员' : '无',
    coins: nav.money,
    avatar: nav.face,
  }
}

export const watchLater = async (client: BiliClient) => {
  client.requireLogin('稍后再看')
  const data = await client.json<any>('https://api.bilibili.com/x/v2/history/toview')
  return {
    count: data.count,
    videos: (data.list ?? []).map((v: any) => ({
      ...mapArchive(v),
      progress: v.progress > 0 ? `${formatDuration(v.progress)} / ${formatDuration(v.duration)}` : v.progress === -1 ? '已看完' : '未观看',
      addedAt: isoTime(v.add_at),
    })),
  }
}

export const watchLaterEdit = async (client: BiliClient, action: 'add' | 'remove', aid: number) => {
  client.requireWrite(action === 'add' ? '添加稍后再看' : '移除稍后再看')
  await client.json('https://api.bilibili.com/x/v2/history/toview/' + (action === 'add' ? 'add' : 'del'), {
    form: { aid, csrf: client.csrf },
  })
  return { ok: true, action, aid, bvid: av2bv(aid) }
}

export const favorites = async (client: BiliClient, opts: { folderId?: number; page?: number; keyword?: string }) => {
  client.requireLogin('收藏夹')
  if (!opts.folderId) {
    const { mid } = await me(client)
    const data = await client.json<any>('https://api.bilibili.com/x/v3/fav/folder/created/list-all', {
      query: { up_mid: mid },
    })
    return {
      folders: (data?.list ?? []).map((f: any) => ({ folderId: f.id, title: f.title, count: f.media_count })),
    }
  }
  const data = await client.json<any>('https://api.bilibili.com/x/v3/fav/resource/list', {
    query: { media_id: opts.folderId, pn: opts.page ?? 1, ps: 20, keyword: opts.keyword, platform: 'web' },
  })
  return {
    folder: data.info?.title,
    total: data.info?.media_count,
    hasMore: data.has_more,
    items: (data.medias ?? []).map((m: any) => ({
      bvid: m.bvid,
      title: m.title,
      author: m.upper?.name,
      play: m.cnt_info?.play,
      duration: formatDuration(m.duration ?? 0),
      favoritedAt: isoTime(m.fav_time),
      invalid: m.attr === 9 || m.title === '已失效视频' || undefined,
      url: m.bvid ? `https://www.bilibili.com/video/${m.bvid}` : undefined,
    })),
  }
}

export const history = async (client: BiliClient, opts: { cursor?: { max: number; viewAt: number } }) => {
  client.requireLogin('历史记录')
  const data = await client.json<any>('https://api.bilibili.com/x/web-interface/history/cursor', {
    query: { ps: 20, max: opts.cursor?.max, view_at: opts.cursor?.viewAt, type: 'archive' },
  })
  return {
    items: (data.list ?? []).map((h: any) => ({
      title: h.title,
      bvid: h.history?.bvid || undefined,
      author: h.author_name,
      progress: h.progress === -1 ? '已看完' : `${formatDuration(Math.max(0, h.progress))} / ${formatDuration(h.duration ?? 0)}`,
      viewedAt: isoTime(h.view_at),
      url: h.uri || (h.history?.bvid ? `https://www.bilibili.com/video/${h.history.bvid}` : undefined),
    })),
    next: data.cursor?.max ? { max: data.cursor.max, viewAt: data.cursor.view_at } : undefined,
  }
}

/** Following feed (Bilibili-Evolved: feeds/*) */
export const feed = async (client: BiliClient, opts: { type?: 'all' | 'video'; offset?: string }) => {
  client.requireLogin('动态')
  const data = await client.json<any>('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all', {
    query: { type: opts.type ?? 'video', offset: opts.offset, timezone_offset: -480, features: 'itemOpusStyle' },
  })
  const items = (data.items ?? []).map((it: any) => {
    const author = it.modules?.module_author
    const dyn = it.modules?.module_dynamic
    const archive = dyn?.major?.archive
    const opus = dyn?.major?.opus
    return {
      id: it.id_str,
      type: it.type,
      author: author?.name,
      mid: author?.mid,
      time: isoTime(author?.pub_ts),
      text: (dyn?.desc?.text || opus?.summary?.text || '').slice(0, 500) || undefined,
      video: archive
        ? { bvid: archive.bvid, title: archive.title, duration: archive.duration_text, play: archive.stat?.play }
        : undefined,
      url: archive?.jump_url ? `https:${archive.jump_url}` : `https://t.bilibili.com/${it.id_str}`,
    }
  })
  return { items, nextOffset: data.has_more ? data.offset : undefined }
}

export const ensureVideoAid = (aid: number | undefined) => {
  if (!aid) throw new BiliError('需要一个视频')
  return aid
}
