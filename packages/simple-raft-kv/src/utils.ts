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

  async function lock(
    id = "##default##",
  ): Promise<{ unlock: () => void; queueLength: number }> {
    if (!(id in lockedById)) lockedById[id] = false;
    if (!(id in waitersById)) waitersById[id] = [];

    return new Promise((resolve) => {
      if (!lockedById[id]) {
        // ロックが空いていればすぐにロック取得
        lockedById[id] = true;
        resolve({ unlock: () => unlock(id), queueLength: 0 });
      } else {
        // すでにロック中であれば待ち行列にプッシュ
        waitersById[id].push(() => {
          lockedById[id] = true;
          resolve({
            unlock: () => unlock(id),
            queueLength: waitersById[id].length,
          });
        });
      }
    });
  }

  return lock;
}
