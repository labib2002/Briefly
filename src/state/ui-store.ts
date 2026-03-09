import { create } from 'zustand';

export type PanelView = 'copilot' | 'search' | 'settings';

type UIState = {
  activeView: PanelView;
  focusedWorkspaceId: string | null;
  setActiveView: (view: PanelView) => void;
  setFocusedWorkspaceId: (workspaceId: string | null) => void;
};

export const useUIStore = create<UIState>((set) => ({
  activeView: 'copilot',
  focusedWorkspaceId: null,
  setActiveView: (view) => set({ activeView: view }),
  setFocusedWorkspaceId: (focusedWorkspaceId) => set({ focusedWorkspaceId }),
}));
