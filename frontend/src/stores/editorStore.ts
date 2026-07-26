import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { DirectoryNode, OutlineVersion, WritingResult, Citation } from '@/types';
import { NodeType } from '@/types';

export interface EditorTab {
  id: string;
  nodeId: string;
  nodeType: NodeType;
  title: string;
  chapterNodeId: string | null;
  sectionNodeId: string | null;
}

interface EditorState {
  scopedProjectId: string | null;
  directoryNodes: DirectoryNode[];
  currentDirectoryVersionId: string | null;
  currentDirectoryVersionNumber: number | null;
  selectedChapterNodeId: string | null;
  selectedSectionNodeId: string | null;
  currentOutline: OutlineVersion | null;
  currentResult: WritingResult | null;
  citations: Citation[];
  leftSidebarCollapsed: boolean;
  chatCollapsed: boolean;
  citationCollapsed: boolean;

  // Tab 管理
  tabs: EditorTab[];
  activeTabId: string | null;

  ensureProjectScope: (projectId: string) => void;
  setDirectoryNodes: (nodes: DirectoryNode[]) => void;
  setCurrentDirectoryVersionId: (id: string | null) => void;
  setCurrentDirectoryVersionNumber: (n: number | null) => void;
  setSelectedChapterNodeId: (id: string | null) => void;
  setSelectedSectionNodeId: (id: string | null) => void;
  setCurrentOutline: (outline: OutlineVersion | null) => void;
  setCurrentResult: (result: WritingResult | null) => void;
  setCitations: (citations: Citation[]) => void;
  setLeftSidebarCollapsed: (v: boolean) => void;
  setChatCollapsed: (v: boolean) => void;
  setCitationCollapsed: (v: boolean) => void;

  // Tab 操作
  addTab: (tab: EditorTab) => void;
  removeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  clearAllTabs: () => void;

  resetAll: () => void;
}

export const useEditorStore = create<EditorState>()(
  devtools(
    (set) => ({
      scopedProjectId: null,
      directoryNodes: [],
      currentDirectoryVersionId: null,
      currentDirectoryVersionNumber: null,
      selectedChapterNodeId: null,
      selectedSectionNodeId: null,
      currentOutline: null,
      currentResult: null,
      citations: [],
      leftSidebarCollapsed: true,
      chatCollapsed: false,
      citationCollapsed: true,
      tabs: [],
      activeTabId: null,

      ensureProjectScope: (projectId) =>
        set((state) => {
          if (state.scopedProjectId === projectId) {
            return state;
          }

          return {
            scopedProjectId: projectId,
            directoryNodes: [],
            currentDirectoryVersionId: null,
            currentDirectoryVersionNumber: null,
            selectedChapterNodeId: null,
            selectedSectionNodeId: null,
            currentOutline: null,
            currentResult: null,
            citations: [],
            leftSidebarCollapsed: true,
            chatCollapsed: false,
            citationCollapsed: true,
            tabs: [],
            activeTabId: null,
          };
        }),
      setDirectoryNodes: (nodes) => set({ directoryNodes: nodes }),
      setCurrentDirectoryVersionId: (id) => set({ currentDirectoryVersionId: id }),
      setCurrentDirectoryVersionNumber: (n) => set({ currentDirectoryVersionNumber: n }),
      setSelectedChapterNodeId: (id) => set({ selectedChapterNodeId: id }),
      setSelectedSectionNodeId: (id) => set({ selectedSectionNodeId: id }),
      setCurrentOutline: (outline) => set({ currentOutline: outline }),
      setCurrentResult: (result) => set({ currentResult: result }),
      setCitations: (citations) => set({ citations }),
      setLeftSidebarCollapsed: (v) => set({ leftSidebarCollapsed: v }),
      setChatCollapsed: (v) => set({ chatCollapsed: v }),
      setCitationCollapsed: (v) => set({ citationCollapsed: v }),

      addTab: (tab) =>
        set((state) => {
          if (state.tabs.some((t) => t.id === tab.id)) {
            return {
              activeTabId: tab.id,
              selectedChapterNodeId: tab.chapterNodeId,
              selectedSectionNodeId: tab.sectionNodeId,
            };
          }
          return {
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
            selectedChapterNodeId: tab.chapterNodeId,
            selectedSectionNodeId: tab.sectionNodeId,
          };
        }),

      removeTab: (tabId) =>
        set((state) => {
          const newTabs = state.tabs.filter((t) => t.id !== tabId);
          let newActiveId = state.activeTabId;
          if (state.activeTabId === tabId) {
            const idx = state.tabs.findIndex((t) => t.id === tabId);
            newActiveId = newTabs.length > 0 ? (newTabs[Math.max(0, idx - 1)]?.id ?? newTabs[0].id) : null;
          }
          const nextActiveTab = newTabs.find((tab) => tab.id === newActiveId) ?? null;

          return {
            tabs: newTabs,
            activeTabId: newActiveId,
            selectedChapterNodeId: nextActiveTab?.chapterNodeId ?? null,
            selectedSectionNodeId: nextActiveTab?.sectionNodeId ?? null,
          };
        }),

      setActiveTab: (tabId) =>
        set((state) => {
          const nextActiveTab = state.tabs.find((tab) => tab.id === tabId);

          if (!nextActiveTab) {
            return state;
          }

          return {
            activeTabId: tabId,
            selectedChapterNodeId: nextActiveTab.chapterNodeId,
            selectedSectionNodeId: nextActiveTab.sectionNodeId,
          };
        }),

      clearAllTabs: () =>
        set({
          tabs: [],
          activeTabId: null,
          selectedChapterNodeId: null,
          selectedSectionNodeId: null,
        }),

      resetAll: () =>
        set({
          scopedProjectId: null,
          directoryNodes: [],
          currentDirectoryVersionId: null,
          currentDirectoryVersionNumber: null,
          selectedChapterNodeId: null,
          selectedSectionNodeId: null,
          currentOutline: null,
          currentResult: null,
          citations: [],
          leftSidebarCollapsed: true,
          chatCollapsed: false,
          citationCollapsed: true,
          tabs: [],
          activeTabId: null,
        }),
    }),
    { name: 'EditorStore', enabled: process.env.NODE_ENV === 'development' }
  )
);
