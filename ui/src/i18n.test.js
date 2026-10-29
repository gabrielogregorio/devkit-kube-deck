import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PT_BR, t, detectLang, normalizeLang, format, setLang, getLang } from './i18n.js'

const SRC = dirname(fileURLToPath(import.meta.url))
const CALL = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g

/** every literal key passed to t('...') / t("...") in the source files */
function usedKeys() {
  const keys = new Map()
  for (const file of readdirSync(SRC)) {
    if (!/\.(jsx?|mjs)$/.test(file) || file.includes('.test.') || file === 'i18n.js') continue
    const text = readFileSync(join(SRC, file), 'utf8')
    for (const m of text.matchAll(CALL)) keys.set(m[2], file)
  }
  return keys
}

/** a fake Storage, optionally one that throws like a blocked browser */
const storage = (value, broken = false) => ({
  getItem: () => { if (broken) throw new Error('blocked'); return value },
})

describe('translations', () => {
  const used = usedKeys()

  it('finds the t() calls in the source', () => {
    expect(used.size).toBeGreaterThan(100)
  })

  it('has a pt-BR entry for every key used in the source', () => {
    const missing = [...used.keys()].filter((k) => !(k in PT_BR)).map((k) => `${used.get(k)}: ${k}`)
    expect(missing).toEqual([])
  })

  it('has no orphan pt-BR keys', () => {
    const orphans = Object.keys(PT_BR).filter((k) => !used.has(k))
    expect(orphans).toEqual([])
  })

  it('keeps the same placeholders in both languages', () => {
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
    const wrong = Object.entries(PT_BR).filter(([k, v]) => vars(k) !== vars(v)).map(([k]) => k)
    expect(wrong).toEqual([])
  })

  it('has no empty translation and no em dash', () => {
    const bad = Object.entries(PT_BR).filter(([, v]) => !v.trim() || v.includes('—')).map(([k]) => k)
    expect(bad).toEqual([])
  })
})

describe('detectLang', () => {
  it('prefers ?lang= over everything else', () => {
    expect(detectLang({ search: '?lang=pt-BR', storage: storage('en'), navigatorLanguage: 'en-US' })).toBe('pt-BR')
    expect(detectLang({ search: '?lang=en', storage: storage('pt-BR'), navigatorLanguage: 'pt-BR' })).toBe('en')
  })

  it('falls back to localStorage, then navigator.language', () => {
    expect(detectLang({ search: '', storage: storage('pt-BR'), navigatorLanguage: 'en-US' })).toBe('pt-BR')
    expect(detectLang({ search: '', storage: storage(null), navigatorLanguage: 'pt-PT' })).toBe('pt-BR')
    expect(detectLang({ search: '', storage: storage(null), navigatorLanguage: 'de-DE' })).toBe('en')
  })

  it('ignores unknown values and a storage that throws', () => {
    expect(detectLang({ search: '?lang=xx', storage: storage(null, true), navigatorLanguage: 'pt' })).toBe('pt-BR')
    expect(detectLang({})).toBe('en')
  })

  it('normalizes tags', () => {
    expect(normalizeLang('PT_br')).toBe('pt-BR')
    expect(normalizeLang('en-GB')).toBe('en')
    expect(normalizeLang('fr')).toBe('')
  })
})

describe('t / format', () => {
  const start = getLang()
  afterEach(() => setLang(start))

  it('interpolates variables and keeps unknown placeholders', () => {
    expect(format('{a} of {b}', { a: 1, b: 2 })).toBe('1 of 2')
    expect(format('{a} of {b}', { a: 1 })).toBe('1 of {b}')
  })

  it('returns English by default and pt-BR when selected', () => {
    setLang('en')
    expect(t('{a} of {b}', { a: 3, b: 9 })).toBe('3 of 9')
    setLang('pt-BR')
    expect(t('{a} of {b}', { a: 3, b: 9 })).toBe('3 de 9')
    expect(t('a key with no translation')).toBe('a key with no translation')
  })
})
