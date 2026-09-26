import React, { StrictMode, Component, ErrorInfo } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { CurrencyProvider } from './CurrencyContext.tsx';
import './index.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  });
}

class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Caught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, color: 'red', fontFamily: 'sans-serif' }}>
          <h2>Application Error</h2>
          <pre style={{ color: 'black', background: '#ffe6e6', padding: 10, borderRadius: 5, overflow: 'auto' }}>
            {this.state.error?.toString()}
          </pre>
        </div>
      );
    }
    return (this as any).props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <CurrencyProvider>
        <App />
      </CurrencyProvider>
    </ErrorBoundary>
  </StrictMode>
);
