export interface ToolLoopDecision {
  action: 'allow' | 'hint' | 'block';
  totalToolCalls: number;
  consecutiveToolCalls: number;
  identicalCalls: number;
  message?: string;
}

const MUTATING_TOOL_PATTERN = /(?:^|[_:\-.])(write|edit|multiedit|notebookedit|create|update|delete|remove|archive|move|rename|send|publish|deploy|commit|merge|apply|execute|submit|cancel)(?:$|[_:\-.])/i;
const MUTATING_SHELL_PATTERN = /(?:^|[;&|]\s*)(?:rm|mv|cp|install|deploy|git\s+(?:commit|merge|push)|(?:npm|bun|pnpm|yarn)\s+(?:install|publish)|curl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE))\b/i;

function isMutation(toolName: string, input: Record<string, unknown>): boolean {
  const normalized = toolName.replace(/^(?:mcp__session__|session__)/, '').replace(/([a-z])([A-Z])/g, '$1_$2');
  if (MUTATING_TOOL_PATTERN.test(`_${normalized}_`)) return true;
  if (!/^(?:bash|shell|exec_command)$/i.test(normalized)) return false;
  const command = [input.command, input.cmd, input.script]
    .find((value): value is string => typeof value === 'string');
  return !!command && MUTATING_SHELL_PATTERN.test(command);
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
  private transactionGraceUntil = 0;

  constructor(
    private readonly hintAfter = 3,
    private readonly blockIdenticalAfter = 4,
    private readonly blockConsecutiveAfter = 8,
    private readonly blockTotalAfter = 24,
    private readonly transactionReserve = 4,
    private readonly totalHintEvery = 6,
  ) {}

  beginPrompt(): void {
    this.lastToolName = undefined;
    this.lastSignature = undefined;
    this.totalToolCalls = 0;
    this.consecutiveToolCalls = 0;
    this.identicalCalls = 0;
    this.transactionGraceUntil = 0;
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

    const mutation = isMutation(toolName, input);
    const transactionInFlight = this.totalToolCalls <= this.transactionGraceUntil;

    if (this.identicalCalls >= this.blockIdenticalAfter) {
      return {
        action: 'block',
        totalToolCalls: this.totalToolCalls,
        consecutiveToolCalls: this.consecutiveToolCalls,
        identicalCalls: this.identicalCalls,
        message: `Cost guard: blocked unchanged ${toolName} call #${this.identicalCalls}. Use the existing result, change the hypothesis or arguments, or batch the remaining work.`,
      };
    }
    if (
      mutation
      && !transactionInFlight
      && this.totalToolCalls >= this.blockTotalAfter - this.transactionReserve
    ) {
      return {
        action: 'block',
        totalToolCalls: this.totalToolCalls,
        consecutiveToolCalls: this.consecutiveToolCalls,
        identicalCalls: this.identicalCalls,
        message: `Cost guard checkpoint: mutation ${toolName} was not started because this turn no longer has the ${this.transactionReserve}-call reserve required to verify and close it safely. End this response with a concise checkpoint naming the remaining action; automatic recovery will continue it without waiting for another user message.`,
      };
    }
    if (mutation) {
      this.transactionGraceUntil = Math.max(
        this.transactionGraceUntil,
        this.totalToolCalls + this.transactionReserve,
      );
    }
    const closingTransaction = this.totalToolCalls <= this.transactionGraceUntil;
    if (this.totalToolCalls >= this.blockTotalAfter && !closingTransaction) {
      return {
        action: 'block',
        totalToolCalls: this.totalToolCalls,
        consecutiveToolCalls: this.consecutiveToolCalls,
        identicalCalls: this.identicalCalls,
        message: `Cost guard checkpoint: tool call #${this.totalToolCalls} reached this turn's hard budget. Synthesize the verified evidence and end with a concise statement of remaining work; automatic recovery will continue without waiting for another user message.`,
      };
    }
    if (this.consecutiveToolCalls >= this.blockConsecutiveAfter && !closingTransaction) {
      return {
        action: 'block',
        totalToolCalls: this.totalToolCalls,
        consecutiveToolCalls: this.consecutiveToolCalls,
        identicalCalls: this.identicalCalls,
        message: `Cost guard checkpoint: blocked consecutive ${toolName} call #${this.consecutiveToolCalls}. Synthesize the existing results and state the remaining work precisely; automatic recovery will continue with a batched or materially different call.`,
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
    if (this.totalHintEvery > 0 && this.totalToolCalls % this.totalHintEvery === 0) {
      return {
        action: 'hint',
        totalToolCalls: this.totalToolCalls,
        consecutiveToolCalls: this.consecutiveToolCalls,
        identicalCalls: this.identicalCalls,
        message: `Cost guard: ${this.totalToolCalls} tool calls used. A routine lookup should normally finish in 3-5 calls; stop broad discovery, batch independent reads, and execute only the shortest remaining path to a verified outcome.`,
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
