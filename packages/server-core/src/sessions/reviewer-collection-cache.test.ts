import { expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as storage from '@craft-agent/shared/config/storage'
import { SessionManager } from './SessionManager'
import { transitionObjectiveContract } from './objective-contract'
import { getDelegatedReviewRequest } from './delegated-review-outcome'
import { cleanupModeState } from '@craft-agent/shared/agent/mode-manager'

it('keeps a host-declared reviewer fresh through real spawn, creation and turn preparation', async () => {
 const rootPath = mkdtempSync(join(tmpdir(), 'real-spawn-cache-'))
 const workspace = { id: 'fixture-ws', slug: 'fixture-ws', name: 'Fixture', rootPath, createdAt: 1 }
 const loader = spyOn(storage,'loadStoredConfig').mockReturnValue({ workspaces:[workspace], activeWorkspaceId:null, activeSessionId:null, defaultLlmConnection:'test-route',
  llmConnections:[{ slug:'test-route',name:'Fixture',providerType:'pi_compat',authType:'none',baseUrl:'http://localhost:11434/v1',defaultModel:'test-model',models:['test-model'],customEndpoint:{api:'openai-completions'},createdAt:1 }] } as never)
 const host = new SessionManager() as any
 try {
  host.sendEvent = () => {}; host.emitUnreadSummaryChanged = () => {}; host.notifySessionCreated = () => {}
  const created = await host.createSession(workspace.id,{name:'Worker',llmConnection:'test-route',model:'test-model',permissionMode:'safe'})
  const parent = host.sessions.get(created.id)
  parent.isProcessing=true
  parent.activeObjective=transitionObjectiveContract({messageId:'root-objective',text:'Compare the supplied collection.',nowMs:1})
  const realSend = host.sendMessage.bind(host)
  let dispatched: Promise<void> | undefined
  let child: any, seen: any
  let generations=0
  const summaryAgent = {getSummarizeCallback:()=>async()=>{generations++; return `Synthesis ${generations}`}}
  parent.agent=summaryAgent
  host.enqueuePersist=()=>true;host.flushSession=async()=>{}
  host.beginAutomaticSessionStatusLifecycle=async()=>{};host.finishAutomaticSessionStatusLifecycle=async()=>{}
  host.emitExecutionTelemetry=()=>{};host.startGenerationTelemetry=()=>{};host.finishGenerationTelemetry=()=>{}
  host.isSessionBeingViewed=()=>true;host.markSessionRead=async()=>{};host.enqueueAutomaticTurnRecovery=async()=>false
  host.disposeManagedAgentRuntime=async()=>{}
  host.getOrCreateAgent=async(m:any)=>{
   child=m
   const agent={...summaryAgent,getModel:()=> 'test-model',getSessionId:()=>null,setAllSources:()=>{},
    async *chat(){
     const workerSummary=await host.getCollectionSummarizer(parent)('Exact fresh collection payload', {requestIdentity:'fixture-get-exact-observation',allowReuse:true})
     const reviewerSummary=await host.getCollectionSummarizer(child)('Exact fresh collection payload', {requestIdentity:'fixture-get-exact-observation',allowReuse:true})
     const secondReviewerSummary=await host.getCollectionSummarizer(child)('Exact fresh collection payload', {requestIdentity:'fixture-get-exact-observation',allowReuse:true})
     seen={missionRole:child.missionRole??null,delegationRole:child.delegation?.role,objectiveRole:child.activeObjective?.delegatedRole,
      risk:child.activeObjective?.risk,criteria:child.activeObjective?.completionCriteria,
      reviewTarget:getDelegatedReviewRequest(child.activeObjective?.originalText??'',child.enabledSourceSlugs,child.activeObjective?.delegatedRole)?.target,
      parentScope:host.getCollectionCacheScope(parent),childScope:host.getCollectionCacheScope(child),
      workerSummary,reviewerSummary,secondReviewerSummary,generations}
     yield {type:'text_complete',text:'Fixture diagnostic completed.'};yield {type:'complete'}
    }}
   m.agent=agent;return agent
  }
  host.sendMessage=(...args:any[])=>{dispatched=realSend(...args);return dispatched}
  await host.spawnDelegatedSession(parent,{role:'reviewer',prompt:'Inspect the target /fixture/collection.json.'})
  await dispatched
  expect(seen).toBeDefined()
  expect(seen.reviewTarget).toBe('/fixture/collection.json')
  expect(seen.childScope.freshEvidence).toBe(true)
  expect(seen.generations).toBe(3)
  // Either host-persisted role is sufficient after hydration/migration.
  const delegation = child.delegation
  child.delegation = undefined
  expect(host.getCollectionCacheScope(child)?.freshEvidence).toBe(true)
  child.delegation = delegation
  child.activeObjective = { ...child.activeObjective, delegatedRole: undefined }
  expect(host.getCollectionCacheScope(child)?.freshEvidence).toBe(true)
 }finally{
  loader.mockRestore()
  for(const id of host.sessions.keys())cleanupModeState(id)
  rmSync(rootPath,{recursive:true,force:true})
 }
})
