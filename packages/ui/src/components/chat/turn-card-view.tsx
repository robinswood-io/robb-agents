import * as React from 'react';

import "i18next";

import "@craft-agent/core/utils";

import { motion, AnimatePresence } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';

import { Spinner } from '../ui/LoadingIndicator';
import "../annotations/AnnotationIslandMenu";
import "../annotations/island-motion";
import "../tooltip";
import "@pierre/diffs";
import "../code-viewer";
import { TurnCardActionsMenu } from './TurnCardActionsMenu';
import { isActivityGroup } from './turn-utils';
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

import "../ui/StyledDropdown";

import { SIZE_CONFIG } from "./turn-card-contracts";

import { ActivityRow } from "./turn-card-activity-row";
import { ActivityGroupRow } from "./turn-card-activity-group";

import { TodoList } from "./turn-card-todo";
import { ResponseCard } from "./ResponseCard";

interface TurnCardViewProps {
  isCodexPresentation: boolean; hasActivities: boolean; toggleExpanded: () => void;
  isExpanded: boolean; activities: import("./turn-card-contracts").ActivityItem[]; activityPreviewText: string;
  renderActionsMenu: (() => React.ReactNode) | undefined; onOpenDetails: (() => void) | undefined; onOpenMultiFileDiff: (() => void) | undefined;
  hasEditOrWriteActivities: boolean | undefined; activitiesContainerRef: React.RefObject<HTMLDivElement | null>; sortedActivities: import("./turn-card-contracts").ActivityItem[];
  groupedActivities: (import("./turn-card-contracts").ActivityItem | import("./turn-utils").ActivityGroup)[] | null; expandedActivityGroups: Set<string>; handleExpandedActivityGroupsChange: (groups: Set<string>) => void;
  onOpenActivityDetails: ((activity: import("./turn-card-contracts").ActivityItem) => void) | undefined; sessionFolderPath: string | undefined; displayMode: "informative" | "detailed";
  hasUserToggled: React.RefObject<boolean>; hasMounted: React.RefObject<boolean>; lastChildSet: Set<string>;
  isThinking: boolean; animateResponse: boolean; isBuffering: boolean;
  todos: import("./turn-card-contracts").TodoItem[] | undefined; planActivities: import("./turn-card-contracts").ActivityItem[]; sessionId: string | undefined;
  onOpenFile: ((path: string) => void) | undefined; onOpenUrl: ((url: string) => void) | undefined; onPopOut: ((text: string) => void) | undefined;
  presentation: "default" | "codex"; onAddAnnotation: ((messageId: string, annotation: import("@craft-agent/core").AnnotationV1) => void) | undefined; onRemoveAnnotation: ((messageId: string, annotationId: string) => void) | undefined;
  onUpdateAnnotation: ((messageId: string, annotationId: string, patch: Partial<import("@craft-agent/core").AnnotationV1>) => void) | undefined; onSaveAndSendFollowUp: ((target: { messageId: string; annotationId: string; note: string; selectedText: string; }) => void) | undefined; onAcceptPlan: (() => void) | undefined;
  onAcceptPlanWithCompact: (() => void) | undefined; isLastResponse: boolean | undefined; compactMode: boolean;
  onBranch: ((messageId: string, options?: { newPanel?: boolean; }) => void) | undefined; sendMessageKey: "enter" | "cmd-enter"; hasActiveFollowUpAnnotations: boolean;
  openAnnotationRequest: import("./turn-card-contracts").OpenAnnotationRequest | null | undefined; annotationInteractionMode: import("./turn-card-contracts").AnnotationInteractionMode; response: import("./turn-card-contracts").ResponseContent | undefined;
  isComplete: boolean; isStreaming: boolean; onQuickAction: ((actionText: string) => void) | undefined;
  quickActionTriggered: boolean; handleQuickAction: (actionText: string) => void; t: import("i18next").TFunction<"translation", undefined>;
}

export function TurnCardView({
  isCodexPresentation, hasActivities, toggleExpanded,
  isExpanded, activities, activityPreviewText,
  renderActionsMenu, onOpenDetails, onOpenMultiFileDiff,
  hasEditOrWriteActivities, activitiesContainerRef, sortedActivities,
  groupedActivities, expandedActivityGroups, handleExpandedActivityGroupsChange,
  onOpenActivityDetails, sessionFolderPath, displayMode,
  hasUserToggled, hasMounted, lastChildSet,
  isThinking, animateResponse, isBuffering,
  todos, planActivities, sessionId,
  onOpenFile, onOpenUrl, onPopOut,
  presentation, onAddAnnotation, onRemoveAnnotation,
  onUpdateAnnotation, onSaveAndSendFollowUp, onAcceptPlan,
  onAcceptPlanWithCompact, isLastResponse, compactMode,
  onBranch, sendMessageKey, hasActiveFollowUpAnnotations,
  openAnnotationRequest, annotationInteractionMode, response,
  isComplete, isStreaming, onQuickAction,
  quickActionTriggered, handleQuickAction, t,
}: TurnCardViewProps) {

  return (
    <div className="space-y-1" data-turncard-presentation={isCodexPresentation ? 'codex' : undefined}>
      {/* Activity Section - excluded from search highlighting (matches ripgrep behavior) */}
      {hasActivities && (
        <div
          className="group select-none"
          data-search-exclude="true"
          data-activity-presentation={isCodexPresentation ? 'codex' : undefined}
        >
          {/* Collapsed Header / Toggle */}
          <button
            onClick={toggleExpanded}
            className={cn(
              isCodexPresentation
                ? "flex items-center gap-1.5 w-full px-0 py-1 text-left rounded-none"
                : "flex items-center gap-2 w-full pl-2.5 pr-1.5 py-1.5 rounded-[8px] text-left",
              SIZE_CONFIG.fontSize,
              "text-muted-foreground",
              isCodexPresentation ? "hover:text-foreground transition-colors" : "hover:bg-muted/40 transition-colors duration-150",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            )}
          >
            {/* Chevron with rotation animation - aligned with activity row icons */}
            <motion.div
              initial={false}
              animate={{ rotate: isExpanded ? 90 : 0 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}
            >
              <ChevronRight className={SIZE_CONFIG.iconSize} />
            </motion.div>

            {/* Step count badge */}
            <span className={cn(
              isCodexPresentation
                ? "-ml-0.5 shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground/75"
                : "-ml-0.5 shrink-0 px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground text-[10px] font-medium tabular-nums"
            )}>
              {activities.length}
            </span>

            {/* Preview text with crossfade + inline failure count */}
            <span className="relative flex-1 min-w-0 h-5 flex items-center">
              <AnimatePresence initial={false}>
                <motion.span
                  key={activityPreviewText}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="absolute inset-0 truncate"
                >
                  {activityPreviewText}
                </motion.span>
              </AnimatePresence>
            </span>

            {/* Turn actions menu - use platform override or default */}
            {renderActionsMenu ? renderActionsMenu() : (
              <TurnCardActionsMenu
                onOpenDetails={onOpenDetails}
                onOpenMultiFileDiff={onOpenMultiFileDiff}
                hasEditOrWriteActivities={hasEditOrWriteActivities}
              />
            )}
          </button>

          {/* Expanded Activity List */}
          <AnimatePresence initial={false}>
            {isExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{
                  height: { duration: 0.25, ease: [0.4, 0, 0.2, 1] },
                  opacity: { duration: 0.15 }
                }}
                className="overflow-hidden"
              >
                {/* Scrollable container when many activities - subtle background for scroll context */}
                {/* ml-[15px] positions the border-l under the chevron */}
                <div
                  ref={activitiesContainerRef}
                  className={cn(
                    isCodexPresentation
                      ? "pl-3 pr-0 py-1 space-y-0.5 border-l border-border/40 ml-[7px]"
                      : "pl-3.5 pr-2 py-0.5 space-y-0.5 border-l border-border/40 ml-[13px]",
                    !isCodexPresentation && sortedActivities.length > SIZE_CONFIG.maxVisibleActivities && "rounded-r-md overflow-y-auto scrollbar-hover py-1.5"
                  )}
                  style={isCodexPresentation ? undefined : {
                    maxHeight: sortedActivities.length > SIZE_CONFIG.maxVisibleActivities
                      ? SIZE_CONFIG.maxVisibleActivities * SIZE_CONFIG.activityRowHeight
                      : undefined
                  }}
                >
                  <AnimatePresence mode="sync">
                  {/* Grouped view for Task subagents */}
                  {groupedActivities ? (
                    groupedActivities.map((item, index) => (
                      isActivityGroup(item) ? (
                        <ActivityGroupRow
                          key={item.parent.id}
                          group={item}
                          expandedGroups={expandedActivityGroups}
                          onExpandedGroupsChange={handleExpandedActivityGroupsChange}
                          onOpenActivityDetails={onOpenActivityDetails}
                          animationIndex={index}
                          sessionFolderPath={sessionFolderPath}
                          displayMode={displayMode}
                        />
                      ) : (
                        <motion.div
                          key={item.id}
                          initial={
                            hasUserToggled.current || hasMounted.current
                              ? { opacity: 0, x: -8 }
                              : false
                          }
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: hasUserToggled.current ? (index < SIZE_CONFIG.staggeredAnimationLimit ? index * 0.03 : SIZE_CONFIG.staggeredAnimationLimit * 0.03) : 0 }}
                        >
                          <ActivityRow
                            activity={item}
                            onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(item) : undefined}
                            sessionFolderPath={sessionFolderPath}
                            displayMode={displayMode}
                          />
                        </motion.div>
                      )
                    ))
                  ) : (
                    /* Flat view for simple tool calls */
                    sortedActivities.map((activity, index) => (
                      <motion.div
                        key={activity.id}
                        initial={
                          hasUserToggled.current || hasMounted.current
                            ? { opacity: 0, x: -8 }
                            : false
                        }
                        animate={{ opacity: 1, x: 0 }}
                        // Only animate on user toggle, not initial mount
                        transition={{ delay: hasUserToggled.current ? (index < SIZE_CONFIG.staggeredAnimationLimit ? index * 0.03 : SIZE_CONFIG.staggeredAnimationLimit * 0.03) : 0 }}
                      >
                        <ActivityRow
                          activity={activity}
                          onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(activity) : undefined}
                          isLastChild={lastChildSet.has(activity.id)}
                          sessionFolderPath={sessionFolderPath}
                          displayMode={displayMode}
                        />
                      </motion.div>
                    ))
                  )}
                  {/* Thinking/Buffering indicator - shown while waiting for response */}
                  {isThinking && !animateResponse && (
                    <motion.div
                      key="thinking"
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{
                        delay: Math.min(sortedActivities.length, SIZE_CONFIG.staggeredAnimationLimit) * 0.03,
                        duration: 0.3,
                        ease: "easeOut"
                      }}
                      className={cn("flex items-center gap-2 py-0.5 text-muted-foreground/70", SIZE_CONFIG.fontSize)}
                    >
                      <Spinner className={SIZE_CONFIG.spinnerSize} />
                      <span>{isBuffering ? 'Preparing response...' : 'Thinking...'}</span>
                    </motion.div>
                  )}
                  </AnimatePresence>
                </div>
                {/* TodoList - inside expanded section */}
                {todos && todos.length > 0 && (
                  <TodoList todos={todos} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Standalone thinking indicator - when no activities but still working */}
      {!hasActivities && isThinking && !animateResponse && (
        <div className={cn("flex items-center gap-2 px-3 py-1.5 text-muted-foreground", SIZE_CONFIG.fontSize)}>
          <Spinner className={SIZE_CONFIG.spinnerSize} />
          <span>{isBuffering ? 'Preparing response...' : 'Thinking...'}</span>
        </div>
      )}

      {/* Plan Activities - rendered as full ResponseCards, time-sorted with other activities */}
      {planActivities.map((planActivity, index) => (
        <div key={planActivity.id} className={cn("select-text", (hasActivities || index > 0) && "mt-2")}>
          <ResponseCard
            text={planActivity.content || ''}
            isStreaming={false}
            sessionId={sessionId}
            onOpenFile={onOpenFile}
            onOpenUrl={onOpenUrl}
            onPopOut={onPopOut ? () => onPopOut(planActivity.content || '') : undefined}
            variant="plan"
            presentation={presentation}
            messageId={planActivity.messageId}
            annotations={planActivity.annotations}
            onAddAnnotation={onAddAnnotation}
            onRemoveAnnotation={onRemoveAnnotation}
            onUpdateAnnotation={onUpdateAnnotation}
            onSaveAndSendFollowUp={onSaveAndSendFollowUp}
            onAccept={onAcceptPlan}
            onAcceptWithCompact={onAcceptPlanWithCompact}
            isLastResponse={isLastResponse && index === planActivities.length - 1}
            compactMode={compactMode}
            onBranch={onBranch ? (options?: { newPanel?: boolean }) => onBranch(planActivity.messageId ?? planActivity.id, options) : undefined}
            sendMessageKey={sendMessageKey}
            hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
            openAnnotationRequest={openAnnotationRequest}
            annotationInteractionMode={annotationInteractionMode}
          />
        </div>
      ))}

      {/* Response Section - only shown when not buffering */}
      {/* Animated version for playground demos */}
      {animateResponse && (
        <AnimatePresence>
          {response && !isBuffering && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className={cn("select-text", hasActivities && "mt-2")}
            >
              <ResponseCard
                text={response.text}
                isStreaming={response.isStreaming}
                streamStartTime={response.streamStartTime}
                sessionId={sessionId}
                onOpenFile={onOpenFile}
                onOpenUrl={onOpenUrl}
                onPopOut={onPopOut ? () => onPopOut(response.text) : undefined}
                variant={response.isPlan ? 'plan' : 'response'}
                presentation={presentation}
                messageId={response.messageId}
                annotations={response.annotations}
                onAddAnnotation={onAddAnnotation}
                onRemoveAnnotation={onRemoveAnnotation}
                onUpdateAnnotation={onUpdateAnnotation}
                onSaveAndSendFollowUp={onSaveAndSendFollowUp}
                onAccept={onAcceptPlan}
                onAcceptWithCompact={onAcceptPlanWithCompact}
                isLastResponse={isLastResponse}
                compactMode={compactMode}
                onBranch={onBranch && response.messageId ? (options?: { newPanel?: boolean }) => onBranch(response.messageId!, options) : undefined}
                sendMessageKey={sendMessageKey}
                hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
                openAnnotationRequest={openAnnotationRequest}
                annotationInteractionMode={annotationInteractionMode}
              />
            </motion.div>
          )}
        </AnimatePresence>
      )}
      {/* Non-animated version for regular app use */}
      {!animateResponse && response && !isBuffering && (
        <div className={cn("select-text", hasActivities && "mt-2")}>
          <ResponseCard
            text={response.text}
            isStreaming={response.isStreaming}
            streamStartTime={response.streamStartTime}
            sessionId={sessionId}
            onOpenFile={onOpenFile}
            onOpenUrl={onOpenUrl}
            onPopOut={onPopOut ? () => onPopOut(response.text) : undefined}
            variant={response.isPlan ? 'plan' : 'response'}
            presentation={presentation}
            messageId={response.messageId}
            annotations={response.annotations}
            onAddAnnotation={onAddAnnotation}
            onRemoveAnnotation={onRemoveAnnotation}
            onUpdateAnnotation={onUpdateAnnotation}
            onSaveAndSendFollowUp={onSaveAndSendFollowUp}
            onAccept={onAcceptPlan}
            onAcceptWithCompact={onAcceptPlanWithCompact}
            isLastResponse={isLastResponse}
            compactMode={compactMode}
            onBranch={onBranch && response.messageId ? (options?: { newPanel?: boolean }) => onBranch(response.messageId!, options) : undefined}
            sendMessageKey={sendMessageKey}
            hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
            openAnnotationRequest={openAnnotationRequest}
            annotationInteractionMode={annotationInteractionMode}
          />
        </div>
      )}
      {isLastResponse && isComplete && !isStreaming && onQuickAction && (
        <div className="mt-2.5 flex items-center gap-1.5 flex-wrap animate-in fade-in duration-200">
          <button
            type="button"
            disabled={quickActionTriggered}
            onClick={() => handleQuickAction("Avec précision : approfondis les détails techniques et vérifie chaque point.")}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border border-border/50 bg-background/60 hover:bg-accent/10 hover:border-accent/40 text-muted-foreground hover:text-foreground transition-all duration-150 shadow-xs select-none ${
              quickActionTriggered ? 'opacity-50 pointer-events-none cursor-not-allowed' : 'cursor-pointer'
            }`}
          >
            <span>🔍</span>
            <span>{t('chat.quickActionPrecision', 'Plus de détails techniques')}</span>
          </button>
          <button
            type="button"
            disabled={quickActionTriggered}
            onClick={() => handleQuickAction("Fouille dans Google Drive et les mémos pour extraire les accès et informations manquants.")}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border border-border/50 bg-background/60 hover:bg-accent/10 hover:border-accent/40 text-muted-foreground hover:text-foreground transition-all duration-150 shadow-xs select-none ${
              quickActionTriggered ? 'opacity-50 pointer-events-none cursor-not-allowed' : 'cursor-pointer'
            }`}
          >
            <span>📁</span>
            <span>{t('chat.quickActionDrive', 'Fouiller dans Drive')}</span>
          </button>
          <button
            type="button"
            disabled={quickActionTriggered}
            onClick={() => handleQuickAction("Rédige un brouillon d'email complet reprenant l'intégralité des éléments pour validation.")}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border border-border/50 bg-background/60 hover:bg-accent/10 hover:border-accent/40 text-muted-foreground hover:text-foreground transition-all duration-150 shadow-xs select-none ${
              quickActionTriggered ? 'opacity-50 pointer-events-none cursor-not-allowed' : 'cursor-pointer'
            }`}
          >
            <span>📝</span>
            <span>{t('chat.quickActionDraft', 'Rédiger un brouillon d\'email')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
