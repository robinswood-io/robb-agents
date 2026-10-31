

export type ActiveRunActiveCreations = {
    id: string;
};

export type ActiveRunBuildPromptResult = {
    routingText: string;
    dispatchText: string;
};

export type ActiveRunSchedulingBudgetBreachResult = {
    metric: 'tokens' | 'cost';
    value: number;
    limit: number;
};

export type ActiveRunSetTerminalIntentIntentPayload = {
    reviewerSessionIds?: string[];
};
