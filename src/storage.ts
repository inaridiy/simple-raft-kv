import type {
  KvCommand,
  LogEntry,
  MemoryState,
  PersistedLogEntry,
  PersistentState,
  RaftKvStorage,
} from "./types.js";

type MemoryStorageState = {
  persistentState: PersistentState;
  logEntries: PersistedLogEntry[];
  kvStore: Map<string, string>;
};

export const createMemoryStorage = (
  initialState: MemoryState,
): RaftKvStorage => {
  // Initialize in-memory state
  const state: MemoryStorageState = {
    persistentState: {
      term: 0,
      votedFor: null,
    },
    logEntries: [],
    kvStore: new Map(),
  };

  const applyCommand = (command: KvCommand) => {
    switch (command.op) {
      case "set":
        state.kvStore.set(command.key, command.value);
        break;
      case "delete":
        state.kvStore.delete(command.key);
        break;
      case "noop":
        break;
    }
  };

  return {
    async loadState(): Promise<PersistentState> {
      return state.persistentState;
    },

    async saveState(newState: PersistentState): Promise<void> {
      state.persistentState = newState;
    },

    async appendLogEntries(from: number, entries: LogEntry[]): Promise<number> {
      // Remove any existing entries from the 'from' index
      state.logEntries = state.logEntries.filter((entry) => entry.index < from);

      // Append new entries with proper indexing
      const newEntries = entries.map((entry, i) => ({
        ...entry,
        index: from + i,
      }));
      state.logEntries.push(...newEntries);

      // Return the index of the last appended entry
      return from + entries.length - 1;
    },

    async getLastLogEntry(): Promise<PersistedLogEntry | null> {
      if (state.logEntries.length === 0) return null;
      return state.logEntries[state.logEntries.length - 1];
    },

    async getLogEntryByIndex(index: number): Promise<PersistedLogEntry | null> {
      return state.logEntries.find((entry) => entry.index === index) ?? null;
    },

    async commitLogEntries(endIndex: number): Promise<void> {
      // Apply all entries from lastCommitIndex to endIndex
      const entriesToCommit = state.logEntries.filter(
        (entry) =>
          entry.index >= initialState.commitIndex && entry.index < endIndex,
      );

      for (const entry of entriesToCommit) {
        applyCommand(entry.command);
      }

      // Update commit index
      initialState.commitIndex = endIndex;
    },
  };
};
