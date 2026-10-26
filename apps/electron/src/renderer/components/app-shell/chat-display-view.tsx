import * as React from "react";

import { ChevronDown, Info } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

import { ActivityCardsOverlay, CodePreviewOverlay, MultiDiffPreviewOverlay, TerminalPreviewOverlay, GenericOverlay, JSONPreviewOverlay, DocumentFormattedMarkdownOverlay, detectLanguage, type DiffViewerSettings } from "@craft-agent/ui";

import type { Session, FileAttachment, CredentialResponse, LoadedSkill } from "../../../shared/types";
import type { PermissionMode } from "@craft-agent/shared/agent/modes";
import type { ThinkingLevel } from "@craft-agent/shared/agent/thinking-levels";
import { type Turn } from "@craft-agent/ui";

import { type StructuredResponse } from "./input";
import type { RichTextInputHandle } from "@/components/ui/rich-text-input";

import { type PendingFollowUpAnnotation } from './ChatDisplay.follow-ups';
import { ChatTranscriptViewport } from "./ChatTranscriptViewport";
import { ChatInputZoneView } from "./ChatInputZoneView";
import { type OverlayState } from "./chat-display-contracts";

interface ChatDisplayViewProps {
  zoneRef: React.RefObject<HTMLDivElement | null>; session: Session | null; scrollViewportRef: React.RefObject<HTMLDivElement | null>;
  compactMode: boolean; messagesLoading: boolean; messagesLoadError: string | null | undefined;
  t: import("i18next").TFunction<"translation", undefined>; onRetryMessagesLoad: (() => void) | undefined; messagesRetrying: boolean;
  skipScrollToBottom: boolean; handleInitialTranscriptScroll: () => void; turns: Turn[];
  hasMoreAbove: boolean; startIndex: number; visibleTimeline: import("@craft-agent/ui/chat").ConversationTimelineEntry[];
  respondToUserInput: (sessionId: string, response: import("@craft-agent/core").UserInputResponse) => Promise<import("@craft-agent/core").UserInputResponseResult>; isSearchActive: boolean; matchingTurnIds: string[];
  currentMatchIndex: number; turnRefs: React.RefObject<Map<string, HTMLDivElement>>; onOpenFile: (path: string) => void;
  onOpenUrl: (url: string) => void; onRespondToCredential: ((sessionId: string, requestId: string, response: CredentialResponse) => void | Promise<void>) | undefined; pendingFollowUpAnnotations: PendingFollowUpAnnotation[];
  expandedTurns: Set<string>; toggleTurn: (turnId: string, expanded: boolean) => void; expandedActivityGroups: Set<string>;
  setExpandedActivityGroups: React.Dispatch<React.SetStateAction<Set<string>>>; sendMessageKey: "enter" | "cmd-enter"; openAnnotationRequest: { messageId: string; annotationId: string; mode: "view" | "edit"; anchorX?: number; anchorY?: number; nonce: number; } | null;
  onSendMessage: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void; appShellContext: import("@/context/AppShellContext").AppShellContextType; navigate: (route: import("@/lib/navigate").Route, options?: import("@/lib/navigate").NavigateOptions) => void | Promise<void>;
  handleSaveAndSendFollowUp: (_target: { messageId: string; annotationId: string; note: string; selectedText: string; }) => void; setOverlayState: React.Dispatch<React.SetStateAction<OverlayState>>; pendingDescendantAuthRequests: import("../../atoms/session-auth-requests").PendingSessionAuthRequest[];
  permissionRecoveries: import("../../atoms/session-permission-recovery").SessionPermissionRecovery[]; presentation: import("@craft-agent/ui/chat").ConversationPresentation; agentActivity: import("../../atoms/session-journey-activity").ConversationAgentActivity;
  messagesEndRef: React.RefObject<HTMLDivElement | null>; showScrollToLatest: boolean; handleReturnToLatestMessage: () => void;
  permissionMode: PermissionMode; onPermissionModeChange: ((mode: PermissionMode) => void) | undefined; sessionFolderPath: string | undefined;
  onInputChange: ((value: string) => void) | undefined; labels: import("@craft-agent/shared/labels").LabelConfig[] | undefined; onLabelsChange: ((labels: string[]) => void) | undefined;
  sessionStatuses: import("@/config/session-status-config").SessionStatus[] | undefined; onSessionStatusChange: ((stateId: string) => void) | undefined; placeholder: string | string[] | undefined;
  isInputDisabled: boolean; isConversationProcessing: boolean; handleAnimatedHeightChange: (delta: number) => void;
  handleSubmit: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void; handleStop: (silent?: boolean) => void; textareaRef: React.RefObject<RichTextInputHandle | null>;
  currentModel: string; onModelChange: (model: string | null, connection?: string) => void; thinkingLevel: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  onThinkingLevelChange: ((level: ThinkingLevel) => void) | undefined; enabledModes: PermissionMode[] | undefined; enableCompactModelPicker: boolean;
  structuredInput: import("./input").StructuredInputData | undefined; handleStructuredResponse: (response: StructuredResponse) => void | Promise<void>; inputValue: string | undefined;
  attachmentsValue: FileAttachment[] | undefined; onAttachmentsChange: ((attachments: FileAttachment[]) => void) | undefined; skills: LoadedSkill[] | undefined;
  workspaceId: string | undefined; workingDirectory: string | undefined; onWorkingDirectoryChange: ((path: string) => void) | undefined;
  disableSend: boolean; connectionUnavailable: boolean; onConnectionChange: ((connectionSlug: string) => void) | undefined;
  followUpInputItems: { id: string; messageId: string; annotationId: string; index: number; noteLabel: string; selectedText: string; color: string | undefined; }[]; handleFollowUpChipClick: (item: { messageId: string; annotationId: string; }, anchor?: { x: number; y: number; }) => void; handleFollowUpIndexClick: (item: { messageId: string; annotationId: string; }) => void;
  overlayState: OverlayState; useStackedActivityOverlay: boolean; handleCloseOverlay: () => void;
  overlayCards: import("@craft-agent/ui").OverlayCard[]; isDark: boolean; activityOutputOverlayData: import("@craft-agent/ui").OverlayData | null;
  diffViewerSettings: Partial<DiffViewerSettings>; handleDiffViewerSettingsChange: (settings: DiffViewerSettings) => void;
}

export function ChatDisplayView({
  zoneRef, session, scrollViewportRef,
  compactMode, messagesLoading, messagesLoadError,
  t, onRetryMessagesLoad, messagesRetrying,
  skipScrollToBottom, handleInitialTranscriptScroll, turns,
  hasMoreAbove, startIndex, visibleTimeline,
  respondToUserInput, isSearchActive, matchingTurnIds,
  currentMatchIndex, turnRefs, onOpenFile,
  onOpenUrl, onRespondToCredential, pendingFollowUpAnnotations,
  expandedTurns, toggleTurn, expandedActivityGroups,
  setExpandedActivityGroups, sendMessageKey, openAnnotationRequest,
  onSendMessage, appShellContext, navigate,
  handleSaveAndSendFollowUp, setOverlayState, pendingDescendantAuthRequests,
  permissionRecoveries, presentation, agentActivity,
  messagesEndRef, showScrollToLatest, handleReturnToLatestMessage,
  permissionMode, onPermissionModeChange, sessionFolderPath,
  onInputChange, labels, onLabelsChange,
  sessionStatuses, onSessionStatusChange, placeholder,
  isInputDisabled, isConversationProcessing, handleAnimatedHeightChange,
  handleSubmit, handleStop, textareaRef,
  currentModel, onModelChange, thinkingLevel,
  onThinkingLevelChange, enabledModes, enableCompactModelPicker,
  structuredInput, handleStructuredResponse, inputValue,
  attachmentsValue, onAttachmentsChange, skills,
  workspaceId, workingDirectory, onWorkingDirectoryChange,
  disableSend, connectionUnavailable, onConnectionChange,
  followUpInputItems, handleFollowUpChipClick, handleFollowUpIndexClick,
  overlayState, useStackedActivityOverlay, handleCloseOverlay,
  overlayCards, isDark, activityOutputOverlayData,
  diffViewerSettings, handleDiffViewerSettingsChange,
}: ChatDisplayViewProps) {

  return (
    <div ref={zoneRef} className="flex h-full flex-col min-w-0" data-focus-zone="chat">
      {session ? (
        <div className="flex flex-1 flex-col min-h-0 min-w-0 relative">
          {/* Content layer */}
          <div className="flex flex-1 flex-col min-h-0 min-w-0 relative z-10">
          {/* === MESSAGES AREA: Scrollable list of message bubbles === */}
          <div className="relative flex-1 min-h-0">
            {/* Mask wrapper - fades content at top and bottom over transparent/image backgrounds */}
            <div
              className="h-full"
              style={{
                maskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
              }}
            >
              <ChatTranscriptViewport
  scrollViewportRef={scrollViewportRef}
  compactMode={compactMode}
  session={session}
  messagesLoading={messagesLoading}
  messagesLoadError={messagesLoadError}
  t={t}
  onRetryMessagesLoad={onRetryMessagesLoad}
  messagesRetrying={messagesRetrying}
  skipScrollToBottom={skipScrollToBottom}
  handleInitialTranscriptScroll={handleInitialTranscriptScroll}
  turns={turns}
  hasMoreAbove={hasMoreAbove}
  startIndex={startIndex}
  visibleTimeline={visibleTimeline}
  respondToUserInput={respondToUserInput}
  isSearchActive={isSearchActive}
  matchingTurnIds={matchingTurnIds}
  currentMatchIndex={currentMatchIndex}
  turnRefs={turnRefs}
  onOpenFile={onOpenFile}
  onOpenUrl={onOpenUrl}
  onRespondToCredential={onRespondToCredential}
  pendingFollowUpAnnotations={pendingFollowUpAnnotations}
  expandedTurns={expandedTurns}
  toggleTurn={toggleTurn}
  expandedActivityGroups={expandedActivityGroups}
  setExpandedActivityGroups={setExpandedActivityGroups}
  sendMessageKey={sendMessageKey}
  openAnnotationRequest={openAnnotationRequest}
  onSendMessage={onSendMessage}
  appShellContext={appShellContext}
  navigate={navigate}
  handleSaveAndSendFollowUp={handleSaveAndSendFollowUp}
  setOverlayState={setOverlayState}
  pendingDescendantAuthRequests={pendingDescendantAuthRequests}
  permissionRecoveries={permissionRecoveries}
  presentation={presentation}
  agentActivity={agentActivity}
  messagesEndRef={messagesEndRef}
/>
            </div>
            <AnimatePresence initial={false}>
              {!compactMode && showScrollToLatest && (
                <motion.button
                  type="button"
                  aria-label={t('chat.returnToLatestMessage', { defaultValue: 'Return to latest message' })}
                  title={t('chat.returnToLatestMessage', { defaultValue: 'Return to latest message' })}
                  onClick={handleReturnToLatestMessage}
                  className="absolute bottom-3 left-1/2 z-20 inline-flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border/70 bg-background/95 text-muted-foreground shadow-minimal backdrop-blur-sm transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  initial={{ opacity: 0, scale: 0.92, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.92, y: 4 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">
                    {t('chat.returnToLatestMessage', { defaultValue: 'Return to latest message' })}
                  </span>
                </motion.button>
              )}
            </AnimatePresence>
          </div>

          {/* === INPUT CONTAINER: FreeForm or Structured Input === */}
          <ChatInputZoneView
  compactMode={compactMode}
  permissionMode={permissionMode}
  onPermissionModeChange={onPermissionModeChange}
  session={session}
  sessionFolderPath={sessionFolderPath}
  onInputChange={onInputChange}
  labels={labels}
  onLabelsChange={onLabelsChange}
  sessionStatuses={sessionStatuses}
  onSessionStatusChange={onSessionStatusChange}
  placeholder={placeholder}
  isInputDisabled={isInputDisabled}
  isConversationProcessing={isConversationProcessing}
  handleAnimatedHeightChange={handleAnimatedHeightChange}
  handleSubmit={handleSubmit}
  handleStop={handleStop}
  textareaRef={textareaRef}
  currentModel={currentModel}
  onModelChange={onModelChange}
  thinkingLevel={thinkingLevel}
  onThinkingLevelChange={onThinkingLevelChange}
  enabledModes={enabledModes}
  enableCompactModelPicker={enableCompactModelPicker}
  structuredInput={structuredInput}
  handleStructuredResponse={handleStructuredResponse}
  inputValue={inputValue}
  attachmentsValue={attachmentsValue}
  onAttachmentsChange={onAttachmentsChange}
  skills={skills}
  workspaceId={workspaceId}
  workingDirectory={workingDirectory}
  onWorkingDirectoryChange={onWorkingDirectoryChange}
  disableSend={disableSend}
  connectionUnavailable={connectionUnavailable}
  onConnectionChange={onConnectionChange}
  followUpInputItems={followUpInputItems}
  handleFollowUpChipClick={handleFollowUpChipClick}
  handleFollowUpIndexClick={handleFollowUpIndexClick}
/>
          </div>
        </div>
      ) : null}

      {/* ================================================================== */}
      {/* Preview Overlays - Rendered outside the main chat flow            */}
      {/* ================================================================== */}

      {/* Activity details overlay */}
      {overlayState?.type === 'activity' && useStackedActivityOverlay && (
        <ActivityCardsOverlay
          isOpen={true}
          onClose={handleCloseOverlay}
          cards={overlayCards}
          title={overlayState.activity.displayName || overlayState.activity.toolName || 'Activity'}
          theme={isDark ? 'dark' : 'light'}
          onOpenUrl={onOpenUrl}
          onOpenFile={onOpenFile}
        />
      )}

      {/* Legacy output-only activity overlay for non-bash/non-mcp tools */}
      {overlayState?.type === 'activity' && !useStackedActivityOverlay && activityOutputOverlayData && (
        activityOutputOverlayData.type === 'code' ? (
          <CodePreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            filePath={activityOutputOverlayData.filePath}
            mode={activityOutputOverlayData.mode}
            startLine={activityOutputOverlayData.startLine}
            totalLines={activityOutputOverlayData.totalLines}
            numLines={activityOutputOverlayData.numLines}
            command={activityOutputOverlayData.command}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'terminal' ? (
          <TerminalPreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            command={activityOutputOverlayData.command}
            output={activityOutputOverlayData.output}
            exitCode={activityOutputOverlayData.exitCode}
            toolType={activityOutputOverlayData.toolType}
            description={activityOutputOverlayData.description}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'json' ? (
          <JSONPreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            data={activityOutputOverlayData.data}
            title={activityOutputOverlayData.title}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'document' ? (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
            filePath={activityOutputOverlayData.filePath}
            typeBadge={{
              icon: Info,
              label: activityOutputOverlayData.toolName,
              variant: 'blue',
            }}
            error={activityOutputOverlayData.error}
          />
        ) : detectLanguage(activityOutputOverlayData.content) === 'markdown' ? (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
            typeBadge={{
              icon: Info,
              label: overlayState.activity.displayName || overlayState.activity.toolName || 'Activity',
              variant: 'blue',
            }}
            error={activityOutputOverlayData.error}
          />
        ) : (
          <GenericOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            title={activityOutputOverlayData.title}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        )
      )}

      {/* Multi-diff preview overlay (Edit/Write tools) */}
      {overlayState?.type === 'multi-diff' && (
        <MultiDiffPreviewOverlay
          isOpen={true}
          onClose={handleCloseOverlay}
          changes={overlayState.changes}
          consolidated={overlayState.consolidated}
          focusedChangeId={overlayState.focusedChangeId}
          theme={isDark ? 'dark' : 'light'}
          diffViewerSettings={diffViewerSettings}
          onDiffViewerSettingsChange={handleDiffViewerSettingsChange}
        />
      )}

      {/* Markdown preview overlay (pop-out, turn details) */}
      {/* forceCodeView: show raw markdown source in code viewer (used by "View as Markdown" button) */}
      {/* otherwise: render formatted markdown (used by turn details, etc.) */}
      {overlayState?.type === 'markdown' && (
        overlayState.forceCodeView ? (
          <CodePreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={overlayState.content}
            filePath="response.md"
            language="markdown"
            mode="read"
            theme={isDark ? 'dark' : 'light'}
          />
        ) : (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={overlayState.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
          />
        )
      )}
    </div>
  )
}
