import { createContext, useContext } from 'react';

/** The primary navigation tabs (single source of truth, shared by App + panels). */
export type Tab =
  | 'overview'
  | 'config'
  | 'knowledge'
  | 'reports'
  | 'files'
  | 'test'
  | 'publish'
  | 'diagnostics';

/**
 * Cross-panel navigation so any panel (or a nested editor) can jump the user to
 * the next stage without prop-drilling through every level. App provides the
 * implementation; panels call `useNavigate()`.
 */
export const NavContext = createContext<(tab: Tab) => void>(() => {});

export function useNavigate(): (tab: Tab) => void {
  return useContext(NavContext);
}
