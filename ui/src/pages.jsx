import { useState } from 'react'
import { useApi } from './api'
import { Block, Table, Card, Loading, ErrorBox, Badge, stateBadge, Search, filterText, UsageBar, relativeTime, PartialView } from './ui'
import { t } from './i18n'

const mem = (s) => {
  if (!s) return ''
  const m = /^(\d+)(Ki|Mi|Gi|Ti)?$/.exec(String(s))
  if (!m) return s
  const n = Number(m[1])
  const gi = { Ki: n / 1048576, Mi: n / 1024, Gi: n, Ti: n * 1024 }[m[2] || 'Ki'] ?? n / 1073741824
  return `${gi.toFixed(1)} Gi`
}
const pct = (v) => Number(String(v || '').replace('%', '')) || 0
const muted = (x) => <span style={{ color: 'var(--muted)' }}>{x}</span>

/* ------------------------------------------------------------------ overview */
export function Overview({ ctx, ns, interval, onOpenPod, goTo, isLocal }) {
  const { data, error, loading } = useApi('overview', { ctx }, { interval })
  const top = useApi('top', { ctx, ns: '*' }, { interval: interval ? interval * 2 : 0 })
  const ev = useApi('events', { ctx, ns }, { interval })

  if (error) return <ErrorBox error={error} onResolve={goTo} />
  if (!data) return <Loading />

  const nodes = data.nodes || []
  const problems = data.problems || []
  const leftovers = data.leftovers || []
  const namespaces = data.namespaces || []
  const badNodes = nodes.filter((n) => !n.ready || n.cordoned).length
  const warnings = (ev.data?.events || []).filter((e) => e.type === 'Warning')

  return (
    <>
      {loading && <Loading text={t('refreshing')} />}
      <PartialView denied={data.denied} goTo={goTo} />
      {isLocal && (
        <div className="notice info">
          <h3>🧪 {t('This is a local test cluster, not your cloud')}</h3>
          <p>{t('It runs in Docker containers on this machine. To see a real environment, switch the cluster in the selector at the top.')}</p>
        </div>
      )}
      <div className="cards">
        <Card label={t('Nodes')} value={nodes.length}
              note={badNodes ? t('{n} with problems', { n: badNodes }) : t('all ready')} danger={!!badNodes} />
        <Card label={t('Live pods')} value={data.pods_alive ?? data.pods_total}
              note={t('{n} healthy', { n: data.pods_ok })} />
        <Card label={t('Broken now')} value={problems.length}
              note={problems.length ? t('using resources') : t('nothing broken')}
              danger={problems.length > 0} />
        <Card label={t('Leftovers of dead pods')} value={leftovers.length}
              note={t('reserve no resources')} />
        <Card label="Restarts" value={data.restarts_total} note={t('cluster total')} />
        <Card label="Namespaces" value={namespaces.length} note={t('server {v}', { v: data.server_version })} />
      </div>

      {leftovers.length > 0 && (
        <div className="notice info">
          <h3>💀 {t('{n} pods are leftovers, not active problems', { n: leftovers.length })}</h3>
          <p>
            {t('They are in the Failed phase: the containers already died and were removed from the node. They reserve no CPU or memory, do not count for the scheduler, take no pod slot on the node and do not count in ResourceQuota. What is left is just the object in etcd, the events and the noise on your screen. Cleaning them up is hygiene, not incident response.')}
            {data.leftovers_by_node?.length === 1 && (
              <> {t('All on the same node ({node}), which points to eviction under resource pressure or a kubelet restart on that node.', { node: data.leftovers_by_node[0][0] })}</>
            )}
          </p>
        </div>
      )}

      {problems.length > 0 && (
        <Block title={t('Broken now (using resources)')} count={problems.length}>
          <Table
            initialSort="ns"
            rowKey={(p) => `${p.ns}/${p.name}`}
            isBad={() => true}
            onClick={onOpenPod}
            columns={[
              { key: 'ns', title: 'namespace' },
              { key: 'name', title: 'pod', mono: true },
              { key: 'state', title: t('state'), render: (p) => <Badge kind={stateBadge(p.state, p.ok)}>{p.state}</Badge> },
              { key: 'restarts', title: 'restarts', num: true },
              { key: 'node', title: t('node'), mono: true },
              { key: 'age', title: t('age'), num: true },
            ]}
            rows={problems}
          />
        </Block>
      )}

      {leftovers.length > 0 && (
        <Block title={t('Leftovers of dead pods')} count={t('{n} · zero resources reserved', { n: leftovers.length })}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)',
                        fontSize: 12, color: 'var(--muted)' }}>
            {t('per node:')} {data.leftovers_by_node?.map(([n, q]) => (
              <span className="chip" key={n}>{n}: {q}</span>
            ))}
            {' '}· {t('(Kube Deck never deletes anything)')}
          </div>
          <Table
            initialSort="ns"
            rowKey={(p) => `${p.ns}/${p.name}`}
            onClick={onOpenPod}
            columns={[
              { key: 'ns', title: 'namespace' },
              { key: 'name', title: 'pod', mono: true },
              { key: 'state', title: t('how it died'), render: (p) => <Badge kind="neutral">{p.state}</Badge> },
              { key: 'resources', title: t('resources'), render: () => muted(t('none reserved')) },
              { key: 'node', title: t('node'), mono: true },
              { key: 'age', title: t('dead for'), num: true },
            ]}
            rows={leftovers}
          />
        </Block>
      )}

      <Block title="Namespaces" count={t('{n} with workloads', { n: namespaces.length })}>
        <Table
          initialSort="ns"
          rowKey={(n) => n.ns}
          isBad={(n) => n.problems > 0}
          onClick={(n) => goTo('pods', n.ns)}
          columns={[
            { key: 'ns', title: 'namespace' },
            { key: 'pods', title: 'pods', num: true },
            { key: 'problems', title: t('broken now'), num: true,
              render: (n) => n.problems ? <Badge kind="bad">{n.problems}</Badge> : muted('0') },
            { key: 'leftovers', title: t('dead leftovers'), num: true,
              render: (n) => n.leftovers ? <Badge kind="neutral">{n.leftovers}</Badge> : muted('0') },
            { key: 'restarts', title: 'restarts', num: true },
          ]}
          rows={namespaces}
        />
      </Block>

      {nodes.length > 0 && (
      <Block title={t('Nodes')} count={nodes.length}>
        <Table
          initialSort="name"
          rowKey={(n) => n.name}
          isBad={(n) => !n.ready || n.cordoned}
          columns={[
            { key: 'name', title: t('node'), mono: true },
            { key: 'ready', title: t('state'),
              render: (n) => n.cordoned ? <Badge kind="warn">cordoned</Badge>
                : <Badge kind={n.ready ? 'ok' : 'bad'}>{n.ready ? 'Ready' : 'NotReady'}</Badge> },
            { key: 'cpu', title: 'cpu', num: true },
            { key: 'memory', title: t('memory'), num: true, render: (n) => mem(n.memory) },
            { key: 'cpu_use', title: t('cpu use'),
              render: (n) => <UsageBar pct={pct(top.data?.nodes?.[n.name]?.cpu_pct)} /> },
            { key: 'mem_use', title: t('mem use'),
              render: (n) => <UsageBar pct={pct(top.data?.nodes?.[n.name]?.mem_pct)} /> },
            { key: 'version', title: 'kubelet', mono: true },
            { key: 'age', title: t('age'), num: true },
          ]}
          rows={nodes}
        />
      </Block>
      )}

      <Block title={t('Warning events')} count={warnings.length}>
        <Table
          initialSort="when" rowKey={(e, i) => `${e.object}-${e.when}-${i}`}
          empty={t('no recent warnings')}
          columns={[
            { key: 'when', title: t('when'), render: (e) => relativeTime(e.when) },
            { key: 'ns', title: 'namespace' },
            { key: 'object', title: t('object'), mono: true },
            { key: 'reason', title: t('reason'), render: (e) => <Badge kind="warn">{e.reason}</Badge> },
            { key: 'message', title: t('message'),
              render: (e) => <span title={e.message} style={{ whiteSpace: 'normal', display: 'block', maxWidth: 620 }}>{e.message}</span> },
          ]}
          rows={warnings.slice(0, 25)}
        />
      </Block>
    </>
  )
}

/* ------------------------------------------------------------------ pods */
export function Pods({ ctx, ns, interval, onOpenPod, goTo }) {
  const { data, error, loading } = useApi('pods', { ctx, ns }, { interval })
  const top = useApi('top', { ctx, ns }, { interval: interval ? interval * 2 : 0 })
  const [search, setSearch] = useState('')
  const [onlyBroken, setOnlyBroken] = useState(false)
  const [hideLeftovers, setHideLeftovers] = useState(false)

  if (error) return <ErrorBox error={error} onResolve={goTo} />
  if (!data) return <Loading />

  const pods = data.pods || []
  let list = filterText(pods, search, ['name', 'ns', 'state', 'node', 'ip'])
  if (onlyBroken) list = list.filter((p) => !p.ok && !p.leftover)
  if (hideLeftovers) list = list.filter((p) => !p.leftover)
  const leftoverCount = pods.filter((p) => p.leftover).length

  return (
    <Block
      title="Pods" count={t('{a} of {b}', { a: list.length, b: pods.length })}
      actions={
        <>
          {loading && <span className="spinner" />}
          <button className={`btn${onlyBroken ? ' active' : ''}`} onClick={() => setOnlyBroken(!onlyBroken)}>
            {t('only broken now')}
          </button>
          {leftoverCount > 0 && (
            <button className={`btn${hideLeftovers ? ' active' : ''}`} onClick={() => setHideLeftovers(!hideLeftovers)}
                    title={t('hides pods in the Failed phase, which reserve no resources')}>
              {t('hide {n} leftovers', { n: leftoverCount })}
            </button>
          )}
          <Search value={search} onChange={setSearch} placeholder={t('filter pods...')} />
        </>
      }>
      <Table
        initialSort="ok"
        rowKey={(p) => `${p.ns}/${p.name}`}
        isBad={(p) => !p.ok && !p.leftover}
        onClick={onOpenPod}
        columns={[
          { key: 'ok', title: '', width: 24,
            render: (p) => <span className={`dot ${p.ok ? 'ok' : p.leftover ? 'dead' : 'bad'}`}
                                 title={p.leftover ? t('dead pod, reserves no resources') : ''} /> },
          { key: 'ns', title: 'namespace' },
          { key: 'name', title: 'pod', mono: true },
          { key: 'ready', title: 'ready', num: true, render: (p) => `${p.ready}/${p.total}` },
          { key: 'state', title: t('state'),
            render: (p) => p.leftover
              ? <span title={t('Failed phase: containers already died, reserves no CPU or memory')}>
                  <Badge kind="neutral">💀 {p.state}</Badge>
                </span>
              : <Badge kind={stateBadge(p.state, p.ok)}>{p.state}</Badge> },
          { key: 'restarts', title: 'rst', num: true,
            render: (p) => p.restarts > 0 ? <span style={{ color: p.restarts > 5 ? 'var(--error)' : 'var(--warn)' }}>{p.restarts}</span> : '0' },
          { key: 'cpu', title: 'cpu', num: true,
            render: (p) => p.leftover ? <span style={{ color: 'var(--muted)' }} title={t('dead pod')}>{t('zero')}</span>
                                      : (top.data?.pods?.[`${p.ns}/${p.name}`]?.cpu || '-') },
          { key: 'memory', title: 'mem', num: true,
            render: (p) => p.leftover ? <span style={{ color: 'var(--muted)' }} title={t('dead pod')}>{t('zero')}</span>
                                      : (top.data?.pods?.[`${p.ns}/${p.name}`]?.mem || '-') },
          { key: 'node', title: t('node'), mono: true },
          { key: 'ip', title: 'ip', mono: true },
          { key: 'age', title: t('age'), num: true },
        ]}
        rows={list}
      />
    </Block>
  )
}

/* ------------------------------------------------------------------ workloads */
export function Workloads({ ctx, ns, interval, goTo }) {
  const { data, error } = useApi('workloads', { ctx, ns }, { interval })
  const [search, setSearch] = useState('')
  if (error) return <ErrorBox error={error} onResolve={goTo} />
  if (!data) return <Loading />
  const list = filterText(data.workloads || [], search, ['name', 'ns', 'kind'])
  const byKind = (k) => list.filter((w) => w.kind === k)

  const table = (rows) => (
    <Table
      initialSort="ns" rowKey={(w) => `${w.kind}/${w.ns}/${w.name}`}
      isBad={(w) => !w.healthy}
      columns={[
        { key: 'ns', title: 'namespace' },
        { key: 'name', title: t('name'), mono: true },
        { key: 'ready', title: 'ready',
          render: (w) => <Badge kind={w.healthy ? 'ok' : 'bad'}>{w.ready}</Badge> },
        { key: 'images', title: t('image'), mono: true,
          render: (w) => (w.images || []).map((i, n) => <span className="chip" key={n} title={i}>{String(i).split('/').pop()}</span>) },
        { key: 'age', title: t('age'), num: true },
      ]}
      rows={rows}
    />
  )

  return (
    <>
      <PartialView denied={data.denied} goTo={goTo} />
      <div style={{ display: 'flex', marginBottom: 12 }}>
        <span className="spacer" />
        <Search value={search} onChange={setSearch} placeholder={t('filter workloads...')} />
      </div>
      {[['Deployment', 'Deployments'], ['StatefulSet', 'StatefulSets'], ['DaemonSet', 'DaemonSets'],
        ['CronJob', 'CronJobs'], ['Job', 'Jobs']].map(([k, title]) =>
        byKind(k).length > 0 && (
          <Block key={k} title={title} count={byKind(k).length}>{table(byKind(k))}</Block>
        ))}
    </>
  )
}

/* ------------------------------------------------------------------ nodes */
export function Nodes({ ctx, interval }) {
  const { data, error } = useApi('overview', { ctx }, { interval })
  const top = useApi('top', { ctx, ns: '*' }, { interval })
  const pods = useApi('pods', { ctx, ns: '*' }, { interval })
  const [open, setOpen] = useState(null)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />

  const nodes = data.nodes || []
  const podsOf = (n) => (pods.data?.pods || []).filter((p) => p.node === n)

  return (
    <>
      <Block title={t('Nodes')} count={nodes.length}>
        <Table
          initialSort="name" rowKey={(n) => n.name}
          isBad={(n) => !n.ready || n.cordoned}
          onClick={(n) => setOpen(open === n.name ? null : n.name)}
          columns={[
            { key: 'name', title: t('node'), mono: true },
            { key: 'ready', title: t('state'),
              render: (n) => n.cordoned ? <Badge kind="warn">cordoned</Badge>
                : <Badge kind={n.ready ? 'ok' : 'bad'}>{n.ready ? 'Ready' : 'NotReady'}</Badge> },
            { key: 'pods', title: 'pods', num: true, render: (n) => podsOf(n.name).length },
            { key: 'cpu', title: 'cpu', num: true },
            { key: 'cpu_use', title: t('cpu use'), render: (n) => <UsageBar pct={pct(top.data?.nodes?.[n.name]?.cpu_pct)} /> },
            { key: 'memory', title: t('memory'), num: true, render: (n) => mem(n.memory) },
            { key: 'mem_use', title: t('mem use'), render: (n) => <UsageBar pct={pct(top.data?.nodes?.[n.name]?.mem_pct)} /> },
            { key: 'version', title: 'kubelet', mono: true },
            { key: 'age', title: t('age'), num: true },
          ]}
          rows={nodes}
        />
      </Block>
      {open && (
        <Block title={t('Pods on {node}', { node: open })} count={podsOf(open).length}>
          <Table
            initialSort="ns" rowKey={(p) => `${p.ns}/${p.name}`} isBad={(p) => !p.ok}
            columns={[
              { key: 'ns', title: 'namespace' },
              { key: 'name', title: 'pod', mono: true },
              { key: 'state', title: t('state'), render: (p) => <Badge kind={stateBadge(p.state, p.ok)}>{p.state}</Badge> },
              { key: 'age', title: t('age'), num: true },
            ]}
            rows={podsOf(open)}
          />
        </Block>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ network */
export function Network({ ctx, ns, interval, goTo }) {
  const { data, error } = useApi('network', { ctx, ns }, { interval })
  const [search, setSearch] = useState('')
  if (error) return <ErrorBox error={error} onResolve={goTo} />
  if (!data) return <Loading />
  const svcs = filterText(data.services || [], search, ['name', 'ns', 'type', 'external'])
  const ings = filterText(data.ingresses || [], search, ['name', 'ns', 'address'])

  return (
    <>
      <PartialView denied={data.denied} goTo={goTo} />
      <div style={{ display: 'flex', marginBottom: 12 }}>
        <span className="spacer" />
        <Search value={search} onChange={setSearch} placeholder={t('filter network...')} />
      </div>

      <Block title="Ingresses" count={ings.length}>
        <Table
          initialSort="ns" rowKey={(i) => `${i.ns}/${i.name}`}
          columns={[
            { key: 'ns', title: 'namespace' },
            { key: 'name', title: 'ingress', mono: true },
            { key: 'rules', title: 'hosts', render: (i) => (
              <span>{(i.rules || []).map((r, n) => (
                <a key={n} className="chip" href={`https://${r.host}${r.path === '/' ? '' : r.path}`}
                   target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                  {r.host}{r.path !== '/' ? r.path : ''} → {r.service}:{r.port}
                </a>
              ))}</span>
            ) },
            { key: 'tls', title: 'tls', render: (i) => i.tls ? <Badge kind="ok">TLS</Badge> : <Badge kind="neutral">{t('no TLS')}</Badge> },
            { key: 'address', title: t('load balancer'), mono: true },
          ]}
          rows={ings}
        />
      </Block>

      <Block title="Services" count={svcs.length}>
        <Table
          initialSort="type" rowKey={(s) => `${s.ns}/${s.name}`}
          columns={[
            { key: 'ns', title: 'namespace' },
            { key: 'name', title: 'service', mono: true },
            { key: 'type', title: t('type'),
              render: (s) => <Badge kind={s.type === 'ClusterIP' ? 'neutral' : 'info'}>{s.type}</Badge> },
            { key: 'clusterIP', title: 'cluster ip', mono: true },
            { key: 'external', title: t('external'), mono: true },
            { key: 'ports', title: t('ports'), mono: true,
              render: (s) => (s.ports || []).map((p, n) => <span className="chip" key={n}>{p}</span>) },
          ]}
          rows={svcs}
        />
      </Block>
    </>
  )
}

/* ------------------------------------------------------------------ config */
export function Config({ ctx, ns, interval, goTo }) {
  const { data, error } = useApi('config', { ctx, ns }, { interval: interval ? interval * 3 : 0 })
  const [search, setSearch] = useState('')
  if (error) return <ErrorBox error={error} onResolve={goTo} />
  if (!data) return <Loading />

  const keys = (o) => (o.keys || []).length
    ? o.keys.map((k) => <span className="chip" key={k}>{k}</span>)
    : muted(t('empty'))
  const configmaps = data.configmaps || []
  const secrets = data.secrets || []

  return (
    <>
      <PartialView denied={data.denied} goTo={goTo} />
      <div className="notice info">
        <h3>{t('Secret values never leave the cluster')}</h3>
        <p>{t('This screen shows only the key names. The backend never exposes the content of any Secret.')}</p>
      </div>
      <div style={{ display: 'flex', marginBottom: 12 }}>
        <span className="spacer" />
        <Search value={search} onChange={setSearch} placeholder={t('filter config...')} />
      </div>

      <Block title="ConfigMaps" count={configmaps.length}>
        <Table
          initialSort="ns" rowKey={(c) => `${c.ns}/${c.name}`}
          columns={[
            { key: 'ns', title: 'namespace' },
            { key: 'name', title: 'configmap', mono: true },
            { key: 'keys', title: t('keys'), render: keys },
            { key: 'age', title: t('age'), num: true },
          ]}
          rows={filterText(configmaps, search, ['name', 'ns'])}
        />
      </Block>

      <Block title="Secrets" count={secrets.length}>
        <Table
          initialSort="ns" rowKey={(s) => `${s.ns}/${s.name}`}
          columns={[
            { key: 'ns', title: 'namespace' },
            { key: 'name', title: 'secret', mono: true },
            { key: 'type', title: t('type'), mono: true },
            { key: 'keys', title: t('keys (names only)'), render: keys },
            { key: 'age', title: t('age'), num: true },
          ]}
          rows={filterText(secrets, search, ['name', 'ns', 'type'])}
        />
      </Block>
    </>
  )
}

/* ------------------------------------------------------------------ storage */
export function Storage({ ctx, ns, interval, goTo }) {
  const { data, error } = useApi('storage', { ctx, ns }, { interval: interval ? interval * 3 : 0 })
  if (error) return <ErrorBox error={error} onResolve={goTo} />
  if (!data) return <Loading />
  const pvcs = data.pvcs || []
  const pvs = data.pvs || []
  return (
    <>
      <PartialView denied={data.denied} goTo={goTo} />
      <Block title="PersistentVolumeClaims" count={pvcs.length}>
        <Table
          initialSort="ns" rowKey={(p) => `${p.ns}/${p.name}`}
          isBad={(p) => p.status !== 'Bound'}
          columns={[
            { key: 'ns', title: 'namespace' },
            { key: 'name', title: 'pvc', mono: true },
            { key: 'status', title: 'status', render: (p) => <Badge kind={stateBadge(p.status)}>{p.status}</Badge> },
            { key: 'capacity', title: t('size'), num: true },
            { key: 'class', title: t('class') },
            { key: 'volume', title: 'volume', mono: true },
            { key: 'age', title: t('age'), num: true },
          ]}
          rows={pvcs}
        />
      </Block>
      <Block title="PersistentVolumes" count={pvs.length}>
        <Table
          initialSort="name" rowKey={(p) => p.name}
          columns={[
            { key: 'name', title: 'pv', mono: true },
            { key: 'status', title: 'status', render: (p) => <Badge kind={stateBadge(p.status)}>{p.status}</Badge> },
            { key: 'capacity', title: t('size'), num: true },
            { key: 'class', title: t('class') },
            { key: 'policy', title: 'reclaim' },
            { key: 'age', title: t('age'), num: true },
          ]}
          rows={pvs}
        />
      </Block>
    </>
  )
}

/* ------------------------------------------------------------------ events */
export function Events({ ctx, ns, interval }) {
  const { data, error } = useApi('events', { ctx, ns }, { interval })
  const [search, setSearch] = useState('')
  const [onlyWarnings, setOnlyWarnings] = useState(true)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const events = data.events || []
  let list = events
  if (onlyWarnings) list = list.filter((e) => e.type === 'Warning')
  list = filterText(list, search, ['object', 'reason', 'message', 'ns'])

  return (
    <Block
      title={t('Events')} count={t('{a} of {b}', { a: list.length, b: events.length })}
      actions={
        <>
          <button className={`btn${onlyWarnings ? ' active' : ''}`} onClick={() => setOnlyWarnings(!onlyWarnings)}>{t('only warnings')}</button>
          <Search value={search} onChange={setSearch} placeholder={t('filter events...')} />
        </>
      }>
      <Table
        initialSort="when" rowKey={(e, i) => `${e.object}-${e.when}-${i}`}
        isBad={(e) => e.type === 'Warning'}
        columns={[
          { key: 'when', title: t('when'), render: (e) => relativeTime(e.when) },
          { key: 'type', title: t('type'), render: (e) => <Badge kind={e.type === 'Warning' ? 'warn' : 'neutral'}>{e.type}</Badge> },
          { key: 'ns', title: 'namespace' },
          { key: 'object', title: t('object'), mono: true },
          { key: 'reason', title: t('reason') },
          { key: 'count', title: 'x', num: true },
          { key: 'message', title: t('message'),
            render: (e) => <span style={{ whiteSpace: 'normal', display: 'block', maxWidth: 700 }}>{e.message}</span> },
        ]}
        rows={list}
      />
    </Block>
  )
}

/* ------------------------------------------------------------------ access */
export function Access({ ctx, ns }) {
  const { data, error } = useApi('access', { ctx, ns })
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const checks = data.checks || []
  return (
    <>
      <Block title={t('Who you are on this cluster')}>
        <div style={{ padding: '14px 16px' }}>
          <dl className="facts">
            <dt>{t('user')}</dt><dd>{data.user}</dd>
            <dt>{t('groups')}</dt><dd>{(data.groups || []).join(', ') || '-'}</dd>
            <dt>namespace</dt><dd>{ns === '*' ? t('all') : ns}</dd>
            <dt>{t('scope asked')}</dt><dd>{data.scope || (ns === '*' ? t('all namespaces') : ns)}</dd>
          </dl>
        </div>
      </Block>
      <Block title={t('What your RBAC allows, screen by screen')}
             count={`${checks.filter((c) => c.allowed).length}/${checks.length}`}>
        <Table
          initialSort="resource"
          rowKey={(c) => `${c.verb} ${c.resource}`}
          isBad={(c) => !c.allowed && !String(c.screen || '').startsWith('(')}
          columns={[
            { key: 'allowed', title: t('allowed?'),
              render: (c) => <Badge kind={c.allowed ? 'ok' : 'bad'}>{c.allowed ? t('yes') : t('no')}</Badge> },
            { key: 'resource', title: t('resource'), mono: true },
            { key: 'verb', title: t('verb'), mono: true },
            { key: 'screen', title: t('what it feeds in Kube Deck') },
          ]}
          rows={checks}
        />
        <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--muted)' }}>
          {t('Asked with')} <code>kubectl auth can-i &lt;verb&gt; &lt;resource&gt;
          {ns === '*' ? ' --all-namespaces' : ` -n ${ns}`}</code>. {t('A "no" here explains exactly why the matching screen shows up empty or partial - it is the cluster refusing, not the tool failing.')}
        </div>
      </Block>
      <div className="notice info">
        <h3>{t('Safe by design: reads freely, the shell asks first, nothing deletes')}</h3>
        <p>{t('Even if your RBAC allows deleting or editing, Kube Deck has no route that changes the cluster. The only thing that runs inside it is the pod shell, and it asks for confirmation every time.')}</p>
      </div>
    </>
  )
}
