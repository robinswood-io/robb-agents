/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import "react";
import type { ComponentEntry } from "./types";
import "@/components/app-shell/AttachmentPreview";
import "@/components/app-shell/SetupAuthBanner";
import "@craft-agent/ui";
import "@/components/app-shell/ActiveOptionBadges";
import "@/components/app-shell/input";
import "@/components/app-shell/input/working-directory-history";
import "@/components/chat/EmptyStateHint";
import "@/components/ui/button";
import "lucide-react";
import "@/context/AppShellContext";
import "@/context/ModalContext";
import "../mock-utils";
import "../adapters/input-adapters";
import "../recent-working-dirs";
import "./chat/input-fixtures";
import "./chat/activity-fixtures";
import "./chat/input-preview";
import "./chat/task-previews";
import { emptyStateHintEntry, attachmentPreviewEntry, setupAuthBannerEntry, activeOptionBadgesEntry, permissionInputToggleEntry, turnCardFlatEntry, turnCardNestedCompleteEntry, turnCardNestedProgressEntry, turnCardMultiTaskEntry, turnCardDeepNestedEntry, activeTasksBarContextEntry } from "./chat/conversation-entries";
import { inputContainerEntry } from "./chat/input-entry";

export const chatComponents: ComponentEntry[] = [
  emptyStateHintEntry,
  attachmentPreviewEntry,
  setupAuthBannerEntry,
  activeOptionBadgesEntry,
  permissionInputToggleEntry,
  turnCardFlatEntry,
  turnCardNestedCompleteEntry,
  turnCardNestedProgressEntry,
  turnCardMultiTaskEntry,
  turnCardDeepNestedEntry,
  activeTasksBarContextEntry,
  inputContainerEntry,
]
