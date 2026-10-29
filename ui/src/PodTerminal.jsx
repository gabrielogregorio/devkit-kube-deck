import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { t } from './i18n'

/* =======================================================================
   Shell inside the pod.

   This is the only thing in Kube Deck that runs a process inside a cluster
   (kubectl exec). It is available on any cluster, but it always asks first:
   a confirm dialog comes up and only then the WebSocket opens, with
   confirm=1. The server answers 403 without that flag, so the two layers are
   independent.

   Right click works like the Ubuntu terminal:
     - with selected text  -> copy
     - without selection   -> paste
   Ctrl+Shift+C / Ctrl+Shift+V too, and Ctrl+C is still SIGINT.
   ======================================================================= */
const THEME = {
  background: '#0d1117', foreground: '#c9d1d9', cursor: '#38bdf8',
  cursorAccent: '#0d1117', selectionBackground: 'rgba(56,189,248,.28)',
  black: '#484f58', red: '#f85149', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#56d364',
  brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
}

/** Builds the WebSocket query. confirm=1 is only sent after the user said yes. */
export function terminalQuery({ ctx, ns, pod, container, confirmed }) {
  const q = new URLSearchParams({ ns, pod })
  if (ctx) q.set('ctx', ctx)
  if (container) q.set('container', container)
  if (confirmed) q.set('confirm', '1')
  return q
}

export function ConfirmShell({ ctx, ns, pod, onCancel, onConfirm }) {
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onCancel])
  return (
    <>
      <div className="backdrop" style={{ zIndex: 42 }} onClick={onCancel} />
      <div className="modal confirm" role="dialog" aria-modal="true" style={{ zIndex: 43 }}>
        <header><h2>{t('Open a shell?')}</h2></header>
        <div className="modal-body">
          <p style={{ marginTop: 0 }}>
            {t('Open a shell in {ns}/{pod} on {context}? This runs a process inside the cluster.',
              { ns, pod, context: ctx || t('the current context') })}
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={onCancel}>{t('Cancel')}</button>
            <button className="btn active" autoFocus onClick={onConfirm}>{t('Open shell')}</button>
          </div>
        </div>
      </div>
    </>
  )
}

export function PodTerminal({ ctx, ns, pod, containers = [] }) {
  const host = useRef(null)
  const wsRef = useRef(null)
  const [container, setContainer] = useState(containers.length === 1 ? containers[0] : '')
  const [state, setState] = useState('connecting')   // connecting | open | closed | error
  const [reason, setReason] = useState('')
  // every new connection asks again: changing container or reconnecting
  const [asking, setAsking] = useState(true)
  const [confirmed, setConfirmed] = useState(false)

  const askAgain = () => { setConfirmed(false); setAsking(true) }

  useEffect(() => {
    if (!confirmed || !host.current) return
    let dead = false
    const el = host.current

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13, cursorBlink: true, scrollback: 5000,
      allowProposedApi: true, theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)

    const resize = () => {
      try { fit.fit() } catch { /* the panel may be hidden */ }
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    setTimeout(resize, 30)

    const q = terminalQuery({ ctx, ns, pod, container, confirmed: true })
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let ws
    try {
      ws = new WebSocket(`${proto}://${location.host}/api/terminal?${q}`)
    } catch (e) {
      setState('error'); setReason(e.message)
      return () => { ro.disconnect(); term.dispose() }
    }
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => { if (!dead) { setState('open'); resize(); term.focus() } }
    ws.onmessage = (ev) => {
      if (dead) return
      term.write(ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data)
    }
    ws.onclose = () => { if (!dead) setState('closed') }
    ws.onerror = () => {
      if (dead) return
      // the backend may refuse before the upgrade (RBAC, missing confirm); the
      // browser only says "error", so fetch the real reason over HTTP
      fetch(`/api/terminal?${q}`).then((r) => r.json())
        .then((d) => { setState('error'); setReason(d?.hint ? `${d.error} - ${d.hint}` : d?.error || t('connection refused')) })
        .catch(() => { setState('error'); setReason(t('connection refused')) })
    }

    const send = (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data))
    }
    term.onData(send)

    // ---- copy/paste like the Ubuntu terminal ----
    const paste = async () => {
      try {
        const text = await navigator.clipboard.readText()
        if (text) send(text)
      } catch {
        term.write(`\r\n\x1b[33m[${t('the browser denied clipboard access; use ctrl+shift+v')}]\x1b[0m\r\n`)
      }
    }
    const copy = async () => {
      const s = term.getSelection()
      if (s) { try { await navigator.clipboard.writeText(s) } catch { /* no permission */ } }
    }
    const menu = (e) => {
      e.preventDefault()
      if (term.hasSelection()) { copy(); term.clearSelection() } else { paste() }
    }
    el.addEventListener('contextmenu', menu)

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') { copy(); return false }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') { paste(); return false }
      return true
    })

    return () => {
      dead = true
      el.removeEventListener('contextmenu', menu)
      ro.disconnect()
      try { ws.close() } catch { /* already closed */ }
      term.dispose()
      wsRef.current = null
    }
  }, [ctx, ns, pod, container, confirmed])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 380 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px',
                    borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('container')}</span>
        <select className="field" value={container} disabled={containers.length < 2}
                onChange={(e) => { setContainer(e.target.value); askAgain() }}>
          {containers.length !== 1 && <option value="">{t('(the first one)')}</option>}
          {containers.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {confirmed && <StateBadge state={state} />}
        <span className="spacer" style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {t('right click: copies if there is a selection, otherwise pastes')}
        </span>
        <button className="btn" onClick={() => { setState('connecting'); askAgain() }}>
          {confirmed ? t('reconnect') : t('Open shell')}
        </button>
      </div>

      {!confirmed && !asking && (
        <div className="notice info" style={{ margin: '10px 12px 0' }}>
          <h3>{t('Shell not opened')}</h3>
          <p>{t('Nothing ran inside the cluster. Use "Open shell" when you want one.')}</p>
        </div>
      )}
      {confirmed && state === 'error' && (
        <div className="notice" style={{ margin: '10px 12px 0' }}>
          <h3>{t('Did not open')}</h3><p>{reason}</p>
        </div>
      )}
      {confirmed && state === 'closed' && (
        <div style={{ padding: '8px 12px', color: 'var(--muted)', fontSize: 12 }}>
          {t('session ended - "reconnect" opens another one.')}
        </div>
      )}

      {confirmed && (
        <div ref={host} style={{ flex: 1, minHeight: 320, padding: 6, background: THEME.background }} />
      )}

      {asking && (
        <ConfirmShell ctx={ctx} ns={ns} pod={pod}
                      onCancel={() => setAsking(false)}
                      onConfirm={() => { setAsking(false); setState('connecting'); setConfirmed(true) }} />
      )}
    </div>
  )
}

function StateBadge({ state }) {
  const m = {
    connecting: ['neutral', t('connecting...')], open: ['ok', t('connected')],
    closed: ['neutral', t('ended')], error: ['bad', t('error')],
  }[state] || ['neutral', state]
  return <span className={`badge ${m[0]}`}>{m[1]}</span>
}
