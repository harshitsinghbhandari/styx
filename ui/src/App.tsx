import { Header } from './components/Header';
import { DagPanel } from './components/DagPanel';
import { Inspector } from './components/Inspector';
import { Ticker } from './components/Ticker';
import { useStyxConsole } from './hooks/useStyxConsole';
import './App.css';

export function App() {
  const { commitments, edges, rows, selectedId, setSelectedId, pulsing, connected, breakCommitment } = useStyxConsole();
  const selected = selectedId ? (commitments.get(selectedId) ?? null) : null;

  return (
    <div className="app">
      <Header commitments={commitments} connected={connected} />
      <div className="app-main">
        <div className="app-dag">
          <DagPanel
            commitments={commitments}
            edges={edges}
            selectedId={selectedId}
            pulsing={pulsing}
            onSelect={setSelectedId}
          />
        </div>
        <Inspector commitment={selected} commitments={commitments} edges={edges} onBreak={breakCommitment} />
      </div>
      <div className="app-ticker">
        <Ticker rows={rows} onSelect={setSelectedId} />
      </div>
    </div>
  );
}
