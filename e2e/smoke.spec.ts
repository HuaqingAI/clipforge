import { test, expect } from "@playwright/test";

test.describe("冒烟测试", () => {
  test("首页可以正常加载", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=带货剪手")).toBeVisible();
    await expect(page.getByRole("link", { name: /TIDEWE/ })).toBeVisible();
    await expect(page.getByText("短视频带货", { exact: true })).toHaveCount(0);
  });

  test("商品库页面可以加载", async ({ page }) => {
    await page.goto("/products");
    await expect(page.locator("text=商品库")).toBeVisible();
  });

  test("新建项目流程可以到达表单", async ({ page }) => {
    await page.goto("/project/new");
    await expect(page.locator("text=商品图片")).toBeVisible();
    await expect(page.locator("text=商品名称")).toBeVisible();
    await expect(page.locator("text=视频模式")).toBeVisible();
  });

  test("设置页可以切换 Tab", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("text=AI 平台")).toBeVisible();
    await page.click("text=出镜人物");
    await expect(page.locator("text=添加出镜人物")).toBeVisible();
    await page.click("text=品牌设置");
    await expect(page.locator("text=店铺名称")).toBeVisible();
  });

  for (const route of ["/batch", "/project/clone", "/project/topic"]) {
    test(`旧入口 ${route} 进入 TIDEWE 创作`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(/\/project\/new$/);
      await expect(page.getByText("短视频带货", { exact: true })).toHaveCount(0);
      await expect(page.getByText("商品名称", { exact: true })).toBeVisible();
    });
  }
});
