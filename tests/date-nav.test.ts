import { describe, expect, it } from 'vitest'
import { dateStepLabel } from '../app/utils/date-nav'

describe('dateStepLabel', () => {
  it('names the period the button steps over', () => {
    expect(dateStepLabel('previous', 'day')).toBe('Previous day')
    expect(dateStepLabel('next', '5day')).toBe('Next 5 days')
    expect(dateStepLabel('previous', 'week')).toBe('Previous week')
    expect(dateStepLabel('next', 'month')).toBe('Next month')
    expect(dateStepLabel('next', 'year')).toBe('Next year')
  })
})
