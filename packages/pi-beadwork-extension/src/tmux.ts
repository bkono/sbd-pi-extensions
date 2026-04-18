import {
  defaultProcessRunner,
  ProcessCommandError,
  type ProcessRunner,
  slugify,
} from "./process.js";

export type LaunchTmuxWorkerInput = {
  sessionName: string;
  workerId: string;
  title: string;
  worktreePath: string;
  launchCommand: string;
};

export type LaunchTmuxWorkerResult = {
  sessionName: string;
  windowName: string;
  paneId: string;
  launchCommand: string;
};

export type TmuxPaneInspection = {
  exists: boolean;
  sessionName?: string;
  windowName?: string;
  paneId?: string;
  dead?: boolean;
  currentCommand?: string;
  panePid?: number;
  exitStatus?: number;
};

export interface TmuxBackend {
  ensureSession(input: { sessionName: string }): Promise<{ sessionName: string; created: boolean }>;
  launchWorker(input: LaunchTmuxWorkerInput): Promise<LaunchTmuxWorkerResult>;
  inspectWorker(input: {
    paneId?: string;
    sessionName?: string;
    windowName?: string;
  }): Promise<TmuxPaneInspection>;
  cleanupWorker(input: {
    paneId?: string;
    sessionName?: string;
    windowName?: string;
  }): Promise<void>;
}

function normalizeWindowName(workerId: string, title: string): string {
  return `${workerId}-${slugify(title, 24)}`.slice(0, 48);
}

function isMissingTmuxTargetError(error: unknown): boolean {
  const detail =
    error instanceof ProcessCommandError
      ? `${error.stderr}\n${error.stdout}\n${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);

  return /can't find (?:pane|window|session)|no server running on/i.test(detail);
}

export function createTmuxBackend(runner: ProcessRunner = defaultProcessRunner): TmuxBackend {
  return {
    async ensureSession(input) {
      try {
        await runner("tmux", ["has-session", "-t", input.sessionName], { timeout: 5_000 });
        return { sessionName: input.sessionName, created: false };
      } catch {
        await runner("tmux", ["new-session", "-d", "-s", input.sessionName, "-n", "beadwork"], {
          timeout: 5_000,
        });
        return { sessionName: input.sessionName, created: true };
      }
    },

    async launchWorker(input) {
      const windowName = normalizeWindowName(input.workerId, input.title);
      const result = await runner(
        "tmux",
        [
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{window_name}\t#{pane_id}",
          "-t",
          input.sessionName,
          "-n",
          windowName,
          "-c",
          input.worktreePath,
          "bash",
          "-lc",
          input.launchCommand,
        ],
        { timeout: 10_000 },
      );

      const [resolvedWindowName = windowName, paneId = ""] = result.stdout.trim().split("\t", 2);
      if (!paneId) {
        throw new Error(`Failed to parse tmux launch result: ${result.stdout}`);
      }

      return {
        sessionName: input.sessionName,
        windowName: resolvedWindowName,
        paneId,
        launchCommand: input.launchCommand,
      };
    },

    async inspectWorker(input) {
      const result = await runner(
        "tmux",
        [
          "list-panes",
          "-a",
          "-F",
          "#{pane_id}\t#{session_name}\t#{window_name}\t#{pane_dead}\t#{pane_current_command}\t#{pane_pid}\t#{pane_exit_status}",
        ],
        { timeout: 5_000 },
      );

      const panes = result.stdout
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const [paneId, sessionName, windowName, dead, currentCommand, panePid, exitStatus] =
            entry.split("\t");
          return {
            paneId,
            sessionName,
            windowName,
            dead: dead === "1",
            currentCommand,
            panePid: panePid ? Number.parseInt(panePid, 10) : undefined,
            exitStatus: exitStatus ? Number.parseInt(exitStatus, 10) : undefined,
          };
        });

      const matchesExpectedWindow = (pane: { sessionName: string; windowName: string }) =>
        (!input.sessionName || pane.sessionName === input.sessionName) &&
        (!input.windowName || pane.windowName === input.windowName);

      const pane =
        panes.find(
          (candidate) => candidate.paneId === input.paneId && matchesExpectedWindow(candidate),
        ) ??
        panes.find((candidate) => matchesExpectedWindow(candidate)) ??
        (input.sessionName || input.windowName
          ? undefined
          : panes.find((candidate) => candidate.paneId === input.paneId));

      if (!pane) {
        return { exists: false };
      }

      return {
        exists: true,
        paneId: pane.paneId,
        sessionName: pane.sessionName,
        windowName: pane.windowName,
        dead: pane.dead,
        currentCommand: pane.currentCommand,
        panePid: pane.panePid,
        exitStatus: pane.exitStatus,
      };
    },

    async cleanupWorker(input) {
      if (input.sessionName && input.windowName) {
        try {
          await runner("tmux", ["kill-window", "-t", `${input.sessionName}:${input.windowName}`], {
            timeout: 5_000,
          });
        } catch (error) {
          if (!isMissingTmuxTargetError(error)) {
            throw error;
          }
        }
        return;
      }

      if (input.paneId) {
        try {
          await runner("tmux", ["kill-pane", "-t", input.paneId], { timeout: 5_000 });
        } catch (error) {
          if (!isMissingTmuxTargetError(error)) {
            throw error;
          }
        }
      }
    },
  };
}
