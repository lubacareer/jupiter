import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Workspace, { type ParameterOverrides, type SimulationSnapshot } from './ui/Workspace';
import type { GpuFileBridge } from './ui/GpuPanel';
import './styles.css';

type Bridge = GpuFileBridge & { command: (command: object) => void; subscribe: (callback: (snapshot: SimulationSnapshot) => void) => () => void; saveCheckpoint: () => void; loadCheckpoint: () => void; exportData: () => void };
declare global { interface Window { europa?: Bridge } }

export function App() {
  const [snapshot, setSnapshot] = useState<SimulationSnapshot>({ status: 'idle', timeSeconds: 0, samples: [], message: 'Launch the desktop app to run the orbital model.' });
  const bridge = window.europa;
  useEffect(() => bridge?.subscribe(setSnapshot), [bridge]);
  return <Workspace snapshot={snapshot} gpuBridge={bridge}
    onStart={bridge ? (parameters: ParameterOverrides) => bridge.command({ type: 'start', parameters }) : undefined}
    onPause={bridge ? () => bridge.command({ type: 'pause' }) : undefined}
    onReset={bridge ? () => bridge.command({ type: 'reset' }) : undefined}
    onSaveCheckpoint={bridge ? () => bridge.saveCheckpoint() : undefined}
    onLoadCheckpoint={bridge ? () => bridge.loadCheckpoint() : undefined}
    onExport={bridge ? () => bridge.exportData() : undefined} />;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
