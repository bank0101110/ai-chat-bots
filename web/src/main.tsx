import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { StreamProvider } from './bus';
import { ToastProvider } from './toast';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <StreamProvider>
          <App />
        </StreamProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
