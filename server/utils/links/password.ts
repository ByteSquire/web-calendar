// The password of a calendar link: scrypt from node:crypto, a random salt per link, the parameters
// stored with the hash so they can be raised later. Checking a password is costly on purpose, and
// it happens on a route anybody can call, so the number of checks that run at once is capped: one
// more than the cap is refused at once (`PasswordBusyError`) instead of queueing up memory and time.
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 200
/** Checks (and hashes) that may run at once in this process. */
export const MAX_PARALLEL_CHECKS = 4

const COST_LOG2 = 15
const BLOCK_SIZE = 8
const PARALLEL = 1
const KEY_LENGTH = 32
const SALT_LENGTH = 16
/** scrypt needs 128 * N * r bytes; with N = 2^15 and r = 8 that is 32 MiB, so the limit is raised. */
const MAX_MEMORY = 64 * 1024 * 1024

export class PasswordBusyError extends Error {
  constructor() {
    super('Too many password checks are running; try again in a moment')
    this.name = 'PasswordBusyError'
  }
}

let running = 0

function derive(password: string, salt: Buffer, costLog2: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password.normalize('NFC'),
      salt,
      KEY_LENGTH,
      { N: 2 ** costLog2, r, p, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    )
  })
}

/** Runs `work` in one of the slots, or throws `PasswordBusyError` when all are taken. */
async function inSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL_CHECKS) throw new PasswordBusyError()
  running += 1
  try {
    return await work()
  } finally {
    running -= 1
  }
}

/** Whether a password may be set: the length only (any characters). Returns the problem or null. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'must be a string'
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `must have at least ${MIN_PASSWORD_LENGTH} characters`
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `must have at most ${MAX_PASSWORD_LENGTH} characters`
  }
  return null
}

/** `scrypt$<log2 N>$<r>$<p>$<salt>$<key>`, salt and key in base64url. */
export function hashPassword(password: string): Promise<string> {
  return inSlot(async () => {
    const salt = randomBytes(SALT_LENGTH)
    const key = await derive(password, salt, COST_LOG2, BLOCK_SIZE, PARALLEL)
    return `scrypt$${COST_LOG2}$${BLOCK_SIZE}$${PARALLEL}$${salt.toString('base64url')}$${key.toString('base64url')}`
  })
}

const STORED =
  /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{16,128})$/

/**
 * Whether `password` is the one of `stored`. A password that is too long is refused before any
 * work, and a stored value in another shape never matches.
 */
export function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return Promise.resolve(false)
  const parts = STORED.exec(stored)
  if (!parts) return Promise.resolve(false)
  const [, costLog2, r, p, salt, key] = parts
  const expected = Buffer.from(key!, 'base64url')
  // The stored parameters are ours, but a damaged row must not ask for a huge amount of memory.
  if (Number(costLog2) > 17 || Number(r) > 16 || Number(p) > 4 || expected.length !== KEY_LENGTH) {
    return Promise.resolve(false)
  }
  return inSlot(async () => {
    const actual = await derive(
      password,
      Buffer.from(salt!, 'base64url'),
      Number(costLog2),
      Number(r),
      Number(p),
    )
    return timingSafeEqual(actual, expected)
  })
}
