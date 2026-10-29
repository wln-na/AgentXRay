// Minimal web dogfood of the desktop "pet" (PRD §5.2 / P1).
//
// Subscribes to GET /api/pet/state over SSE and renders a fixed bottom-right
// companion that shows the top-priority agent state with an emoji + bubble.
// Clicking it jumps back to the underlying session via the existing
// open-session ("locate") logic — AgentXRay is read-only, so the pet only ever
// navigates, never replies (PRD N1).
//
// waiting_input / error are the highest-value signals (PRD G2), so they get a
// pulsing ring to grab attention.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getPetState, openSession, petStateUrl } from '@/api/client';
import type { PetState, PetStateName } from '@/api/types';
import { PLATFORM_LABELS } from '@/api/types';
import { DEMO } from '@/demo/flag';

interface PetMeta {
  emoji: string;
  label: string;
  ring: string;
  text: string;
  pulse: boolean;
}

// ring/text use Tailwind theme classes; text colors follow the project's
// light/dark-aware palette via semantic tokens where available.
const PET_META: Record<PetStateName, PetMeta> = {
  idle: { emoji: '😴', label: '空闲', ring: 'ring-slate-400/40', text: 'text-slate-300', pulse: false },
  thinking: { emoji: '🤔', label: '思考中', ring: 'ring-sky-400/60', text: 'text-sky-300', pulse: false },
  working: { emoji: '⚙️', label: '工作中', ring: 'ring-amber-400/60', text: 'text-amber-300', pulse: false },
  done: { emoji: '✅', label: '完成', ring: 'ring-emerald-400/60', text: 'text-emerald-300', pulse: false },
  waiting_input: { emoji: '🙋', label: '等你输入', ring: 'ring-red-500/70', text: 'text-red-300', pulse: true },
  error: { emoji: '⚠️', label: '出错了', ring: 'ring-red-600/70', text: 'text-red-300', pulse: true },
};

interface PetConnection {
  pet: PetState | null;
  connected: boolean;
  errored: boolean;
}

function usePetState(): PetConnection {
  const [pet, setPet] = useState<PetState | null>(null);
  const [connected, setConnected] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    // Demo mode has no backend to stream from — show a calm idle pet.
    if (DEMO) {
      setPet({
        state: 'idle',
        platform: null,
        sessionId: null,
        agent: null,
        bubble: '空闲',
        updatedAt: Date.now(),
      });
      return;
    }

    const es = new EventSource(petStateUrl());
    es.addEventListener('state', (event) => {
      try {
        const next = JSON.parse((event as MessageEvent).data || 'null') as PetState | null;
        if (next) {
          setPet(next);
          setConnected(true);
          setErrored(false);
        }
      } catch {
        /* ignore malformed frame */
      }
    });
    es.addEventListener('error', () => {
      // EventSource auto-reconnects; reflect transient / aggregation errors.
      setErrored(true);
      setConnected(false);
    });
    // Best-effort immediate snapshot in case the first SSE frame is slow.
    getPetState()
      .then(setPet)
      .catch(() => {});

    return () => es.close();
  }, []);

  return { pet, connected, errored };
}

export function PetWidget() {
  const { pet, connected, errored } = usePetState();
  const meta = pet ? PET_META[pet.state] : PET_META.idle;
  const platformLabel = pet?.platform ? (PLATFORM_LABELS[pet.platform] ?? pet.platform) : null;
  const clickable = !!pet?.platform && !!pet?.sessionId;

  const handleClick = async () => {
    if (!pet?.platform || !pet.sessionId) return;
    try {
      const res = await openSession(pet.platform, pet.sessionId, 'locate', {
        agent: pet.agent || undefined,
      });
      if (res?.ok) {
        toast.success(platformLabel ? `${platformLabel} 会话已定位` : '会话已定位');
      } else if (res?.fallback) {
        const text = res.fallback.path || res.fallback.command || '';
        if (text) {
          navigator.clipboard?.writeText(text).then(
            () => toast.info(`已复制定位方式：${text}`),
            () => toast.info(text)
          );
        } else {
          toast.info(res.detail || '已尝试定位会话');
        }
      } else {
        toast.info(res?.detail || res?.error || '已尝试定位会话');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '定位会话失败');
    }
  };

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex select-none items-end gap-2">
      {pet && pet.state !== 'idle' ? (
        <div
          className={`pointer-events-auto max-w-[220px] rounded-2xl rounded-br-sm border border-white/10 bg-black/80 px-3 py-1.5 text-xs shadow-lg backdrop-blur ${meta.text}`}
        >
          <span className="font-medium">{pet.bubble}</span>
          {platformLabel ? <span className="ml-1 text-white/50">· {platformLabel}</span> : null}
        </div>
      ) : null}
      <button
        type="button"
        onClick={handleClick}
        disabled={!clickable}
        title={clickable ? `点击定位到 ${platformLabel ?? ''} 会话` : meta.label}
        className={`pointer-events-auto relative flex h-12 w-12 items-center justify-center rounded-full bg-zinc-900/90 text-2xl shadow-lg ring-2 transition-transform ${meta.ring} ${clickable ? 'cursor-pointer hover:scale-105' : 'cursor-default'} ${meta.pulse ? 'animate-pulse' : ''}`}
      >
        <span aria-hidden>{meta.emoji}</span>
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-zinc-900 ${
            errored ? 'bg-red-500' : connected ? 'bg-emerald-400' : 'bg-slate-500'
          }`}
        />
      </button>
    </div>
  );
}
