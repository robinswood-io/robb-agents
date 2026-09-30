import {describe,it,expect} from 'bun:test';
import {transitionObjectiveContract,buildObjectiveContractPrompt,objectiveRequiresExecutionEvidence} from './objective-contract.ts';
import {requiresStructuredObjectiveOutcome} from './objective-completion-policy.ts';
import {classifyObjectiveTerminalState} from './turn-completion.ts';
import {SessionManager,createManagedSession} from './SessionManager.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appendRunLog} from '@craft-agent/shared/tasks';

const original=()=>({...transitionObjectiveContract({messageId:'root',text:'Explique simplement ce terme.',
 lifetimeCostUsd:12,lifetimeTokens:200,nowMs:1}),model:'pi/selected-model',thinkingLevel:'high' as const});

describe('accepted amendments promote completion evidence without replacing the root',()=>{
 it('builds an authenticated Task child contract from its semantic assignment only',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'task-objective-contract-'));
  const manager=new SessionManager();const host=manager as any;
  try{
   const workspace={id:'fixture',name:'Fixture',rootPath:directory,createdAt:1} as any;
   const parent=createManagedSession({id:'orchestrator',name:'Orchestrator'},workspace,
    {messagesLoaded:true,isProcessing:true});
   parent.activeObjective=transitionObjectiveContract({messageId:'parent-root',text:'Coordinate the task.',nowMs:1});
   const managed=createManagedSession({
    id:'task-child',name:'Task child',parentSessionId:'orchestrator',
    taskSlug:'read-task',taskRunId:'run-1',taskNodeId:'list',
   },workspace,{messagesLoaded:true});
   appendRunLog(directory,'read-task','run-1',{
    t:'2026-09-11T00:00:00.000Z',kind:'node-spawned',nodeId:'list',sessionId:'task-child',
   });
   host.sessions.set(parent.id,parent);host.sessions.set(managed.id,managed);host.sendEvent=()=>{};
   for(const name of ['startGenerationTelemetry','finishGenerationTelemetry','finishAllGenerationTelemetry','emitExecutionTelemetry'])host[name]=()=>{};
   const agent={getModel:()=> 'fixture',getSessionId:()=>null,setAllSources:()=>{},isProcessing:()=>false,forceAbort:()=>{},dispose:()=>{},
    async *chat(){yield {type:'text_complete',text:'Listed.',turnId:'task-final'};yield {type:'complete'};}};
   host.getOrCreateAgent=async()=>{managed.agent=agent as any;return agent;};
   const assignment='List files.';
   const prompt='[Execution policy]\nWrite paths: (none)\nNever persist secret values.\n<specialist_execution>\nDo not claim completion without executing the relevant verification.\n</specialist_execution>\nPrevious failure mentioned external mutation and security verification.\n\nList files.';
   await manager.sendMessage(managed.id,prompt,undefined,undefined,{internalOrigin:{
    kind:'spawned-session',senderSessionId:'orchestrator',authenticatedTaskText:assignment,
   }});
   await manager.flushSession(managed.id);
   expect(managed.activeObjective?.originalText).toBe(assignment);
   expect(managed.activeObjective?.requiresExecutionEvidence).toBeUndefined();
   expect(managed.activeObjective?.requiresObservationEvidence).toBeUndefined();
   expect(managed.activeObjective?.requiresAcceptanceCriteria).toBeUndefined();
  }finally{await manager.cleanup();rmSync(directory,{recursive:true,force:true});}
 });
 it('the real host refuses an unregistered artifact completion after accepting a new instruction',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'objective-amendment-'));
  const manager=new SessionManager();const host=manager as any;
  try{
   const managed=createManagedSession({id:'amended-direct',name:'Amended direct'},
    {id:'fixture',name:'Fixture',rootPath:directory,createdAt:1} as any,{messagesLoaded:true});
   managed.activeObjective=original();managed.messages=[{id:'root',role:'user',content:managed.activeObjective.originalText!,timestamp:1}];
   host.sessions.set(managed.id,managed);host.sendEvent=()=>{};
   for(const name of ['startGenerationTelemetry','finishGenerationTelemetry','finishAllGenerationTelemetry','emitExecutionTelemetry'])host[name]=()=>{};
   const recovery:string[]=[];host.enqueueAutomaticTurnRecovery=async(_session:unknown,cause:string)=>{recovery.push(cause);return false;};
   const agent={getModel:()=> 'fixture',getSessionId:()=>null,setAllSources:()=>{},isProcessing:()=>false,forceAbort:()=>{},dispose:()=>{},
    async *chat(){yield {type:'text_complete',text:'Les documents sont produits et vérifiés.',turnId:'unproven-final'};yield {type:'complete'};}};
   host.getOrCreateAgent=async()=>{managed.agent=agent as any;return agent;};
   await manager.sendMessage(managed.id,'Continue : crée les documents puis vérifie leur rendu.');
   await manager.flushSession(managed.id);
   expect(managed.activeObjective).toMatchObject({objectiveId:'root',requiresExecutionEvidence:true,requiresAcceptanceCriteria:true});
   expect(managed.activeObjective?.terminalState).not.toBe('complete_verified');
   expect(recovery).toContain('objective_incomplete');
  }finally{await manager.cleanup();rmSync(directory,{recursive:true,force:true});}
 });
 it('rejects a bare success claim after a direct discussion becomes artifact work',()=>{
  const first=original();
  const next=transitionObjectiveContract({existing:first,messageId:'amendment',nowMs:2,lifetimeCostUsd:90,
   text:'Continue ce chantier : crée les documents demandés puis vérifie le contenu et le rendu. Aucun email pendant cette passe.'});
  expect(next).toMatchObject({objectiveId:'root',userMessageId:'root',originalText:first.originalText,
   lastUserMessageId:'amendment',startedAt:1,budgetBaselineUsd:12,tokenBaseline:200,model:first.model,thinkingLevel:'high',
   requiresExecutionEvidence:true,requiresObservationEvidence:true,requiresAcceptanceCriteria:true});
  expect(requiresStructuredObjectiveOutcome(next)).toBe(true);
  expect(buildObjectiveContractPrompt(next)).toContain('robb_objective_outcome');
  expect(classifyObjectiveTerminalState('Les documents sont produits et vérifiés.',{
   structuredOutcomeRequired:requiresStructuredObjectiveOutcome(next)})).toBe('continue');
 });
 it('requires observed checks when a direct explanation becomes an explicit read-only audit',()=>{
  const next=transitionObjectiveContract({existing:original(),messageId:'audit',
   text:'Audit indépendant en lecture seule. Vérifie les résultats existants.'});
  expect(next.requiresObservationEvidence).toBe(true);
  expect(next.requiresAcceptanceCriteria).toBe(true);
  expect(next.requiresExecutionEvidence).toBeUndefined();
 });
 it('preserves the exact registered contract until canonical re-registration',()=>{
  const criterion={id:'existing',description:'Existing check',toolName:'Read',input:{file_path:'/tmp/state'},checks:[{path:'$.ok',equals:true}]};
  const first={...original(),acceptanceCriteria:[criterion],acceptanceRegisteredAt:4};
  const next=transitionObjectiveContract({existing:first,messageId:'edit',text:'Continue : corrige le document.'});
  expect(next.acceptanceCriteria).toEqual([criterion]);
  expect(next.acceptanceRegisteredAt).toBe(4);
  expect(next.acceptanceNeedsReview).toBe(true);
  expect(next.acceptanceRevision).toBe('edit');
 });
 it('promotes required high-stakes evidence without changing the chosen model',()=>{
  const first=original();
  const next=transitionObjectiveContract({existing:first,messageId:'security',text:'Continue : corrige la configuration RBAC.'});
  expect(next.risk).toBe('high-stakes');
  expect(next.evidenceRequirement).toBe('authoritative-sources-before-mutation');
  expect(next.completionCriteria).toEqual([...first.completionCriteria,'independent-review-passed']);
  expect(next.model).toBe(first.model);
 });
 it('does not lower execution or review obligations during a subsequent read-only step',()=>{
  const first=transitionObjectiveContract({messageId:'security',text:'Corrige la configuration RBAC.'});
  const next=transitionObjectiveContract({existing:first,messageId:'audit',text:'Audit indépendant en lecture seule. Vérifie le résultat.'});
  expect(next.requiresExecutionEvidence).toBe(true);
  expect(next.completionCriteria).toEqual(first.completionCriteria);
  expect(next.risk).toBe('high-stakes');
 });
 it('does not let an old read-only root neutralize a newly accepted correction',()=>{
  const first=transitionObjectiveContract({messageId:'read',text:'Audit indépendant en lecture seule. Vérifie les résultats.'});
  const next=transitionObjectiveContract({existing:first,messageId:'fix',text:'Continue : corrige le document existant.'});
  expect(next.requiresExecutionEvidence).toBe(true);
  expect(objectiveRequiresExecutionEvidence(next)).toBe(true);
  expect(next.originalText).toBe(first.originalText);
 });
 it('preserves the legacy correction for a read-only root with only old polluted flags',()=>{
  const first={...transitionObjectiveContract({messageId:'read',text:'Audit indépendant en lecture seule. Vérifie les résultats.'}),requiresExecutionEvidence:true};
  expect(objectiveRequiresExecutionEvidence(first)).toBe(false);
 });
 for(const text of ['Continue, ne crée aucun fichier. Réponds seulement ici.','Continue, ne modifie rien.',
  'Continue : aucune modification de fichier, aucune vérification externe ; réponds simplement ici.'])it(`does not turn an exclusion into requested work: ${text}`,()=>{
  const next=transitionObjectiveContract({existing:original(),messageId:'exclude',text});
  expect(requiresStructuredObjectiveOutcome(next)).toBe(false);
 });
 it('keeps a positive write after an exclusion, including the inherited high-stakes source requirement',()=>{
  const first=transitionObjectiveContract({messageId:'read',text:'Audit indépendant en lecture seule. Inspecte la configuration RBAC.'});
  const next=transitionObjectiveContract({existing:first,messageId:'fix',text:'Continue : ne publie rien, mais corrige les problèmes relevés.'});
  expect(objectiveRequiresExecutionEvidence(next)).toBe(true);
  expect(next.evidenceRequirement).toBe('authoritative-sources-before-mutation');
 });
 it('keeps a trailing sensitive referent from a long accepted objective',()=>{
  const root=`Audit indépendant en lecture seule. ${'Contexte neutre. '.repeat(100)}Inspecte la configuration RBAC.`;
  const first=transitionObjectiveContract({messageId:'read-long',text:root});
  const next=transitionObjectiveContract({existing:first,messageId:'fix-long',
   text:'Continue : corrige les problèmes relevés.'});
  expect(next).toMatchObject({
   risk:'high-stakes',orchestrationMode:'mission',requiresExecutionEvidence:true,
   evidenceRequirement:'authoritative-sources-before-mutation',
  });
  expect(next.completionCriteria).toContain('independent-review-passed');
 });
 it('retains the last sensitive amendment through later presentation and status turns',()=>{
  let objective=transitionObjectiveContract({messageId:'root-neutral',text:'Analyse le dossier.'});
  const turns=[
   ['sensitive-observation','Inspecte la configuration RBAC.'],
   ['style-1','Réponds plus brièvement.'],
   ['style-2','Utilise un ton simple.'],
   ['style-3','Continue en français.'],
   ['thanks','Merci.'],
   ['status','Où en sommes-nous ?'],
  ] as const;
  for(const [messageId,text] of turns){
   objective=transitionObjectiveContract({existing:objective,messageId,text});
  }
  const next=transitionObjectiveContract({existing:objective,messageId:'fix-sensitive-history',
   text:'Continue : corrige les problèmes relevés.'});
  expect(next).toMatchObject({
   risk:'high-stakes',orchestrationMode:'mission',requiresExecutionEvidence:true,
   evidenceRequirement:'authoritative-sources-before-mutation',
  });
  expect(next.completionCriteria).toContain('independent-review-passed');
 });
 for(const text of ['Continue','Où en es-tu ?','Merci','Utilise un ton plus simple.'])it(`keeps a response-only discussion response-only for ${text}`,()=>{
  const next=transitionObjectiveContract({existing:original(),messageId:'brief',text});
  expect(requiresStructuredObjectiveOutcome(next)).toBe(false);
 });
 it('records a short continuation containing a new language preference',()=>{
  const next=transitionObjectiveContract({existing:original(),messageId:'language',text:'Continue en anglais.'});
  expect(next.amendments?.[0]?.text).toBe('Continue en anglais.');
  expect(requiresStructuredObjectiveOutcome(next)).toBe(false);
 });
 for(const bullet of ['-','*','+'])it(`recognizes explicit work in ${bullet} Markdown bullets`,()=>{
  const next=transitionObjectiveContract({existing:original(),messageId:'steps',text:`Continue :\n${bullet} Crée le PDF demandé.\n${bullet} Vérifie son rendu.`});
  expect(next.requiresExecutionEvidence).toBe(true);expect(next.requiresObservationEvidence).toBe(true);
 });
 it('keeps an explicit new objective on its existing reset path',()=>{
  const next=transitionObjectiveContract({existing:original(),messageId:'new',lifetimeCostUsd:90,text:'Nouvel objectif : crée un fichier.'});
  expect(next.objectiveId).toBe('new');expect(next.budgetBaselineUsd).toBe(90);expect(next.requiresExecutionEvidence).toBe(true);
 });
});
