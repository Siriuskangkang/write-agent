import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorStore } from './editorStore'
import { NodeType } from '@/types'
import type { EditorTab } from './editorStore'

// 每个测试前重置 store 状态
beforeEach(() => {
  useEditorStore.getState().resetAll()
})

describe('ensureProjectScope', () => {
  it('切换到新 projectId 时应重置所有状态', () => {
    const store = useEditorStore.getState()

    // 先设置一些状态
    store.setDirectoryNodes([
      {
        node_id: 'node-1',
        parent_node_id: null,
        node_type: NodeType.CHAPTER,
        order_index: 0,
        title: '第一章',
      },
    ])
    store.setSelectedChapterNodeId('node-1')

    // 切换到新项目
    store.ensureProjectScope('project-new')

    const state = useEditorStore.getState()
    expect(state.scopedProjectId).toBe('project-new')
    expect(state.directoryNodes).toEqual([])
    expect(state.selectedChapterNodeId).toBeNull()
    expect(state.tabs).toEqual([])
    expect(state.activeTabId).toBeNull()
  })

  it('同一 projectId 时不应重置状态', () => {
    const store = useEditorStore.getState()

    // 先绑定到某个项目
    store.ensureProjectScope('project-abc')
    store.setSelectedChapterNodeId('chapter-1')

    // 再次调用相同 projectId
    store.ensureProjectScope('project-abc')

    const state = useEditorStore.getState()
    // 状态不应被重置
    expect(state.selectedChapterNodeId).toBe('chapter-1')
  })
})

describe('addTab', () => {
  it('添加新 tab 时应更新 tabs 列表和 activeTabId', () => {
    const newTab: EditorTab = {
      id: 'tab-1',
      nodeId: 'node-1',
      nodeType: NodeType.CHAPTER,
      title: '第一章',
      chapterNodeId: 'chapter-1',
      sectionNodeId: null,
    }

    useEditorStore.getState().addTab(newTab)

    const state = useEditorStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toEqual(newTab)
    expect(state.activeTabId).toBe('tab-1')
    expect(state.selectedChapterNodeId).toBe('chapter-1')
    expect(state.selectedSectionNodeId).toBeNull()
  })

  it('添加已存在的 tab 时只应激活它而不重复添加', () => {
    const tab: EditorTab = {
      id: 'tab-1',
      nodeId: 'node-1',
      nodeType: NodeType.CHAPTER,
      title: '第一章',
      chapterNodeId: 'chapter-1',
      sectionNodeId: null,
    }

    const store = useEditorStore.getState()
    store.addTab(tab)
    store.addTab(tab) // 再次添加相同 tab

    const state = useEditorStore.getState()
    expect(state.tabs).toHaveLength(1) // 不重复
    expect(state.activeTabId).toBe('tab-1')
  })

  it('可以添加多个不同的 tab', () => {
    const tab1: EditorTab = {
      id: 'tab-1',
      nodeId: 'node-1',
      nodeType: NodeType.CHAPTER,
      title: '第一章',
      chapterNodeId: 'chapter-1',
      sectionNodeId: null,
    }
    const tab2: EditorTab = {
      id: 'tab-2',
      nodeId: 'node-2',
      nodeType: NodeType.SECTION,
      title: '第一节',
      chapterNodeId: 'chapter-1',
      sectionNodeId: 'section-1',
    }

    const store = useEditorStore.getState()
    store.addTab(tab1)
    store.addTab(tab2)

    const state = useEditorStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.activeTabId).toBe('tab-2')
    expect(state.selectedSectionNodeId).toBe('section-1')
  })
})

describe('setSelectedChapterNodeId', () => {
  it('应正确更新 selectedChapterNodeId', () => {
    useEditorStore.getState().setSelectedChapterNodeId('chapter-42')

    expect(useEditorStore.getState().selectedChapterNodeId).toBe('chapter-42')
  })

  it('应支持设置为 null', () => {
    useEditorStore.getState().setSelectedChapterNodeId('chapter-1')
    useEditorStore.getState().setSelectedChapterNodeId(null)

    expect(useEditorStore.getState().selectedChapterNodeId).toBeNull()
  })
})
