import { Hono } from "hono";
import * as v from "valibot";
import { type RaftKvOptionsInput, RaftKvOptionsSchema } from "./types.js";

export const createRaftKvRoute = (options: RaftKvOptionsInput) => {
  const validOptions = v.parse(RaftKvOptionsSchema, options);
};
