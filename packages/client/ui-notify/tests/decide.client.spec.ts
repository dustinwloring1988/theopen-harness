/** The pure notification gate: mode/focus/quiet/permission/dedupe decisions
 *  and the quiet-window clock math. Node-env, no DOM. */
import { describe, expect, it } from 'vitest'
import {
  isWithinQuietHours, parseQuietTime, shouldNotify, shouldRequestPermission,
} from '../src/client/decide.ts'

const base = {
  mode: 'on', focused: false, quiet: false,
  permission: 'granted', duplicate: false,
} as const

describe('shouldNotify', () => {
  it('notifies a granted, unfocused, awake, fresh event in on mode', () => {
    expect(shouldNotify(base)).toBe(true)
  })

  it('never notifies in off mode, whatever else holds', () => {
    expect(shouldNotify({ ...base, mode: 'off' })).toBe(false)
  })

  it('suppresses while the document has focus', () => {
    expect(shouldNotify({ ...base, focused: true })).toBe(false)
  })

  it('suppresses inside quiet hours even for approvals', () => {
    expect(shouldNotify({ ...base, quiet: true })).toBe(false)
  })

  it('suppresses duplicate arcs without consuming anything else', () => {
    expect(shouldNotify({ ...base, duplicate: true })).toBe(false)
  })

  it('waits for an explicit grant: default and denied never raise', () => {
    expect(shouldNotify({ ...base, permission: 'default' })).toBe(false)
    expect(shouldNotify({ ...base, permission: 'denied' })).toBe(false)
    expect(shouldNotify({ ...base, permission: 'unsupported' })).toBe(false)
  })
})

describe('shouldRequestPermission', () => {
  it('asks once per page on a qualifying event while unanswered', () => {
    expect(shouldRequestPermission('ask', 'default')).toBe(true)
    expect(shouldRequestPermission('on', 'default')).toBe(true)
  })

  it('never asks when answered, disabled, or unsupported', () => {
    expect(shouldRequestPermission('ask', 'granted')).toBe(false)
    expect(shouldRequestPermission('ask', 'denied')).toBe(false)
    expect(shouldRequestPermission('ask', 'unsupported')).toBe(false)
    expect(shouldRequestPermission('off', 'default')).toBe(false)
  })
})

describe('parseQuietTime', () => {
  it('accepts 24-hour HH:MM and rejects everything else', () => {
    expect(parseQuietTime('22:00')).toBe(22 * 60)
    expect(parseQuietTime('00:30')).toBe(30)
    expect(parseQuietTime('23:59')).toBe(23 * 60 + 59)
    expect(parseQuietTime('24:00')).toBeUndefined()
    expect(parseQuietTime('7:00')).toBeUndefined()
    expect(parseQuietTime('07:60')).toBeUndefined()
    expect(parseQuietTime('abc')).toBeUndefined()
    expect(parseQuietTime(undefined)).toBeUndefined()
  })
})

describe('isWithinQuietHours', () => {
  it('is off entirely when either bound is missing or malformed', () => {
    expect(isWithinQuietHours(600, '', '')).toBe(false)
    expect(isWithinQuietHours(600, '22:00', undefined)).toBe(false)
    expect(isWithinQuietHours(600, 'bad', '23:00')).toBe(false)
    expect(isWithinQuietHours(600, '22:00', 'nope')).toBe(false)
  })

  it('treats an equal start and end as no window', () => {
    expect(isWithinQuietHours(600, '10:00', '10:00')).toBe(false)
    expect(isWithinQuietHours(1320, '22:00', '22:00')).toBe(false)
  })

  it('covers a same-day window inclusively at the start, exclusively at the end', () => {
    expect(isWithinQuietHours(13 * 60, '12:00', '14:00')).toBe(true)
    expect(isWithinQuietHours(12 * 60 + 30, '12:00', '14:00')).toBe(true)
    expect(isWithinQuietHours(11 * 60 + 59, '12:00', '14:00')).toBe(false)
    expect(isWithinQuietHours(14 * 60, '12:00', '14:00')).toBe(false)
  })

  it('wraps midnight windows around the day boundary', () => {
    expect(isWithinQuietHours(23 * 60, '22:00', '07:00')).toBe(true)
    expect(isWithinQuietHours(3 * 60, '22:00', '07:00')).toBe(true)
    expect(isWithinQuietHours(6 * 60 + 59, '22:00', '07:00')).toBe(true)
    expect(isWithinQuietHours(7 * 60, '22:00', '07:00')).toBe(false)
    expect(isWithinQuietHours(12 * 60, '22:00', '07:00')).toBe(false)
  })
})
