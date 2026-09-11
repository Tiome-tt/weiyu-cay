import type { RichNode } from '../../domain/content'
import type { NoteDocument } from '../../domain/model'
import type { AssetPort, ImageReadPort, NotePort, TrashPort } from '../../domain/ports'
import { markdownToRichDocument } from '../document/markdownConversion'

interface ConversionPorts {
  notes: Pick<NotePort, 'createNote' | 'saveNote'>
  assets?: AssetPort
  assetReader?: ImageReadPort
  trash: Pick<TrashPort, 'trash'>
}

/** Keep the Markdown source immutable and give every copied image a new owner. */
export async function convertMarkdownCopy(source: NoteDocument, ports: ConversionPorts): Promise<NoteDocument> {
  if (source.content !== undefined) throw new Error('只有 Markdown 笔记可以转换为文档副本。')
  const document = markdownToRichDocument(source.markdown)
  const copy = await ports.notes.createNote({
    title: `${source.title}（文档副本）`,
    folderId: source.folderId,
    format: 'document',
  })
  if (copy.id === source.id || copy.content?.type !== 'document') {
    throw new Error('未创建独立文档，原笔记已保留。')
  }

  try {
    const images = new Map<string, string>()
    const copyImages = async (node: RichNode): Promise<void> => {
      if (node.type === 'image') {
        const sourcePath = node.attrs?.src
        if (typeof sourcePath !== 'string' || ports.assets === undefined || ports.assetReader === undefined) {
          throw new Error('无法复制图片。')
        }
        let destination = images.get(sourcePath)
        if (destination === undefined) {
          const image = await ports.assetReader.readImage({ noteId: source.id, relativePath: sourcePath })
          destination = (await ports.assets.saveImage({ noteId: copy.id, ...image })).relativePath
          images.set(sourcePath, destination)
        }
        node.attrs = { ...node.attrs, src: destination }
      }
      for (const child of node.content ?? []) await copyImages(child)
    }
    await copyImages(document.root)
    return await ports.notes.saveNote({
      ...copy,
      tags: [...source.tags],
      markdown: '',
      content: { type: 'document', document },
    })
  } catch (cause) {
    try {
      const rollback = await ports.trash.trash([copy.id])
      if (!rollback.trashed.includes(copy.id)) throw new Error('rollback failed')
    } catch {
      throw new Error(`转换未完成，原笔记已保留。未完成的文档副本仍在资料库，可手动移入回收站。${cause instanceof Error ? ` ${cause.message}` : ''}`)
    }
    throw new Error(`转换未完成，原笔记已保留，未完成的副本已移入回收站。${cause instanceof Error ? ` ${cause.message}` : ''}`)
  }
}
