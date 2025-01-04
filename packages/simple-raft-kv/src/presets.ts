import type { RaftKvNode, RaftKvParams } from "./core.js";
import type {
  KvCommand,
  LogEntry,
  PersistedLogEntry,
  PersistentState,
  RaftKvRpc,
} from "./types.js";

export const randomDelay = (
  range: Readonly<[number, number]> | [number, number],
) => {
  const [min, max] = range;
  return new Promise<void>((resolve) =>
    setTimeout(resolve, Math.random() * (max - min) + min),
  );
};

export const createTimers = (
  electionTimeout: Readonly<[number, number]> | [number, number],
  heartbeatInterval: number,
  appendEntriesTimeout: number,
) => {
  return {
    heartbeatInterval: (cb) => setInterval(cb, heartbeatInterval),
    electionTimeout: (cb) => {
      let tm: NodeJS.Timeout;
      const start = () => {
        if (tm) clearTimeout(tm);
        const [min, max] = electionTimeout;
        const timeout = Math.random() * (max - min) + min;
        tm = setTimeout(() => cb(), timeout);
      };
      start();
      return () => {
        clearTimeout(tm);
        start();
      };
    },
    electionRetrySleep: () => randomDelay(electionTimeout),
    electionDuration: () => randomDelay(electionTimeout),
    appendEntriesTimeout: () =>
      randomDelay([appendEntriesTimeout, appendEntriesTimeout]),
  } satisfies RaftKvParams["timers"];
};

export const createDirectRpc = (
  delay: Readonly<[number, number]> | [number, number],
) => {
  let node: RaftKvNode | null = null;

  const setNode = (n: RaftKvNode) => {
    node = n;
  };

  const rpc: RaftKvRpc = {
    requestVote: async (args) => {
      await randomDelay(delay);
      if (!node) return null;
      return node.handleRequestVote(args);
    },
    appendEntries: async (args) => {
      await randomDelay(delay);
      if (!node) return null;
      return node.handleAppendEntries(args);
    },
  };

  return { rpc, setNode };
};

export type DirectRpc = ReturnType<typeof createDirectRpc>;

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
          index: from + idx,
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
    internal: state,
    async clearLogEntries() {
      state.logEntries = [];
      state.lastApplied = 0;
      state.kvStore = new Map();
    },
  };
};

export type MemoryStorage = ReturnType<typeof createMemoryStorage>;
