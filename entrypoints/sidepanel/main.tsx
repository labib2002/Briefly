import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from '../../src/ui/App';
import { ensureDefaultSettings } from '../../src/db/settings';
import './styles.css';

void ensureDefaultSettings();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
