import { initializeRaftKv } from "../src/core.js";
import { createDirectRpc as createDirectRpcWithRandomDelay } from "../src/presets.js";
import { createMemoryStorage } from "../src/presets.js";
import type {
  AppendEntriesArgs,
  AppendEntriesReply,
  RaftKvRpc,
  RequestVoteArgs,
  RequestVoteReply,
} from "../src/types.js";

const rpcDelay = [5, 20] as const;
const electionRetrySleep = [150, 150] as const;
const electionDuration = [150, 300] as const;
const appendEntriesTimeout = [50, 50] as const;

const delay = (range: Readonly<[number, number]>) => {
  const [min, max] = range;
  return new Promise((resolve) =>
    setTimeout(resolve, Math.random() * (max - min) + min),
  );
};

export const createMockTimers = () => {
  let heartbeatCallback: (() => void) | null = null;
  let electionCallback: (() => void) | null = null;
  let electionTimeoutReset: (() => void) | null = null;

  return {
    heartbeatInterval: (cb: () => void) => {
      heartbeatCallback = cb;
    },
    electionTimeout: (cb: () => void) => {
      electionCallback = cb;
      electionTimeoutReset = () => {
        // Reset election timeout
      };
      return electionTimeoutReset;
    },
    electionRetrySleep: async () => {
      await delay(electionRetrySleep);
    },
    electionDuration: async () => {
      await delay(electionDuration);
    },
    appendEntriesTimeout: async () => {
      // Immediate return for testing
      await delay(appendEntriesTimeout);
    },
    // Test helpers
    triggerHeartbeat: () => {
      if (heartbeatCallback) heartbeatCallback();
    },
    triggerElectionTimeout: () => {
      if (electionCallback) electionCallback();
    },
    resetElectionTimeout: () => {
      if (electionTimeoutReset) electionTimeoutReset();
    },
  };
};

export const createDirectRpc = () => createDirectRpcWithRandomDelay(rpcDelay);

export const createNNodes = (ids: string[]) => {
  const rpcs = ids.map((id) => ({ id, directRpc: createDirectRpc() }));
  const nodes = ids.map((id) => {
    const peers = rpcs
      .filter((rpc) => rpc.id !== id)
      .map((rpc) => ({ id: rpc.id, rpc: rpc.directRpc.rpc }));
    const thisRpc = rpcs.find((rpc) => rpc.id === id);
    if (!thisRpc) throw new Error("No RPC found");

    const timers = createMockTimers();
    const storage = createMemoryStorage();

    const node = initializeRaftKv({
      nodeId: id,
      nodes: peers,
      timers,
      storage,
    });
    thisRpc.directRpc.setNode(node);
    return { id, node, timers, storage };
  });

  return nodes;
};

interface MockRpcConfig {
  requestVoteResponse?: RequestVoteReply;
  appendEntriesResponse?:
    | AppendEntriesReply
    | ((args: AppendEntriesArgs) => AppendEntriesReply);
  requestVoteDelay?: number;
  appendEntriesDelay?: number;
  failureRate?: number;
  onAppendEntries?: (args: AppendEntriesArgs) => void;
  onRequestVote?: (args: RequestVoteArgs) => void;
}

export const createMockRpc = (config: MockRpcConfig = {}): RaftKvRpc => {
  return {
    requestVote: async (args: RequestVoteArgs): Promise<RequestVoteReply> => {
      if (config.requestVoteDelay) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.requestVoteDelay),
        );
      }
      if (config.failureRate && Math.random() < config.failureRate) {
        throw new Error("Network error");
      }
      config.onRequestVote?.(args);
      return (
        config.requestVoteResponse ?? {
          term: args.term,
          voteGranted: true,
        }
      );
    },
    appendEntries: async (
      args: AppendEntriesArgs,
    ): Promise<AppendEntriesReply> => {
      if (config.appendEntriesDelay) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.appendEntriesDelay),
        );
      }
      if (config.failureRate && Math.random() < config.failureRate) {
        throw new Error("Network error");
      }
      config.onAppendEntries?.(args);
      if (typeof config.appendEntriesResponse === "function") {
        return config.appendEntriesResponse(args);
      }
      return (
        config.appendEntriesResponse ?? {
          term: args.term,
          success: true,
        }
      );
    },
  };
};

export type MockRpc = ReturnType<typeof createMockRpc>;

export const createThreeNodesWithMockRpc = (
  nodeId: string,
  rpcs: [[string, MockRpc], [string, MockRpc]],
) => {
  const timers = createMockTimers();
  const storage = createMemoryStorage();
  const node = initializeRaftKv({
    nodeId,
    nodes: rpcs.map(([id, rpc]) => ({ id, rpc })),
    timers,
    storage,
  });

  return { node, timers, storage };
};
