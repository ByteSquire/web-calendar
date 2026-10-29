export class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large')
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Passes the stream through and errors it with `BodyTooLargeError` once it exceeds `max` bytes;
 * `onExceeded` tells the caller why a request that reads the stream failed.
 */
export function limitStream(
  stream: ReadableStream<Uint8Array>,
  max: number,
  onExceeded: () => void,
): ReadableStream<Uint8Array> {
  let seen = 0
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > max) {
          onExceeded()
          controller.error(new BodyTooLargeError())
        } else {
          controller.enqueue(chunk)
        }
      },
    }),
  )
}

/** Reads the whole stream, up to `max` bytes. */
export async function readLimited(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > max) {
      await reader.cancel().catch(() => undefined)
      throw new BodyTooLargeError()
    }
    chunks.push(value)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}
