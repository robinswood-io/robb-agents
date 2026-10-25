import { BrowserWindow, type Session as ElectronSession } from "electron";
import type { WindowManager } from "./window-manager";
import { type AccessibilitySnapshot, type ElementGeometry } from "./browser-cdp";
import { type BrowserEmptyStateLaunchPayload, type BrowserEmptyStateLaunchResult, type BrowserInstanceInfo } from "../shared/types";
import { type BrowserPanePermissionContext } from "./browser-pane-permissions";
import type { IBrowserPaneManager, BrowserInstanceSnapshot, BrowserMutationUrlPolicy } from "@craft-agent/server-core/handlers";
import type { BrowserCapabilityRequest } from "@craft-agent/server-core/transport";
import type { BrowserInstance, CreateBrowserInstanceOptions, BrowserPanePermissionAutonomyResolver, BrowserScreenshotOptions, BrowserConsoleEntry, BrowserConsoleOptions, BrowserScreenshotRegionTarget, BrowserNetworkEntry, BrowserNetworkOptions, BrowserWaitArgs, BrowserWaitResult, BrowserKeyArgs, BrowserDownloadEntry, BrowserDownloadOptions, BrowserScreenshotResult } from './browser-pane-manager/shared.ts';
import type { BrowserPaneCreateForSessionAsyncOptionsPayload, BrowserPaneGetOrCreateForSessionAsyncOptionsPayload, BrowserPaneNavigateResult, BrowserPaneClickElementOptionsPayload, BrowserPaneCapturePageWithRecoveryOptionsPayload, BrowserPaneCapturePageWithRecoveryResult, BrowserPaneWindowResizeResult, BrowserPaneDetectSecurityChallengeResult, BrowserPaneCreateForSessionOptionsPayload, BrowserPaneParseOwnerKeyResult, BrowserPaneSetAgentControlMetaPayload, BrowserPaneClearAgentControlForInstanceResult, BrowserPaneGetPermissionInstanceWebContentsPayload } from './browser-pane-manager/protocol.ts';
import * as browserPaneManagerInstances from './browser-pane-manager/instances.ts';
import * as browserPaneManagerOperationGuard from './browser-pane-manager/operation-guard.ts';
import * as browserPaneManagerLaunch from './browser-pane-manager/launch.ts';
import * as browserPaneManagerNavigation from './browser-pane-manager/navigation.ts';
import * as browserPaneManagerWindowControl from './browser-pane-manager/window-control.ts';
import * as browserPaneManagerPointerInput from './browser-pane-manager/pointer-input.ts';
import * as browserPaneManagerTextInput from './browser-pane-manager/text-input.ts';
import * as browserPaneManagerCapture from './browser-pane-manager/capture.ts';
import * as browserPaneManagerCaptureRecovery from './browser-pane-manager/capture-recovery.ts';
import * as browserPaneManagerInspection from './browser-pane-manager/inspection.ts';
import * as browserPaneManagerSessionBinding from './browser-pane-manager/session-binding.ts';
import * as browserPaneManagerOverlay from './browser-pane-manager/overlay.ts';
import * as browserPaneManagerLayout from './browser-pane-manager/layout.ts';
import * as browserPaneManagerDestruction from './browser-pane-manager/destruction.ts';
import * as browserPaneManagerToolbar from './browser-pane-manager/toolbar.ts';
import * as browserPaneManagerIpc from './browser-pane-manager/ipc.ts';
import * as browserPaneManagerCapabilities from './browser-pane-manager/capabilities.ts';
import * as browserPaneManagerTheme from './browser-pane-manager/theme.ts';
import * as browserPaneManagerPopups from './browser-pane-manager/popups.ts';
import * as browserPaneManagerObservations from './browser-pane-manager/observations.ts';
import * as browserPaneManagerPermissions from './browser-pane-manager/permissions.ts';
import * as browserPaneManagerStateEvents from './browser-pane-manager/state-events.ts';
import * as browserPaneManagerWindowEvents from './browser-pane-manager/window-events.ts';
import * as browserPaneManagerWindowState from './browser-pane-manager/window-state.ts';
import * as browserPaneManagerNavigationRules from './browser-pane-manager/navigation-rules.ts';
import * as browserPaneManagerCapturePage from './browser-pane-manager/capture-page.ts';
import * as browserPaneManagerToolbarState from './browser-pane-manager/toolbar-state.ts';
import * as browserPaneManagerCapabilityValues from './browser-pane-manager/capability-values.ts';
import * as browserPaneManagerSessionRecords from './browser-pane-manager/session-records.ts';
export type { BrowserScreenshotOptions, BrowserConsoleEntry, BrowserConsoleOptions, BrowserScreenshotRegionTarget, BrowserNetworkEntry, BrowserNetworkOptions, BrowserWaitArgs, BrowserWaitResult, BrowserKeyArgs, BrowserDownloadEntry, BrowserDownloadOptions, BrowserScreenshotResult } from './browser-pane-manager/shared.ts';
export { BROWSER_PANE_SESSION_PARTITION } from './browser-pane-manager/shared.ts';

export class BrowserPaneManager implements IBrowserPaneManager {
    private instances: Map<string, BrowserInstance> = new Map();
    private destroyingIds: Set<string> = new Set();
    private stateChangeCallback: ((info: BrowserInstanceInfo) => void) | null = null;
    private removedCallback: ((id: string) => void) | null = null;
    private interactedCallback: ((id: string) => void) | null = null;
    private partitionPermissionsInitialized = false;
    private partitionObserversInitialized = false;
    private inFlightRequestsByWebContentsId = new Map<number, number>();
    private lastNetworkActivityByWebContentsId = new Map<number, number>();
    private popupWindowsByParentInstanceId = new Map<string, Set<BrowserWindow>>();
    private popupParentByWebContentsId = new Map<number, string>();
    private popupWebContentsIdByWindow = new WeakMap<BrowserWindow, number>();
    private windowManager: WindowManager | null = null;
    private sessionPathResolver: ((sessionId: string) => string | null) | null = null;
    private permissionAutonomyResolver: BrowserPanePermissionAutonomyResolver | null = null;
    /** Serialize URL-changing operations and page mutations per instance. This
     * keeps the URL fence and the following effect in one ordered host section. */
    private serializedOperationTails = new Map<string, Promise<void>>();
    setWindowManager(windowManager: WindowManager): void {
        this.windowManager = windowManager;
    }
    setSessionPathResolver(fn: (sessionId: string) => string | null): void {
        this.sessionPathResolver = fn;
    }
    /**
     * Resolve live session/workspace autonomy state without coupling this
     * Electron-only manager to SessionManager internals.
     */
    setPermissionAutonomyResolver(fn: BrowserPanePermissionAutonomyResolver): void {
        this.permissionAutonomyResolver = fn;
    }
    onStateChange(callback: (info: BrowserInstanceInfo) => void): void {
        this.stateChangeCallback = callback;
    }
    onRemoved(callback: (id: string) => void): void {
        this.removedCallback = callback;
    }
    onInteracted(callback: (id: string) => void): void {
        this.interactedCallback = callback;
    }
    createInstance(id?: string, options?: CreateBrowserInstanceOptions): string {
        return browserPaneManagerInstances.createInstance(this, __dirname, id, options);
    }
    destroyInstance(id: string): void {
        return browserPaneManagerInstances.destroyInstance(this, id);
    }
    getInstance(id: string): BrowserInstance | undefined {
        return this.instances.get(id);
    }
    private cleanupDestroyedInstance(instance: BrowserInstance, reason: string): void {
        return browserPaneManagerInstances.cleanupDestroyedInstance(this, instance, reason);
    }
    private requireAliveInstance(id: string): BrowserInstance {
        return browserPaneManagerInstances.requireAliveInstance(this, id);
    }
    private async runSerializedBrowserOperation<T>(id: string, operation: () => Promise<T> | T): Promise<T> {
        return browserPaneManagerOperationGuard.runSerializedBrowserOperation<T>(this, id, operation);
    }
    private assertMutationUrlAllowed(instance: BrowserInstance, policy?: BrowserMutationUrlPolicy): void {
        return browserPaneManagerOperationGuard.assertMutationUrlAllowed(this, instance, policy);
    }
    async handleEmptyStateLaunchFromRenderer(senderWebContentsId: number, payload: BrowserEmptyStateLaunchPayload): Promise<BrowserEmptyStateLaunchResult> {
        return browserPaneManagerLaunch.handleEmptyStateLaunchFromRenderer(this, senderWebContentsId, payload);
    }
    private buildDeepLinkFromRoute(route: string): string {
        return browserPaneManagerLaunch.buildDeepLinkFromRoute(this, route);
    }
    private async triggerEmptyStateRouteLaunch(instance: BrowserInstance, route: string, token: string | null, source: 'hash' | 'ipc'): Promise<boolean> {
        return browserPaneManagerLaunch.triggerEmptyStateRouteLaunch(this, instance, route, token, source);
    }
    listInstances(): BrowserInstanceInfo[] {
        return browserPaneManagerInstances.listInstances(this);
    }
    async listInstancesAsync(): Promise<BrowserInstanceInfo[]> {
        return browserPaneManagerInstances.listInstancesAsync(this);
    }
    async getInstanceAsync(id: string): Promise<BrowserInstanceSnapshot | undefined> {
        return browserPaneManagerInstances.getInstanceAsync(this, id);
    }
    async createForSessionAsync(sessionId: string, options?: BrowserPaneCreateForSessionAsyncOptionsPayload): Promise<string> {
        return browserPaneManagerInstances.createForSessionAsync(this, sessionId, options);
    }
    async getOrCreateForSessionAsync(sessionId: string, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): Promise<string> {
        return browserPaneManagerInstances.getOrCreateForSessionAsync(this, sessionId, options);
    }
    async focusBoundForSessionAsync(sessionId: string, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): Promise<string> {
        return browserPaneManagerInstances.focusBoundForSessionAsync(this, sessionId, options);
    }
    getWindowCount(): number {
        return this.instances.size;
    }
    getBrowserWindows(): BrowserWindow[] {
        return Array.from(this.instances.values())
            .map((instance) => instance.window)
            .filter((win) => !win.isDestroyed());
    }
    async navigate(id: string, url: string): Promise<BrowserPaneNavigateResult> {
        return browserPaneManagerNavigation.navigate(this, id, url);
    }
    private async navigateAtCurrentInstance(id: string, url: string): Promise<BrowserPaneNavigateResult> {
        return browserPaneManagerNavigation.navigateAtCurrentInstance(this, id, url);
    }
    async goBack(id: string): Promise<void> {
        return browserPaneManagerNavigation.goBack(this, id);
    }
    async goForward(id: string): Promise<void> {
        return browserPaneManagerNavigation.goForward(this, id);
    }
    private async navigateHistoryAtCurrentInstance(id: string, direction: 'back' | 'forward'): Promise<void> {
        return browserPaneManagerNavigation.navigateHistoryAtCurrentInstance(this, id, direction);
    }
    reload(id: string): void {
        return browserPaneManagerNavigation.reload(this, id);
    }
    stop(id: string): void {
        return browserPaneManagerNavigation.stop(this, id);
    }
    focus(id: string): void {
        return browserPaneManagerWindowControl.focus(this, id);
    }
    hide(id: string): void {
        return browserPaneManagerWindowControl.hide(this, id);
    }
    async getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot> {
        return browserPaneManagerInspection.getAccessibilitySnapshot(this, id);
    }
    async clickAtCoordinates(id: string, x: number, y: number, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerPointerInput.clickAtCoordinates(this, id, x, y, mutationPolicy);
    }
    private async clickAtCoordinatesAtCurrentUrl(id: string, x: number, y: number, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerPointerInput.clickAtCoordinatesAtCurrentUrl(this, id, x, y, mutationPolicy);
    }
    async drag(id: string, x1: number, y1: number, x2: number, y2: number, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerPointerInput.drag(this, id, x1, y1, x2, y2, mutationPolicy);
    }
    private async dragAtCurrentUrl(id: string, x1: number, y1: number, x2: number, y2: number, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerPointerInput.dragAtCurrentUrl(this, id, x1, y1, x2, y2, mutationPolicy);
    }
    async typeText(id: string, text: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerTextInput.typeText(this, id, text, mutationPolicy);
    }
    private async typeTextAtCurrentUrl(id: string, text: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerTextInput.typeTextAtCurrentUrl(this, id, text, mutationPolicy);
    }
    async setClipboard(id: string, text: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerTextInput.setClipboard(this, id, text, mutationPolicy);
    }
    private async setClipboardAtCurrentUrl(id: string, text: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerTextInput.setClipboardAtCurrentUrl(this, id, text, mutationPolicy);
    }
    async getClipboard(id: string): Promise<string> {
        return browserPaneManagerTextInput.getClipboard(this, id);
    }
    async clickElement(id: string, ref: string, options?: BrowserPaneClickElementOptionsPayload, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerPointerInput.clickElement(this, id, ref, options, mutationPolicy);
    }
    private async clickElementAtCurrentUrl(id: string, ref: string, options?: BrowserPaneClickElementOptionsPayload, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerPointerInput.clickElementAtCurrentUrl(this, id, ref, options, mutationPolicy);
    }
    async fillElement(id: string, ref: string, value: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerTextInput.fillElement(this, id, ref, value, mutationPolicy);
    }
    private async fillElementAtCurrentUrl(id: string, ref: string, value: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerTextInput.fillElementAtCurrentUrl(this, id, ref, value, mutationPolicy);
    }
    async selectOption(id: string, ref: string, value: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerTextInput.selectOption(this, id, ref, value, mutationPolicy);
    }
    private async selectOptionAtCurrentUrl(id: string, ref: string, value: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerTextInput.selectOptionAtCurrentUrl(this, id, ref, value, mutationPolicy);
    }
    private restoreOverlayAfterCapture(instance: BrowserInstance, suspended: boolean): void {
        return browserPaneManagerCapture.restoreOverlayAfterCapture(this, instance, suspended);
    }
    async screenshot(id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
        return browserPaneManagerCapture.screenshot(this, id, options);
    }
    async screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult> {
        return browserPaneManagerCapture.screenshotRegion(this, id, target);
    }
    private async capturePageWithRecovery(instance: BrowserInstance, options: BrowserPaneCapturePageWithRecoveryOptionsPayload): Promise<BrowserPaneCapturePageWithRecoveryResult> {
        return browserPaneManagerCaptureRecovery.capturePageWithRecovery(this, instance, options);
    }
    private async waitForScreenshotReadiness(instanceId: string): Promise<void> {
        return browserPaneManagerCapture.waitForScreenshotReadiness(this, instanceId);
    }
    getConsoleLogs(id: string, options?: BrowserConsoleOptions): BrowserConsoleEntry[] {
        return browserPaneManagerInspection.getConsoleLogs(this, id, options);
    }
    getNetworkLogs(id: string, options?: BrowserNetworkOptions): BrowserNetworkEntry[] {
        return browserPaneManagerInspection.getNetworkLogs(this, id, options);
    }
    async waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult> {
        return browserPaneManagerInspection.waitFor(this, id, args);
    }
    async sendKey(id: string, args: BrowserKeyArgs, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerTextInput.sendKey(this, id, args, mutationPolicy);
    }
    private async sendKeyAtCurrentUrl(id: string, args: BrowserKeyArgs, mutationPolicy?: BrowserMutationUrlPolicy): Promise<void> {
        return browserPaneManagerTextInput.sendKeyAtCurrentUrl(this, id, args, mutationPolicy);
    }
    async getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> {
        return browserPaneManagerInspection.getDownloads(this, id, options);
    }
    async uploadFile(id: string, ref: string, filePaths: string[], mutationPolicy?: BrowserMutationUrlPolicy): Promise<ElementGeometry> {
        return browserPaneManagerTextInput.uploadFile(this, id, ref, filePaths, mutationPolicy);
    }
    private async uploadFileAtCurrentUrl(id: string, ref: string, filePaths: string[], mutationPolicy?: BrowserMutationUrlPolicy): Promise<ElementGeometry> {
        return browserPaneManagerTextInput.uploadFileAtCurrentUrl(this, id, ref, filePaths, mutationPolicy);
    }
    windowResize(id: string, width: number, height: number): BrowserPaneWindowResizeResult {
        return browserPaneManagerWindowControl.windowResize(this, id, width, height);
    }
    async evaluate(id: string, expression: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<unknown> {
        return browserPaneManagerInspection.evaluate(this, id, expression, mutationPolicy);
    }
    private async evaluateAtCurrentUrl(id: string, expression: string, mutationPolicy?: BrowserMutationUrlPolicy): Promise<unknown> {
        return browserPaneManagerInspection.evaluateAtCurrentUrl(this, id, expression, mutationPolicy);
    }
    async detectSecurityChallenge(id: string): Promise<BrowserPaneDetectSecurityChallengeResult> {
        return browserPaneManagerInspection.detectSecurityChallenge(this, id);
    }
    async scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount = 500): Promise<void> {
        return browserPaneManagerPointerInput.scroll(this, id, direction, amount);
    }
    bindSession(id: string, sessionId: string, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): void {
        return browserPaneManagerSessionBinding.bindSession(this, id, sessionId, options);
    }
    unbindSession(id: string): void {
        return browserPaneManagerSessionBinding.unbindSession(this, id);
    }
    unbindAllForSession(sessionId: string): void {
        return browserPaneManagerSessionBinding.unbindAllForSession(this, sessionId);
    }
    getBoundForSession(sessionId: string): string | null {
        return browserPaneManagerSessionBinding.getBoundForSession(this, sessionId);
    }
    createForSession(sessionId: string, options?: BrowserPaneCreateForSessionOptionsPayload): string {
        return browserPaneManagerSessionBinding.createForSession(this, sessionId, options);
    }
    focusBoundForSession(sessionId: string, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): string {
        return browserPaneManagerSessionBinding.focusBoundForSession(this, sessionId, options);
    }
    getOrCreateForSession(sessionId: string, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): string {
        return browserPaneManagerSessionBinding.getOrCreateForSession(this, sessionId, options);
    }
    getBoundInstanceId(sessionId: string): string | null {
        return browserPaneManagerSessionBinding.getBoundInstanceId(this, sessionId);
    }
    destroyForSession(sessionId: string): void {
        return browserPaneManagerSessionBinding.destroyForSession(this, sessionId);
    }
    async clearVisualsForSession(sessionId: string): Promise<void> {
        return browserPaneManagerSessionBinding.clearVisualsForSession(this, sessionId);
    }
    private reapplyAgentControlVisual(instance: BrowserInstance): void {
        return browserPaneManagerOverlay.reapplyAgentControlVisual(this, instance);
    }
    private isLiveInstance(instance: BrowserInstance): boolean {
        return browserPaneManagerInstances.isLiveInstance(this, instance);
    }
    private async loadNativeOverlayPage(instance: BrowserInstance): Promise<void> {
        return browserPaneManagerOverlay.loadNativeOverlayPage(this, instance);
    }
    private layoutToolbarView(instance: BrowserInstance): void {
        return browserPaneManagerLayout.layoutToolbarView(this, instance);
    }
    private bringToolbarToFront(instance: BrowserInstance): void {
        return browserPaneManagerLayout.bringToolbarToFront(this, instance);
    }
    private updateNativeOverlayState(instance: BrowserInstance): void {
        return browserPaneManagerOverlay.updateNativeOverlayState(this, instance);
    }
    private applyAgentControlLock(instance: BrowserInstance, active: boolean): void {
        return browserPaneManagerOverlay.applyAgentControlLock(this, instance, active);
    }
    destroyAll(): void {
        return browserPaneManagerDestruction.destroyAll(this);
    }
    private finalizeDestroyedInstance(instance: BrowserInstance, source: 'destroy' | 'closed'): void {
        return browserPaneManagerDestruction.finalizeDestroyedInstance(this, instance, source);
    }
    private layoutPageView(instance: BrowserInstance): void {
        return browserPaneManagerLayout.layoutPageView(this, instance);
    }
    private layoutAllViews(instance: BrowserInstance): void {
        return browserPaneManagerLayout.layoutAllViews(this, instance);
    }
    private forceCloseToolbarMenu(instance: BrowserInstance, reason: string): void {
        return browserPaneManagerLayout.forceCloseToolbarMenu(this, instance, reason);
    }
    private normalizePageState(url: string, title: string): BrowserPaneNavigateResult {
        return browserPaneManagerNavigation.normalizePageState(this, url, title);
    }
    private async loadEmptyStatePage(instance: BrowserInstance): Promise<void> {
        return browserPaneManagerToolbar.loadEmptyStatePage(this, __dirname, instance);
    }
    private async maybeHandleEmptyStateLaunch(instance: BrowserInstance, url: string): Promise<boolean> {
        return browserPaneManagerLaunch.maybeHandleEmptyStateLaunch(this, instance, url);
    }
    private async loadToolbarPage(instance: BrowserInstance): Promise<void> {
        return browserPaneManagerToolbar.loadToolbarPage(this, __dirname, instance);
    }
    private isLiveToolbarInstance(instance: BrowserInstance): boolean {
        return browserPaneManagerToolbar.isLiveToolbarInstance(this, instance);
    }
    private sleep(ms: number): Promise<void> {
        return browserPaneManagerToolbar.sleep(this, ms);
    }
    registerToolbarIpc(): void {
        return browserPaneManagerIpc.registerToolbarIpc(this);
    }
    registerCapabilityIpc(): void {
        return browserPaneManagerIpc.registerCapabilityIpc(this);
    }
    private parseOwnerKey(value: string): BrowserPaneParseOwnerKeyResult | null {
        return browserPaneManagerCapabilities.parseOwnerKey(this, value);
    }
    private stripOwnerKeysInPlace<T extends Partial<BrowserInstanceInfo>>(info: T): T {
        return browserPaneManagerCapabilities.stripOwnerKeysInPlace<T>(this, info);
    }
    private listInstancesForOwner(ownerKey: string): BrowserInstanceInfo[] {
        return browserPaneManagerCapabilities.listInstancesForOwner(this, ownerKey);
    }
    private async dispatchCapability(req: BrowserCapabilityRequest): Promise<unknown> {
        return browserPaneManagerCapabilities.dispatchCapability(this, req);
    }
    private markToolbarReady(instance: BrowserInstance, reason: string): void {
        return browserPaneManagerToolbar.markToolbarReady(this, instance, reason);
    }
    setAgentControl(sessionId: string, meta: BrowserPaneSetAgentControlMetaPayload, options?: BrowserPaneGetOrCreateForSessionAsyncOptionsPayload): void {
        return browserPaneManagerOverlay.setAgentControl(this, sessionId, meta, options);
    }
    clearAgentControl(sessionId: string): void {
        return browserPaneManagerOverlay.clearAgentControl(this, sessionId);
    }
    clearAgentControlForInstance(instanceId: string, sessionId?: string): BrowserPaneClearAgentControlForInstanceResult {
        return browserPaneManagerOverlay.clearAgentControlForInstance(this, instanceId, sessionId);
    }
    private async extractThemeColor(instance: BrowserInstance): Promise<void> {
        return browserPaneManagerTheme.extractThemeColor(this, instance);
    }
    private applyThemeColor(instance: BrowserInstance, color: string | null): void {
        return browserPaneManagerTheme.applyThemeColor(this, instance, color);
    }
    private installThemeObserver(instance: BrowserInstance, allowRetry = true): void {
        return browserPaneManagerTheme.installThemeObserver(this, instance, allowRetry);
    }
    private scheduleEarlyThemeExtraction(instance: BrowserInstance, urlAtSchedule: string): void {
        return browserPaneManagerTheme.scheduleEarlyThemeExtraction(this, instance, urlAtSchedule);
    }
    private getInstanceByWebContentsId(webContentsId: number): BrowserInstance | undefined {
        return browserPaneManagerPopups.getInstanceByWebContentsId(this, webContentsId);
    }
    private registerPopupWindow(parentInstance: BrowserInstance, popupWindow: BrowserWindow, sourceUrl?: string): void {
        return browserPaneManagerPopups.registerPopupWindow(this, parentInstance, popupWindow, sourceUrl);
    }
    private closePopupsForParent(parentId: string, reason: 'parent_destroy'): void {
        return browserPaneManagerPopups.closePopupsForParent(this, parentId, reason);
    }
    private setupSessionObservers(ses: ElectronSession): void {
        return browserPaneManagerObservations.setupSessionObservers(this, ses);
    }
    private getPermissionInstance(webContents: BrowserPaneGetPermissionInstanceWebContentsPayload | null): BrowserInstance | undefined {
        return browserPaneManagerPermissions.getPermissionInstance(this, webContents);
    }
    private getPermissionContext(webContents: BrowserPaneGetPermissionInstanceWebContentsPayload | null, requestingOrigin: string): BrowserPanePermissionContext | undefined {
        return browserPaneManagerPermissions.getPermissionContext(this, webContents, requestingOrigin);
    }
    private isPermissionAllowed(webContents: BrowserPaneGetPermissionInstanceWebContentsPayload | null, permission: string, requestingOrigin: string): boolean {
        return browserPaneManagerPermissions.isPermissionAllowed(this, webContents, permission, requestingOrigin);
    }
    private setupSessionPermissions(ses: ElectronSession): void {
        return browserPaneManagerPermissions.setupSessionPermissions(this, ses);
    }
    private setupWindowListeners(instance: BrowserInstance): void {
        return browserPaneManagerWindowEvents.setupWindowListeners(this, instance);
    }
    private toInfo(instance: BrowserInstance): BrowserInstanceInfo {
        return browserPaneManagerStateEvents.toInfo(this, instance);
    }
    private emitStateChange(instance: BrowserInstance): void {
        return browserPaneManagerStateEvents.emitStateChange(this, instance);
    }
}

export type { BrowserInstanceInfo }
