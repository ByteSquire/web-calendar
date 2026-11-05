import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../app/utils/i18n'
import { principalLabel } from '../app/utils/principal-label'

// The fixed kinds of who a rule or share is for come from the server in English; the page words them.
describe('principalLabel', () => {
  afterEach(() => setLocale('en'))

  it('words the fixed kinds in the language of the page', () => {
    setLocale('de')
    expect(principalLabel('authenticated', 'Everyone signed in')).toBe('Alle Angemeldeten')
    expect(principalLabel('public', 'Public')).toBe('Öffentlich')
    expect(principalLabel('user', 'Unknown person')).toBe('Unbekannte Person')
  })

  it('keeps the names of people and groups as the server sends them', () => {
    setLocale('de')
    expect(principalLabel('user', 'Alice Example')).toBe('Alice Example')
    expect(principalLabel('group', 'staff')).toBe('staff')
    // a group may be called like a fixed kind; only a person can be unknown
    expect(principalLabel('group', 'Unknown person')).toBe('Unknown person')
  })

  it('is the English text in English', () => {
    expect(principalLabel('authenticated', 'ignored')).toBe('Everyone signed in')
  })
})
