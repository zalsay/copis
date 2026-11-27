export class WordProblem extends Error {}
export type WordContent = { text: string; images: Buffer[] }
export const wordLimit = 20 * 1024 * 1024
export const pageLimit = 80

/** 只允许内嵌位图；不把 SVG、链接或伪装成图片的文件交给解码器。 */
export function wordImageType(bytes: Buffer): string {
  const head = bytes.subarray(0, 8).toString('hex')
  if (head === '89504e470d0a1a0a') return 'image/png'
  if (head.startsWith('ffd8ff')) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.toString('ascii',0,6))) return 'image/gif'
  if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'image/webp'
  throw new WordProblem('Word 含不支持的图片，请在 Word 中将该图转换为 PNG 或 JPEG。')
}
