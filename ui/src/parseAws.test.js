/* Tests for the AWS paste parser. Key values below are FAKE, they only have the right shape. */
import { describe, it, expect } from 'vitest'
import { parsePaste, envValue, flagValue } from './parseAws.js'

const ROLE = 'arn:aws:iam::111122223333:role/MyEKSReadRole'

describe('parsePaste', () => {
  it('reads update-kubeconfig + export block together (the everyday case)', () => {
    const r = parsePaste(`aws eks update-kubeconfig --region us-west-2 --name my-cluster-prod --role-arn ${ROLE}

export AWS_ACCESS_KEY_ID="ASIAZZZZZZZZEXAMPLE1"
export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
export AWS_SESSION_TOKEN="IQoJb3JpZ2luX2VjEA//////////wEaCXVzLWVhc3QtMiJH"`)
    expect(r.region).toBe('us-west-2')
    expect(r.cluster).toBe('my-cluster-prod')
    expect(r.role_arn).toBe(ROLE)
    expect(r.account).toBe('111122223333')
    expect(r.access_key).toBe('ASIAZZZZZZZZEXAMPLE1')
    expect(r.secret_key).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
    expect(r.session_token).toBe('IQoJb3JpZ2luX2VjEA//////////wEaCXVzLWVhc3QtMiJH')
  })

  it('reads exports without quotes (console style)', () => {
    const r = parsePaste(`export AWS_ACCESS_KEY_ID=ASIAZZZZZZZZEXAMPLE2
export AWS_SECRET_ACCESS_KEY=abc/def+ghi
export AWS_SESSION_TOKEN=tok123==`)
    expect(r.access_key).toBe('ASIAZZZZZZZZEXAMPLE2')
    expect(r.secret_key).toBe('abc/def+ghi')
    expect(r.session_token).toBe('tok123==')
    expect(r.cluster).toBe('')
  })

  it('reads the .ini block from the AWS console', () => {
    const r = parsePaste(`[111122223333_MyEKSReadRole]
aws_access_key_id=ASIAZZZZZZZZEXAMPLE3
aws_secret_access_key=secret/with+slash
aws_session_token=IQoJb3JpZ2luX2Vj`)
    expect(r.profile).toBe('111122223333_MyEKSReadRole')
    expect(r.account).toBe('111122223333')
    expect(r.access_key).toBe('ASIAZZZZZZZZEXAMPLE3')
    expect(r.secret_key).toBe('secret/with+slash')
    expect(r.session_token).toBe('IQoJb3JpZ2luX2Vj')
  })

  it('reads PowerShell and Windows cmd', () => {
    const ps = parsePaste(`$Env:AWS_ACCESS_KEY_ID="ASIAZZZZZZZZEXAMPLE4"
$Env:AWS_SECRET_ACCESS_KEY="ps-secret"`)
    expect(ps.access_key).toBe('ASIAZZZZZZZZEXAMPLE4')
    expect(ps.secret_key).toBe('ps-secret')
    const cmd = parsePaste(`set AWS_ACCESS_KEY_ID=ASIAZZZZZZZZEXAMPLE5
set AWS_SECRET_ACCESS_KEY=cmd-secret`)
    expect(cmd.access_key).toBe('ASIAZZZZZZZZEXAMPLE5')
    expect(cmd.secret_key).toBe('cmd-secret')
  })

  it('does not confuse SECRET_ACCESS_KEY with ACCESS_KEY_ID', () => {
    const r = parsePaste('export AWS_SECRET_ACCESS_KEY="only-the-secret"')
    expect(r.access_key).toBe('')
    expect(r.secret_key).toBe('only-the-secret')
  })

  it('reads flags with = and commands split over several lines', () => {
    const r = parsePaste(`aws eks update-kubeconfig --region=sa-east-1 \\
  --name=my-cluster --alias=short --profile=my-profile`)
    expect(r.region).toBe('sa-east-1')
    expect(r.cluster).toBe('my-cluster')
    expect(r.alias).toBe('short')
    expect(r.profile).toBe('my-profile')
  })

  it('does not keep the line continuation backslash in the value', () => {
    const r = parsePaste(`aws eks update-kubeconfig --region us-west-2 \\
  --name other-cluster`)
    expect(r.region).toBe('us-west-2')
    expect(r.cluster).toBe('other-cluster')
  })

  it('reads --cluster-name', () => {
    expect(parsePaste('aws eks update-kubeconfig --region us-west-2 --cluster-name abc').cluster).toBe('abc')
  })

  it('reads the region from environment variables', () => {
    expect(parsePaste('export AWS_DEFAULT_REGION=eu-central-1').region).toBe('eu-central-1')
    expect(parsePaste('AWS_REGION=ap-southeast-2').region).toBe('ap-southeast-2')
  })

  it('does not blow up or invent values on empty or useless input', () => {
    expect(Object.values(parsePaste('')).join('')).toBe('')
    expect(Object.values(parsePaste('good morning, there is no credential here')).join('')).toBe('')
  })

  it('suggests a profile name from the role when the paste has none', () => {
    const r = parsePaste(`aws eks update-kubeconfig --region us-west-2 --name c --role-arn ${ROLE}
export AWS_ACCESS_KEY_ID=ASIAZZZZZZZZEXAMPLEA`)
    expect(r.profile).toBe('')
    expect(r.suggested_profile).toBe('111122223333_MyEKSReadRole')
  })

  it('does not suggest when the paste already names the profile', () => {
    const r = parsePaste(`[111122223333_MyEKSReadRole]
aws_access_key_id=ASIAZZZZZZZZEXAMPLEB`)
    expect(r.suggested_profile).toBe('')
  })

  it('does not suggest without a role', () => {
    expect(parsePaste('nothing here').suggested_profile).toBe('')
  })
})

describe('envValue / flagValue', () => {
  it('reads JSON style "KEY": "value"', () => {
    expect(envValue('{"AWS_ACCESS_KEY_ID": "ASIAZZZZZZZZEXAMPLEC"}', 'AWS_ACCESS_KEY_ID')).toBe('ASIAZZZZZZZZEXAMPLEC')
  })
  it('returns an empty string when the flag is missing', () => {
    expect(flagValue('aws eks list-clusters', 'region')).toBe('')
  })
})
