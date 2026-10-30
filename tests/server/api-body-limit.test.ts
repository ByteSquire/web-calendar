// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { API_MAX_BODY_BYTES, apiBodyProblem } from '../../server/utils/api/body-limit'

const headers = (init: Record<string, string>) => new Headers(init)

describe('apiBodyProblem', () => {
  it('lets requests without a body through', () => {
    expect(apiBodyProblem('GET', headers({}))).toBeNull()
    expect(apiBodyProblem('DELETE', headers({}))).toBeNull()
    expect(apiBodyProblem('POST', headers({}))).toBeNull()
    expect(apiBodyProblem('GET', headers({ 'content-length': '999999999' }))).toBeNull()
  })

  it('accepts bodies up to the limit', () => {
    expect(apiBodyProblem('POST', headers({ 'content-length': '0' }))).toBeNull()
    expect(
      apiBodyProblem('PUT', headers({ 'content-length': String(API_MAX_BODY_BYTES) })),
    ).toBeNull()
  })

  it('refuses bodies over the limit', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'post']) {
      expect(
        apiBodyProblem(method, headers({ 'content-length': String(API_MAX_BODY_BYTES + 1) })),
      ).toEqual({ status: 413, message: 'Payload Too Large' })
    }
  })

  it('refuses a chunked body, which has no announced size', () => {
    expect(apiBodyProblem('POST', headers({ 'transfer-encoding': 'chunked' }))?.status).toBe(411)
    expect(apiBodyProblem('PUT', headers({ 'transfer-encoding': 'gzip, chunked' }))?.status).toBe(
      411,
    )
  })

  it('refuses a Content-Length that is not a plain number', () => {
    for (const value of ['abc', '-1', '1e6', '12 34', '0x10', '1'.repeat(13)]) {
      expect(apiBodyProblem('POST', headers({ 'content-length': value }))?.status).toBe(400)
    }
  })
})
