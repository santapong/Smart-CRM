import { test, expect } from "@playwright/test";

test("golden path: sign in, see dashboard, navigate sections", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@demo.com");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.waitForURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.getByRole("link", { name: "Contacts" }).click();
  await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();

  await page.getByRole("link", { name: "Deals" }).click();
  await expect(page.getByRole("heading", { name: "Deals" })).toBeVisible();

  await page.getByRole("link", { name: "Activities" }).click();
  await expect(page.getByRole("heading", { name: "Activities" })).toBeVisible();
});

test("create a new contact", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@demo.com");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard$/);

  await page.goto("/contacts/new");
  await page.getByLabel("First name").fill("Zed");
  await page.getByLabel("Last name").fill("Tester");
  await page.getByLabel("Email").fill("zed.tester@example.com");
  await page.getByRole("button", { name: /create contact/i }).click();

  await expect(page.getByRole("heading", { name: /Zed Tester/i })).toBeVisible();
});
