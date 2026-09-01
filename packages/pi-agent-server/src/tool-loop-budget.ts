export interface ToolLoopDecision {
  action: 'allow' | 'hint' | 'block';
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
  private consecutiveToolCalls = 0;
  private identicalCalls = 0;

  constructor(
    private readonly hintAfter = 3,
    private readonly blockIdenticalAfter = 4,
  ) {}

  beginPrompt(): void {
    this.lastToolName = undefined;
    this.lastSignature = undefined;
    this.consecutiveToolCalls = 0;
    this.identicalCalls = 0;
  }

  observe(toolName: string, input: Record<string, unknown>): ToolLoopDecision {
    const nextSignature = signature(toolName, input);
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
        consecutiveToolCalls: this.consecutiveToolCalls,
        identicalCalls: this.identicalCalls,
        message: `Cost guard: blocked unchanged ${toolName} call #${this.identicalCalls}. Use the existing result, change the hypothesis or arguments, or batch the remaining work.`,
      };
    }
    if (this.consecutiveToolCalls >= this.hintAfter) {
      return {
        action: 'hint',
        consecutiveToolCalls: this.consecutiveToolCalls,
        identicalCalls: this.identicalCalls,
        message: `Cost guard: ${this.consecutiveToolCalls} consecutive ${toolName} calls. Batch remaining inputs into one call when supported; otherwise synthesize current evidence before another call.`,
      };
    }
    return {
      action: 'allow',
      consecutiveToolCalls: this.consecutiveToolCalls,
      identicalCalls: this.identicalCalls,
    };
  }
}
