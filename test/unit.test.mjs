import { test } from 'node:test'
import assert from 'node:assert/strict'
import { av2bv, bv2av, parseTarget } from '../dist/ids.js'
import { getMixinKey, signWbi, keyFromUrl } from '../dist/wbi.js'
import { root, decodeSegment, decodeView } from '../dist/danmaku/proto.js'
import { toAss, toXml, fromElem, secondsToAssTime } from '../dist/danmaku/converter.js'
import { toSrt, toText, toAss as subAss } from '../dist/subtitle.js'
import { loadConfig } from '../dist/config.js'
import { danmakuStats, danmakuLines } from '../dist/api/media.js'

test('av/BV conversion matches known pairs', () => {
  assert.equal(av2bv(170001), 'BV17x411w7KC')
  assert.equal(bv2av('BV17x411w7KC'), 170001)
  assert.equal(av2bv(111298867365120), 'BV1L9Uoa9EUx')
  assert.equal(bv2av('BV1L9Uoa9EUx'), 111298867365120)
  for (const aid of [1, 2, 99999, 1234567890, 2 ** 40 + 7]) assert.equal(bv2av(av2bv(aid)), aid)
})

test('wbi signing (public reference vector)', () => {
  const img = '7cd084941338484aae1ad9425b84077c'
  const sub = '4932caff0ff746eab6f01bf08b70ac45'
  assert.equal(getMixinKey(img, sub), 'ea1db124af3c7062474693fa704f4ff8')
  const q = signWbi({ foo: '114', bar: '514', zab: 1919810 }, img, sub, 1702204169)
  assert.equal(q, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4')
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'), img)
  // forbidden chars stripped, values url-encoded
  assert.match(signWbi({ k: "a b!'()*" }, img, sub, 1), /^k=a%20b&wts=1&w_rid=[0-9a-f]{32}$/)
})

test('parseTarget recognises many input shapes', () => {
  assert.deepEqual(parseTarget('https://www.bilibili.com/video/BV17x411w7KC/?p=3&spm=1'), { kind: 'video', bvid: 'BV17x411w7KC', aid: 170001, page: 3 })
  assert.deepEqual(parseTarget('av170001'), { kind: 'video', aid: 170001, bvid: 'BV17x411w7KC', page: undefined })
  assert.deepEqual(parseTarget('https://www.bilibili.com/bangumi/play/ep123456'), { kind: 'episode', epid: 123456 })
  assert.deepEqual(parseTarget('ss28747'), { kind: 'season', seasonId: 28747 })
  assert.deepEqual(parseTarget('https://www.bilibili.com/bangumi/media/md28229899'), { kind: 'media', mediaId: 28229899 })
  assert.deepEqual(parseTarget('https://space.bilibili.com/2/video'), { kind: 'user', mid: 2 })
  assert.deepEqual(parseTarget('https://live.bilibili.com/21452505?x=1'), { kind: 'live', roomId: 21452505 })
  assert.deepEqual(parseTarget('cv1'), { kind: 'article', cvid: 1 })
  assert.deepEqual(parseTarget('UID: 546195'), { kind: 'user', mid: 546195 })
  assert.equal(parseTarget('hello world'), undefined)
  // "nav123" must not be read as av123
  assert.equal(parseTarget('nav123'), undefined)
})

test('config merges SESSDATA / bili_jct and gates writes', () => {
  const c = loadConfig({ BILIBILI_SESSDATA: 'abc', BILIBILI_BILI_JCT: 'xyz', BILIBILI_DOWNLOAD_DIR: '/tmp/x' })
  assert.equal(c.cookie, 'SESSDATA=abc; bili_jct=xyz')
  assert.equal(c.csrf, 'xyz')
  assert.equal(c.allowWrite, false)
  assert.equal(loadConfig({ BILIBILI_ALLOW_WRITE: 'true' }).allowWrite, true)
})

const elems = [
  { id: '1', progress: 1500, mode: 1, fontsize: 25, color: 16777215, midHash: 'aa', content: '前方高能', ctime: '1700000000', pool: 0, idStr: '1' },
  { id: '2', progress: 1600, mode: 1, fontsize: 25, color: 16711680, midHash: 'bb', content: 'long danmaku <xml> & "quotes"', ctime: '1700000001', pool: 0, idStr: '2' },
  { id: '3', progress: 3000, mode: 5, fontsize: 25, color: 16777215, midHash: 'cc', content: '顶部弹幕', ctime: '1700000002', pool: 0, idStr: '3' },
  { id: '4', progress: 3100, mode: 4, fontsize: 18, color: 255, midHash: 'dd', content: '底部{弹幕}', ctime: '1700000003', pool: 0, idStr: '4' },
  { id: '5', progress: 65000, mode: 7, fontsize: 25, color: 1, midHash: 'ee', content: '[高级弹幕]', ctime: '1700000004', pool: 0, idStr: '5' },
  { id: '6', progress: 70000, mode: 1, fontsize: 25, color: 16777215, midHash: 'ff', content: '前方高能', ctime: '1700000005', pool: 0, idStr: '6' },
]

export const encodeSegment = list => {
  const T = root.lookupType('DmSegMobileReply')
  return T.encode(T.fromObject({ elems: list })).finish()
}
export const encodeView = total => {
  const T = root.lookupType('DmWebViewReply')
  return T.encode(T.fromObject({ state: 0, dmSge: { pageSize: 360000, total } })).finish()
}

test('danmaku protobuf round trip', () => {
  const decoded = decodeSegment(encodeSegment(elems))
  assert.equal(decoded.elems.length, 6)
  assert.equal(decoded.elems[1].content, elems[1].content)
  assert.equal(decoded.elems[0].ctime, '1700000000')
  assert.equal(decodeView(encodeView(3)).dmSge.total, '3')
})

test('danmaku → xml / ass conversion (ported converter)', () => {
  const list = elems.map(fromElem)
  const xml = toXml(123, list)
  assert.match(xml, /<chatid>123<\/chatid>/)
  assert.match(xml, /<d p="1.6,1,25,16711680,1700000001,0,bb,2">long danmaku &lt;xml&gt; &#38; &#34;quotes&#34;<\/d>/)
  const ass = toAss(list, { title: 'T' })
  const dialogues = ass.split('\n').filter(l => l.startsWith('Dialogue:'))
  assert.equal(dialogues.length, 5, 'mode 7 advanced danmaku dropped')
  assert.match(dialogues[0], /^Dialogue: 0,0:00:01\.50,0:00:19\.50,Medium,,0,0,0,,\{\\move\(/)
  // second scroll danmaku goes to the next track (y differs)
  const y = l => l.match(/\\move\([\d.]+,([\d.]+)/)[1]
  assert.notEqual(y(dialogues[0]), y(dialogues[1]))
  assert.match(dialogues[1], /\\c&H0000FF&/) // red → BGR
  assert.match(ass, /\\pos\(960,30\).*顶部弹幕/)
  assert.match(ass, /Small,.*底部｛弹幕｝/)
  assert.equal(secondsToAssTime(3725.5), '1:02:05.50')
  const blocked = toAss(list, { title: 'T', blockKeywords: ['高能'] })
  assert.ok(!blocked.includes('前方高能'))
})

test('danmaku stats and lines', () => {
  const list = elems.map(fromElem)
  const s = danmakuStats(list, 120)
  assert.equal(s.total, 6)
  assert.deepEqual(s.topPhrases[0], { text: '前方高能', count: 2 })
  assert.equal(s.density.length, 2)
  assert.equal(s.density[0].count, 4)
  const l = danmakuLines(list, { from: 60, limit: 10 })
  assert.deepEqual(l.lines, ['[01:05] [高级弹幕]', '[01:10] 前方高能'])
  const sampled = danmakuLines(list, { limit: 3 })
  assert.equal(sampled.returned, 3)
  assert.equal(sampled.sampled, true)
})

test('subtitle conversions', () => {
  const items = [
    { from: 0.5, to: 2.25, content: '你好' },
    { from: 3661.2, to: 3663, content: 'second {line}' },
  ]
  assert.equal(toSrt(items), '1\n00:00:00,500 --> 00:00:02,250\n你好\n\n2\n01:01:01,200 --> 01:01:03,000\nsecond {line}\n')
  assert.equal(toText(items), '[00:00] 你好\n[1:01:01] second {line}')
  assert.equal(toText(items, false), '你好\nsecond {line}')
  const ass = subAss(items, { title: 'x' })
  assert.match(ass, /Dialogue: 0,0:00:00\.50,0:00:02\.25,BottomCenter,,0,0,0,,你好/)
  assert.match(ass, /second ｛line｝/)
})
