import type { RaftKvNode, RaftKvParams } from "./core.js";
import type { RaftKvRpc } from "./types.js";

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
      if (!node) throw new Error("Node is not set");
      await randomDelay(delay);
      return node.handleRequestVote(args);
    },
    appendEntries: async (args) => {
      if (!node) throw new Error("Node is not set");
      await randomDelay(delay);
      return node.handleAppendEntries(args);
    },
  };

  return { rpc, setNode };
};
