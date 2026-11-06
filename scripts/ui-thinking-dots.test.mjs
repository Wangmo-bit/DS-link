import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
const output=await build({entryPoints:['src/client/chat-ui.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(name=>name==='react'?React:{MarkdownText:()=>null},mod,mod.exports);
test('thinking animation uses three fixed dots, opacity only, and respects reduced motion',async()=>{
 const tree=mod.exports.ThinkingDots(),children=React.Children.toArray(tree.props.children);
 assert.equal(tree.props['aria-hidden'],'true');assert.equal(children.length,3);assert.ok(children.every(child=>child.props.children==='·'));
 const css=await readFile(new URL('../src/client/chat-skin.css',import.meta.url),'utf8');
 assert.match(css,/@keyframes sl-thinking-pulse\s*\{[^}]*opacity/s);assert.match(css,/@media\s*\(prefers-reduced-motion:reduce\)\s*\{\s*\.sl-chat-thinking-dots\s*>\s*span\s*\{\s*animation:none/);
});
