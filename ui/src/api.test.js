import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchJson, postJson, buildQuery, registerCmds, readCmds, clearCmds, subscribeCmds,
  sortList, filterText,
} from './api.js'

const answer = (body, { ok = true, status = 200 } = {}) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body) })

describe('fetchJson / postJson', () => {
  beforeEach(() => { clearCmds() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('builds the URL with only the non-empty params', async () => {
    const fetch = vi.fn(() => answer({ pods: [] }))
    vi.stubGlobal('fetch', fetch)
    await fetchJson('pods', { ctx: 'my-cluster-prod', ns: '*', name: '', container: null, tail: undefined })
    expect(fetch).toHaveBeenCalledWith('/api/pods?ctx=my-cluster-prod&ns=*')
  })

  it('throws with .hint when the server answers {error, hint}', async () => {
    vi.stubGlobal('fetch', vi.fn(() => answer({ error: 'Forbidden', hint: 'ask for list pods' }, { ok: false, status: 403 })))
    const err = await fetchJson('pods', {}).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('Forbidden')
    expect(err.hint).toBe('ask for list pods')
    expect(err.status).toBe(403)
  })

  it('throws on {error} even with HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn(() => answer({ error: 'token expired' })))
    await expect(fetchJson('overview', {})).rejects.toThrow('token expired')
  })

  it('throws HTTP status when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('x')) })))
    await expect(fetchJson('overview', {})).rejects.toThrow('HTTP 502')
  })

  it('registers the _cmds of the answer under the route', async () => {
    vi.stubGlobal('fetch', vi.fn(() => answer({ pods: [], _cmds: ['kubectl get pods -A -o json'] })))
    await fetchJson('pods', {})
    expect(readCmds()).toEqual([['pods', ['kubectl get pods -A -o json']]])
  })

  it('posts JSON and throws with .hint on error', async () => {
    const fetch = vi.fn(() => answer({ error: 'bad profile', hint: 'use my-profile' }, { ok: false, status: 400 }))
    vi.stubGlobal('fetch', fetch)
    const err = await postJson('aws/link', { context: 'c', profile: 'p' }).catch((e) => e)
    expect(err.hint).toBe('use my-profile')
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('/api/aws/link')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ context: 'c', profile: 'p' })
  })
})

describe('command registry', () => {
  beforeEach(() => { clearCmds() })

  it('ignores empty lists and notifies only on real changes', () => {
    const listener = vi.fn()
    const off = subscribeCmds(listener)
    registerCmds('pods', [])
    registerCmds('pods', undefined)
    expect(listener).not.toHaveBeenCalled()
    registerCmds('pods', ['kubectl get pods'])
    registerCmds('pods', ['kubectl get pods'])
    expect(listener).toHaveBeenCalledTimes(1)
    const snap = readCmds()
    expect(readCmds()).toBe(snap)           // stable snapshot for useSyncExternalStore
    registerCmds('events', ['kubectl get events'])
    expect(readCmds()).not.toBe(snap)
    expect(readCmds().map(([r]) => r)).toEqual(['pods', 'events'])
    off()
    clearCmds()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(readCmds()).toEqual([])
  })
})

describe('pure helpers', () => {
  it('buildQuery drops empty values', () => {
    expect(buildQuery({ a: 1, b: '', c: null, d: undefined, e: 0 })).toBe('a=1&e=0')
  })

  it('sortList sorts numbers and natural strings, both directions', () => {
    const rows = [{ n: 10, s: 'pod-10' }, { n: 2, s: 'pod-2' }, { n: 33, s: 'pod-1' }]
    expect(sortList(rows, 'n').map((r) => r.n)).toEqual([2, 10, 33])
    expect(sortList(rows, 's', 'desc').map((r) => r.s)).toEqual(['pod-10', 'pod-2', 'pod-1'])
    expect(sortList(rows, null)).toBe(rows)
  })

  it('filterText matches any field, case insensitive', () => {
    const rows = [{ name: 'API', ns: 'default' }, { name: 'worker', ns: 'jobs' }]
    expect(filterText(rows, 'api', ['name'])).toEqual([rows[0]])
    expect(filterText(rows, 'JOBS', ['name', 'ns'])).toEqual([rows[1]])
    expect(filterText(rows, '', ['name'])).toBe(rows)
  })
})
