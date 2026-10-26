import { expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface ObservedBridgeMessage {
  type?: string;
  requestId?: string;
  sessionId?: string;
  event?: {
    type?: string;
    usage?: { input?: number; contextWindow?: number };
    message?: { content?: Array<{ type?: string; text?: string }> };
  };
}

it('resumes an ACP session and keeps idle replay out of two permissioned prompt turns', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'robb-vibe-public-protocol-'));
  const executable = join(directory, 'vibe-acp');
  const protocolLog = join(directory, 'protocol.jsonl');
  writeFileSync(executable, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = value => appendFileSync(${JSON.stringify(protocolLog)}, JSON.stringify(value) + '\\n');
const send = value => console.log(JSON.stringify(value));
const update = (sessionId, value) => send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:value}});
const pending = new Map();
let turn = 0;
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 const message = JSON.parse(line);
 log(message);
 if(message.method==='initialize')send({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 else if(message.method==='session/load'){
  send({jsonrpc:'2.0',id:message.id,result:{}});
  setTimeout(()=>{
   update('persisted-qa-session',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'idle replay must stay outside the next turn'}});
   log({marker:'idle-replay-sent'});
  },20);
 }else if(message.method==='session/new')send({jsonrpc:'2.0',id:message.id,result:{sessionId:'unexpected-new-session'}});
 else if(message.method==='session/prompt'){
  const number=++turn,permissionId='permission-'+number;
  pending.set(permissionId,{promptId:message.id,number,sessionId:message.params.sessionId});
  send({jsonrpc:'2.0',id:permissionId,method:'session/request_permission',params:{
   sessionId:message.params.sessionId,
   toolCall:{toolCallId:'qa-read-'+number,title:'qa_read_only',kind:'read',status:'pending',rawInput:{path:'/qa-only/fixture'}},
   options:[{optionId:'allow-once',name:'Allow once',kind:'allow_once'},{optionId:'reject-once',name:'Reject once',kind:'reject_once'}]
  }});
 }else if(pending.has(message.id)){
  const {promptId,number,sessionId}=pending.get(message.id);pending.delete(message.id);
  update('another-qa-session',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'wrong session'}});
  update(sessionId,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'QA thought'}});
  update(sessionId,{sessionUpdate:'tool_call',toolCallId:'qa-read-'+number,title:'qa_read_only',kind:'read',status:'in_progress',rawInput:{path:'/qa-only/fixture'}});
  update(sessionId,{sessionUpdate:'tool_call_update',toolCallId:'qa-read-'+number,status:'completed',rawOutput:'QA fixture read'});
  update(sessionId,{sessionUpdate:'agent_message_chunk',messageId:'qa-message-'+number,content:{type:'text',text:'fresh turn '+number}});
  update(sessionId,{sessionUpdate:'usage_update',used:17,size:1000});
  send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});
 }
});
`);
  chmodSync(executable, 0o755);
  const child = spawn(process.execPath, ['src/vibe-acp-server.ts'], {
    cwd: join(import.meta.dir, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { HOME: directory, PATH: process.env.PATH, ROBB_VIBE_ACP_COMMAND: executable },
  });
  const output: ObservedBridgeMessage[] = [];
  let diagnostic = '';
  child.stderr!.on('data', chunk => { diagnostic += String(chunk); });
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const send = (message: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  lines.on('line', line => {
    const message = JSON.parse(line) as ObservedBridgeMessage;
    output.push(message);
    if (message.type === 'pre_tool_use_request' && message.requestId) {
      send({ type: 'pre_tool_use_response', requestId: message.requestId, action: 'allow' });
    }
  });
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`ACP fixture timed out: ${JSON.stringify(output)} ${diagnostic}`);
      await Bun.sleep(10);
    }
  };
  const protocol = (): Array<Record<string, unknown> & { params?: { sessionId?: string } }> => existsSync(protocolLog)
    ? readFileSync(protocolLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  try {
    send({ type: 'init', cwd: directory, sdkSessionId: 'persisted-qa-session', model: 'pi/mistral-vibe' });
    await waitFor(() => output.some(message => message.type === 'ready'));
    expect(output.find(message => message.type === 'ready')?.sessionId).toBe('persisted-qa-session');
    await waitFor(() => protocol().some(message => message.marker === 'idle-replay-sent'));
    for (const number of [1, 2]) {
      send({ type: 'prompt', id: `qa-turn-${number}`, message: `QA prompt ${number}` });
      await waitFor(() => output.filter(message => message.event?.type === 'agent_end').length === number);
      const completed = output.filter(message => message.event?.type === 'message_end');
      expect(completed[number - 1]?.event?.message?.content).toEqual([{ type: 'text', text: `fresh turn ${number}` }]);
    }
    const calls = protocol();
    expect(calls.filter(message => message.method === 'session/load')).toHaveLength(1);
    expect(calls.some(message => message.method === 'session/new')).toBe(false);
    expect(calls.filter(message => message.method === 'session/prompt').map(message => message.params?.sessionId)).toEqual(['persisted-qa-session', 'persisted-qa-session']);
    expect(output.filter(message => message.type === 'provider_handoff')).toHaveLength(2);
    expect(output.filter(message => message.event?.type === 'tool_execution_start')).toHaveLength(2);
    expect(output.filter(message => message.event?.type === 'tool_execution_end')).toHaveLength(2);
    expect(output.filter(message => message.event?.type === 'thinking_delta')).toHaveLength(2);
    expect(output.filter(message => message.event?.type === 'usage_update').map(message => message.event?.usage?.input)).toEqual([17, 17]);
    expect(output.filter(message => message.event?.type === 'usage_update').map(message => message.event?.usage?.contextWindow)).toEqual([1000, 1000]);
    expect(output.some(message => message.type === 'error')).toBe(false);
  } finally {
    if (child.exitCode === null) send({ type: 'shutdown' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    await exit;
    clearTimeout(timer);
    lines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
