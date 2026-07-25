import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";
import { GitClient } from "../infrastructure/git/GitClient.js";
import { WorktreeManagerLive } from "../infrastructure/git/WorktreeManagerLive.js";
import { DelegationFibersLive } from "../infrastructure/runtime/DelegationFibers.js";
import { RuntimeRegistryLive } from "../infrastructure/runtime/RuntimeRegistry.js";

const GitAndNode = GitClient.layer.pipe(Layer.provideMerge(NodeServices.layer));

const WorktreeLayer = WorktreeManagerLive.pipe(Layer.provide(GitAndNode));

export const AppLayer = Layer.mergeAll(NodeServices.layer, WorktreeLayer, RuntimeRegistryLive, DelegationFibersLive);
