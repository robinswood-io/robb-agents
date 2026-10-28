import { omitUndefined } from '@craft-agent/shared/utils/json';
import * as React from "react";

import { AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { Spinner } from "@craft-agent/ui";

import type { Session, FileAttachment, CredentialResponse } from "../../../shared/types";

import { TurnCard, JourneyProgress, UserInputCard, formatTurnAsMarkdown, getAssistantTurnUiKey, type Turn } from "@craft-agent/ui";
import { MemoizedAuthRequestCard } from "@/components/chat/AuthRequestCard";

import { PermissionRecoveryCard } from './PermissionRecoveryCard';
import { routes } from "@/lib/navigate";
import { CHAT_LAYOUT } from "@/config/layout";
import { collectFileChangesFromActivities, getFirstFileChangeIdForActivity } from "@/lib/file-changes";

import { buildBranchSessionOptions, resolveBranchNewPanelOption } from "./branching";

import { AutonomyPanel } from "./AutonomyPanel";

import { type PendingFollowUpAnnotation } from './ChatDisplay.follow-ups';
import { type OverlayState, getTurnKey, ScrollOnMount } from "./chat-display-contracts";
import { MemoizedMessageBubble } from "./chat-message-bubbles";

interface ChatTranscriptViewportProps {
  scrollViewportRef: React.RefObject<HTMLDivElement | null>; compactMode: boolean;
  session: Session; messagesLoading: boolean;
  messagesLoadError: string | null | undefined; t: import("i18next").TFunction<"translation", undefined>;
  onRetryMessagesLoad: (() => void) | undefined; messagesRetrying: boolean;
  skipScrollToBottom: boolean; handleInitialTranscriptScroll: () => void;
  turns: Turn[]; hasMoreAbove: boolean;
  startIndex: number; visibleTimeline: import("@craft-agent/ui/chat").ConversationTimelineEntry[];
  respondToUserInput: (sessionId: string, response: import("@craft-agent/core").UserInputResponse) => Promise<import("@craft-agent/core").UserInputResponseResult>; isSearchActive: boolean;
  matchingTurnIds: string[]; currentMatchIndex: number;
  turnRefs: React.RefObject<Map<string, HTMLDivElement>>; onOpenFile: (path: string) => void;
  onOpenUrl: (url: string) => void; onRespondToCredential: ((sessionId: string, requestId: string, response: CredentialResponse) => void | Promise<void>) | undefined;
  pendingFollowUpAnnotations: PendingFollowUpAnnotation[]; expandedTurns: Set<string>;
  toggleTurn: (turnId: string, expanded: boolean) => void; expandedActivityGroups: Set<string>;
  setExpandedActivityGroups: React.Dispatch<React.SetStateAction<Set<string>>>; sendMessageKey: "enter" | "cmd-enter";
  openAnnotationRequest: { messageId: string; annotationId: string; mode: "view" | "edit"; anchorX?: number; anchorY?: number; nonce: number; } | null; onSendMessage: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void;
  appShellContext: import("@/context/AppShellContext").AppShellContextType; navigate: (route: import("@/lib/navigate").Route, options?: import("@/lib/navigate").NavigateOptions) => void | Promise<void>;
  handleSaveAndSendFollowUp: (_target: { messageId: string; annotationId: string; note: string; selectedText: string; }) => void; setOverlayState: React.Dispatch<React.SetStateAction<OverlayState>>;
  pendingDescendantAuthRequests: import("../../atoms/session-auth-requests").PendingSessionAuthRequest[]; permissionRecoveries: import("../../atoms/session-permission-recovery").SessionPermissionRecovery[];
  presentation: import("@craft-agent/ui/chat").ConversationPresentation; agentActivity: import("../../atoms/session-journey-activity").ConversationAgentActivity;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export function ChatTranscriptViewport({
  scrollViewportRef, compactMode,
  session, messagesLoading,
  messagesLoadError, t,
  onRetryMessagesLoad, messagesRetrying,
  skipScrollToBottom, handleInitialTranscriptScroll,
  turns, hasMoreAbove,
  startIndex, visibleTimeline,
  respondToUserInput, isSearchActive,
  matchingTurnIds, currentMatchIndex,
  turnRefs, onOpenFile,
  onOpenUrl, onRespondToCredential,
  pendingFollowUpAnnotations, expandedTurns,
  toggleTurn, expandedActivityGroups,
  setExpandedActivityGroups, sendMessageKey,
  openAnnotationRequest, onSendMessage,
  appShellContext, navigate,
  handleSaveAndSendFollowUp, setOverlayState,
  pendingDescendantAuthRequests, permissionRecoveries,
  presentation, agentActivity,
  messagesEndRef,
}: ChatTranscriptViewportProps) {
  return (
<ScrollArea className="h-full min-w-0" viewportRef={scrollViewportRef}>
              <div className={cn(
                CHAT_LAYOUT.maxWidth,
                "mx-auto min-w-0",
                compactMode ? "px-3 py-4 space-y-2" : [CHAT_LAYOUT.containerPadding, CHAT_LAYOUT.messageSpacing]
              )}>
                {/* Session-level AnimatePresence: Prevents layout jump when switching sessions */}
                <AnimatePresence mode={compactMode ? "sync" : "wait"} initial={false}>
                  <motion.div
                    key={compactMode ? 'compact-session' : session?.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={compactMode ? { duration: 0 } : { duration: 0.1, ease: 'easeOut' }}
                  >
                    {/* Loading/Content AnimatePresence: sync mode avoids stale loading exits masking ready content */}
                    <AnimatePresence mode="sync" initial={false}>
                    {messagesLoading ? (
                      /* Loading State: Show spinner while messages are being lazy loaded */
                      <motion.div
                        key="loading"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={compactMode ? { duration: 0 } : { duration: 0.1 }}
                        className="flex items-center justify-center h-64"
                      >
                        <Spinner className="text-foreground/30" />
                      </motion.div>
                    ) : messagesLoadError ? (
                      <motion.div
                        key="load-error"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={compactMode ? { duration: 0 } : { duration: 0.1 }}
                        className="flex items-center justify-center h-64 px-4"
                      >
                        <div
                          className="max-w-sm rounded-[8px] border border-destructive/20 px-4 py-3 text-center shadow-tinted"
                          style={{
                            backgroundColor: 'oklch(from var(--destructive) l c h / 0.03)',
                            '--shadow-color': 'var(--destructive-rgb)',
                          } as React.CSSProperties}
                        >
                          <AlertTriangle className="mx-auto mb-2 h-4 w-4 text-destructive/70" />
                          <div className="text-sm font-medium text-destructive">{t("chat.failedToLoadConversation")}</div>
                          {onRetryMessagesLoad && (
                            <button
                              type="button"
                              onClick={onRetryMessagesLoad}
                              disabled={messagesRetrying}
                              className="mt-3 rounded border border-destructive/20 px-2 py-0.5 text-xs text-destructive/70 transition-colors hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {messagesRetrying ? t("common.retrying") : t("common.retry")}
                            </button>
                          )}
                        </div>
                      </motion.div>
                    ) : (
                    /* Turn-based Message Display - memoized to avoid re-grouping on every render */
                    /* AnimatePresence handles the fade-in animation when transitioning from loading */
                    <motion.div
                      key={compactMode ? 'loaded-compact' : `loaded-${session?.id}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={compactMode ? { duration: 0 } : { duration: 0.1, ease: 'easeOut' }}
                    >
                  {/* Scroll to bottom before paint - fires via useLayoutEffect */}
                  {/* Skip when search is active on session switch - scroll to first match instead */}
                  <ScrollOnMount
                    viewportRef={scrollViewportRef}
                    resetKey={session.id}
                    skip={skipScrollToBottom}
                    onScroll={handleInitialTranscriptScroll}
                  />
                  {!compactMode && <AutonomyPanel session={session} />}
                  {/* Empty state for compact mode - inviting conversational prompt, centered in full popover */}
                  {compactMode && turns.length === 0 && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center select-none gap-1 pointer-events-none">
                      <span className="text-sm text-muted-foreground">{t("editPopover.whatToChange")}</span>
                      <span className="text-xs text-muted-foreground/50">{t("editPopover.justDescribe")}</span>
                    </div>
                  )}
                  {/* Load more indicator - shown when there are older messages */}
                  {hasMoreAbove && (
                    <div className="text-center text-muted-foreground/60 text-xs py-3 select-none">
                      ↑ {t('chat.scrollUpForEarlier', { count: startIndex })}
                    </div>
                  )}
                  {visibleTimeline.map(entry => {
                    if (entry.type === 'user-input') {
                      return <UserInputCard key={`user-input-${entry.request.id}`} request={entry.request}
                        onRespond={respondToUserInput} />
                    }
                    const { turn } = entry
                    const index = entry.turnIndex - startIndex
                    // Compute turn key and check if it's a search match
                    const turnKey = getTurnKey(turn)
                    const isCurrentMatch = isSearchActive && matchingTurnIds[currentMatchIndex] === turnKey
                    const isAnyMatch = isSearchActive && matchingTurnIds.includes(turnKey)

                    // User turns - render with MemoizedMessageBubble
                    // Extra padding creates visual separation from AI responses
                    if (turn.type === 'user') {
                      return (
                        <div
                          key={turnKey}
                          ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                          className={cn(
                            compactMode ? "pt-2 pb-1" : CHAT_LAYOUT.userMessagePadding,
                            "rounded-lg transition-all duration-200",
                            isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                            isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                          )}
                        >
                          <MemoizedMessageBubble
                            message={turn.message}
                            onOpenFile={onOpenFile}
                            onOpenUrl={onOpenUrl}
                            sessionId={session?.id}
                            compactMode={compactMode}
                          />
                        </div>
                      )
                    }

                    // System turns (error, status, info, warning) - render with MemoizedMessageBubble
                    if (turn.type === 'system') {
                      return (
                        <div
                          key={turnKey}
                          ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                          className={cn(
                            "rounded-lg transition-all duration-200",
                            isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                            isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                          )}
                        >
                          <MemoizedMessageBubble
                            message={turn.message}
                            onOpenFile={onOpenFile}
                            onOpenUrl={onOpenUrl}
                            sessionId={session?.id}
                          />
                        </div>
                      )
                    }

                    // Auth-request turns - render inline auth UI
                    // mt-2 matches ResponseCard spacing for visual consistency
                    if (turn.type === 'auth-request') {
                      // Interactive only if no user message follows
                      const isAuthInteractive = !turns.slice(index + 1).some(t => t.type === 'user')
                      return (
                        <div
                          key={turnKey}
                          ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                          className={cn(
                            "mt-2 rounded-lg transition-all duration-200",
                            isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                            isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                          )}
                        >
                          <MemoizedAuthRequestCard
                            message={turn.message}
                            sessionId={session.id}
                            onRespondToCredential={onRespondToCredential}
                            isInteractive={isAuthInteractive}
                          />
                        </div>
                      )
                    }

                    // Check if this is the last response (for Accept Plan button visibility)
                    const isLastResponse = index === turns.length - 1 || !turns.slice(index + 1).some(t => t.type === 'user')

                    // Assistant turns - render with TurnCard (buffered streaming)
                    const assistantUiKey = getAssistantTurnUiKey(turn, index)
                    return (
                      <div
                        key={turnKey}
                        ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                        className={cn(
                          "pt-2",
                          "rounded-lg transition-all duration-200",
                          isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                          isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                        )}
                      >
                      <TurnCard
                        sessionId={session.id}
                        sessionFolderPath={session.sessionFolderPath}
                        hasActiveFollowUpAnnotations={pendingFollowUpAnnotations.length > 0}
                        turnId={turn.turnId}
                        activities={turn.activities}
                        response={turn.response}
                        intent={turn.intent}
                        isStreaming={turn.isStreaming}
                        isComplete={turn.isComplete}
                        isExpanded={expandedTurns.has(assistantUiKey)}
                        onExpandedChange={(expanded) => toggleTurn(assistantUiKey, expanded)}
                        expandedActivityGroups={expandedActivityGroups}
                        onExpandedActivityGroupsChange={setExpandedActivityGroups}
                        todos={turn.todos}
                        onOpenFile={onOpenFile}
                        onOpenUrl={onOpenUrl}
                        isLastResponse={isLastResponse}
                        compactMode={compactMode}
                        presentation="codex"
                        displayMode="informative"
                        sendMessageKey={sendMessageKey}
                        openAnnotationRequest={openAnnotationRequest}
                        onQuickAction={(actionText) => onSendMessage(actionText)}
                        onBranch={session?.supportsBranching ? async (messageId: string, options?: { newPanel?: boolean }) => {
                          if (!session) return
                          try {
                            const child = await appShellContext.onCreateSession(
                              session.workspaceId,
                              buildBranchSessionOptions(session, messageId)
                            )
                            navigate(routes.view.allSessions(child.id), { newPanel: resolveBranchNewPanelOption(options) })
                          } catch (error) {
                            const rawMessage = error instanceof Error ? error.message : 'Failed to create branch'
                            const message = rawMessage.includes('source and target providers must match')
                              || rawMessage.includes('same provider/backend')
                              ? 'Branching is only supported within the same provider/backend. Switch this panel connection and try again.'
                              : rawMessage
                            toast.error(t('toast.couldNotCreateBranch'), { description: message })
                          }
                        } : undefined}
                        onAddAnnotation={async (messageId, annotation) => {
                          if (!session) return
                          try {
                            await window.electronAPI.sessionCommand(session.id, {
                              type: 'addAnnotation',
                              messageId,
                              annotation,
                            })
                          } catch (error) {
                            toast.error(t('toast.couldNotSaveHighlight'), {
                              description: error instanceof Error ? error.message : 'Unknown error',
                            })
                            throw error
                          }
                        }}
                        onRemoveAnnotation={async (messageId, annotationId) => {
                          if (!session) return
                          try {
                            await window.electronAPI.sessionCommand(session.id, {
                              type: 'removeAnnotation',
                              messageId,
                              annotationId,
                            })
                          } catch (error) {
                            toast.error(t('toast.couldNotRemoveHighlight'), {
                              description: error instanceof Error ? error.message : 'Unknown error',
                            })
                          }
                        }}
                        onUpdateAnnotation={async (messageId, annotationId, patch) => {
                          if (!session) return
                          try {
                            await window.electronAPI.sessionCommand(session.id, {
                              type: 'updateAnnotation',
                              messageId,
                              annotationId,
                              patch,
                            })
                          } catch (error) {
                            toast.error(t('toast.couldNotUpdateHighlight'), {
                              description: error instanceof Error ? error.message : 'Unknown error',
                            })
                            throw error
                          }
                        }}
                        onSaveAndSendFollowUp={handleSaveAndSendFollowUp}
                        onAcceptPlan={() => {
                          const planMessage = session?.messages.findLast(m => m.role === 'plan')
                          const planPath = planMessage?.planPath

                          window.dispatchEvent(new CustomEvent('craft:approve-plan', {
                            detail: {
                              sessionId: session?.id,
                              planPath,
                              includeDraftInput: true,
                              source: 'plan-card',
                            },
                          }))
                        }}
                        onAcceptPlanWithCompact={() => {
                          const planMessage = session?.messages.findLast(m => m.role === 'plan')
                          const planPath = planMessage?.planPath

                          window.dispatchEvent(new CustomEvent('craft:approve-plan-with-compact', {
                            detail: {
                              sessionId: session?.id,
                              planPath,
                              includeDraftInput: true,
                              source: 'plan-card',
                            },
                          }))
                        }}
                        onPopOut={(text) => {
                          // Open raw markdown source in code viewer
                          setOverlayState({
                            type: 'markdown',
                            content: text,
                            title: 'Response Preview',
                            forceCodeView: true,
                          })
                        }}
                        onOpenDetails={() => {
                          // Open turn details in markdown overlay
                          const markdown = formatTurnAsMarkdown(turn)
                          setOverlayState({
                            type: 'markdown',
                            content: markdown,
                            title: 'Turn Details',
                          })
                        }}
                        onOpenActivityDetails={(activity) => {
                          // Write tool for .md/.txt → Document overlay (rendered markdown)
                          // rather than multi-diff, since these are better viewed as formatted documents
                          const isDocumentWrite = activity.toolName === 'Write' && (() => {
                            const actInput = activity.toolInput as Record<string, unknown> | undefined
                            const fp = (actInput?.["file_path"] as string) || ''
                            const ext = fp.split('.').pop()?.toLowerCase()
                            return ext === 'md' || ext === 'txt'
                          })()

                          // Edit/Write tool → Multi-file diff overlay (ungrouped, focused on this change)
                          // Exception: Write to .md/.txt files goes to document overlay instead
                          if ((activity.toolName === 'Edit' || activity.toolName === 'Write') && !isDocumentWrite) {
                            const changes = collectFileChangesFromActivities(turn.activities)
                            if (changes.length > 0) {
                              setOverlayState(omitUndefined({
                                type: 'multi-diff' as const,
                                changes,
                                consolidated: false as const, // Ungrouped mode - show individual changes
                                focusedChangeId: getFirstFileChangeIdForActivity(activity.id, changes),
                              }))
                            }
                          } else {
                            // All other tools → open generic activity cards overlay (Input/Output)
                            setOverlayState({ type: 'activity', activity })
                          }
                        }}
                        hasEditOrWriteActivities={turn.activities.some(a =>
                          a.toolName === 'Edit' || a.toolName === 'Write'
                        )}
                        onOpenMultiFileDiff={() => {
                          const changes = collectFileChangesFromActivities(turn.activities)
                          if (changes.length > 0) {
                            setOverlayState({
                              type: 'multi-diff',
                              changes,
                              consolidated: true, // Consolidated mode - group by file
                            })
                          }
                        }}
                      />
                      </div>
                    )
                  })}
                    </motion.div>
                    )}
                    </AnimatePresence>
                  </motion.div>
                </AnimatePresence>
                {pendingDescendantAuthRequests.map(request => (
                  <div key={`auth-${request.sessionId}-${request.message.id}`} className="mt-2">
                    <MemoizedAuthRequestCard
                      message={request.message}
                      sessionId={request.sessionId}
                      onRespondToCredential={onRespondToCredential}
                      isInteractive
                    />
                  </div>
                ))}
                {permissionRecoveries.map(request => (
                  <PermissionRecoveryCard key={`${request.sessionId}-${request.requestId}`} request={request}
                    showSessionName={request.sessionId !== session.id} />
                ))}
                {!messagesLoading && !messagesLoadError && presentation.progress && (
                  <JourneyProgress progress={presentation.progress} agents={agentActivity} presentation="codex" />
                )}
                {/* Scroll Anchor: For auto-scroll to bottom */}
                <div ref={messagesEndRef} />
              </div>
              </ScrollArea>
  )
}
