import type {
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  offloadedImageText,
  requestImageHandleText,
  type LlmImageRequestPricing,
} from '@deepseek-ai/dsh-llm'

import { pluginFailure } from './errors.js'
import type { NativeContentBlock, NativeImageMediaType } from './sdk-runtime.js'

/**
 * Long edge of one request image. The Claude API scales a longer edge down to
 * 1568 px before it counts the image, so a larger request image adds no model
 * detail. Reviewed against the Claude vision documentation on 2026-11-11.
 */
export const CLAUDE_IMAGE_LONG_EDGE = 1_568

/** Encoded-byte target of one request image. The API limit is 5 MB. */
export const CLAUDE_IMAGE_MAX_BYTES = 4 * 1024 * 1024

/** Claude vision token accounting: about one token for each 750 pixels. */
export const CLAUDE_IMAGE_PIXELS_PER_TOKEN = 750

const NATIVE_IMAGE_MEDIA_TYPES: readonly NativeImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** One model-visible block taken from a dsh message that the adapter sends. */
export type OutgoingBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly attachment: ImageAttachmentRef
    readonly offloaded?: true
  }

/** The attachment service methods this adapter needs. Tests supply a fake. */
export interface ImageAttachmentReader {
  readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment>
}

/** One exact request version that the native session sends. */
export interface PreparedImage {
  readonly mediaType: NativeImageMediaType
  readonly data: string
  readonly width: number
  readonly height: number
}

/** Resolve the request dimensions and byte target for one retained image. */
export function claudeImageTarget(image: { readonly width: number; readonly height: number }): ImageRequestTarget {
  if (!isPositiveInteger(image.width) || !isPositiveInteger(image.height)) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'An image attachment has no valid width and height.')
  }
  const projected = longEdgeDimensions(image.width, image.height, CLAUDE_IMAGE_LONG_EDGE)
  return { width: projected.width, height: projected.height, maxBytes: CLAUDE_IMAGE_MAX_BYTES }
}

/** Approximate visual tokens of one request image. */
export function claudeImageTokens(width: number, height: number): number {
  return Math.max(1, Math.ceil((width * height) / CLAUDE_IMAGE_PIXELS_PER_TOKEN))
}

/**
 * Publish the same per-image price and descriptor text that the request sends.
 * Offloaded occurrences cost no visual tokens.
 */
export function claudeImageRequestPricing(): LlmImageRequestPricing {
  return {
    priceImages(images) {
      return images.map((block) => {
        if (block.offloaded === true) {
          return { visualTokens: 0, text: offloadedImageText(block.attachment, undefined) }
        }
        const target = claudeImageTarget(block.attachment)
        return {
          visualTokens: claudeImageTokens(target.width, target.height),
          text: requestImageHandleText(block.attachment, target, undefined),
        }
      })
    },
  }
}

/** Replace each offloaded image with its deterministic placeholder text. */
export function projectOffloadedImages(blocks: readonly OutgoingBlock[]): readonly OutgoingBlock[] {
  let next: OutgoingBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image' && block.offloaded === true) {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: offloadedImageText(block.attachment, undefined) })
      continue
    }
    next?.push(block)
  }
  return next ?? blocks
}

/**
 * Read every distinct retained image as one request version.
 * A missing attachment service is a refusal before native dispatch.
 */
export async function prepareRequestImages(
  blocks: readonly OutgoingBlock[],
  reader: ImageAttachmentReader | undefined,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, PreparedImage>> {
  const images = new Map<string, PreparedImage>()
  for (const block of blocks) {
    if (block.type !== 'image' || block.offloaded === true) continue
    const id = String(block.attachment.attachmentId)
    if (images.has(id)) continue
    if (reader === undefined) {
      throw pluginFailure(
        'UNSUPPORTED_INPUT',
        'The request contains an image, but the dsh attachment service is not mounted.',
      )
    }
    const target = claudeImageTarget(block.attachment)
    const version = await reader.readImageRequest(block.attachment, target, signal)
    if (!isNativeImageMediaType(version.mediaType)) {
      throw pluginFailure(
        'UNSUPPORTED_INPUT',
        `The attachment service returned "${version.mediaType}", which the native session cannot send.`,
      )
    }
    images.set(id, {
      mediaType: version.mediaType,
      data: Buffer.from(version.data).toString('base64'),
      width: version.width,
      height: version.height,
    })
  }
  return images
}

/** Convert projected blocks into the exact native content list. */
export function nativeContent(
  blocks: readonly OutgoingBlock[],
  images: ReadonlyMap<string, PreparedImage>,
): NativeContentBlock[] {
  const content: NativeContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
      continue
    }
    if (block.offloaded === true) {
      content.push({ type: 'text', text: offloadedImageText(block.attachment, undefined) })
      continue
    }
    const prepared = images.get(String(block.attachment.attachmentId))
    if (prepared === undefined) {
      throw pluginFailure('UNSUPPORTED_INPUT', 'An image occurrence has no prepared request version.')
    }
    content.push({
      type: 'text',
      text: requestImageHandleText(block.attachment, prepared, undefined),
    })
    content.push({ type: 'image', mediaType: prepared.mediaType, data: prepared.data })
  }
  return content
}

/** Prepare and convert one user or tool-result content list. */
export async function prepareNativeContent(
  blocks: readonly OutgoingBlock[],
  reader: ImageAttachmentReader | undefined,
  signal?: AbortSignal,
): Promise<NativeContentBlock[]> {
  const projected = projectOffloadedImages(blocks)
  const images = await prepareRequestImages(projected, reader, signal)
  return nativeContent(projected, images)
}

export function isNativeImageMediaType(value: unknown): value is NativeImageMediaType {
  return typeof value === 'string'
    && (NATIVE_IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

function longEdgeDimensions(
  width: number,
  height: number,
  longEdge: number,
): { readonly width: number; readonly height: number } {
  if (longEdge >= Math.max(width, height)) return { width, height }
  if (width >= height) {
    return { width: longEdge, height: Math.max(1, Math.round((longEdge * height) / width)) }
  }
  return { width: Math.max(1, Math.round((longEdge * width) / height)), height: longEdge }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
