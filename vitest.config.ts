import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test-effect/**/*.test.ts"],
    exclude: [
      ".agentfiles/**",
      ".repos/**",
      "dist/**",
      "node_modules/**",
      "test/**",
      "test-e2e/**",
      "test-ui/**",
    ],
    coverage: {
      provider: "v8",
      include: [
        "src/application/**/*.ts",
        "src/domain/**/*.ts",
        "src/infrastructure/**/*.ts",
        "src/runtime/**/*.ts",
      ],
      exclude: [
        "src/application/agents/**",
        "src/application/delegation/**",
        "src/application/sessions/**",
        "src/domain/session-policy.ts",
        "src/domain/session.ts",
        "src/infrastructure/configuration/**",
        "src/infrastructure/git/**",
        "src/infrastructure/pi/**",
      ],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
      reporter: ["text", "html", "lcov"],
      reportsDirectory: ".agentfiles/coverage/effect",
    },
  },
});
