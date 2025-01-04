import type {
  KvCommand,
  LogEntry,
  PersistedLogEntry,
  PersistentState,
  RaftKvStorage,
} from "./types.js";

type MemoryStorageState = {
  persistentState: PersistentState;
  logEntries: PersistedLogEntry[];
  lastApplied: number;
  kvStore: Map<string, string>;
};

export const createMemoryStorage = (injectState?: MemoryStorageState) => {
  // Initialize in-memory state
  const state: MemoryStorageState = injectState || {
    persistentState: { term: 0, votedFor: null },
    logEntries: [],
    lastApplied: 0,
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
    async loadState() {
      return state.persistentState;
    },

    async saveState(newState: PersistentState) {
      state.persistentState = newState;
    },

    async appendLogEntries(from: number, entries: LogEntry[]): Promise<number> {
      if (entries.length === 0) return state.logEntries.length;

      // 既存のエントリを削除して新しいエントリで上書き
      state.logEntries = [
        ...state.logEntries.slice(0, from - 1),
        ...entries.map((entry, idx) => ({
          ...entry,
          index: from + idx + 1,
        })),
      ];

      return from + entries.length; // indexは1から始まる
    },

    async getLastLogEntry(): Promise<PersistedLogEntry | null> {
      if (state.logEntries.length === 0) return null;
      return state.logEntries[state.logEntries.length - 1];
    },

    async getLogEntryByIndex(index: number): Promise<PersistedLogEntry | null> {
      const entry = state.logEntries[index - 1];
      return entry || null;
    },

    async commitLogEntries(endIndex: number): Promise<void> {
      // 未適用のエントリを適用
      for (let i = state.lastApplied; i < endIndex; i++) {
        const entry = state.logEntries[i];
        if (entry) {
          applyCommand(entry.command);
        }
      }
      state.lastApplied = endIndex;
    },
    async clearLogEntries() {
      state.logEntries = [];
      state.lastApplied = 0;
      state.kvStore = new Map();
    },
  };
};
