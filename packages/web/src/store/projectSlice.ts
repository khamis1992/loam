import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

interface Project {
  uid: string;
  name: string;
  description?: string;
  instruction?: string;
  isPinned?: boolean;
  isFavorite?: boolean;
}

interface ProjectState {
  list: Project[];
  activeUid: string | null;
}

const initialState: ProjectState = { list: [], activeUid: null };

const projectSlice = createSlice({
  name: 'project',
  initialState,
  reducers: {
    setProjects(state, action: PayloadAction<Project[]>) {
      state.list = action.payload;
    },
    selectProject(state, action: PayloadAction<string | null>) {
      state.activeUid = action.payload;
    },
  },
});

export const { setProjects, selectProject } = projectSlice.actions;
export default projectSlice.reducer;
