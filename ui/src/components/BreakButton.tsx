import { useState } from 'react';
import type { Commitment } from '../api/types';
import './BreakButton.css';

interface BreakButtonProps {
  commitment: Commitment | null;
  onBreak: (id: string, reason: string) => Promise<void>;
}

const FLASH_MS = 2000;

/**
 * The demo trigger. No confirmation dialog by design (this button exists to
 * be mashed live during the cascade scene); a 2s flash after the POST
 * resolves is the only feedback, and there is no undo, break is a real
 * kernel transition (see kernel/src/transition.ts's active -> broken edge).
 */
export function BreakButton({ commitment, onBreak }: BreakButtonProps) {
  const [pending, setPending] = useState(false);
  const [flashed, setFlashed] = useState(false);

  const enabled = commitment?.status === 'active' && !pending && !flashed;

  async function handleClick() {
    if (!commitment) return;
    setPending(true);
    try {
      await onBreak(commitment.id, 'broken from the console');
      setFlashed(true);
      setTimeout(() => setFlashed(false), FLASH_MS);
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      className={`break-button${flashed ? ' flashed' : ''}`}
      disabled={!enabled}
      onClick={handleClick}
    >
      {flashed ? 'BROKEN' : pending ? 'breaking…' : 'BREAK'}
    </button>
  );
}
