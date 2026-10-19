import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface Project {
  uid: string;
  name: string;
  description?: string;
  sessionCount: number;
}

export interface ProjectState {
  list: Project[];
  activeUid: string | null;
}

const initialState: ProjectState = {
  list: [],
  activeUid: null,
};

export const projectSlice = createSlice({
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
