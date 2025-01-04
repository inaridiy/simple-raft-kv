import fs from "node:fs/promises";
import * as nodeUtils from "node:util";
import { serve } from "@hono/node-server";
import { vValidator } from "@hono/valibot-validator";
import {
  AppendEntriesArgsSchema,
  KvCommandSchema,
  type RaftKvRpc,
  RequestVoteArgsSchema,
  createMemoryStorage,
  createSimplestTimers,
  initializeRaftKv,
} from "@simple-raft-kv/core";
import { Hono } from "hono";
import { hc } from "hono/client";
serve;
import * as v from "valibot";

const configSchema = v.object({
  electionTimeout: v.tuple([v.number(), v.number()]),
  heartbeatInterval: v.number(),
  appendEntiresTimeout: v.number(),
  nodes: v.array(v.object({ id: v.string(), url: v.string() })),
});

const { values } = nodeUtils.parseArgs({
  options: {
    nodeId: { type: "string" },
    port: { type: "string" },
    config: { type: "string" },
  },
});
const { nodeId, port, config: configPath } = values;
if (!nodeId) throw new Error("nodeId is required");
if (!port) throw new Error("port is required");
if (!configPath) throw new Error("config is required");

const configJson = await fs.readFile(configPath, "utf-8");
const config = v.parse(configSchema, JSON.parse(configJson));

const httpRpc = (url: string): RaftKvRpc => {
  const client = hc<typeof app>(url);
  return {
    async requestVote(args) {
      try {
        const response = await client.raft["request-vote"].$post({
          json: args,
        });
        const reply = await response.json();
        return reply;
      } catch (e) {
        return null;
      }
    },
    async appendEntries(args) {
      try {
        const response = await client.raft["append-entries"].$post({
          json: args,
        });
        const reply = await response.json();
        return reply;
      } catch (e) {
        return null;
      }
    },
  };
};

const storage = createMemoryStorage();
const raft = initializeRaftKv({
  nodeId,
  storage,
  logger: console.log,
  nodes: config.nodes
    .filter((n) => n.id !== nodeId)
    .map((n) => ({ id: n.id, rpc: httpRpc(n.url) })),
  timers: createSimplestTimers(
    config.electionTimeout,
    config.heartbeatInterval,
    config.appendEntiresTimeout,
  ),
});

const app = new Hono()
  .post(
    "/raft/request-vote",
    vValidator("json", RequestVoteArgsSchema),
    async (c) => {
      const args = c.req.valid("json");
      const reply = await raft.handleRequestVote(args);
      return c.json(reply);
    },
  )
  .post(
    "/raft/append-entries",
    vValidator("json", AppendEntriesArgsSchema),
    async (c) => {
      const args = c.req.valid("json");
      const reply = await raft.handleAppendEntries(args);
      return c.json(reply);
    },
  )
  .post("/mutate", vValidator("json", KvCommandSchema), async (c) => {
    const command = c.req.valid("json");
    const result = await raft.handleClientRequest([command]);
    if (result.type === "success") return c.json({ ok: true });
    if (result.type === "redirect") {
      const redirectTo = config.nodes.find((n) => n.id === result.redirect);
      if (!redirectTo)
        return c.json({ ok: false, error: "redirect node not found" }, 500);
      return c.redirect(redirectTo.url, 307);
    }
    return c.json({ ok: false, error: "election in progress" }, 503);
  })
  .post(
    "/query",
    vValidator("json", v.object({ keys: v.array(v.string()) })),
    async (c) => {
      const { keys } = c.req.valid("json");
      const noopResult = await raft.handleClientRequest([{ op: "noop" }]); //雑に

      if (noopResult.type === "redirect") {
        const redirectTo = config.nodes.find(
          (n) => n.id === noopResult.redirect,
        );
        return redirectTo
          ? c.redirect(redirectTo.url, 307)
          : c.json({ ok: false, error: "redirect node not found" }, 500);
      }

      if (noopResult.type === "in-election") {
        return c.json({ ok: false, error: "election in progress" }, 503);
      }

      //行儀の悪い実装
      const values = keys.map((key) => storage.internal.kvStore.get(key));
      return c.json({ ok: true, values } as const);
    },
  );

serve({ fetch: app.fetch, port: Number.parseInt(port) }, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
