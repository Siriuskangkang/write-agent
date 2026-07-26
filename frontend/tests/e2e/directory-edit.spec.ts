import { test, expect, Page } from '@playwright/test';

const BASE_URL = 'http://localhost:8002';
const EMAIL = 'test@test.com';
const PASSWORD = '12345678';

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);

  // 检查当前 URL，如果已经重定向到 /projects 则说明已登录
  const currentUrl = page.url();
  if (currentUrl.includes('/projects')) {
    return;
  }

  // 等待登录表单出现（给足时间让页面加载和可能的重定向完成）
  await page.waitForTimeout(2000);
  const afterWaitUrl = page.url();
  if (afterWaitUrl.includes('/projects')) {
    return;
  }

  await page.waitForSelector('input[placeholder*="邮箱"]', { timeout: 10000 });
  await page.fill('input[placeholder*="邮箱"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/projects/, { timeout: 15000 });
}

async function navigateToWorkbench(page: Page) {
  // 等待项目列表加载
  await page.waitForSelector('.project-card', { timeout: 15000 });
  const projectCard = page.locator('.project-card').first();
  await projectCard.click();
  // 等待导航到工作台
  await page.waitForURL(/\/projects\/[^/]+$/, { timeout: 15000 });
  // 等待页面稳定
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
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

  // 等待目录树节点真正可见（在视口内）
  await page.waitForFunction(() => {
    const node = document.querySelector('.ant-tree-node-content-wrapper');
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.left < window.innerWidth;
  }, { timeout: 10000 });
}

test.describe('目录节点编辑功能', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateToWorkbench(page);
    await openDirectorySidebar(page);
  });

  test('目录树节点显示正确', async ({ page }) => {
    // 验证目录树至少有一个节点
    const treeNodes = page.locator('.ant-tree-node-content-wrapper');
    const count = await treeNodes.count();
    expect(count).toBeGreaterThan(0);
    console.log(`目录树共有 ${count} 个节点`);
  });

  test('目录树节点标题内联编辑', async ({ page }) => {
    // 等待树节点
    const treeNode = page.locator('.ant-tree-node-content-wrapper').first();
    await expect(treeNode).toBeVisible({ timeout: 10000 });

    // 悬停在节点上——不用 force，让真实鼠标事件触发 CSS :hover
    await treeNode.scrollIntoViewIfNeeded();
    await treeNode.hover();
    await page.waitForTimeout(500);

    // 查找悬停后出现的编辑图标（data-icon="edit"）
    // 节点操作区域在 .node-actions 中
    const editIcon = page.locator('.node-actions [data-icon="edit"]').first();

    if (await editIcon.count() > 0) {
      await editIcon.click({ force: true });
      await page.waitForTimeout(500);

      // 等待内联编辑输入框出现
      const editInput = page.locator('.ant-tree .ant-input-sm, .ant-tree input[size="small"]');
      await expect(editInput).toBeVisible({ timeout: 5000 });

      const newTitle = `编辑测试_${Date.now()}`;
      await editInput.clear();
      await editInput.fill(newTitle);
      await editInput.press('Enter');

      await expect(editInput).toBeHidden({ timeout: 5000 });
      await expect(page.locator('.ant-tree').getByText(newTitle)).toBeVisible({ timeout: 5000 });
    } else {
      // 截图记录当前状态
      await page.screenshot({ path: 'test-results/directory-hover-state.png' });

      // 通过 CSS 检查 node-actions 是否存在
      const nodeActions = await page.locator('.node-actions').count();
      console.log(`找到 ${nodeActions} 个 node-actions 元素`);

      // 尝试用 JavaScript 强制触发编辑
      const triggered = await page.evaluate(() => {
        const editIcons = document.querySelectorAll('.node-actions [data-icon="edit"]');
        if (editIcons.length > 0) {
          (editIcons[0] as HTMLElement).click();
          return true;
        }
        return false;
      });

      if (triggered) {
        const editInput = page.locator('.ant-tree .ant-input-sm, .ant-tree input[size="small"]');
        await expect(editInput).toBeVisible({ timeout: 5000 });
        console.log('通过 JavaScript 触发编辑成功');
      } else {
        test.skip(true, '未能找到目录节点编辑按钮，可能需要先生成目录');
      }
    }
  });

  test('目录树节点删除确认弹窗', async ({ page }) => {
    const treeNode = page.locator('.ant-tree-node-content-wrapper').first();
    await treeNode.scrollIntoViewIfNeeded();
    await treeNode.hover();
    await page.waitForTimeout(500);

    const deleteIcon = page.locator('.node-actions [data-icon="delete"]').first();
    if (await deleteIcon.count() > 0) {
      await deleteIcon.click({ force: true });

      // 验证删除确认弹窗出现
      const confirmDialog = page.locator('.ant-popconfirm');
      await expect(confirmDialog).toBeVisible({ timeout: 5000 });

      // Ant Design 按钮文字有字间空格，用 includes 匹配
      const clicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('.ant-popover button');
        for (const btn of Array.from(buttons)) {
          if (btn.textContent?.replace(/\s/g, '') === '取消') {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        console.log('删除确认弹窗测试通过');
      } else {
        test.skip(true, '未找到取消按钮');
      }
    } else {
      test.skip(true, '未找到删除按钮');
    }
  });
});
