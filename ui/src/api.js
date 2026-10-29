import { useCallback, useEffect, useRef, useState } from 'react'

const base = ''

/* ---- command bus: every command the backend ran stays visible in the UI ---- */
const _cmds = new Map()          // route -> [commands]
const _listeners = new Set()
// stable snapshot: useSyncExternalStore needs the SAME reference while nothing
// changes, otherwise React re-renders in a loop
let _snap = []
const notify = () => { _snap = [..._cmds.entries()]; _listeners.forEach((f) => f()) }

export function registerCmds(route, list) {
  if (!list?.length) return
  const before = _cmds.get(route)
  if (before && before.join('\n') === list.join('\n')) return
  _cmds.set(route, list)
  notify()
}
export function subscribeCmds(f) { _listeners.add(f); return () => _listeners.delete(f) }
export function readCmds() { return _snap }
export function clearCmds() { _cmds.clear(); notify() }

/** Builds the query string, dropping empty values. */
export function buildQuery(params = {}) {
  return new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString()
}

/** Turns a parsed answer into an exception when it carries {error, hint}. */
function raiseIfError(d, status) {
  if (d && d.error) {
    const e = new Error(d.error)
    e.hint = d.hint
    e.status = status
    throw e
  }
}

async function readJson(r) {
  try { return await r.json() } catch { return null }
}

export async function fetchJson(route, params = {}) {
  const r = await fetch(`${base}/api/${route}?${buildQuery(params)}`)
  const d = await readJson(r)
  if (d) registerCmds(route, d._cmds)
  raiseIfError(d, r.status)
  if (!r.ok || !d) throw new Error(`HTTP ${r.status}`)
  return d
}

export async function postJson(route, body) {
  const r = await fetch(`${base}/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const d = await readJson(r)
  if (d) registerCmds(route, d._cmds)
  raiseIfError(d, r.status)
  if (!r.ok || !d) throw new Error(`HTTP ${r.status}`)
  return d
}

/** Fetch with optional auto-refresh. Returns {data, error, loading, reload}. */
export function useApi(route, params = {}, { interval = 0, enabled = true } = {}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(enabled)
  const key = JSON.stringify([route, params])
  const mounted = useRef(true)

  const load = useCallback(async (silent = false) => {
    if (!enabled) return
    if (!silent) setLoading(true)
    try {
      const d = await fetchJson(route, params)
      if (!mounted.current) return
      setData(d)
      setError(null)
    } catch (e) {
      if (!mounted.current) return
      setError(e)
    } finally {
      if (mounted.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  useEffect(() => {
    mounted.current = true
    load()
    return () => { mounted.current = false }
  }, [load])

  useEffect(() => {
    if (!interval || !enabled) return
    const timer = setInterval(() => load(true), interval)
    return () => clearInterval(timer)
  }, [interval, load, enabled])

  return { data, error, loading, reload: () => load(true) }
}

/** Sorts a list by column, toggling asc/desc. */
export function useSort(initial, initialDir = 'asc') {
  const [col, setCol] = useState(initial)
  const [dir, setDir] = useState(initialDir)
  const sortBy = (c) => {
    if (c === col) setDir(dir === 'asc' ? 'desc' : 'asc')
    else { setCol(c); setDir('asc') }
  }
  const apply = (list) => sortList(list, col, dir)
  return { col, dir, sortBy, apply }
}

export function sortList(list, col, dir = 'asc') {
  if (!col) return list
  const s = [...list].sort((a, b) => {
    const x = a[col], y = b[col]
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true })
  })
  return dir === 'asc' ? s : s.reverse()
}

export const filterText = (list, term, fields) => {
  if (!term) return list
  const needle = term.toLowerCase()
  return list.filter((o) => fields.some((c) => String(o[c] ?? '').toLowerCase().includes(needle)))
}
