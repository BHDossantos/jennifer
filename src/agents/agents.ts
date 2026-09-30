import { JenniferError, type Space } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';

/** Specialist roles (spec §12): prompt configurations with narrow tool sets. */
export const SPECIALIST_ROLES = {
  communications: { tools: ['search_messages', 'read_thread', 'retrieve_memory', 'create_draft', 'send_message'], label: 'Preparing the reply' },
  calendar: { tools: ['get_free_busy', 'create_event', 'retrieve_memory'], label: 'Checking your calendar' },
  research: { tools: ['retrieve_memory', 'search_messages'], label: 'Researching' },
  documents: { tools: ['retrieve_memory', 'create_draft'], label: 'Preparing the document' },
  business: { tools: ['retrieve_memory', 'search_messages', 'create_follow_up'], label: 'Reviewing the project' },
  quality_review: { tools: ['read_thread', 'retrieve_memory'], label: 'Double-checking' },
} as const;
export type SpecialistRole = keyof typeof SPECIALIST_ROLES;

export interface TaskEnvelope {
  taskId: string;
  parentId?: string;
  role: SpecialistRole | 'jennifer';
  goal: string;
  constraints: string[];
  authorizedScope: { spaces: Space[]; contactIds?: string[]; tools: string[] };
  inputSources: string[];
  outputSchema: string;
  deadline: Date;
  maxCostEur: number;
  toolBudget: number;
  depth: number;
  idempotencyKey: string;
  status: 'running' | 'completed' | 'failed' | 'canceled';
  spentEur: number;
  toolCalls: number;
  children: string[];
}

export interface SpecialistResult {
  findings: string[];
  evidence: string[];
  proposedActionIds: string[];
  unresolvedQuestions: string[];
  completion: 'complete' | 'partial' | 'blocked';
}

export interface CoordinatorLimits {
  maxDepth: number;
  maxTotalTasks: number;
  maxTotalCostEur: number;
}

/**
 * Coordinates specialist tasks: budgets, depth caps, scope narrowing and
 * cancellation propagation. Children can never expand the parent's authority.
 */
export class AgentCoordinator {
  private tasks = new Map<string, TaskEnvelope>();
  private activity: Array<{ at: Date; taskId: string; text: string }> = [];

  constructor(
    private clock: Clock,
    private limits: CoordinatorLimits = { maxDepth: 2, maxTotalTasks: 20, maxTotalCostEur: 2 },
  ) {}

  root(goal: string, scope: TaskEnvelope['authorizedScope'], opts: { maxCostEur?: number; toolBudget?: number; deadlineMs?: number } = {}): TaskEnvelope {
    return this.create({ goal, role: 'jennifer', authorizedScope: scope, depth: 0, maxCostEur: opts.maxCostEur ?? 0.5, toolBudget: opts.toolBudget ?? 30, deadlineMs: opts.deadlineMs ?? 10 * 60_000 });
  }

  delegate(
    parentId: string,
    role: SpecialistRole,
    goal: string,
    opts: { spaces?: Space[]; contactIds?: string[]; maxCostEur: number; toolBudget: number; inputSources?: string[] },
  ): TaskEnvelope {
    const parent = this.get(parentId);
    if (parent.status !== 'running') throw new JenniferError('agent.parent_inactive', 'Parent task is not running');
    if (parent.depth + 1 > this.limits.maxDepth) throw new JenniferError('agent.depth', 'Delegation depth limit reached');
    if (this.tasks.size >= this.limits.maxTotalTasks) throw new JenniferError('agent.total_tasks', 'Total task limit reached');
    const committed = parent.children.reduce((s, id) => s + this.get(id).maxCostEur, 0);
    if (committed + opts.maxCostEur > parent.maxCostEur - parent.spentEur) throw new JenniferError('agent.budget', 'Child budget exceeds the parent remaining budget');

    const roleTools = SPECIALIST_ROLES[role].tools as readonly string[];
    const tools = roleTools.filter((t) => parent.authorizedScope.tools.includes(t));
    const spaces = (opts.spaces ?? parent.authorizedScope.spaces).filter((s) => parent.authorizedScope.spaces.includes(s));
    const contactIds = opts.contactIds && parent.authorizedScope.contactIds ? opts.contactIds.filter((c) => parent.authorizedScope.contactIds!.includes(c)) : (opts.contactIds ?? parent.authorizedScope.contactIds);

    const child = this.create({
      goal,
      role,
      parentId,
      authorizedScope: { spaces, contactIds, tools },
      depth: parent.depth + 1,
      maxCostEur: opts.maxCostEur,
      toolBudget: Math.min(opts.toolBudget, parent.toolBudget - parent.toolCalls),
      deadlineMs: Math.max(0, parent.deadline.getTime() - this.clock.now().getTime()),
      inputSources: opts.inputSources,
    });
    parent.children.push(child.taskId);
    this.log(child.taskId, SPECIALIST_ROLES[role].label);
    return child;
  }

  /** Account for a tool call; enforce budgets and deadlines. */
  charge(taskId: string, costEur: number, tool: string): void {
    const t = this.get(taskId);
    if (t.status !== 'running') throw new JenniferError('agent.not_running', `Task is ${t.status}`);
    if (!t.authorizedScope.tools.includes(tool)) throw new JenniferError('agent.tool_scope', `${t.role} may not use ${tool}`);
    if (this.clock.now() > t.deadline) {
      this.fail(taskId, 'deadline exceeded');
      throw new JenniferError('agent.deadline', 'Task deadline exceeded');
    }
    if (t.toolCalls + 1 > t.toolBudget) {
      this.fail(taskId, 'tool budget exhausted');
      throw new JenniferError('agent.tool_budget', 'Tool budget exhausted');
    }
    if (t.spentEur + costEur > t.maxCostEur || this.totalSpent() + costEur > this.limits.maxTotalCostEur) {
      this.fail(taskId, 'cost budget exhausted');
      throw new JenniferError('agent.cost_budget', 'Cost budget exhausted');
    }
    t.toolCalls++;
    t.spentEur += costEur;
    let p = t.parentId ? this.tasks.get(t.parentId) : undefined;
    while (p) {
      p.spentEur += costEur;
      p = p.parentId ? this.tasks.get(p.parentId) : undefined;
    }
  }

  complete(taskId: string, _result: SpecialistResult): void {
    const t = this.get(taskId);
    if (t.status === 'running') t.status = 'completed';
  }

  /** Canceling a parent cancels all descendants. */
  cancel(taskId: string): void {
    const t = this.get(taskId);
    if (t.status === 'running') t.status = 'canceled';
    for (const c of t.children) this.cancel(c);
  }

  get(id: string): TaskEnvelope {
    const t = this.tasks.get(id);
    if (!t) throw new JenniferError('agent.not_found', id);
    return t;
  }

  /** Plain-language activity for the app (spec §12). */
  activityFeed(): Array<{ at: Date; taskId: string; text: string }> {
    return [...this.activity];
  }

  private fail(taskId: string, reason: string): void {
    const t = this.get(taskId);
    t.status = 'failed';
    this.log(taskId, `Stopped: ${reason}`);
    for (const c of t.children) this.cancel(c);
  }

  private totalSpent(): number {
    return [...this.tasks.values()].filter((t) => !t.parentId).reduce((s, t) => s + t.spentEur, 0);
  }

  private log(taskId: string, text: string): void {
    this.activity.push({ at: this.clock.now(), taskId, text });
  }

  private create(i: {
    goal: string;
    role: TaskEnvelope['role'];
    parentId?: string;
    authorizedScope: TaskEnvelope['authorizedScope'];
    depth: number;
    maxCostEur: number;
    toolBudget: number;
    deadlineMs: number;
    inputSources?: string[];
  }): TaskEnvelope {
    const t: TaskEnvelope = {
      taskId: newId('task'),
      parentId: i.parentId,
      role: i.role,
      goal: i.goal,
      constraints: [],
      authorizedScope: i.authorizedScope,
      inputSources: i.inputSources ?? [],
      outputSchema: 'SpecialistResult',
      deadline: new Date(this.clock.now().getTime() + i.deadlineMs),
      maxCostEur: i.maxCostEur,
      toolBudget: i.toolBudget,
      depth: i.depth,
      idempotencyKey: newId('idem'),
      status: 'running',
      spentEur: 0,
      toolCalls: 0,
      children: [],
    };
    this.tasks.set(t.taskId, t);
    return t;
  }
}
