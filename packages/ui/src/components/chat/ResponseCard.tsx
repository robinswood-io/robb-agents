

import "i18next";
import { useTranslation } from 'react-i18next';
import "@craft-agent/core/utils";

import { FileText, Copy, Check, Maximize2, ListTodo } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Markdown } from '../markdown';
import { Spinner } from '../ui/LoadingIndicator';
import "../annotations/AnnotationIslandMenu";
import "../annotations/island-motion";
import "../tooltip";
import "@pierre/diffs";
import "../code-viewer";

import "./follow-up-helpers";
import "../annotations/follow-up-state";
import "../annotations/annotation-core";
import "../annotations/annotation-style-tokens";
import "../annotations/block-markers";
import "../annotations/annotation-host-config";
import "../annotations/selection-restore";
import "../annotations/interaction-policy";
import "../annotations/annotation-overlay-geometry";
import "../annotations/AnnotationOverlayLayer";
import "../annotations/interaction-selectors";
import "../annotations/use-annotation-interaction-controller";
import "../annotations/use-annotation-island-presentation";
import "../annotations/use-annotation-island-events";
import "../annotations/use-annotation-cancel-restore";
import { DocumentFormattedMarkdownOverlay } from '../overlay';
import { AcceptPlanDropdown } from './AcceptPlanDropdown';
import { CompactAcceptPlanDrawer } from './CompactAcceptPlanDrawer';
import "../ui/StyledDropdown";
import { useResponseBuffer } from "./use-response-buffer";
import { useResponseSelectionMenu } from "./use-response-selection-menu";
import { useResponseTextSelection } from "./use-response-text-selection";
import { useResponseFollowUps } from "./use-response-follow-ups";
import { useResponseAnnotations } from "./use-response-annotations";
import { useResponseSelection } from "./use-response-selection";
import { SIZE_CONFIG } from "./turn-card-contracts";

import { type ResponseCardProps, BranchDropdown, MAX_HEIGHT } from "./turn-card-response-helpers";

export function ResponseCard({
  text,
  isStreaming,
  streamStartTime,
  onOpenFile,
  onOpenUrl,
  onPopOut,
  variant = 'response',
  presentation = 'default',
  sessionId,
  messageId,
  annotations,
  onAccept,
  onAcceptWithCompact,
  isLastResponse = true,
  showAcceptPlan = true,
  compactMode = false,
  onBranch,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onSaveAndSendFollowUp,
  hasActiveFollowUpAnnotations = false,
  openAnnotationRequest,
  annotationInteractionMode = 'interactive',
}: ResponseCardProps) {
  const { t } = useTranslation()
  // Throttled content for display - updates every CONTENT_THROTTLE_MS during streaming
  const {
    pendingSelection,
    selectionMenuView,
    activeAnnotationDetail,
    closeSelectionMenu,
    contentLayerRef,
    setAnnotationOverlay,
    displayedText,
    canAnnotate,
    resetPresentation,
    dragStartPointerRef,
    lastPointerRef,
    interactionState,
    isSelectionMenuVisible,
    selectionMenuOpenedAtRef,
    isTargetInsideAnnotationIsland,
    openFollowUpFromSelection,
    requestEdit,
    markSubmitSuccess,
    cancelFollowUp,
    allowAnnotationIsland,
    setSelectionMenuTransitionConfig,
    triggerSelectionMenuEntryReplay,
    openFromAnnotation,
    consumeExternalOpenRequest,
    markDeleteSuccess,
    selectionStartedInContentRef,
    openFromSelection,
    selectionMenuRenderAnchor,
    selectionMenuRenderSourceKey,
    selectionMenuShowNonce,
    followUpMode,
    followUpDraft,
    setFollowUpDraft,
    selectionMenuTransitionConfig,
    handleSelectionMenuExitComplete,
    annotationOverlay,
    setDisplayedText,
    lastUpdateRef,
    setIsFullscreen,
    contentRef,
    isDarkMode,
    handleCopy,
    copied,
    isFullscreen,
  } = useResponseSelection({
    text, onAddAnnotation, messageId, isStreaming, annotationInteractionMode,
  })

  const {
    activeAnnotation,
    handleOpenFollowUpView,
    renderedAnnotations,
  } = useResponseAnnotations({
    annotations, pendingSelection, selectionMenuView, messageId, sessionId,
    activeAnnotationDetail, closeSelectionMenu, contentLayerRef, setAnnotationOverlay, text,
    displayedText, isStreaming, canAnnotate, resetPresentation, dragStartPointerRef,
    lastPointerRef, interactionState, isSelectionMenuVisible, selectionMenuOpenedAtRef, isTargetInsideAnnotationIsland,
    openFollowUpFromSelection,
  })

  const {
    handleCancelFollowUp,
    handleRequestFollowUpEdit,
    handleSubmitFollowUp,
    handleSubmitAndSendFollowUp,
    handleDeleteActiveAnnotation,
    handleOpenAnnotationDetail,
  } = useResponseFollowUps({
    requestEdit, messageId, activeAnnotationDetail, onUpdateAnnotation, activeAnnotation,
    closeSelectionMenu, markSubmitSuccess, text, onAddAnnotation, pendingSelection,
    annotations, sessionId, onSaveAndSendFollowUp, contentLayerRef, cancelFollowUp,
    allowAnnotationIsland, setSelectionMenuTransitionConfig, triggerSelectionMenuEntryReplay, openFromAnnotation, consumeExternalOpenRequest,
    openAnnotationRequest, onRemoveAnnotation, markDeleteSuccess,
  })

  const {
    showSelectionMenuFromCurrentSelection,
    handleSelectionPointerDown,
    handleTextSelection,
  } = useResponseTextSelection({
    selectionStartedInContentRef, dragStartPointerRef, lastPointerRef, contentLayerRef, closeSelectionMenu,
    annotations, setSelectionMenuTransitionConfig, triggerSelectionMenuEntryReplay, openFromSelection, canAnnotate,
    onAddAnnotation, messageId,
  })

  const {
    annotationOverlayLayer,
    selectionMenu,
  } = useResponseSelectionMenu({
    canAnnotate, onAddAnnotation, messageId, selectionStartedInContentRef, lastPointerRef,
    contentLayerRef, showSelectionMenuFromCurrentSelection, selectionMenuView, handleCancelFollowUp, allowAnnotationIsland,
    interactionState, isSelectionMenuVisible, selectionMenuOpenedAtRef, isTargetInsideAnnotationIsland, closeSelectionMenu,
    selectionMenuRenderAnchor, selectionMenuRenderSourceKey, selectionMenuShowNonce, followUpMode, followUpDraft,
    setFollowUpDraft, handleOpenFollowUpView, handleRequestFollowUpEdit, handleSubmitFollowUp, handleSubmitAndSendFollowUp,
    activeAnnotationDetail, handleDeleteActiveAnnotation, sendMessageKey, selectionMenuTransitionConfig, handleSelectionMenuExitComplete,
    annotationOverlay, renderedAnnotations, handleOpenAnnotationDetail,
  })

  // Throttle content updates during streaming for performance
  // Updates immediately when streaming ends to show final content
  const {
    isBuffering,
    isCompleted,
    isCodexPresentation,
    isPlan,
  } = useResponseBuffer({
    isStreaming, setDisplayedText, text, lastUpdateRef, streamStartTime,
    variant, presentation,
  })

  // While buffering, return null - TurnCard will show a subtle indicator instead
  if (isBuffering) {
    return null
  }

  // Completed response or plan - show with max height and footer
  if (isCompleted || variant === 'plan') {
    return (
      <>
        <div
          data-response-presentation={isCodexPresentation ? 'codex' : undefined}
          className={cn(
            isCodexPresentation
              ? "relative group"
              : "bg-background shadow-minimal rounded-[8px] border border-border/40 overflow-hidden relative group"
          )}
        >
          {/* Fullscreen button - desktop only; compact mode keeps message chrome minimal */}
          {!compactMode && (
          <button
            onClick={() => setIsFullscreen(true)}
            className={cn(
              isCodexPresentation
                ? "absolute -top-1 right-0 p-1 rounded-[4px] transition-all z-10 select-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                : "absolute top-2 right-2 p-1 rounded-[6px] transition-all z-10 select-none opacity-0 group-hover:opacity-100",
              !isCodexPresentation && "bg-background shadow-minimal",
              "text-muted-foreground/50 hover:text-foreground",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100"
            )}
            title={t('common.viewFullscreen')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          )}

          {/* Plan header - only shown for plan variant */}
          {isPlan && (
            <div
              className={cn(
                "px-4 py-2 border-b border-border/30 flex items-center gap-2 bg-success/5 select-none",
                SIZE_CONFIG.fontSize
              )}
            >
              <ListTodo className={cn(SIZE_CONFIG.iconSize, "text-success")} />
              <span className="font-medium text-success">Plan</span>
            </div>
          )}

          {/* Scrollable content area with subtle fade at edges (dark mode only) */}
          <div
            ref={contentRef}
            data-search-root="response"
            data-response-content={isCodexPresentation ? 'inline' : undefined}
            onMouseDown={handleSelectionPointerDown}
            onMouseUp={handleTextSelection}
            className={cn(
              isCodexPresentation
                ? "py-1 text-sm"
                : "pl-[22px] pr-[16px] py-3 text-sm overflow-y-auto scrollbar-hover"
            )}
            style={isCodexPresentation ? undefined : {
              maxHeight: MAX_HEIGHT,
              // Subtle fade at top and bottom edges (16px) - only in dark mode for better contrast
              ...(isDarkMode && {
                maskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
              }),
            }}
          >
            <div ref={contentLayerRef} className="relative">
              <Markdown
                mode="minimal"
                onUrlClick={onOpenUrl}
                onFileClick={onOpenFile}
              >
                {text}
              </Markdown>
              {annotationOverlayLayer}
            </div>
          </div>

          {/* Desktop footer with actions (Copy / Markdown / Accept Plan / Branch).
              Compact mode falls through to the slim Accept-Plan-only footer below. */}
          {!compactMode && (
            isCodexPresentation ? (
              <div
                data-turncard-actions="codex"
                className={cn(
                  "mt-2 flex items-center justify-between gap-3 text-muted-foreground transition-opacity duration-150",
                  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                  SIZE_CONFIG.fontSize
                )}
              >
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleCopy}
                    aria-label={copied ? t('common.copied') : t('common.copy')}
                    title={copied ? t('common.copied') : t('common.copy')}
                    className={cn(
                      "turn-action-btn inline-flex h-6 w-6 items-center justify-center rounded-[4px] transition-colors select-none",
                      copied ? "text-success" : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                      "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    )}
                  >
                    {copied ? <Check className={SIZE_CONFIG.iconSize} /> : <Copy className={SIZE_CONFIG.iconSize} />}
                    <span className="sr-only">{copied ? t('common.copied') : t('common.copy')}</span>
                  </button>
                  {onPopOut && (
                    <button
                      onClick={onPopOut}
                      aria-label="Markdown"
                      title="Markdown"
                      className={cn(
                        "turn-action-btn inline-flex h-6 w-6 items-center justify-center rounded-[4px] transition-colors select-none",
                        "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                        "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      )}
                    >
                      <FileText className={SIZE_CONFIG.iconSize} />
                      <span className="sr-only">Markdown</span>
                    </button>
                  )}
                </div>
                {onBranch && <BranchDropdown onBranch={onBranch} />}
              </div>
            ) : (
              <div className={cn(
                "pl-4 pr-2.5 py-2 border-t border-border/30 flex items-center justify-between bg-muted/20",
                SIZE_CONFIG.fontSize
              )}>
                {/* Left side - Copy, View as Markdown, Annotation hint */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleCopy}
                    className={cn(
                      "turn-action-btn flex items-center gap-1.5 transition-colors select-none",
                      copied ? "text-success" : "text-muted-foreground hover:text-foreground",
                      "focus:outline-none focus-visible:underline"
                    )}
                  >
                    {copied ? (
                      <>
                        <Check className={SIZE_CONFIG.iconSize} />
                        <span>{t("common.copied")}</span>
                      </>
                    ) : (
                      <>
                        <Copy className={SIZE_CONFIG.iconSize} />
                        <span>{t("common.copy")}</span>
                      </>
                    )}
                  </button>
                  {onPopOut && (
                    <button
                      onClick={onPopOut}
                      className={cn(
                        "turn-action-btn flex items-center gap-1.5 transition-colors select-none",
                        "text-muted-foreground hover:text-foreground",
                        "focus:outline-none focus-visible:underline"
                      )}
                    >
                      <FileText className={SIZE_CONFIG.iconSize} />
                      <span>Markdown</span>
                    </button>
                  )}
                </div>

                {/* Right side */}
                <div className="flex items-center gap-3">
                  {/* Accept Plan dropdown (plan variant only, last response) */}
                  {isPlan && showAcceptPlan && onAccept && onAcceptWithCompact && (
                    <div
                      className={cn(
                        "flex items-center gap-3 transition-all duration-200",
                        isLastResponse
                          ? "opacity-100 translate-x-0"
                          : "opacity-0 translate-x-2 pointer-events-none"
                      )}
                    >
                      <AcceptPlanDropdown
                        onAccept={onAccept}
                        onAcceptWithCompact={onAcceptWithCompact}
                        acceptLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.acceptPlan')}
                        acceptOptionLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.accept')}
                      />
                    </div>
                  )}
                  {onBranch && <BranchDropdown onBranch={onBranch} />}
                </div>
              </div>
            )
          )}

          {/* Compact footer — Accept Plan only (mobile / auto-compact / popover).
              Uses a bottom-sheet drawer to match the CompactPermissionModeSelector
              / CompactModelSelector pattern. Guarded by isLastResponse so older
              plans don't render an empty strip with a hidden-but-focusable button. */}
          {compactMode && isPlan && showAcceptPlan && isLastResponse && onAccept && onAcceptWithCompact && (
            <div
              className={cn(
                "pl-3 pr-2 py-1.5 border-t border-border/30 flex items-center justify-end bg-muted/20",
                SIZE_CONFIG.fontSize
              )}
            >
              <CompactAcceptPlanDrawer
                onAccept={onAccept}
                onAcceptWithCompact={onAcceptWithCompact}
                acceptLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.acceptPlan')}
                acceptOptionLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.accept')}
              />
            </div>
          )}
        </div>

        {/* Fullscreen overlay for reading/annotating response and plan content. */}
        <DocumentFormattedMarkdownOverlay
          content={text}
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          variant={isPlan ? 'plan' : undefined}
          onOpenUrl={onOpenUrl}
          onOpenFile={onOpenFile}
          sessionId={sessionId}
          messageId={messageId}
          annotations={annotations}
          onAddAnnotation={onAddAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          sendMessageKey={sendMessageKey}
          openAnnotationRequest={openAnnotationRequest}
          isStreaming={isStreaming}
        />
        {selectionMenu}
      </>
    )
  }

  // Streaming response - show throttled content with spinner
  return (
    <>
      <div
        data-response-presentation={isCodexPresentation ? 'codex' : undefined}
        className={cn(
          isCodexPresentation
            ? "relative group"
            : "bg-background shadow-minimal rounded-[8px] border border-border/40 overflow-hidden group"
        )}
      >
        {/* Content area - uses displayedText (throttled) for performance */}
        {/* Subtle fade at top and bottom edges (dark mode only) */}
        <div
          ref={contentRef}
          data-search-root="response"
          data-response-content={isCodexPresentation ? 'inline' : undefined}
          onMouseDown={handleSelectionPointerDown}
          onMouseUp={handleTextSelection}
          className={cn(
            isCodexPresentation
              ? "py-1 text-sm"
              : "pl-[22px] pr-4 py-3 text-sm overflow-y-auto scrollbar-hover"
          )}
          style={isCodexPresentation ? undefined : {
            maxHeight: MAX_HEIGHT,
            // Subtle fade at top and bottom edges (16px) - only in dark mode for better contrast
            ...(isDarkMode && {
              maskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
            }),
          }}
        >
          <div ref={contentLayerRef} className="relative">
            <Markdown
              mode="minimal"
              onUrlClick={onOpenUrl}
              onFileClick={onOpenFile}
            >
              {displayedText}
            </Markdown>
            {annotationOverlayLayer}
          </div>
        </div>

        {/* Desktop streaming footer; compact mode renders nothing here
            (the Accept-Plan footer only applies to completed plans). */}
        {!compactMode && (
          <div className={cn(
            isCodexPresentation
              ? "mt-2 flex items-center gap-2 text-muted-foreground"
              : "px-4 py-2 border-t border-border/30 flex items-center bg-muted/20",
            SIZE_CONFIG.fontSize
          )}>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner className={SIZE_CONFIG.spinnerSize} />
              <span>Streaming...</span>
            </div>
          </div>
        )}
      </div>
      {selectionMenu}
    </>
  )
}
