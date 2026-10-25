/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import type { ComponentEntry } from "./types";
import "react";
import "@craft-agent/ui";
import { turnCardStreamingSimEntry } from "./turn-card/streaming";
import "./turn-card/turn-fixtures";
import { turnCardEntry } from "./turn-card/turn-entry";
import "./turn-card/document-fixtures";
import "./turn-card/overlays";
import "./turn-card/code-fixtures";
import "./turn-card/utility-fixtures";
import { documentOverlayEntry, codePreviewOverlayEntry } from "./turn-card/document-entries";
import { multiDiffOverlayEntry, terminalPreviewOverlayEntry, jsonPreviewOverlayEntry, genericOverlayEntry, dataTableOverlayEntry } from "./turn-card/utility-entries";

export const turnCardComponents: ComponentEntry[] = [
  turnCardEntry,
  turnCardStreamingSimEntry,
]

export const fullscreenOverlayComponents: ComponentEntry[] = [
  documentOverlayEntry,
  codePreviewOverlayEntry,
  multiDiffOverlayEntry,
  terminalPreviewOverlayEntry,
  jsonPreviewOverlayEntry,
  genericOverlayEntry,
  dataTableOverlayEntry,
]
