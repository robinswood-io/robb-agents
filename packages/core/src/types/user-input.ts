/** Structured context questions. Identity and lifecycle fields are host-owned. */
export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface UserInputQuestion {
  id: string;
  question: string;
  options?: UserInputOption[];
  multiSelect?: boolean;
}

export interface UserInputAnswer {
  questionId: string;
  optionIds: string[];
  text?: string;
}

export interface UserInputRequest {
  id: string;
  /** Requesting session, also when displayed inside its parent conversation. */
  sessionId: string;
  originWorkspaceId: string;
  questions: UserInputQuestion[];
  status: 'pending' | 'answered' | 'cancelled';
  createdAt: number;
  answeredAt?: number;
  answers?: UserInputAnswer[];
  objectiveUserMessageId?: string;
  responseMessageId?: string;
  /** Host-owned provenance for a question created by a provider-admission
   * gate. Provider-authored questions never receive this capability. */
  hostPrompt?: {
    schemaVersion: 1;
    kind: 'context-limit-next-step';
    objectiveId: string;
    recoveryDispatchId: string;
    issuedAt: number;
  };
}

export interface UserInputResponse {
  requestId: string;
  answers?: UserInputAnswer[];
  cancelled?: boolean;
}

/** Acceptance confirms delivery, not that the model has consumed the answer. */
export interface UserInputResponseResult {
  status: 'accepted' | 'already_answered' | 'cancelled';
  responseMessageId?: string;
  delivery?: 'steered' | 'queued' | 'started';
}
