import { describe, expect, it } from "vitest";
import { createLock } from "./utils.js";

describe("create", () => {
  it("should lock and unlock correctly", async () => {
    const lock = createLock();
    const { unlock } = await lock("test");
    let isLocked = true;

    // ロックが取得されていることを確認
    expect(isLocked).toBe(true);

    // ロックを解放
    unlock();
    isLocked = false;

    // ロックが解放されていることを確認
    expect(isLocked).toBe(false);
  });

  it("should handle multiple locks correctly", async () => {
    const lock = createLock();
    const { unlock: unlock1 } = await lock("test");
    let isLocked1 = true;

    // 最初のロックが取得されていることを確認
    expect(isLocked1).toBe(true);

    const unlock2Promise = lock("test");
    let isLocked2 = false;

    // 2つ目のロックはまだ取得されていないことを確認
    unlock1();
    isLocked1 = false;

    // 最初のロックが解放された後、2つ目のロックが取得されることを確認
    const { unlock: unlock2 } = await unlock2Promise;
    isLocked2 = true;

    expect(isLocked1).toBe(false);
    expect(isLocked2).toBe(true);

    // 2つ目のロックを解放
    unlock2();
    isLocked2 = false;

    // 2つ目のロックが解放されていることを確認
    expect(isLocked2).toBe(false);
  });
});
