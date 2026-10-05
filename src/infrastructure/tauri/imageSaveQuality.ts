import type { AppSettings } from '../../domain/ports'

type ImagePayload = { mediaType: string; bytes: Uint8Array }
type WebpEncoder = (source: Blob, quality: number) => Promise<Blob | null>

export async function prepareImageForStorage<T extends ImagePayload>(
  input: T,
  quality: AppSettings['imageSaveQuality'],
  encode: WebpEncoder = encodeWebp,
): Promise<T> {
  if (quality === 'original' || !['image/png', 'image/jpeg'].includes(input.mediaType)) return input
  if (input.mediaType === 'image/png' && isAnimatedPng(input.bytes)) return input
  try {
    const blob = await encode(new Blob([Uint8Array.from(input.bytes)], { type: input.mediaType }), quality === 'webp-q85' ? 0.85 : 0.95)
    if (!blob || blob.type !== 'image/webp' || blob.size >= input.bytes.byteLength) return input
    return { ...input, mediaType: 'image/webp', bytes: new Uint8Array(await blob.arrayBuffer()) }
  } catch {
    // Encoder support varies between desktop WebViews; keep the original image on failure.
    return input
  }
}

function isAnimatedPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return false
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = (bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]
    if (length > bytes.length - offset - 12) return false
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (kind === 'acTL') return true
    if (kind === 'IDAT' || kind === 'IEND') return false
    offset += 12 + length
  }
  return false
}

async function encodeWebp(source: Blob, quality: number): Promise<Blob | null> {
  const url = URL.createObjectURL(source)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('image decode failed'))
      image.src = url
    })
    if (image.naturalWidth === 0 || image.naturalHeight === 0 || image.naturalWidth * image.naturalHeight > 64_000_000) return null
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    try {
      const context = canvas.getContext('2d')
      if (!context) return null
      context.drawImage(image, 0, 0)
      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}
