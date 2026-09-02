export interface ToolLoopDecision {
  action: 'allow' | 'hint' | 'block';
  totalToolCalls: number;
  consecutiveToolCalls: number;
  identicalCalls: number;
  message?: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function signature(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(stableValue(input))}`;
}

/** Per-prompt deterministic guard against unbatched or unchanged tool loops. */
export class ToolLoopBudget {
  private lastToolName?: string;
  private lastSignature?: string;
  private totalToolCalls = 0;
  private consecutiveToolCalls = 0;
  private identicalCalls = 0;

  constructor(
    private readonly hintAfter = 3,
    private readonly blockIdenticalAfter = 4,
    private readonly blockConsecutiveAfter = 8,
    private readonly blockTotalAfter = 24,
  ) {}

  beginPrompt(): void {
    this.lastToolName = undefined;
    this.lastSignature = undefined;
    this.totalToolCalls = 0;
    this.consecutiveToolCalls = 0;
    this.identicalCalls = 0;
  }

  observe(toolName: string, input: Record<string, unknown>): ToolLoopDecision {
    const nextSignature = signature(toolName, input);
    this.totalToolCalls += 1;
    this.consecutiveToolCalls = toolName === this.lastToolName
      ? this.consecutiveToolCalls + 1
      : 1;
    this.identicalCalls = nextSignature === this.lastSignature
      ? this.identicalCalls + 1
      : 1;
    this.lastToolName = toolName;
    this.lastSignature = nextSignature;

    if (this.identicalCalls >= this.blockIdenticalAfter) {
      return {
        action: 'block',
        totalToolCalls: this.totalToolCalls,
        consecutiveToolCalls: this.consecutiveToolCalls,
        identicalCalls: this.identicalCalls,
        message: `Cost guard: blocked unchanged ${toolName} call #${this.identicalCalls}. Use the existing result, change the hypothesis or arguments, or batch the remaining work.`,
      };
    }
    if (this.totalToolCalls >= this.blockTotalAfter) {
      return {
        action: 'block',
        totalToolCalls: this.totalToolCalls,
        consecutiveToolCalls: this.consecutiveToolCalls,
        identicalCalls: this.identicalCalls,
        message: `Cost guard: blocked tool call #${this.totalToolCalls}; this turn reached its hard tool budget. Synthesize the verified evidence now and continue only in a new user-authorized turn.`,
      };
    }
    if (this.consecutiveToolCalls >= this.blockConsecutiveAfter) {
      return {
        action: 'block',
        totalToolCalls: this.totalToolCalls,
        consecutiveToolCalls: this.consecutiveToolCalls,
        identicalCalls: this.identicalCalls,
        message: `Cost guard: blocked consecutive ${toolName} call #${this.consecutiveToolCalls}. Synthesize the existing results or use a single batched call in a new user-authorized turn.`,
      };
    }
    if (this.consecutiveToolCalls >= this.hintAfter) {
      return {
        action: 'hint',
        totalToolCalls: this.totalToolCalls,
        consecutiveToolCalls: this.consecutiveToolCalls,
        identicalCalls: this.identicalCalls,
        message: `Cost guard: ${this.consecutiveToolCalls} consecutive ${toolName} calls. Batch remaining inputs into one call when supported; otherwise synthesize current evidence before another call.`,
      };
    }
    return {
      action: 'allow',
      totalToolCalls: this.totalToolCalls,
      consecutiveToolCalls: this.consecutiveToolCalls,
      identicalCalls: this.identicalCalls,
    };
  }
}
