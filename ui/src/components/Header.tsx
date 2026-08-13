import { useState } from 'react';
import { getApiKey, setApiKey } from '../api/client';
import type { Commitment } from '../api/types';
import { StatusChips } from './StatusChips';
import './Header.css';

interface HeaderProps {
  commitments: Map<string, Commitment>;
  connected: boolean;
}

export function Header({ commitments, connected }: HeaderProps) {
  const [keyInput, setKeyInput] = useState(getApiKey());

  function applyKey() {
    setApiKey(keyInput.trim());
    window.location.reload(); // simplest correct way to reconnect SSE + refetch with the new key
  }

  return (
    <header className="header">
      <div className="header-brand">
        <span className="header-wordmark">STYX</span>
        <span className={`cluster-dot ${connected ? 'connected' : 'disconnected'}`} title={connected ? 'connected' : 'disconnected'} />
      </div>

      <StatusChips commitments={commitments} />

      <div className="header-key">
        <input
          className="header-key-input mono"
          type="password"
          placeholder="agent API key"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyKey()}
        />
        <button type="button" className="header-key-apply" onClick={applyKey}>
          set
        </button>
      </div>
    </header>
  );
}
