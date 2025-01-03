import { type RaftKvNode, initializeRaftKv } from "../src/core.js";
import { createMemoryStorage } from "../src/storage.js";
import type { RaftKvRpc } from "../src/types.js";

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
      // Immediate return for testing
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    electionDuration: async () => {
      // Immediate return for testing
      await new Promise((resolve) => setTimeout(resolve, 0));
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
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 100));
      return node.handleRequestVote(args);
    },
    appendEntries: async (args) => {
      if (!node) throw new Error("Node is not set");
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 100));
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
