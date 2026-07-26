import { Page, expect } from '@playwright/test';

export const TEST_CREDENTIALS = {
  email: 'test@test.com',
  password: '12345678',
};

export async function login(page: Page) {
  await page.goto('/');

  // 如果已经登录，直接返回
  if (page.url().includes('/projects') || page.url().includes('/workbench')) {
    return;
  }

  // 等待登录表单
  await page.waitForSelector('input[type="email"], input[placeholder*="邮箱"], input[placeholder*="email"]', { timeout: 5000 });

  const emailInput = page.locator('input[type="email"], input[placeholder*="邮箱"]').first();
  const passwordInput = page.locator('input[type="password"]').first();

  await emailInput.fill(TEST_CREDENTIALS.email);
  await passwordInput.fill(TEST_CREDENTIALS.password);

  await page.locator('button[type="submit"], button:has-text("登录")').first().click();

  // 等待登录成功后跳转
  await page.waitForURL(/\/(projects|workbench)/, { timeout: 15000 });
}

export async function navigateToProject(page: Page) {
  await login(page);

  // 等待项目列表加载
  await page.waitForSelector('[class*="project"], .ant-card, h2, h3', { timeout: 10000 });

  // 点击第一个项目
  const projectCard = page.locator('.ant-card, [class*="project-item"]').first();
  if (await projectCard.count() > 0) {
    await projectCard.click();
    await page.waitForURL(/\/workbench/, { timeout: 10000 });
  }
}
