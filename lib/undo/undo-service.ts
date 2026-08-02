"use client";

export type UndoDirection = "undo" | "redo";
export type UndoEntityType =
  | "attendance"
  | "visitor"
  | "member"
  | "service";

export interface UndoCommand {
  id: string;
  organizationId: string;
  userId: string;
  entityType: UndoEntityType;
  entityId: string;
  label: string;
  canUndo: () => Promise<boolean>;
  canRedo: () => Promise<boolean>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

export interface UndoHistoryEvent {
  kind: "recorded" | "undone" | "redone" | "conflict" | "cleared";
  command?: UndoCommand;
  message: string;
}

const HISTORY_LIMIT = 50;
const undoStack: UndoCommand[] = [];
const redoStack: UndoCommand[] = [];
const listeners = new Set<(event: UndoHistoryEvent) => void>();
let suppressionDepth = 0;
let executionDirection: UndoDirection | undefined;
let group:
  | {
      label: string;
      commands: UndoCommand[];
    }
  | undefined;
let executing = false;

function emit(event: UndoHistoryEvent) {
  listeners.forEach((listener) => listener(event));
}

function push(command: UndoCommand) {
  undoStack.push(command);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  emit({
    kind: "recorded",
    command,
    message: command.label,
  });
}

export function recordUndoAction(command: UndoCommand) {
  if (suppressionDepth > 0) return;
  if (group) {
    group.commands.push(command);
    return;
  }
  push(command);
}

export async function runWithoutUndoCapture<T>(operation: () => Promise<T>) {
  suppressionDepth += 1;
  try {
    return await operation();
  } finally {
    suppressionDepth -= 1;
  }
}

export function currentUndoDirection() {
  return executionDirection;
}

function pushGroup(label: string, commands: UndoCommand[]) {
  if (commands.length === 0) return;
  if (commands.length === 1) {
    push({ ...commands[0], label });
    return;
  }
  const first = commands[0];
  push({
    id: crypto.randomUUID(),
    organizationId: first.organizationId,
    userId: first.userId,
    entityType: first.entityType,
    entityId: first.entityId,
    label,
    canUndo: async () => {
      const results = await Promise.all(
        [...commands].reverse().map((command) => command.canUndo()),
      );
      return results.every(Boolean);
    },
    canRedo: async () => {
      const results = await Promise.all(
        commands.map((command) => command.canRedo()),
      );
      return results.every(Boolean);
    },
    undo: async () => {
      for (const command of [...commands].reverse()) await command.undo();
    },
    redo: async () => {
      for (const command of commands) await command.redo();
    },
  });
}

export async function runUndoGroup<T>(
  label: string,
  operation: () => Promise<T>,
) {
  if (group || suppressionDepth > 0) return operation();
  group = { label, commands: [] };
  try {
    const result = await operation();
    pushGroup(label, group.commands);
    return result;
  } catch (error) {
    pushGroup(label, group.commands);
    throw error;
  } finally {
    group = undefined;
  }
}

async function execute(direction: UndoDirection) {
  if (executing) return false;
  const source = direction === "undo" ? undoStack : redoStack;
  const target = direction === "undo" ? redoStack : undoStack;
  const command = source.at(-1);
  if (!command) return false;
  executing = true;
  try {
    const valid =
      direction === "undo" ? await command.canUndo() : await command.canRedo();
    if (!valid) {
      source.pop();
      emit({
        kind: "conflict",
        command,
        message: `${command.label} can no longer be ${
          direction === "undo" ? "undone" : "redone"
        } because it changed elsewhere.`,
      });
      return false;
    }
    executionDirection = direction;
    await runWithoutUndoCapture(() =>
      direction === "undo" ? command.undo() : command.redo(),
    );
    source.pop();
    target.push(command);
    emit({
      kind: direction === "undo" ? "undone" : "redone",
      command,
      message: `${direction === "undo" ? "Undid" : "Redid"} ${command.label.toLocaleLowerCase()}.`,
    });
    return true;
  } catch {
    emit({
      kind: "conflict",
      command,
      message: `${command.label} could not be ${
        direction === "undo" ? "undone" : "redone"
      }. The current saved data was left unchanged.`,
    });
    return false;
  } finally {
    executionDirection = undefined;
    executing = false;
  }
}

export function undoLatest() {
  return execute("undo");
}

export function redoLatest() {
  return execute("redo");
}

export function clearUndoHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  group = undefined;
  emit({ kind: "cleared", message: "Undo history cleared." });
}

export function undoHistoryState() {
  return {
    undoCount: undoStack.length,
    redoCount: redoStack.length,
    executing,
  };
}

export function subscribeToUndoHistory(
  listener: (event: UndoHistoryEvent) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
