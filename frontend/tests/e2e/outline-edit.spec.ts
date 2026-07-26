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

async function navigateToWorkbench(page: Page) {
  await page.waitForSelector('.project-card, .projects-grid', { timeout: 10000 });
  const projectCard = page.locator('.project-card').first();
  await projectCard.click();
  await page.waitForURL(/\/projects\/[^/]+$/, { timeout: 15000 });
}

async function selectChapterNode(page: Page) {
  // 等待目录树加载
  await page.waitForSelector('.ant-tree', { timeout: 15000 });

  // 调试：检查是否有遮挡层
  const overlayInfo = await page.evaluate(() => {
    const tree = document.querySelector('.ant-tree');
    if (!tree) return { error: 'tree not found' };

    const rect = tree.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const topElement = document.elementFromPoint(centerX, centerY);

    return {
      treeClass: tree.className,
      topElementTag: topElement?.tagName,
      topElementClass: topElement?.className,
      topElementStyle: topElement ? window.getComputedStyle(topElement).pointerEvents : null,
    };
  });

  console.log('DOM 状态检查:', JSON.stringify(overlayInfo, null, 2));

  // 尝试点击章级别节点（通常是 CHAPTER 类型）
  // 查找带有"章"标签的节点
  const chapterNode = page.locator('.ant-tree-node-content-wrapper').filter({
    has: page.locator('.ant-tag', { hasText: '章' })
  }).first();

  if (await chapterNode.count() > 0) {
    await chapterNode.click({ force: true }); // 强制点击以绕过遮挡检测
  } else {
    // 如果没有"章"标签，点击第一个展开的节点
    const firstNode = page.locator('.ant-tree-node-content-wrapper').first();
    await firstNode.click({ force: true }); // 强制点击以绕过遮挡检测
  }

  // 等待工作区响应
  await page.waitForTimeout(2000);
}

test.describe('大纲编辑功能', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateToWorkbench(page);
  });

  test('大纲编辑按钮可点击（无遮挡）', async ({ page }) => {
    await selectChapterNode(page);

    // 查找大纲面板的 PaneHeader
    // 大纲编辑按钮应该在 "大纲" 标题旁边
    const outlineHeader = page.locator('text=大纲').first();
    await expect(outlineHeader).toBeVisible({ timeout: 10000 });

    // 查找附近的编辑按钮
    const editBtn = page.locator('button').filter({ hasText: '编辑' }).first();

    // 检查按钮是否存在且不被遮挡
    if (await editBtn.count() > 0) {
      await expect(editBtn).toBeVisible({ timeout: 5000 });

      // 检查按钮是否被覆盖（遮挡检测）
      const isClickable = await editBtn.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const topElement = document.elementFromPoint(centerX, centerY);
        return el === topElement || el.contains(topElement as Node);
      });

      if (!isClickable) {
        console.error('编辑按钮被遮挡！存在 z-index 或 pointer-events 问题');
        await page.screenshot({ path: 'test-results/outline-edit-button-blocked.png', fullPage: true });
      }

      expect(isClickable).toBe(true);

      // 尝试点击编辑按钮
      await editBtn.click({ force: false }); // 不强制点击，测试实际可点击性

      // 验证进入编辑状态（出现保存/取消按钮）
      const saveBtn = page.locator('button').filter({ hasText: '保存' });
      const cancelBtn = page.locator('button').filter({ hasText: '取消' });

      await expect(saveBtn).toBeVisible({ timeout: 5000 });
      await expect(cancelBtn).toBeVisible({ timeout: 5000 });

      console.log('大纲编辑按钮可点击，进入编辑状态成功');
    } else {
      // 截图记录当前状态
      await page.screenshot({ path: 'test-results/outline-no-edit-button.png', fullPage: true });
      console.log('未找到大纲编辑按钮，可能大纲尚未生成');
    }
  });

  test('大纲编辑 - 完整编辑流程', async ({ page }) => {
    await selectChapterNode(page);

    // 等待大纲内容加载
    await page.waitForTimeout(3000);

    // 检查是否有大纲内容
    const outlineContent = page.locator('[class*="outline"], .ant-collapse').first();
    const hasOutline = await outlineContent.count() > 0;

    if (!hasOutline) {
      test.skip(true, '该章节没有大纲内容，跳过编辑测试');
      return;
    }

    // 查找编辑按钮
    const editBtn = page.locator('button').filter({ hasText: '编辑' }).first();

    if (await editBtn.count() === 0) {
      test.skip(true, '未找到编辑按钮，跳过测试');
      return;
    }

    // 点击编辑
    await editBtn.click();

    // 等待编辑器出现（选择第一个可见的 textarea）
    const editor = page.locator('textarea').first();
    await expect(editor).toBeVisible({ timeout: 5000 });

    // 点击取消
    const cancelBtn = page.locator('button').filter({ hasText: '取消' });
    await cancelBtn.click();

    // 验证退出编辑状态
    await expect(editBtn).toBeVisible({ timeout: 5000 });
    console.log('大纲编辑流程测试通过');
  });

  test('大纲 PaneHeader 无 z-index 遮挡问题', async ({ page }) => {
    await selectChapterNode(page);
    await page.waitForTimeout(2000);

    // 检查是否有覆盖在按钮区域的透明元素
    const overlayCheck = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      const blockedButtons: string[] = [];

      buttons.forEach((btn) => {
        const text = btn.textContent?.trim();
        if (text === '编辑' || text?.includes('编辑')) {
          const rect = btn.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;

          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const topElement = document.elementFromPoint(centerX, centerY);

          if (topElement && btn !== topElement && !btn.contains(topElement)) {
            blockedButtons.push(`按钮 "${text}" 被 ${topElement.tagName}.${topElement.className} 遮挡`);
          }
        }
      });

      return blockedButtons;
    });

    if (overlayCheck.length > 0) {
      console.error('发现遮挡问题:', overlayCheck);
      await page.screenshot({ path: 'test-results/outline-overlay-issues.png', fullPage: true });
    }

    expect(overlayCheck).toHaveLength(0);
  });

  test('大纲编辑 - 保存功能测试（不修改内容）', async ({ page }) => {
    await selectChapterNode(page);
    await page.waitForTimeout(3000);

    // 检查是否有大纲内容
    const editBtn = page.locator('button').filter({ hasText: '编辑' }).first();
    if (await editBtn.count() === 0) {
      test.skip(true, '未找到编辑按钮，跳过测试');
      return;
    }

    // 点击编辑
    await editBtn.click();

    // 等待编辑器出现
    const editor = page.locator('textarea').first();
    await expect(editor).toBeVisible({ timeout: 5000 });

    // 监听 outline 更新接口的响应
    let apiResponseBody: string | null = null;
    let apiStatus: number | null = null;
    page.on('response', async (resp) => {
      if (resp.url().includes('/outline/') && resp.request().method() === 'PATCH') {
        apiStatus = resp.status();
        apiResponseBody = await resp.text().catch(() => null);
      }
    });

    // 不修改内容，直接点击保存
    const saveBtn = page.locator('button').filter({ hasText: '保存' });
    await saveBtn.click();

    // 等待保存完成
    await page.waitForTimeout(2000);

    if (apiStatus !== null) {
      console.log(`API 响应状态: ${apiStatus}`);
      console.log(`API 响应内容: ${apiResponseBody}`);
    }

    // 验证是否有错误提示
    const errorMessage = page.locator('.ant-message-error, .ant-notification-error');
    const hasError = await errorMessage.count() > 0;

    if (hasError) {
      const errorText = await errorMessage.first().textContent();
      console.error('保存失败，错误信息:', errorText);
      await page.screenshot({ path: 'test-results/outline-save-error.png', fullPage: true });
      throw new Error(`保存大纲失败（未修改内容）: ${errorText}`);
    }

    // 验证成功提示
    const successMessage = page.locator('.ant-message-success');
    await expect(successMessage).toBeVisible({ timeout: 5000 });

    console.log('大纲保存成功（未修改内容）');
  });
});
