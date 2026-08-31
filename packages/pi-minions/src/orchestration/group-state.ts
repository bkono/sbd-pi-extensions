import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { logger } from "../logger.js";
import { generateId } from "../minions.js";

export const GROUP_REJECT_REASONS = {
  secondConcurrentGroup: "second concurrent group",
  cwdMissing: "cwd missing",
  cwdMismatch: "cwd mismatch",
  unknownGroupId: "unknown groupId",
} as const;

export type GroupRejectReason = (typeof GROUP_REJECT_REASONS)[keyof typeof GROUP_REJECT_REASONS];

export interface OpenOrchestrationGroup {
  groupId: string;
  cwd: string;
}

export interface LifecycleRegistration {
  lifecycleId: string;
  childId: string;
  groupId: string;
  epoch: number;
}

export interface AcceptLifecycleInput {
  lifecycleId: string;
  childId: string;
}

export interface PreviewedOrchestrationGroup extends OpenOrchestrationGroup {
  /** True when this preview would create a group that is not yet open. */
  created: boolean;
}

export interface ResolveGroupInput {
  groupId?: string;
  cwd?: string;
  parentCwd: string;
}

export type ResolveGroupResult = OpenOrchestrationGroup | { reject: GroupRejectReason };
export type PreviewGroupResult = PreviewedOrchestrationGroup | { reject: GroupRejectReason };

export function isResolveGroupReject(
  result: ResolveGroupResult | PreviewGroupResult,
): result is { reject: GroupRejectReason } {
  return "reject" in result;
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toAbsolute(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

/** Workspace identity is realpath of an existing directory. Does not create paths. */
function existingDirRealpath(cwd: string | undefined, parentCwd: string): string | undefined {
  const parentAbs = toAbsolute(parentCwd, process.cwd());
  const candidate = cwd === undefined ? parentAbs : toAbsolute(cwd, parentAbs);
  try {
    const real = realpathSync(candidate);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

function newGroupId(): string {
  return `grp-${generateId()}`;
}

/**
 * One open orchestrated group per parent session. cwd is set at create (default:
 * parent cwd), must already exist, and is immutable after that.
 */
export class OrchestrationGroupState {
  private open: OpenOrchestrationGroup | undefined;
  private epoch = 0;
  private idleEpoch: number | undefined;
  private readonly lifecycles = new Map<string, LifecycleRegistration>();
  previewGroup(input: ResolveGroupInput): PreviewGroupResult {
    const groupId = optionalString(input.groupId);
    const cwdInput = optionalString(input.cwd);
    const result = this.compute(groupId, cwdInput, input.parentCwd);
    if (isResolveGroupReject(result)) {
      logger.info("orchestration-group", "resolve", {
        groupId,
        cwd: cwdInput,
        reject: result.reject,
      });
    } else {
      logger.info("orchestration-group", "resolve", {
        groupId: result.groupId,
        cwd: result.cwd,
        reject: undefined,
      });
    }
    return result;
  }

  commitGroup(group: OpenOrchestrationGroup): void {
    if (this.open) return;
    this.open = { groupId: group.groupId, cwd: group.cwd };
    this.epoch = 0;
    this.idleEpoch = undefined;
    this.lifecycles.clear();
    logger.info("orchestration-group", "commit", {
      groupId: group.groupId,
      cwd: group.cwd,
      reject: undefined,
    });
  }

  resolveGroup(input: ResolveGroupInput): ResolveGroupResult {
    const result = this.previewGroup(input);
    if (isResolveGroupReject(result)) return result;
    this.commitGroup(result);
    return { groupId: result.groupId, cwd: result.cwd };
  }

  /** Arm an epoch and capture immutable ownership when child runtimes are accepted. */
  acceptLiveWork(groupId: string, children: readonly AcceptLifecycleInput[]): number | undefined {
    if (this.open?.groupId !== groupId) return undefined;
    if (this.idleEpoch === undefined) {
      this.epoch++;
      this.idleEpoch = this.epoch;
    }
    const epoch = this.idleEpoch;
    for (const child of children) {
      if (this.lifecycles.has(child.lifecycleId)) continue;
      this.lifecycles.set(child.lifecycleId, {
        lifecycleId: child.lifecycleId,
        childId: child.childId,
        groupId,
        epoch,
      });
    }
    return epoch;
  }

  /** Resolve only the exact lifecycle registration accepted by this open group. */
  getLifecycleRegistration(
    lifecycleId: string,
    groupId?: string,
    epoch?: number,
  ): LifecycleRegistration | undefined {
    const registration = this.lifecycles.get(lifecycleId);
    if (
      !registration ||
      this.open?.groupId !== registration.groupId ||
      (groupId !== undefined && registration.groupId !== groupId) ||
      (epoch !== undefined && registration.epoch !== epoch)
    ) {
      return undefined;
    }
    return { ...registration };
  }

  /** Reserve, but do not consume, an active→idle epoch owned by terminal evidence. */
  peekIdleTransition(
    groupId: string,
    hasLiveWork: boolean,
    terminalEpochs: ReadonlySet<number>,
  ): number | undefined {
    if (this.open?.groupId !== groupId || hasLiveWork || this.idleEpoch === undefined) {
      return undefined;
    }
    return terminalEpochs.has(this.idleEpoch) ? this.idleEpoch : undefined;
  }

  /** Consume a reservation only after the corresponding packet submission is accepted. */
  acknowledgeIdleTransition(groupId: string, epoch: number): boolean {
    if (this.open?.groupId !== groupId || this.idleEpoch !== epoch) return false;
    this.idleEpoch = undefined;
    return true;
  }

  closeGroup(groupId?: string): void {
    const requested = optionalString(groupId);
    const current = this.open;
    if (!current) {
      logger.info("orchestration-group", "close", {
        groupId: requested,
        cwd: undefined,
        reject: undefined,
      });
      return;
    }
    if (requested !== undefined && requested !== current.groupId) {
      logger.info("orchestration-group", "close", {
        groupId: requested,
        cwd: current.cwd,
        reject: GROUP_REJECT_REASONS.unknownGroupId,
      });
      return;
    }
    this.open = undefined;
    this.epoch = 0;
    this.idleEpoch = undefined;
    this.lifecycles.clear();
    logger.info("orchestration-group", "close", {
      groupId: current.groupId,
      cwd: current.cwd,
      reject: undefined,
    });
  }

  getOpenGroup(): OpenOrchestrationGroup | undefined {
    return this.open === undefined ? undefined : { ...this.open };
  }

  private compute(
    groupId: string | undefined,
    cwdInput: string | undefined,
    parentCwd: string,
  ): PreviewGroupResult {
    const open = this.open;
    if (open) {
      if (groupId !== undefined && groupId !== open.groupId) {
        return { reject: GROUP_REJECT_REASONS.secondConcurrentGroup };
      }
      if (cwdInput !== undefined) {
        const realCwd = existingDirRealpath(cwdInput, parentCwd);
        if (realCwd === undefined) {
          return { reject: GROUP_REJECT_REASONS.cwdMissing };
        }
        if (realCwd !== open.cwd) {
          return { reject: GROUP_REJECT_REASONS.cwdMismatch };
        }
      }
      return { groupId: open.groupId, cwd: open.cwd, created: false };
    }

    if (groupId !== undefined) {
      return { reject: GROUP_REJECT_REASONS.unknownGroupId };
    }

    const cwd = existingDirRealpath(cwdInput, parentCwd);
    if (cwd === undefined) {
      return { reject: GROUP_REJECT_REASONS.cwdMissing };
    }

    return { groupId: newGroupId(), cwd, created: true };
  }
}
