import { vValidator } from "@hono/valibot-validator";
import { Hono } from "hono";
import * as v from "valibot";
import {
  AppendEntriesArgsSchema,
  type RaftKvOptionsInput,
  RaftKvOptionsSchema,
  RequestVoteArgsSchema,
} from "./types.js";

export const createRaftKvRoute = (options: RaftKvOptionsInput) => {
  const validOptions = v.parse(RaftKvOptionsSchema, options);

  return new Hono()
    .post(
      "/append-entries",
      vValidator("json", AppendEntriesArgsSchema),
      (c) => {},
    )
    .post(
      "/request-vote",
      vValidator("json", RequestVoteArgsSchema),
      (c) => {},
    );
};
