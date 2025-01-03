import type { RaftKvParams } from "./core.js";

export const createNoopSignal = () => {
  return new AbortController().signal;
};

export function createLock() {
  // ID ごとにロック状態と待機キューを管理する
  const lockedById: Record<string, boolean> = {};
  const waitersById: Record<string, Array<() => void>> = {};

  function unlock(id: string) {
    const waiters = waitersById[id];
    if (!waiters) return;

    if (waiters.length > 0) {
      // キューに残っている待ちタスクを解放し、再度ロックさせる
      const next = waiters.shift();
      next?.();
    } else {
      // 待ちタスクがなければロックを解放
      lockedById[id] = false;
    }
  }

  async function lock(id = "##default##"): Promise<() => void> {
    if (!(id in lockedById)) lockedById[id] = false;
    if (!(id in waitersById)) waitersById[id] = [];

    return new Promise((resolve) => {
      if (!lockedById[id]) {
        // ロックが空いていればすぐにロック取得
        lockedById[id] = true;
        resolve(() => unlock(id));
      } else {
        // すでにロック中であれば待ち行列にプッシュ
        waitersById[id].push(() => {
          lockedById[id] = true;
          resolve(() => unlock(id));
        });
      }
    });
  }

  return lock;
}

export const createTimers = (
  electionTimeout: [number, number],
  heartbeatInterval: number,
  appendEntriesTimeout: number,
) => {
  return {
    heartbeatInterval: (cb) => setInterval(cb, heartbeatInterval),
    electionTimeout: (cb) => {
      const [min, max] = electionTimeout;
      const timeout = Math.random() * (max - min) + min;
      let tm: NodeJS.Timeout;
      const start = () => {
        tm = setTimeout(() => cb(), timeout);
      };
      return () => {
        clearTimeout(tm);
        start();
      };
    },
    electionRetrySleep: () => {
      const [min, max] = electionTimeout;
      const timeout = Math.random() * (max - min) + min;
      return new Promise((resolve) => setTimeout(resolve, timeout));
    },
    electionDuration: () => {
      const [min, max] = electionTimeout;
      const timeout = Math.random() * (max - min) + min;
      return new Promise((resolve) => setTimeout(resolve, timeout));
    },
    appendEntriesTimeout: () => {
      return new Promise((resolve) =>
        setTimeout(resolve, appendEntriesTimeout),
      );
    },
  } satisfies RaftKvParams["timers"];
};
