import { create } from 'zustand';
import type { StyleTemplate, StyleTemplateAnalysisResult } from '@/components/workbench/StyleTemplate/types';

interface StyleTemplateState {
  templates: StyleTemplate[];
  activeTemplateId: string | null;
  currentTemplate: StyleTemplate | null;
  uploadingFileId: string | null;
  analyzing: boolean;
  analysisResult: StyleTemplateAnalysisResult | null;

  setTemplates: (templates: StyleTemplate[]) => void;
  setActiveTemplateId: (id: string | null) => void;
  setCurrentTemplate: (template: StyleTemplate | null) => void;
  setUploadingFileId: (fileId: string | null) => void;
  setAnalyzing: (analyzing: boolean) => void;
  setAnalysisResult: (result: StyleTemplateAnalysisResult | null) => void;
  addTemplate: (template: StyleTemplate) => void;
  updateTemplate: (id: string, updates: Partial<StyleTemplate>) => void;
  deleteTemplate: (id: string) => void;
  activateTemplate: (id: string) => void;
  reset: () => void;
}

const initialState = {
  templates: [],
  activeTemplateId: null,
  currentTemplate: null,
  uploadingFileId: null,
  analyzing: false,
  analysisResult: null
};

export const useStyleTemplateStore = create<StyleTemplateState>((set) => ({
  ...initialState,

  setTemplates: (templates) => set({ templates }),

  setActiveTemplateId: (id) => set({ activeTemplateId: id }),

  setCurrentTemplate: (template) => set({ currentTemplate: template }),

  setUploadingFileId: (fileId) => set({ uploadingFileId: fileId }),

  setAnalyzing: (analyzing) => set({ analyzing }),

  setAnalysisResult: (result) => set({ analysisResult: result }),

  addTemplate: (template) =>
    set((state) => ({ templates: [...state.templates, template] })),

  updateTemplate: (id, updates) =>
    set((state) => ({
      templates: state.templates.map((t) => (t.id === id ? { ...t, ...updates } : t))
    })),

  deleteTemplate: (id) =>
    set((state) => ({
      templates: state.templates.filter((t) => t.id !== id),
      activeTemplateId: state.activeTemplateId === id ? null : state.activeTemplateId
    })),

  activateTemplate: (id) =>
    set((state) => ({
      templates: state.templates.map((t) => ({ ...t, isActive: t.id === id })),
      activeTemplateId: id
    })),

  reset: () => set(initialState)
}));
