import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TrustedKeyProvider } from "./hooks/useTrustedKey";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TrustedKeyProvider>
        <App />
      </TrustedKeyProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
