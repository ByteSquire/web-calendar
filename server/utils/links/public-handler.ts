// The frame of the two public routes of a calendar link (no sign-in): nothing is cached or indexed,
// and the errors of the link service become the few answers a visitor may get. Never
// `defineApiHandler`, which would ask for a bearer token.
import {
  createError,
  defineEventHandler,
  setResponseHeader,
  type EventHandler,
  type H3Event,
} from 'h3'
import { ApiError } from '../api/errors'
import { PasswordBusyError } from './password'
import { LinkUnavailableError, ReadsBusyError, SessionError, WrongPasswordError } from './service'

export function tooMany(event: H3Event, waitSec: number): never {
  setResponseHeader(event, 'retry-after', waitSec)
  throw createError({
    statusCode: 429,
    statusMessage: 'Too Many Requests',
    message: 'Too many tries; wait a little and try again',
  })
}

export function definePublicLinkHandler<T>(handler: (event: H3Event) => Promise<T>): EventHandler {
  return defineEventHandler(async (event) => {
    setResponseHeader(event, 'cache-control', 'no-store')
    setResponseHeader(event, 'x-robots-tag', 'noindex, nofollow')
    try {
      return await handler(event)
    } catch (error) {
      if (error instanceof LinkUnavailableError) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Not Found',
          message: error.message,
          data: { code: 'unavailable' },
        })
      }
      if (error instanceof WrongPasswordError) {
        throw createError({
          statusCode: 401,
          statusMessage: 'Unauthorized',
          message: error.message,
          data: { code: 'wrong_password' },
        })
      }
      if (error instanceof SessionError) {
        throw createError({
          statusCode: 401,
          statusMessage: 'Unauthorized',
          message: error.message,
          data: { code: 'session' },
        })
      }
      if (error instanceof PasswordBusyError || error instanceof ReadsBusyError) {
        setResponseHeader(event, 'retry-after', 2)
        throw createError({
          statusCode: 429,
          statusMessage: 'Too Many Requests',
          message: error.message,
        })
      }
      if (error instanceof ApiError) {
        throw createError({
          statusCode: error.statusCode,
          statusMessage: 'Error',
          message: error.message,
        })
      }
      throw error
    }
  })
}
