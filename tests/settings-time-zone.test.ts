import { describe, expect, it } from 'vitest'
import {
  BROWSER_CHOICE,
  describeZoneChange,
  searchText,
  timeZoneChoices,
  type TimeZoneChoicesInput,
} from '../app/utils/settings/time-zone'

const ZONES = ['Africa/Cairo', 'America/New_York', 'Asia/Calcutta', 'Europe/Berlin', 'Europe/Paris']

function choices(overrides: Partial<TimeZoneChoicesInput> = {}) {
  return timeZoneChoices({
    defaultZone: 'Europe/Berlin',
    orgZone: 'Europe/Paris',
    current: null,
    zones: ZONES,
    ...overrides,
  })
}

const values = (group: { value: string }[]) => group.map((item) => item.value)

describe('timeZoneChoices', () => {
  it("offers the browser's zone first and as the default, with its name", () => {
    const [defaults] = choices()
    expect(defaults).toEqual([
      {
        label: "Browser's zone (Europe/Berlin)",
        value: BROWSER_CHOICE,
        search: "Browser's zone (Europe/Berlin)",
      },
    ])
  })

  it('lists the zones in order and marks the organization zone', () => {
    const [, zones] = choices()
    expect(values(zones)).toEqual(ZONES)
    expect(zones.map((zone) => zone.label)).toEqual([
      'Africa/Cairo',
      'America/New_York',
      'Asia/Calcutta',
      'Europe/Berlin',
      'Europe/Paris (organization zone)',
    ])
  })

  it('adds the saved choice and the two named zones when the list lacks them', () => {
    const [, zones] = choices({
      zones: ['Africa/Cairo'],
      current: 'UTC',
      defaultZone: 'America/Lima',
      orgZone: 'Asia/Tokyo',
    })
    expect(values(zones)).toEqual(['Africa/Cairo', 'America/Lima', 'Asia/Tokyo', 'UTC'])
  })

  it('lists a zone once even when it is the choice, the default and the organization zone', () => {
    const [, zones] = choices({ current: 'Europe/Berlin', orgZone: 'Europe/Berlin' })
    expect(values(zones).filter((zone) => zone === 'Europe/Berlin')).toHaveLength(1)
  })

  it('works with the list of the runtime', () => {
    const [, zones] = choices({ zones: undefined })
    expect(zones.length).toBeGreaterThan(100)
    expect(values(zones)).toContain('Europe/Berlin')
    expect(values(zones)).toEqual([...values(zones)].sort())
  })
})

describe('searchText', () => {
  it('has the name and the name in words', () => {
    expect(searchText('America/New_York')).toBe('America/New_York America New York')
    expect(searchText('America/Argentina/Buenos_Aires')).toBe(
      'America/Argentina/Buenos_Aires America Argentina Buenos Aires',
    )
    expect(searchText('UTC')).toBe('UTC UTC')
  })
})

describe('describeZoneChange', () => {
  it('names the zone times are shown in now', () => {
    expect(describeZoneChange('Asia/Tokyo', 'Asia/Tokyo')).toBe(
      'Times are now shown in Asia/Tokyo.',
    )
  })

  it("says so when the browser's zone applies again", () => {
    expect(describeZoneChange(null, 'Europe/Berlin')).toBe(
      "Times are now shown in your browser's zone, Europe/Berlin.",
    )
  })
})
