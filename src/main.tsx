import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Workspace, { type SimulationParameters, type SimulationSnapshot } from './ui/Workspace';
import './styles.css';

type Bridge = { command: (command: object) => void; subscribe: (callback: (snapshot: SimulationSnapshot) => void) => () => void; saveCheckpoint: () => void; loadCheckpoint: () => void; exportData: () => void };
declare global { interface Window { europa?: Bridge } }

function App() {
  const [snapshot, setSnapshot] = useState<SimulationSnapshot>({ status: 'idle', timeSeconds: 0, samples: [], message: 'Launch the desktop app to run the orbital model.' });
  const bridge = window.europa;
  useEffect(() => bridge?.subscribe(setSnapshot), [bridge]);
  return <Workspace snapshot={snapshot}
    onStart={bridge ? (parameters: SimulationParameters) => bridge.command({ type: 'start', parameters }) : undefined}
    onPause={bridge ? () => bridge.command({ type: 'pause' }) : undefined}
    onReset={bridge ? () => bridge.command({ type: 'reset' }) : undefined}
    onSaveCheckpoint={bridge?.saveCheckpoint}
    onLoadCheckpoint={bridge?.loadCheckpoint}
    onExport={bridge?.exportData} />;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
