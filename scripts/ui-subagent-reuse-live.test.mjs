// Synthetic component regression: ordinary child reuse via ask_agent.
// Render/effect/notification semantics mirror the host contract, without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {build} from 'esbuild';

const bundle=await build({entryPoints:['src/client/native-flow.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};
new Function('require','module','exports',bundle.outputFiles[0].text)(name=>name==='react'?React:{MarkdownText:()=>null},mod,mod.exports);

function createRenderer(root) {
  const instances=new Map(), dispatcher=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const equal=(a,b)=>a && b && a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
  let dirty=true,tree,renders=0;
  const invalidate=()=>{dirty=true;};
  function renderOnce() {
    dirty=false;renders++;
    const previous=dispatcher.current,visited=new Set(),effects=[];
    function walk(value,path) {
      if(value==null||typeof value==='boolean')return null;
      if(Array.isArray(value))return value.map((v,i)=>walk(v,`${path}/${v?.key ?? i}`)).filter(v=>v!=null);
      if(typeof value==='string'||typeof value==='number')return value;
      if(value.type===React.Fragment)return walk(value.props.children,`${path}/fragment`);
      if(typeof value.type==='function'){
        const key=`${path}/${value.type.name}:${value.key??''}`;visited.add(key);
        let slots=instances.get(key);if(!slots)instances.set(key,slots=[]);
        let cursor=0;
        const memo=(fn,deps)=>{const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value;};
        const effect=(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||!equal(old.deps,deps)){const slot={deps,cleanup:old?.cleanup};slots[i]=slot;effects.push(()=>{slot.cleanup?.();slot.cleanup=fn()||undefined;});}};
        dispatcher.current={
          useState(initial){const i=cursor++;if(!(i in slots))slots[i]={value:typeof initial==='function'?initial():initial};const slot=slots[i];return [slot.value,next=>{const v=typeof next==='function'?next(slot.value):next;if(!Object.is(v,slot.value)){slot.value=v;invalidate();}}];},
          useMemo:memo,useCallback(fn,deps){return memo(()=>fn,deps);},
          useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},
          useEffect:effect,useLayoutEffect:effect,
          useSyncExternalStore(subscribe,getSnapshot){const i=cursor++,old=slots[i];if(!old||old.subscribe!==subscribe||old.getSnapshot!==getSnapshot){const slot={subscribe,getSnapshot,cleanup:old?.cleanup};slots[i]=slot;effects.push(()=>{slot.cleanup?.();slot.cleanup=subscribe(invalidate);});}return getSnapshot();},
        };
        return walk(value.type(value.props),`${key}/out`);
      }
      return {type:value.type,props:value.props,children:walk(value.props.children,`${path}/children`)};
    }
    try{tree=walk(root(),'root');}finally{dispatcher.current=previous;}
    for(const [key,slots] of instances)if(!visited.has(key)){for(const slot of slots)slot?.cleanup?.();instances.delete(key);}
    for(const run of effects)run();
  }
  return {invalidate,flush(){let n=0;while(dirty){assert.ok(++n<50,'render/effect loop');renderOnce();}return tree;},get renders(){return renders;},unmount(){for(const slots of instances.values())for(const slot of slots)slot?.cleanup?.();instances.clear();dirty=false;}};
}
function source(){let rows=[];const listeners=new Set();return {getSnapshot:()=>rows,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},publish(next){rows=next;for(const fn of [...listeners])fn();},get listeners(){return listeners.size;}};}
const closed=(turn,start,end)=>({turn,status:'closed',start:{time:start},end:{time:end},steps:[],data:{}});
const args=id=>({text:key=>{assert.notEqual(key,'message','message body must not be read');return key==='agent_id'?id:undefined;}});
const start=id=>({root:{phase:'start',name:'ask_agent',callId:'ask',turn:2,step:1,time:210,args:args(id),argsRaw:JSON.stringify({agent_id:id}),subCalls:[]}});
const result=(id,{error=false,head=true}={})=>({root:{kind:'tool-result',seq:1,time:240,callId:'ask',name:'ask_agent',args:args(id),call:head?{name:'ask_agent',argsRaw:JSON.stringify({agent_id:id})}:null,callTime:210,isError:error,content:[{type:'text',text:'synthetic response'}],subCalls:[]}});
const teamSend=()=>({root:{kind:'tool-result',name:'send_message',call:{name:'send_message',argsRaw:'{"target":"teammate"}'},callTime:210,args:{text:key=>key==='target'?'teammate':undefined},isError:false,content:[{type:'text',text:'{"sent":true}'}],subCalls:[]}});
function flatten(value,out=[]){if(!value||typeof value!=='object')return out;if(Array.isArray(value)){value.forEach(v=>flatten(v,out));return out;}out.push(value);flatten(value.children,out);return out;}
function badges(tree){const result=new Map();for(const row of flatten(tree).filter(v=>v.props?.['data-chat-turn']!==undefined)){const turn=row.props['data-chat-turn'],found=flatten(row).filter(v=>v.props?.['data-sl-agent-badges']!==undefined);assert.ok(found.length<=1,`duplicate badge in turn ${turn}`);if(found.length){assert.ok(!result.has(turn),`duplicate carrier in turn ${turn}`);result.set(turn,{label:found[0].props['aria-label'],icons:flatten(found[0]).filter(v=>v.type==='svg').map(v=>v.props.className)});}}return result;}
function fixture(){
  const turns=[closed(1,100,190),closed(2,200,290)];
  function chat(id){const backing=new Map(),sources=new Map(),entries=[];for(const t of turns){const key=`${id}-${t.turn}`;entries.push({kind:'node',key});backing.set(key,{kind:'turn-process',location:{kind:'turn',turn:t},data:{turn:t.turn,toolCallCount:1}});sources.set(t.turn,source());}return {sources,entries,nodes:{get:key=>backing.get(key),values:()=>[...backing.values()],turnDataSource:(turn,kind)=>{assert.equal(kind,'tool-call');return sources.get(turn);}},timeline:{turns:new Map(turns.map(t=>[t.turn,t])),turnOrder:turns.map(t=>t.turn)}};}
  const chats={one:chat('one'),two:chat('two')};let sessionId='one';
  const prior={running:false,projectionValues:{subagentTiming:{lastTurnCompleted:true},turnOutline:[{turn:1}]}};
  let sessions={byId:{one:{title:'One'},two:{title:'Two'},old:prior,fresh:prior,team:prior},projectionsBySession:{one:{values:{subagentCatalog:[{id:'old',label:'worker',mode:'continuable',createdAt:120}]}},two:{values:{subagentCatalog:[]}}}};
  const flow={NativeFlow:()=>null,pendingInputs:[],lastInputTurn:0,useChat:selector=>selector({nodes:chats[sessionId].nodes,timeline:chats[sessionId].timeline}),useSessions:selector=>selector(sessions),useChatNode:(key,selector=x=>x)=>selector(chats[sessionId].nodes.get(key)),useChatGroup:()=>undefined,usePresentation:selector=>selector({foldCompletedTurns:true,stepGrouping:'collapsed'})};
  const root=()=>React.createElement(mod.exports.NativeFlowAdapter,{...flow,sessionId,entries:chats[sessionId].entries});let renderer=createRenderer(root);
  const values=(id,next)=>{const prev=sessions.projectionsBySession[id]?.values??{};sessions={...sessions,projectionsBySession:{...sessions.projectionsBySession,[id]:{values:{...prev,...next}}}};renderer.invalidate();};
  return {chats,
    catalog(id,list){values(id,{subagentCatalog:list});},
    roster(id){values(id,{agentTeam:{members:[{id:'team',name:'teammate',role:'teammate',phase:'active'}]}});},
    status(id,running,since=225){sessions={...sessions,byId:{...sessions.byId,[id]:{running,projectionValues:{subagentTiming:{lastTurnCompleted:true,...(running?{active:{since,through:since}}:{})},turnOutline:[{turn:1},{turn:2}]}}}};renderer.invalidate();},
    switchTo(id){sessionId=id;renderer.invalidate();},refresh(){renderer.unmount();renderer=createRenderer(root);},
    view(){return badges(renderer.flush());},get renders(){return renderer.renders;},close(){renderer.unmount();}};
}
function state(map,turn,kind){const item=map.get(turn);assert.ok(item,`expected badge in turn ${turn}`);assert.equal(item.icons.length,1);assert.ok(item.icons[0].includes(`--${kind}`),`${turn}: ${item.icons[0]} should be ${kind}`);assert.match(item.label,/本轮 1 个 agent/);}

test('live ordinary ask_agent reuse stays in its turn after completion and refresh',()=>{
  const f=fixture();try{
    let v=f.view();assert.deepEqual([...v.keys()],[1]);
    const src=f.chats.one.sources.get(2),before=f.renders;
    f.status('old',true);src.publish([start('old')]);
    v=f.view();assert.ok(f.renders>before,'source or child update must render');assert.deepEqual([...v.keys()],[1,2]);state(v,2,'running');state(v,1,'idle');
    src.publish([result('old'),result('old')]);f.status('old',false);
    v=f.view();assert.deepEqual([...v.keys()],[1,2]);state(v,2,'idle');
    f.refresh();v=f.view();state(v,2,'idle');assert.equal(src.listeners,1,'refresh cleans up the old source subscription');
    // Failure, truncated call head and non-direct-child ids cannot create a turn-2 badge.
    src.publish([result('old',{error:true}),result('old',{head:false}),result('stranger')]);
    v=f.view();assert.deepEqual([...v.keys()],[1]);
  }finally{f.close();}
});

test('same-label new and reused children dedupe without crossing sessions or breaking Team sends',()=>{
  const f=fixture();try{
    f.catalog('one',[{id:'old',label:'worker',mode:'continuable',createdAt:120},{id:'fresh',label:'worker',mode:'continuable',createdAt:220}]);
    const first=f.chats.one.sources.get(2);first.publish([result('old'),result('old')]);
    let v=f.view();assert.deepEqual([...v.keys()],[1,2]);state(v,2,'idle');
    f.roster('one');first.publish([result('old'),teamSend()]);v=f.view();
    assert.deepEqual([...v.keys()],[1,2]);assert.match(v.get(2).label,/本轮 2 个 agent/,'one ordinary label plus one teammate');
    f.switchTo('two');v=f.view();assert.equal(v.size,0,'other session has no inherited catalog or roster');
    f.chats.two.sources.get(2).publish([result('old')]);assert.equal(f.view().size,0,'old child is not direct to other session');
    assert.equal(first.listeners,0,'old session source unsubscribed');
    f.switchTo('one');v=f.view();assert.match(v.get(2).label,/本轮 2 个 agent/);
  }finally{f.close();}
});
