import { type RaftKvNode, initializeRaftKv } from "../src/core.js";
import { createMemoryStorage } from "../src/storage.js";
import type { RaftKvRpc } from "../src/types.js";

const rpcDelay = [5, 20] as const;
const electionRetrySleep = [150, 150] as const;
const electionDuration = [150, 300] as const;

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
      await new Promise((resolve) => setTimeout(resolve, 0));
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

export const createDirectRpc = () => {
  let node: RaftKvNode | null = null;

  const setNode = (n: RaftKvNode) => {
    node = n;
  };

  const rpc: RaftKvRpc = {
    requestVote: async (args) => {
      if (!node) throw new Error("Node is not set");
      await delay(rpcDelay);
      return node.handleRequestVote(args);
    },
    appendEntries: async (args) => {
      if (!node) throw new Error("Node is not set");
      await delay(rpcDelay);
      return node.handleAppendEntries(args);
    },
  };

  return { rpc, setNode };
};

export const createThreeNodes = (ids: [string, string, string]) => {
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
