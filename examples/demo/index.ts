import * as nodeUtils from "node:util";
import { create } from "@simple-raft-kv/core";
import * as v from "valibot";

const configSchema = v.object({
  electionTimeout: v.tuple([v.number(), v.number()]),
  heartbeatInterval: v.number(),
  appendEntiresTimeout: v.number(),
  nodes: v.array(v.object({ id: v.string(), url: v.string() })),
});

const { values } = nodeUtils.parseArgs({
  options: {
    config: { type: "string" },
  },
});
const { config: configPath } = values;
if (!configPath) throw new Error("config is required");

const rpcs = new Map<string, DirectRpc>();
