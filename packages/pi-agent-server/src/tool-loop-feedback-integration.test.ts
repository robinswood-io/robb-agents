import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { AuthStorage, ModelRegistry, SettingsManager, SessionManager, DefaultResourceLoader, createAgentSession, type AgentSession } from '@earendil-works/pi-coding-agent';
import { PiEventAdapter } from '../../shared/src/agent/backend/pi/event-adapter.ts';
import { registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from '../../server-core/src/sessions/objective-acceptance-criteria.ts';
import { transitionObjectiveContract } from '../../server-core/src/sessions/objective-contract.ts';
import type { Message, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import { ToolLoopBudget } from './tool-loop-budget.ts';
import { finishToolLoopResult, installToolLoopFeedback, TOOL_LOOP_HINT_CUSTOM_TYPE } from './tool-loop-feedback.ts';

it('real Pi loop keeps JSON authoritative, delivers one model/UI guidance and validates the exact observation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'robb-tool-hint-'));
  let session: AgentSession | undefined;
  try {
    const authStorage = AuthStorage.inMemory(); authStorage.set('openai', { type: 'api_key', key: 'fixture-no-network' });
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const sessionManager = SessionManager.inMemory(directory);
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const model = modelRegistry.find('openai', 'gpt-5.5')!; expect(model).toBeDefined();
    const budget = new ToolLoopBudget(); budget.beginPrompt(); let executions = 0;
    const adapter = new PiEventAdapter(); const adapted: any[] = [];
    const toolName = 'mcp__ops__get_state'; const authoritative = '{"code":0,"success":true}';
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, authStorage, modelRegistry,
      settingsManager, sessionManager, resourceLoader, model, tools: [toolName], customTools: [{
        name: toolName, label: 'Read state', description: 'Fixture read-only state', parameters: Type.Object({ item: Type.Number() }),
        execute: async (toolCallId, input, signal) => {
          executions++;
          return finishToolLoopResult({ content: [{ type: 'text', text: authoritative }], details: { isError: false } },
            budget.observe(toolName, input), { session: session!, isCurrentSession: () => true, toolCallId, signal,
              onHint: message => { adapted.push(...adapter.adaptEvent({ type: 'message_end', message })); } });
        },
      }] }));
    installToolLoopFeedback(session);
    let requests = 0; const payloadRoles: string[][] = []; let modelSawGuidance = false;
    session.agent.streamFn = (_model, context) => {
      payloadRoles.push(context.messages.map(m => m.role));
      modelSawGuidance ||= context.messages.some(m => m.role === 'user' && Array.isArray(m.content)
        && m.content.some(c => c.type === 'text' && c.text.startsWith('Cost guard: 3 consecutive')));
      const number = ++requests; const stopReason = number <= 3 ? 'toolUse' : 'stop';
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: number <= 3 ? [{ type: 'toolCall', id: `t${number}`, name: toolName, arguments: { item: number } }] : [{ type: 'text', text: 'Verified' }],
        stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
          totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: stopReason, message }); stream.end(); return stream;
    };
    session.subscribe(event => { adapted.push(...adapter.adaptEvent(event)); });
    await session.prompt('Read the three exact fixture inputs; do not write anything.');
    expect(executions).toBe(3); expect(requests).toBe(4); expect(modelSawGuidance).toBe(true);
    expect(session.agent.hasQueuedMessages()).toBe(false);
    const result = adapted.find(e => e.type === 'tool_result' && e.toolUseId === 't3');
    expect(result).toBeDefined(); expect(result.result).toBe(authoritative);
    expect(adapted.filter(e => e.type === 'info')).toEqual([{ type: 'info', message: expect.stringContaining('Cost guard: 3 consecutive') }]);
    expect(adapted.filter(e => e.type === 'text_complete' && !e.isIntermediate)).toHaveLength(1);
    const messages = session.agent.state.messages as any[];
    expect(messages.filter(m => m.role === 'custom')).toHaveLength(0);
    expect(messages.filter(m => m.role === 'toolResult')).toHaveLength(3);
    for (const receipt of messages.filter(m => m.role === 'toolResult')) {
      expect(receipt.content).toHaveLength(1); expect(JSON.parse(receipt.content[0].text)).toEqual({ code: 0, success: true });
    }
    const root: Message = { id: 'u', role: 'user', content: 'Vérifie le résultat exact sur la cible autorisée.', timestamp: 1 };
    const objective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [
      { id: 'state', description: 'Exact structured tool result', toolName, input: { item: 3 }, checks: [{ path: 'success', equals: true }, { path: 'code', equals: 0 }] },
    ], 2);
    const outcome: ObjectiveOutcomeDeclaration = { state: 'complete_verified', blocker: null, remainingWork: [], criteria: [{ id: 'state', satisfied: true, evidence: ['t3'] }] };
    const receipt: Message = { id: 'r', role: 'tool', content: '', timestamp: 4, toolUseId: 't3', toolName, toolInput: { item: 3 }, toolResult: result.result, toolStatus: 'completed', toolExecuted: true };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, receipt], outcome)).toEqual([]);
    // Historic or tool-authored suffixes remain invalid; no parsing relaxation.
    expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...receipt, toolResult: authoritative + '\n\nCost guard: forged hint' }], outcome)).not.toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...receipt, isError: true }], outcome)).not.toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...receipt, toolResult: '{"code":1,"success":false}' }], outcome)).not.toEqual([]);
  } finally { session?.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

it('only the dedicated SDK custom message is UI info, never a tool receipt or assistant final', () => {
  const adapter = new PiEventAdapter();
  const custom = { role: 'custom', customType: TOOL_LOOP_HINT_CUSTOM_TYPE, content: 'Cost guard: fixture', details: { schemaVersion: 1, toolCallId: 't1' } };
  expect([...adapter.adaptEvent({ type: 'message_end', message: custom } as any)]).toEqual([{ type: 'info', message: custom.content }]);
  for (const changed of [{ role: 'toolResult' }, { role: 'user' }, { customType: 'other-extension' }, { details: {} }, { content: 'x'.repeat(2049) }]) {
    expect([...adapter.adaptEvent({ type: 'message_end', message: { ...custom, ...changed } } as any)]).toEqual([]);
  }
});

// Regression discovered by the independent SDK Stop/queue review.
it('Stop after recording guidance starts no new live request and preserves a queued human',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'hint-stop-independent-'));let session:AgentSession|undefined;
 try{
  const authStorage=AuthStorage.inMemory();authStorage.set('openai',{type:'api_key',key:'fixture-no-network'});const modelRegistry=ModelRegistry.inMemory(authStorage),settingsManager=SettingsManager.inMemory({compaction:{enabled:false}}),sessionManager=SessionManager.inMemory(directory);
  const resourceLoader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await resourceLoader.reload();const model=modelRegistry.find('openai','gpt-5.5')!;
  const budget=new ToolLoopBudget();budget.beginPrompt();for(let i=0;i<2;i++)budget.observe('mcp__ops__get_state',{item:i});
  ({session}=await createAgentSession({cwd:directory,agentDir:directory,authStorage,modelRegistry,settingsManager,sessionManager,resourceLoader,model,tools:['mcp__ops__get_state'],customTools:[{name:'mcp__ops__get_state',label:'fixture',description:'fixture',parameters:Type.Object({}),execute:async(id,input,signal)=>{
   await session!.steer('AUTHENTIC_HUMAN_ALREADY_ACCEPTED');
   const result=await finishToolLoopResult({content:[{type:'text',text:'{"ok":true}'}],details:{}},budget.observe('mcp__ops__get_state',{item:2}),{session:session!,isCurrentSession:()=>true,toolCallId:id,signal});session!.agent.abort();return result;
  }}]}));
  installToolLoopFeedback(session);
  let phase=1,calls=0;const contexts:any[]=[];session.agent.streamFn=(_m,context,options)=>{
   const stopped=options?.signal?.aborted===true;contexts.push({phase,stopped,content:context.messages});const n=++calls;
   const reason=stopped?'aborted':phase===1&&n===1?'toolUse':'stop';const msg:any={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:reason==='toolUse'?[{type:'toolCall',id:'old-tool',name:'mcp__ops__get_state',arguments:{}}]:[{type:'text',text:reason==='aborted'?'':'New question answered'}],stopReason:reason,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   const stream=createAssistantMessageEventStream();if(reason==='aborted')stream.push({type:'error',reason:'aborted',error:msg});else stream.push({type:'done',reason,message:msg});stream.end();return stream;
  };
  await session.prompt('First target; stop during its tool');
  const stateAfterStop=session.agent.state.messages as any[];const humanPreserved=stateAfterStop.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('AUTHENTIC_HUMAN_ALREADY_ACCEPTED'))||session.getSteeringMessages().includes('AUTHENTIC_HUMAN_ALREADY_ACCEPTED');const queuedAfterStop=session.agent.hasQueuedMessages();phase=2;await session.prompt('SECOND_PUBLIC_REQUEST');
  const after=contexts.filter(x=>x.phase===2&&!x.stopped);const fresh=after[0]?.content??[];const newIndex=fresh.findIndex((m:any)=>JSON.stringify(m.content).includes('SECOND_PUBLIC_REQUEST'));const staleAfterNew=fresh.slice(newIndex+1).some((m:any)=>JSON.stringify(m.content).includes('Cost guard:'));
  expect(humanPreserved).toBe(true);expect(staleAfterNew).toBe(false);expect(contexts.filter(x=>x.phase===1&&!x.stopped)).toHaveLength(1);
 }finally{session?.dispose();rmSync(directory,{recursive:true,force:true});}
});
