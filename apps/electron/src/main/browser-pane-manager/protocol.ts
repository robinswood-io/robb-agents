

export type BrowserPaneCreateForSessionAsyncOptionsPayload = {
    show?: boolean;
    workspaceId?: string | null;
};

export type BrowserPaneGetOrCreateForSessionAsyncOptionsPayload = {
    workspaceId?: string | null;
};

export type BrowserPaneNavigateResult = {
    url: string;
    title: string;
};

export type BrowserPaneClickElementOptionsPayload = {
    waitFor?: 'none' | 'navigation' | 'network-idle';
    timeoutMs?: number;
};

export type BrowserPaneCapturePageWithRecoveryOptionsPayload = {
    mode: 'raw' | 'agent' | 'region';
    errorPrefix: 'screenshot' | 'region screenshot';
    rect?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    dpr?: number;
    format?: 'png' | 'jpeg';
    jpegQuality?: number;
};

export type BrowserPaneCapturePageWithRecoveryResult = {
    imageBuffer: Buffer;
    imageFormat: 'png' | 'jpeg';
    warnings: string[];
};

export type BrowserPaneCapturePageImageOptionsPayload = {
    rect?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    useHiddenCaptureOptions: boolean;
    dpr?: number;
    format?: 'png' | 'jpeg';
    jpegQuality?: number;
};

export type BrowserPaneCapturePageImageResult = {
    buffer: Buffer;
    format: 'png' | 'jpeg';
};

export type BrowserPaneWindowResizeResult = {
    width: number;
    height: number;
};

export type BrowserPaneDetectSecurityChallengeResult = {
    detected: boolean;
    provider: string;
    signals: string[];
};

export type BrowserPaneCreateForSessionOptionsPayload = {
    show?: boolean;
    allowReuseManual?: boolean;
    workspaceId?: string | null;
};

export type BrowserPaneParseOwnerKeyResult = {
    workspaceId: string;
    sessionId: string;
};

export type BrowserPaneSetAgentControlMetaPayload = {
    displayName?: string;
    intent?: string;
};

export type BrowserPaneClearAgentControlForInstanceResult = {
    released: boolean;
    reason?: string;
};

export type BrowserPaneSelectWebAuthnAccountDetailsPayload = {
    relyingPartyId: string;
    accounts: Electron.WebAuthnAccount[];
    frame: Electron.WebFrameMain | null;
};

export type BrowserPaneGetPermissionInstanceWebContentsPayload = {
    id: number;
};
