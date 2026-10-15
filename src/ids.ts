/**
 * av/BV conversion and generic input parsing.
 * Mirrors Bilibili-Evolved's `bvid-convert` / `av-url` features.
 */
const XOR_CODE = 23442827791579n
const MASK_CODE = 2251799813685247n
const MAX_AID = 1n << 51n
const BASE = 58n
const ALPHABET = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf'

export const av2bv = (aid: number | string | bigint): string => {
  const bytes = ['B', 'V', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0']
  let index = bytes.length - 1
  let tmp = (MAX_AID | BigInt(aid)) ^ XOR_CODE
  while (tmp > 0n) {
    bytes[index] = ALPHABET[Number(tmp % BASE)]
    tmp /= BASE
    index -= 1
  }
  ;[bytes[3], bytes[9]] = [bytes[9], bytes[3]]
  ;[bytes[4], bytes[7]] = [bytes[7], bytes[4]]
  return bytes.join('')
}

export const bv2av = (bvid: string): number => {
  const chars = bvid.split('')
  ;[chars[3], chars[9]] = [chars[9], chars[3]]
  ;[chars[4], chars[7]] = [chars[7], chars[4]]
  let tmp = 0n
  for (const char of chars.slice(3)) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error(`无效的 BV 号: ${bvid}`)
    tmp = tmp * BASE + BigInt(index)
  }
  return Number((tmp & MASK_CODE) ^ XOR_CODE)
}

export type ParsedTarget =
  | { kind: 'video'; aid: number; bvid: string; page?: number }
  | { kind: 'episode'; epid: number }
  | { kind: 'season'; seasonId: number }
  | { kind: 'media'; mediaId: number }
  | { kind: 'user'; mid: number }
  | { kind: 'live'; roomId: number }
  | { kind: 'article'; cvid: number }
  | { kind: 'audio'; auid: number }

const BV_RE = /BV1[0-9A-Za-z]{9}/
export const SHORT_LINK_RE = /(?:https?:\/\/)?(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/

/** Parse text that may be a URL, BV/av/ep/ss/md/cv/au id, uid etc. (no network). */
export const parseTarget = (input: string): ParsedTarget | undefined => {
  const text = input.trim()
  const pageMatch = text.match(/[?&]p=(\d+)/)
  const page = pageMatch ? parseInt(pageMatch[1]) : undefined

  const bv = text.match(BV_RE)
  if (bv) return { kind: 'video', bvid: bv[0], aid: bv2av(bv[0]), page }

  let m: RegExpMatchArray | null
  if ((m = text.match(/space\.bilibili\.com\/(\d+)/))) return { kind: 'user', mid: +m[1] }
  if ((m = text.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/))) return { kind: 'live', roomId: +m[1] }
  if ((m = text.match(/(?:^|[^a-z])av(\d+)/i))) {
    return { kind: 'video', aid: +m[1], bvid: av2bv(m[1]), page }
  }
  if ((m = text.match(/(?:^|[^a-z])ep(\d+)/i))) return { kind: 'episode', epid: +m[1] }
  if ((m = text.match(/(?:^|[^a-z])ss(\d+)/i))) return { kind: 'season', seasonId: +m[1] }
  if ((m = text.match(/(?:^|[^a-z])md(\d+)/i))) return { kind: 'media', mediaId: +m[1] }
  if ((m = text.match(/(?:^|[^a-z])cv(\d+)/i))) return { kind: 'article', cvid: +m[1] }
  if ((m = text.match(/(?:^|[^a-z])au(\d+)/i))) return { kind: 'audio', auid: +m[1] }
  if ((m = text.match(/(?:^|\D)(?:uid|mid)[:：=\s]*(\d+)/i))) return { kind: 'user', mid: +m[1] }
  return undefined
}
