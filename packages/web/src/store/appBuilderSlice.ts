import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import {
  listAppProjects, getAppProject, getQueue, enqueue, removeQueueItem, pauseQueue, resumeQueue, raceEstimate,
  type AppProjectDto, type PromptQueueStateDto, type RaceEstimateDto,
} from '../services/appBuilderApi';

/** Cap G §4.16 — Agent Studio App Builder state: project list, the selected
 *  project's queue, and the Race estimate the composer chip shows before Send. */

export const loadProjects = createAsyncThunk('appBuilder/loadProjects', async () => (await listAppProjects()).projects);
export const selectProject = createAsyncThunk('appBuilder/selectProject', async (id: string) => {
  const detail = await getAppProject(id);
  return { project: detail.project, queue: detail.queue };
});
export const refreshQueue = createAsyncThunk('appBuilder/refreshQueue', async (id: string) => (await getQueue(id)).queue);
export const enqueuePrompt = createAsyncThunk('appBuilder/enqueuePrompt', async ({ id, content }: { id: string; content: string }) => {
  await enqueue(id, content);
  return (await getQueue(id)).queue;
});
export const dropQueueItem = createAsyncThunk('appBuilder/dropQueueItem', async ({ id, itemId }: { id: string; itemId: string }) => (await removeQueueItem(id, itemId)).queue);
export const toggleQueuePaused = createAsyncThunk('appBuilder/toggleQueuePaused', async ({ id, paused }: { id: string; paused: boolean }) =>
  (await (paused ? resumeQueue(id) : pauseQueue(id))).queue);
export const loadEstimate = createAsyncThunk('appBuilder/loadEstimate', async ({ id, branches }: { id: string; branches: 2 | 3 | 4 }) =>
  (await raceEstimate(id, branches)).estimate);

export interface AppBuilderState {
  projects: AppProjectDto[];
  projectsError: string | null;
  selectedId: string | null;
  selected: AppProjectDto | null;
  queue: PromptQueueStateDto | null;
  estimate: RaceEstimateDto | null;
  estimateBranches: 2 | 3 | 4;
  error: string | null;
}

const initialState: AppBuilderState = {
  projects: [], projectsError: null, selectedId: null, selected: null, queue: null,
  estimate: null, estimateBranches: 2, error: null,
};

const appBuilderSlice = createSlice({
  name: 'appBuilder',
  initialState,
  reducers: {
    setEstimateBranches(state, action: PayloadAction<2 | 3 | 4>) {
      state.estimateBranches = action.payload;
    },
    clearSelection(state) {
      state.selectedId = null; state.selected = null; state.queue = null; state.estimate = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadProjects.fulfilled, (state, action) => { state.projects = action.payload; state.projectsError = null; })
      .addCase(loadProjects.rejected, (state, action) => { state.projectsError = action.error.message ?? 'تعذر تحميل المشاريع'; })
      .addCase(selectProject.fulfilled, (state, action) => {
        state.selected = action.payload.project; state.selectedId = action.payload.project.id; state.queue = action.payload.queue;
      })
      .addCase(selectProject.rejected, (state, action) => { state.error = action.error.message ?? 'تعذر فتح المشروع'; })
      .addCase(refreshQueue.fulfilled, (state, action) => { state.queue = action.payload; })
      .addCase(enqueuePrompt.fulfilled, (state, action) => { state.queue = action.payload; })
      .addCase(enqueuePrompt.rejected, (state, action) => { state.error = action.error.message ?? 'تعذر إضافة الطلب'; })
      .addCase(dropQueueItem.fulfilled, (state, action) => { state.queue = action.payload; })
      .addCase(toggleQueuePaused.fulfilled, (state, action) => { state.queue = action.payload; })
      .addCase(loadEstimate.fulfilled, (state, action) => { state.estimate = action.payload; });
  },
});

export const { setEstimateBranches, clearSelection } = appBuilderSlice.actions;
export default appBuilderSlice.reducer;
