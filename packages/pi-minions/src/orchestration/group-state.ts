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

export interface ResolveGroupInput {
  groupId?: string;
  cwd?: string;
  parentCwd: string;
}

export type ResolveGroupResult = OpenOrchestrationGroup | { reject: GroupRejectReason };

export function isResolveGroupReject(
  result: ResolveGroupResult,
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

  resolveGroup(input: ResolveGroupInput): ResolveGroupResult {
    const groupId = optionalString(input.groupId);
    const cwdInput = optionalString(input.cwd);
    const result = this.resolve(groupId, cwdInput, input.parentCwd);
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
    logger.info("orchestration-group", "close", {
      groupId: current.groupId,
      cwd: current.cwd,
      reject: undefined,
    });
  }

  getOpenGroup(): OpenOrchestrationGroup | undefined {
    return this.open === undefined ? undefined : { ...this.open };
  }

  private resolve(
    groupId: string | undefined,
    cwdInput: string | undefined,
    parentCwd: string,
  ): ResolveGroupResult {
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
      return { groupId: open.groupId, cwd: open.cwd };
    }

    if (groupId !== undefined) {
      return { reject: GROUP_REJECT_REASONS.unknownGroupId };
    }

    const cwd = existingDirRealpath(cwdInput, parentCwd);
    if (cwd === undefined) {
      return { reject: GROUP_REJECT_REASONS.cwdMissing };
    }

    const created: OpenOrchestrationGroup = { groupId: newGroupId(), cwd };
    this.open = created;
    return created;
  }
}
