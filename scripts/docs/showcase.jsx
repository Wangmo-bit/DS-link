// Documentation fixture, never mounted in DSH. Product components/CSS are
// reused with fictional content and an explicitly labelled mock Host shell.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBubble, CopyMessage } from '../../src/client/chat-ui.jsx';
import { SenderCardLayout } from '../../src/client/outgoing-cards.jsx';
import { SessionLinkCardLayout } from '../../src/client/incoming-cards.jsx';
import { SettingsForm } from '../../src/client/index.jsx';
import { setI18nLocale, retranslateDocument } from '../../src/client/i18n.js';
import { CARD_CSS } from '../../src/client/card-shell.mjs';
import bubbleCSS from '../../src/client/chat-skin.css';
import panelCSS from '../../src/client/style.css';
import { createQuoteMessageAction } from '../../src/client/message-quote-action.jsx';
const lang = new URLSearchParams(location.search).get('lang') || 'zh';
const english = lang === 'en';
const t = (zh, en) => english ? en : zh;
setI18nLocale(lang);
const product = t('产品讨论', 'Product discussion'), dev = t('开发伙伴', 'Development');
const request = t('和产品讨论确认一下：第一版先做周报导出，还是先做搜索？确认后继续。', 'Ask Product discussion whether the first version should start with weekly-report export or search. Then continue.');
const answer = t('产品会话确认：第一版先做周报导出，搜索留到下一版。\n\n我会按这个范围继续，先给你一份可以检查的导出结果。', 'Product discussion confirmed: start with weekly-report export; leave search for the next version.\n\nI will continue within that scope and bring back an export you can review.');
const sourceText = t('第一版先做周报导出。保留日期、进展和待确认事项，搜索放到下一版。', 'Start with weekly-report export. Keep dates, progress and open questions. Search comes next.');
const status = t('已进入上下文', 'Received into context');
const Stamp = () => <span className="sl-chat-summary">{t('耗时 18 秒 · 2 次思考 · 3 次工具', '18 s · 2 thoughts · 3 tools')}</span>;
const Badge = () => <span className="demo-agent" title={t('1 个 Agent，已完成 1 个；合成状态', '1 agent, 1 completed; synthetic state')}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="8" cy="4" r="2.2"/><path d="M3.5 14v-2.5a4.5 4.5 0 0 1 9 0V14"/></svg></span>;
const closing = { finalNode: { messageId: 'demo-message' }, blocks: [{ kind: 'text', text: answer }] };
const QuoteAction = createQuoteMessageAction();
function App() {
  const [scene, setScene] = useState('bubble'), [stage, setStage] = useState(2), [quote, setQuote] = useState(''), [exchange, setExchange] = useState(false);
  window.showcase = { setScene, setStage, setQuote, setExchange };
  const footer = <footer className="demo-actions"><CopyMessage text={answer}/><QuoteAction messageId="demo-message" useChat={selector => selector({ nodes: new Map([['tail', { data: { closing } }]]) })} inputActions={{ insertQuote: value => { setQuote(value); return true; } }}/><span className="demo-muted">{t('引用后，接着输入你的回复', 'Quote, then type your reply')}</span></footer>;
  const capsule = (received = false) => <div className="sl-chat-event" data-session-link-notice=""><button className="sl-exchange-link" onClick={() => setExchange(!exchange)}>{received ? t('收到消息，来自 产品讨论', 'Message received from Product discussion') : t('已发消息给 产品讨论', 'Message sent to Product discussion')}{!received && <span className="sl-delivery-indicator sl-delivery-indicator--received">✓</span>}</button></div>;
  const senderData = { from: 'demo-development', fromDisplay: dev, to: ['demo-product'], toDisplay: [product], subject: t('确认第一版范围', 'Confirm first-version scope'), status: '已进入上下文', text: sourceText, tool: 'session_link_send', callId: 'demo-call', kind: 'request' };
  return <main key={scene} id="capture" data-session-link-i18n-root="">
    <div className="demo-header"><div><span className="demo-brand">Session Link</span><span className="demo-section">{scene === 'settings' ? t('简单设置，按需调整', 'Simple settings, your way') : scene === 'card' ? t('卡片模式 · 过程与细节', 'Card mode · process and detail') : t('气泡模式 · 轻松交流', 'Bubble mode · less noise')}</span></div><span className="demo-label">{t('合成界面演示', 'Synthetic UI fixture')}</span></div>
    {scene === 'settings' ? <section className="demo-settings sl-section"><SettingsForm snapshot={{ settingsRevision: 1, settings: { enabled: true, paused: false, maxConcurrent: 3, requestTimeoutMs: 1800000, retentionDays: 30 } }} writable busy={false} save={async () => ({ ok: true })}/></section> : <section className="demo-chat">
      <MessageBubble author={t('我', 'You')} direction="sent" text={request}/>
      {scene === 'card' ? <>
        <div className="demo-native"><span>{t('宿主过程（演示占位）', 'Host process (fixture stand-in)')}</span><p>{t('思考 · 确认需求范围', 'Thinking · confirm scope')}</p><p>session_link_send → {product}</p></div>
        <SenderCardLayout data={senderData} open={false}/>
        <SessionLinkCardLayout data={{ fromDisplay: product, toDisplay: dev, senderSessionId: 'demo-product', subject: t('范围已确认', 'Scope confirmed'), text: sourceText, row: { id: 'demo-reply', kind: 'reply', status: 'accepted', replyStatus: 'received', receipt: { state: 'received' } } }} open body={{ phase: 'available', body: sourceText }}/>
        <MessageBubble author={dev} text={answer}/>
      </> : <>
        {stage >= 0 && capsule()}
        {stage >= 1 && capsule(true)}
        {exchange && <aside className="demo-exchange"><b>{t('双方往返 · 合成示例', 'Exchange · synthetic example')}</b><p>{sourceText}</p><button onClick={() => setExchange(false)}>{t('关闭', 'Close')}</button></aside>}
        {stage >= 2 && <><MessageBubble author={dev} text={answer} heading={<span className="demo-summary"><Stamp/><Badge/></span>}/>{footer}</>}
        {scene === 'quote' && <div className="demo-composer"><div className="demo-quote">❝ {quote || answer.split('\n')[0]}</div><div>{t('那就先按这个范围做。', 'Yes, proceed with that scope.')}</div><small>{t('输入框示意 · 不会发送', 'Composer stand-in · does not send')}</small></div>}
      </>}
    </section>}
    <div className="demo-foot">{t('虚构会话与内容 · 使用产品组件和样式，宿主区域为演示替身 · 非端到端验收', 'Fictional content · product components and CSS, mock Host shell · not an end-to-end test')}</div>
  </main>;
}
const style = document.createElement('style');
style.textContent = panelCSS + CARD_CSS + bubbleCSS + `
*{box-sizing:border-box}body{--dsw-alias-bg-layer-1:#24262c;--dsw-alias-label-primary:#edf0f5;--dsw-alias-label-secondary:#a2a9b7;--dsw-alias-border-l1:#3a3e48;--dsw-alias-brand-primary:#8cacff;margin:0;background:#131416;color:#edf0f5;font:15px/1.65 system-ui,"Noto Sans CJK SC",sans-serif}button,input{font:inherit}#capture{padding:32px 40px 22px;width:1100px;background:#131416}.demo-header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #30333b;padding-bottom:20px;margin-bottom:24px}.demo-brand{font-size:25px;font-weight:700;letter-spacing:-.8px}.demo-section{margin-left:20px;color:#a2a9b7;font-size:14px}.demo-label{color:#a2a9b7;font-size:11px;border:1px solid #3a3e48;border-radius:20px;padding:3px 10px}.demo-chat{max-width:960px;margin:auto}.demo-summary{display:flex;align-items:center;gap:12px}.demo-agent{color:#4fb87b;display:inline-flex}.demo-actions{display:flex;align-items:center;gap:14px;color:#a2a9b7;margin:0 0 16px}.demo-muted{font-size:12px;margin-left:5px}.sl-chat-message{max-width:88%}.demo-native{border-left:2px solid #454b5b;padding:8px 14px;margin:16px 0;color:#a2a9b7;font-size:12px}.demo-native p{margin:3px 0}.demo-native>span{font-size:10px}.sl-card{margin:12px 0}.demo-settings{max-width:900px;margin:auto}.demo-foot{border-top:1px solid #30333b;margin-top:28px;padding-top:14px;color:#888e9b;font-size:10px}.demo-composer{border:1px solid #414652;border-radius:16px;padding:16px 20px;background:#24262c;margin-top:22px}.demo-quote{color:#8cacff;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:850px;margin-bottom:10px}.demo-composer small{display:block;margin-top:14px;color:#888e9b;font-size:10px}.demo-exchange{padding:18px;border:1px solid #596474;border-radius:12px;margin:14px 0;background:#24262c}.sl-chat-event{margin:12px 0}.sl-setting{font-size:13px}.sl-settings input{font-size:13px}.sl-setting small{font-size:11px}.sl-settings{gap:12px!important}.sl-chat-copy{color:#a2a9b7}.sl-message-action{opacity:1}
`;
document.head.append(style); document.body.setAttribute('data-ds-dark-theme', '');
createRoot(document.getElementById('app')).render(<App/>);
new MutationObserver(() => retranslateDocument()).observe(document.getElementById('app'), { childList: true, subtree: true });
