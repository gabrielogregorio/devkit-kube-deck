import { useSort, filterText } from './api'
import { t } from './i18n'

export function Badge({ kind = 'neutral', children }) {
  return <span className={`badge ${kind}`}>{children}</span>
}

/** Picks the badge color from the Kubernetes textual state. */
export function stateBadge(state, ok) {
  const e = String(state || '').toLowerCase()
  if (ok || e === 'running' || e === 'succeeded' || e === 'completed' || e === 'active' || e === 'bound') return 'ok'
  if (['pending', 'containercreating', 'podinitializing', 'terminating', 'init'].some((x) => e.includes(x))) return 'warn'
  if (['crashloop', 'error', 'failed', 'imagepull', 'errimage', 'oomkilled', 'evicted', 'unknown', 'notready'].some((x) => e.includes(x))) return 'bad'
  return 'neutral'
}

export function Card({ label, value, note, danger }) {
  return (
    <div className={`card${danger ? ' danger' : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  )
}

export function Loading({ text }) {
  return <div className="loading"><span className="spinner" />{text || t('querying the cluster')}...</div>
}

export function ErrorBox({ error, onResolve }) {
  if (!error) return null
  const text = `${error.hint || ''} ${error.message || ''}`
  // 403 is permission, not credentials. Sending the user to "fix credentials"
  // on a Forbidden pushes them the wrong way - they are already authenticated.
  const isRbac = /forbidden|rbac|permission/i.test(text)
  const isCredential = !isRbac && /credential|sso|token|expired/i.test(text)
  return (
    <div className="notice" style={isRbac ? { borderLeftColor: 'var(--warn)' } : undefined}>
      <h3>{isRbac ? `🔐 ${t('Authenticated, but without permission')}` : t('Could not read the cluster')}</h3>
      <p>{error.hint || error.message}</p>
      {error.hint && <p style={{ marginTop: 6, opacity: .7, fontSize: 12 }}>{error.message}</p>}
      {isCredential && onResolve && (
        <button className="btn active" style={{ marginTop: 10 }} onClick={() => onResolve('credentials')}>
          {t('fix credentials now')}
        </button>
      )}
      {isRbac && onResolve && (
        <button className="btn active" style={{ marginTop: 10 }} onClick={() => onResolve('access')}>
          {t('see what my user can do')}
        </button>
      )}
    </div>
  )
}

/**
 * "Partial view" banner: RBAC denied some resources, but the rest of the
 * screen is real. Works for any page - a restricted read profile often loses
 * nodes/secrets/pv and still sees pods and workloads.
 */
export function PartialView({ denied, goTo }) {
  if (!denied || !denied.length) return null
  return (
    <div className="notice" style={{ borderLeftColor: 'var(--warn)' }}>
      <h3>🔐 {t('Partial view: your RBAC blocks {n} resource(s)', { n: denied.length })}</h3>
      <p>
        {denied.map((n) => <span className="chip" key={n.resource}>{n.resource}</span>)}
        {' '}{t('You are authenticated; the cluster just does not let your user read these resources. The rest of the screen is real. "Access and RBAC" shows exactly what you can do.')}
      </p>
      {goTo && (
        <button className="btn active" style={{ marginTop: 8 }} onClick={() => goTo('access')}>
          {t('see my RBAC')}
        </button>
      )}
    </div>
  )
}

export function Block({ title, count, actions, children }) {
  return (
    <section className="block">
      {title && (
        <header>
          <span>{title}</span>
          {count !== undefined && <span className="count">{count}</span>}
          <span className="spacer" />
          {actions}
        </header>
      )}
      <div className="scroll">{children}</div>
    </section>
  )
}

/**
 * Sortable table.
 * columns: [{ key, title, width, render?, num?, mono? }]
 */
export function Table({ columns, rows, onClick, initialSort, rowKey, isBad, empty }) {
  const sort = useSort(initialSort)
  const data = sort.apply(rows || [])
  if (!data.length) return <div className="empty">{empty || t('nothing here')}</div>
  return (
    <table>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} style={c.width ? { width: c.width } : undefined}
                onClick={() => sort.sortBy(c.key)}>
              {c.title}{sort.col === c.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((l, i) => (
          <tr key={rowKey ? rowKey(l, i) : i}
              className={`${onClick ? 'clickable' : ''} ${isBad && isBad(l) ? 'bad' : ''}`}
              onClick={onClick ? () => onClick(l) : undefined}>
            {columns.map((c) => (
              <td key={c.key} className={`${c.num ? 'num' : ''} ${c.mono ? 'mono' : ''}`}>
                {c.render ? c.render(l) : String(l[c.key] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Search({ value, onChange, placeholder }) {
  return (
    <input className="field" style={{ width: 220 }} value={value} placeholder={placeholder || t('filter...')}
           onChange={(e) => onChange(e.target.value)} />
  )
}

export { filterText }

/** usage bar; pct is 0-100 */
export function UsageBar({ pct }) {
  const n = Math.max(0, Math.min(100, Number(pct) || 0))
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="mini-bar">
        <i style={{ width: `${n}%` }} className={n > 85 ? 'high' : n > 60 ? 'mid' : ''} />
      </span>
      <span style={{ fontSize: 11, color: 'var(--muted)', minWidth: 32 }}>{n}%</span>
    </span>
  )
}

export function relativeTime(iso) {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
