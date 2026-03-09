import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { SETTINGS_RECORD_ID } from '../db/settings';
import { db } from '../db';
import { useUIStore } from '../state/ui-store';
import { CopilotView } from './CopilotView';
import { SearchView } from './SearchView';
import { SettingsView } from './SettingsView';

export function App() {
  const settings = useLiveQuery(() => db.settings.get(SETTINGS_RECORD_ID), []);
  const activeView = useUIStore((state) => state.activeView);
  const setActiveView = useUIStore((state) => state.setActiveView);

  useEffect(() => {
    const theme = settings?.theme ?? 'dark';
    document.body.dataset.theme = theme;
  }, [settings?.theme]);

  return (
    <main className="app-shell">
      <div className="frame">
        <section className="topbar">
          <div>
            <span className="eyebrow">YouTube Research Copilot</span>
            <h1 className="title">Briefly</h1>
          </div>

          <div className="segmented-control segmented-control--compact">
            <button
              className={`segment-button ${activeView === 'copilot' ? 'segment-button--active' : ''}`}
              onClick={() => setActiveView('copilot')}
              type="button"
            >
              Copilot
            </button>
            <button
              className={`segment-button ${activeView === 'search' ? 'segment-button--active' : ''}`}
              onClick={() => setActiveView('search')}
              type="button"
            >
              Search
            </button>
            <button
              className={`segment-button ${activeView === 'settings' ? 'segment-button--active' : ''}`}
              onClick={() => setActiveView('settings')}
              type="button"
            >
              Settings
            </button>
          </div>
        </section>

        {activeView === 'copilot' ? <CopilotView /> : null}
        {activeView === 'search' ? <SearchView /> : null}
        {activeView === 'settings' ? <SettingsView /> : null}
      </div>
    </main>
  );
}
