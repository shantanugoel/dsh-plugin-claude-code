import type {
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  offloadedImageText,
  requestImageHandleText,
  requiredImageOffload,
  type LlmImageRequestBudget,
  type LlmImageRequestPricing,
  type RequestMessage,
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

/**
 * Documented Claude request image limit for a model with a 200000-token
 * context. The provider documents that a request with more than 20 images can
 * use stricter per-image resizing. One image has a 5 MB encoded limit; the
 * 4 MiB request target above stays below it. These values are reviewed from
 * the provider documentation. See decision D26 for the measured probe result.
 */
export const CLAUDE_REQUEST_IMAGE_LIMIT = 100

/** Images above this count in one request can use stricter provider resizing. */
export const CLAUDE_STRICT_RESIZE_IMAGE_COUNT = 20

/**
 * Conservative request image count for this route. The value is below the
 * documented 100-image limit. The adapter fails the request with
 * `IMAGE_OFFLOAD_REQUIRED` before dispatch when the retained occurrences exceed
 * this count or the byte budget.
 */
export const IMAGE_REQUEST_MAX_IMAGES = 80

/**
 * Conservative encoded-byte budget for one request. The provider documents a
 * per-image limit, not a total request limit. This value is an adapter-chosen
 * bound on the base64 request body. It is not a measured provider limit.
 */
export const IMAGE_REQUEST_MAX_BYTES = 20 * 1024 * 1024

/** The exact image budget that `requiredImageOffload` applies to one request. */
export const IMAGE_REQUEST_BUDGET: LlmImageRequestBudget = {
  representation: 'base64',
  maxImages: IMAGE_REQUEST_MAX_IMAGES,
  maxBytes: IMAGE_REQUEST_MAX_BYTES,
}

/**
 * Conservative image count that one native generation can retain. The value
 * leaves 20 images of headroom below the documented request limit. The adapter
 * starts a recorded new generation when the next request would exceed it.
 */
export const IMAGE_GENERATION_MAX_IMAGES = 80

/** Conservative encoded image bytes that one native generation can retain. */
export const IMAGE_GENERATION_MAX_BYTES = 20 * 1024 * 1024

/** Image occurrences and their encoded bytes in one native content list. */
export interface ImageContentStats {
  readonly count: number
  readonly bytes: number
}

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
    rememberRequestVersionBytes(block.attachment, version.data.byteLength)
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

/**
 * Number of oldest retained occurrences to offload before the request count
 * fits. This check reads no attachment version: it gives every occurrence a
 * one-byte length, so only the count budget can trigger. The adapter uses it
 * before any image read, and it uses the exact byte budget after the reads.
 */
export function requiredRequestImageCountOffload(messages: readonly RequestMessage[]): number {
  return requiredImageOffload(messages, IMAGE_REQUEST_BUDGET, () => 1)
}

/**
 * Count and encoded bytes of every image block in one native content list.
 * The byte count is the exact base64 string length that the request sends.
 */
export function imageContentStats(content: readonly NativeContentBlock[]): ImageContentStats {
  let count = 0
  let bytes = 0
  for (const block of content) {
    if (block.type !== 'image') continue
    count += 1
    bytes += block.data.length
  }
  return { count, bytes }
}

/** Add two image stats values. */
export function addImageContentStats(left: ImageContentStats, right: ImageContentStats): ImageContentStats {
  return { count: left.count + right.count, bytes: left.bytes + right.bytes }
}

/**
 * True when one more native turn would put the live generation above its
 * documented conservative image threshold.
 */
export function exceedsGenerationImageLimit(
  retained: ImageContentStats,
  added: ImageContentStats,
): boolean {
  return retained.count + added.count > IMAGE_GENERATION_MAX_IMAGES
    || retained.bytes + added.bytes > IMAGE_GENERATION_MAX_BYTES
}

/**
 * Raw request-version byte length of each attachment id already read. The
 * budget uses the exact sent version size when it is known.
 */
const requestVersionBytes = new Map<string, number>()

/** Remember the exact request-version byte length of one retained image. */
export function rememberRequestVersionBytes(attachment: ImageAttachmentRef, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return
  requestVersionBytes.set(String(attachment.attachmentId), bytes)
}

/** Drop the size cache. Tests use this function; production has no caller. */
export function clearRequestVersionBytesCache(): void {
  requestVersionBytes.clear()
}

/**
 * Raw request-version byte length for the budget helper. An occurrence that
 * this process has not read yet uses its durable file byte size as a
 * deterministic estimate. `requiredImageOffload` then applies the base64
 * expansion. The exact version size replaces the estimate after the first read.
 */
function requestVersionBytesForBudget(attachment: ImageAttachmentRef): number {
  return requestVersionBytes.get(String(attachment.attachmentId)) ?? attachment.bytes
}

/**
 * Number of oldest retained image occurrences that dsh must offload before
 * this request fits the route image budget. Zero means the request fits.
 */
export function requiredRequestImageOffload(messages: readonly RequestMessage[]): number {
  return requiredImageOffload(messages, IMAGE_REQUEST_BUDGET, (block) => {
    return requestVersionBytesForBudget(block.attachment)
  })
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
