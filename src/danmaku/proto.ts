import protobuf from 'protobufjs'

/**
 * Protobuf definitions for the web danmaku segment APIs.
 * Ported from Bilibili-Evolved registry/lib/components/video/danmaku/converter/danmaku-segment.ts (MIT).
 */
const proto = {
  nested: {
    DmWebViewReply: {
      fields: {
        state: { type: 'int32', id: 1 },
        text: { type: 'string', id: 2 },
        textSide: { type: 'string', id: 3 },
        dmSge: { type: 'DmSegConfig', id: 4 },
        count: { type: 'int64', id: 8 },
      },
    },
    DmSegConfig: {
      fields: {
        pageSize: { type: 'int64', id: 1 },
        total: { type: 'int64', id: 2 },
      },
    },
    DmSegMobileReply: {
      fields: {
        elems: { rule: 'repeated', type: 'DanmakuElem', id: 1 },
      },
    },
    DanmakuElem: {
      fields: {
        id: { type: 'int64', id: 1 },
        progress: { type: 'int32', id: 2 },
        mode: { type: 'int32', id: 3 },
        fontsize: { type: 'int32', id: 4 },
        color: { type: 'uint32', id: 5 },
        midHash: { type: 'string', id: 6 },
        content: { type: 'string', id: 7 },
        ctime: { type: 'int64', id: 8 },
        weight: { type: 'int32', id: 9 },
        action: { type: 'string', id: 10 },
        pool: { type: 'int32', id: 11 },
        idStr: { type: 'string', id: 12 },
        attr: { type: 'int32', id: 13 },
      },
    },
  },
}

export const root = protobuf.Root.fromJSON(proto)

export interface DanmakuElem {
  id?: string
  progress?: number
  mode?: number
  fontsize?: number
  color?: number
  midHash?: string
  content: string
  ctime?: number
  weight?: number
  pool?: number
  idStr?: string
  attr?: number
}

const decode = <T>(type: string, buffer: Uint8Array): T => {
  const message = root.lookupType(type)
  return message.toObject(message.decode(buffer), { longs: String }) as T
}

export const decodeView = (buffer: Uint8Array) =>
  decode<{ dmSge?: { total?: string; pageSize?: string }; count?: string }>('DmWebViewReply', buffer)

export const decodeSegment = (buffer: Uint8Array) =>
  decode<{ elems?: (Omit<DanmakuElem, 'ctime'> & { ctime?: string })[] }>('DmSegMobileReply', buffer)
