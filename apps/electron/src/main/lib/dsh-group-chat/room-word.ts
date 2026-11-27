import AdmZip from 'adm-zip'
import { DOMParser } from '@xmldom/xmldom'
import { inflateRawSync } from 'node:zlib'
import { posix } from 'node:path'
import { readBinaryWord } from './room-word-binary'

import { WordProblem, wordLimit, pageLimit, type WordContent } from './room-word-limits'
const relNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const strictRel = 'http://purl.oclc.org/ooxml/officeDocument/relationships'
const isWord = (n: Element) =>
  [
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main',
  ].includes(n.namespaceURI ?? '')
function xml(bytes: Buffer) {
  const text = bytes.toString('utf8')
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || (text.match(/</g)?.length ?? 0) > 60000)
    throw new WordProblem('Word XML 过于复杂或不支持。')
  const fail = () => {
    throw new WordProblem('Word XML 格式无效。')
  }
  return new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } }).parseFromString(
    text,
    'application/xml',
  ).documentElement
}
function readDocx(bytes: Buffer): WordContent {
  const zip = new AdmZip(bytes)
  if (zip.getEntryCount() > 4096) throw new WordProblem('Word 内部文件过多。')
  let remaining = wordLimit
  function read(path: string, limit: number) {
    const e = zip.getEntry(path)
    if (!e || e.header.flags & 1 || e.header.size < 1 || e.header.size > limit)
      throw new WordProblem('Word 内部文件缺失、加密或超过大小限制。')
    const raw = e.getCompressedData()
    const data =
      e.header.method === 0
        ? raw
        : e.header.method === 8
          ? inflateRawSync(raw, { maxOutputLength: limit })
          : null
    if (!data || data.length !== e.header.size) throw new WordProblem('Word 内部文件损坏。')
    return data
  }
  const root = xml(read('word/document.xml', 2 * 1024 * 1024))
  const rels = new Map<string, string>()
  if (zip.getEntry('word/_rels/document.xml.rels')) {
    const all = xml(read('word/_rels/document.xml.rels', 512 * 1024)).getElementsByTagNameNS(
      '*',
      'Relationship',
    )
    for (let i = 0; i < all.length; i++) {
      const r = all.item(i)!
      const target = r.getAttribute('Target') || '',
        id = r.getAttribute('Id')
      if (
        !id ||
        r.getAttribute('TargetMode') === 'External' ||
        ![relNS + '/image', strictRel + '/image'].includes(r.getAttribute('Type') || '')
      )
        continue
      const path = posix.normalize(target.startsWith('/') ? target.slice(1) : 'word/' + target)
      if (/^word\/media\/[^/\\:?#]+$/i.test(path)) rels.set(id, path)
    }
  }
  const texts: string[] = [],
    images: Buffer[] = []
  const cache = new Map<string, Buffer>()
  function visit(n: Element, depth: number) {
    if (depth > 100) throw new WordProblem('Word 嵌套层级过深。')
    if (isWord(n) && ['del', 'moveFrom'].includes(n.localName)) return
    if (isWord(n) && n.localName === 't') {
      texts.push(n.textContent || '')
      return
    }
    if (
      n.namespaceURI === 'http://schemas.openxmlformats.org/markup-compatibility/2006' &&
      n.localName === 'AlternateContent'
    ) {
      const element =
        Array.from(n.childNodes).find((x) => x.nodeType === 1 && (x as Element).localName === 'Choice') ??
        n.getElementsByTagNameNS('*', 'Fallback')[0]
      if (element) visit(element as Element, depth + 1)
      return
    }
    const drawing =
      n.localName === 'blip' &&
      [
        'http://schemas.openxmlformats.org/drawingml/2006/main',
        'http://purl.oclc.org/ooxml/drawingml/main',
      ].includes(n.namespaceURI || '')
    if (drawing || (n.localName === 'imagedata' && n.namespaceURI === 'urn:schemas-microsoft-com:vml')) {
      const attr = drawing ? 'embed' : 'id'
      const path = rels.get(n.getAttributeNS(relNS, attr) || n.getAttributeNS(strictRel, attr) || '')
      if (!path) throw new WordProblem('Word 含外链或缺失的图片，请把图片嵌入文档后再发送。')
      if (images.length >= pageLimit || remaining <= 0)
        throw new WordProblem('Word 图片太多或太大，请拆分后发送。')
      const image = cache.get(path) ?? read(path, remaining)
      remaining -= image.length
      if (remaining < 0) throw new WordProblem('Word 图片总量过大，请拆分后发送。')
      cache.set(path, image)
      images.push(image)
      return
    }
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) visit(c as Element, depth + 1)
    if (isWord(n) && n.localName === 'p') texts.push('\n')
  }
  const body = root.getElementsByTagNameNS('*', 'body')[0]
  if (!body || !isWord(body)) throw new WordProblem('没有找到 Word 正文。')
  visit(body, 0)
  return { text: texts.join('').trim(), images }
}
export function readWord(bytes: Buffer): WordContent {
  try {
    if (bytes.length > wordLimit) throw new WordProblem('Word 文件过大。')
    if (bytes.readUInt32LE(0) === 0x04034b50) return readDocx(bytes)
    if (bytes.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') return readBinaryWord(bytes)
  } catch (e) {
    if (e instanceof WordProblem) throw e
  }
  throw new WordProblem('无法读取这份 Word。请确认未加密，或另存为 .docx 后发送。')
}
