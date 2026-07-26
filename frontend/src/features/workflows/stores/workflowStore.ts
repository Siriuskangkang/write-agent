'use client';

import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  type CreateWorkflowRequest,
  type PersistedWorkflowRef,
  type WorkflowEvent,
  type WorkflowRuntime,
  type WorkflowType,
} from '../types';
import {
  workflowService,
  type WorkflowService,
} from '../services/workflowService';

const STORAGE_PREFIX = 'write-agent:active-workflow:';

export interface WorkflowStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WorkflowStoreDependencies {
  service: WorkflowService;
  storage: WorkflowStorage;
}

export interface WorkflowStoreState {
  jobsByProject: Record<string, WorkflowRuntime | undefined>;
  createWorkflow: (
    projectId: string,
    workflowType: WorkflowType,
    input?: Record<string, unknown>,
  ) => Promise<WorkflowRuntime>;
  recoverProject: (projectId: string) => Promise<WorkflowRuntime | null>;
  refreshProject: (projectId: string) => Promise<WorkflowRuntime | null>;
  cancelProject: (projectId: string) => Promise<WorkflowRuntime | null>;
  approveProject: (projectId: string) => Promise<WorkflowRuntime | null>;
  resumeProject: (projectId: string) => Promise<WorkflowRuntime | null>;
  dismissProject: (projectId: string) => void;
  reset: () => void;
}

export type WorkflowStoreApi = StoreApi<WorkflowStoreState>;

function browserStorage(): WorkflowStorage {
  return {
    getItem: (key) =>
      typeof window === 'undefined' ? null : window.localStorage.getItem(key),
    setItem: (key, value) => {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    },
    removeItem: (key) => {
      if (typeof window !== 'undefined') window.localStorage.removeItem(key);
    },
  };
}

export function createWorkflowStore(
  dependencies: WorkflowStoreDependencies = {
    service: workflowService,
    storage: browserStorage(),
  },
): WorkflowStoreApi {
  const refreshes = new Map<string, Promise<WorkflowRuntime | null>>();
  const storageKey = (projectId: string) => `${STORAGE_PREFIX}${projectId}`;

  const persist = (runtime: WorkflowRuntime): void => {
    if (runtime.job.status === 'STOPPED') {
      dependencies.storage.removeItem(storageKey(runtime.projectId));
      return;
    }
    const value: PersistedWorkflowRef = {
      job_id: runtime.job.id,
      cursor: runtime.cursor,
      workflow_type: runtime.job.workflow_type,
      resource_id: runtime.resourceId,
      version_id: runtime.versionId,
    };
    dependencies.storage.setItem(storageKey(runtime.projectId), JSON.stringify(value));
  };

  return createStore<WorkflowStoreState>((set, get) => {
    const setRuntime = (runtime: WorkflowRuntime): WorkflowRuntime => {
      set((state) => ({
        jobsByProject: {
          ...state.jobsByProject,
          [runtime.projectId]: runtime,
        },
      }));
      persist(runtime);
      return runtime;
    };

    const mutateAction = async (
      projectId: string,
      action: 'cancel' | 'approve' | 'resume',
    ): Promise<WorkflowRuntime | null> => {
      const runtime = get().jobsByProject[projectId];
      if (!runtime) return null;
      setRuntime({ ...runtime, actionPending: action });
      try {
        const job = await dependencies.service[action](projectId, runtime.job.id);
        return setRuntime({
          ...get().jobsByProject[projectId]!,
          job,
          proposal:
            action === 'approve' && runtime.proposal
              ? { ...runtime.proposal, status: 'APPROVED' }
              : action === 'resume'
                ? null
                : runtime.proposal,
          actionPending: null,
        });
      } catch (error) {
        const latest = get().jobsByProject[projectId];
        if (latest) setRuntime({ ...latest, actionPending: null });
        throw error;
      }
    };

    return {
      jobsByProject: {},

      async createWorkflow(projectId, workflowType, input) {
        const request: CreateWorkflowRequest = {
          workflow_type: workflowType,
          input,
          client_contract_version: 'authoring-approval-ui.v1',
        };
        const job = await dependencies.service.create(projectId, request);
        return setRuntime({
          projectId,
          job,
          cursor: null,
          events: [],
          proposal: null,
          streamContent: '',
          resourceId: null,
          versionId: null,
          actionPending: null,
        });
      },

      async recoverProject(projectId) {
        if (get().jobsByProject[projectId]) {
          return get().refreshProject(projectId);
        }
        const raw = dependencies.storage.getItem(storageKey(projectId));
        const persisted = parsePersistedRef(raw);
        if (!persisted) {
          if (raw !== null) dependencies.storage.removeItem(storageKey(projectId));
          return null;
        }
        const job = await dependencies.service.getJob(projectId, persisted.job_id);
        setRuntime({
          projectId,
          job,
          cursor: persisted.cursor,
          events: [],
          proposal: null,
          streamContent: '',
          resourceId: persisted.resource_id,
          versionId: persisted.version_id,
          actionPending: null,
        });
        return get().refreshProject(projectId);
      },

      async refreshProject(projectId) {
        const existingRefresh = refreshes.get(projectId);
        if (existingRefresh) return existingRefresh;
        const refresh = (async (): Promise<WorkflowRuntime | null> => {
          const runtime = get().jobsByProject[projectId];
          if (!runtime) return null;
          const [events, job] = await Promise.all([
            dependencies.service.listEvents(
              projectId,
              runtime.job.id,
              runtime.cursor,
            ),
            dependencies.service.getJob(projectId, runtime.job.id),
          ]);
          const reduced = reduceEvents(runtime, events);
          const proposal =
            job.status === 'WAITING_APPROVAL'
              ? await dependencies.service.getProposal(projectId, job.id)
              : job.status === 'QUEUED' && reduced.proposal?.status === 'APPROVED'
                ? reduced.proposal
                : null;
          return setRuntime({
            ...reduced,
            job,
            proposal,
            actionPending: null,
          });
        })().finally(() => refreshes.delete(projectId));
        refreshes.set(projectId, refresh);
        return refresh;
      },

      cancelProject: (projectId) => mutateAction(projectId, 'cancel'),
      approveProject: (projectId) => mutateAction(projectId, 'approve'),
      resumeProject: (projectId) => mutateAction(projectId, 'resume'),

      dismissProject(projectId) {
        dependencies.storage.removeItem(storageKey(projectId));
        set((state) => {
          const jobsByProject = { ...state.jobsByProject };
          delete jobsByProject[projectId];
          return { jobsByProject };
        });
      },

      reset() {
        for (const projectId of Object.keys(get().jobsByProject)) {
          dependencies.storage.removeItem(storageKey(projectId));
        }
        refreshes.clear();
        set({ jobsByProject: {} });
      },
    };
  });
}

function reduceEvents(
  runtime: WorkflowRuntime,
  events: WorkflowEvent[],
): WorkflowRuntime {
  let streamContent = runtime.streamContent;
  let resourceId = runtime.resourceId;
  let versionId = runtime.versionId;
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'reset' || data.type === 'reset') streamContent = '';
    if (
      (event.type === 'token' || data.type === 'token') &&
      typeof data.content === 'string'
    ) {
      streamContent += data.content;
    }
    if (event.type === 'done' || event.type === 'authoring.committed') {
      if (typeof data.result_id === 'string') resourceId = data.result_id;
      if (typeof data.resource_id === 'string') resourceId = data.resource_id;
      if (typeof data.version_id === 'string') versionId = data.version_id;
    }
  }
  return {
    ...runtime,
    events: [...runtime.events, ...events],
    cursor: events.at(-1)?.id ?? runtime.cursor,
    streamContent,
    resourceId,
    versionId,
  };
}

function parsePersistedRef(raw: string | null): PersistedWorkflowRef | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedWorkflowRef>;
    if (
      typeof value.job_id !== 'string' ||
      typeof value.workflow_type !== 'string' ||
      (value.cursor !== null && typeof value.cursor !== 'string') ||
      (value.resource_id !== null && typeof value.resource_id !== 'string') ||
      (value.version_id !== null && typeof value.version_id !== 'string')
    ) {
      return null;
    }
    return value as PersistedWorkflowRef;
  } catch {
    return null;
  }
}

export const workflowStore = createWorkflowStore();

export function useWorkflowStore<T>(
  selector: (state: WorkflowStoreState) => T,
): T {
  return useStore(workflowStore, selector);
}
