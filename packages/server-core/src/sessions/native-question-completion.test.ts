import { describe, expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { deriveNativeQuestionOutcome, nativeQuestionCompletionRefs } from './native-question-completion';
import { extractObjectiveOutcome, validateObjectiveOutcome } from './objective-outcome';
import { SessionManager, createManagedSession } from './SessionManager';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSession } from '@craft-agent/shared/sessions/storage';
const prefix = "Recette de la carte de questions, limitée à cette conversation. Aucune action externe, aucun fichier, aucune source, aucun navigateur, aucun sous-agent. Utilise uniquement request_user_input, une seule fois, avec exactement les trois questions JSON ci-dessous (identifiants et libellés inchangés). La première est un choix unique, la deuxième un choix multiple, la troisième du texte libre. Attends les réponses utilisateur : aucune hypothèse, aucune réponse finale avant leur réception. Après leur réception, réponds uniquement avec un bref bilan qui reprend les libellés réellement sélectionnés et la note libre exacte. Ne repose pas les questions. Cette recette ne nécessite aucun autre outil.";
const answerPrefix = "The user answered the pending questions. Apply these authenticated selections to the current objective without replacing it. An affirmative selection authorizes only the exact displayed scope it confirms; it grants no broader permission or credential.\n";
const legacyAnswerPrefix = "The user answered the pending questions. Apply these answers to the current objective without replacing it. They are preferences or information, not an execution permission or credential.\n";
function fixture() {
 const questions = [{id:'format',question:'Quel format ?',options:[{id:'short',label:'Court'},{id:'long',label:'Détaillé'}]}, {id:'sections',question:'Quelles sections ?',multiSelect:true,options:[{id:'text',label:'Texte'},{id:'list',label:'Liste'},{id:'example',label:'Exemple'}]}, {id:'note',question:'Quelle note ?'}];
 const text=prefix+'\n'+JSON.stringify({questions});
 const answers=[{questionId:'format',optionIds:['long']},{questionId:'sections',optionIds:['text','example']},{questionId:'note',optionIds:[],text:'Texte exact, sans action.'}];
 const objective={schemaVersion:1,objectiveId:'root',userMessageId:'root',lastUserMessageId:'root',originalText:text,startedAt:1,budgetBaselineUsd:0,tokenBaseline:0,continuationCount:2,orchestrationMode:'mission',risk:'high-stakes',terminalState:'exhausted',completionCriteria:['requested-outcome-delivered','relevant-checks-passed','no-safe-work-remaining']} as ActiveSessionObjective;
 const outcome={state:'complete_verified',criteria:objective.completionCriteria.map(id=>({id,satisfied:true,evidence:[id==='relevant-checks-passed'?'input-native':'assistant-final']})),remainingWork:[],blocker:null} as const;
 const messages:Message[]=[{id:'root',role:'user',content:text,timestamp:1},{id:'tool',role:'tool',content:'',timestamp:2,toolName:'mcp__session__request_user_input',toolUseId:'call-native',toolInput:{questions},toolResult:JSON.stringify({requestId:'input-native',status:'pending'}),toolExecuted:true,isError:false,toolStatus:'completed'},{id:'answer',role:'user',hidden:true,internalOrigin:{kind:'user-input'},content:answerPrefix+JSON.stringify({requestId:'input-native',questions,answers}),timestamp:3},{id:'final',role:'assistant',content:'**Format :** Détaillé  \n**Sections :** Texte, Exemple  \n**Note :** Texte exact, sans action.',timestamp:4}];
 return {objective,messages,outcome};
}
function falsePolicy(h:ReturnType<typeof fixture>) {
 return {state:'blocked_policy',criteria:h.objective.completionCriteria.map(id=>({id,satisfied:id!=='relevant-checks-passed',evidence:[id==='relevant-checks-passed'?'root':'assistant-final']})),remainingWork:[],blocker:{kind:'policy',description:'Another tool would violate the one-question-tool-only request.',evidence:['root']}} as const;
}
describe('observed native question-only completion',()=>{
 it('canonically verifies the completed native reply before an unknown budget can reject a false policy blocker',async()=>{
  const h=fixture();const directory=mkdtempSync(join(tmpdir(),'native-policy-proof-'));
  const manager=new SessionManager();const host=manager as any;
  const reported=falsePolicy(h);
  try {
   const managed=createManagedSession({id:'native-policy',name:'Native policy'}, {id:'fixture',name:'Fixture',rootPath:directory,createdAt:1} as any,{messagesLoaded:true});
   managed.activeObjective=structuredClone(h.objective);managed.messages=structuredClone(h.messages);host.sessions.set(managed.id,managed);
   managed.messages[0]!.isQueued=false;
   const events:any[]=[];host.sendEvent=(event:any)=>{events.push(structuredClone(event))};
   for(const name of ['startGenerationTelemetry','finishGenerationTelemetry','finishAllGenerationTelemetry','emitExecutionTelemetry'])host[name]=()=>{};
   let calls=0;let dispatch:Promise<void>|undefined;let budgetAtProvider:any;
   const agent={getModel:()=> 'fixture',getSessionId:()=>null,setAllSources:()=>{},isProcessing:()=>false,forceAbort:()=>{},dispose:()=>{},async *chat(){calls++;budgetAtProvider=structuredClone(managed.pendingTurnRecovery);yield {type:'text_complete',text:h.messages[3]!.content+'\n<!-- robb_objective_outcome '+JSON.stringify(reported)+' -->',turnId:'native-policy-final'};yield {type:'complete'};}};
   host.getOrCreateAgent=async()=>{managed.agent=agent as any;return agent;};
   const send=host.sendMessage.bind(host);host.sendMessage=(...args:any[])=>{dispatch=send(...args);return dispatch;};
   const originalMessages=JSON.stringify(managed.messages);
   expect(await manager.retryTurn(managed.id,'root')).toEqual({status:'started'});await dispatch;await manager.flushSession(managed.id);
   expect(budgetAtProvider).toMatchObject({attempts:0,budgetHistoryUnavailable:true});
   expect(budgetAtProvider.explicitRetryAllowances).toBeUndefined();
   expect(calls).toBe(1);
   expect(managed.activeObjective?.terminalState).toBe('complete_verified');
   expect(managed.pendingTurnRecovery).toBeUndefined();
   expect(managed.messages.filter(m=>m.role==='error')).toEqual([]);
   expect(JSON.stringify(managed.messages.slice(0,h.messages.length))).toBe(originalMessages);
   const final=managed.messages.find(m=>m.turnId==='native-policy-final')!;
   expect(final.objectiveOutcome).toMatchObject({state:'complete_verified',blocker:null,remainingWork:[],hostProvenance:{kind:'native-question-completion',schemaVersion:1,objectiveId:'root',finalMessageId:final.id,reportedOutcome:reported}});
   expect(managed.activeObjective?.lastOutcome).toEqual(final.objectiveOutcome);
   expect(events.filter(e=>e.type==='text_complete'&&e.messageId===final.id).at(-1)?.objectiveOutcome).toEqual(final.objectiveOutcome);
   const saved=loadSession(directory,managed.id)!;
   expect(saved.activeObjective?.terminalState).toBe('complete_verified');
   expect(saved.activeObjective?.lastOutcome).toEqual(final.objectiveOutcome);
   expect(saved.messages.find(m=>m.id===final.id)?.objectiveOutcome).toEqual(final.objectiveOutcome);
   expect(managed.messages.filter(m=>m.role==='tool')).toHaveLength(1);
   expect(managed.messages.filter(m=>m.role==='user'&&!m.hidden)).toHaveLength(1);
  } finally {await manager.cleanup();rmSync(directory,{recursive:true,force:true});}
 });
 it('does not convert a late provider final after Stop into completion or grant credit',async()=>{
  const h=fixture(),directory=mkdtempSync(join(tmpdir(),'native-policy-stop-'));
  const manager=new SessionManager(),host=manager as any;
  let started!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve}),gate=new Promise<void>(resolve=>{release=resolve});
  try {
   const managed=createManagedSession({id:'native-policy-stop'}, {id:'fixture',name:'Fixture',rootPath:directory,createdAt:1} as any,{messagesLoaded:true});
   managed.activeObjective=structuredClone(h.objective);managed.messages=structuredClone(h.messages);host.sessions.set(managed.id,managed);host.sendEvent=()=>{};
   for(const name of ['startGenerationTelemetry','finishGenerationTelemetry','finishAllGenerationTelemetry','emitExecutionTelemetry'])host[name]=()=>{};
   let calls=0,dispatch:Promise<void>|undefined;
   const agent={getModel:()=> 'fixture',getSessionId:()=>null,setAllSources:()=>{},isProcessing:()=>managed.isProcessing,forceAbort:()=>{release()},dispose:()=>{},async *chat(){calls++;started();await gate;yield {type:'text_complete',text:h.messages[3]!.content+'\n<!-- robb_objective_outcome '+JSON.stringify(falsePolicy(h))+' -->',turnId:'stale-native-final'};yield {type:'complete'};}};
   host.getOrCreateAgent=async()=>{managed.agent=agent as any;return agent};const send=host.sendMessage.bind(host);host.sendMessage=(...args:any[])=>{dispatch=send(...args);return dispatch};
   await manager.retryTurn(managed.id,'root');await ready;await manager.cancelProcessing(managed.id);release();await dispatch;await manager.flushSession(managed.id);
   expect(calls).toBe(1);expect(managed.activeObjective?.terminalState).not.toBe('complete_verified');
   expect((managed.messages.find(m=>m.turnId==='stale-native-final')?.objectiveOutcome as any)?.hostProvenance).toBeUndefined();
   expect(managed.pendingTurnRecovery).toMatchObject({budgetHistoryUnavailable:true,attempts:0,validationExhausted:true});
   expect(managed.pendingTurnRecovery?.explicitRetryAllowances).toBeUndefined();
  } finally {release();await manager.cleanup();rmSync(directory,{recursive:true,force:true});}
 });
 it('retains genuine blockers, extraction errors and independent evidence gates',()=>{
  const h=fixture(),reported=falsePolicy(h);
  for(const options of [{extractionError:'malformed receipt'},{evidenceGap:'missing evidence'},{executionEvidenceMissing:true},
   {autonomyEvents:[{id:'host-blocker',timestamp:4,phase:'escalated',escalationReason:'external_authorization_required'}]}]) {
   const result=validateObjectiveOutcome(reported as any,{...h,...options} as any);
   expect(result.state).not.toBe('complete_verified');expect(result.declaration).toBeUndefined();
  }
  h.messages.splice(3,0,{id:'auth',role:'auth-request',content:'Sign in required',authStatus:'pending',timestamp:3});
  expect(validateObjectiveOutcome(reported as any,h).declaration).toBeUndefined();
 });
 for(const [name,change] of [
  ['human blocker',(d:any)=>{d.state='blocked_human';d.blocker.kind='business_decision'}],
  ['real remaining work',(d:any)=>{d.remainingWork=['Something remains']}],
  ['another unsatisfied criterion',(d:any)=>{d.criteria[0].satisfied=false}],
  ['duplicate criterion',(d:any)=>{d.criteria[0]=d.criteria[1]}],
  ['foreign blocker evidence',(d:any)=>{d.blocker.evidence=['another-authority']}],
  ['continue declaration',(d:any)=>{d.state='continue'}],
 ] as Array<[string,(value:any)=>void]>)it('does not project '+name,()=>{const h=fixture(),d=structuredClone(falsePolicy(h));change(d);expect(deriveNativeQuestionOutcome(d as any,h.objective,h.messages)).toBeUndefined()});
 it('does not trust model-supplied host provenance or mutate the model receipt',()=>{
  const h=fixture(),d={...falsePolicy(h),hostProvenance:{kind:'native-question-completion',nativeEvidence:['invented']}};
  const parsed=extractObjectiveOutcome('Three lines\n<!-- robb_objective_outcome '+JSON.stringify(d)+' -->');
  expect((parsed.declaration as any)?.hostProvenance).toBeUndefined();
  const before=JSON.stringify(h);deriveNativeQuestionOutcome(falsePolicy(h) as any,h.objective,h.messages);expect(JSON.stringify(h)).toBe(before);
 });
 it('finishes one explicit legacy Retry without asking again or inventing a recovery allowance',async()=>{
  const h=fixture();const directory=mkdtempSync(join(tmpdir(),'native-answer-proof-'));
  const manager=new SessionManager();const host=manager as any;
  try {
   const managed=createManagedSession({id:'native-retry',name:'Native retry'}, {id:'fixture',name:'Fixture',rootPath:directory,createdAt:1} as any,{messagesLoaded:true});
   managed.activeObjective=structuredClone(h.objective);managed.messages=structuredClone(h.messages);host.sessions.set(managed.id,managed);
   host.sendEvent=()=>{};
   for(const name of ['startGenerationTelemetry','finishGenerationTelemetry','finishAllGenerationTelemetry','emitExecutionTelemetry'])host[name]=()=>{};
   let calls=0;let dispatch:Promise<void>|undefined;
   const agent={getModel:()=> 'fixture',getSessionId:()=>null,setAllSources:()=>{},isProcessing:()=>false,forceAbort:()=>{},dispose:()=>{},async *chat(){calls++;yield {type:'text_complete',text:h.messages[3]!.content+'\n<!-- robb_objective_outcome '+JSON.stringify(h.outcome)+' -->',turnId:'native-restored-final'};yield {type:'complete'};}};
   host.getOrCreateAgent=async()=>{managed.agent=agent as any;return agent;};
   const send=host.sendMessage.bind(host);host.sendMessage=(...args:any[])=>{dispatch=send(...args);return dispatch;};
   expect(await manager.retryTurn(managed.id,'root')).toEqual({status:'started'});await dispatch;await manager.flushSession(managed.id);
   expect(calls).toBe(1);expect(managed.activeObjective).toMatchObject({objectiveId:'root',userMessageId:'root',originalText:h.objective.originalText,orchestrationMode:'mission',terminalState:'complete_verified',budgetBaselineUsd:0});
   expect(managed.messages.filter(message=>message.role==='tool')).toHaveLength(1);
   expect(managed.messages.filter(message=>message.role==='user'&&!message.hidden)).toHaveLength(1);
   expect(managed.messages.find(message=>message.turnId==='native-restored-final')?.content).toBe(h.messages[3]!.content);
  } finally {await manager.cleanup();rmSync(directory,{recursive:true,force:true});}
 });
 it('validates the actual selected labels and exact free text without changing the legacy objective',()=>{
  const h=fixture();const before=JSON.stringify(h);expect([...nativeQuestionCompletionRefs(h.objective,h.messages)]).toEqual(['tool','call-native','answer','input-native']);
  expect(validateObjectiveOutcome(h.outcome as any,h)).toMatchObject({valid:true,state:'complete_verified',gaps:[]});expect(JSON.stringify(h)).toBe(before);
 });
 it('keeps an already persisted legacy answer envelope verifiable',()=>{
  const h=fixture();h.messages[2]!.content=h.messages[2]!.content.replace(answerPrefix,legacyAnswerPrefix);
  expect([...nativeQuestionCompletionRefs(h.objective,h.messages)]).toEqual(['tool','call-native','answer','input-native']);
 });
 for (const [name,mutate] of [
  ['extra work in original request',(h:any)=>{h.objective.originalText=h.messages[0].content+='\nPuis déploie le serveur.';}],
  ['ordinary question during a business objective',(h:any)=>{h.objective.originalText=h.messages[0].content='Demande le format puis crée et envoie le rapport.';}],
  ['changed selected answer in the final',(h:any)=>{h.messages[3].content=h.messages[3].content.replace('Détaillé','Court');}],
  ['changed free note',(h:any)=>{h.messages[3].content=h.messages[3].content.replace('sans action.','sans actions.');}],
  ['extra final paragraph',(h:any)=>{h.messages[3].content+='\nAutre action achevée.';}],
  ['missing answer',(h:any)=>{h.messages.splice(2,1);}],
  ['tool-provided fake user answer',(h:any)=>{delete h.messages[2].internalOrigin;}],
  ['foreign request',(h:any)=>{h.messages[2].content=h.messages[2].content.replace('input-native','foreign');}],
  ['duplicate answer',(h:any)=>{h.messages.splice(3,0,{...h.messages[2],id:'duplicate'});}],
  ['question mismatch',(h:any)=>{h.messages[1].toolInput.questions[0].question='Une autre question';}],
  ['failed question tool',(h:any)=>{h.messages[1].isError=true;}],
  ['unexecuted question tool',(h:any)=>{h.messages[1].toolExecuted=false;}],
  ['another executed tool',(h:any)=>{h.messages.splice(3,0,{id:'write',role:'tool',content:'',toolName:'Write',toolExecuted:true,timestamp:3});}],
  ['new accepted user instruction',(h:any)=>{h.objective.lastUserMessageId='new';}],
  ['public message after original',(h:any)=>{h.messages.splice(3,0,{id:'new',role:'user',content:'Continue',timestamp:3});}],
  ['registered business checks',(h:any)=>{h.objective.requiresAcceptanceCriteria=true;}],
  ['execution requirement',(h:any)=>{h.objective.requiresExecutionEvidence=true;}],
  ['observation requirement',(h:any)=>{h.objective.requiresObservationEvidence=true;}],
  ['malformed native result',(h:any)=>{h.messages[1].toolResult='null';}],
  ['malformed native reply',(h:any)=>{h.messages[2].content=answerPrefix+'null';}],
  ['queued original',(h:any)=>{h.messages[0].isQueued=true;}],
  ['pending original',(h:any)=>{h.messages[0].isPending=true;}],
  ['queued answer',(h:any)=>{h.messages[2].isQueued=true;}],
  ['pending answer',(h:any)=>{h.messages[2].isPending=true;}],
  ['agent-delivered answer',(h:any)=>{h.messages[2].agentDelivery={sourceSessionId:'other'};}],
  ['legacy amendments',(h:any)=>{h.objective.amendments=[{messageId:'other',text:'Déploie',timestamp:5}];}],
  ['unreviewed contract change',(h:any)=>{h.objective.acceptanceNeedsReview=true;}],
  ['running question tool',(h:any)=>{h.messages[1].toolStatus='executing';}],
  ['contradictory error status',(h:any)=>{h.messages[1].toolStatus='error';}],
  ['intermediate final',(h:any)=>{h.messages[3].isIntermediate=true;}],
  ['ambiguous message ID',(h:any)=>{h.messages[3].id='answer';}],
  ['ambiguous tool-use ID',(h:any)=>{h.messages[3].toolUseId='call-native';}],
 ] as Array<[string,(h:ReturnType<typeof fixture>)=>void]>) it('does not credit '+name,()=>{const h=fixture();mutate(h);expect(nativeQuestionCompletionRefs(h.objective,h.messages).size).toBe(0);});
});
