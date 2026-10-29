import { useEffect, useMemo, useRef, useState } from 'react'
import { useApi, fetchJson, postJson } from './api'
import { Block, Badge, Loading, ErrorBox } from './ui'
import { parsePaste } from './parseAws'
import { t } from './i18n'

/* ----------------------------------------------------- live SSO login */
function LoginWindow({ profile, onClose, onDone }) {
  const [lines, setLines] = useState([])
  const [end, setEnd] = useState(null)
  // keep the latest callback without restarting the stream on every render
  const doneRef = useRef(onDone)
  useEffect(() => { doneRef.current = onDone }, [onDone])

  useEffect(() => {
    const es = new EventSource(`/api/aws/login?profile=${encodeURIComponent(profile)}`)
    es.onmessage = (ev) => {
      let d
      try { d = JSON.parse(ev.data) } catch { return }
      if (d.done) { setEnd(d); es.close(); doneRef.current?.(d) }
      else if (d.line !== undefined) setLines((p) => [...p, d.line])
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [profile])

  const url = lines.map((l) => (l.match(/https?:\/\/\S+/) || [])[0]).filter(Boolean).pop()
  const code = lines.map((l) => (l.match(/\b[A-Z]{4}-[A-Z]{4}\b/) || [])[0]).filter(Boolean).pop()

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="modal">
        <header>
          <h2>{t('SSO login · {profile}', { profile })}</h2>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>{t('close')}</button>
        </header>
        <div className="modal-body">
          {!end && (
            <p style={{ color: 'var(--muted)', marginTop: 0 }}>
              {t('The AWS CLI opens the browser by itself. If it does not, use the link and the code below.')}
            </p>
          )}
          {code && (
            <div className="highlight">
              {t('verification code:')} <b className="mono" style={{ fontSize: 20 }}>{code}</b>
            </div>
          )}
          {url && (
            <p><a href={url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{url}</a></p>
          )}
          <pre className="code" style={{ maxHeight: 220 }}>
            {lines.join('\n') || t('starting...')}
          </pre>
          {end && (
            <div className={`notice ${end.status?.valid ? 'info' : ''}`} style={{ marginTop: 14 }}>
              <h3>{end.status?.valid ? t('Valid session') : t('Not authenticated')}</h3>
              <p>{end.status?.valid
                ? t('account {account} · {arn}', { account: end.status.account, arn: end.status.arn })
                : end.status?.reason || t('try again')}</p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------- inject credentials / cluster */
const EMPTY = {
  profile: '', access_key: '', secret_key: '', session_token: '',
  region: '', cluster: '', role_arn: '', alias: '',
}

const EXAMPLE = `aws eks update-kubeconfig --region us-west-2 --name my-cluster-prod \\
  --role-arn arn:aws:iam::111122223333:role/MyEKSReadRole

export AWS_ACCESS_KEY_ID="ASIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_SESSION_TOKEN="..."`

const linkedCount = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)

function Injector({ profiles, target, onSave }) {
  const [pasted, setPasted] = useState('')
  const [f, setF] = useState(EMPTY)
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState('')
  const [results, setResults] = useState([])
  const [suggestion, setSuggestion] = useState('')
  const box = useRef(null)

  // clicking "change keys" in the profiles table lands here with the profile
  // filled. target is a new object on every click, so clicking the same
  // profile again still fires
  useEffect(() => {
    if (!target?.name) return
    setF((a) => ({ ...a, profile: target.name }))
    box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [target])

  const paste = (txt) => {
    setPasted(txt)
    const p = parsePaste(txt)
    // only overwrite what was actually found: what you typed stays
    setF((a) => {
      const n = { ...a }
      for (const k of Object.keys(EMPTY)) if (p[k]) n[k] = p[k]
      return n
    })
    setSuggestion(p.suggested_profile || '')
    setResults([])
  }

  const canKeys = !!(f.profile && f.access_key && f.secret_key)
  const canCluster = !!(f.cluster && f.region)
  // a pasted key without a chosen profile would be dropped silently - warn
  const orphanKey = !!((f.access_key || f.secret_key) && !f.profile)

  const found = useMemo(() => {
    const l = []
    if (f.access_key) l.push('access key')
    if (f.secret_key) l.push('secret')
    if (f.session_token) l.push('session token')
    if (f.cluster) l.push('cluster')
    if (f.region) l.push(t('region'))
    if (f.role_arn) l.push('role')
    if (f.profile) l.push(t('profile'))
    return l
  }, [f])

  const apply = async () => {
    const out = []
    let failed = false
    if (canKeys) {
      setBusy('keys')
      try {
        await postJson('aws/keys', {
          profile: f.profile, access_key: f.access_key, secret_key: f.secret_key,
          session_token: f.session_token, region: f.region,
        })
        out.push({ ok: true, text: t('keys saved to profile "{profile}" (~/.aws/credentials, backup made)', { profile: f.profile }) })
      } catch (e) {
        out.push({ ok: false, text: `${t('keys')}: ${e.message}` })
        failed = true
      }
    }
    // if the keys failed, registering the cluster with stale credentials only confuses
    if (canCluster && !failed) {
      setBusy('cluster')
      try {
        const r = await postJson('aws/kubeconfig', {
          name: f.cluster, region: f.region, role_arn: f.role_arn,
          profile: f.profile, alias: f.alias,
        })
        out.push({ ok: true, text: t('cluster in the kubeconfig as {context}', { context: r.context || f.cluster }) })
        if (linkedCount(r.linked)) {
          out.push({ ok: true, text: t('profile {profile} linked to {n} context(s)', { profile: r.profile, n: linkedCount(r.linked) }) })
        }
        if (r.backup) out.push({ ok: true, text: t('kubeconfig backup at {path}', { path: r.backup }) })
      } catch (e) {
        out.push({ ok: false, text: `kubeconfig: ${e.message}` })
        failed = true
      }
    }
    setBusy('')
    setResults(out)
    if (!failed) {
      // secrets off the screen as soon as they have been used
      setPasted('')
      setF((a) => ({ ...a, access_key: '', secret_key: '', session_token: '' }))
    }
    onSave?.()
  }

  const field = (k, label, hint = '', secret = false) => (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      <input className="field mono" style={{ width: '100%' }} value={f[k]} placeholder={hint}
             type={secret && !reveal ? 'password' : 'text'}
             autoComplete="off" spellCheck="false"
             list={k === 'profile' ? 'known-profiles' : undefined}
             onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  )

  return (
    <div ref={box}>
      <Block title={t('Inject credentials and cluster')}
             count={found.length ? found.join(' · ') : t('paste and it extracts')}
             actions={
               <>
                 <button className="btn" onClick={() => setReveal(!reveal)}>{reveal ? t('hide secrets') : t('show secrets')}</button>{' '}
                 <button className="btn" onClick={() => { setPasted(''); setF(EMPTY); setResults([]) }}>{t('clear')}</button>
               </>
             }>
        <div style={{ padding: '14px 16px' }}>
          <p style={{ color: 'var(--muted)', marginTop: 0, fontSize: 13, maxWidth: 760 }}>
            {t('Paste here what AWS gave you, as it came: the export block, the [profile] section in .ini format, the aws eks update-kubeconfig command, or all of it together. The fields below fill themselves and stay editable.')}
          </p>

          <textarea className="field mono" rows={7} value={pasted} spellCheck="false"
                    placeholder={EXAMPLE}
                    style={{ width: '100%', resize: 'vertical', lineHeight: 1.5 }}
                    onChange={(e) => paste(e.target.value)} />

          <datalist id="known-profiles">
            {(profiles || []).map((p) => <option key={p} value={p} />)}
          </datalist>

          <div style={{ display: 'grid', gap: 10, marginTop: 14,
                        gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
            {field('profile', t('AWS profile (saves/updates this one)'), 'my-profile')}
            {field('access_key', 'AWS_ACCESS_KEY_ID', 'AKIA... / ASIA...')}
            {field('secret_key', 'AWS_SECRET_ACCESS_KEY', '', true)}
            {field('session_token', t('AWS_SESSION_TOKEN (temporary)'), '', true)}
            {field('region', t('region'), 'us-west-2')}
            {field('cluster', t('EKS cluster name (--name)'), 'my-cluster-prod')}
            {field('role_arn', t('role to assume (--role-arn)'), 'arn:aws:iam::111122223333:role/MyEKSReadRole')}
            {field('alias', t('context alias (optional)'), 'my-prod')}
          </div>

          {orphanKey && (
            <div className="notice" style={{ marginTop: 14, marginBottom: 0 }}>
              <h3>{t('Give it a profile name, or the keys are ignored')}</h3>
              <p>
                {t('The paste has an access key but no chosen profile - and a key needs a profile in ~/.aws/credentials to exist.')}
                {suggestion && ` ${t('Suggestion from the role:')} `}
                {suggestion && (
                  <button className="btn" onClick={() => setF({ ...f, profile: suggestion })}>
                    {t('use {profile}', { profile: suggestion })}
                  </button>
                )}
              </p>
            </div>
          )}

          <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn active" disabled={(!canKeys && !canCluster) || !!busy} onClick={apply}>
              {busy === 'keys' ? t('saving keys...')
                : busy === 'cluster' ? t('registering cluster...')
                : canKeys && canCluster ? t('save keys and register cluster')
                : canKeys ? t('save keys to the profile')
                : canCluster ? t('register cluster in the kubeconfig')
                : t('paste something above')}
            </button>
            {busy && <span className="spinner" />}
            {!canKeys && !canCluster && pasted && (
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                {t('missing profile+keys, or cluster+region')}
              </span>
            )}
          </div>

          {results.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              {results.map((r, i) => (
                <div key={i} className="mono" style={{ color: r.ok ? 'var(--ok)' : 'var(--error)', marginBottom: 3 }}>
                  {r.ok ? '✓' : '✗'} {r.text}
                </div>
              ))}
            </div>
          )}

          <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 0, marginTop: 14, maxWidth: 760 }}>
            {t('The keys go to ~/.aws/credentials with mode 600 and a backup of the previous file, and they never come back through the API once saved - so to change them, paste again. Registering the cluster runs aws eks update-kubeconfig, which writes only to your ~/.kube/config (with backup): nothing is changed inside the cluster.')}
          </p>
        </div>
      </Block>
    </div>
  )
}

/* ----------------------------------------------------- page */
export function Credentials({ ctx }) {
  const { data, error, reload } = useApi('aws', {})
  const [status, setStatus] = useState({})
  const [testing, setTesting] = useState('')
  const [login, setLogin] = useState(null)
  const [notice, setNotice] = useState(null)
  // {name} instead of a string: clicking the same profile again must fire the effect
  const [target, setTarget] = useState(null)

  const test = async (profile) => {
    setTesting(profile)
    try {
      const s = await fetchJson('aws/status', { profile })
      setStatus((p) => ({ ...p, [profile]: s }))
    } catch (e) {
      setStatus((p) => ({ ...p, [profile]: { valid: false, reason: e.message } }))
    }
    setTesting('')
  }

  const link = async (context, profile) => {
    try {
      await postJson('aws/link', { context, profile })
      setNotice({ ok: true, text: profile
        ? t('profile {profile} linked (applies to every context of the same cluster)', { profile })
        : t('link removed from {context}', { context }) })
      reload()
      if (profile) test(profile)
    } catch (e) { setNotice({ ok: false, text: e.message }) }
  }

  useEffect(() => {
    // test the already linked profiles on its own, so the screen opens informative
    if (!data) return
    const linked = [...new Set((data.contexts || []).filter((c) => c.profile).map((c) => c.profile))]
    linked.forEach((p) => { if (!status[p]) test(p) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading text={t('reading ~/.aws')} />

  const profiles = data.profiles || []
  const usingAws = (data.contexts || []).filter((c) => c.uses_aws)
  const unlinked = usingAws.filter((c) => !c.profile).length

  const sessionBadge = (s) => (s.valid ? <Badge kind="ok">{t('valid')}</Badge> : <Badge kind="bad">{s.reason}</Badge>)

  return (
    <>
      {data.aws_available === false && (
        <div className="notice">
          <h3>{t('AWS CLI not found')}</h3>
          <p>{t('Install the AWS CLI v2 to test sessions, log in with SSO and register EKS clusters.')}</p>
        </div>
      )}

      <div className="notice info">
        <h3>{t('One credential per cluster, no clash between environments')}</h3>
        <p>
          {t('Your kubeconfig calls aws eks get-token without saying which profile to use, so it takes whatever AWS_PROFILE is exported in the shell. That is why staging and production get in each other’s way. Link the profile here and Kube Deck injects the right credential in every call to that cluster, ignoring whatever is loose in the environment.')}
        </p>
      </div>

      {notice && (
        <div className="notice" style={{ borderLeftColor: notice.ok ? 'var(--ok)' : 'var(--error)' }}>
          <h3>{notice.ok ? t('Done') : t('It did not work')}</h3>
          <p>{notice.text}</p>
        </div>
      )}

      <Block title={t('Clusters and credentials')}
             count={unlinked ? t('{n} without a linked profile', { n: unlinked }) : t('all linked')}>
        <table>
          <thead>
            <tr>
              <th>{t('cluster (context)')}</th><th>{t('aws account')}</th><th>{t('profile used')}</th>
              <th>{t('session')}</th><th>{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {usingAws.map((c) => {
              const s = c.profile ? status[c.profile] : null
              const suggested = c.suggested || []
              return (
                <tr key={c.context} className={c.context === ctx ? 'current' : ''}>
                  <td className="mono truncate" title={c.context}>{c.context}</td>
                  <td className="mono">{c.account || '-'}</td>
                  <td>
                    <select className="field" value={c.profile || ''}
                            onChange={(e) => link(c.context, e.target.value)}>
                      <option value="">{t('(uses the one from the shell)')}</option>
                      {suggested.length > 0 && (
                        <optgroup label={t('same aws account')}>
                          {suggested.map((p) => <option key={p} value={p}>{p}</option>)}
                        </optgroup>
                      )}
                      <optgroup label={t('all profiles')}>
                        {profiles.filter((p) => !suggested.includes(p.name))
                          .map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                      </optgroup>
                    </select>
                  </td>
                  <td>
                    {!c.profile ? <Badge kind="neutral">{t('not linked')}</Badge>
                      : testing === c.profile ? <span className="spinner" />
                      : s ? sessionBadge(s)
                      : <Badge kind="neutral">{t('not tested')}</Badge>}
                  </td>
                  <td>
                    {c.profile && (
                      <>
                        <button className="btn" onClick={() => test(c.profile)}>{t('test')}</button>{' '}
                        <button className="btn active" onClick={() => setLogin(c.profile)}>{t('SSO login')}</button>
                      </>
                    )}
                    {!c.profile && suggested[0] && (
                      <button className="btn active" onClick={() => link(c.context, suggested[0])}>
                        {t('link {profile}', { profile: suggested[0] })}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Block>

      <Block title={t('Profiles in ~/.aws')} count={profiles.length}>
        <table>
          <thead><tr><th>{t('profile')}</th><th>{t('type')}</th><th>{t('account')}</th><th>role</th><th>{t('region')}</th><th>{t('session')}</th><th></th></tr></thead>
          <tbody>
            {profiles.map((p) => {
              const s = status[p.name]
              return (
                <tr key={p.name}>
                  <td className="mono">{p.name}</td>
                  <td><Badge kind={p.type === 'sso' ? 'info' : 'neutral'}>{p.type}</Badge></td>
                  <td className="mono">{p.account || '-'}</td>
                  <td>{p.role || '-'}</td>
                  <td>{p.region || '-'}</td>
                  <td>
                    {testing === p.name ? <span className="spinner" />
                      : s ? sessionBadge(s)
                      : <span style={{ color: 'var(--muted)' }}>-</span>}
                  </td>
                  <td>
                    <button className="btn" onClick={() => test(p.name)}>{t('test')}</button>{' '}
                    {p.type === 'sso' && <button className="btn" onClick={() => setLogin(p.name)}>{t('SSO login')}</button>}{' '}
                    <button className="btn" onClick={() => setTarget({ name: p.name })}>{t('change keys')}</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Block>

      <Injector profiles={profiles.map((p) => p.name)} target={target}
                onSave={() => { reload(); if (target?.name) test(target.name) }} />

      {login && (
        <LoginWindow profile={login} onClose={() => setLogin(null)}
                     onDone={(d) => { setStatus((p) => ({ ...p, [login]: d.status })); reload() }} />
      )}
    </>
  )
}
