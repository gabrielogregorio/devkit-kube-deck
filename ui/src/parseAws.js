/* =======================================================================
   Parser for what you paste from AWS.
   Copy from the console/CLI as it comes and it extracts the values:
   export block, .ini, the `aws eks update-kubeconfig` command, or all of it.
   No React on purpose - it is tested directly with vitest.
   ======================================================================= */
const RE_QUOTES = /^(['"])([\s\S]*)\1$/

const unquote = (v) => {
  const m = String(v).trim().match(RE_QUOTES)
  return (m ? m[2] : String(v).trim()).replace(/[;,]+$/, '').trim()
}

/** value of a variable, in any of the formats AWS hands out:
 *  export X="v" | set X=v | $Env:X="v" | X=v | aws_access_key_id = v | "X": "v" */
export function envValue(txt, name) {
  const re = new RegExp(
    String.raw`(?:^|[\s;{,"])(?:export\s+|set\s+|setx\s+|\$env:)?` +
    name + String.raw`"?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)`, 'im')
  const m = txt.match(re)
  return m ? unquote(m[1]) : ''
}

/** value of a flag: --region us-west-2 or --region=us-west-2 */
export function flagValue(txt, name) {
  const m = txt.match(new RegExp(
    String.raw`--${name}[=\s]+("[^"]*"|'[^']*'|[^\s'"\\]+)`, 'i'))
  return m ? unquote(m[1]) : ''
}

export function parsePaste(txt) {
  const t = txt || ''
  // .ini header: [name], [profile name] or [111122223333_MyEKSReadRole]
  const section = (t.match(/^\s*\[([^\]\n]+)\]\s*$/m) || [])[1] || ''
  const iniProfile = section.trim().replace(/^profile\s+/i, '')
  const role = flagValue(t, 'role-arn') || envValue(t, 'AWS_ROLE_ARN')
  const account = (role.match(/iam::(\d{12}):/) || [])[1] ||
                (iniProfile.match(/(?:^|\D)(\d{12})(?!\d)/) || [])[1] || ''
  // when the paste only has keys + command, there is no profile name anywhere.
  // we suggest one in the Identity Center format, but do NOT fill it on our
  // own: saving a key to a profile the user did not choose is a bad surprise
  const roleName = (role.match(/:role\/(?:.*\/)?([A-Za-z0-9+=,.@_-]+)$/) || [])[1] || ''
  return {
    suggested_profile: (!iniProfile && account && roleName) ? `${account}_${roleName}` : '',
    access_key: envValue(t, 'AWS_ACCESS_KEY_ID'),
    secret_key: envValue(t, 'AWS_SECRET_ACCESS_KEY'),
    session_token: envValue(t, 'AWS_SESSION_TOKEN'),
    region: flagValue(t, 'region') || envValue(t, 'AWS_DEFAULT_REGION') || envValue(t, 'AWS_REGION'),
    cluster: flagValue(t, 'name') || flagValue(t, 'cluster-name'),
    role_arn: role,
    alias: flagValue(t, 'alias'),
    profile: flagValue(t, 'profile') || envValue(t, 'AWS_PROFILE') || iniProfile,
    account,
  }
}
