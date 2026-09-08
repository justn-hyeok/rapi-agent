import type { DeliveryState, TaskState } from "@rapi/contracts";

export class InvalidStateTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

const deliveryTransitions: Readonly<
  Record<DeliveryState, readonly DeliveryState[]>
> = {
  draft: ["ready"],
  ready: ["sending"],
  sending: ["delivered", "partially_failed", "failed"],
  partially_failed: ["retrying", "dead_letter"],
  retrying: ["delivered", "partially_failed", "failed"],
  delivered: [],
  failed: ["retrying", "dead_letter"],
  dead_letter: [],
};

const taskTransitions: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["approved", "rejected", "expired", "cancelled"],
  approved: ["awaiting_approval", "dispatched", "expired", "cancelled"],
  dispatched: ["running", "failed", "cancelled"],
  running: ["blocked", "completed", "failed", "cancelled"],
  blocked: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

function assertTransition<T extends string>(
  entity: string,
  transitions: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
): void {
  if (!transitions[from].includes(to))
    throw new InvalidStateTransitionError(entity, from, to);
}

export function assertDeliveryTransition(
  from: DeliveryState,
  to: DeliveryState,
): void {
  assertTransition("delivery", deliveryTransitions, from, to);
}
export function assertTaskTransition(from: TaskState, to: TaskState): void {
  assertTransition("task", taskTransitions, from, to);
}
