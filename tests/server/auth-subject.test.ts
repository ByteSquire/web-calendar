// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isReservedPrincipal, isUserSubject, isValidSubject } from '../../server/utils/auth/subject'
import { parseSharedOwners } from '../../server/utils/sharing/config'
import { groupPrincipal } from '../../server/utils/sharing/names'
import { RESOURCES_PRINCIPAL } from '../../server/utils/sharing/types'

// The shape rule comes from probing Radicale 3.9.0: what it accepts as a user id, a path component,
// `X-Remote-User`, an htgroup member and a sharing map entry.

describe('isValidSubject', () => {
  it.each([
    '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
    'ABC123',
    'abc123',
    '00u1AbCdEfGhIjKlMnOp',
    'auth0|5f7c8ec7c33c6c004bbafe82',
    'google-oauth2|103547991597142817347',
    'alice@example.org',
    'Alice@Example.ORG',
    'u+1',
    'a=b',
    'a.b',
    'a~b',
    'a-b_c',
    '_resources',
    '-1',
    '~x',
    '|x',
    'x'.repeat(255),
  ])('accepts %j', (sub) => {
    expect(isValidSubject(sub)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['a space', 'a b'],
    ['a tab', 'a\tb'],
    ['a newline', 'a\nb'],
    ['non-ASCII', 'ü'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['the htgroup separator', 'a:b'],
    ['a single quote', "a'b"],
    ['a double quote', 'a"b'],
    ['a star', 'a*b'],
    ['a question mark', 'a?b'],
    ['a comma', 'a,b'],
    ['two @', 'a@b@c'],
    ['a leading @', '@x'],
    ['a trailing @', 'x@'],
    ['a leading dot', '.x'],
    ['a dot name', '..'],
    ['a trailing tilde', 'x~'],
    ['256 characters', 'x'.repeat(256)],
  ])('refuses %s', (_label, sub) => {
    expect(isValidSubject(sub)).toBe(false)
  })

  it('refuses what is not a string', () => {
    for (const value of [undefined, null, 1, {}, ['a']]) expect(isValidSubject(value)).toBe(false)
  })
})

describe('the app’s own principals', () => {
  const owners = parseSharedOwners('_team, _other, _resources, bad name')

  it('are valid ids for the app to act as, and never ids of a person', () => {
    expect(owners).toEqual(['_other', '_team'])
    const principals = [
      RESOURCES_PRINCIPAL,
      groupPrincipal(1),
      groupPrincipal(999_999_999_999_999),
      ...owners,
    ]
    for (const principal of principals) {
      expect(isValidSubject(principal), principal).toBe(true)
      expect(isReservedPrincipal(principal, owners), principal).toBe(true)
      expect(isUserSubject(principal, owners), principal).toBe(false)
    }
  })

  it('reserve the whole _group- prefix, and a shared owner only when it is configured', () => {
    expect(isReservedPrincipal('_group-', [])).toBe(true)
    expect(isReservedPrincipal('_group-abc', [])).toBe(true)
    expect(isReservedPrincipal('_team', [])).toBe(false)
    expect(isReservedPrincipal('_team', ['_team'])).toBe(true)
  })

  it('leave other ids that start with an underscore to people (Entra pairwise ids can)', () => {
    for (const sub of ['_Zx9', '_', '_group', '_resourcesX', '_Resources']) {
      expect(isUserSubject(sub, owners), sub).toBe(true)
    }
  })

  // The guard behind `isReservedPrincipal`: a principal the code can create must be covered above.
  // A new underscore name in the server code fails here until it is reserved or listed as not one.
  it('is complete: the server code names no other underscore principal', () => {
    const known = new Set(['_resources', '_group-'])
    const notPrincipals = new Set(['_attributes']) // an XML parser option
    const root = fileURLToPath(new URL('../../server', import.meta.url))
    const found = new Set<string>()
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|mjs)$/.test(name)) {
          for (const match of readFileSync(path, 'utf8').matchAll(/['"`](_[A-Za-z][\w-]*)/g)) {
            found.add(match[1]!.startsWith('_group-') ? '_group-' : match[1]!)
          }
        }
      }
    }
    walk(root)
    const unknown = [...found].filter((name) => !known.has(name) && !notPrincipals.has(name))
    expect(unknown).toEqual([])
    expect([...found]).toEqual(expect.arrayContaining([...known]))
  })
})
