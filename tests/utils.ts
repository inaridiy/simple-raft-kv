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
