import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

const RequestSchema = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("current"), cwd: Schema.String, sessionDir: Schema.optional(Schema.String) }),
  Schema.Struct({ scope: Schema.Literal("all"), sessionDir: Schema.optional(Schema.String) }),
]);

const request = Schema.decodeUnknownSync(RequestSchema)(JSON.parse(process.argv[2] ?? "null"));
const sessions =
  request.scope === "current"
    ? await SessionManager.list(request.cwd, request.sessionDir)
    : request.sessionDir
      ? await SessionManager.listAll(request.sessionDir)
      : await SessionManager.listAll();

process.stdout.write(JSON.stringify(sessions));
