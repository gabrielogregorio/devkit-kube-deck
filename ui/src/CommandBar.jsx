import { useEffect, useState, useSyncExternalStore } from 'react'
import { subscribeCmds, readCmds, clearCmds } from './api'
import { t } from './i18n'

const STORE_KEY = 'kd:cmds'

function loadOpen() {
  try { return localStorage.getItem(STORE_KEY) === '1' } catch { return false }
}

function copyText(txt, setOk) {
  const done = () => { setOk(true); setTimeout(() => setOk(false), 1400) }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(txt).then(done, done)
  else {
    const area = document.createElement('textarea')
    area.value = txt; document.body.appendChild(area); area.select()
    try { document.execCommand('copy') } catch { /* nothing */ }
    document.body.removeChild(area); done()
  }
}

function Line({ cmd }) {
  const [ok, setOk] = useState(false)
  return (
    <div className="cmd-line">
      <code onClick={(e) => {
        const r = document.createRange(); r.selectNodeContents(e.currentTarget)
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
      }} title={t('click to select all')}>{cmd}</code>
      <button className="btn" onClick={() => copyText(cmd, setOk)}>{ok ? t('copied') : t('copy')}</button>
    </div>
  )
}

export function CommandBar() {
  const entries = useSyncExternalStore(subscribeCmds, readCmds, readCmds)
  const [open, setOpen] = useState(loadOpen)
  const [okAll, setOkAll] = useState(false)
  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, open ? '1' : '0') } catch { /* storage blocked */ }
  }, [open])

  const all = entries.flatMap(([, l]) => l)
  const unique = [...new Set(all)]

  return (
    <aside className={`cmdbar${open ? ' open' : ''}`}>
      <header onClick={() => setOpen(!open)}>
        <span className="mono" style={{ color: 'var(--accent)' }}>$</span>
        <b>{t('commands behind this screen')}</b>
        <span className="count">{unique.length}</span>
        <span className="spacer" />
        {open && unique.length > 0 && (
          <button className="btn" onClick={(e) => { e.stopPropagation(); copyText(unique.join('\n'), setOkAll) }}>
            {okAll ? t('copied') : t('copy all')}
          </button>
        )}
        {open && (
          <button className="btn" onClick={(e) => { e.stopPropagation(); clearCmds() }}>{t('clear')}</button>
        )}
        <button className="btn">{open ? `${t('hide')} ▾` : `${t('show')} ▴`}</button>
      </header>
      {open && (
        <div className="cmdbar-body">
          {unique.length === 0
            ? <div style={{ color: 'var(--muted)', padding: '6px 2px' }}>{t('nothing queried yet')}</div>
            : entries.map(([route, list]) => (
              <div key={route} className="cmd-group">
                <div className="cmd-route">/{route}</div>
                {list.map((c) => <Line key={c} cmd={c} />)}
              </div>
            ))}
        </div>
      )}
    </aside>
  )
}
