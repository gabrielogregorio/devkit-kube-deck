import { useEffect, useState } from 'react'
import { useApi, fetchJson } from './api'
import { Overview, Pods, Workloads, Nodes, Network, Config, Storage, Events, Access } from './pages'
import { PodPanel } from './PodPanel'
import { Credentials } from './Credentials'
import { CommandBar } from './CommandBar'
import { t, getLang, setLang, LANGS } from './i18n'

export default function App() {
  const [ctx, setCtx] = useState(null)
  const [ns, setNs] = useState('*')
  const [page, setPage] = useState('overview')
  const [openPod, setOpenPod] = useState(null)
  const [interval, setIntervalMs] = useState(10000)

  const ctxs = useApi('contexts', {})
  const nss = useApi('namespaces', { ctx }, { enabled: !!ctx })
  const overview = useApi('overview', { ctx }, { interval, enabled: !!ctx })

  useEffect(() => {
    if (!ctx && ctxs.data?.current) setCtx(ctxs.data.current)
  }, [ctxs.data, ctx])

  const pages = [
    { id: 'overview', name: t('Overview'), group: 'cluster' },
    { id: 'nodes', name: t('Nodes'), group: 'cluster' },
    { id: 'events', name: t('Events'), group: 'cluster' },
    { id: 'pods', name: 'Pods', group: 'workloads' },
    { id: 'workloads', name: 'Workloads', group: 'workloads' },
    { id: 'network', name: t('Network'), group: 'resources' },
    { id: 'config', name: t('Config and Secrets'), group: 'resources' },
    { id: 'storage', name: t('Storage'), group: 'resources' },
    { id: 'access', name: t('Access and RBAC'), group: 'resources' },
    { id: 'credentials', name: t('AWS credentials'), group: 'resources' },
  ]
  const groups = [['cluster', 'Cluster'], ['workloads', t('Workloads')], ['resources', t('Resources')]]

  const info = ctxs.data?.contexts?.find((c) => c.name === ctx)
  const isLocal = !!info?.local

  const switchCtx = async (name) => {
    setCtx(name)
    setNs('*')
    setOpenPod(null)
    try { await fetchJson('select', { name }) } catch { /* the server only stores a preference */ }
  }

  const goTo = (p, newNs) => {
    if (newNs) setNs(newNs)
    setPage(p)
  }

  const props = { ctx, ns, interval, onOpenPod: setOpenPod, goTo, isLocal }
  const counts = {
    nodes: overview.data?.nodes?.length,
    pods: overview.data?.pods_total,
  }
  const ov = overview.data

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">kube<span>deck</span> <small>v2.0</small></div>

        <select className="field" value={ctx || ''} onChange={(e) => switchCtx(e.target.value)}
                title={t('cluster (kubeconfig context)')}>
          {!ctxs.data && <option>{t('loading clusters...')}</option>}
          {ctxs.data?.contexts?.map((c) => (
            <option key={c.name} value={c.name}>
              {c.local ? '🧪 ' : ''}{c.name}{c.local ? `  (${t('local, docker')})` : ''}
            </option>
          ))}
        </select>

        {isLocal && (
          <span className="badge info" title={t('test cluster running in Docker on this machine ({server})', { server: info?.server })}>
            🧪 {t('LOCAL, NOT THE CLOUD')}
          </span>
        )}

        <select className="field" value={ns} onChange={(e) => setNs(e.target.value)} title="namespace">
          <option value="*">{t('all namespaces')}</option>
          {nss.data?.namespaces?.map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
        </select>

        <span className="spacer" />

        <span className="safety-pill" title={t('Safe by design: reads freely, the shell asks first, nothing deletes')}>
          {t('safe by design')}
        </span>

        <select className="field" value={interval} onChange={(e) => setIntervalMs(Number(e.target.value))}
                title={t('auto refresh')}>
          <option value={0}>{t('manual')}</option>
          <option value={5000}>{t('every 5s')}</option>
          <option value={10000}>{t('every 10s')}</option>
          <option value={30000}>{t('every 30s')}</option>
        </select>

        <select className="field" value={getLang()} onChange={(e) => setLang(e.target.value, true)}
                title={t('language')}>
          {LANGS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>

        <button className="btn" onClick={() => { overview.reload(); window.dispatchEvent(new Event('kd:refresh')) }}>
          {t('refresh')}
        </button>
      </header>

      <div className="main-grid">
        <nav className="sidebar">
          {groups.map(([g, title]) => (
            <div key={g}>
              <h4>{title}</h4>
              {pages.filter((p) => p.group === g).map((p) => (
                <button key={p.id} className={`nav-item${page === p.id ? ' active' : ''}`}
                        onClick={() => setPage(p.id)}>
                  <span>{p.name}</span>
                  {counts[p.id] !== undefined && <span className="count">{counts[p.id]}</span>}
                </button>
              ))}
            </div>
          ))}

          <h4>{t('Status')}</h4>
          <div style={{ padding: '0 10px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.8 }}>
            {ov ? (
              <>
                <div>{t('server {v}', { v: ov.server_version })}</div>
                <div>{t('{a}/{b} pods ok', { a: ov.pods_ok, b: ov.pods_total })}</div>
                <div style={{ color: (ov.problems || []).length ? 'var(--error)' : 'var(--ok)' }}>
                  {t('{n} with problems', { n: (ov.problems || []).length })}
                </div>
              </>
            ) : overview.error ? <span style={{ color: 'var(--error)' }}>{t('no connection')}</span> : t('loading...')}
          </div>
        </nav>

        <main className="content" key={`${ctx}-${ns}-${page}`}>
          {!ctx ? <div className="loading"><span className="spinner" />{t('discovering clusters...')}</div> : (
            <>
              {page === 'overview' && <Overview {...props} />}
              {page === 'pods' && <Pods {...props} />}
              {page === 'workloads' && <Workloads {...props} />}
              {page === 'nodes' && <Nodes {...props} />}
              {page === 'network' && <Network {...props} />}
              {page === 'config' && <Config {...props} />}
              {page === 'storage' && <Storage {...props} />}
              {page === 'events' && <Events {...props} />}
              {page === 'access' && <Access {...props} />}
              {page === 'credentials' && <Credentials {...props} />}
            </>
          )}
        </main>
      </div>

      <CommandBar />

      {openPod && <PodPanel ctx={ctx} pod={openPod} onClose={() => setOpenPod(null)} />}
    </div>
  )
}
