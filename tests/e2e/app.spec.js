// The real server + the built UI, against the fake kubectl (tests/e2e/serve.py).
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const LOG = path.join(__dirname, "..", "..", "test-results", "e2e", "kubectl.log");
const kubectlCalls = () =>
  fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("the overview shows the cluster from kubectl", async ({ page }) => {
  await page.goto("/?lang=en");
  await expect(page.getByText("node-a").first()).toBeVisible();
  await expect(page.getByText("api-2").first()).toBeVisible();
  await expect(page.getByText("safe by design")).toBeVisible();
});

test("the interface speaks Brazilian Portuguese", async ({ page }) => {
  await page.goto("/?lang=pt-BR");
  await expect(page.getByText("Visão geral").first()).toBeVisible();
});

test("there is no button that changes or deletes anything", async ({ page }) => {
  await page.goto("/?lang=en");
  await expect(page.getByText("node-a").first()).toBeVisible();
  for (const word of [/^delete$/i, /^scale$/i, /^restart$/i, /^kill$/i]) {
    await expect(page.getByRole("button", { name: word })).toHaveCount(0);
  }
});

test("the pod shell asks first and runs nothing when cancelled", async ({ page }) => {
  await page.goto("/?lang=en");
  await page.getByText("Pods", { exact: true }).first().click();
  await page.getByText("api-1").first().click();
  await page.getByText("Terminal", { exact: true }).first().click();
  // the tab opens straight into the question; nothing runs before the answer
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("default/api-1 on staging");
  expect(kubectlCalls().some((c) => c.includes("exec"))).toBe(false);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Nothing ran inside the cluster", { exact: false })).toBeVisible();
  expect(kubectlCalls().some((c) => c.includes("exec"))).toBe(false);

  await page.getByRole("button", { name: "Open shell" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Open shell" }).click();
  await expect.poll(() => kubectlCalls().some((c) => c.includes("exec"))).toBe(true);
});
