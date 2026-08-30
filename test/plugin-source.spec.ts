import { describe, expect, it } from 'vitest'
import { gitRepositoryWebUrl } from '../src/shared/plugin-source.js'

describe('gitRepositoryWebUrl', () => {
  it('converts package-manager GitHub sources into repository web addresses', () => {
    expect(gitRepositoryWebUrl('github:mexiaosqwq/dsh-web-mobile'))
      .toBe('https://github.com/mexiaosqwq/dsh-web-mobile')
    expect(gitRepositoryWebUrl('mexiaosqwq/dsh-web-mobile#main'))
      .toBe('https://github.com/mexiaosqwq/dsh-web-mobile')
  })

  it('normalizes HTTPS and SSH Git URLs', () => {
    expect(gitRepositoryWebUrl('git+https://github.com/mexiaosqwq/dsh-web-mobile.git#v2.1.1'))
      .toBe('https://github.com/mexiaosqwq/dsh-web-mobile')
    expect(gitRepositoryWebUrl('git@github.com:mexiaosqwq/dsh-web-mobile.git'))
      .toBe('https://github.com/mexiaosqwq/dsh-web-mobile')
    expect(gitRepositoryWebUrl('git+ssh://git@github.com/mexiaosqwq/dsh-web-mobile.git#main'))
      .toBe('https://github.com/mexiaosqwq/dsh-web-mobile')
  })

  it('keeps an unknown source unchanged', () => {
    expect(gitRepositoryWebUrl('not a repository')).toBe('not a repository')
  })
})
