import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AdminApp } from './AdminApp.tsx';
import './index.css';

function isAdminMode() {
  const url = new URL(window.location.href);
  return url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.searchParams.get('admin') === '1' || url.hash === '#admin';
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAdminMode() ? <AdminApp /> : <App />}
  </StrictMode>
);
