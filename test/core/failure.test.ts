import { describe, expect, test } from 'vitest'
import { describeFailure, errorTextFor } from '../../src/core/failure.js'
import { OpenCodeHttpError, OpenCodeTimeoutError } from '../../src/runtime/opencode/client.js'

/**
 * Fixtures are the real failures stored for run 6eb22c7c on September 13: five W&B
 * agents rejected with this OpenCode 500 body, and two Muse Spark agents recorded only
 * "TypeError: fetch failed" because the transport cause was discarded.
 */
const BODY_500 =
  '{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_0672e772"}}'

const http500 = () =>
  new OpenCodeHttpError({ method: 'POST', path: '/session/ses_f65192857ffeBfnbedFN4MlzK7/message', status: 500, bodyText: BODY_500 })

const headersTimeout = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
  })

describe('describeFailure', () => {
  test('an OpenCode HTTP error keeps its status, error name and ref', () => {
    expect(describeFailure(http500())).toEqual({
      message: 'OpenCode returned HTTP 500 UnknownError (ref err_0672e772)',
      httpStatus: 500,
      code: 'UnknownError',
      ref: 'err_0672e772',
    })
  })

  test('a transport failure keeps its cause code instead of collapsing to "fetch failed"', () => {
    expect(describeFailure(headersTimeout())).toEqual({
      message: 'Transport failure: fetch failed (UND_ERR_HEADERS_TIMEOUT)',
      code: 'UND_ERR_HEADERS_TIMEOUT',
    })
  })

  test('the two failures from the incident are distinguishable', () => {
    const provider = describeFailure(http500())
    const transport = describeFailure(headersTimeout())
    expect(provider.httpStatus).toBe(500)
    expect(transport.httpStatus).toBeUndefined()
    expect(provider.code).not.toBe(transport.code)
  })

  test('our own request deadline is named as such', () => {
    expect(describeFailure(new OpenCodeTimeoutError(300_000, new Error('aborted')))).toEqual({
      message: 'OpenCode request exceeded 300000ms',
      code: 'OPENCODE_TIMEOUT',
    })
  })

  test('unsafe names and refs from a response body are not exposed as fields', () => {
    const hostile = new OpenCodeHttpError({
      method: 'POST', path: '/x', status: 502,
      bodyText: '{"name":"Unknown Error <script>","data":{"ref":"drop table runs"}}',
    })
    const f = describeFailure(hostile)
    expect(f.httpStatus).toBe(502)
    expect(f.code).toBeUndefined()
    expect(f.ref).toBeUndefined()
  })

  test('credentials in a URL never reach the public message', () => {
    const f = describeFailure(new Error('connect to http://user:s3cret@127.0.0.1:4096/session failed'))
    expect(f.message).not.toContain('s3cret')
    expect(f.message).not.toContain('user:')
  })

  test('the message is bounded', () => {
    expect(describeFailure(new Error('x'.repeat(5000))).message.length).toBeLessThanOrEqual(300)
  })
})

describe('errorTextFor', () => {
  test('the persisted text keeps the transport cause for reopened runs', () => {
    expect(errorTextFor(headersTimeout())).toBe('TypeError: fetch failed (cause UND_ERR_HEADERS_TIMEOUT)')
  })

  test('the persisted text keeps the OpenCode ref', () => {
    expect(errorTextFor(http500())).toContain('err_0672e772')
  })

  test('the persisted text is redacted and bounded', () => {
    const text = errorTextFor(new Error(`http://u:pw@h/${'y'.repeat(2000)}`))
    expect(text).not.toContain('pw@')
    expect(text.length).toBeLessThanOrEqual(500)
  })
})
