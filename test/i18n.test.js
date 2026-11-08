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

test('DS-link branding is consistent and local-only scope is explicit in both locales', () => {
  setI18nLocale('zh')
  assert.equal(translateText('DS-link'), 'DS-link')
  assert.equal(translateText('DS-link设置'), 'DS-link设置')
  setI18nLocale('en')
  assert.equal(translateText('DS-link'), 'DS-link')
  assert.equal(translateText('DS-link设置'), 'DS-link settings')
  assert.equal(translateText('开启DS-link'), 'Enable DS-link')
  assert.match(translateText('连接本机 DSH 会话，管理消息投递和通信记录。'), /this DSH host/)
  assert.match(translateText('DS-link已关闭；重新开启且未暂停后继续。'), /^DS-link is off/)
  setI18nLocale('zh')
})

test('en translates dynamic status terms without inventing read state', () => {
  setI18nLocale('en')
  const out = translateText('已进入上下文 · 截至 13:00')
  assert.match(out, /received into context/i)
  assert.match(out, /as of 13:00/)
  assert.doesNotMatch(out, /已进入上下文/)
  assert.equal(translateText('已排队 3 条消息。'), 'Queued 3 messages.')
  assert.equal(translateText('已恢复投递 2 条消息。'), 'Resumed delivery of 2 messages.')
  setI18nLocale('zh')
})
