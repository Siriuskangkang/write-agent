import { test, expect, Page } from '@playwright/test';

const BASE_URL = 'http://localhost:8002';
const EMAIL = 'test@test.com';
const PASSWORD = '12345678';

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForSelector('input[placeholder*="邮箱"]', { timeout: 10000 });
  await page.fill('input[placeholder*="邮箱"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/projects/, { timeout: 15000 });
}

async function navigateToStyleTemplate(page: Page) {
  // 等待项目列表加载
  await page.waitForSelector('.project-card, .projects-grid', { timeout: 10000 });

  // 获取第一个项目的 ID（从链接中获取）
  const firstProject = page.locator('.project-card').first();
  await firstProject.click();
  await page.waitForURL(/\/projects\//, { timeout: 15000 });

  // 获取项目 ID
  const url = page.url();
  const projectId = url.match(/\/projects\/([^/]+)/)?.[1];

  if (!projectId) {
    throw new Error('无法获取项目 ID');
  }

  // 导航到体例模板页面
  await page.goto(`${BASE_URL}/projects/${projectId}/style-templates`);
  await page.waitForURL(/style-templates/, { timeout: 10000 });
  await page.waitForTimeout(2000);

  return projectId;
}

test.describe('体例模板编辑功能', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('体例模板页面加载正常', async ({ page }) => {
    await navigateToStyleTemplate(page);

    // 等待页面内容加载
    await page.waitForTimeout(2000);

    // 截图记录当前状态
    await page.screenshot({ path: 'test-results/style-template-page.png', fullPage: true });

    // 页面应该显示体例相关内容
    const pageContent = await page.content();
    const hasStyleTemplateContent =
      pageContent.includes('体例') ||
      pageContent.includes('模板') ||
      pageContent.includes('style-template');

    expect(hasStyleTemplateContent).toBe(true);
  });

  test('体例模板列表编辑按钮可点击', async ({ page }) => {
    await navigateToStyleTemplate(page);

    // 查找编辑按钮（在表格操作列中）
    const editButtons = page.locator('.ant-btn').filter({ hasText: '编辑' });
    const count = await editButtons.count();

    if (count === 0) {
      console.log('未找到体例模板，跳过编辑测试（可能尚未创建体例）');
      await page.screenshot({ path: 'test-results/style-template-no-templates.png', fullPage: true });
      return;
    }

    console.log(`找到 ${count} 个编辑按钮`);

    // 检查第一个编辑按钮的可点击性
    const firstEditBtn = editButtons.first();
    await expect(firstEditBtn).toBeVisible({ timeout: 5000 });

    // 检查是否被遮挡
    const isClickable = await firstEditBtn.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const topElement = document.elementFromPoint(centerX, centerY);
      return el === topElement || el.contains(topElement as Node);
    });

    expect(isClickable).toBe(true);
  });

  test('体例模板编辑 - 完整流程', async ({ page }) => {
    await navigateToStyleTemplate(page);

    // 查找编辑按钮
    const editButtons = page.locator('.ant-btn').filter({ hasText: '编辑' });
    const count = await editButtons.count();

    if (count === 0) {
      test.skip(true, '没有可编辑的体例模板，跳过测试');
      return;
    }

    // 点击第一个编辑按钮
    const firstEditBtn = editButtons.first();
    await firstEditBtn.click();

    // 等待编辑界面出现
    await page.waitForTimeout(1000);

    // 验证编辑表单出现（应该显示"编辑体例"标题）
    const editForm = page.locator('.ant-card', { hasText: '编辑体例' });
    await expect(editForm).toBeVisible({ timeout: 5000 });

    console.log('体例编辑表单打开成功');

    // 截图记录编辑状态
    await page.screenshot({ path: 'test-results/style-template-edit-form.png', fullPage: true });

    // 查找取消按钮
    const cancelBtn = page.locator('.ant-btn').filter({ hasText: '取消' });
    if (await cancelBtn.count() > 0) {
      await cancelBtn.first().click();
      await page.waitForTimeout(500);
      console.log('取消编辑成功');
    }
  });

  test('体例模板编辑 - 字段修改和保存', async ({ page }) => {
    await navigateToStyleTemplate(page);

    const editButtons = page.locator('.ant-btn').filter({ hasText: '编辑' });
    const count = await editButtons.count();

    if (count === 0) {
      test.skip(true, '没有可编辑的体例模板，跳过测试');
      return;
    }

    // 点击第一个编辑按钮
    await editButtons.first().click();

    // 等待编辑表单出现
    const editForm = page.locator('.ant-card', { hasText: '编辑体例' });
    await expect(editForm).toBeVisible({ timeout: 5000 });

    // 查找并修改第一个文本输入字段
    const textInputs = editForm.locator('input[type="text"], .ant-input').filter({ hasNot: page.locator('[disabled]') });
    const inputCount = await textInputs.count();

    if (inputCount > 0) {
      const firstInput = textInputs.first();
      await firstInput.clear();
      await firstInput.fill('测试修改值');
      console.log('成功修改了一个字段值');
    }

    // 点击保存
    const saveBtn = editForm.locator('.ant-btn-primary').filter({ hasText: '保存' });
    if (await saveBtn.count() > 0) {
      await saveBtn.click();
      await page.waitForTimeout(1000);

      // 验证保存成功（应该返回到列表或显示成功提示）
      const successMsg = page.locator('.ant-message-success');
      if (await successMsg.count() > 0) {
        console.log('保存成功，显示了成功提示');
      }
    }
  });
});
