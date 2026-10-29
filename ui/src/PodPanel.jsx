import { useEffect, useRef, useState } from 'react'
import { PodTerminal } from './PodTerminal'
import { useApi, fetchJson, registerCmds } from './api'
import { Badge, stateBadge, Loading, ErrorBox, relativeTime } from './ui'
import { t } from './i18n'

/* ---------------------------------------------------------------- logs */
function Logs({ ctx, ns, pod, containers }) {
  const [lines, setLines] = useState([])
  const [container, setContainer] = useState(containers?.length === 1 ? containers[0] : '')
  const [follow, setFollow] = useState(true)
  const [previous, setPrevious] = useState(false)
  const [filter, setFilter] = useState('')
  const [tail, setTail] = useState(300)
  const [connected, setConnected] = useState(false)
  const [cmd, setCmd] = useState('')
  const box = useRef(null)

  useEffect(() => {
    setLines([])
    setConnected(false)
    const q = new URLSearchParams({ ns, name: pod, tail: String(tail) })
    if (ctx) q.set('ctx', ctx)
    if (container) q.set('container', container)
    if (previous) q.set('previous', '1')
    const es = new EventSource(`/api/logs?${q}`)
    es.onopen = () => setConnected(true)
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data)
        if (d.cmd) { setCmd(d.cmd); registerCmds('logs', [d.cmd]); return }
        if (d.line === undefined) return
        setLines((prev) => (prev.length > 5000 ? [...prev.slice(-4000), d.line] : [...prev, d.line]))
      } catch { /* skip malformed line */ }
    }
    es.onerror = () => { setConnected(false); es.close() }
    return () => { es.close() }
  }, [ctx, ns, pod, container, previous, tail])

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [lines, follow])

  const visible = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines

  const lineClass = (l) => {
    const low = l.toLowerCase()
    if (/\b(error|fatal|exception|traceback|panic|critical)\b/.test(low)) return 'line log-error'
    if (/\b(warn|warning|deprecated)\b/.test(low)) return 'line log-warn'
    return 'line'
  }

  const highlight = (l) => {
    if (!filter) return l
    const i = l.toLowerCase().indexOf(filter.toLowerCase())
    if (i < 0) return l
    return <>{l.slice(0, i)}<mark>{l.slice(i, i + filter.length)}</mark>{l.slice(i + filter.length)}</>
  }

  return (
    <>
      <div className="logs-bar">
        {containers?.length > 1 && (
          <select className="field" value={container} onChange={(e) => setContainer(e.target.value)}>
            <option value="">{t('all containers')}</option>
            {containers.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <select className="field" value={tail} onChange={(e) => setTail(Number(e.target.value))}>
          {[100, 300, 1000, 3000].map((n) => <option key={n} value={n}>{t('last {n}', { n })}</option>)}
        </select>
        <button className={`btn${follow ? ' active' : ''}`} onClick={() => setFollow(!follow)}>
          {follow ? t('following') : t('paused')}
        </button>
        <button className={`btn${previous ? ' active' : ''}`} onClick={() => setPrevious(!previous)}
                title={t('log of the previous container incarnation (--previous)')}>
          {t('previous')}
        </button>
        <input className="field" style={{ width: 200 }} placeholder={t('search the log...')}
               value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn" onClick={() => setLines([])}>{t('clear')}</button>
        <span className="spacer" />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {t('{n} lines', { n: visible.length })} · {connected ? t('live') : t('disconnected')}
        </span>
      </div>
      {cmd && (
        <div className="cmd-line" style={{ marginBottom: 8 }}>
          <code title={t('the command running right now')}>{cmd}</code>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(cmd)}>{t('copy')}</button>
        </div>
      )}
      <div className="logs-box" ref={box}
           onScroll={(e) => {
             const el = e.currentTarget
             if (el.scrollHeight - el.scrollTop - el.clientHeight > 60) setFollow(false)
           }}>
        {visible.length === 0
          ? <span style={{ color: 'var(--muted)' }}>
              {connected ? t('no output so far...') : t('connecting...')}
            </span>
          : visible.map((l, i) => <div key={i} className={lineClass(l)}>{highlight(l)}</div>)}
      </div>
    </>
  )
}

/* ---------------------------------------------------------------- panel */
export function PodPanel({ ctx, pod, onClose }) {
  const [tab, setTab] = useState('summary')
  const { data, error } = useApi('pod', { ctx, ns: pod.ns, name: pod.name }, { interval: 15000 })
  const [yaml, setYaml] = useState(null)
  const [descr, setDescr] = useState(null)

  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  useEffect(() => {
    if (tab === 'yaml' && !yaml) {
      fetchJson('yaml', { ctx, kind: 'pod', ns: pod.ns, name: pod.name })
        .then((d) => setYaml(JSON.stringify(d.object, null, 2)))
        .catch((e) => setYaml(`${t('error')}: ${e.message}`))
    }
    if (tab === 'describe' && !descr) {
      fetchJson('describe', { ctx, kind: 'pod', ns: pod.ns, name: pod.name })
        .then((d) => setDescr(d.text))
        .catch((e) => setDescr(`${t('error')}: ${e.message}`))
    }
  }, [tab, ctx, pod, yaml, descr])

  const p = data?.pod
  const r = data?.summary || pod
  const containers = p?.spec?.containers?.map((c) => c.name) || pod.containers || []
  const events = data?.events || []

  const tabs = [
    ['summary', t('Summary')], ['containers', t('Containers')], ['logs', t('Logs')],
    ['events', events.length ? `${t('Events')} (${events.length})` : t('Events')],
    ['describe', 'Describe'], ['yaml', 'YAML'],
    ['terminal', t('Terminal')],
  ]

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <aside className="drawer">
        <header>
          <span className={`dot ${r.ok ? 'ok' : 'bad'}`} />
          <div style={{ minWidth: 0 }}>
            <h2>{pod.name}</h2>
            <div className="sub">{pod.ns} · {r.node}</div>
          </div>
          <span className="spacer" />
          <Badge kind={stateBadge(r.state, r.ok)}>{r.state}</Badge>
          <button className="btn" onClick={onClose}>{t('close (esc)')}</button>
        </header>

        <div className="tabs">
          {tabs.map(([k, label]) => (
            <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>

        <div className="panel-content">
          {error && <ErrorBox error={error} />}

          {tab === 'summary' && (!p ? <Loading /> : (
            <>
              <dl className="facts">
                <dt>namespace</dt><dd>{pod.ns}</dd>
                <dt>{t('node')}</dt><dd>{r.node}</dd>
                <dt>{t('pod ip')}</dt><dd>{r.ip}</dd>
                <dt>{t('phase')}</dt><dd>{r.phase}</dd>
                <dt>ready</dt><dd>{r.ready}/{r.total}</dd>
                <dt>restarts</dt><dd>{r.restarts}</dd>
                <dt>{t('created')}</dt><dd>{r.created} ({r.age})</dd>
                <dt>{t('controlled by')}</dt>
                <dd>{p.metadata?.ownerReferences?.[0]
                  ? `${p.metadata.ownerReferences[0].kind}/${p.metadata.ownerReferences[0].name}` : '-'}</dd>
                <dt>service account</dt><dd>{p.spec?.serviceAccountName || 'default'}</dd>
                <dt>qos</dt><dd>{p.status?.qosClass || '-'}</dd>
              </dl>

              <h3 style={{ fontSize: 13, color: 'var(--muted)' }}>Labels</h3>
              <div style={{ marginBottom: 18 }}>
                {Object.entries(p.metadata?.labels || {}).map(([k, v]) =>
                  <span className="chip" key={k}>{k}={v}</span>)}
              </div>

              <h3 style={{ fontSize: 13, color: 'var(--muted)' }}>Volumes</h3>
              <div>
                {(p.spec?.volumes || []).map((v) => {
                  const kind = Object.keys(v).find((k) => k !== 'name')
                  return <span className="chip" key={v.name}>{v.name} ({kind})</span>
                })}
              </div>

              <h3 style={{ fontSize: 13, color: 'var(--muted)', marginTop: 18 }}>{t('Equivalent commands')}</h3>
              <pre className="code">{[
                `kd info ${pod.name}`,
                `kd log ${pod.name}`,
                `kd sh ${pod.name}`,
                `kubectl -n ${pod.ns} port-forward pod/${pod.name} 8080:80`,
              ].join('\n')}</pre>
            </>
          ))}

          {tab === 'containers' && (!p ? <Loading /> : (
            <>
              {(p.spec?.containers || []).map((c) => {
                const st = (p.status?.containerStatuses || []).find((s) => s.name === c.name) || {}
                const state = Object.keys(st.state || {})[0] || '?'
                const reason = st.state?.[state]?.reason
                return (
                  <div key={c.name} className="block" style={{ marginBottom: 14 }}>
                    <header>
                      <span className={`dot ${st.ready ? 'ok' : 'bad'}`} />
                      <span className="mono">{c.name}</span>
                      <span className="spacer" />
                      <Badge kind={st.ready ? 'ok' : 'bad'}>{reason || state}</Badge>
                    </header>
                    <div style={{ padding: '12px 14px' }}>
                      <dl className="facts" style={{ marginBottom: 0 }}>
                        <dt>{t('image')}</dt><dd>{c.image}</dd>
                        <dt>imageID</dt><dd style={{ fontSize: 11 }}>{st.imageID || '-'}</dd>
                        <dt>restarts</dt><dd>{st.restartCount ?? 0}</dd>
                        <dt>{t('ports')}</dt><dd>{(c.ports || []).map((x) => x.containerPort).join(', ') || '-'}</dd>
                        <dt>requests</dt><dd>{JSON.stringify(c.resources?.requests || {})}</dd>
                        <dt>limits</dt><dd>{JSON.stringify(c.resources?.limits || {})}</dd>
                        <dt>probes</dt>
                        <dd>{['livenessProbe', 'readinessProbe', 'startupProbe']
                          .filter((k) => c[k]).map((k) => k.replace('Probe', '')).join(', ') || t('none')}</dd>
                        <dt>env</dt><dd>{t('{n} variables', { n: (c.env || []).length })}
                          {(c.envFrom || []).length ? ` + ${c.envFrom.length} envFrom` : ''}</dd>
                        {st.lastState?.terminated && (
                          <>
                            <dt>{t('died before')}</dt>
                            <dd style={{ color: 'var(--error)' }}>
                              {st.lastState.terminated.reason} (exit {st.lastState.terminated.exitCode})
                            </dd>
                          </>
                        )}
                      </dl>
                    </div>
                  </div>
                )
              })}
            </>
          ))}

          {tab === 'logs' && <Logs ctx={ctx} ns={pod.ns} pod={pod.name} containers={containers} />}

          {tab === 'events' && (!data ? <Loading /> : (
            events.length === 0
              ? <div className="empty">{t('no events for this pod')}</div>
              : <table>
                  <thead><tr><th>{t('when')}</th><th>{t('type')}</th><th>{t('reason')}</th><th>x</th><th>{t('message')}</th></tr></thead>
                  <tbody>
                    {events.map((e, i) => (
                      <tr key={i}>
                        <td>{relativeTime(e.when)}</td>
                        <td><Badge kind={e.type === 'Warning' ? 'warn' : 'neutral'}>{e.type}</Badge></td>
                        <td>{e.reason}</td>
                        <td className="num">{e.count}</td>
                        <td style={{ whiteSpace: 'normal' }}>{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
          ))}

          {tab === 'terminal' && (
            <PodTerminal ctx={ctx} ns={pod.ns} pod={pod.name} containers={containers} />
          )}

          {tab === 'describe' && (descr === null ? <Loading /> : <pre className="code">{descr}</pre>)}
          {tab === 'yaml' && (yaml === null ? <Loading /> : <pre className="code">{yaml}</pre>)}
        </div>
      </aside>
    </>
  )
}
