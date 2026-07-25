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
        "src/infrastructure/git/**",
        "src/infrastructure/pi/legacy-v0_82/**",
      ],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 90,
        lines: 95,
      },
      reporter: ["text", "html", "lcov"],
      reportsDirectory: ".agentfiles/coverage/effect",
    },
  },
});
