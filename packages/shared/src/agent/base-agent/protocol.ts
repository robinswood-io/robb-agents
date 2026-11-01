

export type BaseAgentAdmittedToolExecutions = {
    toolName: string;
    inputJson: string;
    sessionId: string;
    runtimeId: string;
    authorizationEpoch: number;
    state: 'admitted' | 'executing';
};

export type BaseAgentPendingSourceActivationRestart = {
    sourceSlug: string;
    userMessage: string;
};

export type BaseAgentAdmitToolExecutionInputPayload = {
    toolUseId: string | undefined;
    toolName: string;
    toolInput: Record<string, unknown>;
    sessionId: string;
    runtimeId: string;
    authorizationEpoch: number;
};

export type BaseAgentBeginAdmittedToolExecutionBySignatureInputPayload = {
    toolName: string;
    toolInput: Record<string, unknown>;
    sessionId: string;
    runtimeId: string;
    authorizationEpoch: number;
};

export type BaseAgentExtractSkillPathsResult = {
    skillPaths: Map<string, string>;
    sealedSkillContents: Map<string, string>;
    cleanMessage: string;
    missingSkills: string[];
};

export type BaseAgentGenerateTitleOptionsPayload = {
    language?: string;
};
