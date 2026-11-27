import { expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { readWord } from './room-word'
import { WordProblem } from './room-word-limits'
import { replyWithFiles } from './room-file-reply'
import { renderWordPdf } from './room-word-pdf'
import sharp from 'sharp'
const ns = 'http://schemas.openxmlformats.org/'
async function fixture(external = false) {
  const zip = new AdmZip()
  const put = (s: string, data: string | Buffer) => zip.addFile(s, Buffer.from(data))
  put(
    'word/document.xml',
    `<w:document xmlns:w="${ns}wordprocessingml/2006/main" xmlns:a="${ns}drawingml/2006/main" xmlns:r="${ns}officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>作业</w:t></w:r></w:p>${['second', 'first', 'second'].map((id) => `<a:blip r:embed="${id}"/>`).join('')}</w:body></w:document>`,
  )
  put(
    'word/_rels/document.xml.rels',
    `<Relationships xmlns="${ns}package/2006/relationships">${['first', 'second'].map((id, i) => `<Relationship Id="${id}" Type="${ns}officeDocument/2006/relationships/image" Target="media/${i}.png" ${external ? 'TargetMode="External"' : ''}/>`).join('')}</Relationships>`,
  )
  for (let i = 0; i < 2; i++)
    put(
      `word/media/${i}.png`,
      await sharp({ create: { width: i ? 80 : 24, height: 40, channels: 3, background: i ? 'blue' : 'red' } })
        .png()
        .toBuffer(),
    )
  return zip.toBuffer()
}
test('DOCX 依正文顺序而非 ZIP 顺序，重复引用不丢；打印 A4 PDF', async () => {
  const doc = readWord(await fixture())
  expect(doc.text).toContain('作业')
  expect(doc.images.length).toBe(3)
  expect(await Promise.all(doc.images.map(async (i) => (await sharp(i).metadata()).width))).toEqual([
    80, 24, 80,
  ])
  const pdf = await renderWordPdf(doc.images, sharp, () => {})
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length).toBe(3)
})
test('Word 97 内嵌图片按正文锚点排序', async () => {
  const doc = readWord(
    Buffer.from(await Bun.file(new URL('./fixtures/inline-pictures.doc', import.meta.url)).arrayBuffer()),
  )
  expect(doc.text).toContain('0')
  expect(await Promise.all(doc.images.map(async (b) => (await sharp(b).metadata()).width))).toEqual([
    10, 13, 16,
  ])
})
test('外链不读取、不静默遗漏', async () => {
  const b = await fixture(true)
  expect(() => readWord(b)).toThrow(WordProblem)
})

test('点名 Word 转 PDF：回执是上传确认的 ID；普通提问则模型实际收到正文及图片', async () => {
  const source = { name: '绘本.docx', mimeType: 'application/octet-stream', bytes: await fixture() }
  let pages = 0,
    calls = 0
  const deps = {
    assertActive: () => {},
    decode: () => sharp,
    ask: async (text: string, images: unknown[]) => {
      calls++
      expect(text).toContain('作业')
      expect(images).toHaveLength(3)
      return '已读'
    },
    upload: async (name: string, bytes: Buffer) => {
      expect(name).toBe('绘本-A4.pdf')
      pages = bytes.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0
      return { id: 'output-id' }
    },
  }
  expect(await replyWithFiles('请合成一份 A4 PDF', [source], deps)).toMatchObject({
    attachmentIds: ['output-id'],
  })
  expect(pages).toBe(3)
  expect(calls).toBe(0)
  expect(await replyWithFiles('请看一下，不要转 PDF', [source], deps)).toEqual({ content: '已读' })
  expect(calls).toBe(1)
  await expect(
    replyWithFiles('转 PDF', [source], {
      ...deps,
      upload: async () => {
        throw Error('未确认上传')
      },
    }),
  ).rejects.toThrow('未确认上传')
  expect(
    (await replyWithFiles('转 PDF', [{ ...source, bytes: Buffer.from('bad') }], deps)).attachmentIds,
  ).toBeUndefined()
})
