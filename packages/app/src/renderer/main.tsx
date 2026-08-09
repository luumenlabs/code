import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import "@/styles.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Missing #root");
}

async function start(): Promise<void> {
  // Running in a plain browser during UI work: install the mock bridge so the
  // interface renders without Electron, Studio, or an agent. Never in a
  // packaged build, where a missing bridge means preload failed and inventing
  // data would hide the real problem.
  if (import.meta.env.DEV && window.luuCode === undefined) {
    const { installMockBridge } = await import("@/lib/mock-bridge");
    installMockBridge();
  }

  createRoot(container!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
