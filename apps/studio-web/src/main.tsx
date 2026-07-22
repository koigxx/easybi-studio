import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyTheme } from './theme.js';
import './styles.css';

// 首屏先套用持久化主题，避免明暗闪烁。
applyTheme();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
