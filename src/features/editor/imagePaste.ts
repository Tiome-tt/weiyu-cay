import {text as uiText} from '../../shared/i18n'
import type { NoteId } from '../../domain/model'
import type { AssetPort } from '../../domain/ports'

const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface ImagePasteEvent {
  clipboardData: { files: ArrayLike<Pick<File, 'type' | 'arrayBuffer'>> } | null
  preventDefault(): void
}

export type ImagePasteResult =
  | { kind: 'ignored' }
  | { kind: 'success'; markdown: string }
  | { kind: 'failure'; message: string }

export async function handleImagePaste(
  event: ImagePasteEvent,
  context: { noteId: NoteId; assets: AssetPort },
): Promise<ImagePasteResult> {
  const file = Array.from(event.clipboardData?.files ?? []).find((candidate) =>
    supportedImageTypes.has(candidate.type),
  )
  if (file === undefined) return { kind: 'ignored' }

  event.preventDefault()
  try {
    const saved = await context.assets.saveImage({
      noteId: context.noteId,
      mediaType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })
    return { kind: 'success', markdown: uiText(`![截图](${saved.relativePath})`,`![Screenshot](${saved.relativePath})`) }
  } catch {
    return { kind: 'failure', message: uiText("无法保存截图。","Could not save the screenshot.") }
  }
}
