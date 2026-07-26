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

async function openDirectorySidebar(page: Page) {
  // 先等待 loading 完成，DirectorySidebar 才会渲染进 DOM
  await page.waitForSelector('.ant-tree-node-content-wrapper', { timeout: 15000 });

  // 用 data-icon 找展开按钮（Tooltip 文字不在按钮 textContent 里）
  const expandBtn = page.locator('button:has([data-icon="menu-unfold"])');
  if (await expandBtn.count() > 0) {
    await expandBtn.first().click();
    // 等待侧边栏动画完成
    await page.waitForTimeout(600);
  }

  // 等待目录树节点真正进入视口
  await page.waitForFunction(() => {
    const node = document.querySelector('.ant-tree-node-content-wrapper');
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.left < window.innerWidth;
  }, { timeout: 10000 });
}

async function closeDirectorySidebar(page: Page) {
  // 点击"收起目录"按钮关闭侧边栏
  const collapseBtn = page.locator('button:has([data-icon="menu-fold"])');
  if (await collapseBtn.count() > 0) {
    await collapseBtn.first().click();
    await page.waitForTimeout(600);
  }
}

async function selectSectionNode(page: Page) {
  // 先打开侧边栏
  await openDirectorySidebar(page);

  // 先展开章节（点击展开箭头）
  const expandIcons = page.locator('.ant-tree-switcher:not(.ant-tree-switcher_open)').first();
  if (await expandIcons.count() > 0) {
    await expandIcons.click({ force: true });
    await page.waitForTimeout(500);
  }

  // 查找小节节点（带有"节"标签）
  const sectionNode = page.locator('.ant-tree-node-content-wrapper').filter({
    has: page.locator('.ant-tag', { hasText: '节' })
  }).first();

  if (await sectionNode.count() > 0) {
    await sectionNode.click({ force: true });
  } else {
    const nodes = page.locator('.ant-tree-node-content-wrapper');
    const count = await nodes.count();
    if (count > 1) {
      await nodes.nth(1).click({ force: true });
    } else {
      await nodes.first().click({ force: true });
    }
  }

  // 关闭侧边栏，让内容区可以交互
  await closeDirectorySidebar(page);
  await page.waitForTimeout(1000);
}

test.describe('正文编辑功能', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateToWorkbench(page);
  });

  test('正文编辑按钮可点击（无遮挡）', async ({ page }) => {
    await selectSectionNode(page);

    // 查找正文面板
    const contentHeader = page.locator('text=正文').first();
    await expect(contentHeader).toBeVisible({ timeout: 10000 });

    // 查找正文编辑按钮
    const editBtns = page.locator('button').filter({ hasText: '编辑' });
    const count = await editBtns.count();

    if (count === 0) {
      await page.screenshot({ path: 'test-results/content-no-edit-button.png', fullPage: true });
      console.log('未找到编辑按钮，可能正文尚未生成');
      return;
    }

    // 取最后一个编辑按钮（正文编辑按钮通常在大纲按钮之后）
    const contentEditBtn = editBtns.last();
    await expect(contentEditBtn).toBeVisible({ timeout: 5000 });

    // 检查按钮是否被遮挡
    const isClickable = await contentEditBtn.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const topElement = document.elementFromPoint(centerX, centerY);
      return el === topElement || el.contains(topElement as Node);
    });

    if (!isClickable) {
      console.error('正文编辑按钮被遮挡！');
      await page.screenshot({ path: 'test-results/content-edit-button-blocked.png', fullPage: true });

      // 诊断遮挡元素
      const blocker = await contentEditBtn.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const topElement = document.elementFromPoint(centerX, centerY);
        if (topElement) {
          const style = window.getComputedStyle(topElement);
          return {
            tag: topElement.tagName,
            class: topElement.className,
            id: topElement.id,
            zIndex: style.zIndex,
            pointerEvents: style.pointerEvents,
            position: style.position,
          };
        }
        return null;
      });
      console.error('遮挡元素信息:', JSON.stringify(blocker, null, 2));
    }

    expect(isClickable).toBe(true);
  });

  test('正文编辑 - 完整流程', async ({ page }) => {
    await selectSectionNode(page);
    await page.waitForTimeout(3000);

    // 查找编辑按钮
    const editBtns = page.locator('button').filter({ hasText: '编辑' });
    const count = await editBtns.count();

    if (count === 0) {
      test.skip(true, '未找到编辑按钮，跳过测试');
      return;
    }

    const contentEditBtn = editBtns.last();

    // 点击编辑
    await contentEditBtn.click();

    // 验证进入编辑状态
    const saveBtn = page.locator('button').filter({ hasText: '保存' });
    await expect(saveBtn).toBeVisible({ timeout: 5000 });

    // 验证编辑器出现
    const editor = page.locator('textarea, .monaco-editor').first();
    await expect(editor).toBeVisible({ timeout: 5000 });

    // 点击取消
    const cancelBtn = page.locator('button').filter({ hasText: '取消' });
    await cancelBtn.click();

    // 验证退出编辑状态
    await expect(contentEditBtn).toBeVisible({ timeout: 5000 });
    console.log('正文编辑流程测试通过');
  });

  test('检测所有编辑按钮的遮挡情况', async ({ page }) => {
    await selectSectionNode(page);
    await page.waitForTimeout(2000);

    // 检查所有编辑按钮
    const blockedButtons = await page.evaluate(() => {
      const results: Array<{
        text: string;
        blocked: boolean;
        blockerInfo?: object;
      }> = [];

      const buttons = document.querySelectorAll('button');
      buttons.forEach((btn) => {
        const text = btn.textContent?.trim() ?? '';
        if (!text.includes('编辑') && !text.includes('保存') && !text.includes('取消')) return;

        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const topElement = document.elementFromPoint(centerX, centerY);

        const isBlocked = !!(topElement && btn !== topElement && !btn.contains(topElement));

        const result: { text: string; blocked: boolean; blockerInfo?: object } = { text, blocked: isBlocked };

        if (isBlocked && topElement) {
          const style = window.getComputedStyle(topElement);
          result.blockerInfo = {
            tag: topElement.tagName,
            class: (topElement as HTMLElement).className,
            zIndex: style.zIndex,
            pointerEvents: style.pointerEvents,
            position: style.position,
          };
        }

        results.push(result);
      });

      return results;
    });

    console.log('按钮检测结果:');
    blockedButtons.forEach((btn) => {
      if (btn.blocked) {
        console.error(`  ❌ "${btn.text}" 被遮挡`, btn.blockerInfo);
      } else {
        console.log(`  ✅ "${btn.text}" 可点击`);
      }
    });

    const blocked = blockedButtons.filter((b) => b.blocked);
    if (blocked.length > 0) {
      await page.screenshot({ path: 'test-results/all-blocked-buttons.png', fullPage: true });
    }

    expect(blocked).toHaveLength(0);
  });
});
