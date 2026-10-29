const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "tests/e2e",
  // 127.0.0.1, not localhost: localhost may resolve to ::1 first and the server listens on IPv4.
  timeout: 30000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:18899", headless: true },
  webServer: {
    // The real server against the fake kubectl and a fake HOME in test-results/ (see serve.py).
    command: "python3 tests/e2e/serve.py",
    url: "http://127.0.0.1:18899/api/contexts",
    reuseExistingServer: !process.env.CI,
    timeout: 20000,
  },
});
