import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { enrichSessionSummary } from "../../../sessions.js";

const RequestSchema = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("current"), cwd: Schema.String, sessionDir: Schema.optional(Schema.String) }),
  Schema.Struct({ scope: Schema.Literal("all"), sessionDir: Schema.optional(Schema.String) }),
]);

const request = Schema.decodeUnknownSync(RequestSchema)(JSON.parse(process.argv[2] ?? "null"));
const sessions = request.sessionDir
  ? await SessionManager.listAll(request.sessionDir)
  : request.scope === "current"
    ? await SessionManager.list(request.cwd)
    : await SessionManager.listAll();

process.stdout.write(JSON.stringify(sessions.map((session) => enrichSessionSummary({ ...session }))));
