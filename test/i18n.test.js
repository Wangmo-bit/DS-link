import test from 'node:test'
import assert from 'node:assert/strict'
import { translateText, setI18nLocale } from '../src/client/i18n.js'

test('zh keeps source text unchanged', () => {
  setI18nLocale('zh')
  assert.equal(translateText('发件人'), '发件人')
  assert.equal(translateText('已进入上下文 · 截至 13:00'), '已进入上下文 · 截至 13:00')
})

test('en translates exact chrome strings but leaves unknown text intact', () => {
  setI18nLocale('en')
  assert.equal(translateText('发件人'), 'Sender')
  assert.equal(translateText('查看轨迹'), 'View trace')
  assert.equal(translateText('技术详情'), 'Technical details')
  assert.equal(translateText('ABC 完全自定义文案'), 'ABC 完全自定义文案')
})

test('en translates dynamic status terms without inventing read state', () => {
  setI18nLocale('en')
  const out = translateText('已进入上下文 · 截至 13:00')
  assert.match(out, /received into context/i)
  assert.match(out, /as of 13:00/)
  assert.doesNotMatch(out, /已进入上下文/)
  setI18nLocale('zh')
})
